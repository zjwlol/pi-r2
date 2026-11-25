import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	keyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, stripTerminalSequences, truncateToWidth, type TuiAltScreen, type TuiMainScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerEditorChipProvider } from "../shared/editor-chips.ts";
import { DEFAULT_AGENT, discoverAgents, unrestrictedPolicy } from "./agents.ts";
import { readConfig, writeConfig } from "./config.ts";
import { createFeatureHooks } from "./features.ts";
import {
	AgentHub,
	type Child,
	completionPercent,
	describeChild,
	describeProgress,
	describeTree,
	firstLine,
	formatParentEvent,
	IRC_MESSAGE_TYPE,
	latestOutput,
	MAX_DEPTH,
	PARENT_ID,
	type ParentEvent,
	readReport,
	RESULT_MESSAGE_TYPE,
	subtreeActive,
	USER_ID,
} from "./hub.ts";
import { removeAllWorktrees } from "./isolation.ts";
import {
	createMentionAutocomplete,
	createMentionChipProvider,
	findMentions,
	MENTION_NOTICE_TYPE,
	type MentionSource,
	mentionNotice,
	recordMentions,
	seedMentionHistory,
} from "./mentions.ts";
import {
	buildTaskDescription,
	buildTaskParams,
	type DoneInfo,
	MAX_TASKS_PER_CALL,
	prepareTaskArguments,
	TASK_PROMPT_GUIDELINES,
	TASK_PROMPT_SNIPPET,
} from "./prompts.ts";
import {
	activityText,
	buildCallLines,
	buildCardLines,
	buildResultMessageLines,
	type CardSnapshot,
	EMPTY_COMPONENT,
	formatRow,
	LinesComponent,
	type RowSnapshot,
	snapshotChild,
	snapshotDetached,
	type TaskDetails,
	widgetAgents,
} from "./render.ts";
import { formatStructuredData } from "./structured.ts";
import { createHubKeyHandler, type InspectorOpenOptions, openInspector } from "./inspector.ts";
import {
	createNativeUI,
	type IrcDetails,
	jsonCopy,
	type NativeComponentContext,
	type NativeNode,
	type NativeUiEvent,
	persistRow,
	WIDGET_TOGGLE_ACTION,
	withNativeDescribe,
} from "./native.ts";

const LEGACY_RESULT_MESSAGE_TYPE = "subagent-result";
const TICK_MS = 150;
const WIDGET_KEY = "task-agents";
const WIDGET_MAX_ROWS = 6;

const TaskParams = buildTaskParams(DEFAULT_AGENT);

const IrcParams = Type.Object({
	op: StringEnum(["send", "wait", "list", "read", "kill"] as const),
	to: Type.Optional(Type.String({ description: 'send: recipient agent name, or "all" (broadcast to every agent; no automatic replies)' })),
	message: Type.Optional(Type.String({ description: "send: message body" })),
	from: Type.Optional(Type.String({ description: "wait: only return events from this agent" })),
	id: Type.Optional(Type.String({ description: "read/kill: agent name" })),
	timeoutSec: Type.Optional(Type.Number({ description: "wait: timeout in seconds (default 300)" })),
});

function textResult(text: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

interface ScreenView {
	lines: string[];
	free: boolean;
}

type ScreenTui = TuiMainScreen | TuiAltScreen;

function readScreen(tui: ScreenTui | undefined): ScreenView | undefined {
	try {
		if (tui?.mode === "fullscreen" && typeof tui.getScreenLines === "function") {
			return { lines: tui.getScreenLines().map(stripTerminalSequences), free: true };
		}
		if (tui?.mode === "regular" && typeof tui.captureRenderState === "function") {
			const s = tui.captureRenderState();
			if (Array.isArray(s?.previousLines)) {
				const rows = tui.terminal?.rows ?? 24;
				const top = typeof s.previousViewportTop === "number" ? s.previousViewportTop : Math.max(0, s.previousLines.length - rows);
				return { lines: s.previousLines.slice(top).map(stripTerminalSequences), free: false };
			}
		}
	} catch {}
	return undefined;
}

function onScreen(screen: string[], sig: string[] | undefined): boolean {
	if (!sig || sig.length === 0 || !sig[0]) return false;
	const first = sig[0];
	for (let i = 0; i + sig.length <= screen.length; i++) {
		if (!screen[i]!.includes(first)) continue;
		let ok = true;
		for (let k = 1; k < sig.length && ok; k++) ok = screen[i + k]!.includes(sig[k]!);
		if (ok) return true;
	}
	return false;
}

interface LiveCard {
	ids: string[];
	invalidate: () => void;
	sig?: string[];
	visible: boolean;
	foldedIds?: ReadonlySet<string>;
}

export default function (pi: ExtensionAPI) {
	const hub = new AgentHub(pi);
	hub.hooks = createFeatureHooks(hub);
	let tuiRef: ScreenTui | undefined;
	let inNativeView = false;
	let uiActive = false;
	let mentionSource: MentionSource | undefined;
	const mentionChipProvider = createMentionChipProvider(() => mentionSource);
	let offMentionChips: (() => void) | undefined;
	let frame = 0;
	const cards = new Map<string, LiveCard>();
	let ticker: NodeJS.Timeout | undefined;
	let soon: NodeJS.Timeout | undefined;
	let offHubKeys: (() => void) | undefined;
	let inspectorOpen = false;
	let hubVersion = 0;
	const native = createNativeUI({ hub, version: () => hubVersion, widgetRows: WIDGET_MAX_ROWS });
	const agentDir = getAgentDir();
	let widgetCollapsed = false;

	const showInspector = async (ui: ExtensionContext["ui"], opts: InspectorOpenOptions = {}) => {
		if (inspectorOpen) return;
		inspectorOpen = true;
		try {
			await openInspector(ui, hub, opts);
		} catch (e) {
			try {
				ui.notify(`Agent inspector failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			} catch {}
		} finally {
			inspectorOpen = false;
		}
	};

	type QueuedInput = "steer" | "followUp";
	const waitBreakers = new Set<(kind: QueuedInput) => void>();
	let lastInput: { kind: QueuedInput; reported: boolean } | undefined;
	const userInputQueued = (kind: QueuedInput, ctx: ExtensionContext | undefined) => {
		const wasPending = !!ctx?.hasPendingMessages?.();
		lastInput = { kind, reported: false };
		if (waitBreakers.size === 0) return;
		// pi queues input only after all input handlers finish.
		const started = Date.now();
		const poll = () => {
			const queued = wasPending ? Date.now() - started >= 30 : !!ctx?.hasPendingMessages?.();
			if (queued) {
				if (lastInput) lastInput.reported = true;
				for (const end of [...waitBreakers]) end(kind);
			} else if (Date.now() - started < 2000) {
				setTimeout(poll, 5).unref?.();
			}
		};
		setTimeout(poll, 0).unref?.();
	};
	const pendingUserInput = (ctx: ExtensionContext | undefined): QueuedInput | undefined => {
		if (!ctx?.hasPendingMessages?.()) {
			lastInput = undefined;
			return undefined;
		}
		const kind = lastInput?.kind ?? "steer";
		// pi delivers follow-ups only after the turn ends.
		if (kind === "followUp" && lastInput?.reported) return undefined;
		if (lastInput) lastInput.reported = true;
		return kind;
	};
	const userInputText = (kind: QueuedInput, interrupted: boolean): string => {
		const running = hub.active().map((c) => c.id);
		const agents = running.length
			? `Your subagents keep running (${running.join(", ")}) and their results still auto-deliver.`
			: "No subagents are running.";
		const head = interrupted ? "Wait interrupted: the user sent you a message" : "Not waiting: the user has sent you a message";
		return kind === "steer"
			? `${head}. It is delivered right after this result: read it and act on it. ${agents}`
			: `${head} as a follow-up, delivered when you end your turn. ${agents} End your turn to read it (wait again only if you must keep blocking).`;
	};

	const coveredByVisibleCard = (): Set<string> => {
		const covered = new Set<string>();
		const visit = (c: Child, foldedIds?: ReadonlySet<string>) => {
			if (foldedIds?.has(c.id)) return;
			covered.add(c.id);
			for (const child of c.owned) visit(child, foldedIds);
		};
		for (const card of cards.values()) {
			if (!card.visible) continue;
			for (const id of card.ids) {
				const c = hub.children.get(id);
				if (c) visit(c, card.foldedIds);
			}
		}

		return covered;
	};

	const tick = () => {
		frame++;
		const view = cards.size && !inNativeView ? readScreen(tuiRef) : undefined;
		for (const [key, card] of cards) {
			const live = card.ids.some((id) => subtreeActive(hub.children.get(id)));
			if (card.sig && !inNativeView) card.visible = view ? onScreen(view.lines, card.sig) : false;
			// Repainting rows above pi's main-screen viewport clears scrollback.
			if (!view || view.free || card.visible) {
				try {
					card.invalidate();
				} catch {}
			}
			if (!live) cards.delete(key);
		}
		try {
			tuiRef?.requestRender?.();
		} catch {}
		if (!hub.hasActive() && cards.size === 0) stopTicker();
	};
	const startTicker = () => {
		if (!uiActive || ticker || inNativeView) return;
		ticker = setInterval(tick, TICK_MS);
		ticker.unref?.();
	};
	const stopTicker = () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
	};
	hub.onChange(() => {
		hubVersion++;
		if (!uiActive) return;
		startTicker();
		if (!soon) {
			soon = setTimeout(() => {
				soon = undefined;
				tick();
			}, 40);
			soon.unref?.();
		}
	});

	const setWidgetCollapsed = (collapsed: boolean, ui: ExtensionContext["ui"]) => {
		try {
			writeConfig(agentDir, { widgetCollapsed: collapsed });
		} catch (error) {
			ui.notify(`Could not save the subagent widget setting: ${error}`, "warning");
			return false;
		}

		widgetCollapsed = collapsed;
		tuiRef?.requestRender();

		return true;
	};

	const widget = (
		theme: Theme,
		ui: ExtensionContext["ui"],
	): Component & { describe(cx: NativeComponentContext): NativeNode | null; handleNativeEvent(event: NativeUiEvent): void } => ({
		invalidate: () => {},
		describe: (cx) => {
			const node = native.describeWidget(cx, widgetCollapsed);
			if (node && !inNativeView) {
				inNativeView = true;
				stopTicker();
			}

			return node;
		},
		handleNativeEvent: (event) => {
			if (event.type === "action" && event.act === WIDGET_TOGGLE_ACTION) setWidgetCollapsed(!widgetCollapsed, ui);
		},
		render: (width) => {
			if (inNativeView) {
				inNativeView = false;
				if (hub.hasActive()) startTicker();
			}
			const agents = widgetAgents(hub, WIDGET_MAX_ROWS, widgetCollapsed, coveredByVisibleCard);
			if (!agents) return [];

			const now = Date.now();
			const out: string[] = [];
			for (const c of agents.rows) {
				const snap = snapshotChild(c, 0, now, false);
				let line = formatRow(snap, theme, Number.POSITIVE_INFINITY, frame, { model: false });
				if (c.depth > 1) line = `${theme.fg("dim", `${"  ".repeat(c.depth - 2)}└─`)} ${line}`;
				const act = activityText(snap, theme);
				if (act) line += ` ${theme.fg("dim", "↳")} ${act}`;
				out.push(truncateToWidth(` ${line}`, width, "…"));
			}
			out.push(truncateToWidth(` ${theme.fg("dim", agents.tail)}`, width, "…"));
			return out;
		},
	});

	pi.on("session_start", async (_e, ctx) => {
		widgetCollapsed = readConfig(agentDir, (message) => ctx.ui.notify(message, "warning")).widgetCollapsed;
		uiActive = ctx.hasUI && ctx.mode === "tui";
		mentionSource = {
			models: () => {
				const scoped = ctx.scopedModels.map((s) => s.model);
				return scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
			},
			current: () => ctx.model,
		};
		if (!ctx.hasUI) return;
		if (ctx.mode === "tui") {
			try {
				ctx.ui.addAutocompleteProvider((current) => createMentionAutocomplete(current, () => mentionSource));
			} catch {}
			offMentionChips?.();
			offMentionChips = registerEditorChipProvider("subagent.mentions", mentionChipProvider);
			void seedMentionHistory().catch(() => {});
			try {
				offHubKeys?.();
				offHubKeys = ctx.ui.onTerminalInput(
					createHubKeyHandler({
						tui: () => tuiRef,
						editorText: () => ctx.ui.getEditorText(),
						isOpen: () => inspectorOpen,
						hasAgents: () => hub.children.size > 0,
						open: (opts) => void showInspector(ctx.ui, opts),
					}),
				);
			} catch {}
		}
		try {
			ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
				tuiRef = tui as ScreenTui;
				return widget(theme, ctx.ui);
			});
		} catch {}
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		mentionSource = undefined;
		offMentionChips?.();
		offMentionChips = undefined;
		try {
			offHubKeys?.();
		} catch {}
		offHubKeys = undefined;
		stopTicker();
		if (soon) clearTimeout(soon);
		soon = undefined;
		cards.clear();
		inNativeView = false;
		uiActive = false;
		tuiRef = undefined;
		// Dispose agents before sweeping worktrees to preserve unsaved changes.
		const notes = await hub.disposeAll();
		await removeAllWorktrees();
		const kept = notes.filter((n) => n.includes("NOT saved"));
		if (kept.length) {
			try {
				ctx?.ui?.notify(`Subagent worktrees kept (unsaved changes):\n${kept.join("\n")}`, "warning");
			} catch {}
		}
	});

	const buildMentionNotice = (text: string) => {
		if (!mentionSource) return undefined;
		let mentions: ReturnType<typeof findMentions> = [];
		try {
			mentions = findMentions(text, mentionSource);
		} catch {
			return undefined;
		}
		if (mentions.length === 0) return undefined;
		recordMentions(mentions);
		if (!pi.getActiveTools().includes("task")) return undefined;
		return {
			customType: MENTION_NOTICE_TYPE,
			content: mentionNotice(mentions, DEFAULT_AGENT),
			display: false,
			details: { models: mentions.map((m) => `${m.model.provider}/${m.model.id}`) },
		};
	};

	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;
		const message = buildMentionNotice(event.prompt);
		return message ? { message } : undefined;
	});

	pi.on("input", async (event, ctx) => {
		if (!event.streamingBehavior) return;
		userInputQueued(event.streamingBehavior, ctx);
		const message = buildMentionNotice(event.text);
		if (message) await pi.sendMessage(message, { deliverAs: event.streamingBehavior });
	});

	pi.on("message_start", async (event) => {
		const m = event.message as { role?: string; customType?: string; details?: unknown; content?: unknown };
		if (m.role !== "custom" || (m.customType !== RESULT_MESSAGE_TYPE && m.customType !== IRC_MESSAGE_TYPE)) return;
		hub.markParentDelivered(m.details, m.content);
	});
	pi.on("agent_settled", async () => {
		hub.clearParentBacklog();
	});

	// pi exits on settle in print and JSON modes.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (ctx.hasUI || !hub.hasActive()) return;
		const quiet = new AbortController();
		const off = hub.onChange(() => {
			if (!hub.hasActive()) quiet.abort();
		});
		let ev: ParentEvent | null;
		try {
			ev = await hub.waitForParent(() => true, 0, ctx.signal ? AbortSignal.any([ctx.signal, quiet.signal]) : quiet.signal);
		} catch (e) {
			if (quiet.signal.aborted && !ctx.signal?.aborted) return;
			throw e;
		} finally {
			off();
		}
		if (!ev) return;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: ev.kind === "done" ? RESULT_MESSAGE_TYPE : IRC_MESSAGE_TYPE,
					content: formatParentEvent(ev),
					display: true,
					details: ev,
				},
			],
			continue: true,
		};
	});

	const description = buildTaskDescription(discoverAgents(process.cwd(), false), DEFAULT_AGENT, MAX_TASKS_PER_CALL, {
		canNest: MAX_DEPTH > 1,
	});

	const cardSnapshot = (details: TaskDetails, context: string | undefined, expanded: boolean, isError: boolean): CardSnapshot => {
		const now = Date.now();
		const liveHub = details.hub === hub.instanceId;
		const rows: RowSnapshot[] = details.items.map((item, i) => {
			const c = liveHub ? hub.children.get(item.id) : undefined;
			return c ? snapshotChild(c, i, now, expanded) : snapshotDetached(item, i);
		});
		let end = details.startedAt;
		let anyActive = false;
		for (const item of details.items) {
			const c = liveHub ? hub.children.get(item.id) : undefined;
			if (subtreeActive(c)) anyActive = true;
			else if (c?.finishedAt) end = Math.max(end, c.finishedAt);
		}
		return {
			rows,
			errors: details.errors ?? [],
			context,
			wallMs: (anyActive ? now : end) - details.startedAt,
			frame,
			isError,
		};
	};

	pi.registerTool({
		name: "task",
		label: "Task",
		description,
		promptSnippet: TASK_PROMPT_SNIPPET,
		promptGuidelines: TASK_PROMPT_GUIDELINES,
		parameters: TaskParams,
		prepareArguments: prepareTaskArguments,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const startedAt = Date.now();
			const agents = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
			const r = await hub.spawnTasks(params, ctx, { policy: unrestrictedPolicy(agents), cwd: ctx.cwd });
			if (r.children.length === 0 && r.failures.length === 0) return textResult(r.text, undefined, true);
			const details: TaskDetails = {
				hub: hub.instanceId,
				ids: r.children.map((c) => c.id),
				items: r.children.map((c) => ({
					id: c.id,
					agent: c.agent.name,
					task: firstLine(c.task),
					model: c.modelLabel,
					thinking: c.thinking,
					isolated: c.isolated || undefined,
					structured: c.schema ? true : undefined,
				})),
				errors: r.failures,
				startedAt,
			};
			return textResult(r.text, details, r.isError);
		},

		renderCall(args, theme, context) {
			if (context.state?.hasResult || (context.executionStarted && !context.isPartial)) return EMPTY_COMPONENT;
			return new LinesComponent((width) => buildCallLines(args, theme, width, context.expanded));
		},

		renderResult(result, { expanded }, theme, context) {
			if (context.state) context.state.hasResult = true;
			const details = result.details as TaskDetails | undefined;
			const args = context.args as { context?: string } | undefined;
			if (!details || !Array.isArray(details.items)) {
				const t = result.content.find((c) => c.type === "text");
				const snap: CardSnapshot = {
					rows: [],
					errors: [],
					context: args?.context,
					wallMs: 0,
					frame,
					isError: context.isError,
					fallbackText: t && t.type === "text" ? t.text : "",
				};
				return new LinesComponent((width) => buildCardLines(snap, theme, width, expanded));
			}
			const snap = cardSnapshot(details, args?.context, expanded, context.isError);
			const live = details.hub === hub.instanceId && details.ids.some((id) => subtreeActive(hub.children.get(id)));
			const foldedIds = live && uiActive ? new Set<string>() : undefined;
			const component = new LinesComponent((width) => buildCardLines(snap, theme, width, expanded, foldedIds));
			if (live && uiActive) {
				const prev = cards.get(context.toolCallId);
				const card: LiveCard = { ids: details.ids, invalidate: context.invalidate, visible: prev?.visible ?? true, sig: prev?.sig, foldedIds: prev?.foldedIds };
				component.onRender = (lines) => {
					// Keep blank rows to align the screen match.
					card.sig = lines.map((l) => stripTerminalSequences(l).trim());
					card.foldedIds = foldedIds;
				};
				cards.set(context.toolCallId, card);
				startTicker();
			} else {
				cards.delete(context.toolCallId);
			}
			return component;
		},

		...native.task,
	});

	pi.registerTool({
		name: "irc",
		label: "IRC",
		description: [
			"Coordinate with task subagents (address them by name).",
			'op "send": message `to` (agent name, or "all"). A running agent receives it at its next step (use this to steer/correct it mid-task); an idle agent is woken and its reply is delivered back to you. "all" reaches every agent and draws no automatic replies. Never blocks.',
			'op "wait": block until the next task result or agent message (optionally only `from` one agent); it returns early when the user sends you a message (your subagents keep running), and at once when a result or message is already on its way to you. Only when you are completely blocked on a result and have nothing else to do first; results otherwise auto-deliver. Nothing left at all but waiting on your subagents? End your turn instead: each result and message starts your next turn. A result arrived and others still run? Act on it before waiting again. NEVER wait for messages nobody owes you.',
			'op "list": roster with status (nested subagents indented under the agent that spawned them). op "read": full latest output + recent activity of `id` (e.g. when a delivered result was truncated). op "kill": abort `id` and its subagents.',
		].join(" "),
		promptSnippet: "Message/steer task subagents, wait for them, list/read/kill",
		parameters: IrcParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			switch (params.op) {
				case "send":
					try {
						return textResult(await hub.send(PARENT_ID, params.to ?? "", params.message ?? ""));
					} catch (e) {
						return textResult(e instanceof Error ? e.message : String(e), undefined, true);
					}
				case "list": {
					const list = describeTree(hub.tree());
					const now = Date.now();
					const details: IrcDetails = {
						op: "list",
						agents: [...hub.children.values()].filter((c) => c.ownerId === PARENT_ID).map((c) => persistRow(c, now)),
					};
					return textResult(list.length ? list.join("\n") : "No subagents.", details);
				}
				case "read": {
					const c = hub.children.get(params.id ?? "");
					if (!c) return textResult(`Unknown agent "${params.id}". Known: ${[...hub.children.keys()].join(", ") || "none"}`, undefined, true);
					const details: IrcDetails = { op: "read", agent: persistRow(c, Date.now(), true) };
					return textResult(readReport(c), details);
				}
				case "kill":
					try {
						const notes = await hub.kill(params.id ?? "", { by: PARENT_ID });
						return textResult([`Killed ${params.id}.`, ...notes].join("\n"));
					} catch (e) {
						return textResult(e instanceof Error ? e.message : String(e), undefined, true);
					}
				case "wait": {
					const pending = pendingUserInput(ctx);
					if (pending) return textResult(userInputText(pending, false), { op: "wait", pending } satisfies IrcDetails);
					// A sibling task call may still be registering its agents.
					await hub.spawnsSettled(PARENT_ID);
					const from = params.from?.trim() || undefined;
					if (from && !hub.children.has(from)) {
						return textResult(`Unknown agent "${from}". Known: ${[...hub.children.keys()].join(", ") || "none"}`, undefined, true);
					}
					const filter = (ev: ParentEvent) => !from || (ev.kind === "done" ? ev.done.id === from : ev.msg.from === from);
					// pi injects queued results only after this tool batch.
					const queued = hub.queuedForParent(filter).map((ev) => (ev.kind === "done" ? `result of ${ev.done.id}` : `message from ${ev.msg.from}`));
					if (queued.length > 0) {
						const more = queued.length > 1 ? ` (and ${queued.length - 1} more)` : "";
						return textResult(`Already arrived: ${queued[0]}${more}; delivered right after this call.`, { op: "wait", queued } satisfies IrcDetails);
					}
					if (!hub.hasActive() && !from) return textResult("No running subagents to wait for.", { op: "wait", idle: true } satisfies IrcDetails);
					const target = from ? hub.children.get(from) : undefined;
					if (target && !subtreeActive(target)) {
						return textResult(
							`\`${target.id}\` is ${target.status}: nothing is running that could reply. Its last result was already delivered (irc read ${target.id}).`,
							{ op: "wait" } satisfies IrcDetails,
						);
					}
					const timeout = Math.max(1, params.timeoutSec ?? 300) * 1000;
					const interrupt = new AbortController();
					let interruptedBy: QueuedInput | undefined;
					const end = (kind: QueuedInput) => {
						interruptedBy = kind;
						interrupt.abort();
					};
					waitBreakers.add(end);
					// Delivery must resolve the wait before inactivity aborts it.
					let stopped = false;
					const stop = () => {
						stopped = true;
						interrupt.abort();
					};
					const offStopped = target
						? hub.onInactive(target.id, stop)
						: hub.onChange(() => {
								if (!hub.hasActive()) stop();
							});
					try {
						const ev = await hub.waitForParent(filter, timeout, signal ? AbortSignal.any([signal, interrupt.signal]) : interrupt.signal);
						const active = ev ? [] : hub.active();
						const running = active.map((c) => c.id);
						let runningLabels: string[] | undefined;
						for (let i = 0; i < active.length; i++) {
							const c = active[i]!;
							const percent = completionPercent(c);
							if (percent !== undefined) {
								runningLabels ??= [...running];
								runningLabels[i] = `${c.id} (${percent}%${c.probe?.stage ? `: ${c.probe.stage}` : ""})`;
							}
						}
						const now = Date.now();
						const text = ev
							? formatParentEvent(ev)
							: active.length
								? `Timed out; agents still running:\n${active.map((c) => describeProgress(c, now)).join("\n")}\nTheir results still auto-deliver. Still blocked on one? Call irc wait again; otherwise keep working or end your turn. NEVER use sleep to wait longer.`
								: "Timed out; agents still running: none";
						const details: IrcDetails = ev
							? { op: "wait", event: jsonCopy(ev), interrupted: interruptedBy }
							: { op: "wait", timedOut: true, running, runningLabels, interrupted: interruptedBy };
						return textResult(interruptedBy ? `${text}\n\n${userInputText(interruptedBy, false)}` : text, details);
					} catch (e) {
						if (interruptedBy && !signal?.aborted) return textResult(userInputText(interruptedBy, true), { op: "wait", interrupted: interruptedBy } satisfies IrcDetails);
						if (stopped && !signal?.aborted) {
							return target
								? textResult(`\`${target.id}\` stopped (${target.status}) without replying.`, { op: "wait" } satisfies IrcDetails)
								: textResult("No agent is running any more: nothing further will arrive.", { op: "wait", idle: true } satisfies IrcDetails);
						}
						return textResult(e instanceof Error ? e.message : String(e), undefined, true);
					} finally {
						waitBreakers.delete(end);
						offStopped();
					}
				}
			}
			return textResult(`Unknown op.`, undefined, true);
		},

		renderCall(args, theme) {
			return new LinesComponent((width) => {
				let text = theme.fg("toolTitle", theme.bold("irc ")) + theme.fg("muted", args.op ?? "");
				if (args.op === "send") {
					const body = (args.message ?? "").replace(/\s+/g, " ");
					text += ` ${theme.fg("accent", `→ ${args.to ?? "?"}`)}${theme.fg("dim", ` ${body}`)}`;
				} else if (args.id || args.from) {
					text += ` ${theme.fg("accent", args.id ?? args.from ?? "")}`;
				}
				return [truncateToWidth(text, width, "…")];
			});
		},

		...native.irc,
	});

	const expandHint = () => {
		try {
			return keyHint("app.tools.expand", "to expand");
		} catch {
			return "";
		}
	};
	const renderEvent = (message: any, expanded: boolean, outputPad: number, theme: Theme): Component => {
		const ev = message.details as ParentEvent | undefined;
		if (ev?.kind === "done") {
			const d = ev.done as Partial<DoneInfo> & { childId?: string; stats?: string };
			const bad = d.status === "failed" || d.status === "aborted";
			const box = new Box(outputPad, 1, (t: string) => theme.bg(bad ? "toolErrorBg" : "toolSuccessBg", t));
			const hint = expandHint();
			box.addChild(new LinesComponent((width) => buildResultMessageLines(d, theme, width, expanded, hint)));
			if (expanded) {
				const body =
					d.data !== undefined
						? `\`\`\`json\n${formatStructuredData(d.data, 8000)}\n\`\`\``
						: (d.output ?? "").trim() || (d.error ? `Error: ${d.error}` : "(no output)");
				box.addChild(new Markdown(body, 2, 0, getMarkdownTheme()));
			}
			return box;
		}
		const box = new Box(outputPad, 1, (t: string) => theme.bg("customMessageBg", t));
		let header: string;
		let body: string;
		if (ev?.kind === "message") {
			header = `${theme.fg("warning", "✉")} ${theme.fg("toolTitle", theme.bold("irc "))}${theme.fg("accent", `${ev.msg.from} → ${ev.msg.to}`)}`;
			body = ev.msg.body;
		} else {
			header = theme.fg("toolTitle", message.customType);
			body = typeof message.content === "string" ? message.content : "";
		}
		box.addChild(new LinesComponent((width) => [truncateToWidth(header, width, "…")]));
		if (expanded) {
			box.addChild(new Markdown(body.trim(), 2, 0, getMarkdownTheme()));
		} else {
			const hint = expandHint();
			box.addChild(
				new LinesComponent((width) => {
					const lines = body.trim().split("\n");
					const out = lines.slice(0, 6).map((l) => truncateToWidth(`  ${theme.fg("toolOutput", l)}`, width, "…"));
					if (lines.length > 6) out.push(truncateToWidth(`  ${theme.fg("muted", `… ${lines.length - 6} more lines`)}${hint ? ` ${hint}` : ""}`, width, "…"));
					return out;
				}),
			);
		}
		return box;
	};
	const nativeEvent = (message: any, expanded: boolean, component: Component): Component =>
		withNativeDescribe(component, (cx) => native.describeEvent(message, expanded, cx));
	pi.registerMessageRenderer(RESULT_MESSAGE_TYPE, (m, o, t) => nativeEvent(m, o.expanded, renderEvent(m, o.expanded, o.outputPad, t)));
	pi.registerMessageRenderer(LEGACY_RESULT_MESSAGE_TYPE, (m, o, t) => nativeEvent(m, o.expanded, renderEvent(m, o.expanded, o.outputPad, t)));
	pi.registerMessageRenderer(IRC_MESSAGE_TYPE, (m, o, t) => nativeEvent(m, o.expanded, renderEvent(m, o.expanded, o.outputPad, t)));

	const idCompletions = (prefix: string) => {
		const first = prefix.split(/\s+/)[0] ?? "";
		if (prefix.includes(" ")) return null;
		const items = [...hub.children.values()]
			.filter((c) => c.status !== "aborted" && c.id.startsWith(first))
			.map((c) => ({
				value: `${c.id} `,
				label: c.id,
				description: `${c.agent.name} · ${c.status}${c.ownerId !== PARENT_ID ? ` · under ${c.ownerId}` : ""}`,
			}));
		return items.length ? items : null;
	};

	pi.registerCommand("irc", {
		description: "Message a subagent as the user: /irc <id|all> <message>",
		getArgumentCompletions: idCompletions,
		handler: async (args, ctx) => {
			const m = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!m) {
				ctx.ui.notify("Usage: /irc <id|all> <message>", "warning");
				return;
			}
			try {
				ctx.ui.notify(`${m[1]}: ${await hub.send(USER_ID, m[1]!, m[2]!)}`, "info");
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});

	const agentsCompletions = (prefix: string) => {
		const items = idCompletions(prefix) ?? [];
		const action = widgetCollapsed ? "expand" : "collapse";
		const value = action.startsWith(prefix) && !hub.children.has(action) ? action : `widget ${action}`;
		if (value.startsWith(prefix)) items.push({ value, label: value, description: `${action} the list of running agents` });

		return items.length ? items : null;
	};

	pi.registerCommand("agents", {
		description: "Inspect, message or kill subagents with /agents [id]. Use /agents widget collapse or /agents widget expand to change the list of running agents.",
		getArgumentCompletions: agentsCompletions,
		handler: async (args, ctx: ExtensionContext) => {
			const name = args.trim();
			const widgetAction = name.replace(/^widget\s+/, "");
			if ((widgetAction === "collapse" || widgetAction === "expand") && !hub.children.has(name)) {
				const collapsed = widgetAction === "collapse";
				if (setWidgetCollapsed(collapsed, ctx.ui)) {
					ctx.ui.notify(collapsed ? "The list of running agents is collapsed." : "The list of running agents is expanded.", "info");
				}
				return;
			}

			const id = name.split(/\s+/)[0] ?? "";
			if (id && !hub.children.has(id)) {
				ctx.ui.notify(`Unknown agent "${id}". Known: ${[...hub.children.keys()].join(", ") || "none"}`, "warning");
				return;
			}
			if (ctx.mode === "tui") {
				void showInspector(ctx.ui, { agentId: id || undefined });
				return;
			}
			const list = hub.tree();
			if (list.length === 0) {
				ctx.ui.notify("No subagents.", "info");
				return;
			}
			const labels = describeTree(list);
			const picked = id ? undefined : await ctx.ui.select("Subagents", labels);
			const child = id ? hub.children.get(id) : picked ? list[labels.indexOf(picked)] : undefined;
			if (!child) return;
			const actions = child.status === "aborted" ? ["Show output"] : ["Send message", "Show output", "Kill"];
			const action = await ctx.ui.select(child.id, actions);
			if (action === "Send message") {
				const body = await ctx.ui.editor(`Message to ${child.id}`);
				if (body?.trim()) ctx.ui.notify(`${child.id}: ${await hub.send(USER_ID, child.id, body)}`, "info");
			} else if (action === "Show output") {
				const out = latestOutput(child);
				const owner = child.ownerId !== PARENT_ID ? `\nOwner: ${child.ownerId}` : "";
				await ctx.ui.editor(
					`${child.id} (read-only view)`,
					`${describeChild(child)}${owner}\nTask: ${child.task}\n\n## Recent activity\n${child.activity.slice(-20).join("\n")}\n\n## Latest output\n${out}`,
				);
			} else if (action === "Kill") {
				const notes = await hub.kill(child.id, { notify: true, by: USER_ID });
				ctx.ui.notify([`Killed ${child.id}`, ...notes].join("\n"), "info");
			}
		},
	});
}

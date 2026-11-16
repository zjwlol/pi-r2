/**
 * /btw: ask a side question about the main session, off its transcript.
 *
 * Port of oh-my-pi's `/btw` (registration: `coding-agent/src/slash-commands/builtin-lifecycle.ts`
 * l. 488–503; `side: true` routing and keys: `modes/controllers/input-controller.ts`; reference:
 * `docs/slash-command-internals.md` §11). This file only wires pi to the controller:
 *
 * - the `/btw` command (a question, bare for history, or the private branch token);
 * - one widget above the editor (the dock of the inline answer panel) and one terminal-input
 *   handler for Esc / `c` / `f` / `b` / alt+i on the main prompt editor;
 * - the main turn's in-flight assistant message, so a question asked mid-turn sees it;
 * - the `input` event: `side: true` prompt templates run as side questions, and a sent inject is
 *   confirmed when its text shows up;
 * - the `btw.inject` setting (pi's settings.json: `{"btw": {"inject": true}}`, read per question);
 * - one `usage` entry per request, so its spend counts in the session totals.
 *
 * Interactive TUI only: in print, JSON and RPC modes nothing is mounted, nothing is intercepted and
 * `/btw` only says so.
 */

import { randomUUID } from "node:crypto";
import type { AssistantMessage, SimpleStreamOptions, ThinkingBudgets, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, copyToClipboard, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { resolveDraftImages } from "../shared/draft-images.ts";
import { branchBlocker } from "./branch.ts";
import { BtwController } from "./controller.ts";
import type { BtwHost } from "./controller.ts";
import type { BtwHistoryPanel } from "./history-panel.ts";
import { createBtwKeyHandler, probeEditor } from "./keys.ts";
import { BtwDock } from "./panel.ts";
import { sanitizeErrorLine } from "./records.ts";
import type { SideContextInput } from "./request.ts";
import { expandSideTemplate, parseSlashInvocation, readSideTemplate, sideTitle } from "./side-commands.ts";
import { historyDirectory } from "./store.ts";

const WIDGET_KEY = "btw";
/** `kind` of the usage entries appended for side requests (pi sums them; only `cache_warm` is rendered). */
const USAGE_KIND = "btw";
/** Argument prefix of the branch dispatch; the NUL keeps it from ever being typed. */
const BRANCH_PREFIX = "\u0000btw-branch:";
const SESSION_CHANGED = "the session changed since /btw started";

/** The writable part of pi's SessionManager the extension API types as read-only (as subagent/usage.ts). */
type UsageWriter = { appendUsage?: (kind: string, provider: string, model: string, usage: Usage, note?: string) => unknown };

function hasSpend(usage: Usage | undefined): usage is Usage {
	if (!usage) return false;
	return !!(usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost?.total);
}

export default function btw(pi: ExtensionAPI): void {
	/** Per extension instance: only this runtime's `b` can ask for a branch. */
	const branchToken = BRANCH_PREFIX + randomUUID();
	let controller: BtwController | undefined;
	let offKeys: (() => void) | undefined;
	let tuiRef: TUI | undefined;
	let mounted = false;
	/** Latest assistant message of the main turn while it streams. */
	let streaming: AssistantMessage | undefined;

	/** pi behind the controller. A stale context (the session was replaced) throws on any access: do nothing then. */
	function createHost(ctx: ExtensionContext, dock: BtwDock): BtwHost {
		const guard = <T>(read: () => T, fallback: T): T => {
			try {
				return read();
			} catch {
				return fallback;
			}
		};
		let theme = ctx.ui.theme;
		/** pi's `images.blockImages`, read per question: no image content leaves in any request. */
		const blockImages = (): boolean =>
			guard(() => (pi.getSettings() as unknown as { images?: { blockImages?: unknown } }).images?.blockImages === true, false);
		return {
			dock,
			theme: () => (theme = guard(() => ctx.ui.theme, theme)),
			requestRender: () => guard(() => tuiRef?.requestRender(), undefined),
			terminalRows: () => guard(() => tuiRef?.terminal.rows, undefined) ?? process.stdout.rows ?? 24,
			notify: (message, kind = "info") => guard(() => ctx.ui.notify(message, kind), undefined),
			// Whichever renderer painted the dock last is the surface the user looks at.
			nativeActive: () => dock.lastPaint() === "native",
			injectEnabled: () => guard(() => (pi.getSettings() as unknown as { btw?: { inject?: unknown } }).btw?.inject === true, false),
			model: () => guard(() => ctx.model, undefined),
			sessionId: () => guard(() => ctx.sessionManager.getSessionId(), ""),
			leafId: () => guard(() => ctx.sessionManager.getLeafId(), null),
			isIdle: () => guard(() => ctx.isIdle(), false),
			historyDirectory: () => {
				const sm = ctx.sessionManager;
				// --no-session: history lives in memory only.
				return sm.getSessionFile() === undefined ? undefined : historyDirectory(getAgentDir(), sm.getSessionId());
			},
			// The projection is what the agent loop starts from (system head with prompt and tool
			// declarations, compaction applied), so the side request shares the main loop's prefix.
			// With `images.blockImages` the request builder replaces images as pi's own requests do.
			sessionContext: () => {
				const input: Pick<SideContextInput, "messages" | "streaming" | "systemPrompt" | "blockImages"> = {
					messages: convertToLlm(ctx.sessionManager.buildSessionProjection().messages),
					streaming,
					systemPrompt: ctx.getSystemPrompt(),
					...(blockImages() ? { blockImages: true } : {}),
				};
				return input;
			},
			stream: (model, context, signal) => {
				const level = ctx.thinkingLevel ?? pi.getThinkingLevel();
				const settings = pi.getSettings() as unknown as {
					thinkingBudgets?: ThinkingBudgets;
					transport?: SimpleStreamOptions["transport"];
				};
				const budgets = settings.thinkingBudgets;
				// Same cache key, reasoning and transport as the main loop (which falls back to "auto"
				// when none is configured); `disableContinuation` keeps the side request out of the
				// conversation's server-side state, as pi's cache warmer does.
				return ctx.modelRegistry.streamSimple(model, context, {
					signal,
					sessionId: ctx.sessionManager.getSessionId(),
					disableContinuation: true,
					reasoning: level === "off" ? undefined : (level as SimpleStreamOptions["reasoning"]),
					transport: settings.transport ?? "auto",
					...(budgets ? { thinkingBudgets: budgets } : {}),
				});
			},
			recordUsage: (message, sessionId) => {
				try {
					const sm = ctx.sessionManager;
					if (sm.getSessionId() !== sessionId || !hasSpend(message.usage)) return;
					const writer = sm as unknown as UsageWriter;
					if (typeof writer.appendUsage !== "function") return;
					writer.appendUsage(USAGE_KIND, message.provider, message.responseModel ?? message.model, message.usage, "/btw");
					tuiRef?.requestRender();
				} catch {}
			},
			// Blocked images are not attached at all: nothing is read, saved with the turn or replayed.
			resolveImages: (text, scope) =>
				blockImages()
					? undefined
					: guard(() => resolveDraftImages(text, { vision: ctx.model ? ctx.model.input.includes("image") : true, scope }), undefined),
			copy: (text) => copyToClipboard(text),
			editorText: () => guard(() => ctx.ui.getEditorText(), ""),
			setEditorText: (text) => guard(() => ctx.ui.setEditorText(text), undefined),
			openHistory: (make) => {
				const opened: { panel?: BtwHistoryPanel } = {};
				// pi calls the factory synchronously and shows the overlay with focus; not awaited: the
				// promise settles when the overlay closes (never, when pi closes it on a session reset).
				void ctx.ui
					.custom<void>(
						(_tui, theme, _keybindings, done) => {
							opened.panel = make(theme, () => done());
							return opened.panel;
						},
						{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } },
					)
					.catch(() => {});
				if (!opened.panel) throw new Error("the history overlay did not open");
				return opened.panel;
			},
			// Unexpanded: model-written text never runs as a command or a template.
			sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "steer" }),
			// Only a command context can replace the session: route `b` through the /btw command.
			requestBranch: () => pi.sendUserMessage(`/btw ${branchToken}`, { expandPromptTemplates: true }),
			branchBlocker: (leafId) => guard(() => branchBlocker(ctx.sessionManager, leafId), SESSION_CHANGED),
		};
	}

	function teardown(ctx: ExtensionContext | undefined): void {
		// First: a running question is cancelled and saved while the session is still there.
		try {
			controller?.dispose();
		} catch {}
		controller = undefined;
		try {
			offKeys?.();
		} catch {}
		offKeys = undefined;
		try {
			if (mounted) ctx?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {}
		mounted = false;
		tuiRef = undefined;
		streaming = undefined;
	}

	pi.registerCommand("btw", {
		description: "Ask a side question, or browse this session's BTW history",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/btw is only available in the interactive TUI", "info");
				return;
			}
			if (args.startsWith(BRANCH_PREFIX)) {
				// A token of another runtime (dispatched before a reload) is dropped, never asked.
				if (args === branchToken) await controller?.performBranch(ctx);
				return;
			}
			const question = args.trim();
			// Not awaited: the command returns while the answer streams.
			void controller?.start(question, { fromEditor: true, restoreText: `/btw ${question}` });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		teardown(ctx);
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const dock = new BtwDock();
		try {
			// Mounted for the whole session; it renders nothing while no panel shows.
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui) => {
					tuiRef = tui;
					return dock;
				},
				{ placement: "aboveEditor" },
			);
			mounted = true;
		} catch {}
		const current = new BtwController(createHost(ctx, dock));
		controller = current;
		try {
			offKeys = ctx.ui.onTerminalInput(
				createBtwKeyHandler(
					current,
					probeEditor(
						() => tuiRef,
						() => ctx.ui.getEditorText(),
					),
				),
			);
		} catch {}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		teardown(ctx);
	});

	// The main turn's in-flight text: a question asked mid-turn is answered with it in view.
	const remember = (message: unknown): void => {
		if (controller && (message as { role?: string } | undefined)?.role === "assistant") streaming = message as AssistantMessage;
	};
	pi.on("message_start", async (event) => {
		remember(event.message);
	});
	pi.on("message_update", async (event) => {
		remember(event.message);
	});
	pi.on("turn_end", async () => {
		streaming = undefined;
	});
	pi.on("agent_end", async () => {
		streaming = undefined;
	});
	// `b to branch` follows the main turn.
	pi.on("agent_start", async () => {
		controller?.mainTurnChanged();
	});
	pi.on("agent_settled", async () => {
		controller?.mainTurnChanged();
	});

	pi.on("input", async (event, ctx) => {
		const current = controller;
		if (!current) return;
		if (event.source === "extension") {
			// A sent inject reached the session; the text continues as it is.
			current.confirmInject(event.text);
			return;
		}
		if (event.source !== "interactive" || ctx.mode !== "tui") return;
		const invocation = parseSlashInvocation(event.text);
		if (!invocation) return;
		if (invocation.name === "btw") {
			// pi dispatches a command only up to the first space: `/btw` followed by a line break or a
			// tab comes here instead. The question is still everything after `/btw`.
			const question = invocation.args.trim();
			void current.start(question, { fromEditor: true, restoreText: event.text });
			return { action: "handled" };
		}
		// `side: true` prompt templates answer as a side question: off the transcript and runnable
		// mid-turn. Extension commands never get here (pi ran them); `/skill:` names are no templates.
		let template: { sourceInfo: { path: string } } | undefined;
		try {
			const named = pi.getCommands().filter((command) => command.name === invocation.name);
			if (named.some((command) => command.source !== "prompt")) return;
			template = named[0];
		} catch {
			return;
		}
		if (!template) return;
		// Only a template proven `side: true` is intercepted: a file that can no longer be read or
		// parsed is left to pi, which expands the copy it loaded.
		let body: string | undefined;
		try {
			body = readSideTemplate(template.sourceInfo.path, parseFrontmatter);
		} catch {
			return;
		}
		if (body === undefined) return;
		let question: string;
		try {
			question = expandSideTemplate(body, invocation.args);
		} catch (error) {
			ctx.ui.notify(sanitizeErrorLine(error), "error");
			if (ctx.ui.getEditorText().trim() === "") ctx.ui.setEditorText(event.text);
			return { action: "handled" };
		}
		// The typed invocation heads the topic; the expanded template is what the model answers.
		void current.start(question, { title: sideTitle(invocation) });
		return { action: "handled" };
	});
}

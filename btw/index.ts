import { randomUUID } from "node:crypto";
import type { AssistantMessage, SimpleStreamOptions, ThinkingBudgets, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, copyToClipboard, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { moveImagesOutOfToolResults } from "../shared/bedrock-tool-images.ts";
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
const USAGE_KIND = "btw";
/**
 * The NUL separates branch dispatch from typed commands.
 */
const BRANCH_PREFIX = "\u0000btw-branch:";
const SESSION_CHANGED = "the session changed since /btw started";

/**
 * Pi exposes the usage writer at runtime but omits it from the context type.
 */
type UsageWriter = { appendUsage?: (kind: string, provider: string, model: string, usage: Usage, note?: string) => unknown };

function hasSpend(usage: Usage | undefined): usage is Usage {
	if (!usage) return false;
	return !!(usage.input || usage.output || usage.cacheRead || usage.cacheWrite || usage.cost?.total);
}

export default function btw(pi: ExtensionAPI): void {
	const branchToken = BRANCH_PREFIX + randomUUID();
	let controller: BtwController | undefined;
	let offKeys: (() => void) | undefined;
	let tuiRef: TUI | undefined;
	let mounted = false;
	let streaming: AssistantMessage | undefined;

	function createHost(ctx: ExtensionContext, dock: BtwDock): BtwHost {
		// Pi invalidates extension contexts after a session switch.
		const guard = <T>(read: () => T, fallback: T): T => {
			try {
				return read();
			} catch {
				return fallback;
			}
		};
		let theme = ctx.ui.theme;
		const blockImages = (): boolean =>
			guard(() => (pi.getSettings() as unknown as { images?: { blockImages?: unknown } }).images?.blockImages === true, false);
		return {
			dock,
			theme: () => (theme = guard(() => ctx.ui.theme, theme)),
			requestRender: () => guard(() => tuiRef?.requestRender(), undefined),
			terminalRows: () => guard(() => tuiRef?.terminal.rows, undefined) ?? process.stdout.rows ?? 24,
			notify: (message, kind = "info") => guard(() => ctx.ui.notify(message, kind), undefined),
			nativeActive: () => dock.lastPaint() === "native",
			injectEnabled: () => guard(() => (pi.getSettings() as unknown as { btw?: { inject?: unknown } }).btw?.inject === true, false),
			model: () => guard(() => ctx.model, undefined),
			sessionId: () => guard(() => ctx.sessionManager.getSessionId(), ""),
			leafId: () => guard(() => ctx.sessionManager.getLeafId(), null),
			isIdle: () => guard(() => ctx.isIdle(), false),
			historyDirectory: () => {
				const sm = ctx.sessionManager;
				return sm.getSessionFile() === undefined ? undefined : historyDirectory(getAgentDir(), sm.getSessionId());
			},
			// Use the session projection to preserve the main turn's prompt cache prefix.
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
				return ctx.modelRegistry.streamSimple(model, context, {
					signal,
					onPayload: moveImagesOutOfToolResults,
					sessionId: ctx.sessionManager.getSessionId(),
					// Keep side turns out of the provider's main conversation state.
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
			resolveImages: (text, scope) =>
				blockImages()
					? undefined
					: guard(() => resolveDraftImages(text, { vision: ctx.model ? ctx.model.input.includes("image") : true, scope }), undefined),
			copy: (text) => copyToClipboard(text),
			editorText: () => guard(() => ctx.ui.getEditorText(), ""),
			setEditorText: (text) => guard(() => ctx.ui.setEditorText(text), undefined),
			openHistory: (make) => {
				const opened: { panel?: BtwHistoryPanel } = {};
				// Pi calls the factory synchronously and resolves the promise only when the overlay closes.
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
			// Pi leaves model text unexpanded unless expansion is requested.
			sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "steer" }),
			// Only a command context can replace the session.
			requestBranch: () => pi.sendUserMessage(`/btw ${branchToken}`, { expandPromptTemplates: true }),
			branchBlocker: (leafId) => guard(() => branchBlocker(ctx.sessionManager, leafId), SESSION_CHANGED),
		};
	}

	function teardown(ctx: ExtensionContext | undefined): void {
		// Cancel and save the running question before releasing the session state.
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
				if (args === branchToken) await controller?.performBranch(ctx);
				return;
			}
			const question = args.trim();
			void controller?.start(question, { fromEditor: true, restoreText: `/btw ${question}` });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		teardown(ctx);
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const dock = new BtwDock();
		try {
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
			current.confirmInject(event.text);
			return;
		}
		if (event.source !== "interactive" || ctx.mode !== "tui") return;
		const invocation = parseSlashInvocation(event.text);
		if (!invocation) return;
		if (invocation.name === "btw") {
			// Pi only treats a space as a command delimiter.
			const question = invocation.args.trim();
			void current.start(question, { fromEditor: true, restoreText: event.text });
			return { action: "handled" };
		}
		let template: { sourceInfo: { path: string } } | undefined;
		try {
			const named = pi.getCommands().filter((command) => command.name === invocation.name);
			if (named.some((command) => command.source !== "prompt")) return;
			template = named[0];
		} catch {
			return;
		}
		if (!template) return;
		let body: string | undefined;
		try {
			body = readSideTemplate(template.sourceInfo.path, parseFrontmatter);
		} catch {
			// Pi can still expand the copy it already loaded.
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
		void current.start(question, { title: sideTitle(invocation) });
		return { action: "handled" };
	});
}

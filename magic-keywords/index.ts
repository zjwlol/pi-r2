/**
 * magic-keywords (ported from oh-my-pi)
 *
 * Type a magic keyword as a standalone word in your prompt and it glows with
 * an animated gradient in the editor (static in the sent message). When the
 * prompt is sent, the keyword's hidden notice is attached to that turn.
 *
 *   orchestrate  → act as an orchestrator: decompose, fan out parallel
 *                  subagents (task/subagent tool), verify, iterate, don't yield early.
 *
 * Keywords only count as prose: inside `code`, fenced blocks, XML/HTML, paths,
 * identifiers (foo-orchestrate, orchestrate()) they are ignored.
 * Keywords live in keywords.ts; notices in notices.ts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { patchUserMessages, setBubbleHook } from "./bubble.ts";
import { MagicEditor, stopAllEditors } from "./editor.ts";
import { findKeywords } from "./keywords.ts";
import type { PaintOptions } from "./paint.ts";

const NOTICE_TYPE = "magic-keyword-notice";

export default function (pi: ExtensionAPI) {
	/** Combined hidden notice for every keyword in `text`, given the active tools. */
	const buildNotice = (text: string) => {
		const keywords = findKeywords(text);
		if (keywords.length === 0) return undefined;
		const tools = pi.getActiveTools();
		const notices = keywords
			.map((k) => ({ id: k.id, text: k.notice(tools) }))
			.filter((n): n is { id: string; text: string } => !!n.text);
		if (notices.length === 0) return undefined;
		return {
			customType: NOTICE_TYPE,
			content: notices.map((n) => n.text).join("\n\n"),
			display: false,
			details: { keywords: notices.map((n) => n.id) },
		};
	};

	// Idle prompt: attach the notice to the run it starts.
	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;
		const message = buildNotice(event.prompt);
		return message ? { message } : undefined;
	});

	// Prompt typed while the agent is busy (steer / follow-up): queue the notice with it.
	pi.on("input", async (event) => {
		if (!event.streamingBehavior) return;
		const message = buildNotice(event.text);
		if (message) await pi.sendMessage(message, { deliverAs: event.streamingBehavior });
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const paintOptions = (): PaintOptions => paintOptionsFor(ctx);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new MagicEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			editor.paintOptions = paintOptions;
			return editor;
		});
		if (patchUserMessages()) setBubbleHook({ paintOptions });
	});

	pi.on("session_shutdown", async () => {
		stopAllEditors();
		setBubbleHook(undefined);
	});
}

function paintOptionsFor(ctx: ExtensionContext): PaintOptions {
	const theme = ctx.ui.theme;
	return { mode: theme.getColorMode(), appearance: theme.appearance };
}

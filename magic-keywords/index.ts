import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { patchUserMessages, setBubbleHook } from "./bubble.ts";
import { chipStyleFor } from "./chips.ts";
import { MagicEditor, stopAllEditors } from "./editor.ts";
import { findKeywords } from "./keywords.ts";
import type { PaintOptions } from "./paint.ts";

const NOTICE_TYPE = "magic-keyword-notice";

export default function (pi: ExtensionAPI) {
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

	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;
		const message = buildNotice(event.prompt);
		return message ? { message } : undefined;
	});

	// Pi skips `before_agent_start` for steers and follow-ups.
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
			editor.chipStyle = () => chipStyleFor(ctx.ui.theme);
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

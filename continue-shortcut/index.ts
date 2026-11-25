import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DIRECTIVE = `<system-notice>
Continue.

MUST resume most recent intent; complete unfinished work.
If interrupted mid-step: resume where stopped.
NEVER pause to summarize progress, re-confirm plan, or ask whether to proceed; continue.
</system-notice>
`;

export default function (pi: ExtensionAPI) {
	pi.on("input", (event, ctx) => {
		const fromEditor = event.source === "interactive" && ctx.mode === "tui";
		if (fromEditor && !event.images?.length && event.text.trim() === ".") {
			if (!ctx.isIdle()) return;

			const { messages } = ctx.sessionManager.buildSessionProjection();
			const hasConversation = messages.some(
				({ role }) => role === "user" || role === "branchSummary" || role === "compactionSummary",
			);
			if (hasConversation) {
				pi.sendMessage({ customType: "manual-continue", content: DIRECTIVE, display: false }, { triggerTurn: true });
			} else {
				ctx.ui.notify("Nothing to resume", "info");
			}

			return { action: "handled" };
		}
	});
}

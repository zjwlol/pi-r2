/**
 * /exit: alias for pi's built-in /quit.
 *
 * Like /quit it exits right away: a running turn is aborted first, then pi
 * shuts down cleanly (session_shutdown runs, so e.g. subagents and their
 * worktrees are cleaned up as usual).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Quit pi (same as /quit)",
		handler: async (_args, ctx) => {
			// ctx.shutdown() waits for a busy agent to settle; abort so it settles now.
			if (!ctx.isIdle()) ctx.abort();
			ctx.shutdown();
		},
	});
}

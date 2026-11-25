import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Quit pi (same as /quit)",
		handler: async (_args, ctx) => {
			// Pi waits for the agent to settle before shutting down.
			if (!ctx.isIdle()) ctx.abort();
			ctx.shutdown();
		},
	});
}

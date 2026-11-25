import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detect, registry, TspSession } from "./session.ts";

export default function (pi: ExtensionAPI) {
	let session: TspSession | null = null;
	let installError: string | null = null;

	// Install the render hooks before pi paints its first frame.
	try {
		session = new TspSession(detect());
		session.activate();
	} catch (error) {
		installError = error instanceof Error ? error.message : String(error);
		session = null;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (installError) {
			ctx.ui.notify(`tsp-native disabled: ${installError}`, "warning");
			return;
		}
		if (!session) {
			try {
				session = new TspSession(detect());
				session.activate();
			} catch (error) {
				ctx.ui.notify(`tsp-native disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
		}
		const orphan = registry().orphan;
		if (orphan && session.tui === null && orphan.session.tui) {
			const previous = orphan.session;
			clearTimeout(orphan.timer);
			registry().orphan = null;
			session.takeOver(previous);
		}
		session.attachContext(ctx);
	});

	pi.on("session_shutdown", async (event) => {
		session?.shutdown(event.reason);
		if (event.reason === "quit") session = null;
	});

	pi.registerCommand("tsp", {
		description: "TSP native rendering: status | off | on",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			if (!session) {
				ctx.ui.notify(`tsp-native is not active${installError ? `: ${installError}` : ""}`, "warning");
				return;
			}
			switch (sub) {
				case "":
				case "status":
					ctx.ui.notify(session.status(), "info");
					return;
				case "off":
					session.off();
					ctx.ui.notify("tsp-native: ANSI rendering (use /tsp on to re-probe)", "info");
					return;
				case "on": {
					const result = session.on();
					ctx.ui.notify(`tsp-native: ${result}`, "info");
					return;
				}
				default:
					ctx.ui.notify("usage: /tsp status | off | on", "warning");
			}
		},
	});
}

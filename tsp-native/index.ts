/**
 * tsp-native: switch pi's terminal UI to Tern Surface Protocol (TSP) native
 * rendering when a TSP terminal (Tern, or rmux brokering a Tern viewer) is
 * available. Without one the extension does nothing and pi renders normally.
 *
 * Detection: a `hello` probe (plus a DA1 sentinel) is sent only when
 * `PI_TUI_NATIVE` isn't `0` and `TERM_PROGRAM` is tern/rmux, `RMUX_TSP=1`, or
 * `PI_TUI_NATIVE=1`. No reply, or the wrong version, keeps the ANSI renderer.
 *
 * Commands: `/tsp status`, `/tsp off`, `/tsp on`.
 * Environment: `PI_TSP_DEBUG=1|<path>` log file, `PI_TSP_RECORD=<path>` JSONL
 * of every message, `PI_TSP_MIRROR=1` reference document for `/tsp status`,
 * `PI_TSP_FAIL_DESCRIBER=<name>` / `PI_TSP_FAIL_BACKEND=<frames>` test hooks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detect, registry, TspSession } from "./session.ts";

export default function (pi: ExtensionAPI) {
	let session: TspSession | null = null;
	let installError: string | null = null;

	// Install the trampolines now, before the TUI starts: the first render then
	// holds for the probe instead of painting rows that the surface would erase.
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
		// A predecessor (before /reload) may have left a live surface; the first render takes it over.
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

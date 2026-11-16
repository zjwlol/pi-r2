/**
 * remember-model
 *
 * 1. Remembers the last selected model + thinking level across restarts by
 *    writing defaultProvider/defaultModel/defaultThinkingLevel to
 *    ~/.pi/agent/settings.json (read by pi on startup for new sessions).
 * 2. Keeps a most-recently-used model list in ~/.pi/agent/model-history.json
 *    and makes the built-in /model selector show those models right after the
 *    current one (tagged "· 5m ago"). On first run the list is seeded from
 *    model changes in recent session files.
 */
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ModelHistory, scanSessionsForModels } from "./history.ts";
import { patchModelSelector, setSelectorHook } from "./model-selector.ts";

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const history = new ModelHistory(join(agentDir, "model-history.json"));
	let settings: SettingsManager | undefined;
	const getSettings = (cwd: string) => (settings ??= SettingsManager.create(cwd, agentDir));

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!patchModelSelector()) return;
		setSelectorHook({ recent: () => history.read(), theme: () => ctx.ui.theme });
		if (!history.exists()) {
			void scanSessionsForModels(join(agentDir, "sessions"))
				.then((seed) => history.merge(seed))
				.catch(() => {});
		}
	});

	pi.on("session_shutdown", async () => {
		setSelectorHook(undefined);
	});

	pi.on("model_select", async (event, ctx) => {
		// Explicit picks go to the front of the recent list right away. Ctrl+P
		// cycling and session restores only count once the model is used.
		if (event.source === "set") history.record(event.model.provider, event.model.id);

		// "restore" = resuming a session that had its own model; not a user pick.
		if (event.source === "restore") return;
		const s = getSettings(ctx.cwd);
		s.setDefaultModelAndProvider(event.model.provider, event.model.id);
		await s.flush();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.model) history.record(ctx.model.provider, ctx.model.id);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		const s = getSettings(ctx.cwd);
		s.setDefaultThinkingLevel(event.level);
		await s.flush();
	});
}

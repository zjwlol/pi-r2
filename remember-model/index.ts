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
		if (event.source === "set") history.record(event.model.provider, event.model.id);

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

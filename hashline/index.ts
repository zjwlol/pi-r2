import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ENV_OVERRIDE, envOverride, isEnabled, readConfig, writeConfig } from "./config.ts";
import { EditStore } from "./store.ts";
import { createHashlineEditTool, createHashlineReadTool } from "./tools.ts";

const SUBCOMMANDS = ["on", "off", "status"] as const;

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const active = isEnabled(agentDir, process.env);
	const store = new EditStore();

	if (active) {
		pi.registerTool(createHashlineReadTool({ store }));
		pi.registerTool(createHashlineEditTool({ store }));
	}

	pi.on("session_start", () => {
		store.clear();
	});

	const statusText = (): string => {
		const saved = readConfig(agentDir).enabled;
		const forced = envOverride(process.env);
		const lines = [`hashline: ${active ? "on" : "off"} in this session (read and edit are ${active ? "the hashline tools" : "pi's built-ins"})`];
		lines.push(`saved setting: ${saved ? "on" : "off"}`);
		if (forced !== undefined) lines.push(`${ENV_OVERRIDE} forces it ${forced ? "on" : "off"} for this process`);
		return lines.join("\n");
	};

	pi.registerCommand("hashline", {
		description: "Line-anchored read/edit tools: on | off | status",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			const items = SUBCOMMANDS.filter((name) => name.startsWith(typed)).map((name) => ({ value: name, label: name }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const notify = (message: string, level: "info" | "warning") => {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			};
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			if (sub === "" || sub === "status") {
				notify(statusText(), "info");
				return;
			}
			if (sub !== "on" && sub !== "off") {
				notify("Usage: /hashline [on|off|status]", "warning");
				return;
			}
			const want = sub === "on";
			if (!writeConfig(agentDir, { enabled: want })) {
				notify("hashline: could not write the setting", "warning");
				return;
			}
			const forced = envOverride(process.env);
			if (forced !== undefined && forced !== want) {
				notify(`hashline ${sub} saved, but ${ENV_OVERRIDE} forces it ${forced ? "on" : "off"} for this process`, "warning");
				return;
			}
			if (want === active) {
				notify(`hashline ${sub}`, "info");
				return;
			}
			notify(`hashline ${sub}: reloading extensions`, "info");
			// Pi fixes the tool set when extensions load.
			await ctx.reload();
		},
	});
}

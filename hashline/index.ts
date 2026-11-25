/**
 * hashline (ported from oh-my-pi's default edit mode)
 *
 * While on, `read` shows text files as a `[PATH#TAG]` header plus `LINE:TEXT` rows, and `edit` takes
 * a small patch language addressed by those line numbers under that header (`PUT 3.=5:` + `+` rows,
 * `PUT <N:` / `PUT >N:`, `CUT`, register pastes, `REM`, `MV`). A stale tag is recovered from when the
 * anchored lines are provably unchanged, else rejected with the current tag and rows.
 *
 *   /hashline [on|off|status]   switch it (persisted in <agentDir>/hashline/config.json) or show its state
 *   PI_HASHLINE=1|0             force it on / off for one process
 *
 * Off by default. Switching reloads pi's extensions, because the tool set is fixed when the extension
 * loads. Works in every mode (TUI, print, JSON, RPC). Subagents (the `subagent` extension starts them
 * with extensions disabled) keep pi's built-in read / edit.
 *
 * This file: registration, the session store's lifetime and the command. Engine: types.ts, format.ts,
 * messages.ts, diff.ts, tokenizer.ts, parser.ts, input.ts, clipboard.ts, block.ts, apply.ts, store.ts,
 * recovery.ts, patcher.ts. Tools: prompt.ts, read-format.ts, tools.ts. Switch: config.ts.
 *
 * Port of oh-my-pi `crates/pi-edit/src/modes/hashline/` and `crates/pi-edit/prompts/hashline.md` (MIT).
 */
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ENV_OVERRIDE, envOverride, isEnabled, readConfig, writeConfig } from "./config.ts";
import { EditStore } from "./store.ts";
import { createHashlineEditTool, createHashlineReadTool } from "./tools.ts";

const SUBCOMMANDS = ["on", "off", "status"] as const;

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	/** Whether this extension instance replaced `read` and `edit` (fixed until the next reload). */
	const active = isEnabled(agentDir, process.env);
	const store = new EditStore();

	if (active) {
		pi.registerTool(createHashlineReadTool({ store }));
		pi.registerTool(createHashlineEditTool({ store }));
	}

	// Tags and registers belong to one session.
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
		description: "Line-anchored read/edit tools (ported from oh-my-pi): on | off | status",
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
			// The tool set is fixed at load: reload so `read` and `edit` are registered (or not) again.
			await ctx.reload();
		},
	});
}

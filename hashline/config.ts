/**
 * hashline/config.ts: the persisted on/off switch, `<agentDir>/hashline/config.json`.
 * Same pattern as word-predict/host.ts (readConfig / writeConfig). Pure: node built-ins only.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const STATE_DIR_NAME = "hashline";
export const CONFIG_FILE = "config.json";
/** Environment override: `1` / `true` / `on` forces hashline on, `0` / `false` / `off` forces it off, for this process. */
export const ENV_OVERRIDE = "PI_HASHLINE";

export interface HashlineConfig {
	enabled: boolean;
}

/** The saved config; `{ enabled: false }` when the file is missing or unreadable (hashline is opt-in). */
export function readConfig(agentDir: string): HashlineConfig {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, STATE_DIR_NAME, CONFIG_FILE), "utf8"));
		const enabled = typeof parsed === "object" && parsed !== null ? (parsed as { enabled?: unknown }).enabled : undefined;
		return { enabled: enabled === true };
	} catch {
		return { enabled: false };
	}
}

/** Write the config atomically (temp file + rename). Returns false, leaving the old file, when the write fails. */
export function writeConfig(agentDir: string, config: HashlineConfig): boolean {
	const dir = path.join(agentDir, STATE_DIR_NAME);
	const tmp = path.join(dir, `${CONFIG_FILE}.${process.pid}.tmp`);
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(tmp, `${JSON.stringify({ enabled: config.enabled === true })}\n`, { mode: 0o600 });
		fs.renameSync(tmp, path.join(dir, CONFIG_FILE));
		return true;
	} catch {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// Nothing left to clean up.
		}
		return false;
	}
}

/** The environment override: true / false, or undefined when the variable is unset or not a recognised value. */
export function envOverride(env: Record<string, string | undefined>): boolean | undefined {
	const value = env[ENV_OVERRIDE]?.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "on") return true;
	if (value === "0" || value === "false" || value === "off") return false;
	return undefined;
}

/** Whether the hashline tools are registered for this process: the environment override, else the saved config. */
export function isEnabled(agentDir: string, env: Record<string, string | undefined>): boolean {
	return envOverride(env) ?? readConfig(agentDir).enabled;
}

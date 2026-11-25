import * as fs from "node:fs";
import * as path from "node:path";

export const STATE_DIR_NAME = "hashline";
export const CONFIG_FILE = "config.json";
export const ENV_OVERRIDE = "PI_HASHLINE";

export interface HashlineConfig {
	enabled: boolean;
}

export function readConfig(agentDir: string): HashlineConfig {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, STATE_DIR_NAME, CONFIG_FILE), "utf8"));
		const enabled = typeof parsed === "object" && parsed !== null ? (parsed as { enabled?: unknown }).enabled : undefined;
		return { enabled: enabled === true };
	} catch {
		return { enabled: false };
	}
}

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
		}
		return false;
	}
}

export function envOverride(env: Record<string, string | undefined>): boolean | undefined {
	const value = env[ENV_OVERRIDE]?.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "on") return true;
	if (value === "0" || value === "false" || value === "off") return false;
	return undefined;
}

export function isEnabled(agentDir: string, env: Record<string, string | undefined>): boolean {
	return envOverride(env) ?? readConfig(agentDir).enabled;
}

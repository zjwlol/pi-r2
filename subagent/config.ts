import * as fs from "node:fs";
import * as path from "node:path";

export interface SubagentConfig {
	widgetCollapsed: boolean;
}

function configPath(agentDir: string): string {
	return path.join(agentDir, "subagent", "config.json");
}

export function readConfig(agentDir: string, warn: (message: string) => void): SubagentConfig {
	const file = configPath(agentDir);
	try {
		const saved: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (saved !== null && typeof saved === "object" && "widgetCollapsed" in saved && typeof saved.widgetCollapsed === "boolean") {
			return { widgetCollapsed: saved.widgetCollapsed };
		}
		warn(`Expected "widgetCollapsed" to be true or false in "${file}".`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(`Could not read "${file}": ${error}`);
	}

	return { widgetCollapsed: false };
}

export function writeConfig(agentDir: string, config: SubagentConfig): void {
	const file = configPath(agentDir);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(config)}\n`, { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

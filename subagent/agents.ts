/**
 * Agent definition discovery.
 *
 * Precedence (first wins by name): project `.pi/agents/*.md` (trusted projects only),
 * user `~/.pi/agent/agents/*.md`, then bundled `./agents/*.md`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type JsonSchema, normalizeSchema } from "./structured.ts";

export type AgentSource = "project" | "user" | "bundled";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/**
	 * Agents this agent may spawn with its own `task` tool: `"*"` (any) or a list of names; absent =
	 * cannot spawn. A `task` entry in `tools` implies `"*"` (oh-my-pi compat). Still subject to MAX_DEPTH.
	 */
	spawns?: "*" | string[];
	model?: string;
	thinking?: string;
	/** Default output schema (`output:` frontmatter, JSON string or YAML mapping): tasks must `yield` matching data. */
	outputSchema?: JsonSchema;
	/** Why `output:` was rejected; tasks using this agent's default schema fail at spawn with it. */
	outputError?: string;
	/** Default for the task item's `isolated` (`isolated: true` frontmatter). */
	isolated?: boolean;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export const DEFAULT_AGENT = "task";

/** Used when no `task.md` can be found anywhere (e.g. bundled dir missing). */
export const FALLBACK_AGENT: AgentConfig = {
	name: DEFAULT_AGENT,
	description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
	spawns: "*",
	systemPrompt: "Worker agent: delegated tasks. MUST hyperfocus the assigned task; NEVER deviate.",
	source: "bundled",
	filePath: "",
};

/**
 * Tools that cannot change the filesystem or run commands. An agent is READ-ONLY iff it declares a
 * non-empty tool list that is a subset of this set (`irc` is always added and is coordination-only).
 * Fail-safe: any unknown tool (incl. `bash`) makes the agent not read-only.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "irc"]);

export function isReadOnlyAgent(agent: AgentConfig): boolean {
	return !!agent.tools?.length && agent.tools.every((t) => READ_ONLY_TOOLS.has(t));
}

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	spawns?: unknown;
	model?: unknown;
	thinking?: unknown;
	"thinking-level"?: unknown;
	thinkingLevel?: unknown;
	output?: unknown;
	isolated?: unknown;
};

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/** `spawns` frontmatter (OMP helpers.ts parseAgentFields): "*", CSV string, or YAML list. */
function parseSpawns(value: unknown, tools: string[] | undefined): "*" | string[] | undefined {
	if (typeof value === "string" && value.trim() === "*") return "*";
	const list = parseToolList(value);
	if (list?.includes("*")) return "*";
	if (list) return list;
	// Backward compat: `tools: [..., task]` means "may spawn anything".
	return tools?.includes("task") ? "*" : undefined;
}

function bool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string" && /^(true|yes|on)$/i.test(value.trim())) return true;
	if (typeof value === "string" && /^(false|no|off)$/i.test(value.trim())) return false;
	return undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(fs.readFileSync(filePath, "utf-8"));
			if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
			const tools = parseToolList(frontmatter.tools);
			const output = normalizeSchema(frontmatter.output);
			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools,
				spawns: parseSpawns(frontmatter.spawns, tools),
				model: str(frontmatter.model),
				thinking: str(frontmatter.thinking) ?? str(frontmatter["thinking-level"]) ?? str(frontmatter.thinkingLevel),
				outputSchema: output.schema,
				outputError: output.error,
				isolated: bool(frontmatter.isolated) || undefined,
				systemPrompt: body,
				source,
				filePath,
			});
		} catch {
			// One bad file must not hide the rest.
		}
	}
	return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function bundledAgentsDir(): string {
	// jiti (pi's extension loader) provides __dirname; fall back to import.meta for native ESM.
	// @ts-ignore TS1470: import.meta is fine at runtime; the type-check config may assume CommonJS output.
	const here = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "agents");
}

export interface SpawnPolicy {
	/** Spawnable agent definitions, in discovery order. */
	agents: AgentConfig[];
	/** Used when a task item omits `agent`: `task` for "*", else the first listed agent (OMP spawn-policy.ts). */
	defaultAgent: string;
	/** For rejection messages: "*" or the comma-separated allowlist. */
	allowedText: string;
}

/** The main agent may spawn every discovered agent. */
export function unrestrictedPolicy(agents: AgentConfig[]): SpawnPolicy {
	return { agents, defaultAgent: DEFAULT_AGENT, allowedText: "*" };
}

/**
 * Resolve an agent's `spawns` against the discovered agents. `undefined` = this agent cannot spawn
 * (no `spawns`, an empty list, or none of the listed agents exist). Depth limits are the caller's job.
 */
export function resolveSpawnPolicy(agent: AgentConfig, agents: AgentConfig[]): SpawnPolicy | undefined {
	const spawns = agent.spawns;
	if (!spawns || spawns.length === 0) return undefined;
	if (spawns === "*") return agents.length ? unrestrictedPolicy(agents) : undefined;
	const allowed = agents.filter((a) => spawns.includes(a.name));
	if (allowed.length === 0) return undefined;
	const defaultAgent = spawns.find((n) => allowed.some((a) => a.name === n)) ?? allowed[0]!.name;
	return { agents: allowed, defaultAgent, allowedText: allowed.map((a) => a.name).join(", ") };
}

export function discoverAgents(cwd: string, includeProject: boolean): AgentConfig[] {
	const byName = new Map<string, AgentConfig>();
	const add = (list: AgentConfig[]) => {
		for (const a of list) if (!byName.has(a.name)) byName.set(a.name, a);
	};
	if (includeProject) {
		const projectDir = findNearestProjectAgentsDir(cwd);
		if (projectDir) add(loadAgentsFromDir(projectDir, "project"));
	}
	add(loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user"));
	add(loadAgentsFromDir(bundledAgentsDir(), "bundled"));
	if (!byName.has(DEFAULT_AGENT)) byName.set(DEFAULT_AGENT, FALLBACK_AGENT);
	// Default agent first, then the rest in discovery order.
	const all = [...byName.values()];
	return [byName.get(DEFAULT_AGENT)!, ...all.filter((a) => a.name !== DEFAULT_AGENT)];
}

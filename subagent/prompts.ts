import { Type } from "typebox";
import { type AgentConfig, isReadOnlyAgent } from "./agents.ts";
import { formatStructuredData, type JsonSchema, structuredCompletionPrompt } from "./structured.ts";

export const INLINE_OUTPUT_CHARS = 11_500;
export const PREVIEW_CHARS = 5000;

export const MAX_TASKS_PER_CALL = 16;

export const TASK_ITEM_KEYS = ["name", "agent", "task", "model", "thinking", "cwd", "isolated", "outputSchema"] as const;

export const ISOLATED_DESCRIPTION =
	"Run in its own git worktree; changes are merged back into your checkout as a patch when it finishes — use for parallel edits that may collide or risky experiments";
export const OUTPUT_SCHEMA_DESCRIPTION =
	"JSON Schema; the agent must submit its result via `yield`; you receive validated JSON. Overrides the agent's default schema; false disables it";

export function buildTaskParams(defaultAgent: string) {
	const TaskItem = Type.Object({
		name: Type.Optional(
			Type.String({ description: "CamelCase agent id, ≤32 chars; auto-generated (AdjNoun) if omitted. Address the agent by it." }),
		),
		agent: Type.Optional(Type.String({ description: `Agent type; omit for the default "${defaultAgent}"` })),
		task: Type.String({
			description: "Self-contained assignment (# Target / # Change / # Acceptance). The agent starts with a blank context.",
		}),
		model: Type.Optional(
			Type.String({
				description:
					"Exact provider/model-id[:level] for this agent only (:level = thinking level; no partial ids); omit unless needed. An unavailable model fails this item and is never substituted",
			}),
		),
		thinking: Type.Optional(Type.String({ description: "Thinking level override: off|minimal|low|medium|high|xhigh" })),
		cwd: Type.Optional(Type.String({ description: "Working directory (default: current; relative paths resolve against it)" })),
		isolated: Type.Optional(Type.Boolean({ description: ISOLATED_DESCRIPTION })),
		// Some model grammars reject boolean subschemas.
		outputSchema: Type.Optional(
			Type.Union([Type.Object({}, { additionalProperties: true }), Type.String(), Type.Boolean(), Type.Null()], {
				description: OUTPUT_SCHEMA_DESCRIPTION,
			}),
		),
	});
	return Type.Object({
		context: Type.Optional(
			Type.String({ description: "Shared background for every task (# Goal, # Contract interfaces). NEVER repeat it per task." }),
		),
		tasks: Type.Array(TaskItem, { description: "Agents to spawn concurrently", minItems: 1, maxItems: MAX_TASKS_PER_CALL }),
	});
}

function hasDoubleEncodeSignature(value: string): boolean {
	const escapes = value.replace(/\\\\/g, "");
	// Treat `\b` and `\f` as literal text to preserve paths and regexes.
	if (/\\[bf]/.test(escapes)) return false;
	if (/\\(?:"|u[0-9a-fA-F]{4})/.test(escapes)) return true;
	return (escapes.match(/\\n/g)?.length ?? 0) >= 2;
}

export function repairDoubleEncodedJsonString(value: string): string {
	if (!value.includes("\\")) return value;
	if (!hasDoubleEncodeSignature(value)) return value;
	let decoded: unknown;
	try {
		decoded = JSON.parse(`"${value}"`);
	} catch {
		return value;
	}
	return typeof decoded === "string" && decoded !== value ? decoded : value;
}

const PLACEHOLDER_KEYS = ["name", "agent", "model", "thinking", "cwd"] as const;
const INHERITED_STRING_KEYS = ["agent", "model", "thinking", "cwd"] as const;

function isPlaceholder(value: unknown): boolean {
	return value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

function repairTaskItem(item: unknown, inherited: Record<string, unknown>): unknown {
	if (!item || typeof item !== "object" || Array.isArray(item)) return item;
	const src = item as Record<string, unknown>;
	let out: Record<string, unknown> | undefined;
	const edit = () => (out ??= { ...src });
	for (const k of PLACEHOLDER_KEYS) if (isPlaceholder(src[k])) delete edit()[k];
	for (const k of Object.keys(inherited)) if ((out ?? src)[k] === undefined) edit()[k] = inherited[k];
	if (typeof src.task === "string") {
		const task = repairDoubleEncodedJsonString(src.task);
		if (task !== src.task) edit().task = task;
	}
	return out ?? src;
}

export function prepareTaskArguments(raw: unknown): any {
	if (!raw || typeof raw !== "object") return raw;
	const a = raw as Record<string, unknown>;
	let tasks: unknown = a.tasks;
	if (typeof tasks === "string") {
		try {
			tasks = JSON.parse(tasks);
		} catch {}
	}
	if (tasks && typeof tasks === "object" && !Array.isArray(tasks)) tasks = [tasks];
	const inherited: Record<string, unknown> = {};
	if (!Array.isArray(tasks) || tasks.length === 0) {
		if (typeof a.task !== "string") return raw;
		const item: Record<string, unknown> = {};
		for (const k of TASK_ITEM_KEYS) if (a[k] !== undefined) item[k] = a[k];
		tasks = [item];
	} else {
		for (const k of INHERITED_STRING_KEYS) {
			const v = a[k];
			if (typeof v === "string" && v.trim()) inherited[k] = k === "agent" ? v.trim() : v;
		}
		if (a.isolated !== undefined && a.isolated !== null) inherited.isolated = a.isolated;
		// An explicit `null` or `false` disables the default schema.
		if (a.outputSchema !== undefined) inherited.outputSchema = a.outputSchema;
	}
	const out: Record<string, unknown> = { tasks: (tasks as unknown[]).map((t) => repairTaskItem(t, inherited)) };
	if (typeof a.context === "string") out.context = repairDoubleEncodedJsonString(a.context);
	return out;
}

export const TASK_PROMPT_SNIPPET = "Spawn background subagents (tasks[]); results auto-deliver; steer/follow up via irc";

export const TASK_PROMPT_GUIDELINES = [
	"Use task for self-contained work that benefits from a fresh context (recon, review, parallel independent edits). Write each task so it stands alone: the subagent has not seen this conversation.",
	"task results auto-deliver as <task-result> messages; NEVER poll with irc list/read. Keep working or end your turn; call irc op wait only when completely blocked on a result.",
	"If you learn something that changes a running agent's assignment, tell it immediately with irc op send rather than waiting for it to finish.",
	"Shared edits need one integration owner; never give two concurrent task agents edits to the same files.",
	"Use isolated: true for parallel edits that may collide or risky experiments: each agent works in its own git worktree and its changes merge back into your checkout as a patch (see each result's <merge-summary>). Use outputSchema when you need machine-readable results (validated JSON in <data>).",
];

export function buildTaskDescription(
	agents: AgentConfig[],
	defaultAgent: string,
	maxTasks: number,
	opts: { forChild?: boolean; canNest?: boolean; structured?: boolean } = {},
): string {
	const scoutAvailable = agents.some((a) => a.name === "scout");
	const nestNote = (a: AgentConfig) =>
		!opts.canNest || !a.spawns?.length
			? ""
			: a.spawns === "*"
				? " (can spawn its own subagents)"
				: ` (can spawn: ${a.spawns.join(", ")})`;
	const agentList = agents
		.map(
			(a) =>
				`- \`${a.name}\`${isReadOnlyAgent(a) ? " (read-only, no edits)" : ""}${a.outputSchema ? " (STRUCTURED; schema result)" : ""}${a.isolated ? " (ISOLATED; own worktree by default)" : ""}${nestNote(a)}: ${a.description}`,
		)
		.join("\n");
	return `Spawn \`tasks[]\` (max ${maxTasks} per call) concurrently as background subagents; names return immediately.

Results auto-deliver; NEVER poll. Completely blocked? Call \`irc\` op \`wait\` until it returns a settled result or message${opts.forChild ? "" : " (it also returns when the user messages you; your agents keep running)"}.
Steer a running agent via \`irc\` op \`send\` (\`to\`: agent name): it reads the message at its next step; an idle (finished) agent is woken and its reply is delivered back to you.
\`completed\`: the subagent finished its run; claimed artifacts unverified.${
		opts.forChild
			? `\nYour own run does not settle while your subagents are active: if you end your turn early, you are resumed with each \`<task-result>\` as it arrives. ${
					opts.structured
						? "Call `yield` with your result after the last one settles (it is rejected while any is running)."
						: "Your final message after the last one settles is your result."
				}`
			: opts.canNest && agents.some((a) => a.spawns?.length)
				? "\nAgents that can spawn report only after their own subagents settle; nested subagents report to the agent that spawned them, not to you (they appear nested under it)."
				: ""
	}

# Inputs
- \`agent\`: most specific, inside each \`tasks[]\` item, NEVER at the top level.
  - Omit only for the default (\`${defaultAgent}\`); NEVER name it.${scoutAvailable ? "\n  - Read-only research MUST use `scout` only when files unknown." : ""}
  - Prefer one agent to investigate + edit.
- \`context\`: shared (\`# Goal\`, \`# Contract\` interfaces); NEVER repeat per task.
- \`task\`: self-contained (\`# Target\` files/non-goals, \`# Change\` steps/APIs, \`# Acceptance\` observable result).
  - Children start blank; parent IRC steers immediately; large payloads go in files referenced by path, NEVER inline.
- \`name\`: CamelCase ≤32, auto-generated if omitted; address agent by name.
- \`model\` / \`thinking\` / \`cwd\`: optional per-task overrides; default to the agent definition, else your own.
  - \`model\`: one exact \`provider/model-id[:level]\` string (\`:level\` = thinking level), no partial ids; omit unless needed.
  - Requested model unavailable → that item fails and is never run on another model: report it; NEVER substitute another.${
		opts.forChild
			? ""
			: "\n  - `^<model>` tags in a user message stand for default-agent subagents on that model: give each tag's work its own item with that `model` (a hidden notice lists the exact values)."
	}
- \`isolated\`: run in its own git worktree (snapshot of your checkout incl. uncommitted changes); changes are merged back into your checkout as a patch when it finishes.
  - Use for parallel edits that may collide or risky experiments.
  - Result has \`<merge-summary>\`; conflicts leave your checkout untouched and name the saved patch (resolve manually: \`git apply --reject <patch>\`, working tree only).
- \`outputSchema\`: JSON Schema; the agent must submit its result via \`yield\`; you receive validated JSON in \`<data>\`.
  - Overrides a STRUCTURED agent's schema; \`false\` disables it.

Shared edits need one integration owner; give each task its files.
Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.

# Available Agents
${agentList}`;
}

export interface PeerInfo {
	id: string;
	agent: string;
	status: string;
	activity?: string;
	own?: boolean;
}

export function formatPeer(p: PeerInfo): string {
	return `- \`${p.id}\` — ${p.agent} (${p.status})${p.activity ? `: ${p.activity}` : ""}${p.own ? " [your subagent]" : ""}`;
}

export interface ChildPromptOptions {
	id: string;
	role: string;
	context?: string;
	peers: PeerInfo[];
	owner?: string;
	spawns?: string[];
	worktree?: { path: string; cwd: string; repoRoot: string };
	schema?: JsonSchema;
}

function workingTreeSection(wt: NonNullable<ChildPromptOptions["worktree"]>, boss: string): string {
	const where = wt.cwd !== wt.path ? ` (your cwd: \`${wt.cwd}\`)` : "";
	return `# Working Tree
You are working in an isolated git worktree at \`${wt.path}\`${where}: a snapshot of ${boss}'s checkout \`${wt.repoRoot}\`, including its uncommitted changes.
- Work ONLY inside this tree; NEVER modify files outside it or in the original checkout.
- Your changes are merged back into the original checkout automatically, as a patch, when your run ends (a failed run's changes are saved as a patch instead); leave them in place, uncommitted.
- NEVER commit, push, stash, reset, rebase, or switch branches; NEVER run \`git worktree\` commands.
- The original checkout may be edited concurrently: keep your edits to what the task needs, or they may conflict at merge time.`;
}

export function childSystemPrompt(opts: ChildPromptOptions): string {
	const peers = opts.peers.length ? opts.peers.map(formatPeer).join("\n") : "- (no other agents)";
	const nested = !!opts.owner;
	const boss = nested ? `\`${opts.owner}\` (\`parent\`)` : "the main agent";
	const addressing = nested
		? `your parent \`${opts.owner}\`, which spawned you, is \`parent\`; the main agent is \`main\``
		: "the main agent is `parent`";
	const sections = [`⁂ Role\n${opts.role.trim() || "Worker agent: delegated tasks."}`];
	if (opts.context?.trim()) sections.push(`⁂ Context\n${opts.context.trim()}`);
	const workingTree = opts.worktree ? `\n\n${workingTreeSection(opts.worktree, nested ? `\`${opts.owner}\`` : "the main agent")}` : "";
	let coop = `⁂ Coop
You are operating on a piece of work assigned to you by ${boss}.${workingTree}

# Peers
Message peers with the \`irc\` tool: op \`send\` with \`to: "<id>"\` and \`message\` (${addressing}). Your id is \`${opts.id}\`. Peers at spawn time:
${peers}

Your assignment sets your files and scope; stay inside it. Address peers by exact roster id; NEVER invent names.
- Messages: only a question that blocks you or a blocker/decision report, sent directly to the one agent that can answer. Short; never long-form content.
- NEVER send FYI, progress, or "editing <file>" announcements.
- Change needed outside your assignment? Ask its owner or \`parent\` first.
- Asked a question? Keep working on whatever it does not block; NEVER \`irc\` op \`wait\` on a peer's or ${nested ? "`parent`'s / `main`'s" : "`parent`'s"} progress.
- Discovery: the roster above is from spawn time and can be out of date; \`irc\` op \`list\` shows the current one (running + idle peers).
- Incoming: messages arrive as \`<irc from="…">\` blocks. Messages from \`parent\`${nested ? ", `main`," : ""} or \`user\` are steering: follow them; they override earlier instructions where they conflict.
- Follow-up: answer the question first, without quoting it. \`irc\` op \`send\` never blocks; op \`wait\` blocks until a message arrives — only for ${opts.spawns?.length ? "your own subagents' results or " : ""}the answer to a question that blocks you.
- Your final result reaches ${nested ? "`parent`" : "the main agent"} automatically. Message \`parent\` only for questions, blockers, or decisions — never progress or completion reports.`;
	if (opts.spawns?.length) {
		coop += `

# Subagents
You may delegate with the \`task\` tool (agents: ${opts.spawns.map((a) => `\`${a}\``).join(", ")}). Their results are delivered to you as \`<task-result>\` blocks: into a pending \`irc\` op \`wait\`, else at your next step. They are your responsibility: you cannot settle while any is still running — ending your turn just waits for the next result and resumes you with it. Manage them with \`irc\` (send / read / kill); NEVER poll with list/read.${opts.schema ? " Call `yield` only after every subagent has settled (it is rejected while any is still running)." : ""}`;
	}
	sections.push(coop);
	if (opts.schema) {
		sections.push(structuredCompletionPrompt(opts.schema));
		return sections.join("\n\n");
	}
	sections.push(`⁂ Completion
No TODO tracking, no progress updates. Execute; your final message is your result.
NEVER run builds, tests, linters, formatters or smoke runs unless your assignment says to; ${nested ? "`parent`" : "the main agent"} verifies once all subagents land. When done, name the checks to run.

While work remains, you MUST continue with another tool call — investigate, edit. A reply without a tool call ends the run; its text reaches ${nested ? "`parent`" : "the main agent"} verbatim as your complete result.${opts.spawns?.length ? " (Exception: while your subagents are still running, ending your turn only waits for their results; your final message after the last one settles is your result.)" : ""} NEVER end on a plan, a promise of further work, or a question.

No \`yield\` tool exists: ROLE mentions of \`yield\`, sections, or output fields describe what your final message covers.

Giving up is a last resort. If truly blocked, your final message MUST describe what you tried and the exact blocker.
You NEVER give up due to uncertainty, missing information obtainable via tools or repo context, or needing a design decision you can derive yourself.

You MUST keep going until this ticket is closed. This matters.`);
	return sections.join("\n\n");
}

export function childUserPrompt(assignment: string): string {
	return `Complete assignment thoroughly:\n\n${assignment}`;
}

export type DoneStatus = "completed" | "failed" | "aborted";

export interface MergeInfo {
	status: "applied" | "empty" | "conflict" | "error" | "unapplied";
	message: string;
	/**
	 * Paths are relative to the merge target.
	 */
	files: string[];
	patchFile?: string;
	worktree?: string;
}

export interface DoneInfo {
	id: string;
	agent: string;
	status: DoneStatus;
	output: string;
	error?: string;
	data?: unknown;
	structured?: boolean;
	isolated?: boolean;
	merge?: MergeInfo;
	durationMs: number;
	model: string;
	thinking?: string;
	task: string;
	toolCount: number;
	requests: number;
	cost: number;
	contextTokens: number;
	contextWindow?: number;
	subagents?: SubagentSummary[];
}

export interface SubagentSummary {
	id: string;
	agent: string;
	status: "pending" | "running" | "idle" | "failed" | "aborted";
	model?: string;
	thinking?: string;
	task: string;
	toolCount: number;
	requests: number;
	cost: number;
	contextTokens: number;
	contextWindow?: number;
	durationMs?: number;
	structured?: boolean;
	isolated?: boolean;
	merge?: MergeInfo;
	subagents?: SubagentSummary[];
}

export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.floor(ms / 1000);
	if (s < 3600) return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)
		.toString()
		.padStart(2, "0")}m`;
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function escapeEnvelope(text: string): string {
	return text.replace(/<(\/?)(task-result|output|preview|error|irc|data|merge-summary)\b/g, "&lt;$1$2");
}

function previewHead(output: string): string {
	const slice = output.slice(0, PREVIEW_CHARS);
	const nl = slice.lastIndexOf("\n");
	return nl >= PREVIEW_CHARS / 2 ? slice.slice(0, nl) : slice;
}

export function resultOutputFallback(d: Pick<DoneInfo, "output" | "error" | "requests">): string {
	const base = d.output.trim();
	if (base) return base;
	if (d.error) return `Error: ${d.error}`;
	return d.requests > 0 ? `(no output) after ${d.requests} req` : "(no output)";
}

export function followUpHint(id: string, status: DoneStatus): string {
	return status === "aborted"
		? `${id} was aborted.`
		: `${id} is now idle — message it with irc op "send" (to: "${id}") to follow up or ask for revisions; full output via irc op "read" (id: "${id}").`;
}

export function formatTaskResult(d: DoneInfo): string {
	const hasData = d.data !== undefined;
	const output = resultOutputFallback(d);
	const truncated = !hasData && output.length > INLINE_OUTPUT_CHARS;
	const error = d.status === "failed" && d.error && d.output.trim() ? d.error : undefined;
	const lines = [
		`<task-result id="${d.id}" agent="${d.agent}" status="${d.status}" duration="${fmtDuration(d.durationMs)}">`,
	];
	if (truncated) {
		lines.push(`<meta lines="${output.split("\n").length}" size="${fmtBytes(Buffer.byteLength(output, "utf8"))}" />`);
	}
	if (error) lines.push(`<error>${escapeEnvelope(error)}</error>`);
	if (hasData) {
		lines.push("<data>", escapeEnvelope(formatStructuredData(d.data)), "</data>");
	} else if (truncated) {
		lines.push(`<preview full-output="irc read ${d.id}">`, escapeEnvelope(previewHead(output)), "</preview>");
	} else {
		lines.push("<output>", escapeEnvelope(output), "</output>");
	}
	if (d.merge) lines.push("<merge-summary>", escapeEnvelope(d.merge.message), "</merge-summary>");
	lines.push("</task-result>");
	if (truncated) {
		lines.push(`Preview truncated at ${PREVIEW_CHARS} chars; call irc with op "read", id "${d.id}" for the full output.`);
	}
	lines.push(followUpHint(d.id, d.status));
	return lines.join("\n");
}

export interface SpawnedInfo {
	id: string;
	agent: string;
	queued: boolean;
	warning?: string;
	tags?: string[];
}

function spawnLabel(s: SpawnedInfo): string {
	return [s.agent, ...(s.tags ?? [])].join(", ");
}

export function formatSpawnFeedback(spawned: SpawnedInfo[], failures: string[], opts: { lifecycle?: boolean } = {}): string {
	const lines: string[] = [];
	const failureSummary = failures.length ? ` Failed to schedule ${failures.length}:` : "";
	if (spawned.length === 0) {
		lines.push(`No agents spawned.${failureSummary}`);
	} else if (spawned.length === 1 && failures.length === 0) {
		const s = spawned[0]!;
		lines.push(`Spawned agent \`${s.id}\` (${spawnLabel(s)})${s.queued ? " — queued until a slot frees up" : ""}.${s.warning ? ` Note: ${s.warning}.` : ""}`);
	} else {
		const agentLabel = [...new Set(spawned.map((s) => s.agent))].join(", ");
		lines.push(`Spawned ${spawned.length} background agent${spawned.length === 1 ? "" : "s"} using ${agentLabel}.${failureSummary}`);
		for (const s of spawned) {
			lines.push(`- \`${s.id}\` (${spawnLabel(s)})${s.queued ? " queued" : ""}${s.warning ? ` — ${s.warning}` : ""}`);
		}
	}
	for (const f of failures) lines.push(`- ✗ ${f}`);
	if (spawned.length > 0) {
		lines.push("Results will be delivered automatically as each agent finishes.");
		if (opts.lifecycle) {
			lines.push(
				'irc op "list" shows agents and status; op "read" returns an agent\'s full latest output and recent activity without consuming delivery; op "kill" aborts one (and its subagents).',
				'Agents stay alive (idle) after finishing until killed or the session ends; irc op "send" messages a live agent (an idle one is woken and replies).',
			);
		}
	}
	return lines.join("\n");
}

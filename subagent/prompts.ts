/**
 * Model-facing text, ported from oh-my-pi's prompts:
 *  - tools/task.md + tools/task-async-contract.md   -> buildTaskDescription (one `# Inputs` bullet list)
 *  - system/subagent-system-prompt.md               -> childSystemPrompt (anti-chatter peer rules;
 *    system/system-prompt.md "Hand-off"                 no builds/tests unless assigned; `⁂` section marker)
 *  - system/subagent-user-prompt.md                 -> childUserPrompt
 *  - tools/task-summary.md (+ result-summary.ts)    -> formatTaskResult (whole up to INLINE_OUTPUT_CHARS,
 *                                                      else a PREVIEW_CHARS head)
 *  - tools/task-follow-up.md                        -> followUpHint
 *  - tools/task-spawn-feedback.md                   -> formatSpawnFeedback (+ the `irc` lifecycle reference,
 *                                                      once per spawner, on the first spawn result)
 * Adapted to this extension: steering/messaging is the `irc` tool (no agent://, proc://, local://).
 * Structured output (`outputSchema` → `yield`, structured.ts) and worktree isolation (`isolated`,
 * isolation.ts) are wired up by features.ts. Nested spawning is depth-limited (hub MAX_DEPTH)
 * and gated by the agent's `spawns` frontmatter.
 *
 * Also home of the `task` tool's schema + argument repair (call shape, blank placeholders, top-level
 * per-item options, double-encoded prose: packages/tui tools/task-repair-args.ts), shared by the main
 * agent's tool (index.ts) and spawning children's tool (hub.ts) so the two never diverge.
 */

import { Type } from "typebox";
import { type AgentConfig, isReadOnlyAgent } from "./agents.ts";
import { formatStructuredData, type JsonSchema, structuredCompletionPrompt } from "./structured.ts";

/**
 * Largest output inlined whole: a cut output costs the parent an `irc` op "read" turn on top of the
 * preview it already holds (OMP: INLINE_OUTPUT_CHARS).
 */
export const INLINE_OUTPUT_CHARS = 11_500;
/** Head shown for an output over INLINE_OUTPUT_CHARS; the envelope then points at `irc` op "read" (OMP: PREVIEW_CHARS). */
export const PREVIEW_CHARS = 5000;

export const MAX_TASKS_PER_CALL = 16;

// ---------------------------------------------------------------------------------------------
// `task` tool schema (shared by the main agent and spawning children)

/** Per-item fields; `prepareTaskArguments` copies these from a flat single-agent call. */
export const TASK_ITEM_KEYS = ["name", "agent", "task", "model", "thinking", "cwd", "isolated", "outputSchema"] as const;

export const ISOLATED_DESCRIPTION =
	"Run in its own git worktree; changes are merged back into your checkout as a patch when it finishes — use for parallel edits that may collide or risky experiments";
export const OUTPUT_SCHEMA_DESCRIPTION =
	"JSON Schema; the agent must submit its result via `yield`; you receive validated JSON. Overrides the agent's default schema; false disables it";

/** Parameters schema; `defaultAgent` only changes the `agent` field's description. */
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
		// Explicit union (not `unknown`): some grammars reject boolean subschemas (OMP types.ts).
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

/**
 * Whether `value` carries the signature of whole-string double-encoding rather than prose that
 * merely mentions escapes. Deliberately narrower than upstream's heuristic (any structural escape, or
 * two-plus escapes), which also decoded legitimate one-line assignments whose backslashes happen to
 * be valid JSON escapes (`\bfoo\b`, `C:\temp\new\bin`, `\nabla \times`, "on \t and \n", `C:\\Users`):
 *  - `\\` pairs are ignored: an escaped backslash alone is a path or a regex, not a signature;
 *  - `\b` / `\f` never occur in re-escaped prose, so their presence vetoes the repair;
 *  - otherwise an escaped quote, a `\uXXXX`, or two-plus `\n` (a multi-line document on one line).
 */
function hasDoubleEncodeSignature(value: string): boolean {
	const escapes = value.replace(/\\\\/g, "");
	// `\b` / `\f` never occur in re-escaped prose: a regex or a path (`\bfoo\b`, `C:\temp\bin`).
	if (/\\[bf]/.test(escapes)) return false;
	if (/\\(?:"|u[0-9a-fA-F]{4})/.test(escapes)) return true;
	return (escapes.match(/\\n/g)?.length ?? 0) >= 2;
}

/**
 * Models occasionally JSON-escape a prose argument twice, so it arrives with every newline, quote and
 * `\uXXXX` still backslash-escaped. Return the once-unescaped string when `value` is uniformly
 * double-encoded JSON, otherwise `value` unchanged (idempotent). Two guards: the signature check above
 * (text whose backslashes are valid JSON escapes by coincidence is left alone), then the `JSON.parse`
 * round-trip, which throws on an invalid escape (`\d+`, `C:\Users`), a bare quote or a real newline.
 * Only for natural-language fields (`task`, `context`), NEVER identifiers (OMP packages/tui
 * tools/task-repair-args.ts, with a stricter signature).
 */
export function repairDoubleEncodedJsonString(value: string): string {
	// Fast path: no backslash → nothing was escaped → the parse can never differ.
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

/** Optional string fields whose blank value means "absent" (callers that emit JSON pad them with `""`, `null` or `[]`). */
const PLACEHOLDER_KEYS = ["name", "agent", "model", "thinking", "cwd"] as const;
/** Top-level string options copied into items that lack them. */
const INHERITED_STRING_KEYS = ["agent", "model", "thinking", "cwd"] as const;

function isPlaceholder(value: unknown): boolean {
	return value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

/** One `tasks[]` item without placeholders, with inherited top-level options and repaired prose; copy-on-write. */
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

/**
 * Repair common malformed calls before validation, never mutating the submitted args:
 *  - a flat single-agent call (`{task, agent, ...}` at the top level), a lone object or JSON string in `tasks`;
 *  - top-level `agent` / `model` / `thinking` / `cwd` / `isolated` / `outputSchema` next to `tasks[]`:
 *    copied into every item that lacks its own value;
 *  - blank placeholders (`null`, `""`, whitespace, `[]`) in an item's `name` / `agent` / `model` /
 *    `thinking` / `cwd`: removed, so the agent's defaults apply (`outputSchema` / `isolated` are left alone);
 *  - double-encoded prose in `context` and each item's `task` (see repairDoubleEncodedJsonString).
 */
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
		// `null` / `false` are values here ("no schema"), so only absence is skipped.
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

/**
 * `forChild`: the description for a spawning subagent's own `task` tool (its run cannot settle while
 * its subagents are active, so it is told how results come back; `structured`: it reports via `yield`).
 * `canNest`: agents spawned through this tool are still below the depth limit, so agents with
 * `spawns` are marked as able to delegate further.
 */
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
	/** Subagent spawned by the viewer. */
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
	/** Id of the agent that spawned this one when it is not the main agent (nested subagent). */
	owner?: string;
	/** Agents this child may spawn with its own `task` tool (absent = no task tool). */
	spawns?: string[];
	/** Isolated checkout the child works in (`isolated` tasks). */
	worktree?: { path: string; cwd: string; repoRoot: string };
	/** Output schema: the child must finish with `yield` (replaces the plain-text ⁂ Completion). */
	schema?: JsonSchema;
}

/** ⁂ Coop "# Working Tree" for isolated children (OMP subagent-system-prompt.md, adapted to patch merge-back). */
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
	// Nested children: `parent` = the agent that spawned them (their owner), `main` = the main agent.
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

/**
 * What happened to an isolated child's worktree changes when a run settled (or it was killed).
 *  applied:   merged into the parent checkout's working tree (not staged/committed)
 *  empty:     no file changes
 *  conflict:  could not be applied; parent untouched; patch saved, worktree kept while the agent lives
 *  error:     merge machinery failed (patch saved when possible)
 *  unapplied: the run failed / was aborted: changes NOT applied, patch saved
 */
export interface MergeInfo {
	status: "applied" | "empty" | "conflict" | "error" | "unapplied";
	/** Model-facing summary (the `<merge-summary>` body). */
	message: string;
	/** Changed paths relative to the merge target's root. */
	files: string[];
	patchFile?: string;
	/** Worktree still holding the changes (conflict / unapplied while the agent lives). */
	worktree?: string;
}

/** Snapshot of a settled run; also the persisted `details` of delivered `task-result` messages. */
export interface DoneInfo {
	id: string;
	agent: string;
	status: DoneStatus;
	/** Final text; for structured runs that yielded, the pretty-printed `data`. */
	output: string;
	error?: string;
	/** Validated `yield` payload (structured runs only; may legitimately be null). */
	data?: unknown;
	/** The task had an output schema. */
	structured?: boolean;
	/** The task ran in its own worktree. */
	isolated?: boolean;
	/** Worktree merge-back outcome for this run (isolated tasks). */
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
	/** Snapshot of the agent's own subagents (nested tree) when it settled; display only. */
	subagents?: SubagentSummary[];
}

/** Display-only row of a nested subagent, persisted inside DoneInfo for result cards. */
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

/** Keep child text from closing the envelope early (also applied to `<irc>` message bodies by the hub). */
export function escapeEnvelope(text: string): string {
	return text.replace(/<(\/?)(task-result|output|preview|error|irc|data|merge-summary)\b/g, "&lt;$1$2");
}

/** Head of `output` within the preview budget, preferring a line boundary (OMP previewHead). */
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

/** The `<task-result>` envelope the parent model reads (task-summary.md). */
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
		// Validated structured result (structured.ts caps it; `irc read` has the full value).
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
	/** e.g. "isolated", "structured" */
	tags?: string[];
}

function spawnLabel(s: SpawnedInfo): string {
	return [s.agent, ...(s.tags ?? [])].join(", ");
}

/**
 * Tool result text for a spawn (task-spawn-feedback.md). `lifecycle`: append the `irc` reference lines
 * (list/read/kill, idle agents) that the tool description no longer carries; the hub sets it on a
 * spawner's first successful spawn only.
 */
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

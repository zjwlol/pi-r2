/**
 * AgentHub - registry of in-process subagent sessions + IRC-style message routing.
 *
 * Modeled on oh-my-pi's IrcBus/IrcBridge:
 *  - `send` never blocks on the recipient producing anything.
 *  - Recipient blocked in `irc wait`  -> message resolves the wait directly.
 *  - Recipient mid-run                -> injected as a steering message at its next step boundary.
 *  - Recipient idle (finished)        -> woken with a new turn; its final text is relayed back to the sender
 *                                        (unless it already replied via irc during that turn).
 *  - Messages to `parent` land in the main session (steer if busy, new turn if idle).
 *
 * Nesting: a child whose agent has `spawns` (and depth < MAX_DEPTH) gets its own `task` tool. Its
 * subagents ("grandchildren") live in the same map (ids are unique hub-wide) with `ownerId` = the
 * spawning child. A nested agent's settled result is routed to its owner as an incoming message of
 * kind "result" (same delivery rules as above, minus the reply relay), and an owner does not settle
 * while any of its subagents is active: when its turn ends it blocks until the next result/message
 * arrives and continues with it.
 *
 * IRC addressing: for a nested child `parent` means its owner and `main` the main agent; for a
 * top-level child `parent` (or `main`) is the main agent. Internally the main agent's id is PARENT_ID.
 *
 * Concurrency: every run (initial task or wake-up) holds a permit, so spawns beyond the running cap
 * queue (status "pending") instead of failing. Permits come from one pool PER DEPTH LEVEL, and an
 * owner releases its permit while it is blocked waiting for its subagents (see `runLoop`).
 *
 * Per-task features (worktree isolation, structured output) plug in through `hub.hooks`
 * (ChildHooks: validate / prepare / tools / resume / beforeSettle / dispose); features.ts implements
 * them. The hub only carries their data (Child.isolated / schema / worktree, DoneInfo.data / merge).
 */

import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents, resolveSpawnPolicy, type SpawnPolicy } from "./agents.ts";
import type { Worktree } from "./isolation.ts";
import { generateTaskName, sanitizeAgentId } from "./names.ts";
import {
	buildTaskDescription,
	buildTaskParams,
	childSystemPrompt,
	childUserPrompt,
	type DoneInfo,
	type DoneStatus,
	formatPeer,
	formatSpawnFeedback,
	formatTaskResult,
	fmtDuration,
	MAX_TASKS_PER_CALL,
	type MergeInfo,
	type PeerInfo,
	prepareTaskArguments,
	type SpawnedInfo,
	type SubagentSummary,
	TASK_PROMPT_GUIDELINES,
	TASK_PROMPT_SNIPPET,
} from "./prompts.ts";
import { formatStructuredData, type JsonSchema } from "./structured.ts";
import { recordUsage, sessionUsage } from "./usage.ts";

export { fmtDuration };
export type { DoneInfo };

/** Internal id of the main agent (and what top-level children call it). */
export const PARENT_ID = "parent";
/** How nested children address the main agent (`parent` is their owner). Accepted from every child. */
export const MAIN_ALIAS = "main";
export const USER_ID = "user";
const RESERVED_IDS = new Set([PARENT_ID, MAIN_ALIAS, USER_ID, "all"]);

function envInt(name: string): number | undefined {
	const n = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Max concurrently running runs PER DEPTH LEVEL (top-level agents, their subagents, ...); further
 * spawns/wake-ups queue. `PI_SUBAGENT_MAX_RUNNING` overrides it (read once at load; mainly for tests).
 */
export const MAX_RUNNING = envInt("PI_SUBAGENT_MAX_RUNNING") ?? 16;
/**
 * Max nesting depth. The main agent is depth 0; agents it spawns are depth 1; an agent at depth
 * < MAX_DEPTH whose definition has `spawns` gets a `task` tool. 2 = top-level agents may spawn one
 * more level, whose agents never spawn.
 */
export const MAX_DEPTH = 2;
export const READ_CAP = 100 * 1024;

export const RESULT_MESSAGE_TYPE = "task-result";
export const IRC_MESSAGE_TYPE = "irc";

export type ChildStatus = "pending" | "running" | "idle" | "failed" | "aborted";

/**
 * "irc": a message sent with the irc tool. "result": a nested subagent's settled result for its owner.
 * "notice": hub-generated information (e.g. a follow-up run merged worktree changes into the
 * recipient's checkout); nothing is relayed back, and it never wakes or resumes a child on its own: an
 * idle or blocked child reads it with its next run / continuation.
 */
export type MessageKind = "irc" | "result" | "notice";

/** Incoming items whose recipient's reply is relayed back to the sender (irc messages only). */
function expectsReply(m: IrcMessage): boolean {
	return m.kind === undefined || m.kind === "irc";
}

export interface IrcMessage {
	/** Absent in messages persisted by older versions (= "irc"). */
	kind?: MessageKind;
	from: string;
	to: string;
	/** For "result": the formatted `<task-result>` envelope. */
	body: string;
	ts: number;
	/** For "result". */
	done?: DoneInfo;
}

export type ParentEvent = { kind: "message"; msg: IrcMessage } | { kind: "done"; done: DoneInfo };

/**
 * A child's own spend (its model responses, plus any compaction/summary calls of its session), as
 * mirrored into the main session's totals by `AgentHub.syncUsage`. Nested subagents keep their own.
 */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Assistant responses (model requests). */
	requests: number;
	/** Tool calls started. */
	toolCount: number;
	contextTokens: number;
}

/** Spend of `c`'s nested subagents (all depths below it), excluding `c` itself. */
export function nestedCost(c: Child): number {
	let sum = 0;
	for (const o of c.owned) sum += o.usage.cost + nestedCost(o);
	return sum;
}

/** Spend of `c` and its whole subtree. */
export function treeCost(c: Child): number {
	return c.usage.cost + nestedCost(c);
}

export interface ToolActivity {
	id: string;
	name: string;
	args: string;
	startedAt: number;
}

export interface Child {
	id: string;
	agent: AgentConfig;
	task: string;
	context?: string;
	cwd: string;
	/** PARENT_ID for agents spawned by the main agent, else the id of the spawning child. */
	ownerId: string;
	/** 1 = spawned by the main agent, 2 = spawned by a depth-1 child, ... */
	depth: number;
	/** Direct subagents, in spawn order. */
	owned: Child[];
	/** Agents this child may spawn (its `task` tool exists iff set); resolved when its session starts. */
	spawns?: string[];
	/** Raw `tasks[]` item this child was spawned from (for hooks reading per-item options). */
	item?: Record<string, unknown>;
	/** Runs in its own git worktree (resolved at spawn by `hooks.validate`). */
	isolated?: boolean;
	/** Output schema: the child must finish with `yield` (resolved at spawn by `hooks.validate`). */
	schema?: JsonSchema;
	/** The isolated checkout (set by `hooks.prepare`; cleared when removed). */
	worktree?: Worktree;
	/** Hub/hook work in progress outside a model step (e.g. "merging changes"); shown as activity. */
	phase?: string;
	/** In-flight kill (so concurrent kills share one teardown). */
	killing?: Promise<string[]>;
	/**
	 * Being torn down (kill) or failing to start: still counts as active (`isActive`) until its initial
	 * result is delivered, so a waiting owner cannot settle in the gap and then drop the late result.
	 */
	finalizing?: boolean;
	/** The main agent's tool context the tree was spawned from; reused for nested spawns (models, auth). */
	ctx: ExtensionContext;
	/** Project-local agents/trust decision of the main agent, inherited by nested spawns. */
	projectTrusted: boolean;
	model: Model<any> | undefined;
	modelLabel: string;
	contextWindow?: number;
	thinking: ThinkingLevel;
	session?: AgentSession;
	status: ChildStatus;
	createdAt: number;
	/** First time a run actually started (after queueing). */
	startedAt?: number;
	/** Start of the current/last run. */
	runStartedAt?: number;
	finishedAt?: number;
	usage: Usage;
	/** Child session entries before this index have been mirrored into the main session (`syncUsage`). */
	usageCursor: number;
	/** A `syncUsage` is already scheduled for the current tick. */
	usageSyncPending?: boolean;
	/** Tools currently executing (parallel calls), keyed by tool call id. */
	runningTools: Map<string, ToolActivity>;
	lastTool?: ToolActivity;
	lastText?: string;
	activity: string[];
	error?: string;
	initialSettled: boolean;
	/** Result of the latest settled run. */
	done?: DoneInfo;
	/** Messages that arrived while the agent had no live step to inject into. */
	inbox: IrcMessage[];
	/** Who woke the current run (gets the run's final text relayed back). */
	wakeSender?: string;
	/** Recipients this child messaged during the current run. */
	sentDuringRun: Set<string>;
	/** Messages injected with session.steer() during the current prompt (pruned after each prompt). */
	steered: Array<{ msg: IrcMessage; text: string }>;
	/** session.steer() calls not yet enqueued (steer awaits input handlers before queueing). */
	steersInFlight: Set<Promise<void>>;
	/** Waiting for a run permit (MAX_RUNNING runs already active at its depth). */
	queued: boolean;
	/** Holds a run permit right now. */
	hasPermit: boolean;
	/** Turn ended but subagents are still active: paused (permit released) until a result/message arrives. */
	blocked: boolean;
	/** Re-checks the blocked wait's wake condition (set while blocked). */
	unblock?: () => void;
	/** Aborts a queued permit wait on kill. */
	abort: AbortController;
	unsubscribe: () => void;
}

export interface SpawnSpec {
	name?: string;
	agent: AgentConfig;
	task: string;
	context?: string;
	cwd: string;
	model?: string;
	thinking?: string;
	/** Spawning child (nested spawn); absent = spawned by the main agent. */
	owner?: Child;
	/** Raw tasks[] item (kept on the child for hooks). */
	item?: Record<string, unknown>;
	/** Resolved by `hooks.validate` (copied to the child). */
	isolated?: boolean;
	schema?: JsonSchema;
}

/** What a `task` call did (shared by the main agent's and children's `task` tools). */
export interface TaskCallOutcome {
	children: Child[];
	failures: string[];
	text: string;
	isError: boolean;
}

/** A run about to settle (see ChildHooks.beforeSettle). */
export interface SettleInfo {
	/** The child's initial assignment (vs. a follow-up turn whose reply is relayed to its sender). */
	initial: boolean;
	status: DoneStatus;
	output: string;
}

/**
 * Integration seams for per-item features layered on the hub (e.g. worktree isolation, structured
 * output). All optional; with no hooks set the hub behaves exactly as without them.
 */
export interface ChildHooks {
	/**
	 * Per-item check at spawn, before anything of the call spawns (runs concurrently for all items).
	 * Return a message to reject the item (a per-item error in the task result, like an unknown
	 * agent). May resolve per-item options onto the spec (`isolated`, `schema`).
	 */
	validate?(spec: SpawnSpec): Promise<string | void> | string | void;
	/** Before the child's session is created (e.g. create a worktree and point `child.cwd` at it). Throwing fails the child. */
	prepare?(child: Child): Promise<void> | void;
	/** Extra custom tools for the child's session (e.g. a `yield` tool); also added to a `tools` allowlist. */
	tools?(child: Child): ToolDefinition[];
	/**
	 * Settle point: a run is about to deliver its result (no subagents active, nothing queued). May
	 * rewrite status/output (e.g. merge worktree changes, validate structured output), or return
	 * `{ retry }` to prompt the child again instead of settling (e.g. "you must call yield").
	 */
	beforeSettle?(child: Child, run: SettleInfo): Promise<SettleOverride | void> | SettleOverride | void;
	/** An owner continues its current purpose with subagent results (e.g. a `yield` made before them is stale). */
	resume?(child: Child): void;
	/**
	 * After the child is killed or disposed (session gone; e.g. save unmerged changes, remove its
	 * worktree). May return info for the aborted result (`merge`) and a note for whoever killed it.
	 */
	dispose?(child: Child): Promise<DisposeInfo | void> | DisposeInfo | void;
}

export interface SettleOverride {
	status?: DoneStatus;
	output?: string;
	/** Replace the run's error ("" clears it). A failed status should come with one. */
	error?: string;
	/** Structured result (DoneInfo.data). */
	data?: unknown;
	/** Worktree merge outcome (DoneInfo.merge). */
	merge?: MergeInfo;
	/** Prompt the child with this instead of settling (same purpose continues). */
	retry?: string;
	/**
	 * Follow-up runs only: must reach `noticeTo` (e.g. "merged N files into your checkout"). Appended
	 * to the relayed reply when that goes to `noticeTo`; otherwise sent to it separately (the child
	 * already answered via irc, the run was not a reply, or someone else woke it, e.g. the user).
	 */
	notice?: string;
	/** Internal id the notice is for (PARENT_ID = main agent); default: the child's owner. */
	noticeTo?: string;
	/** Follow-up runs only: appended to a relayed reply, never sent on its own (e.g. "still conflicting"). */
	replyNote?: string;
}

export interface DisposeInfo {
	/** Attached to the aborted result (if one is delivered). */
	merge?: MergeInfo;
	/** Human-readable note for the killer (e.g. "unmerged changes saved to …"). */
	note?: string;
}

/** Extra DoneInfo fields produced at the settle point. */
type DoneExtra = Pick<DoneInfo, "data" | "merge">;

/** What a run's final text is for. */
type Purpose = { kind: "initial" } | { kind: "reply"; to: string } | { kind: "none" };

interface ChildWaiter {
	from?: string;
	resolve: (msg: IrcMessage | null) => void;
}

interface ParentWaiter {
	filter: (ev: ParentEvent) => boolean;
	resolve: (ev: ParentEvent | null) => void;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Counting semaphore with FIFO queueing and abortable waits. */
class Semaphore {
	private active = 0;
	private queue: Array<{ grant: () => void; fail: (e: Error) => void }> = [];

	constructor(private readonly max: number) {}

	get waiting(): number {
		return this.queue.length;
	}

	wouldQueue(): boolean {
		return this.active >= this.max;
	}

	acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new Error("aborted"));
		if (this.active < this.max) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const entry = {
				grant: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				},
				fail: (e: Error) => reject(e),
			};
			const onAbort = () => {
				const i = this.queue.indexOf(entry);
				if (i >= 0) this.queue.splice(i, 1);
				entry.fail(new Error("aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push(entry);
		});
	}

	release(): void {
		const next = this.queue.shift();
		if (next) next.grant();
		else this.active = Math.max(0, this.active - 1);
	}

	rejectAll(): void {
		for (const e of this.queue.splice(0)) e.fail(new Error("aborted"));
	}
}

export function truncateBytes(text: string, cap = READ_CAP): string {
	if (Buffer.byteLength(text, "utf8") <= cap) return text;
	let t = text.slice(0, cap);
	while (Buffer.byteLength(t, "utf8") > cap) t = t.slice(0, -1);
	return `${t}\n\n[Output truncated at ${Math.round(cap / 1024)}KB.]`;
}

const SECTION_HEADING = /^#+\s*(?:target|change|changes|acceptance|goal|contract|context|task|assignment)\s*:?\s*$/i;

/**
 * One-line brief of an assignment: the first meaningful line, skipping bare `# Target`-style
 * section headings (the recommended task format) and stripping markdown heading markers.
 */
export function firstLine(text: string, max = 120): string {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	const pick = lines.find((l) => !SECTION_HEADING.test(l)) ?? lines[0] ?? "";
	const line = pick.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function previewArgs(args: any): string {
	if (!args || typeof args !== "object") return "";
	const pick = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.to ?? args.op;
	const s = typeof pick === "string" ? pick : JSON.stringify(args);
	const flat = s.replace(/\s+/g, " ");
	return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/**
 * Framing of an incoming item for a child. `from` is already mapped to the recipient's view.
 *  steer:    injected mid-run (or folded into the next prompt)
 *  wake:     starts a new turn of an idle agent; its reply is relayed to the sender
 *  wait:     returned from `irc wait`
 *  continue: resumes an owner whose turn ended while its subagents were active (no relay)
 * Results never use the wake framing (nothing is relayed back to a subagent).
 */
function frameIncoming(msg: IrcMessage, from: string, mode: "steer" | "wake" | "wait" | "continue", structured = false): string {
	if (msg.kind === "result") {
		return mode === "steer" ? `[Subagent \`${from}\` settled while you were working.]\n${msg.body}` : msg.body;
	}
	if (msg.kind === "notice") return `[Notice from \`${from}\`.]\n${msg.body}`;
	const block = `<irc from="${from}">\n${msg.body}\n</irc>`;
	if (mode === "steer" || mode === "continue") {
		return `[Message received while you were working. Read it and adjust your plan accordingly before continuing.]\n${block}`;
	}
	if (mode === "wake") {
		const via = structured ? ` (if you call \`yield\` this turn, its data is delivered instead)` : "";
		return `${block}\n\nYour final reply this turn is delivered to \`${from}\` automatically${via}.`;
	}
	return block;
}

export function formatParentEvent(ev: ParentEvent): string {
	if (ev.kind === "message" && ev.msg.kind === "notice") return `[Notice from \`${ev.msg.from}\`.]\n${ev.msg.body}`;
	if (ev.kind === "message") {
		return `<irc from="${ev.msg.from}">\n${ev.msg.body}\n</irc>\nReply with the irc tool (op: "send", to: "${ev.msg.from}") if a response is needed.`;
	}
	return formatTaskResult(ev.done);
}

export function isActive(c: Child | undefined): boolean {
	return !!c && (c.status === "running" || c.status === "pending" || (!!c.finalizing && !c.initialSettled));
}

/** Active agents in `c`'s subtree (excluding `c`). */
export function activeDescendants(c: Child, out: Child[] = []): Child[] {
	for (const o of c.owned) {
		if (isActive(o)) out.push(o);
		activeDescendants(o, out);
	}
	return out;
}

/** `c` or anything below it is active. */
export function subtreeActive(c: Child | undefined): boolean {
	return !!c && (isActive(c) || activeDescendants(c).length > 0);
}

/** All agents below `c`. */
export function descendants(c: Child, out: Child[] = []): Child[] {
	for (const o of c.owned) {
		out.push(o);
		descendants(o, out);
	}
	return out;
}

/** One-line status of an agent (irc list, /agents). */
export function describeChild(c: Child): string {
	const end = c.status === "running" ? Date.now() : (c.finishedAt ?? Date.now());
	const elapsed = c.runStartedAt ? fmtDuration(end - c.runStartedAt) : "";
	const u = c.usage;
	const nested = nestedCost(c);
	const stats = [
		u.toolCount ? `${u.toolCount} tools` : "",
		u.requests ? `${u.requests} req` : "",
		u.cost || nested ? `$${u.cost.toFixed(2)}${nested ? ` (+${nested.toFixed(2)})` : ""}` : "",
		elapsed,
		c.modelLabel,
	].filter(Boolean);
	const waiting = c.blocked ? activeDescendants(c).length : 0;
	const state = c.status === "pending" ? "queued" : c.blocked ? `waiting for ${waiting} subagent${waiting === 1 ? "" : "s"}` : c.status;
	const tags = [c.isolated ? "[isolated]" : "", c.schema ? "{}" : ""].filter(Boolean).join(" ");
	return `${c.id} ⟨${c.agent.name}⟩${tags ? ` ${tags}` : ""} ${state} — ${stats.join(" · ")}`;
}

/** `describeChild` rows for `list` in tree order, nested agents indented under their owner. */
export function describeTree(list: Child[]): string[] {
	return list.map((c) => `${c.depth > 1 ? `${"  ".repeat(c.depth - 1)}↳ ` : ""}${describeChild(c)}`);
}

/** Latest result text of `c`: its structured data when the last settled run yielded, else its latest assistant text. */
export function latestOutput(c: Child, cap = READ_CAP): string {
	if (c.done?.data !== undefined && c.status !== "running") return formatStructuredData(c.done.data, cap);
	return c.session?.getLastAssistantText?.() ?? c.done?.output ?? "";
}

/** Full report for `irc read`: status, assignment, recent activity, latest output. */
export function readReport(c: Child): string {
	const out = latestOutput(c);
	const owner = c.ownerId !== PARENT_ID ? `\nOwner: ${c.ownerId}` : "";
	const subs = c.owned.length ? `\nSubagents: ${c.owned.map((o) => `${o.id} (${o.status})`).join(", ")}` : "";
	const wt = c.worktree ? `\nWorktree: ${c.worktree.path}` : "";
	const merge = c.done?.merge ? `\nLast merge: ${c.done.merge.message}` : "";
	return `${describeChild(c)}${owner}${subs}${wt}${merge}\nTask: ${c.task}\n\nRecent activity:\n${c.activity.slice(-15).join("\n") || "(none)"}\n\nLatest output:\n${truncateBytes(out) || "(none yet)"}`;
}

function summarize(c: Child): SubagentSummary {
	const start = c.runStartedAt ?? c.startedAt;
	return {
		id: c.id,
		agent: c.agent.name,
		status: c.status,
		model: c.modelLabel,
		thinking: c.thinking,
		task: firstLine(c.task),
		toolCount: c.usage.toolCount,
		requests: c.usage.requests,
		cost: c.usage.cost,
		contextTokens: c.usage.contextTokens,
		contextWindow: c.contextWindow,
		durationMs: c.done?.durationMs ?? (start ? (c.finishedAt ?? Date.now()) - start : undefined),
		structured: c.schema ? true : undefined,
		isolated: c.isolated || undefined,
		merge: c.done?.merge,
		subagents: c.owned.length ? c.owned.map(summarize) : undefined,
	};
}

export class AgentHub {
	/** Distinguishes live children from same-named ones in persisted details of older sessions. */
	readonly instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	/** Every agent of every depth (ids are unique hub-wide), in spawn order. */
	readonly children = new Map<string, Child>();
	/** Integration seams (worktree isolation, structured output, ...). */
	hooks: ChildHooks = {};
	private childWaiters = new Map<string, ChildWaiter[]>();
	private parentWaiters: ParentWaiter[] = [];
	private changeListeners = new Set<() => void>();
	/**
	 * One permit pool per depth level. With a single shared pool, owners holding every permit while
	 * waiting on their (queued) subagents would deadlock. Per-depth pools make progress structural:
	 * the deepest level never waits on descendants, so its runs always finish, and every level above
	 * only waits on levels below it. Owners additionally release their permit while blocked on their
	 * subagents after their turn ended (runLoop), so idle owners don't starve same-level work.
	 * (An owner blocked *inside* a turn, e.g. `irc wait`, keeps its permit; per-depth pools still
	 * guarantee its subagents can run.)
	 */
	private pools = new Map<number, Semaphore>();

	constructor(private readonly pi: ExtensionAPI) {}

	onChange(fn: () => void): () => void {
		this.changeListeners.add(fn);
		return () => this.changeListeners.delete(fn);
	}

	/** Re-render / re-check after hook-side state changes (e.g. `child.phase`). */
	touch(): void {
		this.changed();
	}

	private changed(): void {
		// Blocked owners re-check their wake condition (a subagent may have settled or died).
		for (const c of this.children.values()) c.unblock?.();
		for (const fn of this.changeListeners) {
			try {
				fn();
			} catch {}
		}
	}

	private pool(depth: number): Semaphore {
		let p = this.pools.get(depth);
		if (!p) {
			p = new Semaphore(MAX_RUNNING);
			this.pools.set(depth, p);
		}
		return p;
	}

	active(): Child[] {
		return [...this.children.values()].filter(isActive);
	}

	hasActive(): boolean {
		for (const c of this.children.values()) if (isActive(c)) return true;
		return false;
	}

	/** Every agent in tree order: each top-level agent followed by its subtree (depth-first). */
	tree(): Child[] {
		const out: Child[] = [];
		const walk = (c: Child) => {
			out.push(c);
			for (const o of c.owned) walk(o);
		};
		for (const c of this.children.values()) if (c.ownerId === PARENT_ID) walk(c);
		return out;
	}

	isDescendant(c: Child, ancestorId: string): boolean {
		for (let cur: Child | undefined = c; cur && cur.ownerId !== PARENT_ID; cur = this.children.get(cur.ownerId)) {
			if (cur.ownerId === ancestorId) return true;
		}
		return false;
	}

	/**
	 * Agents `viewer` sees. The main agent (or user) sees everyone; a child sees its siblings (same
	 * owner) and its own subagents. Any id can still be addressed directly.
	 */
	peers(viewer: string): PeerInfo[] {
		const me = this.children.get(viewer);
		const out: PeerInfo[] = [];
		for (const c of this.children.values()) {
			if (c.id === viewer || c.status === "aborted") continue;
			const own = !!me && c.ownerId === viewer;
			if (me && !own && c.ownerId !== me.ownerId) continue;
			out.push({ id: c.id, agent: c.agent.name, status: c.status, activity: firstLine(c.task, 80), own: own || undefined });
		}
		return out;
	}

	roster(viewer: string): string {
		const lines: string[] = [];
		const me = this.children.get(viewer);
		if (me?.ownerId === PARENT_ID) lines.push(`- \`${PARENT_ID}\` — the main agent that spawned you`);
		else if (me) {
			lines.push(`- \`${PARENT_ID}\` — \`${me.ownerId}\`, the agent that spawned you`);
			lines.push(`- \`${MAIN_ALIAS}\` — the main agent`);
		}
		for (const p of this.peers(viewer)) lines.push(formatPeer(p));
		return lines.length ? lines.join("\n") : "(no other agents)";
	}

	/** Map a model-facing address to an internal id: `parent` = owner for nested senders, `main` = main agent. */
	resolveAddress(sender: Child | undefined, to: string): string {
		if (to === MAIN_ALIAS) return PARENT_ID;
		if (to === PARENT_ID && sender) return sender.ownerId;
		return to;
	}

	/** Internal id as `viewer` addresses it (inverse of resolveAddress). */
	displayId(viewer: Child, id: string): string {
		if (viewer.ownerId === PARENT_ID) return id;
		if (id === viewer.ownerId) return PARENT_ID;
		if (id === PARENT_ID) return MAIN_ALIAS;
		return id;
	}

	private taken(id: string): boolean {
		return this.children.has(id) || RESERVED_IDS.has(id.toLowerCase());
	}

	private uniqueId(requested?: string): string {
		const base = sanitizeAgentId(requested);
		if (!base) return generateTaskName((id) => this.taken(id));
		if (!this.taken(base)) return base;
		for (let n = 2; ; n++) if (!this.taken(`${base}-${n}`)) return `${base}-${n}`;
	}

	private resolveModel(
		spec: SpawnSpec,
		ctx: ExtensionContext,
		fallback: Model<any> | undefined,
	): { model: Model<any> | undefined; warning?: string } {
		const want = spec.model ?? spec.agent.model;
		if (!want) return { model: fallback };
		const reg = ctx.modelRegistry;
		let found: Model<any> | undefined;
		const slash = want.indexOf("/");
		if (slash > 0) found = reg.find(want.slice(0, slash), want.slice(slash + 1));
		if (!found) {
			const all = reg.getAvailable();
			const exact = all.filter((m) => m.id === want);
			found =
				exact.find((m) => m.provider === fallback?.provider) ??
				exact[0] ??
				all.find((m) => m.provider === fallback?.provider && m.id.includes(want)) ??
				all.find((m) => m.id.includes(want));
		}
		if (!found) return { model: fallback, warning: `model "${want}" not found; using parent model` };
		return { model: found };
	}

	/** Ids at `depth` that are (or will be) waiting for a run permit: FIFO, so the newest claimants beyond the cap. */
	queuedAt(depth: number): Set<string> {
		const claimants = [...this.children.values()].filter(
			(c) => c.depth === depth && (c.status === "running" || c.status === "pending") && !c.blocked,
		);
		return new Set(claimants.slice(MAX_RUNNING).map((c) => c.id));
	}

	/**
	 * Register a child and start it in the background. Returns synchronously; the session is created
	 * asynchronously and the first run waits for a permit when MAX_RUNNING runs are already active.
	 */
	spawn(spec: SpawnSpec, ctx: ExtensionContext): { child: Child; warning?: string } {
		const owner = spec.owner;
		if (owner && owner.depth >= MAX_DEPTH) throw new Error(`nesting limit reached (max depth ${MAX_DEPTH})`);
		if (owner?.status === "aborted") throw new Error(`${owner.id} was aborted`);
		const { model, warning } = this.resolveModel(spec, ctx, owner ? owner.model : ctx.model);
		if (!model) throw new Error("No model available for subagent.");
		const id = this.uniqueId(spec.name);
		const thinkingRaw = spec.thinking ?? spec.agent.thinking;
		const thinking = (
			thinkingRaw && THINKING_LEVELS.includes(thinkingRaw) ? thinkingRaw : (owner?.thinking ?? this.pi.getThinkingLevel())
		) as ThinkingLevel;
		let projectTrusted = owner?.projectTrusted ?? false;
		if (!owner) {
			try {
				projectTrusted = ctx.isProjectTrusted();
			} catch {}
		}
		const child: Child = {
			id,
			agent: spec.agent,
			task: spec.task,
			context: spec.context,
			cwd: spec.cwd,
			ownerId: owner?.id ?? PARENT_ID,
			depth: (owner?.depth ?? 0) + 1,
			owned: [],
			item: spec.item,
			isolated: spec.isolated || undefined,
			schema: spec.schema,
			ctx,
			projectTrusted,
			model,
			modelLabel: `${model.provider}/${model.id}`,
			contextWindow: (model as { contextWindow?: number }).contextWindow,
			thinking,
			status: "pending",
			createdAt: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0, toolCount: 0, contextTokens: 0 },
			usageCursor: 0,
			runningTools: new Map(),
			activity: [],
			initialSettled: false,
			inbox: [],
			sentDuringRun: new Set(),
			steered: [],
			steersInFlight: new Set(),
			queued: false,
			hasPermit: false,
			blocked: false,
			abort: new AbortController(),
			unsubscribe: () => {},
		};
		this.children.set(id, child);
		owner?.owned.push(child);
		this.changed();
		void this.start(child);
		return { child, warning };
	}

	/**
	 * Body of every `task` tool call (main agent and spawning children): validate items against the
	 * caller's spawn policy (+ `hooks.validate`, e.g. output schema / git repo checks) and spawn the
	 * valid ones. `owner` = the calling child (nested spawn). Relative item `cwd`s resolve against `opts.cwd`.
	 */
	async spawnTasks(
		params: { context?: string; tasks?: Array<Record<string, any>> },
		ctx: ExtensionContext,
		opts: { policy: SpawnPolicy; cwd: string; owner?: Child },
	): Promise<TaskCallOutcome> {
		const items = Array.isArray(params.tasks) ? params.tasks : [];
		const { policy, owner } = opts;
		const available = policy.agents.map((a) => a.name).join(", ");
		const fail = (text: string): TaskCallOutcome => ({ children: [], failures: [], text, isError: true });
		if (items.length === 0) return fail(`Provide tasks[] (each with a task). Available agents: ${available}`);
		if (items.length > MAX_TASKS_PER_CALL) return fail(`Too many tasks (${items.length}); max ${MAX_TASKS_PER_CALL} per call.`);

		// 1. Synchronous checks, then the (possibly async) hook checks of every item concurrently.
		const entries: Array<{ label: string; spec?: SpawnSpec; error?: string }> = items.map((item, i) => {
			const label = (typeof item.name === "string" && item.name.trim()) || `#${i + 1}`;
			if (typeof item.task !== "string" || !item.task.trim()) return { label, error: "empty task" };
			const agentName = (typeof item.agent === "string" && item.agent.trim()) || policy.defaultAgent;
			const agent = policy.agents.find((a) => a.name === agentName);
			if (!agent) {
				return {
					label,
					error:
						policy.allowedText === "*"
							? `unknown agent "${agentName}" (available: ${available})`
							: `agent "${agentName}" is not allowed here (spawns: ${policy.allowedText})`,
				};
			}
			const cwd = typeof item.cwd === "string" && item.cwd.trim() ? path.resolve(opts.cwd, item.cwd.trim()) : opts.cwd;
			return {
				label,
				spec: { name: item.name, agent, task: item.task, context: params.context, cwd, model: item.model, thinking: item.thinking, owner, item },
			};
		});
		if (this.hooks.validate) {
			await Promise.all(
				entries.map(async (e) => {
					if (!e.spec) return;
					try {
						const err = await this.hooks.validate!(e.spec);
						if (typeof err === "string" && err) e.error = err;
					} catch (err) {
						e.error = err instanceof Error ? err.message : String(err);
					}
				}),
			);
		}

		// 2. Spawn in item order (synchronously, so every child's roster lists its whole batch).
		const children: Child[] = [];
		const warnings = new Map<string, string>();
		const failures: string[] = [];
		for (const e of entries) {
			if (e.error || !e.spec) {
				failures.push(`${e.label}: ${e.error ?? "invalid task"}`);
				continue;
			}
			try {
				const { child, warning } = this.spawn(e.spec, ctx);
				children.push(child);
				if (warning) warnings.set(child.id, warning);
			} catch (err) {
				failures.push(`${e.label}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		const queuedIds = this.queuedAt((owner?.depth ?? 0) + 1);
		const spawned: SpawnedInfo[] = children.map((c) => ({
			id: c.id,
			agent: c.agent.name,
			queued: queuedIds.has(c.id),
			warning: warnings.get(c.id),
			tags: [c.isolated ? "isolated" : "", c.schema ? "structured" : ""].filter(Boolean),
		}));
		return { children, failures, text: formatSpawnFeedback(spawned, failures), isError: children.length === 0 };
	}

	/** Spawn policy for a child's own `task` tool; undefined = no task tool (depth limit or no `spawns`). */
	private spawnPolicy(child: Child): SpawnPolicy | undefined {
		if (child.depth >= MAX_DEPTH) return undefined;
		return resolveSpawnPolicy(child.agent, discoverAgents(child.cwd, child.projectTrusted));
	}

	/** Custom tools of a child session: irc, task (spawners only), then hook-provided tools. */
	private childTools(child: Child, policy: SpawnPolicy | undefined): ToolDefinition[] {
		const tools = [this.childIrcTool(child)];
		if (policy) tools.push(this.childTaskTool(child, policy));
		tools.push(...(this.hooks.tools?.(child) ?? []));
		return tools;
	}

	/** Built-in tool allowlist: the agent's `tools` (minus `task`, which only exists as a custom tool) + every custom tool. */
	private toolAllowlist(child: Child, customTools: ToolDefinition[]): string[] | undefined {
		if (!child.agent.tools) return undefined;
		return [...new Set([...child.agent.tools.filter((t) => t !== "task"), ...customTools.map((t) => t.name)])];
	}

	private async start(child: Child): Promise<void> {
		// Let the rest of the batch register first so every child's peer roster lists its siblings.
		await Promise.resolve();
		if ((child.status as ChildStatus) === "aborted") return;
		const ctx = child.ctx;
		try {
			if (this.hooks.prepare) {
				await this.hooks.prepare(child);
				if ((child.status as ChildStatus) === "aborted") return;
			}
			const policy = this.spawnPolicy(child);
			child.spawns = policy?.agents.map((a) => a.name);
			const customTools = this.childTools(child, policy);

			const agentDir = getAgentDir();
			// In-memory snapshot of parent settings: children never write settings.json.
			const settingsManager = SettingsManager.inMemory(structuredClone(this.pi.getSettings()));
			const resourceLoader = new DefaultResourceLoader({
				cwd: child.cwd,
				agentDir,
				settingsManager,
				// No extensions in children: nested spawning is the hub's own `task` tool (depth/policy
				// limited), and side-effecting user extensions stay out.
				noExtensions: true,
				appendSystemPrompt: [
					childSystemPrompt({
						id: child.id,
						role: child.agent.systemPrompt,
						context: child.context,
						peers: this.peers(child.id),
						owner: child.ownerId !== PARENT_ID ? child.ownerId : undefined,
						spawns: child.spawns,
						worktree: child.worktree ? { path: child.worktree.path, cwd: child.worktree.cwd, repoRoot: child.worktree.repoRoot } : undefined,
						schema: child.schema,
					}),
				],
			});
			await resourceLoader.reload();

			// Reuse the parent's model runtime (keeps extension-registered providers and auth caches).
			const runtime = (ctx.modelRegistry as any)?.runtime;
			const { session } = await createAgentSession({
				cwd: child.cwd,
				agentDir,
				model: child.model,
				thinkingLevel: child.thinking,
				modelRuntime: runtime && typeof runtime.getModel === "function" ? runtime : undefined,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(child.cwd),
				tools: this.toolAllowlist(child, customTools),
				customTools,
			});
			if ((child.status as ChildStatus) === "aborted") {
				session.dispose();
				return;
			}
			child.session = session;
			child.unsubscribe = session.subscribe((ev) => this.onChildEvent(child, ev));
		} catch (e) {
			if ((child.status as ChildStatus) === "aborted") return;
			child.finalizing = true; // stays "active" for its owner until the failed result is out
			child.error = e instanceof Error ? e.message : String(e);
			child.status = "failed";
			child.finishedAt = Date.now();
			// Never ran and cannot be woken (no session): release what prepare set up (e.g. its worktree).
			let info: DisposeInfo | undefined;
			try {
				const r = await this.hooks.dispose?.(child);
				if (r && typeof r === "object") info = r;
			} catch {}
			if ((child.status as ChildStatus) !== "aborted") this.settleInitial(child, "failed", "", true, info?.merge ? { merge: info.merge } : undefined);
			this.changed();
			return;
		}
		await this.runLoop(child, childUserPrompt(child.task), { kind: "initial" });
	}

	private pushActivity(child: Child, line: string): void {
		child.activity.push(line);
		if (child.activity.length > 50) child.activity.shift();
	}

	private onChildEvent(child: Child, ev: AgentSessionEvent): void {
		if (ev.type === "tool_execution_start") {
			const act: ToolActivity = { id: ev.toolCallId, name: ev.toolName, args: previewArgs(ev.args), startedAt: Date.now() };
			child.runningTools.set(ev.toolCallId, act);
			child.usage.toolCount++;
			this.pushActivity(child, `→ ${act.name} ${act.args}`.trimEnd());
			this.changed();
		} else if (ev.type === "tool_execution_end") {
			const act = child.runningTools.get(ev.toolCallId);
			if (act) {
				child.runningTools.delete(ev.toolCallId);
				child.lastTool = act;
			}
			if (ev.isError) this.pushActivity(child, `✗ ${ev.toolName} failed`);
			this.changed();
		} else if (ev.type === "message_end" && (ev.message as any).role === "assistant") {
			const msg = ev.message as any;
			child.usage.requests++;
			const u = msg.usage;
			if (u) {
				child.usage.contextTokens =
					u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
			}
			// Tokens/cost are taken from the session entry (appended right after this event), see scheduleUsageSync.
			const text = (msg.content ?? [])
				.filter((p: any) => p.type === "text")
				.map((p: any) => p.text)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			if (text) {
				child.lastText = text.length > 200 ? `${text.slice(0, 200)}…` : text;
				this.pushActivity(child, text.length > 100 ? `${text.slice(0, 100)}…` : text);
			}
			this.changed();
		}
		switch (ev.type) {
			// Everything that can add spend to the child's session: model responses (the entry is appended
			// right after message_end is emitted), compaction summaries, cache-warm usage entries.
			case "message_end":
			case "turn_end":
			case "agent_end":
			case "agent_settled":
			case "compaction_end":
			case "entry_appended":
				this.scheduleUsageSync(child);
		}
	}

	/** Mirror new child spend after the current synchronous step (pi appends the message after emitting message_end). */
	private scheduleUsageSync(child: Child): void {
		if (child.usageSyncPending) return;
		child.usageSyncPending = true;
		queueMicrotask(() => {
			child.usageSyncPending = false;
			this.syncUsage(child);
		});
	}

	/**
	 * Mirror the child's session spend since the last sync into the main session (`usage` entries of
	 * kind "subagent", one per provider/model of the batch; see usage.ts) and into `child.usage`. Idempotent:
	 * a cursor over the child's append-only entries guarantees each entry is counted exactly once. Called
	 * after every spending event and at teardown, so killed and shutdown-aborted runs are included too.
	 */
	syncUsage(child: Child): void {
		const sm = child.session?.sessionManager;
		if (!sm) return;
		const entries = sm.getEntries();
		if (entries.length <= child.usageCursor) return;
		const batch = sessionUsage(entries, child.usageCursor, { provider: child.model?.provider ?? "unknown", model: child.model?.id ?? "unknown" });
		child.usageCursor = entries.length;
		if (batch.length === 0) return;
		for (const a of batch) {
			child.usage.input += a.usage.input;
			child.usage.output += a.usage.output;
			child.usage.cacheRead += a.usage.cacheRead;
			child.usage.cacheWrite += a.usage.cacheWrite;
			child.usage.cost += a.usage.cost.total;
			try {
				recordUsage(child.ctx.sessionManager, a, child.id);
			} catch {
				// Stale ctx (session replaced under a still-running child): nowhere left to record it.
			}
		}
		this.changed();
	}

	private lastAssistantError(child: Child): string | undefined {
		const msgs = (child.session?.messages ?? []) as any[];
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.role !== "assistant") continue;
			if (m.stopReason === "error" || m.stopReason === "aborted") return m.errorMessage || m.stopReason;
			return undefined;
		}
		return undefined;
	}

	makeDone(child: Child, status: DoneStatus, output: string, extra?: DoneExtra): DoneInfo {
		this.syncUsage(child); // the result's cost covers the whole run
		const end = child.finishedAt ?? Date.now();
		return {
			id: child.id,
			agent: child.agent.name,
			status,
			output,
			error: child.error,
			...(extra && extra.data !== undefined ? { data: extra.data } : {}),
			structured: child.schema ? true : undefined,
			isolated: child.isolated || undefined,
			merge: extra?.merge,
			durationMs: end - (child.runStartedAt ?? child.startedAt ?? child.createdAt),
			model: child.modelLabel,
			thinking: child.thinking,
			task: firstLine(child.task),
			toolCount: child.usage.toolCount,
			requests: child.usage.requests,
			cost: child.usage.cost,
			contextTokens: child.usage.contextTokens,
			contextWindow: child.contextWindow,
			subagents: child.owned.length ? child.owned.map(summarize) : undefined,
		};
	}

	private settleInitial(child: Child, status: DoneStatus, output: string, notify = true, extra?: DoneExtra): void {
		const done = this.makeDone(child, status, output, extra);
		child.done = done;
		if (child.initialSettled) return;
		child.initialSettled = true;
		if (notify) this.deliverResult(child, done);
	}

	/** A settled initial result goes to whoever spawned the agent: the main session or the owning child. */
	private deliverResult(child: Child, done: DoneInfo): void {
		if (child.ownerId === PARENT_ID) {
			this.notifyParent({ kind: "done", done });
			return;
		}
		const owner = this.children.get(child.ownerId);
		if (!owner || owner.status === "aborted") return;
		const msg: IrcMessage = { kind: "result", from: child.id, to: owner.id, body: formatTaskResult(done), done, ts: Date.now() };
		void this.route(owner, msg).catch(() => {});
	}

	/** Status line about an owner's subagents, appended to results it receives. */
	private subagentNote(owner: Child): string {
		if (owner.owned.length === 0) return "";
		const active = activeDescendants(owner);
		if (active.length === 0) return "All your subagents have settled.";
		const n = active.length;
		return `${n} subagent${n === 1 ? "" : "s"} still running (${active.map((c) => c.id).join(", ")}); ${n === 1 ? "its result is" : "their results are"} delivered as they finish.`;
	}

	/** Frame an incoming item for `recipient` (ids mapped to its view; results get a subagent status note). */
	formatIncoming(recipient: Child, msg: IrcMessage, mode: "steer" | "wake" | "wait" | "continue"): string {
		const text = frameIncoming(msg, this.displayId(recipient, msg.from), mode, !!recipient.schema);
		if (msg.kind !== "result") return text;
		const note = this.subagentNote(recipient);
		return note ? `${text}\n\n${note}` : text;
	}

	/** Next prompt for an owner continuing the same purpose (results/messages that arrived while it worked or waited). */
	private continuation(child: Child, leftovers: string[], queued: IrcMessage[]): string {
		return [...leftovers, ...queued.map((m) => this.formatIncoming(child, m, "continue"))].join("\n\n");
	}

	private pushInbox(child: Child, msg: IrcMessage): void {
		child.inbox.push(msg);
		child.unblock?.();
	}

	private async acquirePermit(child: Child): Promise<boolean> {
		const pool = this.pool(child.depth);
		child.queued = pool.wouldQueue();
		this.changed();
		try {
			await pool.acquire(child.abort.signal);
			child.hasPermit = true;
			return true;
		} catch {
			return false; // killed while queued
		} finally {
			child.queued = false;
		}
	}

	private releasePermit(child: Child): void {
		if (!child.hasPermit) return;
		child.hasPermit = false;
		this.pool(child.depth).release();
	}

	/**
	 * The owner's turn ended while its subagents are active: pause WITHOUT a permit until an inbox item
	 * arrives (a result or message), every subagent has settled, or the owner is killed; then take a
	 * permit again. Returns the inbox items to continue with (empty = nothing arrived / killed).
	 */
	private async awaitSubagents(child: Child): Promise<IrcMessage[]> {
		child.blocked = true;
		this.releasePermit(child);
		await new Promise<void>((resolve) => {
			child.unblock = () => {
				// Notices wait for the continuation; they do not resume a paused owner on their own.
				if (child.inbox.some((m) => m.kind !== "notice") || child.status === "aborted" || activeDescendants(child).length === 0) {
					child.unblock = undefined;
					resolve();
				}
			};
			this.changed(); // shows "waiting for N subagents" and runs the first check
		});
		child.blocked = false;
		if ((child.status as ChildStatus) === "aborted") return [];
		if (!(await this.acquirePermit(child))) return [];
		return child.inbox.splice(0);
	}

	/**
	 * Run turns until the child has nothing left to process, then go idle. Holds a permit while it
	 * runs (released while blocked on its subagents).
	 *
	 * After each prompt:
	 *  1. subagent results unread or subagents still active -> continue the same purpose (blocking
	 *     for the next result first if nothing is queued); nothing settles yet
	 *  2. settle point (`settleRun`, after the optional `hooks.beforeSettle`)
	 *  3. messages that arrived meanwhile -> new turn whose reply goes to the first sender
	 */
	private async runLoop(child: Child, firstText: string, purpose: Purpose): Promise<void> {
		child.status = "pending";
		child.finishedAt = undefined;
		if (!(await this.acquirePermit(child))) return;
		try {
			if ((child.status as ChildStatus) === "aborted" || !child.session) return;
			const session = child.session;
			child.status = "running";
			child.runStartedAt = Date.now();
			child.startedAt ??= child.runStartedAt;
			child.error = undefined;
			this.changed();

			let text = firstText;
			let current = purpose;
			child.sentDuringRun.clear();
			while (true) {
				// Messages that arrived while queued are folded into this run's prompt.
				const early = child.inbox.splice(0);
				if (early.length) text = [text, ...early.map((m) => this.formatIncoming(child, m, "steer"))].join("\n\n");
				child.wakeSender = current.kind === "reply" ? current.to : undefined;
				let thrown: string | undefined;
				try {
					await session.prompt(text, { expandPromptTemplates: false });
				} catch (e) {
					thrown = e instanceof Error ? e.message : String(e);
				}
				if ((child.status as ChildStatus) === "aborted") return;
				// A steer that raced with the end of the prompt must land in the queue before it is collected.
				if (child.steersInFlight.size > 0) {
					await Promise.all([...child.steersInFlight]);
					if ((child.status as ChildStatus) === "aborted") return;
				}

				// Synchronously (no awaits) collect anything that slipped past the loop's last steering check.
				let leftovers: string[] = [];
				try {
					const q = session.clearQueue();
					leftovers = [...q.steering, ...q.followUp];
				} catch {}
				let queued = child.inbox.splice(0);
				const steeredResult = child.steered.some((s) => s.msg.kind === "result" && leftovers.includes(s.text));
				child.steered = [];

				const output = session.getLastAssistantText() ?? "";
				const error = thrown ?? this.lastAssistantError(child);
				child.error = error;
				child.runningTools.clear();

				// 1. An owner is not done while its subagents work or their results are unread.
				if (steeredResult || queued.some((m) => m.kind === "result") || activeDescendants(child).length > 0) {
					if (leftovers.length === 0 && queued.length === 0) {
						queued = await this.awaitSubagents(child);
						if ((child.status as ChildStatus) === "aborted") return;
					}
					if (leftovers.length > 0 || queued.length > 0) {
						text = this.continuation(child, leftovers, queued);
						this.hooks.resume?.(child);
						continue;
					}
					// Every subagent settled without reporting back (e.g. killed): settle with the output we have.
				}

				// 2. Settle point.
				let status: DoneStatus = error ? "failed" : "completed";
				let finalOutput = output;
				let extra: DoneExtra | undefined;
				let notice: { body?: string; to?: string; replyNote?: string } | undefined;
				if (this.hooks.beforeSettle) {
					let o: SettleOverride | void = undefined;
					try {
						o = await this.hooks.beforeSettle(child, { initial: current.kind === "initial", status, output });
					} catch (e) {
						child.error = e instanceof Error ? e.message : String(e);
						status = "failed";
					}
					if ((child.status as ChildStatus) === "aborted") return;
					// Anything that arrived during the hook joins this batch.
					queued.push(...child.inbox.splice(0));
					if (o?.retry) {
						text = [o.retry, this.continuation(child, leftovers, queued)].filter(Boolean).join("\n\n");
						continue;
					}
					if (o?.status) status = o.status;
					if (o?.output !== undefined) finalOutput = o.output;
					if (o?.error !== undefined) child.error = o.error || undefined;
					if (o && (o.data !== undefined || o.merge)) extra = { data: o.data, merge: o.merge };
					if (o?.notice || o?.replyNote) notice = { body: o.notice, to: o.noticeTo, replyNote: o.replyNote };
				}
				this.settleRun(child, current, status, finalOutput, child.error, extra, notice);

				// 3. Follow-ups that arrived during the run. Notices alone don't start a turn: they stay queued
				// for the next run (an idle child's inbox is folded into its next prompt).
				if (leftovers.length === 0 && queued.every((m) => m.kind === "notice")) {
					child.inbox.unshift(...queued);
					break;
				}
				text = [
					...leftovers,
					...queued.map((m) => this.formatIncoming(child, m, expectsReply(m) ? "wake" : "continue")),
				].join("\n\n");
				const firstIrc = queued.find(expectsReply);
				current = firstIrc ? { kind: "reply", to: firstIrc.from } : { kind: "none" };
				child.sentDuringRun.clear();
			}
			child.status = child.error ? "failed" : "idle";
			child.finishedAt = Date.now();
			this.changed();
		} finally {
			this.releasePermit(child);
		}
	}

	/** Deliver a run's result: the initial result goes to the owner; a follow-up reply to its sender. */
	private settleRun(
		child: Child,
		purpose: Purpose,
		status: DoneStatus,
		output: string,
		error: string | undefined,
		extra?: DoneExtra,
		notice?: { body?: string; to?: string; replyNote?: string },
	): void {
		if (purpose.kind === "initial") {
			// The result (incl. e.g. its merge summary) goes to the owner anyway.
			child.finishedAt = Date.now();
			this.settleInitial(child, status, output, true, extra);
			return;
		}
		child.done = this.makeDone(child, status, output, extra);
		const relayTo = purpose.kind === "reply" && !child.sentDuringRun.has(purpose.to) ? purpose.to : undefined;
		const noticeTo = notice?.to ?? child.ownerId;
		if (relayTo) {
			const reply = error && !output ? `(failed: ${error})` : output || "(no reply)";
			const extra = relayTo === noticeTo ? (notice?.body ?? notice?.replyNote) : (notice?.replyNote ?? notice?.body);
			void this.deliver(child.id, relayTo, extra ? `${reply}\n\n${extra}` : reply).catch(() => {});
		}
		if (notice?.body && relayTo !== noticeTo) this.sendNotice(child, notice.body, noticeTo);
	}

	/**
	 * Hub-generated notice for `to` (PARENT_ID or a child id); never relayed back. The main agent gets
	 * it right away (a turn); a child gets it at its next step, or with its next run if idle/paused.
	 */
	private sendNotice(child: Child, body: string, to: string): void {
		const msg: IrcMessage = { kind: "notice", from: child.id, to, body, ts: Date.now() };
		if (to === PARENT_ID) {
			this.notifyParent({ kind: "message", msg });
			return;
		}
		const target = this.children.get(to);
		if (!target || target.status === "aborted") return;
		void this.route(target, msg).catch(() => {});
	}

	/**
	 * Deliver a message from `from` (PARENT_ID, USER_ID, or a child id) to a model-facing address
	 * (`parent`/`main` aliases resolved for the sender). Returns a human-readable receipt; throws on failure.
	 */
	async send(from: string, to: string, body: string): Promise<string> {
		to = to.trim();
		if (!to) throw new Error("A recipient is required.");
		if (!body.trim()) throw new Error("A non-empty message is required.");
		return this.deliver(from, this.resolveAddress(this.children.get(from), to), body);
	}

	/** `send` with an internal recipient id (no alias resolution). */
	private async deliver(from: string, to: string, body: string): Promise<string> {
		if (to === from) throw new Error("Cannot send a message to yourself.");
		const sender = this.children.get(from);
		if (sender) sender.sentDuringRun.add(to);

		if (to === "all") {
			const targets = this.broadcastTargets(from);
			const receipts = await Promise.all(
				targets.map((t) =>
					this.deliver(from, t, body).then(
						(r) => `- ${t}: ${r}`,
						(e) => `- ${t}: failed — ${e.message}`,
					),
				),
			);
			return targets.length ? `Broadcast to ${targets.length} agent(s):\n${receipts.join("\n")}` : "No agents to broadcast to.";
		}

		const msg: IrcMessage = { kind: "irc", from, to, body, ts: Date.now() };
		if (to === PARENT_ID) {
			this.notifyParent({ kind: "message", msg });
			return sender && sender.ownerId !== PARENT_ID ? "delivered to the main agent" : "delivered to parent";
		}
		if (to === USER_ID) {
			this.notifyUser(msg);
			return "delivered to user";
		}

		const child = this.children.get(to);
		if (!child) throw new Error(`Unknown agent "${to}". Known: ${[PARENT_ID, ...this.children.keys()].join(", ")}`);
		if (child.status === "aborted") throw new Error(`Agent "${to}" was aborted and cannot receive messages.`);
		return this.route(child, msg);
	}

	/**
	 * "all": the main agent and the user reach every agent; a child reaches its roster (its parent,
	 * siblings, and own subagents).
	 */
	private broadcastTargets(from: string): string[] {
		const me = this.children.get(from);
		const live = [...this.children.values()].filter((c) => c.id !== from && c.status !== "aborted");
		if (!me) return live.map((c) => c.id);
		const targets = live.filter((c) => c.ownerId === me.ownerId || c.ownerId === me.id).map((c) => c.id);
		const owner = this.children.get(me.ownerId);
		if (me.ownerId === PARENT_ID) targets.unshift(PARENT_ID);
		else if (owner && owner.status !== "aborted") targets.unshift(owner.id);
		return targets;
	}

	/** Route an incoming item (message or subagent result) to a child according to its state. */
	private async route(child: Child, msg: IrcMessage): Promise<string> {
		const waiters = this.childWaiters.get(child.id);
		const wi = waiters?.findIndex((w) => !w.from || w.from === msg.from) ?? -1;
		if (waiters && wi >= 0) {
			const [w] = waiters.splice(wi, 1);
			w!.resolve(msg);
			return "delivered (recipient was waiting)";
		}
		if (child.session?.isStreaming) {
			const text = this.formatIncoming(child, msg, "steer");
			child.steered.push({ msg, text });
			const p = child.session.steer(text);
			const landed = p.then(
				() => {},
				() => {},
			);
			child.steersInFlight.add(landed);
			try {
				await p;
			} finally {
				child.steersInFlight.delete(landed);
			}
			return "delivered; it will read it at its next step";
		}
		if (child.status === "pending") {
			this.pushInbox(child, msg);
			return "queued; it will read it when it starts";
		}
		if (child.status === "running") {
			this.pushInbox(child, msg);
			return "queued; it will read it right after its current step";
		}
		if (!child.session) throw new Error(`Agent "${child.id}" failed to start${child.error ? ` (${child.error})` : ""} and cannot receive messages.`);
		if (msg.kind === "notice") {
			// Idle: don't spend a turn on it; it is folded into the agent's next run.
			this.pushInbox(child, msg);
			return "queued for its next run";
		}
		if (!expectsReply(msg)) {
			void this.runLoop(child, this.formatIncoming(child, msg, "continue"), { kind: "none" });
			return "woke idle agent";
		}
		void this.runLoop(child, this.formatIncoming(child, msg, "wake"), { kind: "reply", to: msg.from });
		return "woke idle agent; its reply will be delivered back to you";
	}

	private notifyParent(ev: ParentEvent): void {
		const i = this.parentWaiters.findIndex((w) => w.filter(ev));
		if (i >= 0) {
			const [w] = this.parentWaiters.splice(i, 1);
			w!.resolve(ev);
			return;
		}
		this.pi.sendMessage(
			{
				customType: ev.kind === "done" ? RESULT_MESSAGE_TYPE : IRC_MESSAGE_TYPE,
				content: formatParentEvent(ev),
				display: true,
				details: ev,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	private notifyUser(msg: IrcMessage): void {
		// Shown in the transcript; doesn't start a parent turn on its own.
		this.pi.sendMessage(
			{
				customType: IRC_MESSAGE_TYPE,
				content: formatParentEvent({ kind: "message", msg }),
				display: true,
				details: { kind: "message", msg },
			},
			{ triggerTurn: false },
		);
	}

	/** Block the parent until a matching event (message or completion) arrives. */
	waitForParent(filter: (ev: ParentEvent) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<ParentEvent | null> {
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const waiter: ParentWaiter = {
				filter,
				resolve: (ev) => {
					cleanup();
					resolve(ev);
				},
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("wait aborted"));
			};
			const cleanup = () => {
				const i = this.parentWaiters.indexOf(waiter);
				if (i >= 0) this.parentWaiters.splice(i, 1);
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			if (signal?.aborted) return reject(new Error("wait aborted"));
			signal?.addEventListener("abort", onAbort, { once: true });
			if (timeoutMs > 0) timer = setTimeout(() => waiter.resolve(null), timeoutMs);
			this.parentWaiters.push(waiter);
		});
	}

	waitForChild(id: string, from: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<IrcMessage | null> {
		const child = this.children.get(id);
		const idx = child?.inbox.findIndex((m) => !from || m.from === from) ?? -1;
		if (child && idx >= 0) return Promise.resolve(child.inbox.splice(idx, 1)[0]!);
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const list = this.childWaiters.get(id) ?? [];
			this.childWaiters.set(id, list);
			const waiter: ChildWaiter = {
				from,
				resolve: (m) => {
					cleanup();
					resolve(m);
				},
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("wait aborted"));
			};
			const cleanup = () => {
				const i = list.indexOf(waiter);
				if (i >= 0) list.splice(i, 1);
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			if (signal?.aborted) return reject(new Error("wait aborted"));
			signal?.addEventListener("abort", onAbort, { once: true });
			if (timeoutMs > 0) timer = setTimeout(() => waiter.resolve(null), timeoutMs);
			list.push(waiter);
		});
	}

	/**
	 * A message matching `from` was steered into `child`'s session and is still queued for its next
	 * step (it arrived while the child was busy, before it called `irc wait`).
	 */
	private hasQueuedSteer(child: Child, from: string | undefined): boolean {
		let pending: readonly string[] = [];
		try {
			pending = child.session?.getSteeringMessages?.() ?? [];
		} catch {}
		return child.steered.some((s) => pending.includes(s.text) && (!from || s.msg.from === from));
	}

	/**
	 * Abort an agent and (first) its whole subtree.
	 *  notify: deliver an aborted `<task-result>` to the owner if the initial result is still outstanding
	 *          (used when the user kills an agent the parent is still expecting). Nested agents notify
	 *          their owner by default unless the owner itself asked for the kill (`by`).
	 *  silent: never notify (cascades and disposal: the owner is going away too).
	 * Resolves (after `hooks.dispose` ran for the whole subtree) with notes for the killer, e.g. where
	 * unmerged worktree changes were saved. Concurrent kills of one agent share a single teardown.
	 */
	kill(id: string, opts: { notify?: boolean; by?: string; silent?: boolean } = {}): Promise<string[]> {
		const child = this.children.get(id);
		if (!child) return Promise.reject(new Error(`Unknown agent "${id}".`));
		if (child.killing) return child.killing;
		if (child.status === "aborted") return Promise.resolve([]);
		child.killing = this.teardown(child, opts);
		return child.killing;
	}

	private async teardown(child: Child, opts: { notify?: boolean; by?: string; silent?: boolean }): Promise<string[]> {
		// Mark first so this agent's own loop (e.g. blocked on its subagents) cannot settle while the subtree goes down.
		// `finalizing` keeps it "active" for a waiting owner until the aborted result below is delivered.
		child.finalizing = true;
		child.status = "aborted";
		child.finishedAt = Date.now();
		child.abort.abort();
		child.runningTools.clear();
		child.unblock?.();
		for (const w of this.childWaiters.get(child.id)?.splice(0) ?? []) w.resolve(null);
		const notes = (await Promise.all(child.owned.map((c) => this.kill(c.id, { silent: true }).catch(() => [] as string[])))).flat();
		const output = child.session?.getLastAssistantText?.() ?? "";
		try {
			await child.session?.abort();
		} catch {}
		// Whatever the aborted run spent (the partial response is in its session by now) is mirrored before the session goes.
		this.syncUsage(child);
		child.unsubscribe();
		child.session?.dispose();
		// Before the aborted result goes out, so it can say what happened to the agent's changes.
		let info: DisposeInfo | undefined;
		try {
			const r = await this.hooks.dispose?.(child);
			if (r && typeof r === "object") info = r;
		} catch {}
		child.phase = undefined;
		const notify = !opts.silent && (opts.notify === true || (child.ownerId !== PARENT_ID && opts.by !== child.ownerId));
		this.settleInitial(child, "aborted", output, notify, info?.merge ? { merge: info.merge } : undefined);
		this.changed();
		if (info?.note) notes.push(`${child.id}: ${info.note}`);
		return notes;
	}

	/**
	 * Kill every agent (top-level first; each takes its subtree down before itself). Resolves after every
	 * dispose hook ran, with their notes (e.g. worktrees kept because their changes could not be saved).
	 */
	async disposeAll(): Promise<string[]> {
		for (const w of this.parentWaiters.splice(0)) w.resolve(null);
		for (const p of this.pools.values()) p.rejectAll();
		const all = [...this.children.values()];
		const top = await Promise.all(all.filter((c) => c.ownerId === PARENT_ID).map((c) => this.kill(c.id, { silent: true }).catch(() => [])));
		const rest = await Promise.all(all.filter((c) => c.ownerId !== PARENT_ID).map((c) => this.kill(c.id, { silent: true }).catch(() => [])));
		this.children.clear();
		this.changed();
		// A cascade already reported its subtree's notes; the second pass only returns the same promises.
		return [...new Set([...top.flat(), ...rest.flat()])];
	}

	/** The `irc` tool given to each child session (spawners also get read/kill for their own subagents). */
	private childIrcTool(child: Child): ToolDefinition {
		const hub = this;
		const selfId = child.id;
		const nested = child.ownerId !== PARENT_ID;
		const manages = !!child.spawns?.length;
		const recipients = nested
			? '"parent" (the agent that spawned you), "main" (the main agent), a peer id, or "all"'
			: '"parent", a peer id, or "all"';
		const ops = manages ? (["send", "wait", "list", "read", "kill"] as const) : (["send", "wait", "list"] as const);
		return {
			name: "irc",
			label: "IRC",
			description:
				`Message other agents. op "send": deliver \`message\` to \`to\` (${recipients}); never blocks on a reply. ` +
				'op "wait": block until a message arrives (optionally only `from` one agent), up to `timeoutSec` (default 120). ' +
				'op "list": show peers.' +
				(manages
					? ' op "read": full latest output + recent activity of your subagent `id`. op "kill": abort your subagent `id` (and its subagents).'
					: ""),
			parameters: Type.Object({
				op: StringEnum(ops),
				to: Type.Optional(Type.String({ description: `Recipient for send: ${recipients}` })),
				message: Type.Optional(Type.String({ description: "Message body for send" })),
				from: Type.Optional(Type.String({ description: "For wait: only accept messages from this agent" })),
				timeoutSec: Type.Optional(Type.Number({ description: "For wait: timeout in seconds (default 120)" })),
				...(manages ? { id: Type.Optional(Type.String({ description: "read/kill: your subagent's id" })) } : {}),
			}),
			async execute(_id: string, params: any, signal: AbortSignal | undefined) {
				const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, isError });
				if (params.op === "list") return text(hub.roster(selfId));
				if (params.op === "send") {
					try {
						return text(await hub.send(selfId, params.to ?? "", params.message ?? ""));
					} catch (e) {
						return text(e instanceof Error ? e.message : String(e), true);
					}
				}
				if (manages && (params.op === "read" || params.op === "kill")) {
					const target = hub.children.get(params.id ?? "");
					if (!target || !hub.isDescendant(target, selfId)) {
						const mine = descendants(child).map((c) => c.id);
						return text(`"${params.id ?? ""}" is not one of your subagents (yours: ${mine.join(", ") || "none"}).`, true);
					}
					if (params.op === "read") return text(readReport(target));
					const notes = await hub.kill(target.id, { by: selfId });
					return text([`Killed ${target.id}.`, ...notes].join("\n"));
				}
				const from = typeof params.from === "string" && params.from.trim() ? hub.resolveAddress(child, params.from.trim()) : undefined;
				if (hub.hasQueuedSteer(child, from)) {
					return text("A message is already queued for you; it is delivered right after this call.");
				}
				const timeout = Math.max(1, params.timeoutSec ?? 120) * 1000;
				const msg = await hub.waitForChild(selfId, from, timeout, signal);
				return text(msg ? hub.formatIncoming(child, msg, "wait") : "No message arrived before the timeout.");
			},
		} as ToolDefinition;
	}

	/** A spawning child's own `task` tool: same schema/behavior as the main agent's, limited by its spawn policy. */
	private childTaskTool(child: Child, policy: SpawnPolicy): ToolDefinition {
		const hub = this;
		return {
			name: "task",
			label: "Task",
			description: buildTaskDescription(policy.agents, policy.defaultAgent, MAX_TASKS_PER_CALL, {
				forChild: true,
				canNest: child.depth + 1 < MAX_DEPTH,
				structured: !!child.schema,
			}),
			promptSnippet: TASK_PROMPT_SNIPPET,
			promptGuidelines: TASK_PROMPT_GUIDELINES,
			parameters: buildTaskParams(policy.defaultAgent),
			prepareArguments: prepareTaskArguments,
			async execute(_id: string, params: any) {
				if (child.status === "aborted") return { content: [{ type: "text" as const, text: "Aborted." }], details: undefined, isError: true };
				// Re-discover like the main agent's tool does (agent files may have changed); keep the spawn-time policy otherwise.
				const current = hub.spawnPolicy(child) ?? policy;
				const r = await hub.spawnTasks(params ?? {}, child.ctx, { policy: current, cwd: child.cwd, owner: child });
				return { content: [{ type: "text" as const, text: r.text }], details: undefined, isError: r.isError };
			},
		} as ToolDefinition;
	}
}

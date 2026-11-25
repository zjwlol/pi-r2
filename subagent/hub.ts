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
import { moveImagesOutOfToolResults } from "../shared/bedrock-tool-images.ts";
import { type AgentConfig, discoverAgents, resolveSpawnPolicy, type SpawnPolicy } from "./agents.ts";
import { CompletionProbe } from "./completion-probe.ts";
import type { Worktree } from "./isolation.ts";
import { generateTaskName, sanitizeAgentId } from "./names.ts";
import {
	buildTaskDescription,
	buildTaskParams,
	childSystemPrompt,
	childUserPrompt,
	type DoneInfo,
	type DoneStatus,
	escapeEnvelope,
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
import { formatStructuredData, type JsonSchema, YIELD_TOOL_NAME } from "./structured.ts";
import { addUsage, type AttributedUsage, isZeroUsage, recordUsage, sessionUsage, zeroUsage } from "./usage.ts";

export { fmtDuration };
export type { DoneInfo };

export const PARENT_ID = "parent";
export const MAIN_ALIAS = "main";
export const USER_ID = "user";
const RESERVED_IDS = new Set([PARENT_ID, MAIN_ALIAS, USER_ID, "all"]);

function envInt(name: string): number | undefined {
	const n = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const MAX_RUNNING = envInt("PI_SUBAGENT_MAX_RUNNING") ?? 16;
export const MAX_DEPTH = 2;
export const READ_CAP = 100 * 1024;

export const SOFT_REQUEST_BUDGET: Record<string, number> = { scout: 100, sonic: 100, default: 200 };
export const BUDGET_STOP_GRACE_REQUESTS = 5;

function configuredRequestBudget(): number {
	const raw = process.env.PI_SUBAGENT_REQUEST_BUDGET;
	if (raw === undefined || raw.trim() === "") return SOFT_REQUEST_BUDGET.default!;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : SOFT_REQUEST_BUDGET.default!;
}
const CONFIGURED_REQUEST_BUDGET = configuredRequestBudget();
const COMPLETION_PROBE_ENABLED = process.env.PI_SUBAGENT_COMPLETION_PROBE !== "0";

export function resolveSoftRequestBudget(agentName: string, configured: number = CONFIGURED_REQUEST_BUDGET): number {
	const normalized = Math.max(0, Math.trunc(configured));
	if (normalized === 0) return 0;
	return Math.min(normalized, SOFT_REQUEST_BUDGET[agentName] ?? normalized);
}

export function budgetStopThreshold(budget: number): number {
	return Math.ceil(budget * 1.5);
}

export function buildBudgetNotice(requests: number, budget: number): string {
	return `[budget notice] You have used ${requests} requests in this run (soft budget: ${budget}). Wrap up now: finish the current step and deliver your final report. At ${budgetStopThreshold(budget)} requests the run is force-stopped and you will be asked to report whatever you have.`;
}

export function buildBudgetStopPrompt(structured: boolean): string {
	return structured
		? `<system-reminder>
Request budget crossed; in-flight turn stopped → forced wrap-up. MUST call \`yield\` NOW with best final report from completed work.

- Consolidate all gathered value; mark remaining gaps incomplete, do not investigate further.
- Do NOT call another tool or resume assignment.
</system-reminder>`
		: `<system-reminder>
Request budget crossed; in-flight turn stopped → forced wrap-up. Do NOT call another tool or resume assignment. Reply NOW with best final report from completed work; this message is your result.

- Consolidate all gathered value; mark remaining gaps incomplete, do not investigate further.
</system-reminder>`;
}

export interface RunBudget {
	limit: number;
	requests: number;
	noticeText?: string;
	stop?: "requested" | "forced" | "hard";
	aborting?: Promise<void>;
}

export const RESULT_MESSAGE_TYPE = "task-result";
export const IRC_MESSAGE_TYPE = "irc";

export type ChildStatus = "pending" | "running" | "idle" | "failed" | "aborted";

export type MessageKind = "irc" | "result" | "notice";

function expectsReply(m: IrcMessage): boolean {
	if (m.kind !== undefined && m.kind !== "irc") return false;
	return !m.relay && !(m.broadcast && m.from !== USER_ID);
}

export interface IrcMessage {
	kind?: MessageKind;
	from: string;
	to: string;
	body: string;
	ts: number;
	done?: DoneInfo;
	relay?: boolean;
	broadcast?: boolean;
}

export type ParentEvent = { kind: "message"; msg: IrcMessage } | { kind: "done"; done: DoneInfo };

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	requests: number;
	toolCount: number;
	contextTokens: number;
}

export function nestedCost(c: Child): number {
	let sum = 0;
	for (const o of c.owned) sum += o.usage.cost + nestedCost(o);
	return sum;
}

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
	ownerId: string;
	depth: number;
	owned: Child[];
	spawns?: string[];
	item?: Record<string, unknown>;
	isolated?: boolean;
	schema?: JsonSchema;
	worktree?: Worktree;
	phase?: string;
	killing?: Promise<string[]>;
	/**
	 * The owner must not settle before the finalizing child's initial result is ready.
	 */
	finalizing?: boolean;
	ctx: ExtensionContext;
	projectTrusted: boolean;
	model: Model<any> | undefined;
	modelLabel: string;
	contextWindow?: number;
	thinking: ThinkingLevel;
	session?: AgentSession;
	probe?: CompletionProbe;
	pendingProbeUsage?: Promise<void>;
	status: ChildStatus;
	createdAt: number;
	startedAt?: number;
	runStartedAt?: number;
	finishedAt?: number;
	usage: Usage;
	usageCursor: number;
	usageSyncPending?: boolean;
	runningTools: Map<string, ToolActivity>;
	lastTool?: ToolActivity;
	lastText?: string;
	activity: string[];
	error?: string;
	initialSettled: boolean;
	done?: DoneInfo;
	inbox: IrcMessage[];
	held: IrcMessage[];
	batchTerminates?: boolean;
	wakeSender?: string;
	sentDuringRun: Set<string>;
	/**
	 * pi's session does not list steering queued directly on its agent.
	 */
	steered: Array<{ msg: IrcMessage; text: string; direct?: boolean }>;
	steersInFlight: Set<Promise<void>>;
	budget: RunBudget;
	queued: boolean;
	hasPermit: boolean;
	blocked: boolean;
	unblock?: () => void;
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
	owner?: Child;
	item?: Record<string, unknown>;
	isolated?: boolean;
	schema?: JsonSchema;
}

export interface TaskCallOutcome {
	children: Child[];
	failures: string[];
	text: string;
	isError: boolean;
}

export interface SettleInfo {
	initial: boolean;
	status: DoneStatus;
	output: string;
}

export interface ChildHooks {
	validate?(spec: SpawnSpec): Promise<string | void> | string | void;
	prepare?(child: Child): Promise<void> | void;
	tools?(child: Child): ToolDefinition[];
	beforeSettle?(child: Child, run: SettleInfo): Promise<SettleOverride | void> | SettleOverride | void;
	resume?(child: Child): void;
	dispose?(child: Child): Promise<DisposeInfo | void> | DisposeInfo | void;
}

export interface SettleOverride {
	status?: DoneStatus;
	output?: string;
	error?: string;
	data?: unknown;
	merge?: MergeInfo;
	retry?: string;
	notice?: string;
	noticeTo?: string;
	replyNote?: string;
}

export interface DisposeInfo {
	merge?: MergeInfo;
	note?: string;
}

type DoneExtra = Pick<DoneInfo, "data" | "merge">;

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

function unescapeEnvelope(text: string): string {
	return text.replace(/&lt;(\/?)(task-result|output|preview|error|irc|data|merge-summary)\b/g, "<$1$2");
}

const howToReply = (from: string) => `reply with irc send (to: "${from}")`;
const steeringHeader = (from: string) =>
	`[Message received while you were working. Read it and adjust your plan accordingly before continuing. If a response is expected, ${howToReply(from)}; no one replies on your behalf.]`;
const peerHeader = (from: string) =>
	`[Message from peer \`${from}\` received while you were working. If a response is expected, ${howToReply(from)}; you may finish your current step first. No one replies on your behalf.]`;
const wakeFooter = (from: string, structured: boolean) =>
	`Reply with irc send (to: "${from}"), or just answer: your final reply this turn is delivered to \`${from}\` automatically${structured ? " (if you call `yield` this turn, its data is delivered instead)" : ""} unless you already messaged \`${from}\` this turn.`;
const relayFooter = (from: string) => `This is \`${from}\`'s reply; nothing is sent back automatically — use irc send if you need to answer.`;
const broadcastFooter = (from: string) =>
	`This is a broadcast from \`${from}\` to every agent; nothing is sent back automatically. Only if it needs an answer from you, ${howToReply(from)}.`;

function frameIncoming(msg: IrcMessage, from: string, mode: "steer" | "wake" | "wait" | "continue", structured = false): string {
	if (msg.kind === "result") {
		return mode === "steer" ? `[Subagent \`${from}\` settled while you were working.]\n${msg.body}` : msg.body;
	}
	if (msg.kind === "notice") return `[Notice from \`${from}\`.]\n${escapeEnvelope(msg.body)}`;
	const block = `<irc from="${from}">\n${escapeEnvelope(msg.body)}\n</irc>`;
	if (mode === "wait") return block;
	if (msg.relay) return `${block}\n\n${relayFooter(from)}`;
	if (msg.broadcast && !expectsReply(msg)) return `${block}\n\n${broadcastFooter(from)}`;
	if (mode === "wake") return `${block}\n\n${wakeFooter(from, structured)}`;
	const steering = from === PARENT_ID || from === MAIN_ALIAS || from === USER_ID;
	return `${steering ? steeringHeader(from) : peerHeader(from)}\n${block}`;
}

export function parseIrcFrames(text: string): { from: string; body: string }[] | undefined {
	const frames: { from: string; body: string }[] = [];
	const close = "\n</irc>";
	let rest = text;
	while (true) {
		const open = /^(?:\[Message [^\n]*\]\n)?<irc from="([^"\n]*)">\n/.exec(rest);
		if (!open) return undefined;
		const from = open[1]!;
		const end = rest.indexOf(close, open[0].length);
		if (end < 0) return undefined;
		frames.push({ from, body: unescapeEnvelope(rest.slice(open[0].length, end)) });
		rest = rest.slice(end + close.length);
		for (const footer of [wakeFooter(from, false), wakeFooter(from, true), relayFooter(from), broadcastFooter(from)]) {
			if (!rest.startsWith(`\n\n${footer}`)) continue;
			rest = rest.slice(footer.length + 2);
			break;
		}
		if (!rest) return frames;
		if (!rest.startsWith("\n\n")) return undefined;
		rest = rest.slice(2);
	}
}

export function formatParentEvent(ev: ParentEvent): string {
	if (ev.kind === "message" && ev.msg.kind === "notice") return `[Notice from \`${ev.msg.from}\`.]\n${escapeEnvelope(ev.msg.body)}`;
	if (ev.kind === "message") {
		return `<irc from="${ev.msg.from}">\n${escapeEnvelope(ev.msg.body)}\n</irc>\nReply with the irc tool (op: "send", to: "${ev.msg.from}") if a response is needed.`;
	}
	return formatTaskResult(ev.done);
}

export function isActive(c: Child | undefined): boolean {
	return !!c && (c.status === "running" || c.status === "pending" || (!!c.finalizing && !c.initialSettled));
}

export function activeDescendants(c: Child, out: Child[] = []): Child[] {
	for (const o of c.owned) {
		if (isActive(o)) out.push(o);
		activeDescendants(o, out);
	}
	return out;
}

export function subtreeActive(c: Child | undefined): boolean {
	return !!c && (isActive(c) || activeDescendants(c).length > 0);
}

export function owedSubagents(owner: Child): Child[] {
	return activeDescendants(owner).filter((c) => !c.initialSettled || c.wakeSender === owner.id);
}

export function descendants(c: Child, out: Child[] = []): Child[] {
	for (const o of c.owned) {
		out.push(o);
		descendants(o, out);
	}
	return out;
}

function fmtCount(n: number): string {
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function contextPart(c: Child): string {
	const tokens = c.usage.contextTokens;
	if (!(tokens > 0)) return "";
	return c.contextWindow ? `ctx ${fmtCount(tokens)}/${fmtCount(c.contextWindow)}` : `ctx ${fmtCount(tokens)}`;
}

export function completionPercent(c: Child): number | undefined {
	return c.status === "running" ? c.probe?.percent : undefined;
}

function completionLabel(c: Child): string {
	const percent = completionPercent(c);
	if (percent === undefined) return "";
	const stage = c.probe?.stage;

	return stage ? `~${percent}% · stage: ${stage}` : `~${percent}%`;
}

export function describeChild(c: Child): string {
	const end = c.status === "running" ? Date.now() : (c.finishedAt ?? Date.now());
	const elapsed = c.runStartedAt ? fmtDuration(end - c.runStartedAt) : "";
	const u = c.usage;
	const nested = nestedCost(c);
	const stats = [
		completionLabel(c),
		u.toolCount ? `${u.toolCount} tools` : "",
		u.requests ? `${u.requests} req` : "",
		u.cost || nested ? `$${u.cost.toFixed(2)}${nested ? ` (+${nested.toFixed(2)})` : ""}` : "",
		contextPart(c),
		elapsed,
		c.modelLabel,
	].filter(Boolean);
	const waiting = c.blocked ? activeDescendants(c).length : 0;
	const state = c.status === "pending" ? "queued" : c.blocked ? `waiting for ${waiting} subagent${waiting === 1 ? "" : "s"}` : c.status;
	const tags = [c.isolated ? "[isolated]" : "", c.schema ? "{}" : ""].filter(Boolean).join(" ");
	return `${c.id} ⟨${c.agent.name}⟩${tags ? ` ${tags}` : ""} ${state} — ${stats.join(" · ")}`;
}

export function describeTree(list: Child[]): string[] {
	return list.map((c) => `${c.depth > 1 ? `${"  ".repeat(c.depth - 1)}↳ ` : ""}${describeChild(c)}`);
}

export function describeProgress(c: Child, now = Date.now()): string {
	const u = c.usage;
	const parts = [
		c.status === "pending" ? "queued" : c.runStartedAt ? fmtDuration(now - c.runStartedAt) : "",
		completionLabel(c),
		u.requests ? `${u.requests} req` : "",
		u.cost > 0 ? (u.cost < 0.005 ? "<$0.01" : `$${u.cost.toFixed(2)}`) : "",
		contextPart(c),
	].filter(Boolean);
	return `- \`${c.id}\` ⟨${c.agent.name}⟩${parts.length ? ` — ${parts.join(" · ")}` : ""}`;
}

export function latestOutput(c: Child, cap = READ_CAP): string {
	if (c.done?.data !== undefined && c.status !== "running") return formatStructuredData(c.done.data, cap);
	return c.session?.getLastAssistantText?.() ?? c.done?.output ?? "";
}

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
	readonly instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	readonly children = new Map<string, Child>();
	hooks: ChildHooks = {};
	private childWaiters = new Map<string, ChildWaiter[]>();
	private parentWaiters: ParentWaiter[] = [];
	private parentBacklog: Array<{ ev: ParentEvent; hits: number }> = [];
	private spawnsInFlight = new Map<string, Set<Promise<void>>>();
	private changeListeners = new Set<() => void>();
	/**
	 * A shared permit pool can deadlock owners waiting for queued subagents.
	 */
	private pools = new Map<number, Semaphore>();
	private lifecycleShown = new Set<string>();

	constructor(private readonly pi: ExtensionAPI) {}

	onChange(fn: () => void): () => void {
		this.changeListeners.add(fn);
		return () => this.changeListeners.delete(fn);
	}

	touch(): void {
		this.changed();
	}

	private changed(): void {
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

	resolveAddress(sender: Child | undefined, to: string): string {
		if (to === MAIN_ALIAS) return PARENT_ID;
		if (to === PARENT_ID && sender) return sender.ownerId;
		return to;
	}

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

	private findExactModel(
		want: string,
		reg: ExtensionContext["modelRegistry"],
		fallback: Model<any> | undefined,
	): { model?: Model<any>; reason?: string } {
		const slash = want.indexOf("/");
		const provider = slash > 0 ? want.slice(0, slash) : "";
		let found: Model<any> | undefined;
		if (provider && reg.getAll().some((m) => m.provider === provider)) {
			found = reg.find(provider, want.slice(slash + 1));
		} else {
			const exact = reg.getAvailable().filter((m) => m.id === want);
			found = exact.find((m) => m.provider === fallback?.provider) ?? exact[0];
		}
		if (found && !reg.hasConfiguredAuth(found)) return { reason: `no credentials for provider "${found.provider}"` };
		return { model: found };
	}

	private nearModels(want: string, reg: ExtensionContext["modelRegistry"], fallback: Model<any> | undefined): string[] {
		const needles = new Set<string>();
		const colon = want.lastIndexOf(":");
		for (const text of colon > 0 ? [want, want.slice(0, colon)] : [want]) {
			const t = text.trim().toLowerCase();
			const slash = t.indexOf("/");
			for (const n of slash > 0 ? [t, t.slice(slash + 1)] : [t]) if (n) needles.add(n);
		}
		const slash = want.indexOf("/");
		const provider = slash > 0 ? want.slice(0, slash) : undefined;
		const rank = (m: Model<any>) => (m.provider === provider ? 0 : m.provider === fallback?.provider ? 1 : 2);
		return reg
			.getAvailable()
			.filter((m) => {
				const selector = `${m.provider}/${m.id}`.toLowerCase();
				return [...needles].some((n) => selector.includes(n));
			})
			.sort((a, b) => rank(a) - rank(b))
			.slice(0, 3)
			.map((m) => `${m.provider}/${m.id}`);
	}

	private resolveModel(
		spec: SpawnSpec,
		ctx: ExtensionContext,
		fallback: Model<any> | undefined,
	): { model: Model<any> | undefined; warning?: string; thinking?: string } {
		const reg = ctx.modelRegistry;
		const requested = spec.model?.trim();
		if (requested) {
			let res = this.findExactModel(requested, reg, fallback);
			let thinking: string | undefined;
			if (!res.model) {
				const colon = requested.lastIndexOf(":");
				const level = colon > 0 ? requested.slice(colon + 1).trim().toLowerCase() : "";
				const base = colon > 0 ? requested.slice(0, colon).trim() : "";
				if (base && THINKING_LEVELS.includes(level)) {
					res = this.findExactModel(base, reg, fallback);
					thinking = level;
				}
			}
			if (!res.model) {
				const near = this.nearModels(requested, reg, fallback);
				throw new Error(
					`model "${requested}" is not available${res.reason ? ` (${res.reason})` : ""}${near.length ? `; near matches: ${near.join(", ")}` : ""}. ` +
						"Use the exact provider/model-id[:level]; if that model is unavailable, report it instead of substituting another or dropping `model`",
				);
			}
			return { model: res.model, thinking };
		}
		const want = spec.agent.model;
		if (!want) return { model: fallback };
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

	queuedAt(depth: number): Set<string> {
		const claimants = [...this.children.values()].filter(
			(c) => c.depth === depth && (c.status === "running" || c.status === "pending") && !c.blocked,
		);
		return new Set(claimants.slice(MAX_RUNNING).map((c) => c.id));
	}

	spawn(spec: SpawnSpec, ctx: ExtensionContext): { child: Child; warning?: string } {
		const owner = spec.owner;
		if (owner && owner.depth >= MAX_DEPTH) throw new Error(`nesting limit reached (max depth ${MAX_DEPTH})`);
		if (owner?.status === "aborted") throw new Error(`${owner.id} was aborted`);
		const { model, warning: modelWarning, thinking: modelThinking } = this.resolveModel(spec, ctx, owner ? owner.model : ctx.model);
		if (!model) throw new Error("No model available for subagent.");
		const id = this.uniqueId(spec.name);
		const level = (v?: string) => {
			const l = v?.trim().toLowerCase();
			return l && THINKING_LEVELS.includes(l) ? l : undefined;
		};
		const thinking = (level(spec.thinking) ??
			modelThinking ??
			level(spec.agent.thinking) ??
			owner?.thinking ??
			this.pi.getThinkingLevel()) as ThinkingLevel;
		const badThinking = level(spec.thinking) ? "" : (spec.thinking?.trim() ?? "");
		const thinkingWarning = badThinking
			? `thinking "${badThinking}" is not a level (${THINKING_LEVELS.join("|")}); using ${thinking}`
			: undefined;
		const warning = [modelWarning, thinkingWarning].filter(Boolean).join("; ") || undefined;
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
			held: [],
			sentDuringRun: new Set(),
			steered: [],
			steersInFlight: new Set(),
			budget: { limit: 0, requests: 0 },
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

	spawnTasks(
		params: { context?: string; tasks?: Array<Record<string, any>> },
		ctx: ExtensionContext,
		opts: { policy: SpawnPolicy; cwd: string; owner?: Child },
	): Promise<TaskCallOutcome> {
		const spawner = opts.owner?.id ?? PARENT_ID;
		const call = this.spawnTasksNow(params, ctx, opts);
		const settled = call.then(
			() => {},
			() => {},
		);
		const calls = this.spawnsInFlight.get(spawner) ?? new Set<Promise<void>>();
		this.spawnsInFlight.set(spawner, calls);
		calls.add(settled);
		void settled.then(() => {
			calls.delete(settled);
			if (calls.size === 0 && this.spawnsInFlight.get(spawner) === calls) this.spawnsInFlight.delete(spawner);
		});
		return call;
	}

	async spawnsSettled(spawner: string): Promise<void> {
		const calls = this.spawnsInFlight.get(spawner);
		if (calls?.size) await Promise.all([...calls]);
	}

	private async spawnTasksNow(
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
		const spawnerId = owner?.id ?? PARENT_ID;
		const lifecycle = children.length > 0 && !this.lifecycleShown.has(spawnerId);
		if (lifecycle) this.lifecycleShown.add(spawnerId);
		return { children, failures, text: formatSpawnFeedback(spawned, failures, { lifecycle }), isError: children.length === 0 };
	}

	private spawnPolicy(child: Child): SpawnPolicy | undefined {
		if (child.depth >= MAX_DEPTH) return undefined;
		return resolveSpawnPolicy(child.agent, discoverAgents(child.cwd, child.projectTrusted));
	}

	private childTools(child: Child, policy: SpawnPolicy | undefined): ToolDefinition[] {
		const tools = [this.childIrcTool(child)];
		if (policy) tools.push(this.childTaskTool(child, policy));
		tools.push(...(this.hooks.tools?.(child) ?? []));
		return tools;
	}

	private toolAllowlist(child: Child, customTools: ToolDefinition[]): string[] | undefined {
		if (!child.agent.tools) return undefined;
		return [...new Set([...child.agent.tools.filter((t) => t !== "task"), ...customTools.map((t) => t.name)])];
	}

	private async start(child: Child): Promise<void> {
		// The whole batch must register before any child builds its peer roster.
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
			const settingsManager = SettingsManager.inMemory(structuredClone(this.pi.getSettings()));
			const resourceLoader = new DefaultResourceLoader({
				cwd: child.cwd,
				agentDir,
				settingsManager,
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

			// The parent runtime carries extension providers and cached credentials.
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
			// pi's default payload hook only dispatches extension handlers.
			session.agent.onPayload = moveImagesOutOfToolResults;
			child.session = session;
			child.unsubscribe = session.subscribe((ev) => this.onChildEvent(child, ev));
		} catch (e) {
			if ((child.status as ChildStatus) === "aborted") return;
			child.finalizing = true;
			child.error = e instanceof Error ? e.message : String(e);
			child.status = "failed";
			child.finishedAt = Date.now();
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
			// pi stops when every top-level tool result requests termination.
			if (!ev.parentToolCallId) {
				const terminates = (ev.result as { terminate?: boolean } | undefined)?.terminate === true;
				child.batchTerminates = child.batchTerminates !== false && terminates;
				if (terminates && ev.toolName === YIELD_TOOL_NAME && child.probe) child.probe.submitted = true;
			}
			if (ev.isError) this.pushActivity(child, `✗ ${ev.toolName} failed`);
			this.changed();
		} else if (ev.type === "turn_end") {
			// pi polls for steering immediately after this event.
			const work = ev.toolResults.length > 0 && child.batchTerminates !== true;
			child.batchTerminates = undefined;
			if (work) this.flushHeld(child);
		} else if (ev.type === "message_start" && (ev.message as any).role === "user") {
			if (child.steered.some((s) => s.direct)) {
				const content = (ev.message as any).content;
				const text =
					typeof content === "string"
						? content
						: (Array.isArray(content) ? content : [])
								.filter((p: any) => p?.type === "text")
								.map((p: any) => p.text)
								.join("");
				child.steered = child.steered.filter((s) => !(s.direct && s.text === text));
			}
		} else if (ev.type === "message_end" && (ev.message as any).role === "assistant") {
			if (child.probe) child.probe.submitted = false;
			const msg = ev.message as any;
			child.usage.requests++;
			const calls = (msg.content ?? []).filter((p: any) => p.type === "toolCall");
			this.checkBudget(child, msg.stopReason !== "error" && msg.stopReason !== "aborted" && calls.some((c: any) => c.name !== YIELD_TOOL_NAME));
			const u = msg.usage;
			// Failed or aborted responses can report partial usage.
			if (u && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
				const total = u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
				if (total > 0) child.usage.contextTokens = total;
			}
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
			case "message_end":
			case "turn_end":
			case "agent_end":
			case "agent_settled":
			case "compaction_end":
			case "entry_appended":
				this.scheduleUsageSync(child);
		}
	}

	/**
	 * pi appends the session entry after emitting `message_end`.
	 */
	private scheduleUsageSync(child: Child): void {
		if (child.usageSyncPending) return;
		child.usageSyncPending = true;
		queueMicrotask(() => {
			child.usageSyncPending = false;
			this.syncUsage(child);
		});
	}

	syncUsage(child: Child): void {
		const sm = child.session?.sessionManager;
		if (!sm) return;
		const entries = sm.getEntries();
		if (entries.length <= child.usageCursor) return;
		const batch = sessionUsage(entries, child.usageCursor, { provider: child.model?.provider ?? "unknown", model: child.model?.id ?? "unknown" });
		child.usageCursor = entries.length;
		if (batch.length === 0) return;
		for (const spend of batch) this.recordSpend(child, spend);
		this.changed();
	}

	private recordSpend(child: Child, spend: AttributedUsage): void {
		const { usage } = spend;
		child.usage.input += usage.input;
		child.usage.output += usage.output;
		child.usage.cacheRead += usage.cacheRead;
		child.usage.cacheWrite += usage.cacheWrite;
		child.usage.cost += usage.cost.total;
		try {
			recordUsage(child.ctx.sessionManager, spend, child.id);
		} catch {
			// The parent may have switched sessions while the child was running.
		}
	}

	private startCompletionProbe(child: Child, session: AgentSession, ownerRun: boolean): void {
		if (COMPLETION_PROBE_ENABLED && ownerRun && child.depth === 1 && child.ctx.mode === "tui") {
			child.probe = new CompletionProbe({
				session,
				onUsage: ({ provider, responseModel, model, usage }) => {
					const spend = addUsage(zeroUsage(), usage);
					if (isZeroUsage(spend)) return;
					this.recordSpend(child, { provider, model: responseModel ?? model, usage: spend });
					this.changed();
				},
				onChange: () => this.changed(),
				onError: (reason) => {
					this.pushActivity(child, `Completion estimate: ${reason}`);
					this.changed();
				},
			});
		}
	}

	private stopCompletionProbe(child: Child): Promise<void> | undefined {
		const pending = child.probe?.stop();
		child.probe = undefined;
		if (pending) child.pendingProbeUsage = pending;

		return child.pendingProbeUsage;
	}

	private checkBudget(child: Child, continues: boolean): void {
		const b = child.budget;
		b.requests++;
		const session = child.session;
		// A notice queued after the final response would start another turn.
		if (!continues || b.limit <= 0 || !session || child.status !== "running" || b.stop === "requested" || b.stop === "hard") return;
		const stopAt = budgetStopThreshold(b.limit);
		const stop = (): Promise<void> => session.abort().catch(() => {});
		if (b.stop === "forced") {
			if (b.requests < stopAt + BUDGET_STOP_GRACE_REQUESTS) return;
			b.stop = "hard";
			b.aborting = stop();
			this.pushActivity(child, `✗ request budget: no report ${BUDGET_STOP_GRACE_REQUESTS} requests after the stop, aborted`);
			this.changed();
			return;
		}
		if (b.requests >= stopAt) {
			b.stop = "requested";
			b.aborting = stop();
			this.pushActivity(child, `⚠ request budget: stopped at ${b.requests} requests (budget ${b.limit}), asked for its report`);
			this.changed();
			return;
		}
		if (b.noticeText !== undefined || b.requests < b.limit) return;
		const notice = buildBudgetNotice(b.requests, b.limit);
		b.noticeText = notice;
		this.pushActivity(child, `⚠ request budget: ${b.requests} requests (budget ${b.limit}), asked to wrap up`);
		// A synchronous steer failure must not break event handling.
		const landed = Promise.resolve()
			.then(() => (session.isStreaming ? session.steer(notice) : undefined))
			.then(
				() => {},
				() => {},
			);
		child.steersInFlight.add(landed);
		void landed.then(() => child.steersInFlight.delete(landed));
	}

	private budgetError(child: Child, hard: boolean): string {
		const b = child.budget;
		return `Soft request budget exceeded (${b.requests} requests; budget ${b.limit})${hard ? " — agent did not report when force-stopped" : ""}`;
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
		this.syncUsage(child);
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

	private subagentNote(owner: Child): string {
		if (owner.owned.length === 0) return "";
		const active = owedSubagents(owner);
		if (active.length === 0) return "All your subagents have settled.";
		const n = active.length;
		return `${n} subagent${n === 1 ? "" : "s"} still running (${active.map((c) => c.id).join(", ")}); ${n === 1 ? "its result is" : "their results are"} delivered as they finish.`;
	}

	formatIncoming(recipient: Child, msg: IrcMessage, mode: "steer" | "wake" | "wait" | "continue"): string {
		const text = frameIncoming(msg, this.displayId(recipient, msg.from), mode, !!recipient.schema);
		if (msg.kind !== "result") return text;
		const note = this.subagentNote(recipient);
		return note ? `${text}\n\n${note}` : text;
	}

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
			// Killing a queued child rejects its permit wait.
			return false;
		} finally {
			child.queued = false;
		}
	}

	private releasePermit(child: Child): void {
		if (!child.hasPermit) return;
		child.hasPermit = false;
		this.pool(child.depth).release();
	}

	private async awaitSubagents(child: Child): Promise<IrcMessage[]> {
		child.blocked = true;
		this.releasePermit(child);
		await new Promise<void>((resolve) => {
			child.unblock = () => {
				if (child.inbox.some((m) => m.kind !== "notice") || child.status === "aborted" || owedSubagents(child).length === 0) {
					child.unblock = undefined;
					resolve();
				}
			};
			this.changed();
		});
		child.blocked = false;
		if ((child.status as ChildStatus) === "aborted") return [];
		if (!(await this.acquirePermit(child))) return [];
		return child.inbox.splice(0);
	}

	private async runLoop(child: Child, firstText: string, purpose: Purpose): Promise<void> {
		child.status = "pending";
		child.finishedAt = undefined;
		// Record the waker before acquiring a permit in case the child is killed while queued.
		child.wakeSender = purpose.kind === "reply" ? purpose.to : undefined;
		if (!(await this.acquirePermit(child))) return;
		try {
			if ((child.status as ChildStatus) === "aborted" || !child.session) return;
			const session = child.session;
			child.status = "running";
			child.runStartedAt = Date.now();
			child.startedAt ??= child.runStartedAt;
			child.error = undefined;
			this.startCompletionProbe(child, session, purpose.kind === "initial" || (purpose.kind === "reply" && purpose.to === child.ownerId));
			this.changed();

			let text = firstText;
			let current = purpose;
			child.sentDuringRun.clear();
			child.budget = { limit: resolveSoftRequestBudget(child.agent.name), requests: 0 };
			let carried: IrcMessage[] = [];
			let carriedLeftovers: string[] = [];
			while (true) {
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
				// The budget abort may outlive the prompt.
				if (child.budget.aborting) {
					await child.budget.aborting;
					child.budget.aborting = undefined;
					if ((child.status as ChildStatus) === "aborted") return;
				}
				// A late steer can reach pi after the prompt returns.
				if (child.steersInFlight.size > 0) {
					await Promise.all([...child.steersInFlight]);
					if ((child.status as ChildStatus) === "aborted") return;
				}

				let leftovers: string[] = [];
				try {
					const q = session.clearQueue();
					leftovers = [...q.steering, ...q.followUp];
				} catch {}
				const unsent = child.steered.filter((s) => s.direct || leftovers.includes(s.text)).map((s) => s.msg);
				leftovers = leftovers.filter((t) => !child.steered.some((s) => s.text === t) && t !== child.budget.noticeText);
				child.steered = [];
				child.batchTerminates = undefined;
				let queued = [...carried, ...unsent, ...child.held.splice(0), ...child.inbox.splice(0)];
				leftovers = [...carriedLeftovers, ...leftovers];
				carried = [];
				carriedLeftovers = [];
				child.runningTools.clear();

				// Messages arriving during the budget stop must not join the forced report.
				if (child.budget.stop === "requested") {
					child.budget.stop = "forced";
					carried = queued;
					carriedLeftovers = leftovers;
					text = buildBudgetStopPrompt(child.schema !== undefined);
					continue;
				}
				const budgetStopped = child.budget.stop !== undefined;
				if (child.budget.stop === "hard") thrown = this.budgetError(child, true);

				const output = session.getLastAssistantText() ?? "";
				const error = thrown ?? this.lastAssistantError(child);
				child.error = error;

				if (!budgetStopped && (queued.some((m) => m.kind === "result") || owedSubagents(child).length > 0)) {
					let resume = true;
					if (leftovers.length === 0 && queued.every((m) => this.holdsAtStop(child, m))) {
						const arrived = await this.awaitSubagents(child);
						if ((child.status as ChildStatus) === "aborted") return;
						queued = [...queued, ...arrived];
						resume = arrived.some((m) => m.kind !== "notice");
					}
					if (resume) {
						text = this.continuation(child, leftovers, queued);
						this.hooks.resume?.(child);
						if (child.probe) child.probe.submitted = false;
						continue;
					}
				}

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
				this.stopCompletionProbe(child);
				this.settleRun(child, current, status, finalOutput, child.error, extra, notice);

				if (leftovers.length === 0 && queued.every((m) => m.kind === "notice")) {
					child.inbox.unshift(...queued);
					break;
				}
				const firstIrc = queued.find(expectsReply);
				text = [
					...leftovers,
					...queued.map((m) => this.formatIncoming(child, m, firstIrc && expectsReply(m) && m.from === firstIrc.from ? "wake" : "continue")),
				].join("\n\n");
				current = firstIrc ? { kind: "reply", to: firstIrc.from } : { kind: "none" };
				this.startCompletionProbe(child, session, queued.some((m) => m.from === child.ownerId && expectsReply(m)));
				child.sentDuringRun.clear();
				child.budget = { limit: child.budget.limit, requests: 0 };
			}
			child.status = child.error ? "failed" : "idle";
			child.finishedAt = Date.now();
			this.changed();
		} finally {
			this.stopCompletionProbe(child);
			this.releasePermit(child);
		}
	}

	private settleRun(
		child: Child,
		purpose: Purpose,
		status: DoneStatus,
		output: string,
		error: string | undefined,
		extra?: DoneExtra,
		notice?: { body?: string; to?: string; replyNote?: string },
	): void {
		child.wakeSender = undefined;
		if (purpose.kind === "initial") {
			child.finishedAt = Date.now();
			this.settleInitial(child, status, output, true, extra);
			return;
		}
		child.done = this.makeDone(child, status, output, extra);
		const messaged = purpose.kind === "reply" && child.sentDuringRun.has(purpose.to);
		const relayTo = purpose.kind === "reply" && (!messaged || error) ? purpose.to : undefined;
		const noticeTo = notice?.to ?? child.ownerId;
		if (relayTo) {
			const reply = error
				? [
						`(failed: ${error})`,
						output,
						messaged ? `(\`${child.id}\` messaged you earlier in this turn, but that was not its answer; nothing further was sent.)` : "",
					]
						.filter(Boolean)
						.join("\n\n")
				: output || "(no reply)";
			const extra = relayTo === noticeTo ? (notice?.body ?? notice?.replyNote) : (notice?.replyNote ?? notice?.body);
			void this.deliver(child.id, relayTo, extra ? `${reply}\n\n${extra}` : reply, { relay: true }).catch(() => {});
		}
		if (notice?.body && relayTo !== noticeTo) this.sendNotice(child, notice.body, noticeTo);
	}

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

	async send(from: string, to: string, body: string): Promise<string> {
		to = to.trim();
		if (!to) throw new Error("A recipient is required.");
		if (!body.trim()) throw new Error("A non-empty message is required.");
		return this.deliver(from, this.resolveAddress(this.children.get(from), to), body);
	}

	private async deliver(from: string, to: string, body: string, flags: { relay?: boolean; broadcast?: boolean } = {}): Promise<string> {
		if (to === from) throw new Error("Cannot send a message to yourself.");
		const sender = this.children.get(from);

		if (to === "all") {
			if (sender) throw new Error('Only the main agent can broadcast. Message the one agent that can answer (irc send, to: "<id>").');
			const targets = this.broadcastTargets(from);
			const receipts = await Promise.all(
				targets.map((t) =>
					this.deliver(from, t, body, { broadcast: true }).then(
						(r) => `- ${t}: ${r}`,
						(e) => `- ${t}: failed — ${e.message}`,
					),
				),
			);
			if (targets.length === 0) return "No agents to broadcast to.";
			const quiet = from === USER_ID ? "" : "; a broadcast draws no automatic replies";
			return `Broadcast to ${targets.length} agent(s)${quiet}:\n${receipts.join("\n")}`;
		}

		if (sender) sender.sentDuringRun.add(to);
		const msg: IrcMessage = { kind: "irc", from, to, body, ts: Date.now() };
		if (flags.relay) msg.relay = true;
		if (flags.broadcast) msg.broadcast = true;
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

	private broadcastTargets(from: string): string[] {
		return [...this.children.values()].filter((c) => c.id !== from && c.status !== "aborted").map((c) => c.id);
	}

	/**
	 * pi can extend a run past its final response when steering is queued.
	 */
	private holdsAtStop(child: Child, msg: IrcMessage): boolean {
		if (msg.kind === "result") return false;
		if (msg.kind === "notice" || msg.broadcast) return true;
		if (msg.from === child.ownerId || msg.from === PARENT_ID || msg.from === USER_ID) return false;
		const sender = this.children.get(msg.from);
		return !(sender && this.isDescendant(sender, child.id));
	}

	/**
	 * Session steering may enqueue the message after pi polls the queue.
	 */
	private flushHeld(child: Child): void {
		const session = child.session;
		if (!session || child.held.length === 0 || child.status !== "running") return;
		try {
			const agent = session.agent;
			if (session.steeringMode !== "all" && agent.hasQueuedMessages()) return;
			const msgs = child.held.splice(0);
			const text = msgs.map((m) => this.formatIncoming(child, m, "steer")).join("\n\n");
			for (const msg of msgs) child.steered.push({ msg, text, direct: true });
			agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		} catch {
			// The tracked messages are recovered after the prompt if enqueueing fails.
		}
	}

	private async route(child: Child, msg: IrcMessage): Promise<string> {
		const waiters = msg.broadcast ? undefined : this.childWaiters.get(child.id);
		const wi = waiters?.findIndex((w) => !w.from || w.from === msg.from) ?? -1;
		if (waiters && wi >= 0) {
			const [w] = waiters.splice(wi, 1);
			w!.resolve(msg);
			return "delivered (recipient was waiting)";
		}
		if (child.session?.isStreaming) {
			if (this.holdsAtStop(child, msg)) {
				child.held.push(msg);
				return "queued; it reads it at its next tool step, or in a turn of its own once its current run has reported";
			}
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
		this.parentBacklog.push({ ev, hits: 0 });
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

	markParentDelivered(details: unknown, content?: unknown): void {
		if (this.parentBacklog.length === 0) return;
		let i = this.parentBacklog.findIndex((e) => e.ev === details);
		if (i < 0 && typeof content === "string") i = this.parentBacklog.findIndex((e) => formatParentEvent(e.ev) === content);
		if (i >= 0) this.parentBacklog.splice(i, 1);
	}

	/**
	 * pi normally delivers one queued message per step but may silently clear the queue.
	 */
	queuedForParent(filter: (ev: ParentEvent) => boolean = () => true): ParentEvent[] {
		this.parentBacklog = this.parentBacklog.filter((e, position) => e.hits <= position + 1);
		const matching = this.parentBacklog.filter((e) => filter(e.ev));
		for (const e of matching) e.hits++;
		return matching.map((e) => e.ev);
	}

	clearParentBacklog(): void {
		this.parentBacklog = [];
	}

	onInactive(id: string, fn: () => void): () => void {
		const off = this.onChange(() => {
			if (subtreeActive(this.children.get(id))) return;
			off();
			fn();
		});
		return off;
	}

	private notifyUser(msg: IrcMessage): void {
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

	takeArrived(child: Child, from?: string): IrcMessage | undefined {
		for (const list of [child.held, child.inbox]) {
			const idx = list.findIndex((m) => !m.broadcast && (!from || m.from === from));
			if (idx >= 0) return list.splice(idx, 1)[0];
		}
		return undefined;
	}

	waitForChild(id: string, from: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<IrcMessage | null> {
		const child = this.children.get(id);
		const arrived = child && this.takeArrived(child, from);
		if (arrived) return Promise.resolve(arrived);
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

	private hasQueuedSteer(child: Child, from: string | undefined): boolean {
		let pending: readonly string[] = [];
		try {
			pending = child.session?.getSteeringMessages?.() ?? [];
		} catch {}
		return child.steered.some((s) => (s.direct || pending.includes(s.text)) && (!from || s.msg.from === from));
	}

	kill(id: string, opts: { notify?: boolean; by?: string; silent?: boolean } = {}): Promise<string[]> {
		const child = this.children.get(id);
		if (!child) return Promise.reject(new Error(`Unknown agent "${id}".`));
		if (child.killing) return child.killing;
		if (child.status === "aborted") return Promise.resolve([]);
		child.killing = this.teardown(child, opts);
		return child.killing;
	}

	private async teardown(child: Child, opts: { notify?: boolean; by?: string; silent?: boolean }): Promise<string[]> {
		child.finalizing = true;
		const waker = child.wakeSender;
		child.wakeSender = undefined;
		// Mark the owner aborted before stopping its subagents to prevent it settling mid-teardown.
		child.status = "aborted";
		child.finishedAt = Date.now();
		child.abort.abort();
		const pendingProbe = this.stopCompletionProbe(child);
		child.runningTools.clear();
		this.changed();
		for (const w of this.childWaiters.get(child.id)?.splice(0) ?? []) w.resolve(null);
		const notes = (await Promise.all(child.owned.map((c) => this.kill(c.id, { silent: true }).catch(() => [] as string[])))).flat();
		const output = child.session?.getLastAssistantText?.() ?? "";
		try {
			await child.session?.abort();
		} catch {}
		if (pendingProbe) await pendingProbe;
		// pi appends any partial response before the session abort resolves.
		this.syncUsage(child);
		child.unsubscribe();
		child.session?.dispose();
		let info: DisposeInfo | undefined;
		try {
			const r = await this.hooks.dispose?.(child);
			if (r && typeof r === "object") info = r;
		} catch {}
		child.phase = undefined;
		const notify = !opts.silent && (opts.notify === true || (child.ownerId !== PARENT_ID && opts.by !== child.ownerId));
		this.settleInitial(child, "aborted", output, notify, info?.merge ? { merge: info.merge } : undefined);
		const killer = opts.by ?? (opts.notify ? USER_ID : undefined);
		if (waker && !opts.silent && waker !== killer) {
			void this.deliver(child.id, waker, `\`${child.id}\` was killed before it replied.`, { relay: true }).catch(() => {});
		}
		this.changed();
		if (info?.note) notes.push(`${child.id}: ${info.note}`);
		return notes;
	}

	async disposeAll(): Promise<string[]> {
		for (const w of this.parentWaiters.splice(0)) w.resolve(null);
		this.parentBacklog = [];
		this.spawnsInFlight.clear();
		for (const p of this.pools.values()) p.rejectAll();
		const all = [...this.children.values()];
		const top = await Promise.all(all.filter((c) => c.ownerId === PARENT_ID).map((c) => this.kill(c.id, { silent: true }).catch(() => [])));
		const rest = await Promise.all(all.filter((c) => c.ownerId !== PARENT_ID).map((c) => this.kill(c.id, { silent: true }).catch(() => [])));
		this.children.clear();
		this.lifecycleShown.clear();
		this.changed();
		return [...new Set([...top.flat(), ...rest.flat()])];
	}

	private childIrcTool(child: Child): ToolDefinition {
		const hub = this;
		const selfId = child.id;
		const nested = child.ownerId !== PARENT_ID;
		const manages = !!child.spawns?.length;
		const recipients = nested ? '"parent" (the agent that spawned you), "main" (the main agent), or a peer id' : '"parent" or a peer id';
		const ops = manages ? (["send", "wait", "list", "read", "kill"] as const) : (["send", "wait", "list"] as const);
		return {
			name: "irc",
			label: "IRC",
			description:
				`Message other agents. op "send": deliver \`message\` to \`to\` (${recipients}); never blocks on a reply. ` +
				'op "wait": block until a message arrives (optionally only `from` one agent), up to `timeoutSec` (default 120). ' +
				"Wait only for the answer to a question that blocks you" +
				(manages ? " or a result of your own subagents; with nothing else to do, end your turn instead — it resumes with their results" : "") +
				". NEVER wait for another agent's progress. " +
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
				// A parallel task call may still be registering the requested sender.
				await hub.spawnsSettled(selfId);
				const asked = from !== undefined && from !== PARENT_ID && from !== USER_ID ? from : undefined;
				if (asked !== undefined && !hub.children.has(asked)) {
					const known = [PARENT_ID, ...(nested ? [MAIN_ALIAS] : []), ...[...hub.children.keys()].filter((k) => k !== selfId && k !== child.ownerId)];
					return text(`Unknown agent "${params.from}". Known: ${known.join(", ")}`, true);
				}
				if (child.steersInFlight.size > 0) await Promise.all([...child.steersInFlight]);
				if (hub.hasQueuedSteer(child, from)) {
					return text("A message is already queued for you; it is delivered right after this call.");
				}
				const arrived = hub.takeArrived(child, from);
				if (arrived) return text(hub.formatIncoming(child, arrived, "wait"));
				const target = asked !== undefined ? hub.children.get(asked) : undefined;
				const shown = target ? hub.displayId(child, target.id) : "";
				if (target && !subtreeActive(target)) {
					const again = target.status === "idle" ? " Message it again (irc send) if you still need an answer." : "";
					return text(`\`${shown}\` is ${target.status}: nothing is running that could reply.${again}`);
				}
				let stopped = false;
				const gone = new AbortController();
				const off = target
					? hub.onInactive(target.id, () => {
							stopped = true;
							gone.abort();
						})
					: undefined;
				const timeout = Math.max(1, params.timeoutSec ?? 120) * 1000;
				try {
					const msg = await hub.waitForChild(selfId, from, timeout, signal ? AbortSignal.any([signal, gone.signal]) : gone.signal);
					return text(
						msg
							? hub.formatIncoming(child, msg, "wait")
							: "No message arrived before the timeout. Keep working on whatever is not blocked, or wait again if nothing is; NEVER use sleep to wait longer.",
					);
				} catch (e) {
					if (!stopped || signal?.aborted) throw e;
					return text(`\`${shown}\` stopped (${target?.status ?? "gone"}) without replying. Ask again, or carry on without the answer.`);
				} finally {
					off?.();
				}
			},
		} as ToolDefinition;
	}

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
				const current = hub.spawnPolicy(child) ?? policy;
				const r = await hub.spawnTasks(params ?? {}, child.ctx, { policy: current, cwd: child.cwd, owner: child });
				return { content: [{ type: "text" as const, text: r.text }], details: undefined, isError: r.isError };
			},
		} as ToolDefinition;
	}
}

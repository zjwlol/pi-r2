/**
 * Native (TSP) descriptions of the subagent UI, for tsp-native (../tsp-native) — oh-my-pi style
 * (tui/src/tools/task.ts, chat/tool-execution.ts):
 *   - `task` / parent `irc` tools: describe hooks returning data-first tool views (head data plus a
 *     body of `agent`, `md` and `text` nodes) instead of pre-rendered rows;
 *   - one `agent` node per subagent (status, name, agent type, task, model, stats, live tool; its
 *     children are the expanded content: assignment, error, output / data, merge note, nested agents);
 *   - `describe(cx)` bodies for the bottom widget and delivered `task-result` / `irc` messages.
 * The contract types are declared here (no imports from tsp-native). Everything returns undefined /
 * null unless the terminal draws `agent` nodes, which keeps tsp-native's own rendering.
 * Memo contract: the same view / node object while nothing shown changed (hub change version,
 * result/args identity, expand state), a new one otherwise.
 */

import type { Component } from "@earendil-works/pi-tui";
import { DEFAULT_AGENT } from "./agents.ts";
import type { AgentHub, Child, ParentEvent } from "./hub.ts";
import { activeDescendants, firstLine, isActive, PARENT_ID, subtreeActive } from "./hub.ts";
import { type DoneInfo, fmtDuration, type MergeInfo, type SubagentSummary } from "./prompts.ts";
import {
	mergeParts,
	nestedRows,
	type RowSnapshot,
	type RowStatus,
	shortModel,
	snapshotChild,
	snapshotDetached,
	snapshotSummary,
	type SpawnedItem,
	type TaskDetails,
} from "./render.ts";
import { formatStructuredData } from "./structured.ts";

// ---------------------------------------------------------------------------------------------
// Contract (mirrors tsp-native's NativeToolView / NativeNode; plain JSON)

export interface TspSpan {
	t: string;
	s?: string;
	href?: string;
}
export type TspText = string | readonly TspSpan[];
export type TspTone = "neutral" | "accent" | "info" | "success" | "warning" | "error" | "pending" | "muted" | "user";

export interface NativeNode {
	k: string;
	p?: Record<string, unknown>;
	c?: readonly NativeNode[];
	key?: string;
}

export interface NativeDescribeOptions {
	expanded: boolean;
	isPartial: boolean;
	executionStarted: boolean;
	argsComplete: boolean;
	cols: number;
	/** Date.now() at describe time. */
	nowMs: number;
	/** The terminal advertises this TSP node kind. */
	supports(kind: string): boolean;
}

export interface NativeToolView {
	tool?: {
		title?: TspText;
		target?: TspText;
		targetKind?: "command" | "path" | "pattern" | "query" | "text";
		meta?: readonly TspText[];
		badges?: readonly { text: string; tone?: TspTone; title?: string }[];
		note?: TspText;
		/** number = use it (age: live timer, took: stopped); null = no timer; undefined = tsp-native's default. */
		age?: number | null;
		took?: number | null;
	};
	body?: readonly NativeNode[];
	tone?: TspTone;
	preview?: { lines: number } | { tail: number } | "none" | "children";
	/** Never start collapsed. */
	open?: boolean;
	/** frame:"inline" (head line + disclosed body, no ring). */
	inline?: boolean;
}

export interface NativeToolResult {
	content: unknown[];
	details: unknown;
	isError: boolean;
}

export interface NativeToolHooks {
	describeCall?(args: unknown, options: NativeDescribeOptions): NativeToolView | undefined;
	describeResult?(result: NativeToolResult, options: NativeDescribeOptions, args: unknown): NativeToolView | undefined;
	/** true: once a result exists only describeResult's view is used (describeCall's when it returns undefined). */
	mergeCallAndResult?: boolean;
}

/** What a component's own `describe(cx)` receives (the part of tsp-native's DescribeContext used here). */
export interface NativeComponentContext {
	readonly cols: number;
	supports(kind: string): boolean;
}

/** Persisted `details` of parent `irc` results (JSON; no live objects). Absent in older sessions. */
export type IrcDetails =
	| { op: "list"; agents: RowSnapshot[] }
	| { op: "read"; agent: RowSnapshot }
	| {
			op: "wait";
			/** The delivered event (copy). */
			event?: ParentEvent;
			timedOut?: boolean;
			/** Agents still running when it timed out. */
			running?: string[];
			/** The user's prompt ended the wait ("steer" | "followUp"). */
			interrupted?: string;
			/** Not waiting: a user prompt was already queued. */
			pending?: string;
			/** Not waiting: no running subagents. */
			idle?: boolean;
	  };

// ---------------------------------------------------------------------------------------------
// Builders

type Props = Record<string, unknown>;
type AgentStatus = "pending" | "running" | "done" | "failed" | "aborted" | "idle" | "parked";
interface Badge {
	text: string;
	tone?: TspTone;
}

function node(k: string, p?: Props, c?: readonly NativeNode[], key?: string): NativeNode {
	const out: NativeNode = { k };
	if (p !== undefined) out.p = p;
	if (c !== undefined && c.length > 0) out.c = c;
	if (key !== undefined) out.key = key;
	return out;
}

function span(t: string, s?: string): TspSpan {
	return s === undefined ? { t } : { t, s };
}

function text(content: TspText, p?: Props, key?: string): NativeNode {
	return node("text", typeof content === "string" ? { ...p, text: content } : { ...p, spans: content }, undefined, key);
}

function md(source: string, p?: Props, key?: string): NativeNode {
	return node("md", { ...p, text: source }, undefined, key);
}

function code(source: string, p?: Props, key?: string): NativeNode {
	return node("code", { ...p, text: source }, undefined, key);
}

function compact<T>(items: readonly (T | undefined | null | false)[]): T[] {
	const out: T[] = [];
	for (const item of items) if (item !== undefined && item !== null && item !== false) out.push(item);
	return out;
}

function noteText(message: string, token = "muted", key?: string): NativeNode {
	return text([span(message, token)], { wrap: "word" }, key);
}

function errorText(message: string, key?: string): NativeNode {
	return text([span(message.trim(), "error")], { wrap: "word", role: "omp.tool.error" }, key);
}

/** The shared batch context as one quiet line above the agents. */
function contextNode(raw: unknown): NativeNode | undefined {
	const line = typeof raw === "string" ? flat(raw) : "";
	return line ? text([span(line, "muted")], { wrap: "word", lines: 2, role: "omp.tool.context" }, "context") : undefined;
}

const HIDDEN: NativeNode = { k: "col", p: { hidden: true } };

// ---------------------------------------------------------------------------------------------
// Small helpers

function isRecord(v: unknown): v is Record<string, any> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, any> {
	return isRecord(v) ? v : {};
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function flat(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `950`, `1.2K`, `19K`, `1.5M` (omp formatNumber). */
function fmtCount(n: number): string {
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function resultText(result: NativeToolResult): string {
	const parts: string[] = [];
	for (const c of Array.isArray(result.content) ? result.content : []) {
		if (isRecord(c) && c.type === "text" && typeof c.text === "string") parts.push(c.text);
	}
	return parts.join("\n");
}

/** JSON copy (persisted details must not share live objects); undefined when not serialisable. */
export function jsonCopy<T>(value: T): T | undefined {
	try {
		const s = JSON.stringify(value);
		return s === undefined ? undefined : (JSON.parse(s) as T);
	} catch {
		return undefined;
	}
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
	return true;
}

/** One memo slot per owner object (a result's details / content, a call's args), keyed by deps. */
class OwnerMemo<T> {
	private readonly slots = new WeakMap<object, { deps: readonly unknown[]; value: T }>();
	private loose?: { deps: readonly unknown[]; value: T };

	get(owner: unknown, deps: readonly unknown[], build: () => T): T {
		const key = owner !== null && typeof owner === "object" ? owner : undefined;
		const slot = key ? this.slots.get(key) : this.loose;
		if (slot && sameDeps(slot.deps, deps)) return slot.value;
		const value = build();
		const next = { deps, value };
		if (key) this.slots.set(key, next);
		else this.loose = next;
		return value;
	}
}

// ---------------------------------------------------------------------------------------------
// Agent nodes

/** Theme token for a thinking level's model-chip dot. */
function thinkingToken(level: string | undefined): string | undefined {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
		case "max":
			return "thinkingXhigh";
		default:
			return undefined;
	}
}

function agentStatus(status: RowStatus): AgentStatus {
	switch (status) {
		case "pending":
			return "pending";
		case "running":
			return "running";
		case "idle":
			return "done";
		case "failed":
			return "failed";
		case "aborted":
			return "aborted";
		default:
			return "idle"; // detached: outcome unknown (session ended)
	}
}

/** Context-window stats: the fill fraction and its `19K / 200K` label (or the token count). */
function contextStats(tokens: number, window: number | undefined): { context?: number; contextLabel?: string; tokens?: number } {
	if (!(tokens > 0)) return {};
	if (!window || !(window > 0)) return { tokens };
	return { context: Math.min(1, tokens / window), contextLabel: `${fmtCount(tokens)} / ${fmtCount(window)}` };
}

function mergeBadge(merge: MergeInfo | undefined): Badge | undefined {
	if (!merge) return undefined;
	switch (merge.status) {
		case "applied": {
			const n = Array.isArray(merge.files) ? merge.files.length : 0;
			return { text: `merged ${plural(n, "file")}`, tone: "success" };
		}
		case "conflict":
			return { text: "merge conflict", tone: "warning" };
		case "unapplied":
			return { text: "not applied", tone: "warning" };
		case "error":
			return { text: "merge failed", tone: "error" };
		default:
			return undefined;
	}
}

function mergeNote(merge: MergeInfo | undefined): NativeNode | undefined {
	const p = mergeParts(merge);
	if (!p) return undefined;
	const spans = [span(p.label, p.color === "dim" ? "muted" : p.color)];
	if (p.path) spans.push(span(` ${p.path}`, "muted mono"));
	return text(spans, { wrap: "word", role: "omp.task.merge" }, "merge");
}

interface AgentOptions {
	nowMs: number;
	expanded: boolean;
	depth?: number;
	/** Point-in-time data (irc list / read): no ticking timers. */
	frozen?: boolean;
	/** Full assignment, the first expanded child (default: the row's task). null = none. */
	assignment?: string | null;
	/** Children after the assignment (e.g. the read report's activity and output). */
	extra?: readonly (NativeNode | undefined)[];
	/** Settled output / structured data as a child (default true). */
	output?: boolean;
	/** Never collapsed. */
	open?: boolean;
	/** No children at all (one-line rows). */
	bare?: boolean;
	role?: string;
}

/** One subagent as an `agent` node (omp TspAgentProps); children are its expanded content. */
export function agentNode(row: RowSnapshot, o: AgentOptions): NativeNode {
	const status = agentStatus(row.status);
	const active = row.status === "running" || row.status === "pending";
	const settled = !active && row.status !== "detached";
	const summary = firstLine(row.task ?? "", 200);
	const phase = active && row.phase ? flat(row.phase) : "";
	const task: TspText | undefined = phase ? (summary ? [span(summary), span(` · ${phase}`, "muted")] : phase) : summary || undefined;
	const current = row.status === "running" && row.tool?.running ? row.tool : undefined;
	const tool = current
		? {
				name: current.name,
				intent: clip(flat(current.args ?? ""), 160) || undefined,
				age: o.frozen ? undefined : Math.max(0, num(current.elapsedMs)),
			}
		: null;
	const d = row.durationMs;
	const timer = typeof d !== "number" || !(d >= 0) ? {} : active ? (o.frozen ? {} : { age: d }) : { took: d };
	const badges: Badge[] = [];
	if (row.status === "detached") badges.push({ text: "detached", tone: "muted" });
	if (row.isolated) badges.push({ text: "isolated" });
	if (row.structured) badges.push({ text: "schema" });
	if (settled) {
		const m = mergeBadge(row.merge);
		if (m) badges.push(m);
	}
	if (active && row.waiting) badges.push({ text: `waiting ${row.waiting}`, tone: "pending" });
	if (active && row.queued) badges.push({ text: "queued", tone: "pending" });

	const depth = o.depth ?? 0;
	let children: NativeNode[] = [];
	if (!o.bare) {
		const full = o.assignment === undefined ? row.task : o.assignment;
		const assignment = full?.trim() && flat(full) !== summary ? md(full.trim(), { role: "omp.task.assignment" }, "assignment") : undefined;
		let output: NativeNode | undefined;
		if (o.output !== false && !active) {
			if (row.hasData) {
				output = code(formatStructuredData(row.data, 8000), { lang: "json", role: "omp.task.output" }, "output");
			} else if (row.output !== undefined) {
				const out = row.output.trim();
				if (out) output = md(out, { role: "omp.task.output" }, "output");
				else if (!row.error) output = noteText(row.requests > 0 ? `(no output) after ${row.requests} req` : "(no output)", "dim", "output");
			}
		}
		children = compact([
			assignment,
			...(o.extra ?? []),
			(row.status === "failed" || row.status === "aborted") && row.error ? errorText(flat(row.error), "error") : undefined,
			output,
			settled ? mergeNote(row.merge) : undefined,
			...(row.children ?? []).map((ch) => agentNode(ch, { nowMs: o.nowMs, expanded: o.expanded, frozen: o.frozen, depth: depth + 1 })),
		]);
	}
	const props: Props = {
		name: row.id,
		agent: row.agent || undefined,
		task,
		status,
		model: shortModel(row.model) || undefined,
		thinking: thinkingToken(row.thinking),
		tool,
		stats: {
			tools: row.toolCount || undefined,
			requests: row.requests || undefined,
			...contextStats(num(row.contextTokens), row.contextWindow),
			cost: row.cost > 0 ? row.cost : undefined,
			...timer,
		},
		badges: badges.length > 0 ? badges : undefined,
		depth: depth > 0 ? depth : undefined,
		collapsible: children.length > 0 ? true : undefined,
		collapsed: children.length > 0 ? (o.open ? false : !o.expanded) : undefined,
	};
	if (o.role) props.role = o.role;
	return node("agent", props, children, row.id);
}

type DoneLike = Partial<DoneInfo> & { childId?: string; stats?: string };

/** Row of a delivered result (current DoneInfo, or the legacy `subagent-result` shape). */
export function rowFromDone(d: DoneLike): RowSnapshot {
	const status: RowStatus = d.status === "completed" ? "idle" : d.status === "failed" ? "failed" : d.status === "aborted" ? "aborted" : "detached";
	const subagents = Array.isArray(d.subagents) ? d.subagents.filter((s) => isRecord(s)) : [];
	return {
		id: str(d.id) || str(d.childId) || "agent",
		agent: str(d.agent),
		status,
		index: 0,
		model: str(d.model) || undefined,
		thinking: str(d.thinking) || undefined,
		toolCount: num(d.toolCount),
		requests: num(d.requests),
		contextTokens: num(d.contextTokens),
		contextWindow: typeof d.contextWindow === "number" ? d.contextWindow : undefined,
		cost: num(d.cost),
		durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined,
		task: str(d.task),
		output: str(d.output),
		error: str(d.error) || undefined,
		isolated: d.isolated,
		structured: d.structured,
		merge: isRecord(d.merge) ? d.merge : undefined,
		...(d.data !== undefined ? { data: d.data, hasData: true } : {}),
		children: subagents.length ? subagents.map((s, i) => snapshotSummary(s as SubagentSummary, i)) : undefined,
	};
}

/** JSON-safe row of a live agent for persisted details (one-line tasks below the top row). */
export function persistRow(c: Child, now: number, fullTask = false): RowSnapshot {
	const strip = (r: RowSnapshot, top: boolean): RowSnapshot => {
		const out: RowSnapshot = { ...r, task: top && fullTask ? r.task : firstLine(r.task, 200) };
		delete out.lastText;
		delete out.output;
		if (r.children?.length) out.children = r.children.map((ch) => strip(ch, false));
		else delete out.children;
		return out;
	};
	return strip(snapshotChild(c, 0, now, false), true);
}

// ---------------------------------------------------------------------------------------------
// Older sessions: the `<task-result>` / `<irc>` envelopes of a wait's text

const ENVELOPE_TAGS = /&lt;(\/?)(task-result|output|preview|error|irc|data|merge-summary)\b/g;

function unescapeEnvelope(s: string): string {
	return s.replace(ENVELOPE_TAGS, "<$1$2");
}

function parseDuration(s: string): number | undefined {
	const t = s.trim();
	const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(t);
	if (!t || !m) return undefined;
	return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

function tagBody(source: string, tag: string): string | undefined {
	const m = new RegExp(`<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(source);
	return m ? unescapeEnvelope(m[1] ?? "") : undefined;
}

/** A task result parsed from its `<task-result>` envelope (text of older sessions). */
function parseTaskResult(source: string): RowSnapshot | undefined {
	const head = /<task-result id="([^"]*)" agent="([^"]*)" status="([^"]*)" duration="([^"]*)">/.exec(source);
	if (!head) return undefined;
	const data = tagBody(source, "data");
	const row = rowFromDone({
		id: head[1],
		agent: head[2],
		status: head[3] as DoneInfo["status"],
		durationMs: parseDuration(head[4] ?? ""),
		error: tagBody(source, "error"),
		output: data ?? tagBody(source, "output") ?? tagBody(source, "preview") ?? "",
	});
	if (data !== undefined) {
		// Already pretty-printed JSON: show it as such.
		row.output = undefined;
		try {
			row.data = JSON.parse(data);
			row.hasData = true;
		} catch {
			row.output = `\`\`\`json\n${data}\n\`\`\``;
		}
	}
	const merge = tagBody(source, "merge-summary");
	if (merge?.trim()) row.lastText = merge.trim();
	return row;
}

// ---------------------------------------------------------------------------------------------
// Hooks

export interface NativeDeps {
	hub: AgentHub;
	/** Bumped on every hub change. */
	version(): number;
	/** Rows of the bottom widget (as in its ANSI rendering). */
	widgetRows: number;
}

export interface NativeSubagentUI {
	task: NativeToolHooks;
	irc: NativeToolHooks;
	/** A native describe ran (the terminal draws agents natively). */
	used(): boolean;
	/** The bottom widget's node: agents not shown by a live task card that was described natively. */
	describeWidget(cx: NativeComponentContext): NativeNode | null;
	/** A delivered `task-result` / `irc` message. */
	describeEvent(message: { customType?: string; content?: unknown; details?: unknown }, expanded: boolean, cx: NativeComponentContext): NativeNode | null;
}

/** Add a native `describe(cx)` to a component (built once per component; null unless agents are drawn). */
export function withNativeDescribe<T extends object>(
	component: T,
	describe: (cx: NativeComponentContext) => NativeNode | null,
): T & { describe(cx: NativeComponentContext): NativeNode | null } {
	let cached: { node: NativeNode | null } | undefined;
	return Object.assign(component, {
		describe(cx: NativeComponentContext): NativeNode | null {
			if (!cx.supports("agent")) return null;
			if (!cached) cached = { node: describe(cx) };
			return cached.node;
		},
	});
}

type IrcArgs = { op?: string; to?: string; message?: string; from?: string; id?: string };

export function createNativeUI(deps: NativeDeps): NativeSubagentUI {
	const { hub } = deps;
	let used = false;
	/** Top-level agents whose live task card was described natively (their card shows them). */
	const carded = new Set<string>();
	let cardedVersion = 0;
	const cover = (id: string) => {
		if (carded.has(id)) return;
		carded.add(id);
		cardedVersion++;
	};

	// ---------- task ----------
	const taskItems = (a: Record<string, any>): Record<string, any>[] =>
		Array.isArray(a.tasks) ? a.tasks.filter(isRecord) : typeof a.task === "string" || typeof a.name === "string" ? [a] : [];

	const itemName = (item: Record<string, any>, i: number) => (typeof item.name === "string" && item.name.trim() ? item.name.trim() : `#${i + 1}`);

	/** `N agents`, or the single item's name. */
	const callTarget = (a: Record<string, any>): string | undefined => {
		const items = taskItems(a);
		if (items.length === 1) return itemName(items[0]!, 0);
		return items.length > 0 ? plural(items.length, "agent") : undefined;
	};

	const describeTaskCall = (args: unknown): NativeToolView => {
		const a = asRecord(args);
		const agents = taskItems(a).map((item, i) => {
			const name = itemName(item, i);
			const schema = item.outputSchema;
			const badges: Badge[] = [];
			if (item.isolated === true || item.isolated === "true") badges.push({ text: "isolated" });
			if (schema !== undefined && schema !== null && schema !== false && schema !== "") badges.push({ text: "schema" });
			const agent = typeof item.agent === "string" ? item.agent.trim() : "";
			return node(
				"agent",
				{
					name,
					agent: agent || undefined,
					task: typeof item.task === "string" ? firstLine(item.task, 200) || undefined : undefined,
					status: "pending",
					model: typeof item.model === "string" ? shortModel(item.model) || undefined : undefined,
					thinking: thinkingToken(typeof item.thinking === "string" ? item.thinking : undefined),
					badges: badges.length > 0 ? badges : undefined,
				},
				undefined,
				name,
			);
		});
		const target = callTarget(a);
		return {
			tool: { title: "Task", target, targetKind: target ? "text" : undefined },
			body: compact([contextNode(a.context), ...agents]),
		};
	};

	/** Full assignments from the call's args (persisted rows only carry the first line). */
	const argAssignments = (a: Record<string, any>, items: SpawnedItem[]): (string | undefined)[] => {
		const tasks = taskItems(a);
		const byName = new Map<string, string>();
		for (const t of tasks) if (typeof t.name === "string" && typeof t.task === "string") byName.set(t.name.trim(), t.task);
		return items.map((item, i) => {
			const named = byName.get(item.id);
			if (named !== undefined) return named;
			const t = tasks.length === items.length ? tasks[i]?.task : undefined;
			return typeof t === "string" ? t : undefined;
		});
	};

	const describeTaskResult = (result: NativeToolResult, options: NativeDescribeOptions, args: unknown): NativeToolView => {
		const a = asRecord(args);
		const context = contextNode(a.context);
		const details = asRecord(result.details) as Partial<TaskDetails>;
		if (!Array.isArray(details.items)) {
			const fallback = resultText(result).trim();
			const target = callTarget(a);
			const head = { title: "Task", target, targetKind: target ? ("text" as const) : undefined };
			if (result.isError) return { tool: head, tone: "error", body: compact([context, errorText(fallback || "Task failed")]) };
			return { tool: head, body: compact([context, fallback ? noteText(fallback, "dim") : undefined]) };
		}
		const items = details.items.filter((it): it is SpawnedItem => isRecord(it) && typeof it.id === "string");
		const errors = Array.isArray(details.errors) ? details.errors.filter((e): e is string => typeof e === "string") : [];
		const now = options.nowMs;
		const live = details.hub === hub.instanceId;
		const startedAt = typeof details.startedAt === "number" ? details.startedAt : undefined;
		const assignments = argAssignments(a, items);
		const rows: RowSnapshot[] = [];
		const agents: NativeNode[] = [];
		let anyActive = false;
		let allLive = items.length > 0;
		let end = startedAt ?? 0;
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			const c = live ? hub.children.get(item.id) : undefined;
			if (c) {
				cover(item.id);
				if (subtreeActive(c)) anyActive = true;
				else if (c.finishedAt) end = Math.max(end, c.finishedAt);
			} else {
				allLive = false;
			}
			const row = c ? snapshotChild(c, i, now, true) : snapshotDetached(item, i);
			rows.push(row);
			agents.push(agentNode(row, { nowMs: now, expanded: options.expanded, assignment: c ? c.task : (assignments[i] ?? item.task) }));
		}

		const nested = rows.flatMap((r) => nestedRows(r));
		const count = (s: RowStatus, queued?: boolean) =>
			rows.filter((r) => r.status === s && (queued === undefined || !!r.queued === queued)).length;
		const failed = count("failed");
		const aborted = count("aborted");
		const parts: string[] = [];
		const add = (n: number, label: string) => {
			if (n > 0) parts.push(`${n} ${label}`);
		};
		add(count("idle"), "done");
		add(failed, "failed");
		add(aborted, "aborted");
		add(count("running"), "running");
		add(count("pending", false), "starting");
		add(count("pending", true), "queued");
		if (rows.length > 0 && rows.every((r) => r.status === "detached")) parts.push("session ended");
		const all = [...rows, ...nested];
		const req = all.reduce((n, r) => n + num(r.requests), 0);
		if (req > 0) parts.push(`${fmtCount(req)} req`);
		const cost = all.reduce((n, r) => n + num(r.cost), 0);
		if (cost > 0) parts.push(`$${cost.toFixed(2)}`);

		let timer: { age?: number | null; took?: number | null } = {};
		if (rows.length > 0) {
			if (!live || startedAt === undefined) timer = { age: null, took: null };
			else if (anyActive) timer = { age: Math.max(0, now - startedAt) };
			else if (allLive && end > startedAt) timer = { took: end - startedAt };
			else timer = { age: null, took: null };
		}
		const target =
			rows.length > 0 ? `${plural(rows.length, "agent")}${nested.length ? ` · ${nested.length} nested` : ""}` : callTarget(a);
		return {
			tool: {
				title: "Task",
				target,
				targetKind: target ? "text" : undefined,
				meta: parts.length > 0 ? [parts.join(" · ")] : undefined,
				...timer,
			},
			tone: failed + aborted + errors.length > 0 || result.isError ? "error" : undefined,
			// Collapsed, the card still shows every agent row (each folds its own content); larger batches clamp.
			preview: { lines: Math.min(60, Math.max(10, (context ? 2 : 0) + 3 * rows.length + errors.length + 1)) },
			body: compact([
				context,
				...agents,
				...errors.map((e, i) => errorText(e, `spawn-error-${i}`)),
				rows.length === 0 && errors.length === 0 ? noteText(resultText(result).trim() || "No agents", "dim") : undefined,
			]),
		};
	};

	const taskCallMemo = new OwnerMemo<NativeToolView>();
	const taskResultMemo = new OwnerMemo<NativeToolView>();

	const task: NativeToolHooks = {
		mergeCallAndResult: true,
		describeCall(args, options) {
			if (!options.supports("agent")) return undefined;
			used = true;
			const a = asRecord(args);
			const items = taskItems(a);
			const last = items[items.length - 1];
			// Streaming args are re-parsed into new objects; the stamp also covers in-place growth.
			const stamp = [items.length, str(last?.task).length, str(last?.name), str(a.context).length];
			return taskCallMemo.get(args, [args, options.argsComplete, ...stamp], () => describeTaskCall(args));
		},
		describeResult(result, options, args) {
			if (!options.supports("agent")) return undefined;
			used = true;
			const details = asRecord(result.details);
			const live = details.hub === hub.instanceId;
			const owner = isRecord(result.details) ? result.details : result.content;
			return taskResultMemo.get(
				owner,
				[live ? deps.version() : -1, result.details, result.content, result.isError, args, options.expanded],
				() => describeTaskResult(result, options, args),
			);
		},
	};

	// ---------- irc ----------
	const ircTitle = (op: string) => (op === "wait" ? "Wait" : "IRC");

	const ircTarget = (a: IrcArgs): TspText | undefined => {
		const op = str(a.op);
		switch (op) {
			case "send":
				return `→ ${str(a.to).trim() || "?"}`;
			case "wait":
				return str(a.from).trim() ? `from ${str(a.from).trim()}` : "any agent";
			case "list":
				return "list";
			case "read":
			case "kill":
				return [span(`${op} `, "muted"), span(str(a.id).trim() || "?")];
			default:
				return op || undefined;
		}
	};

	const ircHead = (a: IrcArgs, extra?: NativeToolView["tool"]): NativeToolView["tool"] => {
		const target = ircTarget(a);
		return { title: ircTitle(str(a.op)), target, targetKind: target !== undefined ? "text" : undefined, ...extra };
	};

	const messageBody = (a: IrcArgs): NativeNode | undefined => {
		const body = str(a.message).trim();
		return body ? md(body, { role: "omp.irc.message" }, "message") : undefined;
	};

	const describeIrcCall = (a: IrcArgs): NativeToolView => {
		if (str(a.op) === "send") return { tool: ircHead(a), body: compact([messageBody(a)]), inline: true, preview: { lines: 3 } };
		return { tool: ircHead(a), inline: true };
	};

	/** A delivered event's body: a task result as an agent, a message as `from → to` + markdown. */
	const eventBody = (ev: ParentEvent, expanded: boolean, nowMs: number): NativeNode[] => {
		if (ev.kind === "done") {
			return [agentNode(rowFromDone(asRecord(ev.done) as DoneLike), { nowMs, expanded, open: true, role: "omp.task.result" })];
		}
		const msg = asRecord(ev.msg);
		const from = str(msg.from) || "?";
		const body = str(msg.body).trim();
		const head =
			msg.kind === "notice"
				? text([span(`Notice from ${from}`, "muted")], { lines: 1 }, "head")
				: text([span(from, "strong"), span(` → ${str(msg.to) || PARENT_ID}`, "muted")], { lines: 1 }, "head");
		return compact([head, body ? md(body, { role: "omp.irc.message" }, "body") : undefined]);
	};

	/** Body of a wait result from its text alone (sessions before `details` carried the event). */
	const waitTextBody = (source: string, expanded: boolean, nowMs: number): { body: NativeNode[]; note?: string } => {
		const row = parseTaskResult(source);
		if (row) {
			const merge = row.lastText;
			row.lastText = undefined;
			const extra = merge ? [text([span(merge, "muted")], { wrap: "word", role: "omp.task.merge" }, "merge")] : undefined;
			return { body: [agentNode(row, { nowMs, expanded, open: true, extra, role: "omp.task.result" })] };
		}
		const irc = /<irc from="([^"]*)">\n([\s\S]*?)\n<\/irc>/.exec(source);
		if (irc) {
			return {
				body: eventBody({ kind: "message", msg: { from: irc[1] ?? "?", to: PARENT_ID, body: unescapeEnvelope(irc[2] ?? ""), ts: 0 } }, expanded, nowMs),
			};
		}
		const notice = /^\[Notice from `([^`]*)`\.\]\n([\s\S]*)$/.exec(source);
		if (notice) {
			return {
				body: eventBody({ kind: "message", msg: { kind: "notice", from: notice[1] ?? "?", to: PARENT_ID, body: notice[2] ?? "", ts: 0 } }, expanded, nowMs),
			};
		}
		if (source.startsWith("Timed out")) return { body: [noteText(source.trim(), "muted")], note: "timed out" };
		return { body: source.trim() ? [noteText(source.trim(), "muted")] : [] };
	};

	const describeWait = (a: IrcArgs, result: NativeToolResult, options: NativeDescribeOptions): NativeToolView => {
		const d = asRecord(result.details);
		const source = resultText(result);
		const nowMs = options.nowMs;
		if (d.op !== "wait") {
			// Older session: the text is all there is.
			const { body, note } = waitTextBody(source, options.expanded, nowMs);
			return body.length > 0 && body[0]!.k === "agent"
				? { tool: ircHead(a), body, preview: { lines: 12 } }
				: { tool: ircHead(a, note ? { note } : undefined), body, inline: true, preview: { lines: 6 } };
		}
		const ev = isRecord(d.event) ? (d.event as ParentEvent) : undefined;
		const interrupted = typeof d.interrupted === "string" ? d.interrupted : undefined;
		const userNote = (head: string) =>
			noteText(`${head}: the user sent a message${interrupted === "followUp" || d.pending === "followUp" ? " (follow-up)" : ""}.`, "muted", "user");
		if (ev) {
			return {
				tool: ircHead(a, interrupted ? { note: "interrupted" } : undefined),
				tone: ev.kind === "message" ? "info" : undefined,
				body: compact([...eventBody(ev, options.expanded, nowMs), interrupted ? userNote("Then interrupted") : undefined]),
				preview: { lines: 12 },
			};
		}
		if (typeof d.pending === "string") return { tool: ircHead(a, { note: "not waiting" }), body: [userNote("Not waiting")], inline: true };
		if (d.idle) return { tool: ircHead(a, { note: "no running agents" }), inline: true };
		if (interrupted) return { tool: ircHead(a, { note: "interrupted" }), body: [userNote("Interrupted")], inline: true };
		if (d.timedOut) {
			const running = Array.isArray(d.running) ? d.running.filter((x: unknown): x is string => typeof x === "string") : [];
			return {
				tool: ircHead(a, { note: "timed out" }),
				body: [noteText(running.length ? `Still running: ${running.join(", ")}` : "No agents running.", "muted")],
				inline: true,
			};
		}
		return { tool: ircHead(a), body: source.trim() ? [noteText(source.trim(), "muted")] : [], inline: true };
	};

	/** Agent rows as a flat tree (depth per level). */
	const listNodes = (rows: RowSnapshot[], nowMs: number, expanded: boolean): NativeNode[] => {
		const out: NativeNode[] = [];
		const walk = (r: RowSnapshot, depth: number) => {
			out.push(agentNode(r, { nowMs, expanded, depth, frozen: true, bare: true }));
			for (const ch of r.children ?? []) if (isRecord(ch)) walk(ch, depth + 1);
		};
		for (const r of rows) if (isRecord(r)) walk(r, 0);
		return out;
	};

	const describeList = (a: IrcArgs, result: NativeToolResult, options: NativeDescribeOptions): NativeToolView => {
		const d = asRecord(result.details);
		const source = resultText(result).trim();
		if (d.op !== "list" || !Array.isArray(d.agents)) {
			const lines = source ? source.split("\n").map((l, i) => noteText(l, "muted", `l${i}`)) : [];
			return { tool: ircHead(a), body: lines, preview: { lines: 12 } };
		}
		const rows = d.agents as RowSnapshot[];
		const nodes = listNodes(rows, options.nowMs, options.expanded);
		let active = 0;
		const countActive = (r: RowSnapshot) => {
			if (r.status === "running" || r.status === "pending") active++;
			for (const ch of r.children ?? []) countActive(ch);
		};
		rows.forEach(countActive);
		const meta = nodes.length > 0 ? [`${plural(nodes.length, "agent")}${active ? ` · ${active} active` : ""}`] : undefined;
		return {
			tool: ircHead(a, { meta }),
			body: nodes.length > 0 ? nodes : [noteText(source || "No subagents.", "muted")],
			preview: { lines: Math.min(40, Math.max(10, 2 * nodes.length + 1)) },
		};
	};

	/** `readReport` sections: recent activity and latest output. */
	const readSections = (source: string): { activity?: string; output?: string } => {
		const act = source.indexOf("\n\nRecent activity:\n");
		if (act < 0) return {};
		const rest = source.slice(act + "\n\nRecent activity:\n".length);
		const out = rest.indexOf("\n\nLatest output:\n");
		if (out < 0) return { activity: rest };
		return { activity: rest.slice(0, out), output: rest.slice(out + "\n\nLatest output:\n".length) };
	};

	const describeRead = (a: IrcArgs, result: NativeToolResult, options: NativeDescribeOptions): NativeToolView => {
		const d = asRecord(result.details);
		const source = resultText(result);
		const { activity, output } = readSections(source);
		const activityNode =
			activity?.trim() && activity.trim() !== "(none)"
				? text([span(activity.trim(), "muted")], { wrap: "word", role: "omp.task.activity" }, "activity")
				: undefined;
		const out = output?.trim();
		const outputNode = out && out !== "(none yet)" ? md(out, { role: "omp.task.output" }, "output") : undefined;
		if (d.op !== "read" || !isRecord(d.agent)) {
			// Older session: the report's head line, then its sections.
			const head = source.split("\n")[0] ?? "";
			const body = compact([head ? noteText(head, "muted", "head") : undefined, activityNode, outputNode]);
			return { tool: ircHead(a), body: body.length > 0 ? body : [noteText(source.trim(), "muted")], preview: { lines: 12 } };
		}
		const row = d.agent as RowSnapshot;
		return {
			tool: ircHead(a),
			body: [agentNode(row, { nowMs: options.nowMs, expanded: options.expanded, frozen: true, open: true, output: false, extra: [activityNode, outputNode] })],
			preview: { lines: 12 },
		};
	};

	const describeIrcResult = (args: unknown, result: NativeToolResult, options: NativeDescribeOptions): NativeToolView => {
		const a = asRecord(args) as IrcArgs;
		const op = str(a.op);
		const source = resultText(result).trim();
		if (result.isError) {
			return { tool: ircHead(a), tone: "error", body: compact([op === "send" ? messageBody(a) : undefined, errorText(source || `${ircTitle(op)} failed`, "error")]) };
		}
		switch (op) {
			case "send": {
				// "delivered; it will read it at its next step" → "delivered"; "Broadcast to 3 agent(s):\n- …" → receipts below.
				const lines = source.split("\n");
				const receipt = (lines[0] ?? "").split(";")[0]!.replace(/:$/, "").trim();
				const receipts = lines.slice(1).filter((l) => l.trim());
				return {
					tool: ircHead(a, { meta: receipt ? [receipt] : undefined }),
					body: compact([messageBody(a), receipts.length ? text([span(receipts.join("\n"), "muted")], { role: "omp.irc.receipts" }, "receipts") : undefined]),
					inline: true,
					preview: { lines: 3 },
				};
			}
			case "wait":
				return describeWait(a, result, options);
			case "list":
				return describeList(a, result, options);
			case "read":
				return describeRead(a, result, options);
			case "kill": {
				const notes = source.split("\n").slice(1).filter((l) => l.trim());
				return {
					tool: ircHead(a, { note: "killed" }),
					body: notes.length ? [text([span(notes.join("\n"), "muted")], { wrap: "word" }, "notes")] : undefined,
					inline: true,
					preview: notes.length ? { lines: 3 } : undefined,
				};
			}
			default:
				return { tool: ircHead(a), body: source ? [noteText(source, "muted")] : undefined, inline: true };
		}
	};

	const ircCallMemo = new OwnerMemo<NativeToolView>();
	const ircResultMemo = new OwnerMemo<NativeToolView>();

	const irc: NativeToolHooks = {
		mergeCallAndResult: true,
		describeCall(args, options) {
			if (!options.supports("agent")) return undefined;
			used = true;
			const a = asRecord(args) as IrcArgs;
			const stamp = [str(a.op), str(a.to), str(a.message).length, str(a.from), str(a.id)];
			return ircCallMemo.get(args, [args, options.argsComplete, ...stamp], () => describeIrcCall(a));
		},
		describeResult(result, options, args) {
			if (!options.supports("agent")) return undefined;
			used = true;
			const owner = isRecord(result.details) ? result.details : result.content;
			return ircResultMemo.get(owner, [result.details, result.content, result.isError, args, options.expanded], () =>
				describeIrcResult(args, result, options),
			);
		},
	};

	// ---------- bottom widget ----------
	let widgetMemo: { deps: readonly unknown[]; node: NativeNode } | undefined;
	const topOf = (c: Child): Child => {
		let cur = c;
		for (let i = 0; i < 16 && cur.ownerId !== PARENT_ID; i++) {
			const owner = hub.children.get(cur.ownerId);
			if (!owner) break;
			cur = owner;
		}
		return cur;
	};
	const describeWidget = (cx: NativeComponentContext): NativeNode | null => {
		if (!cx.supports("agent")) return null;
		used = true;
		const memoDeps = [deps.version(), cardedVersion];
		if (widgetMemo && sameDeps(widgetMemo.deps, memoDeps)) return widgetMemo.node;
		const now = Date.now();
		const list = hub.tree();
		// A live task card described natively updates in place (hooks read the hub): its agents (and their
		// nested ones) are shown there, so the widget only lists agents no such card shows.
		const rows = list.filter((c) => isActive(c) && !carded.has(topOf(c).id));
		let out: NativeNode;
		if (rows.length === 0) {
			out = HIDDEN;
		} else {
			const nodes = rows
				.slice(0, deps.widgetRows)
				.map((c) => agentNode(snapshotChild(c, 0, now, false), { nowMs: now, expanded: false, depth: Math.max(0, c.depth - 1), bare: true }));
			const more = rows.length - deps.widgetRows;
			const idle = list.filter((c) => c.status === "idle").length;
			const tail = [more > 0 ? `… ${more} more running` : "", idle ? `${idle} idle` : "", "ctrl+s or /agents to inspect"].filter(Boolean);
			out = node("col", { role: "omp.subagent.widget", gap: "xs" }, [...nodes, text([span(tail.join(" · "), "muted")], { lines: 1 }, "tail")]);
		}
		widgetMemo = { deps: memoDeps, node: out };
		return out;
	};

	// ---------- delivered messages ----------
	const describeEvent = (
		message: { customType?: string; content?: unknown; details?: unknown },
		expanded: boolean,
		cx: NativeComponentContext,
	): NativeNode | null => {
		if (!cx.supports("agent")) return null;
		used = true;
		const ev = asRecord(message.details);
		if (ev.kind === "done" && isRecord(ev.done)) {
			const d = ev.done as DoneLike;
			const stats = str(d.stats).trim();
			return agentNode(rowFromDone(d), {
				nowMs: Date.now(),
				expanded,
				role: "omp.task.result",
				extra: stats ? [noteText(stats, "dim", "stats")] : undefined,
			});
		}
		if (ev.kind === "message" && isRecord(ev.msg)) {
			return node("col", { role: "omp.irc.message", gap: "xs" }, eventBody(ev as ParentEvent, expanded, Date.now()));
		}
		const body = typeof message.content === "string" ? message.content.trim() : "";
		return node("col", { role: "omp.irc.message", gap: "xs" }, compact([
			text([span(str(message.customType) || "message", "muted")], { lines: 1 }, "head"),
			body ? md(body, undefined, "body") : undefined,
		]));
	};

	return { task, irc, used: () => used, describeWidget, describeEvent };
}

// ---------------------------------------------------------------------------------------------
// Agent hub (inspector.ts): oh-my-pi overlays/agent-hub.ts #describePicker / #describePreview and
// agent-transcript-viewer.ts #describe, as plain data for the inspector's own describe(cx).

/** A node whose children may also be components (describe boundaries), as tsp-native's NativeNode. */
export interface NativeUiNode {
	k: string;
	p?: Props;
	c?: readonly NativeUiChild[];
	key?: string;
	/** Scroll the node into view when it is added. */
	reveal?: "start" | "end" | "nearest";
}

export type NativeUiChild = NativeUiNode | Component;

/** tsp-native's NativeUiEvent: a pointer or host-edit event on a described node; `key` is its keypath in the component. */
export type NativeUiEvent =
	| { readonly type: "toggle"; readonly key: string; readonly collapsed: boolean }
	| { readonly type: "select" | "activate"; readonly key: string; readonly item: string }
	| { readonly type: "action"; readonly key: string; readonly act: string; readonly value?: string; readonly mods?: readonly string[] }
	| { readonly type: "change"; readonly key: string; readonly item: string; readonly value: unknown }
	| { readonly type: "edit"; readonly key: string; readonly from: number; readonly to: number; readonly text: string; readonly cursor: number; readonly len: number }
	| { readonly type: "undo"; readonly key: string }
	| { readonly type: "send"; readonly key: string; readonly text: string };

export function uiNode(k: string, p?: Props, c?: readonly NativeUiChild[], key?: string): NativeUiNode {
	const out: NativeUiNode = { k };
	if (p !== undefined) out.p = p;
	if (c !== undefined && c.length > 0) out.c = c;
	if (key !== undefined) out.key = key;
	return out;
}

/** `ctrl+x` → `["ctrl", "x"]`, `escape` → `["esc"]` (omp pickerKeys). */
export function keyCaps(key: string): string[] {
	return key
		.split("+")
		.filter((part) => part.length > 0)
		.map((part) => (part === "escape" ? "esc" : part));
}

/** A native button (omp actionButton, role `omp.btn`): label plus keycap; a click sends `act` as an `action`. */
export function hubButton(label: string, act: string, opts: { key?: string; keys?: string; tone?: "accent" | "error"; title?: string } = {}): NativeUiNode {
	const children: NativeUiNode[] = [text(label)];
	if (opts.keys) children.push(node("kbd", { keys: keyCaps(opts.keys) }));
	return uiNode(
		"row",
		{
			role: "omp.btn",
			gap: "xs",
			align: "center",
			actions: { click: act },
			title: opts.title ?? (opts.keys ? `${label}  ${opts.keys}` : label),
			...(opts.tone ? { tone: opts.tone } : {}),
		},
		children,
		opts.key ?? act,
	);
}

/** A bare `esc` keycap button for a view's top-right corner (omp escCloseButton). */
export function hubEscButton(act: string, title: string): NativeUiNode {
	return uiNode("row", { role: "omp.btn", align: "center", actions: { click: act }, title: `${title}  esc` }, [node("kbd", { keys: ["esc"] })], "esc");
}

/** Picker dot per status (omp STATUS_DOT): a running agent pulses. */
export function hubStatusDot(status: string): TspTone {
	switch (status) {
		case "running":
			return "pending";
		case "idle":
			return "success";
		case "failed":
		case "aborted":
			return "error";
		default:
			return "muted";
	}
}

/** Badge / text tone per status (omp STATUS_TONE). */
export function hubStatusTone(status: string): TspTone {
	switch (status) {
		case "running":
			return "accent";
		case "idle":
			return "success";
		case "failed":
		case "aborted":
			return "error";
		default:
			return "muted";
	}
}

/** The agent's state in a word: `running`, `waiting`, `queued`, `starting`, `idle`, `failed`, `killed`. */
export function hubStatusLabel(c: Child): string {
	if (c.status === "pending") return c.queued ? "queued" : "starting";
	if (c.status === "running") return c.blocked ? "waiting" : c.queued ? "queued" : "running";
	if (c.status === "aborted") return "killed";
	return c.status;
}

/** Duration of the current (running) or latest run (render.ts snapshotChild). */
export function hubRunDuration(c: Child, now: number): number | undefined {
	if (c.status === "running" && c.runStartedAt) return Math.max(0, now - c.runStartedAt);
	if (c.status === "pending") return undefined;
	const d = c.done?.durationMs ?? (c.finishedAt && c.runStartedAt ? c.finishedAt - c.runStartedAt : undefined);
	return typeof d === "number" && d >= 0 ? d : undefined;
}

export function hubLastActivity(c: Child): number {
	return Math.max(c.createdAt, c.startedAt ?? 0, c.runStartedAt ?? 0, c.finishedAt ?? 0);
}

function hubCost(cost: number): string {
	return `$${cost.toFixed(cost > 0 && cost < 0.1 ? 3 : 2)}`;
}

function hubTokens(c: Child): number {
	return c.usage.input + c.usage.output + c.usage.cacheWrite;
}

function ownerName(c: Child): string {
	return c.ownerId === PARENT_ID ? "main" : c.ownerId;
}

/** One-line task summary. */
function taskSummary(task: string): string {
	return firstLine(task, 300);
}

/** Fuzzy `hits` of `query` in `label` (omp pickerFuzzyHits): each token's substring, else its characters in order. */
function fuzzyHits(label: string, query: string): [number, number][] | undefined {
	const lower = label.toLowerCase();
	const ranges: [number, number][] = [];
	for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
		const at = lower.indexOf(token);
		if (at >= 0) {
			ranges.push([at, at + token.length]);
			continue;
		}
		let from = 0;
		for (const ch of token) {
			const i = lower.indexOf(ch, from);
			if (i < 0) return undefined;
			ranges.push([i, i + 1]);
			from = i + 1;
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [start, end] of ranges) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged.length > 0 ? merged : undefined;
}

/** Roster fact columns (omp AGENT_COLUMNS); lower priorities hide first on narrow sheets. */
export const HUB_COLUMNS: readonly Props[] = [
	{ id: "cost", head: "Cost", format: "price", priority: 6 },
	{ id: "time", head: "Time", format: "elapsed", priority: 5 },
	{ id: "req", head: "Req", format: "num", priority: 2 },
	{ id: "tools", head: "Tools", format: "num", priority: 1 },
	{ id: "tok", head: "Tok", format: "num", priority: 3 },
	{ id: "ctx", head: "Ctx", format: "bar", priority: 4 },
];

export interface HubItemOptions {
	now: number;
	/** Tree layout: nesting depth (0 = spawned by the main agent). Undefined = flat rows. */
	depth?: number;
	/** Name the spawning agent (flat and filtered views). */
	showOwner?: boolean;
	/** Filter text to mark in the label. */
	query?: string;
}

/** One roster row as a picker item (omp #pickerAgentItem): status dot, id, task, model chip, badges, usage facts. */
export function hubPickerItem(c: Child, o: HubItemOptions): Props {
	const badges: { text: string; tone?: TspTone; title?: string }[] = [];
	const agent = c.agent.name?.trim();
	if (agent && agent !== DEFAULT_AGENT) badges.push({ text: agent, title: "Agent type" });
	if (c.inbox.length > 0) badges.push({ text: `${c.inbox.length} unread`, tone: "warning", title: "Messages waiting for its next step" });
	if (o.showOwner && c.ownerId !== PARENT_ID) badges.push({ text: `↳ ${c.ownerId}`, tone: "muted", title: "Spawned by" });
	if (c.status === "pending" || c.queued) badges.push({ text: c.queued ? "queued" : "starting", tone: "muted" });
	else if (c.status === "running" && c.blocked) badges.push({ text: "waiting", tone: "muted", title: "Waiting for its subagents" });
	if (c.isolated) badges.push({ text: "isolated", title: "Runs in its own git worktree" });
	if (c.schema) badges.push({ text: "schema", title: "Structured result" });
	const model = shortModel(c.modelLabel);
	const item: Props = {
		id: c.id,
		label: c.id,
		mono: true,
		dot: hubStatusDot(c.status),
		detail: taskSummary(c.task) || undefined,
		chips: model ? [{ text: model, dot: thinkingToken(c.thinking) }] : undefined,
		badges: badges.length > 0 ? badges : undefined,
	};
	if (o.query) {
		const hits = fuzzyHits(c.id, o.query);
		if (hits) item.hits = hits;
	}
	if (o.depth !== undefined) {
		item.depth = o.depth;
		if (c.owned.length > 0) item.open = true;
	}
	const u = c.usage;
	const d = hubRunDuration(c, o.now);
	if (u.requests > 0 || u.cost > 0 || u.toolCount > 0 || d !== undefined) {
		const facts: Props = { cost: hubCost(u.cost), time: d, req: u.requests, tools: u.toolCount, tok: hubTokens(c) };
		if (u.contextTokens > 0 && c.contextWindow && c.contextWindow > 0) {
			facts.ctx = Math.max(0, Math.min(1, u.contextTokens / c.contextWindow));
			item.title = `Context ${fmtCount(u.contextTokens)} / ${fmtCount(c.contextWindow)}`;
		}
		item.facts = facts;
	}
	return item;
}

/** Roster totals for the picker head: status counts, then spend (`2 running · 1 idle · $0.12 · 14 req · 33 tools`). */
export function hubSubtitle(all: readonly Child[]): TspText {
	if (all.length === 0) return [span("No agents yet", "muted")];
	const out: TspSpan[] = [];
	const sep = () => {
		if (out.length > 0) out.push(span(" · ", "dim"));
	};
	const count = (pred: (c: Child) => boolean) => all.filter(pred).length;
	for (const [n, label, token] of [
		[count((c) => c.status === "running" && !c.blocked), "running", "accent"],
		[count((c) => c.status === "running" && c.blocked), "waiting", "muted"],
		[count((c) => c.status === "pending"), "queued", "muted"],
		[count((c) => c.status === "idle"), "idle", "success"],
		[count((c) => c.status === "failed"), "failed", "error"],
		[count((c) => c.status === "aborted"), "killed", "error"],
	] as const) {
		if (n === 0) continue;
		sep();
		out.push(span(`${n} ${label}`, token));
	}
	let cost = 0;
	let req = 0;
	let tools = 0;
	for (const c of all) {
		cost += c.usage.cost;
		req += c.usage.requests;
		tools += c.usage.toolCount;
	}
	sep();
	out.push(span(hubCost(cost), "warning"));
	out.push(span(` · ${fmtCount(req)} req · ${fmtCount(tools)} tools`, "dim"));
	return out;
}

interface HubActivityRow {
	at?: number;
	glyph: TspSpan;
	name: string;
	summary: string;
}

function argsPreview(args: unknown): string {
	const a = asRecord(args);
	const pick = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? a.to ?? a.op;
	let s = typeof pick === "string" ? pick : "";
	if (!s) {
		try {
			s = JSON.stringify(args) ?? "";
		} catch {
			s = "";
		}
	}
	return clip(flat(s), 200);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => isRecord(p) && p.type === "text" && typeof p.text === "string")
		.map((p) => (p as { text: string }).text)
		.join(" ");
}

/** The agent's latest steps from its session (omp's activity rows): prompts, tool calls with their outcome, replies. */
function sessionActivity(c: Child, limit: number): HubActivityRow[] | undefined {
	const msgs = (c.session as { messages?: unknown } | undefined)?.messages;
	if (!Array.isArray(msgs)) return undefined;
	const results = new Map<string, boolean>();
	const out: HubActivityRow[] = [];
	for (let i = msgs.length - 1; i >= 0 && out.length < limit; i--) {
		const m = asRecord(msgs[i]);
		const at = typeof m.timestamp === "number" ? m.timestamp : undefined;
		switch (m.role) {
			case "toolResult":
				if (typeof m.toolCallId === "string") results.set(m.toolCallId, m.isError === true);
				break;
			case "user": {
				const t = flat(contentText(m.content));
				if (t) out.push({ at, glyph: span("→", "accent"), name: "prompt", summary: clip(t, 200) });
				break;
			}
			case "assistant": {
				const parts = Array.isArray(m.content) ? m.content : [];
				if (m.stopReason === "error" || m.stopReason === "aborted") {
					out.push({ at, glyph: span("✗", m.stopReason === "aborted" ? "warning" : "error"), name: m.stopReason, summary: clip(flat(str(m.errorMessage) || str(m.stopReason)), 200) });
				}
				for (let k = parts.length - 1; k >= 0 && out.length < limit; k--) {
					const part = asRecord(parts[k]);
					if (part.type === "toolCall") {
						const id = str(part.id);
						const failed = results.get(id);
						const glyph = failed === undefined ? span("●", "accent") : failed ? span("✗", "error") : span("✓", "success");
						out.push({ at, glyph, name: str(part.name) || "tool", summary: argsPreview(part.arguments) });
					} else if (part.type === "text") {
						const t = flat(str(part.text));
						if (t) out.push({ at, glyph: span("◆", "success"), name: "reply", summary: clip(t, 200) });
					}
				}
				break;
			}
			case "custom": {
				if (!m.display) break;
				const t = flat(contentText(m.content));
				if (t) out.push({ at, glyph: span("→", "accent"), name: str(m.customType) || "message", summary: clip(t, 200) });
				break;
			}
			case "bashExecution":
				out.push({ at, glyph: span("$", "muted"), name: "bash", summary: clip(flat(str(m.command)), 200) });
				break;
		}
	}
	return out.reverse();
}

/** The hub's own activity log (no session yet): `→ tool args`, `✗ tool failed`, reply text. */
function logActivity(c: Child, limit: number): HubActivityRow[] {
	return c.activity.slice(-limit).map((line) => {
		if (line.startsWith("→ ")) {
			const rest = line.slice(2);
			const sp = rest.indexOf(" ");
			return { glyph: span("●", "accent"), name: sp < 0 ? rest : rest.slice(0, sp), summary: sp < 0 ? "" : rest.slice(sp + 1) };
		}
		if (line.startsWith("✗ ")) return { glyph: span("✗", "error"), name: line.slice(2).replace(/ failed$/, ""), summary: "failed" };
		return { glyph: span("◆", "success"), name: "reply", summary: flat(line) };
	});
}

function clock(at: number | undefined): string {
	if (at === undefined) return "--:--:--";
	const d = new Date(at);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Rows shown in the preview's "Recent activity". */
export const HUB_RECENT_ACTIVITY = 20;

/** The tool the agent runs right now (the latest of parallel calls). */
export function hubRunningTool(c: Child): { name: string; args: string; startedAt: number } | undefined {
	let latest: { name: string; args: string; startedAt: number } | undefined;
	for (const t of c.runningTools.values()) if (!latest || t.startedAt >= latest.startedAt) latest = t;
	return latest;
}

/** The agent's current step in words (render.ts activityText, plain); `timer`: a long tool call's run time. */
export function hubCurrent(c: Child, now: number, timer = true): TspText | undefined {
	if (c.status === "failed" && c.error) return [span(flat(c.error), "error")];
	if (c.status !== "running") return undefined;
	if (c.phase) return [span(flat(c.phase), "muted")];
	if (c.blocked) {
		const n = activeDescendants(c).length;
		return [span(`waiting for ${plural(n, "subagent")}`, "muted")];
	}
	if (c.queued) return [span("queued for a run slot", "muted")];
	const latest = hubRunningTool(c);
	if (latest) {
		const out = [span(latest.name, "mono")];
		if (latest.args) out.push(span(` ${flat(latest.args)}`, "muted"));
		const ms = now - latest.startedAt;
		if (timer && ms > 5000) out.push(span(` · ${fmtDuration(ms)}`, "warning"));
		return out;
	}
	if (c.lastText) return [span(flat(c.lastText), "muted")];
	if (c.lastTool) return [span(c.lastTool.name, "mono muted"), span(` ${flat(c.lastTool.args)}`, "dim")];
	return [span("starting…", "dim")];
}

/** `3 tools · 2 req · 19K / 200K ctx · $0.02 (+0.01 nested)`. */
function usageSpans(c: Child): TspText {
	const u = c.usage;
	const parts: string[] = [];
	if (u.toolCount) parts.push(plural(u.toolCount, "tool"));
	if (u.requests) parts.push(`${fmtCount(u.requests)} req`);
	if (u.contextTokens > 0) parts.push(c.contextWindow ? `${fmtCount(u.contextTokens)} / ${fmtCount(c.contextWindow)} ctx` : `${fmtCount(u.contextTokens)} ctx`);
	const tok = hubTokens(c);
	if (tok > 0) parts.push(`${fmtCount(tok)} tok`);
	if (parts.length === 0 && u.cost === 0) return [span("usage —", "dim")];
	const out: TspSpan[] = [span(parts.join(" · "), "muted")];
	const nested = c.owned.reduce((n, o) => n + o.usage.cost, 0);
	if (u.cost > 0 || nested > 0) {
		out.push(span(`${parts.length ? " · " : ""}${hubCost(u.cost)}`, "warning"));
		if (nested > 0) out.push(span(` (+${nested.toFixed(2)} nested)`, "dim"));
	}
	return out;
}

export interface HubPreviewOptions {
	now: number;
	notice?: { text: string; tone: string };
	/** The terminal draws `meter` (else `progress`, when it draws that). */
	meter: boolean;
	progress: boolean;
}

/** The selected agent's preview pane (omp #describePreview): title + status, state, facts, context meter, recent activity. */
export function hubPreview(c: Child | undefined, o: HubPreviewOptions): NativeUiNode[] {
	if (!c) return [];
	const now = o.now;
	const out: NativeUiNode[] = [
		uiNode(
			"row",
			{ role: "omp.hub.title", gap: "sm", align: "center" },
			[text(c.id, { role: "omp.picker.title", truncate: "end" }), node("badge", { text: hubStatusLabel(c), tone: hubStatusTone(c.status) })],
			"title",
		),
	];
	if (o.notice) out.push(text([span(flat(o.notice.text), o.notice.tone)], { wrap: "word" }, "notice"));

	// State: spinner / status, run time, last active.
	const label = hubStatusLabel(c);
	const tone = hubStatusTone(c.status);
	const state: NativeUiNode[] = [
		c.status === "running" && !c.blocked ? node("spinner", { label: [span(label, "accent")] }) : text([span(label, tone)]),
	];
	const d = hubRunDuration(c, now);
	if (d !== undefined) state.push(c.status === "running" ? node("elapsed", { age: d }) : text([span(fmtDuration(d), "dim")]));
	const busy = c.status === "running" && !c.blocked && (c.runningTools.size > 0 || !!(c.session as { isStreaming?: boolean } | undefined)?.isStreaming);
	if (busy) state.push(text([span("active now", "dim")]));
	else state.push(text([span("last active", "dim")]), node("elapsed", { age: Math.max(0, now - hubLastActivity(c)), format: "short" }), text([span("ago", "dim")]));
	out.push(uiNode("row", { gap: "sm", wrap: true, align: "baseline" }, state, "state"));

	// Facts.
	const facts: { k: string; v: TspText }[] = [];
	const task = taskSummary(c.task);
	if (task) facts.push({ k: "Task", v: task });
	const model = shortModel(c.modelLabel);
	if (model) {
		const v: TspSpan[] = [span(model, "mono")];
		if (c.thinking && c.thinking !== "off") v.push(span(" · ", "dim"), span(c.thinking, thinkingToken(c.thinking) ?? "muted"));
		facts.push({ k: "Model", v });
	}
	const agent = c.agent.name?.trim();
	if (agent && agent !== DEFAULT_AGENT) facts.push({ k: "Agent", v: agent });
	const current = hubCurrent(c, now);
	if (current && c.status === "running") facts.push({ k: "Current", v: current });
	facts.push({ k: "Usage", v: usageSpans(c) });
	facts.push({ k: "Lineage", v: `Spawned by ${ownerName(c)}${c.owned.length ? ` · ${plural(c.owned.length, "subagent")}` : ""}` });
	if (c.owned.length > 0) {
		const named = c.owned.slice(0, 12).map((x) => x.id);
		const more = c.owned.length - named.length;
		const live = activeDescendants(c).length;
		facts.push({ k: "Subagents", v: [span(`${named.join(", ")}${more > 0 ? `, … +${more}` : ""}`, "dim"), ...(live ? [span(` (${live} active)`, "accent")] : [])] });
	}
	const flags = [c.isolated ? "isolated worktree" : "", c.schema ? "structured result" : ""].filter(Boolean);
	if (flags.length) facts.push({ k: "Mode", v: [span(flags.join(" · "), "muted")] });
	if (c.worktree) facts.push({ k: "Worktree", v: [span(c.worktree.path, "path")] });
	const merge = mergeParts(c.done?.merge);
	if (merge) facts.push({ k: "Merge", v: [span(merge.label, merge.color === "dim" ? "muted" : merge.color), ...(merge.path ? [span(` ${merge.path}`, "path")] : [])] });
	if (c.inbox.length > 0) facts.push({ k: "Inbox", v: [span(`${plural(c.inbox.length, "message")} waiting`, "warning")] });
	facts.push({ k: "Started", v: [span(clock(c.startedAt ?? c.createdAt), "dim")] });
	out.push(uiNode("kv", { items: facts, layout: "grid", role: "omp.hub.kv" }, undefined, "facts"));

	if (c.error && c.status !== "running") out.push(text([span(flat(c.error), "error")], { wrap: "word", lines: 6 }, "error"));

	const win = c.contextWindow;
	if (c.usage.contextTokens > 0 && win && win > 0 && (o.meter || o.progress)) {
		const ratio = Math.max(0, Math.min(1, c.usage.contextTokens / win));
		const ctxLabel = `${fmtCount(c.usage.contextTokens)} / ${fmtCount(win)} · ${Math.round(ratio * 100)}%`;
		out.push(
			o.meter
				? uiNode("meter", { value: ratio, style: "bar", size: "md", label: ctxLabel, thresholds: { warn: 0.7, bad: 0.9 } }, undefined, "context")
				: uiNode("progress", { value: ratio, label: ctxLabel }, undefined, "context"),
		);
	}

	const recent = sessionActivity(c, HUB_RECENT_ACTIVITY) ?? logActivity(c, HUB_RECENT_ACTIVITY);
	const rows: NativeUiNode[] = recent.map((a, i) =>
		uiNode(
			"row",
			{ role: "omp.hub.activity.row", gap: "sm", align: "baseline", actions: { click: "transcript" }, title: "Open transcript" },
			[
				text([span(clock(a.at), "mono dim")]),
				text([a.glyph]),
				text([span(a.name, "mono muted")]),
				text(a.summary || " ", { truncate: "end", grow: 1 }),
			],
			`r${i}`,
		),
	);
	if (rows.length === 0) rows.push(text([span("No response or tool activity yet", "dim")], undefined, "none"));
	out.push(uiNode("section", { head: "Recent activity", role: "omp.hub.activity" }, rows, "recentActivity"));
	return out;
}

/** Cheap change signature of everything the hub shows for `c` (roster row + preview). */
export function hubSignature(c: Child): string {
	const u = c.usage;
	const msgs = (c.session as { messages?: unknown[] } | undefined)?.messages;
	return [
		c.id,
		c.status,
		c.queued ? 1 : 0,
		c.blocked ? 1 : 0,
		c.phase ?? "",
		c.error ?? "",
		u.requests,
		u.cost,
		u.toolCount,
		u.contextTokens,
		u.input + u.output + u.cacheWrite,
		c.runningTools.size,
		c.lastTool?.id ?? "",
		c.activity.length,
		c.activity[c.activity.length - 1] ?? "",
		c.inbox.length,
		c.owned.length,
		c.finishedAt ?? 0,
		c.runStartedAt ?? 0,
		c.done?.merge?.status ?? "",
		c.worktree?.path ?? "",
		c.modelLabel,
		c.thinking,
		Array.isArray(msgs) ? msgs.length : -1,
	].join("\u0001");
}

export interface HubTranscriptView {
	id: string;
	child: Child | undefined;
	now: number;
	/** The agent's message components (describe boundaries), else a placeholder line. */
	body: { kind: "entries"; children: readonly NativeUiChild[] } | { kind: "note"; text: string; tone: string };
	/** Key of the end marker: a new key (entries added) scrolls the view to the end. */
	endKey: string;
	notice?: { text: string; tone: string };
	/** The message field; absent = read-only (killed). */
	input?: { text: string; cursor: number; multiline: boolean };
	expanded: boolean;
	hideThinking: boolean;
	/** ctrl+x was pressed (or Kill clicked) once: the next one kills. */
	killArmed: boolean;
	keys: { expand: string; thinking: string };
	/** The terminal draws these kinds. */
	progress: boolean;
	elapsed: boolean;
	editor: boolean;
}

/**
 * The transcript view (omp agent-transcript-viewer.ts #describe): the agent's meta with a top-right `esc`, its
 * usage and current step, the transcript (pi's own message components), the message field and the actions.
 * Scrolling is the terminal's; a new end marker brings the latest entry into view.
 */
export function hubTranscript(v: HubTranscriptView): NativeUiNode {
	const c = v.child;
	const children: NativeUiChild[] = [];
	const meta: NativeUiChild[] = [text([span(v.id, "strong")], undefined, "id")];
	if (c) {
		meta.push(node("badge", { text: hubStatusLabel(c), tone: hubStatusTone(c.status) }, undefined, "status"));
		const agent = c.agent.name?.trim();
		meta.push(text([span([agent, `of ${ownerName(c)}`].filter(Boolean).join(" · "), "dim")], { truncate: "end" }, "kind"));
		const model = shortModel(c.modelLabel);
		if (model) {
			const spans: TspSpan[] = [span(model, "muted")];
			if (c.thinking && c.thinking !== "off") spans.push(span(" · ", "dim"), span(c.thinking, thinkingToken(c.thinking) ?? "muted"));
			meta.push(text(spans, { truncate: "end" }, "model"));
		}
	}
	children.push(
		uiNode("row", { gap: "md", align: "center" }, [uiNode("row", { gap: "sm", align: "center", grow: 1, min: { w: 0 }, wrap: true }, meta, "meta"), hubEscButton("esc", "Back to the roster")], "top"),
	);

	if (c) {
		const u = c.usage;
		const stats: NativeUiChild[] = [];
		const win = c.contextWindow;
		if (v.progress && u.contextTokens > 0 && win && win > 0) {
			const ratio = Math.max(0, Math.min(1, u.contextTokens / win));
			stats.push(uiNode("progress", { value: ratio, label: `${fmtCount(u.contextTokens)} / ${fmtCount(win)} · ${Math.round(ratio * 100)}%`, max: { w: "24ch" } }, undefined, "ctx"));
		}
		const parts: TspSpan[] = [];
		const sep = () => {
			if (parts.length > 0) parts.push(span(" · ", "dim"));
		};
		if (u.toolCount) parts.push(span(plural(u.toolCount, "tool"), "dim"));
		if (u.requests) {
			sep();
			parts.push(span(`${fmtCount(u.requests)} req`, "dim"));
		}
		if (u.contextTokens > 0 && !(win && win > 0)) {
			sep();
			parts.push(span(`${fmtCount(u.contextTokens)} ctx`, "dim"));
		}
		if (u.cost > 0) {
			sep();
			parts.push(span(hubCost(u.cost), "warning"));
		}
		if (parts.length > 0) stats.push(text(parts, { truncate: "end" }, "usage"));
		const d = hubRunDuration(c, v.now);
		if (d !== undefined) {
			stats.push(c.status === "running" && v.elapsed ? node("elapsed", { age: d }, undefined, "time") : text([span(fmtDuration(d), "dim")], undefined, "time"));
		}
		if (stats.length > 0) children.push(uiNode("row", { gap: "md", align: "center", wrap: true }, stats, "stats"));

		const current = c.status === "running" ? hubCurrent(c, v.now, false) : undefined;
		if (current) {
			const row: NativeUiChild[] = [text([span("↳", "dim")]), text(current, { truncate: "end", grow: 1 })];
			const tool = hubRunningTool(c);
			if (tool && v.elapsed) row.push(node("elapsed", { age: Math.max(0, v.now - tool.startedAt) }));
			children.push(uiNode("row", { gap: "sm", align: "baseline" }, row, "current"));
		}
		if (c.error && c.status !== "running") children.push(text([span(flat(c.error), "error")], { wrap: "word", lines: 6 }, "error"));
	}

	if (v.body.kind === "entries") children.push(uiNode("col", { gap: "md", role: "omp.hub.transcript.body" }, v.body.children, "transcript"));
	else children.push(text([span(v.body.text, v.body.tone)], { wrap: "word" }, "placeholder"));
	if (v.notice) children.push(text([span(flat(v.notice.text), v.notice.tone)], { wrap: "word" }, "notice"));
	if (v.input) {
		const multiline = v.input.multiline && v.editor;
		children.push(
			uiNode(
				multiline ? "editor" : "input",
				{
					text: v.input.text,
					cursor: v.input.cursor,
					placeholder: `Message ${v.id} (steers it while it runs, wakes it when idle)`,
					sendable: true,
					...(multiline ? { maxLines: 8 } : { prompt: [span("›", "accent")] }),
				},
				undefined,
				"message",
			),
		);
	} else if (c) {
		children.push(text([span("Killed: the transcript is read-only.", "dim")], undefined, "readonly"));
	}

	const actions: NativeUiChild[] = [
		hubButton(v.expanded ? "Collapse tools" : "Expand tools", "expand", { keys: v.keys.expand }),
		hubButton(v.hideThinking ? "Show thinking" : "Hide thinking", "thinking", { keys: v.keys.thinking }),
		uiNode("spacer", { grow: 1 }, undefined, "fill"),
	];
	if (c && c.status !== "aborted") {
		const subtree = c.owned.length > 0 ? " and its subagents" : "";
		actions.push(
			hubButton(v.killArmed ? "Confirm kill" : "Kill", "kill", {
				keys: "ctrl+x",
				tone: "error",
				title: v.killArmed ? `Kill ${v.id}${subtree} now  ctrl+x` : `Kill ${v.id}${subtree} (asks again)  ctrl+x`,
			}),
		);
	}
	actions.push(hubButton("Close hub", "close", { keys: "ctrl+s" }));
	children.push(uiNode("row", { role: "omp.actions", gap: "sm", align: "center", wrap: true }, actions, "actions"));
	children.push({ k: "spacer", p: { size: "none" }, key: v.endKey, reveal: "end" });
	return uiNode("col", { gap: "md", role: "omp.hub.transcript" }, children);
}

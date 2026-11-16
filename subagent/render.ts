/**
 * TUI rendering in the style of oh-my-pi's task card (tui/src/tools/task.ts + agent-tree.ts):
 *   ⇶ Task · 3 agents
 *   ⠹ SwiftFalcon ⟨scout⟩ claude-opus-4-5:medium · 3 tools · 2 req · 1.2%/200k · $0.02 · 5.2s
 *     ↳ read: src/foo.ts
 *   ✓ CalmPanda [isolated] {} claude-opus-4-5 · 12 tools · 8 req · 3.4%/200k · $0.10 · 42.1s
 *     ↳ merged 3 files
 *     ↳ waiting for 1 subagent
 *     ├─ ✓ BoldOtter ⟨scout⟩ claude-opus-4-5 · 4 tools · 2 req · 8.0s
 *     └─ ⠹ KeenLynx ⟨scout⟩ claude-opus-4-5 · 1 tool · 1 req · 3.0s
 *          ↳ grep: TODO
 *   [1 succeeded · 1 running · 2 nested · 13 req · 42.1s]
 *
 * Everything here renders from immutable snapshots, so a component never changes its output unless
 * the owner rebuilds it (important for pi's main-screen TUI, where changing lines that scrolled
 * above the viewport forces a full redraw).
 */

import * as os from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { DEFAULT_AGENT } from "./agents.ts";
import { type Child, type ChildStatus, firstLine } from "./hub.ts";
import { type DoneInfo, fmtDuration, type MergeInfo, resultOutputFallback, type SubagentSummary } from "./prompts.ts";
import { formatStructuredData } from "./structured.ts";

export const COLLAPSED_AGENT_LIMIT = 4;
/** Nested subagents shown per level when collapsed (the rest fold into "… N more"). */
export const COLLAPSED_NESTED_LIMIT = 3;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SEP = " · ";

export type RowStatus = ChildStatus | "detached";

export interface RowSnapshot {
	id: string;
	agent: string;
	status: RowStatus;
	/** pending + waiting for a run permit (vs. still starting up). */
	queued?: boolean;
	index: number;
	model?: string;
	thinking?: string;
	toolCount: number;
	requests: number;
	contextTokens: number;
	contextWindow?: number;
	cost: number;
	durationMs?: number;
	tool?: { name: string; args: string; elapsedMs: number; running: boolean };
	lastText?: string;
	task: string;
	output?: string;
	error?: string;
	/** Nested subagents (spawned by this agent), in spawn order. */
	children?: RowSnapshot[];
	/** Turn ended while subagents run: number of active subagents it is waiting for. */
	waiting?: number;
	/** Runs in its own worktree. */
	isolated?: boolean;
	/** Has an output schema (result via `yield`). */
	structured?: boolean;
	/** Worktree merge outcome of its latest settled run. */
	merge?: MergeInfo;
	/** Latest validated structured result (expanded rows); `hasData` distinguishes a null payload. */
	data?: unknown;
	hasData?: boolean;
	/** Hub-side work in progress (e.g. merging worktree changes). */
	phase?: string;
}

/** Persisted per-item spawn info (tool result details), used when live state is gone (reload/resume). */
export interface SpawnedItem {
	id: string;
	agent: string;
	task: string;
	model?: string;
	thinking?: string;
	isolated?: boolean;
	structured?: boolean;
}

export interface TaskDetails {
	hub: string;
	ids: string[];
	items: SpawnedItem[];
	errors: string[];
	startedAt: number;
}

/** Fixed-content component: lines are built once per width and never change on their own. */
export class LinesComponent implements Component {
	private cache?: { width: number; lines: string[] };
	/** Called with every rendered frame's lines (used for on-screen probing). */
	onRender?: (lines: string[]) => void;

	constructor(private readonly build: (width: number) => string[]) {}

	render(width: number): string[] {
		if (!this.cache || this.cache.width !== width) this.cache = { width, lines: this.build(width) };
		this.onRender?.(this.cache.lines);
		return this.cache.lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

export const EMPTY_COMPONENT: Component = { render: () => [], invalidate: () => {} };

// ---------------------------------------------------------------------------------------------
// Formatting helpers

export function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function shortModel(label: string | undefined): string {
	if (!label) return "";
	let id = label.split("/").pop() ?? label;
	// Bedrock-style ids: "us.anthropic.claude-opus-4-5" -> "claude-opus-4-5"
	id = id.replace(/^(?:(?:us|eu|apac|global|jp|au|ca)\.)?(?:anthropic|amazon|meta|mistral|cohere|deepseek|openai|qwen|google|writer)\./, "");
	return id.length > 28 ? `${id.slice(0, 27)}…` : id;
}

function modelBadge(row: Pick<RowSnapshot, "model" | "thinking">, theme: Theme): string {
	const m = shortModel(row.model);
	if (!m) return "";
	const t = row.thinking && row.thinking !== "off" ? `:${row.thinking}` : "";
	return ` ${theme.fg("muted", `${m}${t}`)}`;
}

/** Dim `⟨agent⟩` badge for a non-default agent type; empty for the generic `task` worker. */
export function agentBadge(agent: string | undefined, theme: Theme): string {
	const a = agent?.trim();
	if (!a || a === DEFAULT_AGENT) return "";
	return ` ${theme.fg("dim", `⟨${a}⟩`)}`;
}

/** ` [isolated]` / ` {}` badges (worktree isolation, structured output). */
export function featureBadges(row: { isolated?: boolean; structured?: boolean }, theme: Theme): string {
	let out = "";
	if (row.isolated) out += ` ${theme.fg("muted", "[isolated]")}`;
	if (row.structured) out += ` ${theme.fg("muted", "{}")}`;
	return out;
}

function tildify(p: string): string {
	const home = os.homedir();
	return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Parts of the merge line of a settled isolated row: `merged 3 files` / `⚠ merge conflict — patch: <path>` / … */
export function mergeParts(merge: MergeInfo | undefined): { color: "success" | "dim" | "warning" | "error"; label: string; path?: string } | undefined {
	if (!merge) return undefined;
	const n = merge.files.length;
	const files = `${n} file${n === 1 ? "" : "s"}`;
	const patch = merge.patchFile ? tildify(merge.patchFile) : undefined;
	switch (merge.status) {
		case "applied":
			return { color: "success", label: `merged ${files}` };
		case "empty":
			return { color: "dim", label: "no changes to merge" };
		case "conflict":
			return { color: "warning", label: patch ? "⚠ merge conflict — patch:" : "⚠ merge conflict — patch not saved", path: patch };
		case "unapplied":
			return { color: "warning", label: `⚠ ${files} not applied — patch:`, path: patch };
		case "error":
			if (patch) return { color: "error", label: "⚠ merge failed — patch:", path: patch };
			return merge.worktree
				? { color: "error", label: "⚠ changes NOT saved — worktree kept:", path: tildify(merge.worktree) }
				: { color: "error", label: "⚠ merge failed" };
	}
}

/** Merge line (+ the path on a continuation line, tail kept, when it does not fit). */
function mergeLine(row: RowSnapshot, indent: string, theme: Theme, width: number): string[] {
	if (row.status === "running" || row.status === "pending") return [];
	const p = mergeParts(row.merge);
	if (!p) return [];
	const head = `${indent}${theme.fg("dim", "↳")} ${theme.fg(p.color, p.label)}`;
	if (!p.path) return [clip(head, width)];
	const inline = `${head} ${theme.fg(p.color, p.path)}`;
	if (!Number.isFinite(width) || visibleWidth(inline) <= width) return [inline];
	const cont = `${indent}  `;
	const room = Math.max(10, width - visibleWidth(cont));
	const shown = p.path.length > room ? `…${p.path.slice(p.path.length - room + 1)}` : p.path;
	return [clip(head, width), clip(`${cont}${theme.fg("dim", shown)}`, width)];
}

/** Expanded "Data" (pretty JSON, capped) or "Output" section of a row. */
function resultSection(row: RowSnapshot, indent: string, width: number, theme: Theme, max: number): string[] {
	if (row.hasData) return sectionLines("Data", formatStructuredData(row.data, 4000), indent, width, theme, max);
	if (row.output === undefined) return [];
	const out =
		row.output.trim() ||
		(row.status === "running" || row.status === "pending" ? "" : resultOutputFallback({ output: "", error: row.error, requests: row.requests }));
	return sectionLines("Output", out, indent, width, theme, max);
}

export function statusIcon(status: RowStatus, theme: Theme, frame = 0): string {
	switch (status) {
		case "running":
			return theme.fg("accent", SPINNER[frame % SPINNER.length]!);
		case "pending":
			return theme.fg("muted", "◌");
		case "idle":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("error", "⊘");
		default:
			return theme.fg("dim", "○");
	}
}

/** Spend of the nested subagents below `row` (all depths), excluding the row itself. */
export function nestedCostOf(row: Pick<RowSnapshot, "children">): number {
	let sum = 0;
	for (const c of row.children ?? []) sum += c.cost + nestedCostOf(c);
	return sum;
}

/**
 * `N tools · N req · ctx · $cost` (agent-tree.ts formatAgentStatRun). `$cost` is the agent's own spend; an
 * agent with nested subagents shows theirs as `(+x.xx)` (OMP status-line style), so a row never hides
 * what its subtree cost.
 */
export function statRun(
	s: Pick<RowSnapshot, "toolCount" | "requests" | "contextTokens" | "contextWindow" | "cost"> & Partial<Pick<RowSnapshot, "children">>,
	theme: Theme,
): string {
	let line = "";
	if (s.toolCount) line += `${theme.fg("dim", SEP)}${theme.fg("dim", `${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`)}`;
	if (s.requests) line += `${theme.fg("dim", SEP)}${theme.fg("dim", `${s.requests} req`)}`;
	if (s.contextTokens > 0) {
		const ctx =
			s.contextWindow && s.contextWindow > 0
				? `${((s.contextTokens / s.contextWindow) * 100).toFixed(1)}%/${fmtTokens(s.contextWindow)}`
				: fmtTokens(s.contextTokens);
		line += `${theme.fg("dim", SEP)}${theme.fg("dim", ctx)}`;
	}
	const nested = nestedCostOf(s);
	if (s.cost > 0 || nested > 0) {
		line += `${theme.fg("dim", SEP)}${theme.fg("warning", `$${s.cost.toFixed(2)}`)}`;
		if (nested > 0) line += ` ${theme.fg("dim", `(+${nested.toFixed(2)})`)}`;
	}
	return line;
}

function statusBadge(row: RowSnapshot, theme: Theme): string {
	switch (row.status) {
		case "pending":
			return ` ${theme.fg("muted", row.queued ? "queued" : "starting")}`;
		case "failed":
			return ` ${theme.fg("error", "failed")}`;
		case "aborted":
			return ` ${theme.fg("error", "aborted")}`;
		case "detached":
			return ` ${theme.fg("dim", "detached")}`;
		default:
			return "";
	}
}

function clip(line: string, width: number): string {
	return Number.isFinite(width) ? truncateToWidth(line, Math.max(1, width), "…") : line;
}

function flat(text: string): string {
	return text.replace(/\t/g, "  ").replace(/\s+/g, " ").trim();
}

/** One agent row: icon, bold Name, ⟨agent⟩, model badge, status badge, stats, duration. */
export function formatRow(row: RowSnapshot, theme: Theme, width: number, frame: number, opts: { model?: boolean } = {}): string {
	const live = row.status === "running" || row.status === "pending";
	const nameColor = row.status === "idle" ? "text" : row.status === "failed" || row.status === "aborted" ? "error" : live ? "accent" : "muted";
	let line = `${statusIcon(row.status, theme, frame)} ${theme.fg(nameColor, theme.bold(row.id))}`;
	line += agentBadge(row.agent, theme);
	line += featureBadges(row, theme);
	if (opts.model !== false) line += modelBadge(row, theme);
	line += statusBadge(row, theme);
	if (row.status !== "pending" && row.status !== "detached") line += statRun(row, theme);
	if (row.durationMs !== undefined && row.durationMs > 0) line += `${theme.fg("dim", SEP)}${theme.fg("dim", fmtDuration(row.durationMs))}`;
	if (row.status === "detached" && row.task) line += theme.fg("dim", ` ${row.task}`);
	return clip(line, width);
}

/** `↳ tool: args` (current tool, else most recent tool / text) for running rows; error for failed rows. */
export function activityText(row: RowSnapshot, theme: Theme): string | undefined {
	if (row.status === "failed" && row.error) return theme.fg("error", flat(row.error));
	if (row.status !== "running") return undefined;
	if (row.phase) return theme.fg("muted", row.phase);
	if (row.waiting) return theme.fg("muted", `waiting for ${row.waiting} subagent${row.waiting === 1 ? "" : "s"}`);
	// Resuming after its subagents reported back, but every run slot at its level is taken.
	if (row.queued) return theme.fg("muted", "queued for a run slot");
	if (row.tool) {
		let t = theme.fg(row.tool.running ? "muted" : "dim", row.tool.name);
		if (row.tool.args) t += `${theme.fg("dim", ":")} ${theme.fg("dim", flat(row.tool.args))}`;
		if (row.tool.running && row.tool.elapsedMs > 5000) t += `${theme.fg("dim", SEP)}${theme.fg("warning", fmtDuration(row.tool.elapsedMs))}`;
		return t;
	}
	if (row.lastText) return theme.fg("dim", flat(row.lastText));
	return theme.fg("dim", "starting…");
}

function sectionLines(label: string, text: string, indent: string, width: number, theme: Theme, max: number): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const out = [clip(`${indent}${theme.fg("muted", label)}`, width)];
	const inner = `${indent}  `;
	const wrapped: string[] = [];
	for (const raw of trimmed.split("\n")) {
		const line = raw.replace(/\t/g, "  ");
		if (!Number.isFinite(width)) wrapped.push(line);
		else wrapped.push(...(line ? wrapTextWithAnsi(line, Math.max(10, width - visibleWidth(inner))) : [""]));
	}
	for (const l of wrapped.slice(0, max)) out.push(`${inner}${theme.fg("dim", l)}`);
	if (wrapped.length > max) out.push(`${inner}${theme.fg("dim", `… ${wrapped.length - max} more lines`)}`);
	return out;
}

// ---------------------------------------------------------------------------------------------
// Snapshots

function countActive(c: Child): number {
	let n = 0;
	for (const o of c.owned) n += (o.status === "running" || o.status === "pending" ? 1 : 0) + countActive(o);
	return n;
}

/** Live row of `c`, including its nested subagents (recursively). */
export function snapshotChild(c: Child, index: number, now: number, withOutput: boolean): RowSnapshot {
	let tool: RowSnapshot["tool"];
	let latest: { name: string; args: string; startedAt: number } | undefined;
	for (const t of c.runningTools.values()) if (!latest || t.startedAt >= latest.startedAt) latest = t;
	if (latest) tool = { name: latest.name, args: latest.args, elapsedMs: now - latest.startedAt, running: true };
	else if (c.lastTool) tool = { name: c.lastTool.name, args: c.lastTool.args, elapsedMs: 0, running: false };
	let durationMs: number | undefined;
	if (c.status === "running" && c.runStartedAt) durationMs = now - c.runStartedAt;
	else if (c.status !== "pending") durationMs = c.done?.durationMs ?? (c.finishedAt && c.runStartedAt ? c.finishedAt - c.runStartedAt : undefined);
	return {
		id: c.id,
		agent: c.agent.name,
		status: c.status,
		queued: c.queued,
		index,
		model: c.modelLabel,
		thinking: c.thinking,
		toolCount: c.usage.toolCount,
		requests: c.usage.requests,
		contextTokens: c.usage.contextTokens,
		contextWindow: c.contextWindow,
		cost: c.usage.cost,
		durationMs,
		tool,
		lastText: c.lastText,
		task: c.task,
		output: withOutput ? (c.session?.getLastAssistantText?.() ?? c.done?.output ?? "") : undefined,
		error: c.error,
		children: c.owned.length ? c.owned.map((o, i) => snapshotChild(o, i, now, withOutput)) : undefined,
		waiting: c.blocked ? countActive(c) : undefined,
		isolated: c.isolated,
		structured: !!c.schema,
		merge: c.done?.merge,
		...(withOutput && c.status !== "running" && c.done?.data !== undefined ? { data: c.done.data, hasData: true } : {}),
		phase: c.phase,
	};
}

/** Row of a persisted subagent summary (delivered result cards). */
export function snapshotSummary(s: SubagentSummary, index: number): RowSnapshot {
	return {
		id: s.id,
		agent: s.agent,
		status: s.status,
		index,
		model: s.model,
		thinking: s.thinking,
		toolCount: s.toolCount,
		requests: s.requests,
		contextTokens: s.contextTokens,
		contextWindow: s.contextWindow,
		cost: s.cost,
		durationMs: s.durationMs,
		task: s.task,
		isolated: s.isolated,
		structured: s.structured,
		merge: s.merge,
		children: s.subagents?.length ? s.subagents.map(snapshotSummary) : undefined,
	};
}

/** Every row below `row`. */
export function nestedRows(row: RowSnapshot, out: RowSnapshot[] = []): RowSnapshot[] {
	for (const c of row.children ?? []) {
		out.push(c);
		nestedRows(c, out);
	}
	return out;
}

const TREE = { branch: "├─ ", last: "└─ ", vertical: "│  ", blank: "   " };

/**
 * Nested subagents of a row as a tree (OMP renderNestedTaskTree): `indent` is the parent row's
 * continuation prefix. Same row format as top-level rows; collapsed shows the last
 * COLLAPSED_NESTED_LIMIT per level (live rows last) with a "… N more" line.
 */
export function nestedTreeLines(
	children: RowSnapshot[] | undefined,
	indent: string,
	theme: Theme,
	width: number,
	frame: number,
	expanded: boolean,
	opts: { activity?: boolean } = {},
): string[] {
	if (!children?.length) return [];
	const ordered = orderRows(children);
	const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_NESTED_LIMIT));
	const hidden = ordered.slice(0, ordered.length - visible.length);
	const lines: string[] = [];
	const glyph = (t: string) => theme.fg("dim", t);
	if (hidden.length > 0) {
		const ok = hidden.filter((r) => r.status === "idle").length;
		const bad = hidden.filter((r) => r.status === "failed" || r.status === "aborted").length;
		const parts = [ok ? `${ok} done` : "", bad ? `${bad} failed` : ""].filter(Boolean);
		const more = `… ${hidden.length} more agent${hidden.length === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
		lines.push(clip(`${indent}${glyph(TREE.branch)}${theme.fg("dim", more)}`, width));
	}
	visible.forEach((row, i) => {
		const last = i === visible.length - 1;
		const cont = `${indent}${glyph(last ? TREE.blank : TREE.vertical)}`;
		lines.push(clip(`${indent}${glyph(last ? TREE.last : TREE.branch)}${formatRow(row, theme, Number.POSITIVE_INFINITY, frame)}`, width));
		const act = opts.activity !== false ? activityText(row, theme) : undefined;
		if (act) lines.push(clip(`${cont}  ${theme.fg("dim", "↳")} ${act}`, width));
		lines.push(...mergeLine(row, `${cont}  `, theme, width));
		if (expanded) {
			lines.push(...sectionLines("Task", row.task, `${cont}  `, width, theme, 4));
			if (row.hasData || row.output?.trim()) lines.push(...resultSection(row, `${cont}  `, width, theme, 8));
		}
		lines.push(...nestedTreeLines(row.children, `${cont}  `, theme, width, frame, expanded, opts));
	});
	return lines;
}

export function snapshotDetached(item: SpawnedItem, index: number): RowSnapshot {
	return {
		id: item.id,
		agent: item.agent,
		status: "detached",
		index,
		model: item.model,
		thinking: item.thinking,
		toolCount: 0,
		requests: 0,
		contextTokens: 0,
		cost: 0,
		task: item.task,
		isolated: item.isolated,
		structured: item.structured,
	};
}

export interface CardSnapshot {
	rows: RowSnapshot[];
	errors: string[];
	context?: string;
	wallMs: number;
	frame: number;
	isError: boolean;
	fallbackText?: string;
}

/** Finished rows first (by runtime), then live rows in dispatch order — rows never reshuffle once settled. */
function orderRows(rows: RowSnapshot[]): RowSnapshot[] {
	const finished = rows.filter((r) => r.status !== "running" && r.status !== "pending" && r.status !== "detached");
	const rest = rows.filter((r) => !finished.includes(r));
	finished.sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0) || a.index - b.index);
	return [...finished, ...rest];
}

export function headerLine(count: number, state: "running" | "success" | "error" | "neutral", theme: Theme, nested = 0): string {
	const icon =
		state === "success"
			? theme.fg("success", "✓")
			: state === "error"
				? theme.fg("error", "✗")
				: state === "running"
					? theme.fg("accent", "⇶")
					: theme.fg("muted", "⇶");
	let meta = count > 0 ? theme.fg("muted", `${SEP}${count} ${count === 1 ? "agent" : "agents"}`) : "";
	if (nested > 0) meta += theme.fg("dim", `${SEP}${nested} nested`);
	return `${icon} ${theme.fg("toolTitle", theme.bold("Task"))}${meta}`;
}

function contextLines(context: string | undefined, width: number, expanded: boolean, theme: Theme): string[] {
	const text = context?.trim();
	if (!text) return [];
	const lines = text.split("\n");
	const max = expanded ? 40 : 2;
	const out = lines.slice(0, max).map((l) => clip(theme.fg("muted", l.replace(/\t/g, "  ")), width));
	if (lines.length > max) out.push(clip(theme.fg("dim", `… ${lines.length - max} more context lines`), width));
	return out;
}

export function buildCardLines(s: CardSnapshot, theme: Theme, width: number, expanded: boolean): string[] {
	const active = s.rows.filter((r) => r.status === "running" || r.status === "pending").length;
	const failed = s.rows.filter((r) => r.status === "failed").length;
	const aborted = s.rows.filter((r) => r.status === "aborted").length;
	const succeeded = s.rows.filter((r) => r.status === "idle").length;
	const detached = s.rows.every((r) => r.status === "detached");
	const state =
		s.rows.length === 0
			? s.isError
				? "error"
				: "neutral"
			: active > 0
				? "running"
				: detached
					? "neutral"
					: failed + aborted > 0 || s.errors.length > 0
						? "error"
						: "success";
	const nested = s.rows.flatMap((r) => nestedRows(r));
	const lines = [clip(headerLine(s.rows.length, state, theme, nested.length), width)];
	lines.push(...contextLines(s.context, width, expanded, theme));

	const ordered = orderRows(s.rows);
	const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
	const hidden = ordered.slice(0, ordered.length - visible.length);
	if (hidden.length > 0) {
		const ok = hidden.filter((r) => r.status === "idle").length;
		const bad = hidden.filter((r) => r.status === "failed" || r.status === "aborted").length;
		const parts = [ok ? theme.fg("success", `${ok} done`) : "", bad ? theme.fg("error", `${bad} failed`) : ""].filter(Boolean);
		lines.push(clip(`${theme.fg("dim", `… ${hidden.length} more agent${hidden.length === 1 ? "" : "s"}`)}${parts.length ? ` ${theme.fg("dim", "(")}${parts.join(theme.fg("dim", ", "))}${theme.fg("dim", ")")}` : ""}`, width));
	}
	for (const row of visible) {
		lines.push(formatRow(row, theme, width, s.frame));
		const act = activityText(row, theme);
		if (act) lines.push(clip(`  ${theme.fg("dim", "↳")} ${act}`, width));
		lines.push(...mergeLine(row, "  ", theme, width));
		if (expanded) {
			lines.push(...sectionLines("Task", row.task, "  ", width, theme, 20));
			lines.push(...resultSection(row, "  ", width, theme, 20));
		}
		lines.push(...nestedTreeLines(row.children, "  ", theme, width, s.frame, expanded));
	}
	for (const e of s.errors) lines.push(clip(`${theme.fg("error", "✗")} ${theme.fg("error", flat(e))}`, width));

	if (s.rows.length === 0 && s.fallbackText) {
		for (const l of s.fallbackText.split("\n").slice(0, 8)) lines.push(clip(theme.fg(s.isError ? "error" : "dim", l), width));
	} else if (s.rows.length > 0) {
		const parts: string[] = [];
		if (aborted) parts.push(theme.fg("error", `${aborted} aborted`));
		if (succeeded) parts.push(theme.fg("success", `${succeeded} succeeded`));
		if (failed) parts.push(theme.fg("error", `${failed} failed`));
		const running = s.rows.filter((r) => r.status === "running").length;
		const queued = s.rows.filter((r) => r.status === "pending" && r.queued).length;
		const starting = s.rows.filter((r) => r.status === "pending" && !r.queued).length;
		if (running) parts.push(theme.fg("accent", `${running} running`));
		if (starting) parts.push(theme.fg("muted", `${starting} starting`));
		if (queued) parts.push(theme.fg("muted", `${queued} queued`));
		if (detached) parts.push(theme.fg("dim", "session ended"));
		if (nested.length) parts.push(theme.fg("dim", `${nested.length} nested`));
		const req = [...s.rows, ...nested].reduce((n, r) => n + r.requests, 0);
		if (req) parts.push(theme.fg("dim", `${req} req`));
		// Everything the call spent (top-level agents + their subtrees); the same amount pi adds to the footer total.
		const total = [...s.rows, ...nested].reduce((n, r) => n + r.cost, 0);
		if (total > 0 && s.rows.length + nested.length > 1) parts.push(theme.fg("warning", `$${total.toFixed(2)} total`));
		if (!detached) parts.push(theme.fg("dim", fmtDuration(s.wallMs)));
		lines.push(clip(`${theme.fg("dim", "[")}${parts.join(theme.fg("dim", SEP))}${theme.fg("dim", "]")}`, width));
	}
	return lines;
}

/** Streaming call preview: header, context, one `• Name: first line ⟨agent⟩` per item (cap 4). */
export function buildCallLines(args: any, theme: Theme, width: number, expanded: boolean): string[] {
	const items: any[] = Array.isArray(args?.tasks)
		? args.tasks.filter((t: unknown) => t && typeof t === "object")
		: args && (typeof args.task === "string" || typeof args.name === "string")
			? [args]
			: [];
	const lines = [clip(headerLine(items.length, "running", theme), width)];
	lines.push(...contextLines(typeof args?.context === "string" ? args.context : undefined, width, expanded, theme));
	const bullet = theme.fg("dim", "•");
	const cap = expanded ? items.length : Math.min(items.length, COLLAPSED_AGENT_LIMIT);
	for (let i = 0; i < cap; i++) {
		const item = items[i];
		const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `#${i + 1}`;
		let line = `${bullet} ${theme.fg("accent", theme.bold(name))}`;
		const brief = typeof item.task === "string" ? firstLine(item.task, 200) : "";
		if (brief) line += `${theme.fg("dim", ":")} ${theme.fg("muted", brief)}`;
		line += agentBadge(typeof item.agent === "string" ? item.agent : undefined, theme);
		const schema = item.outputSchema;
		line += featureBadges(
			{ isolated: item.isolated === true || item.isolated === "true", structured: schema !== undefined && schema !== null && schema !== false && schema !== "" },
			theme,
		);
		lines.push(clip(line, width));
	}
	if (cap < items.length) lines.push(clip(`${bullet} ${theme.fg("dim", `… ${items.length - cap} more agent${items.length - cap === 1 ? "" : "s"}`)}`, width));
	return lines;
}

// ---------------------------------------------------------------------------------------------
// Delivered result message

/** Accepts current DoneInfo and the legacy `subagent-result` shape ({ childId, stats }). */
export function buildResultMessageLines(d: Partial<DoneInfo> & { childId?: string; stats?: string }, theme: Theme, width: number, expanded: boolean, hint: string): string[] {
	const status: RowStatus = d.status === "completed" ? "idle" : d.status === "failed" ? "failed" : d.status === "aborted" ? "aborted" : "detached";
	const row: RowSnapshot = {
		id: d.id ?? d.childId ?? "agent",
		agent: d.agent ?? DEFAULT_AGENT,
		status,
		index: 0,
		model: d.model,
		thinking: d.thinking,
		toolCount: d.toolCount ?? 0,
		requests: d.requests ?? 0,
		contextTokens: d.contextTokens ?? 0,
		contextWindow: d.contextWindow,
		cost: d.cost ?? 0,
		durationMs: d.durationMs,
		task: d.task ?? "",
		isolated: d.isolated,
		structured: d.structured,
		merge: d.merge,
		// Its subagents as they were when it settled (all settled by then); also makes the row's `(+nested)` cost visible.
		children: d.subagents?.length ? d.subagents.map(snapshotSummary) : undefined,
	};
	let head = formatRow(row, theme, Number.POSITIVE_INFINITY, 0);
	if (d.stats) head += theme.fg("dim", ` ${d.stats}`);
	const lines = [clip(head, width)];
	if (row.task) lines.push(clip(`  ${theme.fg("dim", "↳")} ${theme.fg("dim", flat(row.task))}`, width));
	if (d.status === "failed" && d.error && d.output?.trim()) lines.push(clip(`  ${theme.fg("error", flat(d.error))}`, width));
	lines.push(...mergeLine(row, "  ", theme, width));
	lines.push(...nestedTreeLines(row.children, "  ", theme, width, 0, expanded, { activity: false }));
	if (expanded) return lines; // caller renders the full body as Markdown
	const body =
		d.data !== undefined
			? formatStructuredData(d.data, 2000)
			: resultOutputFallback({ output: d.output ?? "", error: d.error, requests: d.requests ?? 0 });
	const max = 6;
	const wrapped = body.split("\n").map((l) => l.replace(/\t/g, "  "));
	for (const l of wrapped.slice(0, max)) lines.push(clip(`  ${theme.fg("toolOutput", l)}`, width));
	if (wrapped.length > max) lines.push(clip(`  ${theme.fg("muted", `… ${wrapped.length - max} more lines`)}${hint ? ` ${hint}` : ""}`, width));
	return lines;
}

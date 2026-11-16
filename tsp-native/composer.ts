/**
 * The native composer: pi's prompt editor as oh-my-pi's chat bar (omp
 * `CustomEditor.describeLayout` + `#describeComposerControls`, the status
 * line's `describeComposerFacts`). A `col` with role `omp.editor`
 * (`omp.editor.bash` for a `!` draft; tone `pending` while a turn runs) over
 *
 * - the context meter (`omp.composer.context`) along its top edge,
 * - the attachment chips other extensions register (shared/composer-slots.ts),
 * - the `omp.composer.line` row: the bash mode chip and the `editor` input,
 * - the autocomplete list while it is open: omp's caret-anchored overlay in
 *   `layer` (see Autocomplete below), else inline under the line,
 * - the `omp.composer.bar`: the model chip (`omp.composer.model`, the
 *   thinking level as its `effort` glyph), the facts (`omp.composer.extras`:
 *   cwd, git branch, session name, extension statuses), the session cost
 *   (`omp.composer.usage`, token totals in its tooltip), then send
 *   (`omp.composer.send`) or Stop (`omp.composer.stop`) while a turn runs.
 *
 * The facts come from pi's FooterComponent (its `session`, `footerData` and
 * `getSessionStats()`); while the composer carries them the footer itself
 * describes as hidden. Clicks come back as `status.model`, `thinking.cycle`,
 * `thinking.set` (a level picked from the terminal's effort menu, as the
 * action's `value`), `submit` and `interrupt` actions (omp's names).
 *
 * No runtime imports from describers.ts (it imports this module).
 */
import type { Component } from "@earendil-works/pi-tui";
import { composerAttachments, isComposerHosted, setComposerHosted } from "../shared/composer-slots.ts";
import { col, compact, type DescribeContext, type NativeChild, type NativeNode, node, row, span, text } from "./node.ts";
import { hasStyle, lineToSpans } from "./spans.ts";
import type { TspProps, TspSpan } from "./wire.ts";

/** Loose view of private component state. */
type Any = Record<string, any>;

// ── Formatting ──────────────────────────────────────────────────────────

/** pi's footer `formatTokens`. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** pi's footer `formatCwdForFooter`: the home directory as `~`. */
function shortCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const base = home.replace(/[\\/]+$/, "");
	if (cwd === base) return "~";
	if (cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`)) return `~${cwd.slice(base.length)}`;
	return cwd;
}

/** The model id without its region/vendor prefixes and Bedrock version tail (`us.anthropic.claude-opus-5-5` → `claude-opus-5-5`). */
export function shortModelId(id: string): string {
	let out = id.slice(id.lastIndexOf("/") + 1);
	const parts = out.split(".");
	while (parts.length > 1 && /^[a-z]+$/.test(parts[0]!)) parts.shift();
	out = parts.join(".").replace(/-v\d+(?::\d+)?$/, "");
	return out || id;
}

const KEY_NAMES: Readonly<Record<string, string>> = {
	ctrl: "Ctrl",
	shift: "Shift",
	alt: "Alt",
	meta: "Meta",
	super: "Super",
	cmd: "Cmd",
	escape: "Esc",
	esc: "Esc",
	enter: "Enter",
	return: "Enter",
	tab: "Tab",
	space: "Space",
	backspace: "Backspace",
	delete: "Del",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
};

/** A key id (`shift+tab`, `ctrl+l`) as a tooltip hint (`Shift+Tab`, `Ctrl+L`). */
export function keyLabel(key: string): string {
	return key
		.split("+")
		.map((part) => {
			const named = KEY_NAMES[part.toLowerCase()];
			if (named) return named;
			return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join("+");
}

function sanitizeStatus(value: string): string {
	return value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function finite(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ── Facts ───────────────────────────────────────────────────────────────

/** What the composer shows of pi's footer, as primitives (the same object while none changed). */
export interface ComposerFacts {
	readonly modelId: string | undefined;
	readonly modelName: string | undefined;
	readonly provider: string | undefined;
	readonly routedId: string | undefined;
	readonly routedThinking: string | undefined;
	/** The thinking level; undefined when the model doesn't reason. */
	readonly thinking: string | undefined;
	/** Context share used (0–100); null when unknown (right after a compaction). */
	readonly percent: number | null;
	readonly tokens: number | null;
	readonly window: number;
	readonly autoCompact: boolean;
	/** Tokens kept free before auto-compaction fires (pi's `compaction.reserveTokens`). */
	readonly reserve: number | undefined;
	readonly cwd: string;
	readonly branch: string | undefined;
	readonly sessionName: string | undefined;
	/** Extension statuses (`ctx.ui.setStatus`), sorted by key. */
	readonly statuses: readonly (readonly [key: string, text: string])[];
	readonly cost: number;
	readonly subscription: boolean;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cacheHit: number | undefined;
}

const factsMemo = new WeakMap<object, { sig: readonly unknown[]; facts: ComposerFacts }>();

function sameSig(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x !== y && !(typeof x === "number" && typeof y === "number" && Number.isNaN(x) && Number.isNaN(y))) return false;
	}
	return true;
}

/** The facts of a pi FooterComponent (`session`, `footerData`, `getSessionStats()`); undefined without a session. */
export function composerFacts(footer: Any): ComposerFacts | undefined {
	const session: Any | undefined = footer.session;
	const data: Any | undefined = footer.footerData;
	if (!session || !data) return undefined;
	const state: Any = session.state ?? {};
	const model: Any | undefined = state.model;
	const stats: Any = typeof footer.getSessionStats === "function" ? (footer.getSessionStats() ?? {}) : {};
	const usage: Any = stats.usageTotals ?? {};
	const context: Any | undefined = stats.contextUsage;
	const routed: Any | undefined = session.routedModel;
	const window = finite(context?.contextWindow ?? model?.contextWindow);
	// As pi's footer: no usage yet reads 0%, a known-unknown (after compaction) reads "?".
	const percent = context === undefined || context === null ? 0 : typeof context.percent === "number" ? context.percent : null;
	const tokens = typeof context?.tokens === "number" ? context.tokens : null;
	const autoCompact = footer.autoCompactEnabled !== false;
	let reserve: number | undefined;
	if (autoCompact) {
		try {
			const value = session.settingsManager?.getCompactionReserveTokens?.(routed?.model ?? model);
			if (typeof value === "number" && Number.isFinite(value)) reserve = value;
		} catch {
			// an invalid setting: no compaction mark
		}
	}
	const sessionManager: Any | undefined = session.sessionManager;
	const cwd = String(sessionManager?.getCwd?.() ?? "");
	const branchValue: unknown = data.getGitBranch?.();
	const branch = typeof branchValue === "string" && branchValue ? branchValue : undefined;
	const nameValue: unknown = sessionManager?.getSessionName?.();
	const sessionName = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : undefined;
	const statusMap: unknown = data.getExtensionStatuses?.();
	const statuses: [string, string][] = [];
	if (statusMap instanceof Map) {
		for (const [key, value] of statusMap) {
			const clean = sanitizeStatus(String(value ?? ""));
			if (clean) statuses.push([String(key), clean]);
		}
		statuses.sort(([a], [b]) => a.localeCompare(b));
	}
	let subscription = false;
	if (model) {
		try {
			subscription = model.provider === "kimi-coding" || session.modelRuntime?.isUsingSubscription?.(model.provider) === true;
		} catch {
			subscription = false;
		}
	}
	const thinking = model?.reasoning ? String(state.thinkingLevel || "off") : undefined;
	const cacheHit = typeof stats.latestCacheHitRate === "number" ? stats.latestCacheHitRate : undefined;
	const sig: unknown[] = [
		model?.id,
		model?.name,
		model?.provider,
		routed?.model?.id,
		routed?.thinkingLevel,
		thinking,
		percent,
		tokens,
		window,
		autoCompact,
		reserve,
		cwd,
		branch,
		sessionName,
		statuses.map(([k, v]) => `${k}\u0001${v}`).join("\u0000"),
		finite(usage.cost),
		subscription,
		finite(usage.input),
		finite(usage.output),
		finite(usage.cacheRead),
		finite(usage.cacheWrite),
		cacheHit,
	];
	const memo = factsMemo.get(footer);
	if (memo && sameSig(memo.sig, sig)) return memo.facts;
	const facts: ComposerFacts = {
		modelId: typeof model?.id === "string" ? model.id : undefined,
		modelName: typeof model?.name === "string" ? model.name : undefined,
		provider: typeof model?.provider === "string" ? model.provider : undefined,
		routedId: typeof routed?.model?.id === "string" ? routed.model.id : undefined,
		routedThinking: typeof routed?.thinkingLevel === "string" ? routed.thinkingLevel : undefined,
		thinking,
		percent,
		tokens,
		window,
		autoCompact,
		reserve,
		cwd,
		branch,
		sessionName,
		statuses,
		cost: finite(usage.cost),
		subscription,
		input: finite(usage.input),
		output: finite(usage.output),
		cacheRead: finite(usage.cacheRead),
		cacheWrite: finite(usage.cacheWrite),
		cacheHit,
	};
	factsMemo.set(footer, { sig, facts });
	return facts;
}

/** A turn, compaction, retry or `!` command is running in the footer's session (Stop can cancel it). */
export function sessionRunning(footer: Any | undefined): boolean {
	const session: Any | undefined = footer?.session;
	if (!session) return false;
	return session.isStreaming === true || session.isCompacting === true || session.isBashRunning === true || session.isRetrying === true;
}

// ── Locating the footer ─────────────────────────────────────────────────

/** Per TUI: the containers from a TUI child down to the footer, the footer last. */
const footerPaths = new WeakMap<object, readonly Any[]>();
/** How deep below the TUI's children the footer is looked for; containers wider than this aren't searched (the transcript). */
const SEARCH_DEPTH = 4;
const SEARCH_WIDTH = 16;

function mounted(tui: Any, path: readonly Any[]): boolean {
	let siblings: unknown = tui.children;
	for (const component of path) {
		if (!Array.isArray(siblings) || !siblings.includes(component)) return false;
		siblings = component.children;
	}
	return true;
}

/** The FooterComponent mounted in `tui` (a shallow search, cached while it stays mounted), else undefined. */
export function findFooter(tui: Any | undefined, isFooter: (component: Any) => boolean): Any | undefined {
	if (!tui || !Array.isArray(tui.children)) return undefined;
	const cached = footerPaths.get(tui);
	if (cached && mounted(tui, cached)) return cached[cached.length - 1];
	const queue: { component: Any; path: Any[] }[] = [];
	for (const child of tui.children as Any[]) if (child) queue.push({ component: child, path: [child] });
	for (let i = 0; i < queue.length; i++) {
		const { component, path } = queue[i]!;
		if (isFooter(component)) {
			footerPaths.set(tui, path);
			return component;
		}
		const kids: unknown = component.children;
		if (path.length >= SEARCH_DEPTH || !Array.isArray(kids) || kids.length > SEARCH_WIDTH) continue;
		for (const kid of kids as Any[]) if (kid) queue.push({ component: kid, path: [...path, kid] });
	}
	footerPaths.delete(tui);
	return undefined;
}

// ── Footer handoff ──────────────────────────────────────────────────────
//
// Every mounted component is described once per frame, the editor before the
// footer. The editor bumps the footer's tick when its composer carries the
// footer's facts; the footer hides while the tick moved since its own last
// describe, so it comes back by itself once the composer stops (an unmounted
// editor, a fallback, ANSI).

const factsTicks = new WeakMap<object, number>();
const footerSeen = new WeakMap<object, number | undefined>();

/** The composer carried `footer`'s facts in this frame. */
export function noteFactsCarried(footer: object): void {
	factsTicks.set(footer, (factsTicks.get(footer) ?? 0) + 1);
}

/** Call once per footer describe: whether a composer carried its facts since the previous one. */
export function footerCarried(footer: object): boolean {
	const tick = factsTicks.get(footer);
	const seen = footerSeen.get(footer);
	footerSeen.set(footer, tick);
	return tick !== undefined && tick !== seen;
}

// ── Hosting ─────────────────────────────────────────────────────────────

/** Tell other extensions whether the native composer hosts the editor; a flip repaints (their bands read it while describing). */
export function hostComposer(editor: Any, hosted: boolean): void {
	if (isComposerHosted() === hosted) return;
	setComposerHosted(hosted);
	try {
		editor.tui?.requestRender?.();
	} catch {
		// the next frame picks it up
	}
}

export function releaseComposer(): void {
	setComposerHosted(false);
}

// ── Attachments ─────────────────────────────────────────────────────────

const keyedChips = new WeakMap<object, NativeNode>();
const chipsMemo = new WeakMap<object, readonly NativeNode[]>();
const NO_CHIPS: readonly NativeNode[] = Object.freeze([]);

function isNode(value: unknown): value is NativeNode {
	return value !== null && typeof value === "object" && typeof (value as Any).k === "string";
}

/** A provider's node with a stable sibling key (the same object while the provider's node is). */
function keyedChip(chip: NativeNode, index: number): NativeNode {
	if (chip.key !== undefined) return chip;
	let keyed = keyedChips.get(chip);
	if (!keyed) {
		keyed = { ...chip, key: `chips${index}` };
		keyedChips.set(chip, keyed);
	}
	return keyed;
}

/** The registered providers' non-null nodes, in key order; the same array for `owner` while every node is unchanged. */
export function composerChips(owner: object, cx: DescribeContext): readonly NativeNode[] {
	const providers = composerAttachments();
	const out: NativeNode[] = [];
	providers.forEach((provider, i) => {
		let described: unknown;
		try {
			described = provider.describe(cx);
		} catch {
			described = null;
		}
		if (isNode(described) && described.p?.hidden !== true) out.push(keyedChip(described, i));
	});
	const last = chipsMemo.get(owner) ?? NO_CHIPS;
	if (sameSig(last, out)) return last;
	const next = out.length === 0 ? NO_CHIPS : out;
	chipsMemo.set(owner, next);
	return next;
}

// ── Keys ────────────────────────────────────────────────────────────────

export interface ComposerKeys {
	readonly model: string | undefined;
	readonly thinking: string | undefined;
	readonly interrupt: string;
	/** All of the above, joined (for fingerprints). */
	readonly sig: string;
}

const keysMemo = new WeakMap<object, ComposerKeys>();

function firstKey(keybindings: Any | undefined, action: string): string | undefined {
	try {
		const keys: unknown = keybindings?.getKeys?.(action);
		return Array.isArray(keys) && typeof keys[0] === "string" ? keys[0] : undefined;
	} catch {
		return undefined;
	}
}

/** The first key of the model selector, thinking cycle and interrupt actions (tooltip hints). */
export function composerKeys(editor: Any): ComposerKeys {
	const kb: Any | undefined = editor.keybindings;
	const model = firstKey(kb, "app.model.select");
	const thinking = firstKey(kb, "app.thinking.cycle");
	const interrupt = firstKey(kb, "app.interrupt") ?? "escape";
	const sig = `${model ?? ""}\u0000${thinking ?? ""}\u0000${interrupt}`;
	const last = keysMemo.get(editor);
	if (last?.sig === sig) return last;
	const keys: ComposerKeys = { model, thinking, interrupt, sig };
	keysMemo.set(editor, keys);
	return keys;
}

// ── Actions ─────────────────────────────────────────────────────────────

function call(handler: unknown): boolean {
	if (typeof handler !== "function") return false;
	handler();
	return true;
}

/**
 * A click on a composer control, routed the way pi's keys go: the model chip
 * opens the model selector (`app.model.select`), the effort glyph cycles the
 * thinking level (`app.thinking.cycle`), Stop interrupts like Esc (the
 * editor's `onEscape`, else `app.interrupt`) while something runs.
 * `thinking.set` carries a level picked by pointer as `value`: it is set on
 * the footer's session when the model offers it, else ignored (no value, no
 * footer, a level pi doesn't have such as omp's `auto`). `submit` is the
 * describer's (it owns the draft). Unknown actions are ignored.
 */
export function runComposerAction(editor: Any, act: string, running: boolean, value?: string, footer?: Any): boolean {
	const handlers: Any | undefined = editor.actionHandlers instanceof Map ? editor.actionHandlers : undefined;
	switch (act) {
		case "status.model":
			return call(handlers?.get("app.model.select"));
		case "thinking.cycle":
			return call(handlers?.get("app.thinking.cycle"));
		case "thinking.set": {
			const session: Any | undefined = footer?.session;
			if (typeof value !== "string" || !value || typeof session?.setThinkingLevel !== "function") return false;
			const levels: unknown = session.getAvailableThinkingLevels?.();
			// Not offered: ignored rather than left to `setThinkingLevel` to clamp.
			if (!Array.isArray(levels) || !levels.includes(value)) return false;
			session.setThinkingLevel(value);
			// pi refreshes the footer and the editor border on the change, without asking for a frame.
			editor.tui?.requestRender?.();
			return true;
		}
		case "interrupt":
			if (!running) return false;
			return call(editor.onEscape ?? handlers?.get("app.interrupt"));
		default:
			return false;
	}
}

// ── Layout ──────────────────────────────────────────────────────────────

export interface ComposerParts {
	/** The `editor` node (key `input`). */
	readonly input: NativeNode;
	/** A `!` draft (`!!`: excluded from the model's context). */
	readonly shell: { readonly excluded: boolean } | undefined;
	/** The working row, when the editor's container doesn't place it above the composer. */
	readonly working: NativeChild | undefined;
	/** The open autocomplete list. */
	readonly complete: NativeNode | undefined;
	readonly chips: readonly NativeNode[];
	readonly facts: ComposerFacts | undefined;
	readonly running: boolean;
	readonly sendable: boolean;
	readonly keys: ComposerKeys;
}

/** Filled steps (of four) of the effort chip's fallback meter (terminals without `effort`), as omp's. */
const EFFORT_STEPS: Partial<Record<string, number>> = { off: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };

/** Context share where the meter turns warning and error: pi's footer colours past 70% and 90%. */
const CONTEXT_THRESHOLDS = { warn: 0.7, bad: 0.9 } as const;

interface FactsView {
	readonly extras: NativeNode;
	readonly usage: NativeNode;
}

const factsViews = new WeakMap<ComposerFacts, FactsView>();

// ── Context line ────────────────────────────────────────────────────────
//
// rsttyd draws the meter as a hairline along the composer's top edge, 22px in
// from each end (tsp.css `omp.composer.context`), and hangs three things in
// the one 11px band just over it without arranging them: the share (`label`,
// 10px mono, centred on the fill's end), the window (`total`, 10px mono, at
// the line's end) and each icon mark (10px wide, centred on its point). omp's
// compaction point sits near 85% of the window, well clear of the total; pi
// compacts at the window less its reserve tokens (98.4% of a 1M window, 92%
// of 200k), right under the total, and the share passes over the mark as it
// nears it. So the meter only carries what fits: the share always, the mark
// unless the share covers it, the total while neither reaches it — what's left
// out stays in the tooltip.

/** rsttyd's composer and context line, in CSS px (tsp.css). */
const CONTEXT_LINE = {
	/** A terminal column at rsttyd's 14px grid font, for an estimate of the pane's width. */
	cell: 8,
	/** The composer's widest, and its margin inside the pane (a phone's below `phone`). */
	composer: 736,
	margin: 24,
	phone: 640,
	phoneMargin: 16,
	/** The line runs 22px in from each end of the composer. */
	inset: 44,
	/** The advance of the 10px mono share and window. */
	glyph: 6.2,
	/** Half an icon mark. */
	mark: 5,
	/** The least room kept between two of them. */
	gap: 4,
} as const;

/** The context line's length on a pane of `cols` columns. */
function contextLinePx(cols: number): number {
	const pane = Math.max(1, cols) * CONTEXT_LINE.cell;
	const composer = pane <= CONTEXT_LINE.phone ? pane - CONTEXT_LINE.phoneMargin : Math.min(CONTEXT_LINE.composer, pane - CONTEXT_LINE.margin);
	return Math.max(60, composer - CONTEXT_LINE.inset);
}

/** Which of the mark and the total the line has room for beside the share. */
function contextFit(used: number | null, label: string | undefined, total: string | undefined, compactAt: number | undefined, cols: number): { mark: boolean; total: boolean } {
	const line = contextLinePx(cols);
	const { glyph, mark: half, gap } = CONTEXT_LINE;
	const share = (used ?? 0) * line;
	const labelHalf = label ? (label.length * glyph) / 2 : 0;
	const totalFrom = total ? line - total.length * glyph : Number.POSITIVE_INFINITY;
	const markAt = compactAt === undefined ? undefined : compactAt * line;
	const mark = markAt !== undefined && !(label && Math.abs(markAt - share) < labelHalf + half + gap);
	let room = total !== undefined;
	if (room && label && share + labelHalf + gap > totalFrom) room = false;
	if (room && mark && markAt! + half + gap > totalFrom) room = false;
	return { mark, total: room };
}

const contextMemo = new WeakMap<ComposerFacts, { readonly key: string; readonly node: NativeNode }>();

function describeContext(facts: ComposerFacts, cols: number): NativeNode {
	const { percent, window, tokens } = facts;
	const used = percent === null ? null : Math.max(0, Math.min(1, percent / 100));
	let compactAt: number | undefined;
	if (facts.autoCompact && window > 0 && facts.reserve !== undefined && facts.reserve < window) compactAt = (window - facts.reserve) / window;
	const label = percent === null ? undefined : `${Math.round(percent)}%`;
	const total = window > 0 ? formatTokens(window) : undefined;
	const fit = contextFit(used, label, total, compactAt, cols);
	const key = `${fit.mark}\u0000${fit.total}`;
	const last = contextMemo.get(facts);
	if (last?.key === key) return last.node;
	const lines = [
		percent === null ? "Context usage unknown" : `Context ${percent.toFixed(1)}% used`,
		window > 0 ? (tokens !== null ? `${formatTokens(tokens)} of ${formatTokens(window)} tokens` : `${formatTokens(window)} token window`) : "No context window",
		facts.autoCompact ? (compactAt !== undefined ? `Auto-compact at ${Math.round(compactAt * 100)}%` : "Auto-compact on") : "Auto-compact off",
	];
	const props: TspProps = {
		role: "omp.composer.context",
		value: used,
		style: "bar",
		thresholds: CONTEXT_THRESHOLDS,
		title: lines.join("\n"),
	};
	if (fit.mark && compactAt !== undefined) props.marks = [{ at: compactAt, icon: "context.compaction", title: `Auto-compact at ${Math.round(compactAt * 100)}%` }];
	if (label !== undefined) props.label = label;
	if (fit.total && total !== undefined) props.total = total;
	const meter = node("meter", props, undefined, "context");
	contextMemo.set(facts, { key, node: meter });
	return meter;
}

function statusSpans(value: string): readonly TspSpan[] {
	const spans = lineToSpans(value);
	if (spans.length === 0) return [span(value)];
	return hasStyle(spans) ? spans : [span(spans.map((sp) => sp.t).join(""))];
}

function fact(key: string, spans: readonly TspSpan[], priority: number, extra?: TspProps): NativeNode {
	return node("seg", { role: "omp.composer.fact", spans, priority, ...extra }, undefined, key);
}

/** The bar's flexible facts (omp's `omp.composer.extras` status): cwd, git branch, session name, then extension statuses. */
function describeExtras(facts: ComposerFacts): NativeNode {
	const segs: NativeNode[] = [];
	// The path shrinks before anything drops; branch and session outlast the statuses.
	if (facts.cwd) segs.push(fact("path", [span(shortCwd(facts.cwd))], 1, { icon: "folder", title: facts.cwd, min: { w: "12ch" } }));
	if (facts.branch) segs.push(fact("git", [span(facts.branch)], 1000, { icon: "git", title: `Git branch ${facts.branch}` }));
	if (facts.sessionName) segs.push(fact("session", [span(facts.sessionName)], 999, { icon: "session", title: `Session ${facts.sessionName}` }));
	for (const [key, value] of facts.statuses) segs.push(fact(`status:${key}`, statusSpans(value), 0, { title: key }));
	return node("status", { role: "omp.composer.extras", transparent: true, grow: 1 }, segs, "extras");
}

/** The session cost (pi's `$0.000`, `(sub)` on a subscription); the token totals ride its tooltip. */
function describeUsage(facts: ComposerFacts): NativeNode {
	const cost = facts.cost > 0 || facts.subscription ? `$${facts.cost.toFixed(3)}${facts.subscription ? " (sub)" : ""}` : "";
	const lines: string[] = [];
	if (cost) lines.push(`Session cost ${cost}`);
	const io = compact([facts.input > 0 && `↑${formatTokens(facts.input)} in`, facts.output > 0 && `↓${formatTokens(facts.output)} out`]);
	if (io.length > 0) lines.push(`Tokens ${io.join(" · ")}`);
	const cache = compact([
		facts.cacheRead > 0 && `R${formatTokens(facts.cacheRead)} read`,
		facts.cacheWrite > 0 && `W${formatTokens(facts.cacheWrite)} written`,
		(facts.cacheRead > 0 || facts.cacheWrite > 0) && facts.cacheHit !== undefined && `CH${facts.cacheHit.toFixed(1)}% hit`,
	]);
	if (cache.length > 0) lines.push(`Cache ${cache.join(" · ")}`);
	// Without a cost the token totals are the usage.
	const shown = cost || compact([facts.input > 0 && `↑${formatTokens(facts.input)}`, facts.output > 0 && `↓${formatTokens(facts.output)}`]).join(" ");
	const props: TspProps = { role: "omp.composer.usage", text: shown, wrap: "none" };
	if (lines.length > 0) props.title = lines.join("\n");
	return node("text", props, undefined, "usage");
}

function factsView(facts: ComposerFacts, cx: DescribeContext): FactsView {
	let view = factsViews.get(facts);
	if (!view) {
		view = {
			extras: cx.supports("status") && cx.supports("seg") ? describeExtras(facts) : node("row", { grow: 1 }, [], "gap"),
			usage: describeUsage(facts),
		};
		factsViews.set(facts, view);
	}
	return view;
}

function modelTitle(facts: ComposerFacts, keys: ComposerKeys): string {
	const lines: string[] = [];
	if (facts.modelId) {
		lines.push(facts.modelName && facts.modelName !== facts.modelId ? `${facts.modelName} (${facts.modelId})` : facts.modelId);
		if (facts.provider) lines.push(`Provider ${facts.provider}`);
	} else lines.push("No model selected");
	if (facts.routedId) lines.push(`Routed to ${facts.routedId}${facts.routedThinking ? ` · ${facts.routedThinking}` : ""}`);
	lines.push(keys.model ? `Switch model  ${keyLabel(keys.model)}` : "Switch model");
	return lines.join("\n");
}

/** Model chip (the level as its `effort` glyph), or an effort chip beside it on terminals without `effort`. */
function describeModel(facts: ComposerFacts, keys: ComposerKeys, cx: DescribeContext): NativeNode[] {
	const thinking = facts.thinking;
	const hint = keys.thinking ? `  ${keyLabel(keys.thinking)}` : "";
	const glyph = thinking !== undefined && cx.supports("effort");
	const label = facts.modelId ? shortModelId(facts.modelId) : "no model";
	const routed = facts.routedId ? ` → ${shortModelId(facts.routedId)}` : "";
	const chip = node(
		"row",
		{ role: "omp.composer.model", gap: "xs", align: "center", title: modelTitle(facts, keys), actions: { click: "status.model" } },
		compact([
			glyph &&
				node(
					"effort",
					{ level: thinking, role: "omp.composer.model.effort", title: `Thinking effort: ${thinking}${hint}`, actions: { click: "thinking.cycle" } },
					undefined,
					"effort",
				),
			text(`${label}${routed}`, { wrap: "none" }, "name"),
			cx.supports("icon") && node("icon", { name: "chev" }, undefined, "chev"),
		]),
		"model",
	);
	if (thinking === undefined || glyph) return [chip];
	const steps = EFFORT_STEPS[thinking];
	const effort = node(
		"row",
		{ role: "omp.composer.effort", gap: "xs", align: "center", title: `Thinking effort${hint}`, actions: { click: "thinking.cycle" } },
		compact([
			cx.supports("meter") && node("meter", { value: steps === undefined ? null : steps / 4, style: "blocks", steps: 4 }, undefined, "meter"),
			text(thinking, { wrap: "none" }, "level"),
		]),
		"effort",
	);
	return [chip, effort];
}

function describeSubmit(parts: ComposerParts, cx: DescribeContext): NativeNode {
	if (parts.running) {
		return node(
			"text",
			{ role: "omp.composer.stop", text: "Stop", tone: "error", title: `Stop  ${keyLabel(parts.keys.interrupt)}`, actions: { click: "interrupt" } },
			undefined,
			"stop",
		);
	}
	const props: TspProps = parts.sendable
		? { role: "omp.composer.send", title: "Send  Enter", actions: { click: "submit" } }
		: { role: "omp.composer.send", title: "Sending is unavailable", tone: "muted" };
	return cx.supports("kbd") ? node("kbd", { ...props, keys: ["enter"] }, undefined, "send") : node("text", { ...props, text: "Send", wrap: "none" }, undefined, "send");
}

interface BarMemo {
	readonly key: string;
	readonly facts: ComposerFacts | undefined;
	readonly node: NativeNode;
}

const barMemo = new WeakMap<object, BarMemo>();

function describeBar(owner: object, parts: ComposerParts, cx: DescribeContext): NativeNode {
	const key = `${parts.running}\u0000${parts.sendable}\u0000${parts.keys.sig}`;
	const last = barMemo.get(owner);
	if (last && last.key === key && last.facts === parts.facts) return last.node;
	const facts = parts.facts;
	const view = facts && factsView(facts, cx);
	const bar = row(
		compact([
			...(facts ? describeModel(facts, parts.keys, cx) : []),
			// The facts are the bar's flexible space; without them a spacer keeps send at the end.
			view ? view.extras : node("row", { grow: 1 }, [], "gap"),
			view?.usage,
			describeSubmit(parts, cx),
		]),
		{ role: "omp.composer.bar", gap: "sm", align: "center" },
		"bar",
	);
	barMemo.set(owner, { key, facts, node: bar });
	return bar;
}

const modeMemo = new Map<boolean, NativeNode>();

/** The bash mode chip before the input (omp's `omp.composer.mode`); `!!` drafts stay out of the model's context. */
function describeMode(excluded: boolean, cx: DescribeContext): NativeNode {
	let chip = modeMemo.get(excluded);
	if (!chip) {
		chip = row(
			compact([
				excluded && cx.supports("icon") && node("icon", { name: "eye-off", title: "Not sent to the model" }, undefined, "excluded"),
				text([span("bash", "bashMode")], { wrap: "none" }, "label"),
			]),
			{ role: "omp.composer.mode", gap: "xs", align: "center", title: excluded ? "Runs in your shell · not sent to the model" : "Runs in your shell" },
			"mode",
		);
		modeMemo.set(excluded, chip);
	}
	return chip;
}

/** omp's composer root around the editor node: `col` role `omp.editor[.bash]`, caret at `line/input` ({@link COMPOSER_CARET}). */
export function describeComposer(owner: object, parts: ComposerParts, cx: DescribeContext): NativeNode {
	const context = parts.facts && cx.supports("meter") ? describeContext(parts.facts, cx.cols) : undefined;
	const line = row(compact([parts.shell && describeMode(parts.shell.excluded, cx), parts.input]), { role: "omp.composer.line", align: "start", gap: "sm" }, "line");
	const children: NativeChild[] = compact<NativeChild>([parts.working, context, ...parts.chips, line, parts.complete, describeBar(owner, parts, cx)]);
	const props: TspProps = { role: parts.shell ? "omp.editor.bash" : "omp.editor" };
	if (parts.running) props.tone = "pending";
	return col(children, props);
}

/** The placeholder for a named session: its name, quoted in italics, in the placeholder's own ink (omp's titled composer). */
const titlePlaceholders = new Map<string, readonly TspSpan[]>();

export function sessionPlaceholder(name: string): readonly TspSpan[] {
	let spans = titlePlaceholders.get(name);
	if (!spans) {
		if (titlePlaceholders.size > 32) titlePlaceholders.clear();
		spans = [span(`“${name}”`, "em")];
		titlePlaceholders.set(name, spans);
	}
	return spans;
}

// ── Autocomplete ────────────────────────────────────────────────────────
//
// omp's composer shows its open completion list (`/` commands, `@` files,
// pi-extended's `^` model mentions) as an `overlay` anchored to the caret,
// role `omp.autocomplete`, around the list component itself; its reconciler
// hoists that overlay into `layer` (rsttyd places a caret card from there:
// beside the caret, a sheet over the composer on a narrow pane). Ours doesn't
// hoist, so the session puts the overlay into `layer` (describers.ts
// `editorAutocompleteOverlay`) with the anchor already the editor node's wire
// id. While an overlay is anchored at its caret rsttyd leaves ↑/↓ to the
// program, so pi-tui's Editor keeps the keys (↑/↓, Tab, Enter, Esc); a click
// on an item is the list's own `select`/`activate` (its onSelect: the
// completion applied, as Tab).

/** The keypath of the `editor` node in the composer (`line` row, `input` node), and in the plain `omp.field`. */
export const COMPOSER_CARET = "line/input";
export const FIELD_CARET = "input";

/**
 * The typed text the open list matches item labels against (omp's
 * `#autocompleteMark`, for the item `mark` spans): the completion prefix
 * without its sigil, from its last path segment on. Labels that keep the
 * sigil (pi-extended's `^model` mentions) are marked with it.
 */
export function autocompleteMark(prefix: string, label: string): string {
	const sigil = /^[/@:#$^]"?/.exec(prefix)?.[0] ?? "";
	const typed = prefix.slice(sigil.length);
	const segment = typed.slice(typed.lastIndexOf("/") + 1);
	const lead = sigil.charAt(0);
	return lead !== "" && segment === typed && label.startsWith(lead) ? lead + segment : segment;
}

const overlayMemo = new WeakMap<object, { readonly list: Component; readonly anchor: string; readonly node: NativeNode }>();
const inlineMemo = new WeakMap<object, { readonly list: Component; readonly node: NativeNode }>();

/** omp's command icons for pi's built-in slash commands (names rsttyd's icon set resolves). */
const COMMAND_ICONS: Readonly<Record<string, string>> = {
	settings: "settings",
	model: "model",
	tree: "tree",
	thinking: "gauge",
	"scoped-models": "model",
	export: "export",
	import: "download",
	share: "share",
	bug: "bug",
	copy: "copy",
	name: "tag",
	session: "session",
	changelog: "news",
	hotkeys: "keyboard",
	fork: "branch",
	clone: "files",
	trust: "shield",
	login: "signIn",
	logout: "signOut",
	new: "plus",
	compact: "compress",
	resume: "resume",
	reload: "restart",
	quit: "exit",
};

/** An item's icon name, from the pi SelectItem it shows. */
export type ItemIcon = (item: { readonly value?: unknown; readonly label?: unknown }) => string | undefined;

const commandIcon: ItemIcon = (item) => {
	const name = String(item.value ?? "");
	return COMMAND_ICONS[name] ?? (name.startsWith("skill:") ? "skill" : "slash");
};
const pathIcon: ItemIcon = (item) => (/\/"?$/.test(String(item.label || item.value || "")) ? "folder" : "file");
const modelIcon: ItemIcon = () => "model";

/**
 * The icon each item of an open list leads with (omp's autocomplete items:
 * the command's icon, `file`/`folder` for paths, `model` for `^` mentions);
 * undefined for lists whose items have none (command arguments). `commands`:
 * the list completes a `/` command's name. Stable functions, so a list's
 * items keep their nodes.
 */
export function autocompleteIcons(prefix: string, state: unknown, commands: boolean): ItemIcon | undefined {
	if (commands) return commandIcon;
	if (prefix.startsWith("^")) return modelIcon;
	if (prefix.startsWith("@") || state === "force") return pathIcon;
	return undefined;
}

/** omp's caret menu: `overlay` (role `omp.autocomplete`, key `complete`) anchored at wire id `anchor`, around `list`. */
export function autocompleteOverlay(owner: object, list: Component, anchor: string): NativeNode {
	const last = overlayMemo.get(owner);
	if (last && last.list === list && last.anchor === anchor) return last.node;
	const overlay = node("overlay", { anchor: { caret: anchor }, role: "omp.autocomplete" }, [list], "complete");
	overlayMemo.set(owner, { list, anchor, node: overlay });
	return overlay;
}

/** The list inside the composer, under the input line, for a frame no session put the overlay into `layer`. */
export function autocompleteInline(owner: object, list: Component): NativeNode {
	const last = inlineMemo.get(owner);
	if (last && last.list === list) return last.node;
	const inline = col([list], { role: "omp.autocomplete" }, "complete");
	inlineMemo.set(owner, { list, node: inline });
	return inline;
}

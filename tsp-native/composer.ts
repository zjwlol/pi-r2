import * as fs from "node:fs";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { type Component, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { composerAttachments, isComposerHosted, setComposerHosted } from "../shared/composer-slots.ts";
import { changeEffort } from "../shared/effort.ts";
import { col, compact, type DescribeContext, type NativeChild, type NativeNode, node, row, span, text } from "./node.ts";
import { hasStyle, lineToSpans } from "./spans.ts";
import type { TspProps, TspSpan } from "./wire.ts";

type Any = Record<string, any>;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function shortCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const base = home.replace(/[\\/]+$/, "");
	if (cwd === base) return "~";
	if (cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`)) return `~${cwd.slice(base.length)}`;
	return cwd;
}

function shellCwd(cwd: string): string {
	const pwd = process.env.PWD;
	if (!pwd || pwd === cwd) return cwd;

	try {
		return fs.realpathSync(pwd) === cwd ? pwd : cwd;
	} catch {
		// PWD can point to a path that no longer exists.
		return cwd;
	}
}

const MAX_PATH_COLUMNS = 32;

function pathLabel(cwd: string): string {
	const path = shortCwd(shellCwd(cwd));
	const width = visibleWidth(path);
	if (width <= MAX_PATH_COLUMNS) return path;

	const prefix = path.startsWith("~/") || path.startsWith("~\\") ? path.slice(0, 2) : "";
	const tailWidth = MAX_PATH_COLUMNS - prefix.length - 1;
	const tail = sliceByColumn(path, width - tailWidth, tailWidth);
	const separator = tail.search(process.platform === "win32" ? /[\\/][^\\/]/ : /\/[^/]/);

	return `${prefix}…${separator > 0 ? tail.slice(separator) : tail}`;
}

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

export interface ComposerFacts {
	readonly modelId: string | undefined;
	readonly modelName: string | undefined;
	readonly provider: string | undefined;
	readonly routedId: string | undefined;
	readonly routedThinking: string | undefined;
	readonly thinking: ModelThinkingLevel | undefined;
	/**
	 * Context usage as a percentage from 0 to 100.
	 */
	readonly percent: number | null;
	readonly tokens: number | null;
	readonly window: number;
	readonly autoCompact: boolean;
	/**
	 * Tokens kept free before auto-compaction fires.
	 */
	readonly reserve: number | undefined;
	readonly cwd: string;
	readonly sessionName: string | undefined;
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

export function composerFacts(footer: Any): ComposerFacts | undefined {
	const session: Any | undefined = footer.session;
	const data: Any | undefined = footer.footerData;
	if (!session || !data) return undefined;
	const state: Partial<AgentSession["state"]> = session.state ?? {};
	const model = state.model;
	const stats: Any = typeof footer.getSessionStats === "function" ? (footer.getSessionStats() ?? {}) : {};
	const usage: Any = stats.usageTotals ?? {};
	const context: Any | undefined = stats.contextUsage;
	const routed: Any | undefined = session.routedModel;
	const window = finite(context?.contextWindow ?? model?.contextWindow);
	const percent = context === undefined || context === null ? 0 : typeof context.percent === "number" ? context.percent : null;
	const tokens = typeof context?.tokens === "number" ? context.tokens : null;
	const autoCompact = footer.autoCompactEnabled !== false;
	let reserve: number | undefined;
	if (autoCompact) {
		try {
			const value = session.settingsManager?.getCompactionReserveTokens?.(routed?.model ?? model);
			if (typeof value === "number" && Number.isFinite(value)) reserve = value;
		} catch {
			// pi can throw when reading an invalid reserve setting.
		}
	}
	const sessionManager: Any | undefined = session.sessionManager;
	const cwd = String(sessionManager?.getCwd?.() ?? "");
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
	const thinking = model?.reasoning ? state.thinkingLevel ?? "off" : undefined;
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

export function sessionRunning(footer: Any | undefined): boolean {
	const session: Any | undefined = footer?.session;
	if (!session) return false;
	return session.isStreaming === true || session.isCompacting === true || session.isBashRunning === true || session.isRetrying === true;
}

const footerPaths = new WeakMap<object, readonly Any[]>();
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

const factsTicks = new WeakMap<object, number>();
const footerSeen = new WeakMap<object, number | undefined>();

export function noteFactsCarried(footer: object): void {
	factsTicks.set(footer, (factsTicks.get(footer) ?? 0) + 1);
}

/**
 * Check this once per frame after the editor is described.
 */
export function footerCarried(footer: object): boolean {
	const tick = factsTicks.get(footer);
	const seen = footerSeen.get(footer);
	footerSeen.set(footer, tick);
	return tick !== undefined && tick !== seen;
}

export function hostComposer(editor: Any, hosted: boolean): void {
	if (isComposerHosted() === hosted) return;
	setComposerHosted(hosted);
	try {
		editor.tui?.requestRender?.();
	} catch {
		// The hosted state is read again on the next frame.
	}
}

export function releaseComposer(): void {
	setComposerHosted(false);
}

const keyedChips = new WeakMap<object, NativeNode>();
const chipsMemo = new WeakMap<object, readonly NativeNode[]>();
const NO_CHIPS: readonly NativeNode[] = Object.freeze([]);

function isNode(value: unknown): value is NativeNode {
	return value !== null && typeof value === "object" && typeof (value as Any).k === "string";
}

function keyedChip(chip: NativeNode, index: number): NativeNode {
	if (chip.key !== undefined) return chip;
	let keyed = keyedChips.get(chip);
	if (!keyed) {
		keyed = { ...chip, key: `chips${index}` };
		keyedChips.set(chip, keyed);
	}
	return keyed;
}

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

export interface ComposerKeys {
	readonly model: string | undefined;
	readonly thinking: string | undefined;
	readonly interrupt: string;
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

function call(handler: unknown): boolean {
	if (typeof handler !== "function") return false;
	handler();
	return true;
}

export function runComposerAction(editor: Any, act: string, running: boolean, value?: string, footer?: Any): boolean {
	const handlers: Any | undefined = editor.actionHandlers instanceof Map ? editor.actionHandlers : undefined;
	switch (act) {
		case "status.model":
			return call(handlers?.get("app.model.select"));
		case "thinking.select": {
			const session: AgentSession | undefined = footer?.session;
			if (session?.model?.reasoning) {
				const ctx = session.extensionRunner.createContext();
				void changeEffort(ctx, { currentLevel: session.thinkingLevel, setLevel: (level) => session.setThinkingLevel(level), overlay: true });

				return true;
			}

			return false;
		}
		case "thinking.set": {
			const session: Any | undefined = footer?.session;
			if (typeof value !== "string" || !value || typeof session?.setThinkingLevel !== "function") return false;
			const levels: unknown = session.getAvailableThinkingLevels?.();
			// pi clamps unsupported effort levels.
			if (!Array.isArray(levels) || !levels.includes(value)) return false;
			session.setThinkingLevel(value);
			// pi updates the footer and editor border without requesting a frame.
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

export interface ComposerParts {
	readonly input: NativeNode;
	readonly shell: { readonly excluded: boolean } | undefined;
	readonly working: NativeChild | undefined;
	readonly complete: NativeNode | undefined;
	readonly chips: readonly NativeNode[];
	readonly facts: ComposerFacts | undefined;
	readonly running: boolean;
	readonly sendable: boolean;
	readonly keys: ComposerKeys;
}

const EFFORT_STEPS: Readonly<Record<ModelThinkingLevel, number>> = { off: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };

const CONTEXT_THRESHOLDS = { warn: 0.7, bad: 0.9 } as const;

interface FactsView {
	readonly extras: NativeNode;
	readonly usage: NativeNode;
}

const factsViews = new WeakMap<ComposerFacts, FactsView>();

/**
 * The context line dimensions are in CSS pixels.
 */
const CONTEXT_LINE = {
	cell: 8,
	composer: 736,
	margin: 24,
	phone: 640,
	phoneMargin: 16,
	inset: 44,
	glyph: 6.2,
	mark: 5,
	gap: 4,
} as const;

function contextLinePx(cols: number): number {
	const pane = Math.max(1, cols) * CONTEXT_LINE.cell;
	const composer = pane <= CONTEXT_LINE.phone ? pane - CONTEXT_LINE.phoneMargin : Math.min(CONTEXT_LINE.composer, pane - CONTEXT_LINE.margin);
	return Math.max(60, composer - CONTEXT_LINE.inset);
}

/**
 * The terminal draws context labels and marks without resolving overlaps.
 */
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

function describeExtras(facts: ComposerFacts): NativeNode {
	const segs: NativeNode[] = [];
	if (facts.cwd) segs.push(fact("path", [span(pathLabel(facts.cwd))], 1, { icon: "folder", title: facts.cwd, min: { w: "12ch" } }));
	if (facts.sessionName) segs.push(fact("session", [span(facts.sessionName)], 999, { icon: "session", title: `Session ${facts.sessionName}` }));
	for (const [key, value] of facts.statuses) segs.push(fact(`status:${key}`, statusSpans(value), 0, { title: key }));
	return node("status", { role: "omp.composer.extras", transparent: true, grow: 1 }, segs, "extras");
}

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

interface DropdownOptions {
	key: "model" | "effort";
	role: "omp.composer.model" | "omp.composer.effort";
	click: "status.model" | "thinking.select";
	label: string;
	title: string;
	glyph?: NativeNode;
}

function dropdown(cx: DescribeContext, { key, role, click, label, title, glyph }: DropdownOptions): NativeNode {
	const chevron = cx.supports("icon") ? node("icon", { name: "chev", tone: "muted" }, undefined, "chev") : text("▾", { wrap: "none", title, tone: "muted" }, "chev");

	return row(
		compact([glyph, text(label, { wrap: "none", title }, "label"), chevron]),
		{ role, gap: "xs", align: "center", title, actions: { click } },
		key,
	);
}

function describeModel(facts: ComposerFacts, keys: ComposerKeys, cx: DescribeContext): NativeNode {
	const label = facts.modelId ? shortModelId(facts.modelId) : "no model";
	const routed = facts.routedId ? ` → ${shortModelId(facts.routedId)}` : "";

	return dropdown(cx, { key: "model", role: "omp.composer.model", click: "status.model", label: `${label}${routed}`, title: modelTitle(facts, keys) });
}

function describeEffort(level: ModelThinkingLevel, keys: ComposerKeys, cx: DescribeContext): NativeNode {
	let glyph: NativeNode | undefined;
	if (cx.supports("effort")) {
		glyph = node("effort", { level }, undefined, "glyph");
	} else if (cx.supports("meter")) {
		glyph = node("meter", { value: EFFORT_STEPS[level] / 4, style: "blocks", steps: 4 }, undefined, "meter");
	}

	const hint = keys.thinking ? `\n${keyLabel(keys.thinking)} cycles thinking levels` : "";

	return dropdown(cx, { key: "effort", role: "omp.composer.effort", click: "thinking.select", label: level, title: `Select thinking effort${hint}`, glyph });
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
			facts && describeModel(facts, parts.keys, cx),
			facts?.thinking !== undefined && describeEffort(facts.thinking, parts.keys, cx),
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

export function describeComposer(owner: object, parts: ComposerParts, cx: DescribeContext): NativeNode {
	const context = parts.facts && cx.supports("meter") ? describeContext(parts.facts, cx.cols) : undefined;
	const line = row(compact([parts.shell && describeMode(parts.shell.excluded, cx), parts.input]), { role: "omp.composer.line", align: "start", gap: "sm" }, "line");
	const children: NativeChild[] = compact<NativeChild>([parts.working, context, ...parts.chips, line, parts.complete, describeBar(owner, parts, cx)]);
	const props: TspProps = { role: parts.shell ? "omp.editor.bash" : "omp.editor" };
	if (parts.running) props.tone = "pending";
	return col(children, props);
}

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

export const COMPOSER_CARET = "line/input";
export const FIELD_CARET = "input";

export function autocompleteMark(prefix: string, label: string): string {
	const sigil = /^[/@:#$^]"?/.exec(prefix)?.[0] ?? "";
	const typed = prefix.slice(sigil.length);
	const segment = typed.slice(typed.lastIndexOf("/") + 1);
	const lead = sigil.charAt(0);
	return lead !== "" && segment === typed && label.startsWith(lead) ? lead + segment : segment;
}

const overlayMemo = new WeakMap<object, { readonly list: Component; readonly anchor: string; readonly node: NativeNode }>();
const inlineMemo = new WeakMap<object, { readonly list: Component; readonly node: NativeNode }>();

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

export type ItemIcon = (item: { readonly value?: unknown; readonly label?: unknown }) => string | undefined;

const commandIcon: ItemIcon = (item) => {
	const name = String(item.value ?? "");
	return COMMAND_ICONS[name] ?? (name.startsWith("skill:") ? "skill" : "slash");
};
const pathIcon: ItemIcon = (item) => (/\/"?$/.test(String(item.label || item.value || "")) ? "folder" : "file");
const modelIcon: ItemIcon = () => "model";

export function autocompleteIcons(prefix: string, state: unknown, commands: boolean): ItemIcon | undefined {
	if (commands) return commandIcon;
	if (prefix.startsWith("^")) return modelIcon;
	if (prefix.startsWith("@") || state === "force") return pathIcon;
	return undefined;
}

/**
 * The terminal leaves arrow keys to pi when the overlay is anchored to the caret.
 */
export function autocompleteOverlay(owner: object, list: Component, anchor: string): NativeNode {
	const last = overlayMemo.get(owner);
	if (last && last.list === list && last.anchor === anchor) return last.node;
	const overlay = node("overlay", { anchor: { caret: anchor }, role: "omp.autocomplete" }, [list], "complete");
	overlayMemo.set(owner, { list, anchor, node: overlay });
	return overlay;
}

export function autocompleteInline(owner: object, list: Component): NativeNode {
	const last = inlineMemo.get(owner);
	if (last && last.list === list) return last.node;
	const inline = col([list], { role: "omp.autocomplete" }, "complete");
	inlineMemo.set(owner, { list, node: inline });
	return inline;
}

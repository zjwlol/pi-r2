/**
 * pi's selectors and dialogs as omp's native sheets (oh-my-pi overlays/model-picker.ts, oauth-selector.ts,
 * thinking-selector.ts, theme-selector.ts, hook-selector.ts, hook-input.ts, hook-editor.ts, login-dialog.ts,
 * native/picker.ts).
 *
 * Pickers: /model, /scoped-models, /thinking, the theme and show-images submenus, /login and /logout's provider
 * list, /trust, and an extension's `select`/`confirm` describe as a ROOT `picker` node; session.ts hoists a dock
 * component whose description root is a `picker`, `prefs` or `overlay` into `layer` as a modal sheet. The picker's
 * search field is the component's own `Input`, sent as `query`/`cursor`: keys stay pi's (the terminal holds no
 * focus while a sheet is up). Pointer events arrive as `select` (move the selection), `activate` (the confirm path)
 * and `action` (`close`, `clear`, the action bar's ids); confirm and cancel feed the bound key to the component's
 * own `handleInput`, so every side effect pi runs on Enter/Esc runs on a click too.
 *
 * Dialogs: an extension's `input`/`editor` are omp's docked panels in the composer's place (`omp.overlay.hook-input`,
 * `omp.overlay.hook-editor`) holding pi's own Input/Editor (described by their own describers); the login flow is
 * omp's `omp.overlay.login` modal sheet, hoisted like a picker.
 */
import {
	BorderedLoader,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	ShowImagesSelectorComponent,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import { THINKING_LEVELS } from "../shared/effort.ts";
import type { Describer } from "./describers.ts";
import { col, type NativeChild, type NativeNode, type NativeUiEvent, node, row, span, stripAnsi, text } from "./node.ts";
import { lineToSpans, spansThemeId } from "./spans.ts";
import type { TspProps, TspSpan, TspText, TspTone } from "./wire.ts";

/** Loose view of private component state. */
type Any = Record<string, any>;

function is(component: Component, ctor: Function | undefined, name: string): boolean {
	if (ctor && component instanceof ctor) return true;
	for (let proto = Object.getPrototypeOf(component); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		if (proto.constructor?.name === name) return true;
	}
	return false;
}

function plain(s: string): string {
	return stripAnsi(s).replaceAll("\x1b_pi:c\x07", "");
}

function textOf(c: unknown): string {
	const t = (c as Any | undefined)?.text;
	return typeof t === "string" ? t : "";
}

function isText(c: Component): boolean {
	return is(c, undefined, "Text") || is(c, undefined, "TruncatedText");
}

// ── Picker wire shapes (omp `TspPickerProps`) ───────────────────────────

interface PickerMark {
	text: string;
	seed?: string;
	icon?: string;
}

interface PickerItem {
	id: string;
	label: TspText;
	detail?: TspText;
	icon?: string;
	mark?: PickerMark;
	dot?: TspTone;
	mono?: boolean;
	facts?: Readonly<Record<string, TspText | number>>;
	badges?: readonly { text: string; tone?: TspTone; title?: string }[];
	tone?: TspTone;
	disabled?: string | true;
	title?: string;
}

interface PickerGroup {
	group: string;
	label: TspText;
	count?: number;
}

interface PickerAction {
	id: string;
	label: string;
	keys?: readonly string[];
	primary?: boolean;
	danger?: boolean;
	end?: boolean;
	on?: boolean;
	disabled?: string | true;
}

interface PickerColumn {
	id: string;
	head?: string;
	format?: "text" | "num" | "price" | "bar" | "time" | "elapsed" | "dim";
	priority?: number;
	min?: number;
}

interface PickerProps {
	title?: string;
	subtitle?: TspText;
	icon?: string;
	noun?: string;
	size?: "md" | "lg" | "screen";
	layout?: "rows" | "cards" | "timeline" | "tree";
	query?: string | null;
	cursor?: number;
	placeholder?: string;
	tabs?: readonly { id: string; label: TspText; count?: number }[];
	tab?: string;
	columns?: readonly PickerColumn[];
	items?: readonly PickerItem[];
	order?: readonly (string | PickerGroup)[];
	hits?: Readonly<Record<string, readonly (readonly [number, number])[]>>;
	selected?: string | null;
	current?: readonly string[];
	total?: number;
	preview?: "side" | "below" | "none";
	actions?: readonly PickerAction[];
	state?: "ready" | "loading" | "error";
	message?: TspText;
	empty?: TspText;
}

function picker(p: PickerProps, preview?: readonly NativeChild[]): NativeNode {
	return node("picker", p as unknown as TspProps, preview);
}

/** Keycap names for a key id (`"alt+enter"` → `["alt", "enter"]`, `"escape"` → `["esc"]`). */
function keyCaps(key: string): string[] {
	if (key === "+") return ["+"];
	const parts = key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
	return parts.filter((part) => part.length > 0).map((part) => (part === "escape" ? "esc" : part));
}

/**
 * The primary key bound to `binding`, else `fallback` (pi's default). A bundled pi keeps its own keybindings
 * manager; ours then knows only pi-tui's ids, so app ids fall back to their defaults.
 */
function boundKey(binding: string, fallback?: string): string | undefined {
	try {
		const keys = (getKeybindings() as unknown as { getKeys(id: string): string[] }).getKeys(binding);
		if (Array.isArray(keys) && typeof keys[0] === "string" && keys[0] !== "") return keys[0];
	} catch {
		// no keybindings manager
	}
	return fallback;
}

/** How pi spells a key in its hints (`ctrl+s` → `Ctrl+S`). */
function keyLabel(key: string): string {
	return key
		.split("+")
		.map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
		.join("+");
}

function pickerAction(id: string, label: string, key?: string, opts?: Omit<PickerAction, "id" | "label" | "keys">): PickerAction {
	const caps = key ? keyCaps(key) : [];
	return { id, label, ...(caps.length > 0 ? { keys: caps } : {}), ...opts };
}

/** The right-aligned `Close esc` every picker ends with; rsttyd's backdrop and head `esc` send it too. */
const CLOSE_ACTION: PickerAction = { id: "close", label: "Close", keys: ["esc"], end: true };

type PickerEvent = { readonly kind: "select" | "activate"; readonly item: string } | { readonly kind: "action"; readonly act: string; readonly value: string | undefined };

/** omp's `pickerEvent`: the pointer event for the picker at keypath `key` ("" = the component's root). */
function pickerEvent(event: NativeUiEvent, key = ""): PickerEvent | undefined {
	if (event.key.replaceAll("^", "") !== key) return undefined;
	switch (event.type) {
		case "select":
		case "activate":
			return { kind: event.type, item: event.item };
		case "action":
			return { kind: "action", act: event.act, value: event.value };
		default:
			return undefined;
	}
}

/** omp's `pickerFuzzyHits`: each query token's first substring, else its characters in order. */
function fuzzyHits(label: string, query: string): [number, number][] | undefined {
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return undefined;
	const lower = label.toLowerCase();
	const marked = new Uint8Array(lower.length);
	for (const token of tokens) {
		const at = lower.indexOf(token);
		if (at >= 0) {
			marked.fill(1, at, at + token.length);
			continue;
		}
		let from = 0;
		for (const ch of token) {
			const index = lower.indexOf(ch, from);
			if (index < 0) break;
			marked[index] = 1;
			from = index + ch.length;
		}
	}
	const ranges: [number, number][] = [];
	for (let i = 0; i < marked.length; i++) {
		if (!marked[i]) continue;
		const start = i;
		while (i < marked.length && marked[i]) i++;
		ranges.push([start, i]);
	}
	return ranges.length > 0 ? ranges : undefined;
}

function hitsFor(ids: readonly string[], labels: (id: string) => string, query: string): Record<string, [number, number][]> | undefined {
	if (!query.trim()) return undefined;
	const out: Record<string, [number, number][]> = {};
	for (const id of ids) {
		const ranges = fuzzyHits(labels(id), query);
		if (ranges) out[id] = ranges;
	}
	return out;
}

/** A search Input's text and caret. */
function inputState(input: Any | undefined): { value: string; cursor: number } {
	const value = typeof input?.getValue === "function" ? String(input.getValue()) : String(input?.value ?? "");
	const raw = Number(input?.cursor);
	return { value, cursor: Number.isFinite(raw) ? Math.max(0, Math.min(value.length, raw)) : value.length };
}

/** omp's `providerMark`: the terminal's logo for a provider, else its initials on its own gradient. */
function providerMark(providerId: string): PickerMark {
	const words = providerId.split(/[-_\s.]+/).filter((word) => word.length > 0);
	const word = words[0] ?? providerId;
	const initials = words.length >= 2 ? `${words[0]!.charAt(0)}${words[1]!.charAt(0)}`.toUpperCase() : `${word.charAt(0).toUpperCase()}${word.charAt(1)}`;
	return { text: initials || "?", seed: providerId, icon: `provider:${providerId}` };
}

function initialsMark(name: string, seed: string): PickerMark {
	const initials = name
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 0)
		.slice(0, 2)
		.map((word) => word[0]!.toUpperCase())
		.join("");
	return { text: initials || name.slice(0, 2) || "?", seed };
}

// ── Keys fed to the component (its own Enter/Esc paths) ─────────────────

const NAMED_KEYS: Readonly<Record<string, string>> = {
	enter: "\r",
	return: "\r",
	escape: "\x1b",
	esc: "\x1b",
	tab: "\t",
	space: " ",
	backspace: "\x7f",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
};
const ARROW_FINAL: Readonly<Record<string, string>> = { up: "A", down: "B", right: "C", left: "D" };

/** The legacy bytes of a key id (pi-tui's `matchesKey` accepts them with or without the kitty protocol). */
function keyBytes(key: string): string | undefined {
	const parts = key.toLowerCase().split("+");
	const base = parts.pop() ?? "";
	const mods = new Set(parts.filter((part) => part.length > 0));
	if (mods.size === 0) return NAMED_KEYS[base] ?? (base.length === 1 ? base : undefined);
	if (mods.size !== 1) return undefined;
	if (mods.has("ctrl") && /^[a-z]$/.test(base)) return String.fromCharCode(base.charCodeAt(0) - 96);
	if (mods.has("alt")) {
		const arrow = ARROW_FINAL[base];
		if (arrow) return `\x1b[1;3${arrow}`;
		if (base.length === 1) return `\x1b${base}`;
		if (base === "enter") return "\x1b\r";
	}
	if (mods.has("shift") && base === "tab") return "\x1b[Z";
	return undefined;
}

/** Run what pressing `binding` runs: its key goes through `target.handleInput`. */
function press(target: Any | undefined, binding: string, fallback: string): boolean {
	if (!target || typeof target.handleInput !== "function") return false;
	const key = boundKey(binding, fallback) ?? fallback;
	const bytes = keyBytes(key) ?? keyBytes(fallback);
	if (bytes === undefined) return false;
	target.handleInput(bytes);
	return true;
}

// ── Dialog chrome (omp native/overlay.ts) ───────────────────────────────

/** omp's `actionButton`: a label plus its keycap; a click sends `act` as an `action` event. */
function button(label: string, act: string, opts: { key?: string | undefined; tone?: "accent" | "error"; title?: string; href?: string } = {}): NativeNode {
	const caps = opts.key ? keyCaps(opts.key) : [];
	const children: NativeChild[] = [text(label, undefined, "label")];
	if (caps.length > 0) children.push(node("kbd", { keys: caps }, undefined, "kbd"));
	const p: TspProps = {
		role: "omp.btn",
		gap: "xs",
		align: "center",
		actions: { click: act },
		title: opts.title ?? (opts.key ? `${label}  ${keyLabel(opts.key)}` : label),
	};
	if (opts.tone) p.tone = opts.tone;
	if (opts.href) p.href = opts.href;
	return node("row", p, children, act);
}

/** omp's `actionBar`: `null` entries become the spacer that end-aligns what follows. */
function actionBar(buttons: readonly (NativeNode | null)[], key = "actions"): NativeNode {
	return node(
		"row",
		{ role: "omp.actions", gap: "sm", align: "center" },
		buttons.map((b, i) => b ?? node("spacer", { grow: 1 }, undefined, `fill${i}`)),
		key,
	);
}

/** A pi-styled line as a text node (theme colours → span tokens). */
function styledText(raw: string, p: TspProps, key: string): NativeNode {
	const lines = raw.replaceAll("\x1b_pi:c\x07", "").split("\n");
	if (lines.length === 1) return text(lineToSpans(lines[0]!), p, key);
	return col(
		lines.map((line, i) => text(lineToSpans(line), { wrap: p.wrap }, `l${i}`)),
		{ role: p.role, gap: "none" },
		key,
	);
}

/** The plain texts of the `Text` children between `from` (exclusive) and `to` (exclusive; undefined: the end). */
function textsBetween(children: readonly Component[], from: unknown, to: unknown): string[] {
	const start = from === undefined ? 0 : children.indexOf(from as Component) + 1;
	let end = to === undefined ? children.length : children.indexOf(to as Component);
	if (end < 0) end = children.length;
	const out: string[] = [];
	for (let i = Math.max(0, start); i < end; i++) {
		const child = children[i]!;
		if (!isText(child)) continue;
		const t = plain(textOf(child)).trim();
		if (t) out.push(t);
	}
	return out;
}

/** Deadlines of pi's countdowns (it keeps only the seconds left), first seen. */
const deadlines = new WeakMap<object, { seconds: number; at: number }>();

/** A live countdown as omp's `elapsed` (negative age = time left); undefined without a running timer. */
function countdownNode(countdown: Any | undefined): NativeNode | undefined {
	if (!countdown || countdown.intervalId === undefined) return undefined;
	const seconds = Number(countdown.remainingSeconds);
	if (!Number.isFinite(seconds)) return undefined;
	let seen = deadlines.get(countdown);
	if (!seen || seconds > seen.seconds) {
		seen = { seconds, at: Date.now() + seconds * 1000 };
		deadlines.set(countdown, seen);
	}
	return node("elapsed", { age: Math.min(0, Date.now() - seen.at), format: "short" }, undefined, "countdown");
}

/** The deadline a countdown node counts to (its identity for memos). */
function countdownKey(countdown: Any | undefined): number | undefined {
	if (!countdown || countdown.intervalId === undefined) return undefined;
	const seconds = Number(countdown.remainingSeconds);
	const seen = deadlines.get(countdown);
	if (!seen || seconds > seen.seconds) return Number.NaN;
	return seen.at;
}

// ── Ages (remember-model's recency tags) ────────────────────────────────

/** remember-model's cache of each selector's recents (`modelKey` → lastUsed ms). */
const RECENT = Symbol.for("pi-extended.remember-model.recent");

const modelKey = (provider: string, id: string) => `${provider}\0${id}`;

/** The recents remember-model cached on this selector (refreshed whenever it sorts the models). */
function recentOf(a: object): Map<string, number> | undefined {
	const value = (a as Record<PropertyKey, unknown>)[RECENT];
	return value instanceof Map ? (value as Map<string, number>) : undefined;
}

/** remember-model's `timeAgo`. */
function timeAgo(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 30) return `${d}d ago`;
	return `${Math.round(d / 30)}mo ago`;
}

/** Ages only change by the minute: the memo keys on this. */
function minute(): number {
	return Math.floor(Date.now() / 60_000);
}

// ── /model ──────────────────────────────────────────────────────────────

interface ModelRow {
	provider: string;
	id: string;
	model: Any | undefined;
}

const MODEL_COLUMNS: readonly PickerColumn[] = [
	{ id: "ctx", head: "Ctx", format: "num", priority: 2 },
	{ id: "price", head: "$/M", format: "price", priority: 1 },
];

function rowId(row: ModelRow): string {
	return `${row.provider}/${row.id}`;
}

function sameModel(a: Any | undefined, b: Any | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function costLeg(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (n === 0) return "0";
	if (n >= 10) return String(Math.round(n));
	if (n >= 1) return String(Math.round(n * 10) / 10);
	return String(Math.round(n * 100) / 100);
}

function priceFact(cost: Any | undefined): string | undefined {
	if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") return undefined;
	if (cost.input === 0 && cost.output === 0) return "free";
	return `$${costLeg(cost.input)}·${costLeg(cost.output)}`;
}

function tokens(n: unknown): string | undefined {
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
	if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}

function modelItem(a: Any, row: ModelRow, recent: Map<string, number> | undefined, now: number): PickerItem {
	const model: Any = row.model ?? {};
	const facts: Record<string, TspText | number> = {};
	if (typeof model.contextWindow === "number" && model.contextWindow > 0) facts.ctx = model.contextWindow;
	const price = priceFact(model.cost);
	if (price) facts.price = price;
	const name = typeof model.name === "string" && model.name.trim() && model.name.trim() !== row.id ? model.name.trim() : undefined;
	const current = sameModel(a.currentModel, row);
	const last = current ? undefined : recent?.get(modelKey(row.provider, row.id));
	const detail: TspSpan[] = [];
	if (name) detail.push(span(last !== undefined ? `${name} ` : name));
	// remember-model's tag, as its ANSI rows show it.
	if (last !== undefined) detail.push(span(`· ${timeAgo(now - last)}`, "accent"));
	const isDefault = a.defaultModel?.provider === row.provider && a.defaultModel?.id === row.id;
	const id = rowId(row);
	return {
		id,
		label: id,
		mono: true,
		mark: providerMark(row.provider),
		...(detail.length > 0 ? { detail } : {}),
		facts,
		...(isDefault ? { badges: [{ text: "default", tone: "accent" as const, title: "Default model" }] } : {}),
		...(name ? { title: name } : {}),
	};
}

const modelCatalogues = new WeakMap<Component, { models: unknown; recent: unknown; minute: number; current: unknown; def: unknown; items: PickerItem[] }>();

/** The whole scope as picker rows (built once per catalogue; filtering only changes `order`). */
function modelCatalogue(c: Component, a: Any): PickerItem[] {
	const models: ModelRow[] = Array.isArray(a.activeModels) ? a.activeModels : [];
	const recent = recentOf(a);
	const now = minute();
	const cached = modelCatalogues.get(c);
	if (cached && cached.models === models && cached.recent === recent && cached.minute === now && cached.current === a.currentModel && cached.def === a.defaultModel) return cached.items;
	const at = Date.now();
	const items = models.map((row) => modelItem(a, row, recent, at));
	modelCatalogues.set(c, { models, recent, minute: now, current: a.currentModel, def: a.defaultModel, items });
	return items;
}

/** The filtered rows in pi's order; the leading current+recent block (remember-model's MRU order) under "Recent". */
function modelOrder(a: Any, filtered: readonly ModelRow[], query: string): (string | PickerGroup)[] {
	const ids = filtered.map(rowId);
	const recent = recentOf(a);
	if (query.trim() || !recent || recent.size === 0) return ids;
	let split = 0;
	while (split < filtered.length) {
		const row = filtered[split]!;
		if (!sameModel(a.currentModel, row) && !recent.has(modelKey(row.provider, row.id))) break;
		split++;
	}
	if (split === 0 || split === filtered.length) return ids;
	return [{ group: "recent", label: "Recent", count: split }, ...ids.slice(0, split), { group: "all", label: "All models", count: filtered.length - split }, ...ids.slice(split)];
}

/** The selected model's facts under the list, then the selector's status lines. */
function modelPreview(a: Any, row: ModelRow | undefined): NativeChild[] {
	const out: NativeChild[] = [];
	if (row) {
		const m: Any = row.model ?? {};
		out.push(text(String(m.name ?? row.id), { role: "omp.picker.title", wrap: "word" }, "title"));
		const kv: { k: string; v: string }[] = [{ k: "Provider", v: row.provider }];
		const ctx = tokens(m.contextWindow);
		if (ctx) kv.push({ k: "Context", v: ctx });
		const max = tokens(m.maxTokens);
		if (max) kv.push({ k: "Max output", v: max });
		if (m.cost && typeof m.cost.input === "number" && typeof m.cost.output === "number") {
			kv.push({ k: "Price", v: m.cost.input === 0 && m.cost.output === 0 ? "free" : `$${costLeg(m.cost.input)} in · $${costLeg(m.cost.output)} out per M` });
		}
		if (m.reasoning === true) kv.push({ k: "Reasoning", v: "yes" });
		if (Array.isArray(m.input) && m.input.length > 0) kv.push({ k: "Input", v: m.input.join(", ") });
		out.push(node("kv", { items: kv, layout: "inline" }, undefined, "facts"));
	}
	if (typeof a.errorMessage === "string" && a.errorMessage) {
		out.push(text([span(a.errorMessage, "error")], { wrap: "word" }, "error"));
	} else if (typeof a.refreshStatusMessage === "string" && a.refreshStatusMessage) {
		out.push(text([span(a.refreshStatusMessage, a.refreshStatusSuccess ? "success" : "muted")], { wrap: "word" }, "refresh"));
	}
	if (!(Array.isArray(a.scopedModelItems) && a.scopedModelItems.length > 0)) {
		out.push(text([span("Only showing models from configured providers. Use /login to add providers.", "warning")], { wrap: "word" }, "hint"));
	}
	return out;
}

const modelSelector: Describer = {
	name: "ModelSelector",
	matches: (c) => is(c, ModelSelectorComponent, "ModelSelectorComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const input = inputState(a.searchInput);
		return [
			cx.supports("picker"),
			a.activeModels,
			a.filteredModels,
			a.filteredModels?.length,
			a.selectedIndex,
			input.value,
			input.cursor,
			a.scope,
			a.scopedModelItems?.length,
			a.allModels?.length,
			a.errorMessage,
			a.refreshStatusMessage,
			a.refreshStatusSuccess,
			a.currentModel,
			a.defaultModel,
			recentOf(a),
			minute(),
			typeof a.onSelectAsDefaultCallback === "function",
		];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const a = c as Any;
		const input = inputState(a.searchInput);
		const filtered: ModelRow[] = Array.isArray(a.filteredModels) ? a.filteredModels : [];
		const items = modelCatalogue(c, a);
		const selectedRow = filtered[Number(a.selectedIndex) || 0];
		const scoped = Array.isArray(a.scopedModelItems) && a.scopedModelItems.length > 0;
		const currentRow = a.currentModel ? { provider: String(a.currentModel.provider), id: String(a.currentModel.id), model: a.currentModel } : undefined;
		const saveKey = boundKey("app.models.save", "ctrl+s");
		const actions: PickerAction[] = [pickerAction("use", "Use model", boundKey("tui.select.confirm", "enter"), { primary: true })];
		if (typeof a.onSelectAsDefaultCallback === "function") actions.push(pickerAction("default", "Set as default", saveKey));
		actions.push(CLOSE_ACTION);
		const ids = filtered.map(rowId);
		const hits = hitsFor(ids, (id) => id, input.value);
		return picker(
			{
				title: "Select model",
				icon: "cpu",
				noun: "models",
				size: "md",
				layout: "rows",
				preview: "below",
				query: input.value,
				cursor: input.cursor,
				placeholder: "Search models…",
				...(scoped
					? {
							tabs: [
								{ id: "all", label: "All", ...(Array.isArray(a.allModels) ? { count: a.allModels.length } : {}) },
								{ id: "scoped", label: "Scoped", count: a.scopedModelItems.length },
							],
							tab: a.scope === "scoped" ? "scoped" : "all",
						}
					: {}),
				columns: MODEL_COLUMNS,
				items,
				order: modelOrder(a, filtered, input.value),
				...(hits ? { hits } : {}),
				selected: selectedRow ? rowId(selectedRow) : null,
				current: currentRow ? [rowId(currentRow)] : [],
				total: items.length,
				empty: a.errorMessage ? String(a.errorMessage) : "No models available. Use /login to add a provider.",
				actions,
			},
			modelPreview(a, selectedRow),
		);
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		const ev = pickerEvent(event);
		if (!ev) return;
		const filtered: ModelRow[] = Array.isArray(a.filteredModels) ? a.filteredModels : [];
		if (ev.kind !== "action") {
			const index = filtered.findIndex((row) => rowId(row) === ev.item);
			if (index < 0) return;
			a.selectedIndex = index;
			a.updateList?.();
			if (ev.kind === "activate") press(a, "tui.select.confirm", "enter");
			return;
		}
		switch (ev.act) {
			case "use":
			case "confirm":
				press(a, "tui.select.confirm", "enter");
				return;
			case "default":
				if (!press(a, "app.models.save", "ctrl+s")) {
					const row = filtered[Number(a.selectedIndex) || 0];
					if (row && typeof a.onSelectAsDefaultCallback === "function") {
						a.dispose?.();
						a.onSelectAsDefaultCallback(row.model);
					}
				}
				return;
			case "tab":
				if ((ev.value === "all" || ev.value === "scoped") && ev.value !== a.scope && typeof a.setScope === "function") {
					a.setScope(ev.value);
					a.scopeHintText?.setText?.(a.getScopeHintText?.() ?? "");
				}
				return;
			case "clear":
				a.searchInput?.setValue?.("");
				a.filterModels?.("");
				return;
			case "close":
			case "cancel":
				press(a, "tui.select.cancel", "escape");
				return;
		}
	},
};

// ── /scoped-models ──────────────────────────────────────────────────────

interface ScopedRow {
	fullId: string;
	model: Any | undefined;
	enabled: boolean;
}

const scopedModels: Describer = {
	name: "ScopedModelsSelector",
	matches: (c) => is(c, undefined, "ScopedModelsSelectorComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const input = inputState(a.searchInput);
		return [cx.supports("picker"), a.filteredItems, a.filteredItems?.length, a.selectedIndex, input.value, input.cursor, a.enabledIds, a.isDirty, a.allIds?.length, textOf(a.refreshStatusText)];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const a = c as Any;
		const input = inputState(a.searchInput);
		const rows: ScopedRow[] = Array.isArray(a.filteredItems) ? a.filteredItems : [];
		const items: PickerItem[] = rows.map((r) => ({
			id: r.fullId,
			label: r.fullId,
			mono: true,
			...(r.model ? { mark: providerMark(String(r.model.provider)) } : { icon: "x-circle", tone: "muted" as const }),
			...(r.model?.name ? { detail: String(r.model.name) } : r.model ? {} : { detail: "unavailable" }),
			...(r.model ? {} : { badges: [{ text: "unavailable", tone: "warning" as const }] }),
		}));
		const selected = rows[Number(a.selectedIndex) || 0];
		const allIds: string[] = Array.isArray(a.allIds) ? a.allIds : [];
		const enabledIds: string[] | null = Array.isArray(a.enabledIds) ? a.enabledIds : null;
		const available = new Set(allIds);
		const enabledCount = enabledIds === null ? allIds.length : enabledIds.filter((id) => available.has(id)).length;
		const unavailable = enabledIds === null ? 0 : enabledIds.length - enabledCount;
		const status: TspSpan[] = [span(enabledIds === null ? "All models enabled" : `${enabledCount} of ${allIds.length} enabled`)];
		if (unavailable > 0) status.push(span(` · ${unavailable} unavailable`, "warning"));
		if (a.isDirty) status.push(span(" · unsaved", "warning"));
		const saveKey = boundKey("app.models.save", "ctrl+s")!;
		const preview: NativeChild[] = [text(status, { wrap: "word" }, "status")];
		preview.push(
			text(
				[span(`Session-only: ${keyLabel(saveKey)} saves to settings · ${keyLabel(boundKey("app.models.reorderUp", "alt+up")!)}/${keyLabel(boundKey("app.models.reorderDown", "alt+down")!)} reorder enabled models`, "muted")],
				{ wrap: "word" },
				"note",
			),
		);
		const refresh = plain(textOf(a.refreshStatusText)).trim();
		if (refresh) preview.push(styledText(textOf(a.refreshStatusText).trim(), { wrap: "word" }, "refresh"));
		const hits = hitsFor(
			rows.map((r) => r.fullId),
			(id) => id,
			input.value,
		);
		return picker(
			{
				title: "Model configuration",
				subtitle: "Models cycled with Ctrl+P",
				icon: "sliders",
				noun: "models",
				size: "md",
				layout: "rows",
				preview: "below",
				query: input.value,
				cursor: input.cursor,
				placeholder: "Search models…",
				items,
				...(hits ? { hits } : {}),
				selected: selected ? selected.fullId : null,
				current: rows.filter((r) => r.model && r.enabled).map((r) => r.fullId),
				total: allIds.length,
				empty: "No matching models",
				actions: [
					pickerAction("toggle", "Toggle", boundKey("tui.select.confirm", "enter"), { primary: true }),
					pickerAction("all", "Enable all", boundKey("app.models.enableAll", "ctrl+a")),
					pickerAction("none", "Clear all", boundKey("app.models.clearAll", "ctrl+x")),
					pickerAction("provider", "Toggle provider", boundKey("app.models.toggleProvider", "ctrl+p")),
					pickerAction("save", a.isDirty ? "Save" : "Saved", saveKey, a.isDirty ? {} : { disabled: "Nothing to save" }),
					CLOSE_ACTION,
				],
			},
			preview,
		);
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		const ev = pickerEvent(event);
		if (!ev) return;
		const rows: ScopedRow[] = Array.isArray(a.filteredItems) ? a.filteredItems : [];
		if (ev.kind !== "action") {
			const index = rows.findIndex((r) => r.fullId === ev.item);
			if (index < 0) return;
			a.selectedIndex = index;
			a.updateList?.();
			if (ev.kind === "activate") press(a, "tui.select.confirm", "enter");
			return;
		}
		switch (ev.act) {
			case "toggle":
			case "confirm":
				press(a, "tui.select.confirm", "enter");
				return;
			case "all":
				press(a, "app.models.enableAll", "ctrl+a");
				return;
			case "none":
				press(a, "app.models.clearAll", "ctrl+x");
				return;
			case "provider":
				press(a, "app.models.toggleProvider", "ctrl+p");
				return;
			case "save":
				press(a, "app.models.save", "ctrl+s");
				return;
			case "clear":
				a.searchInput?.setValue?.("");
				a.refresh?.();
				return;
			case "close":
			case "cancel":
				// Esc cancels even with a search (Ctrl+C would clear it first).
				if (typeof a.handleInput === "function") a.handleInput("\x1b");
				else a.callbacks?.onCancel?.();
				return;
		}
	},
};

// ── SelectList sheets (thinking level, theme, show images) ──────────────

interface SelectItem {
	value: string;
	label?: string;
	description?: string;
}

function listItems(list: Any | undefined): SelectItem[] {
	return Array.isArray(list?.filteredItems) ? list.filteredItems : [];
}

function listSelected(list: Any | undefined): SelectItem | undefined {
	const items = listItems(list);
	return items[Number(list?.selectedIndex) || 0];
}

/** omp's `routeSelectListPicker`: a row click selects (and previews), a second click or Select confirms, Close cancels. */
function routeSelectList(list: Any | undefined, event: NativeUiEvent, onClear?: () => void): void {
	const ev = pickerEvent(event);
	if (!ev || !list) return;
	if (ev.kind === "action") {
		switch (ev.act) {
			case "confirm":
			case "use":
				if (!press(list, "tui.select.confirm", "enter")) {
					const item = listSelected(list);
					if (item) list.onSelect?.(item);
				}
				return;
			case "clear":
				onClear?.();
				return;
			case "close":
			case "cancel":
				if (!press(list, "tui.select.cancel", "escape")) list.onCancel?.();
				return;
		}
		return;
	}
	const items = listItems(list);
	const index = items.findIndex((item) => item.value === ev.item);
	if (index < 0) return;
	const changed = index !== Number(list.selectedIndex);
	if (typeof list.setSelectedIndex === "function") list.setSelectedIndex(index);
	else list.selectedIndex = index;
	if (changed) list.onSelectionChange?.(items[index]);
	if (ev.kind === "activate") {
		if (!press(list, "tui.select.confirm", "enter")) list.onSelect?.(items[index]);
	}
}

const thinkingCatalogues = new WeakMap<object, PickerItem[]>();

const thinkingSelector: Describer = {
	name: "ThinkingSelector",
	matches: (c) => is(c, ThinkingSelectorComponent, "ThinkingSelectorComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const list = a.selectList;
		const input = inputState(a.searchInput);
		return [cx.supports("picker"), a.allItems, list, list?.filteredItems, list?.selectedIndex, input.value, input.cursor, typeof a.onSelectAsDefault === "function"];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const a = c as Any;
		const all: SelectItem[] = Array.isArray(a.allItems) ? a.allItems : [];
		let items = thinkingCatalogues.get(all);
		if (!items) {
			items = all.map((item) => {
				const level = THINKING_LEVELS.findIndex((value) => value === item.value);
				return {
					id: item.value,
					label: item.value,
					...(item.description ? { detail: item.description } : {}),
					...(level >= 0 ? { facts: { depth: level / (THINKING_LEVELS.length - 1) } } : {}),
				};
			});
			thinkingCatalogues.set(all, items);
		}
		const current = all.find((item) => String(item.label ?? "").startsWith("✓"));
		const input = inputState(a.searchInput);
		const list = a.selectList;
		const actions: PickerAction[] = [pickerAction("confirm", "Select", boundKey("tui.select.confirm", "enter"), { primary: true })];
		if (typeof a.onSelectAsDefault === "function") actions.push(pickerAction("default", "Set as default", boundKey("app.thinking.save", "ctrl+s")));
		actions.push(CLOSE_ACTION);
		const cycle = boundKey("app.thinking.cycle", "shift+tab");
		return picker({
			title: "Thinking level",
			...(cycle ? { subtitle: `${keyLabel(cycle)} cycles thinking levels in-session` } : {}),
			icon: "brain",
			noun: "levels",
			size: "md",
			layout: "rows",
			preview: "none",
			// The field shows once typing filters (omp's hook selector); the keys always reach pi's search.
			...(input.value ? { query: input.value, cursor: input.cursor } : { query: null }),
			columns: [{ id: "depth", format: "bar", priority: 1 }],
			items,
			...(input.value ? { order: listItems(list).map((item) => item.value) } : {}),
			selected: listSelected(list)?.value ?? null,
			current: current ? [current.value] : [],
			total: all.length,
			empty: "No matching levels",
			actions,
		});
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		const ev = pickerEvent(event);
		if (ev?.kind === "action" && ev.act === "default") {
			if (!press(a, "app.thinking.save", "ctrl+s")) {
				const item = listSelected(a.selectList);
				if (item) a.onSelectAsDefault?.(item.value);
			}
			return;
		}
		routeSelectList(a.selectList, event, () => {
			a.searchInput?.setValue?.("");
			a.applyFilter?.("");
		});
	},
};

/** The selection a list was opened with (pi keeps the current value only as the preselection). */
const openedWith = new WeakMap<object, string | undefined>();

function selectListSheet(name: string, ctor: Function | undefined, ctorName: string, options: { title: string; icon: string; noun: string; details?: boolean; current: (a: Any, list: Any) => string | undefined; decorate?: (item: SelectItem) => Partial<PickerItem> }): Describer {
	const catalogues = new WeakMap<object, PickerItem[]>();
	return {
		name,
		matches: (c) => is(c, ctor, ctorName),
		fingerprint: (c, cx) => {
			const list = (c as Any).selectList;
			if (list && !openedWith.has(list)) openedWith.set(list, listSelected(list)?.value);
			return [cx.supports("picker"), list, list?.items, list?.filteredItems, list?.selectedIndex];
		},
		build: (c, cx) => {
			if (!cx.supports("picker")) return null;
			const a = c as Any;
			const list = a.selectList;
			if (!list) return null;
			const source: SelectItem[] = Array.isArray(list.items) ? list.items : listItems(list);
			let items = catalogues.get(source);
			if (!items) {
				items = source.map((item) => ({
					id: item.value,
					label: item.label || item.value,
					...(item.description && options.details !== false ? { detail: item.description } : {}),
					...options.decorate?.(item),
				}));
				catalogues.set(source, items);
			}
			const current = options.current(a, list);
			return picker({
				title: options.title,
				icon: options.icon,
				noun: options.noun,
				size: "md",
				layout: "rows",
				preview: "none",
				query: null,
				items,
				order: listItems(list).map((item) => item.value),
				selected: listSelected(list)?.value ?? null,
				current: current !== undefined ? [current] : [],
				total: source.length,
				actions: [pickerAction("confirm", "Select", boundKey("tui.select.confirm", "enter"), { primary: true }), CLOSE_ACTION],
			});
		},
		handleEvent: (c, event) => routeSelectList((c as Any).selectList, event),
	};
}

const themeSelector = selectListSheet("ThemeSelector", ThemeSelectorComponent, "ThemeSelectorComponent", {
	title: "Theme",
	icon: "ink",
	noun: "themes",
	current: (_a, list) => (Array.isArray(list.items) ? (list.items as SelectItem[]).find((item) => item.description === "(current)")?.value : undefined),
	// The check marks the current theme; its "(current)" text stays in the terminal list.
	details: false,
	decorate: (item) => ({ mark: { text: item.value.slice(0, 2), seed: item.value } }),
});

const showImagesSelector = selectListSheet("ShowImagesSelector", ShowImagesSelectorComponent, "ShowImagesSelectorComponent", {
	title: "Show images",
	icon: "image",
	noun: "options",
	current: (_a, list) => openedWith.get(list),
});

// ── /login, /logout provider list ───────────────────────────────────────

function authTypeLabel(authType: unknown, subscription: unknown): string {
	if (authType === "api_key") return "API key";
	return subscription === false ? "account" : "subscription";
}

/** pi's `formatAuthSelectorProviderStatus`, as a detail and a dot. */
function authStatus(p: Any): { text: string; style: string; dot: TspTone } {
	const status: Any | undefined = p.status;
	if (!status) return { text: "Not configured", style: "muted", dot: "muted" };
	if (status.type !== p.authType) return { text: `${authTypeLabel(status.type, p.subscription)} configured`, style: "warning", dot: "warning" };
	const source: unknown = status.source;
	if (!source || source === "OAuth" || source === "stored credential") return { text: "Configured", style: "success", dot: "success" };
	const shown = /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(String(source)) ? `env: ${String(source)}` : String(source);
	return { text: `Configured · ${shown}`, style: "success", dot: "success" };
}

function providerId(p: Any): string {
	return `${String(p.id)}:${String(p.authType)}`;
}

const providerCatalogues = new WeakMap<object, PickerItem[]>();

const oauthSelector: Describer = {
	name: "OAuthSelector",
	matches: (c) => is(c, OAuthSelectorComponent, "OAuthSelectorComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const input = inputState(a.searchInput);
		return [cx.supports("picker"), a.allProviders, a.filteredProviders, a.filteredProviders?.length, a.selectedIndex, input.value, input.cursor, a.mode, a.showAuthTypeLabels];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const a = c as Any;
		const all: Any[] = Array.isArray(a.allProviders) ? a.allProviders : [];
		const filtered: Any[] = Array.isArray(a.filteredProviders) ? a.filteredProviders : [];
		let items = providerCatalogues.get(all);
		if (!items) {
			items = all.map((p) => {
				const status = authStatus(p);
				const name = String(p.name ?? p.id);
				const detail: TspSpan[] = [span(status.text, status.style)];
				if (p.method?.name) detail.push(span(` · ${String(p.method.name)}`, "muted"));
				return {
					id: providerId(p),
					label: name,
					detail,
					mark: initialsMark(name, String(p.id)),
					dot: status.dot,
					...(a.showAuthTypeLabels ? { badges: [{ text: authTypeLabel(p.authType, p.subscription) }] } : {}),
				};
			});
			providerCatalogues.set(all, items);
		}
		const input = inputState(a.searchInput);
		const login = a.mode !== "logout";
		const selected = filtered[Number(a.selectedIndex) || 0];
		const names = new Map(all.map((p) => [providerId(p), String(p.name ?? p.id)]));
		const hits = hitsFor(filtered.map(providerId), (id) => names.get(id) ?? id, input.value);
		return picker({
			title: login ? "Sign in" : "Sign out",
			subtitle: login ? "Select a provider to configure" : "Select a provider to log out",
			icon: "key-round",
			noun: "providers",
			size: "md",
			layout: "cards",
			preview: "none",
			query: input.value,
			cursor: input.cursor,
			placeholder: "Search providers…",
			items,
			...(input.value ? { order: filtered.map(providerId) } : {}),
			...(hits ? { hits } : {}),
			selected: selected ? providerId(selected) : null,
			total: all.length,
			empty: all.length === 0 ? (login ? "No providers available" : "No providers logged in. Use /login first.") : "No matching providers",
			actions: [pickerAction("confirm", login ? "Configure" : "Log out", boundKey("tui.select.confirm", "enter"), login ? { primary: true } : { primary: true, danger: true }), CLOSE_ACTION],
		});
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		const ev = pickerEvent(event);
		if (!ev) return;
		const filtered: Any[] = Array.isArray(a.filteredProviders) ? a.filteredProviders : [];
		if (ev.kind !== "action") {
			const index = filtered.findIndex((p) => providerId(p) === ev.item);
			if (index < 0) return;
			a.selectedIndex = index;
			a.updateList?.();
			if (ev.kind === "activate") press(a, "tui.select.confirm", "enter");
			return;
		}
		switch (ev.act) {
			case "confirm":
				press(a, "tui.select.confirm", "enter");
				return;
			case "clear":
				a.searchInput?.setValue?.("");
				a.filterProviders?.("");
				return;
			case "close":
			case "cancel":
				press(a, "tui.select.cancel", "escape");
				return;
		}
	},
};

// ── /trust ──────────────────────────────────────────────────────────────

const trustSelector: Describer = {
	name: "TrustSelector",
	matches: (c) => is(c, undefined, "TrustSelectorComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		return [cx.supports("picker"), a.trustOptions, a.selectedIndex, a.savedDecision, ((a.children ?? []) as Component[]).filter(isText).map(textOf).join("\0")];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const a = c as Any;
		const options: Any[] = Array.isArray(a.trustOptions) ? a.trustOptions : [];
		const texts = textsBetween((a.children ?? []) as Component[], undefined, a.listContainer);
		// The first text is the title; the cwd and the decisions follow.
		const [title = "Project trust", ...facts] = texts;
		const current = options.findIndex((o) => {
			try {
				return a.isSavedOption?.(o) === true;
			} catch {
				return false;
			}
		});
		return picker({
			title,
			...(facts.length > 0 ? { subtitle: facts.join("\n") } : {}),
			icon: "shield",
			noun: "options",
			size: "md",
			layout: "rows",
			preview: "none",
			query: null,
			items: options.map((o, i) => ({ id: `o${i}`, label: String(o.label ?? ""), icon: o.trusted ? "shield" : "shield-alert", ...(o.trusted ? {} : { tone: "warning" as const }) })),
			selected: options.length > 0 ? `o${Number(a.selectedIndex) || 0}` : null,
			current: current >= 0 ? [`o${current}`] : [],
			actions: [pickerAction("save", "Save", boundKey("tui.select.confirm", "enter"), { primary: true }), CLOSE_ACTION],
		});
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		const ev = pickerEvent(event);
		if (!ev) return;
		if (ev.kind !== "action") {
			const index = Number(ev.item.slice(1));
			if (!ev.item.startsWith("o") || !Number.isInteger(index) || index < 0 || index >= (a.trustOptions?.length ?? 0)) return;
			a.selectedIndex = index;
			a.updateList?.();
			if (ev.kind === "activate") press(a, "tui.select.confirm", "enter");
			return;
		}
		if (ev.act === "save" || ev.act === "confirm") press(a, "tui.select.confirm", "enter");
		else if (ev.act === "close" || ev.act === "cancel") press(a, "tui.select.cancel", "escape");
	},
};

// ── ctx.ui.select / ctx.ui.confirm (and the /login menus) ───────────────

const extensionSelector: Describer = {
	name: "ExtensionSelector",
	matches: (c) => is(c, ExtensionSelectorComponent, "ExtensionSelectorComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const countdown = a.countdown;
		return [cx.supports("picker"), a.options, a.options?.length, a.selectedIndex, a.baseTitle, countdown?.intervalId !== undefined ? countdown?.remainingSeconds : undefined, (a.children as unknown[] | undefined)?.length];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const a = c as Any;
		const options: unknown[] = Array.isArray(a.options) ? a.options : [];
		const [titleLine = "", ...rest] = plain(String(a.baseTitle ?? "")).trim().split(/\r?\n/);
		const description = textsBetween((a.children ?? []) as Component[], a.titleText, a.listContainer);
		const subtitle = [...rest, ...description].join("\n").trim();
		const countdown = a.countdown;
		const seconds = countdown?.intervalId !== undefined ? Number(countdown?.remainingSeconds) : Number.NaN;
		const labels = options.map((o) => plain(String(o)));
		const confirm = labels.length === 2 && labels[0] === "Yes" && labels[1] === "No";
		return picker({
			title: `${titleLine.trim() || "Select"}${Number.isFinite(seconds) ? ` (${seconds}s)` : ""}`,
			...(subtitle ? { subtitle } : {}),
			icon: confirm ? "help" : "list",
			noun: "options",
			size: "md",
			layout: "rows",
			preview: "none",
			query: null,
			items: labels.map((label, i) => ({ id: `o${i}`, label })),
			selected: options.length > 0 ? `o${Number(a.selectedIndex) || 0}` : null,
			total: options.length,
			empty: "No options",
			actions: [pickerAction("confirm", "Select", boundKey("tui.select.confirm", "enter"), { primary: true }), CLOSE_ACTION],
		});
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		const ev = pickerEvent(event);
		if (!ev) return;
		if (ev.kind !== "action") {
			const index = Number(ev.item.slice(1));
			if (!ev.item.startsWith("o") || !Number.isInteger(index) || index < 0 || index >= (a.options?.length ?? 0)) return;
			a.selectedIndex = index;
			a.updateList?.();
			if (ev.kind === "activate") press(a, "tui.select.confirm", "enter");
			return;
		}
		if (ev.act === "confirm") press(a, "tui.select.confirm", "enter");
		else if (ev.act === "close" || ev.act === "cancel") press(a, "tui.select.cancel", "escape");
	},
};

// ── ctx.ui.input: omp's hook-input panel in the composer's place ────────

const extensionInput: Describer = {
	name: "ExtensionInput",
	matches: (c) => is(c, ExtensionInputComponent, "ExtensionInputComponent"),
	fingerprint: (c) => {
		const a = c as Any;
		countdownNode(a.countdown);
		return [a.baseTitle, a.input, textsBetween((a.children ?? []) as Component[], a.titleText, a.input).join("\n"), countdownKey(a.countdown)];
	},
	build: (c) => {
		const a = c as Any;
		if (!a.input) return null;
		const [titleLine = "", ...rest] = plain(String(a.baseTitle ?? "")).trim().split(/\r?\n/);
		const detail = [...rest, ...textsBetween((a.children ?? []) as Component[], a.titleText, a.input)].join("\n").trim();
		const titleRow: NativeChild[] = [text([span(titleLine.trim())], { role: "omp.hook-input.title", wrap: "word", grow: 1 }, "title")];
		const timer = countdownNode(a.countdown);
		if (timer) titleRow.push(node("row", { role: "omp.hook-input.timer", title: "Cancels when the time runs out" }, [timer], "timer"));
		const head: NativeChild[] = [row(titleRow, { gap: "md", align: "baseline" }, "line")];
		if (detail) head.push(text([span(detail)], { role: "omp.hook-input.detail", wrap: "word" }, "detail"));
		return col(
			[
				node("col", { role: "omp.hook-input.head", gap: "xs" }, head, "head"),
				node("col", { role: "omp.hook-input.field" }, [a.input as Component], "field"),
				actionBar([null, button("Cancel", "cancel", { key: boundKey("tui.select.cancel", "escape") }), button("Submit", "submit", { key: boundKey("tui.select.confirm", "enter"), tone: "accent" })]),
			],
			{ role: "omp.overlay.hook-input" },
		);
	},
	handleEvent: (c, event) => {
		if (event.type !== "action") return;
		const a = c as Any;
		if (event.act === "submit") {
			if (!press(a, "tui.select.confirm", "enter")) a.onSubmitCallback?.(a.input?.getValue?.() ?? "");
		} else if (event.act === "cancel" || event.act === "close") {
			if (!press(a, "tui.select.cancel", "escape")) a.onCancelCallback?.();
		}
	},
};

// ── ctx.ui.editor: omp's hook-editor panel ──────────────────────────────

const extensionEditor: Describer = {
	name: "ExtensionEditor",
	matches: (c) => is(c, ExtensionEditorComponent, "ExtensionEditorComponent"),
	fingerprint: (c) => {
		const a = c as Any;
		const children = (a.children ?? []) as Component[];
		return [a.editor, children.length, textsBetween(children, undefined, a.editor).join("\n")];
	},
	build: (c) => {
		const a = c as Any;
		if (!a.editor) return null;
		// The title, then the description, sit above the editor.
		const [title = "", ...details] = textsBetween((a.children ?? []) as Component[], undefined, a.editor);
		const [titleLine = "", ...rest] = title.split(/\r?\n/);
		const detail = [...rest, ...details].join("\n").trim();
		const head: NativeChild[] = [text([span(titleLine.trim())], { role: "omp.hook-editor.title", wrap: "word" }, "title")];
		if (detail) head.push(text([span(detail)], { role: "omp.hook-editor.detail", wrap: "word" }, "detail"));
		const external = boundKey("app.editor.external", "ctrl+g");
		return col(
			[
				node("col", { role: "omp.hook-editor.head", gap: "xs" }, head, "head"),
				node("col", { role: "omp.hook-editor.field" }, [a.editor as Component], "field"),
				actionBar([
					button("Open in editor", "external", { key: external, title: `Edit in your external editor${external ? `  ${keyLabel(external)}` : ""}` }),
					null,
					button("Cancel", "cancel", { key: boundKey("tui.select.cancel", "escape") }),
					button("Submit", "submit", { key: boundKey("tui.select.confirm", "enter"), tone: "accent", title: `Submit  ${keyLabel(boundKey("tui.select.confirm", "enter")!)} · New line  ${keyLabel(boundKey("tui.input.newLine", "shift+enter")!)}` }),
				]),
			],
			{ role: "omp.overlay.hook-editor" },
		);
	},
	handleEvent: (c, event) => {
		if (event.type !== "action") return;
		const a = c as Any;
		switch (event.act) {
			case "submit":
				// pi-tui's submit path (paste markers expanded, the draft cleared, onSubmit).
				if (typeof a.editor?.submitValue === "function") a.editor.submitValue();
				else a.onSubmitCallback?.(a.editor?.getText?.() ?? "");
				return;
			case "cancel":
			case "close":
				if (!press(a, "tui.select.cancel", "escape")) a.onCancelCallback?.();
				return;
			case "external":
				void a.handleOpenExternalEditor?.();
				return;
		}
	},
};

// ── /login dialog: omp's login sheet ────────────────────────────────────

const HINT_RE = /^\(.*\bto (cancel|close|submit)\b.*\)$/i;
const CLICK_RE = /^(cmd|ctrl)\+click to open$/i;
const URL_RE = /^https?:\/\/\S+$/;
const CODE_RE = /^Enter code:\s*(\S+)$/;
const ELLIPSIS_RE = /(\.\.\.|…)$/;

/** The device code, large in a well; a click copies it (terminal-local, `href`). */
function codeWell(code: string, key: string): NativeNode {
	return node(
		"row",
		{ role: "omp.login.code", align: "center", actions: { click: "copy" }, href: code, title: "Copy code" },
		[text([span(code, "mono")], undefined, "value"), node("icon", { name: "copy" }, undefined, "icon")],
		key,
	);
}

/** A link as omp's read-only field: the URL (middle-truncated; a click opens it) and Copy. */
function linkField(url: string, key: string): NativeNode {
	return node(
		"row",
		{ role: "omp.login.link", gap: "sm", align: "center" },
		[
			node("icon", { name: "link" }, undefined, "icon"),
			text([span(url, "mono", { href: url })], { role: "omp.login.url", truncate: "middle", lines: 1, title: url }, "url"),
			node("row", { role: "omp.btn", align: "center", actions: { click: "copy" }, href: url, title: "Copy the link" }, [text("Copy")], "copyLink"),
		],
		key,
	);
}

function loginTitle(a: Any): string {
	const children = (a.children ?? []) as Component[];
	const first = children.find(isText);
	return plain(textOf(first)).trim() || "Sign in";
}

function loginParts(a: Any): { body: NativeChild[]; close: boolean; field: boolean } {
	const kids: Component[] = Array.isArray(a.contentContainer?.children) ? a.contentContainer.children : [];
	const body: NativeChild[] = [];
	let close = false;
	let field = false;
	let lastText = -1;
	for (let i = 0; i < kids.length; i++) {
		const child = kids[i]!;
		if (isText(child)) {
			const t = plain(textOf(child)).trim();
			if (t && !HINT_RE.test(t) && !CLICK_RE.test(t)) lastText = i;
		} else if (!is(child, undefined, "Spacer")) lastText = -1;
	}
	// A prompt's question (and its `e.g.` line) are the texts since the spacer before its field: they label it.
	const labels = new Map<number, number[]>();
	const labelled = new Set<number>();
	for (let i = 0; i < kids.length; i++) {
		const child = kids[i]!;
		if (child !== a.input && !is(child, undefined, "Input")) continue;
		const own: number[] = [];
		for (let k = i - 1; k >= 0 && isText(kids[k]!) && !labelled.has(k); k--) own.unshift(k);
		for (const k of own) labelled.add(k);
		labels.set(i, own);
	}
	for (let i = 0; i < kids.length; i++) {
		const child = kids[i]!;
		if (labelled.has(i)) continue;
		const own = labels.get(i);
		if (own) {
			field = true;
			const parts: NativeChild[] = own.map((k, n) => {
				const t = plain(textOf(kids[k])).trim();
				return n === 0 ? text(t.replace(/:$/, ""), { role: "omp.login.label", wrap: "word" }, `label${n}`) : text([span(t, "muted")], { wrap: "word" }, `label${n}`);
			});
			parts.push(child);
			body.push(node("col", { role: "omp.login.prompt", gap: "sm" }, parts, `i${i}`));
			continue;
		}
		if (is(child, undefined, "Spacer")) continue;
		if (!isText(child)) {
			// AuthUrlComponent and anything else describe themselves.
			body.push(child);
			continue;
		}
		const raw = textOf(child);
		const t = plain(raw).trim();
		if (!t) continue;
		const hint = HINT_RE.exec(t);
		if (hint) {
			if (hint[1]!.toLowerCase() === "close") close = true;
			continue;
		}
		if (CLICK_RE.test(t)) continue;
		const code = CODE_RE.exec(t);
		if (code) {
			body.push(codeWell(code[1]!, `k${i}`));
			continue;
		}
		if (URL_RE.test(t)) {
			body.push(linkField(t, `u${i}`));
			continue;
		}
		if (t.startsWith("> ")) {
			body.push(row([text([span(t.slice(2) || "—", "mono")], { truncate: "end", lines: 1 }, "value")], { role: "omp.login.answer", gap: "sm", align: "baseline" }, `a${i}`));
			continue;
		}
		if (ELLIPSIS_RE.test(t)) {
			// A stage message: the latest one runs, earlier ones are done.
			body.push(
				i === lastText
					? row([node("spinner", { style: "orbit", label: t, tone: "muted" })], { role: "omp.login.waiting", gap: "sm", align: "center" }, `p${i}`)
					: row([node("icon", { name: "check" }, undefined, "icon"), text(t.replace(ELLIPSIS_RE, ""), { wrap: "word" }, "text")], { role: "omp.login.done", gap: "sm", align: "baseline" }, `p${i}`),
			);
			continue;
		}
		body.push(styledText(raw.trim(), { role: "omp.login.lead", wrap: "word" }, `t${i}`));
	}
	return { body, close, field };
}

const loginDialog: Describer = {
	name: "LoginDialog",
	matches: (c) => is(c, LoginDialogComponent, "LoginDialogComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const kids: Component[] = Array.isArray(a.contentContainer?.children) ? a.contentContainer.children : [];
		return [cx.supports("overlay"), loginTitle(a), [...kids], kids.map(textOf).join("\0"), a.authUrl, typeof a.inputResolver === "function", spansThemeId()];
	},
	build: (c, cx) => {
		if (!cx.supports("overlay")) return null;
		const a = c as Any;
		const { body, close, field } = loginParts(a);
		const url: string | undefined = typeof a.authUrl?.url === "string" ? a.authUrl.url : undefined;
		const cancelKey = boundKey("tui.select.cancel", "escape");
		const buttons: (NativeNode | null)[] = [];
		const waitingAnswer = field && typeof a.inputResolver === "function";
		if (url) {
			buttons.push(
				node(
					"row",
					{ role: "omp.btn", gap: "xs", align: "center", actions: { click: "open" }, href: url, title: "Open the sign-in page in your browser", ...(waitingAnswer ? {} : { tone: "accent" as const }) },
					[text("Open sign-in page"), node("icon", { name: "open" }, undefined, "icon")],
					"openLink",
				),
			);
		}
		buttons.push(null, button(close ? "Close" : "Cancel", "cancel", { key: cancelKey }));
		if (waitingAnswer) buttons.push(button("Continue", "submit", { key: boundKey("tui.input.submit", "enter"), tone: "accent" }));
		return node("overlay", { role: "omp.overlay.login", head: loginTitle(a), anchor: "center", size: "md", modal: true }, [
			col([node("col", { role: "omp.login.body", gap: "md" }, body, "body"), actionBar(buttons)], { gap: "lg" }, "sheet"),
		]);
	},
	handleEvent: (c, event) => {
		if (event.type !== "action") return;
		const a = c as Any;
		if (event.act === "cancel" || event.act === "close") {
			if (!press(a, "tui.select.cancel", "escape")) a.cancel?.();
		} else if (event.act === "submit") {
			if (typeof a.input?.onSubmit === "function") a.input.onSubmit(a.input.getValue?.() ?? "");
		} else if (event.act === "copy") void a.authUrl?.copy?.();
	},
};

/** A sign-in URL (pi's AuthUrlComponent): omp's link field; Copy copies in the terminal. */
const authUrl: Describer = {
	name: "AuthUrl",
	matches: (c) => is(c, undefined, "AuthUrlComponent"),
	fingerprint: (c) => [(c as Any).url, textOf((c as Any).hint)],
	build: (c) => {
		const url = String((c as Any).url ?? "");
		if (!url) return null;
		return linkField(url, "link");
	},
	handleEvent: (c, event) => {
		if (event.type === "action" && event.act === "copy") void (c as Any).copy?.();
	},
};

// ── Bordered loader (extension and share flows) ─────────────────────────

const borderedLoader: Describer = {
	name: "BorderedLoader",
	matches: (c) => is(c, BorderedLoader, "BorderedLoader"),
	fingerprint: (c) => [(c as Any).loader, (c as Any).cancellable],
	build: (c) => {
		const a = c as Any;
		const loader: Component | undefined = a.loader;
		if (!loader) return null;
		const children: NativeChild[] = [node("col", { grow: 1 }, [loader], "loader")];
		if (a.cancellable) children.push(button("Cancel", "cancel", { key: boundKey("tui.select.cancel", "escape") }));
		return col([row(children, { gap: "md", align: "center" }, "line")], { role: "omp.overlay.loader" });
	},
	handleEvent: (c, event) => {
		if (event.type === "action" && event.act === "cancel") press((c as Any).loader, "tui.select.cancel", "escape");
	},
};

/** Registered after the transcript's and block describers (describers.ts DESCRIBERS). */
export const PICKER_DESCRIBERS: readonly Describer[] = [
	modelSelector,
	scopedModels,
	thinkingSelector,
	themeSelector,
	showImagesSelector,
	oauthSelector,
	trustSelector,
	extensionSelector,
	extensionInput,
	extensionEditor,
	loginDialog,
	authUrl,
	borderedLoader,
];

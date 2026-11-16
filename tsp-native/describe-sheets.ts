/**
 * pi's session navigation selectors as omp's native picker sheets (oh-my-pi overlays/session-selector.ts,
 * overlays/tree-selector.ts, native/picker.ts).
 *
 * - /resume (`SessionSelectorComponent`): an `lg` sheet over the session list — scopes Current folder / All
 *   projects (the scope column, Tab), sort tabs Threaded / Recent / Fuzzy (Ctrl+S cycles), Named-only and Paths
 *   toggles (Ctrl+N / Ctrl+P), Delete (Ctrl+D, answered in the confirm strip) and Rename (Ctrl+R: pi's rename
 *   `Input` takes the preview pane). Threaded sessions nest as a `tree`; flat orders are day-grouped cards.
 * - /tree (`TreeSelectorComponent`): a `tree` sheet of the visible entries at pi's branch depths, the active
 *   path lit, filter-mode tabs, labels as badges; the label editor (pi's `Input`) takes the preview pane.
 * - /fork (`UserMessageSelectorComponent`): a sheet of the past user messages, the selected one previewed.
 *
 * Keys stay pi's: each sheet's search text and caret come from the component's own state (the terminal holds no
 * field while a sheet is up, so typing reaches pi's `handleInput`). Pointer events — `select`, `activate`,
 * `action` (bar buttons, `tab`, `scope`, the confirm strip's answer, `close`, `clear`) — feed the bound key to
 * the component's `handleInput` where one exists, so every side effect pi runs on a key runs on a click too.
 */
import { SessionSelectorComponent, TreeSelectorComponent, UserMessageSelectorComponent } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import type { Describer } from "./describers.ts";
import { code, md, type NativeChild, type NativeNode, type NativeUiEvent, node, span, text } from "./node.ts";
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

/** One line of display text: control characters and runs of whitespace folded to single spaces. */
function oneLine(s: string): string {
	return s
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The last `max` characters of `s`, led by an ellipsis when cut. */
function tail(s: string, max: number): string {
	return s.length > max ? `…${s.slice(-max)}` : s;
}

function shortenPath(p: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** A path as dim-prefix / strong-tail spans (omp's `cwdSpans`). */
function pathSpans(p: string): TspSpan[] {
	const short = shortenPath(p);
	const cut = short.lastIndexOf("/") + 1;
	return cut > 0 && cut < short.length ? [span(short.slice(0, cut), "path dim"), span(short.slice(cut), "path")] : [span(short, "path")];
}

function validDate(d: unknown): Date | undefined {
	if (d instanceof Date) return Number.isNaN(d.getTime()) ? undefined : d;
	if (typeof d === "string" || typeof d === "number") {
		const parsed = new Date(d);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}
	return undefined;
}

/** omp's `pickerAge`: the compact age of `at` (`now`, `5m`, `2h`, `3d`, `2w`, `6mo`, `1y`), pi's session ages. */
function pickerAge(at: Date, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - at.getTime()) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** omp's `pickerDate`: the absolute local time behind an age (`28 Sep 2026, 18:02`). */
function pickerDate(d: Date): string {
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/** Ages only change by the minute: memos key on this. */
function minute(): number {
	return Math.floor(Date.now() / 60_000);
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
	/** `timeline`: node style; `tree`: nesting depth and disclosure state. */
	node?: "user" | "assistant" | "tool" | "marker";
	depth?: number;
	open?: boolean;
	role?: string;
	title?: string;
}

interface PickerGroup {
	group: string;
	label: TspText;
	count?: number;
}

interface PickerScope {
	id: string;
	label: TspText;
	icon?: string;
	count?: number;
	group?: string;
	disabled?: string | true;
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
	scopes?: readonly PickerScope[];
	scope?: string;
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
	confirm?: { text: TspText; act: string; label?: string } | null;
	focus?: "list" | "scopes" | "tabs" | "strip" | "preview";
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
function boundKey(binding: string, fallback: string): string {
	try {
		const keys = (getKeybindings() as unknown as { getKeys(id: string): string[] }).getKeys(binding);
		if (Array.isArray(keys) && typeof keys[0] === "string" && keys[0] !== "") return keys[0];
	} catch {
		// no keybindings manager
	}
	return fallback;
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

/** Every case-insensitive occurrence of the (lowercase) `tokens` in `label`, merged (omp's `pickerHits`). */
function substringHits(label: string, tokens: readonly string[]): [number, number][] {
	const lower = label.toLowerCase();
	const ranges: [number, number][] = [];
	for (const token of tokens) {
		if (!token) continue;
		for (let from = lower.indexOf(token); from !== -1; from = lower.indexOf(token, from + token.length)) ranges.push([from, from + token.length]);
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [start, end] of ranges) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

/** The plain text of a picker label. */
function labelText(label: TspText): string {
	return typeof label === "string" ? label : label.map((s) => s.t).join("");
}

/** A search Input's text and caret. */
function inputState(input: Any | undefined): { value: string; cursor: number } {
	const value = typeof input?.getValue === "function" ? String(input.getValue()) : String(input?.value ?? "");
	const raw = Number(input?.cursor);
	return { value, cursor: Number.isFinite(raw) ? Math.max(0, Math.min(value.length, raw)) : value.length };
}

function kvNode(pairs: readonly (readonly [string, TspText | undefined])[], key: string): NativeNode | undefined {
	const items: { k: TspText; v: TspText }[] = [];
	for (const [k, v] of pairs) {
		if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
		items.push({ k: [span(k, "muted")], v });
	}
	return items.length > 0 ? node("kv", { items }, undefined, key) : undefined;
}

function previewTitle(t: TspText, key = "title"): NativeNode {
	return text(t, { role: "omp.picker.title", wrap: "word" }, key);
}

// ── Keys fed to the component (its own key paths) ───────────────────────

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
	const arrow = ARROW_FINAL[base];
	if (mods.has("ctrl")) {
		if (/^[a-z]$/.test(base)) return String.fromCharCode(base.charCodeAt(0) - 96);
		if (arrow) return `\x1b[1;5${arrow}`;
	}
	if (mods.has("alt")) {
		if (arrow) return `\x1b[1;3${arrow}`;
		if (base.length === 1) return `\x1b${base}`;
		if (base === "enter") return "\x1b\r";
	}
	if (mods.has("shift")) {
		if (base === "tab") return "\x1b[Z";
		// Legacy shift+letter is the capital.
		if (/^[a-z]$/.test(base)) return base.toUpperCase();
	}
	return undefined;
}

/**
 * Run what pressing `binding` runs: its key goes through `target.handleInput`. False (nothing fed) when the
 * target takes no keys or the bound key has no legacy bytes; callers then run the same path directly.
 */
function press(target: Any | undefined, binding: string, fallback: string): boolean {
	if (!target || typeof target.handleInput !== "function") return false;
	const bytes = keyBytes(boundKey(binding, fallback));
	if (bytes === undefined) return false;
	target.handleInput(bytes);
	return true;
}

// ── /fork: UserMessageSelectorComponent ─────────────────────────────────

interface ForkMessage {
	id: string;
	text: string;
}

function forkMessages(list: Any | undefined): ForkMessage[] {
	return Array.isArray(list?.messages) ? list.messages : [];
}

const forkCatalogues = new WeakMap<object, PickerItem[]>();

function forkItems(messages: ForkMessage[]): PickerItem[] {
	let items = forkCatalogues.get(messages);
	if (items) return items;
	const n = messages.length;
	items = messages.map((m, i) => {
		const raw = String(m?.text ?? "");
		return {
			id: String(m?.id ?? i),
			label: clip(oneLine(raw), 240) || "(empty message)",
			icon: "user",
			facts: { n: `${i + 1} / ${n}` },
			title: clip(raw.trim(), 400),
		};
	});
	forkCatalogues.set(messages, items);
	return items;
}

const forkPreviews = new WeakMap<object, { index: number; n: number; nodes: NativeChild[] }>();

/** The selected message in full, and what forking from it does. */
function forkPreview(message: ForkMessage | undefined, index: number, n: number): NativeChild[] {
	if (!message) return [];
	const cached = forkPreviews.get(message);
	if (cached && cached.index === index && cached.n === n) return cached.nodes;
	const body = String(message.text ?? "").trim();
	const nodes: NativeChild[] = [previewTitle(`Message ${index + 1} of ${n}`)];
	if (body) nodes.push(md(clip(body, 4000), { tone: "user" }, "body"));
	nodes.push(text([span("Forking copies the active path up to this message into a new session and puts the message back in the editor.", "muted")], { wrap: "word" }, "note"));
	forkPreviews.set(message, { index, n, nodes });
	return nodes;
}

const userMessageSelector: Describer = {
	name: "UserMessageSelector",
	matches: (c) => is(c, UserMessageSelectorComponent, "UserMessageSelectorComponent"),
	fingerprint: (c, cx) => {
		const list = (c as Any).messageList;
		const messages = forkMessages(list);
		return [cx.supports("picker"), list, messages, messages.length, list?.selectedIndex];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const list = (c as Any).messageList;
		if (!list || !Array.isArray(list.messages)) return null;
		const messages = forkMessages(list);
		const items = forkItems(messages);
		const index = Math.max(0, Math.min(messages.length - 1, Number(list.selectedIndex) || 0));
		return picker(
			{
				title: "Fork from message",
				subtitle: "Copy the active path up to a message into a new session",
				icon: "git-branch",
				noun: "messages",
				size: "lg",
				layout: "rows",
				preview: "side",
				query: null,
				columns: [{ id: "n", format: "dim", priority: 1 }],
				items,
				selected: items[index]?.id ?? null,
				total: items.length,
				empty: "No user messages found",
				actions: [pickerAction("fork", "Fork", boundKey("tui.select.confirm", "enter"), { primary: true }), CLOSE_ACTION],
			},
			forkPreview(messages[index], index, messages.length),
		);
	},
	handleEvent: (c, event) => {
		const list = (c as Any).messageList;
		const ev = pickerEvent(event);
		if (!ev || !list) return;
		const messages = forkMessages(list);
		const confirm = () => {
			if (!press(list, "tui.select.confirm", "enter")) {
				const message = messages[Number(list.selectedIndex) || 0];
				if (message) list.onSelect?.(message.id);
			}
		};
		if (ev.kind !== "action") {
			const items = forkItems(messages);
			const index = items.findIndex((item) => item.id === ev.item);
			if (index < 0) return;
			list.selectedIndex = index;
			if (ev.kind === "activate") confirm();
			return;
		}
		switch (ev.act) {
			case "fork":
			case "confirm":
				confirm();
				return;
			case "close":
			case "cancel":
				if (!press(list, "tui.select.cancel", "escape")) list.onCancel?.();
				return;
		}
	},
};

// ── /resume: SessionSelectorComponent ───────────────────────────────────

interface SessionInfoLike {
	path: string;
	id?: string;
	cwd?: string;
	name?: string;
	parentSessionPath?: string;
	created?: Date;
	modified?: Date;
	messageCount?: number;
	firstMessage?: string;
	allMessagesText?: string;
}

/** A `SessionList.filteredSessions` row: the session and its place in the threaded tree. */
interface SessionRow {
	session: SessionInfoLike;
	depth?: number;
}

const SESSION_SCOPES: readonly { id: string; label: string; icon: string }[] = [
	{ id: "current", label: "Current folder", icon: "folder" },
	{ id: "all", label: "All projects", icon: "globe" },
];

const SORT_TABS: readonly { id: string; label: string }[] = [
	{ id: "threaded", label: "Threaded" },
	{ id: "recent", label: "Recent" },
	{ id: "relevance", label: "Fuzzy" },
];

const SORT_IDS: readonly string[] = SORT_TABS.map((t) => t.id);

const SESSION_COLUMNS: readonly PickerColumn[] = [
	{ id: "msgs", head: "Msgs", format: "num", priority: 1 },
	{ id: "when", format: "time", priority: 2 },
];

/** Longest prompt or answer excerpt the session preview shows (omp's `PREVIEW_EXCERPT_CHARS`). */
const EXCERPT_CHARS = 1200;
const DAY_MS = 86_400_000;

function sessionRows(list: Any | undefined): SessionRow[] {
	const rows: unknown = list?.filteredSessions;
	if (!Array.isArray(rows)) return [];
	return rows.every((r) => typeof r?.session?.path === "string") ? rows : rows.filter((r) => typeof r?.session?.path === "string");
}

function allSessionsOf(list: Any | undefined): SessionInfoLike[] {
	const all: unknown = list?.allSessions;
	return Array.isArray(all) ? all.filter((s) => typeof s?.path === "string") : [];
}

/** pi's row text: the session's name, else its first message; else its id or file name. */
function sessionLabel(s: SessionInfoLike): string {
	const shown = oneLine(String(s.name ?? s.firstMessage ?? ""));
	if (shown) return shown;
	if (s.id) return String(s.id);
	const slash = s.path.lastIndexOf("/");
	return s.path.slice(slash + 1).replace(/\.jsonl$/, "");
}

function isNamed(s: SessionInfoLike): boolean {
	return typeof s.name === "string" && s.name.trim().length > 0;
}

function isCurrentSession(list: Any, path: string): boolean {
	try {
		return typeof list.isCurrentSessionPath === "function" ? list.isCurrentSessionPath(path) === true : false;
	} catch {
		return false;
	}
}

interface SessionCatalogue {
	key: readonly unknown[];
	items: PickerItem[];
	labels: Map<string, string>;
	current: string[];
}

const sessionCatalogues = new WeakMap<object, SessionCatalogue>();

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The sheet's rows. Flat orders send the whole scope once (typing, the named filter and re-sorting change only
 * `order`); the threaded tree sends its rows at their depths, rebuilt when pi re-threads them.
 */
function sessionCatalogue(c: Component, list: Any, tree: boolean): SessionCatalogue {
	const all: unknown = list.allSessions;
	const key = [all, Array.isArray(all) ? all.length : 0, tree ? list.filteredSessions : null, !!list.showCwd, !!list.showPath, list.currentSessionCanonicalPath, minute()];
	const cached = sessionCatalogues.get(c);
	if (cached && sameKey(cached.key, key)) return cached;
	const sessions = allSessionsOf(list);
	const source: SessionRow[] = tree ? sessionRows(list) : sessions.map((session) => ({ session, depth: 0 }));
	const labels = new Map<string, string>();
	for (const s of sessions) labels.set(s.path, sessionLabel(s));
	for (const r of source) if (!labels.has(r.session.path)) labels.set(r.session.path, sessionLabel(r.session));
	const showCwd = !!list.showCwd;
	const showPath = !!list.showPath;
	const now = Date.now();
	const current: string[] = [];
	// pi canonicalizes (realpath) every path it compares; only a path ending in the current file's name can be it.
	const canonical = typeof list.currentSessionCanonicalPath === "string" ? (list.currentSessionCanonicalPath as string) : undefined;
	const currentName = canonical ? canonical.slice(canonical.lastIndexOf("/") + 1) : undefined;
	const seen = new Set<string>();
	const items: PickerItem[] = [];
	for (const r of source) {
		const s = r.session;
		if (seen.has(s.path)) continue;
		seen.add(s.path);
		const depth = Math.max(0, Number(r.depth) || 0);
		const isCurrent = !!currentName && (s.path === canonical || (s.path.endsWith(currentName) && isCurrentSession(list, s.path)));
		if (isCurrent) current.push(s.path);
		const detail: TspSpan[] = [];
		const sep = () => {
			if (detail.length > 0) detail.push(span(" · ", "dim"));
		};
		if (isNamed(s)) {
			const first = oneLine(String(s.firstMessage ?? ""));
			if (first && first !== "(no messages)") detail.push(span(clip(first, 160), "dim"));
		}
		if (showCwd && s.cwd) {
			sep();
			detail.push(...pathSpans(s.cwd));
		}
		if (showPath) {
			sep();
			detail.push(...pathSpans(s.path));
		}
		const badges: { text: string; tone?: TspTone; title?: string }[] = [];
		if (isCurrent) badges.push({ text: "current", tone: "accent", title: "The session you are in" });
		// Threaded forks sit under their parent; elsewhere the badge says where they came from.
		if (s.parentSessionPath && depth === 0) {
			const parent = labels.get(s.parentSessionPath) ?? shortenPath(s.parentSessionPath);
			badges.push({ text: "fork", title: `Forked from “${clip(parent, 80)}”` });
		}
		const modified = validDate(s.modified);
		const title = [modified ? pickerDate(modified) : undefined, shortenPath(s.path)].filter((t): t is string => !!t).join("\n");
		items.push({
			id: s.path,
			label: clip(labels.get(s.path) ?? s.path, 240),
			...(detail.length > 0 ? { detail } : {}),
			// pi colours named sessions; the sheet marks them with a tag.
			...(isNamed(s) ? { icon: "tag" } : {}),
			facts: { msgs: Math.max(0, Number(s.messageCount) || 0), when: modified ? pickerAge(modified, now) : "" },
			...(badges.length > 0 ? { badges } : {}),
			...(tree ? { depth } : {}),
			title,
		});
	}
	const catalogue: SessionCatalogue = { key, items, labels, current };
	sessionCatalogues.set(c, catalogue);
	return catalogue;
}

/** Day group of a session's last activity, relative to local midnight today (omp's `sessionDayGroup`). */
function dayGroup(modified: Date | undefined, startOfToday: number): { id: string; label: string } {
	const at = modified?.getTime() ?? 0;
	if (at >= startOfToday) return { id: "today", label: "Today" };
	if (at >= startOfToday - DAY_MS) return { id: "yesterday", label: "Yesterday" };
	if (at >= startOfToday - 6 * DAY_MS) return { id: "week", label: "This week" };
	return { id: "earlier", label: "Earlier" };
}

/** pi's filtered rows in its order; recency orders under day headers (Today, Yesterday, This week, Earlier). */
function sessionOrder(rows: readonly SessionRow[], byRecency: boolean): (string | PickerGroup)[] {
	const ids = rows.map((r) => r.session.path);
	if (!byRecency || rows.length === 0) return ids;
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const groups = rows.map((r) => dayGroup(validDate(r.session.modified), startOfToday));
	const order: (string | PickerGroup)[] = [];
	for (let i = 0; i < rows.length; i++) {
		const group = groups[i]!;
		if (i === 0 || groups[i - 1]!.id !== group.id) {
			let count = 1;
			while (i + count < rows.length && groups[i + count]!.id === group.id) count++;
			order.push({ group: `${group.id}-${i}`, label: group.label, count });
		}
		order.push(ids[i]!);
	}
	return order;
}

/** pi's `re:<pattern>` as a global, case-insensitive regex; undefined when empty or invalid. */
function regexOf(pattern: string): RegExp | undefined {
	if (!pattern) return undefined;
	try {
		return new RegExp(pattern, "gi");
	} catch {
		return undefined;
	}
}

/** Hit ranges for pi's query syntax: `re:<pattern>` regex matches, else its words and "quoted phrases". */
function sessionHits(ids: readonly string[], labels: ReadonlyMap<string, string>, query: string): Record<string, [number, number][]> | undefined {
	const trimmed = query.trim();
	if (!trimmed) return undefined;
	let find: (label: string) => [number, number][];
	if (trimmed.startsWith("re:")) {
		const re = regexOf(trimmed.slice(3).trim());
		if (!re) return undefined;
		find = (label) => {
			const out: [number, number][] = [];
			re.lastIndex = 0;
			for (let m = re.exec(label); m && out.length < 32; m = re.exec(label)) {
				if (m[0].length === 0) {
					re.lastIndex++;
					continue;
				}
				out.push([m.index, m.index + m[0].length]);
			}
			return out;
		};
	} else {
		const tokens: string[] = [];
		const rest = trimmed.replace(/"([^"]*)"/g, (_m, phrase: string) => {
			const p = phrase.trim().toLowerCase();
			if (p) tokens.push(p);
			return " ";
		});
		for (const word of rest.replaceAll('"', " ").toLowerCase().split(/\s+/)) if (word) tokens.push(word);
		if (tokens.length === 0) return undefined;
		find = (label) => substringHits(label, tokens);
	}
	const out: Record<string, [number, number][]> = {};
	for (const id of ids) {
		const label = labels.get(id);
		if (!label) continue;
		const ranges = find(clip(label, 240));
		if (ranges.length > 0) out[id] = ranges;
	}
	return out;
}

const sessionPreviews = new WeakMap<object, { current: boolean; parent: string | undefined; nodes: NativeChild[] }>();

/** omp's `sessionPreview`: the session's name, its facts, then its first prompt and the tail of the rest. */
function sessionPreview(s: SessionInfoLike | undefined, labels: ReadonlyMap<string, string>, current: boolean): NativeChild[] {
	if (!s) return [];
	const parent = s.parentSessionPath ? (labels.get(s.parentSessionPath) ?? shortenPath(s.parentSessionPath)) : undefined;
	const cached = sessionPreviews.get(s);
	if (cached && cached.current === current && cached.parent === parent) return cached.nodes;
	const created = validDate(s.created);
	const modified = validDate(s.modified);
	const nodes: NativeChild[] = [previewTitle(clip(sessionLabel(s), 400))];
	if (current) nodes.push(text([span("The session you are in", "accent")], undefined, "current"));
	const facts = kvNode(
		[
			["Name", isNamed(s) ? String(s.name).trim() : undefined],
			["Folder", s.cwd ? pathSpans(s.cwd) : undefined],
			["File", pathSpans(s.path)],
			["Created", created ? pickerDate(created) : undefined],
			["Modified", modified ? pickerDate(modified) : undefined],
			["Messages", String(Math.max(0, Number(s.messageCount) || 0))],
			["Forked from", parent ? clip(parent, 120) : undefined],
		],
		"facts",
	);
	if (facts) nodes.push(facts);
	const first = String(s.firstMessage ?? "").trim();
	const all = String(s.allMessagesText ?? "");
	const rest = first && all.startsWith(first) ? all.slice(first.length).trim() : "";
	const conversation: NativeChild[] = [];
	if (first && first !== "(no messages)") conversation.push(md(clip(first, EXCERPT_CHARS), { tone: "user" }, "first"));
	if (rest) conversation.push(md(tail(rest, EXCERPT_CHARS), undefined, "rest"));
	if (conversation.length > 0) nodes.push(node("section", { head: "Conversation" }, conversation, "conversation"));
	sessionPreviews.set(s, { current, parent, nodes });
	return nodes;
}

/** The rename panel in the preview pane: pi's own rename `Input` (described by its own describer; the terminal focuses it). */
function renamePreview(a: Any, target: SessionInfoLike | undefined): NativeChild[] {
	const nodes: NativeChild[] = [previewTitle("Rename session")];
	if (target) nodes.push(text([span(clip(sessionLabel(target), 200), "muted")], { wrap: "word" }, "target"));
	if (a.renameInput && typeof a.renameInput.render === "function") nodes.push(a.renameInput as Component);
	nodes.push(text([span("Enter saves the name · Esc goes back to the list", "muted")], { wrap: "word" }, "hint"));
	return nodes;
}

function sessionSubtitle(a: Any, list: Any): TspText | undefined {
	const header: Any | undefined = a.header;
	const status: Any | undefined = header?.statusMessage;
	if (status && typeof status.message === "string" && status.message) return [span(status.message, status.type === "error" ? "error" : "accent")];
	if (header?.loading) {
		const p: Any | undefined = header.loadProgress;
		return [span(p ? `Loading ${p.loaded}/${p.total}…` : "Loading…", "muted")];
	}
	if (a.scope === "all") return "Sessions of every project";
	const cwd = allSessionsOf(list).find((s) => s.cwd)?.cwd;
	return cwd ? pathSpans(cwd) : undefined;
}

/** pi's empty-list copy (the sheet's Tab action offers the other scope next to it). */
function sessionEmpty(a: Any, list: Any): string {
	const all = a.scope === "all" || !!list.showCwd;
	if (a.nameFilter === "named") return all ? "No named sessions found" : "No named sessions in this folder";
	return all ? "No sessions found" : "No sessions in this folder yet";
}

/** Press `binding` on `target`; when that fed nothing or changed nothing `probe` sees, run pi's own `direct` path. */
function pressOrRun(target: Any, binding: string, fallback: string, probe: () => unknown, direct: () => void): void {
	const before = probe();
	if (press(target, binding, fallback) && probe() !== before) return;
	direct();
}

function sessionActions(a: Any, list: Any, selected: SessionInfoLike | undefined, selectedIsCurrent: boolean): PickerAction[] {
	const confirmKey = boundKey("tui.select.confirm", "enter");
	if (a.mode === "rename") return [pickerAction("rename-save", "Save name", confirmKey, { primary: true }), { ...CLOSE_ACTION, label: "Cancel" }];
	const none = selected ? undefined : "No session selected";
	const scopeLoading = (a.scope === "all" ? a.allLoad : a.currentLoad) != null;
	const actions: PickerAction[] = [pickerAction("resume", "Resume", confirmKey, { primary: true, ...(none ? { disabled: none } : {}) })];
	const deleteOff = none ?? (selectedIsCurrent ? "Cannot delete the currently active session" : undefined);
	actions.push(pickerAction("delete", "Delete", boundKey("app.session.delete", "ctrl+d"), deleteOff ? { disabled: deleteOff } : {}));
	if (a.canRename !== false) {
		const renameOff = none ?? (scopeLoading ? "Wait for the sessions to load" : undefined);
		actions.push(pickerAction("rename", "Rename", boundKey("app.session.rename", "ctrl+r"), renameOff ? { disabled: renameOff } : {}));
	}
	actions.push(pickerAction("named", "Named only", boundKey("app.session.toggleNamedFilter", "ctrl+n"), { on: a.nameFilter === "named" }));
	actions.push(pickerAction("path", "Paths", boundKey("app.session.togglePath", "ctrl+p"), { on: !!list.showPath }));
	// Bound to Tab: rsttyd's empty state offers it ("No sessions in this folder yet" → All projects).
	actions.push(pickerAction("scope", a.scope === "all" ? "Current folder" : "All projects", boundKey("tui.input.tab", "tab")));
	actions.push(CLOSE_ACTION);
	return actions;
}

const sessionSelector: Describer = {
	name: "SessionSelector",
	matches: (c) => is(c, SessionSelectorComponent, "SessionSelectorComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const list: Any | undefined = a.sessionList;
		const header: Any | undefined = a.header;
		const input = inputState(list?.searchInput);
		return [
			cx.supports("picker"),
			list,
			a.mode,
			a.scope,
			a.sortMode,
			a.nameFilter,
			a.canRename,
			a.renameTargetPath,
			list?.allSessions,
			list?.allSessions?.length,
			list?.filteredSessions,
			list?.filteredSessions?.length,
			list?.selectedIndex,
			list?.showCwd,
			list?.showPath,
			list?.confirmingDeletePath,
			list?.currentSessionCanonicalPath,
			input.value,
			input.cursor,
			header?.loading,
			header?.loadProgress?.loaded,
			header?.loadProgress?.total,
			header?.statusMessage,
			a.currentSessions?.length,
			a.allSessions?.length,
			a.currentLoad,
			a.allLoad,
			minute(),
		];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const a = c as Any;
		const list: Any | undefined = a.sessionList;
		if (!list || !Array.isArray(list.filteredSessions) || !Array.isArray(list.allSessions)) return null;
		const input = inputState(list.searchInput);
		const query = input.value;
		const sortMode = SORT_IDS.includes(a.sortMode) ? String(a.sortMode) : "threaded";
		// pi threads sessions only without a query; searching ranks them flat.
		const tree = sortMode === "threaded" && !query.trim();
		const rows = sessionRows(list);
		const catalogue = sessionCatalogue(c, list, tree);
		const selected = rows[Math.max(0, Math.min(rows.length - 1, Number(list.selectedIndex) || 0))]?.session;
		const selectedIsCurrent = selected ? catalogue.current.includes(selected.path) : false;
		const renaming = a.mode === "rename";
		const confirming = typeof list.confirmingDeletePath === "string" ? (list.confirmingDeletePath as string) : undefined;
		const loading = a.header?.loading === true && rows.length === 0 && catalogue.items.length === 0;
		const hits = sessionHits(
			rows.map((r) => r.session.path),
			catalogue.labels,
			query,
		);
		const scopes: PickerScope[] = SESSION_SCOPES.map((s) => {
			const loaded: unknown = s.id === "current" ? a.currentSessions : a.allSessions;
			return { ...s, ...(Array.isArray(loaded) ? { count: loaded.length } : {}) };
		});
		let preview: NativeChild[];
		if (renaming) {
			const targetPath = typeof a.renameTargetPath === "string" ? a.renameTargetPath : undefined;
			preview = renamePreview(a, targetPath ? (allSessionsOf(list).find((s) => s.path === targetPath) ?? selected) : selected);
		} else preview = sessionPreview(selected, catalogue.labels, selectedIsCurrent);
		const confirmLabel = confirming !== undefined ? (catalogue.labels.get(confirming) ?? shortenPath(confirming)) : undefined;
		const subtitle = sessionSubtitle(a, list);
		const search = 're:regex, "exact phrase"';
		return picker(
			{
				title: "Resume session",
				...(subtitle !== undefined ? { subtitle } : {}),
				icon: "history",
				noun: "sessions",
				size: "lg",
				layout: tree ? "tree" : "cards",
				preview: "side",
				query,
				cursor: input.cursor,
				placeholder: a.scope === "all" ? `Search all sessions — ${search}` : `Search sessions — ${search}`,
				scopes,
				scope: a.scope === "all" ? "all" : "current",
				tabs: SORT_TABS,
				tab: sortMode,
				columns: SESSION_COLUMNS,
				items: catalogue.items,
				order: sessionOrder(rows, sortMode === "recent" || (sortMode === "relevance" && !query.trim())),
				...(hits ? { hits } : {}),
				selected: confirming ?? selected?.path ?? null,
				current: catalogue.current,
				// Every session of the scope, whatever the named filter hides ("3 of 40").
				total: Math.max(catalogue.items.length, allSessionsOf(list).length),
				actions: sessionActions(a, list, selected, selectedIsCurrent),
				state: loading ? "loading" : "ready",
				...(loading ? { message: "Loading sessions…" } : {}),
				empty: sessionEmpty(a, list),
				confirm:
					confirmLabel !== undefined
						? { text: `Delete “${clip(confirmLabel, 80)}”? The session file goes to the trash (or is removed).`, act: "delete-confirm", label: "Delete" }
						: null,
				focus: renaming ? "preview" : "list",
			},
			preview,
		);
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		const list: Any | undefined = a.sessionList;
		const ev = pickerEvent(event);
		if (!ev || !list) return;
		const rows = sessionRows(list);
		const selectedPath = () => rows[Number(list.selectedIndex) || 0]?.session.path;
		const resume = () => {
			if (press(a, "tui.select.confirm", "enter")) return;
			const path = selectedPath();
			if (path) list.onSelect?.(path);
		};
		// Rename: Enter saves (pi's rename Input submits), Esc goes back to the list.
		if (a.mode === "rename") {
			if (ev.kind !== "action") return;
			if (ev.act === "rename-save" || ev.act === "confirm") {
				if (!press(a, "tui.select.confirm", "enter")) void a.confirmRename?.(inputState(a.renameInput).value);
			} else if (ev.act === "close" || ev.act === "cancel") {
				if (!press(a, "tui.select.cancel", "escape")) a.exitRenameMode?.();
			}
			return;
		}
		// Delete confirmation: pi takes only Enter (delete) and Esc (keep) until it is answered.
		if (typeof list.confirmingDeletePath === "string") {
			if (ev.kind !== "action") return;
			if (ev.act === "delete-confirm") {
				if (!press(a, "tui.select.confirm", "enter")) {
					const path = list.confirmingDeletePath;
					list.setConfirmingDeletePath?.(null);
					void list.onDeleteSession?.(path);
				}
			} else if (ev.act === "cancel" || ev.act === "close") {
				if (!press(a, "tui.select.cancel", "escape")) list.setConfirmingDeletePath?.(null);
			}
			return;
		}
		if (ev.kind !== "action") {
			const index = rows.findIndex((r) => r.session.path === ev.item);
			if (index < 0) return;
			list.selectedIndex = index;
			list.selectionTouched = true;
			if (ev.kind === "activate") resume();
			return;
		}
		switch (ev.act) {
			case "resume":
			case "confirm":
				resume();
				return;
			case "delete":
				if (!press(a, "app.session.delete", "ctrl+d")) list.startDeleteConfirmationForSelectedSession?.();
				return;
			case "rename":
				pressOrRun(
					a,
					"app.session.rename",
					"ctrl+r",
					() => a.mode,
					() => {
						const path = selectedPath();
						if (path) list.onRenameSession?.(path);
					},
				);
				return;
			case "named":
				pressOrRun(
					a,
					"app.session.toggleNamedFilter",
					"ctrl+n",
					() => a.nameFilter,
					() => a.toggleNameFilter?.(),
				);
				return;
			case "path":
				pressOrRun(
					a,
					"app.session.togglePath",
					"ctrl+p",
					() => list.showPath,
					() => {
						list.showPath = !list.showPath;
						list.onTogglePath?.(list.showPath);
					},
				);
				return;
			case "scope":
				// The scope column names its scope; the bar's button (Tab) toggles.
				if (ev.value !== undefined && ev.value === a.scope) return;
				pressOrRun(
					a,
					"tui.input.tab",
					"tab",
					() => a.scope,
					() => a.toggleScope?.(),
				);
				return;
			case "tab": {
				// pi cycles Threaded → Recent → Fuzzy on its sort key: press it until the clicked tab is on.
				const target = ev.value;
				if (target === undefined || !SORT_IDS.includes(target)) return;
				for (let i = 0; i < SORT_IDS.length && a.sortMode !== target; i++) {
					pressOrRun(
						a,
						"app.session.toggleSort",
						"ctrl+s",
						() => a.sortMode,
						() => a.toggleSortMode?.(),
					);
				}
				return;
			}
			case "clear":
				list.searchInput?.setValue?.("");
				list.filterSessions?.("");
				return;
			case "close":
			case "cancel":
				if (!press(a, "tui.select.cancel", "escape")) list.onCancel?.();
				return;
		}
	},
};

// ── /tree: TreeSelectorComponent ────────────────────────────────────────

const TREE_FILTER_TABS: readonly { id: string; label: string }[] = [
	{ id: "default", label: "Default" },
	{ id: "no-tools", label: "No tools" },
	{ id: "user-only", label: "User only" },
	{ id: "labeled-only", label: "Labeled" },
	{ id: "all", label: "All" },
];

/** The key pi binds to each filter mode (`default` sets it; the others toggle between it and `default`). */
const TREE_FILTER_KEYS: Readonly<Record<string, readonly [binding: string, fallback: string]>> = {
	default: ["app.tree.filter.default", "ctrl+d"],
	"no-tools": ["app.tree.filter.noTools", "ctrl+t"],
	"user-only": ["app.tree.filter.userOnly", "ctrl+u"],
	"labeled-only": ["app.tree.filter.labeledOnly", "ctrl+l"],
	all: ["app.tree.filter.all", "ctrl+a"],
};

/** A `TreeList.filteredNodes` row: the session tree node and its display indent. */
interface TreeFlatNode {
	node: { entry: Any; label?: string; labelTimestamp?: string };
	indent?: number;
}

function treeNodes(list: Any | undefined): TreeFlatNode[] {
	const rows: unknown = list?.filteredNodes;
	if (!Array.isArray(rows)) return [];
	const ok = (r: Any) => typeof r?.node?.entry?.id === "string";
	return rows.every(ok) ? rows : rows.filter(ok);
}

/** The text of a message's content (pi's `extractFullContent`). */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") out += block.text;
	return out;
}

const TOOL_ICONS: Readonly<Record<string, string>> = { read: "read", write: "write", edit: "edit", bash: "bash", grep: "search", find: "search", ls: "folder" };

/** The lead icon of an entry, by what it records. */
function entryIcon(entry: Any): string | undefined {
	switch (entry.type) {
		case "message": {
			const role = entry.message?.role;
			if (role === "user") return "user";
			if (role === "assistant") return "sparkle";
			if (role === "toolResult") return TOOL_ICONS[String(entry.message?.toolName ?? "")] ?? "tool";
			if (role === "bashExecution") return "bash";
			return "message";
		}
		case "custom_message":
			return "extension";
		case "compaction":
			return "compaction";
		case "branch_summary":
			return "git-branch";
		case "model_change":
			return "model";
		case "thinking_level_change":
			return "thinking";
		case "custom":
			return "puzzle";
		case "context_edit":
			return "scissors";
		case "label":
			return "tag";
		case "session_info":
			return "pen";
		default:
			return undefined;
	}
}

/**
 * pi's row text for an entry (`user: …`, `[read: …]`, `[compaction: 12k tokens]`) as styled spans, on one line:
 * pi folds `\n` and `\t` out of message text only, so a tool argument's line breaks (and any `\r`, U+2028, U+2029)
 * are folded here, one space each (span boundaries and search hit offsets stay put).
 */
function entryLabel(list: Any, flat: TreeFlatNode): TspSpan[] {
	try {
		if (typeof list.getEntryDisplayText === "function") {
			const spans = lineToSpans(String(list.getEntryDisplayText(flat.node, false))).map((s) => ({ ...s, t: s.t.replace(/[\r\n\t\u2028\u2029]/g, " ") }));
			if (spans.some((s) => s.t.trim().length > 0)) return clipSpans(spans, 300);
		}
	} catch {
		// fall back to the entry type
	}
	return [span(`[${String(flat.node.entry.type ?? "entry")}]`, "dim")];
}

/** At most `max` characters of styled text, an ellipsis marking the cut. */
function clipSpans(spans: readonly TspSpan[], max: number): TspSpan[] {
	const out: TspSpan[] = [];
	let left = max;
	for (const s of spans) {
		if (s.t.length <= left) {
			out.push(s);
			left -= s.t.length;
			continue;
		}
		out.push({ ...s, t: `${s.t.slice(0, left)}…` });
		break;
	}
	return out;
}

function labelTimestamp(list: Any, ts: unknown): string | undefined {
	if (typeof ts !== "string" || !ts) return undefined;
	try {
		if (typeof list.formatLabelTimestamp === "function") return String(list.formatLabelTimestamp(ts));
	} catch {
		// fall through
	}
	const d = validDate(ts);
	return d ? pickerDate(d) : undefined;
}

/** Whether pi would fold the entry on its fold key (it has visible children and starts a branch or the tree). */
function isFoldable(list: Any, id: string): boolean {
	try {
		return typeof list.isFoldable === "function" && list.isFoldable(id) === true;
	} catch {
		return false;
	}
}

function isFolded(list: Any, id: string): boolean {
	const folded: unknown = list.foldedNodes;
	return folded instanceof Set && folded.has(id);
}

const treeItemCache = new WeakMap<object, { sig: string; item: PickerItem }>();

/** A visible entry as a `tree` row: pi's depth, a disclosure where it folds, the active path lit, its label a badge. */
function treeItem(list: Any, flat: TreeFlatNode, themeId: number): PickerItem {
	const entry = flat.node.entry;
	const id = String(entry.id);
	const indent = Math.max(0, Number(flat.indent) || 0);
	const depth = list.multipleRoots ? Math.max(0, indent - 1) : indent;
	const folded = isFolded(list, id);
	const open = folded ? false : isFoldable(list, id) ? true : undefined;
	const active = list.activePathIds instanceof Set && list.activePathIds.has(id);
	// Folded to one line: a label's line breaks would break the badge (and the row).
	const label = (typeof flat.node.label === "string" && oneLine(flat.node.label)) || undefined;
	const stamp = label && list.showLabelTimestamps ? labelTimestamp(list, flat.node.labelTimestamp) : undefined;
	const sig = `${depth}|${open}|${active}|${label ?? ""}|${stamp ?? ""}|${themeId}`;
	const cached = treeItemCache.get(flat);
	if (cached && cached.sig === sig && cached.item.id === id) return cached.item;
	const icon = entryIcon(entry);
	const when = validDate(entry.timestamp);
	const item: PickerItem = {
		id,
		label: entryLabel(list, flat),
		depth,
		...(icon ? { icon } : {}),
		...(open !== undefined ? { open } : {}),
		...(active ? { dot: "accent" as const } : {}),
		...(label ? { badges: [{ text: stamp ? `${label} · ${stamp}` : label, tone: "warning" as const, title: "Label" }] } : {}),
		...(when ? { title: pickerDate(when) } : {}),
	};
	treeItemCache.set(flat, { sig, item });
	return item;
}

const treeCatalogues = new WeakMap<object, PickerItem[]>();

/** The visible entries in pi's order; the previous array while every row is unchanged (moving the selection). */
function treeItems(c: Component, list: Any, nodes: readonly TreeFlatNode[]): PickerItem[] {
	const themeId = spansThemeId();
	const items = nodes.map((flat) => treeItem(list, flat, themeId));
	const previous = treeCatalogues.get(c);
	if (previous && previous.length === items.length && previous.every((item, i) => item === items[i])) return previous;
	treeCatalogues.set(c, items);
	return items;
}

const treeTotals = new WeakMap<object, number>();

/** Entries pi can show at all (it never lists `usage` entries). */
function treeTotal(list: Any): number {
	const flat: unknown = list.flatNodes;
	if (!Array.isArray(flat)) return 0;
	let total = treeTotals.get(flat);
	if (total === undefined) {
		total = flat.filter((f) => f?.node?.entry?.type !== "usage").length;
		treeTotals.set(flat, total);
	}
	return total;
}

/** Longest entry body the tree preview shows. */
const TREE_PREVIEW_CHARS = 4000;

function entryTitle(entry: Any): string {
	switch (entry.type) {
		case "message": {
			const m: Any = entry.message ?? {};
			if (m.role === "user") return "User message";
			if (m.role === "assistant") return "Assistant";
			if (m.role === "toolResult") return `Tool result · ${String(m.toolName ?? "tool")}`;
			if (m.role === "bashExecution") return "Shell command";
			return String(m.role ?? "Message");
		}
		case "custom_message":
			return `Extension message · ${String(entry.customType ?? "")}`;
		case "compaction":
			return "Compaction";
		case "branch_summary":
			return "Branch summary";
		case "model_change":
			return "Model change";
		case "thinking_level_change":
			return "Thinking level change";
		case "custom":
			return `Custom entry · ${String(entry.customType ?? "")}`;
		case "context_edit":
			return "Context edit";
		case "label":
			return "Label change";
		case "session_info":
			return "Session name";
		default:
			return String(entry.type ?? "Entry");
	}
}

/** The tool call a tool result answers, as pi's tree shows it (`[read: ~/x.ts:1-20]`). */
function toolCallText(list: Any, m: Any): string | undefined {
	const call: Any | undefined = m.toolCallId && list.toolCallMap instanceof Map ? list.toolCallMap.get(m.toolCallId) : undefined;
	if (!call) return undefined;
	try {
		if (typeof list.formatToolCall === "function") return String(list.formatToolCall(call.name, call.arguments ?? {}));
	} catch {
		// fall through
	}
	return String(call.name ?? "");
}

/** The selected entry's body: prose as markdown, commands and outputs as code. */
function entryBody(list: Any, entry: Any): NativeChild[] {
	const out: NativeChild[] = [];
	switch (entry.type) {
		case "message": {
			const m: Any = entry.message ?? {};
			if (m.role === "bashExecution") {
				if (m.command) out.push(code(clip(String(m.command), TREE_PREVIEW_CHARS), { lang: "bash" }, "command"));
				const output = String(m.output ?? "").trimEnd();
				if (output) out.push(code(tail(output, TREE_PREVIEW_CHARS), undefined, "output"));
				break;
			}
			const body = contentText(m.content).trim();
			if (m.role === "toolResult") {
				if (body) out.push(code(clip(body, TREE_PREVIEW_CHARS), m.isError ? { tone: "error" } : undefined, "output"));
				break;
			}
			if (body) out.push(md(clip(body, TREE_PREVIEW_CHARS), m.role === "user" ? { tone: "user" } : undefined, "body"));
			if (m.role === "assistant" && m.errorMessage) out.push(text([span(clip(oneLine(String(m.errorMessage)), 400), "error")], { wrap: "word" }, "error"));
			else if (m.role === "assistant" && !body) out.push(text([span(m.stopReason === "aborted" ? "(aborted)" : "(no text — tool calls only)", "muted")], undefined, "empty"));
			break;
		}
		case "custom_message": {
			const body = contentText(entry.content).trim();
			if (body) out.push(md(clip(body, TREE_PREVIEW_CHARS), undefined, "body"));
			break;
		}
		case "compaction":
		case "branch_summary":
			if (entry.summary) out.push(md(clip(String(entry.summary), TREE_PREVIEW_CHARS), undefined, "body"));
			break;
	}
	return out;
}

const treePreviews = new WeakMap<object, { sig: string; nodes: NativeChild[] }>();

/** omp's tree preview: the entry's kind, its label, facts, then its content as the transcript shows it. */
function treePreview(list: Any, flat: TreeFlatNode | undefined): NativeChild[] {
	if (!flat) return [];
	const entry = flat.node.entry;
	const label = typeof flat.node.label === "string" ? oneLine(flat.node.label) : "";
	const active = list.activePathIds instanceof Set && list.activePathIds.has(entry.id);
	const leaf = entry.id === list.currentLeafId;
	const sig = `${label}|${active}|${leaf}`;
	const cached = treePreviews.get(entry);
	if (cached && cached.sig === sig) return cached.nodes;
	const nodes: NativeChild[] = [previewTitle(entryTitle(entry))];
	if (label) nodes.push(text([span(`[${label}]`, "warning")], { wrap: "word" }, "label"));
	if (leaf) nodes.push(text([span("You are here", "accent")], undefined, "here"));
	else if (active) nodes.push(text([span("On the active path", "accent")], undefined, "path"));
	const m: Any = entry.type === "message" ? (entry.message ?? {}) : {};
	const when = validDate(entry.timestamp);
	const exit = m.role === "bashExecution" ? (m.cancelled ? "cancelled" : m.exitCode !== undefined && m.exitCode !== null ? String(m.exitCode) : undefined) : undefined;
	const facts = kvNode(
		[
			["Time", when ? pickerDate(when) : undefined],
			["Model", m.role === "assistant" && m.model ? `${m.provider ? `${String(m.provider)}/` : ""}${String(m.model)}` : entry.type === "model_change" ? `${entry.provider ? `${String(entry.provider)}/` : ""}${String(entry.modelId ?? "")}` : undefined],
			["Stopped", m.role === "assistant" && m.stopReason && m.stopReason !== "stop" && m.stopReason !== "toolUse" ? String(m.stopReason) : undefined],
			["Call", m.role === "toolResult" ? toolCallText(list, m) : undefined],
			["Exit", exit],
			["Thinking", entry.type === "thinking_level_change" ? String(entry.thinkingLevel ?? "") : undefined],
			["Tokens before", entry.type === "compaction" && typeof entry.tokensBefore === "number" ? entry.tokensBefore.toLocaleString("en-US") : undefined],
			["Name", entry.type === "session_info" ? String(entry.name ?? "(empty)") : undefined],
			["Label", entry.type === "label" ? String(entry.label ?? "(cleared)") : undefined],
			["Target", entry.type === "context_edit" || entry.type === "label" ? (entry.targetId ? String(entry.targetId) : undefined) : undefined],
			["Edit", entry.type === "context_edit" ? (entry.replacement === null ? "omit" : "replace") : undefined],
		],
		"facts",
	);
	if (facts) nodes.push(facts);
	nodes.push(...entryBody(list, entry));
	treePreviews.set(entry, { sig, nodes });
	return nodes;
}

const labelPreviews = new WeakMap<object, NativeChild[]>();

/** The label editor in the preview pane: pi's own label `Input` (described by its own describer; the terminal focuses it). */
function labelPreview(labelInput: Any, target: TreeFlatNode | undefined, list: Any): NativeChild[] {
	const cached = labelPreviews.get(labelInput);
	if (cached) return cached;
	const nodes: NativeChild[] = [previewTitle("Label")];
	if (target) nodes.push(text(entryLabel(list, target), { wrap: "word" }, "target"));
	nodes.push(text([span("Empty removes the label", "muted")], undefined, "hint"));
	if (labelInput.input && typeof labelInput.input.render === "function") nodes.push(labelInput.input as Component);
	labelPreviews.set(labelInput, nodes);
	return nodes;
}

function treeEmpty(list: Any): string {
	if (list.searchQuery) return "No entries match";
	switch (list.filterMode) {
		case "user-only":
			return "No user messages";
		case "labeled-only":
			return "No labeled entries";
		default:
			return "No entries found";
	}
}

const treeSelector: Describer = {
	name: "TreeSelector",
	matches: (c) => is(c, TreeSelectorComponent, "TreeSelectorComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const list: Any | undefined = a.treeList;
		return [
			cx.supports("picker"),
			list,
			list?.filteredNodes,
			list?.filteredNodes?.length,
			list?.selectedIndex,
			list?.filterMode,
			list?.searchQuery,
			list?.showLabelTimestamps,
			list?.multipleRoots,
			list?.currentLeafId,
			list?.foldedNodes?.size,
			a.labelInput,
			spansThemeId(),
		];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const a = c as Any;
		const list: Any | undefined = a.treeList;
		if (!list || !Array.isArray(list.filteredNodes)) return null;
		const nodes = treeNodes(list);
		const items = treeItems(c, list, nodes);
		const selected = nodes[Math.max(0, Math.min(nodes.length - 1, Number(list.selectedIndex) || 0))];
		const selectedId = selected ? String(selected.node.entry.id) : undefined;
		const query = typeof list.searchQuery === "string" ? list.searchQuery : "";
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		let hits: Record<string, [number, number][]> | undefined;
		if (tokens.length > 0) {
			for (const item of items) {
				const ranges = substringHits(labelText(item.label), tokens);
				if (ranges.length > 0) (hits ??= {})[item.id] = ranges;
			}
		}
		const labelInput: Any | null = a.labelInput ?? null;
		const filterMode = typeof list.filterMode === "string" && TREE_FILTER_KEYS[list.filterMode] ? list.filterMode : "default";
		let actions: PickerAction[];
		if (labelInput) {
			actions = [pickerAction("label-save", "Save label", boundKey("tui.select.confirm", "enter"), { primary: true }), { ...CLOSE_ACTION, label: "Cancel" }];
		} else {
			const none = selected ? undefined : "No entry selected";
			const folded = selectedId !== undefined && isFolded(list, selectedId);
			const foldable = selectedId !== undefined && isFoldable(list, selectedId);
			actions = [
				pickerAction("switch", "Switch", boundKey("tui.select.confirm", "enter"), { primary: true, ...(none ? { disabled: none } : {}) }),
				pickerAction("label", "Label", boundKey("app.tree.editLabel", "shift+l"), none ? { disabled: none } : {}),
				pickerAction("copy", "Copy", boundKey("app.message.copy", "ctrl+x"), none ? { disabled: none } : {}),
				folded
					? pickerAction("fold", "Unfold", boundKey("app.tree.unfoldOrDown", "ctrl+right"))
					: pickerAction("fold", "Fold", boundKey("app.tree.foldOrUp", "ctrl+left"), foldable ? {} : { disabled: "Only a branch start folds" }),
			];
			if (items.some((item) => item.badges !== undefined)) {
				actions.push(pickerAction("label-time", "Label times", boundKey("app.tree.toggleLabelTimestamp", "shift+t"), { on: list.showLabelTimestamps === true }));
			}
			actions.push(CLOSE_ACTION);
		}
		const preview = labelInput ? labelPreview(labelInput, nodes.find((n) => n.node.entry.id === labelInput.entryId) ?? selected, list) : treePreview(list, selected);
		const leaf = typeof list.currentLeafId === "string" ? list.currentLeafId : undefined;
		return picker(
			{
				title: "Session tree",
				subtitle: "Switch to any point of this session",
				icon: "git-branch",
				noun: "entries",
				size: "lg",
				layout: "tree",
				preview: "side",
				query,
				cursor: query.length,
				placeholder: "Type to search entries…",
				tabs: TREE_FILTER_TABS,
				tab: filterMode,
				items,
				...(hits ? { hits } : {}),
				selected: selectedId ?? null,
				current: leaf ? [leaf] : [],
				total: treeTotal(list),
				empty: treeEmpty(list),
				actions,
				focus: labelInput ? "preview" : "list",
			},
			preview,
		);
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		const list: Any | undefined = a.treeList;
		const ev = pickerEvent(event);
		if (!ev || !list) return;
		const labelInput: Any | null = a.labelInput ?? null;
		// The label editor owns the sheet while open: Enter saves, Esc cancels (pi's LabelInput keys).
		if (labelInput) {
			if (ev.kind !== "action") return;
			if (ev.act === "label-save" || ev.act === "confirm") {
				if (!press(a, "tui.select.confirm", "enter")) {
					const value = inputState(labelInput.input).value.trim();
					labelInput.onSubmit?.(labelInput.entryId, value || undefined);
				}
			} else if (ev.act === "close" || ev.act === "cancel") {
				if (!press(a, "tui.select.cancel", "escape")) labelInput.onCancel?.();
			}
			return;
		}
		const nodes = treeNodes(list);
		const selected = () => nodes[Number(list.selectedIndex) || 0];
		const confirm = () => {
			if (press(a, "tui.select.confirm", "enter")) return;
			const flat = selected();
			if (flat) list.onSelect?.(flat.node.entry.id);
		};
		if (ev.kind !== "action") {
			const index = nodes.findIndex((n) => n.node.entry.id === ev.item);
			if (index < 0) return;
			list.selectedIndex = index;
			if (ev.kind === "activate") confirm();
			return;
		}
		switch (ev.act) {
			case "switch":
			case "confirm":
				confirm();
				return;
			case "tab": {
				const mode = ev.value;
				const keys = mode !== undefined ? TREE_FILTER_KEYS[mode] : undefined;
				if (!mode || !keys || list.filterMode === mode) return;
				pressOrRun(
					a,
					keys[0],
					keys[1],
					() => list.filterMode,
					() => {
						list.filterMode = mode;
						list.foldedNodes?.clear?.();
						list.applyFilter?.();
					},
				);
				return;
			}
			case "label": {
				// What the label key runs (its fallback, a capital letter, would otherwise land in the search).
				const flat = selected();
				if (flat) list.onLabelEdit?.(flat.node.entry.id, flat.node.label);
				return;
			}
			case "label-time":
				list.showLabelTimestamps = !list.showLabelTimestamps;
				return;
			case "copy":
				if (!press(a, "app.message.copy", "ctrl+x")) list.copySelected?.();
				return;
			case "fold": {
				const flat = selected();
				if (!flat) return;
				const id = String(flat.node.entry.id);
				const folded = isFolded(list, id);
				if (!folded && !isFoldable(list, id)) return;
				pressOrRun(
					a,
					folded ? "app.tree.unfoldOrDown" : "app.tree.foldOrUp",
					folded ? "ctrl+right" : "ctrl+left",
					() => list.filteredNodes,
					() => {
						const set: unknown = list.foldedNodes;
						if (!(set instanceof Set)) return;
						if (folded) set.delete(id);
						else set.add(id);
						list.applyFilter?.();
					},
				);
				return;
			}
			case "clear":
				// pi's Esc with a query clears it (and the folds), leaving the selector open.
				if (!list.searchQuery) return;
				pressOrRun(
					a,
					"tui.select.cancel",
					"escape",
					() => list.searchQuery,
					() => {
						list.searchQuery = "";
						list.foldedNodes?.clear?.();
						list.applyFilter?.();
					},
				);
				return;
			case "close":
			case "cancel":
				if (!press(a, "tui.select.cancel", "escape")) list.onCancel?.();
				return;
		}
	},
};

/** Registered with the picker describers (describers.ts DESCRIBERS). */
export const SHEET_DESCRIBERS: readonly Describer[] = [sessionSelector, treeSelector, userMessageSelector];

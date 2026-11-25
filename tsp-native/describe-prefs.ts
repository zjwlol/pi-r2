import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import type { Describer } from "./describers.ts";
import { col, type NativeChild, type NativeNode, type NativeUiEvent, node, stripAnsi } from "./node.ts";
import type { TspProps, TspText } from "./wire.ts";

type Any = Record<string, any>;

function is(component: unknown, ctor: Function | undefined, name: string): boolean {
	if (!component || typeof component !== "object") return false;
	if (ctor && component instanceof ctor) return true;
	for (let proto = Object.getPrototypeOf(component); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		if (proto.constructor?.name === name) return true;
	}
	return false;
}

function plain(s: unknown): string {
	return typeof s === "string" ? stripAnsi(s).replaceAll("\x1b_pi:c\x07", "") : "";
}

function plainLine(s: unknown): string {
	return plain(s).replace(/\s+/g, " ").trim();
}

function textOf(c: unknown): string {
	const t = (c as Any | undefined)?.text;
	return typeof t === "string" ? t : "";
}

function isText(c: unknown): boolean {
	return is(c, undefined, "Text") || is(c, undefined, "TruncatedText");
}

function kids(c: unknown): Component[] {
	const children = (c as Any | undefined)?.children;
	return Array.isArray(children) ? children : [];
}

function inputState(input: Any | undefined): { value: string; cursor: number } {
	const value = typeof input?.getValue === "function" ? String(input.getValue()) : String(input?.value ?? "");
	const raw = Number(input?.cursor);
	return { value, cursor: Number.isFinite(raw) ? Math.max(0, Math.min(value.length, raw)) : value.length };
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
	enter: "\r",
	return: "\r",
	escape: "\x1b",
	esc: "\x1b",
	tab: "\t",
	space: " ",
	up: "\x1b[A",
	down: "\x1b[B",
};

/**
 * Pi accepts legacy key bytes even in extended keyboard mode.
 */
function keyBytes(key: string): string | undefined {
	const parts = key.toLowerCase().split("+");
	const base = parts.pop() ?? "";
	const mods = parts.filter((part) => part.length > 0);
	if (mods.length === 0) return NAMED_KEYS[base] ?? (base.length === 1 ? base : undefined);
	if (mods.length === 1 && mods[0] === "ctrl" && /^[a-z]$/.test(base)) return String.fromCharCode(base.charCodeAt(0) - 96);
	return undefined;
}

/**
 * Bundled pi keeps a separate keybindings manager.
 */
function boundKey(binding: string, fallback: string): string {
	try {
		const keys = (getKeybindings() as unknown as { getKeys(id: string): string[] }).getKeys(binding);
		if (Array.isArray(keys) && typeof keys[0] === "string" && keys[0] !== "") return keys[0];
	} catch {
	}
	return fallback;
}

type Binding = "confirm" | "cancel" | "up" | "down" | "tab";

const BINDINGS: Readonly<Record<Binding, readonly [string, string]>> = {
	confirm: ["tui.select.confirm", "enter"],
	cancel: ["tui.select.cancel", "escape"],
	up: ["tui.select.up", "up"],
	down: ["tui.select.down", "down"],
	tab: ["tui.input.tab", "tab"],
};

function press(target: Any | undefined, binding: Binding): boolean {
	if (!target || typeof target.handleInput !== "function") return false;
	const [id, fallback] = BINDINGS[binding];
	const bytes = keyBytes(boundKey(id, fallback)) ?? keyBytes(fallback);
	if (bytes === undefined) return false;
	target.handleInput(bytes);
	return true;
}

function keyCaps(key: string): string[] {
	return key
		.split("+")
		.filter((part) => part.length > 0)
		.map((part) => (part === "escape" ? "esc" : part));
}

function capsOf(binding: Binding): string[] {
	const [id, fallback] = BINDINGS[binding];
	return keyCaps(boundKey(id, fallback));
}

interface PrefsOption {
	value: string;
	label: string;
	detail?: string;
}

type PrefsControl =
	| { k: "switch"; on: boolean }
	| { k: "choice"; value: string; options: readonly PrefsOption[]; style?: "auto" | "segmented" | "menu"; mono?: boolean }
	| { k: "number"; value: number; min?: number; max?: number; step?: number; unit?: string; labels?: Readonly<Record<string, string>> }
	| { k: "action"; label: string; act: string };

interface PrefsRow {
	id: string;
	label: string;
	hint?: string;
	warning?: string;
	disabled?: string;
	control: PrefsControl;
}

interface PrefsSection {
	id: string;
	title: string;
	page?: string;
	rows: PrefsRow[];
}

interface PrefsPage {
	id: string;
	label: string;
	icon?: string;
	group?: string;
	disabled?: string;
}

interface PrefsEditing {
	row: string;
	option?: string;
}

interface PrefsProps {
	title: string;
	pages: readonly PrefsPage[];
	page: string;
	lead?: string;
	query?: string;
	cursor?: number;
	sections: readonly PrefsSection[];
	focus?: string | null;
	editing?: PrefsEditing | null;
}

function prefs(p: PrefsProps, children?: readonly NativeChild[]): NativeNode {
	return node("prefs", p as unknown as TspProps, children && children.length > 0 ? children : undefined);
}

interface PickerItem {
	id: string;
	label: TspText;
	detail?: TspText;
	icon?: string;
	disabled?: string | true;
	title?: string;
}

interface PickerAction {
	id: string;
	label: string;
	keys?: readonly string[];
	primary?: boolean;
	danger?: boolean;
	end?: boolean;
	disabled?: string | true;
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
	items?: readonly PickerItem[];
	order?: readonly string[];
	hits?: Readonly<Record<string, readonly (readonly [number, number])[]>>;
	selected?: string | null;
	current?: readonly string[];
	total?: number;
	preview?: "side" | "below" | "none";
	actions?: readonly PickerAction[];
	empty?: TspText;
}

function picker(p: PickerProps): NativeNode {
	return node("picker", p as unknown as TspProps);
}

type PickerEvent = { readonly kind: "select" | "activate"; readonly item: string } | { readonly kind: "action"; readonly act: string; readonly value: string | undefined };

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

function hitsFor(items: readonly PickerItem[], ids: readonly string[], query: string): Record<string, [number, number][]> | undefined {
	if (!query.trim()) return undefined;
	const labels = new Map(items.map((item) => [item.id, typeof item.label === "string" ? item.label : item.label.map((sp) => sp.t).join("")]));
	const out: Record<string, [number, number][]> = {};
	for (const id of ids) {
		const ranges = fuzzyHits(labels.get(id) ?? id, query);
		if (ranges) out[id] = ranges;
	}
	return out;
}

interface SubOption {
	value: string;
	label?: string;
	description?: string;
}

function listItems(list: Any | undefined): SubOption[] {
	return Array.isArray(list?.filteredItems) ? list.filteredItems : [];
}

function listSelected(list: Any | undefined): SubOption | undefined {
	return listItems(list)[Number(list?.selectedIndex) || 0];
}

function submenuOptions(m: Any): SubOption[] {
	return Array.isArray(m.allOptions) ? m.allOptions : listItems(m.selectList);
}

function optionLabel(o: SubOption): string {
	return plainLine(o.label || o.value).replace(/^✓\s*/, "");
}

function optionCurrent(o: SubOption): boolean {
	return plain(o.label).trimStart().startsWith("✓");
}

function submenuTexts(m: Any): { title: string; description: string[] } {
	const children = kids(m);
	const first = children.find(isText);
	const end = children.indexOf((m.searchInput ?? m.selectList) as Component);
	const description: string[] = [];
	for (let i = first ? children.indexOf(first) + 1 : 0; i < (end < 0 ? children.length : end); i++) {
		const child = children[i];
		if (!isText(child)) continue;
		const t = plain(textOf(child)).trim();
		if (t) description.push(t);
	}
	return { title: plainLine(textOf(first)), description };
}

function submenuIcon(title: string): string {
	if (/theme/i.test(title)) return "ink";
	if (/thinking/i.test(title)) return "brain";
	if (/model/i.test(title)) return "cpu";
	return "list";
}

const submenuCatalogues = new WeakMap<object, PickerItem[]>();

function submenuItems(all: SubOption[]): PickerItem[] {
	let items = submenuCatalogues.get(all);
	if (!items) {
		items = all.map((o) => {
			const detail = plainLine(o.description);
			return { id: String(o.value), label: optionLabel(o), ...(detail ? { detail } : {}) };
		});
		submenuCatalogues.set(all, items);
	}
	return items;
}

function submenuPicker(m: Any): NativeNode | null {
	const list: Any | undefined = m.selectList;
	if (!list || !Array.isArray(list.filteredItems)) return null;
	const all = submenuOptions(m);
	const items = submenuItems(all);
	const { title, description } = submenuTexts(m);
	const input = m.searchInput ? inputState(m.searchInput) : undefined;
	const filtering = !!input && input.value.trim() !== "";
	const shown = listItems(list).map((o) => String(o.value));
	const step = /^Step (\d+)\/(\d+)/.exec(description[0] ?? "");
	const back = step !== null && Number(step[1]) > 1;
	const hits = input && filtering ? hitsFor(items, shown, input.value) : undefined;
	const selected = listSelected(list);
	const model = /model/i.test(`${title} ${description.join(" ")}`);
	return picker({
		title: title || "Select",
		...(description.length > 0 ? { subtitle: description.join("\n") } : {}),
		icon: submenuIcon(title),
		noun: model && !/level/i.test(title) ? "models" : "options",
		size: "md",
		layout: "rows",
		preview: "none",
		...(input ? { query: input.value, cursor: input.cursor, placeholder: "Type to filter…" } : { query: null }),
		items,
		...(filtering || shown.length !== items.length ? { order: shown } : {}),
		...(hits ? { hits } : {}),
		selected: selected ? String(selected.value) : null,
		current: all.filter(optionCurrent).map((o) => String(o.value)),
		total: all.length,
		empty: "No matching options",
		actions: [
			{ id: "confirm", label: "Select", keys: capsOf("confirm"), primary: true },
			{ id: "close", label: back ? "Back" : "Close", keys: capsOf("cancel"), end: true },
		],
	});
}

function submenuFingerprint(m: Any | undefined): unknown[] {
	const list: Any | undefined = m?.selectList;
	const input = m?.searchInput ? inputState(m.searchInput) : undefined;
	return [m, m?.allOptions, list, list?.filteredItems, list?.filteredItems?.length, list?.selectedIndex, input?.value, input?.cursor];
}

function selectIndex(list: Any, index: number, notify: boolean): void {
	const items = listItems(list);
	if (index < 0 || index >= items.length) return;
	const changed = index !== Number(list.selectedIndex);
	if (typeof list.setSelectedIndex === "function") list.setSelectedIndex(index);
	else list.selectedIndex = index;
	// Pi previews themes through this hook.
	if (changed && notify) list.onSelectionChange?.(items[index]);
}

function selectOption(m: Any, value: string, notify: boolean): boolean {
	const list: Any | undefined = m.selectList;
	if (!list) return false;
	const index = listItems(list).findIndex((o) => String(o.value) === value);
	if (index < 0) return false;
	selectIndex(list, index, notify);
	return true;
}

function routeSubmenu(m: Any, ev: PickerEvent): void {
	if (ev.kind === "action") {
		switch (ev.act) {
			case "confirm":
			case "use":
				press(m, "confirm");
				return;
			case "clear":
				if (m.searchInput) {
					m.searchInput.setValue?.("");
					m.applyFilter?.("");
				}
				return;
			case "close":
			case "cancel":
				press(m, "cancel");
				return;
		}
		return;
	}
	if (!selectOption(m, ev.item, true)) return;
	if (ev.kind === "activate") press(m, "confirm");
}

const selectSubmenu: Describer = {
	name: "SelectSubmenu",
	matches: (c) => is(c, undefined, "SelectSubmenu"),
	fingerprint: (c, cx) => [cx.supports("picker"), ...submenuFingerprint(c as Any)],
	build: (c, cx) => (cx.supports("picker") ? submenuPicker(c as Any) : null),
	handleEvent: (c, event) => {
		const ev = pickerEvent(event);
		if (ev) routeSubmenu(c as Any, ev);
	},
};

function activeStep(c: Component): Any | undefined {
	const active = (c as Any).activeComponent;
	return is(active, undefined, "SelectSubmenu") ? (active as Any) : undefined;
}

const steppedSubmenu: Describer = {
	name: "SteppedSubmenu",
	matches: (c) => is(c, undefined, "SteppedSubmenu"),
	fingerprint: (c, cx) => [cx.supports("picker"), ...submenuFingerprint(activeStep(c))],
	build: (c, cx) => {
		const active = activeStep(c);
		return cx.supports("picker") && active ? submenuPicker(active) : null;
	},
	handleEvent: (c, event) => {
		const ev = pickerEvent(event);
		const active = activeStep(c);
		if (!ev || !active) return;
		// Only the stepper can move between steps.
		if (ev.kind === "action" && (ev.act === "close" || ev.act === "cancel")) press(c as Any, "cancel");
		else if (ev.kind === "action" && (ev.act === "confirm" || ev.act === "use")) press(c as Any, "confirm");
		else if (ev.kind === "activate") {
			if (selectOption(active, ev.item, true)) press(c as Any, "confirm");
		} else routeSubmenu(active, ev);
	},
};

interface SettingItem {
	id: string;
	label?: string;
	description?: string;
	currentValue?: string;
	values?: readonly string[];
	submenu?: unknown;
}

interface PageDef {
	id: string;
	label: string;
	icon: string;
	lead: string;
}

/**
 * Each page must cover a contiguous run of pi's settings.
 */
const SETTINGS_PAGES: readonly PageDef[] = [
	{ id: "general", label: "General", icon: "sliders", lead: "Compaction, images and skill commands." },
	{ id: "terminal", label: "Terminal", icon: "terminal", lead: "The editor, padding and how pi draws in your terminal." },
	{ id: "agent", label: "Agent", icon: "sparkle", lead: "How queued messages reach the agent and how pi talks to providers." },
	{ id: "session", label: "Session", icon: "history", lead: "What the transcript shows, startup, navigation and per-model overrides." },
	{ id: "appearance", label: "Appearance", icon: "appearance", lead: "Layout mode, fullscreen behavior and the color theme." },
];

const SETTINGS_PLACES: Readonly<Record<string, readonly [page: string, section: string]>> = {
	autocompact: ["general", "Context"],
	"show-images": ["general", "Images"],
	"image-width-cells": ["general", "Images"],
	"auto-resize-images": ["general", "Images"],
	"block-images": ["general", "Images"],
	"skill-commands": ["general", "Skills"],
	"show-hardware-cursor": ["terminal", "Editor"],
	"editor-padding": ["terminal", "Editor"],
	"output-padding": ["terminal", "Editor"],
	"autocomplete-max-visible": ["terminal", "Editor"],
	"clear-on-shrink": ["terminal", "Rendering"],
	"terminal-progress": ["terminal", "Rendering"],
	"steering-mode": ["agent", "Message queue"],
	"follow-up-mode": ["agent", "Message queue"],
	transport: ["agent", "Providers"],
	"share-destination": ["agent", "Providers"],
	"http-idle-timeout": ["agent", "Providers"],
	"cache-warming-mode": ["agent", "Providers"],
	"hide-thinking": ["session", "Transcript"],
	"mermaid-rendering": ["session", "Transcript"],
	"cache-miss-notices": ["session", "Transcript"],
	"collapse-changelog": ["session", "Startup"],
	"quiet-startup": ["session", "Startup"],
	"install-telemetry": ["session", "Startup"],
	"default-project-trust": ["session", "Startup"],
	"double-escape-action": ["session", "Navigation"],
	"tree-filter-mode": ["session", "Navigation"],
	warnings: ["session", "Overrides"],
	"model-thinking": ["session", "Overrides"],
	"tui-mode": ["appearance", "Layout"],
	"fullscreen-exit-output": ["appearance", "Fullscreen"],
	"fullscreen-scrollbar": ["appearance", "Fullscreen"],
	"fullscreen-copy-on-select": ["appearance", "Fullscreen"],
	"fullscreen-wheel-scroll-lines": ["appearance", "Fullscreen"],
	theme: ["appearance", "Theme"],
};

const NUMBER_UNITS: Readonly<Record<string, string>> = { "image-width-cells": "cells", "autocomplete-max-visible": "items" };

const CHOICE_SUBMENUS: ReadonlySet<string> = new Set(["theme", "light-theme", "dark-theme"]);

const MENU_MAX = 12;

interface Place {
	page: string;
	section: string;
}

const placeCache = new WeakMap<object, { length: number; places: ReadonlyMap<string | undefined, Place> }>();

function settingPlaces(items: readonly SettingItem[]): ReadonlyMap<string | undefined, Place> {
	const cached = placeCache.get(items);
	if (cached && cached.length === items.length) return cached.places;
	const places = new Map<string | undefined, Place>();
	let last: Place = { page: SETTINGS_PAGES[0]!.id, section: "General" };
	for (const item of items) {
		if (!item || typeof item.id !== "string") continue;
		const known = SETTINGS_PLACES[item.id];
		if (known) last = { page: known[0], section: known[1] };
		places.set(item.id, last);
	}
	placeCache.set(items, { length: items.length, places });
	return places;
}

function slug(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "section"
	);
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function settingsListOf(a: Any): Any | undefined {
	if (is(a.settingsList, undefined, "SettingsList")) return a.settingsList;
	return kids(a).find((k) => is(k, undefined, "SettingsList")) as Any | undefined;
}

function displayItems(list: Any): SettingItem[] {
	const items = list.searchEnabled ? list.filteredItems : list.items;
	return Array.isArray(items) ? items : [];
}

function displayIndex(list: Any, id: string): number {
	return displayItems(list).findIndex((item) => item?.id === id);
}

function openItemOf(list: Any): SettingItem | undefined {
	if (!list.submenuComponent) return undefined;
	const items = displayItems(list);
	const at = list.submenuItemIndex ?? list.selectedIndex;
	return items[Number(at) || 0];
}

function onOff(v: string): string {
	return v === "true" ? "on" : v === "false" ? "off" : v;
}

function themeLabel(value: string): string {
	if (value === "/") return "automatic";
	const slash = value.indexOf("/");
	return slash > 0 ? `automatic · ${value.slice(0, slash)} / ${value.slice(slash + 1)}` : value;
}

const IDENT = /^[a-z0-9][a-z0-9._-]*$/;

function valueControl(item: SettingItem): PrefsControl {
	const values = (item.values ?? []).map(String);
	const current = String(item.currentValue ?? "");
	if (values.length === 2 && values.includes("true") && values.includes("false")) return { k: "switch", on: current === "true" };
	if (values.length === 1) return { k: "action", label: capitalize(plainLine(values[0])), act: "run" };
	if (values.length >= 3 && values.every((v) => /^\d+$/.test(v))) {
		const unit = NUMBER_UNITS[item.id];
		const labels: Record<string, string> = {};
		for (const v of values) labels[String(Number(v))] = unit ? `${v} ${unit}` : v;
		const n = Number(current);
		return { k: "number", value: current !== "" && Number.isFinite(n) ? n : Number(values[0]), labels };
	}
	const options = values.map((v) => ({ value: v, label: onOff(v) }));
	const mono = values.every((v) => IDENT.test(v) && v !== "true" && v !== "false");
	return { k: "choice", value: current, options, ...(mono ? { mono: true } : {}) };
}

function valueString(item: SettingItem, value: unknown): string | undefined {
	const values = (item.values ?? []).map(String);
	let out: string | undefined;
	if (typeof value === "boolean") out = value ? "true" : "false";
	else if (typeof value === "number") out = values.find((v) => Number(v) === value);
	else if (typeof value === "string") out = value;
	return out !== undefined && values.includes(out) ? out : undefined;
}

function leafSelect(sub: Any | undefined): Any | undefined {
	if (!sub) return undefined;
	if (is(sub, undefined, "SelectSubmenu")) return sub;
	if (is(sub.inputComponent, undefined, "SelectSubmenu")) return sub.inputComponent;
	if (is(sub.activeComponent, undefined, "SelectSubmenu")) return sub.activeComponent;
	return undefined;
}

function leafList(sub: Any | undefined): Any | undefined {
	if (!sub) return undefined;
	if (is(sub, undefined, "SettingsList")) return sub;
	if (is(sub.settingsList, undefined, "SettingsList")) return sub.settingsList;
	if (is(sub.inputComponent, undefined, "SettingsList")) return sub.inputComponent;
	return undefined;
}

function inlineMenu(m: Any): boolean {
	return !m.searchInput && submenuOptions(m).length <= MENU_MAX;
}

type OpenView =
	| { kind: "menu"; select: Any }
	| { kind: "list"; list: Any }
	| { kind: "sheet"; child: Component }
	| { kind: "card"; child: Component };

function openView(sub: Any, choiceRow: boolean): OpenView {
	if (is(sub, undefined, "SteppedSubmenu")) return { kind: "sheet", child: sub as Component };
	const select = leafSelect(sub);
	if (select) return choiceRow && inlineMenu(select) ? { kind: "menu", select } : { kind: "sheet", child: select as Component };
	const list = leafList(sub);
	if (list) return { kind: "list", list };
	return { kind: "card", child: sub as Component };
}

function menuControl(select: Any, current: string): PrefsControl {
	const all = submenuOptions(select);
	const options = all.map((o) => {
		const detail = plainLine(o.description);
		return { value: String(o.value), label: optionLabel(o), ...(detail ? { detail } : {}) };
	});
	// Pi's `/` menu option represents any automatic theme pair.
	const value = options.some((o) => o.value === current) || !current.includes("/") || !options.some((o) => o.value === "/") ? current : "/";
	return { k: "choice", value, options, style: "menu", ...(options.every((o) => IDENT.test(o.value)) ? { mono: true } : {}) };
}

function submenuLead(sub: Any, list: Any): { title: string; lead: string } {
	const texts: string[] = [];
	const visit = (c: unknown, depth: number): void => {
		for (const child of kids(c)) {
			if (child === list) return;
			if (isText(child)) {
				const t = plainLine(textOf(child));
				if (t) texts.push(t);
			} else if (depth < 2) visit(child, depth + 1);
		}
	};
	visit(sub, 0);
	const [title = "", ...rest] = texts;
	return { title, lead: rest.join(" ") };
}

function selectedValue(select: Any): string | undefined {
	const item = listSelected(select.selectList);
	return item ? String(item.value) : undefined;
}

function editorCard(child: Component): NativeNode {
	return col([child], { role: "omp.prefs.editor" }, "editor");
}

function settingRow(item: SettingItem, id: string, themes?: readonly string[]): PrefsRow {
	const label = plainLine(item.label) || item.id;
	const hint = plainLine(item.description);
	const current = String(item.currentValue ?? "");
	let control: PrefsControl;
	if (item.submenu) {
		if (CHOICE_SUBMENUS.has(item.id)) {
			// Pi only exposes the main theme choices while that submenu is open.
			const names = themes && item.id !== "theme" ? [...themes] : [];
			if (!names.includes(current)) names.unshift(current);
			control = { k: "choice", value: current, options: names.map((n) => ({ value: n, label: item.id === "theme" ? themeLabel(n) : n })), style: "menu", ...(names.every((n) => IDENT.test(n)) ? { mono: true } : {}) };
		} else {
			const shown = plainLine(current);
			control = { k: "action", label: !shown || shown === "configure" ? "Configure…" : `Edit… (${shown})`, act: "open" };
		}
	} else if (Array.isArray(item.values) && item.values.length > 0) control = valueControl(item);
	else control = { k: "choice", value: current, options: [{ value: current, label: plainLine(current) || "—" }], style: "segmented" };
	return { id, label, ...(hint ? { hint } : {}), control };
}

interface OpenOut {
	children: NativeChild[];
	editing: PrefsEditing | null;
}

function nestedSection(parent: SettingItem, sub: Any, list: Any, page: string, searching: boolean, out: OpenOut): { section: PrefsSection; focus: string | null; lead: string } {
	const themes: string[] | undefined = Array.isArray(sub.availableThemes) ? sub.availableThemes.map(String) : undefined;
	const items = displayItems(list).filter((item) => item && typeof item.id === "string");
	const innerOpen = openItemOf(list);
	const rows = items.map((item) => {
		const id = `${parent.id}/${item.id}`;
		const row = settingRow(item, id, themes);
		if (item === innerOpen && list.submenuComponent) {
			const view = openView(list.submenuComponent, CHOICE_SUBMENUS.has(item.id));
			if (view.kind === "menu") {
				row.control = menuControl(view.select, String(item.currentValue ?? ""));
				const option = selectedValue(view.select);
				out.editing = { row: id, ...(option !== undefined ? { option } : {}) };
			} else {
				row.control = { k: "action", label: "Close", act: "close" };
				out.children.push(view.kind === "sheet" ? view.child : editorCard(view.kind === "card" ? view.child : (list.submenuComponent as Component)));
			}
		}
		return row;
	});
	const { title, lead } = submenuLead(sub, list);
	const focused = innerOpen ?? items[Number(list.selectedIndex) || 0];
	return {
		section: { id: `${parent.id}/sub`, title: title || plainLine(parent.label) || parent.id, ...(searching ? { page } : {}), rows },
		focus: focused ? `${parent.id}/${focused.id}` : null,
		lead,
	};
}

interface MenuState {
	row: string;
	option?: string;
}

const ownMenus = new WeakMap<Component, MenuState>();
const lastPages = new WeakMap<Component, string>();

interface PrefsView {
	props: PrefsProps;
	children: NativeChild[];
	sig: string;
}

function settingsView(c: Component): PrefsView | null {
	const a = c as Any;
	const list = settingsListOf(a);
	if (!list || !Array.isArray(list.items)) return null;
	const items: SettingItem[] = list.items;
	const display = displayItems(list);
	const places = settingPlaces(items);
	const search = list.searchEnabled && list.searchInput ? inputState(list.searchInput) : undefined;
	const query = search?.value ?? "";
	const searching = query.trim() !== "";
	const sub: Any | undefined = list.submenuComponent ?? undefined;
	const openItem = openItemOf(list);
	const anchor = openItem ?? display[Number(list.selectedIndex) || 0];
	let pages = SETTINGS_PAGES.filter((pg) => items.some((item) => places.get(item?.id)?.page === pg.id));
	if (pages.length === 0) pages = [SETTINGS_PAGES[0]!];
	const page = places.get(anchor?.id)?.page || lastPages.get(c) || pages[0]!.id;
	lastPages.set(c, page);

	const out: OpenOut = { children: [], editing: null };
	let focus: string | null = typeof anchor?.id === "string" ? anchor.id : null;
	const sections: PrefsSection[] = [];
	const byId = new Map<string, PrefsSection>();
	let nested: { after: PrefsSection; section: PrefsSection } | undefined;
	for (const item of display) {
		if (!item || typeof item.id !== "string") continue;
		const place = places.get(item.id) ?? { page, section: "General" };
		if (!searching && place.page !== page) continue;
		const secId = searching ? `${place.page}/${slug(place.section)}` : slug(place.section);
		let section = byId.get(secId);
		if (!section) {
			section = { id: secId, title: place.section, ...(searching ? { page: place.page } : {}), rows: [] };
			byId.set(secId, section);
			sections.push(section);
		}
		const row = settingRow(item, item.id);
		section.rows.push(row);
		if (item !== openItem || !sub) continue;
		const view = openView(sub, CHOICE_SUBMENUS.has(item.id));
		switch (view.kind) {
			case "menu": {
				row.control = menuControl(view.select, String(item.currentValue ?? ""));
				const option = selectedValue(view.select);
				out.editing = { row: item.id, ...(option !== undefined ? { option } : {}) };
				break;
			}
			case "list": {
				const inner = nestedSection(item, sub, view.list, place.page, searching, out);
				nested = { after: section, section: inner.section };
				focus = inner.focus;
				// Pi saves warning toggles immediately but waits for Apply to save theme pairs.
				row.control = { k: "action", label: is(sub, undefined, "ThemeSubmenu") ? "Cancel" : "Done", act: "close" };
				if (inner.lead) row.hint = inner.lead;
				break;
			}
			default:
				row.control = { k: "action", label: "Close", act: "close" };
				out.children.push(view.kind === "sheet" ? view.child : editorCard(view.child));
		}
	}
	if (nested) sections.splice(sections.indexOf(nested.after) + 1, 0, nested.section);

	const menu = ownMenus.get(c);
	if (menu) {
		if (menu.row !== focus || out.editing !== null || out.children.length > 0) ownMenus.delete(c);
		else out.editing = { row: menu.row, ...(menu.option !== undefined ? { option: menu.option } : {}) };
	}

	const lead = searching ? undefined : pages.find((pg) => pg.id === page)?.lead;
	const props: PrefsProps = {
		title: "pi settings",
		pages: pages.map((pg) => ({ id: pg.id, label: pg.label, icon: pg.icon })),
		page,
		...(lead ? { lead } : {}),
		...(query !== "" ? { query } : {}),
		...(search && query !== "" && !sub ? { cursor: search.cursor } : {}),
		sections,
		focus,
		editing: out.editing,
	};
	return { props, children: out.children, sig: JSON.stringify(props) };
}

/**
 * Pi closes at most one submenu level per Escape.
 */
function closeSubmenus(list: Any): void {
	for (let i = 0; i < 8 && list.submenuComponent; i++) press(list, "cancel");
}

function closeInner(list: Any, inner: Any): void {
	for (let i = 0; i < 4 && inner.submenuComponent && list.submenuComponent; i++) press(list, "cancel");
}

/**
 * Pi routes keys to nested lists through the top list.
 */
function applySetting(target: Any, idx: number, value: string, via: Any): void {
	const item = displayItems(target)[idx];
	if (!item || item.submenu || !Array.isArray(item.values) || !item.values.map(String).includes(value)) return;
	target.selectedIndex = idx;
	const current = String(item.currentValue ?? "");
	if (current === value) return;
	const values = item.values.map(String);
	if (values[(values.indexOf(current) + 1) % values.length] === value) {
		press(via, "confirm");
		return;
	}
	item.currentValue = value;
	target.onChange?.(item.id, value);
}

function chooseInSubmenu(target: Any, idx: number, value: string, via: Any): void {
	const item = displayItems(target)[idx];
	if (!item?.submenu) return;
	if (target.submenuComponent && openItemOf(target) !== item) {
		if (target === via) closeSubmenus(target);
		else closeInner(via, target);
	}
	if (!target.submenuComponent) {
		target.selectedIndex = idx;
		press(via, "confirm");
	}
	const select = leafSelect(target.submenuComponent);
	if (select && selectOption(select, value, false)) press(via, "confirm");
}

function openRow(target: Any, idx: number, via: Any): void {
	const item = displayItems(target)[idx];
	if (!item) return;
	if (target.submenuComponent) {
		if (openItemOf(target) === item) return;
		if (target === via) closeSubmenus(target);
		else closeInner(via, target);
	}
	target.selectedIndex = idx;
	if (item.submenu || (Array.isArray(item.values) && item.values.length === 1)) press(via, "confirm");
}

function locate(list: Any, id: string): { target: Any; idx: number; item: SettingItem } | undefined {
	const top = displayIndex(list, id);
	if (top >= 0) return { target: list, idx: top, item: displayItems(list)[top]! };
	const open = openItemOf(list);
	if (!open || !id.startsWith(`${open.id}/`)) return undefined;
	const inner = leafList(list.submenuComponent);
	if (!inner) return undefined;
	const idx = displayIndex(inner, id.slice(open.id.length + 1));
	return idx >= 0 ? { target: inner, idx, item: displayItems(inner)[idx]! } : undefined;
}

function menuSelect(list: Any, id: string): Any | undefined {
	const at = locate(list, id);
	if (!at || !at.target.submenuComponent || openItemOf(at.target) !== at.item) return undefined;
	const select = leafSelect(at.target.submenuComponent);
	return select && inlineMenu(select) ? select : undefined;
}

function settingsEvent(c: Component, event: NativeUiEvent): void {
	if (event.key.replaceAll("^", "") !== "") return;
	const list = settingsListOf(c as Any);
	if (!list) return;
	switch (event.type) {
		case "action": {
			const { act, value } = event;
			if (act === "page" && value) {
				ownMenus.delete(c);
				closeSubmenus(list);
				const search = list.searchEnabled ? list.searchInput : undefined;
				if (search && inputState(search).value !== "") {
					search.setValue?.("");
					list.applyFilter?.("");
				}
				const places = settingPlaces(Array.isArray(list.items) ? list.items : []);
				const idx = displayItems(list).findIndex((item) => places.get(item?.id)?.page === value);
				if (idx >= 0) list.selectedIndex = idx;
				return;
			}
			if (act === "close") {
				if (value === undefined) {
					// Escape must revert theme previews before the sheet closes.
					ownMenus.delete(c);
					closeSubmenus(list);
					press(list, "cancel");
					return;
				}
				if (ownMenus.get(c)?.row === value) {
					ownMenus.delete(c);
					return;
				}
				const open = openItemOf(list);
				if (open?.id === value) closeSubmenus(list);
				else if (open && value.startsWith(`${open.id}/`)) {
					const inner = leafList(list.submenuComponent);
					if (inner) closeInner(list, inner);
				}
				return;
			}
			if ((act === "open" || act === "run" || act === "edit") && value) {
				ownMenus.delete(c);
				const at = locate(list, value);
				if (at) openRow(at.target, at.idx, list);
			}
			return;
		}
		case "select": {
			const eq = event.item.indexOf("=");
			if (eq >= 0) {
				const id = event.item.slice(0, eq);
				const option = event.item.slice(eq + 1);
				const menu = ownMenus.get(c);
				if (menu?.row === id) ownMenus.set(c, { row: id, option });
				else {
					const select = menuSelect(list, id);
					if (select) selectOption(select, option, true);
				}
				return;
			}
			if (ownMenus.get(c)?.row !== event.item) ownMenus.delete(c);
			const at = locate(list, event.item);
			if (!at) return;
			if (at.target === list) {
				if (list.submenuComponent) {
					if (openItemOf(list) === at.item) return;
					closeSubmenus(list);
				}
				list.selectedIndex = at.idx;
			} else {
				if (at.target.submenuComponent && openItemOf(at.target) !== at.item) closeInner(list, at.target);
				if (!at.target.submenuComponent) at.target.selectedIndex = at.idx;
			}
			return;
		}
		case "activate": {
			const at = locate(list, event.item);
			if (!at) return;
			ownMenus.delete(c);
			if (at.item.submenu) {
				openRow(at.target, at.idx, list);
				return;
			}
			if (at.target === list) closeSubmenus(list);
			else if (at.target.submenuComponent) closeInner(list, at.target);
			at.target.selectedIndex = at.idx;
			ownMenus.set(c, { row: event.item });
			return;
		}
		case "change": {
			ownMenus.delete(c);
			const at = locate(list, event.item);
			if (!at) return;
			if (at.target === list && list.submenuComponent && openItemOf(list) !== at.item) closeSubmenus(list);
			if (at.item.submenu) {
				if (typeof event.value === "string") chooseInSubmenu(at.target, at.idx, event.value, list);
				return;
			}
			if (at.target !== list && at.target.submenuComponent) closeInner(list, at.target);
			const value = valueString(at.item, event.value);
			if (value !== undefined) applySetting(at.target, at.idx, value, list);
			return;
		}
	}
}

const settingsViews = new WeakMap<Component, PrefsView>();

const settingsSelector: Describer = {
	name: "SettingsSelector",
	matches: (c) => is(c, undefined, "SettingsSelectorComponent"),
	fingerprint: (c, cx) => {
		if (!cx.supports("prefs")) return [false];
		const view = settingsView(c);
		if (!view) {
			settingsViews.delete(c);
			return [true, null];
		}
		settingsViews.set(c, view);
		return [true, cx.supports("picker"), view.sig, ...view.children];
	},
	build: (c, cx) => {
		if (!cx.supports("prefs")) return null;
		const view = settingsViews.get(c) ?? settingsView(c);
		return view ? prefs(view.props, view.children) : null;
	},
	handleEvent: (c, event) => settingsEvent(c, event),
};

type ResourceEntry = { type: "group"; group: Any } | { type: "subgroup"; subgroup: Any; group: Any } | { type: "item"; item: Any };

function resourceEntries(rl: Any): ResourceEntry[] {
	return Array.isArray(rl.filteredItems) ? rl.filteredItems : [];
}

function resourceId(item: Any): string {
	return `${String(item.subgroupKey ?? item.resourceType ?? "")}|${String(item.path ?? item.displayName ?? "")}`;
}

function resourceIndex(rl: Any, id: string): number {
	return resourceEntries(rl).findIndex((entry) => entry?.type === "item" && resourceId(entry.item) === id);
}

function tildePath(path: string): string {
	const home = process.env.HOME;
	return home && home !== "/" && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function overrideState(rl: Any, item: Any): "inherit" | "load" | "unload" | undefined {
	try {
		const state = rl.getProjectOverrideState?.(item);
		return state === "inherit" || state === "load" || state === "unload" ? state : undefined;
	} catch {
		return undefined;
	}
}

function call<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

function scopeFile(header: Any | undefined): string {
	if (!header || typeof header.render !== "function") return "";
	const lines: unknown = call(() => header.render(240), [] as string[]);
	const line = Array.isArray(lines) ? plainLine(lines[1]) : "";
	return line.split(" · ")[0]?.trim() ?? "";
}

function configView(c: Component): PrefsView | null {
	const a = c as Any;
	const rl: Any | undefined = a.resourceList ?? kids(a).find((k) => is(k, undefined, "ResourceList"));
	if (!rl || !Array.isArray(rl.filteredItems)) return null;
	const scope: "global" | "project" = rl.writeScope === "project" ? "project" : "global";
	const projectMode = a.header?.projectModeAvailable !== false;
	const search = rl.searchInput ? inputState(rl.searchInput) : undefined;
	const query = search?.value ?? "";
	const searching = query.trim() !== "";
	const sections: PrefsSection[] = [];
	let section: PrefsSection | undefined;
	let group: Any | undefined;
	let focus: string | null = null;
	const entries = resourceEntries(rl);
	const selected = entries[Number(rl.selectedIndex) || 0];
	for (const entry of entries) {
		if (!entry) continue;
		if (entry.type === "group") {
			group = entry.group;
			section = undefined;
			continue;
		}
		if (entry.type === "subgroup") {
			group = entry.group ?? group;
			const inherited = scope === "project" && group?.scope === "user";
			const title = `${plainLine(group?.label)}${inherited ? " · inherited global" : ""} — ${plainLine(entry.subgroup?.label)}`;
			const type = entry.subgroup?.type;
			section = { id: type ? `${String(group?.key ?? "")}:${String(type)}` : `s${sections.length}`, title, ...(searching ? { page: scope } : {}), rows: [] };
			sections.push(section);
			continue;
		}
		if (entry.type !== "item" || !entry.item) continue;
		const item = entry.item;
		if (!section) {
			section = { id: `s${sections.length}`, title: plainLine(group?.label) || "Resources", ...(searching ? { page: scope } : {}), rows: [] };
			sections.push(section);
		}
		const id = resourceId(item);
		if (entry === selected) focus = id;
		const own = call(() => rl.getItemScope?.(item), item.metadata?.scope === "project" ? "project" : "user");
		const hint: string[] = [tildePath(String(item.path ?? ""))];
		let control: PrefsControl;
		let disabled: string | undefined;
		if (scope === "project") {
			const state = overrideState(rl, item) ?? "inherit";
			const inheritedOn = call(() => rl.getInheritedEnabled?.(item) === true, item.enabled === true);
			control = {
				k: "choice",
				value: state,
				options: [
					{ value: "inherit", label: inheritedOn ? "Inherit (on)" : "Inherit (off)", detail: "Follow the global settings" },
					{ value: "load", label: "Load", detail: "Load it in this project" },
					{ value: "unload", label: "Unload", detail: "Don't load it in this project" },
				],
				style: "segmented",
			};
			if (state === "load") hint.push("project load");
			else if (state === "unload") hint.push("project unload");
			else if (call(() => rl.isInheritedGlobalItem?.(item) === true, false)) hint.push("inherited global");
		} else {
			control = { k: "switch", on: item.enabled === true };
			if (own !== "user") disabled = projectMode ? "Set by the project's settings · switch to Project to change it" : "Set by the project's settings";
		}
		section.rows.push({ id, label: plainLine(item.displayName) || id, hint: hint.filter((h) => h).join(" · "), ...(disabled ? { disabled } : {}), control });
	}
	const file = scopeFile(a.header);
	const pages: PrefsPage[] = [{ id: "global", label: "Global", icon: "globe" }];
	if (projectMode || scope === "project") pages.push({ id: "project", label: "Project", icon: "folder" });
	const props: PrefsProps = {
		title: "pi config",
		pages,
		page: scope,
		...(searching
			? {}
			: {
					lead:
						scope === "project"
							? `Resources this project loads${file ? `, saved to ${file}` : ""}. Inherit follows the global settings.`
							: `Resources pi loads everywhere${file ? `, saved to ${file}` : ""}.`,
				}),
		...(search && query !== "" ? { query, cursor: search.cursor } : {}),
		sections,
		focus,
		editing: null,
	};
	return { props, children: [], sig: JSON.stringify(props) };
}

function configEvent(c: Component, event: NativeUiEvent): void {
	if (event.key.replaceAll("^", "") !== "") return;
	const a = c as Any;
	const rl: Any | undefined = a.resourceList ?? kids(a).find((k) => is(k, undefined, "ResourceList"));
	if (!rl || typeof rl.handleInput !== "function") return;
	switch (event.type) {
		case "action":
			if (event.act === "page" && (event.value === "global" || event.value === "project") && event.value !== rl.writeScope) {
				if (a.header?.projectModeAvailable !== false) press(rl, "tab");
			} else if (event.act === "close" && event.value === undefined) press(rl, "cancel");
			return;
		case "select":
		case "activate": {
			const idx = resourceIndex(rl, event.item);
			if (idx >= 0) rl.selectedIndex = idx;
			return;
		}
		case "change": {
			const idx = resourceIndex(rl, event.item);
			if (idx < 0) return;
			const entry = resourceEntries(rl)[idx];
			if (entry?.type !== "item") return;
			rl.selectedIndex = idx;
			// Pi saves each resource change on Space.
			if (rl.writeScope === "project") {
				if (event.value !== "inherit" && event.value !== "load" && event.value !== "unload") return;
				for (let i = 0; i < 3 && overrideState(rl, entry.item) !== event.value; i++) rl.handleInput(" ");
			} else if (typeof event.value === "boolean" && event.value !== (entry.item.enabled === true)) rl.handleInput(" ");
			return;
		}
	}
}

const configViews = new WeakMap<Component, PrefsView>();

const configSelector: Describer = {
	name: "ConfigSelector",
	matches: (c) => is(c, undefined, "ConfigSelectorComponent"),
	fingerprint: (c, cx) => {
		if (!cx.supports("prefs")) return [false];
		const view = configView(c);
		if (!view) {
			configViews.delete(c);
			return [true, null];
		}
		configViews.set(c, view);
		return [true, view.sig];
	},
	build: (c, cx) => {
		if (!cx.supports("prefs")) return null;
		const view = configViews.get(c) ?? configView(c);
		return view ? prefs(view.props) : null;
	},
	handleEvent: (c, event) => configEvent(c, event),
};

const SETUP_FALLBACK: Readonly<Record<"theme" | "analytics", readonly string[]>> = {
	theme: ["System (matches your terminal colors)", "Dark", "Light"],
	analytics: ["Share anonymous usage data", "Don't share"],
};

const THEME_ICONS: readonly string[] = ["monitor", "moon", "sun"];

function setupTexts(a: Any, step: "theme" | "analytics"): { welcome: string; question: string[]; options: string[] } {
	const texts = kids(a)
		.filter(isText)
		.map((child) => plain(textOf(child)));
	const first = texts.findIndex((t) => t.startsWith("→ ") || t.startsWith("  "));
	const options: string[] = [];
	if (first >= 0) for (let i = first; i < texts.length && (texts[i]!.startsWith("→ ") || texts[i]!.startsWith("  ")); i++) options.push(texts[i]!.slice(2).trim());
	const at = texts.findIndex((t) => /^Welcome\b/.test(t.trim()));
	const question: string[] = [];
	for (let i = at + 1; i < (first >= 0 ? first : texts.length); i++) {
		const t = texts[i]!.trim();
		if (t && !t.includes("█")) question.push(t.replace(/\s*\n\s*/g, " "));
	}
	return { welcome: at >= 0 ? texts[at]!.trim() : "Welcome", question, options: options.length > 0 ? options : [...SETUP_FALLBACK[step]] };
}

function setupStep(a: Any): "theme" | "analytics" {
	return a.step === "analytics" ? "analytics" : "theme";
}

function setupIndex(a: Any): number {
	return Number(setupStep(a) === "theme" ? a.themeIndex : a.analyticsIndex) || 0;
}

const firstTimeSetup: Describer = {
	name: "FirstTimeSetup",
	matches: (c) => is(c, undefined, "FirstTimeSetupComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		return [cx.supports("picker"), a.step, a.themeIndex, a.analyticsIndex, kids(a).length, kids(a).filter(isText).map(textOf).join("\0")];
	},
	build: (c, cx) => {
		if (!cx.supports("picker")) return null;
		const a = c as Any;
		const step = setupStep(a);
		const { welcome, question, options } = setupTexts(a, step);
		const index = Math.max(0, Math.min(options.length - 1, setupIndex(a)));
		return picker({
			title: welcome,
			subtitle: [`Step ${step === "theme" ? 1 : 2} of 2`, ...question].join("\n"),
			icon: "pi-mark",
			noun: "options",
			size: "md",
			layout: "rows",
			preview: "none",
			query: null,
			items: options.map((label, i) => {
				const icon = step === "theme" ? THEME_ICONS[i] : undefined;
				return { id: `o${i}`, label, ...(icon ? { icon } : {}) };
			}),
			selected: `o${index}`,
			total: options.length,
			actions: [
				{ id: "confirm", label: step === "theme" ? "Continue" : "Finish", keys: capsOf("confirm"), primary: true },
				{ id: "close", label: "Skip setup", keys: capsOf("cancel"), end: true },
			],
		});
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		const ev = pickerEvent(event);
		if (!ev) return;
		if (ev.kind === "action") {
			if (ev.act === "confirm") press(a, "confirm");
			else if (ev.act === "close" || ev.act === "cancel") press(a, "cancel");
			return;
		}
		const target = Number(ev.item.slice(1));
		if (!ev.item.startsWith("o") || !Number.isInteger(target) || target < 0) return;
		const count = setupTexts(a, setupStep(a)).options.length;
		if (target >= count) return;
		// Pi previews each theme while handling the arrow keys.
		for (let i = 0, at = setupIndex(a); i < count && at !== target; i++, at = setupIndex(a)) press(a, at < target ? "down" : "up");
		if (ev.kind === "activate") press(a, "confirm");
	},
};

export const PREFS_DESCRIBERS: readonly Describer[] = [settingsSelector, configSelector, firstTimeSetup, selectSubmenu, steppedSubmenu];

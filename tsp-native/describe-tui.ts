import {
	type Component,
	getKeybindings,
	HStack,
	Image,
	imageFallback,
	Input,
	ScrollView,
	SelectList,
	SettingsList,
	TruncatedText,
	VStack,
} from "@earendil-works/pi-tui";
import { registerTspBlob } from "../shared/tsp-blobs.ts";
import type { Describer } from "./describers.ts";
import { ansi, col, type DescribeContext, EMPTY_NODE, type NativeChild, type NativeNode, type NativeUiEvent, node, row, spacer, span, stripAnsi, text } from "./node.ts";
import { hasStyle, lineToSpans, spansThemeId } from "./spans.ts";
import type { TspProps, TspSpace, TspSpan, TspText } from "./wire.ts";

type Any = Record<string, any>;

function is(component: Component, ctor: Function | undefined, name: string): boolean {
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

function lineText(line: string): TspText {
	const spans = lineToSpans(line.replaceAll("\x1b_pi:c\x07", ""));
	while (spans.length > 0) {
		const last = spans[spans.length - 1]!;
		const t = last.t.trimEnd();
		if (t) {
			if (t !== last.t) spans[spans.length - 1] = { ...last, t };
			break;
		}
		spans.pop();
	}
	return hasStyle(spans) ? spans : spans.map((sp) => sp.t).join("");
}

function labelText(s: unknown): TspText {
	if (typeof s !== "string") return "";
	const one = s.replace(/[\r\n]+/g, " ");
	if (!one.includes("\x1b")) return one.replace(/\s+/g, " ").trim();
	const spans = lineToSpans(one).map((sp) => ({ ...sp, t: sp.t.replace(/\s+/g, " ") }));
	if (spans.length > 0) {
		spans[0] = { ...spans[0]!, t: spans[0]!.t.trimStart() };
		const last = spans.length - 1;
		spans[last] = { ...spans[last]!, t: spans[last]!.t.trimEnd() };
	}
	const kept = spans.filter((sp) => sp.t !== "");
	return hasStyle(kept) ? kept : kept.map((sp) => sp.t).join("");
}

function textOf(t: TspText): string {
	return typeof t === "string" ? t : t.map((sp) => sp.t).join("");
}

function kbd(key: string, nodeKey?: string): NativeNode {
	const keys = key === "+" ? ["+"] : key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
	return node("kbd", { keys: keys.filter((part) => part.length > 0) }, undefined, nodeKey);
}

interface Hint {
	readonly keys: readonly string[];
	readonly label: string;
}

function actionHint(action: string, label: string): Hint | undefined {
	try {
		const [key] = (getKeybindings() as unknown as Any).getKeys(action) as string[];
		return typeof key === "string" && key ? { keys: [key], label } : undefined;
	} catch {
		return undefined;
	}
}

function hintsRow(hints: readonly (Hint | undefined)[], key = "hints"): NativeNode | undefined {
	const groups: NativeChild[] = [];
	for (const hint of hints) {
		if (!hint) continue;
		const group: NativeChild[] = hint.keys.map((k, i) => kbd(k, `k${i}`));
		group.push(text([span(hint.label, "muted")], undefined, "label"));
		groups.push(row(group, { gap: "xs", align: "center" }, hint.label));
	}
	return groups.length > 0 ? node("row", { gap: "md", wrap: true, role: "omp.overlay.hints" }, groups, key) : undefined;
}

function uniqueKeys(values: readonly string[]): string[] {
	const seen = new Set<string>();
	return values.map((value, i) => {
		const k = seen.has(value) ? `${value}\u0000${i}` : value;
		seen.add(k);
		return k;
	});
}

function clampOffset(value: number, max: number): number {
	return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), 0), max) : 0;
}

const inputEditHooks = new WeakMap<Component, (value: string) => void>();

function singleLine(s: string): string {
	return s.replace(/\r\n|\r|\n/g, "").replace(/\t/g, "    ");
}

/**
 * Terminal edit offsets are measured in UTF-16 code units.
 */
function applyInputEdit(c: Component, a: Any, edit: Extract<NativeUiEvent, { type: "edit" }>): void {
	const value: string = a.value;
	if (edit.len !== value.length) return;
	let from = clampOffset(edit.from, value.length);
	let to = clampOffset(edit.to, value.length);
	if (to < from) [from, to] = [to, from];
	const raw = typeof edit.text === "string" ? edit.text : "";
	const insert = singleLine(raw);
	const next = value.slice(0, from) + insert + value.slice(to);
	const changed = next !== value;
	a.lastAction = null;
	if (changed) {
		a.pushUndo?.();
		a.value = next;
	}
	let cursor = Number.isFinite(edit.cursor) ? Math.trunc(edit.cursor) : from + insert.length;
	if (cursor >= from + raw.length) cursor += insert.length - raw.length;
	else if (cursor > from) cursor = from + Math.min(insert.length, cursor - from);
	a.cursor = clampOffset(cursor, next.length);
	if (changed) inputEditHooks.get(c)?.(next);
}

const input: Describer = {
	name: "Input",
	matches: (c) => is(c, Input, "Input"),
	fingerprint: (c) => {
		const a = c as Any;
		return [a.value, a.cursor, a.prompt, a.placeholder];
	},
	build: (c) => {
		const a = c as Any;
		if (typeof a.value !== "string") return null;
		const value: string = a.value;
		const prompt = plain(a.prompt);
		const placeholder = plainLine(a.placeholder);
		return node("input", {
			text: value,
			cursor: clampOffset(Number(a.cursor ?? value.length), value.length),
			sendable: false,
			prompt: prompt || undefined,
			placeholder: placeholder || undefined,
		});
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		if (typeof a.value !== "string") return;
		switch (event.type) {
			case "edit":
				applyInputEdit(c, a, event);
				return;
			case "undo": {
				const before = a.value;
				a.undo?.();
				if (a.value !== before) inputEditHooks.get(c)?.(a.value);
				return;
			}
			case "send":
				a.onSubmit?.(event.text);
				return;
		}
	},
};

const selectItemNodes = new WeakMap<object, { sig: string; node: NativeNode }>();

function selectItems(a: Any): Any[] | undefined {
	const items = a.filteredItems;
	return Array.isArray(items) ? items : undefined;
}

function selectKeys(items: readonly Any[]): string[] {
	return uniqueKeys(items.map((item) => String(item?.value ?? "")));
}

function describeSelectItem(item: Any, key: string, mark: string, iconOf: ((item: Any) => unknown) | undefined): NativeNode {
	const label = labelText(item.label || item.value || "");
	const description = typeof item.description === "string" ? plainLine(item.description) : "";
	const labelPlain = textOf(label);
	const marked = mark.length > 0 && labelPlain.toLowerCase().startsWith(mark.toLowerCase()) ? mark.length : 0;
	let icon: string | undefined;
	if (iconOf) {
		try {
			const named = iconOf(item);
			icon = typeof named === "string" && named ? named : undefined;
		} catch {
			icon = undefined;
		}
	}
	const sig = `${key}\0${labelPlain}\0${typeof label === "string"}\0${description}\0${marked}\0${icon ?? ""}\0${spansThemeId()}`;
	const cached = selectItemNodes.get(item);
	if (cached?.sig === sig) return cached.node;
	let shown: TspText = label;
	if (marked > 0) {
		const rest = labelPlain.slice(marked);
		shown = rest ? [span(labelPlain.slice(0, marked), "mark"), span(rest)] : [span(labelPlain, "mark")];
	}
	const built = node("item", { icon, label: shown, detail: description ? [span(description, "muted")] : undefined }, undefined, key);
	selectItemNodes.set(item, { sig, node: built });
	return built;
}

const selectList: Describer = {
	name: "SelectList",
	matches: (c) => is(c, SelectList, "SelectList"),
	fingerprint: (c) => {
		const a = c as Any;
		const items = selectItems(a);
		return [items, items?.length, a.selectedIndex, a.maxVisible, typeof a.nativeMark === "string" ? a.nativeMark : undefined, typeof a.nativeIcon === "function" ? a.nativeIcon : undefined, typeof a.nativeMaxLines === "number" ? a.nativeMaxLines : undefined, spansThemeId()];
	},
	build: (c) => {
		const a = c as Any;
		const items = selectItems(a);
		if (!items) return null;
		const keys = selectKeys(items);
		const mark = typeof a.nativeMark === "string" ? a.nativeMark : "";
		const iconOf = typeof a.nativeIcon === "function" ? (a.nativeIcon as (item: Any) => unknown) : undefined;
		const children = items.map((item, i) => describeSelectItem(item ?? {}, keys[i]!, mark, iconOf));
		const index = Number(a.selectedIndex ?? 0);
		const maxVisible = typeof a.nativeMaxLines === "number" && a.nativeMaxLines > 0 ? a.nativeMaxLines : Number(a.maxVisible);
		const list = node(
			"list",
			{
				selected: keys[index] ?? null,
				empty: "No matching items",
				max: Number.isFinite(maxVisible) && maxVisible > 0 ? { lines: Math.floor(maxVisible) } : undefined,
			},
			children,
			"list",
		);
		return col([list], { role: "omp.select" });
	},
	handleEvent: (c, event) => {
		if (event.type !== "select" && event.type !== "activate") return;
		const a = c as Any;
		const items = selectItems(a);
		if (!items) return;
		const index = selectKeys(items).indexOf(event.item);
		const item = items[index];
		if (index < 0 || !item) return;
		if (a.selectedIndex !== index) {
			a.selectedIndex = index;
			if (typeof a.notifySelectionChange === "function") a.notifySelectionChange();
			else a.onSelectionChange?.(item);
		}
		a.onSelect?.(item);
	},
};

const settingItemNodes = new WeakMap<object, { sig: string; node: NativeNode }>();

function settingItems(a: Any): Any[] | undefined {
	const items = a.searchEnabled ? a.filteredItems : a.items;
	return Array.isArray(items) ? items : undefined;
}

function settingKeys(items: readonly Any[]): string[] {
	return uniqueKeys(items.map((item) => String(item?.id ?? "")));
}

function settingValues(items: readonly Any[]): string {
	let sig = "";
	for (const item of items) sig += `${item?.currentValue ?? ""}\u0000`;
	return sig;
}

function describeSettingItem(item: Any, key: string): NativeNode {
	const label = labelText(item.label ?? item.id ?? "");
	const value = plainLine(String(item.currentValue ?? ""));
	const description = typeof item.description === "string" ? plainLine(item.description) : "";
	const sig = `${key}\0${textOf(label)}\0${typeof label === "string"}\0${value}\0${description}\0${spansThemeId()}`;
	const cached = settingItemNodes.get(item);
	if (cached?.sig === sig) return cached.node;
	const built = node(
		"item",
		{
			label,
			value: value ? [span(value, "muted")] : undefined,
			detail: description ? [span(description, "muted")] : undefined,
		},
		undefined,
		key,
	);
	settingItemNodes.set(item, { sig, node: built });
	return built;
}

function settingsQuery(a: Any): string {
	return a.searchEnabled && typeof a.searchInput?.value === "string" ? a.searchInput.value : "";
}

const settingsList: Describer = {
	name: "SettingsList",
	matches: (c) => is(c, SettingsList, "SettingsList"),
	fingerprint: (c) => {
		const a = c as Any;
		const search: Component | undefined = a.searchEnabled ? a.searchInput : undefined;
		// Terminal edits bypass pi's settings input handler.
		if (search && !inputEditHooks.has(search)) inputEditHooks.set(search, (value) => a.applyFilter?.(value));
		const items = settingItems(a);
		return [a.submenuComponent ?? null, items, items?.length, items ? settingValues(items) : "", a.selectedIndex, a.maxVisible, search ?? null, settingsQuery(a), spansThemeId()];
	},
	build: (c) => {
		const a = c as Any;
		const submenu: Component | null | undefined = a.submenuComponent;
		if (submenu) return col([submenu], { role: "omp.settings", gap: "sm" });
		const items = settingItems(a);
		if (!items) return null;
		const keys = settingKeys(items);
		const query = settingsQuery(a).trim();
		const maxVisible = Number(a.maxVisible);
		const list = node(
			"list",
			{
				selected: keys[Number(a.selectedIndex ?? 0)] ?? null,
				filter: query || undefined,
				empty: (Array.isArray(a.items) ? a.items.length : items.length) === 0 ? "No settings available" : "No matching settings",
				max: Number.isFinite(maxVisible) && maxVisible > 0 ? { lines: Math.floor(maxVisible) } : undefined,
			},
			items.map((item, i) => describeSettingItem(item ?? {}, keys[i]!)),
			"list",
		);
		const children: NativeChild[] = [];
		const search: Component | undefined = a.searchEnabled ? a.searchInput : undefined;
		if (search) children.push(search);
		children.push(list);
		const hints = hintsRow([a.searchEnabled ? { keys: [], label: "Type to search" } : undefined, actionHint("tui.select.confirm", "change"), actionHint("tui.select.cancel", "cancel")]);
		if (hints) children.push(hints);
		return col(children, { role: "omp.settings", gap: "sm" });
	},
	handleEvent: (c, event) => {
		if (event.type !== "select" && event.type !== "activate") return;
		const a = c as Any;
		if (a.submenuComponent) return;
		const items = settingItems(a);
		if (!items) return;
		const index = settingKeys(items).indexOf(event.item);
		if (index < 0) return;
		const was = a.selectedIndex === index;
		a.selectedIndex = index;
		if (event.type === "activate" || was) a.activateItem?.();
	},
};

const truncatedText: Describer = {
	name: "TruncatedText",
	matches: (c) => is(c, TruncatedText, "TruncatedText"),
	fingerprint: (c) => {
		const a = c as Any;
		return [a.text, a.paddingY, spansThemeId()];
	},
	build: (c) => {
		const a = c as Any;
		const raw = typeof a.text === "string" ? a.text : "";
		const nl = raw.indexOf("\n");
		const first = lineText(nl === -1 ? raw : raw.slice(0, nl));
		const padded = Number(a.paddingY ?? 0) > 0;
		if (textOf(first).trim() === "") return padded ? spacer("sm") : EMPTY_NODE;
		const line = text(first, { role: "pi.text", wrap: "none", truncate: "end", lines: 1 }, "t");
		return padded ? col([spacer("sm", "a"), line, spacer("sm", "b")]) : line;
	},
};

/**
 * Match the backend's cap on decoded blob bytes.
 */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const imageBytes = new WeakMap<Component, { data: string; bytes: Uint8Array }>();

function imageMode(cx: DescribeContext): boolean {
	return cx.supports("image") && cx.feature("blobs");
}

function imageAlt(a: Any): string {
	const mime = typeof a.mimeType === "string" ? a.mimeType : "image";
	try {
		const alt = plainLine(imageFallback(mime, a.dimensions, a.options?.filename));
		if (alt) return alt;
	} catch {
	}
	const dims = a.dimensions;
	return dims && Number.isFinite(dims.widthPx) && Number.isFinite(dims.heightPx) ? `[${mime}] ${dims.widthPx}x${dims.heightPx}` : `[${mime}]`;
}

function imageBlobBytes(c: Component, data: string): Uint8Array | undefined {
	const cached = imageBytes.get(c);
	if (cached?.data === data) return cached.bytes;
	let bytes: Uint8Array;
	try {
		bytes = Buffer.from(data, "base64");
	} catch {
		return undefined;
	}
	imageBytes.set(c, { data, bytes });
	return bytes;
}

function cells(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

const image: Describer = {
	name: "Image",
	matches: (c) => is(c, Image, "Image"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		return [a.base64Data, a.mimeType, a.dimensions?.widthPx, a.dimensions?.heightPx, a.options?.maxWidthCells, a.options?.maxHeightCells, a.options?.filename, imageMode(cx)];
	},
	build: (c, cx) => {
		const a = c as Any;
		const alt = imageAlt(a);
		const data = a.base64Data;
		const mime = typeof a.mimeType === "string" ? a.mimeType : "";
		if (imageMode(cx) && typeof data === "string" && data && mime) {
			const bytes = imageBlobBytes(c, data);
			if (bytes && bytes.byteLength > 0 && bytes.byteLength <= MAX_IMAGE_BYTES) {
				const dims = a.dimensions;
				const maxW = cells(a.options?.maxWidthCells) ?? 60;
				const maxH = cells(a.options?.maxHeightCells);
				return node("image", {
					role: "pi.image",
					blob: registerTspBlob(bytes, mime),
					alt,
					w: cells(dims?.widthPx),
					h: cells(dims?.heightPx),
					max: { w: `${maxW}ch`, h: maxH === undefined ? undefined : `${maxH}lines` },
				});
			}
		}
		return text([span(alt, "muted")], { role: "pi.image.alt", wrap: "none", truncate: "end" });
	},
};

const plainEntries = new WeakMap<Component, Any>();

function stackEntries(a: Any, cx: DescribeContext): Any[] {
	const entries: unknown = a.entries;
	if (!Array.isArray(entries)) {
		return ((a.children ?? []) as Component[]).map((component) => {
			let entry = plainEntries.get(component);
			if (!entry) plainEntries.set(component, (entry = { component }));
			return entry;
		});
	}
	const viewport = { width: Math.max(1, cx.cols), height: Number.MAX_SAFE_INTEGER };
	return entries.filter((entry: Any) => {
		if (!entry?.component) return false;
		try {
			return typeof entry.visible === "function" ? entry.visible(viewport) !== false : true;
		} catch {
			return true;
		}
	});
}

function stackGap(gap: unknown, vertical: boolean): TspSpace | undefined {
	const n = typeof gap === "number" && Number.isFinite(gap) ? Math.floor(gap) : 0;
	if (n <= 0) return undefined;
	if (vertical) return n === 1 ? "md" : "lg";
	return n === 1 ? "sm" : n === 2 ? "md" : "lg";
}

function stackAlign(align: unknown): string | undefined {
	return align === "start" || align === "center" || align === "end" ? align : undefined;
}

function widthSlot(entry: Any): TspProps | undefined {
	const grow = cells(entry.grow);
	const basis = cells(entry.basis);
	const min = cells(entry.minSize);
	const max = typeof entry.maxSize === "number" && entry.maxSize < Number.MAX_SAFE_INTEGER ? cells(entry.maxSize) : undefined;
	if (grow === undefined && basis === undefined && min === undefined && max === undefined) return undefined;
	if (basis !== undefined && grow === undefined) return { grow: 0, shrink: 0, min: { w: `${basis}ch` }, max: { w: `${basis}ch` } };
	return { grow, min: min === undefined ? undefined : { w: `${min}ch` }, max: max === undefined ? undefined : { w: `${max}ch` } };
}

const stackFrames = new WeakMap<Component, Any[]>();

function stackFingerprint(c: Component, cx: DescribeContext): readonly unknown[] {
	const a = c as Any;
	const entries = stackEntries(a, cx);
	stackFrames.set(c, entries);
	return [entries, a.gap, a.align];
}

const vStack: Describer = {
	name: "VStack",
	matches: (c) => is(c, VStack, "VStack"),
	fingerprint: stackFingerprint,
	build: (c, cx) => {
		const a = c as Any;
		const entries = stackFrames.get(c) ?? stackEntries(a, cx);
		if (entries.length === 0) return EMPTY_NODE;
		return col(
			entries.map((entry) => entry.component as Component),
			{ gap: stackGap(a.gap, true), align: stackAlign(a.align) },
		);
	},
};

const hStack: Describer = {
	name: "HStack",
	matches: (c) => is(c, HStack, "HStack"),
	fingerprint: stackFingerprint,
	build: (c, cx) => {
		const a = c as Any;
		const entries = stackFrames.get(c) ?? stackEntries(a, cx);
		if (entries.length === 0) return EMPTY_NODE;
		const children = entries.map((entry, i): NativeChild => {
			const slot = widthSlot(entry);
			return slot ? col([entry.component as Component], slot, `s${i}`) : (entry.component as Component);
		});
		return row(children, { gap: stackGap(a.gap, false), align: stackAlign(a.align) ?? "start" });
	},
};

const stack: Describer = {
	name: "Stack",
	matches: (c) => Array.isArray((c as Any).entries) && is(c, undefined, "Stack"),
	fingerprint: stackFingerprint,
	build: (c, cx) => {
		const a = c as Any;
		const entries = stackFrames.get(c) ?? stackEntries(a, cx);
		if (entries.length === 0) return EMPTY_NODE;
		return col(
			entries.map((entry) => entry.component as Component),
			{ gap: stackGap(a.gap, true) },
		);
	},
};

const scrollView: Describer = {
	name: "ScrollView",
	matches: (c) => is(c, ScrollView, "ScrollView"),
	fingerprint: (c) => {
		const a = c as Any;
		return [a.child ?? (a.children as Component[] | undefined)?.[0]];
	},
	build: (c) => {
		const a = c as Any;
		const child: Component | undefined = a.child ?? (a.children as Component[] | undefined)?.[0];
		return child ? col([child], { role: "pi.scroll" }) : EMPTY_NODE;
	},
};

function isObjectLiteral(c: Component): boolean {
	const proto = Object.getPrototypeOf(c);
	return (proto === Object.prototype || proto === null) && typeof (c as Any).render === "function";
}

const literalLines = new WeakMap<Component, string[]>();

function renderLines(c: Component, cols: number): string[] {
	try {
		const lines = c.render(Math.max(1, cols));
		return Array.isArray(lines) ? lines.map((line) => (typeof line === "string" ? line : "")) : [];
	} catch {
		return [];
	}
}

const GRID_RE = /[\u2500-\u259f\u2800-\u28ff]|\S {3,}\S/;

function dropLeading(content: TspText, n: number): TspText {
	if (n <= 0) return content;
	if (typeof content === "string") return content.slice(n);
	const out: TspSpan[] = [];
	let left = n;
	for (const sp of content) {
		if (left >= sp.t.length) {
			left -= sp.t.length;
			continue;
		}
		out.push(left > 0 ? { ...sp, t: sp.t.slice(left) } : sp);
		left = 0;
	}
	return out;
}

function trimAnsiEnd(line: string): string {
	const trimmed = line.replace(/(?:\s|\x1b\[[0-9;:]*m)+$/, "");
	return trimmed.includes("\x1b") ? `${trimmed}\x1b[0m` : trimmed;
}

function describeLines(lines: readonly string[], cols: number): NativeNode {
	const plainLines = lines.map((line) => plain(line).trimEnd());
	let first = 0;
	let last = plainLines.length - 1;
	while (first <= last && plainLines[first] === "") first++;
	while (last >= first && plainLines[last] === "") last--;
	if (first > last) return EMPTY_NODE;
	const shown = lines.slice(first, last + 1);
	const shownPlain = plainLines.slice(first, last + 1);
	if (shownPlain.some((line) => GRID_RE.test(line))) {
		return ansi(shown.map(trimAnsiEnd).join("\n"), { cols: Math.max(1, cols), role: "pi.lines" });
	}
	let indent = Number.POSITIVE_INFINITY;
	for (const line of shownPlain) if (line !== "") indent = Math.min(indent, line.length - line.trimStart().length);
	if (!Number.isFinite(indent)) indent = 0;
	if (shown.length === 1) return text(dropLeading(lineText(shown[0]!), indent), { role: "pi.lines", wrap: "word" });
	return col(
		shown.map((line, i): NativeNode => (shownPlain[i] === "" ? spacer("md", `l${i}`) : text(dropLeading(lineText(line), indent), { wrap: "word" }, `l${i}`))),
		{ role: "pi.lines" },
	);
}

const objectLiteral: Describer = {
	name: "ObjectComponent",
	matches: (c) => isObjectLiteral(c),
	fingerprint: (c, cx) => {
		const lines = renderLines(c, cx.cols);
		literalLines.set(c, lines);
		return [cx.cols, lines.length, lines.join("\n"), spansThemeId()];
	},
	build: (c, cx) => describeLines(literalLines.get(c) ?? renderLines(c, cx.cols), cx.cols),
};

export const TUI_DESCRIBERS: readonly Describer[] = [input, selectList, settingsList, truncatedText, image, scrollView, vStack, hStack, stack, objectLiteral];

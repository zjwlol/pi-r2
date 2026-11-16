/**
 * TSP (native) node contract and builders for the /btw views, declared locally as
 * subagent/native.ts does: plain JSON nodes, no import from tsp-native/.
 *
 * Ports the parts of oh-my-pi `packages/tui/src/native/describe.ts` (node, span, text, md, col,
 * row, card, kbd) and `native/overlay.ts` (hintsRow, statusHintsRow, actionButton, actionBar)
 * that `overlays/btw-panel.ts`, `btw-inject.ts` and `btw-history-panel.ts` describe with.
 *
 * Memo contract (tsp-native): a component returns the same node object while nothing shown
 * changed; the reconciler skips reference-equal nodes without walking them. The builders here
 * allocate, so callers keep the result.
 */

import type { Component } from "@earendil-works/pi-tui";

export interface TspSpan {
	t: string;
	s?: string;
	fx?: "shimmer" | "pulse" | "none";
	href?: string;
}
export type TspText = string | readonly TspSpan[];

export interface NativeNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly NativeChild[];
	/** Identity among siblings inside the owning component (defaults to the child index). */
	readonly key?: string;
	/** Scroll the node into view when it is added (the reconciler sends a `reveal` op once, on mount). */
	readonly reveal?: "start" | "end" | "nearest";
}
/** A nested node, or a component the reconciler describes on its own (a describe boundary). */
export type NativeChild = NativeNode | Component;

/** The part of tsp-native's DescribeContext the views read. */
export interface DescribeCx {
	readonly cols: number;
	supports(kind: string): boolean;
	feature?(name: string): boolean;
}

/** A pointer or host-edit event on a described node; `key` is its keypath inside the component. */
export type NativeUiEvent =
	| { readonly type: "select" | "activate"; readonly key: string; readonly item: string }
	| { readonly type: "action"; readonly key: string; readonly act: string; readonly value?: string }
	| { readonly type: "toggle" | "change" | "edit" | "undo" | "send"; readonly key: string };

/** One footer hint: the key ids that trigger it (alternatives side by side) and what it does. */
export interface NativeHint {
	keys: readonly string[];
	label: string;
}

/** A mounted, empty, invisible node for a component that shows nothing. */
export const HIDDEN: NativeNode = { k: "col", p: { hidden: true } };

export function node(k: string, p?: Record<string, unknown>, c?: readonly NativeChild[], key?: string): NativeNode {
	const out: { k: string; p?: Record<string, unknown>; c?: readonly NativeChild[]; key?: string } = { k };
	if (p !== undefined) out.p = p;
	if (c !== undefined) out.c = c;
	if (key !== undefined) out.key = key;
	return out;
}

/** One styled span; `s` is a space-separated list of semantic or theme tokens. */
export function span(t: string, s?: string, extra?: Omit<TspSpan, "t" | "s">): TspSpan {
	if (s === undefined && extra === undefined) return { t };
	return s === undefined ? { t, ...extra } : { t, s, ...extra };
}

/** Plain or styled text. */
export function text(content: TspText, p?: Record<string, unknown>, key?: string): NativeNode {
	return node("text", typeof content === "string" ? { ...p, text: content } : { ...p, spans: content }, undefined, key);
}

/** Markdown source. */
export function md(source: string, p?: Record<string, unknown>, key?: string): NativeNode {
	return node("md", { ...p, text: source }, undefined, key);
}

/** Vertical stack. */
export function col(c: readonly NativeChild[], p?: Record<string, unknown>, key?: string): NativeNode {
	return node("col", p, c, key);
}

/** Horizontal flex row. */
export function row(c: readonly NativeChild[], p?: Record<string, unknown>, key?: string): NativeNode {
	return node("row", p, c, key);
}

export function card(p: Record<string, unknown>, c: readonly NativeChild[], key?: string): NativeNode {
	return node("card", p, c, key);
}

/**
 * The keycap names of one key id, as `kbd` takes them: `alt+i` → `["alt", "i"]`,
 * `escape` → `["esc"]`. A literal `+` key survives (`+`, `ctrl++`).
 */
export function keyCaps(key: string): string[] {
	const parts = key === "+" ? ["+"] : key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
	return parts.filter((part) => part.length > 0).map((part) => (part === "escape" ? "esc" : part));
}

function kbd(key: string): NativeNode {
	return node("kbd", { keys: keyCaps(key) });
}

/**
 * A wrapping row of keycaps with muted labels (role `omp.overlay.hints`): the footer hint strip.
 * `undefined` entries are skipped.
 */
export function hintsRow(hints: readonly (NativeHint | undefined)[], key = "hints"): NativeNode {
	const children: NativeChild[] = [];
	for (const hint of hints) {
		if (!hint) continue;
		const group: NativeChild[] = hint.keys.map((k) => kbd(k));
		group.push(text([span(hint.label, "muted")]));
		children.push(row(group, { gap: "xs", align: "center" }));
	}
	return node("row", { gap: "md", wrap: true, role: "omp.overlay.hints" }, children, key);
}

/** A wrapping footer: a status line (`✓ Copied to clipboard`, `⚠ Cancelled`) followed by key hints. */
export function statusHintsRow(status: TspText, hints: readonly (NativeHint | undefined)[]): NativeNode {
	return row([text(status), hintsRow(hints)], { gap: "md", wrap: true, align: "center" });
}

/**
 * A native button (role `omp.btn`): a label plus the keycap of the key it mirrors. A click sends
 * `act` back as an `action` event; the node's sibling key defaults to `act`.
 */
export function actionButton(
	label: string,
	act: string,
	options: { keys?: string; tone?: "accent" | "error"; key?: string } = {},
): NativeNode {
	const { keys, tone } = options;
	const children: NativeChild[] = [text(label)];
	if (keys) children.push(kbd(keys));
	return node(
		"row",
		{
			role: "omp.btn",
			gap: "xs",
			align: "center",
			actions: { click: act },
			title: keys ? `${label}  ${keyCaps(keys).join("+")}` : label,
			...(tone ? { tone } : {}),
		},
		children,
		options.key ?? act,
	);
}

/** A row of buttons (role `omp.actions`); a `null` entry is the spacer that end-aligns what follows. */
export function actionBar(buttons: readonly (NativeNode | null)[], key = "actions"): NativeNode {
	const children = buttons.map((button) => button ?? node("spacer", { grow: 1 }));
	return node("row", { role: "omp.actions", gap: "sm", align: "center" }, children, key);
}

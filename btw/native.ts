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
	/**
	 * The reconciler uses the child index when the key is omitted.
	 */
	readonly key?: string;
	/**
	 * The reconciler only reveals a node when it mounts.
	 */
	readonly reveal?: "start" | "end" | "nearest";
}
export type NativeChild = NativeNode | Component;

export interface DescribeCx {
	readonly cols: number;
	supports(kind: string): boolean;
	feature?(name: string): boolean;
}

/**
 * Event keys are paths relative to the owning component.
 */
export type NativeUiEvent =
	| { readonly type: "select" | "activate"; readonly key: string; readonly item: string }
	| { readonly type: "action"; readonly key: string; readonly act: string; readonly value?: string }
	| { readonly type: "toggle" | "change" | "edit" | "undo" | "send"; readonly key: string };

export interface NativeHint {
	keys: readonly string[];
	label: string;
}

export const HIDDEN: NativeNode = { k: "col", p: { hidden: true } };

export function node(k: string, p?: Record<string, unknown>, c?: readonly NativeChild[], key?: string): NativeNode {
	const out: { k: string; p?: Record<string, unknown>; c?: readonly NativeChild[]; key?: string } = { k };
	if (p !== undefined) out.p = p;
	if (c !== undefined) out.c = c;
	if (key !== undefined) out.key = key;
	return out;
}

/**
 * Separate the style tokens in `s` with spaces.
 */
export function span(t: string, s?: string, extra?: Omit<TspSpan, "t" | "s">): TspSpan {
	if (s === undefined && extra === undefined) return { t };
	return s === undefined ? { t, ...extra } : { t, s, ...extra };
}

export function text(content: TspText, p?: Record<string, unknown>, key?: string): NativeNode {
	return node("text", typeof content === "string" ? { ...p, text: content } : { ...p, spans: content }, undefined, key);
}

export function md(source: string, p?: Record<string, unknown>, key?: string): NativeNode {
	return node("md", { ...p, text: source }, undefined, key);
}

export function col(c: readonly NativeChild[], p?: Record<string, unknown>, key?: string): NativeNode {
	return node("col", p, c, key);
}

export function row(c: readonly NativeChild[], p?: Record<string, unknown>, key?: string): NativeNode {
	return node("row", p, c, key);
}

export function card(p: Record<string, unknown>, c: readonly NativeChild[], key?: string): NativeNode {
	return node("card", p, c, key);
}

export function keyCaps(key: string): string[] {
	const parts = key === "+" ? ["+"] : key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
	return parts.filter((part) => part.length > 0).map((part) => (part === "escape" ? "esc" : part));
}

function kbd(key: string): NativeNode {
	return node("kbd", { keys: keyCaps(key) });
}

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

export function statusHintsRow(status: TspText, hints: readonly (NativeHint | undefined)[]): NativeNode {
	return row([text(status), hintsRow(hints)], { gap: "md", wrap: true, align: "center" });
}

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

export function actionBar(buttons: readonly (NativeNode | null)[], key = "actions"): NativeNode {
	const children = buttons.map((button) => button ?? node("spacer", { grow: 1 }));
	return node("row", { role: "omp.actions", gap: "sm", align: "center" }, children, key);
}

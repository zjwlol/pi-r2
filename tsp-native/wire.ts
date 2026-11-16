/**
 * Tern Surface Protocol (TSP) wire shapes, ported from oh-my-pi
 * `packages/wire/src/tsp.ts` (trimmed to what this extension sends and reads;
 * unknown fields and verbs are ignored in both directions).
 *
 * Messages travel in-band as APC strings on the pty:
 *
 *     ESC _ tsp ; <verb> [; <key>=<value>]* ; <body> ESC \
 *
 * Program → terminal verbs: `q` query, `o` open, `f` frame, `b` blob, `t`
 * palette, `x` close. Terminal → program: `r` reply, `e` event.
 */

export const TSP_VERSION = 1;
export const TSP_APC_ID = "tsp";
export const TSP_DEFAULT_APC_LIMIT = 65_536;
export const TSP_DEFAULT_CREDITS = 2;

export type TspVerb = "q" | "o" | "f" | "b" | "t" | "x" | "r" | "e";

export const TSP_KINDS = [
	"col",
	"row",
	"card",
	"section",
	"rule",
	"spacer",
	"text",
	"md",
	"code",
	"diff",
	"ansi",
	"math",
	"image",
	"media",
	"kv",
	"table",
	"tree",
	"badge",
	"kbd",
	"icon",
	"spinner",
	"shimmer",
	"elapsed",
	"progress",
	"rate",
	"list",
	"item",
	"tabs",
	"editor",
	"input",
	"status",
	"seg",
	"overlay",
	"toast",
	"rows",
	"picker",
	"prefs",
	"tool",
	"checklist",
	"agent",
	"chart",
	"meter",
	"effort",
] as const;

export type TspKind = (typeof TSP_KINDS)[number];

export type TspTone = "neutral" | "accent" | "info" | "success" | "warning" | "error" | "pending" | "muted" | "user";
export type TspSpace = "none" | "xs" | "sm" | "md" | "lg";
export type TspEffect = "shimmer" | "pulse" | "none";

export interface TspSpan {
	t: string;
	s?: string;
	fx?: TspEffect;
	href?: string;
}
export type TspText = string | readonly TspSpan[];
export type TspCardStatus = "pending" | "running" | "done" | "error" | "cancelled";
export type TspPreview = { lines: number } | "auto";
/** A `tool` node's body clamp while collapsed: head lines, tail lines (shell output), none, or the children's own previews. */
export type TspToolPreview = { lines: number } | { tail: number } | "none" | "children";

/** Props every node accepts, plus the kind-specific ones this extension uses (loosely typed). */
export interface TspProps {
	role?: string;
	key?: string;
	tone?: TspTone;
	hidden?: boolean;
	grow?: number;
	title?: string;
	aria?: string;
	href?: string;
	actions?: { click?: string; dblclick?: string; menu?: readonly string[] };
	// col/row
	gap?: TspSpace;
	align?: string;
	justify?: string;
	wrap?: boolean | "word" | "char" | "none";
	// card/section/overlay
	head?: TspText;
	status?: TspCardStatus;
	collapsible?: boolean;
	collapsed?: boolean;
	preview?: TspPreview | TspToolPreview;
	anchor?: "center" | "top" | "bottom" | { node: string; side: "above" | "below" } | { caret: string };
	size?: string;
	modal?: boolean;
	// text-like
	text?: string;
	spans?: readonly TspSpan[];
	stream?: boolean;
	marks?: readonly unknown[];
	lang?: string;
	path?: string;
	start?: number;
	numbers?: boolean;
	follow?: boolean;
	cols?: number;
	lines?: readonly string[] | number;
	// spinner/shimmer/elapsed
	style?: string;
	label?: TspText;
	age?: number;
	stopped?: number;
	format?: string;
	// editor
	cursor?: number;
	anchorOffset?: never;
	decor?: readonly TspEditorDecoration[];
	ghost?: string;
	placeholder?: TspText;
	prompt?: TspText;
	mode?: string;
	readonly?: boolean;
	sendable?: boolean;
	maxLines?: number;
	// status/seg
	transparent?: boolean;
	icon?: string;
	priority?: number;
	side?: "left" | "right";
	// badge/kbd
	keys?: readonly string[];
	// misc passthrough
	[extra: string]: unknown;
}

export interface TspEditorDecoration {
	from: number;
	to: number;
	s: string;
	fx?: TspEffect;
}

/** Kinds whose primary text the `text` and `splice` ops address. */
export const TSP_TEXT_KINDS = ["text", "md", "code", "ansi", "math", "editor", "input", "shimmer"] as const;

/** A node on the wire. */
export interface TspNode {
	id: string;
	k: TspKind;
	p?: TspProps;
	c?: readonly TspNode[];
}

export const TSP_REGION_IDS = { main: "main", dock: "dock", layer: "layer" } as const;

export type TspOp =
	| readonly [op: "add", id: string, parent: string, before: string | null, node: TspNode]
	| readonly [op: "set", id: string, props: Readonly<Record<string, unknown>>]
	| readonly [op: "text", id: string, mode: "append" | "replace", text: string]
	| readonly [op: "splice", id: string, at: number, del: number, text: string]
	| readonly [op: "move", id: string, parent: string, before: string | null]
	| readonly [op: "del", id: string]
	| readonly [op: "settle", id: string]
	| readonly [op: "focus", id: string | null]
	| readonly [op: "reveal", id: string, where: "start" | "end" | "nearest"]
	| readonly [op: "scroll", id: string, by: string]
	| readonly [op: "suspend"]
	| readonly [op: "resume"];

export interface TspFrame {
	sf: string;
	s: number;
	ops: readonly TspOp[];
}

export interface TspOpen {
	id: string;
	mode: "inline" | "screen";
	title?: string;
	role?: string;
	adopt?: boolean;
}

export interface TspClose {
	id: string;
	keep: boolean;
}

export interface TspPalette {
	sf: string;
	dark?: Readonly<Record<string, string>>;
	light?: Readonly<Record<string, string>>;
	name?: { dark?: string; light?: string };
}

export type TspQuery =
	| { q: "hello"; v: readonly number[]; app: string; ver?: string; features?: readonly string[] }
	| { q: "blobs"; ids: readonly string[] };

export interface TspHello {
	r: "hello";
	v: number;
	term: string;
	ver?: string;
	kinds: readonly string[];
	features?: readonly string[];
	apc?: number;
	credits?: number;
	cols?: number;
	cell?: { w: number; h: number };
	dark?: boolean;
	reduceMotion?: boolean;
	hour12?: boolean;
}

export type TspReply = TspHello | { r: "blobs"; have: readonly string[] } | { r: string; [extra: string]: unknown };

export type TspEvent =
	| { ev: "ack"; sf: string; s: number }
	| { ev: "resize"; sf?: string; cols: number; cell?: { w: number; h: number }; visible?: boolean }
	| { ev: "theme"; dark: boolean }
	| { ev: "motion"; reduce: boolean }
	| { ev: "visible"; sf?: string; visible: boolean }
	| { ev: "toggle"; sf: string; id: string; key?: string; collapsed: boolean }
	| { ev: "select"; sf: string; id: string; item: string }
	| { ev: "activate"; sf: string; id: string; item: string }
	| { ev: "action"; sf: string; id: string; act: string; value?: string; mods?: readonly string[] }
	| { ev: "change"; sf: string; id: string; item: string; value: unknown }
	| { ev: "edit"; sf: string; id: string; from: number; to: number; text: string; cursor: number; len: number }
	| { ev: "undo"; sf: string; id: string }
	| { ev: "send"; sf: string; id: string; text: string }
	| { ev: "focus"; sf: string; id: string }
	| { ev: "error"; sf?: string; s?: number; op?: number; msg: string }
	| { ev: "gone"; sf?: string; ids: readonly string[] }
	| { ev: string; [extra: string]: unknown };

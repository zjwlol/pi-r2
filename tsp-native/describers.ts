/**
 * Describers: how pi's interactive-mode components become TSP nodes. A
 * registry keyed by class (instanceof first, constructor name as a fallback
 * for duplicated module instances). Every describer runs under try/catch; a
 * throw, or a `null` result, means the component falls back to `rows`.
 *
 * Role names follow oh-my-pi (`omp.user`, `omp.assistant`, `omp.tool.*`,
 * `omp.field`, …) so Tern's stylesheet applies.
 */
import {
	AssistantMessageComponent,
	DynamicBorder,
	FooterComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Editor, Loader, Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import {
	autocompleteIcons,
	autocompleteInline,
	autocompleteMark,
	autocompleteOverlay,
	COMPOSER_CARET,
	type ComposerFacts,
	type ComposerKeys,
	composerChips,
	composerFacts,
	composerKeys,
	describeComposer,
	FIELD_CARET,
	findFooter,
	footerCarried,
	hostComposer,
	noteFactsCarried,
	releaseComposer,
	runComposerAction,
	sessionPlaceholder,
	sessionRunning,
} from "./composer.ts";
import {
	ansi,
	card,
	code,
	col,
	compact,
	type DescribeContext,
	diff,
	EMPTY_NODE,
	md,
	type NativeChild,
	type NativeNode,
	type NativeUiEvent,
	node,
	row,
	rule,
	sameFingerprint,
	spacer,
	span,
	stripAnsi,
	text,
} from "./node.ts";
import { cleanRow, nativeComponentId } from "./reconcile.ts";
import { hasStyle, lineToSpans, spansThemeId } from "./spans.ts";
import { TRANSCRIPT_DESCRIBERS } from "./transcript.ts";
import { BLOCK_DESCRIBERS, releaseBlockSideEffects, toolResultImages } from "./describe-blocks.ts";
import { PICKER_DESCRIBERS } from "./describe-pickers.ts";
import { PREFS_DESCRIBERS } from "./describe-prefs.ts";
import { SHEET_DESCRIBERS } from "./describe-sheets.ts";
import { TUI_DESCRIBERS } from "./describe-tui.ts";
import type { TspCardStatus, TspEditorDecoration, TspKind, TspSpan, TspText, TspTone, TspToolPreview } from "./wire.ts";

/** Loose view of private component state. */
type Any = Record<string, any>;

export interface Describer {
	readonly name: string;
	matches(component: Component): boolean;
	/** Cheap fingerprint of everything the description depends on; same fingerprint → same node. */
	fingerprint(component: Component, cx: DescribeContext): readonly unknown[];
	build(component: Component, cx: DescribeContext): NativeNode | null;
	handleEvent?(component: Component, event: NativeUiEvent, cx: DescribeContext): void;
}

export interface DescriberStats {
	native: Map<string, number>;
	rows: Map<string, number>;
	failures: Map<string, string>;
}

/** Hooks a component (MagicEditor) may implement itself; duck-typed so the editor module needs no import. */
export interface EditorNativeHooks {
	/** Decorations over the current text (UTF-16 offsets into lines joined by "\n"). */
	describeDecorations?(text: string): readonly TspEditorDecoration[];
	/** Set while a TSP surface draws the editor: skip ANSI-only effects and their timers. */
	nativeMode?: boolean;
}

const memo = new WeakMap<Component, { by: Describer; fp: readonly unknown[]; node: NativeNode | null }>();
/** Components whose describer threw: they stay on rows for the rest of the session. */
const broken = new WeakSet<Component>();
/** Loaders whose animation timers we stopped while native; restarted on fallback. */
const stoppedLoaders = new Set<Loader>();
/** Editors switched to native mode; reverted on fallback. */
const nativeEditors = new Set<Component>();
/** What each prompt editor's composer shows this frame besides the draft (set by its fingerprint). */
const composerFrames = new WeakMap<Component, ComposerFrame>();
/** Prompt editors whose working indicator their container describes over the composer (set by the container's fingerprint). */
const hoistedIndicators = new WeakMap<Component, Component>();
/** Footers whose facts the composer carries this frame: they describe hidden. */
const carriedFooters = new WeakSet<Component>();
/** Forced failures for tests: `PI_TSP_FAIL_DESCRIBER=<describer name>`. */
const failDescriber = process.env.PI_TSP_FAIL_DESCRIBER;

export const stats: DescriberStats = { native: new Map(), rows: new Map(), failures: new Map() };

function bump(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function is(component: Component, ctor: Function | undefined, name: string): boolean {
	if (ctor && component instanceof ctor) return true;
	for (let proto = Object.getPrototypeOf(component); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		if (proto.constructor?.name === name) return true;
	}
	return false;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function plain(s: string): string {
	return stripAnsi(s).replaceAll("\x1b_pi:c\x07", "");
}

function rowsNode(lines: readonly string[], cols: number, key?: string): NativeNode {
	return node("rows", { cols, lines: lines.map(cleanRow) }, undefined, key);
}

function safeRender(component: Component, cols: number): string[] {
	try {
		return component.render(Math.max(1, cols));
	} catch {
		return [];
	}
}

function firstLine(s: string): string {
	const nl = s.indexOf("\n");
	return nl === -1 ? s : s.slice(0, nl);
}

function textOutput(result: Any | undefined): string {
	const content: Any[] | undefined = result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

function previewLines(text: string): number {
	return Math.min(10, Math.max(1, text.split("\n").length));
}

/** A line of pi's display diff: marker, padded line number, one space, the line's text. */
const DISPLAY_DIFF_LINE = /^([+\- ])(\s*\d+)(?: (.*))?$/s;

/**
 * The `diff` hunks of pi's display-oriented edit diff (`+12 added`,
 * `-12 removed`, ` 12 context`, a numberless `...` row between regions), the
 * way omp's `nativeDiff` reads its compact diff: each run of consecutive lines
 * is one hunk, and a `...` row or a jump in line numbers starts the next.
 * Removed and context rows carry old line numbers, added rows new ones, so the
 * other side follows from the running offset. Runs without a change are
 * dropped. Undefined when nothing parses into a hunk.
 */
function displayDiffHunks(display: string): { oldStart: number; newStart: number; lines: string[] }[] | undefined {
	const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
	let lines: string[] = [];
	let changed = false;
	let oldStart = 1;
	let newStart = 1;
	// The old and new lines the open run continues with.
	let nextOld = 1;
	let nextNew = 1;
	const close = (): void => {
		if (changed) hunks.push({ oldStart, newStart, lines });
		lines = [];
		changed = false;
	};
	for (const raw of display.split("\n")) {
		const parsed = DISPLAY_DIFF_LINE.exec(raw);
		if (!parsed) {
			const trimmed = raw.trim();
			if (trimmed === "" || trimmed === "..." || trimmed === "…") close();
			continue;
		}
		const prefix = parsed[1]!;
		const number = Number.parseInt(parsed[2]!.trim(), 10);
		const added = prefix === "+";
		if (number !== (added ? nextNew : nextOld)) {
			close();
			// The lines skipped are unchanged: both sides move by as many.
			const skipped = number - (added ? nextNew : nextOld);
			nextOld += skipped;
			nextNew += skipped;
		}
		if (lines.length === 0) {
			oldStart = nextOld;
			newStart = nextNew;
		}
		if (prefix !== "+") nextOld++;
		if (prefix !== "-") nextNew++;
		changed ||= prefix !== " ";
		lines.push(`${prefix}${parsed[3] ?? ""}`);
	}
	close();
	return hunks.length > 0 ? hunks : undefined;
}

// ── Describers ──────────────────────────────────────────────────────────

const userMessage: Describer = {
	name: "UserMessage",
	matches: (c) => is(c, UserMessageComponent, "UserMessageComponent"),
	fingerprint: (c) => [(c as Any).text],
	build: (c) => card({ role: "omp.user", tone: "user" }, [md(String((c as Any).text ?? ""))]),
};

function assistantSignature(message: Any | undefined): string {
	if (!message) return "";
	let sig = `${message.stopReason ?? ""}|${message.errorMessage ?? ""}`;
	for (const part of message.content ?? []) {
		if (part.type === "text") sig += `|t${part.text?.length ?? 0}`;
		else if (part.type === "thinking") sig += `|k${part.thinking?.length ?? 0}`;
		else sig += `|${part.type}`;
	}
	return sig;
}

const assistantMessage: Describer = {
	name: "AssistantMessage",
	matches: (c) => is(c, AssistantMessageComponent, "AssistantMessageComponent"),
	fingerprint: (c) => {
		const a = c as Any;
		return [a.lastMessage, assistantSignature(a.lastMessage), a.isStreaming, a.hideThinkingBlock, a.hiddenThinkingLabel];
	},
	build: (c) => {
		const a = c as Any;
		const message: Any | undefined = a.lastMessage;
		if (!message) return EMPTY_NODE;
		const streaming = a.isStreaming === true;
		const children: NativeChild[] = [];
		const content: Any[] = message.content ?? [];
		for (let i = 0; i < content.length; i++) {
			const part = content[i]!;
			if (part.type === "text" && String(part.text ?? "").trim()) {
				children.push(md(String(part.text).trim(), streaming && i === content.length - 1 ? { stream: true } : undefined, `t${i}`));
			} else if (part.type === "thinking") {
				const blocks: string[] = [];
				const start = i;
				for (; i < content.length && content[i]!.type === "thinking"; i++) {
					const thinking = String(content[i]!.thinking ?? "").trim();
					if (thinking) blocks.push(thinking);
				}
				i--;
				if (blocks.length === 0) continue;
				const hidden = a.hideThinkingBlock === true;
				const live = streaming && i === content.length - 1;
				children.push(
					node(
						"section",
						{ role: live ? "omp.thinking.live" : "omp.thinking", collapsible: true, collapsed: hidden, head: [span(String(a.hiddenThinkingLabel ?? "Thinking..."), "thinkingText")] },
						[md(blocks.join("\n\n"), live ? { stream: true } : undefined, "body")],
						`k${start}`,
					),
				);
			}
		}
		const hasToolCalls = content.some((p) => p.type === "toolCall");
		if (message.stopReason === "length") {
			children.push(text([span("Response was truncated before completion.", "error")], undefined, "len"));
		} else if (!hasToolCalls && message.stopReason === "aborted") {
			const msg = message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted";
			children.push(text([span(String(msg), "error")], undefined, "abort"));
		} else if (!hasToolCalls && message.stopReason === "error") {
			children.push(text([span(`Error: ${message.errorMessage || "Unknown error"}`, "error")], undefined, "err"));
		}
		if (children.length === 0) return EMPTY_NODE;
		return col(children, { role: "omp.assistant" });
	},
};

const markdown: Describer = {
	name: "Markdown",
	matches: (c) => is(c, Markdown, "Markdown"),
	fingerprint: (c) => [(c as Any).text],
	build: (c) => md(String((c as Any).text ?? "")),
};

const spacerDescriber: Describer = {
	name: "Spacer",
	matches: (c) => is(c, Spacer, "Spacer"),
	fingerprint: (c) => [(c as Any).lines],
	build: (c) => {
		const lines = Number((c as Any).lines ?? 1);
		if (lines <= 0) return EMPTY_NODE;
		return spacer(lines === 1 ? "sm" : lines === 2 ? "md" : "lg");
	},
};

const border: Describer = {
	name: "DynamicBorder",
	matches: (c) => is(c, DynamicBorder, "DynamicBorder"),
	fingerprint: () => [],
	build: () => rule(),
};

const loader: Describer = {
	name: "Loader",
	matches: (c) => is(c, Loader, "Loader"),
	fingerprint: (c) => {
		const a = c as Any;
		return [a.message, a.frames?.length, a.kind];
	},
	build: (c) => {
		const a = c as Any;
		// The terminal clocks the spinner: stop pi's 80 ms repaint timer while native.
		if (a.intervalId) {
			a.stop?.();
			stoppedLoaders.add(c as Loader);
		}
		const message = String(a.message ?? "");
		const frames: string[] = a.frames ?? [];
		const label: TspSpan[] = [span(message, "muted")];
		if (frames.length === 0) return row([text(label)], { role: "omp.working", align: "center" });
		return row([node("spinner", { style: "dots", tone: "accent", label })], { role: "omp.working", align: "center", gap: "sm" });
	},
};

/** A styled pi line as a `text` node: theme colours become span tokens; a plain line stays a plain string. */
function styledLine(line: string, key?: string): NativeNode {
	const spans = lineToSpans(line);
	if (spans.length === 0) return text("", { role: "pi.text" }, key);
	if (!hasStyle(spans)) return text(spans.map((sp) => sp.t).join(""), { role: "pi.text", wrap: "word" }, key);
	return text(spans, { role: "pi.text", wrap: "word" }, key);
}

const plainText: Describer = {
	name: "Text",
	matches: (c) => is(c, Text, "Text"),
	fingerprint: (c) => {
		const a = c as Any;
		// ThemedText rebuilds its string lazily in render(): ask for it once so `text` is current.
		if (a.stale === true && typeof a.build === "function") {
			a.stale = false;
			a.setText?.(a.build());
		}
		return [a.text, a.paddingY, spansThemeId()];
	},
	build: (c) => {
		const a = c as Any;
		const raw = String(a.text ?? "").replaceAll("\x1b_pi:c\x07", "");
		if (plain(raw).trim() === "") return a.paddingY > 0 ? spacer("sm") : EMPTY_NODE;
		const lines = raw.split("\n");
		const body = lines.length === 1 ? styledLine(lines[0]!, "t") : col(lines.map((line, i) => styledLine(line, `l${i}`)), { role: "pi.text" }, "t");
		if (!a.paddingY) return body;
		return col([spacer("sm", "a"), body, spacer("sm", "b")]);
	},
};

const container: Describer = {
	name: "Container",
	matches: (c) => is(c, Container, "Container") || is(c, Box, "Box"),
	fingerprint: (c, cx) => {
		const children: Component[] = (c as Any).children ?? [];
		return [children.length, [...children], hoistIndicator(children, cx)];
	},
	build: (c) => {
		const children: Component[] = (c as Any).children ?? [];
		if (children.length === 0) return EMPTY_NODE;
		// pi's editor container: the working row goes over the composer, as omp's activity line.
		const indicator = children.length === 1 ? hoistedIndicators.get(children[0]!) : undefined;
		if (indicator) return col([indicator, children[0]!], { gap: "lg" });
		return col(children.slice());
	},
};

const mouseRegion: Describer = {
	name: "MouseRegion",
	matches: (c) => is(c, MouseRegion, "MouseRegion"),
	fingerprint: (c) => [(c as Any).child],
	build: (c) => {
		const child: Component | undefined = (c as Any).child;
		return child ? col([child]) : EMPTY_NODE;
	},
};

const idleStatus: Describer = {
	name: "IdleStatus",
	matches: (c) => is(c, undefined, "IdleStatus"),
	fingerprint: () => [],
	build: () => spacer("sm"),
};

function footerSegments(c: Component): { left: string[]; right: string[] } {
	// Render wide so nothing is truncated, then split the stats line at its padding gap.
	const lines = safeRender(c, 400).map(plain);
	const left: string[] = [];
	const right: string[] = [];
	const pwd = (lines[0] ?? "").trim();
	if (pwd) left.push(pwd);
	const stats = lines[1] ?? "";
	const gap = stats.search(/ {2,}/);
	if (gap === -1) {
		if (stats.trim()) left.push(stats.trim());
	} else {
		left.push(stats.slice(0, gap).trim());
		right.push(stats.slice(gap).trim());
	}
	for (const extra of lines.slice(2)) if (extra.trim()) left.push(extra.trim());
	return { left, right };
}

const footer: Describer = {
	name: "Footer",
	matches: (c) => is(c, FooterComponent, "FooterComponent"),
	fingerprint: (c) => {
		// The composer carries its facts this frame: no duplicate line.
		if (footerCarried(c)) {
			carriedFooters.add(c);
			return [true];
		}
		carriedFooters.delete(c);
		const { left, right } = footerSegments(c);
		return [false, left.join("\u0000"), right.join("\u0000")];
	},
	build: (c) => {
		if (carriedFooters.has(c)) return EMPTY_NODE;
		const { left, right } = footerSegments(c);
		const segs: NativeNode[] = [];
		left.forEach((t, i) => segs.push(node("seg", { spans: [span(t, "muted")], side: "left", priority: 10 - i }, undefined, `l${i}`)));
		right.forEach((t, i) => segs.push(node("seg", { spans: [span(t, "muted")], side: "right", priority: 5 - i }, undefined, `r${i}`)));
		if (segs.length === 0) return EMPTY_NODE;
		return node("status", { role: "omp.status", transparent: true }, segs);
	},
};

// ── Tool execution ──────────────────────────────────────────────────────

function toolStatus(a: Any): TspCardStatus {
	if (a.isPartial) return a.executionStarted ? "running" : "pending";
	if (a.result?.isError) return "error";
	return "done";
}

function toolTarget(name: string, args: Any): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	switch (name) {
		case "bash":
		case "powershell":
			return typeof args.command === "string" ? firstLine(args.command) : undefined;
		case "read":
		case "write":
		case "edit":
		case "ls":
			return typeof args.path === "string" ? args.path : undefined;
		case "grep":
			return typeof args.pattern === "string" ? args.pattern : undefined;
		case "find":
			return typeof args.pattern === "string" ? args.pattern : undefined;
		default: {
			const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
			return first ? firstLine(first).slice(0, 120) : undefined;
		}
	}
}

function toolBody(a: Any, cx: DescribeContext, tool = false): NativeChild[] {
	const name: string = a.toolName;
	const args: Any = a.args ?? {};
	const result: Any | undefined = a.result;
	const expanded = a.expanded === true;
	const out: NativeChild[] = [];
	const output = textOutput(result);
	// A `tool` node clamps its body itself; inside a card the children carry the previews.
	const preview = expanded || tool ? undefined : ({ lines: previewLines(output) } as const);
	// pi's grep/find/ls renderers repeat the call line a `tool` head already shows: their output alone reads natively.
	if (tool && (name === "grep" || name === "find" || name === "ls")) {
		if (output) out.push(code(plain(output), { role: `omp.tool.${name}.output` }, "out"));
		return out;
	}
	switch (name) {
		case "bash":
		case "powershell": {
			// A `tool` head shows a one-line command as its target: only a multi-line script keeps its code block.
			if (typeof args.command === "string" && (!tool || args.command.trim().includes("\n"))) out.push(code(args.command, { lang: name === "bash" ? "bash" : "powershell", role: "omp.tool.bash.command" }, "cmd"));
			if (output) out.push(ansi(output, { follow: a.isPartial === true, preview, role: "omp.tool.bash.output" }, "out"));
			return out;
		}
		case "edit": {
			const path = typeof args.path === "string" ? args.path : undefined;
			// pi's standard unified patch (`--- path`, `+++ path`, `@@ -a,b +c,d @@` hunks); a patch without a hunk shows nothing.
			const patch: unknown = result?.details?.patch;
			if (typeof patch === "string" && /^@@ /m.test(patch)) {
				out.push(diff(patch, { path, role: "omp.tool.edit.diff" }, "diff"));
				return out;
			}
			// Only the display diff (older pi, other edit tools): its numbered lines as hunks, never as unified text.
			const display: unknown = result?.details?.diff;
			const hunks = typeof display === "string" && display.trim() ? displayDiffHunks(display) : undefined;
			if (hunks) out.push(node("diff", { path, role: "omp.tool.edit.diff", hunks }, undefined, "diff"));
			else if (output) out.push(text(plain(output), undefined, "out"));
			return out;
		}
		case "write": {
			if (typeof args.content === "string") out.push(code(args.content, { path: typeof args.path === "string" ? args.path : undefined, preview: expanded || tool ? undefined : { lines: 10 } }, "content"));
			if (output && result?.isError) out.push(text([span(plain(output), "error")], undefined, "err"));
			return out;
		}
		case "read": {
			if (output) out.push(code(output, { path: typeof args.path === "string" ? args.path : undefined, start: typeof args.offset === "number" ? args.offset : undefined, preview, role: "omp.tool.read" }, "out"));
			return out;
		}
		default: {
			// Tools with their own renderer (extensions): their rendered rows keep the body faithful.
			const shell: Component | undefined = a.toolDefinition?.renderShell === "self" ? a.selfRenderContainer : a.contentBox;
			if (a.toolDefinition && shell && (a.toolDefinition.renderResult || a.toolDefinition.renderCall)) {
				const lines = safeRender(shell, cx.cols);
				if (lines.length > 0) out.push(rowsNode(lines, cx.cols, "rows"));
				return out;
			}
			if (output) out.push(code(output, { preview, role: "omp.tool.output" }, "out"));
			// The complete arguments (the head clips its one value), folded after the output, once the call runs:
			// streamed argument deltas would re-send the whole JSON each frame.
			if ((a.executionStarted === true || result !== undefined) && args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length > 0) {
				out.push(node("section", { head: [span("Args", "muted")], collapsible: true, collapsed: true }, [code(JSON.stringify(args, null, 2), { lang: "json" }, "json")], "args"));
			}
			return out;
		}
	}
}

// ── Native tool hooks ───────────────────────────────────────────────────
//
// The contract with extensions: optional fields on a registered ToolDefinition
// (pi hands the definition to `ToolExecutionComponent.toolDefinition` as is).
// Both sides define these types locally; nothing is imported across.

/** A node in a hook's view: plain JSON, the shape of {@link NativeNode}. */
export interface NativeViewNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly NativeViewNode[];
	readonly key?: string;
}

export interface NativeDescribeOptions {
	expanded: boolean;
	isPartial: boolean;
	executionStarted: boolean;
	argsComplete: boolean;
	cols: number;
	/** Date.now() at describe time. */
	nowMs: number;
	/** The terminal advertises this TSP node kind. */
	supports(kind: string): boolean;
}

export type NativeToolTargetKind = "command" | "path" | "pattern" | "query" | "text";

/** A tool call as data: the `tool` node's head, its body nodes and its fold. */
export interface NativeToolView {
	tool?: {
		title?: TspText;
		target?: TspText;
		targetKind?: NativeToolTargetKind;
		meta?: readonly TspText[];
		badges?: readonly { text: string; tone?: TspTone; title?: string }[];
		note?: TspText;
		/** Timer override: a number is a live timer (ms elapsed now); null: no timer; undefined: the default. */
		age?: number | null;
		/** Timer override: a number is a stopped timer (total ms); null: no timer; undefined: the default. */
		took?: number | null;
	};
	body?: readonly NativeViewNode[];
	tone?: TspTone;
	preview?: TspToolPreview;
	/** Never start collapsed. */
	open?: boolean;
	/** `frame: "inline"`: a head line plus a disclosed body, no ring. */
	inline?: boolean;
}

/**
 * Describe hooks a tool definition may carry. Memo contract: return the same
 * view object while nothing shown changed, a new one when anything did.
 */
export interface NativeToolHooks {
	describeCall?(args: unknown, options: NativeDescribeOptions): NativeToolView | undefined;
	describeResult?(result: { content: unknown[]; details: unknown; isError: boolean }, options: NativeDescribeOptions, args: unknown): NativeToolView | undefined;
	/** true: once a result exists only describeResult's view counts (describeCall's when it returns none). Else the call head merges under the result head and the bodies concatenate. */
	mergeCallAndResult?: boolean;
}

/** omp's DEFAULT_TERMINAL_PREVIEW_LINES: a collapsed tool body shows this many lines. */
const TOOL_PREVIEW_LINES = 10;
const NO_BODY: readonly NativeChild[] = [];

/** The hook view `fingerprint` computed, reused by `build` (no second hook call). */
const toolViews = new WeakMap<Component, NativeToolView | undefined>();
/** The last merged call+result view, kept while both halves are reference-equal. */
const mergedViews = new WeakMap<Component, { call: NativeToolView; result: NativeToolView; view: NativeToolView }>();
/** When execution was first seen started, and first seen settled (Date.now()). */
const toolClocks = new WeakMap<Component, { start?: number; end?: number }>();

function asView(value: unknown): NativeToolView | undefined {
	return value !== null && typeof value === "object" ? (value as NativeToolView) : undefined;
}

function mergeViews(c: Component, call: NativeToolView, result: NativeToolView): NativeToolView {
	const last = mergedViews.get(c);
	if (last && last.call === call && last.result === result) return last.view;
	const view: NativeToolView = {
		tool: call.tool || result.tool ? { ...call.tool, ...result.tool } : undefined,
		body: [...(call.body ?? []), ...(result.body ?? [])],
		tone: result.tone ?? call.tone,
		preview: result.preview ?? call.preview,
		open: result.open ?? call.open,
		inline: result.inline ?? call.inline,
	};
	mergedViews.set(c, { call, result, view });
	return view;
}

/**
 * The tool definition's own view of the call (omp `#nativeView`): the call view
 * until a result exists, then the result view (merged hooks) or the call head
 * over both bodies. No hooks, no view, or a throw: undefined (built-in rendering).
 */
function nativeView(c: Component, a: Any, cx: DescribeContext): NativeToolView | undefined {
	const hooks: NativeToolHooks | undefined = a.toolDefinition;
	if (!hooks || (typeof hooks.describeCall !== "function" && typeof hooks.describeResult !== "function")) return undefined;
	const options: NativeDescribeOptions = {
		expanded: a.expanded === true,
		isPartial: a.isPartial === true,
		executionStarted: a.executionStarted === true,
		argsComplete: typeof a.argsComplete === "boolean" ? a.argsComplete : !a.argsPending,
		cols: cx.cols,
		nowMs: Date.now(),
		supports: (kind) => cx.supports(kind as TspKind),
	};
	let stage = "describeCall";
	try {
		const result: Any | undefined = a.result;
		const merged = hooks.mergeCallAndResult === true;
		let resultView: NativeToolView | undefined;
		if (result && typeof hooks.describeResult === "function") {
			stage = "describeResult";
			resultView = asView(hooks.describeResult({ content: Array.isArray(result.content) ? result.content : [], details: result.details, isError: result.isError === true }, options, a.args));
		}
		let callView: NativeToolView | undefined;
		if ((!result || !merged || !resultView) && typeof hooks.describeCall === "function") {
			stage = "describeCall";
			callView = asView(hooks.describeCall(a.args, options));
		}
		if (merged || !callView || !resultView) return resultView ?? callView;
		return mergeViews(c, callView, resultView);
	} catch (error) {
		stats.failures.set(`ToolExecution.${stage}(${String(a.toolName ?? "tool")})`, String(error));
		return undefined;
	}
}

/** Record when execution was first seen started and first seen settled. */
function tickToolClock(c: Component, a: Any): void {
	let clock = toolClocks.get(c);
	if (!clock) {
		if (a.executionStarted !== true) return;
		clock = {};
		toolClocks.set(c, clock);
	}
	if (clock.start === undefined && a.executionStarted === true) clock.start = Date.now();
	if (clock.start !== undefined && clock.end === undefined && a.result && a.isPartial !== true) clock.end = Date.now();
}

function toolTone(a: Any): TspTone | undefined {
	return a.result?.isError ? "error" : a.isPartial ? "pending" : undefined;
}

/** A view's live timer keeps a settled call running (`task` returns while its agents work on). */
function viewStatus(status: TspCardStatus, view: NativeToolView | undefined): TspCardStatus {
	return status === "done" && typeof view?.tool?.age === "number" ? "running" : status;
}

function wholeMs(ms: number): number {
	return Math.max(0, Math.round(ms));
}

/** `age` (live, ms elapsed when sent) or `took` (stopped, total ms); the view's numbers win, its nulls drop the timer. */
function toolTimer(c: Component, a: Any, status: TspCardStatus, view: NativeToolView | undefined): { age?: number; took?: number } {
	const head = view?.tool;
	if (typeof head?.age === "number" && Number.isFinite(head.age)) return { age: wholeMs(head.age) };
	if (typeof head?.took === "number" && Number.isFinite(head.took)) return { took: wholeMs(head.took) };
	const clock = toolClocks.get(c);
	const now = Date.now();
	if (status === "pending" || status === "running") {
		if (head?.age === null || clock?.start === undefined) return {};
		return { age: wholeMs(now - clock.start) };
	}
	if (head?.took === null) return {};
	const duration = a.result?.durationMs;
	if (typeof duration === "number" && Number.isFinite(duration)) return { took: wholeMs(duration) };
	return clock?.start === undefined ? {} : { took: wholeMs((clock.end ?? now) - clock.start) };
}

/** The head verb: the definition's label, else the tool name, first letter capitalised ("Bash", "Task", "IRC"). */
function toolLabel(a: Any, name: string): string {
	const label: unknown = a.toolDefinition?.label;
	const raw = typeof label === "string" && label.trim() ? label.trim() : name;
	return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function toolTargetKind(name: string): NativeToolTargetKind {
	switch (name) {
		case "bash":
		case "powershell":
			return "command";
		case "read":
		case "write":
		case "edit":
		case "ls":
			return "path";
		case "grep":
		case "find":
			return "pattern";
		default:
			return "text";
	}
}

function isViewNode(value: unknown): boolean {
	return value !== null && typeof value === "object" && typeof (value as Any).k === "string";
}

/** The view's body as children (the same array while every entry is a node). */
function viewBody(view: NativeToolView): readonly NativeChild[] {
	const body: unknown = view.body;
	if (!Array.isArray(body) || body.length === 0) return NO_BODY;
	return (body.every(isViewNode) ? body : body.filter(isViewNode)) as unknown as readonly NativeNode[];
}

/** Append `value` styled `style` (spans keep their own style). */
function pushText(out: TspSpan[], value: TspText, style: string): void {
	if (typeof value === "string") {
		if (value) out.push(span(value, style));
		return;
	}
	for (const sp of value) out.push(sp.s === undefined ? { ...sp, s: style } : sp);
}

const BADGE_STYLES: Partial<Record<TspTone, string>> = { error: "error", warning: "warning", success: "success", accent: "accent", info: "accent", user: "accent" };

/** A card head from a view's data head (terminals without `tool`). */
function viewHeadSpans(view: NativeToolView, label: string, took: number | undefined): TspSpan[] {
	const head = view.tool;
	const out: TspSpan[] = [];
	pushText(out, head?.title ?? label, "toolTitle strong");
	if (head?.target !== undefined && head.target.length > 0) {
		out.push(span(" "));
		pushText(out, head.target, "mono muted");
	}
	for (const badge of head?.badges ?? []) out.push(span(" "), span(badge.text, BADGE_STYLES[badge.tone ?? "neutral"] ?? "muted"));
	for (const meta of head?.meta ?? []) {
		out.push(span(" "));
		pushText(out, meta, "dim");
	}
	if (head?.note !== undefined && head.note.length > 0) {
		out.push(span(" "));
		pushText(out, head.note, "muted");
	}
	if (took !== undefined) out.push(span(` ${(took / 1000).toFixed(1)}s`, "dim"));
	return out;
}

/** A view's preview as a card clamp: `tail` becomes a head clamp of that size, `none`/`children` none. */
function cardPreview(preview: TspToolPreview | undefined): { lines: number } | "auto" | undefined {
	if (preview === undefined) return "auto";
	if (preview === "none" || preview === "children") return undefined;
	return "tail" in preview ? { lines: preview.tail } : preview;
}

/** A built-in tool's body plus its result's images (read of a png, screenshots). */
function withImages(body: readonly NativeChild[], a: Any, cx: DescribeContext): readonly NativeChild[] {
	const images = toolResultImages(a, cx);
	return images.length === 0 ? body : [...body, ...images];
}

/** The data-first `tool` node (omp `#describeTool`): head data, status and timer as props, the body as children. */
function describeToolNode(c: Component, a: Any, cx: DescribeContext, view: NativeToolView | undefined): NativeNode {
	const name = String(a.toolName ?? "tool");
	const head = view?.tool;
	const status = viewStatus(toolStatus(a), view);
	const timer = toolTimer(c, a, status, view);
	let body: readonly NativeChild[];
	let target: TspText | undefined;
	let targetKind: NativeToolTargetKind | undefined;
	let lang: string | undefined;
	let command: string | undefined;
	let preview: TspToolPreview;
	if (view) {
		body = viewBody(view);
		target = head?.target;
		targetKind = head?.targetKind;
		preview = view.preview ?? (view.inline ? "none" : { lines: TOOL_PREVIEW_LINES });
	} else {
		body = withImages(toolBody(a, cx, true), a, cx);
		target = toolTarget(name, a.args);
		targetKind = target === undefined ? undefined : toolTargetKind(name);
		const shell = name === "bash" || name === "powershell";
		if (shell) {
			lang = name;
			if (typeof a.args?.command === "string") command = a.args.command;
		}
		// Shell output reads from its end; everything else from its start.
		preview = shell ? { tail: TOOL_PREVIEW_LINES } : { lines: TOOL_PREVIEW_LINES };
	}
	const hasBody = body.length > 0;
	return node(
		"tool",
		{
			role: `omp.tool.${name}`,
			name,
			// `title` here is the head verb (TspToolProps), not the common tooltip.
			title: (head?.title ?? toolLabel(a, name)) as string,
			target: target !== undefined && target.length > 0 ? target : undefined,
			targetKind,
			lang,
			command,
			meta: head?.meta && head.meta.length > 0 ? head.meta : undefined,
			badges: head?.badges && head.badges.length > 0 ? head.badges : undefined,
			note: head?.note,
			status,
			age: timer.age,
			took: timer.took,
			frame: view?.inline === true ? "inline" : "card",
			collapsible: hasBody,
			collapsed: hasBody ? view?.open !== true && a.expanded !== true : undefined,
			preview: hasBody ? preview : undefined,
			tone: view?.tone ?? toolTone(a),
		},
		body,
	);
}

/** A view as the classic card (terminals without `tool`). */
function describeViewCard(c: Component, a: Any, view: NativeToolView): NativeNode {
	const name = String(a.toolName ?? "tool");
	const status = viewStatus(toolStatus(a), view);
	const body = viewBody(view);
	return card(
		{
			role: `omp.tool.${name}`,
			head: viewHeadSpans(view, toolLabel(a, name), toolTimer(c, a, status, view).took),
			status,
			collapsible: body.length > 0,
			collapsed: view.open !== true && a.expanded !== true,
			preview: a.expanded ? undefined : cardPreview(view.preview),
			tone: view.tone ?? toolTone(a),
		},
		body,
	);
}

const toolExecution: Describer = {
	name: "ToolExecution",
	matches: (c) => is(c, ToolExecutionComponent, "ToolExecutionComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		tickToolClock(c, a);
		// The hook view is asked once per describe; `build` reuses it. Hooks memoize it: a new object means a change.
		const view = nativeView(c, a, cx);
		toolViews.set(c, view);
		return [a.toolName, a.args, JSON.stringify(a.args ?? null).length, a.result, textOutput(a.result).length, a.isPartial, a.expanded, a.executionStarted, a.hideComponent, a.argsPending, cx.supports("tool"), view];
	},
	build: (c, cx) => {
		const a = c as Any;
		if (a.argsPending) a.updateDisplay?.();
		if (a.hideComponent) return EMPTY_NODE;
		const view = toolViews.has(c) ? toolViews.get(c) : nativeView(c, a, cx);
		if (cx.supports("tool")) return describeToolNode(c, a, cx, view);
		if (view) return describeViewCard(c, a, view);
		const name: string = a.toolName ?? "tool";
		const target = toolTarget(name, a.args);
		const head: TspSpan[] = [span(name, "toolTitle strong")];
		if (target) head.push(span(" "), span(target, "mono muted"));
		if (a.result?.durationMs !== undefined && !a.isPartial) head.push(span(` ${(a.result.durationMs / 1000).toFixed(1)}s`, "dim"));
		const body = withImages(toolBody(a, cx), a, cx);
		return card(
			{
				role: `omp.tool.${name}`,
				head,
				status: toolStatus(a),
				collapsible: body.length > 0,
				collapsed: a.expanded !== true,
				preview: a.expanded ? undefined : "auto",
				tone: toolTone(a),
			},
			body,
		);
	},
	handleEvent: (c, event) => {
		// The card's or tool's own fold is pi's expand state; nested folds (agent rows in a body) stay terminal-local.
		if (event.type === "toggle" && event.key === "") (c as Any).setExpanded?.(!event.collapsed);
	},
};

// ── Editor ──────────────────────────────────────────────────────────────

/** The untitled composer's placeholder: plain text in the terminal's own quiet, upright ink (omp's is a string too). */
const EDITOR_PLACEHOLDER = "Ask anything, edit files, run tools";

function editorText(a: Any): { text: string; cursor: number } {
	const lines: string[] = a.state?.lines ?? [""];
	const cursorLine: number = a.state?.cursorLine ?? 0;
	const cursorCol: number = a.state?.cursorCol ?? 0;
	let offset = 0;
	for (let i = 0; i < cursorLine; i++) offset += (lines[i]?.length ?? 0) + 1;
	return { text: lines.join("\n"), cursor: offset + cursorCol };
}

/** A `!` draft's sigil with its blanks (`!`, `!!`); natively the bash mode chip stands in for it (omp's SHELL_SIGIL_RE). */
const BASH_SIGIL_RE = /^\s*!!?[ \t]?/;

/** pi's prompt editor (a CustomEditor: app action handlers); other editors (dialog fields) stay plain `omp.field`s. */
function isPromptEditor(c: Component): boolean {
	return (c as Any).actionHandlers instanceof Map;
}

/** The terminal draws omp's composer around the editor node (else the plain `omp.field` column). */
function composerSupported(cx: DescribeContext): boolean {
	return cx.supports("editor") && cx.supports("row") && cx.supports("col") && cx.supports("text");
}

function isFooterComponent(c: Any): boolean {
	return typeof c.render === "function" && is(c as Component, FooterComponent, "FooterComponent");
}

/** What the composer shows besides the draft, gathered by the editor's fingerprint and reused by its build. */
interface ComposerFrame {
	readonly footer: Any | undefined;
	readonly facts: ComposerFacts | undefined;
	readonly chips: readonly NativeNode[];
	readonly keys: ComposerKeys;
	readonly running: boolean;
}

function editorRunning(a: Any, footer: Any | undefined): boolean {
	if (a.workingStatusIndicator !== undefined && a.workingStatusIndicator !== null) return true;
	try {
		return sessionRunning(footer);
	} catch {
		return false;
	}
}

function composerFrame(c: Component, a: Any, cx: DescribeContext): ComposerFrame {
	let footer: Any | undefined;
	let facts: ComposerFacts | undefined;
	try {
		footer = findFooter(a.tui, isFooterComponent);
		facts = footer ? composerFacts(footer) : undefined;
	} catch (error) {
		// No facts this frame: the bar keeps send/stop and the footer its own line.
		stats.failures.set("Composer.facts", String(error));
		facts = undefined;
	}
	if (footer && facts) noteFactsCarried(footer);
	const frame: ComposerFrame = { footer, facts, chips: composerChips(c, cx), keys: composerKeys(a), running: editorRunning(a, footer) };
	composerFrames.set(c, frame);
	return frame;
}

/**
 * The editor's container (pi's editorContainer, the editor alone in it): its
 * working indicator moves out of the composer, over it. Called from the
 * container's fingerprint, before the editor is described in the same frame.
 */
function hoistIndicator(children: readonly Component[], cx: DescribeContext): Component | undefined {
	if (children.length !== 1) return undefined;
	const child = children[0]!;
	if (describerFor(child) !== editor) return undefined;
	const indicator: Any | undefined = (child as Any).workingStatusIndicator;
	if (indicator && typeof indicator.render === "function" && isPromptEditor(child) && typeof (child as Any).describe !== "function" && !broken.has(child) && composerSupported(cx)) {
		hoistedIndicators.set(child, indicator as unknown as Component);
		return indicator as unknown as Component;
	}
	hoistedIndicators.delete(child);
	return undefined;
}

/** The working row inside the editor's own description (no container moved it out). */
function workingRow(indicator: Any): NativeNode {
	if (indicator.intervalId) {
		indicator.stop?.();
		stoppedLoaders.add(indicator as Loader);
	}
	const label: TspSpan[] = [span(String(indicator.message ?? ""), "muted")];
	return row(
		(indicator.frames?.length ?? 0) > 0 ? [node("spinner", { style: "dots", tone: "accent", label })] : [text(label)],
		{ role: "omp.working", align: "center", gap: "sm" },
		"working",
	);
}

/** The draft's decorations: a `!` draft hides its sigil (the mode chip shows it), else the editor's own (magic keywords). */
function editorDecor(c: Component, value: string, bash: boolean): readonly TspEditorDecoration[] | undefined {
	if (bash) {
		const sigil = BASH_SIGIL_RE.exec(value)?.[0].length ?? 0;
		return sigil > 0 ? [{ from: 0, to: sigil, s: "hide" }] : undefined;
	}
	const hooks = c as EditorNativeHooks;
	if (typeof hooks.describeDecorations !== "function") return undefined;
	const d = hooks.describeDecorations(value);
	return d && d.length > 0 ? d : undefined;
}

/** Submit the draft as Enter does (pi-tui's `submitValue`: paste markers expanded, the draft cleared, `onSubmit`). */
function submitDraft(a: Any): void {
	if (a.disableSubmit) return;
	const { text: value } = editorText(a);
	if (!value.trim()) return;
	if (typeof a.submitValue === "function") {
		a.submitValue();
		return;
	}
	// No submitValue (a foreign editor): what it does, by hand.
	a.cancelAutocomplete?.();
	a.state.lines = [""];
	a.state.cursorLine = 0;
	a.state.cursorCol = 0;
	a.exitHistoryBrowsing?.();
	a.lastAction = null;
	a.onChange?.("");
	a.onSubmit?.(value.trim());
}

/**
 * A TSP `send` (rsttyd's `TspEditing.send`: a prompt submitted programmatically, never a key; rsttyd passes Enter to
 * the pty, so Enter with the autocomplete open stays pi-tui's own) is its own prompt, as omp's CustomEditor takes it:
 * a different draft gives way to `text` (kept in history for recall when it holds no pasted blocks), then the
 * prompt goes out the way Enter sends it ({@link submitDraft}): the draft cleared, the autocomplete closed,
 * history browsing left and the undo stack reset before `onSubmit`, so the composer describes empty again.
 */
function sendPrompt(a: Any, text: string): void {
	const value = text.trim();
	if (!value || a.disableSubmit) return;
	const { text: draft } = editorText(a);
	if (draft.trim() !== value) {
		if (draft.trim() && !(a.pastes instanceof Map && a.pastes.size > 0)) a.addToHistory?.(draft);
		if (typeof a.setText === "function") a.setText(text);
		else {
			a.state.lines = text.replace(/\r\n?/g, "\n").split("\n");
			a.state.cursorLine = a.state.lines.length - 1;
			a.state.cursorCol = a.state.lines[a.state.cursorLine].length;
		}
	}
	submitDraft(a);
}

/** The keypath of the `editor` node in each editor's last native build (its caret anchor). */
const caretPaths = new WeakMap<Component, string>();
/**
 * The list each editor's overlay last showed in `layer` (set by {@link editorAutocompleteOverlay} before the frame is
 * described). Pi-tui makes a new list per suggestion request, so a stale entry never matches the open one; a mounted
 * editor's open list is put into `layer` every frame.
 */
const layeredLists = new WeakMap<Component, Component>();
/** The list each editor shows under its input line this frame (no session put it into `layer`). */
const inlineLists = new WeakMap<Component, Component>();

/** pi-tui's open autocomplete list (`autocompleteState` + `autocompleteList`), unless it has no item to show (omp's `#visibleAutocompleteList`). */
function openAutocomplete(a: Any): Component | undefined {
	const list: Any | undefined = a.autocompleteList;
	if (!a.autocompleteState || !list || typeof list.render !== "function") return undefined;
	try {
		return typeof list.getSelectedItem !== "function" || list.getSelectedItem() ? (list as Component) : undefined;
	} catch {
		return undefined;
	}
}

/** Lines omp's caret menu shows (its default `autocompleteMaxVisible`). */
const AUTOCOMPLETE_LINES = 10;

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Hand the list what its items are drawn with: the typed prefix their labels are marked with (`nativeMark`) and their icons (`nativeIcon`), read by the SelectList describer. */
function markAutocomplete(a: Any, list: Component): void {
	const l = list as Any;
	let label = "";
	try {
		label = String(l.getSelectedItem?.()?.label ?? "");
	} catch {
		label = "";
	}
	const prefix = String(a.autocompletePrefix ?? "");
	l.nativeMark = autocompleteMark(prefix, label);
	// pi's command-name list: `/name` (a path completion's prefix holds another `/`; an argument's, none).
	const commands = /^\/[^/\s]*$/.test(prefix) && a.autocompleteState !== "force";
	l.nativeIcon = autocompleteIcons(prefix, a.autocompleteState, commands);
	// omp's caret menu caps at its 10 visible lines (rsttyd counts them in 22px for its 32px rows); pi's default is 5.
	l.nativeMaxLines = Math.max(AUTOCOMPLETE_LINES, finiteNumber(a.autocompleteMaxVisible));
}

/** How deep below a dock component, and through how wide containers, the editor is looked for (pi's editorContainer holds it). */
const EDITOR_DEPTH = 3;
const EDITOR_WIDTH = 16;

/**
 * The open autocomplete of the editor mounted in `dock` (the components pi
 * mounted under the transcript), as omp's caret menu for the `layer` region:
 * an `overlay` (role `omp.autocomplete`, key `complete`) anchored at the
 * editor node's wire id, around pi-tui's SelectList (its own describe
 * boundary; a click applies the completion through its onSelect). Null while
 * no natively described editor shows one. Call once per frame, before the
 * frame is described: the editor then leaves the list out of its composer.
 */
export function editorAutocompleteOverlay(dock: readonly unknown[]): NativeNode | null {
	const queue: { component: Component; depth: number }[] = [];
	for (const child of dock) if (child && typeof (child as Component).render === "function") queue.push({ component: child as Component, depth: 1 });
	for (let i = 0; i < queue.length; i++) {
		const { component, depth } = queue[i]!;
		const a = component as Any;
		if (describerFor(component) === editor) {
			const path = caretPaths.get(component);
			if (path === undefined || broken.has(component) || typeof a.describe === "function") continue;
			const list = openAutocomplete(a);
			if (!list) continue;
			markAutocomplete(a, list);
			layeredLists.set(component, list);
			return autocompleteOverlay(component, list, `${nativeComponentId(component)}.${path}`);
		}
		const kids: unknown = a.children;
		if (depth >= EDITOR_DEPTH || !Array.isArray(kids) || kids.length > EDITOR_WIDTH) continue;
		for (const kid of kids) if (kid && typeof kid.render === "function") queue.push({ component: kid as Component, depth: depth + 1 });
	}
	return null;
}

const editor: Describer = {
	name: "Editor",
	matches: (c) => is(c, Editor, "Editor"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const { text, cursor } = editorText(a);
		const hooks = c as EditorNativeHooks;
		if (hooks.nativeMode !== undefined || typeof hooks.describeDecorations === "function") {
			if (hooks.nativeMode !== true) {
				hooks.nativeMode = true;
				nativeEditors.add(c);
			}
		}
		const indicator: Any | undefined = a.workingStatusIndicator;
		// The open list is a component of its own (pi-tui's SelectList describes itself); in `layer` when the session
		// put it there this frame, else under the input line.
		const list = openAutocomplete(a);
		const layered = list !== undefined && layeredLists.get(c) === list;
		const inline = layered ? undefined : list;
		if (inline) {
			markAutocomplete(a, inline);
			inlineLists.set(c, inline);
		} else inlineLists.delete(c);
		const fp: unknown[] = [
			text,
			cursor,
			a.focused,
			a.disableSubmit,
			inline,
			indicator,
			indicator?.message,
			indicator?.frames?.length,
			a.borderColor,
			cx.cols,
		];
		if (!isPromptEditor(c)) return fp;
		if (!composerSupported(cx)) {
			composerFrames.delete(c);
			hostComposer(a, false);
			return fp;
		}
		hostComposer(a, true);
		const frame = composerFrame(c, a, cx);
		fp.push(frame.facts, frame.chips, frame.keys, frame.running, indicator !== undefined && hoistedIndicators.get(c) === indicator);
		return fp;
	},
	build: (c, cx) => {
		const a = c as Any;
		const { text: value, cursor } = editorText(a);
		const frame = composerFrames.get(c);
		const bash = frame !== undefined && value.trimStart().startsWith("!");
		const indicator: Any | undefined = a.workingStatusIndicator;
		const working = indicator && !(frame && hoistedIndicators.get(c) === indicator) ? workingRow(indicator) : undefined;
		const name = frame?.facts?.sessionName;
		const input = node(
			"editor",
			{
				text: value,
				cursor,
				placeholder: value === "" ? (name ? sessionPlaceholder(name) : EDITOR_PLACEHOLDER) : undefined,
				decor: editorDecor(c, value, bash),
				sendable: a.disableSubmit !== true,
				maxLines: 12,
				lang: bash ? "bash" : undefined,
			},
			undefined,
			"input",
		);
		const inline = inlineLists.get(c);
		const complete = inline ? autocompleteInline(c, inline) : undefined;
		caretPaths.set(c, frame ? COMPOSER_CARET : FIELD_CARET);
		if (!frame) return col(compact<NativeChild>([working, input, complete]), { role: "omp.field" });
		return describeComposer(
			c,
			{
				input,
				shell: bash ? { excluded: value.trimStart().startsWith("!!") } : undefined,
				working,
				complete,
				chips: frame.chips,
				facts: frame.facts,
				running: frame.running,
				sendable: a.disableSubmit !== true,
				keys: frame.keys,
			},
			cx,
		);
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		switch (event.type) {
			case "edit": {
				applyHostEdit(a, event);
				return;
			}
			case "undo":
				a.undo?.();
				return;
			case "send":
				sendPrompt(a, event.text);
				return;
			case "action": {
				// The composer's controls (omp's action names); chips and unknown actions are ignored.
				if (event.act === "submit") {
					submitDraft(a);
					return;
				}
				const footer = composerFrames.get(c)?.footer;
				runComposerAction(a, event.act, editorRunning(a, footer), event.value, footer);
				return;
			}
		}
	},
};

/** Apply a terminal-side edit over pi's editor state (UTF-16 offsets; stale when `len` mismatches). */
function applyHostEdit(a: Any, edit: { from: number; to: number; text: string; cursor: number; len: number }): void {
	const { text: current } = editorText(a);
	if (edit.len !== current.length) return;
	const clamp = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), 0), current.length) : 0);
	let from = clamp(edit.from);
	let to = clamp(edit.to);
	if (to < from) [from, to] = [to, from];
	const insert = (edit.text ?? "").replace(/\r\n?/g, "\n");
	const next = current.slice(0, from) + insert + current.slice(to);
	const changed = from !== to || insert !== "";
	if (changed) {
		a.exitHistoryBrowsing?.();
		a.pushUndoSnapshot?.();
		a.state.lines = next.split("\n");
		a.lastAction = null;
	}
	const cursor = Math.min(Math.max(0, Math.trunc(edit.cursor)), next.length);
	const lines: string[] = a.state.lines;
	const beforeLine: unknown = a.state.cursorLine;
	const beforeCol: unknown = a.state.cursorCol;
	let line = 0;
	let colOffset = cursor;
	while (line < lines.length - 1 && colOffset > lines[line]!.length) colOffset -= lines[line++]!.length + 1;
	a.state.cursorLine = line;
	a.state.cursorCol = Math.min(colOffset, lines[line]!.length);
	a.preferredVisualCol = null;
	if (!changed) {
		// The caret alone moved (a click in the draft): an open list follows it as on pi-tui's arrow keys (re-queried
		// at the new position, closed when nothing matches there), and none opens.
		if ((a.state.cursorLine !== beforeLine || a.state.cursorCol !== beforeCol) && a.autocompleteState) {
			try {
				if (typeof a.updateAutocomplete === "function") a.updateAutocomplete();
				else a.cancelAutocomplete?.();
			} catch {
				// A provider's failure must not break the caret move.
			}
		}
		return;
	}
	a.onChange?.(next);
	retriggerAutocomplete(a);
}

/**
 * After a terminal-side edit, keep the autocomplete as typing would (omp's
 * `#retriggerAutocompleteAtCursor`): an open list refreshes for the new text,
 * else a `/` command, or a trigger character's token (`@`, `^`; pi-tui's
 * own trigger pattern), before the caret opens one.
 */
function retriggerAutocomplete(a: Any): void {
	try {
		if (a.autocompleteState) {
			a.updateAutocomplete?.();
			return;
		}
		const before = String(a.state.lines[a.state.cursorLine] ?? "").slice(0, a.state.cursorCol);
		const slash = typeof a.isInSlashCommandContext === "function" && a.isInSlashCommandContext(before) === true;
		const pattern: unknown = a.autocompleteTriggerPattern;
		if (slash || (pattern instanceof RegExp && pattern.test(before))) a.tryTriggerAutocomplete?.();
	} catch {
		// the next keystroke triggers it
	}
}

/** Most specific first: startup/transcript blocks, then the transcript's blocks (Flow's describers), sheets, pi-tui primitives, then the fallbacks. */
const DESCRIBERS: readonly Describer[] = [
	...BLOCK_DESCRIBERS,
	...TRANSCRIPT_DESCRIBERS,
	...PICKER_DESCRIBERS,
	...PREFS_DESCRIBERS,
	...SHEET_DESCRIBERS,
	...TUI_DESCRIBERS,
	userMessage,
	assistantMessage,
	toolExecution,
	footer,
	editor,
	loader,
	idleStatus,
	plainText,
	markdown,
	spacerDescriber,
	border,
	mouseRegion,
	container,
];

const matchCache = new WeakMap<Component, Describer | null>();

export function describerFor(component: Component): Describer | null {
	let found = matchCache.get(component);
	if (found !== undefined) return found;
	found = null;
	for (const d of DESCRIBERS) {
		if (d.matches(component)) {
			found = d;
			break;
		}
	}
	matchCache.set(component, found);
	return found;
}

/**
 * Describe `component`: its own `describe()` wins, then the registry. `null`
 * means rows. The memo returns the same node while the fingerprint is equal.
 */
export function describeComponent(component: Component, cx: DescribeContext): NativeNode | null {
	if (broken.has(component)) return null;
	const own = (component as Any).describe;
	if (typeof own === "function" && !is(component, Container, "Container")) {
		try {
			const result = own.call(component, cx);
			if (result) return result as NativeNode;
		} catch (error) {
			broken.add(component);
			stats.failures.set(`${component.constructor.name}.describe`, String(error));
			return null;
		}
	}
	const by = describerFor(component);
	if (!by) {
		bump(stats.rows, component.constructor.name);
		return null;
	}
	try {
		if (failDescriber && by.name === failDescriber) throw new Error(`forced failure (PI_TSP_FAIL_DESCRIBER=${failDescriber})`);
		const fp = by.fingerprint(component, cx);
		const cached = memo.get(component);
		if (cached && cached.by === by && sameFingerprint(cached.fp, fp)) {
			if (cached.node) bump(stats.native, by.name);
			else bump(stats.rows, by.name);
			return cached.node;
		}
		const built = by.build(component, cx);
		memo.set(component, { by, fp, node: built });
		if (built) bump(stats.native, by.name);
		else bump(stats.rows, by.name);
		return built;
	} catch (error) {
		broken.add(component);
		stats.failures.set(by.name, String(error));
		bump(stats.rows, by.name);
		// The editor goes to rows: the composer no longer hosts its chips.
		if (by === editor && isPromptEditor(component)) {
			composerFrames.delete(component);
			hostComposer(component as Any, false);
		}
		return null;
	}
}

/** Route a terminal event to the component's own handler, else its describer's. */
export function dispatchEvent(component: Component, event: NativeUiEvent, cx: DescribeContext): boolean {
	const own = (component as Any).handleNativeEvent;
	if (typeof own === "function") {
		own.call(component, event);
		return true;
	}
	const by = describerFor(component);
	if (!by?.handleEvent) return false;
	by.handleEvent(component, event, cx);
	return true;
}

/** Leaving native rendering: give pi's animations back their timers and clear per-frame stats. */
export function releaseNativeSideEffects(): void {
	for (const l of stoppedLoaders) {
		try {
			(l as Any).start?.();
		} catch {
			// ignore
		}
	}
	stoppedLoaders.clear();
	for (const e of nativeEditors) (e as EditorNativeHooks).nativeMode = false;
	nativeEditors.clear();
	releaseComposer();
	releaseBlockSideEffects();
}

export function resetStats(): void {
	stats.native.clear();
	stats.rows.clear();
}

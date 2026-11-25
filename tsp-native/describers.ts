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
import { composerGhost } from "../shared/composer-slots.ts";
import { hasStyle, lineToSpans, spansThemeId } from "./spans.ts";
import { TRANSCRIPT_DESCRIBERS } from "./transcript.ts";
import { BLOCK_DESCRIBERS, releaseBlockSideEffects, toolResultImages } from "./describe-blocks.ts";
import { PICKER_DESCRIBERS } from "./describe-pickers.ts";
import { PREFS_DESCRIBERS } from "./describe-prefs.ts";
import { SHEET_DESCRIBERS } from "./describe-sheets.ts";
import { TUI_DESCRIBERS } from "./describe-tui.ts";
import type { TspCardStatus, TspEditorDecoration, TspKind, TspSpan, TspText, TspTone, TspToolPreview } from "./wire.ts";

type Any = Record<string, any>;

export interface Describer {
	readonly name: string;
	matches(component: Component): boolean;
	fingerprint(component: Component, cx: DescribeContext): readonly unknown[];
	build(component: Component, cx: DescribeContext): NativeNode | null;
	handleEvent?(component: Component, event: NativeUiEvent, cx: DescribeContext): void;
}

export interface DescriberStats {
	native: Map<string, number>;
	rows: Map<string, number>;
	failures: Map<string, string>;
}

export interface EditorNativeHooks {
	/**
	 * Decoration offsets count UTF-16 code units in the newline-joined draft.
	 */
	describeDecorations?(text: string): readonly TspEditorDecoration[];
	nativeMode?: boolean;
}

const memo = new WeakMap<Component, { by: Describer; fp: readonly unknown[]; node: NativeNode | null }>();
const broken = new WeakSet<Component>();
const stoppedLoaders = new Set<Loader>();
const nativeEditors = new Set<Component>();
const composerFrames = new WeakMap<Component, ComposerFrame>();
const hoistedIndicators = new WeakMap<Component, Component>();
const carriedFooters = new WeakSet<Component>();
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

const DISPLAY_DIFF_LINE = /^([+\- ])(\s*\d+)(?: (.*))?$/s;

/**
 * pi numbers added diff rows on the new side and the other rows on the old side.
 */
function displayDiffHunks(display: string): { oldStart: number; newStart: number; lines: string[] }[] | undefined {
	const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
	let lines: string[] = [];
	let changed = false;
	let oldStart = 1;
	let newStart = 1;
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
			// pi omits only unchanged lines between diff regions.
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
		// The terminal animates this spinner without pi's repaint timer.
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
		// pi normally rebuilds stale text during render.
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
	const lines = safeRender(c, 400).map(plain);
	const left: string[] = [];
	const right: string[] = [];
	const pwd = (lines[0] ?? "").trim();
	if (pwd) left.push(pwd);
	const stats = lines[1] ?? "";
	// pi separates the footer stats from the model with at least two spaces.
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

function toolStatus(a: Any): TspCardStatus {
	if (a.isPartial) return a.executionStarted ? "running" : "pending";
	if (a.result?.isError) return "error";
	return "done";
}

const NO_PATHS: readonly string[] = [];
const HASHLINE_HEADER_RE = /^\[(.+?)(?:#[0-9A-Fa-f]{4})?\]$/;

function hashlineEditPaths(args: Any): readonly string[] {
	const input: unknown = args?.input;
	if (typeof input !== "string" || input.length === 0) return NO_PATHS;
	const paths: string[] = [];
	for (const row of input.split("\n")) {
		if (!row.startsWith("[")) continue;
		const path = HASHLINE_HEADER_RE.exec(row.trimEnd())?.[1]?.trim();
		if (path && !path.startsWith("***") && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

function hashlineReadView(result: Any | undefined, output: string): { text: string | undefined; start: number; notice: string } | undefined {
	const mark: unknown = result?.details?.hashline;
	if (result?.isError || mark === null || typeof mark !== "object") return undefined;
	const first: unknown = (mark as Any).firstLine;
	const last: unknown = (mark as Any).lastLine;
	if (typeof first !== "number" || typeof last !== "number" || !Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first - 1) return undefined;
	const lines = output.split("\n");
	if (!/^\[.+#[0-9A-F]{4}\]$/.test(lines[0] ?? "")) return undefined;
	const count = last - first + 1;
	if (lines.length < 1 + count) return undefined;
	const rows: string[] = [];
	for (let i = 0; i < count; i++) {
		const prefix = `${first + i}:`;
		const row = lines[1 + i];
		if (!row.startsWith(prefix)) return undefined;
		rows.push(row.slice(prefix.length));
	}
	return { text: count > 0 ? rows.join("\n") : undefined, start: first, notice: lines.slice(1 + count).join("\n").trim() };
}

function toolTarget(name: string, args: Any): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	switch (name) {
		case "bash":
		case "powershell":
			return typeof args.command === "string" ? firstLine(args.command) : undefined;
		case "read":
		case "write":
		case "ls":
			return typeof args.path === "string" ? args.path : undefined;
		case "edit": {
			if (typeof args.path === "string") return args.path;
			const paths = hashlineEditPaths(args);
			return paths.length === 0 ? undefined : paths.length === 1 ? paths[0] : `${paths.length} files`;
		}
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
	// The terminal applies the preview limit to the entire `tool` body.
	const preview = expanded || tool ? undefined : ({ lines: previewLines(output) } as const);
	// pi includes the call line in its grep, find and ls renders.
	if (tool && (name === "grep" || name === "find" || name === "ls")) {
		if (output) out.push(code(plain(output), { role: `omp.tool.${name}.output` }, "out"));
		return out;
	}
	switch (name) {
		case "bash":
		case "powershell": {
			if (typeof args.command === "string" && (!tool || args.command.trim().includes("\n"))) out.push(code(args.command, { lang: name === "bash" ? "bash" : "powershell", role: "omp.tool.bash.command" }, "cmd"));
			if (output) out.push(ansi(output, { follow: a.isPartial === true, preview, role: "omp.tool.bash.output" }, "out"));
			return out;
		}
		case "edit": {
			const sections = typeof args.path === "string" ? NO_PATHS : hashlineEditPaths(args);
			const path = typeof args.path === "string" ? args.path : sections.length === 1 ? sections[0] : undefined;
			const patch: unknown = result?.details?.patch;
			if (typeof patch === "string" && /^@@ /m.test(patch)) {
				out.push(diff(patch, { path, role: "omp.tool.edit.diff" }, "diff"));
				return out;
			}
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
			const anchored = hashlineReadView(result, output);
			if (anchored) {
				if (anchored.text !== undefined) out.push(code(anchored.text, { path: typeof args.path === "string" ? args.path : undefined, start: anchored.start, numbers: true, preview: preview && { lines: previewLines(anchored.text) }, role: "omp.tool.read" }, "out"));
				if (anchored.notice) out.push(text([span(anchored.notice, "muted")], { role: "omp.tool.read.notice" }, "note"));
				return out;
			}
			if (output) out.push(code(output, { path: typeof args.path === "string" ? args.path : undefined, start: typeof args.offset === "number" ? args.offset : undefined, preview, role: "omp.tool.read" }, "out"));
			return out;
		}
		default: {
			const shell: Component | undefined = a.toolDefinition?.renderShell === "self" ? a.selfRenderContainer : a.contentBox;
			if (a.toolDefinition && shell && (a.toolDefinition.renderResult || a.toolDefinition.renderCall)) {
				const lines = safeRender(shell, cx.cols);
				if (lines.length > 0) out.push(rowsNode(lines, cx.cols, "rows"));
				return out;
			}
			if (output) out.push(code(output, { preview, role: "omp.tool.output" }, "out"));
			// Wait until execution to avoid resending the full JSON on each argument delta.
			if ((a.executionStarted === true || result !== undefined) && args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length > 0) {
				out.push(node("section", { head: [span("Args", "muted")], collapsible: true, collapsed: true }, [code(JSON.stringify(args, null, 2), { lang: "json" }, "json")], "args"));
			}
			return out;
		}
	}
}

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
	nowMs: number;
	supports(kind: string): boolean;
}

export type NativeToolTargetKind = "command" | "path" | "pattern" | "query" | "text";

export interface NativeToolView {
	tool?: {
		title?: TspText;
		target?: TspText;
		targetKind?: NativeToolTargetKind;
		meta?: readonly TspText[];
		badges?: readonly { text: string; tone?: TspTone; title?: string }[];
		note?: TspText;
		/**
		 * Use elapsed milliseconds for a live timer or `null` to disable it.
		 */
		age?: number | null;
		/**
		 * Use total milliseconds for a stopped timer or `null` to disable it.
		 */
		took?: number | null;
	};
	body?: readonly NativeViewNode[];
	tone?: TspTone;
	preview?: TspToolPreview;
	open?: boolean;
	inline?: boolean;
}

/**
 * Reuse the same view object until its rendered content changes.
 */
export interface NativeToolHooks {
	describeCall?(args: unknown, options: NativeDescribeOptions): NativeToolView | undefined;
	describeResult?(result: { content: unknown[]; details: unknown; isError: boolean }, options: NativeDescribeOptions, args: unknown): NativeToolView | undefined;
	mergeCallAndResult?: boolean;
}

const TOOL_PREVIEW_LINES = 10;
const NO_BODY: readonly NativeChild[] = [];

const toolViews = new WeakMap<Component, NativeToolView | undefined>();
const mergedViews = new WeakMap<Component, { call: NativeToolView; result: NativeToolView; view: NativeToolView }>();
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

function nativeView(c: Component, a: Any, cx: DescribeContext): NativeToolView | undefined {
	// pi preserves custom properties on the registered tool definition.
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

/**
 * A tool can return before the work tracked by its timer finishes.
 */
function viewStatus(status: TspCardStatus, view: NativeToolView | undefined): TspCardStatus {
	return status === "done" && typeof view?.tool?.age === "number" ? "running" : status;
}

function wholeMs(ms: number): number {
	return Math.max(0, Math.round(ms));
}

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

function toolLabel(a: Any, name: string): string {
	const label: unknown = a.toolDefinition?.label;
	const raw = typeof label === "string" && label.trim() ? label.trim() : name;
	return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function toolTargetKind(name: string, args?: Any): NativeToolTargetKind {
	switch (name) {
		case "bash":
		case "powershell":
			return "command";
		case "edit":
			return args && typeof args.path !== "string" && hashlineEditPaths(args).length > 1 ? "text" : "path";
		case "read":
		case "write":
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

function viewBody(view: NativeToolView): readonly NativeChild[] {
	const body: unknown = view.body;
	if (!Array.isArray(body) || body.length === 0) return NO_BODY;
	return (body.every(isViewNode) ? body : body.filter(isViewNode)) as unknown as readonly NativeNode[];
}

function pushText(out: TspSpan[], value: TspText, style: string): void {
	if (typeof value === "string") {
		if (value) out.push(span(value, style));
		return;
	}
	for (const sp of value) out.push(sp.s === undefined ? { ...sp, s: style } : sp);
}

const BADGE_STYLES: Partial<Record<TspTone, string>> = { error: "error", warning: "warning", success: "success", accent: "accent", info: "accent", user: "accent" };

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

function cardPreview(preview: TspToolPreview | undefined): { lines: number } | "auto" | undefined {
	if (preview === undefined) return "auto";
	if (preview === "none" || preview === "children") return undefined;
	return "tail" in preview ? { lines: preview.tail } : preview;
}

function withImages(body: readonly NativeChild[], a: Any, cx: DescribeContext): readonly NativeChild[] {
	const images = toolResultImages(a, cx);
	return images.length === 0 ? body : [...body, ...images];
}

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
		targetKind = target === undefined ? undefined : toolTargetKind(name, a.args);
		const shell = name === "bash" || name === "powershell";
		if (shell) {
			lang = name;
			if (typeof a.args?.command === "string") command = a.args.command;
		}
		preview = shell ? { tail: TOOL_PREVIEW_LINES } : { lines: TOOL_PREVIEW_LINES };
	}
	const hasBody = body.length > 0;
	return node(
		"tool",
		{
			role: `omp.tool.${name}`,
			name,
			// The terminal uses a tool's `title` as its heading verb.
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
		if (event.type === "toggle" && event.key === "") (c as Any).setExpanded?.(!event.collapsed);
	},
};

const EDITOR_PLACEHOLDER = "Ask anything, edit files, run tools";

function editorText(a: Any): { text: string; cursor: number } {
	const lines: string[] = a.state?.lines ?? [""];
	const cursorLine: number = a.state?.cursorLine ?? 0;
	const cursorCol: number = a.state?.cursorCol ?? 0;
	let offset = 0;
	for (let i = 0; i < cursorLine; i++) offset += (lines[i]?.length ?? 0) + 1;
	return { text: lines.join("\n"), cursor: offset + cursorCol };
}

const BASH_SIGIL_RE = /^\s*!!?[ \t]?/;

function isPromptEditor(c: Component): boolean {
	return (c as Any).actionHandlers instanceof Map;
}

function composerSupported(cx: DescribeContext): boolean {
	return cx.supports("editor") && cx.supports("row") && cx.supports("col") && cx.supports("text");
}

function isFooterComponent(c: Any): boolean {
	return typeof c.render === "function" && is(c as Component, FooterComponent, "FooterComponent");
}

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
		stats.failures.set("Composer.facts", String(error));
		facts = undefined;
	}
	if (footer && facts) noteFactsCarried(footer);
	const frame: ComposerFrame = { footer, facts, chips: composerChips(c, cx), keys: composerKeys(a), running: editorRunning(a, footer) };
	composerFrames.set(c, frame);
	return frame;
}

/**
 * Mark the indicator before the editor builds its own description.
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

function submitDraft(a: Any): void {
	if (a.disableSubmit) return;
	const { text: value } = editorText(a);
	if (!value.trim()) return;
	if (typeof a.submitValue === "function") {
		a.submitValue();
		return;
	}
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
 * The terminal passes Enter to pi as a key rather than emitting `send`.
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

const caretPaths = new WeakMap<Component, string>();
/**
 * pi creates a fresh list for each new set of completions.
 */
const layeredLists = new WeakMap<Component, Component>();
const inlineLists = new WeakMap<Component, Component>();

function openAutocomplete(a: Any): Component | undefined {
	const list: Any | undefined = a.autocompleteList;
	if (!a.autocompleteState || !list || typeof list.render !== "function") return undefined;
	try {
		return typeof list.getSelectedItem !== "function" || list.getSelectedItem() ? (list as Component) : undefined;
	} catch {
		return undefined;
	}
}

const AUTOCOMPLETE_LINES = 10;

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

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
	const commands = /^\/[^/\s]*$/.test(prefix) && a.autocompleteState !== "force";
	l.nativeIcon = autocompleteIcons(prefix, a.autocompleteState, commands);
	l.nativeMaxLines = Math.max(AUTOCOMPLETE_LINES, finiteNumber(a.autocompleteMaxVisible));
}

const EDITOR_DEPTH = 3;
const EDITOR_WIDTH = 16;

/**
 * Build the overlay before describing the editor to avoid drawing the list twice.
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
			isPromptEditor(c) ? composerGhost(c) : undefined,
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
				ghost: value !== "" && isPromptEditor(c) ? composerGhost(c) : undefined,
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

/**
 * Terminal edit offsets are measured in UTF-16 code units.
 */
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
		if ((a.state.cursorLine !== beforeLine || a.state.cursorCol !== beforeCol) && a.autocompleteState) {
			try {
				if (typeof a.updateAutocomplete === "function") a.updateAutocomplete();
				else a.cancelAutocomplete?.();
			} catch {
				// Keep the caret move even if the completion provider fails.
			}
		}
		return;
	}
	a.onChange?.(next);
	retriggerAutocomplete(a);
}

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
		// The next keystroke can retry autocomplete.
	}
}

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
		if (by === editor && isPromptEditor(component)) {
			composerFrames.delete(component);
			hostComposer(component as Any, false);
		}
		return null;
	}
}

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

export function releaseNativeSideEffects(): void {
	for (const l of stoppedLoaders) {
		try {
			(l as Any).start?.();
		} catch {
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

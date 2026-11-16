/**
 * Native describers for pi's transcript and startup blocks that otherwise read
 * as a terminal (oh-my-pi's `chat/*` describes are the reference):
 *
 * - a user `!cmd` / `!!cmd` run (BashExecutionComponent) is omp's user run: a
 *   `tool` (role `omp.bash`, a `you` badge, `not sent` for `!!`) over one run
 *   box (`omp.run`: the command, the output as an `ansi` mini terminal
 *   following its tail, the state/time/truncation foot); a `card` where the
 *   terminal has no `tool` kind;
 * - compaction and branch summaries are omp's folded dividers (`section`s
 *   `omp.compaction` / `omp.branch`), a skill invocation omp's user-toned
 *   `omp.skill` card with its prompt behind a fold;
 * - an extension's message or entry renderer stays a describe boundary under
 *   an `omp.custom` col (its own describe wins); pi's default custom message
 *   look is omp's framed `omp.custom` card;
 * - pi's startup header is omp's `omp.welcome` splash (logo, wordmark and
 *   version, key hints as keycaps, the onboarding tip), the loaded-resources
 *   listings quiet `section`s, the Earendil announcement a card with its
 *   picture, Armin and the 3D egg pictures/`ansi`, a VisualLinePreview an
 *   `ansi` clamp — never `rows`.
 *
 * {@link toolResultImages} turns a tool result's image blocks into `image`
 * nodes (blobs) the tool describer appends to its body.
 *
 * Runtime imports stay off describers.ts (it registers these).
 */
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import {
	ArminComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	keyText,
	SkillInvocationMessageComponent,
	truncateTail,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Component, getImageDimensions } from "@earendil-works/pi-tui";
import { registerTspBlob, releaseTspBlob } from "../shared/tsp-blobs.ts";
import type { Describer } from "./describers.ts";
import { ansi, card, code, col, compact, type DescribeContext, EMPTY_NODE, md, type NativeChild, type NativeNode, type NativeUiEvent, node, row, spacer, span, stripAnsi, text } from "./node.ts";
import { hasStyle, lineToSpans, spansThemeId } from "./spans.ts";
import type { TspCardStatus, TspSpan, TspTone } from "./wire.ts";

/** Loose view of private component state. */
type Any = Record<string, any>;

function is(component: Component, ctor: Function | undefined, name: string): boolean {
	if (ctor && component instanceof ctor) return true;
	for (let proto = Object.getPrototypeOf(component); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		if (proto.constructor?.name === name) return true;
	}
	return false;
}

/** The exact class (by constructor name): pi's module-local classes (BuiltInHeader, ExpandableText, …) have no export to test against. */
function exactly(component: Component, name: string): boolean {
	return (component as Any).constructor?.name === name;
}

function plain(s: string): string {
	return stripAnsi(s).replaceAll("\x1b_pi:c\x07", "");
}

/** A ThemedText rebuilds its string lazily in render(): ask for it once so `text` is current (as the Text describers do). */
function refreshThemedText(a: Any): void {
	if (a.stale === true && typeof a.build === "function") {
		a.stale = false;
		a.setText?.(a.build());
	}
}

function rootToggle(event: NativeUiEvent): boolean | undefined {
	return event.type === "toggle" && event.key === "" ? !event.collapsed : undefined;
}

/** omp's `formatNumber`: 999, 1.2K, 19K, 1.5M. */
function formatNumber(n: number): string {
	const trim1 = (v: number) => {
		const s = v.toFixed(1);
		return s.endsWith(".0") ? s.slice(0, -2) : s;
	};
	if (n < 1_000) return String(Math.round(n));
	if (n < 10_000) return `${trim1(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
	if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
	return `${trim1(n / 1_000_000_000)}B`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function styledLine(line: string, role: string, key: string): NativeNode {
	const spans = lineToSpans(line);
	if (spans.length === 0) return text("", { role }, key);
	if (!hasStyle(spans)) return text(spans.map((sp) => sp.t).join(""), { role, wrap: "word" }, key);
	return text(spans, { role, wrap: "word" }, key);
}

// ── Images (blobs) ──────────────────────────────────────────────────────

/** rsttyd's `MAX_BLOB` (decoded bytes): bigger blobs are rejected, so they aren't registered. */
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const NO_IMAGES: NativeNode[] = [];

interface DecodedImage {
	readonly blob: string;
	readonly w: number | undefined;
	readonly h: number | undefined;
}

/** Decoded payloads by their base64 text (bounded): a payload is decoded and hashed once, whichever result object carries it. */
const decodedImages = new Map<string, DecodedImage | null>();
const MAX_DECODED_IMAGES = 64;

function imagesSupported(cx: DescribeContext): boolean {
	return cx.supports("image") && cx.feature("blobs");
}

function decodeImage(data: string, mime: string): DecodedImage | null {
	const hit = decodedImages.get(data);
	if (hit !== undefined) return hit;
	let entry: DecodedImage | null = null;
	try {
		const buffer = Buffer.from(data, "base64");
		// A small Buffer is a view into Node's shared pool: keep a copy of its own.
		const bytes = buffer.byteOffset === 0 && buffer.buffer.byteLength === buffer.byteLength ? buffer : new Uint8Array(buffer);
		if (bytes.byteLength > 0 && bytes.byteLength <= MAX_BLOB_BYTES) {
			let dims: { widthPx: number; heightPx: number } | null = null;
			try {
				dims = getImageDimensions(data, mime);
			} catch {
				dims = null;
			}
			entry = {
				blob: registerTspBlob(bytes, mime),
				w: dims && dims.widthPx > 0 ? dims.widthPx : undefined,
				h: dims && dims.heightPx > 0 ? dims.heightPx : undefined,
			};
		}
	} catch {
		entry = null;
	}
	if (decodedImages.size >= MAX_DECODED_IMAGES) {
		const oldest = decodedImages.keys().next();
		if (!oldest.done) decodedImages.delete(oldest.value);
	}
	decodedImages.set(data, entry);
	return entry;
}

/** `image` nodes for the `{type: "image", data, mimeType}` blocks of `content` (keys `img<n>`). */
function imageNodes(content: readonly unknown[], widthCells: number | undefined, role: string): NativeNode[] {
	const out: NativeNode[] = [];
	for (const item of content) {
		const block = item as Any | null;
		if (block?.type !== "image" || typeof block.data !== "string" || block.data === "") continue;
		const mime = typeof block.mimeType === "string" && block.mimeType ? block.mimeType : "image/png";
		const decoded = decodeImage(block.data, mime);
		if (!decoded) continue;
		out.push(
			node(
				"image",
				{
					role,
					blob: decoded.blob,
					alt: mime,
					w: decoded.w,
					h: decoded.h,
					max: widthCells !== undefined ? { w: `${widthCells}ch` } : undefined,
				},
				undefined,
				`img${out.length}`,
			),
		);
	}
	return out.length > 0 ? out : NO_IMAGES;
}

interface ImageMemo {
	readonly content: readonly unknown[];
	readonly length: number;
	readonly width: number;
	readonly nodes: NativeNode[];
}

/** The image nodes last built per tool result object. */
const toolImages = new WeakMap<object, ImageMemo>();

/**
 * The image blocks of a ToolExecutionComponent's result (`tool.result.content`
 * items `{type: "image", data, mimeType}`) as `image` nodes (keys `img<n>`),
 * only where the terminal draws blobs and pi shows images. The same array
 * while the result is unchanged (each payload decoded once).
 */
export function toolResultImages(tool: Record<string, any>, cx: DescribeContext): NativeNode[] {
	if (!imagesSupported(cx) || tool.showImages === false) return NO_IMAGES;
	const result: unknown = tool.result;
	if (!result || typeof result !== "object") return NO_IMAGES;
	const content: unknown = (result as Any).content;
	if (!Array.isArray(content) || content.length === 0) return NO_IMAGES;
	const width = typeof tool.imageWidthCells === "number" && tool.imageWidthCells > 0 ? Math.floor(tool.imageWidthCells) : 60;
	const cached = toolImages.get(result);
	if (cached && cached.content === content && cached.length === content.length && cached.width === width) return cached.nodes;
	const nodes = content.some((item) => (item as Any | null)?.type === "image") ? imageNodes(content, width, "omp.tool.image") : NO_IMAGES;
	toolImages.set(result, { content, length: content.length, width, nodes });
	return nodes;
}

// ── User bash (`!cmd`, `!!cmd`) ─────────────────────────────────────────

type ExecutionStatus = "running" | "complete" | "cancelled" | "error";

/** pi's PREVIEW_LINES for a user run (bash-execution.ts). */
const BASH_PREVIEW_LINES = 20;
/** omp's RUN_INPUT_PREVIEW_LINES: drawn lines of the command before its "N more lines". */
const RUN_INPUT_PREVIEW_LINES = 6;

const CARD_STATUS: Record<ExecutionStatus, TspCardStatus> = { running: "running", complete: "done", cancelled: "cancelled", error: "error" };

/** When a run was first seen running, and first seen settled (a run restored from the session has no clock). */
const bashClocks = new WeakMap<Component, { start: number; end?: number }>();
/** pi's Loader timers stopped while a run is native (the terminal clocks its spinner), restarted on release. */
const stoppedLoaders = new Map<Any, Any>();

function bashStatus(a: Any): ExecutionStatus {
	const s = a.status;
	return s === "running" || s === "cancelled" || s === "error" ? s : "complete";
}

function tickBashClock(c: Component, status: ExecutionStatus): { start: number; end?: number } | undefined {
	let clock = bashClocks.get(c);
	if (!clock) {
		if (status !== "running") return undefined;
		clock = { start: Date.now() };
		bashClocks.set(c, clock);
	}
	if (status !== "running" && clock.end === undefined) clock.end = Date.now();
	return clock;
}

function stopBashLoader(a: Any): void {
	const loader: Any | undefined = a.loader;
	if (!loader?.intervalId || typeof loader.stop !== "function") return;
	loader.stop();
	stoppedLoaders.set(loader, a);
}

/** The run's output as pi keeps it for display (its context-limit tail), and whether anything was cut. */
function bashOutput(a: Any): { output: string; truncated: boolean } {
	const lines: unknown = a.outputLines;
	const full = Array.isArray(lines) ? lines.join("\n") : typeof a.getOutput === "function" ? String(a.getOutput()) : "";
	let output = full;
	let truncated = a.truncationResult?.truncated === true;
	try {
		const cut = truncateTail(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		output = cut.content;
		if (cut.truncated) truncated = true;
	} catch {
		// keep the full output
	}
	return { output: output.trimEnd(), truncated };
}

function cancelKey(): string {
	try {
		return keyText("tui.select.cancel") || "esc";
	} catch {
		return "esc";
	}
}

/** The truncation notice of a run's foot (pi: `Output truncated. Full output: <path>`). */
function truncationNotice(a: Any, truncated: boolean): string | undefined {
	if (!truncated) return undefined;
	const path = typeof a.fullOutputPath === "string" && a.fullOutputPath ? a.fullOutputPath : undefined;
	return path ? `Output truncated · full output: ${path}` : "Output truncated";
}

const RUN_STATE: Record<ExecutionStatus, { word: string; tone: TspTone }> = {
	running: { word: "Running", tone: "pending" },
	complete: { word: "Done", tone: "success" },
	error: { word: "Failed", tone: "error" },
	cancelled: { word: "Cancelled", tone: "muted" },
};

/** omp's `runFoot`: the state word in its tone, the run time (live while running) and the notice. */
function runFoot(status: ExecutionStatus, exitCode: unknown, ms: number | undefined, notice: string | undefined): NativeNode {
	const failed = status === "error" && typeof exitCode === "number" && exitCode !== 0;
	const state = failed ? { word: `exit ${exitCode}`, tone: RUN_STATE.error.tone } : RUN_STATE[status];
	const time =
		ms === undefined
			? undefined
			: node("elapsed", status === "running" ? { role: "omp.run.time", age: ms, format: "short" } : { role: "omp.run.time", age: ms, stopped: ms, format: "short" }, undefined, "time");
	return row(
		compact<NativeNode>([
			text([span(state.word)], { role: "omp.run.state", tone: state.tone }, "state"),
			time,
			notice !== undefined && text([span(notice, "warning")], { role: "omp.run.facts", wrap: "word" }, "facts"),
		]),
		{ role: "omp.run.foot", gap: "sm", align: "center" },
		"foot",
	);
}

/**
 * omp's `describeExecutionTool`: the user's run as the agent's bash frame
 * with a `you` badge (`not sent` when excluded from context) and the command
 * for Copy command; one run box (command, output, foot); timer, exit chip and
 * cancelled note as head data.
 */
function describeBashTool(a: Any, status: ExecutionStatus, ms: number | undefined): NativeNode {
	const command = String(a.command ?? "");
	const running = status === "running";
	const expanded = a.expanded === true;
	const { output, truncated } = bashOutput(a);
	const box = col(
		compact<NativeNode>([
			code(command.trimEnd(), { role: "omp.tool.bash.command", lang: "bash", wrap: true, preview: { lines: RUN_INPUT_PREVIEW_LINES } }, "input"),
			output.length > 0 && ansi(output, { role: "omp.tool.bash.output", follow: true, preview: expanded ? undefined : { lines: BASH_PREVIEW_LINES } }, "output"),
			runFoot(status, a.exitCode, ms, truncationNotice(a, truncated)),
		]),
		{ role: "omp.run", gap: "none", tone: status === "error" ? "error" : undefined },
		"run",
	);
	const badges: { text: string; tone?: TspTone; title?: string }[] = [{ text: "you", tone: "user" }];
	if (a.colorKey === "dim") badges.push({ text: "not sent", title: "Not sent to the model", tone: "muted" });
	return node(
		"tool",
		{
			role: "omp.bash",
			name: "bash",
			title: "Bash",
			command,
			badges,
			status: CARD_STATUS[status],
			age: running ? ms : undefined,
			took: running ? undefined : ms,
			exit: status === "error" && typeof a.exitCode === "number" ? a.exitCode : undefined,
			note: status === "cancelled" ? "cancelled" : undefined,
			frame: "card",
			collapsible: true,
			collapsed: !expanded,
			preview: "children",
		},
		[box],
	);
}

/** omp's `describeExecutionCard` (terminals without `tool`): the `$ cmd` head, the output, a cancel spinner, then the notes. */
function describeBashCard(a: Any, status: ExecutionStatus, ms: number | undefined): NativeNode {
	const command = String(a.command ?? "");
	const running = status === "running";
	const excluded = a.colorKey === "dim";
	const expanded = a.expanded === true;
	const { output, truncated } = bashOutput(a);
	const children: NativeChild[] = [];
	if (running && ms !== undefined) children.push(row([node("elapsed", { age: ms, format: "short" })], { gap: "sm", align: "baseline" }, "head"));
	if (output) children.push(ansi(output, { follow: running, preview: expanded ? undefined : { lines: BASH_PREVIEW_LINES }, role: "omp.tool.bash.output" }, "output"));
	if (running) children.push(node("spinner", { label: [span(`Running… (${cancelKey()} to cancel)`, "muted")] }, undefined, "running"));
	const notes: TspSpan[] = [];
	const note = (value: string, token: string): void => {
		if (notes.length > 0) notes.push(span("\n"));
		notes.push(span(value, token));
	};
	if (status === "cancelled") note("(cancelled)", "warning");
	else if (status === "error") note(`(exit ${a.exitCode})`, "error");
	const notice = truncationNotice(a, truncated);
	if (notice) note(notice, "warning");
	if (notes.length > 0) children.push(text(notes, { wrap: "word" }, "notes"));
	return card(
		{
			role: "omp.bash",
			head: [span(`$ ${command}`, `${excluded ? "dim" : "bashMode"} strong`)],
			tone: excluded ? "muted" : undefined,
			status: CARD_STATUS[status],
			collapsible: true,
			collapsed: !expanded,
			preview: expanded ? undefined : { lines: BASH_PREVIEW_LINES },
		},
		children,
	);
}

const bashExecution: Describer = {
	name: "BashExecution",
	matches: (c) => is(c, BashExecutionComponent, "BashExecutionComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const status = bashStatus(a);
		const clock = tickBashClock(c, status);
		if (status === "running") stopBashLoader(a);
		const lines: unknown[] = Array.isArray(a.outputLines) ? a.outputLines : [];
		const last = lines[lines.length - 1];
		return [
			a.command,
			lines.length,
			typeof last === "string" ? last.length : -1,
			status,
			a.exitCode,
			a.expanded === true,
			a.colorKey,
			a.truncationResult,
			a.fullOutputPath,
			clock,
			clock?.end,
			cx.supports("tool"),
		];
	},
	build: (c, cx) => {
		const a = c as Any;
		const status = bashStatus(a);
		const clock = bashClocks.get(c);
		const ms = clock ? Math.max(0, Math.round((clock.end ?? Date.now()) - clock.start)) : undefined;
		return cx.supports("tool") ? describeBashTool(a, status, ms) : describeBashCard(a, status, ms);
	},
	handleEvent: (c, event) => {
		const expanded = rootToggle(event);
		if (expanded !== undefined) (c as Any).setExpanded?.(expanded);
	},
};

// ── Summaries and skills ────────────────────────────────────────────────

function toggleExpanded(c: Component, event: NativeUiEvent, keys: readonly string[] = [""]): void {
	if (event.type !== "toggle" || !keys.includes(event.key)) return;
	(c as Any).setExpanded?.(!event.collapsed);
}

/** omp's compaction divider: `Compacted from 19K tokens`, the summary behind the fold. */
const compactionSummary: Describer = {
	name: "CompactionSummary",
	matches: (c) => is(c, CompactionSummaryMessageComponent, "CompactionSummaryMessageComponent"),
	fingerprint: (c) => {
		const a = c as Any;
		return [a.message, a.message?.summary, a.message?.tokensBefore, a.expanded === true];
	},
	build: (c) => {
		const a = c as Any;
		const message: Any = a.message ?? {};
		const before = typeof message.tokensBefore === "number" && Number.isFinite(message.tokensBefore) ? message.tokensBefore : 0;
		const head: TspSpan[] = [span("Compacted", "muted")];
		if (before > 0) head.push(span(" from ", "dim"), span(`${formatNumber(before)} tokens`, "muted mono"));
		return node(
			"section",
			{ role: "omp.compaction", head, collapsible: true, collapsed: a.expanded !== true },
			[
				text([span("Summary of the earlier conversation", "dim")], { role: "omp.compaction.caption" }, "caption"),
				md(String(message.summary ?? ""), undefined, "summary"),
			],
		);
	},
	handleEvent: (c, event) => toggleExpanded(c, event),
};

/** omp's branch divider: `Branch summarized`, the summary behind the fold. */
const branchSummary: Describer = {
	name: "BranchSummary",
	matches: (c) => is(c, BranchSummaryMessageComponent, "BranchSummaryMessageComponent"),
	fingerprint: (c) => {
		const a = c as Any;
		return [a.message, a.message?.summary, a.expanded === true];
	},
	build: (c) => {
		const a = c as Any;
		return node("section", { role: "omp.branch", head: [span("Branch summarized", "muted")], collapsible: true, collapsed: a.expanded !== true }, [
			md(`**Branch summary**\n\n${String(a.message?.summary ?? "")}`, undefined, "summary"),
		]);
	},
	handleEvent: (c, event) => toggleExpanded(c, event),
};

function fileHref(path: unknown): { href: string } | undefined {
	if (typeof path !== "string" || !path) return undefined;
	try {
		return { href: pathToFileURL(path).href };
	} catch {
		return undefined;
	}
}

/** omp's skill card: a user-toned card headed by the skill (linked to its file) and its size, the loaded prompt behind a fold. */
const skillInvocation: Describer = {
	name: "SkillInvocation",
	matches: (c) => is(c, SkillInvocationMessageComponent, "SkillInvocationMessageComponent"),
	fingerprint: (c) => {
		const a = c as Any;
		return [a.skillBlock, a.skillBlock?.name, a.skillBlock?.content, a.expanded === true];
	},
	build: (c) => {
		const a = c as Any;
		const block: Any = a.skillBlock ?? {};
		const name = String(block.name ?? "").trim() || "skill";
		const content = String(block.content ?? "");
		const lines = content ? content.split("\n").length : 0;
		const head: TspSpan[] = [span(name, "customMessageLabel strong", fileHref(block.location))];
		if (lines > 0) head.push(span(`  ${lines} ${lines === 1 ? "line" : "lines"}`, "muted"));
		return card({ role: "omp.skill", tone: "user", head }, [
			node("section", { head: [span("prompt", "muted")], role: "omp.skill.prompt", collapsible: true, collapsed: a.expanded !== true }, content ? [md(content, undefined, "body")] : [], "prompt"),
		]);
	},
	handleEvent: (c, event) => toggleExpanded(c, event, ["", "prompt"]),
};

// ── Extension messages and entries ──────────────────────────────────────

interface CustomImages {
	readonly content: unknown;
	readonly nodes: NativeNode[];
}

const customImages = new WeakMap<Component, CustomImages>();

function customMessageImages(c: Component, content: unknown, cx: DescribeContext): NativeNode[] {
	if (!imagesSupported(cx) || !Array.isArray(content)) return NO_IMAGES;
	const cached = customImages.get(c);
	if (cached && cached.content === content) return cached.nodes;
	const nodes = imageNodes(content, 60, "omp.custom.image");
	customImages.set(c, { content, nodes });
	return nodes;
}

/**
 * An extension's custom message: its renderer's component stays a describe
 * boundary (its own describe wins) under an `omp.custom` col; pi's default
 * look is omp's framed card, the custom type as its head, the text as markdown.
 */
const customMessage: Describer = {
	name: "CustomMessage",
	matches: (c) => is(c, CustomMessageComponent, "CustomMessageComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const content = a.message?.content;
		return [a.customComponent, a.message, content, Array.isArray(content) ? content.length : -1, a.message?.customType, imagesSupported(cx)];
	},
	build: (c, cx) => {
		const a = c as Any;
		const custom: Component | undefined = a.customComponent;
		if (custom && typeof custom.render === "function") return col([custom], { role: "omp.custom" });
		const message: Any | undefined = a.message;
		if (!message) return EMPTY_NODE;
		const body = messageText(message.content);
		const images = customMessageImages(c, message.content, cx);
		return card({ role: "omp.custom", head: [span(String(message.customType ?? "custom"), "customMessageLabel strong")] }, [
			...(body.trim() ? [md(body, undefined, "body")] : []),
			...images,
		]);
	},
};

/** An extension's session entry: the renderer's component as a describe boundary; nothing rendered, nothing shown. */
const customEntry: Describer = {
	name: "CustomEntry",
	matches: (c) => is(c, undefined, "CustomEntryComponent"),
	fingerprint: (c) => [(c as Any).customComponent],
	build: (c) => {
		const custom: Component | undefined = (c as Any).customComponent;
		return custom && typeof custom.render === "function" ? col([custom], { role: "omp.custom.entry" }) : EMPTY_NODE;
	},
};

// ── Startup header ──────────────────────────────────────────────────────

/** pi's logo (pi-logo.ts): four cells of two square pixels each, in its brand colours, as a tile. */
const PI_LOGO_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="-0.5 -0.5 5 5" shape-rendering="crispEdges">' +
	'<path fill="#e48a7a" d="M0 0h3v1H0zM2 1h1v1H2z"/>' +
	'<path fill="#4f8eb3" d="M0 1h1v3H0zM1 2h1v1H1z"/>' +
	'<path fill="#eab65d" d="M3 2h1v2H3z"/>' +
	"</svg>";

let piLogoBlob: string | undefined;

function piLogo(): string {
	piLogoBlob ??= registerTspBlob(new TextEncoder().encode(PI_LOGO_SVG), "image/svg+xml");
	return piLogoBlob;
}

/** The logo's half-block glyphs leading the header's hint line. */
const LOGO_GLYPHS = /^[\s\u2580-\u259f]+/;

/** Single-word key names that read as keys (pi-tui key ids). */
const KEY_NAMES: ReadonlySet<string> = new Set([
	"esc",
	"escape",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	"ctrl",
	"alt",
	"shift",
	"super",
	"option",
]);

function isKeyWord(word: string): boolean {
	if (word === "") return false;
	if (word.includes("+")) return true;
	if (KEY_NAMES.has(word.toLowerCase())) return true;
	if (/^f\d{1,2}$/i.test(word)) return true;
	const chars = [...word];
	return chars.length === 1 || (chars.length <= 2 && /^[^\p{L}\p{N}\s]+$/u.test(word));
}

/** A key id for rsttyd's `key` spans (macOS pi writes `option` for alt). */
function keyId(word: string): string {
	return word.replace(/\boption\b/gi, "alt");
}

/** A hint's key text as keycap spans: `ctrl+c/ctrl+d` two caps, `ctrl+c twice` a cap and a word. */
function keySpans(keys: string): TspSpan[] {
	const out: TspSpan[] = [];
	keys.split(" ").forEach((word, i) => {
		if (i > 0) out.push(span(" "));
		if (!isKeyWord(word)) {
			out.push(span(word, "muted"));
			return;
		}
		const parts = word.length > 1 && word.includes("/") ? word.split("/") : [word];
		if (parts.some((part) => !isKeyWord(part))) {
			out.push(span(keyId(word), "key"));
			return;
		}
		parts.forEach((part, j) => {
			if (j > 0) out.push(span("/", "dim"));
			out.push(span(keyId(part), "key"));
		});
	});
	return out;
}

/** One hint (`esc to interrupt`, `ctrl+o more`) as its keys and its words. */
function parseHint(item: string): { keys: string; desc: string } {
	const m = /^(.+?) ((?:to|for) .+)$/.exec(item);
	if (m) return { keys: m[1]!, desc: m[2]! };
	const sp = item.indexOf(" ");
	return sp === -1 ? { keys: item, desc: "" } : { keys: item.slice(0, sp), desc: item.slice(sp + 1) };
}

/** `Press ctrl+o to show …` with the key as a keycap. */
function pressSpans(line: string): TspSpan[] {
	const m = /^(Press )(\S+)( .*)$/.exec(line);
	if (!m || !isKeyWord(m[2]!)) return [span(line, "dim")];
	return [span(m[1]!, "dim"), ...keySpans(m[2]!), span(m[3]!, "dim")];
}

/**
 * pi's built-in header (BuiltInHeader: the logo and version, the key hints,
 * the onboarding lines) as omp's `omp.welcome` splash: the lockup (pi's logo
 * tile where blobs draw, the `pi` wordmark over the version), the hints as
 * keycap pairs (inline while folded, a grid expanded), the "Press … for more"
 * line, then the onboarding sentence as omp's tip. The text is pi's own
 * (parsed from what it renders), so hints follow the keybindings.
 */
function describeHeader(a: Any, cx: DescribeContext): NativeNode {
	const lines = plain(String(a.text ?? "")).split("\n");
	if (lines.every((line) => line.trim() === "")) return EMPTY_NODE;
	const version = /\bv(\d[\w.+-]*)/.exec(lines[0] ?? "")?.[1] ?? VERSION;
	const hintLines: string[] = [];
	let i = 1;
	for (; i < lines.length; i++) {
		const line = lines[i]!.replace(LOGO_GLYPHS, "").trim();
		if (line === "" || line.endsWith(".")) break;
		hintLines.push(line);
	}
	const notes = lines
		.slice(i)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const expanded = a.state?.expanded === true;
	const hints = hintLines.flatMap((line) => line.split(" · ")).map((item) => parseHint(item.trim()));

	const mark = col(
		[
			text([span("pi", "strong")], { wrap: "none", role: "omp.welcome.wordmark" }, "omp.welcome.wordmark"),
			text([span(`v${version}`, "dim mono")], { wrap: "none", role: "omp.welcome.version" }, "omp.welcome.version"),
		],
		{ role: "omp.welcome.mark" },
		"mark",
	);
	const lockup: NativeChild[] = [];
	if (imagesSupported(cx)) lockup.push(node("image", { blob: piLogo(), alt: "pi", w: 40, h: 40, role: "omp.welcome.logo", actions: { click: "logo" } }, undefined, "logo"));
	lockup.push(mark);
	const body: NativeChild[] = [row(lockup, { align: "center", gap: "md", role: "omp.welcome.lockup" }, "lockup")];
	if (hints.length > 0) {
		body.push(spacer("sm", "keys-gap"));
		body.push(
			node(
				"kv",
				{
					role: "pi.welcome.keys",
					layout: expanded ? undefined : "inline",
					items: hints.map((hint) => ({ k: keySpans(hint.keys), v: hint.desc ? [span(hint.desc, "muted")] : "" })),
				},
				undefined,
				"keys",
			),
		);
	}
	notes.forEach((line, n) => {
		if (/^Press\b/.test(line)) {
			body.push(spacer("xs", `more-gap${n}`), text(pressSpans(line), { wrap: "word", role: "pi.welcome.more" }, `more${n}`));
			return;
		}
		body.push(
			row(
				[node("icon", { name: "lightbulb", role: "omp.welcome.tip-icon" }, undefined, "icon"), text(line, { wrap: "word", role: "omp.welcome.tip-text" }, "text")],
				{ gap: "sm", align: "start", role: "omp.welcome.tip" },
				`tip${n}`,
			),
		);
	});
	return card({ role: "omp.welcome" }, body);
}

const builtInHeader: Describer = {
	name: "StartupHeader",
	matches: (c) => exactly(c, "BuiltInHeader"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		refreshThemedText(a);
		return [a.text, a.state?.expanded === true, imagesSupported(cx)];
	},
	build: (c, cx) => describeHeader(c as Any, cx),
};

/**
 * A loaded-resources listing (ExpandableText `[Context]`, `[Skills]`, …): a
 * quiet section headed by the name, pi's compact list (folded) or its scope
 * groups (expanded) as themed lines.
 */
const loadedResources: Describer = {
	name: "LoadedResources",
	matches: (c) => exactly(c, "ExpandableText"),
	fingerprint: (c) => {
		const a = c as Any;
		refreshThemedText(a);
		return [a.text, spansThemeId()];
	},
	build: (c) => {
		const raw = String((c as Any).text ?? "").replaceAll("\x1b_pi:c\x07", "");
		const lines = raw.split("\n");
		const name = /^\[(.+)\]$/.exec(plain(lines[0] ?? "").trim())?.[1];
		const rest = (name === undefined ? lines : lines.slice(1)).filter((line) => plain(line).trim() !== "");
		// pi indents every listing line two cells under its head; the section body does that.
		const body = rest.map((line, i) => styledLine(line.replace(/^((?:\x1b\[[0-9;]*m)*) {2}/, "$1"), "pi.resources.item", `l${i}`));
		if (name === undefined) return body.length > 0 ? col(body, { role: "pi.resources" }) : EMPTY_NODE;
		return node("section", { role: "pi.resources", head: [span(name, "strong")] }, body);
	},
};

/** pi's Earendil announcement: a card with the title, the blog link and the picture (pi-tui's Image, a describe boundary). */
const earendilAnnouncement: Describer = {
	name: "EarendilAnnouncement",
	matches: (c) => is(c, undefined, "EarendilAnnouncementComponent"),
	fingerprint: (c) => {
		const children: Any[] = (c as Any).children ?? [];
		return [children.length, ...children];
	},
	build: (c) => {
		const children: Any[] = (c as Any).children ?? [];
		const texts: string[] = [];
		let image: Component | undefined;
		for (const child of children) {
			if (typeof child?.base64Data === "string" && typeof child.render === "function") image = child as Component;
			else if (typeof child?.text === "string" && plain(child.text).trim()) texts.push(plain(child.text).trim());
		}
		const url = texts.find((t) => /^https?:\/\//.test(t));
		const [title, ...rest] = texts.filter((t) => t !== url);
		const body: NativeChild[] = [];
		if (title) body.push(text([span(title, "accent strong")], { wrap: "word" }, "title"));
		const lead = rest.join(" ");
		const link: TspSpan[] = [];
		if (lead) link.push(span(url ? `${lead} ` : lead, "muted"));
		if (url) link.push(span(url, "link", { href: url }));
		if (link.length > 0) body.push(text(link, { wrap: "word" }, "link"));
		if (image) body.push(image);
		return body.length > 0 ? card({ role: "pi.announcement" }, body) : EMPTY_NODE;
	},
};

// ── Easter eggs and previews ────────────────────────────────────────────

/** Opacity of the top and bottom pixel of a half-block cell. */
function cellPixels(ch: string | undefined): readonly [number, number] {
	switch (ch) {
		case "█":
			return [1, 1];
		case "▀":
			return [1, 0];
		case "▄":
			return [0, 1];
		case "▓":
			return [0.8, 0.8];
		case "▒":
			return [0.55, 0.55];
		case "░":
			return [0.3, 0.3];
		default:
			return [0, 0];
	}
}

/** A half-block grid as an SVG (one path per opacity, horizontal runs merged), 4px per pixel. */
function gridSvg(grid: readonly (readonly string[])[], color: string): string {
	const width = grid.reduce((n, r) => Math.max(n, r.length), 0);
	const height = grid.length * 2;
	const paths = new Map<number, string>();
	for (let y = 0; y < height; y++) {
		const cells = grid[y >> 1] ?? [];
		let x = 0;
		while (x < width) {
			const alpha = cellPixels(cells[x])[y & 1] ?? 0;
			if (alpha === 0) {
				x++;
				continue;
			}
			const start = x;
			while (x < width && (cellPixels(cells[x])[y & 1] ?? 0) === alpha) x++;
			paths.set(alpha, `${paths.get(alpha) ?? ""}M${start} ${y}h${x - start}v1h${start - x}z`);
		}
	}
	let body = "";
	for (const [alpha, d] of paths) body += `<path fill="${color}"${alpha < 1 ? ` fill-opacity="${alpha}"` : ""} d="${d}"/>`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 4}" height="${height * 4}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${body}</svg>`;
}

/** The truecolor foreground of a pi-rendered line, as `#rrggbb`. */
function lineColor(lines: readonly string[]): string | undefined {
	for (const line of lines) {
		const m = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(line);
		if (m) return `#${[m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0")).join("")}`;
	}
	return undefined;
}

/** The last animation frame's blob per Armin, released when the next frame replaces it. */
const arminFrames = new WeakMap<Component, string>();

/**
 * Armin (`/armin`): his picture in the theme's accent as an SVG where blobs
 * draw (the effect animating at 10 fps), else his half-block art as `ansi`;
 * then "ARMIN SAYS HI".
 */
const armin: Describer = {
	name: "Armin",
	matches: (c) => is(c, ArminComponent, "ArminComponent"),
	fingerprint: (c, cx) => {
		const a = c as Any;
		const animating = a.interval != null;
		return [animating ? Math.floor(Date.now() / 100) : -1, animating ? -1 : a.gridVersion, imagesSupported(cx), cx.cols, spansThemeId()];
	},
	build: (c, cx) => {
		const a = c as Any;
		const lines = c.render(Math.max(40, cx.cols));
		const art = lines.slice(0, -1).map((line) => line.replace(/\s+$/, ""));
		const message = text([span(plain(lines[lines.length - 1] ?? "ARMIN SAYS HI").trim() || "ARMIN SAYS HI", "accent strong")], { wrap: "none" }, "message");
		const grid: unknown = a.currentGrid;
		if (imagesSupported(cx) && Array.isArray(grid) && grid.every((r) => Array.isArray(r))) {
			const svg = gridSvg(grid as string[][], lineColor(lines) ?? "#8abeb7");
			const blob = registerTspBlob(new TextEncoder().encode(svg), "image/svg+xml");
			const previous = arminFrames.get(c);
			if (previous !== undefined && previous !== blob) releaseTspBlob(previous);
			arminFrames.set(c, blob);
			return col([node("image", { blob, alt: "Armin", role: "pi.armin.art", actions: { click: "armin" } }, undefined, "art"), message], { role: "pi.armin", gap: "sm" });
		}
		return col([ansi(art.join("\n"), { role: "pi.armin.art" }, "art"), message], { role: "pi.armin", gap: "sm" });
	},
};

/**
 * The 3D easter egg (fullscreen overlay): its frames as an `ansi` screen at
 * 8 fps (describing keeps it alive; it ends on its own once no longer drawn).
 */
const easterEgg3d: Describer = {
	name: "EasterEgg3d",
	matches: (c) => is(c, undefined, "EasterEgg3dAnimation"),
	fingerprint: (_c, cx) => [Math.floor(Date.now() / 125), cx.cols],
	build: (c, cx) => {
		const cols = Math.max(1, cx.cols);
		return ansi(c.render(cols).join("\n"), { role: "pi.egg", cols }, "screen");
	},
};

/** pi's collapsed tool output preview: the whole text as `ansi`, clamped to its head or tail lines by the terminal. */
const visualLinePreview: Describer = {
	name: "VisualLinePreview",
	matches: (c) => is(c, undefined, "VisualLinePreview"),
	fingerprint: (c) => {
		const options: Any | undefined = (c as Any).options;
		return [options, options?.text, options?.maxVisualLines, options?.keep];
	},
	build: (c) => {
		const options: Any = (c as Any).options ?? {};
		const value = String(options.text ?? "").replace(/\s+$/, "");
		if (!value) return EMPTY_NODE;
		const lines = typeof options.maxVisualLines === "number" && options.maxVisualLines > 0 ? Math.floor(options.maxVisualLines) : 10;
		return ansi(value, { role: "pi.preview", preview: options.keep === "start" ? { lines } : { tail: lines } });
	},
};

/**
 * Leaving native rendering: restart the spinner timers of runs still going
 * (the describer stopped them; the terminal clocked the native spinner).
 */
export function releaseBlockSideEffects(): void {
	for (const [loader, run] of stoppedLoaders) {
		try {
			if (run.status === "running") loader.start?.();
		} catch {
			// ignore
		}
	}
	stoppedLoaders.clear();
}

/** Registered before the transcript's and the generic describers (exact classes only). */
export const BLOCK_DESCRIBERS: readonly Describer[] = [
	bashExecution,
	compactionSummary,
	branchSummary,
	skillInvocation,
	customMessage,
	customEntry,
	builtInHeader,
	loadedResources,
	earendilAnnouncement,
	armin,
	easterEgg3d,
	visualLinePreview,
];

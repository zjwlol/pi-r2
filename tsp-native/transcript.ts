/**
 * The transcript as oh-my-pi's blocks. pi mounts its whole document (header,
 * loaded resources, chat) as one component; Tern's transcript features (the
 * "Worked for …" fold, block parking, per-block styling) look at `main`'s
 * direct children, so {@link transcriptBlocks} flattens pi's plain layout
 * containers into one block per chat entry, and the describers here make the
 * blocks classify as omp's do (tsp-fold.js `blockKind`):
 *
 * - a user message is omp's `omp.user` bubble (a break);
 * - an assistant message is an `omp.assistant` col of `md` parts keyed by
 *   content index, its thoughts omp's `omp.thinking` sections with a "Thought
 *   for 12s" head (`took` feeds the fold's sum), its turn-ending error or
 *   abort in omp's roles, and the turn's usage as omp's hover footer;
 * - a transcript Spacer draws nothing (the block gap spaces the blocks, as in
 *   omp) and a dim or warning status line is an `omp.notice.*` block: both are
 *   quiet, so they fold with the run around them.
 *
 * Runtime imports stay off describers.ts (it registers these first).
 */
import { AssistantMessageComponent, copyToClipboard, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Container, ScrollView, Spacer, Text } from "@earendil-works/pi-tui";
import type { Describer } from "./describers.ts";
import { card, col, type DescribeContext, EMPTY_NODE, md, type NativeChild, type NativeNode, node, row, span, stripAnsi, text } from "./node.ts";
import { hasStyle, lineToSpans, spansThemeId } from "./spans.ts";
import type { TspSpan } from "./wire.ts";

/** Loose view of private component state. */
type Any = Record<string, any>;

function is(component: Component, ctor: Function | undefined, name: string): boolean {
	if (ctor && component instanceof ctor) return true;
	for (let proto = Object.getPrototypeOf(component); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		if (proto.constructor?.name === name) return true;
	}
	return false;
}

// ── Flattening ──────────────────────────────────────────────────────────

/** Levels of plain containers opened: pi's document, then its header/loaded-resources/chat containers. */
const LAYOUT_DEPTH = 2;

/** An exact pi-tui `Container` (UserMessageComponent, ToolExecutionComponent, … extend it: those are blocks). */
function isPlainContainer(c: Component): boolean {
	const ctor = (c as Any).constructor;
	return (ctor === Container || ctor?.name === "Container") && Array.isArray((c as Any).children);
}

/** A fullscreen transcript viewport mounted in pi's place: its content is the document. */
function scrolledContent(c: Component): Component | undefined {
	if (!is(c, ScrollView, "ScrollView")) return undefined;
	const child = (c as Any).child;
	return child && typeof child.render === "function" ? (child as Component) : undefined;
}

/**
 * The transcript blocks under pi's document root (`tui.children[0]` in both
 * TUI modes: the fullscreen layout root only wraps the same components): the
 * root and its plain layout containers opened, every other component a block
 * (the same objects each frame, so their wire ids stay). Anything else at the
 * root stays one block, as before.
 */
export function transcriptBlocks(root: Component): Component[] {
	const out: Component[] = [];
	const visit = (c: Component, depth: number): void => {
		const content = depth === 0 ? scrolledContent(c) : undefined;
		if (content) {
			visit(content, depth);
			return;
		}
		if (depth < LAYOUT_DEPTH && isPlainContainer(c)) {
			for (const child of (c as Any).children as Component[]) visit(child, depth + 1);
			return;
		}
		out.push(c);
	};
	visit(root, 0);
	noteTranscript(out);
	return out;
}

type BlockKind = "user" | "assistant" | "text" | "spacer" | "other";

const kinds = new WeakMap<Component, BlockKind>();
/** Components that are transcript blocks (a Text or Spacer elsewhere keeps its ordinary describer). */
const blocks = new WeakSet<Component>();

function kindOf(c: Component): BlockKind {
	let kind = kinds.get(c);
	if (kind !== undefined) return kind;
	if (is(c, UserMessageComponent, "UserMessageComponent")) kind = "user";
	else if (is(c, AssistantMessageComponent, "AssistantMessageComponent")) kind = "assistant";
	else if (is(c, Text, "Text")) kind = "text";
	else if (is(c, Spacer, "Spacer")) kind = "spacer";
	else kind = "other";
	kinds.set(c, kind);
	return kind;
}

// ── Turn usage ──────────────────────────────────────────────────────────

/** A finished turn's totals (omp `TurnUsageSummary`), shown under its last answer. */
interface TurnUsage {
	readonly elapsedMs: number | undefined;
	/** Input and cache writes (cache reads re-read the context each request: left out, as in omp). */
	readonly input: number;
	readonly output: number;
	readonly cost: number;
	readonly text: string;
	readonly title: string;
}

const turnUsage = new WeakMap<Component, TurnUsage>();

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Mark the blocks and sum each turn's requests onto the message that ends it
 * (any stop but `toolUse`); a user message starts a new tally. The same
 * summary object stays while its numbers do.
 */
function noteTranscript(list: readonly Component[]): void {
	let input = 0;
	let output = 0;
	let cost = 0;
	let started: number | undefined;
	const reset = () => {
		input = output = cost = 0;
		started = undefined;
	};
	for (const c of list) {
		blocks.add(c);
		const kind = kindOf(c);
		if (kind === "user") {
			reset();
			continue;
		}
		if (kind !== "assistant") continue;
		const a = c as Any;
		const message: Any | undefined = a.lastMessage;
		if (!message || a.isStreaming === true || typeof message.stopReason !== "string") {
			turnUsage.delete(c);
			continue;
		}
		const usage: Any = message.usage ?? {};
		input += num(usage.input) + num(usage.cacheWrite);
		output += num(usage.output);
		cost += num(usage.cost?.total);
		if (started === undefined && Number.isFinite(message.timestamp)) started = message.timestamp;
		if (message.stopReason === "toolUse") {
			turnUsage.delete(c);
			continue;
		}
		if (input + output <= 0 && cost <= 0) turnUsage.delete(c);
		else {
			const end = Number.isFinite(message.timestamp) && Number.isFinite(message.durationMs) ? message.timestamp + message.durationMs : undefined;
			const elapsedMs = end !== undefined && started !== undefined && end > started ? Math.round(end - started) : undefined;
			const prev = turnUsage.get(c);
			if (!prev || prev.input !== input || prev.output !== output || prev.cost !== cost || prev.elapsedMs !== elapsedMs) {
				turnUsage.set(c, { elapsedMs, input, output, cost, ...formatTurnUsage(elapsedMs, input, output, cost) });
			}
		}
		reset();
	}
}

/** omp `formatTurnUsage`: `12.4s · 19K tok · $0.02 this turn`, exact counts in the tooltip. */
function formatTurnUsage(elapsedMs: number | undefined, input: number, output: number, cost: number): { text: string; title: string } {
	const tokens = input + output;
	const money = cost > 0 ? (cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}`) : undefined;
	const time = elapsedMs === undefined ? undefined : formatDuration(elapsedMs);
	const line = [time, `${formatNumber(tokens)} tok`, money].filter((part) => part !== undefined).join(" · ");
	const exact = `${tokens.toLocaleString("en-US")} tokens (${input.toLocaleString("en-US")} in · ${output.toLocaleString("en-US")} out)`;
	const title = [time, exact, money].filter((part) => part !== undefined).join(" · ");
	return { text: `${line} this turn`, title: `This turn: ${title}` };
}

/** omp's `formatDuration`. */
function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < 1000) return `${Math.floor(ms)}ms`;
	if (ms < 60_000) {
		const tenths = Math.round(ms / 100);
		return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : "1m";
	}
	if (ms < 3_600_000) {
		const mins = Math.floor(ms / 60_000);
		const secs = Math.floor((ms % 60_000) / 1000);
		return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
	}
	if (ms < 86_400_000) {
		const hours = Math.floor(ms / 3_600_000);
		const mins = Math.floor((ms % 3_600_000) / 60_000);
		return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	}
	const days = Math.floor(ms / 86_400_000);
	const hours = Math.floor((ms % 86_400_000) / 3_600_000);
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
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

function copy(value: string): void {
	if (!value) return;
	copyToClipboard(value).catch(() => {
		// no clipboard reachable: nothing to report in the transcript
	});
}

// ── User message ────────────────────────────────────────────────────────

const IMAGE_TOKEN = /\[Image #\d+\]/g;

/** paste-images' `[Image #N]` tokens as `md` marks, styled as omp's composer chips. */
function imageMarks(value: string): TspSpan[] {
	if (!value.includes("[Image #")) return [];
	const seen = new Set<string>();
	for (const match of value.matchAll(IMAGE_TOKEN)) seen.add(match[0]);
	return [...seen].map((t) => ({ t, s: "accent strong" }));
}

/**
 * omp's `UserMessageComponent.describe`: a head-less user-toned card (Tern
 * draws the right-hand bubble) with the prompt as markdown, and the hover
 * toolbar's Copy (omp's `copy-message`, run here through pi's clipboard).
 */
const userMessage: Describer = {
	name: "TranscriptUserMessage",
	matches: (c) => kindOf(c) === "user",
	fingerprint: (c) => [(c as Any).text],
	build: (c) => {
		const value = String((c as Any).text ?? "");
		const marks = imageMarks(value);
		return card({ role: "omp.user", tone: "user" }, [
			row(
				[
					node(
						"icon",
						{ name: "copy", role: "omp.user.tool", title: "Copy message", aria: "Copy message", actions: { click: "copy-message" } },
						undefined,
						"copy",
					),
				],
				{ gap: "xs", align: "center", role: "omp.user.tools" },
				"tools",
			),
			md(value, marks.length > 0 ? { marks } : undefined),
		]);
	},
	handleEvent: (c, event) => {
		if (event.type === "action" && event.act === "copy-message") copy(String((c as Any).text ?? ""));
	},
};

// ── Assistant message ───────────────────────────────────────────────────

/** A visible text part, or a run of consecutive thinking parts (pi joins them into one block). */
interface Part {
	readonly kind: "text" | "thinking";
	/** First and last content index. */
	readonly start: number;
	readonly end: number;
	readonly text: string;
	/** pi's thinking run index (its `thinkingVisibilityOverrides` key); -1 for text. */
	readonly run: number;
}

function messageParts(content: readonly Any[]): Part[] {
	const parts: Part[] = [];
	let run = 0;
	for (let i = 0; i < content.length; i++) {
		const item = content[i];
		if (item?.type === "text") {
			const value = String(item.text ?? "");
			if (value.trim()) parts.push({ kind: "text", start: i, end: i, text: value, run: -1 });
		} else if (item?.type === "thinking") {
			const start = i;
			const texts: string[] = [];
			for (; i < content.length && content[i]?.type === "thinking"; i++) {
				const thinking = String(content[i]!.thinking ?? "").trim();
				if (thinking) texts.push(thinking);
			}
			i--;
			if (texts.length > 0) parts.push({ kind: "thinking", start, end: i, text: texts.join("\n\n"), run: run++ });
		}
	}
	return parts;
}

function contentOf(message: Any | undefined): Any[] {
	return Array.isArray(message?.content) ? message.content : [];
}

function assistantSignature(message: Any | undefined): string {
	if (!message) return "";
	let sig = `${message.stopReason ?? ""}|${message.errorMessage ?? ""}|${message.durationMs ?? ""}`;
	for (const part of contentOf(message)) {
		if (part?.type === "text") sig += `|t${part.text?.length ?? 0}`;
		else if (part?.type === "thinking") sig += `|k${part.thinking?.length ?? 0}`;
		else sig += `|${part?.type}`;
	}
	return sig;
}

interface ThoughtClock {
	start: number;
	end?: number;
}

/** When each thought was first seen streaming and first seen finished, per message and run start; kept across reloads (the components are pi's). */
const CLOCKS = Symbol.for("pi-extended.tsp-native.thought-clocks");
const clocks: WeakMap<Component, Map<number, ThoughtClock>> = (() => {
	const holder = globalThis as unknown as { [CLOCKS]?: WeakMap<Component, Map<number, ThoughtClock>> };
	let current = holder[CLOCKS];
	if (!(current instanceof WeakMap)) {
		current = new WeakMap();
		holder[CLOCKS] = current;
	}
	return current;
})();

/** The start index of the thinking run that is the streaming message's last part, else -1. */
function liveThinkingStart(content: readonly Any[]): number {
	let i = content.length - 1;
	if (i < 0 || content[i]?.type !== "thinking") return -1;
	let visible = false;
	for (; i >= 0 && content[i]?.type === "thinking"; i--) if (!visible && /\S/.test(String(content[i]!.thinking ?? ""))) visible = true;
	return visible ? i + 1 : -1;
}

/** Start the live thought's clock, stop every other; the returned signature changes when any clock does. */
function tickClocks(c: Component, content: readonly Any[], streaming: boolean): string {
	let map = clocks.get(c);
	const live = streaming ? liveThinkingStart(content) : -1;
	if (live >= 0 && !map?.has(live)) {
		if (!map) {
			map = new Map();
			clocks.set(c, map);
		}
		map.set(live, { start: Date.now() });
	}
	if (!map) return "";
	const now = Date.now();
	let sig = "";
	for (const [start, clock] of map) {
		if (start !== live && clock.end === undefined) clock.end = now;
		sig += `${start}${clock.end === undefined ? "~" : "."}`;
	}
	return sig;
}

/**
 * A finished thought's time: its clock when it was seen streaming; else (a
 * resumed session) a message whose only prose is this thought spent its
 * response on it.
 */
function thoughtTook(clock: ThoughtClock | undefined, message: Any, parts: readonly Part[]): number | undefined {
	if (clock?.end !== undefined) return Math.max(0, Math.round(clock.end - clock.start));
	if (clock) return undefined;
	const duration = message.durationMs;
	if (parts.length !== 1 || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return undefined;
	return Math.round(duration);
}

/** omp's "Thought for 12s" (whole seconds under a minute, then `2m5s`, `1h3m`). */
function thoughtLabel(took: number | undefined): string {
	if (took === undefined) return "Thought";
	return `Thought for ${took < 60_000 ? `${Math.max(1, Math.round(took / 1000))}s` : formatDuration(took)}`;
}

/**
 * A streaming table's last row waits for its line end (omp
 * `holdPartialTableRow`): the terminal sizes the columns by every row it gets.
 */
function holdPartialTableRow(value: string): string {
	const lastBreak = value.lastIndexOf("\n");
	if (lastBreak <= 0 || lastBreak === value.length - 1) return value;
	if (!value.slice(lastBreak + 1).trimStart().startsWith("|")) return value;
	const above = value.slice(value.lastIndexOf("\n", lastBreak - 1) + 1, lastBreak);
	return above.trimStart().startsWith("|") ? value.slice(0, lastBreak + 1) : value;
}

interface MdEntry {
	readonly text: string;
	readonly stream: boolean;
	readonly node: NativeNode;
}

interface SectionEntry {
	readonly head: NativeNode;
	readonly body: NativeNode;
	readonly live: boolean;
	readonly collapsed: boolean;
	readonly took: number | undefined;
	readonly node: NativeNode;
}

/** The nodes one build made, reused by the next while their inputs are equal (unchanged parts skip the diff). */
interface PartCache {
	readonly md: Map<string, MdEntry>;
	readonly heads: Map<number, { readonly label: string | null; readonly node: NativeNode }>;
	readonly sections: Map<number, SectionEntry>;
	usage?: { readonly summary: TurnUsage; readonly answered: boolean; readonly node: NativeNode };
}

const partCaches = new WeakMap<Component, PartCache>();

function newCache(): PartCache {
	return { md: new Map(), heads: new Map(), sections: new Map() };
}

function mdPart(prev: PartCache, next: PartCache, slot: string, key: string, source: string, stream: boolean): NativeNode {
	const cached = prev.md.get(slot);
	const entry = cached && cached.text === source && cached.stream === stream ? cached : { text: source, stream, node: node("md", stream ? { text: source, stream: true } : { text: source }, undefined, key) };
	next.md.set(slot, entry);
	return entry.node;
}

/** Live: starburst · "Thinking…" · a ticking timer (omp). One node while live, so the terminal's clock keeps running. */
function liveHead(prev: PartCache, next: PartCache, start: number, clock: ThoughtClock | undefined, cx: DescribeContext): NativeNode {
	const cached = prev.heads.get(start);
	if (cached && cached.label === null) {
		next.heads.set(start, cached);
		return cached.node;
	}
	const kids: NativeNode[] = [];
	if (cx.supports("spinner")) kids.push(node("spinner", { style: "starburst", role: "omp.thinking.spin" }));
	kids.push(text([span("Thinking…", "muted")]));
	if (cx.supports("elapsed")) kids.push(node("elapsed", { age: Math.max(0, Math.round(Date.now() - (clock?.start ?? Date.now()))), format: "short" }));
	const entry = { label: null, node: row(kids, { gap: "sm" }, "head") };
	next.heads.set(start, entry);
	return entry.node;
}

function doneHead(prev: PartCache, next: PartCache, start: number, took: number | undefined): NativeNode {
	const label = thoughtLabel(took);
	const cached = prev.heads.get(start);
	const entry = cached && cached.label === label ? cached : { label, node: node("text", { spans: [span(label, "muted")] }, undefined, "head") };
	next.heads.set(start, entry);
	return entry.node;
}

const MAX_ERROR_ROWS = 8;

/** omp `#describeError`: the truncation note, the abort label, or the failed request's error frame. */
function describeError(message: Any, hasToolCalls: boolean): NativeNode | undefined {
	if (message.stopReason === "length") return text([span("Response was truncated before completion.", "error")], { wrap: "word", role: "omp.assistant.abort" }, "error");
	if (hasToolCalls) return undefined;
	if (message.stopReason === "aborted") {
		const label = message.errorMessage && message.errorMessage !== "Request was aborted" ? String(message.errorMessage) : "Operation aborted";
		return text([span(label, "error")], { wrap: "word", role: "omp.assistant.abort" }, "error");
	}
	if (message.stopReason !== "error") return undefined;
	const lines = String(message.errorMessage || "Unknown error")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	// "500 upstream overloaded" → chip "500", then the message once: a line the next one repeats with more detail is dropped.
	const status = /^(\d{3})\s+/.exec(lines[0] ?? "");
	if (status) lines[0] = lines[0]!.slice(status[0].length);
	const detail = lines.filter((line, index) => !lines.slice(index + 1).some((later) => later.startsWith(line)));
	const errorText = detail.join("\n") || "Unknown error";
	const head: NativeNode[] = [text([span("Request failed", "error strong")])];
	if (status) head.push(node("badge", { text: status[1]!, tone: "error", role: "omp.error.code" }));
	return card(
		{ role: "omp.error", tone: "error" },
		[
			row(head, { gap: "sm" }, "head"),
			text([span(errorText, "mono")], { wrap: "word", lines: MAX_ERROR_ROWS, role: "omp.error.message" }, "message"),
			row(
				[row([text("Copy error")], { gap: "xs", role: "omp.error.action", actions: { click: "copy-error" }, title: "Copy the error message" }, "copy-error")],
				{ gap: "sm", role: "omp.error.actions" },
				"actions",
			),
		],
		"error",
	);
}

function errorText(message: Any | undefined): string {
	return String(message?.errorMessage || "Unknown error").trim();
}

function answerText(message: Any | undefined): string {
	return contentOf(message)
		.filter((part) => part?.type === "text" && String(part.text ?? "").trim())
		.map((part) => String(part.text).trim())
		.join("\n\n");
}

/** omp's turn footer: `⧉ · 12.4s · 19K tok · $0.02 this turn`, Copy only under an answer. */
function usageRow(prev: PartCache, next: PartCache, summary: TurnUsage, answered: boolean): NativeNode {
	if (prev.usage && prev.usage.summary === summary && prev.usage.answered === answered) {
		next.usage = prev.usage;
		return prev.usage.node;
	}
	const line: NativeNode[] = [];
	if (answered) {
		line.push(
			node("icon", { name: "copy", role: "omp.turn.copy", title: "Copy answer", aria: "Copy answer", actions: { click: "copy-answer" } }, undefined, "copy"),
			node("text", { text: "·" }, undefined, "dot"),
		);
	}
	line.push(node("text", { text: summary.text }, undefined, "text"));
	next.usage = { summary, answered, node: row(line, { role: "omp.turn.usage", gap: "xs", align: "center", title: summary.title }, "turn-usage") };
	return next.usage.node;
}

function overridesSignature(a: Any): string {
	const overrides = a.thinkingVisibilityOverrides;
	if (!(overrides instanceof Map) || overrides.size === 0) return "";
	let sig = "";
	for (const [run, hidden] of overrides) sig += `${run}${hidden ? "h" : "s"}`;
	return sig;
}

/**
 * omp's `AssistantMessageComponent.describe`: md parts keyed `t<index>` (the
 * streaming tail carries `stream`), each thinking run a quiet collapsible
 * section keyed `k<index>` (live: `omp.thinking.live` with a starburst and a
 * timer; done: "Thought for 12s" and `took`), folded per pi's
 * hideThinkingBlock and its per-run overrides, then the turn-ending error and
 * the turn's usage footer. A message without visible parts draws nothing.
 */
const assistantMessage: Describer = {
	name: "TranscriptAssistantMessage",
	matches: (c) => kindOf(c) === "assistant",
	fingerprint: (c, cx) => {
		const a = c as Any;
		const message: Any | undefined = a.lastMessage;
		const streaming = a.isStreaming === true;
		return [
			message,
			assistantSignature(message),
			streaming,
			a.hideThinkingBlock === true,
			overridesSignature(a),
			tickClocks(c, contentOf(message), streaming),
			turnUsage.get(c),
			cx.supports("spinner"),
			cx.supports("elapsed"),
		];
	},
	build: (c, cx) => {
		const a = c as Any;
		const message: Any | undefined = a.lastMessage;
		if (!message) return EMPTY_NODE;
		const content = contentOf(message);
		const streaming = a.isStreaming === true;
		const hide = a.hideThinkingBlock === true;
		const overrides: Map<number, boolean> | undefined = a.thinkingVisibilityOverrides instanceof Map ? a.thinkingVisibilityOverrides : undefined;
		const prev = partCaches.get(c) ?? newCache();
		const next = newCache();
		const parts = messageParts(content);
		const clockMap = clocks.get(c);
		const children: NativeChild[] = [];
		let answered = false;
		for (const part of parts) {
			const live = streaming && part.end === content.length - 1;
			if (part.kind === "text") {
				const source = (live ? holdPartialTableRow(part.text) : part.text).trim();
				if (!source) continue;
				answered = true;
				children.push(mdPart(prev, next, `t${part.start}`, `t${part.start}`, source, live));
				continue;
			}
			const clock = clockMap?.get(part.start);
			const took = live ? undefined : thoughtTook(clock, message, parts);
			const collapsed = overrides?.get(part.run) ?? hide;
			const head = live ? liveHead(prev, next, part.start, clock, cx) : doneHead(prev, next, part.start, took);
			const body = mdPart(prev, next, `k${part.start}`, "body", part.text, live);
			const cached = prev.sections.get(part.start);
			const section =
				cached && cached.head === head && cached.body === body && cached.live === live && cached.collapsed === collapsed && cached.took === took
					? cached
					: {
							head,
							body,
							live,
							collapsed,
							took,
							node: node(
								"section",
								{
									// `.live` while streaming: the body clamps to its tail under a fade.
									role: live ? "omp.thinking.live" : "omp.thinking",
									collapsible: true,
									collapsed,
									// Tern's fold head sums it into "Worked for 12s".
									took,
								},
								[head, body],
								`k${part.start}`,
							),
						};
			next.sections.set(part.start, section);
			children.push(section.node);
		}
		const error = describeError(message, content.some((part) => part?.type === "toolCall"));
		if (error) children.push(error);
		const summary = turnUsage.get(c);
		if (summary && children.length > 0) children.push(usageRow(prev, next, summary, answered));
		partCaches.set(c, next);
		if (children.length === 0) return EMPTY_NODE;
		return col(children, { role: "omp.assistant" });
	},
	handleEvent: (c, event) => {
		const a = c as Any;
		if (event.type === "action") {
			if (event.act === "copy-answer") copy(answerText(a.lastMessage));
			else if (event.act === "copy-error") copy(errorText(a.lastMessage));
			return;
		}
		// A thought folded or opened in the terminal: pi's own per-run override, so a rebuild (and the ANSI view) agree.
		if (event.type !== "toggle" || !/^k\d+$/.test(event.key)) return;
		const start = Number(event.key.slice(1));
		const part = messageParts(contentOf(a.lastMessage)).find((p) => p.kind === "thinking" && p.start === start);
		if (!part || !(a.thinkingVisibilityOverrides instanceof Map)) return;
		a.thinkingVisibilityOverrides.set(part.run, event.collapsed);
		if (a.lastMessage && typeof a.updateContent === "function") a.updateContent(a.lastMessage);
	},
};

// ── Spacers and status lines ────────────────────────────────────────────

/** A transcript Spacer: main's block gap already spaces the blocks (omp's rhythm); hidden, it is quiet. */
const transcriptSpacer: Describer = {
	name: "TranscriptSpacer",
	matches: (c) => kindOf(c) === "spacer" && blocks.has(c),
	fingerprint: () => [],
	build: () => EMPTY_NODE,
};

/** The colours pi paints its status lines in (showStatus dim, showWarning and the cache/billing notices warning). */
const QUIET_TOKENS: ReadonlySet<string> = new Set(["dim", "muted", "warning"]);
/** A quiet role (tsp-fold.js `blockKind`) that no rsttyd rule styles on a text or col. */
const NOTICE_ROLE = "omp.notice.status";

function plain(s: string): string {
	return stripAnsi(s).replaceAll("\x1b_pi:c\x07", "");
}

/** Every visible span in a quiet colour. */
function quietLine(spans: readonly TspSpan[]): boolean {
	return spans.every((sp) => sp.t.trim() === "" || (sp.s !== undefined && QUIET_TOKENS.has(sp.s.split(" ")[0]!)));
}

function lineNode(spans: readonly TspSpan[], role: string, key: string): NativeNode {
	if (spans.length === 0) return text("", { role }, key);
	if (!hasStyle(spans)) return text(spans.map((sp) => sp.t).join(""), { role, wrap: "word" }, key);
	return text(spans, { role, wrap: "word" }, key);
}

/**
 * A Text block in the transcript, drawn as the plain Text describer draws it
 * (theme colours as span tokens) without its vertical padding (the block gap
 * spaces it); a line wholly in a status colour carries a quiet notice role,
 * so pi's status, warning and cache notices fold with the run around them.
 * Errors and anything else stay breaks.
 */
const transcriptText: Describer = {
	name: "TranscriptText",
	matches: (c) => kindOf(c) === "text" && blocks.has(c),
	fingerprint: (c) => {
		const a = c as Any;
		// ThemedText rebuilds its string lazily in render(): ask for it once so `text` is current.
		if (a.stale === true && typeof a.build === "function") {
			a.stale = false;
			a.setText?.(a.build());
		}
		return [a.text, spansThemeId()];
	},
	build: (c) => {
		const raw = String((c as Any).text ?? "").replaceAll("\x1b_pi:c\x07", "");
		if (plain(raw).trim() === "") return EMPTY_NODE;
		const lines = raw.split("\n").map(lineToSpans);
		const quiet = lines.every(quietLine);
		if (lines.length === 1) return lineNode(lines[0]!, quiet ? NOTICE_ROLE : "pi.text", "t");
		return col(
			lines.map((spans, i) => lineNode(spans, "pi.text", `l${i}`)),
			{ role: quiet ? NOTICE_ROLE : "pi.text" },
			"t",
		);
	},
};

/** Registered first (describers.ts): they win over the generic user/assistant/Text/Spacer describers. */
export const TRANSCRIPT_DESCRIBERS: readonly Describer[] = [userMessage, assistantMessage, transcriptText, transcriptSpacer];

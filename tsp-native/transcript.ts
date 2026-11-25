import { AssistantMessageComponent, copyToClipboard, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Container, ScrollView, Spacer, Text } from "@earendil-works/pi-tui";
import type { Describer } from "./describers.ts";
import { card, col, type DescribeContext, EMPTY_NODE, md, type NativeChild, type NativeNode, node, row, span, stripAnsi, text } from "./node.ts";
import { hasStyle, lineToSpans, spansThemeId } from "./spans.ts";
import type { TspSpan } from "./wire.ts";

type Any = Record<string, any>;

function is(component: Component, ctor: Function | undefined, name: string): boolean {
	if (ctor && component instanceof ctor) return true;
	for (let proto = Object.getPrototypeOf(component); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		if (proto.constructor?.name === name) return true;
	}
	return false;
}

const LAYOUT_DEPTH = 2;

function isPlainContainer(c: Component): boolean {
	const ctor = (c as Any).constructor;
	return (ctor === Container || ctor?.name === "Container") && Array.isArray((c as Any).children);
}

function scrolledContent(c: Component): Component | undefined {
	if (!is(c, ScrollView, "ScrollView")) return undefined;
	const child = (c as Any).child;
	return child && typeof child.render === "function" ? (child as Component) : undefined;
}

/**
 * The terminal expects each transcript block to be a direct child of main.
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

interface TurnUsage {
	readonly elapsedMs: number | undefined;
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
		// Cache reads can count the same context again on each request.
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

function formatTurnUsage(elapsedMs: number | undefined, input: number, output: number, cost: number): { text: string; title: string } {
	const tokens = input + output;
	const money = cost > 0 ? (cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}`) : undefined;
	const time = elapsedMs === undefined ? undefined : formatDuration(elapsedMs);
	const line = [time, `${formatNumber(tokens)} tok`, money].filter((part) => part !== undefined).join(" · ");
	const exact = `${tokens.toLocaleString("en-US")} tokens (${input.toLocaleString("en-US")} in · ${output.toLocaleString("en-US")} out)`;
	const title = [time, exact, money].filter((part) => part !== undefined).join(" · ");
	return { text: `${line} this turn`, title: `This turn: ${title}` };
}

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
		// The clipboard may be unavailable.
	});
}

const IMAGE_TOKEN = /\[Image #\d+\]/g;

function imageMarks(value: string): TspSpan[] {
	if (!value.includes("[Image #")) return [];
	const seen = new Set<string>();
	for (const match of value.matchAll(IMAGE_TOKEN)) seen.add(match[0]);
	return [...seen].map((t) => ({ t, s: "accent strong" }));
}

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

interface Part {
	readonly kind: "text" | "thinking";
	readonly start: number;
	readonly end: number;
	readonly text: string;
	/**
	 * Thinking run indexes must match pi's visibility overrides.
	 */
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

function liveThinkingStart(content: readonly Any[]): number {
	let i = content.length - 1;
	if (i < 0 || content[i]?.type !== "thinking") return -1;
	let visible = false;
	for (; i >= 0 && content[i]?.type === "thinking"; i--) if (!visible && /\S/.test(String(content[i]!.thinking ?? ""))) visible = true;
	return visible ? i + 1 : -1;
}

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

function thoughtTook(clock: ThoughtClock | undefined, message: Any, parts: readonly Part[]): number | undefined {
	if (clock?.end !== undefined) return Math.max(0, Math.round(clock.end - clock.start));
	if (clock) return undefined;
	const duration = message.durationMs;
	if (parts.length !== 1 || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return undefined;
	return Math.round(duration);
}

function thoughtLabel(took: number | undefined): string {
	if (took === undefined) return "Thought";
	return `Thought for ${took < 60_000 ? `${Math.max(1, Math.round(took / 1000))}s` : formatDuration(took)}`;
}

/**
 * The terminal sizes table columns from incomplete rows too.
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

/**
 * Keep the live node stable to avoid resetting the terminal's timer.
 */
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
									// The terminal uses the live role to clip the body to its tail.
									role: live ? "omp.thinking.live" : "omp.thinking",
									collapsible: true,
									collapsed,
									// The terminal sums these milliseconds in the fold heading.
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
		if (event.type !== "toggle" || !/^k\d+$/.test(event.key)) return;
		const start = Number(event.key.slice(1));
		const part = messageParts(contentOf(a.lastMessage)).find((p) => p.kind === "thinking" && p.start === start);
		if (!part || !(a.thinkingVisibilityOverrides instanceof Map)) return;
		a.thinkingVisibilityOverrides.set(part.run, event.collapsed);
		if (a.lastMessage && typeof a.updateContent === "function") a.updateContent(a.lastMessage);
	},
};

const transcriptSpacer: Describer = {
	name: "TranscriptSpacer",
	matches: (c) => kindOf(c) === "spacer" && blocks.has(c),
	fingerprint: () => [],
	build: () => EMPTY_NODE,
};

/**
 * pi distinguishes status lines by colour.
 */
const QUIET_TOKENS: ReadonlySet<string> = new Set(["dim", "muted", "warning"]);
/**
 * The terminal folds this role with surrounding blocks.
 */
const NOTICE_ROLE = "omp.notice.status";

function plain(s: string): string {
	return stripAnsi(s).replaceAll("\x1b_pi:c\x07", "");
}

function quietLine(spans: readonly TspSpan[]): boolean {
	return spans.every((sp) => sp.t.trim() === "" || (sp.s !== undefined && QUIET_TOKENS.has(sp.s.split(" ")[0]!)));
}

function warningLines(lines: readonly (readonly TspSpan[])[]): boolean {
	let seen = false;
	for (const spans of lines) {
		for (const sp of spans) {
			if (sp.t.trim() === "") continue;
			if (sp.s?.split(" ")[0] !== "warning") return false;
			seen = true;
		}
	}
	return seen;
}

const WARNING_LABEL = /^\s*Warning:\s*/;

function warningRow(lines: readonly (readonly TspSpan[])[], key: string): NativeNode {
	let message: TspSpan[] = [];
	lines.forEach((spans, i) => {
		if (i > 0) message.push({ t: "\n" });
		for (const sp of spans) {
			const rest = sp.s?.split(" ").filter((token) => token !== "warning") ?? [];
			message.push(rest.length > 0 ? { ...sp, s: rest.join(" ") } : { t: sp.t });
		}
	});
	const visible = (sp: TspSpan) => sp.t.trim() !== "";
	const first = message.findIndex(visible);
	let end = message.length;
	while (end > first + 1 && !visible(message[end - 1]!)) end--;
	message = message.slice(first, end);
	const unlabelled = message[0]!.t.replace(WARNING_LABEL, "");
	if (unlabelled !== "") message[0] = { ...message[0]!, t: unlabelled };
	else if (message.slice(1).some(visible)) message = message.slice(message.findIndex((sp, i) => i > 0 && visible(sp)));
	return row(
		[
			node("icon", { name: "warning", tone: "warning", aria: "Warning" }, undefined, "icon"),
			text(hasStyle(message) ? message : message.map((sp) => sp.t).join(""), { wrap: "word", grow: 1 }, "text"),
		],
		{ role: "omp.notice.warning", tone: "warning", gap: "sm", align: "start" },
		key,
	);
}

function lineNode(spans: readonly TspSpan[], role: string, key: string): NativeNode {
	if (spans.length === 0) return text("", { role }, key);
	if (!hasStyle(spans)) return text(spans.map((sp) => sp.t).join(""), { role, wrap: "word" }, key);
	return text(spans, { role, wrap: "word" }, key);
}

const transcriptText: Describer = {
	name: "TranscriptText",
	matches: (c) => kindOf(c) === "text" && blocks.has(c),
	fingerprint: (c, cx) => {
		const a = c as Any;
		// pi rebuilds themed text lazily during render.
		if (a.stale === true && typeof a.build === "function") {
			a.stale = false;
			a.setText?.(a.build());
		}
		return [a.text, spansThemeId(), cx.supports("icon")];
	},
	build: (c, cx) => {
		const raw = String((c as Any).text ?? "").replaceAll("\x1b_pi:c\x07", "");
		if (plain(raw).trim() === "") return EMPTY_NODE;
		const lines = raw.split("\n").map(lineToSpans);
		if (cx.supports("icon") && warningLines(lines)) return warningRow(lines, "t");
		const quiet = lines.every(quietLine);
		if (lines.length === 1) return lineNode(lines[0]!, quiet ? NOTICE_ROLE : "pi.text", "t");
		return col(
			lines.map((spans, i) => lineNode(spans, "pi.text", `l${i}`)),
			{ role: quiet ? NOTICE_ROLE : "pi.text" },
			"t",
		);
	},
};

/**
 * Match these before the generic component describers.
 */
export const TRANSCRIPT_DESCRIBERS: readonly Describer[] = [userMessage, assistantMessage, transcriptText, transcriptSpacer];

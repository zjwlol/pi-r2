import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bottomBorder, boxRow, formatKey, GLYPH, keyHint, topBorder } from "./chrome.ts";
import { describeInjectAnswer, renderInjectAnswer } from "./inject-view.ts";
import {
	col,
	type DescribeCx,
	HIDDEN,
	hintsRow,
	md,
	type NativeHint,
	type NativeNode,
	node,
	span,
	statusHintsRow,
	text,
} from "./native.ts";
import {
	type InjectParts,
	replaceTabs,
	sanitizeDisplayLine,
	sanitizeDisplayText,
	sanitizeErrorLine,
	splitInject,
} from "./records.ts";

export type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

export interface BtwPanelOptions {
	question: string;
	title?: string;
	theme: () => Theme;
	requestRender: () => void;
	canBranch?: () => boolean;
	canFollowUp?: () => boolean;
	canInject?: () => boolean;
	injectKey: string;
	maxBodyRows?: () => number;
}

const WAITING = `${GLYPH.pending} Waiting for response…`;
const NO_TEXT = "No text returned.";
const COPIED = `${GLYPH.check} Copied to clipboard`;
const BRANCHING = `${GLYPH.pending} Branching to chat…`;

function interruptKey(): string {
	try {
		const keys = (getKeybindings() as unknown as { getKeys(action: string): readonly string[] }).getKeys("app.interrupt");
		return keys[0] ?? "escape";
	} catch {
		return "escape";
	}
}

export class BtwPanel implements Component {
	private readonly options: BtwPanelOptions;
	private readonly baseTitle: string;
	private state: BtwPanelState = "running";
	private answer = "";
	private visibleAnswer = "";
	private errorMessage: string | undefined;
	private closed = false;
	private copied = false;
	private injected = false;
	private version = 0;
	private markdown: Markdown | undefined;
	private body: { version: number; width: number; lines: string[] } | undefined;
	private native:
		| { node: NativeNode; canFollowUp: boolean; canBranch: boolean; injectKey: string | undefined; spinner: boolean }
		| undefined;

	constructor(options: BtwPanelOptions) {
		this.options = options;
		this.baseTitle = sanitizeDisplayLine(options.title ?? `/btw ${options.question}`)
			.replace(/\s+/g, " ")
			.trim();
	}

	appendText(delta: string): void {
		if (!delta || this.closed) return;
		this.answer += delta;
		this.visibleAnswer = replaceTabs(this.answer).trim();
		this.copied = false;
		this.rebuild();
	}

	setAnswer(text: string): void {
		if (this.closed) return;
		this.answer = text;
		this.visibleAnswer = replaceTabs(text).trim();
		this.copied = false;
		this.rebuild();
	}

	markComplete(): void {
		this.transition("complete", undefined);
	}

	markCopied(): void {
		if (this.closed || !this.isCopyable()) return;
		this.copied = true;
		this.rebuild();
	}

	setInjected(injected: boolean): void {
		if (this.closed || this.injected === injected) return;
		this.injected = injected;
		this.rebuild();
	}

	markBranching(): void {
		this.transition("branching", undefined);
	}

	markAborted(): void {
		this.transition("aborted", undefined);
	}

	markError(message: string): void {
		this.transition("error", message);
	}

	isBranchable(): boolean {
		return this.isCopyable();
	}

	isCopyable(): boolean {
		return this.state === "complete" && this.visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		return this.isCopyable() ? this.visibleAnswer : undefined;
	}

	close(): void {
		this.closed = true;
	}

	invalidate(): void {
		this.markdown = undefined;
		this.body = undefined;
		this.native = undefined;
	}

	render(width: number): string[] {
		width = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		if (width === 0) return [];
		const theme = this.options.theme();
		const inner = Math.max(1, width - 4);
		const title = this.copied ? `${this.baseTitle} ${GLYPH.check} Copied` : this.baseTitle;
		const lines = [topBorder(theme, width, title), boxRow(theme, "", width)];
		for (const line of this.guardedBody(theme, inner)) lines.push(boxRow(theme, line, width));
		lines.push(boxRow(theme, "", width));
		for (const line of wrapTextWithAnsi(this.footerLine(theme), inner)) lines.push(boxRow(theme, line, width));
		lines.push(bottomBorder(theme, width));
		return lines;
	}

	describe(cx: DescribeCx): NativeNode {
		const canFollowUp = this.options.canFollowUp?.() ?? false;
		const canBranch = this.options.canBranch?.() ?? this.isBranchable();
		const injectKey = this.activeInjectKey();
		const live = this.state === "running" || this.state === "branching";
		const spinner = live && cx.supports("spinner");
		// The reconciler skips nodes with unchanged references.
		const memo = this.native;
		if (
			memo &&
			memo.canFollowUp === canFollowUp &&
			memo.canBranch === canBranch &&
			memo.injectKey === injectKey &&
			memo.spinner === spinner
		) {
			return memo.node;
		}
		const space = this.baseTitle.indexOf(" ");
		const command = space === -1 ? this.baseTitle : this.baseTitle.slice(0, space);
		const rest = space === -1 ? "" : this.baseTitle.slice(space);
		const title = text([span(command, "accent"), ...(rest ? [span(rest)] : [])], { truncate: "end", lines: 1 });
		const head = node("row", { role: "omp.sheet.head", gap: "sm", align: "center" }, [
			...(spinner ? [node("spinner", {})] : []),
			title,
		]);
		const tone = this.state === "error" ? "error" : this.state === "aborted" ? "warning" : undefined;
		const described = col([head, this.describeBody(), this.describeFooter(canFollowUp, canBranch, injectKey)], {
			role: "omp.overlay.btw",
			gap: "sm",
			...(tone ? { tone } : {}),
		});
		this.native = { node: described, canFollowUp, canBranch, injectKey, spinner };
		return described;
	}

	private transition(state: BtwPanelState, errorMessage: string | undefined): void {
		if (this.closed) return;
		this.state = state;
		this.errorMessage = errorMessage;
		this.copied = false;
		this.rebuild();
	}

	private rebuild(): void {
		this.version++;
		this.native = undefined;
		this.options.requestRender();
	}

	private injectParts(): InjectParts | undefined {
		const parts = this.options.canInject ? splitInject(this.visibleAnswer) : undefined;
		return parts && (parts.closed || this.state === "running") ? parts : undefined;
	}

	private activeInjectKey(): string | undefined {
		return this.options.canInject?.() ? this.options.injectKey : undefined;
	}

	private bodyLines(theme: Theme, width: number): string[] {
		const cached = this.body;
		if (cached && cached.version === this.version && cached.width === width) return cached.lines;
		let lines: string[];
		if (this.state === "error") {
			lines = wrapTextWithAnsi(theme.fg("error", sanitizeErrorLine(this.errorMessage ?? "Unknown error")), width);
		} else if (!this.visibleAnswer) {
			lines = wrapTextWithAnsi(theme.fg("dim", this.state === "running" ? WAITING : NO_TEXT), width);
		} else {
			const parts = this.injectParts();
			if (parts) {
				lines = renderInjectAnswer(theme, parts, this.injected, width);
			} else {
				this.markdown ??= new Markdown("", 0, 0, getMarkdownTheme());
				this.markdown.setText(sanitizeDisplayText(this.visibleAnswer));
				lines = this.markdown.render(width);
			}
		}
		this.body = { version: this.version, width, lines };
		return lines;
	}

	private guardedBody(theme: Theme, width: number): string[] {
		const lines = this.bodyLines(theme, width);
		const budget = this.options.maxBodyRows?.();
		if (budget === undefined || !Number.isFinite(budget)) return lines;
		const max = Math.max(2, Math.floor(budget));
		if (lines.length <= max) return lines;
		const keep = max - 1;
		const hidden = lines.length - keep;
		const more = theme.fg("dim", `… +${hidden} more line${hidden === 1 ? "" : "s"} · /btw to read it all`);
		return this.state === "running" ? [more, ...lines.slice(-keep)] : [...lines.slice(0, keep), more];
	}

	private footerLine(theme: Theme): string {
		const esc = interruptKey();
		switch (this.state) {
			case "running":
				return keyHint(theme, esc, "to cancel");
			case "complete": {
				const hints: string[] = [];
				const injectKey = this.activeInjectKey();
				if (injectKey) hints.push(keyHint(theme, injectKey, "to inject"));
				if (this.isCopyable()) hints.push(keyHint(theme, "c", this.copied ? "to copy again" : "to copy"));
				if (this.options.canFollowUp?.()) hints.push(keyHint(theme, "f", "to follow up"));
				if (this.options.canBranch?.() ?? this.isBranchable()) hints.push(keyHint(theme, "b", "to branch"));
				hints.push(keyHint(theme, esc, "to close"));
				const separator = theme.fg("muted", " · ");
				const joined = hints.join(separator);
				return this.copied ? `${theme.fg("success", COPIED)}${separator}${joined}` : joined;
			}
			case "branching":
				return theme.fg("muted", BRANCHING);
			case "aborted":
				return theme.fg("warning", `${GLYPH.warning} Cancelled · ${formatKey(esc)} to close`);
			case "error":
				return theme.fg("error", `${GLYPH.error} Error · ${formatKey(esc)} to close`);
		}
	}

	private describeBody(): NativeNode {
		if (this.state === "error") {
			return text([span(sanitizeErrorLine(this.errorMessage ?? "Unknown error"), "error")], { wrap: "word" });
		}
		const stream = this.state === "running";
		const parts = this.injectParts();
		if (parts) return describeInjectAnswer(parts, this.injected, stream);
		if (this.visibleAnswer) return md(this.visibleAnswer, { stream });
		return text([span(stream ? WAITING : NO_TEXT, "dim")]);
	}

	private describeFooter(canFollowUp: boolean, canBranch: boolean, injectKey: string | undefined): NativeNode {
		const esc: NativeHint = { keys: [interruptKey()], label: "to close" };
		switch (this.state) {
			case "running":
				return hintsRow([{ ...esc, label: "to cancel" }]);
			case "complete": {
				const hints: NativeHint[] = [];
				if (injectKey) hints.push({ keys: [injectKey], label: "to inject" });
				if (this.isCopyable()) hints.push({ keys: ["c"], label: this.copied ? "to copy again" : "to copy" });
				if (canFollowUp) hints.push({ keys: ["f"], label: "to follow up" });
				if (canBranch) hints.push({ keys: ["b"], label: "to branch" });
				hints.push(esc);
				if (!this.copied) return hintsRow(hints);
				return statusHintsRow([span(COPIED, "success")], hints);
			}
			case "branching":
				return text([span(BRANCHING, "muted")]);
			case "aborted":
				return statusHintsRow([span(`${GLYPH.warning} Cancelled`, "warning")], [esc]);
			case "error":
				return statusHintsRow([span(`${GLYPH.error} Error`, "error")], [esc]);
		}
	}
}

export class BtwDock implements Component {
	private current: BtwPanel | undefined;
	private painted: "ansi" | "native" | undefined;

	show(panel: BtwPanel | undefined): void {
		this.current = panel;
	}

	get panel(): BtwPanel | undefined {
		return this.current;
	}

	lastPaint(): "ansi" | "native" | undefined {
		return this.painted;
	}

	render(width: number): string[] {
		this.painted = "ansi";
		return this.current ? this.current.render(width) : [];
	}

	invalidate(): void {
		this.current?.invalidate();
	}

	describe(cx: DescribeCx): NativeNode {
		this.painted = "native";
		return this.current ? this.current.describe(cx) : HIDDEN;
	}
}

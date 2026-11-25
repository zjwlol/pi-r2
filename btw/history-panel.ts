import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	isKeyRelease,
	type Keybinding,
	type KeyId,
	Markdown,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	bottomBorder,
	boxRow,
	clampScroll,
	fullStamp,
	GLYPH,
	isSameLocalDay,
	keyHint,
	listStamp,
	listWindow,
	pad,
	paneWidths,
	STATUS,
	timeStamp,
	topBorder,
} from "./chrome.ts";
import { describeInjectAnswer, renderInjectAnswer } from "./inject-view.ts";
import {
	actionBar,
	actionButton,
	col,
	type DescribeCx,
	md,
	type NativeChild,
	type NativeNode,
	type NativeUiEvent,
	node,
	span,
	type TspSpan,
	text,
} from "./native.ts";
import {
	type BtwRecord,
	type BtwTurn,
	getCopyText,
	getDisplayTurns,
	getLatestTurn,
	getTopicLabel,
	getTurns,
	type InjectParts,
	sanitizeDisplayLine,
	sanitizeDisplayText,
	sanitizeErrorLine,
	splitInject,
} from "./records.ts";

export interface BtwHistoryInject {
	state(record: BtwRecord, turnIndex: number): "pending" | "sent" | undefined;
	canSend(record: BtwRecord): boolean;
	send(record: BtwRecord): void;
}

export interface BtwHistoryPanelOptions {
	records: readonly BtwRecord[];
	theme: Theme;
	onClose(): void;
	onCopy(record: BtwRecord): void;
	onCancel(record: BtwRecord): void;
	canFollowUp?(record: BtwRecord): boolean;
	canBranch?(record: BtwRecord): boolean;
	onBranch?(record: BtwRecord): void;
	/**
	 * The signal aborts when the draft is dropped.
	 */
	onFollowUp?(record: BtwRecord, question: string, signal: AbortSignal): Promise<boolean>;
	onDispose?(): void;
	requestRender(): void;
	getHeight(): number;
	escapeHides?: boolean;
	inject?: BtwHistoryInject;
	injectKey: string;
}

type InjectState = "pending" | "sent";

interface InjectBlock {
	parts: InjectParts;
	state: InjectState;
}

interface FollowUpComposer {
	recordId: string;
	input: Input;
	abortController: AbortController;
	notice?: string;
}

interface RenderedTurn {
	turn: Pick<BtwTurn, "question" | "answer" | "status" | "error" | "createdAt">;
	question: Markdown;
	answer: Markdown;
	block: InjectState | undefined;
	lines: readonly string[];
	width: number;
}

interface NativeMemo {
	records: readonly BtwRecord[];
	selectedId: string | undefined;
	focus: "list" | "answer";
	focused: boolean;
	composer: FollowUpComposer | undefined;
	notice: string | undefined;
	followUpPending: boolean;
	canFollowUp: boolean;
	canBranch: boolean;
	copied: boolean;
	canInject: boolean;
	latestInject: InjectState | undefined;
	node: NativeNode;
}

const SHEET = { role: "omp.overlay.btwHistory", anchor: "center", size: "lg", head: "BTW history" } as const;
const EMPTY_SHEET = { role: "omp.overlay.btwHistory", anchor: "center", size: "md", head: "BTW history" } as const;

const NOTICE = {
	empty: "Enter a follow-up question.",
	busy: "A BTW request is busy. Try again when it finishes.",
	starting: "Starting follow-up…",
	refused: "Follow-up was not started. Your draft is kept; enter to retry.",
	failed: "Could not start the follow-up. Your draft is kept; enter to retry.",
} as const;

const FAST_SCROLL_ROWS = 5;

function bound(data: string, action: Keybinding, fallback: KeyId): boolean {
	try {
		if (getKeybindings().matches(data, action)) return true;
	} catch {
		// pi may not have initialized keybindings yet.
	}
	return matchesKey(data, fallback);
}

const isCancel = (data: string): boolean => bound(data, "tui.select.cancel", "escape");
const isUp = (data: string): boolean => bound(data, "tui.select.up", "up");
const isDown = (data: string): boolean => bound(data, "tui.select.down", "down");
const isPageUp = (data: string): boolean => bound(data, "tui.select.pageUp", "pageUp");
const isPageDown = (data: string): boolean => bound(data, "tui.select.pageDown", "pageDown");

function fit(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

function cut(line: string, width: number): string {
	return width > 0 ? truncateToWidth(line, width, "…") : "";
}

function viewport(theme: Theme, rows: readonly string[], width: number, height: number, total: number, offset: number): string[] {
	const overflow = total > height && width > 0 && height > 0;
	const contentWidth = overflow ? width - 1 : width;
	let thumbStart = 0;
	let thumbEnd = 0;
	if (overflow) {
		const size = Math.max(1, Math.min(Math.floor((height * height) / total), height));
		const maxOffset = total - height;
		thumbStart = Math.round((clampScroll(offset, total, height) / maxOffset) * (height - size));
		thumbEnd = thumbStart + size;
	}
	const out: string[] = [];
	for (let index = 0; index < height; index++) {
		const line = pad(rows[index] ?? "", contentWidth);
		if (!overflow) out.push(line);
		else out.push(line + (index >= thumbStart && index < thumbEnd ? theme.fg("accent", "█") : theme.fg("muted", "│")));
	}
	return out;
}

function packHints(theme: Theme, hints: readonly string[], width: number): string[] {
	const separator = theme.fg("muted", " · ");
	const rows: string[] = [];
	let current = "";
	let used = 0;
	for (const hint of hints) {
		const size = visibleWidth(hint);
		if (current && used + 3 + size <= width) {
			current += separator + hint;
			used += 3 + size;
			continue;
		}
		if (current) rows.push(current);
		current = size > width ? cut(hint, width) : hint;
		used = Math.min(size, width);
	}
	if (current) rows.push(current);
	return rows;
}

function describeStatus(status: BtwTurn["status"]): TspSpan[] | undefined {
	switch (status) {
		case "running":
			return [span("●", "accent", { fx: "pulse" }), span(" Answering", "accent")];
		case "cancelled":
			return [span("Cancelled", "warning")];
		case "error":
			return [span("Failed", "error")];
		case "interrupted":
			return [span("Interrupted", "warning")];
		case "complete":
			return undefined;
	}
}

export class BtwHistoryPanel implements Component, Focusable {
	focused = false;

	private readonly options: BtwHistoryPanelOptions;
	private readonly theme: Theme;
	private records: readonly BtwRecord[];
	private selectedId: string | undefined;
	private focus: "list" | "answer" = "list";
	private listScroll = 0;
	private listPage = 1;
	private composer: FollowUpComposer | undefined;
	private followUpPending = false;
	private disposed = false;
	private copiedId: string | undefined;
	private copiedText: string | undefined;

	private turns: RenderedTurn[] = [];
	private detailLines: string[] = [];
	private detailRecord: BtwRecord | undefined;
	private detailWidth = 0;
	private detailDirty = true;
	private detailCopied = false;
	private detailInject: InjectState | undefined;
	private detailScroll = 0;
	private followLatest = false;
	private detailTotal = 0;
	private detailRows = 1;

	private bodyTop = 0;
	private bodyRows = 1;
	private wide = false;
	private leftWidth = 0;

	private native: NativeMemo | undefined;

	constructor(options: BtwHistoryPanelOptions) {
		this.options = options;
		this.theme = options.theme;
		this.records = options.records;
		this.selectedId = options.records[0]?.id;
		if (options.records.length === 1) this.focus = "answer";
	}

	update(records: readonly BtwRecord[]): void {
		this.records = records;
		this.detailDirty = true;
		const copied = this.copiedId !== undefined ? records.find((record) => record.id === this.copiedId) : undefined;
		if (!copied || getCopyText(copied) !== this.copiedText) {
			this.copiedId = undefined;
			this.copiedText = undefined;
		}
		const composer = this.composer;
		if (composer && !records.some((record) => record.id === composer.recordId)) {
			composer.abortController.abort();
			this.composer = undefined;
		}
		if (!records.some((record) => record.id === this.selectedId)) {
			this.selectedId = records[0]?.id;
			this.listScroll = 0;
			this.followLatest = false;
			this.detailScroll = 0;
		}
		if (records.length === 1) this.focus = "answer";
		this.options.requestRender();
	}

	markCopied(recordId: string, text: string): void {
		this.copiedId = recordId;
		this.copiedText = text;
		this.detailDirty = true;
		this.options.requestRender();
	}

	openFollowUp(recordId: string): boolean {
		if (this.composer || this.disposed) return false;
		const index = this.records.findIndex((record) => record.id === recordId);
		const record = this.records[index];
		if (!record || !this.canFollowUp(record)) return false;
		this.select(index);
		this.openComposer(record);
		return true;
	}

	showRecord(recordId: string): void {
		const index = this.records.findIndex((record) => record.id === recordId);
		if (index === -1) return;
		this.select(index);
		this.focus = "answer";
		this.options.requestRender();
	}

	invalidate(): void {
		this.detailRecord = undefined;
		this.turns = [];
		this.detailDirty = true;
		this.composer?.input.invalidate();
		this.native = undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.composer?.abortController.abort();
		this.composer = undefined;
		this.options.onDispose?.();
	}

	private selectedIndex(): number {
		return Math.max(
			0,
			this.records.findIndex((record) => record.id === this.selectedId),
		);
	}

	private selected(): BtwRecord | undefined {
		return this.records[this.selectedIndex()];
	}

	private select(index: number): void {
		const record = this.records[Math.max(0, Math.min(index, this.records.length - 1))];
		if (!record || record.id === this.selectedId) return;
		this.selectedId = record.id;
		this.followLatest = false;
		this.detailScroll = 0;
	}

	private canFollowUp(record: BtwRecord): boolean {
		return !this.followUpPending && !!this.options.onFollowUp && !!this.options.canFollowUp?.(record);
	}

	private isCopied(record: BtwRecord): boolean {
		return record.id === this.copiedId && getCopyText(record) === this.copiedText;
	}

	private runningRecord(record: BtwRecord | undefined): BtwRecord | undefined {
		return record !== undefined && getLatestTurn(record).status === "running" ? record : undefined;
	}

	private openComposer(record: BtwRecord): void {
		const input = new Input({
			prompt: this.theme.fg("accent", "Follow up: "),
			placeholder: "Ask about this answer…",
			placeholderStyle: (value) => this.theme.fg("dim", value),
		});
		const composer: FollowUpComposer = { recordId: record.id, input, abortController: new AbortController() };
		input.onEscape = () => {
			composer.abortController.abort();
			if (this.composer === composer) this.composer = undefined;
		};
		input.onSubmit = (value) => {
			void this.submitFollowUp(composer, value);
		};
		this.composer = composer;
		this.focus = "answer";
		this.followLatest = true;
		this.options.requestRender();
	}

	private async submitFollowUp(composer: FollowUpComposer, value: string): Promise<void> {
		if (this.followUpPending || this.composer !== composer) return;
		const question = value.trim();
		if (!question) {
			composer.notice = NOTICE.empty;
			this.options.requestRender();
			return;
		}
		const record = this.records.find((entry) => entry.id === composer.recordId);
		const onFollowUp = this.options.onFollowUp;
		if (!record || !onFollowUp || !this.canFollowUp(record)) {
			composer.notice = NOTICE.busy;
			this.options.requestRender();
			return;
		}
		this.followUpPending = true;
		composer.notice = NOTICE.starting;
		this.options.requestRender();
		try {
			const accepted = await onFollowUp(record, question, composer.abortController.signal);
			if (this.composer !== composer) return;
			if (accepted) {
				this.composer = undefined;
				this.selectedId = composer.recordId;
				this.focus = "answer";
				this.followLatest = true;
				this.detailDirty = true;
			} else {
				composer.notice = NOTICE.refused;
			}
		} catch {
			if (this.composer === composer) composer.notice = NOTICE.failed;
		} finally {
			this.followUpPending = false;
			if (!this.disposed) this.options.requestRender();
		}
	}

	private sendInject(record: BtwRecord | undefined): void {
		const inject = this.options.inject;
		if (!record || !inject?.canSend(record)) return;
		inject.send(record);
		this.detailDirty = true;
		this.options.requestRender();
	}

	private injectBlock(record: BtwRecord, turn: BtwTurn, index: number): InjectBlock | undefined {
		const inject = this.options.inject;
		const parts = inject ? splitInject(turn.answer) : undefined;
		if (!inject || !parts) return undefined;
		const state = turn.status === "running" ? "pending" : parts.closed ? inject.state(record, index) : undefined;
		return state ? { parts, state } : undefined;
	}

	private latestInject(record: BtwRecord | undefined): InjectState | undefined {
		return record ? this.options.inject?.state(record, getTurns(record).length - 1) : undefined;
	}

	handleInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		const composer = this.composer;
		if (composer) {
			// Take scroll keys first because pi's input cannot report unhandled keys.
			if (!this.scrollDetail(data, false)) composer.input.handleInput(data);
			this.options.requestRender();
			return;
		}
		const record = this.selected();
		const running = this.runningRecord(record);
		const hides = this.options.escapeHides === true;
		if (isCancel(data)) {
			if (running && !hides) this.options.onCancel(running);
			else this.options.onClose();
			return;
		}
		if (hides && matchesKey(data, "x")) {
			if (running) this.options.onCancel(running);
			return;
		}
		if (matchesKey(data, "f") || matchesKey(data, "enter")) {
			if (record) this.openFollowUp(record.id);
			return;
		}
		if (matchesKey(data, "c")) {
			if (record && getCopyText(record) !== undefined) this.options.onCopy(record);
			return;
		}
		if (matchesKey(data, "b")) {
			if (record && this.options.canBranch?.(record)) this.options.onBranch?.(record);
			return;
		}
		if (this.options.inject && matchesKey(data, this.options.injectKey as KeyId)) {
			this.sendInject(record);
			return;
		}
		// Legacy terminals can send \x1f for Ctrl+/ and Ctrl+_.
		if (
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab") ||
			matchesKey(data, "ctrl+/") ||
			matchesKey(data, "ctrl+_") ||
			data === "\x1f"
		) {
			if (this.records.length > 1) this.focus = this.focus === "list" ? "answer" : "list";
		} else if (matchesKey(data, "right")) {
			this.focus = "answer";
		} else if (matchesKey(data, "left")) {
			if (this.records.length > 1) this.focus = "list";
		} else if (this.focus === "list") {
			const index = this.selectedIndex();
			if (isUp(data)) this.select(index - 1);
			else if (isDown(data)) this.select(index + 1);
			else if (isPageUp(data)) this.select(index - this.listPage);
			else if (isPageDown(data)) this.select(index + this.listPage);
			else if (matchesKey(data, "home")) this.select(0);
			else if (matchesKey(data, "end")) this.select(this.records.length - 1);
			else return;
		} else if (!this.scrollDetail(data, true)) {
			return;
		}
		this.options.requestRender();
	}

	private scrollDetail(data: string, edges: boolean): boolean {
		const page = Math.max(1, this.detailRows - 1);
		let next: number;
		let end = false;
		if (matchesKey(data, "shift+up")) next = this.detailScroll - FAST_SCROLL_ROWS;
		else if (matchesKey(data, "shift+down")) next = this.detailScroll + FAST_SCROLL_ROWS;
		else if (isUp(data)) next = this.detailScroll - 1;
		else if (isDown(data)) next = this.detailScroll + 1;
		else if (isPageUp(data)) next = this.detailScroll - page;
		else if (isPageDown(data)) next = this.detailScroll + page;
		else if (edges && matchesKey(data, "home")) next = 0;
		else if (edges && matchesKey(data, "end")) {
			next = Number.MAX_SAFE_INTEGER;
			end = true;
		} else return false;
		this.detailScroll = clampScroll(next, this.detailTotal, this.detailRows);
		this.followLatest = end;
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || event.type !== "wheel" || !event.wheelDelta) return undefined;
		const line = event.y - this.bodyTop;
		if (line < 0 || line >= this.bodyRows) return undefined;
		const overList = this.wide ? event.x >= 2 && event.x < 2 + this.leftWidth : this.focus === "list";
		if (overList) {
			// The draft stays bound to its original topic until it closes.
			if (this.composer) return { handled: true, render: false };
			this.select(this.selectedIndex() + Math.sign(event.wheelDelta));
		} else {
			this.detailScroll = clampScroll(this.detailScroll + Math.trunc(event.wheelDelta), this.detailTotal, this.detailRows);
			this.followLatest = false;
		}
		this.options.requestRender();
		return { handled: true };
	}

	render(width: number): string[] {
		const theme = this.theme;
		const height = Math.max(0, Math.floor(this.options.getHeight()));
		width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (width === 0 || height === 0) return [];
		const framed = width >= 12 && height >= 8;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const panes = framed ? paneWidths(inner) : { wide: false, left: inner, right: inner };
		const wide = panes.wide;
		const record = this.selected();
		const composer = this.composer;

		const hintRows = packHints(theme, this.hints(record, inner), inner).slice(0, framed ? 2 : 1);
		const chrome = framed ? 3 + hintRows.length : height >= 3 ? 2 : 0;

		const composerLines: string[] = [];
		if (composer) {
			const availableRows = Math.max(1, height - chrome - 1);
			if (availableRows >= 2) {
				const topic = `Topic: ${sanitizeDisplayLine(record ? getTopicLabel(record) : "")}`;
				composerLines.push(theme.fg("dim", cut(topic, inner)));
			}
			if (composer.notice && availableRows >= 3) {
				composerLines.push(theme.fg(this.followUpPending ? "dim" : "warning", cut(composer.notice, inner)));
			}
			composer.input.focused = this.focused;
			composerLines.push(...composer.input.render(inner));
		}

		let bodyRows = Math.max(composer ? 0 : 1, height - chrome - composerLines.length);
		const detailWidth = wide ? panes.right : inner;
		const detailLines = wide || this.focus === "answer" ? this.buildDetail(record, detailWidth) : undefined;
		const showNavigation =
			framed && !composer && (this.focus === "list" || (detailLines !== undefined && detailLines.length > bodyRows));
		if (showNavigation) bodyRows = Math.max(1, bodyRows - 1);

		let detail: string[] | undefined;
		if (detailLines) {
			const total = detailLines.length;
			this.detailTotal = total;
			this.detailRows = bodyRows;
			this.detailScroll = this.followLatest ? Math.max(0, total - bodyRows) : clampScroll(this.detailScroll, total, bodyRows);
			const shown = detailLines.slice(this.detailScroll, this.detailScroll + bodyRows);
			detail = viewport(theme, shown, detailWidth, bodyRows, total, this.detailScroll);
		}
		const list = wide || this.focus === "list" ? this.renderList(wide ? panes.left : inner, bodyRows) : undefined;

		this.bodyTop = framed ? 2 : height >= 3 ? 1 : 0;
		this.bodyRows = bodyRows;
		this.wide = wide;
		this.leftWidth = panes.left;

		const lines: string[] = [];
		if (framed) {
			const bar = theme.fg("border", "│");
			const split = (left: string, right: string): string =>
				`${bar} ${pad(left, panes.left)} ${bar} ${pad(right, panes.right)} ${bar}`;
			lines.push(topBorder(theme, width, "BTW history"));
			lines.push(
				wide
					? split(this.focusLabel("list"), this.focusLabel("answer"))
					: boxRow(theme, this.focusLabel(this.focus), width),
			);
			const single = this.focus === "list" ? list : detail;
			for (let index = 0; index < bodyRows; index++) {
				lines.push(
					wide ? split(list?.[index] ?? "", detail?.[index] ?? "") : boxRow(theme, single?.[index] ?? "", width),
				);
			}
			for (const line of composerLines) lines.push(boxRow(theme, line, width));
			if (showNavigation) {
				const what = this.focus === "list" ? "select" : "scroll";
				lines.push(boxRow(theme, theme.fg("dim", "↑/↓") + theme.fg("muted", ` ${what}`), width));
			}
			for (const line of hintRows) lines.push(boxRow(theme, line, width));
			lines.push(bottomBorder(theme, width));
		} else {
			if (height >= 3) lines.push(this.focusLabel(this.focus));
			const body = this.focus === "list" ? list : detail;
			for (let index = 0; index < bodyRows; index++) lines.push(body?.[index] ?? "");
			lines.push(...composerLines);
			if (height >= 3) lines.push(hintRows[0] ?? "");
		}
		return lines.slice(0, height).map((line) => fit(line, width));
	}

	private focusLabel(focus: "list" | "answer"): string {
		const label = focus === "list" ? `History (${this.records.length})` : "Details";
		return this.focus === focus
			? this.theme.bold(this.theme.fg("accent", `${GLYPH.cursor} ${label}`))
			: this.theme.fg("muted", `  ${label}`);
	}

	private hints(record: BtwRecord | undefined, inner: number): string[] {
		const theme = this.theme;
		if (this.composer) {
			return [
				keyHint(theme, "enter", this.followUpPending ? "starting…" : "send"),
				keyHint(theme, "escape", "cancel"),
			];
		}
		const running = this.runningRecord(record) !== undefined;
		const hides = this.options.escapeHides === true;
		const hints = [keyHint(theme, "escape", running && !hides ? "cancel" : "close")];
		if (running && hides) hints.push(keyHint(theme, "x", "cancel"));
		if (this.records.length > 1) hints.push(keyHint(theme, ["tab", "ctrl+/"], "switch pane"));
		if (record && this.canFollowUp(record)) hints.push(keyHint(theme, ["f", "enter"], "follow up"));
		if (record && this.options.inject?.canSend(record)) hints.push(keyHint(theme, this.options.injectKey, "inject"));
		if (record && getCopyText(record) !== undefined) {
			if (this.isCopied(record)) hints.push(theme.fg("success", `${GLYPH.check} copied · c to copy again`));
			else hints.push(keyHint(theme, "c", inner < 40 ? "copy" : "copy answer"));
		}
		if (record && this.options.canBranch?.(record)) {
			hints.push(keyHint(theme, "b", inner < 40 ? "branch" : "branch to chat"));
		}
		return hints;
	}

	private renderList(width: number, height: number): string[] {
		const theme = this.theme;
		const rowSpan = width < 36 && height >= 2 ? 2 : 1;
		this.listPage = Math.max(1, Math.floor(height / rowSpan));
		if (this.records.length === 0) {
			const empty = [
				...wrapTextWithAnsi(theme.fg("muted", "No side questions yet."), width),
				"",
				...wrapTextWithAnsi(theme.fg("muted", "Use /btw QUESTION to start one."), width),
			];
			return viewport(theme, empty.slice(0, height), width, height, 0, 0);
		}
		const selectedIndex = this.selectedIndex();
		this.listScroll = listWindow(selectedIndex, this.listScroll, this.records.length, this.listPage);
		const totalRows = this.records.length * rowSpan;
		const contentWidth = Math.max(0, width - (totalRows > height ? 1 : 0));
		const lines: string[] = [];
		const now = new Date();
		const last = Math.min(this.records.length, this.listScroll + this.listPage);
		for (let index = this.listScroll; index < last; index++) {
			const record = this.records[index]!;
			const selected = index === selectedIndex;
			const status = STATUS[getLatestTurn(record).status];
			const cursor = selected ? theme.fg(this.focus === "list" ? "accent" : "muted", GLYPH.cursor) : " ";
			const stamp = theme.fg("dim", listStamp(record.createdAt, now));
			const badge = theme.fg(status.color, status.label);
			const prefix = `${cursor} ${stamp} ${badge} `;
			const question = sanitizeDisplayLine(getTopicLabel(record));
			const snippet = cut(question, contentWidth - (rowSpan === 2 ? 2 : visibleWidth(prefix)));
			const label = selected ? theme.bold(snippet) : snippet;
			const first = pad(rowSpan === 2 ? prefix : `${prefix}${label}`, contentWidth);
			lines.push(selected ? theme.bg("selectedBg", first) : first);
			if (rowSpan === 2) {
				const second = pad(`  ${label}`, contentWidth);
				lines.push(selected ? theme.bg("selectedBg", second) : second);
			}
		}
		return viewport(theme, lines, width, height, totalRows, this.listScroll * rowSpan);
	}

	private renderTurn(turn: BtwTurn, cached: RenderedTurn | undefined, width: number, block: InjectBlock | undefined): RenderedTurn {
		const theme = this.theme;
		const previous = cached?.turn;
		if (
			cached &&
			previous &&
			cached.width === width &&
			turn.question === previous.question &&
			turn.answer === previous.answer &&
			turn.status === previous.status &&
			turn.error === previous.error &&
			turn.createdAt === previous.createdAt &&
			block?.state === cached.block
		) {
			return cached;
		}
		const question = cached?.question ?? new Markdown("", 0, 0, getMarkdownTheme());
		const answer = cached?.answer ?? new Markdown("", 0, 0, getMarkdownTheme());
		if (turn.question !== previous?.question) question.setText(sanitizeDisplayText(turn.question));
		// The cached Markdown can be stale when switching out of block view.
		if (!block) answer.setText(sanitizeDisplayText(turn.answer));
		const status = STATUS[turn.status];
		const lines = [
			...wrapTextWithAnsi(theme.fg(status.color, `${status.label} · ${fullStamp(turn.createdAt)}`), width),
			"",
			theme.bold(theme.fg("accent", "Question")),
			...question.render(width),
			"",
			theme.bold(theme.fg("accent", "Answer")),
		];
		if (block) lines.push(...renderInjectAnswer(theme, block.parts, block.state === "sent", width));
		else if (turn.answer.trim()) lines.push(...answer.render(width));
		else {
			const waiting = turn.status === "running" ? "Waiting for response…" : "No answer text.";
			lines.push(...wrapTextWithAnsi(theme.fg("dim", waiting), width));
		}
		if (turn.error) lines.push("", ...wrapTextWithAnsi(theme.fg("error", sanitizeErrorLine(turn.error)), width));
		if (turn.status === "interrupted") {
			lines.push("", ...wrapTextWithAnsi(theme.fg("muted", "Not resumed in this view."), width));
		}
		return {
			turn: {
				question: turn.question,
				answer: turn.answer,
				status: turn.status,
				error: turn.error,
				createdAt: turn.createdAt,
			},
			question,
			answer,
			block: block?.state,
			lines,
			width,
		};
	}

	private buildDetail(record: BtwRecord | undefined, width: number): string[] {
		const theme = this.theme;
		if (record?.id !== this.detailRecord?.id) this.turns = [];
		const copied = record !== undefined && this.isCopied(record);
		const inject = this.latestInject(record);
		if (
			!this.detailDirty &&
			record === this.detailRecord &&
			width === this.detailWidth &&
			copied === this.detailCopied &&
			inject === this.detailInject
		) {
			return this.detailLines;
		}
		const inner = Math.max(1, width - 1);
		const lines: string[] = [];
		if (record) {
			if (copied) lines.push(...wrapTextWithAnsi(theme.fg("success", `${GLYPH.check} Copied to clipboard`), inner), "");
			const turns = getDisplayTurns(record);
			for (let index = 0; index < turns.length; index++) {
				const turn = turns[index]!;
				const rendered = this.renderTurn(turn, this.turns[index], inner, this.injectBlock(record, turn, index));
				this.turns[index] = rendered;
				if (index > 0) lines.push("", theme.fg("dim", "─".repeat(inner)), "");
				lines.push(...rendered.lines);
			}
			this.turns.length = turns.length;
		} else {
			lines.push(...wrapTextWithAnsi(theme.fg("muted", "No side questions yet. Use /btw QUESTION to start one."), inner));
		}
		this.detailLines = lines;
		this.detailRecord = record;
		this.detailWidth = width;
		this.detailCopied = copied;
		this.detailInject = inject;
		this.detailDirty = false;
		return lines;
	}

	get nativeOverlay(): { role: string; anchor: "center"; size: "lg" | "md"; head: string } {
		return this.records.length > 0 ? SHEET : EMPTY_SHEET;
	}

	describe(_cx: DescribeCx): NativeNode {
		const record = this.selected();
		const composer = this.composer;
		const canFollowUp = record !== undefined && this.canFollowUp(record);
		const canBranch = record !== undefined && this.options.canBranch?.(record) === true;
		const copied = record !== undefined && this.isCopied(record);
		const canInject = record !== undefined && this.options.inject?.canSend(record) === true;
		const latestInject = this.latestInject(record);
		const memo = this.native;
		if (
			memo &&
			memo.records === this.records &&
			memo.selectedId === this.selectedId &&
			memo.focus === this.focus &&
			memo.focused === this.focused &&
			memo.composer === composer &&
			memo.notice === composer?.notice &&
			memo.followUpPending === this.followUpPending &&
			memo.canFollowUp === canFollowUp &&
			memo.canBranch === canBranch &&
			memo.copied === copied &&
			memo.canInject === canInject &&
			memo.latestInject === latestInject
		) {
			return memo.node;
		}
		const children: NativeChild[] = [];
		if (record) {
			const reader = node(
				"col",
				{ role: "omp.btw.reader", grow: 1, basis: 0, min: { w: 0 } },
				[this.describeThread(record)],
				"details",
			);
			const panes = this.records.length > 1 ? [this.describeList(), reader] : [reader];
			children.push(node("row", { role: "omp.btw.body" }, panes, "body"));
		} else {
			children.push(this.describeEmpty());
		}
		// The native sheet pins its last child as the footer.
		children.push(this.describeActions(record, canFollowUp, canBranch, copied, canInject));
		const described = col(children, { gap: "none" });
		this.native = {
			records: this.records,
			selectedId: this.selectedId,
			focus: this.focus,
			focused: this.focused,
			composer,
			notice: composer?.notice,
			followUpPending: this.followUpPending,
			canFollowUp,
			canBranch,
			copied,
			canInject,
			latestInject,
			node: described,
		};
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.disposed) return;
		if (event.type === "action") {
			const record = this.selected();
			switch (event.act) {
				case "close":
					this.options.onClose();
					return;
				case "copy-answer":
					if (record && getCopyText(record) !== undefined) this.options.onCopy(record);
					break;
				case "branch":
					if (record && this.options.canBranch?.(record)) this.options.onBranch?.(record);
					break;
				case "inject":
					this.sendInject(record);
					break;
				case "follow-up":
					if (record) this.openFollowUp(record.id);
					break;
				case "stop": {
					const running = this.runningRecord(record);
					if (running) this.options.onCancel(running);
					break;
				}
				case "send": {
					const input = this.composer?.input;
					input?.onSubmit?.(input.getValue());
					break;
				}
				case "discard":
					this.composer?.input.onEscape?.();
					break;
				default:
					return;
			}
			this.options.requestRender();
			return;
		}
		if ((event.type !== "select" && event.type !== "activate") || this.composer) return;
		const index = this.records.findIndex((record) => record.id === event.item);
		if (index === -1) return;
		this.select(index);
		this.focus = "list";
		if (event.type === "activate") this.openFollowUp(event.item);
		this.options.requestRender();
	}

	private describeList(): NativeNode {
		const now = new Date();
		const items = this.records.map((record) => {
			const followUps = record.followUps?.length ?? 0;
			const detail: TspSpan[] = [span(listStamp(record.createdAt, now), "mono")];
			if (followUps > 0) detail.push(span(` · ${followUps} follow-up${followUps === 1 ? "" : "s"}`));
			const status = describeStatus(getLatestTurn(record).status);
			const label = sanitizeDisplayLine(getTopicLabel(record))
				.split(/`([^`]+)`/)
				.flatMap((part, index) => (part ? [span(part, index % 2 === 1 ? "mono" : undefined)] : []));
			return node("item", { label, detail, ...(status ? { value: status } : {}) }, undefined, record.id);
		});
		const role = this.focus === "list" ? "omp.btw.list" : "omp.btw.list.idle";
		return node(
			"col",
			{ role: "omp.btw.history", shrink: 0 },
			[node("list", { role, selected: this.selectedId ?? null }, items, "records")],
			"history",
		);
	}

	private describeThread(record: BtwRecord): NativeNode {
		const turns = getDisplayTurns(record);
		const children: NativeChild[] = turns.map((turn, index) =>
			this.describeTurn(turn, index, this.injectBlock(record, turn, index), record.createdAt),
		);
		if (this.composer) children.push(this.describeComposer(this.composer));
		return node("col", { role: "omp.btw.thread" }, children, "thread");
	}

	private describeTurn(turn: BtwTurn, index: number, block: InjectBlock | undefined, topicCreatedAt: number): NativeNode {
		const meta: TspSpan[] =
			index === 0
				? [span(fullStamp(turn.createdAt))]
				: [
						span("Follow-up · "),
						span(isSameLocalDay(turn.createdAt, topicCreatedAt) ? timeStamp(turn.createdAt) : fullStamp(turn.createdAt)),
					];
		const status = describeStatus(turn.status);
		if (status) meta.push(span("  ·  "), ...status);
		const children: NativeChild[] = [
			md(sanitizeDisplayText(turn.question), { role: index === 0 ? "omp.btw.question" : "omp.btw.followup" }),
			text(meta, { role: "omp.btw.meta", truncate: "end", lines: 1 }),
		];
		if (turn.answer.trim() || !turn.error) {
			const stream = turn.status === "running";
			const answer = block
				? describeInjectAnswer(block.parts, block.state === "sent", stream)
				: turn.answer.trim()
					? md(sanitizeDisplayText(turn.answer), { stream })
					: text([span(stream ? "Thinking…" : "No answer text.", "dim")], { role: "omp.btw.pending" });
			children.push(node("col", { role: "omp.btw.answer" }, [answer], "answer"));
		}
		if (turn.error) {
			children.push(text([span(sanitizeErrorLine(turn.error), "error")], { role: "omp.btw.error", wrap: "word" }));
		}
		if (turn.status === "interrupted") {
			children.push(text([span("Not resumed in this view.", "muted")], { role: "omp.btw.note" }));
		}
		// Native reveal runs again if the key changes.
		const described = node("col", { role: "omp.btw.turn" }, children, `turn-${index}`);
		return index > 0 && turn.status === "running" ? { ...described, reveal: "start" } : described;
	}

	private describeComposer(composer: FollowUpComposer): NativeNode {
		composer.input.focused = this.focused;
		const children: NativeChild[] = [composer.input];
		if (composer.notice) {
			children.push(
				text([span(composer.notice, this.followUpPending ? "dim" : "warning")], {
					role: "omp.btw.notice",
					wrap: "word",
				}),
			);
		}
		return { ...node("col", { role: "omp.btw.composer", gap: "sm" }, children, "composer"), reveal: "end" };
	}

	private describeEmpty(): NativeNode {
		return node(
			"col",
			{ role: "omp.btw.empty", align: "center", gap: "sm" },
			[
				text("No side questions yet", { role: "omp.btw.empty.title" }),
				text(
					[
						span("Ask one with "),
						span("/btw <question>", "code"),
						span(". The answer stays out of the main conversation."),
					],
					{ role: "omp.btw.empty.hint", wrap: "word" },
				),
			],
			"empty",
		);
	}

	private describeActions(
		record: BtwRecord | undefined,
		canFollowUp: boolean,
		canBranch: boolean,
		copied: boolean,
		canInject: boolean,
	): NativeNode {
		if (this.composer) {
			return actionBar([
				null,
				actionButton("Cancel", "discard", { keys: "escape" }),
				actionButton(this.followUpPending ? "Sending…" : "Send", "send", { keys: "enter", tone: "accent" }),
			]);
		}
		const running = this.runningRecord(record) !== undefined;
		const hides = this.options.escapeHides === true;
		const buttons: (NativeNode | null)[] = [];
		if (running) buttons.push(actionButton("Stop answer", "stop", { keys: hides ? "x" : "escape" }));
		if (canInject) buttons.push(actionButton("Inject into main", "inject", { keys: this.options.injectKey }));
		if (canBranch) buttons.push(actionButton("Branch to chat", "branch", { keys: "b" }));
		if (record && getCopyText(record) !== undefined) {
			buttons.push(actionButton(copied ? "Copy again" : "Copy answer", "copy-answer", { keys: "c" }));
			if (copied) buttons.push(text([span(`${GLYPH.check} Copied`, "success")], { role: "omp.btw.copied" }));
		}
		buttons.push(null);
		buttons.push(actionButton("Close", "close", running && !hides ? undefined : { keys: "escape" }));
		if (canFollowUp) buttons.push(actionButton("Follow up", "follow-up", { keys: "f", tone: "accent" }));
		return actionBar(buttons);
	}
}

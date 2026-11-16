/**
 * Agent inspector: oh-my-pi's Agent Hub (packages/tui/src/overlays/agent-hub.ts) and its in-hub
 * transcript viewer (agent-transcript-viewer.ts), for vanilla pi.
 *
 * - Roster: every subagent of the session (nested ones grouped under the agent that spawned them,
 *   or a flat status-ordered list), live status and stats, and a detail pane for the selected agent
 *   on wide terminals (Tab toggles it on narrow ones).
 * - Transcript: a live view of one agent's conversation, drawn with pi's own message components
 *   (user, assistant, tool calls), plus an input line that messages the agent as the user (steers a
 *   running agent, wakes an idle one; its reply comes back to the main transcript).
 *
 * Opened with ctrl+s / alt+a (oh-my-pi's app.session.observe / app.agents.hub), a deliberate ←← on
 * an empty editor (only when there are subagents), or /agents. The same keys (or ←← / Esc) close it.
 *
 * Natively (tsp-native, a TSP terminal) the roster is omp's `picker` sheet (agent rows with usage
 * columns, the selected agent as the side preview) and the transcript a full overlay of pi's message
 * components plus a native message field; keys stay this component's, pointer events come back
 * through handleNativeEvent to the same handlers.
 */

import {
	AssistantMessageComponent,
	CustomMessageComponent,
	type ExtensionUIContext,
	getMarkdownTheme,
	getSelectListTheme,
	type KeybindingsManager,
	type Theme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Editor,
	type Focusable,
	fuzzyMatch,
	Input,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	Spacer,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type AgentHub, activeDescendants, type Child, firstLine, PARENT_ID, USER_ID } from "./hub.ts";
import {
	HUB_COLUMNS,
	type HubTranscriptView,
	hubPickerItem,
	hubPreview,
	hubSignature,
	hubSubtitle,
	hubTranscript,
	type NativeComponentContext,
	type NativeUiChild,
	type NativeUiEvent,
	type NativeUiNode,
	type TspSpan,
	uiNode,
} from "./native.ts";
import { activityText, formatRow, type RowSnapshot, snapshotChild, statRun, statusIcon } from "./render.ts";

// ---------------------------------------------------------------------------------------------
// Gestures

/**
 * Double-← gesture bounds (oh-my-pi input-controller.ts). Terminals synthesize bursts of arrow keys
 * (click-to-move-cursor in iTerm2/WezTerm/kitty/tmux arrive sub-millisecond apart in one read), and
 * three or more rapid taps are a burst too; a deliberate human double tap is tens of ms apart.
 */
export const LEFT_DOUBLE_TAP_MIN_GAP_MS = 40;
export const LEFT_DOUBLE_TAP_MAX_GAP_MS = 500;
/** Double-tap window of the roster's ←← "close" gesture (oh-my-pi agent-hub.ts LEFT_TAP_WINDOW_MS). */
export const LEFT_TAP_WINDOW_MS = 500;
/** Keys that open the inspector from the editor and close it from inside (alt+a = app.agents.hub, ctrl+s = app.session.observe). */
export const HUB_KEYS = ["ctrl+s", "alt+a"] as const;
/** Redraw cadence while open (spinners, durations, streaming transcripts). */
const TICK_MS = 150;
/** Natively the roster redraws every this many ticks (its run times count in seconds). */
const NATIVE_ROSTER_TICKS = 7;
/** Second ctrl+x within this window kills the agent shown in the transcript view. */
const KILL_CONFIRM_MS = 3000;

/**
 * Deliberate double-tap detector (oh-my-pi #detectLeftDoubleTap): true only on the second tap of a
 * fresh sequence landing [MIN_GAP, MAX_GAP) after the first. Closer taps, or any third-and-later tap
 * before a quiet gap, are a burst and never fire.
 */
export class LeftDoubleTap {
	private last = 0;
	private count = 0;

	tap(now = Date.now()): boolean {
		const since = now - this.last;
		this.last = now;
		if (since >= LEFT_DOUBLE_TAP_MAX_GAP_MS) {
			this.count = 1;
			return false;
		}
		this.count += 1;
		if (this.count === 2 && since >= LEFT_DOUBLE_TAP_MIN_GAP_MS) {
			this.count = 0;
			this.last = 0;
			return true;
		}
		return false;
	}

	/** A key-repeat event (held key): part of a burst, never a gesture. */
	burst(now = Date.now()): void {
		this.last = now;
		this.count = Math.max(this.count, 2);
	}
}

export interface InspectorOpenOptions {
	/** Opened by the editor's ←← gesture: a single ← right after it closes again (oh-my-pi armCloseTap). */
	armCloseTap?: boolean;
	/** Open this agent's transcript directly. */
	agentId?: string;
}

export interface HubKeyDeps {
	tui: () => TUI | undefined;
	editorText: () => string;
	isOpen: () => boolean;
	hasAgents: () => boolean;
	open: (opts: InspectorOpenOptions) => void;
}

/** The main prompt editor has focus (not a selector, dialog or overlay). pi's editor is a CustomEditor. */
export function mainEditorFocused(tui: TUI | undefined): boolean {
	const focused = (tui as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.() as
		| { getText?: unknown; onAction?: unknown }
		| null
		| undefined;
	return !!focused && typeof focused.getText === "function" && typeof focused.onAction === "function";
}

/**
 * `ctx.ui.onTerminalInput` handler (runs before the focused component). Only while the main editor
 * has focus: ctrl+s / alt+a open the inspector (pi binds ctrl+s only inside its selectors, which keep
 * it), and a deliberate ←← on an empty editor opens it when there are subagents (oh-my-pi
 * requireContent). Every other key, including ← in a non-empty editor, passes through untouched.
 */
export function createHubKeyHandler(deps: HubKeyDeps): (data: string) => { consume?: boolean } | undefined {
	const taps = new LeftDoubleTap();
	return (data) => {
		if (deps.isOpen() || isKeyRelease(data)) return undefined;
		if (!mainEditorFocused(deps.tui())) return undefined;
		if (HUB_KEYS.some((k) => matchesKey(data, k))) {
			deps.open({});
			return { consume: true };
		}
		if (matchesKey(data, "left") && deps.editorText().trim() === "") {
			if (isKeyRepeat(data)) {
				taps.burst();
				return undefined;
			}
			if (taps.tap() && deps.hasAgents()) {
				deps.open({ armCloseTap: true });
				return { consume: true };
			}
		}
		return undefined;
	};
}

/** Show the inspector as a full-screen overlay; resolves when it closes. */
export function openInspector(ui: ExtensionUIContext, hub: AgentHub, opts: InspectorOpenOptions = {}): Promise<void> {
	return ui.custom<void>(
		(tui, theme, keybindings, done) => new AgentInspector({ hub, tui, theme, keybindings, done: () => done(), ...opts }),
		{
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
		},
	);
}

// ---------------------------------------------------------------------------------------------
// Layout helpers

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", teeR: "├", teeL: "┤", teeD: "┬", teeU: "┴" };
const STATUS_ORDER: Record<string, number> = { running: 0, pending: 1, idle: 2, failed: 3, aborted: 4 };
const SPLIT_MIN_WIDTH = 96;
const DETAIL_MIN_WIDTH = 34;
const ROSTER_MIN_WIDTH = 48;

function pad(s: string, width: number): string {
	if (width <= 0) return "";
	const t = visibleWidth(s) > width ? truncateToWidth(s, width, "…") : s;
	return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}

function clip(s: string, width: number): string {
	return visibleWidth(s) > width ? truncateToWidth(s, Math.max(0, width), "…") : s;
}

function flat(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function fmtAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h`;
}

function lastActivity(c: Child): number {
	return Math.max(c.createdAt, c.startedAt ?? 0, c.runStartedAt ?? 0, c.finishedAt ?? 0);
}

/** `3 tools · 2 req · 1.2%/200k · $0.02` (render.ts statRun without its leading separator). */
function usageText(s: RowSnapshot, theme: Theme): string {
	const run = statRun(s, theme);
	const sep = theme.fg("dim", " · ");
	return run.startsWith(sep) ? run.slice(sep.length) : run || theme.fg("dim", "usage —");
}

interface Frame {
	theme: Theme;
	width: number;
}

function topBorder(f: Frame, title: string, splitAt?: number): string {
	const { theme, width } = f;
	const inner = Math.max(0, width - 2);
	const shown = clip(` ${title} `, Math.max(0, inner - 2));
	const used = 1 + visibleWidth(shown);
	let rest = BOX.h.repeat(Math.max(0, inner - used));
	if (splitAt !== undefined && splitAt > used && splitAt < inner) {
		rest = BOX.h.repeat(splitAt - used) + BOX.teeD + BOX.h.repeat(Math.max(0, inner - splitAt - 1));
	}
	return theme.fg("border", BOX.tl + BOX.h) + theme.bold(theme.fg("accent", shown)) + theme.fg("border", rest + BOX.tr);
}

function divider(f: Frame, splitAt?: number): string {
	const inner = Math.max(0, f.width - 2);
	const mid =
		splitAt !== undefined && splitAt > 0 && splitAt < inner
			? BOX.h.repeat(splitAt) + BOX.teeU + BOX.h.repeat(Math.max(0, inner - splitAt - 1))
			: BOX.h.repeat(inner);
	return f.theme.fg("border", BOX.teeR + mid + BOX.teeL);
}

function bottomBorder(f: Frame): string {
	return f.theme.fg("border", BOX.bl + BOX.h.repeat(Math.max(0, f.width - 2)) + BOX.br);
}

function boxRow(f: Frame, content: string): string {
	const bar = f.theme.fg("border", BOX.v);
	return `${bar} ${pad(content, f.width - 4)} ${bar}`;
}

function splitRow(f: Frame, left: string, right: string, leftWidth: number): string {
	const bar = f.theme.fg("border", BOX.v);
	const rightWidth = Math.max(0, f.width - leftWidth - 7);
	return `${bar} ${pad(left, leftWidth)} ${bar} ${pad(right, rightWidth)} ${bar}`;
}

/** A plain horizontal rule with an optional dim label on the right. */
function rule(f: Frame, label = ""): string {
	const { theme, width } = f;
	if (!label) return theme.fg("border", BOX.h.repeat(width));
	const l = clip(` ${label} `, Math.max(0, width - 4));
	return theme.fg("border", BOX.h.repeat(Math.max(0, width - visibleWidth(l) - 2))) + theme.fg("dim", l) + theme.fg("border", BOX.h.repeat(2));
}

// ---------------------------------------------------------------------------------------------
// Inspector

export interface InspectorDeps extends InspectorOpenOptions {
	hub: AgentHub;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	done: () => void;
	/** Terminal rows (tests); default the TUI's terminal. */
	rows?: () => number;
}

type Notice = { text: string; tone: "error" | "warning" | "success" | "muted" };
type ViewMode = "tree" | "flat";

/** Placement of the overlay wrapping the inspector natively (tsp-native reads `nativeOverlay`). */
interface NativeOverlay {
	size: "full";
	role: string;
	head: TspSpan[];
}

/** Kinds the native roster (a picker sheet with its preview) and transcript are drawn with. */
const ROSTER_KINDS = ["picker", "row", "text", "badge", "kv", "section", "spinner", "elapsed"] as const;
const TRANSCRIPT_KINDS = ["col", "row", "text", "badge", "input", "kbd", "spacer"] as const;

function supportsAll(cx: NativeComponentContext, kinds: readonly string[]): boolean {
	return kinds.every((k) => cx.supports(k));
}

function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[]): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
	return true;
}

/** pi-tui Editor internals the native field edits through (duck-typed; absent → setText). */
interface EditorInternals {
	state?: { lines: string[]; cursorLine: number; cursorCol: number };
	lastAction?: unknown;
	preferredVisualCol?: unknown;
	exitHistoryBrowsing?: () => void;
	pushUndoSnapshot?: () => void;
	undo?: () => void;
	onChange?: (text: string) => void;
}

/** The draft as one string and the caret as an offset into it. */
function editorDraft(editor: Editor): { text: string; cursor: number } {
	const lines = editor.getLines();
	const { line, col } = editor.getCursor();
	let offset = 0;
	for (let i = 0; i < line && i < lines.length; i++) offset += lines[i]!.length + 1;
	return { text: lines.join("\n"), cursor: offset + col };
}

/** Apply a terminal-side edit (UTF-16 offsets over the draft; stale when `len` mismatches), as tsp-native's editor describer does. */
function applyHostEdit(editor: Editor, ev: { from: number; to: number; text: string; cursor: number; len: number }): void {
	const current = editorDraft(editor).text;
	if (ev.len !== current.length) return;
	const clamp = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), 0), current.length) : 0);
	let from = clamp(ev.from);
	let to = clamp(ev.to);
	if (to < from) [from, to] = [to, from];
	const insert = (ev.text ?? "").replace(/\r\n?/g, "\n");
	const next = current.slice(0, from) + insert + current.slice(to);
	const changed = from !== to || insert !== "";
	const a = editor as unknown as EditorInternals;
	const state = a.state;
	if (!state || !Array.isArray(state.lines)) {
		if (changed) editor.setText(next);
		return;
	}
	if (changed) {
		a.exitHistoryBrowsing?.();
		a.pushUndoSnapshot?.();
		state.lines = next.split("\n");
		a.lastAction = null;
	}
	let col = Math.min(Math.max(0, Math.trunc(ev.cursor)), next.length);
	let line = 0;
	while (line < state.lines.length - 1 && col > state.lines[line]!.length) col -= state.lines[line++]!.length + 1;
	state.cursorLine = line;
	state.cursorCol = Math.min(col, state.lines[line]!.length);
	a.preferredVisualCol = null;
	if (changed) a.onChange?.(next);
}

/** The last segment of a node keypath (the node's own key). */
function leafKey(key: string): string {
	const slash = key.lastIndexOf("/");
	return slash < 0 ? key : key.slice(slash + 1);
}

export class AgentInspector implements Component, Focusable {
	private mode: ViewMode = "tree";
	private selectedId: string | undefined;
	private rosterTop = 0;
	private detailScroll = 0;
	private narrowDetails = false;
	private readonly filter = new Input({ prompt: "" });
	private filterEditing = false;
	private notice: Notice | undefined;
	private lastLeftTap = 0;
	private frame = 0;
	private timer: NodeJS.Timeout | undefined;
	private offChange: (() => void) | undefined;
	private transcript: TranscriptView | undefined;
	private disposed = false;
	private closed = false;
	private _focused = false;
	/** Bumped on every hub change (part of the native memo's signature). */
	private version = 0;
	/** Last native roster description and the state it was built from. */
	private native: { sig: string; node: NativeUiNode } | undefined;
	/** Agent whose pointer kill waits on the picker's confirmation strip. */
	private killConfirm: string | undefined;
	private overlay: { id: string; value: NativeOverlay } | undefined;
	/** The last frame was described natively (describe ran after render). */
	private nativeShown = false;

	constructor(private readonly deps: InspectorDeps) {
		if (deps.armCloseTap) this.lastLeftTap = Date.now();
		this.timer = setInterval(() => {
			this.frame++;
			// Natively the terminal animates spinners and timers: the roster only needs its run times (~1s);
			// a transcript keeps the cadence (it picks up streaming messages when described).
			if (!this.nativeShown || this.transcript || this.frame % NATIVE_ROSTER_TICKS === 0) this.requestRender();
		}, TICK_MS);
		this.timer.unref?.();
		this.offChange = deps.hub.onChange(() => {
			this.version++;
			this.requestRender();
		});
		if (deps.agentId && deps.hub.children.has(deps.agentId)) {
			this.selectedId = deps.agentId;
			this.openTranscript(deps.agentId);
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.filter.focused = value && this.filterEditing;
		this.transcript?.setFocused(value);
	}

	/** Which view is showing (tests). */
	get view(): "list" | "transcript" {
		return this.transcript ? "transcript" : "list";
	}

	get selected(): string | undefined {
		return this.selectedId;
	}

	invalidate(): void {
		this.transcript?.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.offChange?.();
		this.offChange = undefined;
		this.transcript?.dispose();
		this.transcript = undefined;
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.deps.done();
	}

	private requestRender(): void {
		if (this.disposed) return;
		try {
			this.deps.tui.requestRender();
		} catch {}
	}

	private height(): number {
		const rows = this.deps.rows?.() ?? this.deps.tui.terminal?.rows ?? process.stdout.rows ?? 40;
		return Math.max(8, rows);
	}

	/** Roster rows in display order (tree: spawn order with nesting; flat: status, then recency), filtered. */
	rows(): Child[] {
		const { hub } = this.deps;
		const all =
			this.mode === "tree"
				? hub.tree()
				: [...hub.children.values()].sort(
						(a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || lastActivity(b) - lastActivity(a) || a.id.localeCompare(b.id),
					);
		const q = this.filter.getValue().trim();
		if (!q) return all;
		return all.filter((c) => fuzzyMatch(q.toLowerCase(), `${c.id} ${c.agent.name}`.toLowerCase()).matches);
	}

	private selectedIndex(rows: Child[]): number {
		const i = rows.findIndex((c) => c.id === this.selectedId);
		if (i >= 0) return i;
		this.selectedId = rows[0]?.id;
		return rows.length ? 0 : -1;
	}

	// ---------- input ----------

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.transcript) {
			const r = this.transcript.handleInput(data);
			if (r === "close") this.close();
			else if (r === "back") this.closeTranscript();
			this.requestRender();
			return;
		}
		if (HUB_KEYS.some((k) => matchesKey(data, k))) {
			this.close();
			return;
		}
		this.handleListInput(data);
		this.requestRender();
	}

	private handleListInput(data: string): void {
		const kb = this.deps.keybindings;
		if (this.killConfirm) {
			// Any key dismisses a pointer kill's confirmation strip; Esc does only that.
			this.killConfirm = undefined;
			if (matchesKey(data, "escape")) return;
		}
		if (this.filterEditing) {
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "\r" || data === "\n") {
				this.filterEditing = false;
				this.filter.focused = false;
				if (matchesKey(data, "escape")) this.filter.setValue("");
			} else {
				this.filter.handleInput(data);
			}
			this.rosterTop = 0;
			return;
		}
		const rows = this.rows();
		const i = this.selectedIndex(rows);
		if (matchesKey(data, "escape")) {
			if (this.filter.getValue()) this.filter.setValue("");
			else if (this.narrowDetails) this.narrowDetails = false;
			else this.close();
			return;
		}
		if (data === "/") {
			this.filterEditing = true;
			this.filter.focused = this._focused;
			return;
		}
		if (matchesKey(data, "tab")) {
			if (rows.length) this.narrowDetails = !this.narrowDetails;
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.detailScroll = Math.max(0, this.detailScroll - 5);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.detailScroll += 5;
			return;
		}
		if (data === "t") {
			this.mode = this.mode === "tree" ? "flat" : "tree";
			this.rosterTop = 0;
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.narrowDetails) {
				this.narrowDetails = false;
				return;
			}
			const now = Date.now();
			if (now - this.lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.lastLeftTap = 0;
				this.close();
			} else {
				this.lastLeftTap = now;
			}
			return;
		}
		if (data === "j" || kb.matches(data, "tui.select.down")) {
			if (i >= 0 && i < rows.length - 1) this.select(rows[i + 1]!.id);
			return;
		}
		if (data === "k" || kb.matches(data, "tui.select.up")) {
			if (i > 0) this.select(rows[i - 1]!.id);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || data === "\r" || data === "\n" || matchesKey(data, "right")) {
			if (i >= 0) this.openTranscript(rows[i]!.id);
			return;
		}
		if (data === "x") {
			if (i >= 0) this.kill(rows[i]!);
			return;
		}
		if (data === "r") {
			const c = rows[i];
			if (!c) return;
			this.notice =
				c.status === "aborted"
					? { text: `${c.id} was killed; killed agents cannot be revived.`, tone: "warning" }
					: { text: `${c.id} is ${c.status}: it stays live (open it and send a message to wake it).`, tone: "muted" };
		}
	}

	private select(id: string): void {
		if (id !== this.selectedId) this.detailScroll = 0;
		this.selectedId = id;
		this.notice = undefined;
	}

	/** Kill an agent (and its subagents) as the user; its owner still gets an aborted result. */
	kill(c: Child): void {
		if (c.status === "aborted") {
			this.setNotice({ text: `${c.id} is already killed.`, tone: "muted" });
			return;
		}
		this.setNotice({ text: `Killing ${c.id}…`, tone: "muted" });
		this.deps.hub.kill(c.id, { notify: true }).then(
			(notes) => {
				this.setNotice({ text: [`Killed ${c.id}.`, ...notes].join(" "), tone: "success" });
			},
			(e) => this.setNotice({ text: e instanceof Error ? e.message : String(e), tone: "error" }),
		);
	}

	private setNotice(n: Notice): void {
		if (this.transcript) this.transcript.notice = n;
		else this.notice = n;
		this.requestRender();
	}

	openTranscript(id: string): void {
		this.transcript?.dispose();
		this.selectedId = id;
		this.notice = undefined;
		this.transcript = new TranscriptView(this.deps, id, (n) => this.setNotice(n), (c) => this.kill(c));
		this.transcript.setFocused(this._focused);
	}

	private closeTranscript(): void {
		this.transcript?.dispose();
		this.transcript = undefined;
	}

	// ---------- native (tsp-native) ----------

	/** The roster is its own sheet (a root `picker`, no overlay wrapper); the transcript sits in a full overlay. */
	nativeSheet(cx: NativeComponentContext): boolean {
		return !this.transcript && supportsAll(cx, ROSTER_KINDS);
	}

	/** The transcript's overlay: a full-size panel sheet titled with the agent. */
	get nativeOverlay(): NativeOverlay | undefined {
		const id = this.transcript?.id;
		if (id === undefined) return undefined;
		if (this.overlay?.id !== id) {
			this.overlay = {
				id,
				value: { size: "full", role: "omp.overlay.agents", head: [{ t: "Agent Hub", s: "accent" }, { t: " · ", s: "dim" }, { t: id, s: "accent" }] },
			};
		}
		return this.overlay.value;
	}

	/** omp's agent hub: the roster as a `picker` with the selected agent's preview, or the transcript view. */
	describe(cx: NativeComponentContext): NativeUiNode | null {
		const described = this.transcript ? this.transcript.describe(cx) : this.describeRoster(cx);
		this.nativeShown = described !== null;
		return described;
	}

	private describeRoster(cx: NativeComponentContext): NativeUiNode | null {
		if (!supportsAll(cx, ROSTER_KINDS)) return null;
		const { hub } = this.deps;
		const rows = this.rows();
		const i = this.selectedIndex(rows);
		const selected = i >= 0 ? rows[i] : undefined;
		if (this.killConfirm && this.killConfirm !== selected?.id) this.killConfirm = undefined;
		const all = [...hub.children.values()];
		const now = Date.now();
		const query = this.filter.getValue();
		const cursor = (this.filter as unknown as { cursor?: number }).cursor ?? query.length;
		const meter = cx.supports("meter");
		const progress = cx.supports("progress");
		const ticking = all.some((c) => c.status === "running");
		const sig = [
			this.version,
			this.mode,
			query,
			cursor,
			this.filterEditing ? 1 : 0,
			selected?.id ?? "",
			this.notice?.text ?? "",
			this.notice?.tone ?? "",
			this.killConfirm ?? "",
			meter ? 1 : 0,
			progress ? 1 : 0,
			// Run times count up while anything runs.
			ticking ? Math.floor(now / 1000) : 0,
			rows.map((c) => c.id).join(","),
			...all.map(hubSignature),
		].join("\u0002");
		if (this.native?.sig === sig) return this.native.node;
		const q = query.trim();
		const tree = this.mode === "tree" && !q;
		const items = rows.map((c) => hubPickerItem(c, { now, depth: tree ? Math.max(0, c.depth - 1) : undefined, showOwner: !tree, query: q || undefined }));
		const showQuery = this.filterEditing || query !== "";
		const confirming = this.killConfirm !== undefined && selected !== undefined;
		const props: Record<string, unknown> = {
			title: "Agents",
			subtitle: hubSubtitle(all),
			icon: "users",
			size: "lg",
			noun: "agents",
			layout: tree ? "tree" : "rows",
			preview: "side",
			query: showQuery ? query : null,
			...(showQuery ? { cursor } : {}),
			placeholder: "Filter agents…",
			columns: HUB_COLUMNS,
			items,
			selected: selected?.id ?? null,
			total: all.length,
			state: "ready",
			empty: "No agents in this session. Subagents spawned with the task tool show up here, live, with their nested agents.",
			actions: [
				{ id: "open", label: "Open transcript", keys: ["enter"], primary: true, disabled: selected ? undefined : true },
				{
					id: "kill",
					label: "Kill",
					keys: ["x"],
					danger: true,
					disabled: !selected ? true : selected.status === "aborted" ? "Already killed; killed agents cannot be revived" : undefined,
				},
				{ id: "view", label: "By parent", keys: ["t"], on: this.mode === "tree" },
				{ id: "filter", label: "Filter", keys: ["/"] },
				{ id: "close", label: "Close", keys: ["esc"], end: true },
			],
			focus: "list",
		};
		if (confirming) {
			props.confirm = { text: `Kill ${selected.id}${selected.owned.length ? " and its subagents" : ""}?`, label: "Kill", act: "confirm-kill" };
		}
		const node = uiNode("picker", props, hubPreview(selected, { now, notice: this.notice, meter, progress }));
		this.native = { sig, node };
		return node;
	}

	/** Pointer events on the native hub: the same paths as the keys. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.closed) return;
		if (this.transcript) {
			const r = this.transcript.handleNativeEvent(event);
			if (r === "close") this.close();
			else if (r === "back") this.closeTranscript();
			this.requestRender();
			return;
		}
		const rows = this.rows();
		const selected = (): Child | undefined => rows[this.selectedIndex(rows)];
		if (event.key === "") {
			switch (event.type) {
				case "select":
				case "activate": {
					const c = rows.find((r) => r.id === event.item);
					if (!c) break;
					this.select(c.id);
					if (event.type === "activate") this.openTranscript(c.id);
					break;
				}
				case "action":
					this.pickerAction(event.act, selected());
					break;
			}
		} else if (event.type === "action" && event.act === "transcript") {
			// A preview "Recent activity" row.
			const c = selected();
			if (c) this.openTranscript(c.id);
		}
		this.requestRender();
	}

	private pickerAction(act: string, c: Child | undefined): void {
		switch (act) {
			case "open":
				if (c) this.openTranscript(c.id);
				return;
			case "kill":
				// A click asks first (the picker's confirmation strip); the `x` key kills at once.
				if (c && c.status !== "aborted") this.killConfirm = c.id;
				else if (c) this.kill(c);
				return;
			case "confirm-kill": {
				const target = this.killConfirm ? this.deps.hub.children.get(this.killConfirm) : undefined;
				this.killConfirm = undefined;
				if (target) this.kill(target);
				return;
			}
			case "cancel":
				this.killConfirm = undefined;
				return;
			case "view":
				this.mode = this.mode === "tree" ? "flat" : "tree";
				this.rosterTop = 0;
				return;
			case "filter":
				this.filterEditing = true;
				this.filter.focused = this._focused;
				return;
			case "clear":
				this.filter.setValue("");
				this.filterEditing = false;
				this.filter.focused = false;
				this.rosterTop = 0;
				return;
			case "close":
				this.close();
				return;
		}
	}

	// ---------- render ----------

	render(width: number): string[] {
		this.nativeShown = false;
		const height = this.height();
		const lines = this.transcript ? this.transcript.render(width, height, this.frame) : this.renderList(width, height);
		const out = lines.slice(0, height).map((l) => clip(l, width));
		while (out.length < height) out.push("");
		return out;
	}

	private renderList(width: number, height: number): string[] {
		const f: Frame = { theme: this.deps.theme, width };
		const rows = this.rows();
		const i = this.selectedIndex(rows);
		const selected = i >= 0 ? rows[i] : undefined;
		const body = Math.max(1, height - 4);
		const inner = Math.max(1, width - 4);
		const split = width >= SPLIT_MIN_WIDTH;
		const out: string[] = [];
		if (split) {
			const leftWidth = Math.max(ROSTER_MIN_WIDTH, Math.min(Math.floor((width - 7) * 0.56), width - 7 - DETAIL_MIN_WIDTH));
			const left = this.rosterLines(rows, i, leftWidth, body);
			const right = this.detailLines(selected, Math.max(1, width - leftWidth - 7), body);
			out.push(topBorder(f, "Agent Hub", leftWidth + 2));
			for (let r = 0; r < body; r++) out.push(splitRow(f, left[r] ?? "", right[r] ?? "", leftWidth));
			out.push(divider(f, leftWidth + 2));
		} else {
			const showDetails = this.narrowDetails && !!selected;
			out.push(topBorder(f, showDetails ? `Agent Hub · ${selected!.id}` : "Agent Hub"));
			const content = showDetails ? this.detailLines(selected, inner, body) : this.rosterLines(rows, i, inner, body);
			for (let r = 0; r < body; r++) out.push(boxRow(f, content[r] ?? ""));
			out.push(divider(f));
		}
		out.push(boxRow(f, this.footer(split, inner)));
		out.push(bottomBorder(f));
		return out;
	}

	private footer(split: boolean, width: number): string {
		const t = this.deps.theme;
		const next = this.mode === "tree" ? "flat" : "by parent";
		const q = this.filter.getValue();
		const filter = this.filterEditing
			? `/${this.filter.render(Math.max(4, visibleWidth(q) + 1))[0] ?? q}  `
			: q
				? `/${q}  `
				: "";
		if (this.filterEditing) return `${filter}${t.fg("dim", "enter:apply  esc:clear")}`;
		const keys = split
			? `j/k:select  enter:open  t:${next}  /:filter  x:kill  pgup/pgdn:details  ←←/esc:close`
			: this.narrowDetails
				? `tab:roster  pgup/pgdn:scroll  enter:open  esc:roster`
				: `j/k:select  enter:open  t:${next}  tab:details  x:kill  esc:close`;
		return clip(`${filter}${t.fg("dim", keys)}`, width);
	}

	private summaryLines(rows: Child[], width: number): string[] {
		const t = this.deps.theme;
		const all = [...this.deps.hub.children.values()];
		const active = (l: string) => t.bg("selectedBg", t.bold(t.fg("accent", ` ${l} `)));
		const inactive = (l: string) => t.fg("muted", ` ${l} `);
		const toggle =
			this.mode === "tree" ? `${active("By parent")}${t.fg("dim", "/")}${inactive("Flat")}` : `${inactive("By parent")}${t.fg("dim", "/")}${active("Flat")}`;
		const counts: string[] = [];
		const count = (s: string) => all.filter((c) => c.status === s).length;
		for (const [status, label] of [
			["running", "running"],
			["pending", "queued"],
			["idle", "idle"],
			["failed", "failed"],
			["aborted", "killed"],
		] as const) {
			const n = count(status);
			if (n) counts.push(`${statusIcon(status, t, this.frame)} ${t.fg(status === "failed" || status === "aborted" ? "error" : status === "idle" ? "success" : "accent", `${n} ${label}`)}`);
		}
		const dot = t.fg("dim", " · ");
		const header = [`${t.bold("Roster")}`, toggle, ...counts].join(dot);
		const lines = wrapTextWithAnsi(header, Math.max(1, width));
		if (all.length) {
			const now = Date.now();
			let cost = 0;
			let req = 0;
			let tools = 0;
			for (const c of all) {
				const s = snapshotChild(c, 0, now, false);
				cost += s.cost;
				req += s.requests;
				tools += s.toolCount;
			}
			const usage = [
				t.fg("warning", `$${cost.toFixed(2)}`),
				t.fg("dim", `${req} req`),
				t.fg("dim", `${tools} tools`),
				t.fg("dim", `${all.length} agent${all.length === 1 ? "" : "s"}${rows.length !== all.length ? ` (${rows.length} shown)` : ""}`),
			].join(dot);
			lines.push(clip(usage, width));
		}
		return lines;
	}

	/** Tree rails of `c` (oh-my-pi treeBranch/treeContinuation): connectors hang under the owner's status icon. */
	private rails(c: Child): { head: string; cont: string } {
		if (this.mode !== "tree" || this.filter.getValue().trim() || c.depth <= 1) return { head: "", cont: "" };
		const { hub } = this.deps;
		const isLast = (x: Child) => {
			const owned = hub.children.get(x.ownerId)?.owned;
			return !owned || owned[owned.length - 1] === x;
		};
		const chain: Child[] = [];
		for (let x: Child | undefined = c; x && x.depth > 1; x = hub.children.get(x.ownerId)) chain.unshift(x);
		const above = chain
			.slice(0, -1)
			.map((a) => (isLast(a) ? "   " : "│  "))
			.join("");
		return { head: above + (isLast(c) ? "└─ " : "├─ "), cont: above + (isLast(c) ? "   " : "│  ") };
	}

	/** One roster entry: status row (render.ts formatRow), task, current activity. */
	entryLines(c: Child, selected: boolean, width: number): string[] {
		const t = this.deps.theme;
		const snap: RowSnapshot = snapshotChild(c, 0, Date.now(), false);
		const { head, cont } = this.rails(c);
		const cursor = selected ? t.fg("accent", "›") : " ";
		let row = formatRow(snap, t, Number.POSITIVE_INFINITY, this.frame);
		if ((this.mode === "flat" || this.filter.getValue().trim()) && c.ownerId !== PARENT_ID) row += ` ${t.fg("dim", `↳ ${c.ownerId}`)}`;
		const unread = c.inbox.length;
		if (unread) row += ` ${t.fg("warning", `⧉ ${unread}`)}`;
		const lines = [clip(`${cursor} ${t.fg("dim", head)}${row}`, width)];
		const ownRail = this.mode === "tree" && !this.filter.getValue().trim() && c.owned.length ? "│ " : "  ";
		const indent = `  ${t.fg("dim", cont + ownRail)}`;
		lines.push(clip(`${indent}${t.fg("muted", flat(firstLine(c.task, 400)))}`, width));
		const act = activityText(snap, t);
		if (act) lines.push(clip(`${indent}${t.fg("dim", "↳")} ${act}`, width));
		if (selected) lines[0] = t.bg("selectedBg", pad(lines[0]!, width));
		return lines;
	}

	private rosterLines(rows: Child[], selectedIdx: number, width: number, height: number): string[] {
		const t = this.deps.theme;
		const lines = this.summaryLines(rows, width);
		if (height >= 8) lines.push("");
		const budget = Math.max(0, height - lines.length - (this.notice ? 1 : 0));
		if (rows.length === 0) {
			const empty = this.deps.hub.children.size
				? [t.fg("muted", `No agents match "${this.filter.getValue()}".`)]
				: [
						`${t.fg("muted", "○")} ${t.bold("No agents in this session")}`,
						t.fg("dim", "Subagents spawned with the task tool show up here, live, with their nested agents."),
					];
			lines.push(...empty.slice(0, budget).map((l) => clip(l, width)));
		} else {
			// Entries (each a few lines) in a window that keeps the selection visible.
			const entries = rows.map((c, k) => this.entryLines(c, k === selectedIdx, width));
			const starts: number[] = [];
			let total = 0;
			for (const e of entries) {
				starts.push(total);
				total += e.length;
			}
			const flatLines = entries.flat();
			if (total <= budget) {
				this.rosterTop = 0;
				lines.push(...flatLines);
			} else {
				const room = Math.max(1, budget - 2); // overflow markers
				const selStart = starts[selectedIdx] ?? 0;
				const selEnd = selStart + (entries[selectedIdx]?.length ?? 1);
				if (selStart < this.rosterTop) this.rosterTop = selStart;
				if (selEnd > this.rosterTop + room) this.rosterTop = selEnd - room;
				this.rosterTop = Math.max(0, Math.min(this.rosterTop, total - room));
				const above = entries.filter((_, k) => starts[k]! + entries[k]!.length <= this.rosterTop).length;
				const below = entries.filter((_, k) => starts[k]! >= this.rosterTop + room).length;
				lines.push(above ? t.fg("dim", `… ${above} more above`) : "");
				lines.push(...flatLines.slice(this.rosterTop, this.rosterTop + room));
				lines.push(below ? t.fg("dim", `… ${below} more below`) : "");
			}
		}
		const out = lines.slice(0, Math.max(0, height - (this.notice ? 1 : 0)));
		if (this.notice) {
			while (out.length < height - 1) out.push("");
			out.push(this.noticeLine(this.notice, width));
		}
		return out;
	}

	private noticeLine(n: Notice, width: number): string {
		return clip(this.deps.theme.fg(n.tone, flat(n.text)), width);
	}

	/** Detail pane of the selected agent (oh-my-pi #renderDetailPanel). */
	detailLines(c: Child | undefined, width: number, height: number): string[] {
		const t = this.deps.theme;
		if (!c) return [t.fg("dim", "Select an agent to inspect")];
		const now = Date.now();
		const snap = snapshotChild(c, 0, now, false);
		const lines: string[] = [];
		const add = (l = "") => lines.push(clip(l, width));
		const wrapped = (text: string, max: number, color: "muted" | "dim" | "text" = "muted") => {
			const w = wrapTextWithAnsi(flat(text), Math.max(1, width - 2));
			for (const l of w.slice(0, max)) add(`  ${t.fg(color, l)}`);
			if (w.length > max) add(`  ${t.fg("dim", "…")}`);
		};
		const section = (label: string) => {
			if (lines.length) add();
			add(t.bold(t.fg("accent", label)));
		};
		add(`${statusIcon(c.status, t, this.frame)} ${t.bold(c.id)} ${t.fg("dim", `⟨${c.agent.name}⟩`)}`);
		const state = c.status === "pending" ? (c.queued ? "queued" : "starting") : c.blocked ? "waiting for subagents" : c.status;
		const busy = c.status === "running" && !c.blocked && (c.runningTools.size > 0 || !!c.session?.isStreaming);
		const facts = [snap.durationMs ? `${(snap.durationMs / 1000).toFixed(1)}s` : "", busy ? "active now" : `active ${fmtAge(now - lastActivity(c))} ago`].filter(Boolean);
		add(`${t.fg(c.status === "failed" || c.status === "aborted" ? "error" : c.status === "idle" ? "success" : "accent", state)}${t.fg("dim", ` · ${facts.join(" · ")}`)}`);
		const model = [c.modelLabel, c.thinking && c.thinking !== "off" ? c.thinking : "", c.isolated ? "[isolated]" : "", c.schema ? "{} structured" : ""].filter(Boolean);
		if (model.length) add(t.fg("muted", model.join(" · ")));
		section("Task");
		wrapped(c.task, 4);
		const act = activityText(snap, t);
		if (act) {
			section("Current");
			add(`  ${act}`);
		}
		if (c.error && c.status !== "running") {
			section("Error");
			wrapped(c.error, 3, "text");
		}
		section("Usage");
		add(`  ${usageText(snap, t)}`);
		section("Lineage");
		add(`  ${t.fg("muted", `Spawned by ${c.ownerId === PARENT_ID ? "main" : c.ownerId}`)}${c.owned.length ? t.fg("muted", ` · ${c.owned.length} subagent${c.owned.length === 1 ? "" : "s"}`) : ""}`);
		if (c.owned.length) {
			const live = activeDescendants(c).length;
			add(`  ${t.fg("dim", clip(c.owned.map((o) => o.id).join(", "), width - 2))}${live ? t.fg("dim", ` (${live} active)`) : ""}`);
		}
		if (c.worktree) add(`  ${t.fg("dim", `worktree ${c.worktree.path}`)}`);
		if (c.done?.merge) add(`  ${t.fg("dim", c.done.merge.message)}`);
		section("Recent activity");
		const recent = c.activity.slice(-Math.max(3, height));
		if (!recent.length) add(`  ${t.fg("muted", "No response or tool activity yet")}`);
		for (const a of recent) add(`  ${t.fg("muted", flat(a))}`);
		const maxScroll = Math.max(0, lines.length - height);
		this.detailScroll = Math.min(this.detailScroll, maxScroll);
		return lines.slice(this.detailScroll, this.detailScroll + height);
	}
}

// ---------------------------------------------------------------------------------------------
// Transcript view (oh-my-pi agent-transcript-viewer.ts)

type AnyMessage = { role: string; [k: string]: any };

function userText(m: AnyMessage): string {
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	return m.content
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text as string)
		.join("\n");
}

/** Cheap change signature of a streaming assistant message. */
function streamSig(m: AnyMessage): string {
	const parts = Array.isArray(m.content) ? m.content : [];
	return parts
		.map((c: any) => `${c?.type}:${(c?.text ?? c?.thinking ?? "").length}:${c?.type === "toolCall" ? JSON.stringify(c.arguments ?? {}).length : 0}`)
		.join(",");
}

class TranscriptView {
	editor: Editor | undefined;
	notice: Notice | undefined;
	private readonly container = new Container();
	private entries: Array<{ msg: AnyMessage; comps: Component[] }> = [];
	private hasContent = false;
	private tools = new Map<string, ToolExecutionComponent>();
	private stream: { msg: AnyMessage; sig: string; assistant: AssistantMessageComponent; tools: Map<string, ToolExecutionComponent> } | undefined;
	private session: unknown;
	private expanded = false;
	private hideThinking = false;
	private follow = true;
	private top = 0;
	private lastBody = { total: 0, budget: 1 };
	private killArmedAt = 0;
	private readonly taps = new LeftDoubleTap();
	/** Native: the transcript's components without pi's spacers (the column's gap spaces them), per children array. */
	private entriesMemo: { from: readonly Component[]; comps: readonly NativeUiChild[] } | undefined;
	private nativeMemo: { deps: readonly unknown[]; node: NativeUiNode } | undefined;
	/** Drawn natively (describe, not render, ran last): the terminal scrolls, so j/k/g/G stay the editor's. */
	private nativeDrawn = false;

	constructor(
		private readonly deps: InspectorDeps,
		readonly id: string,
		private readonly onNotice: (n: Notice) => void,
		private readonly onKill: (c: Child) => void,
	) {
		const child = deps.hub.children.get(id);
		if (child && child.status !== "aborted") {
			const t = deps.theme;
			this.editor = new Editor(deps.tui, { borderColor: (s) => t.fg("borderMuted", s), selectList: getSelectListTheme() }, { paddingX: 1 });
			this.editor.onSubmit = (text) => this.submit(text);
		}
	}

	setFocused(focused: boolean): void {
		if (this.editor) this.editor.focused = focused;
	}

	invalidate(): void {
		this.container.invalidate();
	}

	dispose(): void {
		this.entries = [];
		this.tools.clear();
		this.stream = undefined;
		this.container.clear();
	}

	private child(): Child | undefined {
		return this.deps.hub.children.get(this.id);
	}

	/** Esc: clear a non-empty draft first, else back to the roster. */
	private escape(): "back" | undefined {
		if (this.editor && this.editor.getText().trim() !== "") {
			this.editor.setText("");
			return undefined;
		}
		return "back";
	}

	/** ctrl+x (or the Kill button): the first press arms, a second one within KILL_CONFIRM_MS kills. */
	private armKill(): void {
		const child = this.child();
		if (!child || child.status === "aborted") {
			this.notice = { text: `${this.id} is already killed.`, tone: "muted" };
			return;
		}
		const now = Date.now();
		if (now - this.killArmedAt < KILL_CONFIRM_MS) {
			this.killArmedAt = 0;
			this.onKill(child);
		} else {
			this.killArmedAt = now;
			this.notice = { text: `Press ctrl+x again (or click Confirm kill) to kill ${this.id}${child.owned.length ? " and its subagents" : ""}.`, tone: "warning" };
		}
	}

	private submit(text: string): void {
		const body = text.trim();
		if (!body) return;
		const child = this.child();
		this.notice = { text: `Sending to ${this.id}…`, tone: "muted" };
		this.deps.hub.send(USER_ID, this.id, body).then(
			(receipt) => this.onNotice({ text: `${this.id}: ${receipt}`, tone: "success" }),
			(e) => this.onNotice({ text: e instanceof Error ? e.message : String(e), tone: "error" }),
		);
		if (child) this.follow = true;
	}

	// ---------- transcript model ----------

	private toolComponent(name: string, id: string, args: unknown, child: Child): ToolExecutionComponent {
		const session = child.session as { getToolDefinition?: (n: string) => any } | undefined;
		let def: any;
		try {
			def = session?.getToolDefinition?.(name);
		} catch {}
		const comp = new ToolExecutionComponent(name, id, args, { showImages: false, outputPad: 1 }, def, this.deps.tui, child.cwd);
		comp.setExpanded(this.expanded);
		return comp;
	}

	private build(msg: AnyMessage, child: Child, first: boolean): Component[] {
		const md = getMarkdownTheme();
		switch (msg.role) {
			case "user": {
				const text = userText(msg);
				if (!text) return [];
				return [...(first ? [] : [new Spacer(1)]), new UserMessageComponent(text, md, 1)];
			}
			case "assistant": {
				const comps: Component[] = [new AssistantMessageComponent(msg as any, this.hideThinking, md, "Thinking...", 1)];
				for (const part of msg.content ?? []) {
					if (part?.type !== "toolCall") continue;
					const tool = this.toolComponent(part.name, part.id, part.arguments, child);
					if (msg.stopReason === "aborted" || msg.stopReason === "error") {
						tool.updateResult({ content: [{ type: "text", text: msg.stopReason === "aborted" ? "Operation aborted" : msg.errorMessage || "Error" }], isError: true });
					} else {
						this.tools.set(part.id, tool);
					}
					comps.push(tool);
				}
				return comps;
			}
			case "toolResult": {
				this.tools.get(msg.toolCallId)?.updateResult(msg as any);
				return [];
			}
			case "custom": {
				if (!msg.display) return [];
				const comp = new CustomMessageComponent(msg as any, undefined, md, 1);
				comp.setExpanded(this.expanded);
				return [new Spacer(1), comp];
			}
			case "bashExecution":
				return [new Spacer(1), new NoteLeaf(`$ ${msg.command ?? ""}`, "muted", () => this.deps.theme)];
			case "compactionSummary":
			case "branchSummary":
				return [new Spacer(1), new NoteLeaf(`[${msg.role === "compactionSummary" ? "compacted" : "branch summary"}]`, "dim", () => this.deps.theme)];
			default:
				return [];
		}
	}

	/** Bring the components in line with the agent's session (cheap when nothing changed). */
	sync(): void {
		const child = this.child();
		const session = child?.session as { messages?: AnyMessage[]; state?: { streamingMessage?: AnyMessage; pendingToolCalls?: ReadonlySet<string> } } | undefined;
		if (session !== this.session) {
			this.entries = [];
			this.tools.clear();
			this.stream = undefined;
			this.hasContent = false;
			this.session = session;
		}
		if (!child || !session) {
			this.container.children = [];
			return;
		}
		const msgs = session.messages ?? [];
		let changed = false;
		let k = 0;
		while (k < this.entries.length && k < msgs.length && this.entries[k]!.msg === msgs[k]) k++;
		if (k < this.entries.length) {
			// History rewritten (compaction, retry): rebuild from scratch.
			this.entries = [];
			this.tools.clear();
			this.hasContent = false;
			k = 0;
		}
		for (; k < msgs.length; k++) {
			const msg = msgs[k]!;
			const comps = this.build(msg, child, !this.hasContent);
			if (comps.length) this.hasContent = true;
			this.entries.push({ msg, comps });
			changed = true;
		}
		for (const id of session.state?.pendingToolCalls ?? []) this.tools.get(id)?.markExecutionStarted();

		const sm = session.state?.streamingMessage;
		const streaming = sm && sm.role === "assistant" && !msgs.includes(sm) ? sm : undefined;
		if (!streaming) {
			if (this.stream) changed = true;
			this.stream = undefined;
		} else {
			const sig = streamSig(streaming);
			if (!this.stream) {
				this.stream = {
					msg: streaming,
					sig,
					assistant: new AssistantMessageComponent(streaming as any, this.hideThinking, getMarkdownTheme(), "Thinking...", 1),
					tools: new Map(),
				};
				changed = true;
			} else if (this.stream.msg !== streaming || this.stream.sig !== sig) {
				this.stream.msg = streaming;
				this.stream.sig = sig;
				this.stream.assistant.updateContent(streaming as any, true);
				changed = true;
			}
			for (const part of streaming.content ?? []) {
				if (part?.type !== "toolCall") continue;
				const existing = this.stream.tools.get(part.id);
				if (existing) existing.updateArgs(part.arguments);
				else {
					this.stream.tools.set(part.id, this.toolComponent(part.name, part.id, part.arguments, child));
					changed = true;
				}
			}
		}
		if (changed) {
			this.container.children = [
				...this.entries.flatMap((e) => e.comps),
				...(this.stream ? [this.stream.assistant as Component, ...this.stream.tools.values()] : []),
			];
		}
	}

	private setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const e of this.entries) for (const c of e.comps) (c as { setExpanded?: (x: boolean) => void }).setExpanded?.(expanded);
		for (const c of this.stream?.tools.values() ?? []) c.setExpanded(expanded);
		this.container.invalidate();
	}

	private setHideThinking(hide: boolean): void {
		this.hideThinking = hide;
		for (const e of this.entries) for (const c of e.comps) if (c instanceof AssistantMessageComponent) c.setHideThinkingBlock(hide);
		this.stream?.assistant.setHideThinkingBlock(hide);
		this.container.invalidate();
	}

	// ---------- input ----------

	private scrollBy(n: number): void {
		const { total, budget } = this.lastBody;
		const max = Math.max(0, total - budget);
		const from = this.follow ? max : this.top;
		this.top = Math.max(0, Math.min(max, from + n));
		this.follow = this.top >= max;
	}

	handleInput(data: string): "back" | "close" | undefined {
		const kb = this.deps.keybindings;
		if (HUB_KEYS.some((k) => matchesKey(data, k))) return "close";
		if (matchesKey(data, "escape")) return this.escape();
		if (kb.matches(data, "app.tools.expand")) {
			this.setExpanded(!this.expanded);
			return undefined;
		}
		if (kb.matches(data, "app.thinking.toggle")) {
			this.setHideThinking(!this.hideThinking);
			return undefined;
		}
		if (matchesKey(data, "ctrl+x")) {
			this.armKill();
			return undefined;
		}
		const empty = !this.editor || this.editor.getText().trim() === "";
		if (empty) {
			// Once the user starts typing a message, the editor owns every key.
			const page = Math.max(1, this.lastBody.budget - 2);
			if (matchesKey(data, "left")) {
				if (isKeyRepeat(data)) this.taps.burst();
				else if (this.taps.tap()) return "back";
			} else if (this.nativeDrawn) {
				// Natively the terminal scrolls the transcript: every other key is the message field's.
			} else if (data === "j" || matchesKey(data, "down")) {
				this.scrollBy(1);
				return undefined;
			} else if (data === "k" || matchesKey(data, "up")) {
				this.scrollBy(-1);
				return undefined;
			} else if (matchesKey(data, "shift+down")) {
				this.scrollBy(5);
				return undefined;
			} else if (matchesKey(data, "shift+up")) {
				this.scrollBy(-5);
				return undefined;
			} else if (matchesKey(data, "pageDown")) {
				this.scrollBy(page);
				return undefined;
			} else if (matchesKey(data, "pageUp")) {
				this.scrollBy(-page);
				return undefined;
			} else if (data === "g" || matchesKey(data, "home")) {
				this.follow = false;
				this.top = 0;
				return undefined;
			} else if (data === "G" || matchesKey(data, "end")) {
				this.follow = true;
				return undefined;
			}
		}
		this.editor?.handleInput(data);
		return undefined;
	}

	// ---------- native (tsp-native) ----------

	/** The primary key of a keybinding, for a button's keycap (`ctrl+o`). */
	private keyOf(binding: string, fallback: string): string {
		try {
			const keys = (this.deps.keybindings as unknown as { getKeys?: (b: string) => string[] }).getKeys?.(binding);
			return keys?.[0] ?? fallback;
		} catch {
			return fallback;
		}
	}

	/** The agent's messages are pi's own components (described by tsp-native's describers), plus a native message field. */
	describe(cx: NativeComponentContext): NativeUiNode | null {
		if (!supportsAll(cx, TRANSCRIPT_KINDS)) return null;
		this.nativeDrawn = true;
		this.sync();
		const child = this.child();
		// Killed while open: read-only from now on.
		if (this.editor && (!child || child.status === "aborted")) this.editor = undefined;
		const now = Date.now();
		const draft = this.editor ? editorDraft(this.editor) : undefined;
		const killArmed = now - this.killArmedAt < KILL_CONFIRM_MS;
		const children = this.container.children;
		const deps: unknown[] = [
			child ? hubSignature(child) : "",
			child?.session,
			children,
			this.expanded,
			this.hideThinking,
			this.notice,
			killArmed,
			draft?.text,
			draft?.cursor,
			cx.supports("progress"),
			cx.supports("elapsed"),
			cx.supports("editor"),
		];
		if (this.nativeMemo && sameDeps(this.nativeMemo.deps, deps)) return this.nativeMemo.node;
		let body: HubTranscriptView["body"];
		let count = 0;
		if (!child) body = { kind: "note", text: `Agent ${this.id} is gone.`, tone: "error" };
		else if (!child.session) {
			body = { kind: "note", text: child.status === "pending" ? (child.queued ? "Queued for a run slot…" : "Starting…") : (child.error ?? "No session."), tone: "dim" };
		} else {
			let memo = this.entriesMemo;
			if (!memo || memo.from !== children) {
				memo = { from: children, comps: children.filter((c) => !(c instanceof Spacer)) };
				this.entriesMemo = memo;
			}
			const comps = memo.comps;
			count = comps.length;
			body = count > 0 ? { kind: "entries", children: comps } : { kind: "note", text: "No messages yet.", tone: "dim" };
		}
		const node = hubTranscript({
			id: this.id,
			child,
			now,
			body,
			endKey: `end-${count}`,
			notice: this.notice,
			input: draft ? { text: draft.text, cursor: draft.cursor, multiline: draft.text.includes("\n") } : undefined,
			expanded: this.expanded,
			hideThinking: this.hideThinking,
			killArmed,
			keys: { expand: this.keyOf("app.tools.expand", "ctrl+o"), thinking: this.keyOf("app.thinking.toggle", "ctrl+t") },
			progress: cx.supports("progress"),
			elapsed: cx.supports("elapsed"),
			editor: cx.supports("editor"),
		});
		this.nativeMemo = { deps, node };
		return node;
	}

	/** Pointer and host-edit events on the native transcript: the same paths as the keys. */
	handleNativeEvent(event: NativeUiEvent): "back" | "close" | undefined {
		const leaf = leafKey(event.key);
		switch (event.type) {
			case "action":
				switch (event.act) {
					case "esc":
						return this.escape();
					case "back":
						return "back";
					case "close":
						return "close";
					case "kill":
						this.armKill();
						return undefined;
					case "expand":
						this.setExpanded(!this.expanded);
						return undefined;
					case "thinking":
						this.setHideThinking(!this.hideThinking);
						return undefined;
				}
				return undefined;
			case "edit":
				if (leaf === "message" && this.editor) applyHostEdit(this.editor, event);
				return undefined;
			case "undo":
				if (leaf === "message" && this.editor) (this.editor as unknown as EditorInternals).undo?.();
				return undefined;
			case "send": {
				if (leaf !== "message" || !this.editor) return undefined;
				const value = event.text.trim();
				if (!value) return undefined;
				if (this.editor.getText().trim() === value) this.editor.setText("");
				this.submit(value);
				return undefined;
			}
			default:
				return undefined;
		}
	}

	// ---------- render ----------

	render(width: number, height: number, frame: number): string[] {
		this.nativeDrawn = false;
		this.sync();
		const t = this.deps.theme;
		const f: Frame = { theme: t, width };
		const child = this.child();
		// Killed while open: read-only from now on.
		if (this.editor && (!child || child.status === "aborted")) this.editor = undefined;
		const header: string[] = [];
		header.push(clip(` ${t.bold(t.fg("accent", "Agent Hub"))}${t.fg("dim", " · ")}${t.fg("accent", this.id)}`, width));
		if (child) {
			const snap = snapshotChild(child, 0, Date.now(), false);
			const owner = child.ownerId === PARENT_ID ? "main" : child.ownerId;
			header.push(clip(` ${formatRow(snap, t, Number.POSITIVE_INFINITY, frame)}${t.fg("dim", ` · of ${owner}`)}`, width));
		}

		const footer: string[] = [];
		const notice = this.notice;
		if (notice) footer.push(clip(` ${t.fg(notice.tone, flat(notice.text))}`, width));
		if (this.editor) footer.push(...this.editor.render(width));
		else footer.push(rule(f));
		if (child) {
			const act = activityText(snapshotChild(child, 0, Date.now(), false), t);
			if (act) footer.push(clip(` ${t.fg("dim", "↳")} ${act}`, width));
		}
		const keys = this.editor
			? "enter:send  esc/←←:back  ^x:kill  ^o:expand  ^t:thinking  ^s:close  empty input → j/k:scroll  g/G:top/bottom"
			: "killed (read-only) · esc/←←:back  ^o:expand  ^t:thinking  ^s:close  j/k:scroll  g/G:top/bottom";
		footer.push(clip(` ${t.fg("dim", keys)}`, width));

		const budget = Math.max(1, height - header.length - 1 - footer.length);
		let body: string[];
		if (!child) body = [` ${t.fg("error", `Agent ${this.id} is gone.`)}`];
		else if (!child.session) body = [` ${t.fg("dim", child.status === "pending" ? (child.queued ? "Queued for a run slot…" : "Starting…") : (child.error ?? "No session."))}`];
		else {
			body = this.container.render(width);
			if (body.length === 0) body = [` ${t.fg("dim", "No messages yet.")}`];
		}
		const total = body.length;
		const max = Math.max(0, total - budget);
		if (this.follow) this.top = max;
		this.top = Math.max(0, Math.min(this.top, max));
		if (this.top >= max) this.follow = true;
		this.lastBody = { total, budget };
		const visible = body.slice(this.top, this.top + budget);
		while (visible.length < budget) visible.push("");
		const above = this.top;
		const below = total - this.top - Math.min(budget, total - this.top);
		const label = [above ? `↑ ${above} more` : "", below > 0 ? `↓ ${below} more` : ""].filter(Boolean).join(" · ");
		return [...header, rule(f, label), ...visible, ...footer];
	}
}

/** A one-line note in the transcript (a `$ command`, a compaction marker), in a theme colour. */
class NoteLeaf implements Component {
	private native: NativeUiNode | undefined;

	constructor(
		private readonly line: string,
		private readonly color: "muted" | "dim",
		private readonly theme: () => Theme,
	) {}

	render(width: number): string[] {
		return [clip(` ${this.theme().fg(this.color, this.line)}`, width)];
	}

	describe(cx: NativeComponentContext): NativeUiNode | null {
		if (!cx.supports("text")) return null;
		this.native ??= uiNode("text", { spans: [{ t: this.line, s: `${this.color} mono` }], wrap: "word" });
		return this.native;
	}

	invalidate(): void {}
}

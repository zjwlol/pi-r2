/**
 * word-predict's hook into pi's prompt editor: the ghost painted after the
 * caret and the keys that accept it.
 *
 * Only one editor component can be installed (magic-keywords owns that slot),
 * so two methods of pi-tui's `Editor` class are wrapped instead:
 *   - render:      paint the ghost into the cursor row (ghost-row.ts)
 *   - handleInput: Tab accepts the ghost with a provisional space, Right
 *                  without; every other key is pi's, and afterwards the
 *                  provisional space is resolved and a typed-past ghost reported
 * Under tsp-native the ghost goes out through the composer's ghost slot
 * (shared/composer-slots.ts) and the terminal draws it; a tap on it arrives as Tab.
 *
 * The prototype is patched once per process; the wrappers are thin trampolines
 * to a registry on `globalThis` that each extension runtime (a fresh module
 * copy after /reload) points at its own hook and clears when it unloads. With
 * no active hook, for an editor that is not the prompt editor, or when
 * anything about the editor's shape is unexpected, they are pi-tui's own
 * methods; nothing the hook throws leaves them.
 *
 * Port of oh-my-pi `packages/tui/src/components/editor.ts` (MIT):
 * `#getWordCompletion`, `#acceptWordCompletion`, the provisional-space handling
 * of `#insertCharacter` / `#addNewLine`, `#reportTypedPastWordCompletion` and
 * the `ghost` of `describe`.
 */
import { Editor, getKeybindings, isKeyRelease, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ComposerGhostProvider, composerGhostProvider, isComposerHosted, setComposerGhost } from "../shared/composer-slots.ts";
import {
	divergesFromGhost,
	type EditorSnapshot,
	FAKE_CURSOR_END,
	FAKE_CURSOR_START,
	insertedText,
	paintGhost,
	type ProvisionalSpace,
	provisionalOutcome,
	type RowMeasure,
} from "./ghost-row.ts";
import type { WordCompletionProvider } from "./provider.ts";

export interface EditorHookDeps {
	provider: WordCompletionProvider;
	enabled(): boolean;
	/** Dim style for the ghost (theme "dim"). */
	style(text: string): string;
}

export interface EditorHookStatus {
	installed: boolean;
	seenEditor: boolean;
	lastPaint: "ansi" | "native" | null;
}

export interface EditorHookHandle {
	status(): EditorHookStatus;
	dispose(): void;
}

/** Loose view of the editor's (TS-private, runtime-public) state. */
type Any = Record<string, any>;

/** What the trampolines delegate to; one per extension runtime. */
interface EditorHook {
	/** The rows pi-tui rendered for `editor`, with the ghost painted in when there is one. */
	render(editor: unknown, width: number, rows: string[]): string[];
	/** One key for `editor`; `pass` hands it to pi-tui's own handler (at most once). */
	input(editor: unknown, data: unknown, pass: () => void): void;
}

interface Registry {
	patched: { render: Function; handleInput: Function } | null;
	active: EditorHook | null;
}

const REG = Symbol.for("pi-extended.word-predict.editor-hook");

function registry(): Registry {
	const holder = globalThis as unknown as { [REG]?: Registry };
	return (holder[REG] ??= { patched: null, active: null });
}

/**
 * Wrap `Editor.prototype.render` / `.handleInput` once per process. Returns
 * false, with nothing patched, when pi-tui does not look as expected.
 */
export function installEditorHook(): boolean {
	const reg = registry();
	if (reg.patched) return true;
	const proto = (Editor as unknown as { prototype?: Any } | undefined)?.prototype;
	if (!proto || typeof proto.render !== "function" || typeof proto.handleInput !== "function") return false;
	try {
		// The row surgery relies on this exact cursor cell.
		if (renderFakeCursor(" ") !== `${FAKE_CURSOR_START} ${FAKE_CURSOR_END}`) return false;
	} catch {
		return false;
	}
	const patched = { render: proto.render as Function, handleInput: proto.handleInput as Function };

	proto.render = function (this: unknown, width: number): string[] {
		const rows: string[] = patched.render.call(this, width);
		const hook = reg.active;
		if (!hook) return rows;
		try {
			const painted = hook.render(this, width, rows);
			return Array.isArray(painted) ? painted : rows;
		} catch {
			return rows;
		}
	};

	proto.handleInput = function (this: unknown, data: unknown): void {
		const hook = reg.active;
		if (!hook) {
			patched.handleInput.call(this, data);
			return;
		}
		let passed = false;
		let failed = false;
		let failure: unknown;
		const pass = (): void => {
			if (passed) return;
			passed = true;
			try {
				patched.handleInput.call(this, data);
			} catch (error) {
				// pi-tui's own throw stays pi-tui's: it leaves the trampoline as it would have without the hook.
				failed = true;
				failure = error;
				throw error;
			}
		};
		try {
			hook.input(this, data, pass);
		} catch {
			if (failed) throw failure;
			// The hook broke before the key reached pi: pi handles it as usual.
			if (!passed) pass();
		}
	};

	reg.patched = patched;
	return true;
}

/** pi's prompt editor (a CustomEditor: app action handlers); the same test tsp-native's describers use. */
function isPromptEditor(editor: unknown): editor is Any {
	return typeof editor === "object" && editor !== null && (editor as Any).actionHandlers instanceof Map;
}

function hasState(a: Any): boolean {
	const state = a.state;
	return (
		typeof state === "object" &&
		state !== null &&
		Array.isArray(state.lines) &&
		Number.isInteger(state.cursorLine) &&
		Number.isInteger(state.cursorCol)
	);
}

/** Everything the key handling touches is there; otherwise the key is left to pi-tui. */
function hasKeyInternals(a: Any): boolean {
	return (
		hasState(a) &&
		"autocompleteState" in a &&
		"jumpMode" in a &&
		"isInPaste" in a &&
		typeof a.insertTextAtCursor === "function" &&
		typeof a.undo === "function" &&
		typeof a.getText === "function" &&
		typeof a.tui?.requestRender === "function"
	);
}

function snapshot(a: Any, copy: boolean): EditorSnapshot {
	const { lines, cursorLine, cursorCol } = a.state;
	return { lines: copy ? lines.slice() : lines, cursorLine, cursorCol };
}

function undoDepth(a: Any): number | undefined {
	const depth: unknown = a.undoStack?.length;
	return typeof depth === "number" ? depth : undefined;
}

function setCursorCol(a: Any, col: number): void {
	if (typeof a.setCursorCol === "function") a.setCursorCol(col);
	else a.state.cursorCol = col;
}

function notifyChange(a: Any): void {
	if (typeof a.onChange === "function") a.onChange(a.getText());
}

/**
 * pi-tui's width functions. Its `truncateToWidth` closes the cut text and the
 * ellipsis with SGR resets, which would end the ghost's dim style before the
 * `…`; a ghost is plain text, so they are dropped.
 */
const MEASURE: RowMeasure = {
	visibleWidth,
	truncateToWidth: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis).replaceAll("\x1b[0m", ""),
};

/** Install the trampolines if needed and make this hook the active one; `{ error }` when pi-tui does not match. */
export function activateEditorHook(deps: EditorHookDeps): EditorHookHandle | { error: string } {
	if (!installEditorHook()) {
		return { error: "pi-tui's Editor is not what this version expects (render / handleInput / the cursor cell)" };
	}
	const reg = registry();
	const { provider } = deps;
	/** The last prompt editor rendered, described or typed into: the one an engine answer repaints. */
	let lastEditor: WeakRef<object> | undefined;
	let seenEditor = false;
	let lastPaint: EditorHookStatus["lastPaint"] = null;
	/** The provisional space of each editor's last Tab accept, valid for its next key only. */
	const provisional = new WeakMap<object, ProvisionalSpace>();

	const see = (a: Any): void => {
		seenEditor = true;
		if (lastEditor?.deref() !== a) lastEditor = new WeakRef(a);
	};

	/** The ghost shown for `a` in its current state: only with the caret at the end of its (logical) line and pi's popup closed. */
	const ghostFor = (a: Any): string | null => {
		if (!deps.enabled() || a.autocompleteState || !hasState(a)) return null;
		const { lines, cursorLine, cursorCol } = a.state;
		const line: unknown = lines[cursorLine];
		if (cursorCol < (typeof line === "string" ? line.length : 0)) return null;
		const ghost: unknown = provider.getWordCompletion(lines, cursorLine, cursorCol);
		return typeof ghost === "string" && ghost !== "" ? ghost : null;
	};

	const feedback = (state: EditorSnapshot, ghost: string, accepted: boolean): void => {
		try {
			provider.wordCompletionFeedback(state.lines, state.cursorLine, state.cursorCol, ghost, accepted);
		} catch {
			// Feedback is advisory: the key goes on.
		}
	};

	/** The marker of `a`'s last Tab accept, when the editor still stands exactly there; any key spends it. */
	const takeProvisional = (a: Any): ProvisionalSpace | undefined => {
		const marker = provisional.get(a);
		if (!marker) return undefined;
		provisional.delete(a);
		if (!hasState(a)) return undefined;
		const { lines, cursorLine, cursorCol } = a.state;
		const valid =
			cursorLine === marker.line && cursorCol === marker.col && lines[cursorLine] === marker.text && marker.text[marker.col - 1] === " ";
		return valid ? marker : undefined;
	};

	/** Tab / Right on a shown ghost: insert it as one undo unit (Tab adds the provisional space). */
	const accept = (a: Any, ghost: string, space: boolean): void => {
		feedback(snapshot(a, false), ghost, true);
		a.insertTextAtCursor(space ? `${ghost} ` : ghost);
		try {
			if (space) {
				const { lines, cursorLine, cursorCol } = a.state;
				const text: unknown = lines[cursorLine];
				if (typeof text === "string" && text[cursorCol - 1] === " ") provisional.set(a, { line: cursorLine, col: cursorCol, text });
			}
			a.tui.requestRender();
		} catch {
			// The word is in; only the provisional space or the repaint is lost.
		}
	};

	/** The key after a Tab accept, already handled by pi: settle the provisional space (see `provisionalOutcome`). */
	const resolveProvisional = (a: Any, marker: ProvisionalSpace, before: EditorSnapshot, after: EditorSnapshot, depth: number | undefined): void => {
		const outcome = provisionalOutcome(marker, before, after);
		if (outcome === "keep") return;
		const line = before.cursorLine;
		const col = before.cursorCol;
		const text = before.lines[line]!;
		if (outcome === "swallow" && depth !== undefined && undoDepth(a) === depth + 1) {
			// pi-tui snapshots the state before every typed space, so one undo is exactly "that space was never typed".
			a.undo();
			a.tui.requestRender();
			return;
		}
		if (outcome === "swallow") {
			// No such snapshot to pop (pi-tui changed): take the typed space out by hand.
			a.state.lines[line] = text;
			setCursorCol(a, col);
		} else if (outcome === "absorb") {
			// "weather ." → "weather.": pi's snapshot for the key holds word and space, so undo gives them back.
			const typed = after.lines[line]!.slice(col, after.cursorCol);
			a.state.lines[line] = text.slice(0, col - 1) + typed + text.slice(col);
			setCursorCol(a, col - 1 + typed.length);
		} else {
			// The line was split at the caret: the space now ends the line above.
			a.state.lines[line] = text.slice(0, col - 1);
		}
		notifyChange(a);
		if (outcome === "absorb" && a.autocompleteState && typeof a.updateAutocomplete === "function") a.updateAutocomplete();
		a.tui.requestRender();
	};

	const hook: EditorHook = {
		render(editor, width, rows) {
			if (!isPromptEditor(editor)) return rows;
			see(editor);
			// Rows rendered while tsp-native hosts the composer are its fallback, not what is on screen.
			if (!isComposerHosted()) lastPaint = "ansi";
			const ghost = ghostFor(editor);
			if (!ghost) return rows;
			const own: unknown = typeof editor.getPaddingX === "function" ? editor.getPaddingX() : undefined;
			if (typeof own !== "number" || !Number.isFinite(own) || !Number.isFinite(width)) return rows;
			// The editor's own clamp of its padding.
			const paddingX = Math.min(own, Math.max(0, Math.floor((width - 1) / 2)));
			return paintGhost(rows, ghost, paddingX, deps.style, MEASURE);
		},

		input(editor, data, pass) {
			if (!isPromptEditor(editor) || typeof data !== "string") return pass();
			const a = editor;
			see(a);
			// Defensive: the TUI already drops key releases for the editor.
			if (isKeyRelease(data)) return pass();
			const marker = takeProvisional(a);
			if (!deps.enabled() || !hasKeyInternals(a)) return pass();
			if (a.jumpMode != null || a.isInPaste || data.includes("\x1b[200~")) return pass();

			// 1. Accept. An open popup keeps Tab and Right; a shown ghost takes Tab before pi's own Tab completion.
			if (!a.autocompleteState) {
				const kb = getKeybindings();
				const tab = kb.matches(data, "tui.input.tab");
				const right = !tab && kb.matches(data, "tui.editor.cursorRight");
				if (tab || right) {
					const ghost = ghostFor(a);
					if (ghost) {
						accept(a, ghost, tab);
						return;
					}
				}
			}

			// 2. Everything else is pi's; then look at what the key changed.
			const shown = ghostFor(a);
			if (!marker && !shown) return pass();
			const before = snapshot(a, true);
			const depth = undoDepth(a);
			pass();
			try {
				if (!hasState(a)) return;
				const after = snapshot(a, false);
				if (shown) {
					const typed = insertedText(before, after);
					if (typed && divergesFromGhost(shown, typed)) feedback(before, shown, false);
				}
				if (marker) resolveProvisional(a, marker, before, after, depth);
			} catch {
				// pi handled the key; what follows it is best effort.
			}
		},
	};

	/** The native path: tsp-native asks for the ghost of the editor it describes. */
	const slot: ComposerGhostProvider = {
		ghost(editor) {
			if (!isPromptEditor(editor)) return undefined;
			see(editor);
			lastPaint = "native";
			return ghostFor(editor) ?? undefined;
		},
	};

	/** An engine answer changed what is shown: repaint (both renderings start from the TUI's render). */
	const onUpdate = (): void => {
		try {
			(lastEditor?.deref() as Any | undefined)?.tui?.requestRender?.();
		} catch {
			// The editor is gone; the next render shows the ghost.
		}
	};

	reg.active = hook;
	setComposerGhost(slot);
	provider.onUpdate = onUpdate;

	return {
		status: () => ({ installed: reg.patched !== null && reg.active === hook, seenEditor, lastPaint }),
		dispose() {
			if (reg.active === hook) reg.active = null;
			if (composerGhostProvider() === slot) setComposerGhost(undefined);
			if (provider.onUpdate === onUpdate) provider.onUpdate = undefined;
			// Ghosts vanish at once, in both renderings.
			onUpdate();
		},
	};
}

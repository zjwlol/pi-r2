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

type Any = Record<string, any>;

interface EditorHook {
	render(editor: unknown, width: number, rows: string[]): string[];
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
 * Pi reloads extensions without replacing the editor prototype.
 */
export function installEditorHook(): boolean {
	const reg = registry();
	if (reg.patched) return true;
	const proto = (Editor as unknown as { prototype?: Any } | undefined)?.prototype;
	if (!proto || typeof proto.render !== "function" || typeof proto.handleInput !== "function") return false;
	try {
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
				// Only failures in the hook are safe to swallow.
				failed = true;
				failure = error;
				throw error;
			}
		};
		try {
			hook.input(this, data, pass);
		} catch {
			if (failed) throw failure;
			if (!passed) pass();
		}
	};

	reg.patched = patched;
	return true;
}

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
 * Pi inserts resets that would end the ghost style before the ellipsis.
 */
const MEASURE: RowMeasure = {
	visibleWidth,
	truncateToWidth: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis).replaceAll("\x1b[0m", ""),
};

export function activateEditorHook(deps: EditorHookDeps): EditorHookHandle | { error: string } {
	if (!installEditorHook()) {
		return { error: "pi-tui's Editor is not what this version expects (render / handleInput / the cursor cell)" };
	}
	const reg = registry();
	const { provider } = deps;
	let lastEditor: WeakRef<object> | undefined;
	let seenEditor = false;
	let lastPaint: EditorHookStatus["lastPaint"] = null;
	const provisional = new WeakMap<object, ProvisionalSpace>();

	const see = (a: Any): void => {
		seenEditor = true;
		if (lastEditor?.deref() !== a) lastEditor = new WeakRef(a);
	};

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
			// Feedback must not block key handling.
		}
	};

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
			// Falling back to pi would handle the key twice.
		}
	};

	const resolveProvisional = (a: Any, marker: ProvisionalSpace, before: EditorSnapshot, after: EditorSnapshot, depth: number | undefined): void => {
		const outcome = provisionalOutcome(marker, before, after);
		if (outcome === "keep") return;
		const line = before.cursorLine;
		const col = before.cursorCol;
		const text = before.lines[line]!;
		if (outcome === "swallow" && depth !== undefined && undoDepth(a) === depth + 1) {
			// Pi snapshots the buffer before inserting a typed space.
			a.undo();
			a.tui.requestRender();
			return;
		}
		if (outcome === "swallow") {
			a.state.lines[line] = text;
			setCursorCol(a, col);
		} else if (outcome === "absorb") {
			// Pi's undo snapshot already contains the provisional space.
			const typed = after.lines[line]!.slice(col, after.cursorCol);
			a.state.lines[line] = text.slice(0, col - 1) + typed + text.slice(col);
			setCursorCol(a, col - 1 + typed.length);
		} else {
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
			// These rows are only a fallback when the composer is hosted.
			if (!isComposerHosted()) lastPaint = "ansi";
			const ghost = ghostFor(editor);
			if (!ghost) return rows;
			const own: unknown = typeof editor.getPaddingX === "function" ? editor.getPaddingX() : undefined;
			if (typeof own !== "number" || !Number.isFinite(own) || !Number.isFinite(width)) return rows;
			// Pi caps padding to leave at least one content cell.
			const paddingX = Math.min(own, Math.max(0, Math.floor((width - 1) / 2)));
			return paintGhost(rows, ghost, paddingX, deps.style, MEASURE);
		},

		input(editor, data, pass) {
			if (!isPromptEditor(editor) || typeof data !== "string") return pass();
			const a = editor;
			see(a);
			if (isKeyRelease(data)) return pass();
			const marker = takeProvisional(a);
			if (!deps.enabled() || !hasKeyInternals(a)) return pass();
			if (a.jumpMode != null || a.isInPaste || data.includes("\x1b[200~")) return pass();

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
			}
		},
	};

	const slot: ComposerGhostProvider = {
		ghost(editor) {
			if (!isPromptEditor(editor)) return undefined;
			see(editor);
			lastPaint = "native";
			return ghostFor(editor) ?? undefined;
		},
	};

	const onUpdate = (): void => {
		try {
			(lastEditor?.deref() as Any | undefined)?.tui?.requestRender?.();
		} catch {
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
			onUpdate();
		},
	};
}

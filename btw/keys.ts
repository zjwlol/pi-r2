/**
 * /btw keys on the main prompt editor.
 *
 * Ports the `b` / `c` / `f` input listeners, the Escape priority and the `app.btw.inject` handler of
 * oh-my-pi's `coding-agent/src/modes/controllers/input-controller.ts` (l. 388–411, 558, 788) to one
 * `ctx.ui.onTerminalInput` handler (runs before the focused component).
 *
 * It acts only while the main prompt editor has focus (not a selector, a dialog, the subagent
 * inspector or the BTW history overlay), reads the editor through a probe and never installs an
 * editor or wraps a prototype. Keys: Esc, `b`, `f`, `c`, alt+i. Everything else, including Tab,
 * Right, Left, ctrl+s and alt+a (the subagent inspector, word-predict), passes through untouched.
 */

import { getKeybindings, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

/** Fixed: vanilla's keybinding registry is closed to extensions (upstream: `app.btw.inject`). */
export const INJECT_KEY = "alt+i";

export interface EditorProbe {
	/** The main prompt editor has focus. */
	focused(): boolean;
	text(): string;
	/** The editor's autocomplete popup is open (Esc belongs to it). */
	autocompleteOpen(): boolean;
}

type EditorLike = { getText?: unknown; onAction?: unknown; isShowingAutocomplete?: unknown };

/** Duck-typed view of the focused main prompt editor (`getText` + `onAction`; `isShowingAutocomplete` when present). */
export function probeEditor(tui: () => TUI | undefined, editorText: () => string): EditorProbe {
	// pi's editor is a CustomEditor (or a subclass another extension installed): the same duck type
	// as subagent/inspector.ts `mainEditorFocused`, re-implemented here on purpose.
	const editor = (): EditorLike | undefined => {
		const focused = (tui() as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.() as
			| EditorLike
			| null
			| undefined;
		return focused && typeof focused.getText === "function" && typeof focused.onAction === "function" ? focused : undefined;
	};
	return {
		focused: () => editor() !== undefined,
		text: () => editorText(),
		autocompleteOpen: () => {
			const focused = editor() as { isShowingAutocomplete?: () => unknown } | undefined;
			return typeof focused?.isShowingAutocomplete === "function" && focused.isShowingAutocomplete() === true;
		},
	};
}

/** What the handler drives: the controller. */
export interface BtwKeyTarget {
	/** The inline panel (or a pending branch) owns Escape. */
	hasActivePanel(): boolean;
	handleEscape(): boolean;
	handlesBranchKey(): boolean;
	handleBranch(): Promise<boolean>;
	canFollowUp(): boolean;
	handleFollowUp(): boolean;
	canCopy(): boolean;
	handleCopy(): Promise<boolean>;
	canInject(): boolean;
	handleInject(): boolean;
}

/** pi's `app.interrupt` (interactive mode hands its keybindings to pi-tui); plain Escape when unknown. */
export function matchesInterrupt(data: string): boolean {
	let keys: readonly string[] = [];
	try {
		keys = (getKeybindings() as unknown as { getKeys(id: string): string[] }).getKeys("app.interrupt");
	} catch {}
	if (keys.length === 0) return matchesKey(data, "escape");
	return keys.some((key) => matchesKey(data, key as Parameters<typeof matchesKey>[1]));
}

export function matchesInjectKey(data: string): boolean {
	return matchesKey(data, INJECT_KEY);
}

/**
 * `ctx.ui.onTerminalInput` handler. Esc and alt+i work with a draft in the editor; the bare letters
 * only on a blank editor without an autocomplete popup, where they cannot be meant as text. A key
 * whose action is not available now is typed (or handled by pi) as usual.
 */
export function createBtwKeyHandler(target: BtwKeyTarget, editor: EditorProbe): (data: string) => { consume?: boolean } | undefined {
	return (data) => {
		try {
			if (isKeyRelease(data)) return undefined;
			if (!editor.focused()) return undefined;
			if (matchesInterrupt(data)) {
				// While a panel is up Esc acts on it first: it never interrupts the main turn.
				if (!target.hasActivePanel() || editor.autocompleteOpen()) return undefined;
				return target.handleEscape() ? { consume: true } : undefined;
			}
			if (matchesInjectKey(data)) {
				if (!target.canInject()) return undefined;
				target.handleInject();
				return { consume: true };
			}
			const letter = matchesKey(data, "b") ? "b" : matchesKey(data, "f") ? "f" : matchesKey(data, "c") ? "c" : undefined;
			// With the autocomplete popup open (Tab on an empty editor lists files) a letter filters the list.
			if (!letter || editor.text().trim() !== "" || editor.autocompleteOpen()) return undefined;
			if (letter === "b") {
				if (!target.handlesBranchKey()) return undefined;
				void target.handleBranch();
				return { consume: true };
			}
			if (letter === "f") {
				if (!target.canFollowUp()) return undefined;
				target.handleFollowUp();
				return { consume: true };
			}
			if (!target.canCopy()) return undefined;
			void target.handleCopy();
			return { consume: true };
		} catch {
			// A stale context (the session was replaced under us): the key is not ours.
			return undefined;
		}
	};
}

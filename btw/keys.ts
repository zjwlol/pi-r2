import { getKeybindings, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

/**
 * Pi's keybinding registry is closed to extensions.
 */
export const INJECT_KEY = "alt+i";

export interface EditorProbe {
	focused(): boolean;
	text(): string;
	autocompleteOpen(): boolean;
}

type EditorLike = { getText?: unknown; onAction?: unknown; isShowingAutocomplete?: unknown };

export function probeEditor(tui: () => TUI | undefined, editorText: () => string): EditorProbe {
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

export interface BtwKeyTarget {
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

export function createBtwKeyHandler(target: BtwKeyTarget, editor: EditorProbe): (data: string) => { consume?: boolean } | undefined {
	return (data) => {
		try {
			if (isKeyRelease(data)) return undefined;
			if (!editor.focused()) return undefined;
			if (matchesInterrupt(data)) {
				if (!target.hasActivePanel() || editor.autocompleteOpen()) return undefined;
				return target.handleEscape() ? { consume: true } : undefined;
			}
			if (matchesInjectKey(data)) {
				if (!target.canInject()) return undefined;
				target.handleInject();
				return { consume: true };
			}
			const letter = matchesKey(data, "b") ? "b" : matchesKey(data, "f") ? "f" : matchesKey(data, "c") ? "c" : undefined;
			// Tab can open autocomplete on an empty editor.
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
			// A replaced session can leave the editor context stale.
			return undefined;
		}
	};
}

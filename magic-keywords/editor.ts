/**
 * Editor that paints magic keywords with an animated gradient while you type
 * (oh-my-pi style shimmer: one repaint every 70 ms while a keyword is on
 * screen and the editor is focused; static gradient otherwise).
 *
 * Under a TSP surface (the tsp-native extension sets `nativeMode`) the
 * terminal clocks the effect itself: `describeDecorations()` hands it the
 * keyword ranges as `shimmer` decorations and the ANSI gradient and its timer
 * stay off.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { findKeywords, keywordRegex, maskNonProse } from "./keywords.ts";
import { type PaintOptions, paintLines } from "./paint.ts";

const FRAME_MS = 70;
const PERIOD_MS = 1800;

const live = new Set<MagicEditor>();

/** Stop every editor's animation timer (session shutdown / reload). */
export function stopAllEditors(): void {
	for (const editor of live) editor.stopShimmer();
	live.clear();
}

/** A TSP editor decoration (mirrors `TspEditorDecoration` in tsp-native/wire.ts; UTF-16 offsets). */
export interface EditorDecoration {
	from: number;
	to: number;
	s: string;
	fx?: "shimmer" | "pulse" | "none";
}

const decorPatterns = new Map<string, RegExp>();

/** Keyword occurrences in `text` (lines joined with "\n") as shimmer decorations, prose-only like the painter. */
export function keywordDecorations(text: string): EditorDecoration[] {
	const keywords = findKeywords(text);
	if (keywords.length === 0) return [];
	const masked = maskNonProse(text);
	const out: EditorDecoration[] = [];
	for (const keyword of keywords) {
		let pattern = decorPatterns.get(keyword.word);
		if (!pattern) {
			pattern = keywordRegex(keyword.word, "g");
			decorPatterns.set(keyword.word, pattern);
		}
		pattern.lastIndex = 0;
		for (let m = pattern.exec(masked); m; m = pattern.exec(masked)) {
			out.push({ from: m.index, to: m.index + m[0].length, s: `accent strong magic-${keyword.id}`, fx: "shimmer" });
			if (m[0].length === 0) pattern.lastIndex++;
		}
	}
	return out.sort((a, b) => a.from - b.from);
}

export class MagicEditor extends CustomEditor {
	/** Supplies the current theme's color mode/appearance; set by the extension. */
	paintOptions?: () => Omit<PaintOptions, "phase">;
	/** Set by tsp-native while a TSP surface draws this editor: no ANSI gradient, no repaint timer. */
	nativeMode = false;
	private timer?: ReturnType<typeof setInterval>;

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.nativeMode) {
			this.stopShimmer();
			return lines;
		}
		const text = this.getText();
		const keywords = findKeywords(text);
		const animate = keywords.length > 0 && this.focused;
		if (animate) this.startShimmer();
		else this.stopShimmer();
		if (keywords.length === 0 || !this.paintOptions) return lines;

		const options: PaintOptions = {
			...this.paintOptions(),
			phase: animate ? (Date.now() % PERIOD_MS) / PERIOD_MS : 0,
		};
		return paintLines(lines, text, keywords, options);
	}

	/** tsp-native hook: decorations over the editor text for the native `editor` node. */
	describeDecorations(text: string): EditorDecoration[] {
		return keywordDecorations(text);
	}

	private startShimmer(): void {
		if (this.timer) return;
		live.add(this);
		this.timer = setInterval(() => this.tui.requestRender(), FRAME_MS);
		this.timer.unref?.();
	}

	stopShimmer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
		live.delete(this);
	}
}

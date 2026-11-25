/**
 * Editor that paints magic keywords with an animated gradient while you type
 * (oh-my-pi style shimmer: one repaint every 70 ms while a keyword is on
 * screen and the editor is focused; static gradient otherwise). Each render
 * arms at most one frame, so the chain ends by itself once the editor is no
 * longer rendered (swapped out for a selector, replaced, ...).
 *
 * Under a TSP surface (the tsp-native extension sets `nativeMode`) the
 * terminal clocks the effect itself: `describeDecorations()` hands it the
 * keyword ranges as `shimmer` decorations and the ANSI gradient and its timer
 * stay off.
 *
 * Chips (shared/editor-chips.ts: ranges other extensions mark as selected
 * tokens, e.g. subagent's resolved `^model` tags) are drawn here too: a pill
 * painted over the rendered rows (chips.ts), or a decoration under a TSP
 * surface. The chip text stays ordinary, editable text.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { editorChips } from "../shared/editor-chips.ts";
import { type ChipStyle, chipDecorations, paintChips, rowSlices, type VisualLine } from "./chips.ts";
import { findKeywords, keywordRegex, maskNonProse } from "./keywords.ts";
import { type PaintOptions, paintLines } from "./paint.ts";

const FRAME_MS = 70;
const PERIOD_MS = 1800;

const live = new Set<MagicEditor>();

/** Cancel every editor's pending animation frame (session shutdown / reload). */
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

/** pi-tui `Editor` state the chip painter reads (TS-private there, plain properties at runtime). */
interface EditorLayoutInternals {
	buildVisualLineMap?: (width: number) => VisualLine[];
	lastWidth?: number;
	scrollOffset?: number;
	renderedVisibleLineCount?: number;
}

export class MagicEditor extends CustomEditor {
	/** Supplies the current theme's color mode/appearance; set by the extension. */
	paintOptions?: () => Omit<PaintOptions, "phase">;
	/** Supplies the escape sequences around a chip (theme colours); set by the extension. Unset: chips are not painted. */
	chipStyle?: () => ChipStyle;
	/** Set by tsp-native while a TSP surface draws this editor: no ANSI gradient, no repaint timer. */
	nativeMode = false;
	private timer?: ReturnType<typeof setTimeout>;

	override render(width: number): string[] {
		let lines = super.render(width);
		if (this.nativeMode) {
			this.stopShimmer();
			return lines;
		}
		const text = this.getText();
		const keywords = findKeywords(text);
		const animate = keywords.length > 0 && this.focused;
		if (animate) this.scheduleFrame();
		else this.stopShimmer();
		if (keywords.length > 0 && this.paintOptions) {
			const options: PaintOptions = {
				...this.paintOptions(),
				phase: animate ? (Date.now() % PERIOD_MS) / PERIOD_MS : 0,
			};
			lines = paintLines(lines, text, keywords, options);
		}
		return this.paintChipRows(lines, text, width);
	}

	/** tsp-native hook: decorations over the editor text for the native `editor` node. */
	describeDecorations(text: string): EditorDecoration[] {
		const keywords = keywordDecorations(text);
		const chips = editorChips(text);
		if (chips.length === 0) return keywords;
		return [...keywords, ...chipDecorations(chips)].sort((a, b) => a.from - b.from);
	}

	/** `rows` (what `render` produced for `text` at `width`) with the chips painted; `rows` itself when there is none or anything is unexpected. */
	private paintChipRows(rows: string[], text: string, width: number): string[] {
		if (!this.chipStyle) return rows;
		try {
			const chips = editorChips(text);
			if (chips.length === 0) return rows;
			const internals = this as unknown as EditorLayoutInternals;
			const { lastWidth, scrollOffset, renderedVisibleLineCount } = internals;
			if (typeof internals.buildVisualLineMap !== "function") return rows;
			if (!Number.isInteger(lastWidth) || !Number.isInteger(scrollOffset) || !Number.isInteger(renderedVisibleLineCount)) return rows;
			const visual = internals.buildVisualLineMap(lastWidth as number);
			if (!Array.isArray(visual)) return rows;
			const slices = rowSlices(visual, scrollOffset as number, renderedVisibleLineCount as number);
			// The editor's own clamp of its padding (pi-tui Editor.render).
			const paddingX = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
			return paintChips(rows, this.getLines(), slices, paddingX, chips, this.chipStyle());
		} catch {
			return rows;
		}
	}

	/** Arm the next shimmer frame: one-shot, re-armed by the render it requests. */
	private scheduleFrame(): void {
		if (this.timer) return;
		live.add(this);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			live.delete(this);
			this.tui.requestRender();
		}, FRAME_MS);
		this.timer.unref?.();
	}

	stopShimmer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		live.delete(this);
	}
}

/**
 * Chip painting for the prompt editor: turns chip ranges (shared/editor-chips.ts,
 * offsets into the draft) into a pill on the rows pi-tui's `Editor.render`
 * produced, and into decorations for tsp-native's `editor` node.
 *
 * Pure: no imports, so it runs (and is probed) under plain node.
 *
 * The rows are not searched for the token text. The editor says which slice
 * of which logical line each row shows (`rowSlices`, from pi-tui's own visual
 * line map, the same one its mouse handling uses), so a tag wrapped over two
 * rows is painted on both and a tag inside `code` is never painted by
 * accident. Only zero-width SGR escapes are inserted, so visible width is
 * unchanged.
 */

/** A chip range: UTF-16 offsets into the editor's lines joined by "\n" (`from` inclusive, `to` exclusive). */
export interface ChipRange {
	from: number;
	to: number;
}

/** One entry of pi-tui's `Editor.buildVisualLineMap`: the slice of a logical line that one visual line shows. */
export interface VisualLine {
	logicalLine: number;
	startCol: number;
	length: number;
}

/** Rendered row `row` shows `lines[line].slice(startCol, startCol + length)`. */
export interface RowSlice {
	row: number;
	line: number;
	startCol: number;
	length: number;
}

/** Escape sequences written before (`open`) and after (`close`) each painted piece of a chip. */
export interface ChipStyle {
	open: string;
	close: string;
}

/** The two theme lookups a chip needs; pi's `Theme` (ctx.ui.theme) has both. */
export interface ChipTheme {
	getBgAnsi(token: "customMessageBg"): string;
	getFgAnsi(token: "customMessageLabel"): string;
}

/** A TSP editor decoration for a chip (same shape as `EditorDecoration` in editor.ts). */
export interface ChipDecoration {
	from: number;
	to: number;
	s: string;
}

/** Style tokens of a chip on tsp-native's `editor` node: accent colour, bold, tinted background. */
export const CHIP_DECOR_STYLE = "accent strong mark";

// CSI, string sequences (OSC/APC/DCS/PM, ended by BEL or ST), or a 2-byte escape. Same as paint.ts.
const ESC_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_P^][\s\S]*?(?:\x07|\x1b\\)|[\s\S])/y;

/** Visible text of `row` (escape sequences removed) and, per visible UTF-16 unit, its index in `row`. */
function visibleMap(row: string): { plain: string; map: number[] } {
	let plain = "";
	const map: number[] = [];
	for (let i = 0; i < row.length; ) {
		if (row.charCodeAt(i) === 0x1b) {
			ESC_RE.lastIndex = i;
			const m = ESC_RE.exec(row);
			if (m) {
				i += m[0].length;
				continue;
			}
		}
		map.push(i);
		plain += row[i];
		i++;
	}
	return { plain, map };
}

/** Offset of the start of each line in `lines.join("\n")`. */
export function lineStarts(lines: readonly string[]): number[] {
	const out: number[] = [];
	let at = 0;
	for (const line of lines) {
		out.push(at);
		at += line.length + 1;
	}
	return out;
}

/**
 * Which slice of the draft each content row shows. `visual` is the editor's
 * whole visual line map; the rows on screen are `visibleCount` of them from
 * `scrollOffset`. Row 0 is the top border, so the first content row is row 1.
 */
export function rowSlices(visual: readonly VisualLine[], scrollOffset: number, visibleCount: number): RowSlice[] {
	const out: RowSlice[] = [];
	for (let i = 0; i < visibleCount; i++) {
		const v = visual[scrollOffset + i];
		if (!v) break;
		out.push({ row: i + 1, line: v.logicalLine, startCol: v.startCol, length: v.length });
	}
	return out;
}

/**
 * `rows` with every chip painted: `style.open` before and `style.close` after
 * each piece of a chip that a row shows.
 *
 * - `lines`: the editor's logical lines (`chips` are offsets into them joined by "\n").
 * - `slices`: from `rowSlices`. Rows no slice names (borders, the autocomplete list) are never touched.
 * - `paddingX`: spaces the editor put left of the text on every content row.
 *
 * Returns `rows` itself (the same array) when nothing was painted. A row whose
 * visible text is not `paddingX` spaces + its slice is left as it is.
 */
export function paintChips(
	rows: string[],
	lines: readonly string[],
	slices: readonly RowSlice[],
	paddingX: number,
	chips: readonly ChipRange[],
	style: ChipStyle,
): string[] {
	if (chips.length === 0 || slices.length === 0) return rows;
	const starts = lineStarts(lines);
	let out: string[] | undefined;
	for (const slice of slices) {
		const row = rows[slice.row];
		const line = lines[slice.line];
		const base = starts[slice.line];
		if (row === undefined || line === undefined || base === undefined || slice.length <= 0) continue;
		// The slice as offsets into the joined text.
		const from = base + slice.startCol;
		const to = from + slice.length;
		// The pieces of chips inside this slice, as offsets into the slice.
		const pieces: { a: number; b: number }[] = [];
		for (const chip of chips) {
			if (chip.from >= to || chip.to <= from) continue;
			pieces.push({ a: Math.max(chip.from, from) - from, b: Math.min(chip.to, to) - from });
		}
		if (pieces.length === 0) continue;
		const { plain, map } = visibleMap(row);
		const chunk = line.slice(slice.startCol, slice.startCol + slice.length);
		if (!plain.startsWith(chunk, paddingX)) continue;
		pieces.sort((x, y) => x.a - y.a);
		let painted = "";
		let last = 0;
		for (const { a, b } of pieces) {
			const start = map[paddingX + a];
			const lastUnit = map[paddingX + b - 1];
			if (start === undefined || lastUnit === undefined || start < last) continue;
			const end = lastUnit + 1;
			painted += row.slice(last, start) + style.open + row.slice(start, end) + style.close;
			last = end;
		}
		if (last === 0) continue;
		painted += row.slice(last);
		out ??= rows.slice();
		out[slice.row] = painted;
	}
	return out ?? rows;
}

/**
 * A chip in the ANSI editor: bold `customMessageLabel` text on `customMessageBg`
 * (the pair pi draws its `[skill]` and custom message labels with, so it reads
 * in every theme), then bold, foreground and background back to the terminal's
 * defaults. Same shape as oh-my-pi's `chipPillStyle`.
 */
export function chipStyleFor(theme: ChipTheme): ChipStyle {
	return {
		open: `${theme.getBgAnsi("customMessageBg")}${theme.getFgAnsi("customMessageLabel")}\x1b[1m`,
		close: "\x1b[22m\x1b[39m\x1b[49m",
	};
}

/** The chips as decorations for tsp-native's `editor` node, in the order given. */
export function chipDecorations(chips: readonly ChipRange[]): ChipDecoration[] {
	return chips.map((chip) => ({ from: chip.from, to: chip.to, s: CHIP_DECOR_STYLE }));
}

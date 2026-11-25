/**
 * Chip ranges use half-open UTF-16 offsets into the draft joined with `\n`.
 */
export interface ChipRange {
	from: number;
	to: number;
}

export interface VisualLine {
	logicalLine: number;
	startCol: number;
	length: number;
}

export interface RowSlice {
	row: number;
	line: number;
	startCol: number;
	length: number;
}

export interface ChipStyle {
	open: string;
	close: string;
}

export interface ChipTheme {
	getBgAnsi(token: "customMessageBg"): string;
	getFgAnsi(token: "customMessageLabel"): string;
}

export interface ChipDecoration {
	from: number;
	to: number;
	s: string;
}

export const CHIP_DECOR_STYLE = "accent strong mark";

const ESC_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_P^][\s\S]*?(?:\x07|\x1b\\)|[\s\S])/y;

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

export function lineStarts(lines: readonly string[]): number[] {
	const out: number[] = [];
	let at = 0;
	for (const line of lines) {
		out.push(at);
		at += line.length + 1;
	}
	return out;
}

export function rowSlices(visual: readonly VisualLine[], scrollOffset: number, visibleCount: number): RowSlice[] {
	const out: RowSlice[] = [];
	for (let i = 0; i < visibleCount; i++) {
		const v = visual[scrollOffset + i];
		if (!v) break;
		// Pi reserves the first rendered row for the top border.
		out.push({ row: i + 1, line: v.logicalLine, startCol: v.startCol, length: v.length });
	}
	return out;
}

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
		const from = base + slice.startCol;
		const to = from + slice.length;
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

export function chipStyleFor(theme: ChipTheme): ChipStyle {
	return {
		open: `${theme.getBgAnsi("customMessageBg")}${theme.getFgAnsi("customMessageLabel")}\x1b[1m`,
		close: "\x1b[22m\x1b[39m\x1b[49m",
	};
}

export function chipDecorations(chips: readonly ChipRange[]): ChipDecoration[] {
	return chips.map((chip) => ({ from: chip.from, to: chip.to, s: CHIP_DECOR_STYLE }));
}

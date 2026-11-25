export const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";

const EOL_CURSOR_CELL = `${FAKE_CURSOR_START} `;
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

export interface RowMeasure {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis: string): string;
}

/**
 * Pi puts only padding after the end-of-line cursor cell.
 */
export function paintGhostRow(
	row: string,
	ghost: string,
	paddingX: number,
	style: (text: string) => string,
	measure: RowMeasure,
): string {
	if (ghost === "" || CONTROL_RE.test(ghost)) return row;
	const end = row.lastIndexOf(FAKE_CURSOR_END);
	if (end < EOL_CURSOR_CELL.length || !row.startsWith(EOL_CURSOR_CELL, end - EOL_CURSOR_CELL.length)) return row;
	const headLength = end + FAKE_CURSOR_END.length;
	for (let i = headLength; i < row.length; i++) if (row.charCodeAt(i) !== 0x20) return row;
	const tail = row.length - headLength;
	const avail = tail - Math.max(0, paddingX);
	if (!(avail > 0)) return row;
	const shown = measure.truncateToWidth(ghost, avail, "…");
	const width = measure.visibleWidth(shown);
	if (!(width > 0) || width > avail) return row;
	return row.slice(0, headLength) + style(shown) + " ".repeat(tail - width);
}

export function paintGhost(
	rows: readonly string[],
	ghost: string,
	paddingX: number,
	style: (text: string) => string,
	measure: RowMeasure,
): string[] {
	const out = rows.slice();
	for (let i = 0; i < out.length; i++) {
		const row = out[i]!;
		const painted = paintGhostRow(row, ghost, paddingX, style, measure);
		if (painted !== row) {
			out[i] = painted;
			break;
		}
	}
	return out;
}

export const PROVISIONAL_SPACE_ABSORBERS: RegExp = /^[-.,;:!?)\]}]/;

export interface EditorSnapshot {
	/**
	 * Pi edits its live line array in place.
	 */
	lines: readonly string[];
	cursorLine: number;
	cursorCol: number;
}

export interface ProvisionalSpace {
	line: number;
	col: number;
	text: string;
}

export function insertedText(before: EditorSnapshot, after: EditorSnapshot): string | undefined {
	const line = before.cursorLine;
	if (after.cursorLine !== line || !(after.cursorCol > before.cursorCol)) return undefined;
	if (after.lines.length !== before.lines.length) return undefined;
	const pre = before.lines[line];
	const post = after.lines[line];
	if (typeof pre !== "string" || typeof post !== "string") return undefined;
	const typed = post.slice(before.cursorCol, after.cursorCol);
	if (post !== pre.slice(0, before.cursorCol) + typed + pre.slice(before.cursorCol)) return undefined;
	for (let i = 0; i < before.lines.length; i++) {
		if (i !== line && before.lines[i] !== after.lines[i]) return undefined;
	}
	return typed;
}

function splitAtCaret(before: EditorSnapshot, after: EditorSnapshot): boolean {
	const line = before.cursorLine;
	const pre = before.lines[line];
	if (typeof pre !== "string") return false;
	if (after.lines.length !== before.lines.length + 1 || after.cursorLine !== line + 1 || after.cursorCol !== 0) return false;
	if (after.lines[line] !== pre.slice(0, before.cursorCol) || after.lines[line + 1] !== pre.slice(before.cursorCol)) return false;
	for (let i = 0; i < before.lines.length; i++) {
		if (i !== line && before.lines[i] !== after.lines[i < line ? i : i + 1]) return false;
	}
	return true;
}

export type ProvisionalOutcome = "swallow" | "absorb" | "newline" | "keep";

export function provisionalOutcome(marker: ProvisionalSpace, before: EditorSnapshot, after: EditorSnapshot): ProvisionalOutcome {
	if (before.cursorLine !== marker.line || before.cursorCol !== marker.col) return "keep";
	if (before.lines[marker.line] !== marker.text || marker.text[marker.col - 1] !== " ") return "keep";
	const typed = insertedText(before, after);
	if (typed === " ") return "swallow";
	if (typed !== undefined) {
		return PROVISIONAL_SPACE_ABSORBERS.test(typed) && [...typed].length === 1 ? "absorb" : "keep";
	}
	return splitAtCaret(before, after) ? "newline" : "keep";
}

export function divergesFromGhost(ghost: string, typed: string): boolean {
	const overlap = Math.min(ghost.length, typed.length);
	return ghost.slice(0, overlap).toLocaleLowerCase() !== typed.slice(0, overlap).toLocaleLowerCase();
}

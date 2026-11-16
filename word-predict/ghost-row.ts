/**
 * word-predict: the pure half of the editor integration. No imports, so it
 * runs (and is probed) under plain node.
 *
 * - Row surgery: put the ghost (the dim rest of the predicted word) into the
 *   free cells after the end-of-line cursor of a row pi-tui's `Editor.render`
 *   produced, without changing the row's visible width.
 * - What one key did to the draft, read from the editor state before and
 *   after it: the text typed at the caret, what becomes of the provisional
 *   space a Tab accept leaves, and whether a typed character leaves the ghost.
 *
 * Port of oh-my-pi `packages/tui/src/components/editor.ts` (MIT): `hintTail`
 * in `render`, `PROVISIONAL_SPACE_ABSORBERS`, `#hasProvisionalSpace`, the
 * provisional-space branches of `#insertCharacter` / `#addNewLine` and
 * `#reportTypedPastWordCompletion`. Upstream decides inside the editor before
 * it edits; here pi-tui's editor has already handled the key, so the same
 * decisions are taken from the two states.
 */

/** pi-tui's markers around the cursor cell (`renderFakeCursor` in its `tui.js`). */
export const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";

/** The end-of-line cursor cell up to its closing marker: one space. */
const EOL_CURSOR_CELL = `${FAKE_CURSOR_START} `;
/** A ghost is one word; anything with a control character in it is not painted. */
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

export interface RowMeasure {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis: string): string;
}

/**
 * `row` with `ghost` painted right after its end-of-line cursor cell, or `row`
 * itself when it is not such a row (no cursor, a cursor on a character, text
 * after the cursor) or has no free cell left of the right padding.
 *
 * pi-tui draws the row as `leftPad + text + CURSOR_MARKER? + FAKE_CURSOR_START
 * + " " + FAKE_CURSOR_END + padding + rightPad`; the ghost replaces the first
 * cells of `padding`, cut with `…` when it is longer, and never wraps.
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
	// The spaces after the cursor: the padding up to the content width, then the right padding.
	const tail = row.length - headLength;
	const avail = tail - Math.max(0, paddingX);
	if (!(avail > 0)) return row;
	const shown = measure.truncateToWidth(ghost, avail, "…");
	const width = measure.visibleWidth(shown);
	if (!(width > 0) || width > avail) return row;
	return row.slice(0, headLength) + style(shown) + " ".repeat(tail - width);
}

/** `rows` with the ghost painted into the first row that takes it (the cursor row); the other rows are the same strings. */
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

/** Characters that pull back onto an accepted word: typed right after a Tab accept they replace its provisional space. */
export const PROVISIONAL_SPACE_ABSORBERS: RegExp = /^[-.,;:!?)\]}]/;

/** The editor state a key is compared against; `lines` must not be the editor's live array (it is edited in place). */
export interface EditorSnapshot {
	lines: readonly string[];
	cursorLine: number;
	cursorCol: number;
}

/** Where the caret stood right after a Tab accept, with the space it added before it. */
export interface ProvisionalSpace {
	line: number;
	col: number;
	text: string;
}

/** Text typed at the caret between two snapshots, or undefined when anything else changed. */
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

/** The line was split at the caret and nothing else: a new line holding what followed the caret, the caret at its start. */
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

/**
 * - `swallow`: a space was typed; the provisional one already stands there, the typed one goes.
 * - `absorb`: one closing punctuation mark or hyphen was typed; it takes the provisional space's place.
 * - `newline`: the line was split at the caret; the provisional space would be trailing blank and goes.
 * - `keep`: anything else, and a marker that does not describe `before` (the space is ordinary text by now).
 */
export type ProvisionalOutcome = "swallow" | "absorb" | "newline" | "keep";

/** What the key between `before` and `after` makes of the provisional space `marker` (valid for that one key). */
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

/** Whether `typed` leaves the shown `ghost`: its first characters are not the ghost's, ignoring case. */
export function divergesFromGhost(ghost: string, typed: string): boolean {
	const overlap = Math.min(ghost.length, typed.length);
	return ghost.slice(0, overlap).toLocaleLowerCase() !== typed.slice(0, overlap).toLocaleLowerCase();
}

/**
 * hashline/apply.ts: apply parsed edits to a text, with the text-only repairs.
 * Port of oh-my-pi `crates/pi-edit/src/modes/hashline/apply.rs` (MIT) as it behaves for a file
 * whose language upstream cannot parse: indentation repair, `PUT >N:` landing shift past closers,
 * boundary-echo dropping and the echo refusals stay; the tree-sitter verified repairs
 * (`repair_boundaries`, opener escape, parse-regression warning) are not ported.
 */
import { STRUCTURAL_CLOSER_RE } from "./block.ts";
import { type EmptyPaste, resolveClipboardEdits } from "./clipboard.ts";
import * as M from "./messages.ts";
import { type ApplyResult, type Clipboard, type DeleteEdit, type Edit, emptyClipboard, HashlineError, type InsertEdit } from "./types.ts";

export interface ApplyOptions {
	/** Clipboard shared across sections; a private empty one when omitted. Mutated by cuts. */
	clipboard?: Clipboard;
	/** Default "throw". */
	onEmptyPaste?: EmptyPaste;
}

/** One `PUT N.=M:` as the parser lowers it: its replacement inserts, then one delete per replaced line. */
export interface ReplacementGroup {
	insertIndices: number[];
	deleteIndices: number[];
	payload: string[];
	start: number;
	end: number;
}

/** The replacement group starting at `edits[start]`, if one starts there. */
export function replacementGroup(edits: readonly Edit[], start: number): ReplacementGroup | undefined {
	const first = edits[start];
	if (!first || first.kind !== "insert" || !first.replacement || first.cursor.kind !== "before") return undefined;
	const anchorLine = first.cursor.line;
	const opLine = first.lineNum;
	const insertIndices: number[] = [];
	const payload: string[] = [];
	let i = start;
	for (;;) {
		const e = edits[i];
		if (!e || e.kind !== "insert" || !e.replacement || e.cursor.kind !== "before" || e.cursor.line !== anchorLine || e.lineNum !== opLine) break;
		insertIndices.push(i);
		payload.push(e.text);
		i += 1;
	}
	const deleteIndices: number[] = [];
	let expected = anchorLine;
	for (;;) {
		const e = edits[i];
		if (!e || e.kind !== "delete" || e.line !== expected || e.lineNum !== opLine) break;
		deleteIndices.push(i);
		expected += 1;
		i += 1;
	}
	if (deleteIndices.length === 0) return undefined;
	return { insertIndices, deleteIndices, payload, start: anchorLine, end: expected - 1 };
}

function leadingIndent(line: string): string {
	return (/^[ \t]*/.exec(line) as RegExpExecArray)[0];
}
function indentDeeper(deeper: string, shallower: string): boolean {
	return deeper.length > shallower.length && deeper.startsWith(shallower);
}
/** Has a character other than tab, LF, VT, FF, CR, space. */
function hasContent(text: string): boolean {
	return /[^\t\n\v\f\r ]/.test(text);
}
function rowsEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((row, i) => row === b[i]);
}

/** Lines (1-indexed) an edit is anchored on: a delete's line, an insert's before/after line. */
function anchorLinesOf(edit: Edit): number[] {
	if (edit.kind === "delete") return [edit.line];
	if (edit.kind === "insert" && (edit.cursor.kind === "before" || edit.cursor.kind === "after")) return [edit.cursor.line];
	return [];
}

/**
 * A replacement body written one indent level too shallow under a `{` line gets the missing indent
 * back, when at least two (and more than half) of its rows equal the rows they replace up to that indent.
 */
function repairIndentation(edits: Edit[], lines: readonly string[]): string[] {
	let repaired = false;
	let start = 0;
	while (start < edits.length) {
		const group = replacementGroup(edits, start);
		if (!group) {
			start += 1;
			continue;
		}
		start = group.deleteIndices[group.deleteIndices.length - 1] + 1;
		if (group.payload.length !== group.deleteIndices.length) continue;
		const preceding = lines[Math.max(0, group.start - 2)] ?? "";
		const sourceFirst = lines[group.start - 1] ?? "";
		const payloadFirst = group.payload[0] ?? "";
		if (!preceding.trimEnd().endsWith("{") || !indentDeeper(leadingIndent(sourceFirst), leadingIndent(preceding)) || indentDeeper(leadingIndent(payloadFirst), leadingIndent(preceding))) {
			continue;
		}
		let shift: string | undefined;
		let matches = 0;
		let consistent = true;
		for (let offset = 0; offset < group.payload.length; offset++) {
			const payload = group.payload[offset];
			const source = lines[group.start - 1 + offset] ?? "";
			if (source.trim() === "" || source.trimStart() !== payload.trimStart()) continue;
			const sourceIndent = leadingIndent(source);
			const payloadIndent = leadingIndent(payload);
			if (!sourceIndent.endsWith(payloadIndent)) {
				consistent = false;
				break;
			}
			const candidate = sourceIndent.slice(0, sourceIndent.length - payloadIndent.length);
			if (shift !== undefined && shift !== candidate) {
				consistent = false;
				break;
			}
			shift = candidate;
			matches += 1;
		}
		if (shift === undefined || !consistent || shift === "" || matches < 2 || matches * 2 <= group.payload.length) continue;
		for (const index of group.insertIndices) {
			const edit = edits[index] as InsertEdit;
			if (edit.text.trim() !== "") edits[index] = { ...edit, text: shift + edit.text };
		}
		repaired = true;
	}
	return repaired ? [M.REPLACEMENT_INDENT_AUTO_SHIFT_WARNING] : [];
}

/** How many of `rows`' first rows restate the lines just above line `start`. */
function restatedAbove(rows: readonly string[], start: number, lines: readonly string[]): number {
	const max = Math.min(rows.length, Math.max(0, start - 1));
	for (let count = max; count >= 1; count--) {
		const sourceStart = start - 1 - count;
		const candidate = rows.slice(0, count);
		if (rowsEqual(candidate, lines.slice(sourceStart, sourceStart + count)) && candidate.some(hasContent)) return count;
	}
	return 0;
}
/** How many of `rows`' last rows restate the lines just below line `end`. */
function restatedBelow(rows: readonly string[], end: number, lines: readonly string[]): number {
	const max = Math.min(rows.length, Math.max(0, lines.length - end));
	for (let count = max; count >= 1; count--) {
		const candidate = rows.slice(rows.length - count);
		if (rowsEqual(candidate, lines.slice(end, end + count)) && candidate.some(hasContent)) return count;
	}
	return 0;
}
/** restatedAbove / restatedBelow, except that a run equal to the range rows it lands on counts as content (0). */
function restatedEdges(rows: readonly string[], lines: readonly string[], start: number, end: number): [number, number] {
	const landsOn = (run: readonly string[], at: number) => {
		const target = lines.slice(Math.min(at, lines.length));
		return run.every((row, i) => i >= target.length || row === target[i]);
	};
	const leading = restatedAbove(rows, start, lines);
	const trailing = restatedBelow(rows, end, lines);
	return [landsOn(rows.slice(0, leading), start - 1) ? 0 : leading, landsOn(rows.slice(rows.length - trailing), Math.max(0, end - trailing)) ? 0 : trailing];
}

type Echoed = { kind: "leading"; count: number } | { kind: "trailing"; count: number } | { kind: "both"; above: number; below: number };

/** A replacement whose body restates a neighbouring line and is too short for its range. */
interface Ambiguity {
	start: number;
	end: number;
	echoed: Echoed;
	/** Range rows the body leaves out. */
	leftOut: [number, number];
	/** An earlier pass dropped one copy of a repeated echo to expose this. */
	repeated: boolean;
}

function shortEcho(group: ReplacementGroup, dropJ: number, dropK: number): Ambiguity | undefined {
	const rangeLen = group.deleteIndices.length;
	const diff = group.payload.length - (dropJ + dropK);
	const between = diff >= 0 ? diff : undefined;
	const oneSidedShort = (dropJ === 0) !== (dropK === 0) && (between === undefined || between < rangeLen);
	const twoSidedShort = dropJ > 0 && dropK > 0 && rangeLen > 1 && between !== undefined && between < rangeLen;
	if (!oneSidedShort && !twoSidedShort) return undefined;
	const kept = between ?? 0;
	if (twoSidedShort) return { start: group.start, end: group.end, echoed: { kind: "both", above: dropJ, below: dropK }, leftOut: [group.start + kept, group.end], repeated: false };
	if (dropJ > 0) return { start: group.start, end: group.end, echoed: { kind: "leading", count: dropJ }, leftOut: [group.start + kept, group.end], repeated: false };
	return { start: group.start, end: group.end, echoed: { kind: "trailing", count: dropK }, leftOut: [group.start, group.end - kept], repeated: false };
}

function refusal(a: Ambiguity): HashlineError {
	let message: string;
	if (a.echoed.kind === "both") message = M.twoSidedBoundaryEchoMessage(a.start, a.end, a.echoed.above, a.echoed.below, a.repeated, a.leftOut);
	else if (a.repeated) message = M.repeatedBoundaryEchoMessage(a.start, a.end, a.echoed.kind, a.echoed.count, a.leftOut);
	else message = M.ambiguousBoundaryEchoMessage(a.start, a.end, a.echoed.kind, a.echoed.count, a.leftOut);
	return new HashlineError("ambiguous_boundary", message);
}

/** Dropping the echo rows would leave the range exactly as it is: the body means the literal edit. */
function dropIsNoop(group: ReplacementGroup, lines: readonly string[], dropL: number, dropT: number): boolean {
	return rowsEqual(group.payload.slice(dropL, group.payload.length - dropT), lines.slice(group.start - 1, group.end));
}

interface Normalized {
	edits: Edit[];
	warnings: string[];
	ambiguities: Ambiguity[];
	/** Start lines of groups kept as written because dropping their echo would be a no-op. */
	literal: number[];
}

/** Drop body rows that restate the line(s) just outside a replaced range ("boundary echoes"). */
function normalizeEchoes(edits: readonly Edit[], lines: readonly string[]): Normalized {
	const out: Edit[] = [];
	const warnings: string[] = [];
	const ambiguities: Ambiguity[] = [];
	const literal: number[] = [];
	let i = 0;
	while (i < edits.length) {
		const group = replacementGroup(edits, i);
		if (!group) {
			out.push({ ...edits[i], index: i });
			i += 1;
			continue;
		}
		const leading = restatedAbove(group.payload, group.start, lines);
		const trailing = restatedBelow(group.payload, group.end, lines);
		const rangeLen = group.deleteIndices.length;
		let dropL = 0;
		let dropT = 0;
		const push = (a: Ambiguity | undefined) => {
			if (a) ambiguities.push(a);
		};
		if (leading > 0 && trailing > 0) {
			if (group.payload.length - (leading + trailing) === rangeLen) {
				dropL = leading;
				dropT = trailing;
			} else push(shortEcho(group, leading, trailing));
		} else if (leading > 0 && rangeLen > 1) {
			if (Math.max(0, group.payload.length - leading) >= rangeLen) dropL = leading;
			else push(shortEcho(group, leading, 0));
		} else if (trailing > 0 && rangeLen > 1) {
			if (Math.max(0, group.payload.length - trailing) >= rangeLen) dropT = trailing;
			else push(shortEcho(group, 0, trailing));
		}
		if ((dropL > 0 || dropT > 0) && dropIsNoop(group, lines, dropL, dropT)) {
			literal.push(group.start);
			dropL = 0;
			dropT = 0;
		}
		if (dropL > 0 || dropT > 0) {
			const rest: ReplacementGroup = { ...group, payload: group.payload.slice(dropL, group.payload.length - dropT) };
			const [j, k] = restatedEdges(rest.payload, lines, group.start, group.end);
			if (rangeLen > 1) {
				const ambiguity = shortEcho(rest, j, k);
				if (ambiguity) ambiguities.push({ ...ambiguity, repeated: true });
			}
			const inserts = group.insertIndices.map((idx) => edits[idx]);
			out.push(...inserts.slice(dropL, inserts.length - dropT));
			out.push(...group.deleteIndices.map((idx) => edits[idx]));
			warnings.push(M.textualBoundaryEchoWarning(group.start, dropL, dropT));
		} else {
			for (const idx of [...group.insertIndices, ...group.deleteIndices]) out.push({ ...edits[idx], index: idx });
		}
		i = group.deleteIndices[group.deleteIndices.length - 1] + 1;
	}
	return { edits: out, warnings, ambiguities, literal };
}

/** The common indent of a body's non-blank rows; undefined when it has none, is only closers, or mixes indents. */
function bodyIndent(rows: readonly string[]): string | undefined {
	const nonBlank = rows.filter(hasContent);
	if (nonBlank.length === 0 || nonBlank.every((row) => STRUCTURAL_CLOSER_RE.test(row))) return undefined;
	let target = leadingIndent(nonBlank[0]);
	for (const row of nonBlank) {
		const indent = leadingIndent(row);
		if (indent.startsWith(target)) continue;
		if (target.startsWith(indent)) target = indent;
		else return undefined;
	}
	return target;
}

/**
 * NOT upstream. Upstream vetoes a landing shift that breaks the parse (a shallower `case`, `} else {`);
 * without a parser, a body whose first row continues the enclosing construct is never moved.
 */
const CONTINUATION_ROW_RE = /^\s*(?:[)\]}]|(?:case|default|else|elif|catch|except|finally)\b)/;

/**
 * `PUT >N:` whose body is indented shallower than line N: the landing moves forward past the closing
 * lines (`}`, `)`, `]`) that follow N, down to the body's indent.
 */
function repairLandings(edits: readonly Edit[], lines: readonly string[]): { edits: Edit[]; warnings: string[] } {
	const groups: { anchor: number; lineNum: number; members: number[] }[] = [];
	edits.forEach((edit, index) => {
		if (edit.kind !== "insert" || edit.replacement || edit.cursor.kind !== "after") return;
		const anchor = edit.cursor.line;
		const group = groups.find((g) => g.anchor === anchor && g.lineNum === edit.lineNum);
		if (group) group.members.push(index);
		else groups.push({ anchor, lineNum: edit.lineNum, members: [index] });
	});
	const targeted = new Set<number>(edits.flatMap(anchorLinesOf));
	const out = [...edits];
	const warnings: string[] = [];
	for (const group of groups) {
		const rows = group.members.map((index) => (edits[index] as InsertEdit).text);
		const target = bodyIndent(rows);
		if (target === undefined) continue;
		if (CONTINUATION_ROW_RE.test(rows.find(hasContent) ?? "")) continue;
		const anchorText = lines[group.anchor - 1] ?? "";
		if (!hasContent(anchorText) || !indentDeeper(leadingIndent(anchorText), target)) continue;
		let landing = group.anchor;
		let crossed = 0;
		let blocked = false;
		for (let line = group.anchor + 1; line <= lines.length; line++) {
			const text = lines[line - 1];
			if (!hasContent(text)) continue;
			if (!STRUCTURAL_CLOSER_RE.test(text) || !leadingIndent(text).startsWith(target)) break;
			if (targeted.has(line)) {
				blocked = true;
				break;
			}
			landing = line;
			crossed += 1;
			if (leadingIndent(text).length === target.length) break;
		}
		if (blocked || landing === group.anchor) continue;
		for (const index of group.members) out[index] = { ...(out[index] as InsertEdit), cursor: { kind: "after", line: landing } };
		warnings.push(M.afterInsertLandingShiftWarning(group.anchor, landing, crossed));
	}
	return { edits: out, warnings };
}

type Slot = "before" | "replacement" | "after" | "delete";

/** Build the result text: `[text, firstChangedLine]`. Only insert and delete edits are used. */
export function materialize(original: readonly string[], edits: readonly Edit[]): [string, number | undefined] {
	let first: number | undefined;
	const bof: string[] = [];
	const eof: string[] = [];
	const anchored: { line: number; slot: Slot; text: string }[] = [];
	for (const edit of edits) {
		if (edit.kind === "delete") anchored.push({ line: edit.line, slot: "delete", text: "" });
		else if (edit.kind === "insert") {
			if (edit.cursor.kind === "bof") bof.push(edit.text);
			else if (edit.cursor.kind === "eof") eof.push(edit.text);
			else if (edit.cursor.kind === "after") anchored.push({ line: edit.cursor.line, slot: "after", text: edit.text });
			else anchored.push({ line: edit.cursor.line, slot: edit.replacement ? "replacement" : "before", text: edit.text });
		}
	}
	// Stable: edits on one line keep their op order.
	anchored.sort((a, b) => a.line - b.line);
	let lines: string[] = [];
	let copied = 0;
	let g = 0;
	while (g < anchored.length) {
		const line = anchored[g].line;
		let h = g;
		while (h < anchored.length && anchored[h].line === line) h += 1;
		const group = anchored.slice(g, h);
		g = h;
		const index = line - 1;
		const end = Math.min(index, original.length);
		lines.push(...original.slice(Math.min(copied, end), end));
		const texts = (slot: Slot) => group.filter((entry) => entry.slot === slot).map((entry) => entry.text);
		lines.push(...texts("before"));
		lines.push(...texts("replacement"));
		if (!group.some((entry) => entry.slot === "delete")) lines.push(original[index] ?? "");
		lines.push(...texts("after"));
		copied = index + 1;
		if (first === undefined) first = line;
	}
	lines.push(...original.slice(copied));
	if (bof.length > 0) {
		if (lines.length === 1 && lines[0] === "") lines = bof;
		else lines.unshift(...bof);
		first = 1;
	}
	if (eof.length > 0) {
		let at: number;
		if (lines.length === 1 && lines[0] === "") {
			lines = eof;
			at = 1;
		} else {
			const index = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
			lines.splice(index, 0, ...eof);
			at = index + 1;
		}
		first = first === undefined ? at : Math.min(first, at);
	}
	return [lines.join("\n"), first];
}

/** The rows `committed` writes in place of `group`'s range. */
function committedRows(group: ReplacementGroup, authored: readonly Edit[], committed: readonly Edit[], lines: readonly string[]): string[] {
	const op = authored[group.insertIndices[0]].lineNum;
	const own = committed.filter((edit) => {
		if (edit.lineNum !== op) return false;
		if (edit.kind === "delete") return edit.line >= group.start && edit.line <= group.end;
		if (edit.kind !== "insert" || !edit.replacement) return false;
		if (edit.cursor.kind === "before") return edit.cursor.line >= group.start && edit.cursor.line <= group.end + 1;
		return edit.cursor.kind === "eof" && group.end + 1 >= lines.length;
	});
	const rows = materialize(lines, own)[0].split("\n");
	const suffix = lines.length - group.end;
	return rows.slice(group.start - 1, Math.max(0, rows.length - suffix));
}

/**
 * Last check: for every replacement whose body restates a neighbouring line, refuse when the rows
 * written in place of its range hold a second copy of that line or are fewer than the range.
 */
function lossyEchoOutcome(
	authored: readonly Edit[],
	committed: readonly Edit[],
	lines: readonly string[],
	recorded: readonly Ambiguity[],
	literal: readonly number[],
): HashlineError | undefined {
	const deleted = (line: number) => committed.some((edit) => edit.kind === "delete" && edit.line === line);
	let i = 0;
	while (i < authored.length) {
		const group = replacementGroup(authored, i);
		if (!group) {
			i += 1;
			continue;
		}
		i = group.deleteIndices[group.deleteIndices.length - 1] + 1;
		const rangeLen = group.deleteIndices.length;
		const leading = restatedAbove(group.payload, group.start, lines);
		const trailing = restatedBelow(group.payload, group.end, lines);
		let echo: boolean;
		if (leading > 0 && trailing > 0) echo = rangeLen > 1 || group.payload.length - (leading + trailing) === rangeLen;
		else echo = (leading > 0 || trailing > 0) && rangeLen > 1;
		if (!echo) continue;
		const rows = committedRows(group, authored, committed, lines);
		if (literal.includes(group.start) && rowsEqual(rows, group.payload)) continue;
		let [above, below] = restatedEdges(rows, lines, group.start, group.end);
		if (deleted(group.start - 1)) above = 0;
		if (deleted(group.end + 1)) below = 0;
		let keepsRow = false;
		for (let line = group.start; line <= group.end; line++) if (!deleted(line)) keepsRow = true;
		const extra = (line: number): number => {
			if (!keepsRow || line === 0 || deleted(line)) return 0;
			const text = lines[line - 1];
			if (text === undefined || !hasContent(text)) return 0;
			const had = lines.slice(group.start - 1, group.end).filter((row) => row === text).length;
			return Math.max(0, rows.filter((row) => row === text).length - had);
		};
		const extraAbove = extra(group.start - 1);
		const extraBelow = extra(group.end + 1);
		const supplied = Math.max(0, rows.length - (Math.max(above, extraAbove) + Math.max(below, extraBelow)));
		if (above === 0 && below === 0 && extraAbove === 0 && extraBelow === 0 && supplied >= rangeLen) continue;
		const known = recorded.find((ambiguity) => ambiguity.start === group.start);
		if (known) return refusal(known);
		const { start, end } = group;
		const side = (edge: number, first: number, last: number, line: number, extraCopies: number): M.Restated | undefined => {
			if (edge > 0) return { kind: "span", first, last };
			return extraCopies > 0 ? { kind: "copies", line, extra: extraCopies } : undefined;
		};
		return new HashlineError(
			"ambiguous_boundary",
			M.boundaryEchoOutcomeMessage(
				start,
				end,
				side(above, Math.max(0, start - above), start - 1, start - 1, extraAbove),
				side(below, end + 1, end + below, end + 1, extraBelow),
				supplied < rangeLen ? [start + supplied, end] : undefined,
			),
		);
	}
	return undefined;
}

/**
 * Apply parsed edits to LF-normalized `text`. Block edits must have been lowered first
 * (block.ts `resolveBlockEdits`). Throws HashlineError (apply | out_of_range | ambiguous_boundary).
 */
export function applyEdits(text: string, edits: readonly Edit[], options: ApplyOptions = {}): ApplyResult {
	if (edits.length === 0) return { text, firstChangedLine: undefined, warnings: [] };
	const lines = text.split("\n");
	const clipboard = options.clipboard ?? emptyClipboard();
	const clipboardWarnings: string[] = [];
	const concrete = resolveClipboardEdits(edits, lines, clipboard, options.onEmptyPaste ?? "throw", (warning) => clipboardWarnings.push(warning));
	let target: Edit[] = [];
	for (const edit of concrete) {
		if (edit.kind === "block") throw new HashlineError("apply", M.UNRESOLVED_BLOCK_INTERNAL);
		if (edit.kind === "cut" || edit.kind === "paste") throw new HashlineError("apply", M.UNRESOLVED_CLIPBOARD_INTERNAL);
		target.push(edit);
	}
	// The empty element after a final newline is not a line: deleting it is ignored.
	if (lines.length > 1 && lines[lines.length - 1] === "") {
		const phantom = lines.length;
		target = target.filter((edit) => !(edit.kind === "delete" && edit.line === phantom));
	}
	target = target.map((edit, index) => ({ ...edit, index }) as InsertEdit | DeleteEdit);
	for (const edit of target) {
		for (const line of anchorLinesOf(edit)) {
			if (line < 1 || line > lines.length) throw new HashlineError("out_of_range", `Line ${line} does not exist (file has ${lines.length} lines)`);
		}
	}
	const indentationWarnings = repairIndentation(target, lines);
	const landed = repairLandings(target, lines);
	const normalized = normalizeEchoes(landed.edits, lines);
	const warnings = [...clipboardWarnings, ...indentationWarnings, ...landed.warnings, ...normalized.warnings];
	const [resultText, firstChangedLine] = materialize(lines, normalized.edits);
	if (normalized.ambiguities.length > 0) throw refusal(normalized.ambiguities[0]);
	const lossy = lossyEchoOutcome(landed.edits, normalized.edits, lines, normalized.ambiguities, normalized.literal);
	if (lossy) throw lossy;
	return { text: resultText, firstChangedLine, warnings };
}

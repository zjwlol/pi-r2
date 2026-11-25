/**
 * hashline/recovery.ts: apply an edit written against an older snapshot (a stale tag) to the current file,
 * when the anchored lines can be proven unchanged.
 * Port of oh-my-pi `crates/pi-edit/src/modes/hashline/recovery.rs` (MIT), without the tree-sitter
 * checks (`context_preserved`, the parse-regression refusal).
 */
import { applyEdits, replacementGroup } from "./apply.ts";
import { buildLineMap, similarity } from "./diff.ts";
import { RECOVERY_EXTERNAL_WARNING, RECOVERY_LINE_REMAP_WARNING, RECOVERY_SESSION_CHAIN_WARNING } from "./messages.ts";
import { hasClipboardEdit } from "./parser.ts";
import type { EditStore } from "./store.ts";
import { type Clipboard, type Cursor, type Edit, forkClipboard } from "./types.ts";

export interface RecoveryArgs {
	/** Canonical target path (store key). */
	path: string;
	/** Current LF-normalized file text. */
	currentText: string;
	/** The stale tag the section carried. */
	fileHash: string;
	/** Edits anchored against the stale snapshot (block and clipboard edits allowed). */
	edits: readonly Edit[];
	/** The call's clipboard; replaced by the recovered state on success. */
	clipboard: Clipboard | undefined;
}

export interface RecoveryResult {
	text: string;
	firstChangedLine: number | undefined;
	/** The recovery banner, then apply-time warnings. */
	warnings: string[];
}

function editAnchors(edit: Edit): number[] {
	const span = (start: number, end: number) => {
		const out: number[] = [];
		for (let n = start; n <= end; n++) out.push(n);
		return out;
	};
	const cursor = (c: Cursor) => (c.kind === "before" || c.kind === "after" ? [c.line] : []);
	switch (edit.kind) {
		case "delete":
		case "block":
			return [edit.line];
		case "cut":
			return span(edit.range.start, edit.range.end);
		case "paste":
			return edit.at.kind === "span" ? span(edit.at.range.start, edit.at.range.end) : cursor(edit.at.cursor);
		case "insert":
			return cursor(edit.cursor);
	}
}

function duplicatedValues(lines: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const line of lines) {
		if (seen.has(line)) duplicated.add(line);
		else seen.add(line);
	}
	return duplicated;
}

/** For each anchor: the line just before and just after its run of consecutive anchors (undefined at the file's ends). */
function anchorNeighbors(anchorLines: Set<number>, lineCount: number): Map<number, { before: number | undefined; after: number | undefined }> {
	const sorted = [...anchorLines].sort((a, b) => a - b);
	const neighbors = new Map<number, { before: number | undefined; after: number | undefined }>();
	let i = 0;
	while (i < sorted.length) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
		const start = sorted[i];
		const end = sorted[j];
		const entry = { before: start > 1 ? start - 1 : undefined, after: end < lineCount ? end + 1 : undefined };
		for (let k = i; k <= j; k++) neighbors.set(sorted[k], entry);
		i = j + 1;
	}
	return neighbors;
}

/** Every anchor maps, and a neighbour of its run maps with the same offset. */
function validateContext(previous: string, current: string, lineMap: Map<number, number>, edits: readonly Edit[]): boolean {
	const previousLines = previous.split("\n");
	const currentLines = current.split("\n");
	const anchors = new Set<number>(edits.flatMap(editAnchors));
	const previousDuplicates = duplicatedValues(previousLines);
	const currentDuplicates = duplicatedValues(currentLines);
	for (const [line, { before, after }] of anchorNeighbors(anchors, previousLines.length)) {
		const mapped = lineMap.get(line);
		if (mapped === undefined) return false;
		const previousValue = previousLines[line - 1] ?? "";
		const currentValue = currentLines[mapped - 1] ?? "";
		if (!previousDuplicates.has(previousValue) && !currentDuplicates.has(currentValue)) {
			const offset = mapped - line;
			const afterMatches = after !== undefined && lineMap.get(after) === after + offset;
			const beforeMatches = before !== undefined && lineMap.get(before) === before + offset;
			if (!afterMatches && !beforeMatches) return false;
		} else {
			let checked = false;
			if (before !== undefined) {
				checked = true;
				const expected = mapped - (line - before);
				if (lineMap.get(before) !== (expected >= 0 ? expected : undefined)) return false;
			}
			if (after !== undefined) {
				checked = true;
				if (lineMap.get(after) !== mapped + (after - line)) return false;
			}
			if (!checked) return false;
		}
	}
	return true;
}

/** The edits with every anchor moved to its current line, and the (uniform) offset; undefined when that is not possible. */
function remapEdits(previous: string, current: string, edits: readonly Edit[]): { edits: Edit[]; offset: number } | undefined {
	const lineMap = buildLineMap(previous, current);
	if (!validateContext(previous, current, lineMap, edits)) return undefined;
	const offsets: number[] = [];
	let failed = false;
	const mapLine = (line: number): number => {
		const mapped = lineMap.get(line);
		if (mapped === undefined) {
			failed = true;
			return line;
		}
		offsets.push(mapped - line);
		return mapped;
	};
	const mapCursor = (c: Cursor): Cursor => (c.kind === "before" || c.kind === "after" ? { kind: c.kind, line: mapLine(c.line) } : c);
	const mapRange = (start: number, end: number) => {
		const mappedStart = mapLine(start);
		let mappedEnd = mappedStart;
		for (let line = start + 1; line <= end; line++) mappedEnd = mapLine(line);
		return { start: mappedStart, end: mappedEnd };
	};
	const remapped: Edit[] = [];
	for (const edit of edits) {
		switch (edit.kind) {
			case "delete":
			case "block":
				remapped.push({ ...edit, line: mapLine(edit.line) });
				break;
			case "cut":
				remapped.push({ ...edit, range: mapRange(edit.range.start, edit.range.end) });
				break;
			case "paste":
				remapped.push({
					...edit,
					at: edit.at.kind === "span" ? { kind: "span", range: mapRange(edit.at.range.start, edit.at.range.end) } : { kind: "gap", cursor: mapCursor(edit.at.cursor) },
				});
				break;
			case "insert":
				remapped.push({ ...edit, cursor: mapCursor(edit.cursor) });
				break;
		}
		if (failed) return undefined;
	}
	if (offsets.length === 0 || offsets.some((offset) => offset !== offsets[0])) return undefined;
	return { edits: remapped, offset: offsets[0] };
}

const AUTHORED_LINES_FLOOR = 0.5;
const AUTHORED_LINES_MARGIN = 0.3;
const KEPT_SHARE_BUDGET = 1 << 23;
const KEPT_SHARE_MIN_CHARS = 8;

function charCount(text: string): number {
	return [...text].length;
}
function identifies(line: string): boolean {
	return charCount(line.trim()) >= KEPT_SHARE_MIN_CHARS;
}

/** How much of `window` the replacement `body` keeps (0..1); undefined when the comparison costs more than `budget.left`. */
function keptShare(window: readonly string[], body: readonly string[], verbatim: Set<string>, budget: { left: number }): number | undefined {
	const windowChars = window.reduce((sum, line) => sum + charCount(line.trim()), 0);
	const bodyChars = body.reduce((sum, row) => sum + charCount(row), 0);
	const cost = windowChars * bodyChars;
	if (window.length === 0 || cost > budget.left) return undefined;
	budget.left -= cost;
	let total = 0;
	for (const raw of window) {
		const line = raw.trim();
		if (!identifies(line)) continue;
		if (verbatim.has(line)) total += 1;
		else total += body.reduce((best, row) => Math.max(best, similarity(line, row)), 0);
	}
	return total / window.length;
}

/**
 * Whether a shifted replacement reads as written for the CURRENT lines at its authored numbers
 * (numbers taken from an untagged view of the current file) rather than for the lines the remap moves it onto.
 */
function aimedAtAuthoredLines(current: string, authored: readonly Edit[], offset: number): boolean {
	const groups: { payload: string[]; start: number; end: number }[] = [];
	let start = 0;
	while (start < authored.length) {
		const group = replacementGroup(authored, start);
		if (!group) {
			start += 1;
			continue;
		}
		start = group.deleteIndices[group.deleteIndices.length - 1] + 1;
		if (group.payload.some((row) => row.trim() !== "")) groups.push({ payload: group.payload, start: group.start, end: group.end });
	}
	if (groups.length === 0) return false;
	const lines = current.split("\n");
	const window = (first: number, last: number, shift: number) => {
		const out: string[] = [];
		for (let line = first; line <= last; line++) out.push(lines[line + shift - 1] ?? "");
		return out;
	};
	const budget = { left: KEPT_SHARE_BUDGET };
	for (const group of groups) {
		const body = group.payload.map((row) => row.trim()).filter((row) => row !== "");
		const target = window(group.start, group.end, offset);
		if (!target.some(identifies)) continue;
		const verbatim = new Set(body);
		const kept = keptShare(window(group.start, group.end, 0), body, verbatim, budget);
		if (kept === undefined) return false;
		if (kept < AUTHORED_LINES_FLOOR) continue;
		const targetKept = keptShare(target, body, verbatim, budget);
		if (targetKept === undefined) return false;
		if (kept > targetKept + AUTHORED_LINES_MARGIN) return true;
	}
	return false;
}

/** Rebase stale anchors from the retained snapshot `args.fileHash` onto the current text; undefined when that is not provably safe. */
export function tryRecover(store: EditStore, args: RecoveryArgs): RecoveryResult | undefined {
	const snapshot = store.byHash(args.path, args.fileHash);
	if (!snapshot) return undefined;
	const warning = store.head(args.path) === snapshot ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING;
	const remapped = remapEdits(snapshot.text, args.currentText, args.edits);
	if (!remapped) return undefined;
	if (remapped.offset !== 0 && aimedAtAuthoredLines(args.currentText, args.edits, remapped.offset)) return undefined;
	// Clipboard edits run on a copy, published only when recovery stands.
	const clipboard = args.clipboard && hasClipboardEdit(remapped.edits) ? forkClipboard(args.clipboard) : undefined;
	let applied: ReturnType<typeof applyEdits>;
	try {
		applied = applyEdits(args.currentText, remapped.edits, { clipboard, onEmptyPaste: "throw" });
	} catch {
		return undefined;
	}
	if (applied.text === args.currentText) return undefined;
	if (args.clipboard && clipboard) Object.assign(args.clipboard, clipboard);
	return { text: applied.text, firstChangedLine: applied.firstChangedLine, warnings: [remapped.offset === 0 ? warning : RECOVERY_LINE_REMAP_WARNING, ...applied.warnings] };
}

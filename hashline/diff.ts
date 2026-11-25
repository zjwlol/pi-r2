/**
 * hashline/diff.ts: line diff (Myers, as jsdiff does it), the line map used by stale-tag recovery,
 * string similarity, and the numbered diff + compact preview printed in edit results.
 * Port of oh-my-pi `crates/pi-diff/src/lib.rs` (myers_diff, line_runs_str),
 * `crates/pi-edit/src/diff_string.rs` (LineDiff::numbered, build_compact_diff_preview) and
 * `crates/pi-edit/src/fuzzy.rs::similarity` (MIT). Pure: no imports.
 */

/** A run of tokens with one classification, in forward order. */
export interface Run {
	count: number;
	added: boolean;
	removed: boolean;
}

interface Component {
	count: number;
	added: boolean;
	removed: boolean;
	prev: Component | undefined;
}
interface PathState {
	oldPos: number;
	last: Component | undefined;
}

function buildRuns(last: Component | undefined): Run[] {
	const runs: Run[] = [];
	for (let c = last; c !== undefined; c = c.prev) runs.push({ count: c.count, added: c.added, removed: c.removed });
	return runs.reverse();
}

/** Myers O(ND) diff over token ids, with jsdiff's tie-breaking (so run structure matches upstream). */
export function myersDiff(oldIds: readonly number[], newIds: readonly number[]): Run[] {
	const oldLen = oldIds.length;
	const newLen = newIds.length;
	const maxEdit = oldLen + newLen;
	const best = new Map<number, PathState>();
	const extractCommon = (path: PathState, diagonal: number): number => {
		let oldPos = path.oldPos;
		let newPos = oldPos - diagonal;
		let common = 0;
		while (newPos + 1 < newLen && oldPos + 1 < oldLen && oldIds[oldPos + 1] === newIds[newPos + 1]) {
			newPos += 1;
			oldPos += 1;
			common += 1;
		}
		if (common > 0) path.last = { count: common, added: false, removed: false, prev: path.last };
		path.oldPos = oldPos;
		return newPos;
	};
	const addToPath = (path: PathState, added: boolean, removed: boolean, oldPosInc: number): PathState => {
		const last = path.last;
		if (last && last.added === added && last.removed === removed) {
			return { oldPos: path.oldPos + oldPosInc, last: { count: last.count + 1, added, removed, prev: last.prev } };
		}
		return { oldPos: path.oldPos + oldPosInc, last: { count: 1, added, removed, prev: last } };
	};

	const seed: PathState = { oldPos: -1, last: undefined };
	const seedNewPos = extractCommon(seed, 0);
	if (seed.oldPos + 1 >= oldLen && seedNewPos + 1 >= newLen) return buildRuns(seed.last);
	best.set(0, seed);

	let minDiagonal = Number.NEGATIVE_INFINITY;
	let maxDiagonal = Number.POSITIVE_INFINITY;
	for (let editLength = 1; editLength <= maxEdit; editLength++) {
		for (let diagonal = Math.max(minDiagonal, -editLength); diagonal <= Math.min(maxDiagonal, editLength); diagonal += 2) {
			const removePath = best.get(diagonal - 1);
			best.delete(diagonal - 1);
			const addPath = best.get(diagonal + 1);
			let canAdd = false;
			if (addPath) {
				const addNewPos = addPath.oldPos - diagonal;
				canAdd = addNewPos >= 0 && addNewPos < newLen;
			}
			const canRemove = removePath !== undefined && removePath.oldPos + 1 < oldLen;
			if (!canAdd && !canRemove) {
				best.delete(diagonal);
				continue;
			}
			let basePath: PathState;
			if (!canRemove || (canAdd && removePath !== undefined && addPath !== undefined && removePath.oldPos < addPath.oldPos)) {
				basePath = addToPath(addPath as PathState, true, false, 0);
			} else {
				basePath = addToPath(removePath as PathState, false, true, 1);
			}
			const newPos = extractCommon(basePath, diagonal);
			if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) return buildRuns(basePath.last);
			if (basePath.oldPos + 1 >= oldLen) maxDiagonal = Math.min(maxDiagonal, diagonal - 1);
			if (newPos + 1 >= newLen) minDiagonal = Math.max(minDiagonal, diagonal + 1);
			best.set(diagonal, basePath);
		}
	}
	// Unreachable: a diff always exists within oldLen + newLen edits.
	return buildRuns(undefined);
}

/** Intern tokens as dense ids under exact equality. */
export function intern(oldTokens: readonly string[], newTokens: readonly string[]): { oldIds: number[]; newIds: number[] } {
	const ids = new Map<string, number>();
	const assign = (token: string): number => {
		let id = ids.get(token);
		if (id === undefined) {
			id = ids.size;
			ids.set(token, id);
		}
		return id;
	};
	return { oldIds: oldTokens.map(assign), newIds: newTokens.map(assign) };
}

/** jsdiff line tokens: each line WITH its `\n` terminator; the last line has none unless the text ends with `\n`. "" gives []. */
export function lineTokens(text: string): string[] {
	const tokens: string[] = [];
	let start = 0;
	while (start < text.length) {
		const nl = text.indexOf("\n", start);
		if (nl === -1) {
			tokens.push(text.slice(start));
			break;
		}
		tokens.push(text.slice(start, nl + 1));
		start = nl + 1;
	}
	return tokens;
}

/** Myers runs over the line tokens of two texts. */
export function lineRuns(oldText: string, newText: string): Run[] {
	const { oldIds, newIds } = intern(lineTokens(oldText), lineTokens(newText));
	return myersDiff(oldIds, newIds);
}

/** Map from `previous`'s 1-indexed line numbers to `current`'s, for lines an intervening change left untouched. */
export function buildLineMap(previous: string, current: string): Map<number, number> {
	const map = new Map<number, number>();
	let previousLine = 1;
	let currentLine = 1;
	for (const run of lineRuns(previous, current)) {
		if (run.added) currentLine += run.count;
		else if (run.removed) previousLine += run.count;
		else {
			for (let offset = 0; offset < run.count; offset++) map.set(previousLine + offset, currentLine + offset);
			previousLine += run.count;
			currentLine += run.count;
		}
	}
	return map;
}

function levenshtein(a: readonly string[], b: readonly string[]): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = new Array<number>(b.length + 1);
	let cur = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		cur[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, cur] = [cur, prev];
	}
	return prev[b.length];
}

/** Similarity in [0, 1]: `1 - levenshtein / max length`, over code points. */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a === "" || b === "") return 0;
	const ac = [...a];
	const bc = [...b];
	return 1 - levenshtein(ac, bc) / Math.max(ac.length, bc.length);
}

// ── numbered diff and compact preview ───────────────────────────────────

export interface NumberedDiff {
	/** Rows ` N|text` (context, old number), `-N|text` (removed, old number), `+N|text` (added, new number); "" separates hunks. */
	diff: string;
	/** 1-indexed first changed line in the new text. */
	firstChangedLine: number | undefined;
}

/** Numbered diff with `contextLines` of context around each change (upstream default 2). */
export function generateNumberedDiff(oldText: string, newText: string, contextLines = 2): NumberedDiff {
	const oldTokens = lineTokens(oldText);
	const newTokens = lineTokens(newText);
	const { oldIds, newIds } = intern(oldTokens, newTokens);
	const runs = myersDiff(oldIds, newIds);
	const row = (token: string) => (token.endsWith("\n") ? token.slice(0, -1) : token);
	const output: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;
	let oldPos = 0;
	let newPos = 0;
	for (let index = 0; index < runs.length; index++) {
		const run = runs[index];
		let raw: string[];
		if (run.removed) {
			raw = oldTokens.slice(oldPos, oldPos + run.count).map(row);
			oldPos += run.count;
		} else {
			raw = newTokens.slice(newPos, newPos + run.count).map(row);
			newPos += run.count;
			if (!run.added) oldPos += run.count;
		}
		if (run.added || run.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLine;
			for (const line of raw) {
				if (run.added) {
					output.push(`+${newLine}|${line}`);
					newLine += 1;
				} else {
					output.push(`-${oldLine}|${line}`);
					oldLine += 1;
				}
			}
			lastWasChange = true;
			continue;
		}
		const next = runs[index + 1];
		const nextIsChange = next !== undefined && (next.added || next.removed);
		if (!lastWasChange && !nextIsChange) {
			oldLine += raw.length;
			newLine += raw.length;
			lastWasChange = false;
			continue;
		}
		let head: string[];
		let tail: string[] = [];
		let leadingSkip = 0;
		let middleSkip = 0;
		let trailingSkip = 0;
		if (lastWasChange && nextIsChange) {
			if (raw.length > contextLines * 2) {
				middleSkip = raw.length - contextLines * 2;
				head = raw.slice(0, contextLines);
				tail = raw.slice(raw.length - contextLines);
			} else head = raw;
		} else if (nextIsChange) {
			leadingSkip = Math.max(0, raw.length - contextLines);
			head = raw.slice(leadingSkip);
		} else {
			trailingSkip = Math.max(0, raw.length - contextLines);
			head = raw.slice(0, Math.min(raw.length, contextLines));
		}
		oldLine += leadingSkip;
		newLine += leadingSkip;
		for (const line of head) {
			output.push(` ${oldLine}|${line}`);
			oldLine += 1;
			newLine += 1;
		}
		if (middleSkip > 0) {
			// Not upstream (it marks gaps only next to bracket-context rows): a blank row between hunks,
			// which the compact preview prints as `…`.
			output.push("");
			oldLine += middleSkip;
			newLine += middleSkip;
			for (const line of tail) {
				output.push(` ${oldLine}|${line}`);
				oldLine += 1;
				newLine += 1;
			}
		}
		oldLine += trailingSkip;
		newLine += trailingSkip;
		lastWasChange = false;
	}
	return { diff: output.join("\n"), firstChangedLine };
}

export interface CompactDiffPreview {
	/** Post-edit numbered rows `N:text`; `…` marks skipped rows. Removed rows are not shown. */
	preview: string;
	addedLines: number;
	removedLines: number;
}

const ELISION = "…";

/** Compact post-edit preview of a numbered diff; added runs longer than `2 * addedRunContext + 1` keep that many rows at each end. */
export function buildCompactDiffPreview(diff: string, addedRunContext = 2): CompactDiffPreview {
	const lines = diff === "" ? [] : diff.split("\n");
	const edge = Math.max(1, addedRunContext);
	let addedLines = 0;
	let removedLines = 0;
	const formatted: string[] = [];
	let addedRun: string[] = [];
	const push = (line: string) => {
		const normalized = line === "" || line === "..." || line === ELISION || line === "+…" ? ELISION : line;
		if (normalized === ELISION && (formatted.length === 0 || formatted[formatted.length - 1] === ELISION)) return;
		formatted.push(normalized);
	};
	const flush = () => {
		if (addedRun.length <= edge * 2 + 1) for (const line of addedRun) push(line);
		else {
			for (const line of addedRun.slice(0, edge)) push(line);
			push(ELISION);
			for (const line of addedRun.slice(addedRun.length - edge)) push(line);
		}
		addedRun = [];
	};
	for (const line of lines) {
		const m = /^([+\- ])\s*([+-]?\d+)[^|]*\|([\s\S]*)$/.exec(line);
		if (!m) {
			flush();
			push(line);
			continue;
		}
		const lineNumber = Number.parseInt(m[2], 10);
		if (m[1] === "+") {
			addedLines += 1;
			addedRun.push(`${lineNumber}:${m[3]}`);
		} else if (m[1] === "-") {
			flush();
			removedLines += 1;
		} else {
			flush();
			push(`${lineNumber + addedLines - removedLines}:${m[3]}`);
		}
	}
	flush();
	while (formatted.length > 0 && formatted[formatted.length - 1] === ELISION) formatted.pop();
	return { preview: formatted.join("\n"), addedLines, removedLines };
}

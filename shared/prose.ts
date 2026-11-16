/**
 * Shared by the pi-extended extensions (this directory has no index.ts, so pi
 * doesn't load it as an extension).
 */

// Markdown fenced-code opener: captures its indentation and marker.
const FENCE_RE = /^( {0,3})([`~]{3,})/;

// Tag/element name: HTML5/XML start char + name chars. Sticky so we can probe at
// a precise offset without slicing.
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;

/** Index just past the run of backticks beginning at `i`. */
function backtickRunEnd(text: string, i: number, n: number): number {
	let j = i;
	while (j < n && text[j] === "`") j++;
	return j;
}

/**
 * Find the closing backtick run that matches an opening run of `runLen`
 * backticks, scanning from `from`. Returns the index just past the closing run,
 * or -1 when no run of the exact length exists (an unmatched run is literal text,
 * not a code span). Already-masked positions (fenced code) are skipped.
 */
function findBacktickClose(text: string, from: number, n: number, runLen: number, masked: Uint8Array): number {
	let k = from;
	while (k < n) {
		if (masked[k]) {
			k++;
			continue;
		}
		if (text[k] === "`") {
			const e = backtickRunEnd(text, k, n);
			if (e - k === runLen) return e;
			k = e;
			continue;
		}
		k++;
	}
	return -1;
}

/**
 * Index of the `>` that closes a tag whose attributes begin at `j`, honoring
 * quoted attribute values. Returns -1 when the tag is malformed (a new `<`
 * appears first, or there is no `>`), so callers can treat the `<` as literal.
 */
function findTagEnd(text: string, j: number, n: number): number {
	let quote = "";
	for (let k = j; k < n; k++) {
		const ch = text[k];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ">") return k;
		if (ch === "<") return -1;
	}
	return -1;
}

/**
 * Whether a `</name` (ASCII case-insensitive, `lname` lowercase) starts at or
 * after `from`. A cheap necessary condition for {@link findMatchingClose} to
 * find anything; it may over-match (longer names, masked regions), never under.
 */
function hasCloseTagPrefix(text: string, from: number, lname: string): boolean {
	const len = lname.length;
	for (let k = text.indexOf("</", from); k >= 0; k = text.indexOf("</", k + 2)) {
		if (text.slice(k + 2, k + 2 + len).toLowerCase() === lname) return true;
	}
	return false;
}

/**
 * Locate the `</name>` that balances an opening `<name>` at `start`, counting
 * nested same-name tags. Returns the index just past the matching close tag's
 * `>`, or -1 when the section is never closed (so callers mask only the opening
 * tag rather than swallowing the rest of the document).
 *
 * `unclosed` is a per-call memo, lowercase name -> index from which the text
 * holds no `</name` at all, so prose with many unclosed tags (`Promise<Result>`,
 * `<br>`) is not rescanned to the end once per tag.
 */
function findMatchingClose(
	text: string,
	start: number,
	n: number,
	name: string,
	masked: Uint8Array,
	unclosed: Map<string, number>,
): number {
	const lname = name.toLowerCase();
	const none = unclosed.get(lname);
	if (none !== undefined && start >= none) return -1;
	if (!hasCloseTagPrefix(text, start, lname)) {
		unclosed.set(lname, start);
		return -1;
	}
	let depth = 1;
	let k = start;
	while (k < n) {
		if (masked[k] || text[k] !== "<") {
			k++;
			continue;
		}
		let m = k + 1;
		let isClose = false;
		if (text[m] === "/") {
			isClose = true;
			m++;
		}
		TAG_NAME.lastIndex = m;
		const nm = TAG_NAME.exec(text);
		if (!nm) {
			k++;
			continue;
		}
		const gt = findTagEnd(text, TAG_NAME.lastIndex, n);
		if (gt < 0) {
			k++;
			continue;
		}
		if (nm[0].toLowerCase() === lname) {
			if (isClose) {
				depth--;
				if (depth === 0) return gt + 1;
			} else if (text[gt - 1] !== "/") {
				depth++;
			}
		}
		k = gt + 1;
	}
	return -1;
}

/**
 * Mask the HTML/XML construct beginning at `<` (index `i`): an HTML comment, a
 * self-closing/closing tag (the tag alone), or an opening tag together with the
 * content through its matching close tag. Returns the index just past the masked
 * region, or `i` when the `<` does not begin a tag (e.g. a stray less-than).
 */
function maskTagAt(text: string, i: number, n: number, masked: Uint8Array, unclosed: Map<string, number>): number {
	if (text.startsWith("<!--", i)) {
		const end = text.indexOf("-->", i + 4);
		const stop = end < 0 ? n : end + 3;
		for (let p = i; p < stop; p++) masked[p] = 1;
		return stop;
	}
	let j = i + 1;
	let closing = false;
	if (text[j] === "/") {
		closing = true;
		j++;
	}
	TAG_NAME.lastIndex = j;
	const nm = TAG_NAME.exec(text);
	if (!nm) return i;
	const gt = findTagEnd(text, TAG_NAME.lastIndex, n);
	if (gt < 0) return i;
	const tagEnd = gt + 1;
	const selfClosing = text[gt - 1] === "/";
	for (let p = i; p < tagEnd; p++) masked[p] = 1;
	if (closing || selfClosing) return tagEnd;
	const close = findMatchingClose(text, tagEnd, n, nm[0], masked, unclosed);
	if (close < 0) return tagEnd;
	for (let p = tagEnd; p < close; p++) masked[p] = 1;
	return close;
}

/**
 * Length-preserving copy of `text` with fenced code blocks, inline code spans,
 * and XML/HTML sections blanked to spaces, so word matches only land on prose
 * while their indices still address the original text. Newlines are kept.
 *
 * Port of oh-my-pi's two-phase scanner (tui/src/prompt/markdown-prose.ts):
 * fences line by line per CommonMark (an unterminated fence runs to the end),
 * then inline code spans (an unmatched backtick run is literal) and tags over
 * what is left: comments (unterminated ones run to the end), lone closing and
 * self-closing tags, and opening tags through their matching close tag, with
 * same-name nesting counted, names compared case-insensitively and quoted
 * attribute values honoured. An unclosed opening tag masks only itself.
 */
export function maskNonProse(text: string): string {
	if (!text.includes("`") && !text.includes("<") && !text.includes("~~~")) {
		return text;
	}
	const n = text.length;
	const masked = new Uint8Array(n);
	const unclosed = new Map<string, number>();

	// Phase 1: fenced code blocks, line by line.
	let fenceChar = "";
	let fenceLen = 0;
	let lineStart = 0;
	while (lineStart <= n) {
		let nl = text.indexOf("\n", lineStart);
		if (nl < 0) nl = n;
		const line = text.slice(lineStart, nl);
		const open = FENCE_RE.exec(line);
		if (fenceChar) {
			for (let p = lineStart; p < nl; p++) masked[p] = 1;
			// A closing fence is the same char, at least as long, with nothing else on the line.
			if (
				open &&
				open[2]![0] === fenceChar &&
				open[2]!.length >= fenceLen &&
				line.slice(open[1]!.length + open[2]!.length).trim() === ""
			) {
				fenceChar = "";
				fenceLen = 0;
			}
		} else if (open) {
			const marker = open[2]!;
			const ch = marker[0]!;
			// A backtick fence's info string may not contain a backtick.
			if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				fenceChar = ch;
				fenceLen = marker.length;
				for (let p = lineStart; p < nl; p++) masked[p] = 1;
			}
		}
		if (nl === n) break;
		lineStart = nl + 1;
	}

	// Phase 2: inline code spans and HTML/XML, over not-yet-masked regions.
	let i = 0;
	while (i < n) {
		if (masked[i]) {
			i++;
			continue;
		}
		const c = text[i];
		if (c === "`") {
			const runEnd = backtickRunEnd(text, i, n);
			const close = findBacktickClose(text, runEnd, n, runEnd - i, masked);
			if (close >= 0) {
				for (let p = i; p < close; p++) masked[p] = 1;
				i = close;
			} else {
				i = runEnd;
			}
			continue;
		}
		if (c === "<") {
			const end = maskTagAt(text, i, n, masked, unclosed);
			i = end > i ? end : i + 1;
			continue;
		}
		i++;
	}

	const arr = text.split("");
	for (let p = 0; p < n; p++) {
		if (masked[p] && arr[p] !== "\n") arr[p] = " ";
	}
	return arr.join("");
}

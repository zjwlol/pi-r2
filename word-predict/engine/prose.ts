/**
 * Prose gating for the word-prediction engine: which words of a prompt are
 * completable prose, and whether a prompt looks typed rather than pasted.
 *
 * Port of oh-my-pi `crates/pi-predict/src/prose.rs` (MIT). The markdown mask
 * itself (`mask_non_prose`) is `maskNonProse` of `shared/prose.ts`, the same
 * two-phase scanner. Offsets are UTF-16 code units where upstream has UTF-8
 * bytes; the length caps are UTF-16 units on both sides.
 *
 * Loaded by Node's type stripping (worker and CLI): erasable syntax only.
 */
import { maskNonProse } from "../../shared/prose.ts";

/** Prompts longer than this (UTF-16 units) get no completion at all. */
const MAX_BUFFER = 20_000;
/** Lines longer than this (UTF-16 units) get no completion. */
const MAX_LINE = 1_000;
/** Typed-looking prompts: at most this many lines, each at most this long. */
const MAX_TYPED_LINES = 25;
const MAX_TYPED_LINE = 600;
const MIN_TYPED = 8;
const MIN_PROSE_FRACTION = 0.6;

const ALPHABETIC = /\p{Alphabetic}/u;
const UPPERCASE = /\p{Uppercase}/u;
const LOWERCASE = /\p{Lowercase}/u;

// Character classes, cached per BMP code point (0 = not classified yet).
const KNOWN = 1;
const LETTER = 2;
const UPPER = 4;
const LOWER = 8;
const CODEISH = 16;
const DIGIT = 32;
const classes = new Uint8Array(0x1_0000);

/**
 * Combining marks (`\p{M}`) that the `Alphabetic` property misses: the
 * general-purpose combining blocks plus variation selectors.
 */
function isMark(c: number): boolean {
	return (
		(c >= 0x0300 && c <= 0x036f) ||
		(c >= 0x0483 && c <= 0x0489) ||
		(c >= 0x0591 && c <= 0x05bd) ||
		(c >= 0x0610 && c <= 0x061a) ||
		(c >= 0x064b && c <= 0x065f) ||
		(c >= 0x0900 && c <= 0x0903) ||
		(c >= 0x093a && c <= 0x094f) ||
		(c >= 0x1ab0 && c <= 0x1aff) ||
		(c >= 0x1dc0 && c <= 0x1dff) ||
		(c >= 0x20d0 && c <= 0x20ff) ||
		(c >= 0x302a && c <= 0x302f) ||
		(c >= 0x3099 && c <= 0x309a) ||
		(c >= 0xfe00 && c <= 0xfe0f) ||
		(c >= 0xfe20 && c <= 0xfe2f)
	);
}

function classify(c: number): number {
	let bits = KNOWN;
	if (c < 0x80) {
		if (c >= 0x61 && c <= 0x7a) bits |= LETTER | LOWER;
		else if (c >= 0x41 && c <= 0x5a) bits |= LETTER | UPPER;
		else if (c >= 0x30 && c <= 0x39) bits |= DIGIT;
		// A word touching any of these characters is code, not prose: \ / @ _ = : { } [ ] < >
		else if ("\\/@_=:{}[]<>".includes(String.fromCharCode(c))) bits |= CODEISH;
		return bits;
	}
	const ch = String.fromCodePoint(c);
	if (ALPHABETIC.test(ch) || isMark(c)) bits |= LETTER;
	if (UPPERCASE.test(ch)) bits |= UPPER;
	if (LOWERCASE.test(ch)) bits |= LOWER;
	return bits;
}

function classOf(c: number): number {
	if (c >= 0x1_0000) return classify(c);
	let bits = classes[c];
	if (bits === 0) {
		bits = classify(c);
		classes[c] = bits;
	}
	return bits;
}

/** JavaScript `\s`: the characters `String.prototype.trim` strips. */
export function isJsSpace(codePoint: number): boolean {
	if (codePoint < 0x80) return codePoint === 0x20 || (codePoint >= 0x09 && codePoint <= 0x0d);
	return (
		codePoint === 0xa0 ||
		codePoint === 0x1680 ||
		(codePoint >= 0x2000 && codePoint <= 0x200a) ||
		codePoint === 0x2028 ||
		codePoint === 0x2029 ||
		codePoint === 0x202f ||
		codePoint === 0x205f ||
		codePoint === 0x3000 ||
		codePoint === 0xfeff
	);
}

/**
 * A letter or combining mark. Not `[\p{L}\p{M}]`: an ASCII letter, or
 * `Alphabetic`, or one of the explicit mark ranges above.
 */
export function isLetter(codePoint: number): boolean {
	return (classOf(codePoint) & LETTER) !== 0;
}

/** A character of a completable word: a letter, a mark or an apostrophe. */
export function isWordChar(codePoint: number): boolean {
	return codePoint === 0x27 || (classOf(codePoint) & LETTER) !== 0;
}

/** Whether every character of `text[start, end)` is JS whitespace. */
function isBlank(text: string, start: number, end: number): boolean {
	// Every JS space is one BMP unit, so units can stand in for characters.
	for (let i = start; i < end; i++) {
		if (!isJsSpace(text.charCodeAt(i))) return false;
	}
	return true;
}

/** Offset of the first character of `text[start, end)` that is not JS whitespace. */
function skipSpace(text: string, start: number, end: number): number {
	let i = start;
	while (i < end && isJsSpace(text.charCodeAt(i))) i++;
	return i;
}

/**
 * Share of non-whitespace characters (UTF-16 weighted) that survive
 * `maskNonProse`; 0 for blank text.
 */
export function proseFraction(text: string): number {
	const masked = maskNonProse(text);
	const n = text.length;
	let total = 0;
	let prose = 0;
	for (let i = 0; i < n; ) {
		const c = text.codePointAt(i)!;
		const units = c > 0xffff ? 2 : 1;
		if (!isJsSpace(c)) {
			total += units;
			// A masked character is blanked whole, one space per unit.
			const hidden = masked.charCodeAt(i) === 0x20 && (units === 1 || masked.charCodeAt(i + 1) === 0x20);
			if (!hidden) prose += units;
		}
		i += units;
	}
	return total === 0 ? 0 : prose / total;
}

/**
 * Shape rule for "a human typed this": 8..=`max` UTF-16 units, at most 25
 * lines of at most 600 units each, not a slash command, >= 60 % prose.
 */
function looksTyped(prompt: string, max: number): boolean {
	const n = prompt.length;
	if (n < MIN_TYPED || n > max) return false;
	let lines = 0;
	for (let lineStart = 0; ; ) {
		let nl = prompt.indexOf("\n", lineStart);
		if (nl < 0) nl = n;
		lines++;
		if (lines > MAX_TYPED_LINES || nl - lineStart > MAX_TYPED_LINE) return false;
		if (nl === n) break;
		lineStart = nl + 1;
	}
	if (prompt.charCodeAt(skipSpace(prompt, 0, n)) === 0x2f) return false;
	return proseFraction(prompt) >= MIN_PROSE_FRACTION;
}

/**
 * The typed-like rule: 8-1500 UTF-16 units, <= 25 lines, no line over 600,
 * not a slash command, >= 60 % prose. Anything else counts as a paste.
 */
export function isTypedLike(prompt: string): boolean {
	return looksTyped(prompt, 1500);
}

/**
 * The paste filter for learned vocabulary: `isTypedLike` with a 5000-unit
 * cap, so long hand-written prompts still count.
 */
export function isLearnable(prompt: string): boolean {
	return looksTyped(prompt, 5000);
}

/** One completable prose word of a prompt (UTF-16 offsets, end exclusive). */
export interface ProseWord {
	start: number;
	end: number;
}

/**
 * Whether the whitespace-delimited token `text[start, end)` is free of code
 * characters, ASCII digits and lowercase-then-uppercase pairs (camelCase).
 */
function isProseToken(text: string, start: number, end: number): boolean {
	let previousLower = false;
	for (let i = start; i < end; ) {
		const c = text.codePointAt(i)!;
		const bits = classOf(c);
		if ((bits & (CODEISH | DIGIT)) !== 0) return false;
		if (previousLower && (bits & UPPER) !== 0) return false;
		previousLower = (bits & LOWER) !== 0;
		i += c > 0xffff ? 2 : 1;
	}
	return true;
}

/**
 * Every word of `prompt` the editor would offer completion for: line-level
 * prose gates (the word survives the line's mask, its token is not code, the
 * line is not a slash command or an arrow), the whole-buffer prose mask, and
 * the buffer/line caps.
 */
export function proseWords(prompt: string): ProseWord[] {
	const out: ProseWord[] = [];
	const n = prompt.length;
	if (n > MAX_BUFFER) return out;
	const fullMask = maskNonProse(prompt);
	for (let lineStart = 0; ; ) {
		let lineEnd = prompt.indexOf("\n", lineStart);
		if (lineEnd < 0) lineEnd = n;
		if (lineEnd - lineStart <= MAX_LINE) {
			scanLine(prompt, fullMask, lineStart, lineEnd, out);
		}
		if (lineEnd === n) break;
		lineStart = lineEnd + 1;
	}
	return out;
}

/** The words of one line (`prompt[lineStart, lineEnd)`, no newline inside) that pass every gate. */
function scanLine(prompt: string, fullMask: string, lineStart: number, lineEnd: number, out: ProseWord[]): void {
	// Line-level gates: a slash command (after leading whitespace) or an arrow line has no prose.
	if (prompt.charCodeAt(skipSpace(prompt, lineStart, lineEnd)) === 0x2f) return;
	const first = prompt.charCodeAt(lineStart);
	if ((first === 0x2d || first === 0x3d) && prompt.charCodeAt(lineStart + 1) === 0x3e) return;

	// The line masked on its own: a fence or tag opened on an earlier line does not reach into it.
	// Nothing in the whole prompt opens a masked region when `maskNonProse` returned it unchanged.
	const line = prompt.slice(lineStart, lineEnd);
	const lineMask = fullMask === prompt ? line : maskNonProse(line);

	// Verdict of the token last examined; several words can share one (`well-known`).
	let tokenEnd = -1;
	let tokenOk = false;
	for (let i = lineStart; i < lineEnd; ) {
		const c = prompt.codePointAt(i)!;
		if (!isWordChar(c)) {
			i += c > 0xffff ? 2 : 1;
			continue;
		}
		// Maximal run of word characters.
		const start = i;
		i += c > 0xffff ? 2 : 1;
		while (i < lineEnd) {
			const next = prompt.codePointAt(i)!;
			if (!isWordChar(next)) break;
			i += next > 0xffff ? 2 : 1;
		}
		const end = i;
		if (isBlank(lineMask, start - lineStart, end - lineStart)) continue;
		if (start >= tokenEnd) {
			let tokenStart = start;
			while (tokenStart > lineStart && !isJsSpace(prompt.charCodeAt(tokenStart - 1))) tokenStart--;
			tokenEnd = end;
			while (tokenEnd < lineEnd && !isJsSpace(prompt.charCodeAt(tokenEnd))) tokenEnd++;
			tokenOk = isProseToken(prompt, tokenStart, tokenEnd);
		}
		if (!tokenOk) continue;
		if (isBlank(fullMask, start, end)) continue;
		out.push({ start, end });
	}
}

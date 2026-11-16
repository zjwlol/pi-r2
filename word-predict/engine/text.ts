/**
 * Left context shared by learning and completion, so both see the same
 * history: the previous one or two prose words, a sentence start, or nothing
 * when code, digits or markup break the chain. Plus the lowercasing helpers
 * the engine uses.
 *
 * Port of oh-my-pi `crates/pi-predict/src/ngram/text.rs` (MIT), and of
 * `lowercase_aligned` from `ngram/query.rs`. Offsets are UTF-16 code units
 * where upstream has UTF-8 bytes; gaps and word lengths count code points.
 *
 * Loaded by Node's type stripping (worker and CLI): erasable syntax only.
 */
import { isWordChar } from "./prose.ts";

/** Sentence/line start pseudo-word (Norvig's `<S>` maps onto it). */
export const BOS = "<s>";

/** Unknown: code or symbols broke the chain. */
export const SLOT_NONE = 0;
/** Sentence or line start. */
export const SLOT_BOS = 1;
/** A prose word, lowercased into `uWord` / `vWord`. */
export const SLOT_WORD = 2;
/** One side of a left context. */
export type Slot = 0 | 1 | 2;

/**
 * Left context of a word: `v` is the word right before it, `u` the one
 * before `v`. `uWord` / `vWord` hold the lowercased word of a `SLOT_WORD`
 * slot and are empty otherwise.
 */
export interface Context {
	u: Slot;
	v: Slot;
	uWord: string;
	vWord: string;
}

/** How far back (in characters) a gap between two words may reach. */
const MAX_GAP = 64;

const GAP_JOIN = 0;
const GAP_STOP = 1;
const GAP_BREAK = 2;

const NON_ASCII = /[^\x00-\x7f]/;

/** Characters a prose token may be wrapped in: `( ) " *` and curly quotes. */
function isSoftWrap(c: number): boolean {
	return c === 0x28 || c === 0x29 || c === 0x22 || c === 0x2a || c === 0x201c || c === 0x201d || c === 0x2018 || c === 0x2019;
}

/** Code point ending at UTF-16 offset `end` (> 0) of `text`. */
function codePointBefore(text: string, end: number): number {
	const low = text.charCodeAt(end - 1);
	if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
		const high = text.charCodeAt(end - 2);
		if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x1_0000;
	}
	return low;
}

/** Whether the gap `text[start, end)` joins two words, ends a sentence, or breaks the chain. */
function classifyGap(text: string, start: number, end: number): number {
	let kind = GAP_JOIN;
	// Every accepted character is one BMP unit; a surrogate breaks like any other symbol.
	for (let i = start; i < end; i++) {
		const c = text.charCodeAt(i);
		// space, tab, `, ; -`, en dash, em dash
		if (c === 0x20 || c === 0x09 || c === 0x2c || c === 0x3b || c === 0x2d || c === 0x2013 || c === 0x2014) continue;
		// newline, `. ! ? :`
		if (c === 0x0a || c === 0x2e || c === 0x21 || c === 0x3f || c === 0x3a) {
			kind = GAP_STOP;
			continue;
		}
		if (isSoftWrap(c)) continue;
		return GAP_BREAK;
	}
	return kind;
}

/** Start of the gap ending at `end`: walks back over non-word characters, at most `MAX_GAP` of them. */
function gapStart(text: string, end: number): number {
	let at = end;
	for (let steps = 0; at > 0 && steps < MAX_GAP; steps++) {
		const c = codePointBefore(text, at);
		if (isWordChar(c)) break;
		at -= c > 0xffff ? 2 : 1;
	}
	return at;
}

/** Word found by the last successful `wordEndingAt`, lowercased. */
let foundWord = "";

/**
 * The prose word ending at `end`, lowercased into `foundWord`; returns its
 * start, or -1 when there is none or the token looks like code (glued to a
 * symbol, camelCase).
 */
function wordEndingAt(text: string, end: number): number {
	let start = end;
	while (start > 0) {
		const c = codePointBefore(text, start);
		if (!isWordChar(c)) break;
		start -= c > 0xffff ? 2 : 1;
	}
	if (start === end) return -1;
	if (start > 0) {
		const before = text.charCodeAt(start - 1);
		if (!(before === 0x20 || before === 0x09 || before === 0x0a || before === 0x2d || isSoftWrap(before))) return -1;
	}
	// An ASCII lowercase letter directly followed by an ASCII uppercase one.
	let previousLower = false;
	for (let i = start; i < end; i++) {
		const c = text.charCodeAt(i);
		if (previousLower && c >= 0x41 && c <= 0x5a) return -1;
		previousLower = c >= 0x61 && c <= 0x7a;
	}
	foundWord = lowercase(text.slice(start, end));
	return start;
}

function fill(out: Context, u: Slot, v: Slot, uWord: string, vWord: string): Context {
	out.u = u;
	out.v = v;
	out.uWord = uWord;
	out.vWord = vWord;
	return out;
}

/** Left context of the word starting at UTF-16 offset `end` of `text`; fills and returns `out`. */
export function contextBefore(text: string, end: number, out: Context): Context {
	const g1 = gapStart(text, end);
	if (g1 === 0) return fill(out, SLOT_NONE, SLOT_BOS, "", "");
	const gap1 = classifyGap(text, g1, end);
	if (gap1 === GAP_BREAK) return fill(out, SLOT_NONE, SLOT_NONE, "", "");
	if (gap1 === GAP_STOP) return fill(out, SLOT_NONE, SLOT_BOS, "", "");
	const prev = wordEndingAt(text, g1);
	if (prev < 0) return fill(out, SLOT_NONE, SLOT_NONE, "", "");
	const vWord = foundWord;
	const g2 = gapStart(text, prev);
	if (g2 === 0) return fill(out, SLOT_BOS, SLOT_WORD, "", vWord);
	const gap2 = classifyGap(text, g2, prev);
	if (gap2 === GAP_BREAK) return fill(out, SLOT_NONE, SLOT_WORD, "", vWord);
	if (gap2 === GAP_STOP) return fill(out, SLOT_BOS, SLOT_WORD, "", vWord);
	if (wordEndingAt(text, g2) < 0) return fill(out, SLOT_NONE, SLOT_WORD, "", vWord);
	return fill(out, SLOT_WORD, SLOT_WORD, foundWord, vWord);
}

/**
 * Lowercase `text` one code point at a time (Rust `char::to_lowercase`):
 * no final-sigma rule, so `ΟΔΟΣ` becomes `οδοσ`.
 */
export function lowercase(text: string): string {
	// ASCII has no context-dependent mapping.
	if (!NON_ASCII.test(text)) return text.toLowerCase();
	let out = "";
	for (const ch of text) out += ch.toLowerCase();
	return out;
}

function utf8Length(codePoint: number): number {
	return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x1_0000 ? 3 : 4;
}

/**
 * Lowercase `text` keeping offsets: a character whose lowercase form is not
 * a single character of the same UTF-8 length is kept as typed. Equal UTF-8
 * length implies equal UTF-16 length, so unit offsets stay aligned too.
 */
export function lowercaseAligned(text: string): string {
	if (!NON_ASCII.test(text)) return text.toLowerCase();
	let out = "";
	for (const ch of text) {
		const lower = ch.toLowerCase();
		const c = lower.codePointAt(0)!;
		const single = lower.length === (c > 0xffff ? 2 : 1);
		out += single && utf8Length(c) === utf8Length(ch.codePointAt(0)!) ? lower : ch;
	}
	return out;
}

/**
 * Case "tail" of a surface form: the word with its first letter lowercased.
 * Sentence-initial capitals are positional, so only the tail identifies a
 * word's own casing (`API`, `PRs`, `OAuth`).
 */
export function caseTail(surface: string): string {
	if (surface.length === 0) return "";
	const first = surface.codePointAt(0)!;
	if (first < 0x80) {
		// Already lowercase (the common case): nothing to rebuild.
		if (first < 0x41 || first > 0x5a) return surface;
		return String.fromCharCode(first + 0x20) + surface.slice(1);
	}
	const units = first > 0xffff ? 2 : 1;
	return surface.slice(0, units).toLowerCase() + surface.slice(units);
}

/** Number of code points of `text`. */
export function codePoints(text: string): number {
	const n = text.length;
	let count = n;
	for (let i = 0; i + 1 < n; i++) {
		const c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				count--;
				i++;
			}
		}
	}
	return count;
}

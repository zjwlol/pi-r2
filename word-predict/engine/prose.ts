import { maskNonProse } from "../../shared/prose.ts";

const MAX_BUFFER = 20_000;
const MAX_LINE = 1_000;
const MAX_TYPED_LINES = 25;
const MAX_TYPED_LINE = 600;
const MIN_TYPED = 8;
const MIN_PROSE_FRACTION = 0.6;

const ALPHABETIC = /\p{Alphabetic}/u;
const UPPERCASE = /\p{Uppercase}/u;
const LOWERCASE = /\p{Lowercase}/u;

const KNOWN = 1;
const LETTER = 2;
const UPPER = 4;
const LOWER = 8;
const CODEISH = 16;
const DIGIT = 32;
const classes = new Uint8Array(0x1_0000);

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

export function isLetter(codePoint: number): boolean {
	return (classOf(codePoint) & LETTER) !== 0;
}

export function isWordChar(codePoint: number): boolean {
	return codePoint === 0x27 || (classOf(codePoint) & LETTER) !== 0;
}

function isBlank(text: string, start: number, end: number): boolean {
	for (let i = start; i < end; i++) {
		if (!isJsSpace(text.charCodeAt(i))) return false;
	}
	return true;
}

function skipSpace(text: string, start: number, end: number): number {
	let i = start;
	while (i < end && isJsSpace(text.charCodeAt(i))) i++;
	return i;
}

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
			// The mask uses one space per hidden UTF-16 code unit.
			const hidden = masked.charCodeAt(i) === 0x20 && (units === 1 || masked.charCodeAt(i + 1) === 0x20);
			if (!hidden) prose += units;
		}
		i += units;
	}
	return total === 0 ? 0 : prose / total;
}

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

export function isTypedLike(prompt: string): boolean {
	return looksTyped(prompt, 1500);
}

export function isLearnable(prompt: string): boolean {
	return looksTyped(prompt, 5000);
}

/**
 * The offsets are UTF-16 code units with an exclusive end.
 */
export interface ProseWord {
	start: number;
	end: number;
}

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

function scanLine(prompt: string, fullMask: string, lineStart: number, lineEnd: number, out: ProseWord[]): void {
	if (prompt.charCodeAt(skipSpace(prompt, lineStart, lineEnd)) === 0x2f) return;
	const first = prompt.charCodeAt(lineStart);
	if ((first === 0x2d || first === 0x3d) && prompt.charCodeAt(lineStart + 1) === 0x3e) return;

	const line = prompt.slice(lineStart, lineEnd);
	// The editor checks the line's mask separately from the whole prompt.
	const lineMask = fullMask === prompt ? line : maskNonProse(line);

	let tokenEnd = -1;
	let tokenOk = false;
	for (let i = lineStart; i < lineEnd; ) {
		const c = prompt.codePointAt(i)!;
		if (!isWordChar(c)) {
			i += c > 0xffff ? 2 : 1;
			continue;
		}
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

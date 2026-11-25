
export const HL_FILE_HASH_EXAMPLES = ["1A2B", "3C4D", "9F3E"] as const;
export const BOM = "\uFEFF";

export function formatHashlineHeader(path: string, tag: string): string {
	return `[${path}#${tag}]`;
}

export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${line}`;
}

export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

export function formatNumberedLines(text: string, startLine: number): string {
	return text
		.split("\n")
		.map((line, i) => formatNumberedLine(startLine + i, line))
		.join("\n");
}

export function describeAnchorExamples(linePrefix: string): string {
	let examples: string[];
	if (linePrefix === "") examples = ["160", "42", "7"];
	else {
		const shortened = linePrefix.slice(0, -1);
		examples = [linePrefix, `${shortened === "" ? "4" : shortened}2`, "7"];
	}
	return examples.map((e) => `"${e}"`).join(", ");
}

export function normalizeToLf(text: string): string {
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith(BOM) ? { bom: BOM, text: content.slice(1) } : { bom: "", text: content };
}

export function detectLineEnding(content: string): "\n" | "\r\n" {
	const lf = content.indexOf("\n");
	if (lf === -1) return "\n";
	const crlf = content.indexOf("\r\n");
	return crlf !== -1 && crlf < lf ? "\r\n" : "\n";
}

export function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

function rotl(x: number, r: number): number {
	return (x << r) | (x >>> (32 - r));
}

export function xxh32(bytes: Uint8Array, seed = 0): number {
	const len = bytes.length;
	const read32 = (i: number) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
	const round = (acc: number, input: number) => Math.imul(rotl((acc + Math.imul(input, P2)) | 0, 13), P1);
	let i = 0;
	let h: number;
	if (len >= 16) {
		let v1 = (seed + P1 + P2) | 0;
		let v2 = (seed + P2) | 0;
		let v3 = seed | 0;
		let v4 = (seed - P1) | 0;
		while (i <= len - 16) {
			v1 = round(v1, read32(i));
			v2 = round(v2, read32(i + 4));
			v3 = round(v3, read32(i + 8));
			v4 = round(v4, read32(i + 12));
			i += 16;
		}
		h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
	} else {
		h = (seed + P5) | 0;
	}
	h = (h + len) | 0;
	while (i <= len - 4) {
		h = Math.imul(rotl((h + Math.imul(read32(i), P3)) | 0, 17), P4);
		i += 4;
	}
	while (i < len) {
		h = Math.imul(rotl((h + Math.imul(bytes[i], P5)) | 0, 11), P1);
		i += 1;
	}
	h ^= h >>> 15;
	h = Math.imul(h, P2);
	h ^= h >>> 13;
	h = Math.imul(h, P3);
	h ^= h >>> 16;
	return h >>> 0;
}

export function computeFileHash(text: string): string {
	const stripped = text
		.split("\n")
		.map((line) => line.replace(/[ \t\r]+$/, ""))
		.join("\n");
	const digest = xxh32(new TextEncoder().encode(stripped), 0);
	return (digest & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

const HL_PREFIX_RE = /^\s*(?:(?:>>>|>>)\s*)?(?:[+*-]\s*)?(\d+)[:|]/;
const READ_RANGE_ELISION_RE = /^\s*[1-9]\d*\s*-\s*[1-9]\d*:.*(?:…|\.\.\.).*$/;
const READ_SINGLE_ELISION_RE = /^\s*(?:…|\.\.\.)\s*$/;

export function isReadTruncationNotice(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length < 2 || !trimmed.startsWith("[") || !trimmed.endsWith("]")) return false;
	const body = trimmed.slice(1, -1);
	const showing =
		body.startsWith("Showing ") &&
		(body.includes(" line") || body.includes("lines ") || body.includes("bytes ")) &&
		(body.includes(" of ") || body.includes(" elided"));
	const moreAt = body.indexOf(" more line");
	const more =
		(body.startsWith("More lines in ") || (moreAt !== -1 && /^\d+$/.test(body.slice(0, moreAt)))) &&
		body.includes(" in ") &&
		body.includes(". Use ") &&
		body.endsWith(" to continue");
	const elided = (body.startsWith("…") || body.startsWith("...")) && body.includes("ln elided;") && body.includes("re-read needed ranges");
	const oversized = body.startsWith("Line ") && body.includes(" exceeds ") && body.includes(" limit.");
	return showing || more || elided || oversized;
}

export function isReadMetadataLine(line: string): boolean {
	return isReadTruncationNotice(line) || READ_RANGE_ELISION_RE.test(line) || READ_SINGLE_ELISION_RE.test(line);
}

export function stripOneLeadingHashlinePrefix(line: string): string {
	return line.replace(HL_PREFIX_RE, "");
}

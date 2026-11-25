import { describeAnchorExamples } from "./format.ts";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER, jsonQuote } from "./messages.ts";
import { HashlineError, type ParsedRange } from "./types.ts";

export type BlockTarget =
	| { kind: "replace"; range: ParsedRange; register: string | undefined }
	| { kind: "block"; line: number; register: string | undefined }
	| { kind: "insert_before"; line: number; register: string | undefined }
	| { kind: "insert_after"; line: number; register: string | undefined }
	| { kind: "insert_after_block"; line: number; register: string | undefined }
	| { kind: "cut"; range: ParsedRange; register: string | undefined }
	| { kind: "cut_block"; line: number; register: string | undefined }
	| { kind: "bof"; register: string | undefined }
	| { kind: "eof"; register: string | undefined }
	| { kind: "rem" }
	| { kind: "move"; dest: string };

export type Token =
	| { kind: "blank"; lineNum: number }
	| { kind: "envelope_begin"; lineNum: number }
	| { kind: "envelope_end"; lineNum: number }
	| { kind: "abort"; lineNum: number }
	| { kind: "header"; lineNum: number; path: string; fileHash: string | undefined }
	| { kind: "op"; lineNum: number; target: BlockTarget; hadColon: boolean }
	| { kind: "payload"; lineNum: number; text: string }
	| { kind: "raw"; lineNum: number; text: string };

const U32_MAX = 4294967295;

function parseNumberPrefix(raw: string): [number, number] | undefined {
	const m = /^[1-9][0-9]*/.exec(raw);
	if (!m) return undefined;
	const value = Number(m[0]);
	if (value > U32_MAX) return undefined;
	return [value, m[0].length];
}

function parseRange(raw: string): [ParsedRange, number, boolean] | undefined {
	const leading = raw.length - raw.trimStart().length;
	const first = parseNumberPrefix(raw.slice(leading));
	if (!first) return undefined;
	const start = first[0];
	let cursor = leading + first[1];
	let sawNonWs = false;
	while (cursor < raw.length) {
		const ch = raw[cursor];
		if (/\s/.test(ch)) cursor += 1;
		else if (ch === "-" || ch === "." || ch === "=" || ch === "…") {
			sawNonWs = true;
			cursor += 1;
		} else break;
	}
	const second = parseNumberPrefix(raw.slice(cursor));
	if (second) {
		cursor += second[1];
		while (cursor < raw.length && /[ \t\n\r\f]/.test(raw[cursor])) cursor += 1;
		return [{ start, end: second[0] }, cursor, true];
	}
	if (sawNonWs && (cursor === raw.length || raw[cursor] === ":" || raw[cursor] === "@")) return [{ start, end: start }, cursor, true];
	return [{ start, end: start }, cursor, false];
}

function withRegister(target: BlockTarget, register: string): BlockTarget {
	if (target.kind === "rem" || target.kind === "move") return target;
	return { ...target, register };
}

function parseRegisterAndColon(raw: string, target: BlockTarget): [BlockTarget, boolean] | undefined {
	let rest = raw.trimStart();
	if (rest.startsWith("@")) {
		const m = /^[A-Za-z0-9_-]*/.exec(rest.slice(1)) as RegExpExecArray;
		const name = m[0];
		if (name.length === 0 || name.length > 64) return undefined;
		target = withRegister(target, name);
		rest = rest.slice(1 + name.length).trimStart();
	}
	const hadColon = rest.startsWith(":");
	if (hadColon) rest = rest.slice(1).trimStart();
	return rest === "" ? [target, hadColon] : undefined;
}

function parsePutTarget(raw: string): [BlockTarget, boolean] | undefined {
	const rest = raw.trimStart();
	if (rest.startsWith(">")) {
		const after = rest.slice(1).trimStart();
		if (after.startsWith("$")) return parseRegisterAndColon(after.slice(1), { kind: "eof", register: undefined });
		const num = parseNumberPrefix(after);
		if (!num) return undefined;
		let tail = after.slice(num[1]);
		const block = tail.startsWith("*");
		if (block) tail = tail.slice(1);
		return parseRegisterAndColon(tail, block ? { kind: "insert_after_block", line: num[0], register: undefined } : { kind: "insert_after", line: num[0], register: undefined });
	}
	if (rest.startsWith("<")) {
		const after = rest.slice(1).trimStart();
		const num = parseNumberPrefix(after);
		if (!num) return undefined;
		let tail = after.slice(num[1]);
		if (tail.startsWith("*")) tail = tail.slice(1);
		return parseRegisterAndColon(tail, num[0] === 1 ? { kind: "bof", register: undefined } : { kind: "insert_before", line: num[0], register: undefined });
	}
	const parsed = parseRange(rest);
	if (!parsed) return undefined;
	const [range, used, hadSeparator] = parsed;
	const tail = rest.slice(used);
	if (tail.startsWith("*")) {
		if (hadSeparator) return undefined;
		return parseRegisterAndColon(tail.slice(1), { kind: "block", line: range.start, register: undefined });
	}
	return parseRegisterAndColon(tail, { kind: "replace", range, register: undefined });
}

function parseCutTarget(raw: string): [BlockTarget, boolean] | undefined {
	const rest = raw.trimStart();
	const parsed = parseRange(rest);
	if (!parsed) return undefined;
	const [range, used, hadSeparator] = parsed;
	const tail = rest.slice(used);
	if (tail.startsWith("*")) {
		if (hadSeparator) return undefined;
		return parseRegisterAndColon(tail.slice(1), { kind: "cut_block", line: range.start, register: undefined });
	}
	return parseRegisterAndColon(tail, { kind: "cut", range, register: undefined });
}

function keywordTail(line: string, keyword: string): string | undefined {
	if (!line.startsWith(keyword)) return undefined;
	const rest = line.slice(keyword.length);
	return rest === "" || rest.startsWith(":") || /^\s/.test(rest) ? rest : undefined;
}

function unquotePath(raw: string): string | undefined {
	for (const q of ['"', "'"]) {
		if (raw.length >= 2 && raw.startsWith(q) && raw.endsWith(q)) return raw.slice(1, -1);
	}
	return raw.startsWith('"') || raw.startsWith("'") ? undefined : raw;
}

export function parseHunkHeader(row: string): [BlockTarget, boolean] | undefined {
	const line = row.trim();
	let rest = keywordTail(line, "REM");
	if (rest !== undefined) return rest.trim() === "" ? [{ kind: "rem" }, false] : undefined;
	rest = keywordTail(line, "MV");
	if (rest !== undefined) {
		const dest = unquotePath(rest.trim());
		return dest !== undefined && dest !== "" ? [{ kind: "move", dest }, false] : undefined;
	}
	rest = keywordTail(line, "PUT");
	if (rest !== undefined) return parsePutTarget(rest);
	rest = keywordTail(line, "CUT");
	if (rest !== undefined) return parseCutTarget(rest);
	return undefined;
}

export function isHunkHeaderText(text: string): boolean {
	return parseHunkHeader(text) !== undefined;
}

export function headerPathHasOrphanBracket(path: string): boolean {
	let depth = 0;
	for (const ch of path) {
		if (ch === "[") depth += 1;
		else if (ch === "]") {
			if (depth === 0) return true;
			depth -= 1;
		}
	}
	return false;
}

export function parseHeader(row: string): [string, string | undefined] | undefined {
	const line = row.trimEnd();
	if (line.length < 2 || !line.startsWith("[") || !line.endsWith("]")) return undefined;
	const body = line.slice(1, -1);
	if (body === "") return undefined;
	const sep = body.lastIndexOf("#");
	if (sep !== -1) {
		const path = body.slice(0, sep);
		const hash = body.slice(sep + 1);
		if (path === "" || headerPathHasOrphanBracket(path) || !/^[0-9A-Fa-f]{4}$/.test(hash)) return undefined;
		return [path, hash.toUpperCase()];
	}
	return headerPathHasOrphanBracket(body) ? undefined : [body, undefined];
}

export function classifyLine(line: string, lineNum: number): Token {
	if (line === "") return { kind: "blank", lineNum };
	const marker = line.trimEnd();
	if (marker === BEGIN_PATCH_MARKER) return { kind: "envelope_begin", lineNum };
	if (marker === END_PATCH_MARKER) return { kind: "envelope_end", lineNum };
	if (marker === ABORT_MARKER) return { kind: "abort", lineNum };
	const header = parseHeader(line);
	if (header) return { kind: "header", lineNum, path: header[0], fileHash: header[1] };
	const op = parseHunkHeader(line);
	if (op) return { kind: "op", lineNum, target: op[0], hadColon: op[1] };
	if (line.startsWith("+")) return { kind: "payload", lineNum, text: line.slice(1) };
	return { kind: "raw", lineNum, text: line };
}

export function tokenizeAll(text: string): Token[] {
	const tokens: Token[] = [];
	const parts = text.split("\n");
	const last = parts.pop() as string;
	let lineNum = 1;
	for (const part of parts) tokens.push(classifyLine(part.endsWith("\r") ? part.slice(0, -1) : part, lineNum++));
	if (last !== "") tokens.push(classifyLine(last.endsWith("\r") ? last.slice(0, -1) : last, lineNum));
	return tokens;
}

export function parseLid(raw: string, lineNum: number): number {
	const value = raw.trim();
	if (!/^[1-9][0-9]*$/.test(value) || Number(value) > U32_MAX) {
		throw new HashlineError(
			"parse",
			`line ${lineNum}: expected a line number such as ${describeAnchorExamples("119")}; got ${jsonQuote(raw)}. Use [PATH#hash] from your latest read for file-version binding.`,
		);
	}
	return Number(value);
}

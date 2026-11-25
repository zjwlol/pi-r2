import { isReadMetadataLine, stripOneLeadingHashlinePrefix } from "./format.ts";
import * as M from "./messages.ts";
import { type BlockTarget, isHunkHeaderText, type Token, tokenizeAll } from "./tokenizer.ts";
import { type BlockMode, type Cursor, type Edit, type FileOp, HashlineError, type Parsed, type ParsedRange, type PasteTarget } from "./types.ts";

const MAX_EXPANDED_RANGE_LINES = 100000;
export const UNIFIED_HUNK_RE = /^@@\s+[-+]?\d+,\d+\s+[-+]?\d+,\d+\s+@@/;

interface PayloadRow {
	text: string;
	lineNum: number;
	bare: boolean;
	minus: boolean;
}
interface Pending {
	target: BlockTarget;
	lineNum: number;
	payloads: PayloadRow[];
	hadColon: boolean;
	deferredBlanks: PayloadRow[];
}

function fail(message: string): never {
	throw new HashlineError("parse", message);
}
function failAt(line: number, message: string): never {
	fail(`line ${line}: ${message}`);
}

function validateRange(range: ParsedRange, lineNum: number, op: M.AbsoluteRangeOp, register: string | undefined): void {
	if (range.end < range.start) fail(M.invalidAbsoluteRangeMessage(lineNum, range.start, range.end, op, register));
	const span = range.end - range.start + 1;
	if (span > MAX_EXPANDED_RANGE_LINES) failAt(lineNum, `${op} range spans ${span} lines; the maximum is ${MAX_EXPANDED_RANGE_LINES}. Split it into smaller hunks.`);
}

function targetRegister(target: BlockTarget): string | undefined {
	return target.kind === "rem" || target.kind === "move" ? undefined : target.register;
}

function bodylessMessage(target: BlockTarget, hadColon: boolean): string | undefined {
	if (target.kind === "cut" || target.kind === "cut_block") return M.CUT_TAKES_NO_BODY;
	if (target.kind === "rem" || target.kind === "move") return undefined;
	if (target.register !== undefined) return M.REGISTER_PUT_TAKES_NO_BODY;
	if (!hadColon) return M.COLONLESS_PUT_TAKES_NO_BODY;
	return undefined;
}

function markdownBullet(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("- ") && trimmed.length > 2 && !/\s/.test(trimmed[2]);
}

function parseSnapshotRow(text: string): [number, string] | undefined {
	const trimmed = text.trimStart();
	const split = trimmed.search(/[:|]/);
	if (split === -1) return undefined;
	const number = trimmed.slice(0, split);
	if (!/^[1-9][0-9]*$/.test(number) || Number(number) > 4294967295) return undefined;
	return [Number(number), trimmed.slice(split + 1)];
}

function parseBareRange(text: string): ParsedRange | undefined {
	const trimmed = text.trim();
	if (!trimmed.endsWith(":")) return undefined;
	const parts = trimmed
		.slice(0, -1)
		.trim()
		.split(/[\s\-.=…]+/)
		.filter((p) => p !== "");
	if (parts.length !== 2 || !parts.every((p) => /^[0-9]+$/.test(p))) return undefined;
	const start = Number(parts[0]);
	const end = Number(parts[1]);
	if (start === 0 || end === 0 || start > 4294967295 || end > 4294967295) return undefined;
	return { start, end };
}

function preview48(trimmed: string): string {
	const chars = [...trimmed];
	return chars.length > 48 ? `${chars.slice(0, 48).join("")}…` : trimmed;
}

function contaminationMessage(text: string): string | undefined {
	const trimmed = text.trimStart();
	if (["*** Update File:", "*** Add File:", "*** Delete File:", "*** Move to:"].some((p) => trimmed.startsWith(p))) {
		return `apply_patch sentinel ${M.jsonQuote(preview48(trimmed))} is not valid in hashline. File sections start with \`[path#HASH]\` (no \`Update File:\` / \`Add File:\` keyword). Use \`PUT N.=M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` ops.`;
	}
	if (trimmed.startsWith("@@")) {
		if (UNIFIED_HUNK_RE.test(trimmed)) {
			return "unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. Use `PUT N.=M:`, `CUT N.=M`, or `PUT <N:`/`PUT >N:` ops.";
		}
		return `\`@@\`-bracketed hunk header ${M.jsonQuote(preview48(trimmed))} is not valid in hashline. Drop the \`@@ ... @@\` brackets and write a header such as \`PUT N.=M:\`.`;
	}
	if (trimmed !== "" && /^[0-9 \t\n\r\f]+$/.test(trimmed) && trimmed.split(/\s+/).filter((p) => p !== "").length === 1) {
		const n = trimmed.trim();
		return `hunk headers need a verb and both endpoints. Use \`PUT ${n}.=${n}:\` to replace, or \`CUT ${n}.=${n}\` to delete.`;
	}
	const pieces = trimmed
		.replace(/:+$/, "")
		.split(/\s+/)
		.filter((p) => p !== "");
	if (pieces.length === 2 && pieces.every((p) => /^[0-9]+$/.test(p))) {
		return `bare range hunk header ${M.jsonQuote(trimmed)} is not valid. Hunk headers need a verb: use \`PUT N.=M:\` or \`CUT N.=M\`.`;
	}
	return undefined;
}

function literalValue(text: string): boolean {
	const value = text.trim().replace(/,+$/, "").trim();
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return true;
	return /^[+-]?(?:(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|inf|infinity|nan)$/i.test(value);
}

function stripUniformBarePrefixes(rows: PayloadRow[]): void {
	let saw = false;
	let allLiteral = true;
	for (const row of rows) {
		if (!row.bare || row.text.trim() === "") continue;
		saw = true;
		const stripped = stripOneLeadingHashlinePrefix(row.text);
		if (stripped === row.text) return;
		allLiteral = allLiteral && literalValue(stripped);
	}
	if (!saw || allLiteral) return;
	for (const row of rows) {
		if (row.bare && row.text.trim() !== "") row.text = stripOneLeadingHashlinePrefix(row.text);
	}
}

export function hasClipboardEdit(edits: readonly Edit[]): boolean {
	return edits.some((e) => e.kind === "cut" || e.kind === "paste" || (e.kind === "block" && (e.mode === "cut" || e.mode === "paste_after" || e.register !== undefined)));
}

export function hasBlockEdit(edits: readonly Edit[]): boolean {
	return edits.some((e) => e.kind === "block");
}

export function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
	return edits.some((e) => {
		if (e.kind === "delete" || e.kind === "cut" || e.kind === "block") return true;
		if (e.kind === "paste") return e.at.kind === "span" || e.at.cursor.kind === "before" || e.at.cursor.kind === "after";
		return e.cursor.kind === "before" || e.cursor.kind === "after";
	});
}

export function collectAnchorLines(edits: readonly Edit[]): number[] {
	const lines = new Set<number>();
	const cursor = (c: Cursor) => {
		if (c.kind === "before" || c.kind === "after") lines.add(c.line);
	};
	for (const e of edits) {
		if (e.kind === "delete" || e.kind === "block") lines.add(e.line);
		else if (e.kind === "cut") for (let n = e.range.start; n <= e.range.end; n++) lines.add(n);
		else if (e.kind === "paste") {
			if (e.at.kind === "span") for (let n = e.at.range.start; n <= e.at.range.end; n++) lines.add(n);
			else cursor(e.at.cursor);
		} else cursor(e.cursor);
	}
	return [...lines].sort((a, b) => a - b);
}

class Executor {
	edits: Edit[] = [];
	warnings: string[] = [];
	editIndex = 0;
	pending: Pending | undefined = undefined;
	fileOp: FileOp | undefined = undefined;
	terminated = false;
	skippableComments: [number, string][] = [];
	recoveredSnapshotLines = new Set<number>();

	warnOnce(warning: string): void {
		if (!this.warnings.includes(warning)) this.warnings.push(warning);
	}

	consumeComments(): void {
		const comments = this.skippableComments;
		this.skippableComments = [];
		for (const [lineNum, text] of comments) this.handleRaw(text, lineNum);
	}

	feed(token: Token): void {
		if (this.terminated) return;
		switch (token.kind) {
			case "envelope_begin":
				this.consumeComments();
				return;
			case "envelope_end":
				this.consumeComments();
				this.terminated = true;
				return;
			case "abort":
				this.terminated = true;
				return;
			case "header":
				this.consumeComments();
				this.flushPending();
				return;
			case "blank":
				this.consumeComments();
				this.handleBlank("", token.lineNum);
				return;
			case "payload":
				this.consumeComments();
				this.handleLiteral(token.text, token.lineNum);
				return;
			case "raw":
				if (!this.pending && token.text.trimStart().startsWith("#")) {
					this.skippableComments.push([token.lineNum, token.text]);
					return;
				}
				this.consumeComments();
				this.handleRaw(token.text, token.lineNum);
				return;
			case "op": {
				this.skippableComments = [];
				const { target, hadColon, lineNum } = token;
				if (target.kind === "replace") validateRange(target.range, lineNum, "replace", target.register);
				if (target.kind === "cut") validateRange(target.range, lineNum, "cut", target.register);
				if (hadColon && (target.kind === "cut" || target.kind === "cut_block")) this.warnOnce(M.CUT_COLON_IGNORED_WARNING);
				if (hadColon && targetRegister(target) !== undefined) failAt(lineNum, M.COLON_ON_REGISTER_PUT);
				this.flushPending();
				if (target.kind === "rem") this.setFileOp({ kind: "rem" }, lineNum);
				else if (target.kind === "move") this.setFileOp({ kind: "move", dest: target.dest }, lineNum);
				else this.pending = { target, lineNum, payloads: [], hadColon, deferredBlanks: [] };
				return;
			}
		}
	}

	finish(): Parsed {
		this.consumeComments();
		this.flushPending();
		if (this.fileOp?.kind === "rem" && this.edits.length > 0) fail("`REM` deletes the whole file and cannot be combined with line ops.");
		this.normalizeOverlaps();
		return { edits: this.edits, fileOp: this.fileOp, warnings: this.warnings };
	}

	setFileOp(op: FileOp, lineNum: number): void {
		if (this.fileOp) failAt(lineNum, "only one file-level op (`REM` or `MV`) per section. Merge them under one header.");
		if (op.kind === "rem" && this.edits.length > 0) failAt(lineNum, M.REM_TAKES_NO_BODY);
		this.fileOp = op;
	}

	handleLiteral(text: string, lineNum: number): void {
		const pending = this.pending;
		if (!pending) {
			if (this.fileOp) failAt(lineNum, M.MOVE_TAKES_NO_BODY);
			failAt(lineNum, `payload line has no preceding hunk header. Got ${M.jsonQuote(`+${text}`)}.`);
		}
		const bodyless = bodylessMessage(pending.target, pending.hadColon);
		if (bodyless) failAt(lineNum, bodyless);
		pending.payloads.push(...pending.deferredBlanks);
		pending.deferredBlanks = [];
		if (isHunkHeaderText(text)) this.warnings.push(M.literalOpRowWarning(lineNum, text));
		pending.payloads.push({ text, lineNum, bare: false, minus: false });
	}

	handleRaw(text: string, lineNum: number): void {
		if (!this.pending && isReadMetadataLine(text)) {
			this.warnOnce(M.READ_METADATA_IGNORED_WARNING);
			return;
		}
		const contamination = contaminationMessage(text);
		if (contamination) failAt(lineNum, contamination);
		if (this.fileOp) failAt(lineNum, M.MOVE_TAKES_NO_BODY);
		const pending = this.pending;
		if (pending) {
			if (text.trim() === "") {
				this.handleBlank(text, lineNum);
				return;
			}
			const bodyless = bodylessMessage(pending.target, pending.hadColon);
			if (bodyless) failAt(lineNum, bodyless);
			const minus = text.trimStart().startsWith("-");
			if (!minus) this.warnOnce(M.BARE_BODY_AUTO_PIPED_WARNING);
			pending.payloads.push(...pending.deferredBlanks);
			pending.deferredBlanks = [];
			pending.payloads.push({ text, lineNum, bare: true, minus });
			return;
		}
		if (text.trim() === "") return;
		const range = parseBareRange(text);
		if (range) {
			validateRange(range, lineNum, "replace", undefined);
			this.pending = { target: { kind: "replace", range, register: undefined }, lineNum, payloads: [], hadColon: true, deferredBlanks: [] };
			this.warnOnce(M.BARE_RANGE_AUTO_PUT_WARNING);
			return;
		}
		const snapshot = parseSnapshotRow(text);
		if (snapshot) {
			const [line, value] = snapshot;
			if (this.recoveredSnapshotLines.has(line)) failAt(lineNum, M.repeatedSnapshotRowMessage(line));
			this.recoveredSnapshotLines.add(line);
			this.pushInsert({ kind: "before", line }, value, lineNum, true);
			this.pushDeleteRange({ start: line, end: line }, lineNum);
			this.warnOnce(M.SNAPSHOT_ROWS_AUTO_PUT_WARNING);
			return;
		}
		failAt(lineNum, `payload line has no preceding hunk header. Use \`PUT N.=M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` above the body. Got ${M.jsonQuote(text)}.`);
	}

	handleBlank(text: string, lineNum: number): void {
		const pending = this.pending;
		if (!pending) return;
		if (bodylessMessage(pending.target, pending.hadColon) !== undefined || pending.payloads.length === 0) return;
		pending.deferredBlanks.push({ text, lineNum, bare: true, minus: false });
	}

	flushPending(): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		const rows = this.resolveMinusRows(pending.payloads);
		stripUniformBarePrefixes(rows);
		const line = pending.lineNum;
		const texts = rows.map((row) => row.text);
		const target = pending.target;
		switch (target.kind) {
			case "rem":
			case "move":
				return;
			case "cut":
				this.pushCut(target.range, target.register, line);
				return;
			case "cut_block":
				this.pushBlock(target.line, [], "cut", target.register, line);
				return;
			case "replace":
				if (target.register !== undefined) this.pushPaste({ kind: "span", range: target.range }, target.register, line);
				else if (rows.length === 0) {
					if (!pending.hadColon) failAt(line, M.COLONLESS_SPAN_PUT);
					this.pushDeleteRange(target.range, line);
					this.warnOnce(M.EMPTY_PUT_AUTO_CUT_WARNING);
				} else {
					for (const text of texts) this.pushInsert({ kind: "before", line: target.range.start }, text, line, true);
					this.pushDeleteRange(target.range, line);
				}
				return;
			case "block":
				if (target.register !== undefined) this.pushBlock(target.line, [], undefined, target.register, line);
				else if (rows.length === 0) {
					if (!pending.hadColon) failAt(line, M.COLONLESS_SPAN_PUT);
					this.pushBlock(target.line, [], undefined, undefined, line);
					this.warnOnce(M.EMPTY_PUT_AUTO_CUT_WARNING);
				} else this.pushBlock(target.line, texts, undefined, undefined, line);
				return;
			case "insert_after_block":
				if (target.register !== undefined || (!pending.hadColon && rows.length === 0)) this.pushBlock(target.line, [], "paste_after", target.register, line);
				else if (rows.length === 0) failAt(line, M.EMPTY_INSERT);
				else this.pushBlock(target.line, texts, "insert_after", undefined, line);
				return;
			default: {
				const cursor: Cursor =
					target.kind === "insert_before" ? { kind: "before", line: target.line } : target.kind === "insert_after" ? { kind: "after", line: target.line } : { kind: target.kind };
				if (target.register !== undefined || (!pending.hadColon && rows.length === 0)) this.pushPaste({ kind: "gap", cursor }, target.register, line);
				else if (rows.length === 0) failAt(line, M.EMPTY_INSERT);
				else for (const text of texts) this.pushInsert(cursor, text, line, false);
			}
		}
	}

	resolveMinusRows(rows: PayloadRow[]): PayloadRow[] {
		const minus = rows.filter((row) => row.minus);
		if (minus.length === 0) return rows;
		const allBullets = minus.every((row) => markdownBullet(row.text));
		const explicit = rows.filter((row) => !row.bare);
		if (allBullets && (explicit.length === 0 || explicit.some((row) => markdownBullet(row.text)))) {
			this.warnOnce(M.MINUS_BULLET_AUTO_PIPED_WARNING);
			return rows;
		}
		if (explicit.length > 0 && !allBullets) {
			this.warnOnce(M.DIFF_OLD_ROWS_IGNORED_WARNING);
			return rows.filter((row) => !row.minus);
		}
		failAt(minus[0].lineNum, M.MINUS_ROW_REJECTED);
	}

	nextIndex(): number {
		return this.editIndex++;
	}
	pushInsert(cursor: Cursor, text: string, lineNum: number, replacement: boolean): void {
		this.edits.push({ kind: "insert", cursor, text, lineNum, index: this.nextIndex(), replacement });
	}
	pushDeleteRange(range: ParsedRange, lineNum: number): void {
		for (let line = range.start; line <= range.end; line++) this.edits.push({ kind: "delete", line, lineNum, index: this.nextIndex() });
	}
	pushCut(range: ParsedRange, register: string | undefined, lineNum: number): void {
		this.edits.push({ kind: "cut", range, register, lineNum, index: this.nextIndex() });
		this.pushDeleteRange(range, lineNum);
	}
	pushPaste(at: PasteTarget, register: string | undefined, lineNum: number): void {
		this.edits.push({ kind: "paste", at, register, lineNum, index: this.nextIndex() });
	}
	pushBlock(line: number, payloads: string[], mode: BlockMode | undefined, register: string | undefined, lineNum: number): void {
		this.edits.push({ kind: "block", line, payloads, mode, register, lineNum, index: this.nextIndex() });
	}

	normalizeOverlaps(): void {
		const hunks = new Map<number, { lines: Set<number>; clipboard: boolean }>();
		const hunk = (lineNum: number) => {
			let h = hunks.get(lineNum);
			if (!h) {
				h = { lines: new Set(), clipboard: false };
				hunks.set(lineNum, h);
			}
			return h;
		};
		for (const edit of this.edits) {
			if (edit.kind === "cut") hunk(edit.lineNum).clipboard = true;
			else if (edit.kind === "paste" && edit.at.kind === "span") {
				const h = hunk(edit.lineNum);
				h.clipboard = true;
				for (let n = edit.at.range.start; n <= edit.at.range.end; n++) h.lines.add(n);
			} else if (edit.kind === "delete") hunk(edit.lineNum).lines.add(edit.line);
		}
		const owner = new Map<number, number>();
		const dropped = new Set<number>();
		const sameLines = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((n) => b.has(n));
		for (const lineNum of [...hunks.keys()].sort((a, b) => a - b)) {
			const h = hunks.get(lineNum) as { lines: Set<number>; clipboard: boolean };
			if (h.lines.size === 0) continue;
			const sorted = [...h.lines].sort((a, b) => a - b);
			const overlaps = new Set<number>();
			for (const n of sorted) {
				const o = owner.get(n);
				if (o !== undefined) overlaps.add(o);
			}
			if (overlaps.size === 0) {
				for (const n of sorted) owner.set(n, lineNum);
				continue;
			}
			const previous = overlaps.size === 1 ? [...overlaps][0] : undefined;
			const old = previous === undefined ? undefined : hunks.get(previous);
			if (previous !== undefined && old && !old.clipboard && sameLines(old.lines, h.lines)) {
				dropped.add(previous);
				for (const [n, o] of [...owner]) if (o === previous) owner.delete(n);
				for (const n of sorted) owner.set(n, lineNum);
				this.warnOnce(M.REPLACE_PAIR_COALESCED_WARNING);
				continue;
			}
			const first = sorted.find((n) => owner.has(n)) ?? 0;
			const prior = previous === undefined ? "an earlier line" : String(previous);
			failAt(
				lineNum,
				`anchor line ${first} is already targeted by another hunk on line ${prior}. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`,
			);
		}
		if (dropped.size > 0) this.edits = this.edits.filter((edit) => !dropped.has(edit.lineNum));
	}
}

export function parsePatch(diff: string): Parsed {
	const executor = new Executor();
	for (const token of tokenizeAll(diff)) executor.feed(token);
	return executor.finish();
}

import { ambiguousAnonymousPasteMessage, EMPTY_PASTE, emptyRegisterPasteWarning, emptyRegisterSpanPasteMessage } from "./messages.ts";
import { hasClipboardEdit } from "./parser.ts";
import { type Clipboard, type CutEdit, type Edit, forkClipboard, HashlineError } from "./types.ts";

export type EmptyPaste = "throw" | "drop";

function describeCut(edit: CutEdit): string {
	const span = edit.range.start === edit.range.end ? String(edit.range.start) : `${edit.range.start}.=${edit.range.end}`;
	return edit.register === undefined ? `CUT ${span}` : `CUT ${span} @${edit.register}`;
}

function knownRegisters(clipboard: Clipboard): string[] {
	return clipboard.named ? [...clipboard.named.keys()].sort() : [];
}

function readRegister(
	register: string | undefined,
	span: boolean,
	clipboard: Clipboard,
	lineNum: number,
	onEmptyPaste: EmptyPaste,
	onWarning: (warning: string) => void,
): string[] | undefined {
	if (register !== undefined) {
		const lines = clipboard.named?.get(register);
		if (lines) return [...lines];
		if (onEmptyPaste === "drop") return undefined;
		const known = knownRegisters(clipboard);
		if (span) throw new HashlineError("apply", `line ${lineNum}: ${emptyRegisterSpanPasteMessage(register, known)}`);
		onWarning(`line ${lineNum}: ${emptyRegisterPasteWarning(register, known)}`);
		return [];
	}
	const pending = clipboard.pendingAnonCuts ?? [];
	if (pending.length > 1) {
		if (onEmptyPaste === "drop") return undefined;
		throw new HashlineError("apply", `line ${lineNum}: ${ambiguousAnonymousPasteMessage(pending)}`);
	}
	if (clipboard.lines === undefined) {
		if (onEmptyPaste === "drop") return undefined;
		throw new HashlineError("apply", `line ${lineNum}: ${EMPTY_PASTE}`);
	}
	clipboard.pendingAnonCuts = [];
	return [...clipboard.lines];
}

function writeRegister(edit: CutEdit, fileLines: readonly string[], clipboard: Clipboard): void {
	const { range } = edit;
	if (range.start === 0 || range.end > fileLines.length) {
		throw new HashlineError("out_of_range", `line ${edit.lineNum}: \`${describeCut(edit)}\` is out of range (file has ${fileLines.length} lines).`);
	}
	const captured = fileLines.slice(range.start - 1, range.end);
	if (edit.register !== undefined) {
		if (!clipboard.named) clipboard.named = new Map();
		clipboard.named.set(edit.register, captured);
	} else {
		clipboard.lines = captured;
		if (!clipboard.pendingAnonCuts) clipboard.pendingAnonCuts = [];
		clipboard.pendingAnonCuts.push(describeCut(edit));
	}
}

export function resolveClipboardEdits(
	edits: readonly Edit[],
	fileLines: readonly string[],
	clipboard: Clipboard,
	onEmptyPaste: EmptyPaste,
	onWarning: (warning: string) => void,
): Edit[] {
	if (!hasClipboardEdit(edits)) return [...edits];
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.kind === "cut") {
			writeRegister(edit, fileLines, clipboard);
			continue;
		}
		if (edit.kind !== "paste") {
			resolved.push(edit);
			continue;
		}
		const lines = readRegister(edit.register, edit.at.kind === "span", clipboard, edit.lineNum, onEmptyPaste, onWarning);
		if (lines === undefined) continue;
		if (edit.at.kind === "gap") {
			for (const text of lines) resolved.push({ kind: "insert", cursor: edit.at.cursor, text, lineNum: edit.lineNum, index: synthIndex++, replacement: false });
			continue;
		}
		const range = edit.at.range;
		if (range.start === 0 || range.end > fileLines.length) {
			const register = edit.register === undefined ? "" : ` @${edit.register}`;
			throw new HashlineError("out_of_range", `line ${edit.lineNum}: \`PUT ${range.start}.=${range.end}${register}\` is out of range (file has ${fileLines.length} lines).`);
		}
		for (const text of lines) {
			resolved.push({ kind: "insert", cursor: { kind: "before", line: range.start }, text, lineNum: edit.lineNum, index: synthIndex++, replacement: true });
		}
		for (let line = range.start; line <= range.end; line++) resolved.push({ kind: "delete", line, lineNum: edit.lineNum, index: synthIndex++ });
	}
	return resolved;
}

export function validateClipboardSequence(edits: readonly Edit[], clipboard: Clipboard): void {
	const fork = forkClipboard(clipboard);
	for (const edit of edits) {
		if (edit.kind === "cut") {
			if (edit.register !== undefined) {
				if (!fork.named) fork.named = new Map();
				fork.named.set(edit.register, []);
			} else {
				fork.lines = [];
				if (!fork.pendingAnonCuts) fork.pendingAnonCuts = [];
				fork.pendingAnonCuts.push(describeCut(edit));
			}
		} else if (edit.kind === "paste") {
			readRegister(edit.register, edit.at.kind === "span", fork, edit.lineNum, "throw", () => {});
		}
	}
}

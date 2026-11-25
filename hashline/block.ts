import {
	blockUnresolvedMessage,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
	pasteAfterBlockCloserLoweredWarning,
	pasteAfterBlockUnresolvedLoweredWarning,
} from "./messages.ts";
import { hasBlockEdit } from "./parser.ts";
import { type Edit, HashlineError } from "./types.ts";

export const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/;

export function resolveBlockEdits(edits: readonly Edit[], text: string, onWarning: (warning: string) => void): Edit[] {
	if (!hasBlockEdit(edits)) return [...edits];
	const lines = text.split("\n");
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.kind !== "block") {
			resolved.push(edit);
			continue;
		}
		const anchorText = lines[edit.line - 1];
		const isCloser = anchorText !== undefined && STRUCTURAL_CLOSER_RE.test(anchorText);
		if (edit.mode === "paste_after") {
			onWarning(isCloser ? pasteAfterBlockCloserLoweredWarning(edit.line) : pasteAfterBlockUnresolvedLoweredWarning(edit.line));
			resolved.push({ kind: "paste", at: { kind: "gap", cursor: { kind: "after", line: edit.line } }, register: edit.register, lineNum: edit.lineNum, index: synthIndex++ });
			continue;
		}
		if (edit.mode === "insert_after") {
			onWarning(isCloser ? insertAfterBlockCloserLoweredWarning(edit.line) : insertAfterBlockUnresolvedLoweredWarning(edit.line));
			for (const payload of edit.payloads) {
				resolved.push({ kind: "insert", cursor: { kind: "after", line: edit.line }, text: payload, lineNum: edit.lineNum, index: synthIndex++, replacement: false });
			}
			continue;
		}
		throw new HashlineError("apply", `line ${edit.lineNum}: ${blockUnresolvedMessage(edit.line, edit.mode === "cut" ? "cut" : "replace", lines, edit.register)}`);
	}
	return resolved;
}

/**
 * hashline/block.ts: what happens to block locators (`PUT N*:`, `CUT N*`, `PUT >N*:`, `PUT N* @r`).
 *
 * Upstream (oh-my-pi `crates/pi-edit/src/modes/hashline/block.rs`, MIT) resolves `N*` with a
 * tree-sitter parse of the file. Vanilla pi ships no parser, so this port behaves as upstream does
 * for a file whose language it does not know: replace / cut forms are rejected with upstream's
 * "could not resolve a syntactic block" message, insert / paste-after forms are applied as the
 * plain `PUT >N` with upstream's warning.
 */
import {
	blockUnresolvedMessage,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
	pasteAfterBlockCloserLoweredWarning,
	pasteAfterBlockUnresolvedLoweredWarning,
} from "./messages.ts";
import { hasBlockEdit } from "./parser.ts";
import { type Edit, HashlineError } from "./types.ts";

/** A line holding only closing delimiters and an optional `;` or `,`. */
export const STRUCTURAL_CLOSER_RE = /^\s*[)\]}]+[;,]?\s*$/;

/** Lower block edits to ordinary edits, or throw HashlineError("apply") for replace / cut forms. */
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

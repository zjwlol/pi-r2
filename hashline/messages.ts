/**
 * hashline/messages.ts: every error / warning text the model sees from the hashline parser, applier and patcher.
 * Port of oh-my-pi `crates/pi-edit/src/modes/hashline/messages.rs`, `mismatch.rs` and the
 * diagnostics of `patcher.rs` (MIT). The strings are upstream's, byte for byte.
 */
import { formatNumberedLine } from "./format.ts";

/** `JSON.stringify(s)` for a string. */
export function jsonQuote(s: string): string {
	return JSON.stringify(s);
}

/** Lines of context shown either side of an anchor in a mismatch reply. */
export const MISMATCH_CONTEXT = 2;

/** Sorted line numbers shown for `anchorLines`: each in-range anchor ± MISMATCH_CONTEXT. */
export function anchoredContextLines(anchorLines: readonly number[], lineCount: number): number[] {
	const display = new Set<number>();
	for (const line of anchorLines) {
		if (line < 1 || line > lineCount) continue;
		const lo = Math.max(1, line - MISMATCH_CONTEXT);
		const hi = Math.min(lineCount, line + MISMATCH_CONTEXT);
		for (let n = lo; n <= hi; n++) display.add(n);
	}
	return [...display].sort((a, b) => a - b);
}

/** Numbered rows around the anchors: `*` marks an anchor, `...` separates non-adjacent runs. */
export function formatAnchoredContext(anchorLines: readonly number[], fileLines: readonly string[]): string[] {
	const display = anchoredContextLines(anchorLines, fileLines.length);
	const anchors = new Set(anchorLines);
	const rows: string[] = [];
	let previous: number | undefined;
	for (const lineNum of display) {
		if (previous !== undefined && lineNum > previous + 1) rows.push("...");
		previous = lineNum;
		rows.push(`${anchors.has(lineNum) ? "*" : " "}${formatNumberedLine(lineNum, fileLines[lineNum - 1] ?? "")}`);
	}
	return rows;
}

export type AbsoluteRangeOp = "replace" | "cut";

function regSuffix(register: string | undefined): string {
	return register === undefined ? "" : ` @${register}`;
}

function rangeOpSingle(op: AbsoluteRangeOp, line: number, register: string | undefined): string {
	if (op === "cut") return `CUT ${line}${regSuffix(register)}`;
	return register !== undefined ? `PUT ${line}${regSuffix(register)}` : `PUT ${line}:`;
}

function rangeOpRange(op: AbsoluteRangeOp, start: number, end: number, register: string | undefined): string {
	if (op === "cut") return `CUT ${start}.=${end}${regSuffix(register)}`;
	return register !== undefined ? `PUT ${start}.=${end}${regSuffix(register)}` : `PUT ${start}.=${end}:`;
}

function blockFormAt(op: AbsoluteRangeOp, line: number, register: string | undefined): string {
	if (op === "cut") return `CUT ${line}*${regSuffix(register)}`;
	return register !== undefined ? `PUT ${line}*${regSuffix(register)}` : `PUT ${line}*:`;
}

/** `PUT 9.=3:`: the end precedes the start. */
export function invalidAbsoluteRangeMessage(patchLine: number, start: number, end: number, op: AbsoluteRangeOp, register: string | undefined): string {
	const single = rangeOpSingle(op, start, register);
	const countedEnd = start + end - 1;
	let message = `line ${patchLine}: Invalid absolute range: start ${start}, end ${end}. The value after \`.=\` is an absolute source line, not a line count or replacement length. For one line use \`${single}\`.`;
	if (countedEnd >= start) message += ` For ${end} lines starting at ${start}, use \`${rangeOpRange(op, start, countedEnd, register)}\`.`;
	return message;
}

export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const ABORT_MARKER = "*** Abort";

export const REPLACE_PAIR_COALESCED_WARNING = "Multiple hunks targeted the same exact range; kept only the last. Issue one `PUT` or `CUT` hunk per range.";
export const REPLACEMENT_INDENT_AUTO_SHIFT_WARNING = "Auto-indented a replacement body to match unchanged structural rows in its source range.";
export const BARE_BODY_AUTO_PIPED_WARNING = "Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";
export const SNAPSHOT_ROWS_AUTO_PUT_WARNING = "Recovered top-level `N:TEXT` snapshot row(s) as single-line `PUT N.=N:` replacements. Use explicit `PUT` headers for reliable edits.";

export function repeatedSnapshotRowMessage(line: number): string {
	return `two or more pasted \`${line}:TEXT\` read-output rows name line ${line}. Such rows are recovered as single-line \`PUT ${line}.=${line}:\` replacements, so repeating a number would keep only the last row and drop the rest. Write the hunk explicitly: one \`PUT ${line}.=M:\` header covering exactly the lines that change, followed by \`+TEXT\` body rows holding their complete final content.`;
}

export function literalOpRowWarning(line: number, text: string): string {
	return `line ${line}: body row \`+${text}\` is itself a valid hunk header, so it was inserted into the file as literal text rather than executed. Ops are never \`+\`-prefixed — drop the \`+\` to run it, and re-issue if this line landed in the file by mistake.`;
}

export const BARE_RANGE_AUTO_PUT_WARNING = "Recovered a bare `N.=M:` header as `PUT N.=M:`. Prefix replacement ranges with `PUT`.";
export const READ_METADATA_IGNORED_WARNING = "Ignored copied read-output elision row(s). Re-read elided ranges before editing them.";
export const EMPTY_PUT_AUTO_CUT_WARNING = "Interpreted an empty `PUT` body as deletion. Use `CUT N.=M` or `CUT N*` for bodyless deletes.";
export const CUT_COLON_IGNORED_WARNING = "Ignored a trailing `:` on bodyless `CUT`. Prefer `CUT N.=M` / `CUT N*` without a colon.";
export const MINUS_BULLET_AUTO_PIPED_WARNING =
	"Auto-prefixed bare `- ` bullet row(s) as literal content. `-` rows never remove lines — the range does that; always prefix literal body rows with `+`: `+- item`.";
export const DIFF_OLD_ROWS_IGNORED_WARNING = "Ignored unified-diff `-old` row(s); the range already removes old content, so only `+new` rows were kept.";
export const MINUS_ROW_REJECTED =
	"`-` rows are not valid; the range already names the lines being changed. For Markdown bullets or other literal `-` lines, prefix the literal row with `+`: `+- item`.";

/** `PUT N*:` / `CUT N*` cannot be resolved (this port has no syntax parser, so always). */
export function blockUnresolvedMessage(line: number, op: AbsoluteRangeOp, fileLines: readonly string[] | undefined, register: string | undefined): string {
	const phrase = blockFormAt(op, line, register);
	const fallback =
		op === "replace" ? (register !== undefined ? `PUT ${line}.=M @${register}` : `PUT ${line}.=M:`) : register !== undefined ? `CUT ${line}.=M @${register}` : `CUT ${line}.=M`;
	let message = `\`${phrase}\` could not resolve a syntactic block beginning on line ${line} (unsupported language, blank/closer line, or parse error). Use \`${fallback}\` with explicit lines.`;
	if (fileLines) {
		const context = formatAnchoredContext([line], fileLines);
		if (context.length > 0) message += `\n\n${context.join("\n")}`;
	}
	return message;
}

function closerLoweredWarning(blockForm: string, plainForm: string): string {
	return `\`${blockForm}\` anchors on a closing delimiter, so it was applied as plain \`${plainForm}\`. Anchor on the line that OPENS the construct.`;
}
function unresolvedLoweredWarning(blockForm: string, line: number, plainForm: string): string {
	return `\`${blockForm}\` could not resolve a syntactic block on line ${line}, so it was applied as plain \`${plainForm}\`. Verify the landing line; anchor on a line that OPENS a construct.`;
}
export function insertAfterBlockCloserLoweredWarning(line: number): string {
	return closerLoweredWarning(`PUT >${line}*:`, `PUT >${line}:`);
}
export function insertAfterBlockUnresolvedLoweredWarning(line: number): string {
	return unresolvedLoweredWarning(`PUT >${line}*:`, line, `PUT >${line}:`);
}
export function pasteAfterBlockCloserLoweredWarning(line: number): string {
	return closerLoweredWarning(`PUT >${line}*`, `PUT >${line}`);
}
export function pasteAfterBlockUnresolvedLoweredWarning(line: number): string {
	return unresolvedLoweredWarning(`PUT >${line}*`, line, `PUT >${line}`);
}

export type BoundarySide = "leading" | "trailing";

function lineSpan(first: number, last: number): string {
	return first === last ? `line ${first}` : `lines ${first}-${last}`;
}

const REISSUE = "Re-issue with the range covering exactly the lines that change and the body as their complete final content.";

export function ambiguousBoundaryEchoMessage(startLine: number, endLine: number, side: BoundarySide, count: number, leftOut: readonly [number, number]): string {
	const where = side === "leading" ? `opens by restating the ${count} line(s) just above the range` : `ends by restating the ${count} line(s) just below the range`;
	return `\`PUT ${startLine}.=${endLine}:\` rejected: the body ${where}, but is too short to be the full final content of the selected range. If the range is off by those line(s), the body leaves out ${lineSpan(leftOut[0], leftOut[1])}, which this edit would delete. ${REISSUE}`;
}

export function repeatedBoundaryEchoMessage(startLine: number, endLine: number, side: BoundarySide, count: number, leftOut: readonly [number, number]): string {
	const where =
		side === "leading" ? `opens by restating the ${count} line(s) just above the range more than once` : `ends by restating the ${count} line(s) just below the range more than once`;
	return `\`PUT ${startLine}.=${endLine}:\` rejected: the body ${where}. With the rows that restate lines just outside the range read as those lines, the body is too short to be the full final content of the selected range: it leaves out ${lineSpan(leftOut[0], leftOut[1])}, which this edit would delete. ${REISSUE}`;
}

export function twoSidedBoundaryEchoMessage(startLine: number, endLine: number, above: number, below: number, repeated: boolean, leftOut: readonly [number, number]): string {
	return `\`PUT ${startLine}.=${endLine}:\` rejected: the body restates both the ${above} line(s) just above and the ${below} line(s) just below the range${repeated ? " more than once" : ""}, and once the rows that restate lines outside the range are set aside, the rows left are too few to be the full final content of the selected range: they leave out ${lineSpan(leftOut[0], leftOut[1])}, which this edit would delete. ${REISSUE}`;
}

/** How a result would repeat a neighbouring line: a span written a second time, or extra copies of one line. */
export type Restated = { kind: "span"; first: number; last: number } | { kind: "copies"; line: number; extra: number };

export function boundaryEchoOutcomeMessage(
	startLine: number,
	endLine: number,
	above: Restated | undefined,
	below: Restated | undefined,
	leftOut: readonly [number, number] | undefined,
): string {
	const restated = (r: Restated, place: string): string => {
		if (r.kind === "span") return `write ${lineSpan(r.first, r.last)} (${place} the range) a second time`;
		if (r.extra === 1) return `hold one more copy of line ${r.line} (${place} the range) than the range did`;
		return `hold ${r.extra} more copies of line ${r.line} (${place} the range) than the range did`;
	};
	const effects: string[] = [];
	if (above) effects.push(restated(above, "just above"));
	if (below) effects.push(restated(below, "just below"));
	if (leftOut) effects.push(`leave out ${lineSpan(leftOut[0], leftOut[1])} of the range, deleting it`);
	return `\`PUT ${startLine}.=${endLine}:\` rejected: the body restates lines next to the range, and as applied the result would ${effects.join(" and ")}. ${REISSUE}`;
}

export function textualBoundaryEchoWarning(startLine: number, leading: number, trailing: number): string {
	const parts: string[] = [];
	if (leading > 0) parts.push(`${leading} leading`);
	if (trailing > 0) parts.push(`${trailing} trailing`);
	return `Auto-repaired a replacement boundary echo at line ${startLine}: dropped ${parts.join(" and ")} body line(s) already present outside the range. Issue the body as final content for the selected range only.`;
}

export const UNRESOLVED_BLOCK_INTERNAL = "internal error: unresolved block edit reached the applier (resolveBlockEdits was not run).";
export const UNRESOLVED_CLIPBOARD_INTERNAL = "internal error: unresolved clipboard edit reached the applier (resolveClipboardEdits was not run).";
export const REM_TAKES_NO_BODY = "`REM` deletes the whole file and takes no body rows or line ops. Issue it alone under the header.";
export const MOVE_TAKES_NO_BODY = "`MV DEST` does not take body rows. Put line edits above the `MV` row; the destination path follows `MV` on the same line.";
export const CUT_TAKES_NO_BODY = "`CUT` deletes (and captures) the named lines and takes no body rows. To write new content, use `PUT N.=M:` with `+TEXT` rows.";
export const COLON_ON_REGISTER_PUT =
	"`PUT … @name` pastes the register and never takes `:` — the colon promises body rows. Drop the colon (`PUT >40 @name`), or drop `@name` and write `+TEXT` body rows.";
export const REGISTER_PUT_TAKES_NO_BODY = "A register `PUT` pastes captured lines and takes no `+` body rows. To write literal text, drop the `@name` and use `PUT …:` with body rows.";
export const COLONLESS_PUT_TAKES_NO_BODY =
	"`PUT` without `:` is clipboard-backed and takes no body rows. Add `:` after the locator to write literal content (`PUT >40:` then `+TEXT` rows).";
export const COLONLESS_SPAN_PUT =
	"Colonless `PUT` is clipboard-backed, and span targets need a named register (`PUT 5.=9 @name`); the anonymous register pastes only at gaps (`PUT >40`). To write literal content, add `:` and `+TEXT` body rows.";
export const EMPTY_PASTE =
	"Nothing to paste: no unlabeled `CUT` precedes this `PUT` in this call, and the anonymous register never carries across calls. Put `CUT N.=M` / `CUT N*` above it, or use named registers (`CUT … @name` → `PUT … @name`) for cross-call moves.";

function availableRegisters(known: readonly string[]): string {
	return known.length === 0 ? "" : ` Available registers: ${known.map((k) => `\`@${k}\``).join(", ")}.`;
}

export function emptyRegisterPasteWarning(name: string, known: readonly string[]): string {
	return `\`@${name}\` was empty — no \`CUT … @${name}\` precedes this op in this call and no persisted register has that name — so nothing was pasted.${availableRegisters(known)}`;
}

export function emptyRegisterSpanPasteMessage(name: string, known: readonly string[]): string {
	return `\`@${name}\` is empty — no \`CUT … @${name}\` precedes this op in this call and no persisted register has that name — so pasting it over a range would delete those lines and write nothing back. Capture the register first (\`CUT … @${name}\`), or use \`CUT\` if deleting the range is what you meant.${availableRegisters(known)}`;
}

export function ambiguousAnonymousPasteMessage(pending: readonly string[]): string {
	return `${pending.length} unlabeled \`CUT\`s are pending (${pending.join(", ")}) — an unlabeled paste cannot tell which one you meant. Label the moves (\`CUT … @name\` → \`PUT … @name\`), or keep at most one unlabeled \`CUT\` before each unlabeled paste.`;
}

export const CLIPBOARD_INTERLEAVED_SECTIONS =
	"`CUT`/register-`PUT` ops cannot be used in a file whose sections are interleaved with another file's: same-path sections merge into the first occurrence, which would reorder the register sequence. Keep each file's ops under ONE `[path#TAG]` header.";
export const EMPTY_INSERT =
	"`PUT <N:` / `PUT >N:` promises body rows and got none. Write `+TEXT` rows, or drop the `:` to paste a register (`PUT >N` = anonymous, `PUT >N @name` = named).";

export function afterInsertLandingShiftWarning(anchorLine: number, landingLine: number, crossed: number): string {
	return `PUT >${anchorLine}: body indented shallower than the anchor, so the landing moved past ${crossed} closing line${crossed === 1 ? "" : "s"} to after line ${landingLine}. For the deeper position inside the block, re-issue with the body indented to match.`;
}

export const RECOVERY_EXTERNAL_WARNING = "Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";
export const RECOVERY_SESSION_CHAIN_WARNING = "Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).";
export const RECOVERY_LINE_REMAP_WARNING =
	"Recovered by remapping stale line anchors to unchanged current lines (file changed since the tagged read). Verify the diff matches your intent.";
export const HEADTAIL_DRIFT_WARNING =
	"Applied the `PUT <1:`/`PUT >$:` edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected.";

export function pathRecoveredFromTagMessage(authoredPath: string, resolvedPath: string, tag: string): string {
	return `Path "${authoredPath}" does not exist; matched its filename and snapshot tag #${tag} to ${resolvedPath} (read earlier this session). Anchor future edits on [${resolvedPath}#TAG].`;
}

// ── patcher.rs diagnostics ──────────────────────────────────────────────

export function noChangeDiagnostic(path: string): string {
	return `Edits to ${path} parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.`;
}

export function noChangeLoopDiagnostic(path: string, count: number): string {
	return `STOP. Edits to ${path} have been a byte-identical no-op ${count} times in a row — the patch body matches the file at the targeted lines and the soft hint did not break the cycle. Cease re-issuing this payload. Either the intended change is already on disk (move on), or your anchor is wrong (re-read the file with \`read\` to observe the current line numbers and tag, then author a different edit). This exact payload will keep being rejected until it changes.`;
}

// ── mismatch.rs ─────────────────────────────────────────────────────────

export interface MismatchDetails {
	path: string | undefined;
	/** The tag the section carried; "" when it carried none. */
	expectedFileHash: string;
	actualFileHash: string;
	fileLines: readonly string[];
	anchorLines: readonly number[];
	/** The store holds a version of this path with `expectedFileHash`. */
	hashRecognized: boolean;
	/** Other paths the store issued `expectedFileHash` for. */
	tagOriginPaths: readonly string[];
}

/** Failure class of a mismatch (upstream `mismatch_error`). */
export function mismatchKind(details: MismatchDetails): string {
	if (details.hashRecognized) return "stale_tag";
	if (details.expectedFileHash === "") return "missing_tag";
	return details.tagOriginPaths.length === 0 ? "unknown_tag" : "other_file_tag";
}

export function formatMismatchMessage(details: MismatchDetails): string {
	const path = details.path === undefined ? "" : ` for ${details.path}`;
	const context = formatAnchoredContext(details.anchorLines, details.fileLines);
	const lines: string[] = [];
	if (details.hashRecognized) {
		lines.push(`Edit rejected${path}: file changed between read and edit.`);
		lines.push(
			`Section is bound to #${details.expectedFileHash}, but the current file hashes to #${details.actualFileHash}. If a prior edit in this session modified this file, copy the [path#newhash] header from that edit's response; otherwise re-read the file with \`read\` to refresh the tag before retrying.`,
		);
	} else {
		lines.push(
			details.expectedFileHash === ""
				? `Edit rejected${path}: the header needs this file's current tag, #${details.actualFileHash}.`
				: `Edit rejected${path}: hash #${details.expectedFileHash} is not from this session.`,
		);
		for (const origin of details.tagOriginPaths) lines.push(`Hash #${details.expectedFileHash} was issued in this session for ${origin}.`);
		const offerResend = context.length > 0 && details.tagOriginPaths.length === 0;
		lines.push(
			offerResend
				? `The current file hashes to #${details.actualFileHash}. If the rows below are the ones you mean, resend the edit under #${details.actualFileHash}; otherwise re-read the file with \`read\` and copy its [path#tag] header verbatim.`
				: `The current file hashes to #${details.actualFileHash}. Re-read the file with \`read\` and copy its [path#tag] header verbatim.`,
		);
	}
	if (context.length > 0) {
		lines.push("");
		lines.push(...context);
	}
	return lines.join("\n");
}

export function formatHeaderOnlyMessage(path: string, actualFileHash: string): string {
	return `Edit rejected for ${path}: no ops follow the header; put them under this file's current tag, #${actualFileHash}.`;
}

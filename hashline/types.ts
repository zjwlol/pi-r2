/**
 * hashline/types.ts: data types shared by the hashline tokenizer, parser, applier and patcher.
 * Port of oh-my-pi `crates/pi-edit/src/modes/hashline/types.rs` (MIT). Pure: no imports.
 */

/** Where an insert lands. `line` is a 1-indexed line of the ORIGINAL file. */
export type Cursor = { kind: "bof" } | { kind: "eof" } | { kind: "before"; line: number } | { kind: "after"; line: number };

/** Inclusive 1-indexed line range. */
export interface ParsedRange {
	start: number;
	end: number;
}

/** Where a paste lands: an insertion gap, or a span it replaces. */
export type PasteTarget = { kind: "gap"; cursor: Cursor } | { kind: "span"; range: ParsedRange };

/** Deferred block-op mode (`undefined` = block replacement). */
export type BlockMode = "insert_after" | "cut" | "paste_after";

export interface InsertEdit {
	kind: "insert";
	cursor: Cursor;
	text: string;
	/** 1-indexed row of the patch body this edit came from. */
	lineNum: number;
	/** Position in the section's op list. */
	index: number;
	/** True for rows of a `PUT N.=M:` body (replacement), false for gap inserts. */
	replacement: boolean;
}
export interface DeleteEdit {
	kind: "delete";
	line: number;
	lineNum: number;
	index: number;
}
export interface CutEdit {
	kind: "cut";
	range: ParsedRange;
	register: string | undefined;
	lineNum: number;
	index: number;
}
export interface PasteEdit {
	kind: "paste";
	at: PasteTarget;
	register: string | undefined;
	lineNum: number;
	index: number;
}
export interface BlockEdit {
	kind: "block";
	line: number;
	payloads: string[];
	mode: BlockMode | undefined;
	register: string | undefined;
	lineNum: number;
	index: number;
}
export type Edit = InsertEdit | DeleteEdit | CutEdit | PasteEdit | BlockEdit;

/** File-level op of a section (`REM` / `MV DEST`). */
export type FileOp = { kind: "rem" } | { kind: "move"; dest: string };

/** Result of parsing one section body. */
export interface Parsed {
	edits: Edit[];
	fileOp: FileOp | undefined;
	warnings: string[];
}

/** Result of applying edits to a text. */
export interface ApplyResult {
	text: string;
	/** 1-indexed first changed line; undefined for a no-op. */
	firstChangedLine: number | undefined;
	warnings: string[];
}

/** Clipboard registers threaded through one patch application. */
export interface Clipboard {
	/** Latest anonymous cut. */
	lines: string[] | undefined;
	/** Named registers. */
	named: Map<string, string[]> | undefined;
	/** Descriptions of anonymous cuts not yet consumed. */
	pendingAnonCuts: string[] | undefined;
}

export function emptyClipboard(): Clipboard {
	return { lines: undefined, named: undefined, pendingAnonCuts: undefined };
}

/** Deep copy. */
export function forkClipboard(c: Clipboard): Clipboard {
	return {
		lines: c.lines ? [...c.lines] : undefined,
		named: c.named ? new Map([...c.named].map(([k, v]) => [k, [...v]] as [string, string[]])) : undefined,
		pendingAnonCuts: c.pendingAnonCuts ? [...c.pendingAnonCuts] : undefined,
	};
}

/**
 * Failure classes (upstream `EditError::kind()`), recorded in `details.errorKind`:
 * parse | apply | invalid_utf8 | io | write_failed | stale_tag | unknown_tag | other_file_tag |
 * missing_tag | header_only | out_of_range | ambiguous_boundary | no_change | file_not_found
 */
export class HashlineError extends Error {
	kind: string;
	constructor(kind: string, message: string) {
		super(message);
		this.name = "HashlineError";
		this.kind = kind;
	}
}

export function cursorLine(cursor: Cursor): number | undefined {
	return cursor.kind === "before" || cursor.kind === "after" ? cursor.line : undefined;
}

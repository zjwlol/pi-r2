
/**
 * Line numbers in the original file start at 1.
 */
export type Cursor = { kind: "bof" } | { kind: "eof" } | { kind: "before"; line: number } | { kind: "after"; line: number };

/**
 * Both endpoints are inclusive one-based line numbers.
 */
export interface ParsedRange {
	start: number;
	end: number;
}

export type PasteTarget = { kind: "gap"; cursor: Cursor } | { kind: "span"; range: ParsedRange };

export type BlockMode = "insert_after" | "cut" | "paste_after";

export interface InsertEdit {
	kind: "insert";
	cursor: Cursor;
	text: string;
	/**
	 * One-based line number in the patch body.
	 */
	lineNum: number;
	index: number;
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

export type FileOp = { kind: "rem" } | { kind: "move"; dest: string };

export interface Parsed {
	edits: Edit[];
	fileOp: FileOp | undefined;
	warnings: string[];
}

export interface ApplyResult {
	text: string;
	/**
	 * One-based line number in the edited text.
	 */
	firstChangedLine: number | undefined;
	warnings: string[];
}

export interface Clipboard {
	lines: string[] | undefined;
	named: Map<string, string[]> | undefined;
	pendingAnonCuts: string[] | undefined;
}

export function emptyClipboard(): Clipboard {
	return { lines: undefined, named: undefined, pendingAnonCuts: undefined };
}

export function forkClipboard(c: Clipboard): Clipboard {
	return {
		lines: c.lines ? [...c.lines] : undefined,
		named: c.named ? new Map([...c.named].map(([k, v]) => [k, [...v]] as [string, string[]])) : undefined,
		pendingAnonCuts: c.pendingAnonCuts ? [...c.pendingAnonCuts] : undefined,
	};
}

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

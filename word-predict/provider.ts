import { maskNonProse } from "../shared/prose.ts";

export interface WordPredictionBackend {
	complete(before: string, prefix: string): Promise<string | null>;
	feedback(before: string, prefix: string, suggestion: string, accepted: boolean): void;
}

export interface WordCompletionQuery {
	before: string;
	prefix: string;
}

const CODEISH_CHARACTERS = "\\/@_=:{}[]<>";
const CAMEL_CASE = /\p{Ll}\p{Lu}/u;
const MAX_PROSE_BUFFER_LENGTH = 20_000;
const MAX_PROSE_LINE_LENGTH = 1_000;

function tokenAt(text: string, start: number, end: number): string {
	let tokenStart = start;
	while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? "")) tokenStart--;
	let tokenEnd = end;
	while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? "")) tokenEnd++;
	return text.slice(tokenStart, tokenEnd);
}

export function isProseWord(text: string, masked: string, start: number, end: number): boolean {
	if (start < 0 || end <= start || end > text.length) return false;
	if (masked.slice(start, end).trim().length === 0) return false;
	const token = tokenAt(text, start, end);
	for (const char of token) {
		if (CODEISH_CHARACTERS.includes(char)) return false;
	}
	if (CAMEL_CASE.test(token) || /\d/.test(token)) return false;
	return !text.trimStart().startsWith("/") && !text.startsWith("->") && !text.startsWith("=>");
}

/**
 * Fenced code can span editor lines.
 */
export class ProseSource {
	#text = "";
	#mask = "";
	#lineOffsets: number[] = [];

	isProse(lines: readonly string[], line: number, startCol: number, endCol: number): boolean {
		const editorText = lines.join("\n");
		if (editorText.length > MAX_PROSE_BUFFER_LENGTH || startCol < 0 || endCol <= startCol) return false;
		const text = lines[line];
		if (text === undefined || text.length > MAX_PROSE_LINE_LENGTH || endCol > text.length) return false;
		this.#prepare(editorText, lines);
		const lineOffset = this.#lineOffsets[line];
		if (lineOffset === undefined) return false;
		return this.#mask.slice(lineOffset + startCol, lineOffset + endCol).trim().length > 0;
	}

	#prepare(editorText: string, lines: readonly string[]): void {
		if (this.#text === editorText) return;
		this.#text = editorText;
		this.#mask = maskNonProse(editorText);
		this.#lineOffsets = new Array<number>(lines.length);
		let offset = 0;
		for (let line = 0; line < lines.length; line++) {
			this.#lineOffsets[line] = offset;
			offset += (lines[line]?.length ?? 0) + 1;
		}
	}
}

const WORD_SUFFIX = /[\p{L}\p{M}']+$/u;
const WORD_CONTINUES = /^[\p{L}\p{M}']/u;
const CACHE_LIMIT = 256;
const BEFORE_LIMIT = 2_000;

interface WordQuery extends WordCompletionQuery {
	key: string;
}

function textBefore(lines: readonly string[], cursorLine: number, start: number): string {
	const head = (lines[cursorLine] ?? "").slice(0, start);
	let length = head.length;
	let first = cursorLine;
	while (first > 0 && length < BEFORE_LIMIT) {
		first--;
		length += (lines[first] ?? "").length + 1;
	}
	let text = head;
	if (first < cursorLine) {
		const parts: string[] = [];
		for (let line = first; line < cursorLine; line++) parts.push(lines[line] ?? "");
		parts.push(head);
		text = parts.join("\n");
	}
	if (text.length <= BEFORE_LIMIT) return text;
	let cut = text.length - BEFORE_LIMIT;
	// Do not split a UTF-16 surrogate pair.
	const unit = text.charCodeAt(cut);
	if (unit >= 0xdc00 && unit <= 0xdfff) cut++;
	return text.slice(cut);
}

export function wordCompletionQuery(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
	prose: ProseSource = new ProseSource(),
): WordCompletionQuery | undefined {
	const line = lines[cursorLine] ?? "";
	// The word regex can take quadratic time on long lines.
	if (line.length > MAX_PROSE_LINE_LENGTH) return undefined;
	if (WORD_CONTINUES.test(line.slice(cursorCol))) return undefined;
	const match = WORD_SUFFIX.exec(line.slice(0, cursorCol));
	if (!match) return undefined;
	const start = cursorCol - match[0].length;
	if (!isProseWord(line, maskNonProse(line), start, cursorCol)) return undefined;
	if (!prose.isProse(lines, cursorLine, start, cursorCol)) return undefined;
	return { before: textBefore(lines, cursorLine, start), prefix: match[0] };
}

export class WordCompletionProvider {
	#enabled = true;
	#generation = 0;
	#prose = new ProseSource();
	#cache = new Map<string, string | null>();
	#activeKey: string | undefined;
	#queued: WordQuery | undefined;
	#lastShown: { before: string; word: string } | undefined;
	#displayed: { key: string; suffix: string | null } | undefined;
	#queryMemo:
		| {
				generation: number;
				lines: readonly string[];
				cursorLine: number;
				cursorCol: number;
				query: WordQuery | undefined;
		  }
		| undefined;

	onUpdate: (() => void) | undefined;

	readonly #resolveBackend: () => WordPredictionBackend | undefined;

	constructor(backend: () => WordPredictionBackend | undefined) {
		this.#resolveBackend = backend;
	}

	setEnabled(enabled: boolean): void {
		if (this.#enabled === enabled) return;
		this.#enabled = enabled;
		this.#generation++;
		this.#cache.clear();
		this.#queued = undefined;
		this.#lastShown = undefined;
		this.#displayed = undefined;
	}

	getWordCompletion(lines: readonly string[], cursorLine: number, cursorCol: number): string | null {
		const query = this.#query(lines, cursorLine, cursorCol);
		const backend = query && this.#backend();
		if (!query || !backend) {
			this.#displayed = undefined;
			return null;
		}
		if (!this.#cache.has(query.key)) this.#schedule(backend, query);
		// A longer prefix can drop a shown word below the engine's threshold.
		const suffix = this.#cache.get(query.key) ?? this.#project(query);
		this.#displayed = { key: query.key, suffix };
		if (suffix) this.#lastShown = { before: query.before, word: query.prefix + suffix };
		return suffix;
	}

	wordCompletionFeedback(
		lines: readonly string[],
		cursorLine: number,
		cursorCol: number,
		suggestion: string,
		accepted: boolean,
	): void {
		const query = this.#query(lines, cursorLine, cursorCol);
		if (!query) return;
		try {
			this.#backend()?.feedback(query.before, query.prefix, suggestion, accepted);
		} catch {
			// Feedback must not interrupt editing.
		}
		if (!accepted) this.#lastShown = undefined;
	}

	#backend(): WordPredictionBackend | undefined {
		return this.#enabled ? this.#resolveBackend() : undefined;
	}

	#query(lines: readonly string[], cursorLine: number, cursorCol: number): WordQuery | undefined {
		if (!this.#enabled) return undefined;
		const memo = this.#queryMemo;
		if (
			memo?.generation === this.#generation &&
			memo.cursorLine === cursorLine &&
			memo.cursorCol === cursorCol &&
			memo.lines.length === lines.length &&
			memo.lines.every((line, index) => line === lines[index])
		) {
			return memo.query;
		}
		const query = wordCompletionQuery(lines, cursorLine, cursorCol, this.#prose);
		// An in-flight request can outlast an off/on toggle.
		const result = query && { key: `${this.#generation}\u0000${query.prefix}\u0000${query.before}`, ...query };
		// Pi edits the line array in place.
		this.#queryMemo = { generation: this.#generation, lines: lines.slice(), cursorLine, cursorCol, query: result };
		return result;
	}

	#project(query: WordQuery): string | null {
		const shown = this.#lastShown;
		if (!shown || shown.before !== query.before || shown.word.length <= query.prefix.length) return null;
		if (!shown.word.toLocaleLowerCase().startsWith(query.prefix.toLocaleLowerCase())) return null;
		return shown.word.slice(query.prefix.length);
	}

	#schedule(backend: WordPredictionBackend, query: WordQuery): void {
		if (this.#activeKey === query.key || this.#queued?.key === query.key) return;
		if (this.#activeKey !== undefined) {
			this.#queued = query;
			return;
		}
		void this.#run(backend, query);
	}

	async #run(backend: WordPredictionBackend, query: WordQuery): Promise<void> {
		this.#activeKey = query.key;
		const generation = this.#generation;
		let suffix: string | null;
		try {
			suffix = (await backend.complete(query.before, query.prefix)) || null;
		} catch {
			suffix = null;
		}
		if (this.#activeKey === query.key) this.#activeKey = undefined;
		const current = generation === this.#generation;
		if (current) {
			if (this.#cache.size >= CACHE_LIMIT) this.#cache.clear();
			this.#cache.set(query.key, suffix);
		}
		const queued = this.#queued;
		this.#queued = undefined;
		const next = queued && !this.#cache.has(queued.key) ? this.#backend() : undefined;
		if (queued && next) void this.#run(next, queued);
		const displayed = this.#displayed;
		if (current && displayed?.key === query.key && displayed.suffix !== (suffix ?? this.#project(query))) {
			try {
				this.onUpdate?.();
			} catch {
				// A repaint failure must not become an unhandled rejection.
			}
		}
	}
}

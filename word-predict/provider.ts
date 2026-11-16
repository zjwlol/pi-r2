/**
 * word-predict: which word at the caret gets a ghost, and the synchronous
 * front of the asynchronous engine (cache, single-flight requests, projection
 * while typing through a ghost).
 *
 * Port of oh-my-pi `packages/tui/src/prompt/word-completion.ts` and the gates
 * of `packages/tui/src/prompt/prose-gate.ts` (MIT). Differences: one engine, so
 * `setMethod` is `setEnabled`; `ProseSource.isProse` takes the lines directly.
 *
 * Pure: no pi or node imports, so it runs under plain node.
 */
import { maskNonProse } from "../shared/prose.ts";

/** Asynchronous engine behind the ghost text (here: `PredictHost.backend`, the engine worker). */
export interface WordPredictionBackend {
	/** Characters to paint after `prefix` typed after `before`, or null. Never rejects. */
	complete(before: string, prefix: string): Promise<string | null>;
	/** Report a shown suggestion the user accepted (Tab / →) or typed past. Fire-and-forget. */
	feedback(before: string, prefix: string, suggestion: string, accepted: boolean): void;
}

/** The prose word ending at the cursor and the editor text before it: what the engine is asked to complete. */
export interface WordCompletionQuery {
	before: string;
	prefix: string;
}

// --- prose gates (prose-gate.ts) --------------------------------------------

const CODEISH_CHARACTERS = "\\/@_=:{}[]<>";
const CAMEL_CASE = /\p{Ll}\p{Lu}/u;
/** Buffers above this many UTF-16 units get no ghost at all. */
const MAX_PROSE_BUFFER_LENGTH = 20_000;
/** Lines above this many UTF-16 units get no ghost at all. */
const MAX_PROSE_LINE_LENGTH = 1_000;

/** The whitespace-delimited token around `text[start, end)`. */
function tokenAt(text: string, start: number, end: number): string {
	let tokenStart = start;
	while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? "")) tokenStart--;
	let tokenEnd = end;
	while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? "")) tokenEnd++;
	return text.slice(tokenStart, tokenEnd);
}

/**
 * Whether `text[start, end)` is a prose word: unmasked by `maskNonProse`
 * (`masked` is that mask of `text`), not inside a path/identifier-like token,
 * and not on a slash-command or queue-shorthand (`->`, `=>`) line.
 */
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
 * Memoized whole-buffer prose mask: answers whether a line range is prose in
 * the context of the full editor text (fenced code spans lines).
 */
export class ProseSource {
	#text = "";
	#mask = "";
	#lineOffsets: number[] = [];

	/** True when `[startCol, endCol)` of `lines[line]` is prose and the buffer is within the caps. */
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

// --- the query (word-completion.ts) -----------------------------------------

const WORD_SUFFIX = /[\p{L}\p{M}']+$/u;
const WORD_CONTINUES = /^[\p{L}\p{M}']/u;
const CACHE_LIMIT = 256;
/** Context sent with each query: the editor text before the word, capped to a recent tail. */
const BEFORE_LIMIT = 2_000;

interface WordQuery extends WordCompletionQuery {
	key: string;
}

/** Editor text before the word starting at `start`, truncated to its last {@link BEFORE_LIMIT} code units. */
function textBefore(lines: readonly string[], cursorLine: number, start: number): string {
	const head = (lines[cursorLine] ?? "").slice(0, start);
	// Find the first line the capped tail reaches, then join once.
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
	// Never start on the low half of a surrogate pair.
	const unit = text.charCodeAt(cut);
	if (unit >= 0xdc00 && unit <= 0xdfff) cut++;
	return text.slice(cut);
}

/**
 * The query for the prose word ending at the cursor, or `undefined` where no
 * ghost text applies (mid-word, no word, code, paths, commands). `prose`
 * memoizes the whole-buffer mask; pass one instance across keystrokes.
 *
 * There is deliberately no gate for `!` bash drafts (upstream has none).
 */
export function wordCompletionQuery(
	lines: readonly string[],
	cursorLine: number,
	cursorCol: number,
	prose: ProseSource = new ProseSource(),
): WordCompletionQuery | undefined {
	const line = lines[cursorLine] ?? "";
	// Before the word regexes: they are quadratic on a long unbroken run of letters.
	if (line.length > MAX_PROSE_LINE_LENGTH) return undefined;
	if (WORD_CONTINUES.test(line.slice(cursorCol))) return undefined;
	// Single letters are asked too (`figure o|ut`); the engine owns its minimum prefix.
	const match = WORD_SUFFIX.exec(line.slice(0, cursorCol));
	if (!match) return undefined;
	const start = cursorCol - match[0].length;
	if (!isProseWord(line, maskNonProse(line), start, cursorCol)) return undefined;
	if (!prose.isProse(lines, cursorLine, start, cursorCol)) return undefined;
	return { before: textBefore(lines, cursorLine, start), prefix: match[0] };
}

// --- the provider -------------------------------------------------------------

/**
 * Ghost-text word completion for the prose word ending at the cursor, served
 * by an injected asynchronous {@link WordPredictionBackend}.
 *
 * Rendering is synchronous, so a cache miss schedules a single-flight backend
 * request (one active, the newest queued) and repaints through `onUpdate` when
 * the answer changes what is shown. The previous suggestion is projected: if
 * its full word still extends what was typed, the remainder shows immediately
 * and stays until the engine offers a different word.
 */
export class WordCompletionProvider {
	// On from the start: whoever builds a provider wants ghosts (upstream starts
	// "off" only because its setting is applied afterwards).
	#enabled = true;
	/** Bumped by every `setEnabled` change; answers of an older generation are dropped. */
	#generation = 0;
	#prose = new ProseSource();
	/** Answers by `prefix \0 before` (behind the generation, see {@link #query}). */
	#cache = new Map<string, string | null>();
	#activeKey: string | undefined;
	#queued: WordQuery | undefined;
	/** Last non-empty suggestion shown, for projection while typing through it. */
	#lastShown: { before: string; word: string } | undefined;
	/** What the last `getWordCompletion` returned, so a fetch repaints only when it changes that. */
	#displayed: { key: string; suffix: string | null } | undefined;
	/** Last {@link #query} input snapshot (lines are copied: the editor mutates its array in place). */
	#queryMemo:
		| {
				generation: number;
				lines: readonly string[];
				cursorLine: number;
				cursorCol: number;
				query: WordQuery | undefined;
		  }
		| undefined;

	/** Invoked when an asynchronous answer changes the rendered ghost text. */
	onUpdate: (() => void) | undefined;

	readonly #resolveBackend: () => WordPredictionBackend | undefined;

	/** `backend` is asked on every use; `undefined` means none is available (no ghost text). */
	constructor(backend: () => WordPredictionBackend | undefined) {
		this.#resolveBackend = backend;
	}

	/** Turn completion on or off and drop the answers gathered so far. */
	setEnabled(enabled: boolean): void {
		if (this.#enabled === enabled) return;
		this.#enabled = enabled;
		this.#generation++;
		this.#cache.clear();
		this.#queued = undefined;
		this.#lastShown = undefined;
		this.#displayed = undefined;
	}

	/** Return the ghost-text suffix for the prose word ending at the cursor, or `null`. */
	getWordCompletion(lines: readonly string[], cursorLine: number, cursorCol: number): string | null {
		const query = this.#query(lines, cursorLine, cursorCol);
		const backend = query && this.#backend();
		if (!query || !backend) {
			this.#displayed = undefined;
			return null;
		}
		if (!this.#cache.has(query.key)) this.#schedule(backend, query);
		// Typing through a shown ghost without Tab can answer null (the word fell
		// under the show threshold); keep that ghost until the engine offers
		// something else.
		const suffix = this.#cache.get(query.key) ?? this.#project(query);
		this.#displayed = { key: query.key, suffix };
		if (suffix) this.#lastShown = { before: query.before, word: query.prefix + suffix };
		return suffix;
	}

	/** Forward accept (Tab / →) or typed-past feedback for the suggestion shown at the cursor. */
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
			// Fire-and-forget: a backend failure never reaches the editor.
		}
		if (!accepted) this.#lastShown = undefined;
	}

	#backend(): WordPredictionBackend | undefined {
		return this.#enabled ? this.#resolveBackend() : undefined;
	}

	#query(lines: readonly string[], cursorLine: number, cursorCol: number): WordQuery | undefined {
		if (!this.#enabled) return undefined;
		// Rendering asks every frame; reuse the answer until the buffer, caret, or on/off state changes.
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
		// The generation (upstream: the engine name) keeps a request still in
		// flight from before an off/on switch from shadowing the same word state.
		const result = query && { key: `${this.#generation}\u0000${query.prefix}\u0000${query.before}`, ...query };
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

	/** Answer `query`, start the queued request, then repaint if the answer changes what is shown. */
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

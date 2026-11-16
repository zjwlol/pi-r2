/**
 * Static web prior: Norvig web unigram and bigram counts plus
 * `/usr/share/dict/words` membership, decoded from `data/web-prior.bin.zst`.
 * Port of oh-my-pi `crates/pi-predict/src/ngram/web.rs` (MIT).
 *
 * The artifact is built upstream by `crates/pi-predict/scripts/build-web-prior.ts`:
 * the 150k most frequent lowercase word forms of Norvig's `count_1w` in UTF-8
 * byte order, their bigrams from `count_2w` (plus the `<S>` sentence-start
 * rows), and dictionary membership. It is decoded once per process.
 *
 * Loaded by Node's type stripping (worker / CLI): erasable syntax only.
 */
import { zstdDecompressSync } from "node:zlib";
import { cmpWords } from "./structures.ts";

const MAGIC = "PIWP";
const VERSION = 1;
/**
 * Share of real sentence starts that Norvig's `<S> w` rows cover (the research
 * tuning: 0.3 -> no change).
 */
const SENTENCE_COVERAGE = 0.6;
/** Web count from which a word is trusted as a real spelling even outside the dictionary. */
export const TRUSTED_WEB_COUNT = 200_000;
/** No bigram slot. */
export const NO_SLOT = 0xffff_ffff;

/** Word list sorted in UTF-8 byte order. */
export class SortedWords {
	private readonly words: string[];

	/** Takes ownership of `words` (byte order, deduplicated). */
	constructor(words: string[]) {
		this.words = words;
	}

	/** Number of words. */
	get length(): number {
		return this.words.length;
	}

	/** Word `index`. */
	get(index: number): string {
		return this.words[index];
	}

	/** First index whose word is `>= key`. */
	lowerBound(key: string): number {
		const words = this.words;
		let lo = 0;
		let hi = words.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (cmpWords(words[mid], key) < 0) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	/** Index range of the words starting with `prefix`. */
	range(prefix: string): [lo: number, hi: number] {
		const words = this.words;
		const lo = this.lowerBound(prefix);
		// Words starting with `prefix` are contiguous from `lo`.
		let a = lo;
		let b = words.length;
		while (a < b) {
			const mid = (a + b) >>> 1;
			if (words[mid].startsWith(prefix)) a = mid + 1;
			else b = mid;
		}
		return [lo, a];
	}

	/** Index of `word`, or -1. */
	find(word: string): number {
		const at = this.lowerBound(word);
		return at < this.words.length && this.words[at] === word ? at : -1;
	}
}

/** The decoded arrays a `WebPrior` is made of. */
interface WebPriorParts {
	words: SortedWords;
	count: Float32Array;
	p0: Float32Array;
	p0Cum: Float64Array;
	dictBits: Uint8Array;
	dictOnly: SortedWords;
	slots: Uint32Array;
	start: Uint32Array;
	follower: Uint32Array;
	prob: Float32Array;
	covered: Float32Array;
}

/** Web unigram and bigram statistics indexed by web id (lexicographic rank). */
export class WebPrior {
	/** Vocabulary in byte order. */
	readonly words: SortedWords;
	/** Norvig count per word. */
	readonly count: Float32Array;
	/** Unigram share `p0` per word. */
	readonly p0: Float32Array;
	/** Cumulative `p0` (`p0Cum[i]` = sum over words `< i`). */
	readonly p0Cum: Float64Array;
	/** Follower web ids, ascending within a slot. */
	readonly follower: Uint32Array;
	/** `P_web(w | v)` per row. */
	readonly prob: Float32Array;
	/** Covered mass `S(v) = sum of P_web(w | v)` per slot (capped at 1). */
	readonly covered: Float32Array;
	/** Dictionary membership, bit `i` (LSB first within a byte) for web word `i`. */
	private readonly dictBits: Uint8Array;
	/** Dictionary words outside the vocabulary. */
	private readonly dictOnly: SortedWords;
	/** Bigram slot per context word (index `length` = sentence start). */
	private readonly slots: Uint32Array;
	/** Follower rows per slot: `start[slot]..start[slot + 1]`. */
	private readonly start: Uint32Array;

	/** Built by `decodeWebPrior`. */
	constructor(parts: WebPriorParts) {
		this.words = parts.words;
		this.count = parts.count;
		this.p0 = parts.p0;
		this.p0Cum = parts.p0Cum;
		this.follower = parts.follower;
		this.prob = parts.prob;
		this.covered = parts.covered;
		this.dictBits = parts.dictBits;
		this.dictOnly = parts.dictOnly;
		this.slots = parts.slots;
		this.start = parts.start;
	}

	/** Number of vocabulary words. */
	get length(): number {
		return this.words.length;
	}

	/** Whether web word `webId` is a dictionary word. */
	inDict(webId: number): boolean {
		return ((this.dictBits[webId >>> 3] >>> (webId & 7)) & 1) === 1;
	}

	/**
	 * Whether `word` (lowercase) is a real spelling: in the dictionary, or at
	 * least `TRUSTED_WEB_COUNT` on the web. `webId` is its web id; `webId` < 0:
	 * `word` is not a web word (dictionary-only lookup).
	 */
	trusted(word: string, webId: number): boolean {
		if (webId >= 0 && webId < this.count.length) {
			return this.inDict(webId) || this.count[webId] >= TRUSTED_WEB_COUNT;
		}
		return this.dictOnly.find(word) >= 0;
	}

	/** Bigram slot of context web id (`length` = sentence start), or NO_SLOT. */
	slot(webId: number): number {
		return this.slots[webId];
	}

	/** Row range of `slot`. */
	rows(slot: number): [start: number, end: number] {
		return [this.start[slot], this.start[slot + 1]];
	}

	/** First row of `slot` whose follower id is `>= webId`. */
	lowerRow(slot: number, webId: number): number {
		const follower = this.follower;
		let lo = this.start[slot];
		let hi = this.start[slot + 1];
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (follower[mid] < webId) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	/** `P_web(webId | slot)`, 0 when absent. */
	probOf(slot: number, webId: number): number {
		const at = this.lowerRow(slot, webId);
		return at < this.start[slot + 1] && this.follower[at] === webId ? this.prob[at] : 0;
	}
}

/** Little-endian cursor over the decompressed artifact (its arrays are not 4-aligned). */
class Reader {
	private readonly bytes: Uint8Array;
	private readonly view: DataView;
	private at = 0;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	/** Advance over `length` bytes and return where they start. */
	private skip(length: number): number {
		const start = this.at;
		if (length > this.bytes.length - start) throw new Error("web prior: truncated");
		this.at = start + length;
		return start;
	}

	take(length: number): Uint8Array {
		const start = this.skip(length);
		return this.bytes.subarray(start, start + length);
	}

	u32(): number {
		return this.view.getUint32(this.skip(4), true);
	}

	f64(): number {
		return this.view.getFloat64(this.skip(8), true);
	}

	u32s(n: number): Uint32Array {
		const start = this.skip(n * 4);
		const out = new Uint32Array(n);
		for (let i = 0; i < n; i++) out[i] = this.view.getUint32(start + i * 4, true);
		return out;
	}

	f32s(n: number): Float32Array {
		const start = this.skip(n * 4);
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) out[i] = this.view.getFloat32(start + i * 4, true);
		return out;
	}

	/** The next `count` lines, each `\n`-terminated. */
	blob(count: number): Uint8Array {
		const bytes = this.bytes;
		let seen = 0;
		let end = this.at;
		for (let i = this.at; i < bytes.length && seen < count; i++) {
			if (bytes[i] === 0x0a) {
				seen += 1;
				end = i + 1;
			}
		}
		if (seen !== count) throw new Error("web prior: word list truncated");
		return this.take(end - this.at);
	}
}

function parseWords(blob: Uint8Array, count: number): SortedWords {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob);
	} catch {
		throw new Error("web prior: words are not UTF-8");
	}
	const words = text.length === 0 ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
	if (words.length !== count) throw new Error(`web prior: expected ${count} words, found ${words.length}`);
	return new SortedWords(words);
}

/** Decode the zstd artifact; throws Error("web prior: …"). */
export function decodeWebPrior(compressed: Uint8Array): WebPrior {
	let raw: Uint8Array;
	try {
		raw = zstdDecompressSync(compressed);
	} catch (error) {
		throw new Error(`web prior: zstd decode: ${error instanceof Error ? error.message : String(error)}`);
	}
	const r = new Reader(raw);
	const magic = r.take(4);
	for (let i = 0; i < 4; i++) {
		if (magic[i] !== MAGIC.charCodeAt(i)) throw new Error("web prior: bad magic");
	}
	const version = r.u32();
	if (version !== VERSION) throw new Error(`web prior: unsupported version ${version}`);
	const n = r.u32();
	const nDict = r.u32();
	const nCtx = r.u32();
	const nRows = r.u32();
	const sentenceTotal = r.f64();
	const count = r.f32s(n);
	const dictBits = r.take(Math.ceil(n / 8));
	const contexts = r.u32s(nCtx);
	const lengths = r.u32s(nCtx);
	const deltas = r.u32s(nRows);
	const counts = r.f32s(nRows);
	const words = parseWords(r.blob(n), n);
	const dictOnly = parseWords(r.blob(nDict), nDict);

	let total = 0;
	for (let i = 0; i < n; i++) total += count[i];
	const p0 = new Float32Array(n);
	for (let i = 0; i < n; i++) p0[i] = count[i] / total;
	const p0Cum = new Float64Array(n + 1);
	let acc = 0;
	for (let i = 0; i < n; i++) {
		acc += p0[i];
		p0Cum[i + 1] = acc;
	}

	const slots = new Uint32Array(n + 1).fill(NO_SLOT);
	const start = new Uint32Array(nCtx + 1);
	const follower = new Uint32Array(nRows);
	const prob = new Float32Array(nRows);
	const covered = new Float32Array(nCtx);
	let row = 0;
	for (let s = 0; s < nCtx; s++) {
		const ctx = contexts[s];
		const length = lengths[s];
		if (ctx > n) throw new Error("web prior: context id out of range");
		slots[ctx] = s;
		start[s] = row;
		const denominator = ctx === n ? sentenceTotal / SENTENCE_COVERAGE : count[ctx];
		let id = 0;
		let mass = 0;
		for (let i = 0; i < length; i++) {
			if (row + i >= nRows) throw new Error("web prior: bigram rows truncated");
			const delta = deltas[row + i];
			id = i === 0 ? delta : id + delta;
			if (id >= n) throw new Error("web prior: follower id out of range");
			const p = counts[row + i] / denominator;
			follower[row + i] = id;
			prob[row + i] = p;
			mass += p;
		}
		covered[s] = Math.min(mass, 1);
		row += length;
	}
	if (row !== nRows) throw new Error("web prior: bigram row count mismatch");
	start[nCtx] = row;
	return new WebPrior({
		words,
		count,
		p0,
		p0Cum,
		dictBits: dictBits.slice(),
		dictOnly,
		slots,
		start,
		follower,
		prob,
		covered,
	});
}

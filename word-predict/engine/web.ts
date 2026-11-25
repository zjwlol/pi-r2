import { zstdDecompressSync } from "node:zlib";
import { cmpWords } from "./structures.ts";

const MAGIC = "PIWP";
const VERSION = 1;
const SENTENCE_COVERAGE = 0.6;
export const TRUSTED_WEB_COUNT = 200_000;
export const NO_SLOT = 0xffff_ffff;

export class SortedWords {
	private readonly words: string[];

	constructor(words: string[]) {
		this.words = words;
	}

	get length(): number {
		return this.words.length;
	}

	get(index: number): string {
		return this.words[index];
	}

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

	range(prefix: string): [lo: number, hi: number] {
		const words = this.words;
		const lo = this.lowerBound(prefix);
		let a = lo;
		let b = words.length;
		while (a < b) {
			const mid = (a + b) >>> 1;
			if (words[mid].startsWith(prefix)) a = mid + 1;
			else b = mid;
		}
		return [lo, a];
	}

	find(word: string): number {
		const at = this.lowerBound(word);
		return at < this.words.length && this.words[at] === word ? at : -1;
	}
}

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

export class WebPrior {
	readonly words: SortedWords;
	readonly count: Float32Array;
	readonly p0: Float32Array;
	/**
	 * Each sum covers word IDs strictly below its index.
	 */
	readonly p0Cum: Float64Array;
	readonly follower: Uint32Array;
	readonly prob: Float32Array;
	readonly covered: Float32Array;
	private readonly dictBits: Uint8Array;
	private readonly dictOnly: SortedWords;
	private readonly slots: Uint32Array;
	private readonly start: Uint32Array;

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

	get length(): number {
		return this.words.length;
	}

	inDict(webId: number): boolean {
		// The artifact stores dictionary membership least significant bit first.
		return ((this.dictBits[webId >>> 3] >>> (webId & 7)) & 1) === 1;
	}

	trusted(word: string, webId: number): boolean {
		if (webId >= 0 && webId < this.count.length) {
			return this.inDict(webId) || this.count[webId] >= TRUSTED_WEB_COUNT;
		}
		return this.dictOnly.find(word) >= 0;
	}

	/**
	 * The artifact uses the vocabulary length as its sentence-start ID.
	 */
	slot(webId: number): number {
		return this.slots[webId];
	}

	rows(slot: number): [start: number, end: number] {
		return [this.start[slot], this.start[slot + 1]];
	}

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

	probOf(slot: number, webId: number): number {
		const at = this.lowerRow(slot, webId);
		return at < this.start[slot + 1] && this.follower[at] === webId ? this.prob[at] : 0;
	}
}

/**
 * The artifact's arrays can start at unaligned byte offsets.
 */
class Reader {
	private readonly bytes: Uint8Array;
	private readonly view: DataView;
	private at = 0;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

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

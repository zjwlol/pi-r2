import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { Model } from "./model.ts";
import type { CaseTail, Params } from "./model.ts";
import { Followers, IdTable, NONE } from "./structures.ts";
import type { WebPrior } from "./web.ts";

const MAGIC = Buffer.from("PINGRAM\0", "latin1");
export const SNAPSHOT_VERSION = 1;
const MAX_TEXT_BYTES = 0xffff;

class Writer {
	private buf: Buffer = Buffer.allocUnsafe(1 << 16);
	private at = 0;

	/**
	 * Claim space before reading the buffer because it may be replaced.
	 */
	private claim(length: number): number {
		const start = this.at;
		const end = start + length;
		if (end > this.buf.length) {
			const next = Buffer.allocUnsafe(Math.max(end, this.buf.length * 2));
			this.buf.copy(next, 0, 0, start);
			this.buf = next;
		}
		this.at = end;
		return start;
	}

	u16(value: number): void {
		const at = this.claim(2);
		this.buf.writeUInt16LE(value, at);
	}

	u32(value: number): void {
		const at = this.claim(4);
		this.buf.writeUInt32LE(value, at);
	}

	f32(value: number): void {
		const at = this.claim(4);
		this.buf.writeFloatLE(value, at);
	}

	f64(value: number): void {
		const at = this.claim(8);
		this.buf.writeDoubleLE(value, at);
	}

	text(text: string): void {
		let length = Buffer.byteLength(text, "utf8");
		if (length <= MAX_TEXT_BYTES) {
			this.u16(length);
			const at = this.claim(length);
			this.buf.write(text, at, length, "utf8");
			return;
		}
		const bytes = Buffer.from(text, "utf8");
		length = MAX_TEXT_BYTES;
		// Truncate only between UTF-8 code points.
		while (length > 0 && (bytes[length] & 0xc0) === 0x80) length -= 1;
		this.u16(length);
		const at = this.claim(length);
		bytes.copy(this.buf, at, 0, length);
	}

	finish(): Buffer {
		return this.buf.subarray(0, this.at);
	}
}

class Reader {
	private readonly bytes: Buffer;
	private at = 0;
	private readonly utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

	constructor(bytes: Buffer) {
		this.bytes = bytes;
	}

	private take(length: number): number {
		const start = this.at;
		if (length > this.bytes.length - start) throw new Error("snapshot truncated");
		this.at = start + length;
		return start;
	}

	get done(): boolean {
		return this.at === this.bytes.length;
	}

	u16(): number {
		return this.bytes.readUInt16LE(this.take(2));
	}

	u32(): number {
		return this.bytes.readUInt32LE(this.take(4));
	}

	/**
	 * The minimum record size is in bytes.
	 */
	len(minRecord: number): number {
		const n = this.u32();
		if (n * minRecord > this.bytes.length - this.at) throw new Error("snapshot count out of range");
		return n;
	}

	f32(): number {
		return this.bytes.readFloatLE(this.take(4));
	}

	f64(): number {
		return this.bytes.readDoubleLE(this.take(8));
	}

	text(): string {
		const length = this.u16();
		const start = this.take(length);
		const end = start + length;
		const bytes = this.bytes;
		let ascii = true;
		for (let i = start; i < end; i++) {
			if (bytes[i] >= 0x80) {
				ascii = false;
				break;
			}
		}
		if (ascii) return bytes.toString("latin1", start, end);
		try {
			return this.utf8.decode(bytes.subarray(start, end));
		} catch {
			throw new Error("snapshot word is not UTF-8");
		}
	}

	word(map: Uint32Array): number {
		const at = this.u32();
		if (at >= map.length) throw new Error("snapshot word index out of range");
		return map[at];
	}
}

export function encodeSnapshot(model: Model): Uint8Array {
	const vocab = model.vocab;
	const n = vocab.length;
	const keep = new Uint8Array(n);
	for (let id = 0; id < n; id++) {
		if (model.count[id] > 0 || model.raw[id] > 0 || model.ctxSlot[id] !== NONE) keep[id] = 1;
	}
	for (const list of model.followers) {
		for (const id of list.ids) keep[id] = 1;
	}
	const pairCount = model.pairTotals.length;
	const pairU = new Uint32Array(pairCount);
	const pairV = new Uint32Array(pairCount);
	model.pairs.forEach((u, v, pair) => {
		pairU[pair] = u;
		pairV[pair] = v;
		keep[u] = 1;
		keep[v] = 1;
	});
	model.tri.forEach((_pair, word) => {
		keep[word] = 1;
	});
	for (const id of model.tails.keys()) keep[id] = 1;
	for (const prompt of model.session.prompts) {
		for (const id of prompt) keep[id] = 1;
	}

	const w = new Writer();
	w.f64(model.total);
	let kept = 0;
	let contexts = 0;
	for (let id = 0; id < n; id++) {
		kept += keep[id];
		if (model.ctxSlot[id] !== NONE) contexts += 1;
	}
	w.u32(kept);
	const index = new Uint32Array(n).fill(NONE);
	let next = 0;
	for (let id = 0; id < n; id++) {
		if (keep[id] === 0) continue;
		index[id] = next;
		next += 1;
		w.text(vocab.word(id));
		w.f32(model.count[id]);
		w.u32(model.raw[id]);
	}
	w.u32(contexts);
	for (let id = 0; id < n; id++) {
		const slot = model.ctxSlot[id];
		if (slot === NONE) continue;
		const list = model.followers[slot];
		w.u32(index[id]);
		w.u32(list.ids.length);
		for (let i = 0; i < list.ids.length; i++) {
			w.u32(index[list.ids[i]]);
			w.f32(list.counts[i]);
		}
	}
	w.u32(pairCount);
	for (let pair = 0; pair < pairCount; pair++) {
		w.u32(index[pairU[pair]]);
		w.u32(index[pairV[pair]]);
		w.f32(model.pairTotals[pair]);
		w.u32(model.pairTypeCounts[pair]);
	}
	w.u32(model.tri.size);
	model.tri.forEach((pair, word, count) => {
		w.u32(pair);
		w.u32(index[word]);
		w.f32(count);
	});
	w.u32(model.tails.size);
	for (const [id, forms] of model.tails) {
		w.u32(index[id]);
		w.u32(forms.length);
		for (const tail of forms) {
			w.text(tail.form);
			w.f32(tail.n);
		}
	}
	w.u32(model.session.prompts.length);
	for (const prompt of model.session.prompts) {
		w.u32(prompt.length);
		for (const id of prompt) w.u32(index[id]);
	}

	const frame = zstdCompressSync(w.finish(), {
		params: {
			[constants.ZSTD_c_compressionLevel]: 3,
			[constants.ZSTD_c_checksumFlag]: 1,
		},
	});
	const out = Buffer.allocUnsafe(12 + frame.length);
	MAGIC.copy(out, 0);
	out.writeUInt32LE(SNAPSHOT_VERSION, 8);
	frame.copy(out, 12);
	return out;
}

export function decodeSnapshot(bytes: Uint8Array, params: Params, web: WebPrior): Model {
	const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (file.length < 12 || !file.subarray(0, 8).equals(MAGIC)) throw new Error("not an n-gram snapshot");
	const version = file.readUInt32LE(8);
	if (version !== SNAPSHOT_VERSION) {
		throw new Error(`unsupported n-gram snapshot version ${version} (expected ${SNAPSHOT_VERSION})`);
	}
	let payload: Buffer;
	try {
		payload = zstdDecompressSync(file.subarray(12));
	} catch (error) {
		throw new Error(`corrupt n-gram snapshot: ${error instanceof Error ? error.message : String(error)}`);
	}
	const r = new Reader(payload);
	const total = r.f64();
	const wordCount = r.len(10);
	const words: string[] = new Array(wordCount);
	const counts = new Float32Array(wordCount);
	const raws = new Uint32Array(wordCount);
	for (let i = 0; i < wordCount; i++) {
		words[i] = r.text();
		counts[i] = r.f32();
		raws[i] = r.u32();
	}
	const model = Model.withWords(params, web, words);
	model.total = total;
	const map = new Uint32Array(wordCount);
	for (let i = 0; i < wordCount; i++) {
		const id = model.vocab.find(words[i]);
		if (id === NONE) throw new Error("snapshot word missing from the vocabulary");
		model.count[id] = counts[i];
		model.raw[id] = raws[i];
		map[i] = id;
	}

	const order: number[] = [];
	for (let left = r.len(8); left > 0; left--) {
		const ctx = r.word(map);
		const length = r.len(8);
		const ids: number[] = new Array(length);
		const weights: number[] = new Array(length);
		let sorted = true;
		for (let i = 0; i < length; i++) {
			ids[i] = r.word(map);
			weights[i] = r.f32();
			if (i > 0 && ids[i - 1] >= ids[i]) sorted = false;
		}
		const list = new Followers();
		if (sorted) {
			list.ids = ids;
			list.counts = weights;
			for (let i = 0; i < length; i++) list.total += weights[i];
		} else {
			order.length = 0;
			for (let i = 0; i < length; i++) order.push(i);
			order.sort((a, b) => ids[a] - ids[b]);
			for (const from of order) {
				const id = ids[from];
				if (list.ids.length > 0 && list.ids[list.ids.length - 1] === id) {
					throw new Error("duplicate snapshot follower");
				}
				list.total += weights[from];
				list.ids.push(id);
				list.counts.push(weights[from]);
			}
		}
		if (model.ctxSlot[ctx] !== NONE) throw new Error("duplicate snapshot context");
		model.ctxSlot[ctx] = model.followers.length;
		model.followers.push(list);
	}

	const pairCount = r.len(16);
	const pairs = new IdTable((slots): Uint32Array => new Uint32Array(slots), Math.max(pairCount, 1024));
	model.pairs = pairs;
	for (let pair = 0; pair < pairCount; pair++) {
		const u = r.word(map);
		const v = r.word(map);
		const at = pairs.entry(u, v);
		if (!pairs.fresh) throw new Error("duplicate snapshot pair");
		pairs.values[at] = pair;
		model.pairTotals.push(r.f32());
		model.pairTypeCounts.push(r.u32());
	}
	const triCount = r.len(12);
	const tri = new IdTable((slots): Float32Array => new Float32Array(slots), Math.max(triCount, 1024));
	model.tri = tri;
	for (let i = 0; i < triCount; i++) {
		const pair = r.u32();
		if (pair >= pairCount) throw new Error("snapshot trigram pair out of range");
		const word = r.word(map);
		const at = tri.entry(pair, word);
		tri.values[at] = r.f32();
	}
	for (let left = r.len(8); left > 0; left--) {
		const id = r.word(map);
		const forms: CaseTail[] = [];
		for (let more = r.len(6); more > 0; more--) {
			const form = r.text();
			forms.push({ form, n: r.f32() });
		}
		model.tails.set(id, forms);
	}
	const prompts: number[][] = [];
	for (let left = r.len(4); left > 0; left--) {
		const prompt: number[] = [];
		for (let more = r.len(4); more > 0; more--) prompt.push(r.word(map));
		prompts.push(prompt);
	}
	if (!r.done) throw new Error("trailing bytes in n-gram snapshot");
	model.restoreSession(prompts);
	model.rebuildRanges();
	model.sweepHygiene();
	return model;
}

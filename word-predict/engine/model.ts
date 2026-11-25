import { forEachNeighbour, forEachSlip } from "./hygiene.ts";
import { isLearnable, isTypedLike, proseWords } from "./prose.ts";
import { Fenwick, Followers, IdTable, MaxTree, NONE, cmpWords } from "./structures.ts";
import { BOS, SLOT_BOS, SLOT_NONE, SLOT_WORD, caseTail, codePoints, contextBefore, lowercase } from "./text.ts";
import type { Context, Slot } from "./text.ts";
import { Vocab } from "./vocab.ts";
import { NO_SLOT } from "./web.ts";
import type { WebPrior } from "./web.ts";

export interface Params {
	pasteWeight: number;
	/**
	 * The unigram prior strength is measured in weighted tokens.
	 */
	mu1: number;
	d2: number;
	mu2: number;
	d3: number;
	mu3: number;
	webBigram: number;
	topK: number;
	minCount: number;
	canonicalize: boolean;
	canonMaxCount: number;
	canonRatio: number;
	casePrior: number;
	caseStrength: number;
	cacheWeight: number;
	/**
	 * The decay length is in UTF-8 bytes.
	 */
	cacheDecay: number;
	cacheContextBoost: number;
	/**
	 * The window length is in UTF-8 bytes.
	 */
	cacheWindow: number;
	sessionWeight: number;
	sessionPrompts: number;
	showThreshold: number;
}

export const DEFAULT_PARAMS: Readonly<Params> = Object.freeze({
	pasteWeight: 0.25,
	mu1: 10_000,
	d2: 0.9,
	mu2: 2,
	d3: 0.9,
	mu3: 2,
	webBigram: 1,
	topK: 6,
	minCount: 2,
	canonicalize: true,
	canonMaxCount: 3,
	canonRatio: 3,
	casePrior: 0.97,
	caseStrength: 2,
	cacheWeight: 0.5,
	cacheDecay: 500,
	cacheContextBoost: 4,
	cacheWindow: 4000,
	sessionWeight: 0.02,
	sessionPrompts: 20,
	showThreshold: 0.15,
});

const TRUSTED = 1;
const SHADOWED = 2;
const WATCH = 4;

const HYGIENE_MIN_CHARS = 5;
const COMPACT_AT = 4096;
const ID_HEADROOM = 2 * COMPACT_AT;

const ALPHABETIC = /\p{Alphabetic}/u;
const LOWERCASE = /\p{Lowercase}/u;

export interface CaseTail {
	form: string;
	n: number;
}

/**
 * Returns a UTF-16 offset.
 */
function codePointOffset(text: string, k: number): number {
	let at = 0;
	for (let i = 0; i < k && at < text.length; i++) {
		const unit = text.charCodeAt(at);
		const pair =
			unit >= 0xd800 &&
			unit <= 0xdbff &&
			at + 1 < text.length &&
			(text.charCodeAt(at + 1) & 0xfc00) === 0xdc00;
		at += pair ? 2 : 1;
	}
	return at;
}

/**
 * The prefix length `k` is in Unicode code points.
 */
export function plainSuffix(rest: string, typed: string, k: number): string {
	if (k >= 2 && ALPHABETIC.test(typed) && !LOWERCASE.test(typed)) return rest.toUpperCase();
	return rest;
}

export class Session {
	prompts: number[][] = [];
	private counts = new Map<number, number>();
	private sortedIds: number[] = [];
	private sortedCounts: number[] = [];
	private stale = false;

	push(words: number[], capacity: number): void {
		if (capacity === 0) return;
		const counts = this.counts;
		for (const id of words) counts.set(id, (counts.get(id) ?? 0) + 1);
		this.prompts.push(words);
		while (this.prompts.length > capacity) {
			const old = this.prompts.shift() as number[];
			for (const id of old) {
				const count = counts.get(id);
				if (count === undefined) continue;
				if (count <= 1) counts.delete(id);
				else counts.set(id, count - 1);
			}
		}
		this.stale = true;
	}

	private resort(vocab: Vocab): void {
		const ids = Array.from(this.counts.keys());
		ids.sort((a, b) => cmpWords(vocab.word(a), vocab.word(b)));
		const counts = this.counts;
		this.sortedIds = ids;
		this.sortedCounts = ids.map((id) => counts.get(id) as number);
		this.stale = false;
	}

	range(prefix: string, vocab: Vocab, visit: (id: number, count: number) => void): void {
		if (this.stale) this.resort(vocab);
		const ids = this.sortedIds;
		let lo = 0;
		let hi = ids.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (cmpWords(vocab.word(ids[mid]), prefix) < 0) lo = mid + 1;
			else hi = mid;
		}
		let end = lo;
		while (end < ids.length && vocab.word(ids[end]).startsWith(prefix)) end += 1;
		const counts = this.sortedCounts;
		for (let at = lo; at < end; at++) visit(ids[at], counts[at]);
	}

	remap(remap: Uint32Array): void {
		for (const prompt of this.prompts) {
			for (let i = 0; i < prompt.length; i++) prompt[i] = remap[prompt[i]];
		}
		const counts = new Map<number, number>();
		for (const [id, count] of this.counts) counts.set(remap[id], count);
		this.counts = counts;
		this.stale = true;
	}
}

const makeU32 = (slots: number): Uint32Array => new Uint32Array(slots);
const makeF32 = (slots: number): Float32Array => new Float32Array(slots);

export class Model {
	readonly params: Params;
	readonly web: WebPrior;
	vocab: Vocab;
	count: Float32Array;
	raw: Uint32Array;
	webId: Uint32Array;
	private flags: Uint8Array;
	ctxSlot: Uint32Array;
	followers: Followers[] = [];
	total = 0;
	webToId: Uint32Array;
	private fen: Fenwick;
	private tree: MaxTree;
	pairs: IdTable<Uint32Array>;
	pairTotals: number[] = [];
	pairTypeCounts: number[] = [];
	tri: IdTable<Float32Array>;
	/**
	 * Keep case tails in first-seen order to break ties.
	 */
	tails = new Map<number, CaseTail[]>();
	session = new Session();
	bos: number;
	/**
	 * Bump when a mutation invalidates cached queries.
	 */
	version = 0;

	private readonly found: number[] = [];
	private readonly folds: number[] = [];
	private readonly context: Context = { u: SLOT_NONE, v: SLOT_NONE, uWord: "", vWord: "" };
	private readonly visitSlip = (candidate: string): void => {
		const other = this.vocab.find(candidate);
		if (other !== NONE && !this.found.includes(other)) this.found.push(other);
	};

	constructor(params: Params, web: WebPrior, extra: string[] = []) {
		this.params = params;
		this.web = web;
		const extras = extra.filter((word) => web.words.find(word) < 0);
		if (web.words.find(BOS) < 0) extras.push(BOS);
		extras.sort(cmpWords);
		let kept = 0;
		for (let i = 0; i < extras.length; i++) {
			if (kept === 0 || extras[kept - 1] !== extras[i]) extras[kept++] = extras[i];
		}
		extras.length = kept;

		const webLength = web.length;
		const n = webLength + extras.length;
		const capacity = n + ID_HEADROOM;
		const merged: string[] = new Array(n);
		const webId = new Uint32Array(capacity).fill(NONE);
		const webToId = new Uint32Array(webLength).fill(NONE);
		const flags = new Uint8Array(capacity);
		let a = 0;
		let b = 0;
		for (let id = 0; id < n; id++) {
			const takeExtra = a === webLength || (b < extras.length && cmpWords(extras[b], web.words.get(a)) < 0);
			if (takeExtra) {
				const word = extras[b++];
				merged[id] = word;
				if (web.trusted(word, -1)) flags[id] = TRUSTED;
			} else {
				const word = web.words.get(a);
				merged[id] = word;
				webId[id] = a;
				webToId[a] = id;
				if (web.trusted(word, a)) flags[id] = TRUSTED;
				a += 1;
			}
		}
		this.vocab = Vocab.fromSorted(merged);
		this.count = new Float32Array(capacity);
		this.raw = new Uint32Array(capacity);
		this.webId = webId;
		this.flags = flags;
		this.ctxSlot = new Uint32Array(capacity).fill(NONE);
		this.webToId = webToId;
		this.pairs = new IdTable(makeU32, 1024);
		this.tri = new IdTable(makeF32, 1024);
		this.bos = this.vocab.find(BOS);
		this.fen = new Fenwick([], 0);
		this.tree = new MaxTree(new Float32Array(0), 0);
		this.rebuildRanges();
	}

	static withWords(params: Params, web: WebPrior, extra: string[]): Model {
		return new Model(params, web, extra);
	}

	countOf(id: number): number {
		return this.count[id];
	}

	rawOf(id: number): number {
		return this.raw[id];
	}

	p0(id: number): number {
		const wid = this.webId[id];
		return wid === NONE ? 0 : this.web.p0[wid];
	}

	rebuildRanges(): void {
		const base = this.vocab.baseLength;
		const count = this.count;
		this.fen = new Fenwick(count, base);
		const mu1 = this.params.mu1;
		const scores = new Float32Array(base);
		for (let i = 0; i < base; i++) scores[i] = count[i] + mu1 * this.p0(i);
		this.tree = new MaxTree(scores, base);
	}

	countSum(lo: number, hi: number): number {
		return this.fen.prefix(hi) - this.fen.prefix(lo);
	}

	topK(lo: number, hi: number, k: number, out: number[]): void {
		this.tree.topK(lo, hi, k, out);
	}

	trusted(id: number): boolean {
		return (this.flags[id] & TRUSTED) !== 0;
	}

	eligible(id: number): boolean {
		const flags = this.flags[id];
		return (
			(flags & TRUSTED) !== 0 ||
			((flags & SHADOWED) === 0 && (this.webId[id] !== NONE || this.raw[id] >= this.params.minCount))
		);
	}

	resolve(slot: Slot, word: string): number {
		if (slot === SLOT_BOS) return this.bos;
		if (slot === SLOT_WORD) return this.vocab.find(word);
		return NONE;
	}

	followersOf(v: number): Followers | undefined {
		const slot = this.ctxSlot[v];
		return slot === NONE ? undefined : this.followers[slot];
	}

	webSlotOf(v: number): number {
		if (v === this.bos) return this.web.slot(this.web.length);
		const wid = this.webId[v];
		return wid === NONE ? NO_SLOT : this.web.slot(wid);
	}

	pairOf(u: number, v: number): number {
		const pair = this.pairs.get(u, v);
		return pair === undefined ? NONE : pair;
	}

	pairTotal(pair: number): number {
		return this.pairTotals[pair];
	}

	pairTypes(pair: number): number {
		return this.pairTypeCounts[pair];
	}

	triCount(pair: number, w: number): number {
		const count = this.tri.get(pair, w);
		return count === undefined ? 0 : count;
	}

	pairCount(): number {
		return this.pairs.size;
	}

	trigramCount(): number {
		return this.tri.size;
	}

	sessionRange(prefix: string, visit: (id: number, count: number) => void): void {
		this.session.range(prefix, this.vocab, visit);
	}

	learnedWords(): number {
		const count = this.count;
		const n = this.vocab.length;
		let learned = 0;
		for (let id = 0; id < n; id++) {
			if (count[id] > 0) learned += 1;
		}
		return learned;
	}

	private reserve(needed: number): void {
		const have = this.count.length;
		if (needed <= have) return;
		const capacity = Math.max(needed, Math.floor(have * 1.5));
		const count = new Float32Array(capacity);
		count.set(this.count);
		this.count = count;
		const raw = new Uint32Array(capacity);
		raw.set(this.raw);
		this.raw = raw;
		const webId = new Uint32Array(capacity).fill(NONE, have);
		webId.set(this.webId);
		this.webId = webId;
		const flags = new Uint8Array(capacity);
		flags.set(this.flags);
		this.flags = flags;
		const ctxSlot = new Uint32Array(capacity).fill(NONE, have);
		ctxSlot.set(this.ctxSlot);
		this.ctxSlot = ctxSlot;
	}

	private intern(word: string): number {
		const vocab = this.vocab;
		const id = vocab.intern(word);
		if (vocab.fresh) {
			this.reserve(id + 1);
			this.count[id] = 0;
			this.raw[id] = 0;
			this.webId[id] = NONE;
			this.flags[id] = this.web.trusted(word, -1) ? TRUSTED : 0;
			this.ctxSlot[id] = NONE;
			this.linkSlips(id);
		}
		return id;
	}

	/**
	 * Prompts must be restored oldest first.
	 */
	restoreSession(prompts: number[][]): void {
		const session = new Session();
		for (const prompt of prompts) session.push(prompt, this.params.sessionPrompts);
		this.session = session;
	}

	private linkSlips(id: number): void {
		const wordChars = codePoints(this.vocab.word(id));
		if (wordChars + 1 < HYGIENE_MIN_CHARS) return;
		const trusted = this.trusted(id);
		if (!trusted && wordChars < HYGIENE_MIN_CHARS) return;
		const found = this.collectSlips(id);
		for (const other of found) {
			if (trusted) {
				if (!this.trusted(other) && codePoints(this.vocab.word(other)) >= HYGIENE_MIN_CHARS) {
					this.flags[id] |= WATCH;
				}
			} else if (this.trusted(other)) {
				this.flags[other] |= WATCH;
			}
		}
	}

	private collectSlips(id: number): number[] {
		this.found.length = 0;
		forEachSlip(this.vocab.word(id), this.visitSlip);
		return this.found;
	}

	private refreshShadow(id: number): void {
		const found = this.collectSlips(id);
		const floor = Math.max(this.raw[id] / 3, 3);
		let hit = false;
		for (const other of found) {
			if (this.trusted(other)) {
				if (this.raw[other] >= floor) hit = true;
				this.flags[other] |= WATCH;
			}
		}
		if (hit) this.flags[id] |= SHADOWED;
		else this.flags[id] &= ~SHADOWED;
	}

	private touchHygiene(id: number): void {
		if (!this.params.canonicalize) return;
		const flags = this.flags[id];
		if ((flags & TRUSTED) === 0) {
			if (codePoints(this.vocab.word(id)) >= HYGIENE_MIN_CHARS) this.refreshShadow(id);
			return;
		}
		if ((flags & WATCH) === 0) return;
		const neighbours = this.collectSlips(id).filter(
			(other) =>
				!this.trusted(other) &&
				this.raw[other] > 0 &&
				codePoints(this.vocab.word(other)) >= HYGIENE_MIN_CHARS,
		);
		for (const other of neighbours) this.refreshShadow(other);
	}

	sweepHygiene(): void {
		const n = this.vocab.length;
		const flags = this.flags;
		for (let id = 0; id < n; id++) flags[id] &= TRUSTED;
		if (!this.params.canonicalize) return;
		for (let id = 0; id < n; id++) {
			if (
				(flags[id] & TRUSTED) === 0 &&
				this.raw[id] > 0 &&
				codePoints(this.vocab.word(id)) >= HYGIENE_MIN_CHARS
			) {
				this.refreshShadow(id);
			}
		}
	}

	private canonical(id: number): number {
		const params = this.params;
		const word = this.vocab.word(id);
		if (!params.canonicalize || this.trusted(id) || codePoints(word) < HYGIENE_MIN_CHARS) return id;
		const raw = this.raw[id] + 1;
		const allowWeb = this.raw[id] < params.canonMaxCount;
		const ratio = params.canonRatio;
		const vocab = this.vocab;
		const raws = this.raw;
		const webId = this.webId;
		const flags = this.flags;
		const webCount = this.web.count;
		let best = id;
		let bestScore = 0;
		forEachNeighbour(word, (candidate) => {
			const other = vocab.find(candidate);
			if (other === NONE) return;
			const otherRaw = raws[other];
			const trusted = (flags[other] & TRUSTED) !== 0;
			const wid = webId[other];
			const count = wid === NONE ? 0 : webCount[wid];
			let score: number;
			if (otherRaw > 0) {
				if (otherRaw < ratio * raw || (!trusted && otherRaw < 10)) return;
				score = otherRaw * 1e12 + count;
			} else {
				if (!allowWeb || wid === NONE || !trusted) return;
				score = count;
			}
			if (score > bestScore) {
				bestScore = score;
				best = other;
			}
		});
		return best;
	}

	learn(prompt: string): void {
		this.version += 1;
		const words = proseWords(prompt);
		if (words.length === 0) return;
		const typed = isTypedLike(prompt);
		const learnable = typed || isLearnable(prompt);
		const weight = typed ? 1 : Math.fround(this.params.pasteWeight);
		if (!(weight > 0)) return;
		this.folds.length = 0;
		const session: number[] = [];
		for (const word of words) {
			const surface = prompt.slice(word.start, word.end);
			const context = contextBefore(prompt, word.start, this.context);
			// Intern `u` before `v` to preserve word ID order.
			const uid = this.eventContext(context.u, context.uWord);
			const vid = this.eventContext(context.v, context.vWord);

			const original = this.intern(lowercase(surface));
			const target = learnable ? this.canonical(original) : original;
			if (target !== original) this.folds.push(original, target);
			this.add(uid, vid, surface, target, weight);
			if (learnable) {
				this.raw[target] += 1;
				this.touchHygiene(target);
				if (target !== original) {
					this.raw[original] += 1;
					this.touchHygiene(original);
				}
				session.push(target);
			}
		}
		if (learnable) this.session.push(session, this.params.sessionPrompts);
		if (this.vocab.overflowLength >= COMPACT_AT) this.compact();
	}

	private eventContext(slot: Slot, word: string): number {
		if (slot === SLOT_BOS) return this.bos;
		if (slot !== SLOT_WORD) return NONE;
		const id = this.intern(word);
		const folds = this.folds;
		for (let i = 0; i < folds.length; i += 2) {
			if (folds[i] === id) return folds[i + 1];
		}
		return id;
	}

	private add(u: number, v: number, surface: string, w: number, weight: number): void {
		this.count[w] += weight;
		this.total += weight;
		if (w < this.vocab.baseLength) {
			this.fen.add(w, weight);
			this.tree.set(w, this.count[w] + this.params.mu1 * this.p0(w));
		}
		this.addTail(w, surface, weight);
		if (v === NONE) return;
		let slot = this.ctxSlot[v];
		if (slot === NONE) {
			slot = this.followers.length;
			this.followers.push(new Followers());
			this.ctxSlot[v] = slot;
		}
		this.followers[slot].add(w, weight);
		if (u === NONE) return;
		const pairs = this.pairs;
		const pairAt = pairs.entry(u, v);
		if (pairs.fresh) {
			pairs.values[pairAt] = this.pairTotals.length;
			this.pairTotals.push(0);
			this.pairTypeCounts.push(0);
		}
		const pair = pairs.values[pairAt];
		const tri = this.tri;
		const triAt = tri.entry(pair, w);
		tri.values[triAt] += weight;
		if (tri.fresh) this.pairTypeCounts[pair] += 1;
		this.pairTotals[pair] = Math.fround(this.pairTotals[pair] + weight);
	}

	private addTail(w: number, surface: string, weight: number): void {
		const tail = caseTail(surface);
		const word = this.vocab.word(w);
		// Final sigma needs surrounding characters when lowercasing.
		if (tail === word || codePoints(tail) !== codePoints(word) || tail.toLowerCase() !== word) return;
		let tails = this.tails.get(w);
		if (tails === undefined) {
			tails = [];
			this.tails.set(w, tails);
		}
		for (const entry of tails) {
			if (entry.form === tail) {
				entry.n = Math.fround(entry.n + weight);
				return;
			}
		}
		tails.push({ form: tail, n: weight });
	}

	compact(): void {
		const oldBase = this.vocab.baseLength;
		const { vocab, remap } = this.vocab.compacted();
		const n = vocab.length;
		const capacity = n + ID_HEADROOM;
		const count = new Float32Array(capacity);
		const raw = new Uint32Array(capacity);
		const webId = new Uint32Array(capacity).fill(NONE);
		const flags = new Uint8Array(capacity);
		const ctxSlot = new Uint32Array(capacity).fill(NONE);
		for (let old = 0; old < remap.length; old++) {
			const id = remap[old];
			count[id] = this.count[old];
			raw[id] = this.raw[old];
			webId[id] = this.webId[old];
			flags[id] = this.flags[old];
			ctxSlot[id] = this.ctxSlot[old];
		}
		this.count = count;
		this.raw = raw;
		this.webId = webId;
		this.flags = flags;
		this.ctxSlot = ctxSlot;
		const webToId = this.webToId;
		for (let w = 0; w < webToId.length; w++) {
			if (webToId[w] !== NONE) webToId[w] = remap[webToId[w]];
		}
		this.bos = remap[this.bos];

		// Remapped base IDs must stay in order for this merge.
		const order: number[] = [];
		for (const list of this.followers) {
			const ids = list.ids;
			const counts = list.counts;
			const split = list.lowerBound(oldBase);
			if (split === ids.length) {
				for (let i = 0; i < split; i++) ids[i] = remap[ids[i]];
				continue;
			}
			order.length = 0;
			for (let i = split; i < ids.length; i++) order.push(i);
			order.sort((x, y) => remap[ids[x]] - remap[ids[y]]);
			const nextIds: number[] = new Array(ids.length);
			const nextCounts: number[] = new Array(ids.length);
			let a = 0;
			let b = 0;
			for (let out = 0; out < nextIds.length; out++) {
				const takeBase = b === order.length || (a < split && remap[ids[a]] < remap[ids[order[b]]]);
				const from = takeBase ? a++ : order[b++];
				nextIds[out] = remap[ids[from]];
				nextCounts[out] = counts[from];
			}
			list.ids = nextIds;
			list.counts = nextCounts;
		}

		const pairs = new IdTable(makeU32, this.pairs.size);
		this.pairs.forEach((u, v, pair) => {
			const at = pairs.entry(remap[u], remap[v]);
			pairs.values[at] = pair;
		});
		this.pairs = pairs;
		const tri = new IdTable(makeF32, this.tri.size);
		this.tri.forEach((pair, w, triCount) => {
			const at = tri.entry(pair, remap[w]);
			tri.values[at] = triCount;
		});
		this.tri = tri;
		const tails = new Map<number, CaseTail[]>();
		for (const [id, forms] of this.tails) tails.set(remap[id], forms);
		this.tails = tails;
		this.vocab = vocab;
		this.session.remap(remap);
		this.rebuildRanges();
		this.version += 1;
	}

	pruneTrigrams(): void {
		const renumber = new Uint32Array(this.pairTotals.length).fill(NONE);
		const totals: number[] = [];
		const types: number[] = [];
		let kept = 0;
		this.tri.forEach((_pair, _w, triCount) => {
			if (triCount >= 1) kept += 1;
		});
		const tri = new IdTable(makeF32, kept);
		this.tri.forEach((pair, w, triCount) => {
			if (!(triCount >= 1)) return;
			if (renumber[pair] === NONE) {
				renumber[pair] = totals.length;
				totals.push(this.pairTotals[pair]);
				types.push(this.pairTypeCounts[pair]);
			}
			const at = tri.entry(renumber[pair], w);
			tri.values[at] = triCount;
		});
		this.tri = tri;
		this.pairTotals = totals;
		this.pairTypeCounts = types;
		const pairs = new IdTable(makeU32, totals.length);
		this.pairs.forEach((u, v, pair) => {
			if (renumber[pair] === NONE) return;
			const at = pairs.entry(u, v);
			pairs.values[at] = renumber[pair];
		});
		this.pairs = pairs;
		this.version += 1;
	}

	caseProb(id: number, tailPrefix: string, plain: boolean, prior: number): number {
		const count = this.count[id];
		let other = 0;
		let compatible = 0;
		const tails = this.tails.get(id);
		if (tails !== undefined) {
			for (const tail of tails) {
				other += tail.n;
				if (tail.form.startsWith(tailPrefix)) compatible += tail.n;
			}
		}
		if (plain) compatible += count - other;
		const a = this.params.caseStrength;
		return (compatible + a * prior) / (count + a);
	}

	suffix(id: number, typed: string, tailPrefix: string): string {
		const word = this.vocab.word(id);
		const k = codePoints(typed);
		const headEnd = codePointOffset(word, k);
		let best: string | undefined = tailPrefix === word.slice(0, headEnd) ? word : undefined;
		let bestCount = best !== undefined ? this.count[id] : 0;
		const tails = this.tails.get(id);
		if (tails !== undefined) {
			if (best !== undefined) {
				let sum = 0;
				for (const tail of tails) sum += tail.n;
				bestCount -= sum;
			}
			for (const tail of tails) {
				if (tail.n > bestCount && tail.form.startsWith(tailPrefix)) {
					best = tail.form;
					bestCount = tail.n;
				}
			}
		}
		if (best !== undefined) return best.slice(codePointOffset(best, k));
		return plainSuffix(word.slice(headEnd), typed, k);
	}
}

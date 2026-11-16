/**
 * Counts, the interpolated chain's state, hygiene flags, and learning.
 * Port of oh-my-pi `crates/pi-predict/src/ngram/model.rs` (MIT).
 *
 * Probability chain (interpolated absolute discounting; `mu` adds a
 * Dirichlet-style floor so tiny contexts don't trust one observation),
 * evaluated by `interp` in `query.ts`:
 *
 *   p0(w)      = web unigram share                                  (static)
 *   p1(w)      = (c(w) + mu1·p0(w)) / (N + mu1)                      personal unigram, web prior
 *   q2(w|v)    = λw·pw(w|v) + (1 − λw·S(v))·p1(w)                    web bigram prior, S = covered mass
 *   p2(w|v)    = (max(c(vw) − d2, 0) + (d2·T(v) + mu2)·q2) / (c(v) + mu2)
 *   p3(w|u,v)  = (max(c(uvw) − d3, 0) + (d3·T(uv) + mu3)·p2) / (c(uv) + mu3)
 *
 * Every level is linear in its lower level, so the mass of all words under a
 * prefix follows the same recursion from range sums.
 *
 * Numeric types mirror upstream: word counts, follower counts, pair totals,
 * trigram counts, case-tail counts and the tree scores are `f32` (typed arrays
 * or `Math.fround` on every store); `total` and the Fenwick sums are `f64`.
 *
 * Loaded by Node's type stripping (worker / CLI): erasable syntax only.
 */
import { forEachNeighbour, forEachSlip } from "./hygiene.ts";
import { isLearnable, isTypedLike, proseWords } from "./prose.ts";
import { Fenwick, Followers, IdTable, MaxTree, NONE, cmpWords } from "./structures.ts";
import { BOS, SLOT_BOS, SLOT_NONE, SLOT_WORD, caseTail, codePoints, contextBefore, lowercase } from "./text.ts";
import type { Context, Slot } from "./text.ts";
import { Vocab } from "./vocab.ts";
import { NO_SLOT } from "./web.ts";
import type { WebPrior } from "./web.ts";

/** Tuning knobs of the n-gram engine. `DEFAULT_PARAMS` is upstream's operating point. */
export interface Params {
	/** Weight of prompts that don't look typed (pastes, logs, long dumps); an `f32`. */
	pasteWeight: number;
	/** Dirichlet strength of the web unigram prior (in history tokens). */
	mu1: number;
	/** Bigram discount. */
	d2: number;
	/** Bigram floor. */
	mu2: number;
	/** Trigram discount. */
	d3: number;
	/** Trigram floor. */
	mu3: number;
	/** Weight of the web bigram prior (0 disables it). */
	webBigram: number;
	/** Unigram candidates pulled from the range top-k tree. */
	topK: number;
	/** Occurrences in typed prompts before a word outside the web vocabulary and the dictionary is suggested. */
	minCount: number;
	/** Fold rare misspellings into a real edit-distance-1 neighbour. */
	canonicalize: boolean;
	/** Below this many occurrences a misspelling may fold into a web word. */
	canonMaxCount: number;
	/** A personal neighbour must be typed this many times as often to absorb a spelling. */
	canonRatio: number;
	/** Prior that a word is typed with plain (lowercase) casing. */
	casePrior: number;
	/** Pseudo-count of the case prior. */
	caseStrength: number;
	/** Prompt-local cache weight λ (0 disables it). */
	cacheWeight: number;
	/** Distance (UTF-8 bytes) at which a prompt-local occurrence weighs 1/e. */
	cacheDecay: number;
	/** Extra cache weight (×(1 + boost)) after the same previous word. */
	cacheContextBoost: number;
	/** UTF-8 bytes of the text before the cursor the prompt-local cache scans. */
	cacheWindow: number;
	/** Session cache weight σ per occurrence (0 disables it). */
	sessionWeight: number;
	/** Recent prompts in the session cache. */
	sessionPrompts: number;
	/** Show threshold τ: the minimum confidence of a ghost, at every prefix length; an `f32`. */
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

/** Flag: a real spelling (dictionary or frequent web word). */
const TRUSTED = 1;
/** Flag: a habitual slip of a real word the user types; never suggested. */
const SHADOWED = 2;
/** Flag: some misspelling in the vocabulary is one slip away from this word. */
const WATCH = 4;

/** Words shorter than this (in code points) are never folded or shadowed. */
const HYGIENE_MIN_CHARS = 5;
/** Overflow size that triggers folding new words into the sorted base. */
const COMPACT_AT = 4096;
/** Spare per-id slots allocated beyond the vocabulary (two compaction rounds). */
const ID_HEADROOM = 2 * COMPACT_AT;

const ALPHABETIC = /\p{Alphabetic}/u;
const LOWERCASE = /\p{Lowercase}/u;

/** A non-plain case tail of a word (`aPI`, `pRs`) with its `f32` count. */
export interface CaseTail {
	form: string;
	n: number;
}

/** UTF-16 offset of code point `k` of `text` (its length when shorter). */
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
 * Lowercase remainder `rest` of a word after `typed` (`k` code points),
 * uppercased when the typed prefix is ALLCAPS.
 */
export function plainSuffix(rest: string, typed: string, k: number): string {
	if (k >= 2 && ALPHABETIC.test(typed) && !LOWERCASE.test(typed)) return rest.toUpperCase();
	return rest;
}

/** Recent-prompt word counts (a topic cache). */
export class Session {
	/** Word ids of each recent prompt, oldest first. */
	prompts: number[][] = [];
	private counts = new Map<number, number>();
	/** Ids and their counts sorted by word; rebuilt lazily (only `range` reads them). */
	private sortedIds: number[] = [];
	private sortedCounts: number[] = [];
	private stale = false;

	/** Add one prompt's words and evict beyond `capacity` prompts. */
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

	/** Visit `(id, count)` of the session words starting with `prefix`, in word order. */
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
		// The words starting with `prefix` are contiguous from `lo`.
		let end = lo;
		while (end < ids.length && vocab.word(ids[end]).startsWith(prefix)) end += 1;
		const counts = this.sortedCounts;
		for (let at = lo; at < end; at++) visit(ids[at], counts[at]);
	}

	/** Renumber every id after a vocabulary compaction. */
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

/** The learned model plus its static web prior. */
export class Model {
	readonly params: Params;
	readonly web: WebPrior;
	vocab: Vocab;
	/** Weighted history count per id (`f32`). The per-id arrays are longer than the vocabulary. */
	count: Float32Array;
	/** Occurrences of the spelling in typed prompts (hygiene). */
	raw: Uint32Array;
	/** Web id per id (`NONE` outside the web vocabulary). */
	webId: Uint32Array;
	private flags: Uint8Array;
	/** Follower-list index per context id (`NONE` = no followers). */
	ctxSlot: Uint32Array;
	followers: Followers[] = [];
	/** Sum of weighted counts (`f64`). */
	total = 0;
	/** Vocabulary id per web id. */
	webToId: Uint32Array;
	private fen: Fenwick;
	private tree: MaxTree;
	/** Trigram contexts: `(u, v)` → pair index. */
	pairs: IdTable<Uint32Array>;
	/** Weighted count per pair index (`f32` values). */
	pairTotals: number[] = [];
	/** Distinct trigram words per pair index. */
	pairTypeCounts: number[] = [];
	/** Trigram counts keyed `(pair, w)`. */
	tri: IdTable<Float32Array>;
	/** Non-plain case tails per id, in first-seen order (the first form wins equal counts). */
	tails = new Map<number, CaseTail[]>();
	session = new Session();
	/** Id of the sentence-start pseudo-word. */
	bos: number;
	/** Bumped by every learned-state change (invalidates query memos). */
	version = 0;

	// Learning scratch.
	private readonly found: number[] = [];
	/** Spellings folded in the current prompt: `original id, canonical id` pairs, flat. */
	private readonly folds: number[] = [];
	private readonly context: Context = { u: SLOT_NONE, v: SLOT_NONE, uWord: "", vWord: "" };
	private readonly visitSlip = (candidate: string): void => {
		const other = this.vocab.find(candidate);
		if (other !== NONE && !this.found.includes(other)) this.found.push(other);
	};

	/**
	 * Fresh model: the web vocabulary plus the sentence-start word (and
	 * `extra`, see `withWords`).
	 */
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

	/**
	 * Model with no learned state whose sorted base holds the web vocabulary,
	 * the sentence-start word, and `extra` (any order, repeats allowed).
	 */
	static withWords(params: Params, web: WebPrior, extra: string[]): Model {
		return new Model(params, web, extra);
	}

	/** Weighted history count of `id` (`f32`). */
	countOf(id: number): number {
		return this.count[id];
	}

	/** Occurrences of `id` in typed (learnable) prompts. */
	rawOf(id: number): number {
		return this.raw[id];
	}

	/** Web unigram share of `id`. */
	p0(id: number): number {
		const wid = this.webId[id];
		return wid === NONE ? 0 : this.web.p0[wid];
	}

	/** Rebuild the Fenwick and max trees over the sorted base. */
	rebuildRanges(): void {
		const base = this.vocab.baseLength;
		const count = this.count;
		this.fen = new Fenwick(count, base);
		const mu1 = this.params.mu1;
		const scores = new Float32Array(base);
		for (let i = 0; i < base; i++) scores[i] = count[i] + mu1 * this.p0(i);
		this.tree = new MaxTree(scores, base);
	}

	/** Unigram prefix sum over base ids `[lo, hi)`. */
	countSum(lo: number, hi: number): number {
		return this.fen.prefix(hi) - this.fen.prefix(lo);
	}

	/** Append the top-`k` base ids of `[lo, hi)` by `count + mu1·p0` to `out`. */
	topK(lo: number, hi: number, k: number, out: number[]): void {
		this.tree.topK(lo, hi, k, out);
	}

	trusted(id: number): boolean {
		return (this.flags[id] & TRUSTED) !== 0;
	}

	/**
	 * May `id` be suggested? Real spellings always; habitual slips never;
	 * words unknown to the web need `minCount` typed occurrences.
	 */
	eligible(id: number): boolean {
		const flags = this.flags[id];
		return (
			(flags & TRUSTED) !== 0 ||
			((flags & SHADOWED) === 0 && (this.webId[id] !== NONE || this.raw[id] >= this.params.minCount))
		);
	}

	/** Id of a context slot (`SLOT_BOS` → bos, `SLOT_WORD` → vocab.find), or NONE. */
	resolve(slot: Slot, word: string): number {
		if (slot === SLOT_BOS) return this.bos;
		if (slot === SLOT_WORD) return this.vocab.find(word);
		return NONE;
	}

	/** Follower list of context `v`. */
	followersOf(v: number): Followers | undefined {
		const slot = this.ctxSlot[v];
		return slot === NONE ? undefined : this.followers[slot];
	}

	/** Web bigram slot of context `v`. */
	webSlotOf(v: number): number {
		if (v === this.bos) return this.web.slot(this.web.length);
		const wid = this.webId[v];
		return wid === NONE ? NO_SLOT : this.web.slot(wid);
	}

	/** Pair index of context (u, v), or NONE. */
	pairOf(u: number, v: number): number {
		const pair = this.pairs.get(u, v);
		return pair === undefined ? NONE : pair;
	}

	/** Weighted count of pair index `pair` (`f32`). */
	pairTotal(pair: number): number {
		return this.pairTotals[pair];
	}

	/** Distinct trigram words seen after pair index `pair`. */
	pairTypes(pair: number): number {
		return this.pairTypeCounts[pair];
	}

	/** Trigram count, 0 when absent. */
	triCount(pair: number, w: number): number {
		const count = this.tri.get(pair, w);
		return count === undefined ? 0 : count;
	}

	/** Number of trigram contexts (status only). */
	pairCount(): number {
		return this.pairs.size;
	}

	/** Number of trigrams (status only). */
	trigramCount(): number {
		return this.tri.size;
	}

	/** Session words starting with `prefix`, in word order. */
	sessionRange(prefix: string, visit: (id: number, count: number) => void): void {
		this.session.range(prefix, this.vocab, visit);
	}

	/** Words with a learned count (status only). */
	learnedWords(): number {
		const count = this.count;
		const n = this.vocab.length;
		let learned = 0;
		for (let id = 0; id < n; id++) {
			if (count[id] > 0) learned += 1;
		}
		return learned;
	}

	/** Grow the per-id arrays to hold `needed` ids. */
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

	/** Refill the session cache from restored prompts (oldest first). */
	restoreSession(prompts: number[][]): void {
		const session = new Session();
		for (const prompt of prompts) session.push(prompt, this.params.sessionPrompts);
		this.session = session;
	}

	/**
	 * Maintain WATCH for a new word: a misspelling marks the real words one
	 * slip away; a real word marks itself when a misspelling is.
	 */
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

	/** Ids of the vocabulary words one slip away from `id` (the shared scratch list). */
	private collectSlips(id: number): number[] {
		this.found.length = 0;
		forEachSlip(this.vocab.word(id), this.visitSlip);
		return this.found;
	}

	/**
	 * Recompute SHADOWED for the misspelling `id`: one slip away from a real
	 * word the user types at least 3 times and at least a third as often.
	 */
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

	/** Hygiene upkeep after `id`'s typed count changed. */
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

	/** Recompute every hygiene flag (after a restore). */
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

	/**
	 * The real spelling a rare misspelling should count toward: a personal
	 * word typed `canonRatio`× as often (and trusted or typed ≥ 10×), or,
	 * while the spelling is still rare, a trusted web word.
	 */
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

	/** Learn one submitted prompt. */
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
			// `u` before `v`: interning a new context word assigns its id.
			const context = contextBefore(prompt, word.start, this.context);
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

	/**
	 * Context id for a learning event; words folded earlier in this prompt map
	 * to their canonical spelling.
	 */
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

	/** Count one word with its left context (`u`, `v`: ids or NONE). */
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

	/** Record the casing of `surface` when it is a non-plain form of `w`. */
	private addTail(w: number, surface: string, weight: number): void {
		const tail = caseTail(surface);
		const word = this.vocab.word(w);
		// Whole-string lowercasing here (Rust `str::to_lowercase`), unlike everywhere else.
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

	/** Fold overflow words into the sorted base and renumber every table. */
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

		// Follower lists stay sorted by id: base ids keep their relative order,
		// so only the overflow tail needs sorting before the two runs merge.
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

	/**
	 * Drop trigrams seen only in pastes (weighted count below 1) and the
	 * contexts left without trigrams; their `p3` is a constant multiple of
	 * `p2`, so posteriors keep their order. Surviving contexts keep their
	 * unpruned totals.
	 */
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

	/**
	 * P(typed case tail | word): share of the word's occurrences whose tail is
	 * compatible with how the prefix was typed, smoothed toward `prior`.
	 */
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

	/**
	 * Surface suffix of `id` after `typed`: the most frequent seen form
	 * compatible with the typed case, else the lowercase rest (uppercased when
	 * the prefix is ALLCAPS).
	 */
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

/**
 * Completion: prefix-constrained ranking with the prompt-local and session
 * caches and the finished-word-aware posterior.
 *
 * Port of oh-my-pi `crates/pi-predict/src/ngram/query.rs` (MIT).
 *
 * For prefix `p` after context `(u, v)`, with `s(w) = p3(w|u,v)·P(case|w)`
 * and `M = Σ s(x)` over every word `x` under the prefix, **including the
 * prefix itself** when it is a word:
 *
 *   post(w)  = s(w) / M
 *   final(w) = (post(w) + λ·cache(w) + σ·session(w)) / (1 + λ·C + σ·S)
 *
 * `cache(w)` sums `exp(−distance/D)` over occurrences of `w` earlier in the
 * prompt (×(1 + b) after the same previous word) and `session(w)` counts `w`
 * in the last prompts; `C` / `S` are their totals under the prefix. The
 * confidence of the best word is `final(best)`.
 *
 * Every score is a ratio over the words under the prefix, so typing another
 * letter of the shown word (in the same case) removes competitors but never
 * reorders the ones that remain: a ghost stays put while the user types
 * through it.
 *
 * Units: string offsets are UTF-16 code units where upstream has UTF-8
 * bytes; the cache distance and the cache window are UTF-8 bytes as
 * upstream (they are observable), prefix lengths are code points. Arithmetic
 * is written in upstream's order; the candidates' `c2` / `pw` / `c3` are
 * `f32` as upstream stores them. Candidate enumeration order decides exact
 * ties and is upstream's.
 *
 * Loaded by Node's type stripping (worker and CLI): erasable syntax only.
 */
import type { Model } from "./model.ts";
import { plainSuffix } from "./model.ts";
import { isWordChar } from "./prose.ts";
import type { Followers } from "./structures.ts";
import { NONE } from "./structures.ts";
import type { Context } from "./text.ts";
import { caseTail, codePoints, contextBefore, lowercase, lowercaseAligned, SLOT_NONE, SLOT_WORD } from "./text.ts";
import { NO_SLOT } from "./web.ts";

/** One row of the candidate table of a query (`QueryState.explain`), in enumeration order. */
export interface CandidateRow {
	word: string;
	/** `final(w)`, also for candidates that cannot be offered. */
	value: number;
	c2: number;
	pw: number;
	c3: number;
	cache: number;
	session: number;
	/** False for the prefix itself and for ineligible words without cache weight. */
	offered: boolean;
	/** The candidate `complete` picks. */
	picked: boolean;
}

const U32_MAX = 0xffff_ffff;
const NON_ASCII = /[^\x00-\x7f]/;

/** `P_web(id | slot)` for vocabulary id `id`, 0 when the slot has no such follower. */
function webProb(model: Model, slot: number, id: number): number {
	// Web ids and the base ids they map to are both in word order, so the
	// rows of a slot are ascending in vocabulary id as well.
	const web = model.web;
	const toId = model.webToId;
	const follower = web.follower;
	const rows = web.rows(slot);
	const end = rows[1];
	let lo = rows[0];
	let hi = end;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (toId[follower[mid]] < id) lo = mid + 1;
		else hi = mid;
	}
	return lo < end && toId[follower[lo]] === id ? web.prob[lo] : 0;
}

/**
 * Start (UTF-16 offset) of the longest suffix of `text` that is at most
 * `maxBytes` UTF-8 bytes and starts on a character boundary.
 */
function windowStart(text: string, maxBytes: number): number {
	const n = text.length;
	// A UTF-16 unit is at most 3 UTF-8 bytes.
	if (n * 3 <= maxBytes) return 0;
	let at = n;
	let bytes = 0;
	while (at > 0) {
		const c = text.charCodeAt(at - 1);
		let units = 1;
		let size = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
		if (c >= 0xdc00 && c <= 0xdfff && at >= 2) {
			const high = text.charCodeAt(at - 2);
			if (high >= 0xd800 && high <= 0xdbff) {
				units = 2;
				size = 4;
			}
		}
		if (bytes + size > maxBytes) break;
		bytes += size;
		at -= units;
	}
	return at;
}

/** Code point ending at UTF-16 offset `end` (> 0) of `text`. */
function codePointBefore(text: string, end: number): number {
	const low = text.charCodeAt(end - 1);
	if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
		const high = text.charCodeAt(end - 2);
		if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x1_0000;
	}
	return low;
}

/** `text` without its first `k` code points. */
function skipCodePoints(text: string, k: number): string {
	let at = 0;
	for (let i = 0; i < k && at < text.length; i++) at += text.codePointAt(at)! > 0xffff ? 2 : 1;
	return text.slice(at);
}

/** `next` (larger, zeroed) with the contents of `old` copied in. */
function grown<A extends Uint32Array | Float32Array | Float64Array>(old: A, next: A): A {
	next.set(old);
	return next;
}

/** Query-local state reused across the prefixes of one word. */
export class QueryState {
	// Memo: the model, its version and the `before` the fields below were built for.
	private model: Model | undefined = undefined;
	private version = -1;
	private before = "";
	/** Left context of the word being completed. */
	private readonly context: Context = { u: SLOT_NONE, v: SLOT_NONE, uWord: "", vWord: "" };
	/**
	 * Lowercased tail of `before` scanned by the prompt-local cache; offsets
	 * match `before.slice(windowAt)`.
	 */
	private window = "";
	private windowAt = 0;
	/** UTF-8 length of `window`. */
	private windowBytes = 0;
	/** UTF-8 offset of every unit index of `window`; unused while the window is ASCII. */
	private bytePos: Uint32Array = new Uint32Array(0);
	private windowAscii = true;

	// Context statistics of the current query (upstream `Ctx`).
	private followers: Followers | undefined = undefined;
	private cv = 0;
	private tv = 0;
	private pair = NONE;
	private cuv = 0;
	private tuv = 0;
	private webSlot = NO_SLOT;
	private webS = 0;

	// Candidates, struct of arrays. `id` is a vocabulary id, or NONE for a word
	// seen only earlier in this prompt, which is identified by its window span.
	private count = 0;
	private id: Uint32Array = new Uint32Array(64);
	private spanStart: Uint32Array = new Uint32Array(64);
	private spanEnd: Uint32Array = new Uint32Array(64);
	private c2: Float32Array = new Float32Array(64);
	private pw: Float32Array = new Float32Array(64);
	private c3: Float32Array = new Float32Array(64);
	private cache: Float64Array = new Float64Array(64);
	private session: Float64Array = new Float64Array(64);
	/** Case-weighted chain score `s(w)`. */
	private score: Float64Array = new Float64Array(64);

	// Scratch.
	/** `stamp[id] === epoch` marks a vocabulary word that is a candidate; `slot[id]` is its index. */
	private stamp: Uint32Array = new Uint32Array(0);
	private slot: Uint32Array = new Uint32Array(0);
	private epoch = 0;
	private readonly top: number[] = [];
	private readonly seen: Context = { u: SLOT_NONE, v: SLOT_NONE, uWord: "", vWord: "" };
	/** Case tail of the typed prefix. */
	private tail = "";

	// Results of the last `rank`.
	private bestValue = 0;
	private caseMass = 0;
	private norm = 1;

	// Arguments of the session visitor (kept in fields so `rank` allocates no closure).
	private rankModel: Model | undefined = undefined;
	private rankKey = "";
	private sessionMass = 0;
	private readonly visitSession = (id: number, count: number): void => {
		const model = this.rankModel!;
		this.sessionMass += count;
		const known = this.stamp[id] === this.epoch;
		if (known || (model.eligible(id) && model.vocab.word(id) !== this.rankKey)) {
			// Index first: `lookup` may reallocate the candidate arrays.
			const at = this.lookup(model, id);
			this.session[at] = count;
		}
	};

	/** Best completion and its ungated f64 confidence, or null. Never changes `model`. */
	complete(model: Model, before: string, prefix: string): { suffix: string; confidence: number } | null {
		const key = lowercase(prefix);
		const k = codePoints(prefix);
		if (k === 0 || codePoints(key) !== k) return null;
		this.load(model, before);
		const best = this.rank(model, key, prefix);
		if (best < 0) return null;
		const suffix = this.suffix(model, best, prefix, key, k);
		return suffix.length === 0 ? null : { suffix, confidence: this.bestValue };
	}

	/**
	 * The candidate table `complete` ranks for this query, in enumeration
	 * order (diagnostics for the replay CLI). Empty when the prefix is not
	 * answered at all.
	 */
	explain(model: Model, before: string, prefix: string): CandidateRow[] {
		const rows: CandidateRow[] = [];
		const key = lowercase(prefix);
		const k = codePoints(prefix);
		if (k === 0 || codePoints(key) !== k) return rows;
		this.load(model, before);
		const best = this.rank(model, key, prefix);
		const p = model.params;
		for (let i = 0; i < this.count; i++) {
			const id = this.id[i];
			const word = id === NONE ? this.window.slice(this.spanStart[i], this.spanEnd[i]) : model.vocab.word(id);
			const post = this.caseMass > 0 ? this.score[i] / this.caseMass : 0;
			const value = (post + p.cacheWeight * this.cache[i] + p.sessionWeight * this.session[i]) / this.norm;
			const offered = word.length !== key.length && (id === NONE || this.cache[i] !== 0 || model.eligible(id));
			rows.push({
				word,
				value,
				c2: this.c2[i],
				pw: this.pw[i],
				c3: this.c3[i],
				cache: this.cache[i],
				session: this.session[i],
				offered,
				picked: i === best,
			});
		}
		return rows;
	}

	/**
	 * Prepare the per-`before` state (context, cache window) unless the memo
	 * already holds it.
	 */
	private load(model: Model, before: string): void {
		if (this.model === model && this.version === model.version && this.before === before) return;
		this.model = model;
		this.version = model.version;
		this.before = before;
		contextBefore(before, before.length, this.context);
		const at = windowStart(before, model.params.cacheWindow);
		this.windowAt = at;
		this.window = model.params.cacheWeight > 0 ? lowercaseAligned(at === 0 ? before : before.slice(at)) : "";
		this.measureWindow();
		const words = model.vocab.length;
		if (this.stamp.length < words) {
			// Headroom: the vocabulary grows by a few words per learned prompt.
			// Fresh zeroes are fine, stamps never outlive a query.
			const size = words + 8192;
			this.stamp = new Uint32Array(size);
			this.slot = new Uint32Array(size);
		}
	}

	/** UTF-8 offsets of the window: the cache decays with byte distance. */
	private measureWindow(): void {
		const window = this.window;
		const n = window.length;
		this.windowAscii = !NON_ASCII.test(window);
		if (this.windowAscii) {
			this.windowBytes = n;
			return;
		}
		if (this.bytePos.length < n + 1) this.bytePos = new Uint32Array(n + 1 + (n >> 2));
		const pos = this.bytePos;
		let bytes = 0;
		for (let i = 0; i < n; i++) {
			pos[i] = bytes;
			const c = window.charCodeAt(i);
			if (c < 0x80) bytes += 1;
			else if (c < 0x800) bytes += 2;
			else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n && (window.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
				// A surrogate pair is 4 bytes, attributed to the high surrogate.
				bytes += 4;
				i++;
				pos[i] = bytes;
			} else bytes += 3;
		}
		pos[n] = bytes;
		this.windowBytes = bytes;
	}

	private suffix(model: Model, best: number, typed: string, key: string, k: number): string {
		const id = this.id[best];
		if (id !== NONE) return model.suffix(id, typed, this.tail);
		// A word seen only earlier in this prompt: prefer the casing it had where it was typed.
		const start = this.spanStart[best];
		const end = this.spanEnd[best];
		const form = caseTail(this.before.slice(start + this.windowAt, end + this.windowAt));
		if (form.startsWith(this.tail)) return skipCodePoints(form, k);
		const word = this.window.slice(start, end);
		return plainSuffix(word.slice(Math.min(key.length, word.length)), typed, k);
	}

	private contextStats(model: Model): void {
		const p = model.params;
		const context = this.context;
		const vid = model.resolve(context.v, context.vWord);
		const followers = vid === NONE ? undefined : model.followersOf(vid);
		let pair = NONE;
		if (vid !== NONE) {
			const uid = model.resolve(context.u, context.uWord);
			if (uid !== NONE) pair = model.pairOf(uid, vid);
		}
		const webSlot = vid !== NONE && p.webBigram > 0 ? model.webSlotOf(vid) : NO_SLOT;
		this.followers = followers;
		this.cv = followers ? followers.total : 0;
		this.tv = followers ? followers.types : 0;
		this.pair = pair;
		this.cuv = pair === NONE ? 0 : model.pairTotal(pair);
		this.tuv = pair === NONE ? 0 : model.pairTypes(pair);
		this.webSlot = webSlot;
		this.webS = webSlot === NO_SLOT ? 0 : model.web.covered[webSlot] * p.webBigram;
	}

	/** Index of a new, zeroed candidate. */
	private push(id: number): number {
		const at = this.count;
		if (at === this.id.length) this.grow();
		this.count = at + 1;
		this.id[at] = id;
		this.spanStart[at] = 0;
		this.spanEnd[at] = 0;
		this.c2[at] = 0;
		this.pw[at] = 0;
		this.c3[at] = 0;
		this.cache[at] = 0;
		this.session[at] = 0;
		this.score[at] = 0;
		return at;
	}

	private grow(): void {
		const size = this.id.length * 2;
		this.id = grown(this.id, new Uint32Array(size));
		this.spanStart = grown(this.spanStart, new Uint32Array(size));
		this.spanEnd = grown(this.spanEnd, new Uint32Array(size));
		this.c2 = grown(this.c2, new Float32Array(size));
		this.pw = grown(this.pw, new Float32Array(size));
		this.c3 = grown(this.c3, new Float32Array(size));
		this.cache = grown(this.cache, new Float64Array(size));
		this.session = grown(this.session, new Float64Array(size));
		this.score = grown(this.score, new Float64Array(size));
	}

	/** Push (or find) the candidate for vocabulary word `id` with known bigram evidence. */
	private candidate(model: Model, id: number, c2: number, pw: number): number {
		if (this.stamp[id] === this.epoch) return this.slot[id];
		const at = this.push(id);
		this.c2[at] = c2;
		this.pw[at] = pw;
		// The trigram count matters only on top of a bigram count.
		this.c3[at] = this.pair !== NONE && c2 > 0 ? model.triCount(this.pair, id) : 0;
		this.stamp[id] = this.epoch;
		this.slot[id] = at;
		return at;
	}

	/** Push (or find) the candidate for vocabulary word `id`, looking its bigram evidence up. */
	private lookup(model: Model, id: number): number {
		if (this.stamp[id] === this.epoch) return this.slot[id];
		const c2 = this.followers ? this.followers.count(id) : 0;
		const pw = this.webSlot === NO_SLOT ? 0 : webProb(model, this.webSlot, id);
		return this.candidate(model, id, c2, pw);
	}

	private nextEpoch(): void {
		this.epoch = (this.epoch + 1) >>> 0;
		if (this.epoch === 0) {
			this.stamp.fill(0);
			this.epoch = 1;
		}
		this.count = 0;
	}

	/**
	 * Rank the completions of lowercase `key` (typed as `typed`). Returns the
	 * index of the picked candidate (its confidence in `bestValue`), or -1.
	 */
	private rank(model: Model, key: string, typed: string): number {
		const p = model.params;
		const vocab = model.vocab;
		const web = model.web;
		this.nextEpoch();
		this.contextStats(model);
		const [lo, hi] = vocab.baseRange(key);
		const [wlo, whi] = web.words.range(key);

		// Merge-join the history and web followers of `v` inside the prefix range.
		let disc2 = 0;
		let sumPw = 0;
		let disc3 = 0;
		const followers = this.followers;
		let a = 0;
		let aEnd = 0;
		if (followers) {
			a = followers.lowerBound(lo);
			aEnd = followers.lowerBound(hi);
		}
		let b = 0;
		let bEnd = 0;
		if (this.webSlot !== NO_SLOT) {
			b = web.lowerRow(this.webSlot, wlo);
			bEnd = web.lowerRow(this.webSlot, whi);
		}
		const webToId = model.webToId;
		while (a < aEnd || b < bEnd) {
			const ida = a < aEnd ? followers!.ids[a] : U32_MAX;
			const idb = b < bEnd ? webToId[web.follower[b]] : U32_MAX;
			const id = ida < idb ? ida : idb;
			let c2 = 0;
			let pw = 0;
			if (ida === id) c2 = followers!.counts[a++];
			if (idb === id) pw = web.prob[b++];
			const at = this.candidate(model, id, c2, pw);
			disc2 += Math.max(c2 - p.d2, 0);
			sumPw += pw;
			disc3 += Math.max(this.c3[at] - p.d3, 0);
		}
		// Overflow followers are not in lexicographic id order: filter by text.
		if (followers) {
			const ids = followers.ids;
			for (let at = followers.lowerBound(vocab.baseLength); at < ids.length; at++) {
				const id = ids[at];
				if (!vocab.word(id).startsWith(key)) continue;
				const c2 = followers.counts[at];
				const slot = this.candidate(model, id, c2, 0);
				disc2 += Math.max(c2 - p.d2, 0);
				disc3 += Math.max(this.c3[slot] - p.d3, 0);
			}
		}
		// Unigram candidates: range top-k over base ids plus every overflow match.
		const top = this.top;
		top.length = 0;
		model.topK(lo, hi, p.topK, top);
		for (let i = 0; i < top.length; i++) this.lookup(model, top[i]);
		let sumC1 = model.countSum(lo, hi);
		const overflow = vocab.overflowRange(key);
		for (let i = 0; i < overflow.length; i++) {
			const id = overflow[i];
			sumC1 += model.countOf(id);
			this.lookup(model, id);
		}
		const sumP0 = web.p0Cum[whi] - web.p0Cum[wlo];
		const mass = this.interp(model, sumC1, sumP0, sumPw, disc2, disc3);

		// Prompt-local cache and session cache.
		const cacheMass = p.cacheWeight > 0 ? this.scanCache(model, key) : 0;
		this.sessionMass = 0;
		if (p.sessionWeight > 0) {
			this.rankModel = model;
			this.rankKey = key;
			model.sessionRange(key, this.visitSession);
			this.rankModel = undefined;
		}
		const sessionMass = this.sessionMass;

		// Score with the case channel; adjust the mass for it.
		const tail = caseTail(typed);
		this.tail = tail;
		const plain = tail === key;
		const prior = plain ? p.casePrior : 1 - p.casePrior;
		let caseMass = prior * mass;
		let scoreSum = 0;
		const count = this.count;
		for (let i = 0; i < count; i++) {
			const id = this.id[i];
			if (id === NONE) continue;
			const raw = this.interp(
				model,
				model.countOf(id),
				model.p0(id),
				this.pw[i],
				Math.max(this.c2[i] - p.d2, 0),
				Math.max(this.c3[i] - p.d3, 0),
			);
			const caseP = model.caseProb(id, tail, plain, prior);
			caseMass += raw * (caseP - prior);
			const score = raw * caseP;
			this.score[i] = score;
			scoreSum += score;
		}
		caseMass = Math.max(caseMass, scoreSum);
		const norm = 1 + p.cacheWeight * cacheMass + p.sessionWeight * sessionMass;
		this.caseMass = caseMass;
		this.norm = norm;
		let best = -1;
		let bestValue = 0;
		for (let i = 0; i < count; i++) {
			const post = caseMass > 0 ? this.score[i] / caseMass : 0;
			const value = (post + p.cacheWeight * this.cache[i] + p.sessionWeight * this.session[i]) / norm;
			const id = this.id[i];
			const length = id === NONE ? this.spanEnd[i] - this.spanStart[i] : vocab.word(id).length;
			// The prefix itself holds mass but is never offered.
			if (length === key.length) continue;
			// Hygiene: misspellings and one-off junk are never offered unless
			// they were typed earlier in this prompt.
			if (id !== NONE && this.cache[i] === 0 && !model.eligible(id)) continue;
			// Strictly greater: the first candidate in enumeration order wins a tie.
			if (value > bestValue) {
				best = i;
				bestValue = value;
			}
		}
		this.bestValue = bestValue;
		return best;
	}

	/**
	 * Prompt-local cache: words in the window that extend `key` (or equal
	 * it), weighted `exp(−distance / D)`, ×(1 + boost) after the same
	 * previous word as the query. Returns the total weight.
	 */
	private scanCache(model: Model, key: string): number {
		const p = model.params;
		const window = this.window;
		const n = window.length;
		const keyLength = key.length;
		// Units of the last character of `key`.
		const lastUnits = keyLength >= 2 && codePointBefore(key, keyLength) > 0xffff ? 2 : 1;
		const context = this.context;
		const seen = this.seen;
		let mass = 0;
		let limit = n;
		while (limit >= keyLength) {
			// Last occurrence of `key` inside `window[0, limit)`.
			const idx = window.lastIndexOf(key, limit - keyLength);
			if (idx < 0) break;
			const boundary = idx === 0 || !isWordChar(codePointBefore(window, idx));
			if (boundary) {
				// The word runs to the next non-word character (a space past the end).
				let end = idx + keyLength;
				let next = 0x20;
				while (end < n) {
					const c = window.codePointAt(end)!;
					if (!isWordChar(c)) {
						next = c;
						break;
					}
					end += c > 0xffff ? 2 : 1;
				}
				// Skip identifiers (`foo_bar`, `v2`).
				const identifier = next === 0x5f || (next >= 0x30 && next <= 0x39);
				while (end > idx + keyLength && window.charCodeAt(end - 1) === 0x27) end--;
				if (!identifier) {
					const distance = this.windowBytes - (this.windowAscii ? idx : this.bytePos[idx]);
					let weight = Math.exp(-distance / p.cacheDecay);
					if (p.cacheContextBoost > 0 && context.v !== SLOT_NONE) {
						contextBefore(window, idx, seen);
						const same = seen.v === context.v && (seen.v !== SLOT_WORD || seen.vWord === context.vWord);
						if (same) weight *= 1 + p.cacheContextBoost;
					}
					mass += weight;
					if (end - idx > keyLength) {
						const id = model.vocab.find(window.slice(idx, end));
						if (id !== NONE) {
							const at = this.lookup(model, id);
							this.cache[at] += weight;
						} else {
							const at = this.findLocal(idx, end);
							if (at >= 0) {
								this.cache[at] += weight;
							} else {
								const fresh = this.push(NONE);
								this.spanStart[fresh] = idx;
								this.spanEnd[fresh] = end;
								this.cache[fresh] = weight;
							}
						}
					}
				}
			}
			if (idx === 0) break;
			// Up to the last character of this occurrence, so overlapping occurrences are found.
			limit = idx + keyLength - lastUnits;
		}
		return mass;
	}

	/** Index of the cache-only candidate spelled like `window[start, end)`, or -1. */
	private findLocal(start: number, end: number): number {
		const window = this.window;
		const length = end - start;
		for (let i = 0; i < this.count; i++) {
			if (this.id[i] !== NONE || this.spanEnd[i] - this.spanStart[i] !== length) continue;
			const from = this.spanStart[i];
			let same = true;
			for (let j = 0; j < length; j++) {
				if (window.charCodeAt(from + j) !== window.charCodeAt(start + j)) {
					same = false;
					break;
				}
			}
			if (same) return i;
		}
		return -1;
	}

	/**
	 * The probability chain, fed either one word's counts or prefix sums of them:
	 *
	 *   p1 = (c1 + mu1·p0) / (total + mu1)
	 *   q2 = no web slot ? p1 : webBigram·pw + (1 − webS)·p1
	 *   p2 = cv  > 0 ? (disc2 + (d2·tv  + mu2)·q2) / (cv  + mu2) : q2
	 *   p3 = cuv > 0 ? (disc3 + (d3·tuv + mu3)·p2) / (cuv + mu3) : p2
	 */
	private interp(model: Model, c1: number, p0: number, pw: number, disc2: number, disc3: number): number {
		const p = model.params;
		const p1 = (c1 + p.mu1 * p0) / (model.total + p.mu1);
		const q2 = this.webSlot === NO_SLOT ? p1 : p.webBigram * pw + (1 - this.webS) * p1;
		const p2 = this.cv > 0 ? (disc2 + (p.d2 * this.tv + p.mu2) * q2) / (this.cv + p.mu2) : q2;
		return this.cuv > 0 ? (disc3 + (p.d3 * this.tuv + p.mu3) * p2) / (this.cuv + p.mu3) : p2;
	}
}

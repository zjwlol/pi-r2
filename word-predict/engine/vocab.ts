/**
 * Word <-> id interning with lexicographic base ids.
 * Port of oh-my-pi `crates/pi-predict/src/ngram/vocab.rs` (MIT).
 *
 * Ids `< baseLength` are byte-order ranks, so a prefix is one contiguous id
 * range. Words interned later get appended "overflow" ids, kept in a sorted
 * side list so prefix lookups stay binary searches; `compacted()` folds them
 * back into the sorted base. The split is observable (overflow words under a
 * prefix are all candidates, base words only through the top-k tree), so
 * nothing here may reorder or merge the two regions on its own.
 *
 * Loaded by Node's type stripping (worker / CLI): erasable syntax only.
 */
import { NONE, cmpWords } from "./structures.ts";

const NO_OVERFLOW: number[] = [];

/** Interned words with a `Map` index (upstream: an open-addressing string index). */
export class Vocab {
	/** Whether the last `intern` call added its word. */
	fresh = false;
	/** Word per id. */
	private readonly words: string[];
	/** Number of sorted base words. */
	private base: number;
	/** Overflow ids sorted by word. */
	private readonly overflow: number[] = [];
	private readonly index: Map<string, number>;

	private constructor(words: string[]) {
		this.words = words;
		this.base = words.length;
		const index = new Map<string, number>();
		for (let id = 0; id < words.length; id++) index.set(words[id], id);
		this.index = index;
	}

	/** Vocabulary whose base is `words` (byte order, deduplicated); takes ownership of the array. */
	static fromSorted(words: string[]): Vocab {
		return new Vocab(words);
	}

	/** Number of words. */
	get length(): number {
		return this.words.length;
	}

	/** Number of sorted base words. */
	get baseLength(): number {
		return this.base;
	}

	/** Number of overflow words. */
	get overflowLength(): number {
		return this.overflow.length;
	}

	/** Word of `id`. */
	word(id: number): string {
		return this.words[id];
	}

	/** Id of `word`, or NONE. */
	find(word: string): number {
		const id = this.index.get(word);
		return id === undefined ? NONE : id;
	}

	/** Id of `word`, appended to the overflow region when new; `fresh` tells whether it was. */
	intern(word: string): number {
		const known = this.index.get(word);
		if (known !== undefined) {
			this.fresh = false;
			return known;
		}
		const words = this.words;
		const overflow = this.overflow;
		const id = words.length;
		words.push(word);
		this.index.set(word, id);
		let lo = 0;
		let hi = overflow.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (cmpWords(words[overflow[mid]], word) < 0) lo = mid + 1;
			else hi = mid;
		}
		overflow.splice(lo, 0, id);
		this.fresh = true;
		return id;
	}

	/** Base id range `[lo, hi)` of the words starting with `prefix`. */
	baseRange(prefix: string): [lo: number, hi: number] {
		const words = this.words;
		let lo = 0;
		let hi = this.base;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (cmpWords(words[mid], prefix) < 0) lo = mid + 1;
			else hi = mid;
		}
		// Words starting with `prefix` are contiguous from `lo`.
		let a = lo;
		let b = this.base;
		while (a < b) {
			const mid = (a + b) >>> 1;
			if (words[mid].startsWith(prefix)) a = mid + 1;
			else b = mid;
		}
		return [lo, a];
	}

	/** Overflow ids of the words starting with `prefix`, in word order. Do not modify the result. */
	overflowRange(prefix: string): number[] {
		const words = this.words;
		const overflow = this.overflow;
		if (overflow.length === 0) return NO_OVERFLOW;
		let lo = 0;
		let hi = overflow.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (cmpWords(words[overflow[mid]], prefix) < 0) lo = mid + 1;
			else hi = mid;
		}
		let a = lo;
		let b = overflow.length;
		while (a < b) {
			const mid = (a + b) >>> 1;
			if (words[overflow[mid]].startsWith(prefix)) a = mid + 1;
			else b = mid;
		}
		return a === lo ? NO_OVERFLOW : overflow.slice(lo, a);
	}

	/**
	 * This vocabulary with every word in the sorted base, plus the
	 * old-id -> new-id map.
	 */
	compacted(): { vocab: Vocab; remap: Uint32Array } {
		const words = this.words;
		const overflow = this.overflow;
		const base = this.base;
		const remap = new Uint32Array(words.length);
		const merged: string[] = new Array(words.length);
		let a = 0;
		let b = 0;
		let next = 0;
		while (a < base || b < overflow.length) {
			const takeBase = b === overflow.length || (a < base && cmpWords(words[a], words[overflow[b]]) < 0);
			const old = takeBase ? a++ : overflow[b++];
			remap[old] = next;
			merged[next] = words[old];
			next += 1;
		}
		return { vocab: new Vocab(merged), remap };
	}
}

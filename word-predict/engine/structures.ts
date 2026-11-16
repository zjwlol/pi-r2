/**
 * Data structures behind prefix-constrained ranking.
 * Port of oh-my-pi `crates/pi-predict/src/ngram/structures.rs` (MIT).
 *
 * Base word ids are lexicographic ranks, so "every word starting with `prefix`"
 * is one contiguous id range `[lo, hi)`. Range sums (`Fenwick`), range top-k
 * (`MaxTree`) and id-sorted follower lists (`Followers`) then answer prefix
 * queries in O(log n) without per-prefix tables.
 *
 * Loaded by Node's type stripping (worker / CLI): erasable syntax only.
 */

/** No id / no slot (`u32::MAX`). */
export const NONE = 0xffff_ffff;

/**
 * Order of two words by their UTF-8 bytes (= code-point order), which is the
 * order of every sorted word list in the engine. JS `<` compares UTF-16 units
 * and disagrees for astral characters versus U+E000–U+FFFF.
 */
export function cmpWords(a: string, b: string): number {
	const n = a.length < b.length ? a.length : b.length;
	for (let i = 0; i < n; i++) {
		let x = a.charCodeAt(i);
		let y = b.charCodeAt(i);
		if (x !== y) {
			if (x >= 0xd800 && y >= 0xd800) {
				// Surrogates (astral characters) sort above U+E000–U+FFFF.
				x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
				y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
			}
			return x < y ? -1 : 1;
		}
	}
	return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Fenwick tree of `f64` counts over base ids (prefix sums with point updates). */
export class Fenwick {
	private readonly tree: Float64Array;

	/** Build over `values[0, length)` in O(n). */
	constructor(values: ArrayLike<number>, length: number) {
		const tree = new Float64Array(length + 1);
		for (let i = 0; i < length; i++) tree[i + 1] = values[i];
		for (let i = 1; i <= length; i++) {
			const parent = i + (i & -i);
			if (parent <= length) tree[parent] += tree[i];
		}
		this.tree = tree;
	}

	/** Add `delta` at `index`. */
	add(index: number, delta: number): void {
		const tree = this.tree;
		for (let j = index + 1; j < tree.length; j += j & -j) tree[j] += delta;
	}

	/** Sum over `[0, end)`. */
	prefix(end: number): number {
		const tree = this.tree;
		let sum = 0;
		for (let j = end; j > 0; j -= j & -j) sum += tree[j];
		return sum;
	}
}

const NO_LEAF = 0xffff_ffff;

/** Max segment tree over base ids: point updates and top-k inside a range. */
export class MaxTree {
	/** `f32` score per leaf (the array passed in; the tree owns it). */
	private readonly values: Float32Array;
	private readonly size: number;
	/** Leaf id holding each subtree's max (`NO_LEAF` when empty). */
	private readonly best: Uint32Array;
	/** Scratch binary heap of tree nodes for `topK`. */
	private readonly heap: number[] = [];

	/** Build over `scores[0, length)` in O(n). */
	constructor(scores: Float32Array, length: number) {
		let size = 1;
		while (size < length) size *= 2;
		const best = new Uint32Array(2 * size).fill(NO_LEAF);
		for (let i = 0; i < length; i++) best[size + i] = i;
		this.values = scores;
		this.size = size;
		this.best = best;
		for (let node = size - 1; node >= 1; node--) best[node] = this.pick(best[2 * node], best[2 * node + 1]);
	}

	/** The better of two leaves: the right one wins only when strictly greater. */
	private pick(a: number, b: number): number {
		if (a === NO_LEAF) return b;
		if (b === NO_LEAF) return a;
		return this.values[b] > this.values[a] ? b : a;
	}

	/** Set leaf `index` to `score` (rounded to `f32`). */
	set(index: number, score: number): void {
		this.values[index] = score;
		const best = this.best;
		for (let node = (index + this.size) >>> 1; node >= 1; node >>>= 1) {
			best[node] = this.pick(best[2 * node], best[2 * node + 1]);
		}
	}

	private key(node: number): number {
		return this.values[this.best[node]];
	}

	/**
	 * Append up to `k` ids of `[lo, hi)` to `out`, best first: best-first
	 * expansion from the O(log n) canonical nodes covering the range. Equal
	 * scores come out in the order upstream's heap gives them.
	 */
	topK(lo: number, hi: number, k: number, out: number[]): void {
		if (lo >= hi || k === 0) return;
		const heap = this.heap;
		heap.length = 0;
		let l = lo + this.size;
		let r = hi + this.size;
		while (l < r) {
			if (l & 1) {
				this.push(l);
				l += 1;
			}
			if (r & 1) {
				r -= 1;
				this.push(r);
			}
			l >>>= 1;
			r >>>= 1;
		}
		let emitted = 0;
		while (emitted < k && heap.length > 0) {
			const node = this.pop();
			if (node >= this.size) {
				out.push(node - this.size);
				emitted += 1;
			} else {
				this.push(2 * node);
				this.push(2 * node + 1);
			}
		}
	}

	private push(node: number): void {
		if (this.best[node] === NO_LEAF) return;
		const heap = this.heap;
		const value = this.key(node);
		let i = heap.length;
		heap.push(node);
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (this.key(heap[parent]) >= value) break;
			heap[i] = heap[parent];
			i = parent;
		}
		heap[i] = node;
	}

	/** Remove and return the best node; the heap must not be empty. */
	private pop(): number {
		const heap = this.heap;
		const top = heap[0];
		const last = heap.pop() as number;
		if (heap.length === 0) return top;
		const value = this.key(last);
		let i = 0;
		for (;;) {
			let child = 2 * i + 1;
			if (child >= heap.length) break;
			if (child + 1 < heap.length && this.key(heap[child + 1]) > this.key(heap[child])) child += 1;
			if (this.key(heap[child]) <= value) break;
			heap[i] = heap[child];
			i = child;
		}
		heap[i] = last;
		return top;
	}
}

/**
 * Growable follower list of one context word, sorted by word id so a prefix
 * maps to a contiguous slice (overflow ids sit at the tail).
 */
export class Followers {
	/** Follower word ids, ascending. */
	ids: number[] = [];
	/** Weighted counts (`f32` values), parallel to `ids`. */
	counts: number[] = [];
	/** Sum of the weights added (`f64`). */
	total = 0;

	/** Number of distinct followers. */
	get types(): number {
		return this.ids.length;
	}

	/** First index whose id is `>= id`. */
	lowerBound(id: number): number {
		const ids = this.ids;
		let lo = 0;
		let hi = ids.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (ids[mid] < id) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	/** Add `weight` to `id`; true when `id` is a new follower. */
	add(id: number, weight: number): boolean {
		const at = this.lowerBound(id);
		this.total += weight;
		if (at < this.ids.length && this.ids[at] === id) {
			this.counts[at] = Math.fround(this.counts[at] + weight);
			return false;
		}
		if (at === this.ids.length) {
			this.ids.push(id);
			this.counts.push(weight);
		} else {
			this.ids.splice(at, 0, id);
			this.counts.splice(at, 0, weight);
		}
		return true;
	}

	/** Count of `id` (0 when absent). */
	count(id: number): number {
		const at = this.lowerBound(id);
		return at < this.ids.length && this.ids[at] === id ? this.counts[at] : 0;
	}
}

const EMPTY_HALF = 0xffff_ffff;

/**
 * Open-addressing hash table from a 64-bit key, held as two `u32` halves, to
 * a `u32` or `f32` value (linear probing, load <= 3/4, no deletion: rebuild to
 * prune). Upstream packs the key into one `u64`; iteration order differs from
 * upstream's and is not observable.
 */
export class IdTable<A extends Uint32Array | Float32Array> {
	/** Values by slot; replaced when the table grows. */
	values: A;
	/** Whether the last `entry` call inserted its key. */
	fresh = false;
	private readonly make: (slots: number) => A;
	private hi: Uint32Array;
	private lo: Uint32Array;
	private mask: number;
	private count = 0;

	/** Table sized for about `capacity` entries; `make` allocates a zeroed value array. */
	constructor(make: (slots: number) => A, capacity: number) {
		let slots = 16;
		while (slots * 3 < capacity * 4) slots *= 2;
		this.make = make;
		this.hi = new Uint32Array(slots).fill(EMPTY_HALF);
		this.lo = new Uint32Array(slots).fill(EMPTY_HALF);
		this.values = make(slots);
		this.mask = slots - 1;
	}

	/** Number of stored keys. */
	get size(): number {
		return this.count;
	}

	/** Slot holding `(hi, lo)`, or the empty slot where it would go. */
	private slot(hi: number, lo: number): number {
		const his = this.hi;
		const los = this.lo;
		const mask = this.mask;
		let h = Math.imul(hi ^ 0x9e3779b9, 0x85ebca6b);
		h ^= h >>> 13;
		h = Math.imul(h ^ lo, 0xc2b2ae35);
		h ^= h >>> 16;
		h = Math.imul(h, 0x27d4eb2f);
		h ^= h >>> 15;
		let at = h & mask;
		for (;;) {
			const storedHi = his[at];
			const storedLo = los[at];
			if (storedHi === hi && storedLo === lo) return at;
			if (storedHi === EMPTY_HALF && storedLo === EMPTY_HALF) return at;
			at = (at + 1) & mask;
		}
	}

	/** Value stored at `(hi, lo)`. */
	get(hi: number, lo: number): number | undefined {
		const at = this.slot(hi, lo);
		return this.hi[at] === hi && this.lo[at] === lo ? this.values[at] : undefined;
	}

	/**
	 * Slot of `(hi, lo)` in `values`, inserting 0 when absent; `fresh` tells
	 * whether it was inserted. Valid until the next `entry`. An insert may
	 * replace `values`: call this first, then index `values` in a separate
	 * statement (never `table.values[table.entry(…)] = …`).
	 */
	entry(hi: number, lo: number): number {
		let at = this.slot(hi, lo);
		const fresh = this.hi[at] !== hi || this.lo[at] !== lo;
		if (fresh) {
			if ((this.count + 1) * 4 > (this.mask + 1) * 3) {
				this.grow();
				at = this.slot(hi, lo);
			}
			this.hi[at] = hi;
			this.lo[at] = lo;
			this.values[at] = 0;
			this.count += 1;
		}
		this.fresh = fresh;
		return at;
	}

	/** Every `(hi, lo, value)`, in slot order. */
	forEach(visit: (hi: number, lo: number, value: number) => void): void {
		const his = this.hi;
		const los = this.lo;
		const values = this.values;
		for (let at = 0; at < his.length; at++) {
			if (his[at] !== EMPTY_HALF || los[at] !== EMPTY_HALF) visit(his[at], los[at], values[at]);
		}
	}

	private grow(): void {
		const his = this.hi;
		const los = this.lo;
		const values = this.values;
		const slots = his.length * 2;
		this.hi = new Uint32Array(slots).fill(EMPTY_HALF);
		this.lo = new Uint32Array(slots).fill(EMPTY_HALF);
		this.values = this.make(slots);
		this.mask = slots - 1;
		for (let old = 0; old < his.length; old++) {
			if (his[old] === EMPTY_HALF && los[old] === EMPTY_HALF) continue;
			const at = this.slot(his[old], los[old]);
			this.hi[at] = his[old];
			this.lo[at] = los[old];
			this.values[at] = values[old];
		}
	}
}

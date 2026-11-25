import { NONE, cmpWords } from "./structures.ts";

const NO_OVERFLOW: number[] = [];

export class Vocab {
	fresh = false;
	private readonly words: string[];
	private base: number;
	private readonly overflow: number[] = [];
	private readonly index: Map<string, number>;

	private constructor(words: string[]) {
		this.words = words;
		this.base = words.length;
		const index = new Map<string, number>();
		for (let id = 0; id < words.length; id++) index.set(words[id], id);
		this.index = index;
	}

	static fromSorted(words: string[]): Vocab {
		return new Vocab(words);
	}

	get length(): number {
		return this.words.length;
	}

	get baseLength(): number {
		return this.base;
	}

	get overflowLength(): number {
		return this.overflow.length;
	}

	word(id: number): string {
		return this.words[id];
	}

	find(word: string): number {
		const id = this.index.get(word);
		return id === undefined ? NONE : id;
	}

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

	baseRange(prefix: string): [lo: number, hi: number] {
		const words = this.words;
		let lo = 0;
		let hi = this.base;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (cmpWords(words[mid], prefix) < 0) lo = mid + 1;
			else hi = mid;
		}
		let a = lo;
		let b = this.base;
		while (a < b) {
			const mid = (a + b) >>> 1;
			if (words[mid].startsWith(prefix)) a = mid + 1;
			else b = mid;
		}
		return [lo, a];
	}

	/**
	 * Do not mutate the shared empty result.
	 */
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

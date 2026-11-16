/**
 * Spelling-edit enumeration for vocabulary hygiene: which learned spellings
 * are typing slips of real words.
 *
 * Port of oh-my-pi `crates/pi-predict/src/ngram/hygiene.rs` (MIT). Edits are
 * over code points; candidates are visited in upstream's order.
 *
 * Loaded by Node's type stripping (worker and CLI): erasable syntax only.
 */

/** `a`-`z`, the letters substituted and inserted. */
const ALPHABET: readonly string[] = Array.from({ length: 26 }, (_, i) => String.fromCharCode(0x61 + i));

/**
 * Split `word` into code points: fills `chars` and their UTF-16 `offsets`
 * (`offsets[n]` is the word's length) and returns the count `n`.
 */
function split(word: string, chars: string[], offsets: number[]): number {
	let n = 0;
	for (let at = 0; at < word.length; n++) {
		const units = word.codePointAt(at)! > 0xffff ? 2 : 1;
		chars[n] = units === 1 ? word[at] : word.slice(at, at + 2);
		offsets[n] = at;
		at += units;
	}
	offsets[n] = word.length;
	return n;
}

/**
 * Visit the Damerau edit-distance-1 neighbours of `word` that look like
 * typing slips: deletes, adjacent transposes, substitutions and inserts over
 * `a`-`z`, except
 * - edits of the final character (`subagents`/`subagent`,
 *   `truncates`/`truncated` are inflections);
 * - edits of the first character other than a transposition (`gcloud`/`cloud`,
 *   `oauth`/`auth` are distinct words);
 * - edits touching an apostrophe (`we're`/`were`, `don't`/`dont`).
 */
export function forEachNeighbour(word: string, visit: (candidate: string) => void): void {
	const chars: string[] = [];
	const offsets: number[] = [];
	const n = split(word, chars, offsets);
	for (let i = 0; i < n - 1; i++) {
		const c = chars[i];
		const next = chars[i + 1];
		const head = word.slice(0, offsets[i]);
		if (i > 0 && c !== "'") visit(head + word.slice(offsets[i + 1]));
		if (c !== next && c !== "'" && next !== "'") visit(head + next + c + word.slice(offsets[i + 2]));
	}
	for (let i = 1; i < n - 1; i++) {
		const c = chars[i];
		if (c === "'") continue;
		const head = word.slice(0, offsets[i]);
		const tail = word.slice(offsets[i + 1]);
		for (const letter of ALPHABET) {
			if (letter !== c) visit(head + letter + tail);
		}
	}
	for (let i = 1; i < n; i++) {
		const head = word.slice(0, offsets[i]);
		const tail = word.slice(offsets[i]);
		for (const letter of ALPHABET) visit(head + letter + tail);
	}
}

/**
 * Visit the unmistakable slips among `forEachNeighbour`'s edits: adjacent
 * transpositions (`isntead`, `proeprly`) and doubled/undoubled inner letters
 * (`cannonical`, `comit`). Unlike substitutions these rarely turn one real
 * word or jargon term into another (`serde`/`serve`), so they are safe to act
 * on even when the variant is typed often. The relation is symmetric: `b` is
 * a slip of `a` iff `a` is a slip of `b`.
 */
export function forEachSlip(word: string, visit: (candidate: string) => void): void {
	const chars: string[] = [];
	const offsets: number[] = [];
	const n = split(word, chars, offsets);
	for (let i = 0; i < n - 1; i++) {
		const c = chars[i];
		const next = chars[i + 1];
		if (c !== next && c !== "'" && next !== "'") {
			visit(word.slice(0, offsets[i]) + next + c + word.slice(offsets[i + 2]));
		}
		// Undouble a pair touching neither end (`uutils`, `sshot` are names).
		if (c === next && i > 0 && i + 2 < n) visit(word.slice(0, offsets[i]) + word.slice(offsets[i + 1]));
	}
	// Double a letter that is neither the first nor the last.
	for (let i = 1; i < n - 1; i++) {
		if (chars[i] !== "'") visit(word.slice(0, offsets[i + 1]) + word.slice(offsets[i]));
	}
}

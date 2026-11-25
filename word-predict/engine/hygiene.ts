const ALPHABET: readonly string[] = Array.from({ length: 26 }, (_, i) => String.fromCharCode(0x61 + i));

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
		if (c === next && i > 0 && i + 2 < n) visit(word.slice(0, offsets[i]) + word.slice(offsets[i + 1]));
	}
	for (let i = 1; i < n - 1; i++) {
		if (chars[i] !== "'") visit(word.slice(0, offsets[i + 1]) + word.slice(offsets[i]));
	}
}

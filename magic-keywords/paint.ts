import { foregroundAnsi, okhslColor, type TerminalColorMode } from "@earendil-works/pi-tui";
import { keywordRegex, type MagicKeyword, maskNonProse } from "./keywords.ts";

const STOPS = 24;
const WORD_SPAN = 0.5;

const ESC_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_P^][\s\S]*?(?:\x07|\x1b\\)|[\s\S])/y;
const SGR_RESET_RE = /^\x1b\[0*m$/;

const patterns = new Map<string, RegExp>();
const palettes = new Map<string, string[]>();

export interface PaintOptions {
	mode: TerminalColorMode;
	appearance: "dark" | "light";
	/**
	 * Phase is a fraction of one cycle.
	 */
	phase?: number;
}

function palette(keyword: MagicKeyword, mode: TerminalColorMode, appearance: "dark" | "light"): string[] {
	const key = `${keyword.id}\0${mode}\0${appearance}`;
	let colors = palettes.get(key);
	if (!colors) {
		const [from, to] = keyword.hue;
		const lightness = appearance === "light" ? 0.52 : 0.74;
		colors = [];
		for (let i = 0; i < STOPS; i++) {
			const t = i / STOPS;
			const tri = t < 0.5 ? t * 2 : 2 - t * 2;
			const hue = (((from + tri * (to - from)) % 360) + 360) % 360;
			colors.push(foregroundAnsi(okhslColor(hue, 0.9, lightness), mode));
		}
		palettes.set(key, colors);
	}
	return colors;
}

function patternFor(word: string): RegExp {
	let p = patterns.get(word);
	if (!p) {
		p = keywordRegex(word, "g");
		patterns.set(word, p);
	}
	return p;
}

function restoreAt(line: string, pos: number): string {
	let active = "";
	for (let i = line.indexOf("\x1b"); i >= 0 && i < pos; i = line.indexOf("\x1b", i + 1)) {
		ESC_RE.lastIndex = i;
		const m = ESC_RE.exec(line);
		if (!m) continue;
		const seq = m[0];
		if (seq.startsWith("\x1b[") && seq.endsWith("m")) active = SGR_RESET_RE.test(seq) ? "" : active + seq;
		i += seq.length - 1;
	}
	return `\x1b[39m${active}`;
}

interface ParsedLine {
	plain: string;
	map: number[];
}

function parseLine(line: string): ParsedLine {
	let plain = "";
	const map: number[] = [];
	for (let i = 0; i < line.length; ) {
		if (line.charCodeAt(i) === 0x1b) {
			ESC_RE.lastIndex = i;
			const m = ESC_RE.exec(line);
			if (m) {
				i += m[0].length;
				continue;
			}
		}
		map.push(i);
		plain += line[i];
		i++;
	}
	return { plain, map };
}

export function paintLines(
	lines: readonly string[],
	source: string,
	keywords: readonly MagicKeyword[],
	options: PaintOptions,
): string[] {
	const relevant = keywords.filter((k) => lines.some((line) => line.includes(k.word[0]!)));
	if (relevant.length === 0) return [...lines];

	const parsed = lines.map(parseLine);
	const masked = maskNonProse(source);
	const phase = (((options.phase ?? 0) % 1) + 1) % 1;
	const inserts: { at: number; text: string }[][] = lines.map(() => []);

	for (const keyword of relevant) {
		const pattern = patternFor(keyword.word);
		// Match against the source because rendered Markdown can omit backticks.
		const prose = [...source.matchAll(pattern)].map(
			(m) => masked.slice(m.index, m.index + m[0].length) === m[0],
		);
		const found: { line: number; start: number; len: number }[] = [];
		parsed.forEach(({ plain }, line) => {
			if (!plain.includes(keyword.word)) return;
			for (const m of plain.matchAll(pattern)) found.push({ line, start: m.index, len: m[0].length });
		});
		const aligned = found.length === prose.length;
		const colors = palette(keyword, options.mode, options.appearance);

		found.forEach(({ line, start, len }, i) => {
			if (aligned && !prose[i]) return;
			const { map } = parsed[line]!;
			const out = inserts[line]!;
			for (let k = 0; k < len; k++) {
				const t = ((k / len) * WORD_SPAN + phase) % 1;
				out.push({ at: map[start + k]!, text: colors[Math.floor(t * STOPS) % STOPS]! });
			}
			const end = map[start + len - 1]! + 1;
			out.push({ at: end, text: restoreAt(lines[line]!, end) });
		});
	}

	return lines.map((line, i) => {
		const list = inserts[i]!;
		if (list.length === 0) return line;
		list.sort((a, b) => a.at - b.at);
		let out = "";
		let last = 0;
		for (const { at, text } of list) {
			out += line.slice(last, at) + text;
			last = at;
		}
		return out + line.slice(last);
	});
}

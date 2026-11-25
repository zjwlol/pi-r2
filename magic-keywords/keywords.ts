import { maskNonProse } from "../shared/prose.ts";
import { orchestrateNotice } from "./notices.ts";

export { maskNonProse };

export interface MagicKeyword {
	id: string;
	word: string;
	/**
	 * Hue endpoints are in degrees and can wrap past 360.
	 */
	hue: readonly [number, number];
	notice(tools: readonly string[]): string | undefined;
}

export const MAGIC_KEYWORDS: readonly MagicKeyword[] = [
	{
		id: "orchestrate",
		word: "orchestrate",
		hue: [150, 280],
		notice: orchestrateNotice,
	},
];

const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

export function keywordRegex(word: string, flags = "g"): RegExp {
	const escaped = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	return new RegExp(`${LEFT_BOUNDARY}${escaped}${RIGHT_BOUNDARY}`, `${flags}u`);
}

const matchers = new Map(MAGIC_KEYWORDS.map((k) => [k.word, keywordRegex(k.word, "")]));

export function findKeywords(text: string): MagicKeyword[] {
	const candidates = MAGIC_KEYWORDS.filter((k) => text.includes(k.word));
	if (candidates.length === 0) return [];
	const masked = maskNonProse(text);
	return candidates.filter((k) => matchers.get(k.word)!.test(masked));
}

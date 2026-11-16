/**
 * Magic keywords (ported from oh-my-pi): standalone lowercase prose words in a
 * prompt that glow in the editor/transcript and append a hidden notice for
 * that turn.
 *
 * This table is the single source of truth: adding a keyword is one row here.
 */
import { maskNonProse } from "../shared/prose.ts";
import { orchestrateNotice } from "./notices.ts";

export { maskNonProse };

export interface MagicKeyword {
	/** customType of the hidden notice message is `${id}-notice`. */
	id: string;
	/** Exact lowercase trigger, matched only as standalone prose. */
	word: string;
	/** Gradient as an OKHSL hue sweep [from, to] in degrees; `to` may exceed 360 to wrap. */
	hue: readonly [number, number];
	/** Render the hidden notice for the active tools, or undefined to skip it this turn. */
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

// Letters, digits, underscores, slashes, hyphens, file-extension dots, `foo::word`
// and `word()` keep the occurrence in code rather than prose.
const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

export function keywordRegex(word: string, flags = "g"): RegExp {
	const escaped = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	return new RegExp(`${LEFT_BOUNDARY}${escaped}${RIGHT_BOUNDARY}`, `${flags}u`);
}

const matchers = new Map(MAGIC_KEYWORDS.map((k) => [k.word, keywordRegex(k.word, "")]));

/** Keywords standing as prose in `text` (never inside code or markup). */
export function findKeywords(text: string): MagicKeyword[] {
	const candidates = MAGIC_KEYWORDS.filter((k) => text.includes(k.word));
	if (candidates.length === 0) return [];
	const masked = maskNonProse(text);
	return candidates.filter((k) => matchers.get(k.word)!.test(masked));
}

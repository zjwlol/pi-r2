/**
 * Shared by the pi-extended extensions (this directory has no index.ts, so pi
 * doesn't load it as an extension).
 */

/**
 * Length-preserving copy of `text` with fenced code blocks, inline code spans,
 * and XML/HTML sections blanked to spaces, so word matches only land on prose
 * while their indices still address the original text.
 */
export function maskNonProse(text: string): string {
	const blank = (s: string) => s.replace(/[^\n]/g, " ");
	return (
		text
			// Fenced code blocks (unterminated fences run to the end).
			.replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\s*\2[^\n]*$|(?![\s\S]))/gm, blank)
			// Inline code spans with matching backtick runs.
			.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank)
			// Balanced XML/HTML sections, then any leftover lone tags and comments.
			.replace(/<([A-Za-z][\w-]*)(?:\s[^<>]*)?>[\s\S]*?<\/\1\s*>/g, blank)
			.replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g, blank)
	);
}

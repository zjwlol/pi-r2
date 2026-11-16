/**
 * `side: true` prompt templates: a template whose frontmatter says `side: true` answers as a `/btw`
 * side question instead of becoming a main-session prompt.
 *
 * Ports the routing of oh-my-pi `packages/coding-agent/src/modes/controllers/input-controller.ts`
 * (`#runSideFileCommand`: the expanded template is the question, the typed invocation the topic
 * title). Template semantics are vanilla's, since the same file is also an ordinary pi template:
 * `parseSlashInvocation`, `parseCommandArgs` and `substituteArgs` are verbatim ports of pi's
 * `dist/core/prompt-templates.js` (`expandPromptTemplate` and its two helpers, which the package does
 * not export).
 *
 * No pi imports and erasable TypeScript: plain `node` loads this file; the frontmatter parser
 * (pi's `parseFrontmatter`) is passed in.
 */
import * as fs from "node:fs";

export interface SideInvocation {
	name: string;
	/** Everything after the command name, untrimmed at the end; "" without arguments. */
	args: string;
}

/** /^\/([^\s]+)(?:\s+([\s\S]*))?$/ as vanilla's expandPromptTemplate; undefined otherwise. */
export function parseSlashInvocation(text: string): SideInvocation | undefined {
	if (!text.startsWith("/")) return undefined;
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return { name: match[1]!, args: match[2] ?? "" };
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	// Tracks whether a token has started, so quoted empty strings ("" or '') are kept as arguments
	let hasToken = false;
	let inQuote: string | null = null;
	// Where the open quote started, so an unclosed quote can be re-read as literal text
	let quoteStart = 0;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;

		if (inQuote) {
			if (char === "\\" && argsString[i + 1] === inQuote) {
				// A backslash before the open quote's character keeps it as text: "say \"hi\"" gives say "hi"
				current += inQuote;
				i++;
			} else if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if ((char === '"' || char === "'") && !hasToken) {
			// Quotes only open at the start of an argument, so apostrophes inside words stay literal
			inQuote = char;
			quoteStart = i;
			hasToken = true;
		} else if (/\s/.test(char)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += char;
			hasToken = true;
		}

		if (inQuote && i === argsString.length - 1) {
			// Unclosed quote: keep the quote character as text and parse the rest normally
			// (current was empty when the quote opened, because quotes only open a new argument)
			inQuote = null;
			current = argsString[quoteStart]!;
			i = quoteStart;
		}
	}

	if (hasToken) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${N:-default} for positional arg N with default when missing/empty
 * - ${@:-default} and ${ARGUMENTS:-default} for all args with a default when empty
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument and default values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");

	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(
			_match: string,
			defaultTarget: string | undefined,
			defaultValue: string | undefined,
			sliceStart: string | undefined,
			sliceLength: string | undefined,
			simple: string | undefined,
		): string => {
			if (defaultTarget) {
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
				return value ? value : (defaultValue ?? "");
			}

			if (sliceStart) {
				let start = parseInt(sliceStart, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
				// Treat 0 as 1 (bash convention: args start at 1)
				if (start < 0) start = 0;

				if (sliceLength) {
					const length = parseInt(sliceLength, 10);
					return args.slice(start, start + length).join(" ");
				}
				return args.slice(start).join(" ");
			}

			if (simple === "ARGUMENTS" || simple === "@") {
				return allArgs;
			}

			const index = parseInt(simple ?? "", 10) - 1;
			return args[index] ?? "";
		},
	);
}

interface CachedTemplate {
	mtimeMs: number;
	size: number;
	/** The template body when the file is a side template. */
	body: string | undefined;
}

/** Templates read so far, by path: the `input` handler asks on every submitted slash command. */
const templateCache = new Map<string, CachedTemplate>();

/** The template body when the file's frontmatter has `side: true` (boolean), else undefined. Cached by path, mtimeMs and size. Throws when the file cannot be read or parsed. */
export function readSideTemplate(
	path: string,
	parseFrontmatter: (content: string) => { frontmatter: Record<string, unknown>; body: string },
): string | undefined {
	const stat = fs.statSync(path);
	const cached = templateCache.get(path);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.body;
	// A file that no longer reads or parses must not keep answering from an older version.
	templateCache.delete(path);
	const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path, "utf-8"));
	const entry: CachedTemplate = {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		body: frontmatter?.side === true && typeof body === "string" ? body : undefined,
	};
	templateCache.set(path, entry);
	return entry.body;
}

/** The side question of an invocation: vanilla's template expansion of `body` with the typed arguments. */
export function expandSideTemplate(body: string, args: string): string {
	return substituteArgs(body, parseCommandArgs(args));
}

/** The topic title: the invocation as typed, `/${name}` or `/${name} ${args.trim()}`. */
export function sideTitle(invocation: SideInvocation): string {
	const args = invocation.args.trim();
	return args ? `/${invocation.name} ${args}` : `/${invocation.name}`;
}

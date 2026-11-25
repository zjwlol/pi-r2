import * as fs from "node:fs";

export interface SideInvocation {
	name: string;
	args: string;
}

export function parseSlashInvocation(text: string): SideInvocation | undefined {
	if (!text.startsWith("/")) return undefined;
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return { name: match[1]!, args: match[2] ?? "" };
}

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let hasToken = false;
	let inQuote: string | null = null;
	let quoteStart = 0;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;

		if (inQuote) {
			if (char === "\\" && argsString[i + 1] === inQuote) {
				current += inQuote;
				i++;
			} else if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if ((char === '"' || char === "'") && !hasToken) {
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
				let start = parseInt(sliceStart, 10) - 1; // Template argument positions are one-based.
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
	body: string | undefined;
}

const templateCache = new Map<string, CachedTemplate>();

export function readSideTemplate(
	path: string,
	parseFrontmatter: (content: string) => { frontmatter: Record<string, unknown>; body: string },
): string | undefined {
	const stat = fs.statSync(path);
	const cached = templateCache.get(path);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.body;
	// A failed reload must not leave the old template cached.
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

/**
 * Keep argument expansion compatible with ordinary pi templates.
 */
export function expandSideTemplate(body: string, args: string): string {
	return substituteArgs(body, parseCommandArgs(args));
}

export function sideTitle(invocation: SideInvocation): string {
	const args = invocation.args.trim();
	return args ? `/${invocation.name} ${args}` : `/${invocation.name}`;
}

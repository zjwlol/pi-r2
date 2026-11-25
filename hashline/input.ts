/**
 * hashline/input.ts: split an edit tool `input` into `[path#TAG]` sections.
 * Port of oh-my-pi `crates/pi-edit/src/modes/hashline/input.rs` (MIT), without the headerless
 * streaming fallback.
 */
import * as nodePath from "node:path";
import { HL_FILE_HASH_EXAMPLES } from "./format.ts";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, CLIPBOARD_INTERLEAVED_SECTIONS, END_PATCH_MARKER, jsonQuote } from "./messages.ts";
import { hasClipboardEdit, parsePatch, UNIFIED_HUNK_RE } from "./parser.ts";
import { classifyLine, headerPathHasOrphanBracket } from "./tokenizer.ts";
import { HashlineError, type Parsed } from "./types.ts";

const ENVELOPE_MARKERS = [BEGIN_PATCH_MARKER, END_PATCH_MARKER, ABORT_MARKER];
const APPLY_PATCH_PATH_NOISE_RE = /^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i;
const RECOVERY_TAG_RE = /#([0-9A-Fa-f]{4})\s*$/;
/** A stand-in where the tag belongs (`#AUTO`, `#????`, `#0`, a bare `#`). */
const PLACEHOLDER_TAG_RE = /#[^\s#./\\:[\]]{0,16}\s*$/;

/** One target file's section: the header's path and tag, and the rows under it. */
export interface PatchSection {
	path: string;
	/** Uppercase 4-hex tag; undefined when the header had none (or a placeholder). */
	fileHash: string | undefined;
	/** The body rows joined with `\n`. */
	diff: string;
	/** Same-path sections were separated by another file's section. */
	interleaved: boolean;
}

interface RawSection extends PatchSection {
	placeholder: boolean;
}

function unquote(path: string): string {
	for (const q of ['"', "'"]) {
		if (path.length >= 2 && path.startsWith(q) && path.endsWith(q)) return path.slice(1, -1);
	}
	return path;
}

/** Clean a header / MV path: quotes and apply_patch noise removed; an absolute path under `cwd` becomes relative. */
export function normalizeHashlinePath(raw: string, cwd: string | undefined): string {
	const cleaned = unquote(raw.trim()).replace(APPLY_PATCH_PATH_NOISE_RE, "");
	if (cwd === undefined || !nodePath.isAbsolute(cleaned)) return cleaned;
	const relative = nodePath.relative(nodePath.normalize(cwd), nodePath.normalize(cleaned));
	if (relative === "") return ".";
	if (relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) return cleaned;
	return relative.split(nodePath.sep).join("/");
}

/**
 * Unwrap leading bracketed envelope markers: `[*** Begin Patch] [a.ts#1A2B]` gives `[a.ts#1A2B]`,
 * `[*** End Patch]` gives `*** End Patch`. Other rows come back unchanged.
 */
function unbracketEnvelopeMarkers(line: string): string {
	let rest = line;
	for (;;) {
		if (!rest.startsWith("[")) return rest;
		const inner = rest.slice(1).trimStart();
		const marker = ENVELOPE_MARKERS.find((m) => inner.startsWith(m));
		if (marker === undefined) return rest;
		let tail = inner.slice(marker.length).trimStart();
		if (tail.startsWith("]")) tail = tail.slice(1);
		tail = tail.trimStart();
		if (tail === "") return marker;
		rest = tail;
	}
}

function recoverHeader(line: string, cwd: string | undefined): RawSection | undefined {
	if (line.length < 2 || !line.startsWith("[") || !line.endsWith("]")) return undefined;
	const body = line.slice(1, -1).trim().replace(APPLY_PATCH_PATH_NOISE_RE, "");
	if (body === "") return undefined;
	let pathText: string;
	let fileHash: string | undefined;
	let placeholder = false;
	const tag = RECOVERY_TAG_RE.exec(body);
	if (tag) {
		pathText = body.slice(0, tag.index);
		fileHash = tag[1].toUpperCase();
	} else {
		const ph = PLACEHOLDER_TAG_RE.exec(body);
		if (ph) {
			pathText = body.slice(0, ph.index);
			placeholder = true;
		} else pathText = body.trimEnd();
	}
	if ((fileHash === undefined && pathText.includes("#")) || headerPathHasOrphanBracket(pathText)) return undefined;
	const path = normalizeHashlinePath(pathText, cwd);
	return path === "" ? undefined : { path, fileHash, diff: "", interleaved: false, placeholder };
}

/** A row starting with `[` as a section header; undefined for other rows; throws for a malformed header. */
function parseHeaderLine(line: string, cwd: string | undefined): RawSection | undefined {
	const trimmed = unbracketEnvelopeMarkers(line.trimEnd());
	if (!trimmed.startsWith("[")) return undefined;
	const token = classifyLine(trimmed, 0);
	if (token.kind === "header") {
		const path = normalizeHashlinePath(token.path, cwd);
		if (path === "") throw new HashlineError("parse", 'Input header "[]" is empty; provide a file path.');
		return { path, fileHash: token.fileHash, diff: "", interleaved: false, placeholder: false };
	}
	const recovered = recoverHeader(trimmed, cwd);
	if (recovered) return recovered;
	throw new HashlineError("parse", `Input header must be [PATH#TAG] with a 4-hex content-hash tag; got ${jsonQuote(trimmed)}.`);
}

function stripLeadingBlanks(input: string): string {
	const lines = (input.startsWith("\uFEFF") ? input.slice(1) : input).split("\n");
	while (lines.length > 0) {
		const clean = unbracketEnvelopeMarkers(lines[0].replace(/\r+$/, ""));
		if (clean.trim() === "" || classifyLine(clean, 0).kind === "envelope_begin") lines.shift();
		else break;
	}
	return lines.join("\n");
}

function splitRawSections(input: string, cwd: string | undefined): RawSection[] {
	const lines = stripLeadingBlanks(input)
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const first = lines[0] ?? "";
	if (!parseHeaderLine(first, cwd)) {
		if (UNIFIED_HUNK_RE.test(first.trimEnd())) {
			throw new HashlineError(
				"parse",
				"unified-diff hunk header (`@@ -N,M +N,M @@`) is not valid in hashline. File sections start with `[path#HASH]`; use `replace`, `delete`, or `insert` ops.",
			);
		}
		const preview = [...first].slice(0, 120).join("");
		throw new HashlineError(
			"parse",
			`input must begin with "[PATH#HASH]" on the first non-blank line for anchored edits; got: ${jsonQuote(preview)}. Example: "[src/foo.ts#${HL_FILE_HASH_EXAMPLES[0]}]" then edit ops.`,
		);
	}
	const sections: RawSection[] = [];
	let current: RawSection | undefined;
	let body: string[] = [];
	const flush = () => {
		if (current && body.some((line) => line.trim() !== "")) {
			current.diff = body.join("\n");
			sections.push(current);
		}
		current = undefined;
		body = [];
	};
	for (const line of lines) {
		const clean = unbracketEnvelopeMarkers(line.trimEnd());
		const kind = classifyLine(clean, 0).kind;
		if (kind === "envelope_end" || kind === "abort") break;
		if (kind === "envelope_begin") continue;
		if (clean.startsWith("[")) {
			const header = parseHeaderLine(clean, cwd);
			if (header) {
				flush();
				current = header;
				continue;
			}
		}
		body.push(line);
	}
	flush();
	return sections;
}

function mergeSamePathSections(sections: RawSection[]): RawSection[] {
	const result: RawSection[] = [];
	const positions = new Map<string, number>();
	let previous: string | undefined;
	for (const section of sections) {
		const index = positions.get(section.path);
		if (index === undefined) {
			positions.set(section.path, result.length);
			previous = section.path;
			result.push(section);
			continue;
		}
		const existing = result[index];
		if (existing.fileHash !== undefined && section.fileHash !== undefined && existing.fileHash !== section.fileHash) {
			throw new HashlineError(
				"parse",
				`Conflicting hashline snapshot tags for ${section.path}: #${existing.fileHash} and #${section.fileHash}. Re-read the file and retry with one current header.`,
			);
		}
		if (existing.fileHash === undefined) existing.fileHash = section.fileHash;
		if (section.placeholder || existing.placeholder) {
			existing.placeholder = true;
			existing.fileHash = undefined;
		}
		if (previous !== section.path) existing.interleaved = true;
		existing.diff += `\n${section.diff}`;
		previous = section.path;
	}
	return result;
}

/**
 * Split `input` into sections, one per target path (same-path sections are merged into the first).
 * A header with no ops under it yields no section. Throws HashlineError("parse").
 */
export function splitSections(input: string, cwd?: string): PatchSection[] {
	return mergeSamePathSections(splitRawSections(input, cwd)).map(({ path, fileHash, diff, interleaved }) => ({ path, fileHash, diff, interleaved }));
}

/** Parse a section's body. Throws HashlineError("parse"). */
export function parseSection(section: PatchSection): Parsed {
	const parsed = parsePatch(section.diff);
	if (section.interleaved && hasClipboardEdit(parsed.edits)) throw new HashlineError("parse", CLIPBOARD_INTERLEAVED_SECTIONS);
	if (parsed.fileOp?.kind === "move") parsed.fileOp = { kind: "move", dest: normalizeHashlinePath(parsed.fileOp.dest, undefined) };
	return parsed;
}

/** The path of the first header row, for input whose headers carry no ops. */
export function firstHeaderPath(input: string, cwd?: string): string | undefined {
	const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
	for (const line of text.split("\n")) {
		try {
			const header = parseHeaderLine(unbracketEnvelopeMarkers(line.replace(/\r$/, "").trimEnd()), cwd);
			if (header) return header.path;
		} catch {
			// A malformed header row names no path.
		}
	}
	return undefined;
}

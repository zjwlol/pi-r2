/**
 * hashline/patcher.ts: run one edit call: split the input into sections, stage every file in memory
 * (any failure aborts before the first write), write, record the new snapshots and build the reply.
 * Port of oh-my-pi `crates/pi-edit/src/modes/hashline/patcher.rs`, `mod.rs::stage` and
 * `crates/pi-edit/src/session.rs::apply` / `format_file_text` (MIT), without the seen-line guard,
 * tree-sitter block resolution, notebooks, URL targets and host write hooks.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { applyEdits } from "./apply.ts";
import { resolveBlockEdits } from "./block.ts";
import { validateClipboardSequence } from "./clipboard.ts";
import { buildCompactDiffPreview, generateNumberedDiff } from "./diff.ts";
import { computeFileHash, detectLineEnding, normalizeToLf, restoreLineEndings, stripBom } from "./format.ts";
import { firstHeaderPath, type PatchSection, parseSection, splitSections } from "./input.ts";
import * as M from "./messages.ts";
import { collectAnchorLines, hasAnchorScopedEdit, hasBlockEdit } from "./parser.ts";
import { tryRecover } from "./recovery.ts";
import type { EditStore } from "./store.ts";
import { type ApplyResult, type Clipboard, type Edit, forkClipboard, HashlineError } from "./types.ts";

/** Added rows kept at each end of a long added run in the reply preview. */
const RESPONSE_ADDED_RUN_CONTEXT_LINES = 20;

export type FileOpKind = "update" | "delete" | "noop";

/** What happened to one file. */
export interface FileOutcome {
	/** Path as authored in the header (or the recovered path). */
	path: string;
	absolutePath: string;
	op: FileOpKind;
	/** Absolute destination of `MV`. */
	moveTo: string | undefined;
	/** LF-normalized, BOM-stripped text before / after. `after === before` for delete and noop. */
	before: string;
	after: string;
	/** 1-indexed first changed line in `after`. */
	firstChangedLine: number | undefined;
	warnings: string[];
	/** This file's part of the reply. */
	text: string;
}

export interface EditOutcome {
	/** The reply for the model. */
	text: string;
	files: FileOutcome[];
}

export interface PatchOptions {
	/** Directory relative paths resolve against. */
	cwd: string;
	store: EditStore;
}

interface Resolved {
	absolute: string;
	display: string;
}

interface FileRead {
	resolved: Resolved;
	canonical: string;
	bom: string;
	ending: "\n" | "\r\n";
	/** LF-normalized, BOM-stripped. */
	text: string;
}

interface StagedFile {
	display: string;
	absolute: string;
	op: FileOpKind;
	moveTo: Resolved | undefined;
	before: string;
	after: string;
	persisted: string | undefined;
	diff: string;
	firstChangedLine: number | undefined;
	warnings: string[];
	textOverride: string | undefined;
	clipboardAfter: Clipboard;
}

/** `~` and `~/x` expand to the home directory; relative paths resolve against `cwd`. */
export function resolvePath(authored: string, cwd: string): string {
	let p = authored;
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = nodePath.join(os.homedir(), p.slice(2));
	return nodePath.resolve(cwd, p);
}

/** Store key: the real path when the file exists, else the real path of its directory plus the file name. */
export function canonicalKey(absolute: string): string {
	try {
		return fs.realpathSync(absolute);
	} catch {
		try {
			return nodePath.join(fs.realpathSync(nodePath.dirname(absolute)), nodePath.basename(absolute));
		} catch {
			return absolute;
		}
	}
}

/** Read a target; undefined when it does not exist. Throws for directories, special files and non-UTF-8 content. */
function tryRead(resolved: Resolved): FileRead | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved.absolute);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) throw new HashlineError("io", `Cannot edit '${resolved.display}': it is not a regular file.`);
	const bytes = fs.readFileSync(resolved.absolute);
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new HashlineError("invalid_utf8", `${resolved.display} is not valid UTF-8; refusing to edit`);
	}
	const { bom, text } = stripBom(raw);
	return { resolved, canonical: canonicalKey(resolved.absolute), bom, ending: detectLineEnding(text), text: normalizeToLf(text) };
}

/** The rejection for a section whose tag does not name the current content. Records the current content in the store. */
function mismatch(section: PatchSection, canonical: string, normalized: string, expected: string, store: EditStore): HashlineError {
	const actual = computeFileHash(normalized);
	let anchorLines: number[] = [];
	try {
		anchorLines = collectAnchorLines(parseSection(section).edits);
	} catch {
		// A body that does not parse shows no context rows.
	}
	store.record(canonical, normalized);
	const details: M.MismatchDetails = {
		path: section.path,
		expectedFileHash: expected,
		actualFileHash: actual,
		fileLines: normalized.split("\n"),
		anchorLines,
		hashRecognized: store.hasHash(canonical, expected),
		tagOriginPaths: store.pathsWithHash(expected).filter((p) => p !== canonical),
	};
	return new HashlineError(M.mismatchKind(details), M.formatMismatchMessage(details));
}

/** Apply a section's edits: directly when the tag names the live content, else through the stale-tag paths. */
function applyWithRecovery(section: PatchSection, canonical: string, normalized: string, edits: readonly Edit[], clipboard: Clipboard, store: EditStore): ApplyResult {
	const expected = section.fileHash ?? "";
	const liveMatches = computeFileHash(normalized) === expected.toUpperCase();
	const stored = store.byHash(canonical, expected);
	const resolveWarnings: string[] = [];
	let resolved: Edit[] = [...edits];
	if (hasBlockEdit(edits)) {
		if (!liveMatches && !stored) throw mismatch(section, canonical, normalized, expected, store);
		resolved = resolveBlockEdits(edits, liveMatches ? normalized : (stored as { text: string }).text, (warning) => resolveWarnings.push(warning));
	}
	validateClipboardSequence(resolved, clipboard);
	if (liveMatches) {
		const result = applyEdits(normalized, resolved, { clipboard, onEmptyPaste: "throw" });
		return { ...result, warnings: [...resolveWarnings, ...result.warnings] };
	}
	// A bare `MV` / `REM` has no content edit to stand on: the tag is its only evidence.
	if (resolved.length === 0) throw mismatch(section, canonical, normalized, expected, store);
	if (!hasAnchorScopedEdit(resolved)) {
		const result = applyEdits(normalized, resolved, { clipboard, onEmptyPaste: "throw" });
		return { ...result, warnings: [...resolveWarnings, M.HEADTAIL_DRIFT_WARNING, ...result.warnings] };
	}
	const recovered = tryRecover(store, { path: canonical, currentText: normalized, fileHash: expected, edits: resolved, clipboard });
	if (recovered) return { text: recovered.text, firstChangedLine: recovered.firstChangedLine, warnings: [...resolveWarnings, ...recovered.warnings] };
	throw mismatch(section, canonical, normalized, expected, store);
}

/**
 * When the authored path does not exist: the one stored snapshot (inside `cwd`) with the same tag and
 * file name, to rebind the section to.
 */
function recoverTarget(section: PatchSection, initial: Resolved, store: EditStore, cwd: string): { section: PatchSection; resolved: Resolved } | undefined {
	if (fs.existsSync(initial.absolute) || section.fileHash === undefined) return undefined;
	const name = nodePath.basename(initial.absolute);
	const candidates = [...new Set(store.pathsWithHash(section.fileHash).filter((p) => nodePath.basename(p) === name && p !== initial.absolute))].sort();
	if (candidates.length !== 1) return undefined;
	const root = canonicalKey(cwd);
	if (candidates[0] !== root && !candidates[0].startsWith(root + nodePath.sep)) return undefined;
	return { section: { ...section, path: candidates[0] }, resolved: { absolute: candidates[0], display: candidates[0] } };
}

function stageSection(original: PatchSection, options: PatchOptions, clipboard: Clipboard, canonicalPaths: Map<string, string>): StagedFile {
	const { cwd, store } = options;
	const parsed = parseSection(original);
	const initial: Resolved = { absolute: resolvePath(original.path, cwd), display: original.path };
	const recovered = recoverTarget(original, initial, store, cwd);
	const section = recovered ? recovered.section : original;
	const resolved = recovered ? recovered.resolved : initial;
	const read = tryRead(resolved);
	if (!read) throw new HashlineError("file_not_found", `File not found: ${section.path}. Use the write tool to create new files.`);
	// A section with no tag (missing, or a placeholder like `#AUTO`) never applies.
	const tag = original.fileHash;
	if (tag === undefined) throw mismatch(section, read.canonical, read.text, "", store);
	const previous = canonicalPaths.get(read.canonical);
	canonicalPaths.set(read.canonical, original.path);
	if (previous !== undefined) {
		throw new HashlineError("apply", `Multiple hashline sections resolve to the same file (${previous} and ${original.path}). Merge their ops under one header before applying.`);
	}
	let moveTo: Resolved | undefined;
	if (parsed.fileOp?.kind === "move") {
		moveTo = { absolute: resolvePath(parsed.fileOp.dest, cwd), display: parsed.fileOp.dest };
		if (canonicalKey(moveTo.absolute) === read.canonical) throw new HashlineError("apply", `MV destination is the same as ${section.path}.`);
	}
	const isRem = parsed.fileOp?.kind === "rem";
	const apply = applyWithRecovery(section, read.canonical, read.text, isRem ? [] : parsed.edits, clipboard, store);
	const warnings = [...parsed.warnings];
	if (section.path !== original.path) warnings.push(M.pathRecoveredFromTagMessage(original.path, section.path, tag));
	warnings.push(...apply.warnings);
	const op: FileOpKind = isRem ? "delete" : apply.text === read.text && !parsed.fileOp ? "noop" : "update";
	const diff = generateNumberedDiff(read.text, apply.text);
	return {
		display: section.path,
		absolute: read.resolved.absolute,
		op,
		moveTo,
		before: read.text,
		after: apply.text,
		persisted: op === "update" ? read.bom + restoreLineEndings(apply.text, read.ending) : undefined,
		diff: diff.diff,
		firstChangedLine: apply.firstChangedLine ?? diff.firstChangedLine,
		warnings,
		textOverride: undefined,
		clipboardAfter: forkClipboard(clipboard),
	};
}

/** Input whose only content is a header: name the file's current tag. */
function headerOnlyError(path: string, cwd: string): HashlineError {
	const read = tryRead({ absolute: resolvePath(path, cwd), display: path });
	if (!read) return new HashlineError("file_not_found", `File not found: ${path}. Use the write tool to create new files.`);
	return new HashlineError("header_only", M.formatHeaderOnlyMessage(path, computeFileHash(read.text)));
}

/** The absolute paths an input targets (section paths and MV destinations), without reading anything. Empty when the input does not parse. */
export function patchTargetPaths(input: string, cwd: string): string[] {
	const paths = new Set<string>();
	try {
		for (const section of splitSections(input, cwd)) {
			paths.add(resolvePath(section.path, cwd));
			try {
				const parsed = parseSection(section);
				if (parsed.fileOp?.kind === "move") paths.add(resolvePath(parsed.fileOp.dest, cwd));
			} catch {
				// Reported by applyHashlinePatch.
			}
		}
	} catch {
		// Reported by applyHashlinePatch.
	}
	return [...paths];
}

function formatFileText(file: StagedFile, header: string): string {
	if (file.textOverride !== undefined) return file.textOverride;
	let body: string;
	if (file.op === "delete") body = `Deleted ${file.display}`;
	else {
		const preview = buildCompactDiffPreview(file.diff, RESPONSE_ADDED_RUN_CONTEXT_LINES).preview;
		body = [header, file.moveTo ? `Moved to ${file.moveTo.display}` : "", preview].filter((line) => line !== "").join("\n");
	}
	const warnings = file.warnings.filter((w) => w !== "");
	return warnings.length === 0 ? body : `${body}\n\nWarnings:\n${warnings.join("\n")}`;
}

/**
 * Apply an edit tool `input`. Synchronous: stages every section, then writes in order.
 * Throws HashlineError; nothing is written unless every section staged (a filesystem failure while
 * writing leaves the files written before it).
 */
export function applyHashlinePatch(input: string, options: PatchOptions): EditOutcome {
	const { cwd, store } = options;
	const sections = splitSections(input, cwd);
	if (sections.length === 0) {
		const path = firstHeaderPath(input, cwd);
		throw path !== undefined ? headerOnlyError(path, cwd) : new HashlineError("parse", "No hashline sections found in input.");
	}
	const clipboard = store.startClipboardBatch();
	const canonicalPaths = new Map<string, string>();
	const staged = sections.map((section) => stageSection(section, options, clipboard, canonicalPaths));

	const noop = staged.find((file) => file.op === "noop");
	if (noop) {
		const { count, escalate } = store.recordNoop(canonicalKey(noop.absolute), input);
		if (sections.length !== 1) throw new HashlineError("no_change", escalate ? M.noChangeLoopDiagnostic(noop.display, count) : M.noChangeDiagnostic(noop.display));
		if (escalate) throw new HashlineError("no_change", M.noChangeLoopDiagnostic(sections[0].path, count));
		noop.textOverride = M.noChangeDiagnostic(sections[0].path);
	}

	const files: FileOutcome[] = [];
	for (const file of staged) {
		const canonical = canonicalKey(file.absolute);
		let tag: string | undefined;
		try {
			if (file.op === "delete") fs.unlinkSync(file.absolute);
			else if (file.op === "update") {
				const target = file.moveTo ? file.moveTo.absolute : file.absolute;
				fs.mkdirSync(nodePath.dirname(target), { recursive: true });
				fs.writeFileSync(target, file.persisted as string);
				if (file.moveTo) fs.rmSync(file.absolute, { force: true });
			}
		} catch (error) {
			throw new HashlineError("write_failed", `Failed to write ${file.display}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (file.op === "delete") store.invalidate(canonical);
		else if (file.op === "noop") tag = store.record(canonical, file.after);
		else {
			const destination = file.moveTo ? canonicalKey(file.moveTo.absolute) : undefined;
			if (destination !== undefined) store.relocate(canonical, destination);
			tag = store.record(destination ?? canonical, file.after);
			store.resetNoop(canonical);
		}
		store.commitClipboard(file.clipboardAfter);
		const headerPath = file.moveTo ? file.moveTo.display : file.display;
		const text = formatFileText(file, `[${headerPath}#${tag ?? computeFileHash(file.after)}]`);
		files.push({
			path: file.display,
			absolutePath: file.absolute,
			op: file.op,
			moveTo: file.moveTo?.absolute,
			before: file.before,
			after: file.after,
			firstChangedLine: file.firstChangedLine,
			warnings: file.warnings,
			text,
		});
	}
	return { text: files.map((file) => file.text).filter((text) => text !== "").join("\n\n"), files };
}

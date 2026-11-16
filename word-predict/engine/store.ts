/**
 * word-predict: what the engine worker keeps on disk, and where its prompts
 * come from. Imported by the worker (`worker.ts`), by the replay CLI and by
 * the main thread (`../host.ts`), so it uses node:fs / node:crypto / node:path
 * only and is loadable by Node's type stripping.
 *
 * Port of oh-my-pi `packages/coding-agent/src/predict/daemon.ts`
 * (`PersistCadence`, ingestion), `packages/coding-agent/src/predict/foreign-history.ts`,
 * `packages/coding-agent/src/session/history-storage.ts` (`normalizePrompt`) and
 * `crates/pi-predict/src/ngram/mod.rs` (`write_atomic`) (MIT).
 *
 * Upstream keeps prompts in `history.db` and one daemon owns the engine state.
 * Here every pi process owns an engine, and two files under
 * `<agentDir>/word-predict/` tie them together without locks:
 *
 *   journal.jsonl   append-only; first line `{"journal":1,"id":"<16 hex>"}`, then
 *                   one `{"p":"<normalized prompt>","t":<epoch ms>}` per submission
 *   state.bin       snapshot + journal cursor + seen-prompt hashes, SHA-1 sealed,
 *                   replaced atomically (layout at `writeState`)
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { threadId } from "node:worker_threads";

export const STATE_FILE = "state.bin";
export const JOURNAL_FILE = "journal.jsonl";
/** Longer prompts are never learned (`learn` finds no words in them). */
export const MAX_PROMPT_UNITS = 20_000;

// ---------------------------------------------------------------------------
// Normalization and identity
// ---------------------------------------------------------------------------

/**
 * Upstream's history normalization: `\n` line ends, no blanks before a line end, trimmed.
 * Upstream's `/[^\S\n]+\n/g` backtracks quadratically on a long blank run that no line end
 * follows (20,000 spaces: ~0.4 s on the submitting thread); trimming each line gives the same
 * result in linear time (`trimEnd` strips exactly `\s`).
 */
export function normalizePrompt(prompt: string): string {
	return prompt
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

/** 48-bit prefix of `sha1(utf8)`: the identity of a prompt in the seen set. */
export function promptHash(normalized: string): number {
	return createHash("sha1").update(normalized, "utf8").digest().readUIntBE(0, 6);
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

const JOURNAL_VERSION = 1;
const JOURNAL_ID = /^[0-9a-f]{16}$/;
/** A header line is ~40 bytes; anything longer in the first line is not one. */
const HEADER_PROBE_BYTES = 256;
const NEWLINE = 0x0a;
/** The state directory and its files hold the user's prompts: owner only. Applied on creation, never to existing ones. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface JournalHeader {
	id: string;
	/** Byte offset of the first data line. */
	end: number;
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The header of an open journal, or undefined when its first line is not (yet) one. */
function readHeader(fd: number): JournalHeader | undefined {
	const probe = Buffer.allocUnsafe(HEADER_PROBE_BYTES);
	const read = fs.readSync(fd, probe, 0, HEADER_PROBE_BYTES, 0);
	const end = probe.subarray(0, read).indexOf(NEWLINE);
	if (end < 0) return undefined;
	try {
		const value: unknown = JSON.parse(probe.toString("utf8", 0, end));
		if (!isRecord(value) || value.journal !== JOURNAL_VERSION) return undefined;
		const id = value.id;
		if (typeof id !== "string" || !JOURNAL_ID.test(id)) return undefined;
		return { id, end: end + 1 };
	} catch {
		return undefined;
	}
}

/** Header of the journal at `file`: `"missing"` when there is no file, undefined when it has no header. */
function probeJournal(file: string): JournalHeader | "missing" | undefined {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return "missing";
		throw error;
	}
	try {
		return readHeader(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function headerLine(id: string): string {
	return `${JSON.stringify({ journal: JOURNAL_VERSION, id })}\n`;
}

/**
 * Replace a journal whose first line is not a header (damaged by hand, or a
 * creator died between `open` and `write`) by a new one with a fresh id that
 * keeps the intact data lines. Readers notice the new id and replay from the
 * first data line; the seen set keeps that idempotent.
 */
function repairJournal(stateDir: string, file: string): string {
	let kept = "";
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			try {
				const value: unknown = JSON.parse(line);
				if (isRecord(value) && typeof value.p === "string") kept += `${line}\n`;
			} catch {
				// Damaged or partial line.
			}
		}
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
	}
	const id = randomBytes(8).toString("hex");
	writeAtomic(stateDir, JOURNAL_FILE, Buffer.from(headerLine(id) + kept, "utf8"));
	return id;
}

/** Create the directory and the journal (with its header line) when missing; returns the journal id. */
export function ensureJournal(stateDir: string): string {
	fs.mkdirSync(stateDir, { recursive: true, mode: DIR_MODE });
	const file = path.join(stateDir, JOURNAL_FILE);
	// A file without a header is normally another process between its exclusive
	// create and its header write: give it a moment before calling it damaged.
	for (let attempt = 0; attempt < 25; attempt++) {
		const header = probeJournal(file);
		if (header === "missing") {
			const id = randomBytes(8).toString("hex");
			try {
				fs.writeFileSync(file, headerLine(id), { flag: "ax", mode: FILE_MODE });
				return id;
			} catch (error) {
				if (!isErrno(error, "EEXIST")) throw error;
				continue;
			}
		}
		if (header) return header.id;
		sleepSync(2);
	}
	return repairJournal(stateDir, file);
}

/** One O_APPEND write of `{"p":…,"t":…}\n`. */
export function appendJournal(stateDir: string, normalized: string, now: number): void {
	const file = path.join(stateDir, JOURNAL_FILE);
	const line = Buffer.from(`${JSON.stringify({ p: normalized, t: now })}\n`, "utf8");
	// No O_CREAT: a journal must never start with a data line. A journal that
	// went missing is recreated (new id) first.
	const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND;
	let fd: number;
	try {
		fd = fs.openSync(file, flags);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
		ensureJournal(stateDir);
		fd = fs.openSync(file, flags);
	}
	try {
		// One write(2) for the whole line, so lines of concurrent writers do not
		// interleave; the loop only covers a short write (disk full, signal).
		let written = 0;
		while (written < line.length) written += fs.writeSync(fd, line, written, line.length - written);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Prompts on the complete lines at or after `offset`; restarts after the header when the id changed
 * or the file shrank. A partial last line stays unread (the returned offset ends at the last `\n`);
 * damaged lines are skipped. A missing or headerless journal yields nothing and keeps the cursor.
 */
export function readJournal(
	stateDir: string,
	journalId: string,
	offset: number,
): { id: string; prompts: string[]; offset: number } {
	const unchanged = { id: journalId, prompts: [], offset };
	let fd: number;
	try {
		fd = fs.openSync(path.join(stateDir, JOURNAL_FILE), "r");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return unchanged;
		throw error;
	}
	try {
		const header = readHeader(fd);
		if (!header) return unchanged;
		const size = fs.fstatSync(fd).size;
		let start = offset;
		if (header.id !== journalId || !Number.isInteger(offset) || offset < header.end || offset > size) {
			start = header.end;
		} else if (offset > header.end) {
			// A cursor always sits right after a line end; anything else is a rewritten file.
			const before = Buffer.allocUnsafe(1);
			if (fs.readSync(fd, before, 0, 1, offset - 1) !== 1 || before[0] !== NEWLINE) start = header.end;
		}
		const bytes = Buffer.allocUnsafe(Math.max(0, size - start));
		let filled = 0;
		while (filled < bytes.length) {
			const read = fs.readSync(fd, bytes, filled, bytes.length - filled, start + filled);
			if (read === 0) break;
			filled += read;
		}
		const prompts: string[] = [];
		let lineStart = 0;
		for (;;) {
			const lineEnd = bytes.indexOf(NEWLINE, lineStart);
			if (lineEnd < 0 || lineEnd >= filled) break;
			try {
				const value: unknown = JSON.parse(bytes.toString("utf8", lineStart, lineEnd));
				const prompt = isRecord(value) ? value.p : undefined;
				if (typeof prompt === "string") prompts.push(prompt);
			} catch {
				// Damaged line: skip it.
			}
			lineStart = lineEnd + 1;
		}
		return { id: header.id, prompts, offset: start + lineStart };
	} finally {
		fs.closeSync(fd);
	}
}

// ---------------------------------------------------------------------------
// State container
// ---------------------------------------------------------------------------

export interface StateMeta {
	journalId: string;
	journalOffset: number;
	prompts: number;
	foreignPrompts: number;
	savedAt: number;
}

export interface LoadedState {
	meta: StateMeta;
	snapshot: Uint8Array;
	seen: Set<number>;
	bytes: number;
}

const STATE_MAGIC = Buffer.from("PIWPST\0\0", "latin1");
const STATE_VERSION = 1;
/** magic + version + metaLen. */
const STATE_HEADER_BYTES = 16;
const SHA1_BYTES = 20;
const HASH_BYTES = 6;
/** Bound for the header-only read; a real meta is ~120 bytes. */
const MAX_META_BYTES = 64 * 1024;

function parseMeta(json: string): StateMeta {
	const value: unknown = JSON.parse(json);
	if (!isRecord(value)) throw new Error("state: meta is not an object");
	const { journalId, journalOffset, prompts, foreignPrompts, savedAt } = value;
	if (typeof journalId !== "string") throw new Error("state: meta.journalId is not a string");
	const count = (name: string, field: unknown): number => {
		if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
			throw new Error(`state: meta.${name} is not a count`);
		}
		return field;
	};
	return {
		journalId,
		journalOffset: count("journalOffset", journalOffset),
		prompts: count("prompts", prompts),
		foreignPrompts: count("foreignPrompts", foreignPrompts),
		savedAt: count("savedAt", savedAt),
	};
}

/**
 * Atomic write; returns the file size. Layout, little endian:
 *
 *   0   "PIWPST\0\0"                        magic
 *   8   u32 version = 1
 *   12  u32 metaLen
 *   16  meta, UTF-8 JSON (`StateMeta`)
 *       u32 snapshotLen, snapshot           upstream's `ngram.snapshot` bytes
 *       u32 seenCount, seenCount × 6 bytes  48-bit big-endian prompt hashes, ascending
 *       20 bytes                            SHA-1 of every byte before it
 */
export function writeState(
	stateDir: string,
	meta: StateMeta,
	snapshot: Uint8Array,
	seen: ReadonlySet<number>,
): number {
	const metaBytes = Buffer.from(
		JSON.stringify({
			journalId: meta.journalId,
			journalOffset: meta.journalOffset,
			prompts: meta.prompts,
			foreignPrompts: meta.foreignPrompts,
			savedAt: meta.savedAt,
		}),
		"utf8",
	);
	const hashes = Float64Array.from(seen).sort();
	const size =
		STATE_HEADER_BYTES + metaBytes.length + 4 + snapshot.length + 4 + hashes.length * HASH_BYTES + SHA1_BYTES;
	const bytes = Buffer.allocUnsafe(size);
	let at = STATE_MAGIC.copy(bytes, 0);
	at = bytes.writeUInt32LE(STATE_VERSION, at);
	at = bytes.writeUInt32LE(metaBytes.length, at);
	at += metaBytes.copy(bytes, at);
	at = bytes.writeUInt32LE(snapshot.length, at);
	bytes.set(snapshot, at);
	at += snapshot.length;
	at = bytes.writeUInt32LE(hashes.length, at);
	for (let i = 0; i < hashes.length; i++) at = bytes.writeUIntBE(hashes[i], at, HASH_BYTES);
	createHash("sha1").update(bytes.subarray(0, at)).digest().copy(bytes, at);
	writeAtomic(stateDir, STATE_FILE, bytes);
	return size;
}

/** undefined when the file is missing; throws when it is corrupt or of an unknown version. */
export function readState(stateDir: string): LoadedState | undefined {
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(path.join(stateDir, STATE_FILE));
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
	if (bytes.length < STATE_HEADER_BYTES || !bytes.subarray(0, STATE_MAGIC.length).equals(STATE_MAGIC)) {
		throw new Error("state: not a word-predict state file");
	}
	const version = bytes.readUInt32LE(8);
	if (version !== STATE_VERSION) throw new Error(`state: unsupported state version ${version}`);
	// Node's zstd does not report a truncated frame, so integrity comes from here.
	const sealed = bytes.length - SHA1_BYTES;
	if (
		sealed < STATE_HEADER_BYTES ||
		!createHash("sha1").update(bytes.subarray(0, sealed)).digest().equals(bytes.subarray(sealed))
	) {
		throw new Error("state: checksum mismatch");
	}
	let at = 12;
	const take = (length: number): Buffer => {
		if (length > sealed - at) throw new Error("state: truncated");
		const part = bytes.subarray(at, at + length);
		at += length;
		return part;
	};
	const meta = parseMeta(take(take(4).readUInt32LE(0)).toString("utf8"));
	const snapshot = take(take(4).readUInt32LE(0));
	const seenCount = take(4).readUInt32LE(0);
	const hashes = take(seenCount * HASH_BYTES);
	if (at !== sealed) throw new Error("state: trailing bytes");
	const seen = new Set<number>();
	for (let i = 0; i < seenCount; i++) seen.add(hashes.readUIntBE(i * HASH_BYTES, HASH_BYTES));
	return { meta, snapshot, seen, bytes: bytes.length };
}

/** Meta of the current state.bin (header only); undefined when missing or unreadable. */
export function readStateMeta(stateDir: string): StateMeta | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(path.join(stateDir, STATE_FILE), "r");
		const header = Buffer.allocUnsafe(STATE_HEADER_BYTES);
		if (fs.readSync(fd, header, 0, STATE_HEADER_BYTES, 0) !== STATE_HEADER_BYTES) return undefined;
		if (!header.subarray(0, STATE_MAGIC.length).equals(STATE_MAGIC)) return undefined;
		if (header.readUInt32LE(8) !== STATE_VERSION) return undefined;
		const metaLen = header.readUInt32LE(12);
		if (metaLen > MAX_META_BYTES) return undefined;
		const metaBytes = Buffer.allocUnsafe(metaLen);
		if (fs.readSync(fd, metaBytes, 0, metaLen, STATE_HEADER_BYTES) !== metaLen) return undefined;
		return parseMeta(metaBytes.toString("utf8"));
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Nothing to do about a failed close of a read-only descriptor.
			}
		}
	}
}

/**
 * Write `dir/name` through `name.<pid>.<threadId>.tmp`, fsync, rename (upstream
 * `write_atomic`; the thread id keeps a worker and its main thread apart). The
 * file is created owner-only, and so is `dir` when it has to be created.
 */
export function writeAtomic(dir: string, name: string, bytes: Uint8Array): void {
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	const target = path.join(dir, name);
	const temp = path.join(dir, `${name}.${process.pid}.${threadId}.tmp`);
	try {
		const fd = fs.openSync(temp, "w", FILE_MODE);
		try {
			let written = 0;
			while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temp, target);
	} catch (error) {
		try {
			fs.unlinkSync(temp);
		} catch {
			// The temp file may not exist.
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// History readers (bootstrap)
// ---------------------------------------------------------------------------

const CHUNK_BYTES = 256 * 1024;
/** A longer line is skipped rather than buffered (tool results can be huge; prompts are not). */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Call `visit(buffer, start, end)` for every line of `file` (final unterminated
 * line included), streaming through one growable buffer; the bytes are only
 * valid during the call. Never holds more than one line.
 */
function forEachLine(file: string, visit: (bytes: Buffer, start: number, end: number) => void): void {
	const fd = fs.openSync(file, "r");
	try {
		let buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		let filled = 0;
		// Inside a line longer than MAX_LINE_BYTES: drop bytes up to its end.
		let skipping = false;
		for (;;) {
			const read = fs.readSync(fd, buffer, filled, buffer.length - filled, null);
			if (read === 0) break;
			const scanFrom = filled;
			filled += read;
			let lineStart = 0;
			for (;;) {
				const lineEnd = buffer.indexOf(NEWLINE, Math.max(lineStart, scanFrom));
				if (lineEnd < 0 || lineEnd >= filled) break;
				if (skipping) skipping = false;
				else visit(buffer, lineStart, lineEnd);
				lineStart = lineEnd + 1;
			}
			if (skipping) {
				filled = 0;
				continue;
			}
			if (lineStart > 0) {
				buffer.copyWithin(0, lineStart, filled);
				filled -= lineStart;
			}
			if (filled === buffer.length) {
				if (buffer.length >= MAX_LINE_BYTES) {
					skipping = true;
					filled = 0;
				} else {
					const grown = Buffer.allocUnsafe(buffer.length * 2);
					buffer.copy(grown, 0, 0, filled);
					buffer = grown;
				}
			}
		}
		if (filled > 0 && !skipping) visit(buffer, 0, filled);
	} finally {
		fs.closeSync(fd);
	}
}

const ROLE_USER = Buffer.from('"role":"user"', "latin1");
const ROLE_BASH = Buffer.from('"role":"bashExecution"', "latin1");

/** `*.jsonl` files directly in `root` and in its immediate subdirectories, in name order. */
function sessionFiles(root: string): string[] {
	const files: string[] = [];
	const list = (dir: string, descend: boolean): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.name.endsWith(".jsonl")) {
				if (!entry.isDirectory()) files.push(full);
			} else if (descend && (entry.isDirectory() || entry.isSymbolicLink())) {
				list(full, false);
			}
		}
	};
	list(root, true);
	return files;
}

/** The typed text of a session entry (`role: "user"` text, or the `!` / `!!` line of a bash execution). */
function sessionPrompt(entry: unknown): { text: string; at: number } | undefined {
	if (!isRecord(entry) || entry.type !== "message") return undefined;
	const message = entry.message;
	if (!isRecord(message)) return undefined;
	let text: string;
	if (message.role === "user") {
		const content = message.content;
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const block of content) {
				const part = isRecord(block) && block.type === "text" ? block.text : undefined;
				if (typeof part === "string") parts.push(part);
			}
			text = parts.join("\n");
		} else {
			return undefined;
		}
	} else if (message.role === "bashExecution") {
		// Upstream stores the typed `!` / `!!` line.
		const command = message.command;
		if (typeof command !== "string") return undefined;
		text = (message.excludeFromContext ? "!!" : "!") + command;
	} else {
		return undefined;
	}
	if (!text) return undefined;
	// The message timestamp is epoch ms; the entry timestamp an ISO string.
	const stamp = message.timestamp;
	const iso = entry.timestamp;
	let at = 0;
	if (typeof stamp === "number" && Number.isFinite(stamp)) {
		at = stamp;
	} else if (typeof iso === "string") {
		const parsed = Date.parse(iso);
		if (Number.isFinite(parsed)) at = parsed;
	}
	return { text, at };
}

/**
 * User and bash prompts of every session file, unsorted. Only lines carrying
 * the bytes `"role":"user"` or `"role":"bashExecution"` are decoded and parsed
 * (a quote inside a JSON string is escaped, so tool output cannot fake them).
 * Unreadable files and damaged lines contribute nothing.
 */
export function* readSessionPrompts(sessionDirs: readonly string[]): Generator<{ text: string; at: number }> {
	const found: { text: string; at: number }[] = [];
	const visit = (bytes: Buffer, start: number, end: number): void => {
		const line = bytes.subarray(start, end);
		if (!line.includes(ROLE_USER) && !line.includes(ROLE_BASH)) return;
		try {
			const prompt = sessionPrompt(JSON.parse(line.toString("utf8")));
			if (prompt) found.push(prompt);
		} catch {
			// Damaged or partial line.
		}
	};
	for (const root of sessionDirs) {
		for (const file of sessionFiles(root)) {
			found.length = 0;
			try {
				forEachLine(file, visit);
			} catch {
				// Unreadable file: keep what was read before the failure.
			}
			yield* found;
		}
	}
}

/** Claude Code placeholders for pasted text and images: not words the user typed. */
const PLACEHOLDER = /\[(?:Pasted text|Image) #\d+[^\]]*\]/g;

/**
 * Prompts of the given `history.jsonl` files (Claude Code, Codex), each in file order; missing or
 * unreadable files contribute nothing.
 */
export function readForeignPrompts(files: readonly string[]): string[] {
	const prompts: string[] = [];
	const visit = (bytes: Buffer, start: number, end: number): void => {
		let value: unknown;
		try {
			value = JSON.parse(bytes.toString("utf8", start, end));
		} catch {
			// A partially-written line must not hide the readable prefix.
			return;
		}
		if (!isRecord(value)) return;
		// Claude Code writes `display`; Codex (and older Claude Code) `text`.
		const text = value.display ?? value.text;
		// Slash commands are not prose.
		if (typeof text !== "string" || text.startsWith("/")) return;
		const prompt = text.replace(PLACEHOLDER, " ").trim();
		if (prompt) prompts.push(prompt);
	};
	for (const file of files) {
		try {
			forEachLine(file, visit);
		} catch {
			// Missing or unreadable: contributes what was read so far.
		}
	}
	return prompts;
}

// ---------------------------------------------------------------------------
// Persist cadence
// ---------------------------------------------------------------------------

/**
 * Trailing debounce capped by a maximum dirty age: each change pushes the
 * flush to `debounceMs` after it, but never past `maxDirtyMs` after the first
 * unflushed change. Consecutive flushes are therefore at least `debounceMs`
 * apart, and a steady stream of changes still flushes every `maxDirtyMs`.
 */
export class PersistCadence {
	private readonly debounceMs: number;
	private readonly maxDirtyMs: number;
	private readonly flush: () => void;
	private timer: NodeJS.Timeout | undefined;
	private dirtySince: number | undefined;

	constructor(debounceMs: number, maxDirtyMs: number, flush: () => void) {
		this.debounceMs = debounceMs;
		this.maxDirtyMs = maxDirtyMs;
		this.flush = flush;
	}

	/** Record a change and (re)arm the flush. */
	touch(): void {
		const now = Date.now();
		this.dirtySince ??= now;
		const delay = Math.max(0, Math.min(this.debounceMs, this.dirtySince + this.maxDirtyMs - now));
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.dirtySince = undefined;
			this.flush();
		}, delay);
	}

	/** Drop a pending flush (the caller persists on stop instead). */
	cancel(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.dirtySince = undefined;
	}
}

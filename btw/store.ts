/**
 * `/btw` history storage: one JSON file per topic in a sidecar directory beside pi's sessions,
 * `<agent dir>/btw-history/<session id>/entry-<record id>.json`. It never reads or writes the
 * session file, so side questions stay out of the transcript, exports and shares.
 *
 * Ports oh-my-pi `packages/coding-agent/src/session/btw-history.ts` (`BtwHistoryStore`,
 * `BtwHistoryConflictError`, `historyDirectory`). Differences: writes are synchronous (at most three
 * per turn, so no queue, no flush, nothing pending at shutdown), the title lives inside the JSON
 * instead of an `entry-<id>.title` sidecar, and there is no cross-process lease (Node has no file
 * lock); the revision check still keeps one writer from silently replacing another's bytes.
 *
 * `node:` built-ins only and erasable TypeScript: plain `node` loads this file.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BtwRecord } from "./records.ts";
import { parseRecord, snapshotRecord, sortRecords } from "./records.ts";

/** The topic on disk is missing or was rewritten since this store read it; retrying the same write can never succeed. */
export class BtwHistoryConflictError extends Error {
	readonly recordId: string;

	constructor(recordId: string) {
		super(`BTW history conflict for ${recordId}; reopen history before retrying`);
		this.name = "BtwHistoryConflictError";
		this.recordId = recordId;
	}
}

/** `<agentDir>/btw-history/<segment>`; segment = sessionId when /^[\w-]+$/, else its sha256 hex. */
export function historyDirectory(agentDir: string, sessionId: string): string {
	// Session ids come from session headers; never let one escape the history root.
	const segment = /^[\w-]+$/.test(sessionId) ? sessionId : sha256(sessionId);
	return path.join(agentDir, "btw-history", segment);
}

function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function recordFileName(id: string): string {
	// The prefix also prevents Windows device names (CON, NUL, etc.).
	return `entry-${id}.json`;
}

interface StoredRecord {
	record: BtwRecord;
	/** sha256 of the file's bytes: what the compare-and-swap of `upsert` compares. */
	revision: string;
}

/** The record in `filePath` with its revision; undefined when the file does not exist. */
function readRecord(filePath: string): StoredRecord | undefined {
	try {
		const stat = fs.lstatSync(filePath);
		if (!stat.isFile()) throw new Error("Expected a regular file");
		const bytes = fs.readFileSync(filePath);
		const record = parseRecord(JSON.parse(bytes.toString("utf8")));
		if (path.basename(filePath) !== recordFileName(record.id)) {
			throw new Error("Record id does not match its filename");
		}
		return { record, revision: sha256(bytes) };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read BTW history ${filePath}: ${errorMessage(error)}`, { cause: error });
	}
}

/**
 * Write through a private temp sibling and publish it with one rename: a reader never sees a
 * half-written record and a failed write leaves the destination untouched.
 */
function writeFileAtomically(filePath: string, content: string): void {
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", 0o600);
		fs.writeFileSync(fd, content, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		// The umask narrows the mode passed to open(); restore it explicitly.
		if (process.platform !== "win32") fs.chmodSync(tempPath, 0o600);
		fs.renameSync(tempPath, filePath);
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// The descriptor is already gone.
			}
		}
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {
			// Nothing staged, or it cannot be removed: the write error is the one to report.
		}
		throw error;
	}
}

/** Session-local sidecar storage; never reads or writes the main session file. */
export class BtwHistoryStore {
	/** The session's history directory; `undefined` = memory only (`--no-session`). */
	readonly directory: string | undefined;
	readonly #records = new Map<string, BtwRecord>();
	/** Revision of each topic's file as read or last written by this store. */
	readonly #revisions = new Map<string, string>();
	#snapshot: readonly BtwRecord[] = Object.freeze([]);

	private constructor(directory: string | undefined) {
		this.directory = directory;
	}

	/** Reads and validates every entry-*.json; `undefined` = memory only. Throws on the first unreadable or invalid record. */
	static open(directory: string | undefined): BtwHistoryStore {
		const store = new BtwHistoryStore(directory);
		if (directory === undefined) return store;
		let names: string[];
		try {
			names = fs.readdirSync(directory);
		} catch (error) {
			if (isEnoent(error)) return store;
			throw error;
		}
		for (const name of names.sort()) {
			if (!name.startsWith("entry-") || !name.endsWith(".json")) continue;
			const stored = readRecord(path.join(directory, name));
			if (!stored) continue;
			// Recovery is only a view: the file keeps its bytes, and the revision is of those
			// bytes, so a turn found `running` shows as interrupted without a rewrite.
			store.#records.set(stored.record.id, snapshotRecord(stored.record, true));
			store.#revisions.set(stored.record.id, stored.revision);
		}
		store.#refreshSnapshot();
		return store;
	}

	/** Frozen, newest first; a new array after every successful upsert. */
	getRecords(): readonly BtwRecord[] {
		return this.#snapshot;
	}

	/** Validate, CAS-check, write atomically, then publish. On a throw neither disk nor getRecords() changed. */
	upsert(record: BtwRecord): void {
		// A detached frozen copy: callers may keep mutating their streaming record.
		const saved = snapshotRecord(parseRecord(record));
		const directory = this.directory;
		if (directory !== undefined) {
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
			const filePath = path.join(directory, recordFileName(saved.id));
			// Missing records and new-id collisions are conflicts, not blind inserts.
			const stored = readRecord(filePath);
			if (stored?.revision !== this.#revisions.get(saved.id)) {
				throw new BtwHistoryConflictError(saved.id);
			}
			const content = `${JSON.stringify(saved)}\n`;
			writeFileAtomically(filePath, content);
			this.#revisions.set(saved.id, sha256(content));
		}
		this.#records.set(saved.id, saved);
		this.#refreshSnapshot();
	}

	#refreshSnapshot(): void {
		this.#snapshot = Object.freeze(sortRecords(this.#records.values()));
	}
}

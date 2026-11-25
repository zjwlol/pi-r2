import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BtwRecord } from "./records.ts";
import { parseRecord, snapshotRecord, sortRecords } from "./records.ts";

export class BtwHistoryConflictError extends Error {
	readonly recordId: string;

	constructor(recordId: string) {
		super(`BTW history conflict for ${recordId}; reopen history before retrying`);
		this.name = "BtwHistoryConflictError";
		this.recordId = recordId;
	}
}

export function historyDirectory(agentDir: string, sessionId: string): string {
	// Session IDs from file headers are not trusted path segments.
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
	// The prefix keeps IDs from matching reserved device names.
	return `entry-${id}.json`;
}

interface StoredRecord {
	record: BtwRecord;
	revision: string;
}

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

function writeFileAtomically(filePath: string, content: string): void {
	// Keep the temporary file on the same filesystem for atomic rename.
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
		// The umask can narrow the mode passed to open.
		if (process.platform !== "win32") fs.chmodSync(tempPath, 0o600);
		fs.renameSync(tempPath, filePath);
	} catch (error) {
		// Cleanup failures must not hide the write error.
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
			}
		}
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {
		}
		throw error;
	}
}

export class BtwHistoryStore {
	readonly directory: string | undefined;
	readonly #records = new Map<string, BtwRecord>();
	readonly #revisions = new Map<string, string>();
	#snapshot: readonly BtwRecord[] = Object.freeze([]);

	private constructor(directory: string | undefined) {
		this.directory = directory;
	}

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
			// Use the on-disk revision even when recovering a turn.
			store.#records.set(stored.record.id, snapshotRecord(stored.record, true));
			store.#revisions.set(stored.record.id, stored.revision);
		}
		store.#refreshSnapshot();
		return store;
	}

	getRecords(): readonly BtwRecord[] {
		return this.#snapshot;
	}

	upsert(record: BtwRecord): void {
		const saved = snapshotRecord(parseRecord(record));
		const directory = this.directory;
		if (directory !== undefined) {
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
			const filePath = path.join(directory, recordFileName(saved.id));
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

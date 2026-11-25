import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { EngineStatus, FromWorker, ToWorker, WorkerInit } from "../protocol.ts";
import { NgramEngine } from "./engine.ts";
import {
	ensureJournal,
	JOURNAL_FILE,
	MAX_PROMPT_UNITS,
	normalizePrompt,
	PersistCadence,
	promptHash,
	readForeignPrompts,
	readJournal,
	readSessionPrompts,
	readState,
	readStateMeta,
	STATE_FILE,
	writeState,
} from "./store.ts";
import { decodeWebPrior, type WebPrior } from "./web.ts";

const PERSIST_DEBOUNCE_MS = 5 * 60_000;
const PERSIST_MAX_DIRTY_MS = 15 * 60_000;
const INGEST_BATCH = 1_000;
const SCAN_SLICE_MS = 25;
const JOURNAL_STAT_MS = 2_000;
const STALE_TEMP_MS = 60 * 60_000;
const SHUTDOWN_PERSIST_BACKLOG = 64;

type CompleteRequest = Extract<ToWorker, { t: "complete" }>;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isUnwritable(error: unknown): boolean {
	const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	return code === "EACCES" || code === "EROFS" || code === "EPERM";
}

function turn(): Promise<void> {
	// Queued worker messages need an event-loop turn.
	return new Promise((resolve) => setImmediate(resolve));
}

function sweepStaleTemps(stateDir: string): void {
	try {
		const cutoff = Date.now() - STALE_TEMP_MS;
		for (const name of fs.readdirSync(stateDir)) {
			if (!name.startsWith(`${STATE_FILE}.`) || !name.endsWith(".tmp")) continue;
			const file = path.join(stateDir, name);
			try {
				if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
			} catch {
				// Another worker may already have removed the file.
			}
		}
	} catch {
		// Stale temp files do not block startup.
	}
}

class EngineWorker {
	private readonly init: WorkerInit;
	private readonly post: (message: FromWorker) => void;
	private readonly cadence: PersistCadence;
	private phase: EngineStatus["phase"] = "loading";
	private error: string | undefined;
	private engine: NgramEngine | undefined;
	private seen = new Set<number>();
	private foreignPrompts = 0;
	private journalId = "";
	private journalOffset = 0;
	private dirty = false;
	private unsaved = 0;
	private neverSaved = false;
	private readOnly: string | undefined;
	private stateBytes: number | null = null;
	private savedAt: number | null = null;
	private readonly startedAt = performance.now();
	private loadMs = 0;
	private held: CompleteRequest | undefined;
	private journalCheckedAt = 0;

	constructor(init: WorkerInit, post: (message: FromWorker) => void) {
		this.init = init;
		this.post = post;
		this.cadence = new PersistCadence(PERSIST_DEBOUNCE_MS, PERSIST_MAX_DIRTY_MS, () => this.flush());
	}

	handle(message: ToWorker): void {
		switch (message.t) {
			case "complete":
				if (this.phase === "ready") {
					this.drainIfGrown();
					this.answer(message);
				} else if (this.phase === "failed") {
					this.reply(message.id, null);
				} else {
					if (this.held) this.reply(this.held.id, null);
					this.held = message;
				}
				break;
			case "sync":
				if (this.phase === "ready" && this.readOnly === undefined) this.drain();
				break;
			case "status":
				this.post({ t: "status", id: message.id, status: this.status() });
				break;
			case "shutdown":
				this.shutdown();
				break;
		}
	}

	fail(error: unknown): void {
		this.phase = "failed";
		this.error = errorText(error);
		this.cadence.cancel();
		const held = this.held;
		this.held = undefined;
		if (held) this.reply(held.id, null);
		this.post({ t: "failed", error: this.error });
	}

	private reply(id: number, suggestion: { suffix: string; confidence: number } | null): void {
		this.post({
			t: "complete",
			id,
			suffix: suggestion ? suggestion.suffix : null,
			confidence: suggestion ? suggestion.confidence : null,
		});
	}

	private answer(request: CompleteRequest): void {
		let suggestion: { suffix: string; confidence: number } | null = null;
		try {
			suggestion = this.engine?.complete(request.before, request.prefix) ?? null;
		} catch (error) {
			// A failed query must not stop later requests.
			this.error = `complete failed: ${errorText(error)}`;
		}
		this.reply(request.id, suggestion);
	}

	private status(): EngineStatus {
		let vocabulary = 0;
		try {
			vocabulary = this.engine?.stats().learnedWords ?? 0;
		} catch {
			// A stats failure must not prevent a status reply.
		}
		const status: EngineStatus = {
			phase: this.phase,
			prompts: this.seen.size,
			foreignPrompts: this.foreignPrompts,
			vocabulary,
			stateBytes: this.stateBytes,
			savedAt: this.savedAt,
			dirty: this.dirty,
			loadMs: this.phase === "ready" ? this.loadMs : Math.round(performance.now() - this.startedAt),
		};
		const error = this.readOnly ?? this.error;
		if (error !== undefined) status.error = error;
		return status;
	}

	private shutdown(): void {
		this.cadence.cancel();
		// Unsaved prompts replay from the journal on restart.
		if (this.phase === "ready" && (this.unsaved >= SHUTDOWN_PERSIST_BACKLOG || this.neverSaved)) this.flush();
		this.post({ t: "bye" });
		process.exit(0);
	}

	async open(): Promise<void> {
		const { stateDir, priorPath } = this.init;
		let journalId = "";
		try {
			journalId = ensureJournal(stateDir);
			// Snapshot renames require write access to the directory.
			fs.accessSync(stateDir, fs.constants.W_OK);
			sweepStaleTemps(stateDir);
		} catch (error) {
			if (!isUnwritable(error)) throw error;
			this.readOnly = `state directory is not writable, nothing is learned or saved: ${errorText(error)}`;
		}
		const web = decodeWebPrior(fs.readFileSync(priorPath));
		await turn();

		let engine = this.restore(web);
		if (this.readOnly !== undefined) {
			this.engine = engine ?? new NgramEngine(web);
			this.finishOpen();
			return;
		}
		if (engine) {
			this.engine = engine;
		} else {
			this.phase = "bootstrapping";
			engine = new NgramEngine(web);
			this.engine = engine;
			this.journalId = journalId;
			this.journalOffset = 0;
			await this.bootstrap(engine);
		}
		await turn();

		const learned = await this.learnAll(engine, this.pullJournal());
		if (learned > 0) this.touch(learned);
		// Drain again for prompts appended between batches while sync is ignored.
		this.drain();
		this.finishOpen();
	}

	private finishOpen(): void {
		this.phase = "ready";
		this.loadMs = Math.round(performance.now() - this.startedAt);
		this.post({ t: "ready", status: this.status() });
		const held = this.held;
		this.held = undefined;
		if (held) this.answer(held);
	}

	private restore(web: WebPrior): NgramEngine | undefined {
		const { stateDir } = this.init;
		try {
			const loaded = readState(stateDir);
			if (!loaded) return undefined;
			const engine = NgramEngine.restore(web, loaded.snapshot);
			this.seen = loaded.seen;
			this.foreignPrompts = loaded.meta.foreignPrompts;
			this.journalId = loaded.meta.journalId;
			this.journalOffset = loaded.meta.journalOffset;
			this.stateBytes = loaded.bytes;
			this.savedAt = loaded.meta.savedAt;
			return engine;
		} catch {
			// An unusable snapshot can be rebuilt from history.
			if (this.readOnly === undefined) {
				try {
					fs.rmSync(path.join(stateDir, STATE_FILE), { force: true });
				} catch {
					// Rebuilding can proceed even if deletion fails.
				}
			}
			return undefined;
		}
	}

	private async bootstrap(engine: NgramEngine): Promise<void> {
		const foreign = readForeignPrompts(this.init.foreignHistories);
		for (let at = 0; at < foreign.length; at += INGEST_BATCH) {
			const end = Math.min(foreign.length, at + INGEST_BATCH);
			for (let i = at; i < end; i++) engine.observe(foreign[i]);
			this.foreignPrompts = end;
			await turn();
		}

		await this.learnAll(engine, await this.sessionPrompts());

		await this.learnAll(engine, this.pullJournal());

		this.dirty = true;
		this.neverSaved = true;
		this.flush();
	}

	private async sessionPrompts(): Promise<string[]> {
		const found: { text: string; at: number }[] = [];
		// Forked pi sessions repeat earlier messages.
		const earliest = new Map<number, number>();
		let sliceStart = performance.now();
		for (const { text, at } of readSessionPrompts(this.init.sessionDirs)) {
			const normalized = normalizePrompt(text);
			if (normalized.length > 0 && normalized.length <= MAX_PROMPT_UNITS) {
				const hash = promptHash(normalized);
				const known = earliest.get(hash);
				if (known === undefined || at < known) {
					earliest.set(hash, at);
					found.push({ text: normalized, at });
				}
			}
			if (performance.now() - sliceStart >= SCAN_SLICE_MS) {
				await turn();
				sliceStart = performance.now();
			}
		}
		found.sort((a, b) => a.at - b.at);
		return found.map((prompt) => prompt.text);
	}

	private learn(engine: NgramEngine, prompt: string): boolean {
		const normalized = normalizePrompt(prompt);
		if (normalized.length === 0 || normalized.length > MAX_PROMPT_UNITS) return false;
		const hash = promptHash(normalized);
		if (this.seen.has(hash)) return false;
		this.seen.add(hash);
		engine.observe(normalized);
		return true;
	}

	private async learnAll(engine: NgramEngine, prompts: readonly string[]): Promise<number> {
		let learned = 0;
		for (let at = 0; at < prompts.length; at += INGEST_BATCH) {
			const end = Math.min(prompts.length, at + INGEST_BATCH);
			for (let i = at; i < end; i++) {
				if (this.learn(engine, prompts[i])) learned++;
			}
			if (end < prompts.length) await turn();
		}
		return learned;
	}

	private pullJournal(): string[] {
		const read = readJournal(this.init.stateDir, this.journalId, this.journalOffset);
		this.journalId = read.id;
		this.journalOffset = read.offset;
		this.journalCheckedAt = Date.now();
		return read.prompts;
	}

	private drain(): void {
		const engine = this.engine;
		if (!engine) return;
		let learned = 0;
		try {
			for (const prompt of this.pullJournal()) {
				if (this.learn(engine, prompt)) learned++;
			}
		} catch (error) {
			this.error = `journal read failed: ${errorText(error)}`;
		}
		if (learned > 0) this.touch(learned);
	}

	private drainIfGrown(): void {
		if (this.readOnly !== undefined) return;
		const now = Date.now();
		if (now - this.journalCheckedAt < JOURNAL_STAT_MS) return;
		this.journalCheckedAt = now;
		let size: number;
		try {
			size = fs.statSync(path.join(this.init.stateDir, JOURNAL_FILE)).size;
		} catch {
			// The next submission recreates a missing journal.
			return;
		}
		if (size !== this.journalOffset) this.drain();
	}

	private touch(learned: number): void {
		this.dirty = true;
		this.unsaved += learned;
		this.cadence.touch();
	}

	private flush(): void {
		if (!this.engine || !this.dirty) return;
		try {
			this.persist(this.engine);
			this.dirty = false;
			this.unsaved = 0;
			this.neverSaved = false;
		} catch (error) {
			this.error = `persist failed: ${errorText(error)}`;
		}
	}

	private persist(engine: NgramEngine): void {
		const { stateDir } = this.init;
		const current = readStateMeta(stateDir);
		if (current && current.journalId === this.journalId && current.journalOffset >= this.journalOffset) {
			try {
				this.stateBytes = fs.statSync(path.join(stateDir, STATE_FILE)).size;
			} catch {
				// The size is only informational.
			}
			return;
		}
		const savedAt = Date.now();
		this.stateBytes = writeState(
			stateDir,
			{
				journalId: this.journalId,
				journalOffset: this.journalOffset,
				prompts: this.seen.size,
				foreignPrompts: this.foreignPrompts,
				savedAt,
			},
			engine.snapshot(),
			this.seen,
		);
		this.savedAt = savedAt;
	}
}

function main(): void {
	const port = parentPort;
	if (!port) {
		process.stderr.write("word-predict: engine/worker.ts is a worker_threads entry, not a script\n");
		process.exitCode = 1;
		return;
	}
	const worker = new EngineWorker(workerData as WorkerInit, (message) => port.postMessage(message));
	process.on("uncaughtException", (error) => worker.fail(error));
	process.on("unhandledRejection", (error) => worker.fail(error));
	port.on("message", (message: ToWorker) => worker.handle(message));
	worker.open().catch((error: unknown) => worker.fail(error));
}

main();

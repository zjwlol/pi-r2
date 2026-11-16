/**
 * word-predict: the engine worker. One per interactive pi process, started by
 * `../host.ts` with `new Worker(".../engine/worker.ts", { workerData: WorkerInit })`
 * and loaded by Node's type stripping; the main thread never runs engine code.
 *
 * Port of oh-my-pi `packages/coding-agent/src/predict/daemon.ts` (MIT): the
 * machine-global daemon becomes this worker, its JSONL socket becomes
 * `postMessage`, `history.db` + `cursor.json` become `journal.jsonl` and the
 * cursor inside `state.bin` (see `store.ts`).
 *
 * Life cycle:
 *   open       restore `state.bin`, or bootstrap when there is no usable one
 *              (foreign histories, pi's session files, the whole journal, then
 *              persist once); drain the journal; post `ready`
 *   complete   drain first when the journal grew (one stat at most every 2 s),
 *              then answer; before `ready` only the newest request is held
 *   sync       drain the journal (the main thread appended a prompt)
 *   persist    5 min after the last learned prompt, at most 15 min after the
 *              first unsaved one; on `shutdown` only when the unsaved backlog is
 *              large (the journal holds it, the next start replays it)
 *
 * The model is always "the state that was loaded or bootstrapped + the journal
 * lines up to the cursor, in file order, minus prompts already seen".
 */
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

/** Persist learned state once changes have been quiet this long (upstream `PERSIST_DEBOUNCE_MS`). */
const PERSIST_DEBOUNCE_MS = 5 * 60_000;
/** Persist at the latest this long after the first unpersisted change (upstream `PERSIST_MAX_DIRTY_MS`). */
const PERSIST_MAX_DIRTY_MS = 15 * 60_000;
/** Prompts per `observe` batch while opening; the event loop gets a turn between batches (upstream `INGEST_BATCH`). */
const INGEST_BATCH = 1_000;
/** While scanning session files, give the event loop a turn this often. */
const SCAN_SLICE_MS = 25;
/** A `complete` checks whether the journal grew at most this often. */
const JOURNAL_STAT_MS = 2_000;
/** `state.bin.*.tmp` files older than this were left by a writer that died. */
const STALE_TEMP_MS = 60 * 60_000;
/**
 * `shutdown` persists only when at least this many prompts were learned since
 * the last save. Encoding and fsyncing the whole state takes ~300 ms for a
 * 5 MB state, on every quit / `/new` / `/resume` / `/reload` after a prompt,
 * and the host waits 400 ms at most; a smaller backlog is replayed from the
 * journal by the next start instead.
 */
const SHUTDOWN_PERSIST_BACKLOG = 64;

type CompleteRequest = Extract<ToWorker, { t: "complete" }>;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The state directory (or its file system) refuses writes: not a failure, the engine serves without learning. */
function isUnwritable(error: unknown): boolean {
	const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	return code === "EACCES" || code === "EROFS" || code === "EPERM";
}

/** Let queued messages (`status`, `shutdown`, a newer `complete`) run. */
function turn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Remove temp files of state writers that died mid-write. */
function sweepStaleTemps(stateDir: string): void {
	try {
		const cutoff = Date.now() - STALE_TEMP_MS;
		for (const name of fs.readdirSync(stateDir)) {
			if (!name.startsWith(`${STATE_FILE}.`) || !name.endsWith(".tmp")) continue;
			const file = path.join(stateDir, name);
			try {
				if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
			} catch {
				// Gone already, or not ours to remove.
			}
		}
	} catch {
		// Housekeeping only.
	}
}

class EngineWorker {
	private readonly init: WorkerInit;
	private readonly post: (message: FromWorker) => void;
	private readonly cadence: PersistCadence;
	private phase: EngineStatus["phase"] = "loading";
	/** Why the worker failed, or the last recoverable failure (persist, drain, one query). */
	private error: string | undefined;
	private engine: NgramEngine | undefined;
	/** Hashes of every pi prompt learned (bootstrap or journal). */
	private seen = new Set<number>();
	private foreignPrompts = 0;
	/** Journal cursor: the id the offset belongs to, and the byte offset consumed so far. */
	private journalId = "";
	private journalOffset = 0;
	/** Learned something `state.bin` does not hold. */
	private dirty = false;
	/** Prompts learned since the last save (or since the state was loaded). */
	private unsaved = 0;
	/** Bootstrapped, and that state never reached the disk. */
	private neverSaved = false;
	/** Why the state directory cannot be written; set = serve in memory, no journal draining, no persisting. */
	private readOnly: string | undefined;
	private stateBytes: number | null = null;
	private savedAt: number | null = null;
	private readonly startedAt = performance.now();
	private loadMs = 0;
	/** Newest `complete` that arrived before `ready`. */
	private held: CompleteRequest | undefined;
	private journalCheckedAt = 0;

	constructor(init: WorkerInit, post: (message: FromWorker) => void) {
		this.init = init;
		this.post = post;
		this.cadence = new PersistCadence(PERSIST_DEBOUNCE_MS, PERSIST_MAX_DIRTY_MS, () => this.flush());
	}

	// --- messages ---

	handle(message: ToWorker): void {
		switch (message.t) {
			case "complete":
				if (this.phase === "ready") {
					this.drainIfGrown();
					this.answer(message);
				} else if (this.phase === "failed") {
					this.reply(message.id, null);
				} else {
					// Upstream: "a first `complete` may wait for its engine to open and ingest history".
					if (this.held) this.reply(this.held.id, null);
					this.held = message;
				}
				break;
			case "sync":
				// Before `ready` the open sequence drains the journal itself.
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

	/** Open failed or something threw outside a request: report it, answer nothing from now on. */
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
			// One query the engine cannot answer shows no ghost; the worker keeps serving.
			this.error = `complete failed: ${errorText(error)}`;
		}
		this.reply(request.id, suggestion);
	}

	private status(): EngineStatus {
		let vocabulary = 0;
		try {
			vocabulary = this.engine?.stats().learnedWords ?? 0;
		} catch {
			// Status must always answer.
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
		// A state that is still opening is not saved: the next start repeats the open.
		// A small backlog is not saved either: the journal holds every unsaved prompt.
		if (this.phase === "ready" && (this.unsaved >= SHUTDOWN_PERSIST_BACKLOG || this.neverSaved)) this.flush();
		this.post({ t: "bye" });
		process.exit(0);
	}

	// --- open ---

	async open(): Promise<void> {
		const { stateDir, priorPath } = this.init;
		let journalId = "";
		try {
			journalId = ensureJournal(stateDir);
			// Persisting needs to create and rename files here, whatever the journal allows.
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
			// In memory only: the web prior plus whatever state.bin could be read.
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

		// Journal lines past the cursor: prompts submitted since the state was saved.
		const learned = await this.learnAll(engine, this.pullJournal());
		if (learned > 0) this.touch(learned);
		// Lines appended while the batches above ran (their `sync` was ignored).
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

	/** The engine of a usable `state.bin`, or undefined (missing, unreadable, or corrupt and deleted). */
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
			// Unloadable state (corrupt, or from an incompatible version): start over
			// and rebuild it like a fresh install, as upstream wipes its state dir.
			if (this.readOnly === undefined) {
				try {
					fs.rmSync(path.join(stateDir, STATE_FILE), { force: true });
				} catch {
					// The next persist replaces it.
				}
			}
			return undefined;
		}
	}

	/** §2.2: foreign histories, pi's session files, the whole journal, then persist once. */
	private async bootstrap(engine: NgramEngine): Promise<void> {
		// 1. Claude Code / Codex prompts: as is, no dedup, not part of the seen set (as upstream).
		const foreign = readForeignPrompts(this.init.foreignHistories);
		for (let at = 0; at < foreign.length; at += INGEST_BATCH) {
			const end = Math.min(foreign.length, at + INGEST_BATCH);
			for (let i = at; i < end; i++) engine.observe(foreign[i]);
			this.foreignPrompts = end;
			await turn();
		}

		// 2. pi's own history, in first-submission order, each distinct prompt once.
		await this.learnAll(engine, await this.sessionPrompts());

		// 3. The journal from its first data line.
		await this.learnAll(engine, this.pullJournal());

		// 4. Upstream only arms its cadence here; saving at once keeps a short
		// first session from repeating the whole bootstrap.
		this.dirty = true;
		this.neverSaved = true;
		this.flush();
	}

	/** Normalized user and bash prompts of every session file, oldest first. */
	private async sessionPrompts(): Promise<string[]> {
		const found: { text: string; at: number }[] = [];
		// Forked sessions repeat earlier messages: a repeat that is not older than
		// the copy already held would lose to it after the stable sort anyway.
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

	// --- learning ---

	/** Learn one of pi's own prompts unless it is empty, too long or already seen. */
	private learn(engine: NgramEngine, prompt: string): boolean {
		const normalized = normalizePrompt(prompt);
		if (normalized.length === 0 || normalized.length > MAX_PROMPT_UNITS) return false;
		const hash = promptHash(normalized);
		if (this.seen.has(hash)) return false;
		this.seen.add(hash);
		engine.observe(normalized);
		return true;
	}

	/** `learn` in batches with an event-loop turn between them; returns how many were new. */
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

	/** Journal prompts past the cursor; advances the cursor (and follows a replaced journal). */
	private pullJournal(): string[] {
		const read = readJournal(this.init.stateDir, this.journalId, this.journalOffset);
		this.journalId = read.id;
		this.journalOffset = read.offset;
		this.journalCheckedAt = Date.now();
		return read.prompts;
	}

	/** Learn every unseen journal line past the cursor, in file order: this process's and other processes'. */
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
			// No journal right now: the next submission recreates it.
			return;
		}
		if (size !== this.journalOffset) this.drain();
	}

	// --- persistence ---

	/** `learned` prompts were learned: mark the state unsaved and (re)arm the persist timer. */
	private touch(learned: number): void {
		this.dirty = true;
		this.unsaved += learned;
		this.cadence.touch();
	}

	/** Persist if dirty; a failure is kept for `status` and retried by the next flush. */
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
		// Another process already saved a state that consumed at least as much of
		// the same journal: keep it. Otherwise last writer wins; every state.bin is
		// self-consistent, so a reader of an older one just replays more lines.
		const current = readStateMeta(stateDir);
		if (current && current.journalId === this.journalId && current.journalOffset >= this.journalOffset) {
			try {
				this.stateBytes = fs.statSync(path.join(stateDir, STATE_FILE)).size;
			} catch {
				// Replaced or removed since the meta was read; the size is informational.
			}
			return;
		}
		const savedAt = Date.now();
		// `snapshot()` prunes paste-only trigrams first, as upstream's `persist`.
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
	// Failures travel as messages; an exception must not take the thread down unreported.
	process.on("uncaughtException", (error) => worker.fail(error));
	process.on("unhandledRejection", (error) => worker.fail(error));
	port.on("message", (message: ToWorker) => worker.handle(message));
	worker.open().catch((error: unknown) => worker.fail(error));
}

main();

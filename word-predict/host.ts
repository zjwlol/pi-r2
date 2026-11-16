/**
 * word-predict: main-thread client of the engine worker, and the on/off config
 * file.
 *
 * Port of oh-my-pi `packages/coding-agent/src/predict/client.ts` (MIT), with
 * the machine-global daemon replaced by one `worker_threads` Worker per pi
 * process (`engine/worker.ts`, loaded by Node's type stripping). Kept from
 * upstream: failures never surface (a query that cannot be answered resolves
 * null and shows no ghost), the 30 s completion timeout, and 30 s of quiet
 * after the engine could not be reached. No engine code runs on this thread.
 *
 * Submitted prompts are appended to `journal.jsonl` here, synchronously, so
 * they are durable whatever the worker is doing; the worker is only nudged.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { appendJournal, ensureJournal, MAX_PROMPT_UNITS, normalizePrompt } from "./engine/store.ts";
import type { EngineStatus, FromWorker, ToWorker, WorkerInit } from "./protocol.ts";
import type { WordPredictionBackend } from "./provider.ts";

/** Directory under the agent dir holding the journal, the state and the config. */
const STATE_DIR_NAME = "word-predict";
const CONFIG_FILE = "config.json";

/** A first `complete` may wait for the engine to open and bootstrap from history. */
const COMPLETE_TIMEOUT_MS = 30_000;
/** The worker is deaf while it decodes the prior or restores a snapshot; do not hold `/word-predict status` longer. */
const STATUS_TIMEOUT_MS = 2_000;
/** After the worker failed, stay quiet this long before spawning another. */
const RETRY_AFTER_MS = 30_000;
/** Stop the worker after this long without a `complete` or `observe` (upstream `IDLE_EXIT_MS`). */
const IDLE_STOP_MS = 15 * 60_000;
/** How long `stop()` waits for the worker to persist and say `bye`. */
const STOP_TIMEOUT_MS = 400;
/** Bytes of the worker's stderr kept for `status`. */
const STDERR_TAIL = 2_048;
/** V8 old-generation cap of the worker: a fuse, not a budget. */
const WORKER_HEAP_MB = 512;

// --- config file ---------------------------------------------------------------

export interface WordPredictConfig {
	enabled: boolean;
}

/** `<agentDir>/word-predict/config.json`; a missing, unreadable or malformed file means enabled. */
export function readConfig(agentDir: string): WordPredictConfig {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, STATE_DIR_NAME, CONFIG_FILE), "utf8"));
		const enabled = typeof parsed === "object" && parsed !== null ? (parsed as { enabled?: unknown }).enabled : undefined;
		return { enabled: enabled !== false };
	} catch {
		return { enabled: true };
	}
}

/** Write the config atomically (temp file + rename). Never throws: a failed write leaves the old file. */
export function writeConfig(agentDir: string, config: WordPredictConfig): void {
	const dir = path.join(agentDir, STATE_DIR_NAME);
	const tmp = path.join(dir, `${CONFIG_FILE}.${process.pid}.tmp`);
	try {
		// Private to the user, like the journal and the state next to it (existing ones keep their mode).
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(tmp, `${JSON.stringify({ enabled: config.enabled === true })}\n`, { mode: 0o600 });
		fs.renameSync(tmp, path.join(dir, CONFIG_FILE));
	} catch {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// Nothing left to clean up.
		}
	}
}

// --- host ----------------------------------------------------------------------

export interface HostOptions {
	/** pi's agent directory (`getAgentDir()`); state lives in `<agentDir>/word-predict`. */
	agentDir: string;
	/** The `word-predict/` extension directory: `engine/worker.ts` and `data/` are resolved against it. */
	extensionDir: string;
}

export interface HostStatus {
	/** `starting` until the worker posted `ready`; `failed` until the next successful spawn or `stop()`. */
	worker: "stopped" | "starting" | "running" | "failed";
	/** Why the last worker failed, with the tail of its stderr. */
	error?: string;
	/** The live worker's latest status; absent when there is none or it never answered. */
	engine?: EngineStatus;
	stateDir: string;
}

interface PendingComplete {
	resolve(suffix: string | null): void;
	timer: NodeJS.Timeout;
}

/** One spawned worker and everything waiting on it. */
interface LiveWorker {
	worker: Worker;
	/** The worker posted `ready`. */
	ready: boolean;
	/** Latest status it reported (`ready` or a `status` reply). */
	engine: EngineStatus | undefined;
	/** Last {@link STDERR_TAIL} bytes it wrote to stderr. */
	stderr: string;
	completes: Map<number, PendingComplete>;
	statuses: Map<number, PendingStatus>;
	/** Set once `shutdown` was posted: an exit is then expected, not a failure. */
	stopping: boolean;
	/** Ends the wait of an in-flight stop (on `bye` or exit). */
	gone: (() => void) | undefined;
}

interface PendingStatus {
	resolve(status: EngineStatus | undefined): void;
	timer: NodeJS.Timeout;
}

function expandTilde(dir: string): string {
	if (dir === "~") return os.homedir();
	return dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Let a captured worker stream be read without holding the process open.
 *
 * `worker.unref()` is not enough with `stdout: true` / `stderr: true`: the
 * first read of such a stream (and a read is triggered as soon as the worker
 * writes) refs the worker's internal port until the stream ends, so Node can
 * flush it. Node switches that off for its own pass-through streams by clearing
 * this flag on them; do the same. Should a Node version not have the flag, the
 * streams are read anyway: the port then stays referenced while the worker
 * lives, which ends with `stop()`.
 */
function unrefStdio(stream: object): void {
	for (const symbol of Object.getOwnPropertySymbols(stream)) {
		if (symbol.description === "kIncrementsPortRef") (stream as Record<symbol, unknown>)[symbol] = false;
	}
}

/** Owns the engine worker of this pi process. Nothing here throws into, or rejects towards, the caller. */
export class PredictHost {
	readonly #stateDir: string;
	readonly #extensionDir: string;
	readonly #agentDir: string;
	#live: LiveWorker | undefined;
	/** In-flight stop (explicit or idle); the worker is unusable while it is set. */
	#stopping: Promise<void> | undefined;
	/** `start()` was called during a stop: spawn again once it settles. */
	#startAfterStop = false;
	/** Why the last worker failed (and that worker, for its stderr); cleared by the next spawn or `stop()`. */
	#failure: { reason: string; live?: LiveWorker } | undefined;
	/** No spawn before this time (epoch ms). */
	#retryAt = 0;
	#nextId = 1;
	#idleTimer: NodeJS.Timeout | undefined;

	/** For WordCompletionProvider. `complete` starts the worker when needed and resolves null on any failure or timeout. */
	readonly backend: WordPredictionBackend;

	constructor(options: HostOptions) {
		this.#agentDir = options.agentDir;
		this.#extensionDir = options.extensionDir;
		this.#stateDir = path.join(options.agentDir, STATE_DIR_NAME);
		this.backend = {
			complete: (before, prefix) => this.#complete(before, prefix),
			// The n-gram engine ignores feedback (accepted words are learned when the
			// prompt is submitted), so nothing is sent to the worker.
			feedback: () => {},
		};
	}

	/** Spawn the worker (idempotent). Does nothing during the retry backoff after a failure. */
	start(): void {
		try {
			if (this.#stopping) {
				this.#startAfterStop = true;
				return;
			}
			if (this.#live || Date.now() < this.#retryAt) return;
			this.#spawn();
		} catch (error) {
			// Only a spawn that threw half-way leaves a worker here.
			const live = this.#live;
			this.#live = undefined;
			this.#clearIdle();
			if (live) void live.worker.terminate().catch(() => {});
			this.#recordFailure(`could not start the worker: ${errorText(error)}`);
		}
	}

	/** Journal one submitted prompt and nudge the worker. Synchronous, never throws. */
	observe(text: string): void {
		try {
			if (typeof text !== "string") return;
			const normalized = normalizePrompt(text);
			if (normalized.length === 0 || normalized.length > MAX_PROMPT_UNITS) return;
			// Durable first: the journal is the source of truth, the worker only catches up with it.
			// The directory is created here so that it is private whoever makes it first.
			fs.mkdirSync(this.#stateDir, { recursive: true, mode: 0o700 });
			ensureJournal(this.#stateDir);
			appendJournal(this.#stateDir, normalized, Date.now());
			// With no worker there is nobody to nudge: the next start drains the journal.
			const live = this.#live;
			if (!live || live.stopping) return;
			this.#armIdle();
			this.#post(live, { t: "sync" });
		} catch {
			// A prompt that could not be journaled is only not learned.
		}
	}

	/** Worker state, with the engine's own status when a worker is up. Never rejects. */
	async status(): Promise<HostStatus> {
		try {
			const live = this.#live;
			if (live && !live.stopping) await this.#askStatus(live);
		} catch {
			// Report what is known.
		}
		const status: HostStatus = { worker: "stopped", stateDir: this.#stateDir };
		const live = this.#live;
		if (live && !live.stopping) {
			status.worker = live.ready ? "running" : "starting";
			if (live.engine) status.engine = live.engine;
		} else if (this.#failure) {
			status.worker = "failed";
			// Composed here, not at failure time: stderr may trail the `error` event.
			const stderr = this.#failure.live?.stderr.trim();
			status.error = stderr ? `${this.#failure.reason}\n${stderr}` : this.#failure.reason;
		}
		return status;
	}

	/** Ask the worker to persist and exit; terminate it after `timeoutMs` (default 400). */
	stop(timeoutMs: number = STOP_TIMEOUT_MS): Promise<void> {
		// An explicit stop is a clean slate: no pending restart, and off → on retries at once.
		this.#startAfterStop = false;
		this.#failure = undefined;
		this.#retryAt = 0;
		return this.#halt(timeoutMs);
	}

	// --- worker lifecycle ---

	#init(): WorkerInit {
		const home = os.homedir();
		const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
		const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		return {
			stateDir: this.#stateDir,
			priorPath: path.join(this.#extensionDir, "data", "web-prior.bin.zst"),
			sessionDirs: [sessionDir ? expandTilde(sessionDir) : path.join(this.#agentDir, "sessions")],
			foreignHistories: [path.join(claudeDir, "history.jsonl"), path.join(home, ".codex", "history.jsonl")],
		};
	}

	#spawn(): void {
		const worker = new Worker(path.join(this.#extensionDir, "engine", "worker.ts"), {
			workerData: this.#init(),
			// Piped, not inherited: nothing the worker prints may reach the TUI's terminal.
			stdout: true,
			stderr: true,
			resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
		});
		const live: LiveWorker = {
			worker,
			ready: false,
			engine: undefined,
			stderr: "",
			completes: new Map(),
			statuses: new Map(),
			stopping: false,
			gone: undefined,
		};
		this.#live = live;
		this.#failure = undefined;

		// Listener bodies must not throw: that would be an uncaught exception in pi.
		worker.on("message", (message: FromWorker) => {
			try {
				this.#onMessage(live, message);
			} catch {
				// Ignore a malformed message.
			}
		});
		worker.on("error", (error) => this.#onGone(live, `worker error: ${errorText(error)}`));
		worker.on("exit", (code) => this.#onGone(live, `worker exited unexpectedly (code ${code})`));
		worker.on("messageerror", () => {});
		unrefStdio(worker.stdout);
		unrefStdio(worker.stderr);
		worker.stdout.on("error", () => {});
		worker.stdout.resume();
		worker.stderr.on("error", () => {});
		worker.stderr.on("data", (chunk: Buffer | string) => {
			live.stderr = (live.stderr + chunk.toString()).slice(-STDERR_TAIL);
		});
		// The worker never keeps pi alive. After the listeners: adding a `message`
		// listener references the worker's port again.
		worker.unref();
		this.#armIdle();
	}

	#onMessage(live: LiveWorker, message: FromWorker): void {
		switch (message.t) {
			case "ready":
				live.ready = true;
				live.engine = message.status;
				break;
			case "complete": {
				const pending = live.completes.get(message.id);
				if (!pending) break;
				live.completes.delete(message.id);
				clearTimeout(pending.timer);
				pending.resolve(typeof message.suffix === "string" && message.suffix.length > 0 ? message.suffix : null);
				break;
			}
			case "status": {
				live.engine = message.status;
				if (message.status?.phase === "ready") live.ready = true;
				const pending = live.statuses.get(message.id);
				if (!pending) break;
				live.statuses.delete(message.id);
				clearTimeout(pending.timer);
				pending.resolve(message.status);
				break;
			}
			case "failed":
				this.#onGone(live, `worker failed: ${message.error}`);
				break;
			case "bye":
				live.gone?.();
				break;
		}
	}

	/** The worker errored, reported `failed`, or exited. Expected during a stop; otherwise a failure with backoff. */
	#onGone(live: LiveWorker, reason: string): void {
		try {
			if (live.stopping) {
				live.gone?.();
				return;
			}
			if (this.#live !== live) return;
			this.#live = undefined;
			this.#clearIdle();
			this.#settle(live);
			this.#recordFailure(reason, live);
			void live.worker.terminate().catch(() => {});
		} catch {
			// Never out of an event listener.
		}
	}

	#recordFailure(reason: string, live?: LiveWorker): void {
		this.#failure = { reason, live };
		this.#retryAt = Date.now() + RETRY_AFTER_MS;
	}

	/** Resolve everything waiting on `live`: completions with null, status requests with nothing. */
	#settle(live: LiveWorker): void {
		for (const pending of live.completes.values()) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		live.completes.clear();
		for (const pending of live.statuses.values()) {
			clearTimeout(pending.timer);
			pending.resolve(undefined);
		}
		live.statuses.clear();
	}

	/** Post `shutdown`, wait for `bye` / exit / `timeoutMs`, then terminate. Shared by `stop()` and the idle timer. */
	#halt(timeoutMs: number): Promise<void> {
		if (this.#stopping) return this.#stopping;
		const live = this.#live;
		if (!live) return Promise.resolve();
		live.stopping = true;
		this.#clearIdle();
		this.#settle(live);
		const wait = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : STOP_TIMEOUT_MS;
		const stopping = (async () => {
			try {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, wait);
					timer.unref();
					live.gone = () => {
						clearTimeout(timer);
						resolve();
					};
					if (!this.#post(live, { t: "shutdown" })) live.gone();
				});
				live.gone = undefined;
				await live.worker.terminate();
			} catch {
				// The worker is gone or going either way.
			}
			if (this.#live === live) this.#live = undefined;
			this.#stopping = undefined;
			if (this.#startAfterStop) {
				this.#startAfterStop = false;
				this.start();
			}
		})();
		this.#stopping = stopping;
		return stopping;
	}

	#armIdle(): void {
		this.#clearIdle();
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			// Idle stop: the next `complete` spawns a fresh worker, which restores the persisted state.
			void this.#halt(STOP_TIMEOUT_MS);
		}, IDLE_STOP_MS);
		this.#idleTimer.unref();
	}

	#clearIdle(): void {
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
	}

	// --- requests ---

	#post(live: LiveWorker, message: ToWorker): boolean {
		try {
			live.worker.postMessage(message);
			return true;
		} catch {
			return false;
		}
	}

	#complete(before: string, prefix: string): Promise<string | null> {
		try {
			// A stopping worker answers nothing; the next query after the stop starts a new one.
			if (this.#stopping) return Promise.resolve(null);
			if (!this.#live) this.start();
			const live = this.#live;
			if (!live || live.stopping) return Promise.resolve(null);
			this.#armIdle();
			const id = this.#nextId++;
			return new Promise<string | null>((resolve) => {
				const timer = setTimeout(() => {
					live.completes.delete(id);
					resolve(null);
				}, COMPLETE_TIMEOUT_MS);
				timer.unref();
				live.completes.set(id, { resolve, timer });
				// Posted even before `ready`: the worker holds the newest query and answers it once loaded.
				if (!this.#post(live, { t: "complete", id, before, prefix })) {
					clearTimeout(timer);
					live.completes.delete(id);
					resolve(null);
				}
			});
		} catch {
			return Promise.resolve(null);
		}
	}

	/** Refresh `live.engine` from the worker; settles without it when no reply comes in time. */
	#askStatus(live: LiveWorker): Promise<EngineStatus | undefined> {
		const id = this.#nextId++;
		return new Promise<EngineStatus | undefined>((resolve) => {
			const timer = setTimeout(() => {
				live.statuses.delete(id);
				resolve(undefined);
			}, STATUS_TIMEOUT_MS);
			timer.unref();
			live.statuses.set(id, { resolve, timer });
			if (!this.#post(live, { t: "status", id })) {
				clearTimeout(timer);
				live.statuses.delete(id);
				resolve(undefined);
			}
		});
	}
}

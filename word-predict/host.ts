import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { appendJournal, ensureJournal, MAX_PROMPT_UNITS, normalizePrompt } from "./engine/store.ts";
import type { EngineStatus, FromWorker, ToWorker, WorkerInit } from "./protocol.ts";
import type { WordPredictionBackend } from "./provider.ts";

const STATE_DIR_NAME = "word-predict";
const CONFIG_FILE = "config.json";

const COMPLETE_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 2_000;
const RETRY_AFTER_MS = 30_000;
const IDLE_STOP_MS = 15 * 60_000;
const STOP_TIMEOUT_MS = 400;
const STDERR_TAIL = 2_048;
const WORKER_HEAP_MB = 512;

export interface WordPredictConfig {
	enabled: boolean;
}

export function readConfig(agentDir: string): WordPredictConfig {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(agentDir, STATE_DIR_NAME, CONFIG_FILE), "utf8"));
		const enabled = typeof parsed === "object" && parsed !== null ? (parsed as { enabled?: unknown }).enabled : undefined;
		return { enabled: enabled !== false };
	} catch {
		return { enabled: true };
	}
}

export function writeConfig(agentDir: string, config: WordPredictConfig): void {
	const dir = path.join(agentDir, STATE_DIR_NAME);
	const tmp = path.join(dir, `${CONFIG_FILE}.${process.pid}.tmp`);
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(tmp, `${JSON.stringify({ enabled: config.enabled === true })}\n`, { mode: 0o600 });
		fs.renameSync(tmp, path.join(dir, CONFIG_FILE));
	} catch {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
		}
	}
}

export interface HostOptions {
	agentDir: string;
	extensionDir: string;
}

export interface HostStatus {
	worker: "stopped" | "starting" | "running" | "failed";
	error?: string;
	engine?: EngineStatus;
	stateDir: string;
}

interface PendingComplete {
	resolve(suffix: string | null): void;
	timer: NodeJS.Timeout;
}

interface LiveWorker {
	worker: Worker;
	ready: boolean;
	engine: EngineStatus | undefined;
	stderr: string;
	completes: Map<number, PendingComplete>;
	statuses: Map<number, PendingStatus>;
	stopping: boolean;
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
 * Reading a piped worker stream normally refs the worker's port.
 */
function unrefStdio(stream: object): void {
	for (const symbol of Object.getOwnPropertySymbols(stream)) {
		if (symbol.description === "kIncrementsPortRef") (stream as Record<symbol, unknown>)[symbol] = false;
	}
}

export class PredictHost {
	readonly #stateDir: string;
	readonly #extensionDir: string;
	readonly #agentDir: string;
	#live: LiveWorker | undefined;
	#stopping: Promise<void> | undefined;
	#startAfterStop = false;
	#failure: { reason: string; live?: LiveWorker } | undefined;
	#retryAt = 0;
	#nextId = 1;
	#idleTimer: NodeJS.Timeout | undefined;

	readonly backend: WordPredictionBackend;

	constructor(options: HostOptions) {
		this.#agentDir = options.agentDir;
		this.#extensionDir = options.extensionDir;
		this.#stateDir = path.join(options.agentDir, STATE_DIR_NAME);
		this.backend = {
			complete: (before, prefix) => this.#complete(before, prefix),
			feedback: () => {},
		};
	}

	start(): void {
		try {
			if (this.#stopping) {
				this.#startAfterStop = true;
				return;
			}
			if (this.#live || Date.now() < this.#retryAt) return;
			this.#spawn();
		} catch (error) {
			const live = this.#live;
			this.#live = undefined;
			this.#clearIdle();
			if (live) void live.worker.terminate().catch(() => {});
			this.#recordFailure(`could not start the worker: ${errorText(error)}`);
		}
	}

	observe(text: string): void {
		try {
			if (typeof text !== "string") return;
			const normalized = normalizePrompt(text);
			if (normalized.length === 0 || normalized.length > MAX_PROMPT_UNITS) return;
			fs.mkdirSync(this.#stateDir, { recursive: true, mode: 0o700 });
			ensureJournal(this.#stateDir);
			// The worker reads new prompts from the journal when nudged.
			appendJournal(this.#stateDir, normalized, Date.now());
			const live = this.#live;
			if (!live || live.stopping) return;
			this.#armIdle();
			this.#post(live, { t: "sync" });
		} catch {
			// Learning a prompt must not interrupt submission.
		}
	}

	async status(): Promise<HostStatus> {
		try {
			const live = this.#live;
			if (live && !live.stopping) await this.#askStatus(live);
		} catch {
		}
		const status: HostStatus = { worker: "stopped", stateDir: this.#stateDir };
		const live = this.#live;
		if (live && !live.stopping) {
			status.worker = live.ready ? "running" : "starting";
			if (live.engine) status.engine = live.engine;
		} else if (this.#failure) {
			status.worker = "failed";
			// Stderr can arrive after the worker's error event.
			const stderr = this.#failure.live?.stderr.trim();
			status.error = stderr ? `${this.#failure.reason}\n${stderr}` : this.#failure.reason;
		}
		return status;
	}

	stop(timeoutMs: number = STOP_TIMEOUT_MS): Promise<void> {
		this.#startAfterStop = false;
		this.#failure = undefined;
		this.#retryAt = 0;
		return this.#halt(timeoutMs);
	}

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
			// Worker output must not reach pi's terminal.
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

		// Exceptions in worker listeners would crash pi.
		worker.on("message", (message: FromWorker) => {
			try {
				this.#onMessage(live, message);
			} catch {
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
		// Adding a message listener refs the worker's port again.
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
		}
	}

	#recordFailure(reason: string, live?: LiveWorker): void {
		this.#failure = { reason, live };
		this.#retryAt = Date.now() + RETRY_AFTER_MS;
	}

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
			void this.#halt(STOP_TIMEOUT_MS);
		}, IDLE_STOP_MS);
		this.#idleTimer.unref();
	}

	#clearIdle(): void {
		if (this.#idleTimer) clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
	}

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
				// The worker queues the latest completion while loading.
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

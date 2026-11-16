/**
 * word-predict: messages and status exchanged between the main thread
 * (`host.ts`) and the engine worker (`engine/worker.ts`). Types only; the
 * worker is loaded by Node's type stripping, so import these with `import type`.
 *
 * Replaces oh-my-pi `packages/coding-agent/src/predict/protocol.ts` (MIT): one
 * worker per pi process instead of a machine-global daemon, so there is no
 * socket, broker or version handshake, only `postMessage`.
 */

/** `workerData` of the engine worker. */
export interface WorkerInit {
	stateDir: string;             // <agentDir>/word-predict
	priorPath: string;            // absolute path of data/web-prior.bin.zst
	sessionDirs: string[];        // roots scanned two levels deep for *.jsonl
	foreignHistories: string[];   // history.jsonl files, in ingestion order
}

/** Main thread → worker. */
export type ToWorker =
	| { t: "complete"; id: number; before: string; prefix: string }
	| { t: "sync" }
	| { t: "status"; id: number }
	| { t: "shutdown" };

/** Worker → main thread. */
export type FromWorker =
	| { t: "ready"; status: EngineStatus }
	| { t: "complete"; id: number; suffix: string | null; confidence: number | null }
	| { t: "status"; id: number; status: EngineStatus }
	| { t: "failed"; error: string }
	| { t: "bye" };

export interface EngineStatus {
	phase: "loading" | "bootstrapping" | "ready" | "failed";
	error?: string;
	prompts: number;              // distinct pi prompts learned (seen-set size)
	foreignPrompts: number;       // learned from Claude Code / Codex at bootstrap
	vocabulary: number;           // words with a learned count
	stateBytes: number | null;    // size of state.bin; null when never written
	savedAt: number | null;       // epoch ms of the state this worker loaded or last wrote
	dirty: boolean;
	loadMs: number;
}

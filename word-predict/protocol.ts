export interface WorkerInit {
	stateDir: string;
	priorPath: string;
	sessionDirs: string[];
	foreignHistories: string[];
}

export type ToWorker =
	| { t: "complete"; id: number; before: string; prefix: string }
	| { t: "sync" }
	| { t: "status"; id: number }
	| { t: "shutdown" };

export type FromWorker =
	| { t: "ready"; status: EngineStatus }
	| { t: "complete"; id: number; suffix: string | null; confidence: number | null }
	| { t: "status"; id: number; status: EngineStatus }
	| { t: "failed"; error: string }
	| { t: "bye" };

export interface EngineStatus {
	phase: "loading" | "bootstrapping" | "ready" | "failed";
	error?: string;
	prompts: number;
	foreignPrompts: number;
	vocabulary: number;
	stateBytes: number | null;
	savedAt: number | null;       // Epoch milliseconds of the loaded or saved state.
	dirty: boolean;
	loadMs: number;
}

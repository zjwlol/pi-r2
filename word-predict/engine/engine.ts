import type { Params } from "./model.ts";
import { DEFAULT_PARAMS, Model } from "./model.ts";
import type { CandidateRow } from "./query.ts";
import { QueryState } from "./query.ts";
import { decodeSnapshot, encodeSnapshot } from "./snapshot.ts";
import type { WebPrior } from "./web.ts";

export type { CandidateRow } from "./query.ts";

export interface Suggestion {
	suffix: string;
	confidence: number;
}

export interface EngineOptions {
	showThreshold?: number;
	params?: Params;
}

export interface EngineStats {
	vocabulary: number;
	learnedWords: number;
	total: number;
	pairs: number;
	trigrams: number;
}

let restored: Model | undefined;

export class NgramEngine {
	private readonly model: Model;
	private readonly query = new QueryState();
	private readonly gate: number;

	constructor(web: WebPrior, options?: EngineOptions) {
		const model = restored;
		restored = undefined;
		this.model = model ?? new Model({ ...(options?.params ?? DEFAULT_PARAMS) }, web);
		this.gate = Math.fround(options?.showThreshold ?? this.model.params.showThreshold);
	}

	static restore(web: WebPrior, snapshot: Uint8Array, options?: EngineOptions): NgramEngine {
		restored = decodeSnapshot(snapshot, { ...(options?.params ?? DEFAULT_PARAMS) }, web);
		return new NgramEngine(web, options);
	}

	complete(before: string, prefix: string): Suggestion | null {
		const best = this.query.complete(this.model, before, prefix);
		if (best === null) return null;
		// Compare both confidence and threshold as float32.
		const confidence = Math.fround(best.confidence);
		return confidence >= this.gate ? { suffix: best.suffix, confidence } : null;
	}

	observe(prompt: string): void {
		this.model.learn(prompt);
	}

	feedback(_before: string, _prefix: string, _suggestion: string, _accepted: boolean): void {}

	snapshot(): Uint8Array {
		this.model.pruneTrigrams();
		return encodeSnapshot(this.model);
	}

	stats(): EngineStats {
		const model = this.model;
		return {
			vocabulary: model.vocab.length,
			learnedWords: model.learnedWords(),
			total: model.total,
			pairs: model.pairCount(),
			trigrams: model.trigramCount(),
		};
	}

	explain(before: string, prefix: string): CandidateRow[] {
		return this.query.explain(this.model, before, prefix);
	}
}

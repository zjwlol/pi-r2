/**
 * The n-gram engine as one object: a learned model, the query scratch and
 * the show threshold. The worker and the replay CLI talk to this facade only.
 *
 * Port of the `NgramPredictor` half of oh-my-pi
 * `crates/pi-predict/src/ngram/mod.rs` (MIT): `complete` / `observe` /
 * `feedback` / `persist` of the `Predictor` trait. Reading and writing the
 * state file is the caller's business (`store.ts`); `snapshot()` returns the
 * bytes upstream's `persist` would write.
 *
 * Operating point: prefixes may be a single letter (`figure o|ut`); one show
 * threshold τ = 0.15 (`Params.showThreshold`) gates every prefix length,
 * and `EngineOptions.showThreshold` replaces it (evaluation). The point
 * favours recall: a wrong ghost costs a glance, a missing right one costs
 * the keystrokes.
 *
 * Loaded by Node's type stripping (worker and CLI): erasable syntax only.
 */
import type { Params } from "./model.ts";
import { DEFAULT_PARAMS, Model } from "./model.ts";
import type { CandidateRow } from "./query.ts";
import { QueryState } from "./query.ts";
import { decodeSnapshot, encodeSnapshot } from "./snapshot.ts";
import type { WebPrior } from "./web.ts";

export type { CandidateRow } from "./query.ts";

/** A shown completion: the rest of the word and its confidence as an `f32` (already `Math.fround`-ed). */
export interface Suggestion {
	suffix: string;
	confidence: number;
}

export interface EngineOptions {
	/** Replaces `Params.showThreshold`; `-Infinity` disables the gate. */
	showThreshold?: number;
	/** Model parameters; the tuned defaults when absent. */
	params?: Params;
}

export interface EngineStats {
	/** Words in the vocabulary (web prior included). */
	vocabulary: number;
	/** Words with a learned count. */
	learnedWords: number;
	/** Weighted count of every learned word occurrence. */
	total: number;
	pairs: number;
	trigrams: number;
}

/** Model handed from `restore` to the constructor, whose public signature has no place for it. */
let restored: Model | undefined;

export class NgramEngine {
	private readonly model: Model;
	private readonly query = new QueryState();
	/** The show threshold as upstream holds it, an `f32`. */
	private readonly gate: number;

	constructor(web: WebPrior, options?: EngineOptions) {
		const model = restored;
		restored = undefined;
		this.model = model ?? new Model({ ...(options?.params ?? DEFAULT_PARAMS) }, web);
		this.gate = Math.fround(options?.showThreshold ?? this.model.params.showThreshold);
	}

	/** Restore from upstream-format snapshot bytes; throws like `decodeSnapshot`. */
	static restore(web: WebPrior, snapshot: Uint8Array, options?: EngineOptions): NgramEngine {
		restored = decodeSnapshot(snapshot, { ...(options?.params ?? DEFAULT_PARAMS) }, web);
		return new NgramEngine(web, options);
	}

	/**
	 * Rest of the word starting with `prefix` after `before`, or null when
	 * nothing clears the show threshold. Never changes learned state.
	 */
	complete(before: string, prefix: string): Suggestion | null {
		const best = this.query.complete(this.model, before, prefix);
		if (best === null) return null;
		// Upstream casts to `f32` before gating; the comparison is between two `f32`s.
		const confidence = Math.fround(best.confidence);
		return confidence >= this.gate ? { suffix: best.suffix, confidence } : null;
	}

	/** Learn a submitted prompt. */
	observe(prompt: string): void {
		this.model.learn(prompt);
	}

	/**
	 * Accepted words are learned when the prompt is submitted. A calibrated
	 * per-(prefix, word) feedback bias measured no gain upstream, so this
	 * engine ignores feedback.
	 */
	feedback(_before: string, _prefix: string, _suggestion: string, _accepted: boolean): void {}

	/** Upstream `persist` minus the file write: `pruneTrigrams`, then `encodeSnapshot`. */
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

	/**
	 * Candidate table of a query in enumeration order, ungated (diagnostics
	 * for the replay CLI's `--explain`). Never changes learned state.
	 */
	explain(before: string, prefix: string): CandidateRow[] {
		return this.query.explain(this.model, before, prefix);
	}
}

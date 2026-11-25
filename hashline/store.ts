/**
 * hashline/store.ts: session-scoped file snapshots (what each issued tag named), named clipboard
 * registers, and the repeated-no-op counter.
 * Port of oh-my-pi `crates/pi-edit/src/store.rs` (MIT) without seen-line provenance.
 */
import { computeFileHash } from "./format.ts";
import { type Clipboard, emptyClipboard } from "./types.ts";

export const DEFAULT_MAX_PATHS = 256;
export const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
/** Ceiling on retained snapshot text, in UTF-16 code units. */
export const DEFAULT_MAX_TOTAL_CHARS = 32 * 1024 * 1024;
/** Files larger than this (bytes) are never snapshotted by `read`. */
export const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;
/** Consecutive identical no-ops before the no-change reply becomes an error. */
export const NOOP_HARD_LIMIT = 3;

/** One full-file version. `text` is LF-normalized, without BOM. */
export interface Snapshot {
	path: string;
	text: string;
	hash: string;
}

interface PathHistory {
	/** Newest first. */
	versions: Snapshot[];
	touched: number;
}

export class EditStore {
	histories = new Map<string, PathHistory>();
	clipboard: Clipboard = emptyClipboard();
	noop = new Map<string, { payload: string; count: number }>();
	clock = 0;
	maxPaths: number;
	maxVersions: number;
	maxTotalChars: number;

	constructor(maxPaths = DEFAULT_MAX_PATHS, maxVersions = DEFAULT_MAX_VERSIONS_PER_PATH, maxTotalChars = DEFAULT_MAX_TOTAL_CHARS) {
		this.maxPaths = maxPaths;
		this.maxVersions = maxVersions;
		this.maxTotalChars = maxTotalChars;
	}

	/** Record `text` (LF-normalized, no BOM) as the current version of `path` (a canonical absolute path); returns its tag. */
	record(path: string, text: string): string {
		const hash = computeFileHash(text);
		this.clock += 1;
		let history = this.histories.get(path);
		if (!history) {
			history = { versions: [], touched: this.clock };
			this.histories.set(path, history);
		}
		history.touched = this.clock;
		const index = history.versions.findIndex((v) => v.hash === hash && v.text === text);
		if (index !== -1) {
			const [existing] = history.versions.splice(index, 1);
			history.versions.unshift(existing);
		} else if (this.maxVersions > 0) {
			history.versions.unshift({ path, text, hash });
			history.versions.length = Math.min(history.versions.length, this.maxVersions);
		}
		this.evict();
		return hash;
	}

	private touch(path: string): PathHistory | undefined {
		const history = this.histories.get(path);
		if (history) {
			this.clock += 1;
			history.touched = this.clock;
		}
		return history;
	}

	/** The current (most recently recorded) version. */
	head(path: string): Snapshot | undefined {
		return this.touch(path)?.versions[0];
	}
	/** The most recent version with tag `hash`. */
	byHash(path: string, hash: string): Snapshot | undefined {
		return this.touch(path)?.versions.find((v) => v.hash === hash);
	}
	hasHash(path: string, hash: string): boolean {
		return this.byHash(path, hash) !== undefined;
	}
	byContent(path: string, text: string): Snapshot | undefined {
		return this.touch(path)?.versions.find((v) => v.text === text);
	}
	/** The path of every retained version with tag `hash` (one entry per version). */
	pathsWithHash(hash: string): string[] {
		const paths: string[] = [];
		for (const history of this.histories.values()) for (const v of history.versions) if (v.hash === hash) paths.push(v.path);
		return paths;
	}

	invalidate(path: string): void {
		this.histories.delete(path);
	}

	/** Move `from`'s history to `to` (in front of `to`'s own), one version per tag. */
	relocate(from: string, to: string): void {
		const source = this.histories.get(from);
		if (!source) return;
		this.histories.delete(from);
		this.clock += 1;
		const merged = source.versions.map((v) => ({ ...v, path: to }));
		const destination = this.histories.get(to);
		if (destination) merged.push(...destination.versions);
		const hashes = new Set<string>();
		const versions = merged.filter((v) => (hashes.has(v.hash) ? false : (hashes.add(v.hash), true))).slice(0, this.maxVersions);
		this.histories.set(to, { versions, touched: this.clock });
		this.evict();
	}

	clear(): void {
		this.histories.clear();
		this.clipboard = emptyClipboard();
		this.noop.clear();
		this.clock = 0;
	}

	/** A clipboard for one edit call: the persisted named registers (copied), no anonymous register. */
	startClipboardBatch(): Clipboard {
		const named = this.clipboard.named;
		return { lines: undefined, named: named ? new Map([...named].map(([k, v]) => [k, [...v]] as [string, string[]])) : undefined, pendingAnonCuts: undefined };
	}

	/** Publish the named registers of a finished batch. */
	commitClipboard(fork: Clipboard): void {
		if (!fork.named) return;
		if (!this.clipboard.named) this.clipboard.named = new Map();
		for (const [name, lines] of fork.named) this.clipboard.named.set(name, [...lines]);
	}

	/** Count consecutive identical no-op payloads for `path`. */
	recordNoop(path: string, payload: string): { count: number; escalate: boolean } {
		const previous = this.noop.get(path);
		const count = previous && previous.payload === payload ? previous.count + 1 : 1;
		this.noop.set(path, { payload, count });
		return { count, escalate: count >= NOOP_HARD_LIMIT };
	}
	resetNoop(path: string): void {
		this.noop.delete(path);
	}

	private retainedChars(): number {
		let total = 0;
		for (const history of this.histories.values()) for (const v of history.versions) total += v.text.length;
		return total;
	}

	/** Drop least recently used paths while over the path or size limit. */
	private evict(): void {
		while (this.histories.size > this.maxPaths || (this.histories.size > 0 && this.retainedChars() > this.maxTotalChars)) {
			let oldest: string | undefined;
			let oldestTouched = Number.POSITIVE_INFINITY;
			for (const [path, history] of this.histories) {
				if (history.touched < oldestTouched) {
					oldest = path;
					oldestTouched = history.touched;
				}
			}
			if (oldest === undefined) break;
			this.histories.delete(oldest);
		}
	}
}

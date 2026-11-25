import type { ImageContent } from "@earendil-works/pi-ai";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import {
	arrivedWhole,
	changedRegion,
	findImagePaths,
	findTokens,
	type ImageFile,
	imageToken,
	insertionRegion,
	readImage,
} from "./detect.ts";

export interface DraftImage {
	readonly n: number;
	readonly path: string;
	readonly source: string;
	readonly name: string;
	mime: string;
	size: number;
	bytes?: Buffer;
	data?: string;
	/**
	 * Dimensions are in pixels.
	 */
	dims?: { readonly width: number; readonly height: number } | null;
	missing?: boolean;
}

export interface Rewrite {
	readonly text: string;
	readonly cursor: number | undefined;
	readonly added: readonly DraftImage[];
}

export interface SubmitPlan {
	readonly text: string;
	readonly images: ImageContent[];
	readonly attached: readonly DraftImage[];
	readonly missing: readonly DraftImage[];
	readonly withheld: readonly DraftImage[];
}

const MAX_UNDONE = 32;

export function base64Of(entry: DraftImage): string | undefined {
	if (!entry.bytes) return undefined;
	entry.data ??= entry.bytes.toString("base64");
	return entry.data;
}

function adopt(entry: DraftImage, file: ImageFile): void {
	entry.bytes = file.bytes;
	entry.data = undefined;
	entry.mime = file.mime;
	entry.size = file.size;
	entry.missing = false;
	const data = base64Of(entry);
	const dims = data ? getImageDimensions(data, file.mime) : null;
	entry.dims = dims ? { width: dims.widthPx, height: dims.heightPx } : null;
}

export class Draft {
	snapshot = "";
	shown: readonly DraftImage[] = [];
	readonly #entries = new Map<number, DraftImage>();
	readonly #undone = new Set<string>();

	tokenise(prev: string, next: string, cursor?: number): Rewrite | null {
		if (this.#undone.has(next)) return null;
		const region = changedRegion(prev, next);
		if (!insertionRegion(region, next)) return null;
		const candidates = findImagePaths(next).filter((c) => arrivedWhole(c, region));
		if (candidates.length === 0) return null;

		let n = this.#nextNumber(next);
		let out = "";
		let last = 0;
		let mapped = cursor;
		const added: DraftImage[] = [];
		for (const c of candidates) {
			const file = readImage(c.path);
			if (!file) continue;
			const entry: DraftImage = { n, path: c.path, source: c.source, name: basename(c.path), mime: file.mime, size: file.size };
			adopt(entry, file);
			this.#entries.set(n, entry);
			added.push(entry);
			const token = imageToken(n++);
			out += next.slice(last, c.start) + token;
			last = c.end;
			if (cursor !== undefined && mapped !== undefined) {
				if (cursor >= c.end) mapped += token.length - (c.end - c.start);
				else if (cursor > c.start) mapped = mapped - (cursor - c.start) + token.length;
			}
		}
		if (added.length === 0) return null;
		out += next.slice(last);
		this.#undone.add(next);
		if (this.#undone.size > MAX_UNDONE) this.#undone.delete(this.#undone.values().next().value!);
		return { text: out, cursor: mapped, added };
	}

	updateShown(text: string): boolean {
		const next: DraftImage[] = [];
		if (this.#entries.size > 0) {
			const seen = new Set<number>();
			for (const t of findTokens(text)) {
				if (seen.has(t.n)) continue;
				seen.add(t.n);
				const entry = this.#entries.get(t.n);
				if (entry) next.push(entry);
			}
		}
		const prev = this.shown;
		if (prev.length === next.length && prev.every((e, i) => e === next[i])) return false;
		for (const entry of next) if (!entry.bytes && !entry.missing) this.load(entry);
		this.shown = next;
		return true;
	}

	load(entry: DraftImage): boolean {
		// The uploaded file can disappear before submission.
		if (entry.bytes) return true;
		const file = readImage(entry.path);
		if (!file) {
			entry.missing = true;
			return false;
		}
		adopt(entry, file);
		return true;
	}

	prepareSubmit(text: string, options: { vision: boolean; prev?: string }): SubmitPlan | null {
		let current = text;
		// Submission can arrive before the editor poll sees a paste.
		if (options.prev !== undefined) {
			const rewrite = this.tokenise(options.prev, current);
			if (rewrite) current = rewrite.text;
		}
		const tokens = findTokens(current);
		if (tokens.length === 0 || this.#entries.size === 0) return null;

		const attached = new Map<number, DraftImage>();
		const restore = new Map<number, DraftImage>();
		const images: ImageContent[] = [];
		const missing: DraftImage[] = [];
		const withheld: DraftImage[] = [];
		for (const t of tokens) {
			const entry = this.#entries.get(t.n);
			if (!entry || attached.has(t.n) || restore.has(t.n)) continue;
			if (!this.load(entry)) {
				missing.push(entry);
				restore.set(t.n, entry);
			} else if (!options.vision) {
				withheld.push(entry);
				restore.set(t.n, entry);
			} else {
				const data = base64Of(entry);
				if (data === undefined) {
					missing.push(entry);
					restore.set(t.n, entry);
					continue;
				}
				attached.set(t.n, entry);
				images.push({ type: "image", data, mimeType: entry.mime });
			}
		}
		if (attached.size === 0 && restore.size === 0) return current === text ? null : { text: current, images, attached: [], missing, withheld };

		let out = "";
		let last = 0;
		for (const t of tokens) {
			const entry = restore.get(t.n);
			if (!entry) continue;
			out += current.slice(last, t.start) + entry.source;
			last = t.end;
		}
		out += current.slice(last);
		return { text: out, images, attached: [...attached.values()], missing, withheld };
	}

	prune(text: string): void {
		// A prompt queued during compaction can resolve after the next draft starts.
		const keep = new Set(findTokens(text).map((t) => t.n));
		for (const n of [...this.#entries.keys()]) if (!keep.has(n)) this.#entries.delete(n);
		this.#undone.clear();
		this.snapshot = text;
		this.updateShown(text);
	}

	reset(): void {
		this.#entries.clear();
		this.#undone.clear();
		this.shown = [];
		this.snapshot = "";
	}

	#nextNumber(text: string): number {
		let max = 0;
		for (const t of findTokens(text)) if (t.n > max) max = t.n;
		// Queued prompts and undo can still reference deleted tokens.
		for (const n of this.#entries.keys()) if (n > max) max = n;
		return max + 1;
	}
}

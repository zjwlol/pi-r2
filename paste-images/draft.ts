/**
 * The prompt draft's pasted images: `[Image #N]` → file, the tokenising
 * rewrite of the editor text, and what a submitted prompt attaches.
 */
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
	/** Absolute path of the file. */
	readonly path: string;
	/** The text the token replaced (quotes included); put back when the image isn't attached. */
	readonly source: string;
	readonly name: string;
	mime: string;
	size: number;
	/** File contents (kept while the entry exists, so a later-deleted upload still sends). */
	bytes?: Buffer;
	/** Base64 of `bytes`, computed on first use. */
	data?: string;
	/** Pixel size from the header; null when unreadable. */
	dims?: { readonly width: number; readonly height: number } | null;
	/** The file couldn't be read the last time we tried. */
	missing?: boolean;
}

export interface Rewrite {
	readonly text: string;
	/** Cursor offset mapped into `text` (undefined when none was given). */
	readonly cursor: number | undefined;
	readonly added: readonly DraftImage[];
}

export interface SubmitPlan {
	readonly text: string;
	readonly images: ImageContent[];
	/** Entries attached as image content, in the order of `images`. */
	readonly attached: readonly DraftImage[];
	/** Entries whose file couldn't be read: their path text was put back. */
	readonly missing: readonly DraftImage[];
	/** Entries not attached because the model has no image input: their path text was put back. */
	readonly withheld: readonly DraftImage[];
}

/** Pre-rewrite texts remembered so an undo of our rewrite isn't redone. */
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
	/** The editor text as last observed (after any rewrite of ours). */
	snapshot = "";
	/** Entries whose token is in the editor text, in text order. A new array whenever the set changes. */
	shown: readonly DraftImage[] = [];
	readonly #entries = new Map<number, DraftImage>();
	readonly #undone = new Set<string>();

	/**
	 * Replace image paths that arrived whole between `prev` and `next` (a
	 * paste, drop or insertion; not typing) with `[Image #N]` tokens. Null
	 * when there is nothing to do, including when `next` is a text we
	 * rewrote before (the user undid our rewrite: leave it).
	 */
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

	/** Recompute {@link shown} for `text`; true when it changed. */
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

	/** (Re)read an entry's file; false (and `missing`) when it can't be read. */
	load(entry: DraftImage): boolean {
		if (entry.bytes) return true;
		const file = readImage(entry.path);
		if (!file) {
			entry.missing = true;
			return false;
		}
		adopt(entry, file);
		return true;
	}

	/**
	 * What a submitted prompt sends: every `[Image #N]` of this draft becomes
	 * image content (its marker stays in the text); paths that arrived since
	 * `prev` (the last observed editor text) and were never tokenised are
	 * tokenised first. Without image input (`vision` false), or when a file
	 * can't be read, the original path text goes back in place of the token.
	 * Null when the text references no draft image.
	 */
	prepareSubmit(text: string, options: { vision: boolean; prev?: string }): SubmitPlan | null {
		let current = text;
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

	/**
	 * After a submit: forget the entries whose token isn't in `text` (the
	 * editor's text now, normally empty), so numbering starts over at 1. An
	 * entry a new draft already uses survives (a prompt queued during
	 * compaction is resolved later, after the next draft began).
	 */
	prune(text: string): void {
		const keep = new Set(findTokens(text).map((t) => t.n));
		for (const n of [...this.#entries.keys()]) if (!keep.has(n)) this.#entries.delete(n);
		this.#undone.clear();
		this.snapshot = text;
		this.updateShown(text);
	}

	/** Forget everything (session start/shutdown). */
	reset(): void {
		this.#entries.clear();
		this.#undone.clear();
		this.shown = [];
		this.snapshot = "";
	}

	/**
	 * One past the highest number in use: by a token in the text, or by an
	 * entry of this draft (a deleted token can come back through undo, and a
	 * queued prompt may still reference it until it is submitted).
	 */
	#nextNumber(text: string): number {
		let max = 0;
		for (const t of findTokens(text)) if (t.n > max) max = t.n;
		for (const n of this.#entries.keys()) if (n > max) max = n;
		return max + 1;
	}
}

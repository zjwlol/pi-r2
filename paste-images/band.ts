/**
 * The thumbnail band above the prompt: one entry per `[Image #N]` token in
 * the editor text.
 *
 * - ANSI: a dim `[Image #N] name · size` caption over a small pi-tui `Image`
 *   (Kitty / iTerm2), or the caption alone when the terminal draws no images.
 * - Native (tsp-native calls `describe`): a wrapping `row` of omp-style chip
 *   cards (`omp.composer.chips` / `omp.composer.chip`, as rsttyd and Tern
 *   style them; props as omp's prompt/attachment-chips.ts), each with an
 *   `image` node over a registered blob, else a `media` node by path, else
 *   the file name. While tsp-native's composer hosts the editor
 *   (`isComposerHosted()`), the composer shows that row inside its
 *   `omp.editor` col (through {@link ImageBand.chips}) and the band itself
 *   describes as a hidden col, so the chips aren't drawn twice.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, Image, truncateToWidth } from "@earendil-works/pi-tui";
import { isComposerHosted } from "../shared/composer-slots.ts";
import { registerTspBlob, releaseTspBlob } from "../shared/tsp-blobs.ts";
import { formatBytes, imageToken } from "./detect.ts";
import { base64Of, type DraftImage } from "./draft.ts";

/** Plain-JSON TSP node, as tsp-native's `describe` contract takes it. */
interface JsonNode {
	readonly k: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly JsonNode[];
	readonly key?: string;
}

/** The parts of tsp-native's DescribeContext this band reads. */
export interface DescribeCx {
	supports(kind: string): boolean;
	feature?(name: string): boolean;
}

/** What the terminal can show in a chip: `image` nodes over blobs, `media` nodes by path. */
interface NativeMode {
	readonly image: boolean;
	readonly media: boolean;
}

const THUMB_COLS = 24;
/** Blobs above this aren't sent (rsttyd MAX_BLOB). */
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
/** Chip preview size (rsttyd fits it into a 36px square anyway). */
const CHIP_MAX = { w: "12ch", h: "4lines" } as const;
const HIDDEN: JsonNode = { k: "col", p: { hidden: true } };

/** Thumbnail rows for `count` images: smaller as they add up, captions only past four. */
function thumbRows(count: number): number {
	if (count <= 2) return 6;
	if (count <= 4) return 4;
	return 0;
}

function dimsText(entry: DraftImage): string | undefined {
	return entry.dims ? `${entry.dims.width}×${entry.dims.height}` : undefined;
}

export class ImageBand implements Component {
	#shown: readonly DraftImage[] = [];
	#lines?: { width: number; shown: readonly DraftImage[]; images: string | null; lines: string[] };
	#native?: { shown: readonly DraftImage[]; image: boolean; media: boolean; node: JsonNode | null };
	readonly #thumbs = new Map<DraftImage, { rows: number; image: Image }>();
	/** Blob ids this band registered, per entry. */
	readonly #blobs = new Map<DraftImage, string>();

	readonly #theme: () => Theme;

	constructor(theme: () => Theme) {
		this.#theme = theme;
	}

	/** Show `shown` (the draft's current images); releases what left. */
	sync(shown: readonly DraftImage[]): void {
		if (shown === this.#shown) return;
		const keep = new Set(shown);
		for (const entry of this.#thumbs.keys()) if (!keep.has(entry)) this.#thumbs.delete(entry);
		const kept = new Set<string>();
		for (const [entry, id] of this.#blobs) if (keep.has(entry)) kept.add(id);
		for (const [entry, id] of this.#blobs) {
			if (keep.has(entry)) continue;
			this.#blobs.delete(entry);
			// The same picture pasted twice shares one blob: keep it while another chip shows it.
			if (!kept.has(id)) releaseTspBlob(id);
		}
		this.#shown = shown;
		this.#lines = undefined;
	}

	invalidate(): void {
		this.#lines = undefined;
		this.#native = undefined;
		for (const { image } of this.#thumbs.values()) image.invalidate();
	}

	dispose(): void {
		this.sync([]);
	}

	render(width: number): string[] {
		const shown = this.#shown;
		if (shown.length === 0 || width <= 0) return [];
		const images = getCapabilities().images;
		const cached = this.#lines;
		if (cached && cached.width === width && cached.shown === shown && cached.images === images) return cached.lines;

		const theme = this.#theme();
		const rows = images ? thumbRows(shown.length) : 0;
		const lines: string[] = [];
		for (const entry of shown) {
			const parts = [entry.name];
			if (entry.missing && !entry.bytes) parts.push("missing");
			else {
				const dims = dimsText(entry);
				if (dims) parts.push(dims);
				parts.push(formatBytes(entry.size));
			}
			lines.push(truncateToWidth(` ${theme.fg("dim", `${imageToken(entry.n)} ${parts.join(" · ")}`)}`, width));
			if (rows === 0 || width < 8) continue;
			const thumb = this.#thumb(entry, rows);
			if (!thumb) continue;
			for (const line of thumb.render(width - 1)) lines.push(line === "" ? "" : ` ${line}`);
		}
		this.#lines = { width, shown, images, lines };
		return lines;
	}

	#thumb(entry: DraftImage, rows: number): Image | undefined {
		const cached = this.#thumbs.get(entry);
		if (cached && cached.rows === rows) return cached.image;
		const data = base64Of(entry);
		if (!data) return undefined;
		const theme = this.#theme();
		const image = new Image(
			data,
			entry.mime,
			{ fallbackColor: (s: string) => theme.fg("dim", s) },
			{ maxWidthCells: THUMB_COLS, maxHeightCells: rows, filename: entry.name },
			entry.dims ? { widthPx: entry.dims.width, heightPx: entry.dims.height } : undefined,
		);
		this.#thumbs.set(entry, { rows, image });
		return image;
	}

	/** Native description: a hidden col while the composer shows the chips (or there are none), else the chips row. */
	describe(cx: DescribeCx): JsonNode {
		if (isComposerHosted()) return HIDDEN;
		return this.chips(cx) ?? HIDDEN;
	}

	/**
	 * The chips row (`omp.composer.chips`), null while no image is shown; the
	 * same node object while the images and the terminal's abilities are
	 * unchanged.
	 */
	chips(cx: DescribeCx): JsonNode | null {
		const shown = this.#shown;
		// rsttyd advertises `blobs` only when it can verify what it receives; without it an image node stays empty.
		const mode: NativeMode = { image: cx.supports("image") && cx.feature?.("blobs") === true, media: cx.supports("media") };
		const cached = this.#native;
		if (cached && cached.shown === shown && cached.image === mode.image && cached.media === mode.media) return cached.node;
		const node: JsonNode | null =
			shown.length === 0
				? null
				: {
						k: "row",
						p: { role: "omp.composer.chips", gap: "sm", wrap: true },
						c: shown.map((entry) => this.#chip(entry, mode)),
					};
		this.#native = { shown, image: mode.image, media: mode.media, node };
		return node;
	}

	#chip(entry: DraftImage, mode: NativeMode): JsonNode {
		const title = `Image #${entry.n}`;
		let preview: JsonNode;
		if (mode.image && entry.bytes && entry.size <= MAX_BLOB_BYTES) {
			let blob = this.#blobs.get(entry);
			if (blob === undefined) {
				blob = registerTspBlob(entry.bytes, entry.mime);
				this.#blobs.set(entry, blob);
			}
			preview = {
				k: "image",
				p: {
					blob,
					alt: `${title} · ${entry.name}`,
					...(entry.dims ? { w: entry.dims.width, h: entry.dims.height } : {}),
					max: CHIP_MAX,
				},
			};
		} else if (mode.media && !entry.missing) {
			preview = { k: "media", p: { path: entry.path, max: CHIP_MAX } };
		} else {
			preview = { k: "text", p: { spans: [{ t: entry.name, s: "muted" }], wrap: "none" } };
		}
		const caption = entry.missing && !entry.bytes ? "missing" : (dimsText(entry) ?? formatBytes(entry.size));
		return {
			k: "card",
			key: `image:${entry.n}`,
			p: { role: "omp.composer.chip", tone: "accent", head: [{ t: title, s: "strong" }] },
			c: [preview, { k: "text", p: { spans: [{ t: caption, s: "dim" }], wrap: "none", title: `${entry.name} · ${formatBytes(entry.size)}` } }],
		};
	}
}

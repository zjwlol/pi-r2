/**
 * Finding pasted image paths in prompt text, reading the files, and the
 * `[Image #N]` tokens that stand in for them in the editor.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Files above this are left alone (pi resizes what it sends; this only bounds what we read). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** A changed region larger than this is a text paste pi collapses; paths inside it stay as written. */
const MAX_REGION_CHARS = 1000;
const MAX_REGION_LINES = 10;
const MAX_PATH_CHARS = 4096;

export interface PathCandidate {
	/** UTF-16 span in the text, quotes included. */
	readonly start: number;
	readonly end: number;
	/** The text the span covers (restored when the image isn't attached). */
	readonly source: string;
	/** Absolute filesystem path. */
	readonly path: string;
}

export interface ImageFile {
	readonly path: string;
	readonly mime: string;
	readonly size: number;
	readonly bytes: Buffer;
}

export interface Region {
	readonly start: number;
	readonly end: number;
}

const EXT = String.raw`\.(?:png|jpe?g|gif|webp)`;
const BEFORE = String.raw`(?<=^|[\s(\[<{=,"'\x60])`;
const AFTER = String.raw`(?=$|[\s)\]}>,;:!?"'\x60]|\.(?:\s|$))`;
/** Groups: 1 quote, 2 quoted path (may be a file URL), 3 file URL path, 4 bare path (backslash escapes allowed). */
const PATH_SOURCE =
	BEFORE +
	"(?:" +
	String.raw`(["'\x60])((?:~|file:\/\/)?\/[^\n"'\x60]*?${EXT})\1` +
	"|" +
	String.raw`file:\/\/(\/[^\s"'\x60]*?${EXT})` +
	"|" +
	String.raw`(~?\/(?:[^\s"'\x60\\]|\\.)*?${EXT})` +
	")" +
	AFTER;

const TOKEN_RE = /\[Image #(\d+)\]/g;

export function imageToken(n: number): string {
	return `[Image #${n}]`;
}

export interface TokenHit {
	readonly n: number;
	readonly start: number;
	readonly end: number;
}

/** Every `[Image #N]` in `text`, in order. */
export function findTokens(text: string): TokenHit[] {
	if (!text.includes("[Image #")) return [];
	const out: TokenHit[] = [];
	TOKEN_RE.lastIndex = 0;
	for (let m = TOKEN_RE.exec(text); m; m = TOKEN_RE.exec(text)) {
		out.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
	}
	return out;
}

function expandPath(raw: string): string | undefined {
	let p = raw;
	if (/^file:\/\//i.test(p)) {
		try {
			p = decodeURIComponent(p.slice(7));
		} catch {
			return undefined;
		}
	}
	if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	return isAbsolute(p) ? p : undefined;
}

/** Absolute (`/…`, `~/…`, `file:///…`) paths ending in an image extension, optionally quoted. */
export function findImagePaths(text: string): PathCandidate[] {
	if (!text.includes("/")) return [];
	const re = new RegExp(PATH_SOURCE, "gi");
	const out: PathCandidate[] = [];
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const source = m[0];
		if (source.length > MAX_PATH_CHARS) continue;
		let raw: string | undefined;
		if (m[2] !== undefined) raw = m[2];
		else if (m[3] !== undefined) raw = `file://${m[3]}`;
		else if (m[4] !== undefined) raw = m[4].replace(/\\(.)/g, "$1");
		const path = raw === undefined ? undefined : expandPath(raw);
		if (path) out.push({ start: m.index, end: m.index + source.length, source, path });
	}
	return out;
}

/** What changed between two versions of the text, as a span of `next` (null when equal). */
export function changedRegion(prev: string, next: string): Region | null {
	if (prev === next) return null;
	const max = Math.min(prev.length, next.length);
	let p = 0;
	while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
	let s = 0;
	while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
	return { start: p, end: next.length - s };
}

/** Whether `region` looks like one paste/insertion (not a large text paste pi collapses). */
export function insertionRegion(region: Region | null, next: string): region is Region {
	if (!region || region.end <= region.start) return false;
	if (region.end - region.start > MAX_REGION_CHARS) return false;
	let lines = 0;
	for (let i = region.start; i < region.end; i++) if (next.charCodeAt(i) === 10 && ++lines > MAX_REGION_LINES) return false;
	return true;
}

/**
 * Whether a candidate arrived in one piece (a paste, drop or completion), not
 * typed: (nearly) all of it lies in the changed region. The slack absorbs the
 * prefix/suffix diff's ambiguity when the paste repeats neighbouring text.
 */
export function arrivedWhole(candidate: PathCandidate, region: Region): boolean {
	const len = candidate.end - candidate.start;
	const overlap = Math.min(candidate.end, region.end) - Math.max(candidate.start, region.start);
	return overlap >= Math.max(Math.min(len, 6), len - 8, Math.ceil(len * 0.6));
}

/** Image type from magic bytes (the extension can lie). */
export function sniffMime(head: Uint8Array): string | undefined {
	if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
	if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
	if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return "image/gif";
	if (
		head.length >= 12 &&
		head[0] === 0x52 &&
		head[1] === 0x49 &&
		head[2] === 0x46 &&
		head[3] === 0x46 &&
		head[8] === 0x57 &&
		head[9] === 0x45 &&
		head[10] === 0x42 &&
		head[11] === 0x50
	) {
		return "image/webp";
	}
	return undefined;
}

/**
 * Whether a JPEG stream reaches its EOI marker (a file still being written,
 * or cut mid-scan, does not: strict provider decoders reject such bytes, and
 * one in the history fails every later request). Walks the marker structure:
 * segments carry their length, and entropy-coded scan data is skipped by
 * JPEG's byte-stuffing rules, so an EOI inside an embedded thumbnail isn't
 * mistaken for the file's end. Data after the EOI (MPF, motion photos) passes.
 */
export function jpegStreamIsComplete(bytes: Uint8Array): boolean {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
	let offset = 2;
	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) return false;
		let markOffset = offset + 1;
		while (markOffset < bytes.length && bytes[markOffset] === 0xff) markOffset++;
		if (markOffset >= bytes.length) return false;
		const marker = bytes[markOffset]!;
		if (marker === 0xd9) return true;
		offset = markOffset + 1;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (marker === 0xd8) return false;
		if (offset + 1 >= bytes.length) return false;
		const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
		if (segmentLength < 2) return false;
		offset += segmentLength;
		if (offset > bytes.length) return false;
		if (marker === 0xda) {
			// Entropy-coded data: 0xFF is stuffed as FF00, restart markers are
			// standalone, and every other following byte opens the next segment.
			while (true) {
				const next = bytes.indexOf(0xff, offset);
				if (next < 0) return false;
				let scan = next + 1;
				while (scan < bytes.length && bytes[scan] === 0xff) scan++;
				if (scan >= bytes.length) return false;
				const code = bytes[scan]!;
				if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
					offset = scan + 1;
					continue;
				}
				offset = next;
				break;
			}
		}
	}
	return false;
}

/**
 * Read an image file: a regular file, 1 byte … {@link MAX_IMAGE_BYTES}, recognised by its magic bytes.
 * A JPEG without its EOI marker (truncated, or still being written) is not one.
 */
export function readImage(path: string): ImageFile | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) return undefined;
		const bytes = Buffer.allocUnsafe(stat.size);
		let read = 0;
		while (read < bytes.length) {
			const n = readSync(fd, bytes, read, bytes.length - read, read);
			if (n <= 0) break;
			read += n;
		}
		const data = read === bytes.length ? bytes : bytes.subarray(0, read);
		const mime = sniffMime(data);
		if (mime === "image/jpeg" && !jpegStreamIsComplete(data)) return undefined;
		return mime ? { path, mime, size: data.length, bytes: data } : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
	}
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

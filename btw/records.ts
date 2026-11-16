/**
 * `/btw` records: the topic / turn types and every pure helper the views and the controller share.
 *
 * Ports oh-my-pi `packages/tui/src/overlays/btw-history.ts` (types, turn accessors, `<inject>`
 * parsing, copy text), `packages/coding-agent/src/session/btw-turn.ts` (`beginBtwTurn`,
 * `patchLatestBtwTurn`), the record schema of `packages/coding-agent/src/session/btw-history.ts`
 * (`parseRecord`, `snapshotRecord`, the sort order), `dedupeEphemeralReply` of
 * `session/messages.ts` (without its byte cap) and the display sanitizers of
 * `tui/src/overlays/extensions/display-text.ts` / `tui/src/chrome/error-block.ts`.
 *
 * No runtime import of pi packages and only erasable TypeScript: plain `node` loads this file.
 */
import { randomBytes } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";

export type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";

export interface BtwTurn {
	question: string;
	/** Images attached to the question, sent again with it on later follow-ups. */
	images?: readonly ImageContent[];
	answer: string;
	status: BtwStatus;
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export interface BtwRecord extends BtwTurn {
	id: string;
	/** Session leaf when the topic was asked; the branch point of `b`. */
	leafId: string | null;
	/** Display heading for the topic, e.g. `/sitrep`; `question` keeps the full text sent to the model. */
	title?: string;
	followUps?: readonly BtwTurn[];
}

/** An answer around its `<inject>` block: the steering prompt a side answer drafted for the main session. */
export interface InjectParts {
	before: string;
	inject: string;
	after: string;
	/** False while no opener has a close: the block may still be streaming, so it runs to the end. */
	closed: boolean;
}

/** Send state of one turn's `<inject>` block in this pi process. */
export type InjectMark = "ready" | "sending" | "sent";

/** Labels a steering prompt that has not been sent yet. */
export const INJECT_LABEL = "Inject into main session";
/** Labels a sent steering prompt. */
export const INJECTED_LABEL = "Injected into main session";

// ───────────────────────────── turn bookkeeping ─────────────────────────────

const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/** Time-sortable id matching /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/: base36 ms, "-", 10 random hex chars. */
export function newRecordId(now: number = Date.now()): string {
	const stamp = Number.isFinite(now) && now >= 0 ? Math.floor(now) : 0;
	return `${stamp.toString(36)}-${randomBytes(5).toString("hex")}`;
}

/** The topic's display heading: its title, else the opening question. */
export function getTopicLabel(record: BtwRecord): string {
	return record.title ?? record.question;
}

export function getLatestTurn(record: BtwRecord): BtwTurn {
	return record.followUps?.at(-1) ?? record;
}

export function getTurns(record: BtwRecord): readonly BtwTurn[] {
	return [record, ...(record.followUps ?? [])];
}

/** getTurns, with a titled topic's first question shown as its title. */
export function getDisplayTurns(record: BtwRecord): readonly BtwTurn[] {
	const turns = getTurns(record);
	return record.title === undefined ? turns : [{ ...turns[0]!, question: record.title }, ...turns.slice(1)];
}

/** Identifies one turn of a topic, its latest by default: a follow-up gets a new key, so per-answer marks reset. */
export function getTurnKey(record: BtwRecord, turnIndex: number = record.followUps?.length ?? 0): string {
	return `${record.id}:${turnIndex}`;
}

/** Copy the most recent nonblank answer, preserving its original whitespace. */
export function getCopyText(record: BtwRecord): string | undefined {
	if (record.followUps) {
		for (let index = record.followUps.length - 1; index >= 0; index--) {
			const answer = record.followUps[index]!.answer;
			if (answer.trim()) return answer;
		}
	}
	return record.answer.trim() ? record.answer : undefined;
}

/** New topic (id from newRecordId, title when given) or `previous` with a running turn appended; `history` = previous's turns. */
export function beginTurn(
	question: string,
	leafId: string | null,
	previous?: BtwRecord,
	images?: readonly ImageContent[],
	title?: string,
	now: number = Date.now(),
): { record: BtwRecord; history?: readonly BtwTurn[] } {
	const turn: BtwTurn = {
		question,
		...(images?.length ? { images } : {}),
		answer: "",
		status: "running",
		createdAt: now,
		updatedAt: now,
	};
	const record: BtwRecord = previous
		? { ...previous, followUps: [...(previous.followUps ?? []), turn] }
		: { ...turn, id: newRecordId(now), leafId, ...(title ? { title } : {}) };
	return { record, history: previous ? getTurns(previous) : undefined };
}

/** Patch the record's latest turn (the last follow-up, else the record itself). */
export function patchLatestTurn(record: BtwRecord, patch: Partial<BtwTurn>): BtwRecord {
	const followUps = record.followUps;
	if (followUps?.length) {
		return { ...record, followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1]!, ...patch }] };
	}
	return { ...record, ...patch };
}

// ───────────────────────────── <inject> blocks ─────────────────────────────

const INJECT_OPEN = "<inject>";
const INJECT_CLOSE = "</inject>";

/**
 * Split an answer at its last closed `<inject>` block: the last opener that has a close
 * after it, paired with the first close after it. A tag merely mentioned in prose,
 * before or after the block, cannot capture it. Without a closed block, the last opener
 * runs to the end (`closed: false`); display it only while the answer still streams.
 * Linear: the last opener before the last close is the last one with any close after it.
 */
export function splitInject(answer: string): InjectParts | undefined {
	const lastClose = answer.lastIndexOf(INJECT_CLOSE);
	const open = lastClose === -1 ? -1 : answer.lastIndexOf(INJECT_OPEN, lastClose - INJECT_OPEN.length);
	if (open !== -1) {
		const close = answer.indexOf(INJECT_CLOSE, open + INJECT_OPEN.length);
		return {
			before: answer.slice(0, open),
			inject: answer.slice(open + INJECT_OPEN.length, close),
			after: answer.slice(close + INJECT_CLOSE.length),
			closed: true,
		};
	}
	const streaming = answer.lastIndexOf(INJECT_OPEN);
	if (streaming === -1) return undefined;
	return {
		before: answer.slice(0, streaming),
		inject: answer.slice(streaming + INJECT_OPEN.length),
		after: "",
		closed: false,
	};
}

/** A block's text as shown and as sent: control sequences stripped, tabs expanded, trimmed. */
export function formatInjectText(inject: string): string {
	return sanitizeDisplayText(inject).trim();
}

/** The steering prompt to send, exactly as the block shows it; undefined while unclosed or blank. */
export function getInject(answer: string): string | undefined {
	const parts = splitInject(answer);
	const text = parts?.closed ? formatInjectText(parts.inject) : "";
	return text || undefined;
}

/** A topic's steering prompt: only its latest turn's, once that turn completed. */
export function getRecordInject(record: BtwRecord): string | undefined {
	const latest = getLatestTurn(record);
	return latest.status === "complete" ? getInject(latest.answer) : undefined;
}

// ───────────────────────────── validation ─────────────────────────────

const STATUSES: readonly BtwStatus[] = ["running", "complete", "cancelled", "error", "interrupted"];
const TURN_KEYS: readonly string[] = ["question", "images", "answer", "status", "createdAt", "updatedAt", "error"];
const RECORD_KEYS: readonly string[] = [...TURN_KEYS, "id", "leafId", "title", "followUps"];
/** Largest time value a `Date` can hold. */
const MAX_TIMESTAMP = 8.64e15;

function invalid(detail: string): Error {
	return new Error(`Invalid BTW history record: ${detail}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseString(source: Record<string, unknown>, key: string, where: string): string {
	const value = source[key];
	if (typeof value !== "string") throw invalid(`${where}${key} must be a string`);
	return value;
}

function parseTimestamp(source: Record<string, unknown>, key: string, where: string): number {
	const value = source[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_TIMESTAMP) {
		throw invalid(`${where}${key} must be a number from 0 to ${MAX_TIMESTAMP}`);
	}
	return value;
}

function parseImages(value: unknown, where: string): ImageContent[] {
	if (!Array.isArray(value)) throw invalid(`${where}images must be an array`);
	return value.map((image: unknown, index: number): ImageContent => {
		const at = `${where}images[${index}]`;
		if (!isPlainObject(image)) throw invalid(`${at} must be an object`);
		if (image.type !== "image") throw invalid(`${at}.type must be "image"`);
		if (typeof image.data !== "string") throw invalid(`${at}.data must be a string`);
		if (typeof image.mimeType !== "string") throw invalid(`${at}.mimeType must be a string`);
		return { type: "image", data: image.data, mimeType: image.mimeType };
	});
}

function parseTurn(source: Record<string, unknown>, allowed: readonly string[], where: string): BtwTurn {
	for (const key of Object.keys(source)) {
		if (!allowed.includes(key)) throw invalid(`${where}${key} must be removed`);
	}
	const question = parseString(source, "question", where);
	const images = source.images === undefined ? undefined : parseImages(source.images, where);
	const answer = parseString(source, "answer", where);
	const status = source.status;
	if (typeof status !== "string" || !STATUSES.includes(status as BtwStatus)) {
		throw invalid(`${where}status must be one of ${STATUSES.join(", ")}`);
	}
	const createdAt = parseTimestamp(source, "createdAt", where);
	const updatedAt = parseTimestamp(source, "updatedAt", where);
	const error = source.error === undefined ? undefined : parseString(source, "error", where);
	return {
		question,
		...(images ? { images } : {}),
		answer,
		status: status as BtwStatus,
		createdAt,
		updatedAt,
		...(error === undefined ? {} : { error }),
	};
}

/**
 * Validate untrusted JSON: known keys only, status enum, finite timestamps within `0…8.64e15`, a
 * file-name-safe id. Returns a fresh plain object; throws `Error("Invalid BTW history record…")`.
 */
export function parseRecord(value: unknown): BtwRecord {
	if (!isPlainObject(value)) throw invalid("must be an object");
	const turn = parseTurn(value, RECORD_KEYS, "");
	const id = value.id;
	if (typeof id !== "string" || id.length === 0) throw invalid("id must be a non-empty string");
	const leafId = value.leafId;
	if (typeof leafId !== "string" && leafId !== null) throw invalid("leafId must be a string or null");
	const title = value.title === undefined ? undefined : parseString(value, "title", "");
	let followUps: BtwTurn[] | undefined;
	if (value.followUps !== undefined) {
		if (!Array.isArray(value.followUps)) throw invalid("followUps must be an array");
		followUps = value.followUps.map((item: unknown, index: number): BtwTurn => {
			if (!isPlainObject(item)) throw invalid(`followUps[${index}] must be an object`);
			return parseTurn(item, TURN_KEYS, `followUps[${index}].`);
		});
	}
	// Ids become file names (`entry-<id>.json`): never let one leave the history directory.
	if (!RECORD_ID.test(id)) throw new Error("Invalid BTW history record id");
	return {
		...turn,
		id,
		leafId,
		...(title === undefined ? {} : { title }),
		...(followUps ? { followUps } : {}),
	};
}

/** Deep-frozen copy; with `recover`, running turns become interrupted. */
export function snapshotRecord(record: BtwRecord, recover: boolean = false): BtwRecord {
	const freezeImages = (images: readonly ImageContent[]): readonly ImageContent[] =>
		Object.freeze(images.map((image) => Object.freeze({ ...image })));
	const turnFields = (turn: BtwTurn): Pick<BtwTurn, "status" | "images"> => ({
		status: recover && turn.status === "running" ? "interrupted" : turn.status,
		...(turn.images ? { images: freezeImages(turn.images) } : {}),
	});
	return Object.freeze({
		...record,
		...turnFields(record),
		...(record.followUps
			? { followUps: Object.freeze(record.followUps.map((turn): BtwTurn => Object.freeze({ ...turn, ...turnFields(turn) }))) }
			: {}),
	});
}

/** Newest first by createdAt, ties by id ascending. */
export function sortRecords(records: Iterable<BtwRecord>): BtwRecord[] {
	return [...records].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ───────────────────────────── display text ─────────────────────────────

const TAB_SPACES = "   ";
/**
 * Terminal control sequences, removed whole so their parameters never show as text: OSC and the
 * other string sequences (DCS, SOS, PM, APC) up to BEL / ST or the end of their line, CSI, and the
 * short `ESC x` forms.
 */
const ANSI_RE =
	/(?:\x1b\]|\x9d)[^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c\n]*(?:\x1b\\|\x9c)?|(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]|\x1b[ -\/]*[0-~]/g;
/** C0 without "\t" and "\n" (CR included), DEL and C1. */
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
/** Half of a surrogate pair on its own: not displayable, not encodable. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function replaceTabs(text: string): string {
	return text.replaceAll("\t", TAB_SPACES);
}

/** Drop ANSI/OSC sequences and C0/C1 controls except "\n" and "\t", then replaceTabs. Call before theming. */
export function sanitizeDisplayText(text: string): string {
	return replaceTabs(text.replace(ANSI_RE, "").replace(CONTROL_RE, "").replace(LONE_SURROGATE_RE, ""));
}

/** sanitizeDisplayText on one row: newlines become spaces so untrusted text cannot add rows; trimmed. */
export function sanitizeDisplayLine(text: string): string {
	return sanitizeDisplayText(text)
		.replace(/[\r\n]+/g, " ")
		.trim();
}

/** One line: message of an Error or String(value), sanitized, whitespace collapsed, "Unknown error" when blank, cut to maxLength (default 240) with "…". */
export function sanitizeErrorLine(error: unknown, maxLength: number = 240): string {
	const message = error instanceof Error ? error.message : String(error);
	const line =
		sanitizeDisplayText(message.replace(/\r\n?/g, "\n"))
			.replace(/\s+/g, " ")
			.trim() || "Unknown error";
	const limit = Math.max(0, Math.floor(maxLength));
	const chars = Array.from(line);
	if (chars.length <= limit) return line;
	return limit === 0 ? "" : `${chars.slice(0, limit - 1).join("")}…`;
}

/** Runs of more than 3 identical consecutive lines become the line plus `[…N×]`. */
export function dedupeReply(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const runLength = j - i;
		if (runLength > 3) {
			out.push(lines[i]!, `[…${runLength}×]`);
		} else {
			for (let k = 0; k < runLength; k++) out.push(lines[i]!);
		}
		i = j;
	}
	return out.join("\n");
}

// ───────────────────────────── inject marks ─────────────────────────────

const INJECT_MARKS = Symbol.for("pi-extended.btw.injects");

/** Marks per turn key, on globalThis[Symbol.for("pi-extended.btw.injects")], so they outlive /reload and session switches. */
export function injectMarks(): Map<string, InjectMark> {
	const holder = globalThis as unknown as { [INJECT_MARKS]?: Map<string, InjectMark> };
	let marks = holder[INJECT_MARKS];
	if (!(marks instanceof Map)) {
		marks = new Map();
		holder[INJECT_MARKS] = marks;
	}
	return marks;
}

import { randomBytes } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";

export type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";

export interface BtwTurn {
	question: string;
	images?: readonly ImageContent[];
	answer: string;
	status: BtwStatus;
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export interface BtwRecord extends BtwTurn {
	id: string;
	leafId: string | null;
	title?: string;
	followUps?: readonly BtwTurn[];
}

export interface InjectParts {
	before: string;
	inject: string;
	after: string;
	closed: boolean;
}

export type InjectMark = "ready" | "sending" | "sent";

export const INJECT_LABEL = "Inject into main session";
export const INJECTED_LABEL = "Injected into main session";

const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function newRecordId(now: number = Date.now()): string {
	const stamp = Number.isFinite(now) && now >= 0 ? Math.floor(now) : 0;
	return `${stamp.toString(36)}-${randomBytes(5).toString("hex")}`;
}

export function getTopicLabel(record: BtwRecord): string {
	return record.title ?? record.question;
}

export function getLatestTurn(record: BtwRecord): BtwTurn {
	return record.followUps?.at(-1) ?? record;
}

export function getTurns(record: BtwRecord): readonly BtwTurn[] {
	return [record, ...(record.followUps ?? [])];
}

export function getDisplayTurns(record: BtwRecord): readonly BtwTurn[] {
	const turns = getTurns(record);
	return record.title === undefined ? turns : [{ ...turns[0]!, question: record.title }, ...turns.slice(1)];
}

export function getTurnKey(record: BtwRecord, turnIndex: number = record.followUps?.length ?? 0): string {
	return `${record.id}:${turnIndex}`;
}

export function getCopyText(record: BtwRecord): string | undefined {
	if (record.followUps) {
		for (let index = record.followUps.length - 1; index >= 0; index--) {
			const answer = record.followUps[index]!.answer;
			if (answer.trim()) return answer;
		}
	}
	return record.answer.trim() ? record.answer : undefined;
}

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

export function patchLatestTurn(record: BtwRecord, patch: Partial<BtwTurn>): BtwRecord {
	const followUps = record.followUps;
	if (followUps?.length) {
		return { ...record, followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1]!, ...patch }] };
	}
	return { ...record, ...patch };
}

const INJECT_OPEN = "<inject>";
const INJECT_CLOSE = "</inject>";

/**
 * An unpaired tag in model prose must not hide a closed block.
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

export function formatInjectText(inject: string): string {
	return sanitizeDisplayText(inject).trim();
}

export function getInject(answer: string): string | undefined {
	const parts = splitInject(answer);
	const text = parts?.closed ? formatInjectText(parts.inject) : "";
	return text || undefined;
}

export function getRecordInject(record: BtwRecord): string | undefined {
	const latest = getLatestTurn(record);
	return latest.status === "complete" ? getInject(latest.answer) : undefined;
}

const STATUSES: readonly BtwStatus[] = ["running", "complete", "cancelled", "error", "interrupted"];
const TURN_KEYS: readonly string[] = ["question", "images", "answer", "status", "createdAt", "updatedAt", "error"];
const RECORD_KEYS: readonly string[] = [...TURN_KEYS, "id", "leafId", "title", "followUps"];
/**
 * Date cannot represent a larger millisecond timestamp.
 */
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
	// Record IDs must be safe as filenames.
	if (!RECORD_ID.test(id)) throw new Error("Invalid BTW history record id");
	return {
		...turn,
		id,
		leafId,
		...(title === undefined ? {} : { title }),
		...(followUps ? { followUps } : {}),
	};
}

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

export function sortRecords(records: Iterable<BtwRecord>): BtwRecord[] {
	return [...records].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const TAB_SPACES = "   ";
/**
 * Remove whole control sequences to keep their parameters out of terminal text.
 */
const ANSI_RE =
	/(?:\x1b\]|\x9d)[^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c\n]*(?:\x1b\\|\x9c)?|(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]|\x1b[ -\/]*[0-~]/g;
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function replaceTabs(text: string): string {
	return text.replaceAll("\t", TAB_SPACES);
}

/**
 * Sanitize untrusted text before adding theme control sequences.
 */
export function sanitizeDisplayText(text: string): string {
	return replaceTabs(text.replace(ANSI_RE, "").replace(CONTROL_RE, "").replace(LONE_SURROGATE_RE, ""));
}

export function sanitizeDisplayLine(text: string): string {
	return sanitizeDisplayText(text)
		.replace(/[\r\n]+/g, " ")
		.trim();
}

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

const INJECT_MARKS = Symbol.for("pi-extended.btw.injects");

/**
 * Keep these marks across reloads and session switches.
 */
export function injectMarks(): Map<string, InjectMark> {
	const holder = globalThis as unknown as { [INJECT_MARKS]?: Map<string, InjectMark> };
	let marks = holder[INJECT_MARKS];
	if (!(marks instanceof Map)) {
		marks = new Map();
		holder[INJECT_MARKS] = marks;
	}
	return marks;
}

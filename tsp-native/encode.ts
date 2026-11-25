import { TSP_APC_ID, TSP_DEFAULT_APC_LIMIT, TSP_VERSION, type TspEvent, type TspHello, type TspReply, type TspVerb } from "./wire.ts";

const APC = "\x1b_";
const ST = "\x1b\\";
export const TSP_PREFIX = `${APC}${TSP_APC_ID};`;

export type TspIncoming = { verb: "r"; reply: TspReply } | { verb: "e"; event: TspEvent };
export type TspParams = Readonly<Record<string, string | number>>;

let nextChunkId = 1;

function leadsWithParameter(bytes: Uint8Array, at: number): boolean {
	let i = at;
	for (; i < bytes.length; i++) {
		const b = bytes[i]!;
		if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b === 0x2d))
			break;
	}
	if (i === at || bytes[i] !== 0x3d) return false;
	i++;
	while (i < bytes.length && bytes[i]! >= 0x21 && bytes[i]! <= 0x7e && bytes[i] !== 0x3b) i++;
	return bytes[i] === 0x3b;
}

function chunkEnd(bytes: Uint8Array, start: number, limit: number): number {
	const target = start + limit;
	if (target >= bytes.length) return bytes.length;
	// Continuation chunks must be valid UTF-8 without a parameter-shaped prefix.
	const safe = (at: number): boolean => (bytes[at]! & 0xc0) !== 0x80 && !leadsWithParameter(bytes, at);
	for (let at = target; at > start; at--) if (safe(at)) return at;
	for (let at = target + 1; at < bytes.length; at++) if (safe(at)) return at;
	return bytes.length;
}

function chunkBodies(body: string, byteLength: number, limit: number): string[] {
	const max = Math.max(1, Math.trunc(limit));
	const pieces: string[] = [];
	if (byteLength === body.length && !body.includes(";")) {
		for (let at = 0; at < body.length; at += max) pieces.push(body.slice(at, at + max));
		return pieces;
	}
	const bytes = Buffer.from(body, "utf8");
	for (let start = 0; start < bytes.length; ) {
		const end = chunkEnd(bytes, start, max);
		pieces.push(bytes.toString("utf8", start, end));
		start = end;
	}
	return pieces;
}

function frame(verb: TspVerb, params: string, body: string): string {
	return `${TSP_PREFIX}${verb}${params};${body}${ST}`;
}

function encodeParams(params: TspParams | undefined): string {
	if (!params) return "";
	let out = "";
	for (const key in params) out += `;${key}=${params[key]}`;
	return out;
}

/**
 * The limit applies to UTF-8 body bytes.
 */
export function encodeTspMessage(verb: TspVerb, body: string, params?: TspParams, limit: number = TSP_DEFAULT_APC_LIMIT): string {
	const base = encodeParams(params);
	if (body.length * 3 <= limit) return frame(verb, base, body);
	const byteLength = Buffer.byteLength(body, "utf8");
	if (byteLength <= limit) return frame(verb, base, body);
	const chunkId = (nextChunkId++).toString(36);
	const pieces = chunkBodies(body, byteLength, limit);
	let out = "";
	for (let i = 0; i < pieces.length; i++) {
		const more = i < pieces.length - 1 ? ";m=1" : "";
		out += frame(verb, `${i === 0 ? base : ""};c=${chunkId}${more}`, pieces[i]!);
	}
	return out;
}

export function encodeTspJson(verb: TspVerb, value: unknown, params?: TspParams, limit?: number): string {
	return encodeTspMessage(verb, JSON.stringify(value), params, limit);
}

export function encodeTspHelloQuery(app: string, features: readonly string[], ver?: string): string {
	return encodeTspJson("q", { q: "hello", v: [TSP_VERSION], app, features, ver });
}

export interface TspRawMessage {
	verb: string;
	params: Record<string, string>;
	body: string;
}

const PARAM_PATTERN = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$/;

export function splitTspMessage(sequence: string): TspRawMessage | null {
	if (!sequence.startsWith(TSP_PREFIX) || !sequence.endsWith(ST)) return null;
	const inner = sequence.slice(TSP_PREFIX.length, -ST.length);
	let semi = inner.indexOf(";");
	if (semi <= 0) return semi === -1 && inner.length > 0 ? { verb: inner, params: {}, body: "" } : null;
	const verb = inner.slice(0, semi);
	const params: Record<string, string> = {};
	let pos = semi + 1;
	for (;;) {
		semi = inner.indexOf(";", pos);
		if (semi === -1) break;
		const segment = inner.slice(pos, semi);
		if (!PARAM_PATTERN.test(segment)) break;
		const eq = segment.indexOf("=");
		params[segment.slice(0, eq)] = segment.slice(eq + 1);
		pos = semi + 1;
	}
	return { verb, params, body: inner.slice(pos) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function decodeReply(value: Record<string, unknown>): TspReply | null {
	if (value.r === "hello") {
		if (typeof value.v !== "number" || typeof value.term !== "string" || !isStringArray(value.kinds)) return null;
		return value as unknown as TspHello;
	}
	if (typeof value.r !== "string") return null;
	if (value.r === "blobs") return isStringArray(value.have) ? (value as unknown as TspReply) : null;
	return value as TspReply;
}

const EVENT_REQUIRED: Readonly<Record<string, Readonly<Record<string, "string" | "number" | "boolean" | "array">>>> = {
	ack: { s: "number" },
	resize: { cols: "number" },
	theme: { dark: "boolean" },
	motion: { reduce: "boolean" },
	visible: { visible: "boolean" },
	checkout: { shown: "boolean" },
	toggle: { id: "string", collapsed: "boolean" },
	select: { id: "string", item: "string" },
	activate: { id: "string", item: "string" },
	action: { id: "string", act: "string" },
	change: { id: "string", item: "string" },
	edit: { id: "string", from: "number", to: "number", text: "string", cursor: "number", len: "number" },
	undo: { id: "string" },
	focus: { id: "string" },
	error: { msg: "string" },
	gone: { ids: "array" },
	send: { id: "string", text: "string" },
};

function decodeEvent(value: Record<string, unknown>): TspEvent | null {
	if (typeof value.ev !== "string") return null;
	const required = EVENT_REQUIRED[value.ev];
	if (!required) return value as TspEvent;
	for (const key in required) {
		const want = required[key];
		const got = value[key];
		if (want === "array" ? !isStringArray(got) : typeof got !== want) return null;
	}
	return value as TspEvent;
}

export function decodeTspBody(verb: string, body: string): TspIncoming | null {
	if (verb !== "r" && verb !== "e") return null;
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	if (verb === "r") {
		const reply = decodeReply(value);
		return reply ? { verb, reply } : null;
	}
	const event = decodeEvent(value);
	return event ? { verb, event } : null;
}

export class TspReader {
	#chunks = new Map<string, string>();

	feed(sequence: string): TspIncoming | null {
		const raw = splitTspMessage(sequence);
		if (!raw) return null;
		let body = raw.body;
		const chunkId = raw.params.c;
		if (chunkId !== undefined) {
			const joined = (this.#chunks.get(chunkId) ?? "") + body;
			if (raw.params.m === "1") {
				this.#chunks.set(chunkId, joined);
				return null;
			}
			this.#chunks.delete(chunkId);
			body = joined;
		}
		return decodeTspBody(raw.verb, body);
	}
}

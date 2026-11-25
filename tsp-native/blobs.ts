import type { TspBlob } from "../shared/tsp-blobs.ts";
import { encodeTspMessage } from "./encode.ts";
import type { TspNode, TspOp } from "./wire.ts";

/**
 * The terminal applies this limit to decoded bytes.
 */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;

/**
 * The MIME parameter cannot contain semicolons.
 */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export function collectBlobIds(op: TspOp, out: Set<string>): void {
	if (op[0] === "set") {
		const blob = op[2].blob;
		if (typeof blob === "string") out.add(blob);
	} else if (op[0] === "add") {
		const visit = (node: TspNode): void => {
			if (node.k === "image" && typeof node.p?.blob === "string") out.add(node.p.blob);
			if (node.c) for (const child of node.c) visit(child);
		};
		visit(op[4]);
	}
}

export function blobParams(blob: TspBlob): Record<string, string> {
	const mime = blob.mime.trim().toLowerCase();
	return { id: blob.id, mime: MIME.test(mime) ? mime : "application/octet-stream" };
}

/**
 * The terminal requires padded base64.
 */
export function blobBody(blob: TspBlob): string {
	const { bytes } = blob;
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function encodeTspBlob(blob: TspBlob, limit: number): { params: Record<string, string>; body: string; encoded: string } {
	const params = blobParams(blob);
	const body = blobBody(blob);
	return { params, body, encoded: encodeTspMessage("b", body, params, limit) };
}

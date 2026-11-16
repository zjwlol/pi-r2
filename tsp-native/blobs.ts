/**
 * Blob delivery helpers for the backend, ported from oh-my-pi
 * `native/backend.ts` (`collectBlobs`, `blobParams`, `#sendBlob`).
 *
 * Wire (verb `b`, program → terminal):
 *
 *     ESC _ tsp ; b ; id=<sha256 hex> ; mime=<type> ; <base64 of the bytes> ESC \
 *
 * chunked like every message past the `apc` limit (`c=<chunk>` on every
 * chunk, `m=1` on all but the last, `id`/`mime` on the first only). The
 * terminal decodes the joined body, checks its sha256 against `id` and keeps
 * it for the `image` nodes whose `p.blob` names it (rsttyd
 * `frontend/js/tsp-blobs.js` `readBlob`, `frontend/js/tsp-session.js`
 * `#blob`); `mime` is a hint, the terminal sniffs the bytes. A blob is not a
 * frame: no sequence number, no credit, no ack.
 */
import type { TspBlob } from "../shared/tsp-blobs.ts";
import { encodeTspMessage } from "./encode.ts";
import type { TspNode, TspOp } from "./wire.ts";

/** Largest blob rsttyd accepts (`MAX_BLOB`, decoded bytes); bigger ones are rejected after crossing the pty, so they aren't sent. */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;

/** A media type that is safe as a `k=v` parameter value (printable ASCII, no `;`). */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** Blob ids referenced by `image` nodes an op adds (nested children included) or by a `set` of `blob`. */
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

/** A `b` message's parameters: the content address the terminal verifies, and the (sanitized) mime hint. */
export function blobParams(blob: TspBlob): Record<string, string> {
	const mime = blob.mime.trim().toLowerCase();
	return { id: blob.id, mime: MIME.test(mime) ? mime : "application/octet-stream" };
}

/** The base64 body of a `b` message (padded, as rsttyd requires). */
export function blobBody(blob: TspBlob): string {
	const { bytes } = blob;
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** The complete `b` message (every chunk, in order) for `blob` under the negotiated APC `limit`. */
export function encodeTspBlob(blob: TspBlob, limit: number): { params: Record<string, string>; body: string; encoded: string } {
	const params = blobParams(blob);
	const body = blobBody(blob);
	return { params, body, encoded: encodeTspMessage("b", body, params, limit) };
}

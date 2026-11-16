/**
 * Content-addressed image bytes for TSP `image` nodes, shared by the
 * pi-extended extensions (this directory has no index.ts, so pi doesn't load
 * it as an extension).
 *
 * A component registers the bytes and puts the returned id in its node's
 * `p.blob`; tsp-native's backend looks the id up here and uploads the bytes
 * (verb `b`) once per terminal connection, before the frame that first
 * references it. Ids are the lowercase sha256 hex of the bytes, which is what
 * the terminal verifies a `b` body against (rsttyd
 * `frontend/js/tsp-blobs.js` `readBlob`; oh-my-pi `native/blobs.ts`).
 *
 * The registry lives on `globalThis` under a registered symbol, so every
 * module copy jiti loads (one per extension, a fresh one per reload) shares
 * it.
 */
import { createHash } from "node:crypto";

export interface TspBlob {
	readonly id: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
}

interface TspBlobRegistry {
	readonly blobs: Map<string, TspBlob>;
	/** Ids already computed for a bytes object, so re-registering it on every describe skips the hash. */
	readonly ids: WeakMap<Uint8Array, string>;
}

const REGISTRY = Symbol.for("pi-extended.tsp-blobs");

function registry(): TspBlobRegistry {
	const holder = globalThis as unknown as { [REGISTRY]?: TspBlobRegistry };
	let current = holder[REGISTRY];
	if (!current || !(current.blobs instanceof Map) || !(current.ids instanceof WeakMap)) {
		current = { blobs: new Map(), ids: new WeakMap() };
		holder[REGISTRY] = current;
	}
	return current;
}

/** Lowercase sha256 hex of `bytes`. */
function blobId(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Register image bytes for TSP `image` nodes; returns the content-addressed
 * blob id to put in the node's `p.blob`. Idempotent for identical bytes (the
 * first registration's mime wins; the terminal sniffs the real type anyway).
 * The registry keeps `bytes` as given: don't mutate them afterwards.
 */
export function registerTspBlob(bytes: Uint8Array, mime: string): string {
	const reg = registry();
	let id = reg.ids.get(bytes);
	if (id === undefined) {
		id = blobId(bytes);
		reg.ids.set(bytes, id);
	}
	if (!reg.blobs.has(id)) reg.blobs.set(id, { id, mime, bytes });
	return id;
}

/** A registered blob by id. */
export function getTspBlob(id: string): TspBlob | undefined {
	return registry().blobs.get(id);
}

/**
 * Drop a blob the caller no longer shows (best effort: a backend may already
 * have sent it, and a later connection can no longer deliver it to a node
 * that still references it).
 */
export function releaseTspBlob(id: string): void {
	registry().blobs.delete(id);
}

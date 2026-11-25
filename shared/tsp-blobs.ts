import { createHash } from "node:crypto";

export interface TspBlob {
	readonly id: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
}

interface TspBlobRegistry {
	readonly blobs: Map<string, TspBlob>;
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

/**
 * The terminal expects a lowercase SHA-256 hex digest.
 */
function blobId(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Keep the bytes unchanged after registration to preserve their digest.
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

export function getTspBlob(id: string): TspBlob | undefined {
	return registry().blobs.get(id);
}

/**
 * A reconnect can only upload blobs that are still registered.
 */
export function releaseTspBlob(id: string): void {
	registry().blobs.delete(id);
}

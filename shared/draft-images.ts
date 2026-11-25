import type { ImageContent } from "@earendil-works/pi-ai";

export interface DraftImagePlan {
	text: string;
	images: ImageContent[];
}

/**
 * Resolving with scope `editor` consumes the submitted draft.
 */
export type DraftImageResolver = (text: string, options: { vision: boolean; scope: "editor" | "detached" }) => DraftImagePlan | undefined;

interface DraftImageRegistry {
	resolver: DraftImageResolver | undefined;
}

const REGISTRY = Symbol.for("pi-extended.draft-images");

function registry(): DraftImageRegistry {
	const holder = globalThis as unknown as { [REGISTRY]?: DraftImageRegistry };
	let current = holder[REGISTRY];
	if (!current || typeof current !== "object" || (current.resolver !== undefined && typeof current.resolver !== "function")) {
		current = { resolver: undefined };
		holder[REGISTRY] = current;
	}
	return current;
}

/**
 * Check ownership before clearing because a reload can replace the resolver.
 */
export function setDraftImageResolver(resolver: DraftImageResolver | undefined): void {
	registry().resolver = typeof resolver === "function" ? resolver : undefined;
}

export function getDraftImageResolver(): DraftImageResolver | undefined {
	return registry().resolver;
}

export function resolveDraftImages(text: string, options: { vision: boolean; scope: "editor" | "detached" }): DraftImagePlan | undefined {
	const resolver = registry().resolver;
	if (!resolver) return undefined;
	try {
		const plan = resolver(text, options);
		if (!plan || typeof plan.text !== "string" || !Array.isArray(plan.images)) return undefined;
		return plan;
	} catch {
		return undefined;
	}
}

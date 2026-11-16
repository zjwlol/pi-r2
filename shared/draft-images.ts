/**
 * The draft-image resolver, shared by the pi-extended extensions like
 * `tsp-blobs.ts` and `composer-slots.ts` (this directory has no index.ts, so
 * pi doesn't load it as an extension).
 *
 * pi hands an extension command only the text after its name: the `input`
 * event, where paste-images turns the `[Image #N]` tokens of a prompt into
 * image content, doesn't fire for it, and only paste-images' private draft
 * knows the files behind the tokens. paste-images registers one resolver
 * here; a command that sends its text to a model itself (`/btw`) asks it for
 * the images of that text. Without paste-images loaded there is no resolver
 * and such a text stays text only.
 *
 * No upstream counterpart: oh-my-pi's editor carries a draft's images with
 * the submitted text (`BtwController.start(question, images)`).
 *
 * The state lives on `globalThis` under a registered symbol, so every module
 * copy jiti loads (one per extension, a fresh one per reload) shares it.
 */
import type { ImageContent } from "@earendil-works/pi-ai";

export interface DraftImagePlan {
	/** The text to send: markers of attached images kept, the path back in place of a marker that isn't attached. */
	text: string;
	/** Image content of the attached images, in text order. */
	images: ImageContent[];
}

/**
 * `vision`: whether the model that gets the text takes image input (without
 * it nothing is attached and the paths go back into the text).
 * `scope` "editor": `text` was just submitted from the prompt editor, its
 * `[Image #N]` tokens are the draft's, and the draft is consumed as by a
 * submitted prompt. "detached": `text` never was in the prompt editor; the
 * image paths it holds are attached.
 * Undefined when the text references no image.
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
 * Register (or with undefined, remove) the resolver. There is one: a later
 * registration replaces the earlier, so an owner that goes away removes it
 * only while `getDraftImageResolver()` is still its own (a reloaded copy may
 * already have taken its place).
 */
export function setDraftImageResolver(resolver: DraftImageResolver | undefined): void {
	registry().resolver = typeof resolver === "function" ? resolver : undefined;
}

/** The registered resolver. */
export function getDraftImageResolver(): DraftImageResolver | undefined {
	return registry().resolver;
}

/** The resolver's plan; undefined without a resolver, when it throws, or when the text references no image. */
export function resolveDraftImages(text: string, options: { vision: boolean; scope: "editor" | "detached" }): DraftImagePlan | undefined {
	const resolver = registry().resolver;
	if (!resolver) return undefined;
	try {
		const plan = resolver(text, options);
		// The resolver may be another module copy's: take only the documented shape.
		if (!plan || typeof plan.text !== "string" || !Array.isArray(plan.images)) return undefined;
		return plan;
	} catch {
		return undefined;
	}
}

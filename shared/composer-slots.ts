/**
 * Slots in tsp-native's composer (the native `omp.editor` chat bar) that
 * other pi-extended extensions fill, shared like `tsp-blobs.ts` (this
 * directory has no index.ts, so pi doesn't load it as an extension).
 *
 * - Attachments: a provider describes a `NativeNode` (role
 *   `omp.composer.chips`) or null while it has nothing staged; the composer
 *   puts each non-null node inside its `omp.editor` col above the input line,
 *   in key order. Memo contract: the same node object while nothing changed.
 * - Hosted: tsp-native sets it while its composer describes the editor
 *   natively (false when it falls back to rows or the session is ANSI), so an
 *   extension's own above-editor band can step aside instead of drawing the
 *   same chips twice.
 * - Ghost: a provider returns the ghost text to draw after the prompt editor's
 *   caret; tsp-native puts it on the `editor` node.
 *
 * The state lives on `globalThis` under a registered symbol, so every module
 * copy jiti loads (one per extension, a fresh one per reload) shares it.
 */

export interface ComposerAttachmentProvider {
	/** A NativeNode (role "omp.composer.chips") or null when empty; the same object while unchanged. `cx` is tsp-native's DescribeContext. */
	describe(cx: unknown): unknown;
}

export interface ComposerGhostProvider {
	/** Ghost text after the caret of prompt editor `editor` in its current state, or undefined. Synchronous and cheap: called every described frame. */
	ghost(editor: unknown): string | undefined;
}

interface ComposerSlots {
	readonly attachments: Map<string, ComposerAttachmentProvider>;
	/** The providers sorted by key, cached until the registry changes. */
	sorted: readonly ComposerAttachmentProvider[] | undefined;
	hosted: boolean;
	ghost?: ComposerGhostProvider;
}

const SLOTS = Symbol.for("pi-extended.composer-slots");

function slots(): ComposerSlots {
	const holder = globalThis as unknown as { [SLOTS]?: ComposerSlots };
	let current = holder[SLOTS];
	if (!current || !(current.attachments instanceof Map) || typeof current.hosted !== "boolean") {
		current = { attachments: new Map(), sorted: undefined, hosted: false };
		holder[SLOTS] = current;
	}
	return current;
}

/** Register (or with `undefined`, remove) the attachment provider under `key`. */
export function setComposerAttachments(key: string, provider: ComposerAttachmentProvider | undefined): void {
	const s = slots();
	if (provider) {
		if (s.attachments.get(key) === provider) return;
		s.attachments.set(key, provider);
	} else if (!s.attachments.delete(key)) return;
	s.sorted = undefined;
}

/** The registered providers, sorted by key; the same array while the registry is unchanged. */
export function composerAttachments(): readonly ComposerAttachmentProvider[] {
	const s = slots();
	s.sorted ??= Object.freeze(
		[...s.attachments.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, provider]) => provider),
	);
	return s.sorted;
}

/** tsp-native: true while its composer describes the editor natively, false when it falls back / goes ANSI. */
export function setComposerHosted(hosted: boolean): void {
	slots().hosted = hosted;
}

export function isComposerHosted(): boolean {
	return slots().hosted;
}

/** Register (or with `undefined`, remove) the ghost provider. */
export function setComposerGhost(provider: ComposerGhostProvider | undefined): void {
	slots().ghost = provider;
}

/** The registered provider (to remove only one's own). */
export function composerGhostProvider(): ComposerGhostProvider | undefined {
	return slots().ghost;
}

/** tsp-native: the ghost for `editor` this frame; undefined when none, empty, or the provider throws. */
export function composerGhost(editor: unknown): string | undefined {
	const provider = slots().ghost;
	if (!provider) return undefined;
	try {
		const ghost = provider.ghost(editor);
		return typeof ghost === "string" && ghost !== "" ? ghost : undefined;
	} catch {
		return undefined;
	}
}

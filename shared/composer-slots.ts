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
 *
 * The state lives on `globalThis` under a registered symbol, so every module
 * copy jiti loads (one per extension, a fresh one per reload) shares it.
 */

export interface ComposerAttachmentProvider {
	/** A NativeNode (role "omp.composer.chips") or null when empty; the same object while unchanged. `cx` is tsp-native's DescribeContext. */
	describe(cx: unknown): unknown;
}

interface ComposerSlots {
	readonly attachments: Map<string, ComposerAttachmentProvider>;
	/** The providers sorted by key, cached until the registry changes. */
	sorted: readonly ComposerAttachmentProvider[] | undefined;
	hosted: boolean;
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

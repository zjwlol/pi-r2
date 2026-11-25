export interface ComposerAttachmentProvider {
	describe(cx: unknown): unknown;
}

export interface ComposerGhostProvider {
	ghost(editor: unknown): string | undefined;
}

interface ComposerSlots {
	readonly attachments: Map<string, ComposerAttachmentProvider>;
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

export function setComposerAttachments(key: string, provider: ComposerAttachmentProvider | undefined): void {
	const s = slots();
	if (provider) {
		if (s.attachments.get(key) === provider) return;
		s.attachments.set(key, provider);
	} else if (!s.attachments.delete(key)) return;
	s.sorted = undefined;
}

export function composerAttachments(): readonly ComposerAttachmentProvider[] {
	const s = slots();
	s.sorted ??= Object.freeze(
		[...s.attachments.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, provider]) => provider),
	);
	return s.sorted;
}

export function setComposerHosted(hosted: boolean): void {
	slots().hosted = hosted;
}

export function isComposerHosted(): boolean {
	return slots().hosted;
}

export function setComposerGhost(provider: ComposerGhostProvider | undefined): void {
	slots().ghost = provider;
}

export function composerGhostProvider(): ComposerGhostProvider | undefined {
	return slots().ghost;
}

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

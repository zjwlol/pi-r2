/**
 * Chips in the prompt editor, shared like `composer-slots.ts` (this directory
 * has no index.ts, so pi doesn't load it as an extension).
 *
 * A chip is a range of the draft that an extension marks as a "selected"
 * token (subagent: a `^model` tag that resolves to a model). The extension
 * that owns the editor (magic-keywords' MagicEditor) asks for the chips on
 * every render and draws them: a pill in the ANSI rows, a decoration on
 * tsp-native's `editor` node. Providers only say where; the look is the
 * editor's.
 *
 * The state lives on `globalThis` under a registered symbol, so every module
 * copy jiti loads (one per extension, a fresh one per reload) shares it.
 * With no provider registered, or no editor asking, nothing happens.
 */

/** A range of the draft, as UTF-16 offsets into the editor's lines joined by "\n": `from` inclusive, `to` exclusive. */
export interface EditorChip {
	from: number;
	to: number;
}

export interface EditorChipProvider {
	/** The chips of `text`. Called on every editor render: must be synchronous, cheap and cached. */
	chips(text: string): readonly EditorChip[];
}

interface ChipRegistry {
	readonly providers: Map<string, EditorChipProvider>;
}

const CHIPS = Symbol.for("pi-extended.editor-chips");
const NO_CHIPS: readonly EditorChip[] = Object.freeze([]);

function registry(): ChipRegistry {
	const holder = globalThis as unknown as { [CHIPS]?: ChipRegistry };
	let current = holder[CHIPS];
	if (!current || !(current.providers instanceof Map)) {
		current = { providers: new Map() };
		holder[CHIPS] = current;
	}
	return current;
}

/**
 * Register `provider` under `key` (replacing any provider already there).
 * Returns the function that removes it; that function does nothing when
 * another provider has taken the key since.
 */
export function registerEditorChipProvider(key: string, provider: EditorChipProvider): () => void {
	const { providers } = registry();
	providers.set(key, provider);
	return () => {
		if (providers.get(key) === provider) providers.delete(key);
	};
}

/**
 * The chips every registered provider reports for `text`: valid ranges only
 * (integers with 0 <= from < to <= text.length), sorted by `from`, and never
 * overlapping (of two that overlap, the one starting first stays). A provider
 * that throws or returns a non-array counts as having none. Never throws.
 */
export function editorChips(text: string): readonly EditorChip[] {
	const { providers } = registry();
	if (providers.size === 0) return NO_CHIPS;
	const all: EditorChip[] = [];
	for (const provider of providers.values()) {
		let list: unknown;
		try {
			list = provider.chips(text);
		} catch {
			continue;
		}
		if (!Array.isArray(list)) continue;
		for (const chip of list as unknown[]) {
			if (typeof chip !== "object" || chip === null) continue;
			const { from, to } = chip as { from?: unknown; to?: unknown };
			if (typeof from !== "number" || typeof to !== "number") continue;
			if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
			if (from < 0 || from >= to || to > text.length) continue;
			all.push({ from, to });
		}
	}
	if (all.length === 0) return NO_CHIPS;
	all.sort((a, b) => a.from - b.from || a.to - b.to);
	const out: EditorChip[] = [];
	let end = 0;
	for (const chip of all) {
		if (chip.from < end) continue;
		out.push(chip);
		end = chip.to;
	}
	return out;
}

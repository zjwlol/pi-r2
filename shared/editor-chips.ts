/**
 * Chip ranges use half-open UTF-16 offsets into the draft joined with `\n`.
 */
export interface EditorChip {
	from: number;
	to: number;
}

export interface EditorChipProvider {
	/**
	 * The editor calls providers on every render.
	 */
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

export function registerEditorChipProvider(key: string, provider: EditorChipProvider): () => void {
	const { providers } = registry();
	providers.set(key, provider);
	return () => {
		if (providers.get(key) === provider) providers.delete(key);
	};
}

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

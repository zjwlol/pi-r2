/**
 * Patches pi's built-in /model selector (ModelSelectorComponent) so recently
 * used models are listed right after the current one, tagged with when they
 * were last used.
 *
 * /model is handled by interactive mode before extension commands run, so it
 * can't be replaced with registerCommand. Instead we wrap two of the
 * component's (TS-private, runtime-public) methods on the shared prototype:
 *   - sortModels: reorder as current → recent (MRU order) → pi's default order
 *   - updateList: append " · 5m ago" to visible recent rows
 *
 * The prototype is patched once per process; behavior is delegated to a hook
 * on globalThis that each extension runtime installs/clears, so /reload picks
 * up new code and a removed extension stops affecting the selector. If pi's
 * internals change shape, the wrappers fall back to the original behavior.
 */
import { ModelSelectorComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { modelKey, type RecentModel } from "./history.ts";

export interface SelectorHook {
	recent(): RecentModel[];
	theme(): Theme;
}

interface ModelItem {
	provider: string;
	id: string;
}

/** Shape of the ModelSelectorComponent internals we touch. */
interface SelectorInternals {
	currentModel?: { provider: string; id: string };
	filteredModels?: ModelItem[];
	selectedIndex?: number;
	listContainer?: { children?: unknown[] };
	[RECENT]?: Map<string, number>;
}

const HOOK = Symbol.for("pi-extended.remember-model.selector-hook");
const PATCHED = Symbol.for("pi-extended.remember-model.selector-patched");
const RECENT = Symbol.for("pi-extended.remember-model.recent");
/** Mirrors maxVisible in ModelSelectorComponent.updateList. */
const MAX_VISIBLE = 10;

type GlobalWithHook = typeof globalThis & { [HOOK]?: SelectorHook };

export function setSelectorHook(hook: SelectorHook | undefined): void {
	(globalThis as GlobalWithHook)[HOOK] = hook;
}

const getHook = () => (globalThis as GlobalWithHook)[HOOK];

/** Returns false if the selector doesn't look like what we expect (nothing patched). */
export function patchModelSelector(): boolean {
	const proto = (ModelSelectorComponent as unknown as { prototype?: Record<PropertyKey, unknown> } | undefined)
		?.prototype;
	if (!proto) return false;
	if (proto[PATCHED]) return true;
	const origSort = proto.sortModels;
	const origUpdate = proto.updateList;
	if (typeof origSort !== "function" || typeof origUpdate !== "function") return false;

	proto.sortModels = function (this: SelectorInternals, models: ModelItem[]): ModelItem[] {
		const sorted: ModelItem[] = origSort.call(this, models);
		const hook = getHook();
		if (!hook) return sorted;
		try {
			const recent = hook.recent();
			this[RECENT] = new Map(recent.map((m) => [modelKey(m.provider, m.id), m.lastUsed]));
			return sortByRecent(sorted, this.currentModel, recent);
		} catch {
			return sorted;
		}
	};

	proto.updateList = function (this: SelectorInternals): void {
		origUpdate.call(this);
		const hook = getHook();
		if (!hook) return;
		try {
			decorateRecent(this, hook.theme());
		} catch {
			// Cosmetic only.
		}
	};

	proto[PATCHED] = true;
	return true;
}

function sortByRecent<T extends ModelItem>(
	sorted: T[],
	current: { provider: string; id: string } | undefined,
	recent: RecentModel[],
): T[] {
	const rank = new Map(recent.map((m, i) => [modelKey(m.provider, m.id), i]));
	const score = (item: T) =>
		current && item.provider === current.provider && item.id === current.id
			? -1
			: (rank.get(modelKey(item.provider, item.id)) ?? Number.MAX_SAFE_INTEGER);
	// Array#sort is stable, so everything that isn't recent keeps pi's order.
	return [...sorted].sort((a, b) => score(a) - score(b));
}

function decorateRecent(self: SelectorInternals, theme: Theme): void {
	const recent = self[RECENT];
	const items = self.filteredModels;
	const rows = self.listContainer?.children;
	if (!recent?.size || !Array.isArray(items) || !Array.isArray(rows) || items.length === 0) return;

	const selectedIndex = self.selectedIndex ?? 0;
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE));
	const end = Math.min(start + MAX_VISIBLE, items.length);
	const now = Date.now();
	const current = self.currentModel;

	for (let i = start; i < end; i++) {
		const row = rows[i - start];
		const item = items[i];
		if (!(row instanceof Text) || !item) return;
		const text = (row as unknown as { text?: unknown }).text;
		// Bail out entirely if rows don't line up with items (pi internals changed).
		if (typeof text !== "string" || !text.includes(item.id) || !text.includes(`[${item.provider}]`)) return;
		if (current && current.provider === item.provider && current.id === item.id) continue;
		const lastUsed = recent.get(modelKey(item.provider, item.id));
		if (lastUsed === undefined) continue;
		row.setText(`${text}${theme.fg("muted", ` · ${timeAgo(now - lastUsed)}`)}`);
	}
}

function timeAgo(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 30) return `${d}d ago`;
	return `${Math.round(d / 30)}mo ago`;
}

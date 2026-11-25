import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { EditorChip, EditorChipProvider } from "../shared/editor-chips.ts";
import { maskNonProse } from "../shared/prose.ts";

export const MENTION_NOTICE_TYPE = "model-mention-notice";
export const MENTION_TRIGGER = "^";
const MAX_SUGGESTIONS = 20;

const MENTION_RE = /(^|\s)\^([^\s^]+)(?=\s|$)/g;
const LIVE_TOKEN_RE = /(?:^|\s)\^([^\s^]*)$/;

type AnyModel = Model<any>;

export interface MentionSource {
	models(): AnyModel[];
	current(): AnyModel | undefined;
}

export interface ResolvedMention {
	token: string;
	model: AnyModel;
	thinking?: string;
}

const selectorOf = (m: AnyModel) => `${m.provider}/${m.id}`;

export function mentionToken(model: AnyModel, models: readonly AnyModel[]): string {
	const sameId = models.filter((m) => m.id === model.id);
	return sameId.length > 1 ? selectorOf(model) : model.id;
}

export function resolveToken(token: string, models: readonly AnyModel[], current?: AnyModel): AnyModel | undefined {
	const exact = models.find((m) => selectorOf(m) === token);
	if (exact) return exact;
	const byId = models.filter((m) => m.id === token);
	return byId.find((m) => m.provider === current?.provider) ?? byId[0];
}

const TAG_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

function parseLevel(value: string): string | undefined {
	if ((TAG_LEVELS as readonly string[]).includes(value)) return value;
	if (value.length < 2) return undefined;
	const hits = TAG_LEVELS.filter((l) => l.startsWith(value));
	return hits.length === 1 ? hits[0] : undefined;
}

function tagLevels(model: AnyModel): string[] {
	try {
		return getSupportedThinkingLevels(model).filter((l) => l !== "off");
	} catch {
		return [];
	}
}

function resolveMention(
	token: string,
	models: readonly AnyModel[],
	current?: AnyModel,
): { model: AnyModel; thinking?: string } | undefined {
	// Some model ids contain colons.
	const exact = resolveToken(token, models, current);
	if (exact) return { model: exact };
	const colon = token.lastIndexOf(":");
	if (colon <= 0) return undefined;
	const base = token.slice(0, colon);
	const model = resolveToken(base, models, current);
	if (!model) return undefined;
	const level = parseLevel(token.slice(colon + 1));
	if (!level || !tagLevels(model).includes(level)) return undefined;
	if (resolveToken(`${base}:${level}`, models, current)) return undefined;
	return { model, thinking: level };
}

/**
 * Offsets use UTF-16 code units.
 */
export interface MentionRange extends ResolvedMention {
	from: number;
	to: number;
}

export function findMentionRanges(text: string, source: MentionSource): MentionRange[] {
	if (!text.includes(MENTION_TRIGGER) || isBashInput(text)) return [];
	const models = source.models();
	if (models.length === 0) return [];
	const current = source.current();
	const out: MentionRange[] = [];
	for (const match of maskNonProse(text).matchAll(MENTION_RE)) {
		const token = match[2]!;
		const r = resolveMention(token, models, current);
		if (!r) continue;
		const from = match.index + match[1]!.length;
		const to = match.index + match[0].length;
		out.push(r.thinking ? { from, to, token, model: r.model, thinking: r.thinking } : { from, to, token, model: r.model });
	}
	return out;
}

export function findMentions(text: string, source: MentionSource): ResolvedMention[] {
	const seen = new Set<string>();
	const out: ResolvedMention[] = [];
	for (const { token, model, thinking } of findMentionRanges(text, source)) {
		const key = `${selectorOf(model)}${thinking ? `:${thinking}` : ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(thinking ? { token, model, thinking } : { token, model });
	}
	return out;
}

const NO_CHIPS: readonly EditorChip[] = Object.freeze([]);

export function mentionChips(text: string, source: MentionSource): EditorChip[] {
	const out: EditorChip[] = [];
	for (const { from, to } of findMentionRanges(text, source)) {
		// A tag at the end of the draft may still be changing.
		if (to < text.length) out.push({ from, to });
	}
	return out;
}

export function createMentionChipProvider(getSource: () => MentionSource | undefined): EditorChipProvider {
	let lastText: string | undefined;
	let lastModels: readonly AnyModel[] = [];
	let lastProvider: string | undefined;
	let lastChips: readonly EditorChip[] = NO_CHIPS;
	return {
		chips(text: string): readonly EditorChip[] {
			if (!text.includes(MENTION_TRIGGER)) return NO_CHIPS;
			try {
				const source = getSource();
				if (!source) return NO_CHIPS;
				const models = source.models();
				const current = source.current();
				const provider = current?.provider;
				const same =
					text === lastText &&
					provider === lastProvider &&
					models.length === lastModels.length &&
					models.every((m, i) => m === lastModels[i]);
				if (same) return lastChips;
				const chips = mentionChips(text, { models: () => models, current: () => current });
				lastText = text;
				lastModels = models;
				lastProvider = provider;
				lastChips = chips.length > 0 ? chips : NO_CHIPS;
				return lastChips;
			} catch {
				// A model lookup failure must not break editor rendering.
				lastText = undefined;
				return NO_CHIPS;
			}
		},
	};
}

export function mentionNotice(mentions: readonly ResolvedMention[], defaultAgent: string): string {
	const lines = mentions.map(({ token, model, thinking }) => {
		const name = thinking ? `${displayName(model)} · ${thinking}` : displayName(model);
		const fields = thinking
			? `\`model: "${selectorOf(model)}"\` and \`thinking: "${thinking}"\``
			: `\`model: "${selectorOf(model)}"\``;
		return `- \`^${token}\` → ${name}: a \`task\` item with ${fields} (omit \`agent\`; default \`${defaultAgent}\`)`;
	});
	const level = mentions.some((m) => m.thinking)
		? " Where a tag lists `thinking`, the user chose that level: set it exactly as listed."
		: "";
	return `<system-notice id="model-mentions">
The user tagged models with \`^\` in this message. Each tag stands for a subagent of the default agent type running on that model:
${lines.join("\n")}
Give the work the user assigns to a tag to that subagent: one \`tasks[]\` item per tag, with \`model\` exactly as listed.${level} Do not run it on another model or agent type, and do not do that work yourself.
</system-notice>`;
}

function displayName(model: AnyModel): string {
	return (model.name?.trim() || model.id).replaceAll('"', "");
}

function isBashInput(text: string): boolean {
	return text.trimStart().startsWith("!");
}

interface RecentEntry {
	provider: string;
	id: string;
	lastUsed: number;
}

const MAX_MENTION_HISTORY = 20;
const recentCache = new Map<string, { mtimeMs: number; entries: RecentEntry[] }>();

const historyFile = () => join(getAgentDir(), "model-history.json");
const mentionHistoryFile = () => join(getAgentDir(), "model-mention-history.json");

function readHistoryFile(file: string): RecentEntry[] {
	try {
		const { mtimeMs } = statSync(file);
		const cached = recentCache.get(file);
		if (cached?.mtimeMs === mtimeMs) return cached.entries;
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: unknown };
		const entries = Array.isArray(parsed.models)
			? parsed.models.filter(
					(m): m is RecentEntry =>
						!!m && typeof m.provider === "string" && typeof m.id === "string" && typeof m.lastUsed === "number",
				)
			: [];
		recentCache.set(file, { mtimeMs, entries });
		return entries;
	} catch {
		return [];
	}
}

function readRecent(): RecentEntry[] {
	const newest = new Map<string, RecentEntry>();
	for (const e of [...readHistoryFile(mentionHistoryFile()), ...readHistoryFile(historyFile())]) {
		const key = `${e.provider}/${e.id}`;
		const prev = newest.get(key);
		if (!prev || e.lastUsed > prev.lastUsed) newest.set(key, e);
	}
	return [...newest.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

export function recordMentions(mentions: readonly ResolvedMention[], at = Date.now()): void {
	if (mentions.length === 0) return;
	mergeMentionHistory(mentions.map((m, i) => ({ provider: m.model.provider, id: m.model.id, lastUsed: at - i })));
}

function mergeMentionHistory(fresh: readonly RecentEntry[]): void {
	const file = mentionHistoryFile();
	try {
		const byKey = new Map<string, RecentEntry>();
		for (const e of [...fresh, ...readHistoryFile(file)]) {
			const key = `${e.provider}/${e.id}`;
			const prev = byKey.get(key);
			if (!prev || e.lastUsed > prev.lastUsed) byKey.set(key, e);
		}
		const models = [...byKey.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_MENTION_HISTORY);
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ version: 1, models }, null, "\t")}\n`);
		renameSync(tmp, file);
		recentCache.delete(file);
	} catch {
		// History failures must not block prompt submission.
	}
}

export async function seedMentionHistory(maxFiles = 100): Promise<void> {
	const file = mentionHistoryFile();
	try {
		statSync(file);
		return;
	} catch {}
	const { readdir, readFile, stat } = await import("node:fs/promises");
	const sessionsDir = join(getAgentDir(), "sessions");
	const files: { path: string; mtime: number }[] = [];
	try {
		for (const dir of await readdir(sessionsDir)) {
			let names: string[] = [];
			try {
				names = await readdir(join(sessionsDir, dir));
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.endsWith(".jsonl")) continue;
				const p = join(sessionsDir, dir, name);
				try {
					files.push({ path: p, mtime: (await stat(p)).mtimeMs });
				} catch {}
			}
		}
	} catch {
		return;
	}
	files.sort((a, b) => b.mtime - a.mtime);
	const found: RecentEntry[] = [];
	for (const { path } of files.slice(0, maxFiles)) {
		let text = "";
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.includes(`"customType":"${MENTION_NOTICE_TYPE}"`)) continue;
			try {
				const e = JSON.parse(line) as { customType?: string; timestamp?: unknown; details?: { models?: unknown } };
				const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
				if (e.customType !== MENTION_NOTICE_TYPE || !Number.isFinite(at) || !Array.isArray(e.details?.models)) continue;
				e.details.models.forEach((sel, i) => {
					const slash = typeof sel === "string" ? sel.indexOf("/") : -1;
					if (slash > 0) found.push({ provider: sel.slice(0, slash), id: sel.slice(slash + 1), lastUsed: at - i });
				});
			} catch {}
		}
	}
	mergeMentionHistory(found);
}

function timeAgo(ms: number): string {
	const m = Math.round(Math.max(0, ms) / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

export function mentionSuggestions(query: string, source: MentionSource, now = Date.now()): AutocompleteItem[] {
	const models = source.models();
	if (models.length === 0) return [];
	const recent = readRecent();
	const rank = new Map(recent.map((r, i) => [`${r.provider}/${r.id}`, i]));
	const lastUsed = new Map(recent.map((r) => [`${r.provider}/${r.id}`, r.lastUsed]));
	const ordered = [...models].sort((a, b) => {
		const ra = rank.get(selectorOf(a)) ?? Number.MAX_SAFE_INTEGER;
		const rb = rank.get(selectorOf(b)) ?? Number.MAX_SAFE_INTEGER;
		return ra - rb || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
	});
	const matched = query
		? fuzzyFilter(ordered, query, (m) => `${m.id} ${m.provider} ${m.name ?? ""}`)
		: ordered;
	return matched.slice(0, MAX_SUGGESTIONS).map((m) => {
		const token = mentionToken(m, models);
		const used = lastUsed.get(selectorOf(m));
		const name = displayName(m);
		const description = [name !== m.id ? name : "", `[${m.provider}]`, used !== undefined ? timeAgo(now - used) : ""]
			.filter(Boolean)
			.join(" · ");
		return { value: token, label: `^${token}`, description };
	});
}

export function createMentionAutocomplete(
	current: AutocompleteProvider,
	getSource: () => MentionSource | undefined,
): AutocompleteProvider {
	const liveQuery = (lines: string[], cursorLine: number, cursorCol: number): string | undefined => {
		if (isBashInput(lines.join("\n"))) return undefined;
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		return before.match(LIVE_TOKEN_RE)?.[1];
	};

	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), MENTION_TRIGGER])],

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const query = liveQuery(lines, cursorLine, cursorCol);
			const source = query === undefined ? undefined : getSource();
			if (query !== undefined && source) {
				let items: AutocompleteItem[] = [];
				try {
					items = mentionSuggestions(query, source);
				} catch {}
				if (items.length > 0) return { items, prefix: `^${query}` };
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol);
			const live = before.match(LIVE_TOKEN_RE);
			if (!prefix.startsWith(MENTION_TRIGGER) || !live) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const start = cursorCol - live[1]!.length - 1;
			const after = line.slice(cursorCol);
			const inserted = `^${item.value}${/^\s/.test(after) ? "" : " "}`;
			const next = [...lines];
			next[cursorLine] = line.slice(0, start) + inserted + after;
			const col = start + inserted.length + (/^\s/.test(after) ? 1 : 0);
			return { lines: next, cursorLine, cursorCol: col };
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

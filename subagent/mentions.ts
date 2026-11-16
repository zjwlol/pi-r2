/**
 * `^model` mentions (ported from oh-my-pi): type `^` in the prompt to pick a
 * model. A tagged model stands for a subagent of the default agent type running
 * on that model; the main agent still writes its task.
 *
 *   - Editor: `^` at the start of a word opens a model popup (models you
 *     recently picked with `^` or used via /model first); picking one inserts
 *     `^<model-id> ` (or `^provider/id` when the id alone is ambiguous).
 *   - Submit: tags standing as prose (not in code) are resolved and a hidden
 *     notice tells the main agent to spawn that work as a default-agent `task`
 *     item with `model` set. The message text stays as typed.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { maskNonProse } from "../shared/prose.ts";

export const MENTION_NOTICE_TYPE = "model-mention-notice";
export const MENTION_TRIGGER = "^";
const MAX_SUGGESTIONS = 20;

/** Completed `^token` in submitted text; groups: leading delimiter, token. */
const MENTION_RE = /(^|\s)\^([^\s^]+)(?=\s|$)/g;
/** `^query` being typed right before the cursor. */
const LIVE_TOKEN_RE = /(?:^|\s)\^([^\s^]*)$/;

type AnyModel = Model<any>;

/** Where mentionable models come from (re-read on every use so it never goes stale). */
export interface MentionSource {
	/** Models a mention may name: the session's scoped models if any, else all available. */
	models(): AnyModel[];
	/** The main session's current model (used to break id ties). */
	current(): AnyModel | undefined;
}

export interface ResolvedMention {
	/** Token as typed after `^`. */
	token: string;
	model: AnyModel;
}

const selectorOf = (m: AnyModel) => `${m.provider}/${m.id}`;

/** Shortest unambiguous token for a model: its id, or `provider/id` when another provider has the same id. */
export function mentionToken(model: AnyModel, models: readonly AnyModel[]): string {
	const sameId = models.filter((m) => m.id === model.id);
	return sameId.length > 1 ? selectorOf(model) : model.id;
}

/** Resolve a typed token (`id` or `provider/id`) against the mentionable models. */
export function resolveToken(token: string, models: readonly AnyModel[], current?: AnyModel): AnyModel | undefined {
	const exact = models.find((m) => selectorOf(m) === token);
	if (exact) return exact;
	const byId = models.filter((m) => m.id === token);
	return byId.find((m) => m.provider === current?.provider) ?? byId[0];
}

/** Tags standing as prose in `text` (never inside code or markup), one per model, in order. */
export function findMentions(text: string, source: MentionSource): ResolvedMention[] {
	if (!text.includes(MENTION_TRIGGER) || isBashInput(text)) return [];
	const models = source.models();
	if (models.length === 0) return [];
	const current = source.current();
	const seen = new Set<string>();
	const out: ResolvedMention[] = [];
	for (const match of maskNonProse(text).matchAll(MENTION_RE)) {
		const token = match[2]!;
		const model = resolveToken(token, models, current);
		if (!model || seen.has(selectorOf(model))) continue;
		seen.add(selectorOf(model));
		out.push({ token, model });
	}
	return out;
}

/** Hidden notice telling the main agent what each tag means for this message. */
export function mentionNotice(mentions: readonly ResolvedMention[], defaultAgent: string): string {
	const lines = mentions.map(
		({ token, model }) =>
			`- \`^${token}\` → ${displayName(model)}: a \`task\` item with \`model: "${selectorOf(model)}"\` (omit \`agent\`; default \`${defaultAgent}\`)`,
	);
	return `<system-notice id="model-mentions">
The user tagged models with \`^\` in this message. Each tag stands for a subagent of the default agent type running on that model:
${lines.join("\n")}
Give the work the user assigns to a tag to that subagent: one \`tasks[]\` item per tag, with \`model\` exactly as listed. Do not run it on another model or agent type, and do not do that work yourself.
</system-notice>`;
}

function displayName(model: AnyModel): string {
	return (model.name?.trim() || model.id).replaceAll('"', "");
}

/** pi's bash mode (`!cmd` / `!!cmd`): mentions don't apply. */
function isBashInput(text: string): boolean {
	return text.trimStart().startsWith("!");
}

// ---------- recent models ----------
// Two sources, merged newest first:
//  - model-history.json: models used in the main session (written by remember-model)
//  - model-mention-history.json: models picked with `^` (written here on submit)

interface RecentEntry {
	provider: string;
	id: string;
	lastUsed: number;
}

const MAX_MENTION_HISTORY = 20;
const recentCache = new Map<string, { mtimeMs: number; entries: RecentEntry[] }>();

const historyFile = () => join(getAgentDir(), "model-history.json");
const mentionHistoryFile = () => join(getAgentDir(), "model-mention-history.json");

/** Entries of one history file, newest first; empty when missing or unreadable. Never throws. */
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

/** Recently used + recently `^`-picked models, newest first, one entry per model. */
function readRecent(): RecentEntry[] {
	const newest = new Map<string, RecentEntry>();
	for (const e of [...readHistoryFile(mentionHistoryFile()), ...readHistoryFile(historyFile())]) {
		const key = `${e.provider}/${e.id}`;
		const prev = newest.get(key);
		if (!prev || e.lastUsed > prev.lastUsed) newest.set(key, e);
	}
	return [...newest.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Remember models the user tagged with `^` (called when a prompt with mentions is sent). Never throws. */
export function recordMentions(mentions: readonly ResolvedMention[], at = Date.now()): void {
	if (mentions.length === 0) return;
	// Later mentions in the same message rank just below earlier ones.
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
		// History is best-effort.
	}
}

/**
 * First run: seed the `^` history from mention notices already in recent session files
 * (so picks made before the history existed still show up). No-op once the file exists.
 */
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

// ---------- autocomplete ----------

/** Candidate models for the popup: recently used first, then the rest by provider/id. */
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

/**
 * Wrap pi's autocomplete provider: handle `^query` tokens, delegate everything
 * else (slash commands, @files, other extensions) to `current`.
 */
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

/**
 * Subagent spend -> main session totals.
 *
 * pi's footer ($, tokens), `/session` stats and the per-model cost breakdown all sum the same four
 * sources over every entry of the main session (footer.ts getSessionStats, agent-session.ts
 * getSessionStats, usage-totals.ts getUsageCostBreakdown): assistant message usage, tool-result
 * `usage`, compaction/branch-summary `usage`, and `usage` entries (`SessionManager.appendUsage`;
 * session-format.md "UsageEntry": "Usage entries contribute to session token and cost totals. Pi hides
 * them from the conversation tree"). Custom messages and custom entries do not count.
 *
 * Children are separate in-memory sessions pi never sees, and the `task` tool returns before they run,
 * so nothing a child spends reaches those totals on its own. The hub therefore mirrors every child's
 * spend into the main session as `usage` entries of kind "subagent" (attributed to the child's
 * provider/model, `note` = child id): once per batch of new child session entries (`sessionUsage`
 * applies pi's own formula to the child's entries, so a child's total is exactly what pi would show
 * for it), for any depth, run (initial, wake, reminder retry) or ending (settled, killed, shutdown).
 * The entries are persisted with the session, so totals survive resume.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export type { Usage };

/** `ctx.sessionManager`: pi types it read-only (a `Pick` of SessionManager); at runtime it is the real one. */
type SessionManagerLike = ExtensionContext["sessionManager"];

/** `kind` of the usage entries the hub appends to the main session. */
export const SUBAGENT_USAGE_KIND = "subagent";

export function zeroUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** `into += u` (tolerates partial usage objects from older/foreign providers). */
export function addUsage(into: Usage, u: Partial<Usage> | undefined): Usage {
	if (!u) return into;
	into.input += u.input || 0;
	into.output += u.output || 0;
	into.cacheRead += u.cacheRead || 0;
	into.cacheWrite += u.cacheWrite || 0;
	if (u.cacheWrite1h !== undefined) into.cacheWrite1h = (into.cacheWrite1h ?? 0) + u.cacheWrite1h;
	if (u.reasoning !== undefined) into.reasoning = (into.reasoning ?? 0) + u.reasoning;
	into.totalTokens += u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
	const c = u.cost;
	if (c) {
		into.cost.input += c.input || 0;
		into.cost.output += c.output || 0;
		into.cost.cacheRead += c.cacheRead || 0;
		into.cost.cacheWrite += c.cacheWrite || 0;
		into.cost.total += c.total || 0;
	}
	return into;
}

export function isZeroUsage(u: Usage): boolean {
	return u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheWrite === 0 && u.cost.total === 0;
}

export interface AttributedUsage {
	/** `provider/model` the spend is attributed to. */
	provider: string;
	model: string;
	usage: Usage;
}

/**
 * Spend recorded by one session entry, following pi's footer formula. `fallback` attributes entries
 * without model information (tool results, compaction summaries) to the session's model.
 */
export function entryUsage(entry: SessionEntry, fallback: { provider: string; model: string }): AttributedUsage | undefined {
	if (entry.type === "usage") return { provider: entry.provider, model: entry.model, usage: entry.usage };
	if (entry.type === "message") {
		const m = entry.message as { role: string; usage?: Usage; provider?: string; model?: string; responseModel?: string };
		if (m.role === "assistant" && m.usage) {
			return { provider: m.provider ?? fallback.provider, model: m.responseModel ?? m.model ?? fallback.model, usage: m.usage };
		}
		if (m.role === "toolResult" && m.usage) return { ...fallback, usage: m.usage };
		return undefined;
	}
	if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) return { ...fallback, usage: entry.usage };
	return undefined;
}

/** Sum of `entries[from..]` grouped by provider/model (insertion order); empty when nothing was spent. */
export function sessionUsage(entries: readonly SessionEntry[], from: number, fallback: { provider: string; model: string }): AttributedUsage[] {
	const byModel = new Map<string, AttributedUsage>();
	for (let i = Math.max(0, from); i < entries.length; i++) {
		const u = entryUsage(entries[i]!, fallback);
		if (!u) continue;
		const key = `${u.provider}/${u.model}`;
		let acc = byModel.get(key);
		if (!acc) {
			acc = { provider: u.provider, model: u.model, usage: zeroUsage() };
			byModel.set(key, acc);
		}
		addUsage(acc.usage, u.usage);
	}
	return [...byModel.values()].filter((a) => !isZeroUsage(a.usage));
}

/** The writable part of pi's SessionManager the extension API types as read-only (present since pi 0.86). */
type UsageWriter = { appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): unknown };

export function canRecordUsage(sm: SessionManagerLike | undefined): sm is SessionManagerLike & UsageWriter {
	return !!sm && typeof (sm as Partial<UsageWriter>).appendUsage === "function";
}

/**
 * Append `usage` to the main session as a "subagent" usage entry (pi sums it into the footer and
 * `/session`, hides it from the tree, persists it). False when this pi has no `appendUsage`.
 */
export function recordUsage(sm: SessionManagerLike | undefined, a: AttributedUsage, note: string): boolean {
	if (!canRecordUsage(sm)) return false;
	sm.appendUsage(SUBAGENT_USAGE_KIND, a.provider, a.model, a.usage, note);
	return true;
}

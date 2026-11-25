import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export type { Usage };

type SessionManagerLike = ExtensionContext["sessionManager"];

export const SUBAGENT_USAGE_KIND = "subagent";

export function zeroUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

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
	provider: string;
	model: string;
	usage: Usage;
}

/**
 * Include only entries that pi counts in session totals.
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

/**
 * pi exposes `appendUsage` at runtime but omits it from the extension type.
 */
type UsageWriter = { appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): unknown };

export function canRecordUsage(sm: SessionManagerLike | undefined): sm is SessionManagerLike & UsageWriter {
	return !!sm && typeof (sm as Partial<UsageWriter>).appendUsage === "function";
}

export function recordUsage(sm: SessionManagerLike | undefined, a: AttributedUsage, note: string): boolean {
	if (!canRecordUsage(sm)) return false;
	sm.appendUsage(SUBAGENT_USAGE_KIND, a.provider, a.model, a.usage, note);
	return true;
}

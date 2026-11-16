/**
 * /btw branch promotion: question and answer become a new session branch.
 *
 * Ports `branchFromBtw` of oh-my-pi's `coding-agent/src/session/agent-session.ts` (l. 14673) and the
 * reply rewrite of `btw-controller.ts` (`assistantMessageWithReplyText`). Vanilla replaces a session
 * only from a command context, so the new file is written with a second `SessionManager` on the
 * session file (branch at the leaf the question was asked from, then the user question and the
 * assistant answer) and loaded with `switchSession`, like `/resume`.
 */

import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NO_BRANCH_POINT = "the session has no branch point";
const SESSION_CHANGED = "the session changed since /btw started";

/**
 * Entries that move the leaf while nothing conversational changed: pi's idle cache warming and this
 * extension's own spend (`usage`), extension state (`custom`), labels and session names.
 */
const PASSIVE_ENTRY_TYPES: ReadonlySet<string> = new Set(["usage", "custom", "label", "session_info"]);

/** undefined when the answer may branch from `leafId`; else "the session has no branch point" | "the session changed since /btw started". */
export function branchBlocker(sm: ExtensionContext["sessionManager"], leafId: string | null): string | undefined {
	if (!leafId) return NO_BRANCH_POINT;
	if (sm.getLeafId() === leafId) return undefined;
	// Root → current leaf. The question's leaf must still be on it (no /tree move, no compaction
	// behind it) with nothing but passive entries after it.
	const path = sm.getBranch();
	const at = path.findIndex((entry) => entry.id === leafId);
	if (at < 0) return SESSION_CHANGED;
	for (let i = at + 1; i < path.length; i++) {
		if (!PASSIVE_ENTRY_TYPES.has(path[i]!.type)) return SESSION_CHANGED;
	}
	return undefined;
}

/**
 * The side answer as a main-session assistant message: real usage, provider, model, api and
 * timestamp; one text block with the cleaned answer (thinking and tool calls dropped, their
 * signatures do not replay); `toolUse` becomes `stop`; no error text.
 */
export function promotedAssistant(message: AssistantMessage, replyText: string): AssistantMessage {
	const { errorMessage: _errorMessage, ...rest } = message;
	return {
		...rest,
		content: [{ type: "text", text: replyText }],
		stopReason: message.stopReason === "toolUse" ? "stop" : message.stopReason,
	};
}

/** Throws Error("session is not persisted") without a session file on disk; other errors propagate. */
export async function promoteToBranch(
	ctx: ExtensionCommandContext,
	args: {
		question: string;
		images?: readonly ImageContent[];
		assistantMessage: AssistantMessage;
		replyText: string;
		leafId: string;
	},
): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
	const sm = ctx.sessionManager;
	const sessionFile = sm.getSessionFile();
	// --no-session, or a session that has no user message yet (pi writes the file with the first one).
	if (!sessionFile || !existsSync(sessionFile)) throw new Error("session is not persisted");

	// A second manager on the same file: the live one must not change under the running agent.
	const branch = SessionManager.open(sessionFile, sm.getSessionDir());
	const branchFile = branch.createBranchedSession(args.leafId);
	if (!branchFile) throw new Error("session is not persisted");
	branch.appendMessage({
		role: "user",
		content: [{ type: "text", text: args.question }, ...(args.images ?? [])],
		timestamp: Date.now(),
	});
	branch.appendMessage(promotedAssistant(args.assistantMessage, args.replyText));

	const name = basename(branchFile);
	// After a successful switch the old runtime is gone: only the replacement context may be used.
	const result = await ctx.switchSession(branchFile, {
		withSession: async (next) => {
			next.ui.notify(`Branched /btw to ${name}`, "info");
		},
	});
	if (result.cancelled) {
		// A `session_before_switch` hook refused: the branch was never entered, so do not leave it behind.
		try {
			rmSync(branchFile, { force: true });
		} catch {}
		return { cancelled: true, sessionFile: undefined };
	}
	return { cancelled: false, sessionFile: branchFile };
}

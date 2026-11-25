import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NO_BRANCH_POINT = "the session has no branch point";
const SESSION_CHANGED = "the session changed since /btw started";

/**
 * Pi can advance the session leaf without adding a conversational turn.
 */
const PASSIVE_ENTRY_TYPES: ReadonlySet<string> = new Set(["usage", "custom", "label", "session_info"]);

export function branchBlocker(sm: ExtensionContext["sessionManager"], leafId: string | null): string | undefined {
	if (!leafId) return NO_BRANCH_POINT;
	if (sm.getLeafId() === leafId) return undefined;
	// Pi returns branch entries from root to leaf.
	const path = sm.getBranch();
	const at = path.findIndex((entry) => entry.id === leafId);
	if (at < 0) return SESSION_CHANGED;
	for (let i = at + 1; i < path.length; i++) {
		if (!PASSIVE_ENTRY_TYPES.has(path[i]!.type)) return SESSION_CHANGED;
	}
	return undefined;
}

export function promotedAssistant(message: AssistantMessage, replyText: string): AssistantMessage {
	const { errorMessage: _errorMessage, ...rest } = message;
	return {
		...rest,
		content: [{ type: "text", text: replyText }],
		stopReason: message.stopReason === "toolUse" ? "stop" : message.stopReason,
	};
}

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
	// Pi does not write a session file until its first user message.
	if (!sessionFile || !existsSync(sessionFile)) throw new Error("session is not persisted");

	// Branch through a separate manager to leave the live session unchanged.
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
	// Use the replacement context after switching sessions.
	const result = await ctx.switchSession(branchFile, {
		withSession: async (next) => {
			next.ui.notify(`Branched /btw to ${name}`, "info");
		},
	});
	if (result.cancelled) {
		try {
			rmSync(branchFile, { force: true });
		} catch {}
		return { cancelled: true, sessionFile: undefined };
	}
	return { cancelled: false, sessionFile: branchFile };
}

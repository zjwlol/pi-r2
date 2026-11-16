/**
 * Per-task features layered on the hub through its ChildHooks seams (hub.ts):
 *
 *  outputSchema (structured.ts)
 *    spawn    schema = item.outputSchema ?? agent `output:`; invalid -> per-item error
 *    session  one YieldState + `yield` tool per child; § Completion = structuredCompletionPrompt
 *    settle   initial run: yielded data -> `data` (output = pretty JSON); {error} -> failed; no yield ->
 *             up to MAX_YIELD_REMINDERS reminder turns, then failed (with the last rejection). No
 *             reminders when the run itself errored/aborted. Follow-up (wake) runs: the reply relayed
 *             is the yielded data if the child yielded that turn, else its final text; no reminders.
 *             The state is reset after every settled run (so each turn needs its own `yield`) and when
 *             an owner resumes with subagent results (a `yield` is only accepted once they all settled).
 *
 *  isolated (isolation.ts)
 *    spawn    cwd must be inside a git work tree -> else per-item error
 *    prepare  createWorktree(child.cwd) -> child.cwd = wt.cwd (nested agents inherit it: subagents of an
 *             isolated agent work in, or branch from and merge into, its worktree)
 *    settle   every settled run: completed -> mergeDelta into the parent's working tree; failed ->
 *             changes NOT applied, patch saved. The worktree is kept while the agent lives (it can be
 *             woken; unmerged changes are offered again by its next successful run). A follow-up run's
 *             merge reaches the owner as a hub notice even when no reply is relayed to it.
 *    dispose  kill / session end: unmerged changes -> patch saved (reported), worktree removed. If the
 *             changes cannot be collected or saved, the worktree is KEPT (`retainWorktree`: also skipped
 *             by the shutdown sweep) and the note says where. A merge that completed after a kill
 *             (never delivered) is reported too.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type AgentHub,
	activeDescendants,
	PARENT_ID,
	type Child,
	type ChildHooks,
	type ChildStatus,
	type DisposeInfo,
	type SettleOverride,
	type SpawnSpec,
} from "./hub.ts";
import {
	collectDelta,
	createWorktree,
	type Delta,
	isGitRepo,
	type MergeResult,
	mergeDelta,
	recoveryHint,
	removeWorktree,
	retainWorktree,
	savePatch,
	type Worktree,
} from "./isolation.ts";
import type { MergeInfo } from "./prompts.ts";
import {
	createYieldState,
	createYieldTool,
	formatStructuredData,
	MAX_YIELD_REMINDERS,
	normalizeSchema,
	resetYieldState,
	YIELD_TOOL_NAME,
	type YieldState,
	yieldReminder,
} from "./structured.ts";

interface FeatureState {
	yield?: YieldState;
	/** Reminders sent during the current (initial) purpose. */
	reminders: number;
	/** In-flight worktree work (creation, merge); dispose waits for it. */
	busy: Promise<unknown>;
	/** Last patch saved for this worktree (not saved twice for the same changes). */
	lastPatch?: { patch: string; file: string };
	/** Merge outcome of a settle that finished after the agent was killed (never delivered otherwise). */
	orphanMerge?: MergeInfo;
	/** Identity of the last reported non-applied merge (status + files + patch hash): repeats are not re-sent. */
	lastReported?: { key: string; patchFile?: string };
}

const states = new WeakMap<Child, FeatureState>();

function stateOf(child: Child): FeatureState {
	let st = states.get(child);
	if (!st) {
		st = { reminders: 0, busy: Promise.resolve() };
		states.set(child, st);
	}
	return st;
}

/** isolation's collect error without its "merge again" advice (used when the agent is gone). */
function collectFailure(e: unknown): string {
	return flat(errText(e).replace(/\s*Fix the problem in the worktree[^]*$/, ""), 300);
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function flat(text: string, max = 400): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function fileList(files: string[], max = 8): string {
	if (files.length === 0) return "";
	const more = files.length > max ? ` (+${files.length - max} more)` : "";
	return `${files.slice(0, max).join(", ")}${more}`;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function bool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (v === "true") return true;
	if (v === "false") return false;
	return undefined;
}

/** Item option wins (`outputSchema: false`/null disables an agent default); else the agent's `output:`. */
export function resolveSchema(spec: Pick<SpawnSpec, "agent" | "item">): { schema?: Record<string, unknown>; error?: string } {
	const item = spec.item ?? {};
	if (Object.hasOwn(item, "outputSchema") && item.outputSchema !== undefined) {
		const r = normalizeSchema(item.outputSchema);
		return r.error ? { error: `outputSchema: ${r.error}` } : { schema: r.schema };
	}
	if (spec.agent.outputError) return { error: `agent "${spec.agent.name}" has an invalid \`output\` schema: ${spec.agent.outputError}` };
	return { schema: spec.agent.outputSchema };
}

export function resolveIsolated(spec: Pick<SpawnSpec, "agent" | "item">): boolean {
	return bool(spec.item?.isolated) ?? !!spec.agent.isolated;
}

/** Save `delta` unless the same changes were saved already (and that file still exists); returns the patch path. */
async function savePatchOnce(wt: Worktree, delta: Delta, st: FeatureState): Promise<string> {
	if (st.lastPatch && st.lastPatch.patch === delta.patch && fs.existsSync(st.lastPatch.file)) return st.lastPatch.file;
	const file = await savePatch(wt, delta);
	st.lastPatch = { patch: delta.patch, file };
	return file;
}

function mergeInfo(r: MergeResult, wt: Worktree, delta: Delta | undefined, st: FeatureState): MergeInfo {
	const files = r.files;
	if (r.patchFile && delta) st.lastPatch = { patch: delta.patch, file: r.patchFile };
	switch (r.status) {
		case "applied":
			return {
				status: "applied",
				files,
				message: `${r.message}${files.length ? ` Files: ${fileList(files)}.` : ""} Working tree only: not staged or committed.`,
			};
		case "empty":
			return { status: "empty", files: [], message: "No file changes." };
		case "conflict": {
			// isolation's message names the patch, the recovery command and the kept worktree.
			const base = r.patchFile && !r.message.includes("git apply --reject") ? `${r.message} ${recoveryHint(r.patchFile, wt.repoRoot)}` : r.message;
			return {
				status: "conflict",
				files,
				patchFile: r.patchFile,
				worktree: wt.path,
				message: `${base} The agent's next successful run retries the merge with all its unmerged changes.`,
			};
		}
		case "error":
			return {
				status: "error",
				files,
				patchFile: r.patchFile,
				worktree: wt.path,
				message: r.patchFile && !r.message.includes("git apply --reject") ? `${r.message} ${recoveryHint(r.patchFile, wt.repoRoot)}` : r.message,
			};
	}
}

/** Run `fn` as tracked worktree work (dispose waits for it). */
function track<T>(st: FeatureState, p: Promise<T>): Promise<T> {
	st.busy = Promise.all([st.busy, p.catch(() => {})]);
	return p;
}

/**
 * Identity of a non-applied outcome for notice dedupe: same status, files and patch content = same news.
 * Applied / empty outcomes have none (always reported / never reported).
 */
function outcomeKey(m: MergeInfo, delta: Delta | undefined): string | undefined {
	if (m.status === "applied" || m.status === "empty") return undefined;
	const hash = delta ? createHash("sha256").update(delta.patch).digest("hex") : m.message;
	return `${m.status}|${[...m.files].sort().join("\0")}|${hash}`;
}

/** Merge or save; with the dedupe key of the outcome. */
async function settleWorktree(wt: Worktree, completed: boolean, st: FeatureState): Promise<{ merge: MergeInfo; key?: string }> {
	let delta: Delta | undefined;
	let merge: MergeInfo;
	try {
		delta = await collectDelta(wt);
		merge = await mergeOrSave(wt, delta, completed, st);
	} catch (e) {
		merge = delta
			? { status: "error", files: delta.files, worktree: wt.path, message: `Failed to process the worktree changes: ${errText(e)}. Nothing was applied.` }
			: { status: "error", files: [], worktree: wt.path, message: `${errText(e)} Nothing was applied.` };
	}
	return { merge, key: outcomeKey(merge, delta) };
}

/** Owner (internal id) of the checkout `wt` merges into: the nearest ancestor whose worktree it is, else the main agent. */
function checkoutOwner(hub: AgentHub, child: Child, wt: Worktree): string {
	const inside = (p: string, root: string) => p === root || p.startsWith(`${root}${path.sep}`);
	for (let cur = child; cur.ownerId !== PARENT_ID; ) {
		const owner = hub.children.get(cur.ownerId);
		if (!owner) break;
		if (owner.worktree && inside(wt.repoRoot, owner.worktree.path)) return owner.id;
		cur = owner;
	}
	return PARENT_ID;
}

/** Merge (completed run) or save as a patch without applying (failed / aborted run). */
async function mergeOrSave(wt: Worktree, delta: Delta, completed: boolean, st: FeatureState): Promise<MergeInfo> {
	if (completed) return mergeInfo(await mergeDelta(wt, delta), wt, delta, st);
	if (!delta.patch.trim()) return { status: "empty", files: [], message: "No file changes." };
	let file: string | undefined;
	try {
		file = await savePatchOnce(wt, delta, st);
	} catch (e) {
		return {
			status: "error",
			files: delta.files,
			worktree: wt.path,
			message: `The run did not complete; its changes to ${plural(delta.files.length, "file")} were NOT applied and could not be saved as a patch (${errText(e)}). They remain in the worktree ${wt.path}.`,
		};
	}
	return {
		status: "unapplied",
		files: delta.files,
		patchFile: file,
		worktree: wt.path,
		message: `The run did not complete, so its changes to ${plural(delta.files.length, "file")} were NOT applied to ${wt.repoRoot}: ${fileList(delta.files)}. Patch saved to ${file}; worktree kept at ${wt.path}. ${recoveryHint(file, wt.repoRoot)} Or let the agent finish: its next successful run merges them.`,
	};
}

/** `yield` that refuses while the agent's own subagents are still running (it must report after they settle). */
function yieldTool(child: Child, state: YieldState): ToolDefinition {
	const tool = createYieldTool(child.schema!, state);
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		execute: (async (...args: Parameters<ToolDefinition["execute"]>) => {
			const active = activeDescendants(child);
			if (active.length > 0) {
				const ids = active.map((c) => c.id).join(", ");
				return {
					content: [
						{
							type: "text" as const,
							text: `yield rejected: your subagent${active.length === 1 ? "" : "s"} ${ids} ${active.length === 1 ? "is" : "are"} still running. End your turn (or irc wait) to receive their results, then call yield; or kill them first.`,
						},
					],
					details: { status: "rejected" },
					isError: true,
				};
			}
			return execute(...args);
		}) as ToolDefinition["execute"],
	};
}

export function createFeatureHooks(hub: AgentHub): ChildHooks {
	const setPhase = (child: Child, phase: string | undefined) => {
		child.phase = phase;
		hub.touch();
	};

	return {
		async validate(spec) {
			const s = resolveSchema(spec);
			if (s.error) return s.error;
			spec.schema = s.schema;
			spec.isolated = resolveIsolated(spec);
			if (spec.isolated && !(await isGitRepo(spec.cwd))) {
				if (!fs.existsSync(spec.cwd)) return `cwd ${spec.cwd} does not exist`;
				return `isolated requires a git repository, but ${spec.cwd} is not inside a git work tree (omit \`isolated\`, or set \`cwd\` to a repository)`;
			}
		},

		async prepare(child) {
			if (!child.isolated) return;
			const st = stateOf(child);
			setPhase(child, "creating worktree…");
			try {
				// Tracked as a whole (incl. cleanup when killed meanwhile) so dispose never races it.
				await track(
					st,
					(async () => {
						const wt = await createWorktree(child.cwd, child.id, child.abort.signal);
						if (child.status === "aborted") {
							await removeWorktree(wt);
							throw new Error("aborted");
						}
						child.worktree = wt;
						child.cwd = wt.cwd;
					})(),
				);
			} finally {
				setPhase(child, undefined);
			}
		},

		tools(child) {
			if (!child.schema) return [];
			const st = stateOf(child);
			st.yield ??= createYieldState();
			return [yieldTool(child, st.yield)];
		},

		resume(child) {
			const y = states.get(child)?.yield;
			if (y?.submitted) resetYieldState(y);
		},

		async beforeSettle(child, run) {
			const st = stateOf(child);
			const o: SettleOverride = {};
			let status = run.status;
			let output = run.output;

			if (child.schema && st.yield) {
				const y = st.yield;
				if (run.initial) {
					if (y.submitted && y.error !== undefined) {
						status = "failed";
						o.error = y.error;
						output = "";
					} else if (y.submitted) {
						status = "completed";
						o.error = "";
						o.data = y.data;
						output = formatStructuredData(y.data);
					} else if (status === "failed") {
						// The run itself errored / was aborted: reminding would not help.
						o.error = `${child.error || "run failed"} (no result was submitted with \`${YIELD_TOOL_NAME}\`)`;
					} else if (st.reminders < MAX_YIELD_REMINDERS) {
						st.reminders++;
						return { retry: yieldReminder(child.schema, st.reminders) };
					} else {
						status = "failed";
						o.error =
							`no valid \`${YIELD_TOOL_NAME}\` after ${MAX_YIELD_REMINDERS} reminders` +
							(y.lastRejection ? `; last rejection: ${flat(y.lastRejection)}` : "");
					}
				} else if (y.submitted) {
					// Follow-up turn: relay what it yielded (else its final text, as for any agent).
					if (y.error !== undefined) output = `Error (via yield): ${y.error}`;
					else {
						o.data = y.data;
						output = formatStructuredData(y.data);
					}
				}
				st.reminders = 0;
				resetYieldState(y);
			}

			const wt = child.worktree;
			// Killed meanwhile: leave the changes to dispose (saved as a patch, not applied).
			if (wt && child.status !== "aborted") {
				setPhase(child, status === "completed" ? "merging worktree changes…" : "saving worktree changes…");
				let merge: MergeInfo;
				let key: string | undefined;
				try {
					({ merge, key } = await track(st, settleWorktree(wt, status === "completed", st)));
				} finally {
					setPhase(child, undefined);
				}
				// Killed while merging: this result is never delivered; dispose reports it instead.
				if ((child.status as ChildStatus) === "aborted") st.orphanMerge = merge;
				o.merge = merge;
				// Same unresolved outcome as last reported (e.g. a conflict whose patch did not change)?
				const prev = st.lastReported;
				const repeat = key !== undefined && key === prev?.key;
				// Keep pointing at the patch that was reported (isolation saves an identical copy per attempt).
				st.lastReported = key === undefined ? undefined : repeat ? prev : { key, patchFile: merge.patchFile };
				const reportedPatch = repeat ? (prev?.patchFile ?? merge.patchFile) : merge.patchFile;
				// Follow-up runs: whoever owns the merged-into checkout must learn about it even if no
				// reply goes to them (hub notice); unchanged conflicts are not re-sent.
				if (!run.initial && merge.status !== "empty") {
					if (repeat) {
						o.replyNote = `<merge-summary>\nStill not merged: same ${merge.status === "conflict" ? "conflict" : "outcome"} as reported before${reportedPatch ? ` (patch ${reportedPatch})` : ""}; nothing new was applied.\n</merge-summary>`;
					} else {
						o.notice = `<merge-summary>\n${merge.message}\n</merge-summary>`;
						o.noticeTo = checkoutOwner(hub, child, wt);
					}
				}
			}

			o.status = status;
			o.output = output;
			return o;
		},

		async dispose(child): Promise<DisposeInfo | void> {
			const st = states.get(child);
			if (!st) return;
			await st.busy; // creation / merge still in flight
			const wt = child.worktree;
			if (!wt) return;
			child.worktree = undefined; // idempotent (start-failure dispose, then kill)
			const messages: string[] = [];
			const notes: string[] = [];
			let merge: MergeInfo | undefined;
			// A merge that finished after the kill was never delivered: the parent's checkout changed.
			const orphan = st.orphanMerge;
			if (orphan && orphan.status !== "empty") {
				merge = orphan;
				messages.push(orphan.message);
				notes.push(`merged while being stopped: ${orphan.message}`);
			}
			let delta: Delta | undefined;
			let failure: string | undefined;
			try {
				delta = await collectDelta(wt);
			} catch (e) {
				failure = `its changes could not be collected: ${collectFailure(e)}`;
			}
			let file: string | undefined;
			if (delta?.patch.trim()) {
				try {
					file = await savePatchOnce(wt, delta, st);
				} catch (e) {
					failure = `its changes could not be saved as a patch: ${flat(errText(e), 300)}`;
				}
			}
			if (failure) {
				// Never delete work we could not save: keep the worktree and stop tracking it, so the
				// shutdown sweep (removeAllWorktrees) leaves it alone too.
				retainWorktree(wt);
				const msg = `Stopped, but ${failure}. Changes NOT saved; worktree kept at ${wt.path}. Recover them from there, then remove it with \`git worktree remove --force ${wt.path}\`.`;
				messages.push(msg);
				notes.push(`changes NOT saved; worktree kept at ${wt.path} — ${failure}`);
				return { merge: { status: "error", files: delta?.files ?? [], worktree: wt.path, message: messages.join(" ") }, note: notes.join("; ") };
			}
			if (file && delta) {
				const n = plural(delta.files.length, "file");
				messages.push(
					`Stopped before its changes were merged: changes to ${n} were NOT applied to ${wt.repoRoot}: ${fileList(delta.files)}. Patch saved to ${file}; the worktree was removed. ${recoveryHint(file, wt.repoRoot)}`,
				);
				notes.push(`unmerged changes to ${n} saved to ${file} (not applied)`);
				merge = { status: "unapplied", files: delta.files, patchFile: file, message: messages.join(" ") };
			}
			await removeWorktree(wt);
			if (!merge) return;
			return { merge: { ...merge, message: messages.join(" ") }, note: notes.join("; ") };
		},
	};
}

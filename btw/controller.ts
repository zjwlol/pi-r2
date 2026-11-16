/**
 * /btw controller: the side-question state machine of one extension runtime.
 *
 * Ports oh-my-pi's `coding-agent/src/modes/controllers/btw-controller.ts` (start, follow-up, cancel,
 * copy, branch, inject, history overlay, dispose). It talks to pi only through `BtwHost`, so a fake
 * host can drive it.
 *
 * What differs from upstream, and why:
 * - History writes are synchronous (store.ts), so there is no write queue, no `flush()` and no
 *   retry of failed checkpoints; every checkpoint is on disk when its call returns.
 * - Only a command context can replace the session: `handleBranch()` asks the host to dispatch the
 *   `/btw` command with the branch token, and `performBranch(ctx)` does the work when it arrives.
 * - pi reports neither admission nor drops of a sent prompt: an inject counts as sent when the
 *   `input` event shows its text reaching the session (`confirmInject`), within a timeout.
 * - Always the main session (vanilla has no focused subagent views, no collab guests).
 */

import type { Api, AssistantMessage, AssistantMessageEvent, Context, ImageContent, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { promoteToBranch } from "./branch.ts";
import { BtwHistoryPanel } from "./history-panel.ts";
import { INJECT_KEY } from "./keys.ts";
import type { BtwKeyTarget } from "./keys.ts";
import { BtwPanel } from "./panel.ts";
import type { BtwDock } from "./panel.ts";
import {
	beginTurn,
	getCopyText,
	getLatestTurn,
	getRecordInject,
	getTurnKey,
	getTurns,
	injectMarks,
	patchLatestTurn,
	replaceTabs,
	sanitizeErrorLine,
} from "./records.ts";
import type { BtwRecord, BtwStatus, BtwTurn } from "./records.ts";
import { buildSideContext, runSideTurn } from "./request.ts";
import type { SideContextInput } from "./request.ts";
import { BtwHistoryStore } from "./store.ts";

/** Everything the controller needs from pi. Methods must not throw on a stale context: they do nothing instead. */
export interface BtwHost {
	dock: BtwDock;
	theme(): Theme;
	requestRender(): void;
	terminalRows(): number;
	notify(message: string, kind?: "info" | "warning" | "error"): void;
	nativeActive(): boolean;
	injectEnabled(): boolean;
	model(): Model<Api> | undefined;
	sessionId(): string;
	leafId(): string | null;
	isIdle(): boolean;
	/** historyDirectory(getAgentDir(), sessionId), or undefined for --no-session. */
	historyDirectory(): string | undefined;
	/** Everything of SideContextInput the session supplies. */
	sessionContext(): Pick<SideContextInput, "messages" | "streaming" | "systemPrompt">;
	/** ctx.modelRegistry.streamSimple with the main loop's cache-relevant options. */
	stream(model: Model<Api>, context: Context, signal: AbortSignal): AsyncIterable<AssistantMessageEvent>;
	recordUsage(message: AssistantMessage, sessionId: string): void;
	resolveImages(text: string, scope: "editor" | "detached"): { text: string; images: ImageContent[] } | undefined;
	copy(text: string): Promise<void>;
	editorText(): string;
	setEditorText(text: string): void;
	/** Mount `make(theme)` as the history overlay (ui.custom, not awaited); returns the panel. `close()` ends the overlay. */
	openHistory(make: (theme: Theme, close: () => void) => BtwHistoryPanel): BtwHistoryPanel;
	/** pi.sendUserMessage(text, { deliverAs: "steer" }) */
	sendUserMessage(text: string): void;
	/** pi.sendUserMessage("/btw " + BRANCH_TOKEN, { expandPromptTemplates: true }) */
	requestBranch(): void;
	branchBlocker(leafId: string | null): string | undefined;
}

/** Timeouts of the two round trips through pi; shortened by probes. */
export interface BtwControllerOptions {
	/** How long the dispatched branch command may take to arrive. */
	branchTimeoutMs?: number;
	/** How long an inject may take to show up in the `input` event. */
	injectTimeoutMs?: number;
}

const BRANCH_TIMEOUT_MS = 5_000;
const INJECT_TIMEOUT_MS = 3_000;
/** §4.1 height guard: rows the panel body may take under a terminal of `rows`. */
const PANEL_CHROME_ROWS = 12;
const PANEL_MIN_BODY_ROWS = 6;

interface BtwRequest {
	panel: BtwPanel;
	abort: AbortController;
	question: string;
	images?: readonly ImageContent[];
	model: Model<Api>;
	/** Session leaf when the question was asked: the branch point. */
	leafId: string | null;
	sessionId: string;
	store: BtwHistoryStore;
	record: BtwRecord;
	/** Earlier turns of the topic, replayed before the question. */
	history?: readonly BtwTurn[];
	/**
	 * `btw.inject` when the question was asked, fixed for the request's life so the prompt
	 * instruction, the highlighted block and the inject key always agree.
	 */
	injectEnabled: boolean;
}

/** The last complete, non-empty answer: what `c` copies and `b` promotes. */
interface CompletedAnswer {
	question: string;
	images?: readonly ImageContent[];
	replyText: string;
	copyText: string;
	assistantMessage: AssistantMessage;
	leafId: string | null;
	sessionId: string;
}

interface PendingInject {
	key: string;
	text: string;
	timer: ReturnType<typeof setTimeout> | undefined;
	settled: boolean;
}

function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

export class BtwController implements BtwKeyTarget {
	readonly #host: BtwHost;
	readonly #branchTimeoutMs: number;
	readonly #injectTimeoutMs: number;

	#active: BtwRequest | undefined;
	#last: CompletedAnswer | undefined;
	/** The inline panel is on screen (text mode). */
	#visible = false;
	#starting = false;
	#copyInFlight = false;
	/** From `b` until the promotion settled (or its command never arrived). */
	#branchInFlight = false;
	/** The branch command was dispatched and has not arrived yet. */
	#branchRequested = false;
	#branchTimer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped by `dispose()`: async continuations of an older generation return without effect. */
	#generation = 0;
	/** Opened lazily on the first /btw; dropped by `dispose()` and after a failed first checkpoint. */
	#store: BtwHistoryStore | undefined;
	#historyPanel: BtwHistoryPanel | undefined;
	#closeOverlay: (() => void) | undefined;
	/**
	 * Sends awaiting their `input` event, by turn key. The marks themselves (`injectMarks()`) are
	 * process-wide: only turns answered in this process with the inject instruction and a closed
	 * block get one, so history from an earlier run, or an answer asked while injecting was off,
	 * never sends.
	 */
	readonly #pendingInjects = new Map<string, PendingInject>();

	constructor(host: BtwHost, options?: BtwControllerOptions) {
		this.#host = host;
		this.#branchTimeoutMs = options?.branchTimeoutMs ?? BRANCH_TIMEOUT_MS;
		this.#injectTimeoutMs = options?.injectTimeoutMs ?? INJECT_TIMEOUT_MS;
	}

	// ───────────────────────────── asking ─────────────────────────────

	/**
	 * `/btw …`: blank opens history. Resolves false when nothing started and no history opened.
	 * `title` heads the topic instead of the question (`/sitrep` rather than its expanded template);
	 * `fromEditor`: the text came from the prompt editor, so its draft images ride along;
	 * `restoreText` goes back into an empty editor when the question was not sent.
	 */
	async start(question: string, options?: { title?: string; fromEditor?: boolean; restoreText?: string }): Promise<boolean> {
		const started = this.#start(question, {
			title: options?.title,
			imageScope: options?.fromEditor ? "editor" : undefined,
		});
		if (!started && options?.restoreText !== undefined) this.#restoreDraft(options.restoreText);
		return started;
	}

	async startFollowUp(recordId: string, question: string, signal?: AbortSignal): Promise<boolean> {
		if (!question.trim()) return false;
		return this.#start(question, { recordId, signal, imageScope: "detached" });
	}

	/** Put an unsent question back, unless a newer draft took its place. */
	#restoreDraft(text: string): void {
		try {
			if (this.#host.editorText().trim() === "") this.#host.setEditorText(text);
		} catch {}
	}

	/** Synchronous on purpose: store and image hooks are, so no other /btw action can interleave. */
	#start(
		question: string,
		options: { recordId?: string; signal?: AbortSignal; title?: string; imageScope?: "editor" | "detached" },
	): boolean {
		const host = this.#host;
		const { recordId, signal, title } = options;
		if (signal?.aborted) return false;
		let trimmed = question.trim();
		if (this.#starting || this.#branchInFlight) {
			this.#notify("A /btw action is in progress. Please wait.");
			return false;
		}
		// One request at a time: no queue, and the running one is never cancelled for a new one.
		if (trimmed && this.#active && getLatestTurn(this.#active.record).status === "running") {
			this.#notify("A /btw question is still running. Open /btw to view it or cancel it first.");
			return false;
		}
		this.#starting = true;
		try {
			const store = (this.#store ??= BtwHistoryStore.open(host.historyDirectory()));
			if (!trimmed) {
				const panel = this.#showHistory(store);
				// Native: reopening lands on the side question put away while it answered.
				const active = this.#active;
				if (host.nativeActive() && active?.store === store && this.#isActive(active)) panel.showRecord(active.record.id);
				return true;
			}
			// The active record may be ahead of the store (a failed terminal checkpoint).
			const previous = recordId ? this.#historyRecords(store).find((record) => record.id === recordId) : undefined;
			if (recordId && (!previous || getLatestTurn(previous).status === "running")) {
				this.#notify("This side conversation is unavailable or still running.");
				return false;
			}
			const model = host.model();
			if (!model) {
				this.#notify("No active model available for /btw.", "error");
				return false;
			}
			// Only now, with every refusal behind us: a refused question keeps its draft images.
			let images: readonly ImageContent[] | undefined;
			if (options.imageScope) {
				const plan = host.resolveImages(trimmed, options.imageScope);
				if (plan) {
					trimmed = plan.text.trim() || trimmed;
					if (plan.images.length > 0) images = plan.images;
				}
			}
			const sessionId = host.sessionId();
			const leafId = host.leafId();
			const { record, history } = beginTurn(trimmed, leafId, previous, images, title);
			if (!previous) this.#closeHistory();
			this.#active?.panel.close();
			this.#last = undefined;
			const injectEnabled = host.injectEnabled();
			const request: BtwRequest = {
				panel: new BtwPanel({
					question: trimmed,
					title,
					theme: () => host.theme(),
					requestRender: () => host.requestRender(),
					canBranch: () => this.canBranch(),
					canFollowUp: () => this.canFollowUp(),
					canInject: injectEnabled ? () => this.canInject() : undefined,
					injectKey: INJECT_KEY,
					maxBodyRows: () => Math.max(PANEL_MIN_BODY_ROWS, host.terminalRows() - PANEL_CHROME_ROWS),
				}),
				abort: new AbortController(),
				question: trimmed,
				images,
				model,
				leafId,
				sessionId,
				store,
				record,
				history,
				injectEnabled,
			};
			this.#active = request;
			// Native shows the answer in the history sheet (its body scrolls, its markdown is
			// native); the text renderer keeps the inline panel.
			const sheet = host.nativeActive();
			this.#visible = !sheet && (!previous || !this.#historyPanel);
			host.dock.show(this.#visible ? request.panel : undefined);
			host.requestRender();
			// First checkpoint, before any model request: a topic that cannot be saved is not asked.
			if (!this.#persist(request)) {
				if (this.#active === request) {
					this.#active = undefined;
					request.panel.close();
					this.#hideInline();
					// The store may be behind the disk (a conflict): reopen it next time.
					this.#store = undefined;
					this.#historyPanel?.update(store.getRecords());
				}
				return false;
			}
			if (!this.#isActive(request) || getLatestTurn(request.record).status !== "running") return false;
			if (signal?.aborted) {
				// The draft was dropped meanwhile: finish the saved turn as cancelled, without a model request.
				this.handleCancel();
				return false;
			}
			this.#refreshHistory();
			if (sheet && !previous) this.#showHistory(store).showRecord(record.id);
			void this.#runRequest(request);
			return true;
		} catch (error) {
			this.#notify(sanitizeErrorLine(`Cannot open /btw history: ${errorMessage(error)}`), "error");
			return false;
		} finally {
			this.#starting = false;
		}
	}

	async #runRequest(request: BtwRequest): Promise<void> {
		const host = this.#host;
		try {
			const context = buildSideContext({
				...host.sessionContext(),
				model: request.model,
				history: request.history,
				question: request.question,
				images: request.images,
				// The same eligibility as the block and the key: no instruction where a block could never be sent.
				inject: request.injectEnabled,
			});
			const { replyText, assistantMessage } = await runSideTurn({
				stream: () => host.stream(request.model, context, request.abort.signal),
				onTextDelta: (delta) => {
					// Text after a cancel (or a dispose) is dropped.
					const latest = getLatestTurn(request.record);
					if (latest.status !== "running") return;
					this.#update(request, { answer: latest.answer + delta, updatedAt: Date.now() });
					if (this.#isActive(request)) {
						if (this.#visible) request.panel.appendText(delta);
						this.#refreshHistory();
					}
				},
				onUsage: (message) => {
					try {
						host.recordUsage(message, request.sessionId);
					} catch {}
				},
				signal: request.abort.signal,
			});
			if (getLatestTurn(request.record).status !== "running") return;
			this.#update(request, { answer: replyText, status: "complete", updatedAt: Date.now() });
			// Only an answer asked with the inject instruction can be sent, even if the setting is turned on later.
			if (request.injectEnabled && getRecordInject(request.record) !== undefined) {
				injectMarks().set(getTurnKey(request.record), "ready");
			}
			if (this.#isActive(request)) {
				request.panel.setAnswer(replyText);
				request.panel.markComplete();
				// Native: the sheet was put away while answering; say where the answer is.
				if (host.nativeActive() && !this.#historyPanel) this.#notify("/btw answer ready · /btw to read it");
				const copyText = request.panel.getCopyText();
				this.#last =
					copyText === undefined
						? undefined
						: {
								question: request.question,
								images: request.images,
								replyText,
								copyText,
								assistantMessage,
								leafId: request.leafId,
								sessionId: request.sessionId,
							};
			}
		} catch (error) {
			// The rejection that follows a cancel changes nothing: the turn is no longer running.
			if (getLatestTurn(request.record).status !== "running") return;
			const cancelled = request.abort.signal.aborted;
			const message = sanitizeErrorLine(error);
			this.#update(request, {
				status: cancelled ? "cancelled" : "error",
				updatedAt: Date.now(),
				...(cancelled ? {} : { error: message }),
			});
			if (this.#isActive(request)) {
				if (cancelled) request.panel.markAborted();
				else request.panel.markError(message);
			}
		}
		this.#persist(request);
		if (this.#isActive(request)) {
			this.#refreshHistory();
			host.requestRender();
		}
	}

	// ───────────────────────────── cancel, escape ─────────────────────────────

	/** Whether the inline panel (or a pending branch, which refuses to be dismissed) owns Escape. */
	hasActivePanel(): boolean {
		return this.#visible || this.#branchInFlight;
	}

	handleEscape(): boolean {
		if (this.#branchInFlight) {
			this.#notify("/btw branch is in progress");
			return true;
		}
		if (!this.#visible) return false;
		if (this.handleCancel()) return true;
		// A finished panel closes; its topic stays in history, its answer can no longer branch.
		this.#hideInline();
		this.#last = undefined;
		return true;
	}

	/** Cancel the running request: the partial answer is kept and saved as Cancelled. */
	handleCancel(): boolean {
		const request = this.#active;
		if (!request || getLatestTurn(request.record).status !== "running") return false;
		this.#update(request, { status: "cancelled", updatedAt: Date.now() });
		request.abort.abort();
		request.panel.markAborted();
		this.#persist(request);
		this.#refreshHistory();
		this.#requestRender();
		return true;
	}

	// ───────────────────────────── copy ─────────────────────────────

	canCopy(): boolean {
		return this.#visible && !this.#copyInFlight && this.#active?.panel.isCopyable() === true && this.#last !== undefined;
	}

	async handleCopy(): Promise<boolean> {
		if (!this.canCopy() || !this.#last) return false;
		return this.#copyAnswer(this.#last.copyText);
	}

	async #copyAnswer(answer: string, history?: { panel: BtwHistoryPanel; recordId: string }): Promise<boolean> {
		if (this.#copyInFlight || !answer.trim()) return false;
		this.#copyInFlight = true;
		// Clipboard writes settle asynchronously; the user may close this panel or start another
		// /btw before they do. Confirm only the surface that asked, and only while it is current.
		const generation = this.#generation;
		const inline = history ? undefined : this.#active;
		try {
			await this.#host.copy(replaceTabs(answer).trim());
			if (generation !== this.#generation) return true;
			this.#notify("Copied /btw answer to clipboard");
			if (history) {
				if (this.#historyPanel === history.panel) history.panel.markCopied(history.recordId, answer);
			} else if (inline && this.#visible && this.#active === inline) inline.panel.markCopied();
			this.#requestRender();
			return true;
		} catch (error) {
			if (generation === this.#generation) this.#notify(sanitizeErrorLine(error), "error");
			return true;
		} finally {
			this.#copyInFlight = false;
		}
	}

	// ───────────────────────────── branch ─────────────────────────────

	canBranch(): boolean {
		return this.#branchUnavailableReason() === undefined;
	}

	/** The answer lives in the inline panel, or natively in the open history sheet. */
	#answerShown(): boolean {
		return this.#visible || (this.#historyPanel !== undefined && this.#host.nativeActive());
	}

	/** Whether plain `b` is currently reserved for a completed or pending branch action. */
	handlesBranchKey(): boolean {
		if (this.#branchInFlight) return true;
		return this.#answerShown() && this.#active?.panel.isBranchable() === true && this.#last !== undefined;
	}

	/** `recheck`: from `performBranch`, where the branch in flight is this one and its panel reads "branching". */
	#branchUnavailableReason(recheck = false): string | undefined {
		const host = this.#host;
		if (this.#branchInFlight && !recheck) return "a branch is already in progress";
		if (this.#pendingInjects.size > 0) return "a /btw prompt is still sending";
		const request = this.#active;
		if (!this.#answerShown() || !request || (!recheck && request.panel.isBranchable() !== true)) {
			return "the answer is not ready";
		}
		// Promotion carries one pair; do not drop earlier side turns.
		if (request.history?.length) return "multi-turn side conversations remain in BTW history";
		const last = this.#last;
		if (!last || !last.question || !last.replyText) return "the answer is unavailable";
		if (!last.leafId) return "the session has no branch point";
		if (last.sessionId !== host.sessionId()) return "the session changed since /btw started";
		const blocker = host.branchBlocker(last.leafId);
		if (blocker) return blocker;
		if (!host.isIdle()) return "a turn is still running";
		return undefined;
	}

	/**
	 * `b`: ask pi to dispatch the branch command. Resolves true once it was requested; the work
	 * happens in `performBranch`. A second `b` while one is in flight starts nothing.
	 */
	async handleBranch(): Promise<boolean> {
		const reason = this.#branchUnavailableReason();
		if (reason) {
			this.#notify(`/btw branch unavailable: ${reason}`);
			return false;
		}
		const request = this.#active;
		if (!request || !this.#last) return false;
		this.#branchInFlight = true;
		this.#branchRequested = true;
		request.panel.markBranching();
		this.#refreshHistory();
		this.#requestRender();
		const generation = this.#generation;
		try {
			// pi runs extension commands at once, so `performBranch` may already run inside this call.
			this.#host.requestBranch();
		} catch (error) {
			if (generation === this.#generation && this.#branchRequested) {
				this.#endBranch(request);
				this.#notify(sanitizeErrorLine(`Cannot branch /btw: ${errorMessage(error)}`), "error");
			}
			return false;
		}
		if (generation === this.#generation && this.#branchRequested) {
			// pi refused or deferred the prompt and the command never came: do not stay stuck.
			this.#branchTimer = unref(
				setTimeout(() => {
					this.#branchTimer = undefined;
					if (generation !== this.#generation || !this.#branchRequested) return;
					this.#endBranch(request);
					this.#notify("Cannot branch /btw: the branch command did not run", "error");
				}, this.#branchTimeoutMs),
			);
		}
		return true;
	}

	/** Called by the /btw handler for BRANCH_TOKEN: re-check, promote, switch to the new session. */
	async performBranch(ctx: ExtensionCommandContext): Promise<boolean> {
		// Only a branch this controller asked for and still waits on.
		if (!this.#branchRequested) return false;
		this.#branchRequested = false;
		if (this.#branchTimer) clearTimeout(this.#branchTimer);
		this.#branchTimer = undefined;
		const generation = this.#generation;
		const request = this.#active;
		try {
			const reason = this.#branchUnavailableReason(true);
			if (reason) {
				this.#notify(`/btw branch unavailable: ${reason}`);
				return false;
			}
			const last = this.#last;
			if (!request || !last || !last.leafId) return false;
			const result = await promoteToBranch(ctx, {
				question: last.question,
				images: last.images,
				assistantMessage: last.assistantMessage,
				replyText: last.replyText,
				leafId: last.leafId,
			});
			// After a successful switch this runtime is gone (`dispose()` ran): nothing left to do here.
			if (result.cancelled && generation === this.#generation) this.#notify("/btw branch cancelled");
			return !result.cancelled;
		} catch (error) {
			if (generation === this.#generation) {
				this.#notify(sanitizeErrorLine(`Cannot branch /btw: ${errorMessage(error)}`), "error");
			}
			return false;
		} finally {
			if (generation === this.#generation) this.#endBranch(request);
			else this.#branchInFlight = false;
		}
	}

	/** The branch is over, whatever its outcome: a still-current panel goes back to complete. */
	#endBranch(request: BtwRequest | undefined): void {
		this.#branchInFlight = false;
		this.#branchRequested = false;
		if (this.#branchTimer) clearTimeout(this.#branchTimer);
		this.#branchTimer = undefined;
		if (request && this.#active === request) request.panel.markComplete();
		this.#refreshHistory();
		this.#requestRender();
	}

	// ───────────────────────────── follow-up ─────────────────────────────

	canFollowUp(): boolean {
		const request = this.#active;
		return (
			this.#visible &&
			!this.#starting &&
			!this.#branchInFlight &&
			request !== undefined &&
			this.#isActive(request) &&
			getLatestTurn(request.record).status === "complete"
		);
	}

	/** `f`: open history on the answered topic with its follow-up input open. No request is sent. */
	handleFollowUp(): boolean {
		const request = this.#active;
		if (!request || !this.canFollowUp()) return false;
		try {
			return this.#showHistory(request.store).openFollowUp(request.record.id);
		} catch (error) {
			this.#notify(sanitizeErrorLine(`Cannot open /btw history: ${errorMessage(error)}`), "error");
			return false;
		}
	}

	// ───────────────────────────── inject ─────────────────────────────

	canInject(): boolean {
		const request = this.#active;
		return this.#visible && request !== undefined && this.#isActive(request) && this.#canSend(request.record);
	}

	handleInject(): boolean {
		const request = this.#active;
		if (!request || !this.canInject()) return false;
		this.#inject(request.record);
		return true;
	}

	/** The topic's latest answer is ready to send, and no start or branch would race the new main-session turn. */
	#canSend(record: BtwRecord): boolean {
		return !this.#starting && !this.#branchInFlight && injectMarks().get(getTurnKey(record)) === "ready";
	}

	/** How a turn's `<inject>` block shows in history: sent, pending on the latest turn, or plain text. */
	#injectState(record: BtwRecord, turnIndex: number): "pending" | "sent" | undefined {
		const mark = injectMarks().get(getTurnKey(record, turnIndex));
		if (mark === "sent") return "sent";
		return mark && turnIndex === getTurns(record).length - 1 ? "pending" : undefined;
	}

	/**
	 * Send the topic's steering prompt to the main session as a user message: a steer while the
	 * agent runs, else a new turn. It is not expanded, so model-written text never runs as a
	 * command. The turn counts as sent once the `input` event shows the text reaching the session;
	 * a send that never shows up turns back to ready, with the inject key as its one retry path.
	 */
	#inject(record: BtwRecord): void {
		const text = getRecordInject(record);
		if (!text) return;
		const key = getTurnKey(record);
		if (this.#pendingInjects.has(key)) return;
		if (!this.#host.model()) {
			this.#notify("Cannot inject /btw prompt: No active model", "error");
			return;
		}
		const pending: PendingInject = { key, text, timer: undefined, settled: false };
		injectMarks().set(key, "sending");
		this.#pendingInjects.set(key, pending);
		this.#refreshHistory();
		this.#requestRender();
		try {
			// pi runs the input handlers inside this call: `confirmInject` may settle it right here.
			this.#host.sendUserMessage(text);
		} catch (error) {
			this.#settleInject(pending, false, errorMessage(error));
			return;
		}
		if (pending.settled) return;
		pending.timer = unref(setTimeout(() => this.#settleInject(pending, false), this.#injectTimeoutMs));
	}

	#settleInject(pending: PendingInject, sent: boolean, reason?: string): void {
		if (pending.settled) return;
		pending.settled = true;
		if (pending.timer) clearTimeout(pending.timer);
		pending.timer = undefined;
		if (this.#pendingInjects.get(pending.key) === pending) this.#pendingInjects.delete(pending.key);
		injectMarks().set(pending.key, sent ? "sent" : "ready");
		// Only the turn that was sent: a follow-up may have taken the panel while the send waited.
		const request = this.#active;
		if (request && getTurnKey(request.record) === pending.key) request.panel.setInjected(sent);
		this.#refreshHistory();
		this.#requestRender();
		if (sent) return;
		if (reason) this.#notify(sanitizeErrorLine(`Cannot inject /btw prompt: ${reason}`), "error");
		else this.#notify(`/btw prompt not sent · ${INJECT_KEY} to retry`);
	}

	/** From the `input` event (`source: "extension"`): the text reached the session. True when it was a pending inject. */
	confirmInject(text: string): boolean {
		for (const pending of this.#pendingInjects.values()) {
			if (pending.text !== text) continue;
			this.#settleInject(pending, true);
			return true;
		}
		return false;
	}

	// ───────────────────────────── history overlay ─────────────────────────────

	#showHistory(store: BtwHistoryStore): BtwHistoryPanel {
		if (this.#historyPanel) {
			this.#refreshHistory();
			return this.#historyPanel;
		}
		const host = this.#host;
		this.#hideInline();
		const historySessionId = host.sessionId();
		const panel = host.openHistory((theme, close) => {
			const created: BtwHistoryPanel = new BtwHistoryPanel({
				records: this.#historyRecords(store),
				theme,
				onClose: () => {
					if (this.#historyPanel === created) this.#closeHistory();
				},
				onCopy: (record) => {
					const answer = getCopyText(record);
					if (answer !== undefined) void this.#copyAnswer(answer, { panel: created, recordId: record.id });
				},
				onCancel: (record) => {
					if (this.#active?.record.id === record.id) this.handleCancel();
				},
				canFollowUp: (record) =>
					!this.#starting &&
					!this.#branchInFlight &&
					getLatestTurn(record).status !== "running" &&
					(!this.#active || getLatestTurn(this.#active.record).status !== "running"),
				canBranch: (record) => record.id === this.#active?.record.id && this.canBranch(),
				onBranch: (record) => {
					if (record.id !== this.#active?.record.id) return;
					void this.handleBranch();
				},
				onFollowUp: (record, question, signal) => {
					if (historySessionId !== host.sessionId()) return Promise.resolve(false);
					return this.startFollowUp(record.id, question, signal);
				},
				// pi closed the overlay itself (session reset): same aftermath as our own close.
				onDispose: () => {
					if (this.#historyPanel === created) this.#closeHistory();
				},
				requestRender: () => host.requestRender(),
				getHeight: () => host.terminalRows(),
				// Native has no inline panel: Esc puts the sheet away, `x` cancels.
				escapeHides: host.nativeActive(),
				// Read once per surface, so one value gates the highlighted block and the key there.
				inject: host.injectEnabled()
					? {
							state: (record, turnIndex) => this.#injectState(record, turnIndex),
							canSend: (record) => this.#canSend(record),
							send: (record) => this.#inject(record),
						}
					: undefined,
				injectKey: INJECT_KEY,
			});
			this.#historyPanel = created;
			this.#closeOverlay = close;
			return created;
		});
		// A host whose factory ran late (never pi's): still the panel it returned.
		this.#historyPanel ??= panel;
		host.requestRender();
		return panel;
	}

	/** The store's topics, with the active request's record as it is in memory (it streams ahead of the store). */
	#historyRecords(store: BtwHistoryStore): readonly BtwRecord[] {
		const records = store.getRecords();
		const request = this.#active;
		if (!request || request.store !== store) return records;
		return records.map((record) => (record.id === request.record.id ? request.record : record));
	}

	#refreshHistory(): void {
		if (this.#historyPanel && this.#store) this.#historyPanel.update(this.#historyRecords(this.#store));
	}

	#closeHistory(): void {
		const panel = this.#historyPanel;
		const close = this.#closeOverlay;
		this.#historyPanel = undefined;
		this.#closeOverlay = undefined;
		if (!panel) return;
		try {
			close?.();
		} catch {}
		// Closing while a question still answers keeps it running: text mode returns to its inline
		// panel; native has none, so it says how to get back.
		const request = this.#active;
		if (request && this.#isActive(request) && getLatestTurn(request.record).status === "running") {
			if (this.#host.nativeActive()) {
				this.#notify("/btw is still answering in the background · /btw to reopen it");
			} else {
				request.panel.setAnswer(getLatestTurn(request.record).answer);
				this.#visible = true;
				this.#host.dock.show(request.panel);
			}
		}
		this.#requestRender();
	}

	// ───────────────────────────── lifecycle ─────────────────────────────

	/** A main-turn boundary: `b to branch` and the inject hint follow the main turn. */
	mainTurnChanged(): void {
		// Both surfaces re-evaluate canBranch / canInject on every paint: a render is all it takes.
		if (this.#visible || this.#historyPanel) this.#requestRender();
	}

	activeStatus(): BtwStatus | undefined {
		return this.#active ? getLatestTurn(this.#active.record).status : undefined;
	}

	/**
	 * Session switch, fork, reload, quit: cancel a running request (saved as Cancelled), ignore its
	 * late output, close overlay and panel, forget everything. Idempotent.
	 */
	dispose(): void {
		this.#generation++;
		// A send that was not confirmed yet may never be: its block stays sendable.
		for (const pending of this.#pendingInjects.values()) {
			pending.settled = true;
			if (pending.timer) clearTimeout(pending.timer);
			pending.timer = undefined;
			injectMarks().set(pending.key, "ready");
		}
		this.#pendingInjects.clear();
		if (this.#branchTimer) clearTimeout(this.#branchTimer);
		this.#branchTimer = undefined;
		this.#branchRequested = false;
		this.#branchInFlight = false;
		try {
			this.handleCancel();
		} catch {}
		try {
			this.#closeHistory();
		} catch {}
		this.#hideInline();
		this.#active?.panel.close();
		this.#active = undefined;
		this.#last = undefined;
		this.#store = undefined;
	}

	// ───────────────────────────── internals ─────────────────────────────

	/** A checkpoint. False when it failed; the answer then stays readable for this run only. */
	#persist(request: BtwRequest): boolean {
		try {
			request.store.upsert(request.record);
			return true;
		} catch (error) {
			if (this.#sessionIs(request.sessionId)) {
				this.#notify(sanitizeErrorLine(`Could not save /btw history: ${errorMessage(error)}`), "error");
			}
			return false;
		}
	}

	#update(request: BtwRequest, patch: Partial<BtwTurn>): void {
		request.record = patchLatestTurn(request.record, patch);
	}

	#hideInline(): void {
		this.#visible = false;
		try {
			this.#host.dock.show(undefined);
		} catch {}
		this.#requestRender();
	}

	/** The request is current and its session is still the loaded one. */
	#isActive(request: BtwRequest): boolean {
		return this.#active === request && this.#sessionIs(request.sessionId);
	}

	#sessionIs(sessionId: string): boolean {
		try {
			return this.#host.sessionId() === sessionId;
		} catch {
			return false;
		}
	}

	#notify(message: string, kind: "info" | "warning" | "error" = "info"): void {
		try {
			this.#host.notify(message, kind);
		} catch {}
	}

	#requestRender(): void {
		try {
			this.#host.requestRender();
		} catch {}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

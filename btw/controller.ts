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

/**
 * Ignore pi context failures after a session switch.
 */
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
	historyDirectory(): string | undefined;
	sessionContext(): Pick<SideContextInput, "messages" | "streaming" | "systemPrompt">;
	/**
	 * Match the main turn's cache-relevant stream options.
	 */
	stream(model: Model<Api>, context: Context, signal: AbortSignal): AsyncIterable<AssistantMessageEvent>;
	recordUsage(message: AssistantMessage, sessionId: string): void;
	resolveImages(text: string, scope: "editor" | "detached"): { text: string; images: ImageContent[] } | undefined;
	copy(text: string): Promise<void>;
	editorText(): string;
	setEditorText(text: string): void;
	openHistory(make: (theme: Theme, close: () => void) => BtwHistoryPanel): BtwHistoryPanel;
	/**
	 * Prompt expansion can run model-written text as a command.
	 */
	sendUserMessage(text: string): void;
	/**
	 * Only a pi command context can replace the session.
	 */
	requestBranch(): void;
	branchBlocker(leafId: string | null): string | undefined;
}

export interface BtwControllerOptions {
	branchTimeoutMs?: number;
	injectTimeoutMs?: number;
}

const BRANCH_TIMEOUT_MS = 5_000;
const INJECT_TIMEOUT_MS = 3_000;
const PANEL_CHROME_ROWS = 12;
const PANEL_MIN_BODY_ROWS = 6;

interface BtwRequest {
	panel: BtwPanel;
	abort: AbortController;
	question: string;
	images?: readonly ImageContent[];
	model: Model<Api>;
	leafId: string | null;
	sessionId: string;
	store: BtwHistoryStore;
	record: BtwRecord;
	history?: readonly BtwTurn[];
	/**
	 * Use the same setting for the prompt and the turn's send eligibility.
	 */
	injectEnabled: boolean;
}

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
	#visible = false;
	#starting = false;
	#copyInFlight = false;
	#branchInFlight = false;
	#branchRequested = false;
	#branchTimer: ReturnType<typeof setTimeout> | undefined;
	#generation = 0;
	#store: BtwHistoryStore | undefined;
	#historyPanel: BtwHistoryPanel | undefined;
	#closeOverlay: (() => void) | undefined;
	readonly #pendingInjects = new Map<string, PendingInject>();

	constructor(host: BtwHost, options?: BtwControllerOptions) {
		this.#host = host;
		this.#branchTimeoutMs = options?.branchTimeoutMs ?? BRANCH_TIMEOUT_MS;
		this.#injectTimeoutMs = options?.injectTimeoutMs ?? INJECT_TIMEOUT_MS;
	}

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

	#restoreDraft(text: string): void {
		try {
			if (this.#host.editorText().trim() === "") this.#host.setEditorText(text);
		} catch {}
	}

	/**
	 * Keep this synchronous to prevent interleaved draft and history updates.
	 */
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
		if (trimmed && this.#active && getLatestTurn(this.#active.record).status === "running") {
			this.#notify("A /btw question is still running. Open /btw to view it or cancel it first.");
			return false;
		}
		this.#starting = true;
		try {
			const store = (this.#store ??= BtwHistoryStore.open(host.historyDirectory()));
			if (!trimmed) {
				const panel = this.#showHistory(store);
				const active = this.#active;
				if (host.nativeActive() && active?.store === store && this.#isActive(active)) panel.showRecord(active.record.id);
				return true;
			}
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
			let images: readonly ImageContent[] | undefined;
			// Image resolution can consume the editor draft.
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
			const sheet = host.nativeActive();
			this.#visible = !sheet && (!previous || !this.#historyPanel);
			host.dock.show(this.#visible ? request.panel : undefined);
			host.requestRender();
			// A turn must exist in history before it starts streaming.
			if (!this.#persist(request)) {
				if (this.#active === request) {
					this.#active = undefined;
					request.panel.close();
					this.#hideInline();
					// A write conflict leaves the store out of sync with disk.
					this.#store = undefined;
					this.#historyPanel?.update(store.getRecords());
				}
				return false;
			}
			if (!this.#isActive(request) || getLatestTurn(request.record).status !== "running") return false;
			if (signal?.aborted) {
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
				inject: request.injectEnabled,
			});
			const { replyText, assistantMessage } = await runSideTurn({
				stream: () => host.stream(request.model, context, request.abort.signal),
				onTextDelta: (delta) => {
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
			if (request.injectEnabled && getRecordInject(request.record) !== undefined) {
				injectMarks().set(getTurnKey(request.record), "ready");
			}
			if (this.#isActive(request)) {
				request.panel.setAnswer(replyText);
				request.panel.markComplete();
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
			// The stream can reject after the turn is marked cancelled.
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
		this.#hideInline();
		this.#last = undefined;
		return true;
	}

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
		// The panel may change while the clipboard write is pending.
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

	canBranch(): boolean {
		return this.#branchUnavailableReason() === undefined;
	}

	#answerShown(): boolean {
		return this.#visible || (this.#historyPanel !== undefined && this.#host.nativeActive());
	}

	handlesBranchKey(): boolean {
		if (this.#branchInFlight) return true;
		return this.#answerShown() && this.#active?.panel.isBranchable() === true && this.#last !== undefined;
	}

	#branchUnavailableReason(recheck = false): string | undefined {
		const host = this.#host;
		if (this.#branchInFlight && !recheck) return "a branch is already in progress";
		if (this.#pendingInjects.size > 0) return "a /btw prompt is still sending";
		const request = this.#active;
		if (!this.#answerShown() || !request || (!recheck && request.panel.isBranchable() !== true)) {
			return "the answer is not ready";
		}
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
			// pi can run the branch command before this call returns.
			this.#host.requestBranch();
		} catch (error) {
			if (generation === this.#generation && this.#branchRequested) {
				this.#endBranch(request);
				this.#notify(sanitizeErrorLine(`Cannot branch /btw: ${errorMessage(error)}`), "error");
			}
			return false;
		}
		if (generation === this.#generation && this.#branchRequested) {
			// pi may drop the command without reporting it.
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

	async performBranch(ctx: ExtensionCommandContext): Promise<boolean> {
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
			// Switching sessions disposes this controller before promotion returns.
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

	#endBranch(request: BtwRequest | undefined): void {
		this.#branchInFlight = false;
		this.#branchRequested = false;
		if (this.#branchTimer) clearTimeout(this.#branchTimer);
		this.#branchTimer = undefined;
		if (request && this.#active === request) request.panel.markComplete();
		this.#refreshHistory();
		this.#requestRender();
	}

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

	#canSend(record: BtwRecord): boolean {
		return !this.#starting && !this.#branchInFlight && injectMarks().get(getTurnKey(record)) === "ready";
	}

	#injectState(record: BtwRecord, turnIndex: number): "pending" | "sent" | undefined {
		const mark = injectMarks().get(getTurnKey(record, turnIndex));
		if (mark === "sent") return "sent";
		return mark && turnIndex === getTurns(record).length - 1 ? "pending" : undefined;
	}

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
			// pi can confirm delivery before this call returns.
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
		// A follow-up can start before delivery is confirmed.
		const request = this.#active;
		if (request && getTurnKey(request.record) === pending.key) request.panel.setInjected(sent);
		this.#refreshHistory();
		this.#requestRender();
		if (sent) return;
		if (reason) this.#notify(sanitizeErrorLine(`Cannot inject /btw prompt: ${reason}`), "error");
		else this.#notify(`/btw prompt not sent · ${INJECT_KEY} to retry`);
	}

	/**
	 * Only input events with source "extension" can confirm delivery.
	 */
	confirmInject(text: string): boolean {
		for (const pending of this.#pendingInjects.values()) {
			if (pending.text !== text) continue;
			this.#settleInject(pending, true);
			return true;
		}
		return false;
	}

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
				// pi can dispose the overlay on a session reset.
				onDispose: () => {
					if (this.#historyPanel === created) this.#closeHistory();
				},
				requestRender: () => host.requestRender(),
				getHeight: () => host.terminalRows(),
				escapeHides: host.nativeActive(),
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
		this.#historyPanel ??= panel;
		host.requestRender();
		return panel;
	}

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

	mainTurnChanged(): void {
		if (this.#visible || this.#historyPanel) this.#requestRender();
	}

	activeStatus(): BtwStatus | undefined {
		return this.#active ? getLatestTurn(this.#active.record).status : undefined;
	}

	dispose(): void {
		this.#generation++;
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

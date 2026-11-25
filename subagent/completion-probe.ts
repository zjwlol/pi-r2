import { type AssistantMessage, getCacheWarmingDelayMs, getPromptCacheTtlMs } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayLine, sanitizeErrorLine } from "../btw/records.ts";
import { runSideTurn, sanitizeStreamingMessage, SIDE_CHANNEL_REMINDER } from "../btw/request.ts";
import { fmtDuration } from "./prompts.ts";

const DELAYS_MINUTES = [2, 5, 10, 30, 60];
const MAX_STAGE_CHARS = 80;
const DEFAULT_SHORT_CACHE_TTL_MS = 5 * 60_000;

interface CompletionEstimate {
	percent: number;
	stage?: string;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, Math.round(value)));
}

function percentField(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return clampPercent(value);
	if (typeof value === "string") {
		const match = /^\s*(\d{1,3}(?:\.\d+)?)\s*%?\s*$/.exec(value);
		if (match) return clampPercent(Number(match[1]));
	}

	return undefined;
}

function stageLine(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = sanitizeDisplayLine(value).replace(/\s+/g, " ");
	if (line.length > MAX_STAGE_CHARS) return `${line.slice(0, MAX_STAGE_CHARS - 1).trimEnd()}…`;

	return line || undefined;
}

function objectEnd(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			for (i++; i < text.length; i++) {
				if (text[i] === "\\") i++;
				else if (text[i] === '"') break;
			}
		} else if (ch === "{" || ch === "[") {
			depth++;
		} else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}

	return -1;
}

export function parseCompletionEstimate(reply: string): CompletionEstimate | undefined {
	let percent: number | undefined;
	let stage: string | undefined;
	let start = reply.indexOf("{");
	while (start !== -1) {
		const end = objectEnd(reply, start);
		if (end === -1) break;
		const object = reply.slice(start, end);
		start = reply.indexOf("{", end);

		let fields: { pct?: unknown; percent?: unknown; stage?: unknown };
		try {
			fields = JSON.parse(object);
		} catch {
			continue;
		}
		stage ??= stageLine(fields.stage);
		percent = percentField(fields.pct ?? fields.percent);
		if (percent !== undefined) break;
	}
	if (percent === undefined) {
		const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(reply);
		if (!match) return undefined;
		percent = clampPercent(Number(match[1]));
	}

	return stage === undefined ? { percent } : { percent, stage };
}

interface PreviousEstimate extends CompletionEstimate {
	at: number;
}

function probePrompt(streaming: AssistantMessage | undefined, previous?: PreviousEstimate): string {
	const lines = ["<progress-check>", "Side question from the orchestrator. Your work continues after this reply."];
	let hasCalls = false;
	for (const block of streaming?.content ?? []) {
		if (block.type !== "toolCall") continue;
		if (!hasCalls) lines.push("These tool calls are still being written and are not in the transcript above:");
		hasCalls = true;
		const path = block.arguments.path;
		const target = typeof path === "string" ? ` (${path})` : "";
		lines.push(`- \`${block.name}\`${target}: ${JSON.stringify(block.arguments).length} characters of arguments so far`);
	}
	if (hasCalls) lines.push("Count that work as done so far.");

	lines.push(
		"Estimate how much of your assigned task is complete. Anchor on your current phase:",
		"- 0-15%: reading the task and exploring code",
		"- 15-30%: plan settled, first edits starting",
		"- 30-75%: implementing, based on deliverables finished vs. remaining",
		"- 75-90%: all deliverables written, running tests and fixing failures",
		"- 90-99%: tests pass, final review and summary left",
	);
	if (previous) {
		const stage = previous.stage ? ` at stage ${JSON.stringify(previous.stage)}` : "";
		lines.push(`Your previous estimate, ${fmtDuration(Date.now() - previous.at)} ago, was ${previous.percent}%${stage}. Update it from what happened since. Lower it if you uncovered more work.`);
	}
	lines.push(
		"Reply with ONLY one line of JSON, no code fence or other text:",
		'{"pct": 40, "stage": "benchmarking the streaming decoder"}',
		"pct: whole-number completion, 0-100.",
		`stage: your current step in a few words (at most ${MAX_STAGE_CHARS} characters).`,
		"NEVER use tools.",
		"</progress-check>",
	);

	return lines.join("\n");
}

interface ProbeOptions {
	session: AgentSession;
	onUsage: (message: AssistantMessage) => void;
	onChange: () => void;
	onError: (reason: string) => void;
}

export class CompletionProbe {
	submitted = false;
	stage?: string;
	private previous?: PreviousEstimate;
	private step = 0;
	private timer?: NodeJS.Timeout;
	private pending?: Promise<void>;
	private readonly abort = new AbortController();

	constructor(private readonly options: ProbeOptions) {
		this.schedule();
	}

	get percent(): number | undefined {
		return this.submitted ? 99 : this.previous?.percent;
	}

	stop(): Promise<void> | undefined {
		clearTimeout(this.timer);
		this.abort.abort();

		return this.pending;
	}

	private schedule(): void {
		const delay = DELAYS_MINUTES[this.step]! * 60_000;
		if (this.step < DELAYS_MINUTES.length - 1) this.step++;
		this.timer = setTimeout(() => {
			this.pending = this.ask().finally(() => {
				this.pending = undefined;
				if (!this.abort.signal.aborted) this.schedule();
			});
		}, delay);
		this.timer.unref();
	}

	private async ask(): Promise<void> {
		const { session, onUsage, onChange, onError } = this.options;
		const { signal } = this.abort;
		if (!session.isStreaming || this.submitted) return;
		try {
			const model = session.model;
			if (!model) throw new Error("No active model.");
			const current = session.state.streamingMessage;
			const streaming = current?.role === "assistant" ? current : undefined;
			const snapshot = session.sessionManager.buildSessionProjection().messages;
			let latest = streaming;
			if (!latest) {
				for (let i = snapshot.length - 1; i >= 0; i--) {
					const message = snapshot[i]!;
					if (message.role === "assistant") {
						latest = message;
						break;
					}
				}
			}
			const ttl = getPromptCacheTtlMs(model, { cacheRetention: "short" }) ?? DEFAULT_SHORT_CACHE_TTL_MS;
			const maxAge = getCacheWarmingDelayMs(ttl);
			if (!latest || maxAge === undefined || Date.now() - latest.timestamp >= maxAge) return;

			const partial = sanitizeStreamingMessage(streaming);
			if (partial && !snapshot.some((m) => m.role === "assistant" && m.timestamp === partial.timestamp)) snapshot.push(partial);
			snapshot.push({
				role: "user",
				timestamp: Date.now(),
				content: [{ type: "text", text: SIDE_CHANNEL_REMINDER }, { type: "text", text: probePrompt(streaming, this.previous) }],
			});

			const messages = await session.agent.convertToLlm(snapshot);
			const thinking = session.thinkingLevel;
			const { replyText } = await runSideTurn({
				stream: () => session.modelRuntime.streamSimple(model, { messages }, {
					signal,
					onPayload: session.agent.onPayload,
					sessionId: session.sessionId,
					disableContinuation: true,
					reasoning: thinking === "off" ? undefined : thinking,
					thinkingBudgets: session.agent.thinkingBudgets,
					transport: session.agent.transport,
				}),
				signal,
				onUsage,
				onTextDelta: () => {},
			});
			if (signal.aborted || this.submitted) return;
			const estimate = parseCompletionEstimate(replyText);
			if (estimate) {
				this.previous = { ...estimate, at: Date.now() };
				if (estimate.stage !== undefined) this.stage = estimate.stage;
				onChange();
			} else {
				onError("No percentage in the reply.");
			}
		} catch (error) {
			if (!signal.aborted) onError(sanitizeErrorLine(error));
		}
	}
}

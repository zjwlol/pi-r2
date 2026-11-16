/**
 * The `/btw` side request: prompt text, context assembly and stream consumption.
 *
 * Ports oh-my-pi `packages/coding-agent/src/session/btw-turn.ts` (`runBtwTurn`: the topic's earlier
 * turns replayed as separate user / assistant messages), `AgentSession.runEphemeralTurn` and
 * `#buildEphemeralSnapshot` of `session/agent-session.ts` (session messages + in-flight assistant
 * text + no-tools reminder + history + prompt; tool calls discarded) and the prompt files
 * `prompts/system/btw-user.md` and `side-channel-no-tools.md`.
 *
 * Differences forced by vanilla pi: there is no `developer` role, so the reminder is the first
 * text block of the first side user message (which also keeps that message byte-identical across
 * follow-ups); the in-flight message is appended unless the projection already holds it; unsigned
 * partial thinking is dropped, because pi-ai cannot replay it.
 *
 * Type imports only and erasable TypeScript: plain `node` loads this file. The caller supplies the
 * session messages and the provider stream, so nothing here touches pi.
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	Model,
	TextContent,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { BtwTurn } from "./records.ts";
import { dedupeReply } from "./records.ts";

/** Told to the model ahead of the side question: the tool declarations are there for the prompt cache only. */
export const SIDE_CHANNEL_REMINDER: string = [
	"<system-reminder>",
	"Ephemeral side-channel turn; reuses current conversation context.",
	"Tool catalog attached only to keep prompt cache warm; tools NOT available this turn.",
	"Do NOT emit tool calls; reply plain text only. Tool calls discarded without execution.",
	"</system-reminder>",
].join("\n");

const PROMPT_HEAD: readonly string[] = [
	"<btw>",
	"Ephemeral side question for current interactive session.",
	"Answer briefly, directly; use conversation context already provided.",
	"NEVER use tools.",
	"NEVER ask follow-up questions.",
];

/** Present only with the `btw.inject` setting on. */
const PROMPT_STEERING: readonly string[] = [
	"Steering: only when the question asks for a steering, correction, or instruction prompt for the main session, draft the exact message for the main agent inside ONE `<inject>…</inject>` block, written as the user speaking to it. The user can send that block to the main session verbatim, so it MUST stand alone. Write it exactly in this form, plain text between the tags:",
	"<inject>Pause the refactor and fix the failing build first, then rerun the tests before continuing.</inject>",
	"NEVER put quote markers, bullets, or code fences around or inside the block, and NEVER write the tag anywhere else.",
];

/** The question wrapped in the `<btw>` prompt; `inject` adds the Steering paragraph. */
export function renderBtwPrompt(question: string, inject: boolean): string {
	return [...PROMPT_HEAD, ...(inject ? PROMPT_STEERING : []), "Question:", question, "</btw>"].join("\n");
}

/**
 * The main turn's in-flight assistant message in a form that can be replayed: a copy with its
 * non-blank text blocks and the thinking blocks a provider accepts back (signed or redacted), without
 * tool calls, unsigned thinking and any thinking after the last text block (providers reject reasoning
 * that no item follows), ended as a normal stop. `undefined` when it has no text yet.
 */
export function sanitizeStreamingMessage(message: AssistantMessage | undefined): AssistantMessage | undefined {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const content: AssistantMessage["content"] = [];
	let hasText = false;
	for (const block of message.content) {
		if (block.type === "text") {
			if (typeof block.text !== "string" || !block.text.trim()) continue;
			content.push({ ...block });
			hasText = true;
		} else if (block.type === "thinking") {
			if (block.thinkingSignature || block.redacted) content.push({ ...block });
		}
	}
	if (!hasText) return undefined;
	// With the tool calls gone, thinking that led up to one would end the message.
	while (content.at(-1)?.type === "thinking") content.pop();
	const { errorMessage: _errorMessage, ...rest } = message;
	return { ...rest, content, stopReason: "stop" };
}

export interface SideContextInput {
	/** convertToLlm(sm.buildSessionProjection().messages) */
	messages: readonly Message[];
	/** Latest in-flight assistant message of the main turn. */
	streaming?: AssistantMessage;
	/** ctx.getSystemPrompt(); used only when `messages` has no system message. */
	systemPrompt: string;
	model: Pick<Model<Api>, "api" | "provider" | "id">;
	/** Earlier turns of a follow-up's topic, replayed as context. */
	history?: readonly BtwTurn[];
	question: string;
	/** Images attached to this question; earlier turns replay their own. */
	images?: readonly ImageContent[];
	/** Ask for steering prompts in an `<inject>` block (the `btw.inject` setting). */
	inject: boolean;
	/** pi's `images.blockImages` setting: send no image content, as pi's own requests do (a text placeholder per image). */
	blockImages?: boolean;
	/** Timestamp of the new question's message; default `Date.now()`. */
	now?: number;
}

/** What pi sends in place of an image while `images.blockImages` is on (`core/sdk.js`). */
const IMAGE_BLOCKED_TEXT = "Image reading is disabled.";

/**
 * pi's `convertToLlmWithBlockImages` (`dist/core/sdk.js`): in user and tool-result messages every image
 * block becomes the placeholder text, and a placeholder directly after another one is dropped. Messages
 * without images are returned as they are; changed ones are copies.
 */
function blockImageContent(messages: readonly Message[]): Message[] {
	const isPlaceholder = (block: TextContent | ImageContent | undefined): boolean =>
		block?.type === "text" && block.text === IMAGE_BLOCKED_TEXT;
	return messages.map((message): Message => {
		if (message.role !== "user" && message.role !== "toolResult") return message;
		const content = message.content;
		if (!Array.isArray(content) || !content.some((block) => block.type === "image")) return message;
		const filtered = content
			.map((block): TextContent | ImageContent => (block.type === "image" ? { type: "text", text: IMAGE_BLOCKED_TEXT } : block))
			.filter((block, index, all) => !(isPlaceholder(block) && index > 0 && isPlaceholder(all[index - 1])));
		return { ...message, content: filtered };
	});
}

function sideUserMessage(
	question: string,
	images: readonly ImageContent[] | undefined,
	inject: boolean,
	timestamp: number,
): UserMessage & { content: (TextContent | ImageContent)[] } {
	return {
		role: "user",
		content: [{ type: "text", text: renderBtwPrompt(question, inject) }, ...(images ?? []).map((image) => ({ ...image }))],
		timestamp,
	};
}

/**
 * The request context of one side question: the session's messages, the in-flight assistant text
 * (unless the projection already holds that message), each earlier turn of the topic as a user
 * message plus an assistant message for its answer text, then the new question. The no-tools
 * reminder is the first text block of the first side message. With `blockImages`, images anywhere in
 * it are replaced as pi replaces them. The input is never mutated.
 */
export function buildSideContext(input: SideContextInput): Context {
	const base: Message[] = [...input.messages];
	const partial = sanitizeStreamingMessage(input.streaming);
	if (partial && !base.some((message) => message.role === "assistant" && message.timestamp === partial.timestamp)) {
		base.push(partial);
	}

	const side: Message[] = [];
	const users: (UserMessage & { content: (TextContent | ImageContent)[] })[] = [];
	for (const turn of input.history ?? []) {
		const user = sideUserMessage(turn.question, turn.images, input.inject, turn.createdAt);
		users.push(user);
		side.push(user);
		// A turn without answer text (cancelled early, failed) replays only its question.
		if (!turn.answer) continue;
		// Saved BTW history contains visible text, not provider-native reasoning
		// or replay signatures. These are context messages, not new billed turns.
		side.push({
			role: "assistant",
			content: [{ type: "text", text: turn.answer }],
			api: input.model.api,
			provider: input.model.provider,
			model: input.model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: turn.updatedAt,
		});
	}
	const prompt = sideUserMessage(input.question, input.images, input.inject, input.now ?? Date.now());
	users.push(prompt);
	side.push(prompt);
	users[0]!.content.unshift({ type: "text", text: SIDE_CHANNEL_REMINDER });

	const all = [...base, ...side];
	const messages = input.blockImages ? blockImageContent(all) : all;
	// The projection normally carries the prompt and tool declarations in its system head.
	return base.some((message) => message.role === "system") ? { messages } : { systemPrompt: input.systemPrompt, messages };
}

/**
 * Consume one response. Rejects when `signal` is already aborted, when `stream()` throws, on an `error`
 * event (Error(errorMessage || "Side request failed")) and when the stream ends without `done`
 * ("Side request ended without a final message"). `onUsage` gets the `done` message or the `error` message.
 * replyText = dedupeReply(joined text deltas, trimmed); when no delta arrived, the final message's text blocks
 * are used and emitted as one delta. The returned message has no toolCall blocks.
 */
export async function runSideTurn(args: {
	stream: () => AsyncIterable<AssistantMessageEvent>;
	onTextDelta: (delta: string) => void;
	onUsage?: (message: AssistantMessage) => void;
	signal: AbortSignal;
}): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
	if (args.signal.aborted) {
		const reason: unknown = args.signal.reason;
		throw reason instanceof Error ? reason : new Error("Side request aborted");
	}
	// Reported where the provider settles the request, before any later step can throw it away.
	const reportUsage = (message: AssistantMessage): void => {
		try {
			args.onUsage?.(message);
		} catch {
			// Accounting must not turn an answered question into a failure.
		}
	};

	let replyText = "";
	let assistantMessage: AssistantMessage | undefined;
	for await (const event of args.stream()) {
		if (event.type === "text_delta") {
			if (!event.delta) continue;
			replyText += event.delta;
			args.onTextDelta(event.delta);
			continue;
		}
		if (event.type === "done") {
			// A proxy or custom provider can hand back a message without `content`; read it as empty.
			assistantMessage = { ...event.message, content: Array.isArray(event.message.content) ? event.message.content : [] };
			reportUsage(assistantMessage);
			break;
		}
		if (event.type === "error") {
			if (event.error) reportUsage(event.error);
			throw new Error(event.error?.errorMessage || "Side request failed");
		}
		// Thinking and tool-call events are not part of a side answer.
	}
	if (!assistantMessage) throw new Error("Side request ended without a final message");

	if (!replyText) {
		// A provider that sends the answer whole, without deltas.
		replyText = assistantMessage.content
			.filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("");
		if (replyText) args.onTextDelta(replyText);
	}
	return {
		replyText: dedupeReply(replyText.trim()),
		assistantMessage: { ...assistantMessage, content: assistantMessage.content.filter((block) => block.type !== "toolCall") },
	};
}

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

const PROMPT_STEERING: readonly string[] = [
	"Steering: only when the question asks for a steering, correction, or instruction prompt for the main session, draft the exact message for the main agent inside ONE `<inject>…</inject>` block, written as the user speaking to it. The user can send that block to the main session verbatim, so it MUST stand alone. Write it exactly in this form, plain text between the tags:",
	"<inject>Pause the refactor and fix the failing build first, then rerun the tests before continuing.</inject>",
	"NEVER put quote markers, bullets, or code fences around or inside the block, and NEVER write the tag anywhere else.",
];

export function renderBtwPrompt(question: string, inject: boolean): string {
	return [...PROMPT_HEAD, ...(inject ? PROMPT_STEERING : []), "Question:", question, "</btw>"].join("\n");
}

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
			// Some providers reject unsigned thinking during replay.
			if (block.thinkingSignature || block.redacted) content.push({ ...block });
		}
	}
	if (!hasText) return undefined;
	// Some providers reject replayed messages that end in thinking.
	while (content.at(-1)?.type === "thinking") content.pop();
	const { errorMessage: _errorMessage, ...rest } = message;
	return { ...rest, content, stopReason: "stop" };
}

export interface SideContextInput {
	messages: readonly Message[];
	streaming?: AssistantMessage;
	systemPrompt: string;
	model: Pick<Model<Api>, "api" | "provider" | "id">;
	history?: readonly BtwTurn[];
	question: string;
	images?: readonly ImageContent[];
	inject: boolean;
	blockImages?: boolean;
	now?: number;
}

const IMAGE_BLOCKED_TEXT = "Image reading is disabled.";

/**
 * Match pi's blocked image text and deduplication to preserve the prompt cache prefix.
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
		if (!turn.answer) continue;
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
	// Keep the reminder in the first side message to preserve the cache prefix on follow-ups.
	users[0]!.content.unshift({ type: "text", text: SIDE_CHANNEL_REMINDER });

	const all = [...base, ...side];
	const messages = input.blockImages ? blockImageContent(all) : all;
	return base.some((message) => message.role === "system") ? { messages } : { systemPrompt: input.systemPrompt, messages };
}

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
	// Record provider usage even if the answer later fails.
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
			// Custom providers can omit content.
			assistantMessage = { ...event.message, content: Array.isArray(event.message.content) ? event.message.content : [] };
			reportUsage(assistantMessage);
			break;
		}
		if (event.type === "error") {
			if (event.error) reportUsage(event.error);
			throw new Error(event.error?.errorMessage || "Side request failed");
		}
	}
	if (!assistantMessage) throw new Error("Side request ended without a final message");

	// Some providers send the full answer without text deltas.
	if (!replyText) {
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

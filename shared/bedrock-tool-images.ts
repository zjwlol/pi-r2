const IMAGE_PLACEHOLDER = "(see attached image)";

interface ToolResultContentBlock {
	text?: string;
	image?: object;
}

interface ToolResultBlock {
	content: ToolResultContentBlock[];
}

interface ContentBlock {
	image?: object;
	toolResult?: ToolResultBlock;
	cachePoint?: object;
}

interface Message {
	content: ContentBlock[];
}

interface ConversePayload {
	modelId: string;
	messages: Message[];
}

function isConversePayload(payload: unknown): payload is ConversePayload {
	const candidate = payload as Partial<ConversePayload> | null | undefined;

	return typeof candidate?.modelId === "string" && Array.isArray(candidate.messages);
}

function isOpenAiModel(modelId: string): boolean {
	return modelId.startsWith("openai.") || modelId.includes(".openai.");
}

function withImagesAfterToolResults(message: Message): Message | undefined {
	if (!Array.isArray(message?.content)) return undefined;
	const blocks = message.content;
	const last = blocks.at(-1);
	const end = last?.cachePoint ? blocks.length - 1 : blocks.length;
	let content: ContentBlock[] | undefined;
	for (let i = 0; i < end; i++) {
		const block = blocks[i];
		const result = block?.toolResult;
		if (!Array.isArray(result?.content)) continue;

		let items: ToolResultContentBlock[] | undefined;
		for (let j = 0; j < result.content.length; j++) {
			const item = result.content[j];
			if (item?.image) {
				items ??= result.content.slice();
				items[j] = { text: IMAGE_PLACEHOLDER };

				content ??= blocks.slice(0, end);
				content.push(item);
			}
		}
		if (items && content) content[i] = { ...block, toolResult: { ...result, content: items } };
	}

	if (content) {
		if (last?.cachePoint) content.push(last);

		return { ...message, content };
	}

	return undefined;
}

/**
 * Affected models require tool images as separate user content blocks.
 */
export function moveImagesOutOfToolResults(payload: unknown): ConversePayload | undefined {
	if (isConversePayload(payload) && isOpenAiModel(payload.modelId)) {
		let messages: Message[] | undefined;
		for (let i = 0; i < payload.messages.length; i++) {
			const message = withImagesAfterToolResults(payload.messages[i]);
			if (message) {
				messages ??= payload.messages.slice();
				messages[i] = message;
			}
		}

		if (messages) return { ...payload, messages };
	}

	return undefined;
}

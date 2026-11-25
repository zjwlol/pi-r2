import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
	createEditToolDefinition,
	createReadToolDefinition,
	generateDiffString,
	generateUnifiedPatch,
	type ToolDefinition,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeToLf, stripBom } from "./format.ts";
import { firstHeaderPath } from "./input.ts";
import { applyHashlinePatch, canonicalKey, type EditOutcome, patchTargetPaths, resolvePath } from "./patcher.ts";
import {
	EDIT_DESCRIPTION,
	EDIT_INPUT_DESCRIPTION,
	EDIT_PROMPT_GUIDELINES,
	EDIT_PROMPT_SNIPPET,
	READ_DESCRIPTION_SUFFIX,
	READ_PROMPT_GUIDELINES,
	READ_PROMPT_SNIPPET,
} from "./prompt.ts";
import { formatReadOutput } from "./read-format.ts";
import { type EditStore, MAX_SNAPSHOT_FILE_BYTES } from "./store.ts";
import { HashlineError } from "./types.ts";

export interface HashlineRuntime {
	store: EditStore;
}

// biome-ignore lint/suspicious/noExplicitAny: tool definitions are registered type-erased, like any customTools entry.
type AnyTool = ToolDefinition<any, any, any>;

export function displayPathFor(absolute: string, cwd: string): string {
	const relative = nodePath.relative(cwd, absolute);
	if (relative === "" || relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) return absolute;
	return relative.split(nodePath.sep).join("/");
}

function readAnchorableText(absolute: string): { text: string } | { reason: string } | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absolute);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) return undefined;
	if (stat.size > MAX_SNAPSHOT_FILE_BYTES) return { reason: "file is larger than 4MB" };
	let raw: string;
	try {
		raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(absolute));
	} catch {
		return { reason: "file is not valid UTF-8 text" };
	}
	if (raw.includes("\u0000")) return { reason: "file looks binary" };
	return { text: normalizeToLf(stripBom(raw).text) };
}

export function createHashlineReadTool(runtime: HashlineRuntime): AnyTool {
	const base = createReadToolDefinition(process.cwd()) as AnyTool;
	return {
		...base,
		description: base.description + READ_DESCRIPTION_SUFFIX,
		promptSnippet: READ_PROMPT_SNIPPET,
		promptGuidelines: [...READ_PROMPT_GUIDELINES],
		async execute(toolCallId, params: { path: string; offset?: number | null; limit?: number | null }, signal, onUpdate, ctx) {
			const cwd = ctx.cwd;
			const builtin = createReadToolDefinition(cwd) as AnyTool;
			// Run pi's read first to preserve its errors and image handling.
			const result = await builtin.execute(toolCallId, params, signal, onUpdate, ctx);
			const first = result.content[0];
			const isImage = result.content.some((block: { type: string }) => block.type === "image");
			if (isImage || !first || first.type !== "text" || first.text.startsWith("Read image file [")) return result;
			const absolute = resolvePath(params.path, cwd);
			const anchorable = readAnchorableText(absolute);
			if (!anchorable) return result;
			if ("reason" in anchorable) {
				const note = `[No edit anchors: ${anchorable.reason}; \`edit\` cannot target this file.]`;
				return { ...result, content: [{ type: "text", text: `${first.text}\n\n${note}` }] };
			}
			const tag = runtime.store.record(canonicalKey(absolute), anchorable.text);
			const displayPath = displayPathFor(absolute, cwd);
			const formatted = formatReadOutput(anchorable.text, { displayPath, tag, offset: params.offset ?? undefined, limit: params.limit ?? undefined });
			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					...(result.details ?? {}),
					hashline: { path: displayPath, tag, firstLine: formatted.firstLine, lastLine: formatted.lastLine, totalLines: formatted.totalLines },
				},
				structuredContent: formatted.text,
			};
		},
	};
}

async function withQueues<T>(paths: readonly string[], fn: () => T): Promise<T> {
	// Acquire the queues in sorted order to avoid deadlocks.
	const sorted = [...new Set(paths)].sort();
	const step = (index: number): Promise<T> => (index >= sorted.length ? Promise.resolve().then(fn) : withFileMutationQueue(sorted[index], () => step(index + 1)));
	return step(0);
}

/**
 * Pi's edit renderer reads `details.diff`.
 */
export function editDetails(outcome: EditOutcome): { diff: string; patch: string; firstChangedLine?: number; files: { path: string; op: string; moveTo?: string }[] } {
	const diffs: string[] = [];
	const patches: string[] = [];
	let firstChangedLine: number | undefined;
	for (const file of outcome.files) {
		if (file.op === "noop") continue;
		const after = file.op === "delete" ? "" : file.after;
		const display = generateDiffString(file.before, after);
		if (display.diff) diffs.push(display.diff);
		const patch = generateUnifiedPatch(file.path, file.before, after);
		if (patch) patches.push(patch.endsWith("\n") ? patch : `${patch}\n`);
		if (firstChangedLine === undefined) firstChangedLine = file.firstChangedLine ?? display.firstChangedLine;
	}
	const details: ReturnType<typeof editDetails> = {
		diff: diffs.join("\n"),
		patch: patches.join(""),
		files: outcome.files.map((file) => (file.moveTo === undefined ? { path: file.path, op: file.op } : { path: file.path, op: file.op, moveTo: file.moveTo })),
	};
	if (firstChangedLine !== undefined) details.firstChangedLine = firstChangedLine;
	return details;
}

const editSchema = Type.Object({
	input: Type.String({ description: EDIT_INPUT_DESCRIPTION }),
});

export function createHashlineEditTool(runtime: HashlineRuntime): AnyTool {
	const builtin = createEditToolDefinition(process.cwd()) as AnyTool;
	// Pi's edit renderer expects `args.path`.
	const withPath = (args: unknown): unknown => {
		const input = (args as { input?: unknown } | undefined)?.input;
		const path = typeof input === "string" ? firstHeaderPath(input) : undefined;
		return path === undefined ? args : { ...(args as object), path };
	};
	return {
		name: "edit",
		label: "edit",
		description: EDIT_DESCRIPTION,
		promptSnippet: EDIT_PROMPT_SNIPPET,
		promptGuidelines: [...EDIT_PROMPT_GUIDELINES],
		parameters: editSchema,
		// Edits to different files still share clipboard state.
		executionMode: "sequential",
		renderShell: builtin.renderShell,
		renderCall: builtin.renderCall ? (args, theme, context) => (builtin.renderCall as NonNullable<AnyTool["renderCall"]>)(withPath(args), theme, context) : undefined,
		renderResult: builtin.renderResult
			? (result, options, theme, context) =>
					(builtin.renderResult as NonNullable<AnyTool["renderResult"]>)(result, options, theme, Object.assign(Object.create(context), { args: withPath(context.args) }))
			: undefined,
		async execute(_toolCallId, params: { input: string }, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const cwd = ctx.cwd;
			try {
				const outcome = await withQueues(patchTargetPaths(params.input, cwd), () => applyHashlinePatch(params.input, { cwd, store: runtime.store }));
				return { content: [{ type: "text", text: outcome.text }], details: editDetails(outcome) };
			} catch (error) {
				if (!(error instanceof HashlineError)) throw error;
				return { content: [{ type: "text", text: error.message }], details: { diff: "", patch: "", errorKind: error.kind }, isError: true };
			}
		},
	};
}

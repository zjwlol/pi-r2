import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { activateEditorHook, type EditorHookHandle } from "./editor-hook.ts";
import { readStateMeta, STATE_FILE } from "./engine/store.ts";
import { type HostStatus, PredictHost, readConfig, writeConfig } from "./host.ts";
import { WordCompletionProvider } from "./provider.ts";

const START_DELAY_MS = 300;
const SUBCOMMANDS = ["on", "off", "status"] as const;

interface Runtime {
	agentDir: string;
	host: PredictHost;
	provider: WordCompletionProvider;
	enabled: boolean;
	hook: EditorHookHandle | undefined;
	hookError: string | undefined;
	startTimer: ReturnType<typeof setTimeout> | undefined;
}

function extensionDir(): string {
	// @ts-ignore TS1470: import.meta is fine at runtime; the type-check config may assume CommonJS output.
	return typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Pi's `--no-session` prompts must stay out of the journal.
 */
function sessionPersisted(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getSessionFile() !== undefined;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	// Pi may call the factory without a session.
	let runtime: Runtime | undefined;
	let warned = false;

	const activate = (rt: Runtime, ctx: ExtensionContext, delayMs: number): boolean => {
		if (rt.hook) return true;
		const hook = activateEditorHook({
			provider: rt.provider,
			enabled: () => rt.enabled,
			style: (text) => ctx.ui.theme.fg("dim", text),
		});
		if ("error" in hook) {
			rt.hookError = hook.error;
			if (!warned) {
				warned = true;
				ctx.ui.notify(`word-predict disabled: ${hook.error}`, "warning");
			}
			return false;
		}
		rt.hook = hook;
		rt.hookError = undefined;
		rt.provider.setEnabled(true);
		clearTimeout(rt.startTimer);
		rt.startTimer = setTimeout(() => {
			rt.startTimer = undefined;
			rt.host.start();
		}, delayMs);
		rt.startTimer.unref?.();
		return true;
	};

	const deactivate = async (rt: Runtime): Promise<void> => {
		clearTimeout(rt.startTimer);
		rt.startTimer = undefined;
		rt.provider.setEnabled(false);
		rt.hook?.dispose();
		rt.hook = undefined;
		try {
			await rt.host.stop();
		} catch {
			// The journal already holds prompts the worker has not saved.
		}
	};

	const teardown = async (): Promise<void> => {
		const rt = runtime;
		runtime = undefined;
		if (rt) await deactivate(rt);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await teardown();
		const agentDir = getAgentDir();
		const host = new PredictHost({ agentDir, extensionDir: extensionDir() });
		const rt: Runtime = {
			agentDir,
			host,
			provider: new WordCompletionProvider(() => host.backend),
			enabled: readConfig(agentDir).enabled,
			hook: undefined,
			hookError: undefined,
			startTimer: undefined,
		};
		runtime = rt;
		if (rt.enabled) activate(rt, ctx, START_DELAY_MS);
		else rt.provider.setEnabled(false);
	});

	pi.on("session_shutdown", async () => {
		await teardown();
	});

	// Pi emits `input` before expanding skills and templates.
	pi.on("input", (event, ctx) => {
		const rt = runtime;
		if (!rt?.hook || !rt.enabled || event.source !== "interactive" || !sessionPersisted(ctx)) return;
		rt.host.observe(event.text);
	});

	pi.on("user_bash", (event, ctx) => {
		const rt = runtime;
		if (!rt?.hook || !rt.enabled || !sessionPersisted(ctx)) return;
		rt.host.observe((event.excludeFromContext ? "!!" : "!") + event.command);
	});

	pi.registerCommand("word-predict", {
		description: "Word predictions in the prompt editor (Tab accepts with a space, → without): on | off | status",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			const items = SUBCOMMANDS.filter((name) => name.startsWith(typed)).map((name) => ({ value: name, label: name }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const rt = runtime;
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("word-predict runs only in the interactive TUI", "info");
				return;
			}
			if (!rt) {
				ctx.ui.notify("word-predict is not running in this session", "warning");
				return;
			}
			const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
			switch (sub) {
				case "":
				case "status":
					ctx.ui.notify(await statusText(rt), "info");
					return;
				case "on": {
					writeConfig(rt.agentDir, { enabled: true });
					rt.enabled = true;
					if (!activate(rt, ctx, 0)) {
						ctx.ui.notify(`word-predict is on, but inert: ${rt.hookError ?? "the editor hook is not installed"}`, "warning");
						return;
					}
					ctx.ui.notify("word-predict on", "info");
					return;
				}
				case "off":
					writeConfig(rt.agentDir, { enabled: false });
					rt.enabled = false;
					await deactivate(rt);
					ctx.ui.notify("word-predict off", "info");
					return;
				default:
					ctx.ui.notify("Usage: /word-predict [on|off|status]", "warning");
			}
		},
	});
}

function workerState(status: HostStatus): string {
	if (status.worker === "failed") return `failed: ${status.error ?? "unknown reason"}`;
	if (status.worker === "stopped") return "stopped";
	const engine = status.engine;
	if (!engine) return "starting";
	if (engine.phase !== "failed") return engine.phase;
	return engineError(status) === undefined ? "failed: unknown reason" : "failed";
}

const ERROR_LIMIT = 200;

/**
 * The engine can report an error and keep serving predictions.
 */
function engineError(status: HostStatus): string | undefined {
	const error: unknown = status.engine?.error;
	if (typeof error !== "string") return undefined;
	const line = (error.split(/\r?\n/).find((part) => part.trim() !== "") ?? "").trim();
	if (line === "") return undefined;
	return line.length > ERROR_LIMIT ? `${line.slice(0, ERROR_LIMIT - 1)}…` : line;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

async function statusText(rt: Runtime): Promise<string> {
	const status = await rt.host.status();
	const engine = status.engine;
	const lines = [`word-predict: ${rt.enabled ? "on" : "off"}`, `worker: ${workerState(status)}`];
	const error = engineError(status);
	if (error !== undefined) lines.push(`engine error: ${error}`);

	let stateBytes: number | null = engine?.stateBytes ?? null;
	let savedAt: number | null = engine?.savedAt ?? null;
	if (engine) {
		lines.push(`learned: ${engine.prompts} prompts, ${engine.foreignPrompts} foreign prompts, ${engine.vocabulary} words`);
	} else {
		const meta = readStateMeta(status.stateDir);
		try {
			stateBytes = fs.statSync(path.join(status.stateDir, STATE_FILE)).size;
		} catch {
			stateBytes = null;
		}
		savedAt = meta?.savedAt ?? null;
		lines.push(
			meta
				? `learned (saved state): ${meta.prompts} prompts, ${meta.foreignPrompts} foreign prompts; vocabulary unknown while the worker is not ready`
				: "learned: unknown while the worker is not ready",
		);
	}
	const saved = savedAt !== null && savedAt > 0 ? `, saved ${formatAge(Date.now() - savedAt)}` : "";
	lines.push(`state: ${stateBytes !== null ? `${formatBytes(stateBytes)}${saved}` : "not written yet"} (${status.stateDir})`);

	const hook = rt.hook?.status();
	if (!hook) lines.push(`editor: ${rt.hookError ? `not hooked: ${rt.hookError}` : "not hooked (off)"}`);
	else if (!hook.installed) lines.push("editor: hook replaced by another runtime");
	else lines.push(`editor: ${hook.seenEditor ? `prompt editor seen, last painted ${hook.lastPaint ?? "nowhere yet"}` : "prompt editor not seen yet"}`);
	return lines.join("\n");
}

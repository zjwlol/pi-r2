/**
 * word-predict (ported from oh-my-pi's "Word Autocomplete")
 *
 * While you type prose in the prompt editor, the rest of the word you are
 * probably typing is shown dim after the caret. Tab accepts it with a space
 * (a `.` or `)` typed next pulls back onto the word), → accepts it without;
 * typing on keeps or drops it. Predictions come from an N-gram engine that
 * learns the prompts you submit; it runs in a worker thread and keeps its
 * state in `<agentDir>/word-predict/`, shared by every pi process.
 *
 *   /word-predict [on|off|status]   switch it (persisted) or show its state
 *
 * Only in the interactive TUI: in print, JSON and RPC mode nothing is
 * started, patched or read.
 *
 * This file: events, the command and the runtime's lifecycle. The engine is
 * under engine/ (host.ts talks to it), the gates and ghost cache in
 * provider.ts, the editor integration in editor-hook.ts.
 *
 * Port of oh-my-pi `packages/coding-agent/src/modes/interactive-mode.ts` (MIT):
 * the wiring of the `spelling.autocomplete` setting to the provider and the
 * engine. The prompt feed replaces upstream's `history.db` rows (the `input`
 * and `user_bash` events here).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { activateEditorHook, type EditorHookHandle } from "./editor-hook.ts";
import { readStateMeta, STATE_FILE } from "./engine/store.ts";
import { type HostStatus, PredictHost, readConfig, writeConfig } from "./host.ts";
import { WordCompletionProvider } from "./provider.ts";

/** The worker starts this long after the session, so its load does not compete with pi's startup. */
const START_DELAY_MS = 300;
const SUBCOMMANDS = ["on", "off", "status"] as const;

/** One interactive session's state; exists only in TUI mode, between `session_start` and `session_shutdown`. */
interface Runtime {
	agentDir: string;
	host: PredictHost;
	provider: WordCompletionProvider;
	/** The config's switch. */
	enabled: boolean;
	/** The active editor hook: set while enabled, unless pi-tui did not match. */
	hook: EditorHookHandle | undefined;
	/** Why the editor hook could not be installed; the extension is inert then. */
	hookError: string | undefined;
	startTimer: ReturnType<typeof setTimeout> | undefined;
}

function extensionDir(): string {
	// jiti (pi's extension loader) provides __dirname; fall back to import.meta for native ESM.
	// @ts-ignore TS1470: import.meta is fine at runtime; the type-check config may assume CommonJS output.
	return typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
}

/**
 * pi writes this session to a file. What pi itself does not keep (`pi --no-session`) is not journaled either:
 * the journal would be the only place those prompts are stored.
 */
function sessionPersisted(ctx: ExtensionContext): boolean {
	try {
		return ctx.sessionManager.getSessionFile() !== undefined;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	// Nothing at factory time (factories may run without a session).
	let runtime: Runtime | undefined;
	/** The "pi-tui does not match" warning was shown. */
	let warned = false;

	/** Hook the editor and schedule the worker. False, with a warning the first time, when pi-tui does not match. */
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

	/** Unhook the editor (ghosts vanish, Tab and → are pi's again) and stop the worker, which persists first. */
	const deactivate = async (rt: Runtime): Promise<void> => {
		clearTimeout(rt.startTimer);
		rt.startTimer = undefined;
		rt.provider.setEnabled(false);
		rt.hook?.dispose();
		rt.hook = undefined;
		try {
			await rt.host.stop();
		} catch {
			// Nothing is lost: unpersisted prompts are in the journal.
		}
	};

	const teardown = async (): Promise<void> => {
		const rt = runtime;
		runtime = undefined;
		if (rt) await deactivate(rt);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// A session of this runtime that was never shut down.
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

	// What the composer submits is what the engine learns: idle prompts, steers and follow-ups alike, as typed
	// (paste markers expanded, before skill / template expansion). Slash commands never get here.
	pi.on("input", (event, ctx) => {
		const rt = runtime;
		if (!rt?.hook || !rt.enabled || event.source !== "interactive" || !sessionPersisted(ctx)) return;
		rt.host.observe(event.text);
	});

	// `!` / `!!` lines, stored as typed (upstream learns them through the same history).
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

// ── /word-predict status ────────────────────────────────────────────────

/**
 * `stopped` / `starting` / `loading` / `bootstrapping` / `ready` / `failed: <reason>`. An error the engine reports
 * is not the reason here: it has its own line (see `engineError`), because the engine can be `ready` with one.
 */
function workerState(status: HostStatus): string {
	if (status.worker === "failed") return `failed: ${status.error ?? "unknown reason"}`;
	if (status.worker === "stopped") return "stopped";
	const engine = status.engine;
	if (!engine) return "starting";
	if (engine.phase !== "failed") return engine.phase;
	return engineError(status) === undefined ? "failed: unknown reason" : "failed";
}

/** Longest engine error shown; the rest is cut with `…`. */
const ERROR_LIMIT = 200;

/**
 * What the engine says went wrong, as one line: also set while it is `ready` (an unwritable state directory, a
 * failed save or journal read leave it serving from memory), so it is shown whatever the phase.
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

	// What was learned: the live engine's counts, else what the saved state says of itself.
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

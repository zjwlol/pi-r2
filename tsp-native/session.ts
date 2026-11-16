/**
 * The TSP native session: detection, the hello/DA1 probe, the stdin
 * reassembly shim, the prototype patches that swap pi's row renderer for the
 * native backend, the erase/alt-screen bookkeeping around the switch, and the
 * ANSI fallback. One instance per loaded extension; the process-wide registry
 * on `globalThis` holds the installed trampolines so `/reload` can hand a live
 * surface from the old instance to the new one.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { colorToHex, type Component, Container, StdinBuffer, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { type BackendHost, NativeBackend } from "./backend.ts";
import { describeComponent, describerFor, dispatchEvent, editorAutocompleteOverlay, releaseNativeSideEffects, resetStats, stats as describerStats } from "./describers.ts";
import { encodeTspHelloQuery, TSP_PREFIX, TspReader } from "./encode.ts";
import type { DescribeContext, NativeChild, NativeNode, NativeRegions } from "./node.ts";
import { col, EMPTY_NODE, node } from "./node.ts";
import { nativeComponentId } from "./reconcile.ts";
import { setThemeForSpans, spansTokenCount } from "./spans.ts";
import { transcriptBlocks } from "./transcript.ts";
import { TSP_VERSION, type TspEvent, type TspHello, type TspPalette, type TspText } from "./wire.ts";

type Any = Record<string, any>;

export const EXT_VERSION = "0.1.0";
export const APP_NAME = "pi";
/** Features this program applies when the terminal sends them. */
export const HELLO_FEATURES = ["edit", "undo", "send"] as const;

/** How long a hello waits for its reply through rmux/tmux, which answer DA1 themselves. */
const MUX_HELLO_TIMEOUT_MS = 1000;
/** Safety deadline elsewhere; the DA1 sentinel normally resolves far sooner. */
const HELLO_TIMEOUT_MS = 2000;
/** A partial APC/DA1 head held back this long without more bytes is released as keys. */
const PARTIAL_FLUSH_MS = 30;
/** A TSP message head without its terminator is dropped after this long (never leaked as keys). */
const PARTIAL_DROP_MS = 1500;
/** An orphaned session (its extension instance unloaded) reverts to ANSI after this long without a successor. */
const ORPHAN_MS = 4000;
/** rmux `pane_tsp_view` poll interval. */
const RMUX_POLL_MS = 2000;

/** Description roots that make a component a modal sheet of its own (omp hoists these into `layer`). */
const SHEET_KINDS: ReadonlySet<string> = new Set(["picker", "prefs", "overlay"]);
/** Describers whose components are never sheets (and whose fingerprints are not free to run twice a frame). */
const NOT_SHEETS: ReadonlySet<string> = new Set(["Editor", "Footer", "Container", "Text", "Markdown", "Spacer", "DynamicBorder", "Loader", "MouseRegion", "IdleStatus", "UserMessage", "AssistantMessage", "ToolExecution"]);
/** How deep under a dock component (through plain Containers: pi's editorContainer) a sheet is looked for. */
const SHEET_DEPTH = 3;

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

// ── Detection ───────────────────────────────────────────────────────────

export interface Detection {
	probe: boolean;
	reason: string;
	mux: boolean;
}

/** Whether to send a hello at all, and why. Never probes when nothing in the environment names a TSP path. */
export function detect(env: NodeJS.ProcessEnv = process.env): Detection {
	const override = env.PI_TUI_NATIVE;
	const program = env.TERM_PROGRAM?.toLowerCase();
	const mux = program === "rmux" || !!env.RMUX || !!env.TMUX;
	if (override === "0") return { probe: false, reason: "PI_TUI_NATIVE=0", mux };
	if (override === "1") return { probe: true, reason: "PI_TUI_NATIVE=1", mux };
	if (program === "tern") return { probe: true, reason: "TERM_PROGRAM=tern", mux };
	if (program === "rmux") return { probe: true, reason: "TERM_PROGRAM=rmux", mux };
	if (env.RMUX_TSP === "1") return { probe: true, reason: "RMUX_TSP=1", mux };
	return { probe: false, reason: "no TSP terminal in the environment (TERM_PROGRAM/RMUX_TSP/PI_TUI_NATIVE)", mux };
}

// ── Registry (process-wide trampolines) ──────────────────────────────────

interface Hooks {
	render(tui: Any): boolean;
	stop(tui: Any, options: Any): void;
	input(buffer: Any, data: string): string;
}

interface Patched {
	mainRender: (this: Any) => void;
	altRender: (this: Any) => void;
	baseProto: Any;
	baseStop: (this: Any, options?: Any) => void;
	stdinProcess: (this: Any, data: unknown) => void;
}

/** What a successor needs from an unloaded instance (duck-typed: the class comes from the old module). */
export interface OrphanHandle {
	readonly tui: Any | null;
	readonly terminal: Any | null;
	readonly hello: TspHello | null;
	readonly lastProbe: ProbeResult | null;
	readonly state: SessionState;
	/** Hand over the live backend (if any) and stop everything else; returns the surface to continue. */
	surrender(): { backend: NativeBackend | null; seq: number; surfaceCounter: number };
}

interface Registry {
	patched: Patched | null;
	active: Hooks | null;
	orphan: { session: OrphanHandle; timer: ReturnType<typeof setTimeout> } | null;
	/** `/tsp off` persists across reloads within the process. */
	userOff: boolean;
}

const REG_KEY = "__piExtendedTspNativeRegistry__";

export function registry(): Registry {
	const g = globalThis as Any;
	return (g[REG_KEY] ??= { patched: null, active: null, orphan: null, userOff: false } as Registry);
}

function protoWithOwn(start: Any, name: string): Any | undefined {
	for (let proto = start; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		if (Object.hasOwn(proto, name)) return proto;
	}
	return undefined;
}

/** Install the trampolines once per process; they delegate to `registry().active`. */
export function installPatches(): void {
	const reg = registry();
	if (reg.patched) return;
	const mainProto = TuiMainScreen.prototype as Any;
	const altProto = TuiAltScreen.prototype as Any;
	const baseProto = protoWithOwn(mainProto, "stop");
	if (!baseProto || typeof mainProto.doRender !== "function" || typeof altProto.doRender !== "function" || typeof (StdinBuffer.prototype as Any).process !== "function") {
		throw new Error("tsp-native: pi-tui internals changed (doRender/stop/StdinBuffer.process not found)");
	}
	const patched: Patched = {
		mainRender: mainProto.doRender,
		altRender: altProto.doRender,
		baseProto,
		baseStop: baseProto.stop,
		stdinProcess: (StdinBuffer.prototype as Any).process,
	};
	mainProto.doRender = function (this: Any): void {
		const h = reg.active;
		if (h && h.render(this)) return;
		patched.mainRender.call(this);
	};
	altProto.doRender = function (this: Any): void {
		const h = reg.active;
		if (h && h.render(this)) return;
		patched.altRender.call(this);
	};
	baseProto.stop = function (this: Any, options: Any = {}): void {
		const h = reg.active;
		if (h) {
			try {
				h.stop(this, options);
			} catch {
				// never block pi's own stop
			}
		}
		patched.baseStop.call(this, options);
	};
	(StdinBuffer.prototype as Any).process = function (this: Any, data: unknown): void {
		const h = reg.active;
		if (h && typeof data === "string" && data.length > 0) {
			const rest = h.input(this, data);
			if (rest.length === 0) return;
			patched.stdinProcess.call(this, rest);
			return;
		}
		patched.stdinProcess.call(this, data);
	};
	reg.patched = patched;
}

export function uninstallPatches(): void {
	const reg = registry();
	const p = reg.patched;
	if (!p) return;
	(TuiMainScreen.prototype as Any).doRender = p.mainRender;
	(TuiAltScreen.prototype as Any).doRender = p.altRender;
	p.baseProto.stop = p.baseStop;
	(StdinBuffer.prototype as Any).process = p.stdinProcess;
	reg.patched = null;
}

// ── Session ─────────────────────────────────────────────────────────────

export type SessionState = "idle" | "probing" | "live" | "ansi" | "closed";

interface ProbeRun {
	startedAt: number;
	timer: ReturnType<typeof setTimeout>;
	/** Hold rendering until the probe resolves (initial probe: nothing painted yet). */
	hold: boolean;
	/** What to do with a positive reply. */
	onNative: (hello: TspHello) => void;
	onAnsi: (reason: string) => void;
}

export interface ProbeResult {
	at: number;
	outcome: "native" | "ansi" | "skipped";
	reason: string;
	ms?: number;
}

export class TspSession {
	readonly detection: Detection;
	readonly hooks: Hooks;
	state: SessionState = "idle";
	/** User asked for ANSI (`/tsp off`) or an exception reverted us: no automatic re-probe. */
	disabled: string | null = null;
	tui: Any | null = null;
	terminal: Any | null = null;
	ctx: ExtensionContext | null = null;
	backend: NativeBackend | null = null;
	hello: TspHello | null = null;
	lastProbe: ProbeResult | null = null;
	#probe: ProbeRun | null = null;
	#reader = new TspReader();
	#input = new InputShim(this);
	#rmuxTimer: ReturnType<typeof setTimeout> | undefined;
	#rmuxView: string | undefined;
	#rmuxSeen = 0;
	#notified = false;
	#log: string[] = [];
	#logPath: string | undefined;
	#warnings = 0;
	#surfaceCounter = 0;
	#paletteCache: { theme: unknown; colors: unknown; palette: Omit<TspPalette, "sf"> } | null = null;
	#closed = false;
	#overlayNodes = new Map<Component, { key: string; node: NativeChild }>();

	constructor(detection = detect()) {
		this.detection = detection;
		if (registry().userOff) this.disabled = "/tsp off (kept across reload)";
		this.#logPath = process.env.PI_TSP_DEBUG ? (process.env.PI_TSP_DEBUG === "1" ? `/tmp/tsp-native-${process.pid}.log` : process.env.PI_TSP_DEBUG) : undefined;
		this.hooks = {
			render: (tui) => {
				try {
					return this.#onRender(tui);
				} catch (error) {
					this.fail(error);
					return false;
				}
			},
			stop: (tui, options) => this.#onStop(tui, options),
			input: (_buffer, data) => {
				try {
					return this.#input.filter(data);
				} catch (error) {
					this.fail(error);
					return data;
				}
			},
		};
		this.log(`session created: probe=${detection.probe} (${detection.reason}) mux=${detection.mux}`);
	}

	// ── Logging ───────────────────────────────────────────────────────

	log(message: string, data?: Record<string, unknown>): void {
		const line = `${new Date().toISOString()} ${message}${data ? ` ${safeJson(data)}` : ""}`;
		this.#log.push(line);
		if (this.#log.length > 200) this.#log.splice(0, this.#log.length - 200);
		if (this.#logPath) {
			try {
				fs.appendFileSync(this.#logPath, `${line}\n`);
			} catch {
				this.#logPath = undefined;
			}
		}
	}

	warn(message: string, data?: Record<string, unknown>): void {
		this.#warnings++;
		this.log(`WARN ${message}`, data);
	}

	recentLog(count = 20): string[] {
		return this.#log.slice(-count);
	}

	// ── Lifecycle ─────────────────────────────────────────────────────

	/** Become the process's active session (installing the trampolines). */
	activate(): void {
		installPatches();
		registry().active = this.hooks;
	}

	attachContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.#paletteCache = null;
		if (this.backend?.live) this.tui?.requestRender();
	}

	/** Hand everything to a successor (called by the new instance after a reload). */
	surrender(): { backend: NativeBackend | null; seq: number; surfaceCounter: number } {
		this.#cancelProbe();
		this.#stopRmuxPoll();
		this.#input.reset();
		this.#closed = true;
		const backend = this.backend;
		const seq = backend?.live ? backend.detach() : 0;
		return { backend: seq > 0 ? backend : null, seq, surfaceCounter: this.#surfaceCounter };
	}

	/** Continue the surface an unloaded instance left live (reload): same surface id, sequence continues. */
	takeOver(previous: OrphanHandle): void {
		this.tui = previous.tui;
		this.terminal = previous.terminal;
		this.hello = previous.hello;
		this.lastProbe = previous.lastProbe;
		const previousState = previous.state;
		const handed = previous.surrender();
		this.#surfaceCounter = handed.surfaceCounter;
		this.activate();
		if (handed.backend && handed.seq > 0 && this.hello) {
			this.backend = new NativeBackend(this.#host(), this.hello, handed.backend.surfaceId, { mirror: !!process.env.PI_TSP_MIRROR });
			this.state = "live";
			resetStats();
			try {
				this.backend.takeOver(handed.seq);
			} catch (error) {
				this.fail(error);
				return;
			}
			this.#startRmuxPoll();
			this.log("took over live surface", { surface: handed.backend.surfaceId, seq: handed.seq });
		} else {
			this.state = previousState === "live" ? "ansi" : "idle";
			this.log("took over without a live surface", { previous: previousState });
			if (this.tui && this.detection.probe && !this.disabled) this.#reprobe(false);
		}
	}

	/**
	 * The extension instance is going away. `reload`-like reasons keep the
	 * surface live for a successor (orphan); anything else tears down now.
	 */
	shutdown(reason: string): void {
		const reg = registry();
		if (reason !== "quit" && this.backend?.live && reg.active === this.hooks) {
			this.#stopRmuxPoll();
			if (reg.orphan) clearTimeout(reg.orphan.timer);
			const timer = setTimeout(() => {
				if ((reg.orphan?.session as unknown) !== this) return;
				reg.orphan = null;
				this.log("orphan expired: reverting to ANSI");
				this.dispose("orphan expired");
			}, ORPHAN_MS);
			timer.unref?.();
			reg.orphan = { session: this as OrphanHandle, timer };
			this.log("orphaned for a successor", { reason });
			return;
		}
		this.dispose(reason);
	}

	/** Full teardown: close the surface, restore ANSI, uninstall the trampolines and the input shim. Idempotent. */
	dispose(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#cancelProbe();
		this.#stopRmuxPoll();
		const reg = registry();
		if (reg.orphan && (reg.orphan.session as unknown) === this) {
			clearTimeout(reg.orphan.timer);
			reg.orphan = null;
		}
		const wasLive = this.backend?.live === true;
		if (wasLive) {
			try {
				this.backend!.stop(false);
			} catch {
				// terminal may be gone
			}
			releaseNativeSideEffects();
			this.#restoreScreen();
		}
		this.state = "closed";
		if (reg.active === this.hooks) {
			reg.active = null;
			uninstallPatches();
		}
		this.#input.reset();
		if (wasLive && this.tui && !(this.tui as Any).stopped) {
			try {
				this.tui.requestRender(true);
			} catch {
				// ignore
			}
		}
		this.log("disposed", { reason });
	}

	// ── Commands ──────────────────────────────────────────────────────

	/** `/tsp off`: back to ANSI now and stay there. */
	off(reason = "/tsp off"): void {
		this.disabled = reason;
		registry().userOff = true;
		this.#cancelProbe();
		this.#stopRmuxPoll();
		if (this.state === "live") this.#goAnsi(reason, false);
		else if (this.state === "probing") {
			this.state = "ansi";
			this.tui?.requestRender(true);
		} else this.state = this.state === "idle" ? "ansi" : this.state;
	}

	/** `/tsp on`: re-probe (also clears a disabled flag). */
	on(): string {
		this.disabled = null;
		registry().userOff = false;
		if (!this.tui) return "no TUI has rendered yet";
		if (this.state === "live") return "already native";
		this.#reprobe(false, true);
		return "probing…";
	}

	status(): string {
		const lines: string[] = [];
		lines.push(`tsp-native ${EXT_VERSION}: state=${this.state}${this.disabled ? ` (disabled: ${this.disabled})` : ""}`);
		lines.push(`detection: probe=${this.detection.probe} — ${this.detection.reason}${this.detection.mux ? " (multiplexer)" : ""}`);
		if (this.lastProbe) lines.push(`last probe: ${this.lastProbe.outcome} — ${this.lastProbe.reason}${this.lastProbe.ms !== undefined ? ` (${this.lastProbe.ms} ms)` : ""}`);
		if (this.hello) {
			const h = this.hello;
			lines.push(`terminal: ${h.term}${h.ver ? ` ${h.ver}` : ""} v${h.v} apc=${h.apc ?? "default"} credits=${h.credits ?? "default"} cols=${h.cols ?? "?"} dark=${h.dark ?? "?"} reduceMotion=${h.reduceMotion ?? false}`);
			lines.push(`kinds (${h.kinds.length}): ${h.kinds.join(" ")}`);
			lines.push(`features: ${(h.features ?? []).join(" ") || "(none)"}`);
		}
		if (this.backend) {
			const s = this.backend.stats();
			lines.push(`surface ${s.surface}: frames=${s.framesSent} ops=${s.opsSent} acks=${s.acksReceived} seq=${s.seq} acked=${s.acked} unacked=${s.unacked} dirty=${s.dirty} stallResets=${s.stallResets} bytesOut=${s.bytesOut} eventsIn=${s.eventsIn}${s.lastEvent ? ` last=${s.lastEvent}` : ""}`);
			lines.push(`mounted components=${s.mounted} rows fallback nodes (last frame)=${s.rowsFallback} surface width=${this.backend.context.cols}`);
			if (this.#modalRoots.length > 0) lines.push(`sheets up (layer, terminal focus kept only inside): ${this.#modalRoots.map((c) => c.constructor?.name ?? "?").join(" ")}`);
			if (s.terminalErrors.length > 0) lines.push(`terminal errors: ${s.terminalErrors.join(" | ")}`);
		}
		const native = [...describerStats.native.entries()].map(([k, v]) => `${k}×${v}`).join(" ");
		const rows = [...describerStats.rows.entries()].map(([k, v]) => `${k}×${v}`).join(" ");
		if (native) lines.push(`native describes: ${native}`);
		if (rows) lines.push(`rows fallbacks: ${rows}`);
		if (describerStats.failures.size > 0) lines.push(`describer failures: ${[...describerStats.failures.entries()].map(([k, v]) => `${k}: ${v}`).join(" | ")}`);
		if (this.#rmuxView) lines.push(`rmux pane_tsp_view: ${this.#rmuxView}`);
		if (this.#warnings) lines.push(`warnings: ${this.#warnings} (last: ${this.recentLog(3).join(" ⏎ ")})`);
		lines.push(`tui: ${this.tui ? this.tui.constructor.name : "none"} cols=${this.terminal?.columns ?? "?"} rows=${this.terminal?.rows ?? "?"}`);
		return lines.join("\n");
	}

	// ── Hooks ─────────────────────────────────────────────────────────

	#onRender(tui: Any): boolean {
		if (this.#closed || tui.stopped) return false;
		if (this.terminal && tui.terminal !== this.terminal) return false;
		if (!this.tui || this.tui !== tui) {
			const first = this.tui === null;
			this.tui = tui;
			this.terminal = tui.terminal;
			if (first) {
				const reg = registry();
				if (reg.orphan && (reg.orphan.session as unknown) !== this) {
					// A predecessor left a live surface for us.
					const previous = reg.orphan.session;
					clearTimeout(reg.orphan.timer);
					reg.orphan = null;
					this.takeOver(previous);
					return this.#onRender(tui);
				}
				if (this.state === "idle" && this.detection.probe && !this.disabled) this.#reprobe(true);
			}
		}
		// After a stop/start cycle (suspend, external editor, mode switch) the surface was closed: re-probe and adopt it.
		if (this.state === "ansi" && this.#resumeOnRender && !this.#probe && !this.disabled && this.detection.probe) {
			this.#resumeOnRender = false;
			this.#reprobe(true);
		}
		if (this.state === "probing") return this.#probe?.hold === true;
		if (this.state !== "live" || !this.backend) return false;
		try {
			this.backend.render();
		} catch (error) {
			this.fail(error);
		}
		return true;
	}

	#onStop(tui: Any, _options: Any): void {
		if (this.#closed || tui.terminal !== this.terminal) return;
		this.#cancelProbe();
		this.#stopRmuxPoll();
		if (this.state === "live" && this.backend?.live) {
			// Terminal handed back (quit, suspend, external editor, mode switch): keep the transcript, close live chrome.
			this.backend.stop(true);
			releaseNativeSideEffects();
			// A fullscreen TUI's own stop paths skip the alt screen (we already left it): nothing to restore here.
			this.state = "ansi";
			this.#pendingResume = true;
			this.#resumeOnRender = true;
			this.log("surface closed on TUI stop; will re-probe on the next render");
		} else if (this.state === "probing") {
			this.state = "ansi";
		}
	}

	/** The closed surface is adopted (not re-opened) by the next positive probe. */
	#pendingResume = false;
	/** After a stop/start cycle the next render re-probes. */
	#resumeOnRender = false;

	// ── Probe ─────────────────────────────────────────────────────────

	#reprobe(hold: boolean, manual = false): void {
		if (!this.tui || !this.terminal || this.#probe) return;
		if (!this.detection.probe && !manual) return;
		// A terminal that isn't reading input (stopped for exit) can't answer; a late DA1 reply would reach the shell.
		if ("inputHandler" in this.terminal && this.terminal.inputHandler === undefined) {
			this.log("probe skipped: terminal not started");
			return;
		}
		const terminal = this.terminal;
		const startedAt = Date.now();
		const timeout = this.detection.mux ? MUX_HELLO_TIMEOUT_MS : HELLO_TIMEOUT_MS;
		this.state = "probing";
		this.#input.probing = true;
		const finish = (outcome: "native" | "ansi", reason: string) => {
			this.lastProbe = { at: startedAt, outcome, reason, ms: Date.now() - startedAt };
			this.log(`probe ${outcome}: ${reason}`, { ms: Date.now() - startedAt });
		};
		this.#probe = {
			startedAt,
			hold,
			timer: setTimeout(() => this.#resolveProbe(null, `no hello reply within ${timeout} ms`), timeout),
			onNative: (hello) => {
				finish("native", `${hello.term}${hello.ver ? ` ${hello.ver}` : ""} answered`);
				this.#goNative(hello);
			},
			onAnsi: (reason) => {
				finish("ansi", reason);
				this.state = "ansi";
				this.#startRmuxPoll();
				if (hold || manual) this.tui?.requestRender(true);
			},
		};
		this.#probe.timer.unref?.();
		try {
			// The DA1 sentinel: a terminal that doesn't speak TSP answers it first. rmux orders a hello reply ahead of its own DA1.
			terminal.write(`${encodeTspHelloQuery(APP_NAME, HELLO_FEATURES, EXT_VERSION)}\x1b[c`);
			this.log("hello sent", { hold, manual, timeout });
		} catch (error) {
			this.#resolveProbe(null, `could not write the hello: ${String(error)}`);
		}
	}

	#cancelProbe(): void {
		if (!this.#probe) return;
		clearTimeout(this.#probe.timer);
		this.#probe = null;
		this.#input.probing = false;
	}

	#resolveProbe(hello: TspHello | null, reason: string): void {
		const probe = this.#probe;
		if (!probe) return;
		this.#cancelProbe();
		if (hello !== null && hello.v !== TSP_VERSION) {
			probe.onAnsi(`unsupported protocol version ${String(hello.v)}`);
			return;
		}
		if (hello === null) probe.onAnsi(reason);
		else probe.onNative(hello);
	}

	/** A complete TSP message from the terminal (replies and events). */
	onTspMessage(sequence: string): void {
		if (this.#closed) return;
		try {
			const decoded = this.#reader.feed(sequence);
			if (decoded?.verb === "r" && decoded.reply.r === "hello") {
				if (this.#probe) this.#resolveProbe(decoded.reply as TspHello, "hello reply");
				else this.log("late hello reply ignored");
				return;
			}
			if (this.backend) {
				this.backend.handleInput(sequence);
				return;
			}
			if (decoded) this.log(`message without a backend ignored: ${decoded.verb} ${safeJson(decoded.verb === "e" ? decoded.event : decoded.reply).slice(0, 120)}`);
		} catch (error) {
			this.fail(error);
		}
	}

	/** The DA1 sentinel answered while a probe is pending: the terminal doesn't speak TSP. */
	onDa1Sentinel(): boolean {
		if (!this.#probe) return false;
		this.#resolveProbe(null, "DA1 answered before a hello reply: the terminal, or a layer in between, dropped the APC query");
		return true;
	}

	// ── Switching ─────────────────────────────────────────────────────

	#goNative(hello: TspHello): void {
		if (!this.tui || !this.terminal) return;
		this.hello = hello;
		try {
			this.#eraseRows();
			resetStats();
			const adopt = this.#pendingResume && this.backend && new Set(hello.features ?? []).has("adopt");
			this.#pendingResume = false;
			if (adopt && this.backend) {
				this.backend.resume(hello);
				this.log("surface adopted", { surface: this.backend.surfaceId });
			} else {
				this.backend = new NativeBackend(this.#host(), hello, `pi:${process.pid.toString(36)}:${(++this.#surfaceCounter).toString(36)}`, {
					mirror: !!process.env.PI_TSP_MIRROR,
					failAfterFrames: process.env.PI_TSP_FAIL_BACKEND ? Number(process.env.PI_TSP_FAIL_BACKEND) : undefined,
				});
				this.backend.start();
				this.log("surface opened", { surface: this.backend.surfaceId, cols: hello.cols, kinds: hello.kinds.length });
			}
			this.state = "live";
			this.#startRmuxPoll();
		} catch (error) {
			this.fail(error);
		}
	}

	/** Leave native rendering: close the surface, hand the screen back to pi's row renderer. */
	#goAnsi(reason: string, keep: boolean): void {
		this.#cancelProbe();
		if (this.backend?.live) {
			try {
				this.backend.stop(keep);
			} catch (error) {
				this.warn("closing the surface failed", { error: String(error) });
			}
		}
		releaseNativeSideEffects();
		this.#restoreScreen();
		this.state = "ansi";
		this.log(`ANSI: ${reason}`);
		try {
			this.tui?.requestRender(true);
		} catch (error) {
			this.warn("requestRender failed", { error: String(error) });
		}
	}

	/** Any exception in the native path: ANSI for the rest of the session, one warning. */
	fail(error: unknown): void {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		this.warn("native rendering failed; reverting to ANSI", { error: message });
		this.disabled = `exception: ${error instanceof Error ? error.message : String(error)}`;
		this.#stopRmuxPoll();
		try {
			this.#goAnsi(this.disabled, false);
		} catch (inner) {
			// Last resort: make sure pi paints something.
			this.state = "ansi";
			this.backend = null;
			releaseNativeSideEffects();
			try {
				this.tui?.requestRender(true);
			} catch {
				// ignore
			}
			this.log(`fallback itself failed: ${String(inner)}`);
		}
		if (!this.#notified) {
			this.#notified = true;
			try {
				this.ctx?.ui.notify(`tsp-native: native rendering failed, back to ANSI (${error instanceof Error ? error.message : String(error)}). /tsp on to retry.`, "warning");
			} catch {
				// no UI
			}
		}
	}

	/** Erase whatever pi's row renderer painted so the surface opens where the rows began. */
	#eraseRows(): void {
		const tui: Any = this.tui!;
		const terminal = this.terminal!;
		const fullscreen = isAltScreenTui(tui);
		if (fullscreen) {
			if (tui.altScreenActive) {
				terminal.write(`\x1b[?2026h${tui.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${EXIT_ALT_SCREEN}\x1b[?2026l`);
				tui.altScreenActive = false;
			}
			tui.resetRenderState?.();
		} else {
			const prev: number = tui.previousLines?.length ?? 0;
			if (prev > 0) {
				const up = (tui.hardwareCursorRow ?? 0) - (tui.previousViewportTop ?? 0);
				let seq = "\x1b[?2026h";
				if (up > 0) seq += `\x1b[${up}A`;
				else if (up < 0) seq += `\x1b[${-up}B`;
				seq += "\r\x1b[J\x1b[?2026l";
				terminal.write(seq);
			}
			tui.resetRenderState?.();
		}
		terminal.hideCursor?.();
	}

	/** Back to rows: a fullscreen TUI re-enters the alternate screen; a regular one repaints from a cleared screen. */
	#restoreScreen(): void {
		const tui = this.tui;
		const terminal = this.terminal;
		if (!tui || !terminal || tui.stopped) return;
		if (tui.altScreenActive !== undefined && !tui.altScreenActive) {
			const term = process.env.TERM?.toLowerCase() ?? "";
			const mouseSequence = process.env.TMUX !== undefined || process.env.RMUX !== undefined || process.env.ZELLIJ !== undefined || process.env.STY !== undefined || term.startsWith("tmux") || term.startsWith("screen") ? ENABLE_BUTTON_MOTION_MOUSE : ENABLE_ALL_MOTION_MOUSE;
			terminal.write(`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${tui.mouseEnabled ? mouseSequence : ""}\x1b[2J\x1b[H\x1b[?25l`);
			tui.altScreenActive = true;
		}
		tui.resetRenderState?.();
	}

	// ── Backend host ──────────────────────────────────────────────────

	#host(): BackendHost {
		return {
			write: (data) => this.terminal!.write(data),
			columns: () => Math.max(1, Number(this.terminal?.columns ?? 80)),
			regions: (cx) => this.#regions(cx),
			focused: () => this.#focused(),
			requestRender: () => this.tui?.requestRender(),
			focusFromPointer: (owners) => {
				const target = owners.find((c) => typeof (c as Any).handleInput === "function");
				if (target && this.tui) this.tui.setFocus(target);
			},
			palette: () => this.#palette(),
			warn: (message, data) => this.warn(message, data),
			dispatch: (component, event, cx) => {
				try {
					dispatchEvent(component, event, cx);
				} catch (error) {
					this.warn("event handler failed", { type: event.type, error: String(error) });
				}
			},
			onTerminalEvent: (event) => this.#onTerminalEvent(event),
			resolver: {
				describe: (component, cx) => {
					// A container a sheet was hoisted out of describes without it (the sheet is in `layer`).
					const hoisted = this.#hoistedFrom.get(component);
					return hoisted ? this.#withoutSheets(component, hoisted) : describeComponent(component, cx);
				},
				rowsCols: (component, cx) => this.#rowsCols(component, cx),
				warn: (message, data) => this.warn(message, data),
			},
		};
	}

	#onTerminalEvent(event: TspEvent): void {
		switch (event.ev) {
			case "gone": {
				// Adopt found nothing: open a fresh surface.
				this.log("surface gone; opening a fresh one");
				if (this.hello && this.state === "live") {
					this.backend?.detach();
					this.backend = null;
					this.#pendingResume = false;
					this.#goNative(this.hello);
				}
				return;
			}
			case "theme":
			case "motion":
				this.#paletteCache = null;
				return;
			default:
				if (typeof event.ev === "string" && event.ev.startsWith("rmux-")) this.log(`rmux event ignored: ${safeJson(event)}`);
		}
	}

	#overlayWidths = new WeakMap<Component, number>();

	#rowsCols(component: Component, cx: DescribeContext): number | undefined {
		return this.#overlayWidths.get(component) ?? (cx.cols > 0 ? cx.cols : undefined);
	}

	/**
	 * `main` = the transcript's blocks: pi's document container (`tui.children[0]` in both TUI modes; fullscreen only
	 * adds a layout root over the same children) with its plain layout containers opened, so each chat entry is a
	 * direct child, as omp's blocks are. `dock` = everything else pi mounted, `layer` = visible overlays.
	 *
	 * Sheets (omp's docked-picker hoisting): a component pi mounted in the dock (a selector swapped into the editor
	 * slot) whose description root is a `picker`, `prefs` or `overlay` is its own modal sheet: it goes into `layer`
	 * as is, and the container it sits in describes without it for the frame. Overlay-stack components that are
	 * sheets (`nativeSheet(cx)`, or such a root) go in unwrapped too. While any sheet or modal overlay is up, the
	 * terminal's focus follows pi's only inside it (see {@link #focused}).
	 */
	#regions(cx: DescribeContext): NativeRegions {
		const tui = this.tui!;
		const children: Component[] = tui.children ?? [];
		const main = children.length > 0 ? transcriptBlocks(children[0]!) : [];
		const mounted = children.slice(1);
		// Before anything below is described: the editor then leaves its list out of the composer.
		const complete = editorAutocompleteOverlay(mounted);
		const sheets: Component[] = [];
		const hoistedFrom = new Map<Component, readonly Component[]>();
		const dock: Component[] = [];
		for (const component of mounted) {
			if (this.#isSheet(component, cx)) {
				sheets.push(component);
				continue;
			}
			this.#findSheets(component, cx, sheets, hoistedFrom, 1);
			dock.push(component);
		}
		this.#hoistedFrom = hoistedFrom;
		const layer: NativeChild[] = [...sheets];
		const modal: Component[] = [...sheets];
		const stack: Any[] = tui.overlayStack ?? [];
		const live = new Set<Component>();
		for (const entry of stack) {
			let visible = true;
			try {
				visible = typeof tui.isOverlayVisible === "function" ? tui.isOverlayVisible(entry) : !entry.hidden;
			} catch {
				visible = !entry.hidden;
			}
			if (!visible) continue;
			const component: Component = entry.component;
			if (live.has(component) || sheets.includes(component)) continue;
			live.add(component);
			const child = this.#overlayNode(component, entry.options, cx, tui.focusedComponent === component);
			if (child === component || (child as NativeNode).p?.modal === true) modal.push(component);
			layer.push(child);
		}
		for (const key of this.#overlayNodes.keys()) if (!live.has(key)) this.#overlayNodes.delete(key);
		if (complete) layer.push(complete);
		this.#modalRoots = modal;
		return { main, dock, layer };
	}

	/** Containers a sheet was hoisted out of this frame, with the hoisted children. */
	#hoistedFrom = new Map<Component, readonly Component[]>();
	/** Sheets and modal overlays up this frame (outermost components). */
	#modalRoots: readonly Component[] = [];
	/** A hoisting container's description without its sheets, kept while its other children stay the same. */
	#stripped = new WeakMap<Component, { rest: readonly Component[]; node: NativeNode }>();

	/** Whether `component` describes as a sheet: a `picker`, `prefs` or `overlay` root (or says so: `nativeSheet`). */
	#isSheet(component: Component, cx: DescribeContext): boolean {
		const a = component as Any;
		if (typeof a.nativeSheet === "function") {
			try {
				if (a.nativeSheet(cx) === true) return true;
			} catch {
				// not a sheet
			}
		}
		const by = describerFor(component);
		const own = typeof a.describe === "function" && !isPlainContainer(component);
		// The editor and other chrome are never sheets; don't run their fingerprints twice a frame.
		if (by ? NOT_SHEETS.has(by.name) : !own) return false;
		const described = describeComponent(component, cx);
		return described !== null && SHEET_KINDS.has(described.k);
	}

	/** Sheets mounted inside `container` through plain Containers (pi's editorContainer holds a selector). */
	#findSheets(container: Component, cx: DescribeContext, sheets: Component[], hoistedFrom: Map<Component, readonly Component[]>, depth: number): void {
		if (depth > SHEET_DEPTH || !isPlainContainer(container)) return;
		const kids: Component[] = (container as Any).children;
		let hoisted: Component[] | undefined;
		for (const kid of kids) {
			if (!kid || typeof kid.render !== "function") continue;
			if (this.#isSheet(kid, cx)) {
				if (sheets.includes(kid)) continue;
				sheets.push(kid);
				(hoisted ??= []).push(kid);
			} else this.#findSheets(kid, cx, sheets, hoistedFrom, depth + 1);
		}
		if (hoisted) hoistedFrom.set(container, hoisted);
	}

	#withoutSheets(container: Component, hoisted: readonly Component[]): NativeNode {
		const kids: Component[] = (container as Any).children ?? [];
		const rest = kids.filter((kid) => !hoisted.includes(kid));
		const memo = this.#stripped.get(container);
		if (memo && memo.rest.length === rest.length && memo.rest.every((kid, i) => kid === rest[i])) return memo.node;
		const described = rest.length === 0 ? EMPTY_NODE : col(rest);
		this.#stripped.set(container, { rest, node: described });
		return described;
	}

	/**
	 * The component whose first `editor`/`input` the terminal focuses: pi's focused one, unless a sheet or modal
	 * overlay is up and it lies outside every one of them (then none: the terminal keeps no field, keys reach pi).
	 */
	#focused(): Component | null {
		const focused = (this.tui?.focusedComponent as Component | null | undefined) ?? null;
		if (!focused || this.#modalRoots.length === 0) return focused;
		for (const root of this.#modalRoots) if (root === focused || contains(root, focused)) return focused;
		return null;
	}

	#overlayNode(component: Component, options: Any | undefined, cx: DescribeContext, focused: boolean): NativeChild {
		const cols = Math.max(1, cx.cols);
		let width = cols;
		try {
			const layout = typeof this.tui!.resolveOverlayLayout === "function" ? this.tui!.resolveOverlayLayout(options ?? {}, 0, cols, Math.max(1, Number(this.terminal?.rows ?? 24))) : undefined;
			if (layout && typeof layout.width === "number" && layout.width > 0) width = Math.min(cols, layout.width);
		} catch {
			// use the surface width
		}
		this.#overlayWidths.set(component, width);
		// A component describing its own sheet (a picker, prefs or overlay root) goes in unwrapped (omp backend.ts).
		if (this.#isSheet(component, cx)) return component;
		const own = overlaySpec((component as Any).nativeOverlay);
		const anchor = own.anchor ?? (options?.anchor?.startsWith?.("top") ? "top" : options?.anchor?.startsWith?.("bottom") ? "bottom" : "center");
		const fraction = width / cols;
		const size = own.size ?? (options?.fullscreen ? "full" : fraction >= 0.75 ? "lg" : fraction >= 0.45 ? "md" : "sm");
		const modal = focused || options?.fullscreen === true || options?.nonCapturing !== true;
		const role = own.role ?? "omp.overlay";
		const key = `${JSON.stringify(anchor)}|${size}|${modal}|${width}|${role}|${JSON.stringify(own.head ?? null)}`;
		const cached = this.#overlayNodes.get(component);
		if (cached?.key === key) return cached.node;
		const wrapper = node("overlay", { anchor, size, modal, role, ...(own.head !== undefined ? { head: own.head } : {}) }, [component], `ov-${nativeComponentId(component)}`);
		this.#overlayNodes.set(component, { key, node: wrapper });
		return wrapper;
	}

	#palette(): Omit<TspPalette, "sf"> | undefined {
		const theme = this.ctx?.ui.theme as Any | undefined;
		if (!theme) return undefined;
		let colors: Any;
		try {
			colors = theme.colors;
		} catch {
			return undefined;
		}
		if (this.#paletteCache && this.#paletteCache.theme === theme && this.#paletteCache.colors === colors) return this.#paletteCache.palette;
		setThemeForSpans(theme);
		this.log("theme palette rebuilt", { tokens: Object.keys(colors).length, spanTokens: spansTokenCount(), appearance: theme.appearance, name: theme.name });
		const variant: Record<string, string> = {};
		for (const key of Object.keys(colors)) {
			try {
				variant[key] = colorToHex(colors[key]);
			} catch {
				// skip tokens that aren't colors
			}
		}
		const dark = theme.appearance !== "light";
		const palette: Omit<TspPalette, "sf"> = dark ? { dark: variant, name: { dark: theme.name ?? "pi" } } : { light: variant, name: { light: theme.name ?? "pi" } };
		this.#paletteCache = { theme, colors, palette };
		return palette;
	}

	// ── rmux view polling ─────────────────────────────────────────────

	#startRmuxPoll(): void {
		if (this.#rmuxTimer || this.#closed || this.disabled) return;
		const socket = process.env.RMUX?.split(",")[0];
		const pane = process.env.RMUX_PANE;
		if (!socket || !pane || !/^%\d+$/.test(pane)) return;
		const tick = () => {
			this.#rmuxTimer = undefined;
			if (this.#closed || this.disabled) return;
			execFile("rmux", ["-N", "-S", socket, "display-message", "-p", "-t", pane, "#{pane_tsp_view}"], { timeout: 3000 }, (error, stdout) => {
				if (this.#closed || this.disabled) return;
				if (!error) this.#onRmuxView(stdout.trim());
				else this.log(`rmux poll failed: ${String(error).slice(0, 120)}`);
				if (!this.#closed && !this.disabled) {
					this.#rmuxTimer = setTimeout(tick, RMUX_POLL_MS);
					this.#rmuxTimer.unref?.();
				}
			});
		};
		this.#rmuxTimer = setTimeout(tick, RMUX_POLL_MS);
		this.#rmuxTimer.unref?.();
	}

	#stopRmuxPoll(): void {
		if (this.#rmuxTimer) clearTimeout(this.#rmuxTimer);
		this.#rmuxTimer = undefined;
		this.#rmuxSeen = 0;
	}

	/** rmux's desired renderer for the pane's viewers; act after two consistent readings. */
	#onRmuxView(view: string): void {
		if (this.#logPath) this.log(`rmux poll: ${view} (state=${this.state})`);
		if (view !== this.#rmuxView) {
			this.#rmuxView = view;
			this.#rmuxSeen = 0;
		}
		// Going native is cheap and reversible: act on the first reading; leaving native repaints everything: wait for two.
		const seen = ++this.#rmuxSeen;
		// A failed re-probe (no reply) while rmux still says native retries every fifth reading (~10 s).
		if (view === "native" ? seen !== 1 && seen % 5 !== 0 : seen !== 2) return;
		if (view === "native" && this.state === "ansi" && !this.#probe) {
			this.log("rmux view is native again: re-probing");
			this.#pendingResume = this.backend !== null;
			this.#reprobe(false);
		} else if (view === "ansi" && this.state === "live") {
			this.log("rmux view is ansi (a plain viewer is in use): back to rows");
			this.#goAnsi("rmux viewer cannot show the surface", true);
			this.#pendingResume = true;
		}
	}
}

// ── Input shim ──────────────────────────────────────────────────────────

const DA1_PATTERN = /\x1b\[\?[\d;]*c/;
const DA1_PREFIX = /\x1b(\[(\?[\d;]*)?)?$/;

/**
 * Sits in front of pi's StdinBuffer: reassembles `ESC _ tsp;… ESC \` messages
 * across chunks (so a split reply never reaches the editor as keys), and
 * swallows the DA1 sentinel while a probe is pending.
 */
export class InputShim {
	#session: TspSession;
	#pending = "";
	#timer: ReturnType<typeof setTimeout> | undefined;
	#pendingSince = 0;
	probing = false;

	constructor(session: TspSession) {
		this.#session = session;
	}

	reset(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#pending = "";
	}

	/** Returns the bytes pi should see; TSP messages and the sentinel are consumed. */
	filter(data: string): string {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		let buf = this.#pending + data;
		this.#pending = "";
		let out = "";
		for (;;) {
			const start = buf.indexOf(TSP_PREFIX);
			if (start === -1) {
				// A tail that could begin a TSP message (or the DA1 sentinel while probing) waits for the next chunk.
				const hold = this.#partialTail(buf);
				out += buf.slice(0, buf.length - hold.length);
				this.#pending = hold;
				break;
			}
			out += buf.slice(0, start);
			// The body is JSON (every control character escaped): the next ESC is either the ST or an
			// interruption by another sequence, which aborts the message (as oh-my-pi's reader does).
			const esc = buf.indexOf("\x1b", start + TSP_PREFIX.length);
			if (esc === -1) {
				this.#pending = buf.slice(start);
				break;
			}
			if (buf[esc + 1] === undefined) {
				this.#pending = buf.slice(start);
				break;
			}
			if (buf[esc + 1] !== "\\") {
				this.#session.warn("TSP message interrupted by another escape sequence; dropped", { length: esc - start });
				buf = buf.slice(esc);
				continue;
			}
			const message = buf.slice(start, esc + 2);
			buf = buf.slice(esc + 2);
			this.#session.onTspMessage(message);
		}
		if (this.probing && out.length > 0) out = this.#consumeSentinel(out);
		if (this.#pending.length > 0) {
			const headComplete = this.#pending.startsWith(TSP_PREFIX);
			if (!headComplete) this.#pendingSince = Date.now();
			else if (this.#pendingSince === 0) this.#pendingSince = Date.now();
			this.#timer = setTimeout(() => this.#flushPending(headComplete), headComplete ? PARTIAL_DROP_MS : PARTIAL_FLUSH_MS);
			this.#timer.unref?.();
		} else this.#pendingSince = 0;
		return out;
	}

	#partialTail(buf: string): string {
		const max = Math.min(buf.length, TSP_PREFIX.length - 1);
		for (let n = max; n > 0; n--) {
			if (TSP_PREFIX.startsWith(buf.slice(buf.length - n))) return buf.slice(buf.length - n);
		}
		if (this.probing) {
			const m = DA1_PREFIX.exec(buf);
			if (m && m[0].length < 12) return m[0];
		}
		return "";
	}

	/** While a probe is pending, the first DA1 reply pi isn't waiting for itself resolves it negatively. */
	#consumeSentinel(out: string): string {
		const terminal = this.#session.terminal as Any | null;
		const tui = this.#session.tui as Any | null;
		// pi's own DA1 queries (kitty keyboard negotiation, colour probes) are answered first; the next reply is ours.
		let owed: number = (terminal?.pendingKeyboardProtocolDeviceAttributes ?? 0) + (tui?.pendingTerminalColorQueries?.length ?? 0);
		let at = 0;
		for (;;) {
			const rest = out.slice(at);
			const match = DA1_PATTERN.exec(rest);
			if (!match) return out;
			const index = at + match.index;
			if (owed > 0) {
				owed--;
				at = index + match[0].length;
				continue;
			}
			this.#session.onDa1Sentinel();
			return out.slice(0, index) + out.slice(index + match[0].length);
		}
	}

	#flushPending(headComplete: boolean): void {
		this.#timer = undefined;
		const pending = this.#pending;
		this.#pending = "";
		this.#pendingSince = 0;
		if (pending.length === 0) return;
		if (headComplete) {
			this.#session.warn("dropped an unterminated TSP message", { length: pending.length });
			return;
		}
		// Not a TSP head after all (a lone Escape, a DA1 fragment): hand it to pi.
		const buffer = (this.#session.terminal as Any | null)?.stdinBuffer;
		const original = registry().patched?.stdinProcess;
		if (buffer && original) original.call(buffer, pending);
	}
}

/** An exact pi-tui `Container` (selectors and blocks extend it: those are components of their own). */
function isPlainContainer(c: Component): boolean {
	const ctor = (c as Any).constructor;
	return (ctor === Container || ctor?.name === "Container") && Array.isArray((c as Any).children);
}

/** Whether `target` is `root` or mounted under it (`children` arrays, a `child`), a few levels deep. */
function contains(root: Component, target: Component): boolean {
	const seen = new Set<unknown>();
	const visit = (c: unknown, depth: number): boolean => {
		if (!c || typeof c !== "object" || depth > 8 || seen.has(c)) return false;
		seen.add(c);
		if (c === target) return true;
		const a = c as Any;
		if (Array.isArray(a.children)) for (const kid of a.children) if (visit(kid, depth + 1)) return true;
		return a.child !== undefined && visit(a.child, depth + 1);
	};
	return visit(root, 0);
}

/** What an overlay component asks of its `overlay` wrapper (omp's `nativeOverlay`). */
interface OverlaySpec {
	anchor?: "center" | "top" | "bottom" | { node: string; side: "above" | "below" } | { caret: string };
	size?: "sm" | "md" | "lg" | "full";
	role?: string;
	head?: TspText;
}

function overlaySpec(value: unknown): OverlaySpec {
	if (!value || typeof value !== "object") return {};
	const v = value as Any;
	const out: OverlaySpec = {};
	if (v.anchor === "center" || v.anchor === "top" || v.anchor === "bottom") out.anchor = v.anchor;
	else if (v.anchor && typeof v.anchor === "object" && (typeof v.anchor.caret === "string" || typeof v.anchor.node === "string")) out.anchor = v.anchor;
	if (v.size === "sm" || v.size === "md" || v.size === "lg" || v.size === "full") out.size = v.size;
	if (typeof v.role === "string" && v.role !== "") out.role = v.role;
	if (typeof v.head === "string" || Array.isArray(v.head)) out.head = v.head as TspText;
	return out;
}

function isAltScreenTui(tui: Any): boolean {
	return tui instanceof TuiAltScreen || tui.altScreenActive !== undefined;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

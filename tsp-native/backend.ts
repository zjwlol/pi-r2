/**
 * Native (TSP) backend: owns the inline surface, sends reconciled frames under
 * credit-based flow control, uploads image blobs, and routes terminal events
 * back to components. Ported (trimmed: no screen surfaces, no `q blobs`
 * query) from oh-my-pi `native/backend.ts`.
 *
 * Flow control: at most `credits` frames per surface are unacknowledged. A
 * render while blocked only marks the surface dirty; the next `ack` reconciles
 * once against the last sent state, so intermediate changes coalesce.
 *
 * Blobs: the bytes of every `image` node's `p.blob` (registered in
 * `shared/tsp-blobs.ts`) reach the terminal once per connection, as a `b`
 * message written right before the first frame that references the id. A new
 * connection (a new backend, `start`, `resume`, `takeOver`) resends instead of
 * asking which blobs the terminal kept; rsttyd ignores a `b` for an id it
 * already holds. Blobs are not frames: they take no credit and are never held
 * back by flow control (only sent alongside a frame that is).
 */
import * as fs from "node:fs";
import type { Component } from "@earendil-works/pi-tui";
import { getTspBlob, type TspBlob } from "../shared/tsp-blobs.ts";
import { collectBlobIds, encodeTspBlob, MAX_BLOB_BYTES } from "./blobs.ts";
import { TspDocument } from "./doc.ts";
import { encodeTspJson, splitTspMessage, TspReader } from "./encode.ts";
import type { DescribeContext, NativeRegions, NativeUiEvent } from "./node.ts";
import { Reconciler, type Resolver } from "./reconcile.ts";
import { TSP_DEFAULT_APC_LIMIT, TSP_DEFAULT_CREDITS, type TspEvent, type TspFrame, type TspHello, type TspKind, type TspNode, type TspOp, type TspPalette } from "./wire.ts";

export interface BackendHost {
	write(data: string): void;
	/** `main`/`dock`/`layer` content for this frame. */
	regions(cx: DescribeContext): NativeRegions;
	focused(): Component | null;
	requestRender(): void;
	/** The user clicked into a node described by `owners[0]` (then its containers): move keyboard focus. */
	focusFromPointer(owners: readonly Component[]): void;
	/** Current theme palette (without `sf`), or undefined when unknown. */
	palette(): Omit<TspPalette, "sf"> | undefined;
	/** Width in cells when the terminal didn't say. */
	columns(): number;
	/** Terminal-level events the backend doesn't route (theme, motion, visible, gone, unknown). */
	onTerminalEvent?(event: TspEvent): void;
	warn(message: string, data?: Record<string, unknown>): void;
	/** Route a UI event to the component that described the node. */
	dispatch(component: Component, event: NativeUiEvent, cx: DescribeContext): void;
	resolver: Resolver;
}

export interface BackendOptions {
	/** Keep a reference document and recent frames (debug). */
	mirror?: boolean;
	/** Append every TSP message to this JSONL file (defaults to `PI_TSP_RECORD`). */
	recordPath?: string;
	title?: string;
	role?: string;
	/** Throw inside render after this many frames (test hook: `PI_TSP_FAIL_BACKEND=<n>`). */
	failAfterFrames?: number;
}

const RECENT_FRAMES = 32;
const STALLED_ACK_MS = 5000;
const SESSION_ROLE = "omp.session";

export class NativeContext implements DescribeContext {
	cols: number;
	reduceMotion: boolean;
	dark: boolean;
	hour12: boolean | undefined;
	#kinds: ReadonlySet<string>;
	#features: ReadonlySet<string>;

	constructor(hello: TspHello, cols: number) {
		this.cols = cols;
		this.reduceMotion = hello.reduceMotion === true;
		this.dark = hello.dark !== false;
		this.hour12 = hello.hour12;
		this.#kinds = new Set(hello.kinds);
		this.#features = new Set(hello.features ?? []);
	}

	supports(kind: TspKind): boolean {
		return this.#kinds.has(kind);
	}

	feature(name: string): boolean {
		return this.#features.has(name);
	}
}

export interface BackendStats {
	surface: string;
	seq: number;
	acked: number;
	unacked: number;
	framesSent: number;
	acksReceived: number;
	opsSent: number;
	stallResets: number;
	dirty: boolean;
	rowsFallback: number;
	mounted: number;
	terminalErrors: string[];
	bytesOut: number;
	/** `b` messages written on this connection, and their decoded size. */
	blobsSent: number;
	blobBytes: number;
	eventsIn: number;
	lastEvent?: string;
}

export class NativeBackend {
	#host: BackendHost;
	#hello: TspHello;
	#cx: NativeContext;
	#limit: number;
	#credits: number;
	#reader = new TspReader();
	#surfaceId: string;
	#reconciler: Reconciler;
	#doc: TspDocument | null;
	#seq = 0;
	#acked = 0;
	#unacked: number[] = [];
	#stalledSince: number | undefined;
	#stallResets = 0;
	#stallTimer: ReturnType<typeof setTimeout> | undefined;
	#focus: string | null = null;
	#dirty = false;
	#live = false;
	#sawResize = false;
	#framesSent = 0;
	#acks = 0;
	#opsSent = 0;
	#bytesOut = 0;
	#eventsIn = 0;
	#lastEvent: string | undefined;
	#terminalErrors: string[] = [];
	#recent: TspFrame[] = [];
	#paletteSent: string | undefined;
	/** Blob ids delivered on this connection; cleared whenever the terminal may no longer hold them. */
	#blobsSent = new Set<string>();
	/** Blob ids already warned about (unregistered or too large), so each warns once per backend. */
	#blobsWarned = new Set<string>();
	#blobCount = 0;
	#blobBytes = 0;
	#recordPath: string | undefined;
	#options: BackendOptions;

	constructor(host: BackendHost, hello: TspHello, surfaceId: string, options: BackendOptions = {}) {
		this.#host = host;
		this.#hello = hello;
		this.#options = options;
		this.#limit = hello.apc !== undefined && hello.apc > 0 ? hello.apc : TSP_DEFAULT_APC_LIMIT;
		this.#credits = hello.credits !== undefined && hello.credits > 0 ? hello.credits : TSP_DEFAULT_CREDITS;
		this.#cx = new NativeContext(hello, hello.cols ?? host.columns());
		this.#surfaceId = surfaceId;
		this.#reconciler = new Reconciler(surfaceId, host.resolver);
		this.#doc = options.mirror ? new TspDocument(surfaceId) : null;
		this.#recordPath = options.recordPath ?? (process.env.PI_TSP_RECORD || undefined);
	}

	get hello(): TspHello {
		return this.#hello;
	}

	get context(): DescribeContext {
		return this.#cx;
	}

	get live(): boolean {
		return this.#live;
	}

	get surfaceId(): string {
		return this.#surfaceId;
	}

	get reconciler(): Reconciler {
		return this.#reconciler;
	}

	stats(): BackendStats {
		return {
			surface: this.#surfaceId,
			seq: this.#seq,
			acked: this.#acked,
			unacked: this.#unacked.length,
			framesSent: this.#framesSent,
			acksReceived: this.#acks,
			opsSent: this.#opsSent,
			stallResets: this.#stallResets,
			dirty: this.#dirty,
			rowsFallback: this.#reconciler.fallbackCount,
			mounted: this.#reconciler.mounted,
			terminalErrors: this.#terminalErrors.slice(-5),
			bytesOut: this.#bytesOut,
			blobsSent: this.#blobCount,
			blobBytes: this.#blobBytes,
			eventsIn: this.#eventsIn,
			lastEvent: this.#lastEvent,
		};
	}

	/** Open the inline surface, send the palette and the first frame. */
	start(): void {
		if (this.#live) return;
		this.#live = true;
		this.#blobsSent.clear();
		this.#write("o", { id: this.#surfaceId, mode: "inline", title: this.#options.title ?? "pi", role: this.#options.role ?? SESSION_ROLE });
		this.#sendPalette(true);
		this.render();
	}

	/**
	 * Adopt the surface another backend (an earlier extension instance) left
	 * open: no `o`, the sequence continues from `seq`, and the first frame
	 * rebuilds the regions in place.
	 */
	takeOver(seq: number): void {
		if (this.#live) return;
		this.#live = true;
		this.#seq = seq;
		this.#acked = seq;
		// What the previous instance delivered is unknown here: the rebuilt regions resend their blobs.
		this.#blobsSent.clear();
		this.#reconciler.resetRegions();
		this.#sendPalette(true);
		this.render();
	}

	/**
	 * Re-open a surface closed with `keep:true` (adopt): the terminal kept
	 * `main`; the next frame re-adds `dock`/`layer`. A `gone` reply opens a
	 * fresh surface instead.
	 */
	resume(hello: TspHello): void {
		if (this.#live) return;
		this.#hello = hello;
		this.#limit = hello.apc !== undefined && hello.apc > 0 ? hello.apc : TSP_DEFAULT_APC_LIMIT;
		this.#credits = hello.credits !== undefined && hello.credits > 0 ? hello.credits : TSP_DEFAULT_CREDITS;
		this.#cx = new NativeContext(hello, hello.cols ?? this.#host.columns());
		this.#sawResize = false;
		this.#live = true;
		this.#reconciler.detachLive();
		this.#unacked = [];
		this.#acked = this.#seq;
		this.#stalledSince = undefined;
		this.#focus = null;
		this.#dirty = false;
		this.#blobsSent.clear();
		this.#write("o", { id: this.#surfaceId, mode: "inline", title: this.#options.title ?? "pi", role: this.#options.role ?? SESSION_ROLE, adopt: true });
		this.#sendPalette(true);
		this.render();
	}

	/** Close the surface. `keep` leaves `main` in scrollback. */
	stop(keep = true): void {
		if (!this.#live) return;
		this.#live = false;
		this.#write("x", { id: this.#surfaceId, keep });
		if (keep) this.#doc?.close();
		this.#blobsSent.clear();
		this.#clearStallTimer();
	}

	/** Forget the surface without closing it (another backend takes it over). */
	detach(): number {
		this.#live = false;
		this.#clearStallTimer();
		return this.#seq;
	}

	noteTerminalColumns(columns: number): void {
		if (this.#sawResize || columns === this.#cx.cols) return;
		this.#cx.cols = columns;
		this.#host.requestRender();
	}

	/** Reconcile and send a frame, unless the surface is out of credits. */
	render(): void {
		if (!this.#live) return;
		this.#sendPalette(false);
		const regions = this.#host.regions(this.#cx);
		if (!this.#hasCredit()) {
			this.#dirty = true;
			this.#armStallTimer();
			return;
		}
		this.#dirty = false;
		const ops = this.#reconciler.reconcile(regions, this.#cx);
		const focused = this.#host.focused();
		const focus = focused ? this.#reconciler.focusTarget(focused) : null;
		if (focus !== this.#focus) {
			ops.push(["focus", focus]);
			this.#focus = focus;
		}
		if (ops.length === 0) return;
		if (this.#options.failAfterFrames !== undefined && this.#framesSent >= this.#options.failAfterFrames) {
			throw new Error(`forced backend failure after ${this.#framesSent} frames (PI_TSP_FAIL_BACKEND)`);
		}
		this.#deliverBlobs(ops);
		this.#sendFrame(ops);
	}

	/** Handle one complete `ESC _ tsp;…` input string. Returns false when it isn't TSP. */
	handleInput(sequence: string): boolean {
		const raw = splitTspMessage(sequence);
		if (!raw) return false;
		this.#record("in", raw.verb, raw.params, raw.body);
		const message = this.#reader.feed(sequence);
		if (message?.verb === "e") {
			this.#eventsIn++;
			this.#lastEvent = String(message.event.ev);
			this.#handleEvent(message.event);
		}
		return true;
	}

	document(): TspNode | undefined {
		return this.#doc?.snapshot();
	}

	recentFrames(count = RECENT_FRAMES): readonly TspFrame[] {
		return this.#recent.slice(-count);
	}

	#sendPalette(force: boolean): void {
		const palette = this.#host.palette();
		if (!palette || (!palette.dark && !palette.light)) return;
		const serialized = JSON.stringify(palette);
		if (!force && serialized === this.#paletteSent) return;
		this.#paletteSent = serialized;
		this.#write("t", { sf: this.#surfaceId, ...palette });
	}

	#hasCredit(): boolean {
		if (this.#unacked.length < this.#credits) return true;
		const oldest = this.#unacked[0]!;
		if (Date.now() - oldest < STALLED_ACK_MS) return false;
		if (this.#stalledSince === undefined) {
			this.#stalledSince = oldest;
			this.#host.warn("terminal stopped acknowledging frames; resuming without credits", { s: this.#seq, acked: this.#acked });
		}
		this.#stallResets++;
		this.#unacked = [];
		this.#acked = this.#seq;
		return true;
	}

	#armStallTimer(): void {
		if (this.#stallTimer) return;
		const delay = Math.max(0, this.#unacked[0]! + STALLED_ACK_MS - Date.now());
		this.#stallTimer = setTimeout(() => {
			this.#stallTimer = undefined;
			this.#host.requestRender();
		}, delay);
		this.#stallTimer.unref?.();
	}

	#clearStallTimer(): void {
		if (this.#stallTimer) clearTimeout(this.#stallTimer);
		this.#stallTimer = undefined;
	}

	#sendFrame(ops: readonly TspOp[]): void {
		this.#seq++;
		this.#unacked.push(Date.now());
		const frame: TspFrame = { sf: this.#surfaceId, s: this.#seq, ops };
		this.#framesSent++;
		this.#opsSent += ops.length;
		if (this.#doc) {
			const errors = this.#doc.applyFrame(frame);
			if (errors.length > 0) this.#host.warn("reference document rejected ops", { errors });
			this.#recent.push(frame);
			if (this.#recent.length > RECENT_FRAMES) this.#recent.splice(0, this.#recent.length - RECENT_FRAMES);
		}
		this.#write("f", frame);
	}

	/**
	 * Write a `b` for every blob `ops` reference that this connection hasn't
	 * delivered yet, ahead of their frame. Nothing when the terminal doesn't
	 * draw `image` nodes. An id missing from the registry is skipped (warned
	 * once) and retried the next time an op references it.
	 */
	#deliverBlobs(ops: readonly TspOp[]): void {
		if (!this.#cx.supports("image")) return;
		let ids: Set<string> | undefined;
		for (const op of ops) {
			if (op[0] !== "add" && op[0] !== "set") continue;
			collectBlobIds(op, (ids ??= new Set()));
		}
		if (!ids) return;
		for (const id of ids) {
			if (this.#blobsSent.has(id)) continue;
			const blob = getTspBlob(id);
			if (!blob) {
				this.#warnBlob(id, "image references an unregistered blob; not sent");
				continue;
			}
			if (blob.bytes.byteLength > MAX_BLOB_BYTES) {
				// The terminal would reject it after the whole body crossed the pty.
				this.#blobsSent.add(id);
				this.#warnBlob(id, "image blob too large for the terminal; not sent", { bytes: blob.bytes.byteLength, max: MAX_BLOB_BYTES });
				continue;
			}
			this.#sendBlob(blob);
		}
	}

	#sendBlob(blob: TspBlob): void {
		this.#blobsSent.add(blob.id);
		const { params, body, encoded } = encodeTspBlob(blob, this.#limit);
		// The full body, so a replay of the recording shows the image.
		this.#record("out", "b", params, body);
		this.#blobCount++;
		this.#blobBytes += blob.bytes.byteLength;
		this.#bytesOut += encoded.length;
		this.#host.write(encoded);
	}

	#warnBlob(id: string, message: string, data?: Record<string, unknown>): void {
		if (this.#blobsWarned.has(id)) return;
		this.#blobsWarned.add(id);
		this.#host.warn(message, { id, ...data });
	}

	#write(verb: "o" | "f" | "t" | "x" | "q", body: unknown): void {
		this.#record("out", verb, undefined, body);
		const encoded = encodeTspJson(verb, body, undefined, this.#limit);
		this.#bytesOut += encoded.length;
		this.#host.write(encoded);
	}

	#record(dir: "in" | "out", verb: string, params: Readonly<Record<string, string>> | undefined, body: unknown): void {
		const path = this.#recordPath;
		if (!path) return;
		let payload = body;
		if (dir === "in" && typeof body === "string") {
			try {
				payload = JSON.parse(body);
			} catch {
				payload = body;
			}
		}
		try {
			fs.appendFileSync(path, `${JSON.stringify({ t: Date.now(), dir, verb, params, body: payload })}\n`);
		} catch (error) {
			this.#host.warn("recording failed; disabling", { path, error: String(error) });
			this.#recordPath = undefined;
		}
	}

	#handleEvent(event: TspEvent): void {
		switch (event.ev) {
			case "ack": {
				const e = event as Extract<TspEvent, { ev: "ack" }>;
				if (e.sf !== this.#surfaceId || e.s <= this.#acked) return;
				this.#acks++;
				const newly = Math.min(e.s, this.#seq) - this.#acked;
				this.#acked = Math.min(e.s, this.#seq);
				this.#unacked.splice(0, newly);
				if (this.#stalledSince !== undefined) {
					this.#stalledSince = undefined;
					this.#stallResets = 0;
				}
				this.#clearStallTimer();
				if (this.#dirty) this.#host.requestRender();
				return;
			}
			case "resize": {
				const e = event as Extract<TspEvent, { ev: "resize" }>;
				this.#sawResize = true;
				if (e.cols === this.#cx.cols) return;
				this.#cx.cols = e.cols;
				this.#host.requestRender();
				return;
			}
			case "theme": {
				this.#cx.dark = (event as Extract<TspEvent, { ev: "theme" }>).dark;
				this.#host.onTerminalEvent?.(event);
				return;
			}
			case "motion": {
				this.#cx.reduceMotion = (event as Extract<TspEvent, { ev: "motion" }>).reduce;
				this.#host.onTerminalEvent?.(event);
				this.#host.requestRender();
				return;
			}
			case "error": {
				const e = event as Extract<TspEvent, { ev: "error" }>;
				// Errors for a surface this backend doesn't own (one we replaced after `gone`) are noise.
				if (e.sf !== undefined && e.sf !== this.#surfaceId) return;
				this.#terminalErrors.push(`s=${e.s ?? "?"} op=${e.op ?? "?"}: ${e.msg}`);
				if (this.#terminalErrors.length > 20) this.#terminalErrors.splice(0, this.#terminalErrors.length - 20);
				this.#host.warn("terminal reported an error", event as unknown as Record<string, unknown>);
				return;
			}
			case "gone": {
				const e = event as Extract<TspEvent, { ev: "gone" }>;
				if (e.ids.includes(this.#surfaceId)) {
					this.#host.onTerminalEvent?.(event);
					return;
				}
				this.#reconciler.forget(e.ids);
				return;
			}
			case "toggle":
			case "select":
			case "activate":
			case "action":
			case "change":
			case "edit":
			case "undo":
			case "send":
				this.#routeUiEvent(event as never);
				return;
			case "focus": {
				const e = event as Extract<TspEvent, { ev: "focus" }>;
				const owners = this.#reconciler.owners(e.id);
				if (owners.length === 0) return;
				this.#host.focusFromPointer(owners);
				this.#host.requestRender();
				return;
			}
			default:
				this.#host.onTerminalEvent?.(event);
		}
	}

	#routeUiEvent(event: Extract<TspEvent, { ev: "toggle" | "select" | "activate" | "action" | "change" | "edit" | "undo" | "send" }>): void {
		if (event.sf !== this.#surfaceId) return;
		const target = this.#reconciler.target(event.id);
		if (!target) return;
		if (event.ev === "send" && (!this.#live || this.#reconciler.focusTarget(target.component) !== event.id)) return;
		const item = (id: string): string => (id.startsWith(`${event.id}/`) || id.startsWith(`${event.id}.`) || !id.includes(".") ? this.#reconciler.itemKey(id) : id);
		let ui: NativeUiEvent;
		switch (event.ev) {
			case "toggle":
				ui = { type: "toggle", key: target.keypath, collapsed: event.collapsed };
				break;
			case "select":
				ui = { type: "select", key: target.keypath, item: item(event.item) };
				break;
			case "activate":
				ui = { type: "activate", key: target.keypath, item: item(event.item) };
				break;
			case "action":
				ui = { type: "action", key: target.keypath, act: event.act, value: event.value, mods: event.mods ?? [] };
				break;
			case "change":
				ui = { type: "change", key: target.keypath, item: event.item, value: event.value };
				break;
			case "edit": {
				const { from, to, text, cursor, len } = event;
				ui = { type: "edit", key: target.keypath, from, to, text, cursor, len };
				break;
			}
			case "undo":
				ui = { type: "undo", key: target.keypath };
				break;
			case "send":
				ui = { type: "send", key: target.keypath, text: event.text };
				break;
		}
		this.#host.dispatch(target.component, ui, this.#cx);
		this.#host.requestRender();
	}
}

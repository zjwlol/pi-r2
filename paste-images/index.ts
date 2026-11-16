/**
 * paste-images
 *
 * When a pasted/dropped image file path lands in the prompt editor (rsttyd
 * uploads a pasted image to `~/.local/state/rsttyd-uploads/paste-*.png` and
 * inserts that path; pi's own Ctrl+V writes a temp file and inserts its path;
 * terminals insert dropped files' paths), the path becomes an `[Image #N]`
 * token and a thumbnail band above the prompt shows the draft's images. On
 * submit every token's file is attached to the user message as image content
 * (the marker stays in the text). Deleting a token drops its image.
 *
 * Tokenising watches the editor text: a 150 ms poll (unref'd) plus a check
 * right after each raw terminal input, so it covers ANSI pastes and TSP
 * native edits (which never pass through terminal input) alike. Only paths
 * that arrived whole since the last look (a paste, drop or completion; not
 * typed character by character) are rewritten, and undoing a rewrite is
 * respected. Any image path pasted too late for the poll is tokenised at
 * submit.
 *
 * Detection: absolute, `~/` or `file://` paths ending in
 * .png/.jpg/.jpeg/.gif/.webp, optionally quoted or backslash-escaped, that
 * name a readable image file of at most 20 MB (checked by magic bytes).
 * Models without image input get the original paths back, with a warning.
 *
 * TSP native (tsp-native): the band's chips also go to tsp-native's composer
 * as an attachment provider (shared/composer-slots.ts, key "paste-images"),
 * which shows them inside its chat bar; while it does, the widget describes
 * as a hidden col.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type ComposerAttachmentProvider, composerAttachments, setComposerAttachments } from "../shared/composer-slots.ts";
import { type DescribeCx, ImageBand } from "./band.ts";
import { Draft } from "./draft.ts";

const WIDGET = "paste-images";
/** This extension's key among the composer's attachment providers. */
const SLOT = "paste-images";
const POLL_MS = 150;

/** The parts of pi-tui's Editor (private members included) a rewrite touches. Duck-typed: MagicEditor etc. qualify. */
interface EditorLike {
	getText(): string;
	getExpandedText?(): string;
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	onChange?: (text: string) => void;
	lastAction?: unknown;
	preferredVisualCol?: unknown;
	/** ≥ 0 while Up/Down browse the prompt history. */
	historyIndex?: number;
	pushUndoSnapshot?(): void;
	exitHistoryBrowsing?(): void;
	cancelAutocomplete?(): void;
}

function asEditor(component: unknown): EditorLike | undefined {
	const c = component as Partial<EditorLike> | null | undefined;
	if (!c || typeof c.getText !== "function") return undefined;
	const state = c.state;
	if (!state || !Array.isArray(state.lines) || typeof state.cursorLine !== "number" || typeof state.cursorCol !== "number") return undefined;
	return c as EditorLike;
}

/**
 * The TUI's focused component. The exported `TUI` interface doesn't declare
 * it; the runtime class (`TuiBase`) has a public `getFocusedComponent()` over
 * a private `focusedComponent` field, so read either, duck-typed.
 */
function focusedOf(tui: TUI | undefined): unknown {
	const t = tui as unknown as { getFocusedComponent?: () => unknown; focusedComponent?: unknown } | undefined;
	if (!t) return undefined;
	return typeof t.getFocusedComponent === "function" ? t.getFocusedComponent() : t.focusedComponent;
}

function cursorOffset(editor: EditorLike): number {
	const { lines, cursorLine, cursorCol } = editor.state;
	let offset = 0;
	for (let i = 0; i < cursorLine && i < lines.length; i++) offset += (lines[i]?.length ?? 0) + 1;
	return offset + cursorCol;
}

/** Replace the editor's text in place (one undo step), keeping the cursor at `cursor`. */
function writeEditor(editor: EditorLike, text: string, cursor: number): void {
	editor.cancelAutocomplete?.();
	editor.exitHistoryBrowsing?.();
	editor.pushUndoSnapshot?.();
	const lines = text.split("\n");
	let line = 0;
	let col = Math.min(Math.max(0, cursor), text.length);
	while (line < lines.length - 1 && col > lines[line]!.length) col -= lines[line++]!.length + 1;
	editor.state.lines = lines;
	editor.state.cursorLine = line;
	editor.state.cursorCol = Math.min(col, lines[line]!.length);
	editor.lastAction = null;
	editor.preferredVisualCol = null;
	editor.onChange?.(text);
}

/** The parts of tsp-native's DescribeContext the chips read, when `cx` has them. */
function asDescribeCx(cx: unknown): DescribeCx | undefined {
	const c = cx as Partial<DescribeCx> | null | undefined;
	return c && typeof c.supports === "function" ? (c as DescribeCx) : undefined;
}

export default function (pi: ExtensionAPI) {
	const draft = new Draft();
	let ui: ExtensionUIContext | undefined;
	let tui: TUI | undefined;
	let band: ImageBand | undefined;
	/** The chips row for tsp-native's composer: the band's, null while it shows nothing. */
	const provider: ComposerAttachmentProvider = {
		describe: (cx) => {
			const describeCx = asDescribeCx(cx);
			return band && describeCx ? band.chips(describeCx) : null;
		},
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let checkQueued = false;
	/** The last non-empty editor text seen: what a submitted prompt is compared with (the editor is cleared by then). */
	let lastSeen = "";

	const editorText = (): string | undefined => {
		try {
			return ui?.getEditorText();
		} catch {
			return undefined;
		}
	};

	const refreshBand = () => {
		band?.sync(draft.shown);
		tui?.requestRender();
	};

	/**
	 * The editor text to work on: the focused main editor's own text (collapsed
	 * `[paste #n …]` markers kept, so a rewrite in place leaves them alone) when
	 * it is the editor pi reports, else pi's expanded text (rewritten through
	 * setEditorText).
	 */
	const observe = (): { text: string; editor?: EditorLike } | undefined => {
		const expanded = editorText();
		if (expanded === undefined) return undefined;
		const editor = asEditor(focusedOf(tui));
		if (editor) {
			try {
				const raw = editor.getText();
				if ((editor.getExpandedText?.() ?? raw) === expanded) return { text: raw, editor };
			} catch {
				// not an editor after all
			}
		}
		return { text: expanded };
	};

	/** Look at the editor text: tokenise newly arrived image paths, then sync the band. */
	const check = () => {
		if (!ui) return;
		const seen = observe();
		if (!seen || seen.text === draft.snapshot) return;
		const { text, editor } = seen;
		const prev = draft.snapshot;
		draft.snapshot = text;
		// A recalled history entry isn't a paste: leave it as it was sent.
		const browsing = editor !== undefined && typeof editor.historyIndex === "number" && editor.historyIndex >= 0;
		const rewrite = browsing ? null : draft.tokenise(prev, text, editor ? cursorOffset(editor) : undefined);
		if (rewrite) {
			try {
				if (editor && rewrite.cursor !== undefined) writeEditor(editor, rewrite.text, rewrite.cursor);
				else ui.setEditorText(rewrite.text);
				draft.snapshot = rewrite.text;
			} catch {
				// Editor gone mid-rewrite: the next look starts over from whatever is there.
			}
		}
		if (draft.snapshot !== "") lastSeen = draft.snapshot;
		if (draft.updateShown(draft.snapshot) || rewrite) refreshBand();
	};

	const queueCheck = () => {
		if (checkQueued) return;
		checkQueued = true;
		// After the focused component has applied this input, before the frame it requested.
		process.nextTick(() => {
			checkQueued = false;
			check();
		});
	};

	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		// Only our own registration: a reloaded copy may already have taken the slot.
		if (composerAttachments().includes(provider)) setComposerAttachments(SLOT, undefined);
		draft.reset();
		lastSeen = "";
		band?.dispose();
		if (band && ui) {
			try {
				ui.setWidget(WIDGET, undefined);
			} catch {
				// UI already torn down
			}
		}
		band = undefined;
		tui = undefined;
		ui = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		ui = ctx.ui;
		const theme = () => ctx.ui.theme;
		ctx.ui.setWidget(
			WIDGET,
			(t) => {
				tui = t;
				const created = new ImageBand(theme);
				created.sync(draft.shown);
				band = created;
				return created;
			},
			{ placement: "aboveEditor" },
		);
		setComposerAttachments(SLOT, provider);
		// Whatever the editor already holds (a restored draft) isn't a paste.
		draft.snapshot = observe()?.text ?? "";
		lastSeen = draft.snapshot;
		unsubscribeInput = ctx.ui.onTerminalInput(() => {
			queueCheck();
			return undefined;
		});
		timer = setInterval(check, POLL_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", async () => {
		stop();
	});

	pi.on("input", async (event, ctx) => {
		// Only prompts typed into this editor carry its tokens (RPC / extension messages have no draft).
		if (!ui || event.source !== "interactive") return;
		const plan = draft.prepareSubmit(event.text, {
			vision: supportsImages(ctx),
			// The editor is already cleared; what it last held tells which paths were pasted since the last look.
			prev: lastSeen.trim(),
		});
		draft.prune(observe()?.text ?? "");
		lastSeen = draft.snapshot;
		refreshBand();
		if (!plan) return;
		if (plan.missing.length > 0) {
			const names = plan.missing.map((e) => e.name).join(", ");
			ctx.ui.notify(`paste-images: couldn't read ${names}; sent the path${plan.missing.length > 1 ? "s" : ""} as text`, "warning");
		}
		if (plan.withheld.length > 0) {
			const model = ctx.model ? ctx.model.name || ctx.model.id : "the current model";
			const count = plan.withheld.length;
			ctx.ui.notify(`paste-images: ${model} has no image input; sent ${count} image path${count > 1 ? "s" : ""} as text`, "warning");
		}
		if (plan.text === event.text && plan.images.length === 0) return;
		return { action: "transform", text: plan.text, images: [...(event.images ?? []), ...plan.images] };
	});
}

/** Whether the current model takes image input (unknown model: assume yes and let pi decide). */
function supportsImages(ctx: ExtensionContext): boolean {
	return ctx.model ? ctx.model.input.includes("image") : true;
}

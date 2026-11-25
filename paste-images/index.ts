import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { type ComposerAttachmentProvider, composerAttachments, setComposerAttachments } from "../shared/composer-slots.ts";
import { type DraftImageResolver, getDraftImageResolver, setDraftImageResolver } from "../shared/draft-images.ts";
import { type DescribeCx, ImageBand } from "./band.ts";
import { Draft } from "./draft.ts";

const WIDGET = "paste-images";
const SLOT = "paste-images";
const POLL_MS = 150;
const SOURCE_NOTICE = "paste-images.source";

function sourceNotice(n: number, path: string): string {
	return [
		`The user attached an image as \`[Image #${n}]\` in their visible message.`,
		`Source path: \`${path}\``,
		`The attached image is stored in this file on disk. Use the source path directly with file tools (for example \`read ${path}\`) when you need the file itself — to inspect, copy, or upload it.`,
	].join("\n\n");
}

interface EditorLike {
	getText(): string;
	getExpandedText?(): string;
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	onChange?: (text: string) => void;
	lastAction?: unknown;
	preferredVisualCol?: unknown;
	/**
	 * Pi uses a negative index outside history browsing.
	 */
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
 * Pi exposes the focused component at runtime but not in its TUI type.
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

function asDescribeCx(cx: unknown): DescribeCx | undefined {
	const c = cx as Partial<DescribeCx> | null | undefined;
	return c && typeof c.supports === "function" ? (c as DescribeCx) : undefined;
}

export default function (pi: ExtensionAPI) {
	const draft = new Draft();
	let ui: ExtensionUIContext | undefined;
	let tui: TUI | undefined;
	let band: ImageBand | undefined;
	const provider: ComposerAttachmentProvider = {
		describe: (cx) => {
			const describeCx = asDescribeCx(cx);
			return band && describeCx ? band.chips(describeCx) : null;
		},
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let checkQueued = false;
	/**
	 * Pi clears the editor before emitting `input`.
	 */
	let lastSeen = "";
	/**
	 * Pi passes the same image objects into `before_agent_start`.
	 */
	let pendingNotices = new WeakMap<ImageContent, string>();
	let session: ExtensionContext | undefined;

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
	 * Pi's expanded text does not preserve collapsed paste markers.
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
			}
		}
		return { text: expanded };
	};

	const check = () => {
		if (!ui) return;
		const seen = observe();
		if (!seen || seen.text === draft.snapshot) return;
		const { text, editor } = seen;
		const prev = draft.snapshot;
		draft.snapshot = text;
		const browsing = editor !== undefined && typeof editor.historyIndex === "number" && editor.historyIndex >= 0;
		const rewrite = browsing ? null : draft.tokenise(prev, text, editor ? cursorOffset(editor) : undefined);
		if (rewrite) {
			try {
				if (editor && rewrite.cursor !== undefined) writeEditor(editor, rewrite.text, rewrite.cursor);
				else ui.setEditorText(rewrite.text);
				draft.snapshot = rewrite.text;
			} catch {
				// The next check can pick up a replacement editor.
			}
		}
		if (draft.snapshot !== "") lastSeen = draft.snapshot;
		if (draft.updateShown(draft.snapshot) || rewrite) refreshBand();
	};

	const queueCheck = () => {
		if (checkQueued) return;
		checkQueued = true;
		// Check after pi handles the input and before the next render.
		process.nextTick(() => {
			checkQueued = false;
			check();
		});
	};

	/**
	 * Pi dispatches extension commands without emitting `input`.
	 */
	const resolver: DraftImageResolver = (text, { vision, scope }) => {
		if (!ui) return undefined;
		const detached = scope === "detached";
		const plan = detached
			? new Draft().prepareSubmit(text, { vision, prev: "" })
			: draft.prepareSubmit(text, { vision, prev: lastSeen.trim() });
		if (!detached) {
			draft.prune(observe()?.text ?? "");
			lastSeen = draft.snapshot;
			refreshBand();
		}
		if (!plan) return undefined;
		try {
			if (plan.missing.length > 0) {
				const names = plan.missing.map((e) => e.name).join(", ");
				ui.notify(`paste-images: couldn't read ${names}; sent the path${plan.missing.length > 1 ? "s" : ""} as text`, "warning");
			}
			if (plan.withheld.length > 0) {
				const current = session?.model;
				const model = current ? current.name || current.id : "the current model";
				const count = plan.withheld.length;
				ui.notify(`paste-images: ${model} has no image input; sent ${count} image path${count > 1 ? "s" : ""} as text`, "warning");
			}
		} catch {
			// Notification failures must not discard the submission plan.
		}
		if (plan.text === text && plan.images.length === 0) return undefined;
		return { text: plan.text, images: plan.images };
	};

	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		// A reloaded copy may already own the registration.
		if (composerAttachments().includes(provider)) setComposerAttachments(SLOT, undefined);
		if (getDraftImageResolver() === resolver) setDraftImageResolver(undefined);
		session = undefined;
		draft.reset();
		lastSeen = "";
		pendingNotices = new WeakMap();
		band?.dispose();
		if (band && ui) {
			try {
				ui.setWidget(WIDGET, undefined);
			} catch {
				// Pi may already have torn down the UI.
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
		draft.snapshot = observe()?.text ?? "";
		lastSeen = draft.snapshot;
		unsubscribeInput = ctx.ui.onTerminalInput(() => {
			queueCheck();
			return undefined;
		});
		// Native editor updates bypass terminal input.
		timer = setInterval(check, POLL_MS);
		timer.unref?.();
		session = ctx;
		setDraftImageResolver(resolver);
	});

	pi.on("session_shutdown", async () => {
		stop();
	});

	pi.on("input", async (event, ctx) => {
		if (!ui || event.source !== "interactive") return;
		const plan = draft.prepareSubmit(event.text, {
			vision: supportsImages(ctx),
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
		// Pi skips `before_agent_start` for steers and follow-ups.
		if (!event.streamingBehavior) {
			plan.attached.forEach((entry, i) => {
				const image = plan.images[i];
				if (image && existsSync(entry.path)) pendingNotices.set(image, sourceNotice(entry.n, entry.path));
			});
		}
		if (plan.text === event.text && plan.images.length === 0) return;
		return { action: "transform", text: plan.text, images: [...(event.images ?? []), ...plan.images] };
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user" || !event.images) return;
		const notices: string[] = [];
		for (const image of event.images) {
			const notice = pendingNotices.get(image);
			if (notice === undefined) continue;
			pendingNotices.delete(image);
			notices.push(notice);
		}
		if (notices.length === 0) return;
		return { message: { customType: SOURCE_NOTICE, content: notices.join("\n\n"), display: false } };
	});
}

function supportsImages(ctx: ExtensionContext): boolean {
	return ctx.model ? ctx.model.input.includes("image") : true;
}

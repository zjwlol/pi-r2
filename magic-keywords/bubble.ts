/**
 * Glow magic keywords in sent user messages (static gradient), like oh-my-pi's
 * message bubbles.
 *
 * Built-in user messages are rendered by UserMessageComponent, which
 * extensions can't replace, so its render() is wrapped on the shared
 * prototype (once per process). Behavior is delegated to a hook on globalThis
 * that each extension runtime installs/clears, so /reload picks up new code.
 * Any failure falls back to the original rendering.
 */
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { findKeywords } from "./keywords.ts";
import { type PaintOptions, paintLines } from "./paint.ts";

export interface BubbleHook {
	paintOptions(): PaintOptions;
}

const HOOK = Symbol.for("pi-extended.magic-keywords.bubble-hook");
const PATCHED = Symbol.for("pi-extended.magic-keywords.bubble-patched");

type GlobalWithHook = typeof globalThis & { [HOOK]?: BubbleHook };

export function setBubbleHook(hook: BubbleHook | undefined): void {
	(globalThis as GlobalWithHook)[HOOK] = hook;
}

export function patchUserMessages(): boolean {
	const proto = (UserMessageComponent as unknown as { prototype?: Record<PropertyKey, unknown> } | undefined)
		?.prototype;
	if (!proto) return false;
	if (proto[PATCHED]) return true;
	const origRender = proto.render;
	if (typeof origRender !== "function") return false;

	proto.render = function (this: { text?: unknown }, width: number): string[] {
		const lines: string[] = origRender.call(this, width);
		const hook = (globalThis as GlobalWithHook)[HOOK];
		if (!hook || typeof this.text !== "string") return lines;
		try {
			const keywords = findKeywords(this.text);
			if (keywords.length === 0) return lines;
			return paintLines(lines, this.text, keywords, hook.paintOptions());
		} catch {
			return lines;
		}
	};
	proto[PATCHED] = true;
	return true;
}

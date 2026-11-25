import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type ExtensionContext, ThinkingSelectorComponent } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function availableThinkingLevels(model: ExtensionContext["model"]): ModelThinkingLevel[] {
	return model ? getSupportedThinkingLevels(model) : [...THINKING_LEVELS];
}

interface EffortOptions {
	currentLevel: ModelThinkingLevel;
	setLevel: (level: ModelThinkingLevel) => void;
	argument?: string;
	overlay?: boolean;
}

function pickEffort(ctx: ExtensionContext, currentLevel: ModelThinkingLevel, overlay = false): Promise<ModelThinkingLevel | undefined> {
	const levels = availableThinkingLevels(ctx.model);

	return ctx.ui.custom<ModelThinkingLevel | undefined>(
		(_tui, _theme, _keys, done) => new ThinkingSelectorComponent(currentLevel, levels, done, () => done(undefined), done),
		{ overlay },
	);
}

export async function changeEffort(ctx: ExtensionContext, options: EffortOptions): Promise<void> {
	const ui = ctx.ui;
	try {
		let requested = options.argument?.trim();
		if (!requested) {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ui.notify("The thinking level picker requires the interactive TUI. Use /effort <level>.", "info");
				return;
			}

			requested = await pickEffort(ctx, options.currentLevel, options.overlay);
			if (requested === undefined) return;
		}

		// The model can change while the picker is open.
		const levels = availableThinkingLevels(ctx.model);
		const normalized = requested.toLowerCase();
		const level = levels.find((candidate) => candidate === normalized);
		if (level !== undefined) {
			options.setLevel(level);
			ui.notify(`Thinking level: ${level}`, "info");
		} else {
			ui.notify(`Unknown thinking level "${requested}". Available levels: ${levels.join(", ")}.`, "error");
		}
	} catch (error) {
		ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

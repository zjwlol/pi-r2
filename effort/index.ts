import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { availableThinkingLevels, changeEffort } from "../shared/effort.ts";

export default function (pi: ExtensionAPI) {
	let context: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
	});
	pi.on("session_shutdown", () => {
		context = undefined;
	});

	pi.registerCommand("effort", {
		description: "Set thinking level",
		getArgumentCompletions: (prefix) => {
			const levels = fuzzyFilter(availableThinkingLevels(context?.model), prefix, (level) => level);

			return levels.length > 0 ? levels.map((level) => ({ value: level, label: level })) : null;
		},
		handler: (args, ctx) => changeEffort(ctx, { currentLevel: pi.getThinkingLevel(), setLevel: pi.setThinkingLevel, argument: args }),
	});
}

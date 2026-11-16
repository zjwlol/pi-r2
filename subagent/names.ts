/**
 * Memorable two-word agent ids, AdjectiveNoun CamelCase (e.g. "SwiftFalcon", "CalmPanda"),
 * same shape as oh-my-pi's task name generator (smaller dictionary).
 */

const ADJECTIVES = [
	"able", "agile", "amber", "ancient", "arctic", "azure", "bold", "brave", "breezy", "bright",
	"brisk", "calm", "candid", "careful", "cheerful", "clever", "cobalt", "cosmic", "crimson", "crisp",
	"curious", "daring", "dapper", "deft", "eager", "early", "earnest", "electric", "elegant", "emerald",
	"epic", "fancy", "fearless", "fierce", "fluent", "focused", "frank", "fresh", "friendly", "frosty",
	"gentle", "gilded", "glad", "golden", "graceful", "grand", "happy", "hardy", "hasty", "honest",
	"humble", "icy", "ideal", "jolly", "keen", "kind", "lively", "loyal", "lucid", "lucky",
	"lunar", "magic", "mellow", "merry", "mighty", "misty", "modest", "neat", "nimble", "noble",
	"patient", "plucky", "polite", "proud", "quick", "quiet", "rapid", "ready", "regal", "rustic",
	"sage", "scarlet", "serene", "sharp", "shiny", "silent", "silver", "sleek", "smart", "snowy",
	"solar", "sonic", "spry", "steady", "stellar", "stoic", "sturdy", "sunny", "swift", "tidy",
	"tranquil", "trusty", "upbeat", "valiant", "vivid", "warm", "wise", "witty", "zany", "zealous",
];

const NOUNS = [
	"albatross", "alpaca", "badger", "beaver", "bison", "bobcat", "buffalo", "camel", "caracal", "cheetah",
	"chipmunk", "cobra", "condor", "cougar", "coyote", "crane", "dingo", "dolphin", "dove", "eagle",
	"egret", "elk", "emu", "falcon", "ferret", "finch", "flamingo", "fox", "gazelle", "gecko",
	"gibbon", "giraffe", "gopher", "grouse", "gull", "hare", "hawk", "hedgehog", "heron", "hippo",
	"ibex", "ibis", "iguana", "impala", "jackal", "jaguar", "jay", "kestrel", "kiwi", "koala",
	"lemur", "leopard", "lion", "llama", "lobster", "lynx", "macaw", "magpie", "mammoth", "manatee",
	"marmot", "marten", "meerkat", "mink", "mole", "moose", "narwhal", "newt", "ocelot", "octopus",
	"orca", "osprey", "otter", "owl", "panda", "panther", "parrot", "pelican", "penguin", "puffin",
	"puma", "quail", "rabbit", "raccoon", "raven", "robin", "salmon", "seal", "shark", "sparrow",
	"squid", "stork", "swan", "tapir", "tiger", "toucan", "turtle", "walrus", "weasel", "wolf",
	"wombat", "wren", "yak", "zebra",
];

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Generate an AdjNoun id for which `taken(id)` is false. */
export function generateTaskName(taken: (id: string) => boolean): string {
	for (let attempt = 0; attempt < 64; attempt++) {
		const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
		const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
		const name = `${capitalize(adj)}${capitalize(noun)}`;
		if (!taken(name)) return name;
	}
	for (const adj of ADJECTIVES) {
		for (const noun of NOUNS) {
			const name = `${capitalize(adj)}${capitalize(noun)}`;
			if (!taken(name)) return name;
		}
	}
	for (let n = 0; ; n++) if (!taken(`Task${n}`)) return `Task${n}`;
}

/** Agent id from a caller-supplied label: keeps `[A-Za-z0-9_-]`, max 32 chars; `undefined` when nothing survives. */
export function sanitizeAgentId(value: string | undefined): string | undefined {
	const sanitized = value
		?.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "")
		.slice(0, 32);
	return sanitized || undefined;
}

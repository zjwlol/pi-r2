import { CURSOR_MARKER, type Component } from "@earendil-works/pi-tui";
import { type DescribeContext, isComponent, type NativeChild, type NativeNode, type NativeRegions } from "./node.ts";
import { TSP_TEXT_KINDS, type TspKind, type TspNode, type TspOp } from "./wire.ts";

/**
 * These escapes must match pi's fake cursor markers.
 */
const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";

export interface NativeTarget {
	readonly component: Component;
	readonly keypath: string;
}

export interface Resolver {
	describe(component: Component, cx: DescribeContext): NativeNode | null;
	rowsCols?(component: Component, cx: DescribeContext): number | undefined;
	warn?(message: string, data?: Record<string, unknown>): void;
}

const kNativeId = Symbol.for("pi-tsp-native.id");

interface IdTagged {
	[kNativeId]?: string;
}

const REGION_IDS = ["main", "dock", "layer"] as const;
type RegionId = (typeof REGION_IDS)[number];
const RESERVED_IDS: ReadonlySet<string> = new Set(REGION_IDS);
const TEXT_KINDS: ReadonlySet<string> = new Set(TSP_TEXT_KINDS);
/**
 * Component IDs must stay unique across extension reloads.
 */
const kNextId = "__piTspNativeNextComponentId__";

export function nativeComponentId(component: Component): string {
	const tagged = component as IdTagged;
	let id = tagged[kNativeId];
	if (id === undefined) {
		const g = globalThis as Record<string, unknown>;
		let next = typeof g[kNextId] === "number" ? (g[kNextId] as number) : 0;
		do {
			id = `c${(next++).toString(36)}`;
		} while (RESERVED_IDS.has(id));
		g[kNextId] = next;
		tagged[kNativeId] = id;
	}
	return id;
}

const KEY_ESCAPES: Readonly<Record<string, string>> = { "%": "%25", "/": "%2F", ".": "%2E" };
const KEY_UNESCAPES: Readonly<Record<string, string>> = { "%25": "%", "%2F": "/", "%2E": "." };

function escapeKey(key: string): string {
	return key.replace(/[%/.]/g, (c) => KEY_ESCAPES[c]!);
}

function unescapeKey(segment: string): string {
	return segment.replace(/%2F|%25|%2E/g, (c) => KEY_UNESCAPES[c]!);
}

function nodeId(base: string, keypath: string): string {
	return keypath === "" ? base : `${base}.${keypath}`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
		return true;
	}
	if (Array.isArray(b)) return false;
	const ka = Object.keys(a as object);
	const kb = Object.keys(b as object);
	if (ka.length !== kb.length) return false;
	for (const key of ka) {
		if (!Object.hasOwn(b as object, key)) return false;
		if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
	}
	return true;
}

function stableMask(sources: readonly number[]): boolean[] {
	const n = sources.length;
	const mask = Array.from({ length: n }, () => false);
	const tails: number[] = [];
	const prev = Array.from({ length: n }, () => -1);
	for (let i = 0; i < n; i++) {
		const value = sources[i]!;
		if (value < 0) continue;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sources[tails[mid]!]! < value) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tails[lo - 1]!;
		tails[lo] = i;
	}
	for (let at = tails.length > 0 ? tails[tails.length - 1]! : -1; at >= 0; at = prev[at]!) mask[at] = true;
	return mask;
}

interface Owner {
	readonly base: string;
	readonly state: CompState | null;
}

interface NodeEntry {
	readonly id: string;
	readonly node: NativeNode;
	readonly owner: Owner;
	readonly keypath: string;
	readonly comp?: undefined;
}

interface CompEntry {
	readonly id: string;
	readonly comp: Component;
}

type Entry = NodeEntry | CompEntry;

interface Inner {
	readonly comp: Component;
	readonly parent: string;
	readonly before: string | null;
}

interface CompState {
	readonly comp: Component;
	readonly id: string;
	readonly owner: Owner;
	node: NativeNode | null;
	inner: Inner[];
	rowsLines: readonly string[] | null;
	rowsCols: number;
	rowsNode: NativeNode | null;
	frame: number;
	container: CompState | null;
}

interface Walk {
	readonly owner: Owner;
	readonly inner: Inner[] | null;
}

const EMPTY_ENTRIES: readonly Entry[] = [];

export class Reconciler {
	readonly surface: string;
	#resolver: Resolver;
	#cx: DescribeContext | undefined;
	#states = new Map<Component, CompState>();
	#byId = new Map<string, CompState>();
	#frame = 0;
	#ops: TspOp[] = [];
	#dels: Entry[] = [];
	#reveals: [id: string, at: "start" | "end" | "nearest"][] = [];
	#regions: Record<RegionId, readonly Entry[]> | null = null;
	#rows = 0;
	#gone = new Set<string>();
	#readd: readonly RegionId[] = [];
	#predel: readonly RegionId[] = [];
	#regionOwners: Record<RegionId, Owner> = {
		main: { base: "main", state: null },
		dock: { base: "dock", state: null },
		layer: { base: "layer", state: null },
	};

	constructor(surface: string, resolver: Resolver) {
		this.surface = surface;
		this.#resolver = resolver;
	}

	get fallbackCount(): number {
		return this.#rows;
	}

	get mounted(): number {
		return this.#states.size;
	}

	reconcile(regions: NativeRegions, cx: DescribeContext): TspOp[] {
		this.#cx = cx;
		this.#frame++;
		this.#ops = [];
		this.#dels = [];
		this.#reveals = [];
		this.#rows = 0;
		for (const region of this.#predel) this.#ops.push(["del", region]);
		this.#predel = [];
		let prev = this.#regions;
		if (prev === null) {
			for (const region of REGION_IDS) this.#ops.push(["add", region, this.surface, null, { id: region, k: "col" }]);
			prev = { main: EMPTY_ENTRIES, dock: EMPTY_ENTRIES, layer: EMPTY_ENTRIES };
		}
		for (const region of this.#readd) this.#ops.push(["add", region, this.surface, null, { id: region, k: "col" }]);
		this.#readd = [];
		const next = {} as Record<RegionId, readonly Entry[]>;
		for (const region of REGION_IDS) {
			const walk: Walk = { owner: this.#regionOwners[region], inner: null };
			const entries = this.#entries(regions[region], "", walk.owner);
			this.#diffChildren(region, prev[region], entries, null, walk);
			next[region] = entries;
		}
		this.#regions = next;
		// Delete old subtrees after moves to preserve moved components.
		for (const entry of this.#dels) this.#deleteEntry(entry);
		this.#dels = [];
		for (const [id, at] of this.#reveals) this.#ops.push(["reveal", id, at]);
		const ops = this.#ops;
		this.#ops = [];
		return this.#gone.size === 0 ? ops : ops.filter((op) => !this.#touchesGone(op));
	}

	/**
	 * The terminal keeps only `main` after a close with `keep: true`.
	 */
	detachLive(): void {
		const regions = this.#regions;
		if (!regions) return;
		this.#frame++;
		for (const region of ["dock", "layer"] as const) {
			for (const entry of regions[region]) {
				if (entry.comp === undefined) this.#dropSubtree(entry);
				else {
					const state = this.#states.get(entry.comp);
					if (state) this.#dropState(state);
				}
			}
		}
		this.#regions = { main: regions.main, dock: EMPTY_ENTRIES, layer: EMPTY_ENTRIES };
		this.#readd = ["dock", "layer"];
	}

	resetRegions(): void {
		this.#states.clear();
		this.#byId.clear();
		this.#regions = { main: EMPTY_ENTRIES, dock: EMPTY_ENTRIES, layer: EMPTY_ENTRIES };
		this.#predel = [...REGION_IDS];
		this.#readd = [...REGION_IDS];
		this.#gone.clear();
	}

	target(id: string): NativeTarget | null {
		const dot = id.indexOf(".");
		const state = this.#byId.get(dot === -1 ? id : id.slice(0, dot));
		if (!state) return null;
		const keypath = dot === -1 ? "" : id.slice(dot + 1).split("/").map(unescapeKey).join("/");
		return { component: state.comp, keypath };
	}

	owners(id: string): Component[] {
		const dot = id.indexOf(".");
		const out: Component[] = [];
		for (let state = this.#byId.get(dot === -1 ? id : id.slice(0, dot)) ?? null; state; state = state.container) out.push(state.comp);
		return out;
	}

	itemKey(id: string): string {
		const dot = id.indexOf(".");
		if (dot === -1) return this.#byId.get(id)?.node?.key ?? id;
		const slash = id.lastIndexOf("/");
		return unescapeKey(id.slice(Math.max(dot, slash) + 1));
	}

	focusTarget(component: Component): string | null {
		const state = this.#states.get(component);
		return state ? this.#findEditor(state, 0) : null;
	}

	forget(ids: readonly string[]): void {
		for (const id of ids) this.#gone.add(id);
	}

	#touchesGone(op: TspOp): boolean {
		const gone = this.#gone;
		switch (op[0]) {
			case "add":
			case "move":
				return gone.has(op[1]) || gone.has(op[2]) || (op[3] !== null && gone.has(op[3]));
			case "focus":
				return op[1] !== null && gone.has(op[1]);
			case "suspend":
			case "resume":
				return false;
			default:
				return gone.has(op[1]);
		}
	}

	#findEditor(state: CompState, depth: number): string | null {
		if (depth > 64 || !state.node) return null;
		return this.#findEditorIn(state.node, state.id, "", state.owner, depth);
	}

	#findEditorIn(node: NativeNode, id: string, keypath: string, owner: Owner, depth: number): string | null {
		if (node.k === "editor" || node.k === "input") return id;
		for (const entry of this.#entries(node.c, keypath, owner)) {
			let found: string | null;
			if (entry.comp !== undefined) {
				const state = this.#states.get(entry.comp);
				found = state ? this.#findEditor(state, depth + 1) : null;
			} else found = this.#findEditorIn(entry.node, entry.id, entry.keypath, owner, depth);
			if (found !== null) return found;
		}
		return null;
	}

	#entries(children: readonly NativeChild[] | undefined, keypath: string, owner: Owner): readonly Entry[] {
		if (!children || children.length === 0) return EMPTY_ENTRIES;
		const out: Entry[] = [];
		let used: Set<string> | undefined;
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			if (isComponent(child)) {
				out.push({ id: nativeComponentId(child), comp: child });
				continue;
			}
			const segment = child.key === undefined ? String(i) : escapeKey(child.key);
			let path = keypath === "" ? segment : `${keypath}/${segment}`;
			if (children.length > 1) {
				used ??= new Set();
				if (used.has(path)) {
					let n = 2;
					while (used.has(`${path}~${n}`)) n++;
					path = `${path}~${n}`;
				}
				used.add(path);
			}
			out.push({ id: nodeId(owner.base, path), node: child, owner, keypath: path });
		}
		return out;
	}

	#diffChildren(parent: string, oldEntries: readonly Entry[], newEntries: readonly Entry[], tailBefore: string | null, walk: Walk): void {
		const oldIndex = new Map<string, number>();
		if (oldEntries.length > 0) {
			const keep = new Set<string>();
			for (const entry of newEntries) keep.add(entry.id);
			for (let i = 0; i < oldEntries.length; i++) {
				const entry = oldEntries[i]!;
				oldIndex.set(entry.id, i);
				if (!keep.has(entry.id)) this.#dels.push(entry);
			}
		}
		const count = newEntries.length;
		const sources = newEntries.map((entry) => oldIndex.get(entry.id) ?? -1);
		const stable = stableMask(sources);
		const anchors: (string | null)[] = [];
		let anchor = tailBefore;
		for (let i = count - 1; i >= 0; i--) {
			anchors[i] = anchor;
			if (stable[i]) anchor = newEntries[i]!.id;
		}
		for (let i = 0; i < count; i++) {
			const entry = newEntries[i]!;
			const source = sources[i]!;
			const before = anchors[i]!;
			const next = i + 1 < count ? newEntries[i + 1]!.id : tailBefore;
			if (source < 0) {
				this.#place(entry, parent, before, next, walk);
				continue;
			}
			if (!stable[i]) {
				const state = entry.comp === undefined ? undefined : this.#states.get(entry.comp);
				if (state) this.#move(state, parent, before);
				else this.#ops.push(["move", entry.id, parent, before]);
			}
			if (entry.comp !== undefined) this.#visitChild(entry.comp, parent, before, next, walk);
			else this.#diffNode(oldEntries[source] as NodeEntry, entry, parent, before, walk);
		}
	}

	#place(entry: Entry, parent: string, before: string | null, next: string | null, walk: Walk): void {
		if (entry.comp === undefined) {
			this.#ops.push(["add", entry.id, parent, before, this.#materialize(entry, walk)]);
			return;
		}
		const state = this.#states.get(entry.comp);
		if (state?.frame === this.#frame) {
			this.#warnDuplicate(state);
			return;
		}
		walk.inner?.push({ comp: entry.comp, parent, before: next });
		if (state) {
			this.#move(state, parent, before);
			this.#visit(state, parent, before);
			return;
		}
		this.#addComponent(entry.comp, parent, before);
	}

	#visitChild(comp: Component, parent: string, before: string | null, next: string | null, walk: Walk): void {
		const state = this.#states.get(comp);
		if (state?.frame === this.#frame) {
			this.#warnDuplicate(state);
			return;
		}
		walk.inner?.push({ comp, parent, before: next });
		if (state) this.#visit(state, parent, before);
		else this.#addComponent(comp, parent, before);
	}

	#addComponent(comp: Component, parent: string, before: string | null): void {
		const state = this.#createState(comp, parent);
		this.#ops.push(["add", state.id, parent, before, this.#materializeComponent(state)]);
	}

	#warnDuplicate(state: CompState): void {
		this.#resolver.warn?.("component described twice in one frame; later occurrence skipped", {
			id: state.id,
			kind: state.comp.constructor.name,
		});
	}

	#diffNode(old: NodeEntry, next: NodeEntry, parent: string, before: string | null, walk: Walk): void {
		if (old.node === next.node) {
			this.#revisitNode(next, walk);
			return;
		}
		if (old.node.k !== next.node.k) {
			this.#dropSubtree(old);
			this.#ops.push(["del", next.id]);
			this.#ops.push(["add", next.id, parent, before, this.#materialize(next, walk)]);
			return;
		}
		const oldEntries = this.#entries(old.node.c, old.keypath, old.owner);
		const newEntries = this.#entries(next.node.c, next.keypath, next.owner);
		this.#diffProps(next.id, next.node.k, this.#wireProps(old.node, oldEntries), this.#wireProps(next.node, newEntries));
		this.#diffChildren(next.id, oldEntries, newEntries, null, walk);
	}

	#revisitNode(entry: NodeEntry, walk: Walk): void {
		const entries = this.#entries(entry.node.c, entry.keypath, entry.owner);
		for (let i = 0; i < entries.length; i++) {
			const child = entries[i]!;
			const before = i + 1 < entries.length ? entries[i + 1]!.id : null;
			if (child.comp === undefined) this.#revisitNode(child, walk);
			else this.#visitChild(child.comp, entry.id, before, before, walk);
		}
	}

	#diffProps(id: string, kind: TspKind, oldProps: Readonly<Record<string, unknown>> | undefined, newProps: Readonly<Record<string, unknown>> | undefined): void {
		const textKind = TEXT_KINDS.has(kind);
		let set: Record<string, unknown> | undefined;
		if (newProps) {
			for (const key in newProps) {
				const value = newProps[key];
				if (value === undefined || (textKind && key === "text")) continue;
				if (!deepEqual(oldProps?.[key], value)) (set ??= {})[key] = value;
			}
		}
		if (oldProps) {
			for (const key in oldProps) {
				if (oldProps[key] === undefined || newProps?.[key] !== undefined) continue;
				if (textKind && key === "text") continue;
				(set ??= {})[key] = null;
			}
		}
		if (textKind) {
			const oldText = oldProps?.text as string | undefined;
			const newText = newProps?.text as string | undefined;
			if (newText === undefined) {
				if (oldText !== undefined) (set ??= {}).text = null;
			} else if (newText !== oldText) this.#textOp(id, kind, oldText ?? "", newText);
		}
		if (set) this.#ops.push(["set", id, set]);
	}

	#textOp(id: string, kind: TspKind, oldText: string, newText: string): void {
		if (newText.length >= oldText.length && newText.startsWith(oldText)) {
			this.#ops.push(["text", id, "append", newText.slice(oldText.length)]);
			return;
		}
		if ((kind === "editor" || kind === "input" || kind === "md") && oldText.length > 0) {
			const limit = Math.min(oldText.length, newText.length);
			let prefix = 0;
			while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
			if (kind !== "md" || prefix > 0) {
				let suffix = 0;
				while (suffix < limit - prefix && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) suffix++;
				this.#ops.push(["splice", id, prefix, oldText.length - prefix - suffix, newText.slice(prefix, newText.length - suffix)]);
				return;
			}
		}
		this.#ops.push(["text", id, "replace", newText]);
	}

	#wireProps(node: NativeNode, entries: readonly Entry[]): Readonly<Record<string, unknown>> | undefined {
		const props = node.p as Readonly<Record<string, unknown>> | undefined;
		switch (node.k) {
			case "list": {
				const selected = props?.selected;
				if (typeof selected !== "string") return props;
				const item = entries.find((entry) => entry.comp === undefined && entry.node.key === selected);
				return item ? { ...props, selected: item.id } : props;
			}
			case "card":
			case "section": {
				if (props?.head !== undefined) return props;
				const head = entries.find((entry) => entry.comp === undefined && entry.node.key === "head");
				return head ? { ...props, head: head.id } : props;
			}
			default:
				return props;
		}
	}

	#materialize(entry: NodeEntry, walk: Walk): TspNode {
		if (entry.node.reveal) this.#reveals.push([entry.id, entry.node.reveal]);
		const entries = this.#entries(entry.node.c, entry.keypath, entry.owner);
		const children: TspNode[] = [];
		for (let i = 0; i < entries.length; i++) {
			const child = entries[i]!;
			if (child.comp === undefined) {
				children.push(this.#materialize(child, walk));
				continue;
			}
			let state = this.#states.get(child.comp);
			if (state?.frame === this.#frame) {
				this.#warnDuplicate(state);
				continue;
			}
			const before = i + 1 < entries.length ? entries[i + 1]!.id : null;
			walk.inner?.push({ comp: child.comp, parent: entry.id, before });
			if (state) {
				// The old node must be deleted before its ID can be reused.
				this.#dropState(state);
				this.#ops.push(["del", state.id]);
			}
			state = this.#createState(child.comp, entry.id);
			children.push(this.#materializeComponent(state));
		}
		return this.#wire(entry.id, entry.node.k, this.#wireProps(entry.node, entries), children);
	}

	#wire(id: string, k: TspKind, props: Readonly<Record<string, unknown>> | undefined, children: readonly TspNode[]): TspNode {
		const out: TspNode = { id, k };
		if (props) {
			let p: Record<string, unknown> | undefined;
			for (const key in props) {
				const value = props[key];
				if (value !== undefined && value !== null) (p ??= {})[key] = value;
			}
			if (p) out.p = p;
		}
		if (children.length > 0) out.c = children;
		return out;
	}

	#containerOf(parent: string): CompState | null {
		const dot = parent.indexOf(".");
		return this.#byId.get(dot === -1 ? parent : parent.slice(0, dot)) ?? null;
	}

	#move(state: CompState, parent: string, before: string | null): void {
		this.#ops.push(["move", state.id, parent, before]);
		state.container = this.#containerOf(parent);
	}

	#createState(comp: Component, parent: string): CompState {
		const id = nativeComponentId(comp);
		const owner: { base: string; state: CompState | null } = { base: id, state: null };
		const state: CompState = {
			comp,
			id,
			owner,
			node: null,
			inner: [],
			rowsLines: null,
			rowsCols: 0,
			rowsNode: null,
			frame: 0,
			container: this.#containerOf(parent),
		};
		owner.state = state;
		this.#states.set(comp, state);
		this.#byId.set(id, state);
		return state;
	}

	#resolve(state: CompState): NativeNode {
		const comp = state.comp;
		const cx = this.#cx!;
		const described = this.#resolver.describe(comp, cx);
		if (described) return described;
		this.#rows++;
		const cols = Math.max(1, this.#resolver.rowsCols?.(comp, cx) ?? cx.cols);
		let lines: string[];
		try {
			lines = comp.render(cols);
		} catch (error) {
			this.#resolver.warn?.("render failed in rows fallback", { kind: comp.constructor.name, error: String(error) });
			lines = [];
		}
		if (state.rowsNode && cols === state.rowsCols && (lines === state.rowsLines || sameLines(lines, state.rowsLines))) return state.rowsNode;
		state.rowsLines = lines;
		state.rowsCols = cols;
		const clean = lines.map(cleanRow);
		state.rowsNode = { k: "rows", p: { cols, lines: clean } };
		return state.rowsNode;
	}

	#rootEntry(state: CompState, node: NativeNode): NodeEntry {
		return { id: state.id, node, owner: state.owner, keypath: "" };
	}

	#materializeComponent(state: CompState): TspNode {
		state.frame = this.#frame;
		const node = this.#resolve(state);
		const inner: Inner[] = [];
		const wire = this.#materialize(this.#rootEntry(state, node), { owner: state.owner, inner });
		state.inner = inner;
		state.node = node;
		return wire;
	}

	#visit(state: CompState, parent: string, before: string | null): void {
		state.frame = this.#frame;
		const next = this.#resolve(state);
		if (state.node !== null && next === state.node) {
			this.#revisitComponent(state);
			return;
		}
		const inner: Inner[] = [];
		const walk: Walk = { owner: state.owner, inner };
		if (state.node === null) {
			this.#ops.push(["add", state.id, parent, before, this.#materialize(this.#rootEntry(state, next), walk)]);
		} else this.#diffNode(this.#rootEntry(state, state.node), this.#rootEntry(state, next), parent, before, walk);
		state.inner = inner;
		state.node = next;
	}

	#revisitComponent(state: CompState): void {
		const walk: Walk = { owner: state.owner, inner: null };
		for (const item of state.inner) this.#visitChild(item.comp, item.parent, item.before, item.before, walk);
	}

	#deleteEntry(entry: Entry): void {
		if (entry.comp !== undefined) {
			const state = this.#states.get(entry.comp);
			if (state?.frame === this.#frame) return;
			if (state) this.#dropState(state);
			this.#ops.push(["del", entry.id]);
			return;
		}
		this.#dropSubtree(entry);
		this.#ops.push(["del", entry.id]);
	}

	#dropSubtree(entry: NodeEntry): void {
		for (const child of this.#entries(entry.node.c, entry.keypath, entry.owner)) {
			if (child.comp === undefined) this.#dropSubtree(child);
			else {
				const state = this.#states.get(child.comp);
				if (state && state.frame !== this.#frame) this.#dropState(state);
			}
		}
	}

	#dropNested(state: CompState): void {
		for (const item of state.inner) {
			const child = this.#states.get(item.comp);
			if (child && child.frame !== this.#frame) this.#dropState(child);
		}
		state.inner = [];
	}

	#dropState(state: CompState): void {
		this.#states.delete(state.comp);
		this.#byId.delete(state.id);
		this.#dropNested(state);
	}
}

function sameLines(a: readonly string[], b: readonly string[] | null): boolean {
	if (!b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function cleanRow(line: string): string {
	if (!line.includes("\x1b_pi:")) return line;
	return line.replaceAll(CURSOR_MARKER, "").replaceAll(FAKE_CURSOR_START, "\x1b[7m").replaceAll(FAKE_CURSOR_END, "\x1b[27m");
}

/**
 * Structured subagent output: a `yield` tool that validates a child's final result against a JSON
 * Schema, plus the prompt text that tells the child to use it. Modeled on oh-my-pi's
 * `tools/yield.ts`, `tools/output-schema-validator.ts`, `prompts/tools/yield.md`,
 * `prompts/system/subagent-yield-reminder.md` and the yield parts of `subagent-system-prompt.md`.
 *
 * Standalone: no imports from the rest of the extension. The hub wires it up:
 *  1. `normalizeSchema(item.outputSchema ?? agent.output)` → schema (or an error to fail fast).
 *  2. `const state = createYieldState()`; pass `createYieldTool(schema, state, options?)` in the
 *     child's `customTools` (and add `"yield"` to any `tools` allowlist); replace the child's completion
 *     section with `structuredCompletionPrompt(schema)`.
 *  3. After each run (`await session.prompt(...)`) check `state.submitted`; if false, re-prompt with
 *     `yieldReminder(schema, n)` for n = 1..MAX_YIELD_REMINDERS, then fail the task.
 *  4. `state.error` set → task failed with that reason; otherwise the result is `state.data`
 *     (render with `formatStructuredData`).
 *
 * Validation happens in two places, both driven by the same `interpretYieldArgs` logic:
 *  - `prepareArguments` runs on the raw tool-call arguments BEFORE pi's own TypeBox validation, so
 *    schema violations reach the model with this module's issue list + format hint (and count as
 *    attempts) instead of pi's generic "Validation failed" text.
 *  - `execute` re-checks (it is also the entry point for direct calls) and records the result.
 * The `data` parameter embeds a sanitized, self-contained copy of the schema (refs inlined,
 * `nullable` converted, only keywords this validator implements) so the model sees the real shape
 * and pi's TypeBox validator can never be stricter than, or crash on, what we accept.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type JsonSchema = Record<string, unknown>;

/** How many times the hub re-prompts a child whose run ended without a successful `yield`. */
export const MAX_YIELD_REMINDERS = 3;

/** Name of the tool returned by {@link createYieldTool}. */
export const YIELD_TOOL_NAME = "yield";

/** Default budget for {@link formatStructuredData}. */
export const DEFAULT_STRUCTURED_DATA_MAX_CHARS = 20_000;

const FORMAT_HINT = 'Submit success as {"data": <value matching the output schema>} or failure as {"error": "message"}.';
const MAX_ISSUES_SHOWN = 20;
const MAX_VALIDATION_DEPTH = 128;
const MAX_TOOL_SCHEMA_CHARS = 64 * 1024;
const MAX_TOOL_SCHEMA_NODES = 5000;

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/**
 * Filler strings non-strict providers put in the optional `error` field next to valid `data`
 * (oh-my-pi PLACEHOLDER_YIELD_ERRORS). Only ignored when `data` is present.
 */
const PLACEHOLDER_ERRORS = new Set([
	"ignore",
	"ignored",
	"n/a",
	"na",
	"none",
	"not applicable",
	"null",
	"placeholder",
	"undefined",
	"unused",
]);

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value;
}

function preview(value: unknown, max = 60): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const bb = b as unknown[];
		return a.length === bb.length && a.every((item, i) => deepEqual(item, bb[i]));
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const ak = Object.keys(ao);
	const bk = Object.keys(bo);
	return ak.length === bk.length && ak.every((k) => hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

function escapePointer(key: string): string {
	return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function childPath(path: string, key: string | number): string {
	return `${path}/${typeof key === "number" ? key : escapePointer(key)}`;
}

function showPath(path: string): string {
	return path === "" ? "(root)" : path;
}

const regexCache = new Map<string, RegExp | null>();

/** Compile a JSON Schema `pattern` (unicode mode first, like TypeBox); null when invalid. */
function compilePattern(pattern: string, unicodeOnly = false): RegExp | null {
	const key = `${unicodeOnly ? "u" : "*"}${pattern}`;
	const cached = regexCache.get(key);
	if (cached !== undefined) return cached;
	let re: RegExp | null = null;
	try {
		re = new RegExp(pattern, "u");
	} catch {
		if (!unicodeOnly) {
			try {
				re = new RegExp(pattern);
			} catch {
				re = null;
			}
		}
	}
	regexCache.set(key, re);
	return re;
}

/** Resolve a local JSON pointer `$ref` ("#", "#/$defs/X", "#/definitions/X", any "#/..."). */
function resolveRef(root: unknown, ref: string): unknown {
	if (ref === "#") return root;
	if (!ref.startsWith("#/")) return undefined;
	let node: unknown = root;
	for (const raw of ref.slice(2).split("/")) {
		let segment: string;
		try {
			segment = decodeURIComponent(raw);
		} catch {
			segment = raw;
		}
		segment = segment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(node)) {
			const index = Number(segment);
			if (!Number.isInteger(index)) return undefined;
			node = node[index];
		} else if (isRecord(node) && hasOwn(node, segment)) {
			node = node[segment];
		} else {
			return undefined;
		}
	}
	return node;
}

function codePointLength(text: string): number {
	let n = 0;
	for (const _ of text) n++;
	return n;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return isRecord(value);
		case "array":
			return Array.isArray(value);
		case "null":
			return value === null;
		default:
			return true; // unknown type names are ignored (normalizeSchema reports them)
	}
}

function isMultipleOf(value: number, divisor: number): boolean {
	if (divisor <= 0) return true;
	const quotient = value / divisor;
	if (!Number.isFinite(quotient)) return true;
	return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

// ---------------------------------------------------------------------------------------------
// normalizeSchema
// ---------------------------------------------------------------------------------------------

/** Accepts a JSON Schema object, a JSON string of one, `true` (any JSON value); null/false/undefined -> no schema. */
export function normalizeSchema(input: unknown): { schema?: JsonSchema; error?: string } {
	if (input === undefined || input === null || input === false) return {};
	if (input === true) return { schema: {} };
	if (typeof input === "string") {
		const text = input.trim();
		if (!text) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (e) {
			return { error: `output schema is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
		}
		if (typeof parsed === "string") return { error: "output schema must be a JSON Schema object, got a JSON string" };
		return normalizeSchema(parsed);
	}
	if (!isRecord(input)) {
		return { error: `output schema must be a JSON Schema object (or true), got ${describeValue(input)}` };
	}
	let schema: JsonSchema;
	try {
		// Private, JSON-clean copy: drops functions/undefined, rejects cycles and BigInt.
		schema = JSON.parse(JSON.stringify(input)) as JsonSchema;
	} catch (e) {
		return { error: `output schema is not JSON-serializable: ${e instanceof Error ? e.message : String(e)}` };
	}
	const problems: string[] = [];
	lintSchema(schema, "#", schema, problems, 0);
	if (problems.length > 0) {
		const shown = problems.slice(0, 5).join("; ");
		const more = problems.length > 5 ? ` (+${problems.length - 5} more)` : "";
		return { error: `invalid output schema: ${shown}${more}` };
	}
	return { schema };
}

const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions"] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SCHEMA_SINGLE_KEYWORDS = ["additionalProperties", "additionalItems", "not"] as const;
const NON_NEGATIVE_INT_KEYWORDS = [
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"minProperties",
	"maxProperties",
] as const;
const NUMBER_KEYWORDS = ["minimum", "maximum"] as const;

/** Light structural checks so author mistakes fail the task up front, not every `yield` call. */
function lintSchema(node: unknown, at: string, root: JsonSchema, out: string[], depth: number): void {
	if (out.length >= 20) return;
	if (typeof node === "boolean") return;
	if (!isRecord(node)) {
		out.push(`${at}: a schema must be an object or boolean, got ${describeValue(node)}`);
		return;
	}
	if (depth > MAX_VALIDATION_DEPTH) {
		out.push(`${at}: schema nesting too deep`);
		return;
	}
	if (node.type !== undefined) {
		const types = Array.isArray(node.type) ? node.type : [node.type];
		if (types.length === 0) out.push(`${at}/type: must not be empty`);
		for (const t of types) {
			if (typeof t !== "string" || !JSON_TYPES.has(t)) {
				out.push(`${at}/type: unknown type ${preview(t)} (expected one of ${[...JSON_TYPES].join(", ")})`);
			}
		}
	}
	if (node.$ref !== undefined) {
		if (typeof node.$ref !== "string") out.push(`${at}/$ref: must be a string`);
		else if (!node.$ref.startsWith("#")) out.push(`${at}/$ref: only local references ("#/$defs/...") are supported`);
		else if (resolveRef(root, node.$ref) === undefined) out.push(`${at}/$ref: cannot resolve ${preview(node.$ref)}`);
	}
	if (node.required !== undefined && !(Array.isArray(node.required) && node.required.every((r) => typeof r === "string"))) {
		out.push(`${at}/required: must be an array of property names`);
	}
	if (node.enum !== undefined && !Array.isArray(node.enum)) out.push(`${at}/enum: must be an array`);
	if (node.pattern !== undefined) {
		if (typeof node.pattern !== "string") out.push(`${at}/pattern: must be a string`);
		else if (!compilePattern(node.pattern)) out.push(`${at}/pattern: invalid regular expression ${preview(node.pattern)}`);
	}
	for (const key of NON_NEGATIVE_INT_KEYWORDS) {
		const v = node[key];
		if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v >= 0)) {
			out.push(`${at}/${key}: must be a non-negative integer`);
		}
	}
	for (const key of NUMBER_KEYWORDS) {
		if (node[key] !== undefined && typeof node[key] !== "number") out.push(`${at}/${key}: must be a number`);
	}
	for (const key of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
		const v = node[key];
		if (v !== undefined && typeof v !== "number" && typeof v !== "boolean") out.push(`${at}/${key}: must be a number`);
	}
	if (node.multipleOf !== undefined && !(typeof node.multipleOf === "number" && node.multipleOf > 0)) {
		out.push(`${at}/multipleOf: must be a positive number`);
	}
	for (const key of SCHEMA_MAP_KEYWORDS) {
		const map = node[key];
		if (map === undefined) continue;
		if (!isRecord(map)) {
			out.push(`${at}/${key}: must be an object`);
			continue;
		}
		for (const [name, sub] of Object.entries(map)) {
			if (key === "patternProperties" && !compilePattern(name)) {
				out.push(`${at}/${key}: invalid regular expression ${preview(name)}`);
			}
			lintSchema(sub, `${at}/${key}/${escapePointer(name)}`, root, out, depth + 1);
		}
	}
	for (const key of SCHEMA_ARRAY_KEYWORDS) {
		const list = node[key];
		if (list === undefined) continue;
		if (!Array.isArray(list) || (key !== "prefixItems" && list.length === 0)) {
			out.push(`${at}/${key}: must be a non-empty array of schemas`);
			continue;
		}
		list.forEach((sub, i) => lintSchema(sub, `${at}/${key}/${i}`, root, out, depth + 1));
	}
	for (const key of SCHEMA_SINGLE_KEYWORDS) {
		if (node[key] !== undefined) lintSchema(node[key], `${at}/${key}`, root, out, depth + 1);
	}
	if (node.items !== undefined) {
		if (Array.isArray(node.items)) node.items.forEach((sub, i) => lintSchema(sub, `${at}/items/${i}`, root, out, depth + 1));
		else lintSchema(node.items, `${at}/items`, root, out, depth + 1);
	}
}

// ---------------------------------------------------------------------------------------------
// validateAgainstSchema
// ---------------------------------------------------------------------------------------------

/**
 * Validation issues ("/path: message", root shown as "(root)"); empty array = valid.
 * Supports type (incl. arrays of types, integer, null), nullable, enum, const, $ref (local JSON
 * pointers incl. #/$defs and #/definitions), properties, required, additionalProperties (bool|schema),
 * patternProperties, min/maxProperties, items (schema or draft-07 tuple + additionalItems),
 * prefixItems, min/maxItems, uniqueItems, min/maxLength (code points), pattern, minimum/maximum,
 * exclusiveMinimum/exclusiveMaximum (number or draft-04 boolean), multipleOf, allOf/anyOf/oneOf/not.
 * Unknown keywords (format, if/then/else, ...) are ignored.
 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): string[] {
	const out: string[] = [];
	checkNode(schema, value, "", schema, 0, out);
	return out;
}

function checkNode(schema: unknown, value: unknown, path: string, root: JsonSchema, depth: number, out: string[]): void {
	if (schema === true || schema === undefined) return;
	if (schema === false) {
		out.push(`${showPath(path)}: no value is allowed here`);
		return;
	}
	if (!isRecord(schema)) return;
	if (depth > MAX_VALIDATION_DEPTH) {
		out.push(`${showPath(path)}: schema recursion too deep`);
		return;
	}
	if (value === undefined) {
		out.push(`${showPath(path)}: value is missing`);
		return;
	}
	// OpenAPI-style `nullable: true` admits null on top of whatever the schema says.
	if (value === null && schema.nullable === true) return;

	if (typeof schema.$ref === "string") {
		const target = resolveRef(root, schema.$ref);
		if (target !== undefined) checkNode(target, value, path, root, depth + 1, out);
	}

	if (schema.type !== undefined) {
		const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
			(t): t is string => typeof t === "string",
		);
		if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
			out.push(`${showPath(path)}: expected ${types.join(" or ")}, got ${describeValue(value)}`);
			return; // other keywords would only add noise
		}
	}

	if (hasOwn(schema, "const") && !deepEqual(value, schema.const)) {
		out.push(`${showPath(path)}: must be exactly ${preview(schema.const)}`);
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
		const options = schema.enum.slice(0, 20).map((e) => preview(e, 40));
		const more = schema.enum.length > 20 ? `, … (${schema.enum.length} total)` : "";
		out.push(`${showPath(path)}: must be one of ${options.join(", ")}${more}; got ${preview(value)}`);
	}

	if (typeof value === "string") checkString(schema, value, path, out);
	else if (typeof value === "number") checkNumber(schema, value, path, out);
	else if (Array.isArray(value)) checkArray(schema, value, path, root, depth, out);
	else if (isRecord(value)) checkObject(schema, value, path, root, depth, out);

	if (Array.isArray(schema.allOf)) {
		for (const sub of schema.allOf) checkNode(sub, value, path, root, depth + 1, out);
	}
	if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
		const results = schema.anyOf.map((sub) => collect(sub, value, path, root, depth + 1));
		if (!results.some((r) => r.length === 0)) out.push(unionFailure("anyOf", path, results));
	}
	if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
		const results = schema.oneOf.map((sub) => collect(sub, value, path, root, depth + 1));
		const matching = results.flatMap((r, i) => (r.length === 0 ? [i + 1] : []));
		if (matching.length === 0) out.push(unionFailure("oneOf", path, results));
		else if (matching.length > 1) {
			out.push(`${showPath(path)}: must match exactly one oneOf variant, but matches variants ${matching.map((i) => `#${i}`).join(", ")}`);
		}
	}
	if (schema.not !== undefined && collect(schema.not, value, path, root, depth + 1).length === 0) {
		out.push(`${showPath(path)}: must NOT match the schema ${preview(schema.not)}`);
	}
}

function collect(schema: unknown, value: unknown, path: string, root: JsonSchema, depth: number): string[] {
	const out: string[] = [];
	checkNode(schema, value, path, root, depth, out);
	return out;
}

function unionFailure(keyword: "anyOf" | "oneOf", path: string, results: string[][]): string {
	// Closest variant: fewest issues, but a variant whose very type differs at this path is the
	// least informative (e.g. for 3 vs [string, integer>=10] point at the integer branch).
	const typeMiss = `${showPath(path)}: expected `;
	const score = (issues: string[]) => issues.length + (issues.some((i) => i.startsWith(typeMiss)) ? 1000 : 0);
	let best = 0;
	for (let i = 1; i < results.length; i++) if (score(results[i]) < score(results[best])) best = i;
	const closest = results[best];
	const shown = closest.slice(0, 3).join("; ");
	const more = closest.length > 3 ? `; … (${closest.length - 3} more)` : "";
	const quantifier = keyword === "oneOf" ? "exactly one" : "at least one";
	return `${showPath(path)}: must match ${quantifier} of ${results.length} ${keyword} variants; closest is #${best + 1}: ${shown}${more}`;
}

/** Prefix of the issue `checkNode` pushes when the value's type is wrong at the root. */
const ROOT_TYPE_MISS = `${showPath("")}: expected `;

/**
 * True when the issues of a root-level value include a root type mismatch, directly or folded into
 * a root anyOf/oneOf line by {@link unionFailure} (no variant takes the value's type).
 */
function hasRootTypeMiss(issues: string[]): boolean {
	return issues.some(
		(i) => i.startsWith(ROOT_TYPE_MISS) || (i.startsWith(`${showPath("")}: must match `) && i.includes(`: ${ROOT_TYPE_MISS}`)),
	);
}

function checkString(schema: Record<string, unknown>, value: string, path: string, out: string[]): void {
	const p = showPath(path);
	if (typeof schema.minLength === "number" || typeof schema.maxLength === "number") {
		const len = codePointLength(value);
		if (typeof schema.minLength === "number" && len < schema.minLength) {
			out.push(`${p}: must be at least ${schema.minLength} characters long (got ${len})`);
		}
		if (typeof schema.maxLength === "number" && len > schema.maxLength) {
			out.push(`${p}: must be at most ${schema.maxLength} characters long (got ${len})`);
		}
	}
	if (typeof schema.pattern === "string") {
		const re = compilePattern(schema.pattern);
		if (re && !re.test(value)) out.push(`${p}: must match pattern /${schema.pattern}/`);
	}
}

function checkNumber(schema: Record<string, unknown>, value: number, path: string, out: string[]): void {
	const p = showPath(path);
	const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema;
	if (typeof minimum === "number") {
		if (exclusiveMinimum === true ? value <= minimum : value < minimum) {
			out.push(`${p}: must be ${exclusiveMinimum === true ? ">" : ">="} ${minimum} (got ${value})`);
		}
	}
	if (typeof maximum === "number") {
		if (exclusiveMaximum === true ? value >= maximum : value > maximum) {
			out.push(`${p}: must be ${exclusiveMaximum === true ? "<" : "<="} ${maximum} (got ${value})`);
		}
	}
	if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) out.push(`${p}: must be > ${exclusiveMinimum} (got ${value})`);
	if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) out.push(`${p}: must be < ${exclusiveMaximum} (got ${value})`);
	if (typeof multipleOf === "number" && !isMultipleOf(value, multipleOf)) {
		out.push(`${p}: must be a multiple of ${multipleOf} (got ${value})`);
	}
}

function checkArray(
	schema: Record<string, unknown>,
	value: unknown[],
	path: string,
	root: JsonSchema,
	depth: number,
	out: string[],
): void {
	const p = showPath(path);
	if (typeof schema.minItems === "number" && value.length < schema.minItems) {
		out.push(`${p}: must have at least ${schema.minItems} item(s) (got ${value.length})`);
	}
	if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
		out.push(`${p}: must have at most ${schema.maxItems} item(s) (got ${value.length})`);
	}
	// Tuple prefix: 2020-12 `prefixItems` (+ `items` for the rest) or draft-07 array `items` (+ `additionalItems`).
	let prefix: unknown[] | undefined;
	let rest: unknown;
	if (Array.isArray(schema.prefixItems)) {
		prefix = schema.prefixItems;
		rest = schema.items;
	} else if (Array.isArray(schema.items)) {
		prefix = schema.items;
		rest = schema.additionalItems;
	} else {
		rest = schema.items;
	}
	value.forEach((item, i) => {
		const itemSchema = prefix && i < prefix.length ? prefix[i] : rest;
		if (itemSchema === false && !(prefix && i < prefix.length)) {
			out.push(`${showPath(childPath(path, i))}: unexpected item (array allows at most ${prefix?.length ?? 0} item(s))`);
			return;
		}
		checkNode(itemSchema, item, childPath(path, i), root, depth + 1, out);
	});
	if (schema.uniqueItems === true) {
		outer: for (let i = 0; i < value.length; i++) {
			for (let j = i + 1; j < value.length; j++) {
				if (deepEqual(value[i], value[j])) {
					out.push(`${p}: items must be unique (items ${i} and ${j} are equal)`);
					break outer;
				}
			}
		}
	}
}

function checkObject(
	schema: Record<string, unknown>,
	value: Record<string, unknown>,
	path: string,
	root: JsonSchema,
	depth: number,
	out: string[],
): void {
	const p = showPath(path);
	const properties = isRecord(schema.properties) ? schema.properties : undefined;
	const patternProperties = isRecord(schema.patternProperties) ? schema.patternProperties : undefined;
	if (Array.isArray(schema.required)) {
		for (const key of schema.required) {
			if (typeof key === "string" && (!hasOwn(value, key) || value[key] === undefined)) {
				out.push(`${showPath(childPath(path, key))}: required property is missing`);
			}
		}
	}
	const keys = Object.keys(value).filter((k) => value[k] !== undefined);
	if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
		out.push(`${p}: must have at least ${schema.minProperties} property(ies) (got ${keys.length})`);
	}
	if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
		out.push(`${p}: must have at most ${schema.maxProperties} property(ies) (got ${keys.length})`);
	}
	const extra: string[] = [];
	for (const key of keys) {
		let matched = false;
		if (properties && hasOwn(properties, key)) {
			matched = true;
			checkNode(properties[key], value[key], childPath(path, key), root, depth + 1, out);
		}
		if (patternProperties) {
			for (const [pattern, sub] of Object.entries(patternProperties)) {
				const re = compilePattern(pattern);
				if (re?.test(key)) {
					matched = true;
					checkNode(sub, value[key], childPath(path, key), root, depth + 1, out);
				}
			}
		}
		if (!matched) extra.push(key);
	}
	const additional = schema.additionalProperties;
	if (additional === false) {
		const allowed = properties ? Object.keys(properties) : [];
		const hint = allowed.length
			? `allowed: ${allowed.slice(0, 30).join(", ")}${allowed.length > 30 ? ", …" : ""}`
			: "no other properties allowed";
		for (const key of extra) out.push(`${showPath(childPath(path, key))}: unexpected property (${hint})`);
	} else if (additional !== undefined && additional !== true) {
		for (const key of extra) checkNode(additional, value[key], childPath(path, key), root, depth + 1, out);
	}
}

function formatIssues(issues: string[]): string {
	const shown = issues.slice(0, MAX_ISSUES_SHOWN).map((issue) => `- ${issue}`);
	if (issues.length > MAX_ISSUES_SHOWN) shown.push(`- … and ${issues.length - MAX_ISSUES_SHOWN} more`);
	return shown.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Tool-facing schema (what the model and pi's TypeBox validator see for `data`)
// ---------------------------------------------------------------------------------------------

const ANNOTATION_KEYWORDS = ["title", "description", "default", "examples"] as const;
/** Keywords copied verbatim into the tool schema, each with the value shape TypeBox can compile. */
const COPY_KEYWORDS: ReadonlyArray<readonly [string, (v: unknown) => boolean]> = [
	["enum", Array.isArray],
	["const", () => true],
	["minLength", isNonNegativeInt],
	["maxLength", isNonNegativeInt],
	["minimum", isFiniteNumber],
	["maximum", isFiniteNumber],
	["multipleOf", (v) => isFiniteNumber(v) && v > 0],
	["minItems", isNonNegativeInt],
	["maxItems", isNonNegativeInt],
	["uniqueItems", (v) => typeof v === "boolean"],
	["minProperties", isNonNegativeInt],
	["maxProperties", isNonNegativeInt],
	["title", (v) => typeof v === "string"],
	["description", (v) => typeof v === "string"],
	["default", () => true],
	["examples", Array.isArray],
];

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function isNonNegativeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Self-contained copy of `root` for the tool's `data` parameter: local `$ref`s inlined (recursive
 * ones become `{}` with a note), `nullable` turned into a `"null"` type/branch, draft-04 boolean
 * exclusive bounds and draft-07 tuple `items` rewritten to 2020-12, `format` moved into the
 * description, invalid patterns and every keyword this validator does not implement dropped.
 * With `openItems`, arrays that leave `items` out get an explicit `items: {}` (same meaning: any
 * item, also the open tail after `prefixItems`) for providers that reject itemless arrays.
 * pi validates tool arguments with TypeBox against this, so it must never be stricter than
 * {@link validateAgainstSchema} and must always compile.
 */
function toToolSchema(root: JsonSchema, openItems = false): Record<string, unknown> {
	try {
		const out = sanitizeNode(root, root, [], { left: MAX_TOOL_SCHEMA_NODES, openItems });
		if (JSON.stringify(out).length <= MAX_TOOL_SCHEMA_CHARS) return out;
	} catch {
		// node budget exhausted (ref fan-out) or unserializable: fall back to a loose schema
	}
	return { description: "Value matching the output schema given in your instructions (schema too large to inline here)." };
}

function sanitizeNode(
	node: unknown,
	root: JsonSchema,
	refStack: string[],
	budget: { left: number; openItems?: boolean },
): Record<string, unknown> {
	if (--budget.left < 0) throw new Error("tool schema too large");
	if (node === false) return { not: {} };
	if (!isRecord(node)) return {}; // true, undefined, malformed

	const out: Record<string, unknown> = {};
	let inlined: Record<string, unknown> | undefined;
	if (typeof node.$ref === "string") {
		const ref = node.$ref;
		if (refStack.includes(ref) || refStack.length >= 32) {
			inlined = { description: `Recursive: same shape as ${ref} in the output schema.` };
		} else {
			const target = resolveRef(root, ref);
			if (target !== undefined) inlined = sanitizeNode(target, root, [...refStack, ref], budget);
		}
	}

	if (node.type !== undefined) {
		const types = (Array.isArray(node.type) ? node.type : [node.type]).filter(
			(t): t is string => typeof t === "string" && JSON_TYPES.has(t),
		);
		if (types.length === 1) out.type = types[0];
		else if (types.length > 1) out.type = types;
	}
	for (const [key, valid] of COPY_KEYWORDS) if (hasOwn(node, key) && valid(node[key])) out[key] = node[key];
	if (typeof node.pattern === "string" && compilePattern(node.pattern, true)) out.pattern = node.pattern;
	if (typeof node.format === "string") {
		const note = `(format: ${node.format})`;
		out.description = typeof out.description === "string" ? `${out.description} ${note}` : note;
	}
	// Bounds: draft-04 booleans -> 2020-12 numbers.
	for (const [bound, exclusive] of [
		["minimum", "exclusiveMinimum"],
		["maximum", "exclusiveMaximum"],
	] as const) {
		const ex = node[exclusive];
		if (isFiniteNumber(ex)) out[exclusive] = ex;
		else if (ex === true && typeof node[bound] === "number") {
			out[exclusive] = node[bound];
			delete out[bound];
		}
	}
	if (Array.isArray(node.required)) out.required = node.required.filter((r) => typeof r === "string");
	if (isRecord(node.properties)) {
		const props: Record<string, unknown> = {};
		for (const [key, sub] of Object.entries(node.properties)) props[key] = sanitizeNode(sub, root, refStack, budget);
		out.properties = props;
	}
	if (isRecord(node.patternProperties)) {
		const props: Record<string, unknown> = {};
		for (const [pattern, sub] of Object.entries(node.patternProperties)) {
			if (compilePattern(pattern, true)) props[pattern] = sanitizeNode(sub, root, refStack, budget);
		}
		if (Object.keys(props).length) out.patternProperties = props;
	}
	if (node.additionalProperties === false) out.additionalProperties = false;
	else if (isRecord(node.additionalProperties)) {
		out.additionalProperties = sanitizeNode(node.additionalProperties, root, refStack, budget);
	}
	if (Array.isArray(node.prefixItems)) {
		out.prefixItems = node.prefixItems.map((sub) => sanitizeNode(sub, root, refStack, budget));
		if (node.items !== undefined && !Array.isArray(node.items)) out.items = sanitizeNode(node.items, root, refStack, budget);
	} else if (Array.isArray(node.items)) {
		out.prefixItems = node.items.map((sub) => sanitizeNode(sub, root, refStack, budget));
		if (node.additionalItems !== undefined) out.items = sanitizeNode(node.additionalItems, root, refStack, budget);
	} else if (node.items !== undefined) {
		out.items = sanitizeNode(node.items, root, refStack, budget);
	}
	// Codex rejects a tool schema with an array that has no `items` ("array schema must define items").
	// Omitted `items` means "any item" (also the open tail after prefixItems), so state it.
	if (budget.openItems && out.items === undefined) {
		const t = out.type;
		if (t === "array" || (Array.isArray(t) && t.includes("array")) || (t === undefined && out.prefixItems !== undefined)) {
			out.items = {};
		}
	}
	for (const key of ["allOf", "anyOf", "oneOf"] as const) {
		const list = node[key];
		if (Array.isArray(list) && list.length > 0) out[key] = list.map((sub) => sanitizeNode(sub, root, refStack, budget));
	}
	if (node.not !== undefined) out.not = sanitizeNode(node.not, root, refStack, budget);

	let result = out;
	if (inlined !== undefined) {
		const constraintKeys = Object.keys(out).filter((k) => !(ANNOTATION_KEYWORDS as readonly string[]).includes(k));
		result = constraintKeys.length === 0 ? { ...inlined, ...out } : { allOf: [inlined, out] };
	}
	return node.nullable === true && Object.keys(result).some((k) => !(ANNOTATION_KEYWORDS as readonly string[]).includes(k))
		? addNull(result)
		: result;
}

/** Make a sanitized schema also accept `null` (OpenAPI `nullable: true`). */
function addNull(schema: Record<string, unknown>): Record<string, unknown> {
	const simple =
		schema.type !== undefined && !["allOf", "anyOf", "oneOf", "not", "const"].some((k) => hasOwn(schema, k));
	if (simple) {
		const types = Array.isArray(schema.type) ? [...(schema.type as string[])] : [schema.type as string];
		if (!types.includes("null")) types.push("null");
		const next: Record<string, unknown> = { ...schema, type: types };
		if (Array.isArray(schema.enum) && !schema.enum.includes(null)) next.enum = [...schema.enum, null];
		return next;
	}
	const { title, description, ...rest } = schema;
	const wrapped: Record<string, unknown> = { anyOf: [rest, { type: "null" }] };
	if (title !== undefined) wrapped.title = title;
	if (description !== undefined) wrapped.description = description;
	return wrapped;
}

// ---------------------------------------------------------------------------------------------
// yield tool
// ---------------------------------------------------------------------------------------------

export interface YieldState {
	/** True once a call succeeded with valid `data` or reported an `error`. */
	submitted: boolean;
	/** Latest accepted payload (cleared when an `error` is reported). */
	data?: unknown;
	/** Failure reason from `{error}` (cleared when valid `data` is submitted). */
	error?: string;
	/** Number of REJECTED yield calls (invalid data, conflicting/missing fields). */
	attempts: number;
	/** Model-facing text of the most recent rejection, for the hub's failure message. */
	lastRejection?: string;
}

export function createYieldState(): YieldState {
	return { submitted: false, attempts: 0 };
}

/** Reset for a new parent-initiated turn on a kept-alive child (keeps `attempts`). */
export function resetYieldState(state: YieldState): void {
	state.submitted = false;
	state.data = undefined;
	state.error = undefined;
	state.lastRejection = undefined;
}

export interface YieldDetails {
	status: "success" | "error" | "rejected";
	data?: unknown;
	error?: string;
	issues?: string[];
}

type YieldCheck =
	| { kind: "data"; data: unknown }
	| { kind: "error"; error: string }
	| { kind: "rejected"; reason: string; issues: string[] };

/** Shared interpretation of raw `yield` arguments (strict-mode nulls, filler errors, JSON-string data). */
function interpretYieldArgs(schema: JsonSchema, raw: unknown): YieldCheck {
	let args = raw;
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			// handled below
		}
	}
	if (!isRecord(args)) {
		return { kind: "rejected", reason: `yield arguments must be an object, got ${describeValue(args)}.`, issues: [] };
	}
	const unknownKeys = Object.keys(args).filter((k) => k !== "data" && k !== "error" && args[k] != null);
	if (unknownKeys.length > 0) {
		return {
			kind: "rejected",
			reason: `unexpected top-level field(s) ${unknownKeys.map((k) => JSON.stringify(k)).join(", ")}. Only "data" and "error" are allowed — put the ENTIRE result inside "data".`,
			issues: [],
		};
	}
	let data: unknown = hasOwn(args, "data") ? args.data : undefined;
	let error: string | undefined;
	const rawError = args.error;
	if (rawError !== undefined && rawError !== null) {
		if (typeof rawError !== "string") {
			return { kind: "rejected", reason: `"error" must be a string, got ${describeValue(rawError)}.`, issues: [] };
		}
		const trimmed = rawError.trim();
		const hasData = data !== undefined && data !== null;
		if (trimmed && !(hasData && PLACEHOLDER_ERRORS.has(trimmed.toLowerCase()))) error = trimmed;
	}
	// Strict-mode providers send omitted optionals as null.
	if (data === null && error !== undefined) data = undefined;
	if (data !== undefined && error !== undefined) {
		return {
			kind: "rejected",
			reason: `"data" and "error" are mutually exclusive. Send {"data": ...} if the task succeeded, or only {"error": ${preview(error)}} if it failed.`,
			issues: [],
		};
	}
	if (error !== undefined) return { kind: "error", error };
	if (data === undefined) {
		return { kind: "rejected", reason: 'yield needs either "data" (your result) or "error" (why you could not finish).', issues: [] };
	}
	let issues = validateAgainstSchema(schema, data);
	let decoded = false;
	if (issues.length > 0 && typeof data === "string") {
		// A JSON-encoded payload string: adopt the decoded value when it is valid (lossless recovery).
		try {
			const parsed: unknown = JSON.parse(data);
			if (parsed !== null) {
				const parsedIssues = validateAgainstSchema(schema, parsed);
				if (parsedIssues.length === 0) {
					data = parsed;
					issues = [];
				} else if (hasRootTypeMiss(issues)) {
					// The schema takes no string here, so the string was meant as the decoded value:
					// report that value's violations, not "expected object, got string". A string the
					// schema accepts type-wise keeps its own violations (maxLength, ...).
					issues = parsedIssues;
					decoded = true;
				}
			}
		} catch {
			// not JSON: keep original issues
		}
	}
	if (issues.length > 0) {
		const reason = decoded
			? '"data" was sent as a JSON string; decoded, it still does not match the output schema. Send "data" as the decoded value (not a JSON string) with the issues below fixed.'
			: '"data" does not match the output schema.';
		return { kind: "rejected", reason, issues };
	}
	return { kind: "data", data };
}

function rejectionText(check: Extract<YieldCheck, { kind: "rejected" }>, attempt: number): string {
	const lines = [`yield rejected (attempt ${attempt}); nothing was submitted. ${check.reason}`];
	if (check.issues.length > 0) lines.push("Issues:", formatIssues(check.issues), "Fix every issue above and call yield again.");
	lines.push(FORMAT_HINT);
	return lines.join("\n");
}

function reject(state: YieldState, check: Extract<YieldCheck, { kind: "rejected" }>): string {
	state.attempts++;
	const text = rejectionText(check, state.attempts);
	state.lastRejection = text;
	return text;
}

const YIELD_DESCRIPTION = `Submit your final result to the agent that assigned this task and end your run. This is the ONLY way to return a result: your text replies are NOT delivered.
- Success: {"data": <your output>} — "data" MUST match the output schema (see this parameter's schema and your instructions).
- Failure: {"error": "<what you tried and the exact blocker>"} — only when genuinely blocked.
Never both; never put result fields at the top level or pass "data" as a JSON string. If the call is rejected, fix the listed issues and call yield again. A successful call ends your run — call it alone, as the last action.`;

/**
 * `yield` tool (label "Submit Result"). Params { data?: <schema>, error?: string }. Exactly one of
 * data/error. Invalid data → isError result listing issues + format hint (state otherwise
 * unchanged, attempts++). Valid → state.submitted=true, short ack with terminate: true so the run
 * ends. `error` → state.submitted=true, state.error set. Calling again after success overwrites.
 * `options.openArrayItems`: give arrays without `items` an explicit `items: {}` in the `data`
 * parameter schema (Codex refuses itemless arrays: "array schema must define items").
 */
export function createYieldTool(
	schema: JsonSchema,
	state: YieldState,
	options?: { openArrayItems?: boolean },
): ToolDefinition {
	const dataSchema: Record<string, unknown> = { ...toToolSchema(schema, options?.openArrayItems === true) };
	const intro = "Your final result; MUST match the output schema.";
	dataSchema.description = typeof dataSchema.description === "string" ? `${intro} ${dataSchema.description}` : intro;

	const parameters = Type.Object(
		{
			data: Type.Optional(Type.Unsafe<unknown>(dataSchema)),
			error: Type.Optional(
				Type.String({ description: "Failure reason (what you tried, the exact blocker). Mutually exclusive with data." }),
			),
		},
		{ additionalProperties: false },
	);

	const tool: ToolDefinition<typeof parameters, YieldDetails> = {
		name: YIELD_TOOL_NAME,
		label: "Submit Result",
		description: YIELD_DESCRIPTION,
		promptSnippet: 'Submit the final result ({"data": ...} matching the output schema, or {"error": "..."}); ends the run',
		promptGuidelines: [
			"Finish by calling yield with data matching the output schema; plain-text final answers are discarded.",
		],
		parameters,
		executionMode: "sequential",
		// Runs on raw arguments before pi's TypeBox validation: normalize and give the model our
		// issue list (thrown errors become isError tool results; execute is skipped).
		prepareArguments(args: unknown) {
			const check = interpretYieldArgs(schema, args);
			if (check.kind === "rejected") throw new Error(reject(state, check));
			return check.kind === "data" ? { data: check.data } : { error: check.error };
		},
		async execute(_toolCallId, params) {
			const check = interpretYieldArgs(schema, params);
			if (check.kind === "rejected") {
				return {
					content: [{ type: "text", text: reject(state, check) }],
					details: { status: "rejected", issues: check.issues },
					isError: true,
				};
			}
			state.submitted = true;
			state.lastRejection = undefined;
			if (check.kind === "error") {
				state.error = check.error;
				state.data = undefined;
				return {
					content: [{ type: "text", text: "Failure reported to the agent that assigned this task. Your run is over; do not call any more tools." }],
					details: { status: "error", error: check.error },
					terminate: true,
				};
			}
			state.data = check.data;
			state.error = undefined;
			return {
				content: [{ type: "text", text: "Result submitted. Your run is over; do not call any more tools." }],
				details: { status: "success", data: check.data },
				terminate: true,
			};
		},
	};
	// Erase the param generic (renderCall is contravariant in it), like any customTools entry.
	return tool as unknown as ToolDefinition;
}

// ---------------------------------------------------------------------------------------------
// Prompt text
// ---------------------------------------------------------------------------------------------

function fenced(text: string, lang: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${lang}\n${text}\n${fence}`;
}

function prettySchema(schema: JsonSchema): string {
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "{}";
	}
}

function isUnconstrained(schema: JsonSchema): boolean {
	return Object.keys(schema).every((k) => (ANNOTATION_KEYWORDS as readonly string[]).includes(k) || k === "$schema");
}

/** System prompt section replacing the normal completion rules for structured children. */
export function structuredCompletionPrompt(schema: JsonSchema): string {
	const schemaBlock = isUnconstrained(schema)
		? "Output schema for `data`: any JSON value (no constraints). Prefer an object with clearly named fields."
		: `Output schema for \`data\` — your \`yield\` call MUST use exactly this shape:\n${fenced(prettySchema(schema), "json")}`;
	return `⁂ Completion
No TODO tracking, no progress updates. Execute; report your result with the \`yield\` tool.
NEVER run builds, tests, linters, formatters or smoke runs unless your assignment says to; the agent that assigned this task verifies once all subagents land. When done, name the checks to run.

While work remains, you MUST continue with another tool call — investigate, edit. When the work is done, call \`yield\`:
- Success: \`{"data": <value>}\` — \`data\` MUST match the output schema below. The schema's fields go INSIDE \`data\`, NEVER at the top level and NEVER as a stringified JSON blob.
- Failure: \`{"error": "<what you tried and the exact blocker>"}\`. Never both.

\`yield\` is your ONLY way to return a result. Your final text message is NOT the result and is NOT delivered to the agent that assigned this task: NEVER write the result (JSON or prose) in a plain message instead of calling \`yield\`. A run that ends without a successful \`yield\` is re-prompted and ultimately fails.
ROLE instructions about what your final message or report should contain describe what goes into \`data\`.
If \`yield\` rejects a submission, fix every listed issue and call it again. A successful \`yield\` ends your run immediately: call it alone, as your last action.

${schemaBlock}

Giving up is a last resort. If truly blocked, call \`yield\` with \`{"error": ...}\` describing what you tried and the exact blocker.
You NEVER give up due to uncertainty, missing information obtainable via tools or repo context, or needing a design decision you can derive yourself.

You MUST keep going until this ticket is closed. This matters.`;
}

/** User-turn reminder when a run ended without a successful yield (attempt is 1-based). */
export function yieldReminder(schema: JsonSchema, attempt: number): string {
	const n = Math.max(1, Math.floor(attempt));
	const isFinal = n >= MAX_YIELD_REMINDERS;
	let compact: string;
	try {
		compact = JSON.stringify(schema);
	} catch {
		compact = "{}";
	}
	return `<system-reminder>
Your last turn ended without a successful \`yield\` call (reminder ${n} of ${MAX_YIELD_REMINDERS}). Text replies are NOT delivered to the agent that assigned this task; only \`yield\` returns your result.

First applicable:
1. **Work remains** — continue with your next tool call. This reminder is NOT a stop signal.
2. **Work done** — call \`yield\` now with \`{"data": <value matching the output schema>}\`; the result goes inside \`data\`, not in a message.
3. **Genuinely blocked** by a concrete, nameable obstacle — call \`yield\` with \`{"error": "<what you tried and the exact blocker>"}\`. This reminder is not a blocker; NEVER cite it as one.
${isFinal ? "\nThis is the FINAL reminder: if this turn ends without a successful `yield`, the task fails.\n" : ""}
NEVER end this turn with text only.

Output schema for \`data\`: ${isUnconstrained(schema) ? "any JSON value" : compact}
</system-reminder>`;
}

/** Pretty JSON for the parent-facing <task-result> envelope, truncated to maxChars with a marker. */
export function formatStructuredData(data: unknown, maxChars: number = DEFAULT_STRUCTURED_DATA_MAX_CHARS): string {
	let text: string;
	try {
		text = JSON.stringify(data, null, 2) ?? "null";
	} catch {
		text = String(data);
	}
	if (!(maxChars > 0) || text.length <= maxChars) return text;
	let cut = text.slice(0, maxChars);
	const nl = cut.lastIndexOf("\n");
	if (nl >= maxChars / 2) cut = cut.slice(0, nl);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return `${cut}\n… [structured output truncated: showing ${cut.length} of ${text.length} chars]`;
}

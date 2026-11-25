import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type EngineOptions, NgramEngine } from "./engine.ts";
import { DEFAULT_PARAMS } from "./model.ts";
import { writeAtomic } from "./store.ts";
import { decodeWebPrior, type WebPrior } from "./web.ts";

const SNAPSHOT_FILE = "ngram.snapshot";
const CONFIDENCE_TOLERANCE = 1e-6;
const INEXACT_LIMIT = 0.001;
const MISMATCHES_SHOWN = 20;
const BENCH_WARMUP_OPS = 2_000;
const EXPLAIN_ROWS = 12;

const USAGE = `usage: replay.ts <script.jsonl> [--state-dir DIR] [--show-threshold X|-inf] [--prior FILE]
                 [--expect FILE] [--explain] [--bench]
       replay.ts --info

Prints one JSON line per operation, as the oracle does. X is a float, or -inf to disable gating
(default: the engine's 0.15). Without --state-dir a fresh temp directory is used and removed on exit;
with it, DIR/ngram.snapshot is restored when present and written by persist / reopen.
--expect FILE  compare with an oracle output file instead of printing the lines: summary, the first
               ${MISMATCHES_SHOWN} mismatches, exit status 1 on failure
--explain      with --expect: the port's candidate table for each mismatching complete, on stderr
--bench        print timings and memory instead of the lines
--info         the engine's default params (the oracle's field names) and Node's Unicode version`;

interface Options {
	script: string | undefined;
	stateDir: string | undefined;
	showThreshold: number | undefined;
	prior: string | undefined;
	expect: string | undefined;
	explain: boolean;
	bench: boolean;
	info: boolean;
}

interface CandidateRow {
	word: string;
	value: number;
	c2: number;
	pw: number;
	c3: number;
	cache: number;
	session: number;
}
type Explain = (before: string, prefix: string) => CandidateRow[];

class ReplayError extends Error {}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseThreshold(text: string): number {
	if (/^-inf(inity)?$/i.test(text)) return Number.NEGATIVE_INFINITY;
	const value = text.trim() === "" ? Number.NaN : Number(text);
	if (Number.isNaN(value)) throw new ReplayError(`--show-threshold: ${JSON.stringify(text)} is not a float or -inf`);
	return value;
}

function parseArgs(argv: readonly string[]): Options {
	const options: Options = {
		script: undefined,
		stateDir: undefined,
		showThreshold: undefined,
		prior: undefined,
		expect: undefined,
		explain: false,
		bench: false,
		info: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const name = eq < 0 ? arg : arg.slice(0, eq);
		const value = (): string => {
			if (eq >= 0) return arg.slice(eq + 1);
			const next = argv[++i];
			if (next === undefined) throw new ReplayError(`${name} needs a value`);
			return next;
		};
		switch (name) {
			case "--state-dir":
				options.stateDir = value();
				break;
			case "--show-threshold":
				options.showThreshold = parseThreshold(value());
				break;
			case "--prior":
				options.prior = value();
				break;
			case "--expect":
				options.expect = value();
				break;
			case "--explain":
				options.explain = true;
				break;
			case "--bench":
				options.bench = true;
				break;
			case "--info":
				options.info = true;
				break;
			case "-h":
			case "--help":
				throw new ReplayError(USAGE);
			default:
				if (arg.startsWith("--")) throw new ReplayError(`unknown option ${arg}\n${USAGE}`);
				if (options.script !== undefined) throw new ReplayError(`unexpected argument ${arg}\n${USAGE}`);
				options.script = arg;
		}
	}
	if (!options.info && options.script === undefined) throw new ReplayError(USAGE);
	return options;
}

function formatF32(value: number): string {
	const single = Math.fround(value);
	if (!Number.isFinite(single)) throw new ReplayError(`engine returned a non-finite confidence ${value}`);
	let digits = single.toPrecision(9);
	for (let precision = 1; precision < 9; precision++) {
		const candidate = single.toPrecision(precision);
		if (Math.fround(Number(candidate)) === single) {
			digits = candidate;
			break;
		}
	}
	const match = /^(-?)(\d)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(digits);
	if (!match) return digits;
	const [, sign, lead, rest = "", exponent = "0"] = match;
	const mantissa = lead + rest;
	const point = 1 + Number(exponent);
	let text: string;
	if (point <= 0) text = `0.${"0".repeat(-point)}${mantissa}`;
	else if (point >= mantissa.length) text = mantissa + "0".repeat(point - mantissa.length);
	else text = `${mantissa.slice(0, point)}.${mantissa.slice(point)}`;
	if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
	return sign + text;
}

const OK_LINE = '{"ok":true}';
const NULL_LINE = '{"suffix":null,"confidence":null}';

function completeLine(suggestion: { suffix: string; confidence: number } | null): string {
	if (!suggestion) return NULL_LINE;
	return `{"suffix":${JSON.stringify(suggestion.suffix)},"confidence":${formatF32(suggestion.confidence)}}`;
}

function printInfo(): void {
	const p = DEFAULT_PARAMS;
	const info = {
		show_threshold: Number(formatF32(p.showThreshold)),
		paste_weight: Number(formatF32(p.pasteWeight)),
		mu1: p.mu1,
		d2: p.d2,
		mu2: p.mu2,
		d3: p.d3,
		mu3: p.mu3,
		web_bigram: p.webBigram,
		top_k: p.topK,
		min_count: p.minCount,
		canonicalize: p.canonicalize,
		canon_max_count: p.canonMaxCount,
		canon_ratio: p.canonRatio,
		case_prior: p.casePrior,
		case_strength: p.caseStrength,
		cache_weight: p.cacheWeight,
		cache_decay: p.cacheDecay,
		cache_context_boost: p.cacheContextBoost,
		cache_window: p.cacheWindow,
		session_weight: p.sessionWeight,
		session_prompts: p.sessionPrompts,
		node_unicode_version: process.versions.unicode,
	};
	process.stdout.write(`${JSON.stringify(info)}\n`);
}

type MismatchKind = "suffix" | "gate" | "confidence" | "shape" | "missing";

interface Mismatch {
	line: number;
	kind: MismatchKind;
	op: string;
	expected: string;
	actual: string;
}

class Comparison {
	readonly expected: string[];
	completes = 0;
	completesMatched = 0;
	others = 0;
	othersMatched = 0;
	inexact = 0;
	readonly kinds: Record<MismatchKind, number> = { suffix: 0, gate: 0, confidence: 0, shape: 0, missing: 0 };
	readonly mismatches: Mismatch[] = [];

	constructor(file: string) {
		this.expected = readLines(file);
	}

	check(
		line: number,
		op: Record<string, unknown>,
		actual: string,
		suggestion: { suffix: string; confidence: number } | null,
	): Mismatch | undefined {
		const isComplete = op.op === "complete";
		if (isComplete) this.completes++;
		else this.others++;
		const expected = this.expected[line - 1];
		let kind: MismatchKind | undefined;
		if (expected === undefined) kind = "missing";
		else if (isComplete) kind = this.compareComplete(expected, suggestion);
		else if (expected.trim() !== OK_LINE) kind = "shape";
		if (kind === undefined) {
			if (isComplete) this.completesMatched++;
			else this.othersMatched++;
			return undefined;
		}
		this.kinds[kind]++;
		const mismatch: Mismatch = { line, kind, op: describeOp(op), expected: expected ?? "(no line)", actual };
		if (this.mismatches.length < MISMATCHES_SHOWN) this.mismatches.push(mismatch);
		return mismatch;
	}

	private compareComplete(
		expected: string,
		suggestion: { suffix: string; confidence: number } | null,
	): MismatchKind | undefined {
		let want: unknown;
		try {
			want = JSON.parse(expected);
		} catch {
			return "shape";
		}
		if (typeof want !== "object" || want === null || !("suffix" in want) || !("confidence" in want)) return "shape";
		const { suffix, confidence } = want as { suffix: unknown; confidence: unknown };
		const wantNull = suffix === null && confidence === null;
		if (!wantNull && (typeof suffix !== "string" || typeof confidence !== "number")) return "shape";
		if (wantNull || !suggestion) return wantNull && !suggestion ? undefined : "gate";
		if (suggestion.suffix !== suffix) return "suffix";
		const port = Math.fround(suggestion.confidence);
		const oracle = Math.fround(confidence as number);
		if (!(Math.abs(port - oracle) <= CONFIDENCE_TOLERANCE)) return "confidence";
		if (port !== oracle) this.inexact++;
		return undefined;
	}

	report(scriptFile: string, expectFile: string, lines: number, out: string[]): boolean {
		const mismatched = this.completes - this.completesMatched + (this.others - this.othersMatched);
		const countsMatch = lines === this.expected.length;
		const inexactShare = this.completes > 0 ? this.inexact / this.completes : 0;
		const inexactOk = inexactShare <= INEXACT_LIMIT;
		const pass = mismatched === 0 && countsMatch && inexactOk;
		out.push(`replay: ${scriptFile} vs ${expectFile}\n`);
		out.push(`  lines     ${lines} (expected file: ${this.expected.length})${countsMatch ? "" : "  <-- line counts differ"}\n`);
		out.push(
			`  complete  ${this.completesMatched}/${this.completes} match` +
				`  (mismatches: suffix ${this.kinds.suffix}, null/non-null ${this.kinds.gate}, confidence ${this.kinds.confidence})\n`,
		);
		out.push(`  other     ${this.othersMatched}/${this.others} match\n`);
		if (this.kinds.shape + this.kinds.missing > 0) {
			out.push(`  expected  ${this.kinds.shape} lines of another shape, ${this.kinds.missing} lines missing\n`);
		}
		out.push(
			`  f32       ${this.inexact} passing completions not bit-equal as f32` +
				` (${(inexactShare * 100).toFixed(3)} % of completions, limit ${INEXACT_LIMIT * 100} %)` +
				`${inexactOk ? "" : "  <-- over the limit"}\n`,
		);
		out.push(`  result    ${pass ? "PASS" : "FAIL"}\n`);
		if (this.mismatches.length > 0) {
			out.push(`first ${this.mismatches.length} of ${mismatched} mismatches:\n`);
			for (const mismatch of this.mismatches) {
				out.push(`  line ${mismatch.line} [${mismatch.kind}] ${mismatch.op}\n`);
				out.push(`    expected ${mismatch.expected}\n`);
				out.push(`    got      ${mismatch.actual}\n`);
			}
		}
		return pass;
	}
}

function readLines(file: string): string[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		throw new ReplayError(`open ${file}: ${errorText(error)}`);
	}
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function describeOp(op: Record<string, unknown>): string {
	if (op.op !== "complete") return String(op.op);
	const before = String(op.before);
	const tail = before.length > 60 ? `…${before.slice(-60)}` : before;
	return `complete before=${JSON.stringify(tail)} (${before.length} units) prefix=${JSON.stringify(op.prefix)}`;
}

function explainMismatch(engine: NgramEngine, mismatch: Mismatch, before: string, prefix: string): void {
	const explain = (engine as unknown as { explain?: Explain }).explain;
	const head = `replay: line ${mismatch.line} [${mismatch.kind}] expected ${mismatch.expected} got ${mismatch.actual}\n`;
	if (typeof explain !== "function") {
		process.stderr.write(`${head}  (no candidate table: NgramEngine.explain is not implemented)\n`);
		return;
	}
	let rows: CandidateRow[];
	try {
		rows = [...explain.call(engine, before, prefix)];
	} catch (error) {
		process.stderr.write(`${head}  (candidate table failed: ${errorText(error)})\n`);
		return;
	}
	// Preserve candidate enumeration order when scores tie.
	rows.sort((a, b) => b.value - a.value);
	const number = (value: unknown): string => (typeof value === "number" ? String(value) : "-").padEnd(24);
	const columns = ["value", "c2", "pw", "c3", "cache", "session"].map((name) => name.padEnd(24)).join("");
	let text = `${head}  ${"word".padEnd(20)}${columns}\n`;
	for (const row of rows.slice(0, EXPLAIN_ROWS)) {
		const cells = [row.value, row.c2, row.pw, row.c3, row.cache, row.session].map(number).join("");
		text += `  ${JSON.stringify(row.word).padEnd(20)}${cells}\n`;
	}
	if (rows.length > EXPLAIN_ROWS) text += `  … ${rows.length - EXPLAIN_ROWS} more\n`;
	if (rows.length >= 2 && rows[0].value > 0) {
		text += `  top two: relative difference ${Math.abs(rows[0].value - rows[1].value) / rows[0].value}\n`;
	}
	process.stderr.write(text);
}

class Samples {
	private values: number[] = [];

	add(ms: number): void {
		this.values.push(ms);
	}

	line(name: string): string {
		const sorted = Float64Array.from(this.values).sort();
		if (sorted.length === 0) return `  ${name.padEnd(20)}n=0\n`;
		const at = (q: number): string =>
			`${(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 1000).toFixed(1)} µs`;
		const max = `${(sorted[sorted.length - 1] * 1000).toFixed(1)} µs`;
		return `  ${name.padEnd(20)}n=${sorted.length}  p50 ${at(0.5)}  p90 ${at(0.9)}  p99 ${at(0.99)}  max ${max}\n`;
	}
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function stringField(op: Record<string, unknown>, name: string): string {
	const value = op[name];
	if (typeof value !== "string") throw new ReplayError(`missing string field ${JSON.stringify(name)}`);
	return value;
}

function booleanField(op: Record<string, unknown>, name: string): boolean {
	const value = op[name];
	if (typeof value !== "boolean") throw new ReplayError(`missing boolean field ${JSON.stringify(name)}`);
	return value;
}

function replay(options: Options, script: string, out: string[]): boolean {
	const priorFile = options.prior ?? path.resolve(path.dirname(process.argv[1]), "..", "data", "web-prior.bin.zst");
	const engineOptions: EngineOptions = options.showThreshold === undefined ? {} : { showThreshold: options.showThreshold };

	let started = performance.now();
	let web: WebPrior;
	try {
		web = decodeWebPrior(fs.readFileSync(priorFile));
	} catch (error) {
		throw new ReplayError(`web prior ${priorFile}: ${errorText(error)}`);
	}
	const priorMs = performance.now() - started;

	let tempDir: string | undefined;
	const stateDir = options.stateDir ?? (tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "word-predict-replay-")));
	const snapshotFile = path.join(stateDir, SNAPSHOT_FILE);
	const open = (): NgramEngine => {
		let snapshot: Buffer | undefined;
		try {
			snapshot = fs.readFileSync(snapshotFile);
		} catch (error) {
			if ((error as { code?: unknown }).code !== "ENOENT") {
				throw new ReplayError(`open n-gram engine on ${stateDir}: ${errorText(error)}`);
			}
		}
		try {
			return snapshot ? NgramEngine.restore(web, snapshot, engineOptions) : new NgramEngine(web, engineOptions);
		} catch (error) {
			throw new ReplayError(`open n-gram engine on ${stateDir}: ${errorText(error)}`);
		}
	};
	const persist = (engine: NgramEngine): void => writeAtomic(stateDir, SNAPSHOT_FILE, engine.snapshot());

	try {
		started = performance.now();
		let engine = open();
		const openMs = performance.now() - started;
		const restoredAtStart = fs.existsSync(snapshotFile);

		const comparison = options.expect === undefined ? undefined : new Comparison(options.expect);
		const printLines = !comparison && !options.bench;
		const completeMs = new Samples();
		const observeMs = new Samples();
		let warm = false;

		const lines = readLines(script);
		let failure: string | undefined;
		let executed = 0;
		for (let index = 0; index < lines.length; index++) {
			const number = index + 1;
			try {
				let op: unknown;
				try {
					op = JSON.parse(lines[index]);
				} catch {
					throw new ReplayError("invalid JSON");
				}
				if (typeof op !== "object" || op === null || Array.isArray(op)) throw new ReplayError('missing string field "op"');
				const fields = op as Record<string, unknown>;
				const name = stringField(fields, "op");
				if (index === BENCH_WARMUP_OPS) warm = true;
				let line = OK_LINE;
				let suggestion: { suffix: string; confidence: number } | null = null;
				switch (name) {
					case "observe": {
						const text = stringField(fields, "text");
						const t = performance.now();
						engine.observe(text);
						if (warm) observeMs.add(performance.now() - t);
						break;
					}
					case "complete": {
						const before = stringField(fields, "before");
						const prefix = stringField(fields, "prefix");
						const t = performance.now();
						suggestion = engine.complete(before, prefix);
						if (warm) completeMs.add(performance.now() - t);
						line = completeLine(suggestion);
						break;
					}
					case "feedback":
						engine.feedback(
							stringField(fields, "before"),
							stringField(fields, "prefix"),
							stringField(fields, "suggestion"),
							booleanField(fields, "accepted"),
						);
						break;
					case "persist":
						persist(engine);
						break;
					case "reopen":
						persist(engine);
						engine = open();
						break;
					default:
						throw new ReplayError(`unknown op ${JSON.stringify(name)}`);
				}
				executed++;
				if (printLines) out.push(`${line}\n`);
				const mismatch = comparison?.check(number, fields, line, suggestion);
				if (mismatch && options.explain && name === "complete") {
					explainMismatch(engine, mismatch, String(fields.before), String(fields.prefix));
				}
			} catch (error) {
				const text = error instanceof ReplayError || !(error instanceof Error) ? errorText(error) : (error.stack ?? error.message);
				failure = `line ${number}: ${text}`;
				break;
			}
		}

		let pass = failure === undefined;
		if (comparison) pass = comparison.report(script, options.expect ?? "", executed, out) && pass;
		if (options.bench) {
			const memory = process.memoryUsage();
			out.push(`bench: ${script}\n`);
			out.push(`  ${"prior decode".padEnd(20)}${priorMs.toFixed(1)} ms\n`);
			out.push(`  ${(restoredAtStart ? "restore at start" : "new Model").padEnd(20)}${openMs.toFixed(1)} ms\n`);
			out.push(completeMs.line("complete"));
			out.push(observeMs.line("observe"));
			if (lines.length <= BENCH_WARMUP_OPS) {
				out.push(`  (no samples: the script has no more than the ${BENCH_WARMUP_OPS} warm-up operations)\n`);
			}
			started = performance.now();
			const snapshot = engine.snapshot();
			out.push(`  ${"snapshot encode".padEnd(20)}${(performance.now() - started).toFixed(1)} ms, ${snapshot.length} bytes\n`);
			started = performance.now();
			NgramEngine.restore(web, snapshot, engineOptions);
			out.push(`  ${"restore".padEnd(20)}${(performance.now() - started).toFixed(1)} ms\n`);
			out.push(
				`  ${"memory".padEnd(20)}rss ${megabytes(memory.rss)}, heap used ${megabytes(memory.heapUsed)}` +
					`, heap total ${megabytes(memory.heapTotal)}, array buffers ${megabytes(memory.arrayBuffers)} (before the snapshot / restore timing)\n`,
			);
		}
		if (failure !== undefined) throw new ReplayError(failure);
		return pass;
	} finally {
		if (tempDir !== undefined) fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

function main(): void {
	const out: string[] = [];
	let pass = false;
	let failure: string | undefined;
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.info) {
			printInfo();
			pass = true;
		} else {
			pass = replay(options, options.script ?? "", out);
		}
	} catch (error) {
		if (error instanceof ReplayError) failure = error.message;
		else failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
	}
	if (out.length > 0) process.stdout.write(out.join(""));
	if (failure !== undefined) process.stderr.write(`replay: ${failure}\n`);
	// Let piped output drain before exiting.
	process.exitCode = pass ? 0 : 1;
}

main();

/**
 * Git-worktree isolation for subagents (modeled on oh-my-pi's task/worktree.ts, much smaller).
 *
 * Lifecycle (driven by the hub):
 *   createWorktree(parentCwd, id)  -> detached worktree whose first commit (baseCommit) is an exact
 *                                     snapshot of the parent's *current working state*
 *   ...child runs with cwd = wt.cwd...
 *   mergeDelta(wt)                 -> child's changes since baseCommit applied to the parent's working
 *                                     tree (never staged/committed); baseline advances on success
 *                                     (measured from the fork point if the child moved HEAD, see below)
 *   removeWorktree(wt) / removeAllWorktrees()
 *
 * Baseline technique: instead of replaying `git diff HEAD` + copying untracked files, the parent's
 * working state is captured as a git tree through a *temporary index* (copy of the real index so
 * stat caches stay valid, then `GIT_INDEX_FILE=tmp git add -A --sparse` + `write-tree`). That
 * reproduces staged + unstaged + deleted + untracked-non-ignored files, modes, symlinks and binaries
 * exactly, without touching the parent's index, working tree, refs or stash (only new objects are
 * written to the shared object store). The tree is committed (`commit-tree`, parent = HEAD) and that
 * commit is checked out with `git worktree add --detach`, so it *is* the worktree's HEAD/baseCommit.
 * The same snapshot routine (run inside the worktree) yields the delta tree ("theirs"); the delta
 * patch is `git diff-tree --binary baseCommit theirs`.
 *
 * Moved HEAD: the delta is state-based (baseCommit tree -> worktree snapshot) wherever the agent's own
 * commits went, as long as baseCommit is still an ancestor of the worktree's HEAD. If it is not (the
 * agent switched / checked out / reset to another commit, amended or rebased the baseline), the
 * working tree may no longer hold what baseCommit added on top of that history - notably the spawner's
 * uncommitted work, which exists only inside baseCommit - and a delta from the baseline would revert
 * all of it in the parent. Whether it does is decided per path, for the paths that differ between the
 * fork point (`git merge-base baseCommit HEAD`) and baseCommit (see deltaOrigin):
 *   - the snapshot or HEAD's commit still holds the baseline's version (`commit --amend`, `reset
 *     --soft/--mixed`, rebase; whatever the agent then did to other files): state-based as usual, so the
 *     spawner's own work is neither offered again nor reverted;
 *   - the snapshot is back at the fork's version (`reset --hard`, `switch`, `checkout`): an effect of
 *     moving HEAD, not part of the delta;
 *   - the snapshot holds something else: it builds on the baseline if merging it with the baseline on
 *     top of the fork changes nothing (it already contains what the baseline added; state-based), on
 *     the fork if that merge is clean but adds something (measured from the fork's version, so the
 *     3-way merge below keeps both sides), and is undecidable if that merge conflicts.
 * The delta (patch, files, stat) is measured from the resulting origin (DeltaMeta.from: the baseline
 * with the fork's version at the paths measured from the fork); result messages say that HEAD had
 * moved. An undecidable path and a HEAD without any common ancestor are never merged automatically
 * (conflict, parent untouched; in the latter case the saved patch holds the agent's files as additions
 * only, so applying it cannot delete anything). An unborn HEAD (`checkout --orphan`) and content-level
 * changes while HEAD still descends from the baseline (`git checkout <old> -- .`, `git restore
 * --source`) stay state-based. advanceBaseline() records a moved HEAD as second parent of the new
 * baseline commit, so a follow-up run that returns to that commit (`git switch <its branch>`) is
 * measured from it and neither reverts nor re-delivers what was already merged.
 *
 * Apply strategy (exact, never fuzzy, no `git apply` into the parent): the plan is a set of
 * per-path transitions pre-blob -> post-blob. Every path of the parent working tree is first compared
 * with `pre` as git sees it (`git hash-object --stdin-paths`, so eol conversion / clean filters such as
 * git-lfs apply exactly as for `git add`; a directory counts as "no blob").
 *   - all touched paths still equal the baseline (or already equal the child's version): the plan is
 *     baseline -> child for the paths that still need it.
 *   - some paths diverged: 3-way merge entirely in object space with `git merge-tree --write-tree
 *     --merge-base=<baseCommit or fork point> <parentSnapshot> <theirs>` (git >= 2.40); the parent index is
 *     never touched (unlike `git apply --3way`). A conflict-free result gives the plan parentSnapshot -> merged.
 *   Execution writes whole blobs (`git cat-file --filters --path=<p>`, i.e. smudged like a checkout)
 *   via temp file + rename, deletions deepest-first then writes shallowest-first (file<->dir and
 *   symlink transitions), never through a symlinked ancestor. Each path is re-verified byte-for-byte
 *   right before it is written and every path is re-checked afterwards. On any failure (concurrent
 *   edit, EACCES/ENOSPC, ...) already written paths are rolled back to their exact previous bytes - but
 *   only if they still hold exactly what the merge wrote; anything else is left alone (a copy is
 *   saved) and reported. So "applied" always means the parent's files now hold the intended content.
 *   Anything else is a "conflict" (parent untouched) or "error" (details per file); patch saved,
 *   worktree kept.
 *
 * Storage: worktrees, saved patches, rescued copies and temp files live in a private per-user directory
 * ($PI_TASK_WORKTREES_DIR, else $XDG_CACHE_HOME/pi/task-worktrees, else ~/.cache/pi/task-worktrees),
 * owner-checked; directories created here are 0700 (an existing directory is never chmodded - if it is
 * accessible by others a private `.pi-task-worktrees/` subdirectory is used); files are 0600 + O_EXCL.
 *
 * Limitations: submodules and nested (non-submodule) repositories are not reproduced in the worktree
 * and their changes are ignored; ignored files (node_modules, build output) are neither copied in
 * nor merged back; only git's file modes are reproduced (exec bit / symlink, not e.g. 0600) and empty
 * directories are not. Writes go through `.pi-merge-*` temp files next to their targets (left behind
 * only if the process dies mid-merge). In sparse checkouts the worktree
 * inherits the parent's sparse patterns; changes to files outside the parent's cone (not present in
 * its working tree) are reported as conflicts, and deleting outside-cone files is not detected.
 * Worktree/Delta objects carry hidden metadata (WeakMaps): pass the same objects back; `baseCommit`
 * is updated in place on a successful merge. Nothing is cleaned up automatically (no exit hooks).
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface Worktree {
	/** Top-level of the parent checkout (where merges are applied). */
	repoRoot: string;
	/** Worktree directory. */
	path: string;
	/** Child cwd inside the worktree (parent cwd mapped relative to repoRoot). */
	cwd: string;
	/** Commit in the worktree representing the last merged state (baseline). */
	baseCommit: string;
}

export interface Delta {
	/** Binary-safe `git diff` (a/ b/ prefixes, relative to the repo root). Empty string if no changes. */
	patch: string;
	/** Changed paths relative to the repo root. */
	files: string[];
	/** `git diff --stat` summary (empty if no changes). */
	stat: string;
}

export interface MergeResult {
	status: "applied" | "empty" | "conflict" | "error";
	message: string;
	files: string[];
	patchFile?: string;
}

/** Refuse to snapshot a parent whose untracked (non-ignored) content exceeds this. */
export const MAX_UNTRACKED_BYTES = 200 * 1024 * 1024;

/** Files larger than this are not merged automatically (their bytes are held in memory for rollback). */
export const MAX_MERGE_FILE_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const PI_IDENT = { name: "pi", email: "pi@localhost" };

interface WorktreeMeta {
	/** Shared git dir (absolute), used when repoRoot is gone at removal time. */
	commonDir: string;
	/** Lock key (realpath of repoRoot). */
	lockKey: string;
}

interface DeltaMeta {
	/** Exact patch bytes (the string form may be lossy for non-UTF-8 text). */
	raw: Buffer;
	/** Snapshot tree of the worktree the delta was computed against ("theirs"). */
	tree: string;
	/** baseCommit the delta belongs to (staleness check; the baseline that advances on a merge). */
	base: string;
	/**
	 * What the delta is measured from: `base`, or - when the agent moved HEAD off the baseline - the
	 * fork point `git merge-base base HEAD`, or a synthetic commit holding the baseline with the fork's
	 * version at some paths (see deltaOrigin). A commit, except for `unrelated`.
	 */
	from: string;
	/** The fork point, when at least one path is measured from it (`from` differs from `base`). */
	fork?: string;
	/** Paths that could be built on either the baseline or the fork: never merged automatically. */
	unsure?: string[];
	/** HEAD shares no history with `base`: `from` is the empty tree; never merged automatically. */
	unrelated?: boolean;
}

const worktreeMeta = new WeakMap<Worktree, WorktreeMeta>();
const deltaMeta = new WeakMap<Delta, DeltaMeta>();
/** Worktrees created by this process and not yet removed/retained (creation order). */
const liveWorktrees = new Set<Worktree>();
/** Per-repoRoot async mutex chains. */
const repoLocks = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------------------------
// git runner
// ---------------------------------------------------------------------------------------------

class GitError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly code: number | null,
		readonly stderr: string,
	) {
		super(`git ${args.join(" ")} failed${code === null ? "" : ` (exit ${code})`}: ${stderr.trim() || "no output"}`);
		this.name = "GitError";
	}
}

class GitMissingError extends Error {
	constructor() {
		super("Isolated tasks require git, but the `git` executable was not found on PATH.");
		this.name = "GitMissingError";
	}
}

interface GitOptions {
	cwd: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
	/** Resolve (instead of throwing) on non-zero exit. */
	allowFail?: boolean;
	/** Data written to stdin. */
	input?: Buffer | string;
	/** Override the stdout/stderr buffer cap. */
	maxBuffer?: number;
}

interface GitResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

/** Env vars that would redirect git away from the cwd-discovered repository. */
const SCRUBBED_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
];

const BASE_CONFIG = [
	"-c",
	"core.quotepath=off",
	"-c",
	"color.ui=false",
	"-c",
	`core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
	"-c",
	"advice.addEmbeddedRepo=false",
	"-c",
	"advice.updateSparsePath=false",
	"-c",
	"core.splitIndex=false",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"commit.gpgSign=false",
	"-c",
	`user.name=${PI_IDENT.name}`,
	"-c",
	`user.email=${PI_IDENT.email}`,
];

function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of SCRUBBED_ENV) delete env[key];
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GIT_EDITOR = ":";
	env.GIT_PAGER = "cat";
	env.LC_ALL = "C";
	env.LANGUAGE = "C";
	env.GIT_AUTHOR_NAME = PI_IDENT.name;
	env.GIT_AUTHOR_EMAIL = PI_IDENT.email;
	env.GIT_COMMITTER_NAME = PI_IDENT.name;
	env.GIT_COMMITTER_EMAIL = PI_IDENT.email;
	return extra ? Object.assign(env, extra) : env;
}

function git(args: string[], opts: GitOptions): Promise<GitResult> {
	return new Promise<GitResult>((resolve, reject) => {
		if (opts.signal?.aborted) {
			reject(abortError(opts.signal));
			return;
		}
		const child = execFile(
			"git",
			[...BASE_CONFIG, ...args],
			{
				cwd: opts.cwd,
				env: gitEnv(opts.env),
				encoding: "buffer",
				maxBuffer: opts.maxBuffer ?? MAX_OUTPUT_BYTES,
				signal: opts.signal,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				const err = error as (NodeJS.ErrnoException & { code?: string | number | null }) | null;
				const stderrText = stderr ? stderr.toString("utf8") : "";
				if (!err) {
					resolve({ code: 0, stdout, stderr: stderrText });
					return;
				}
				if (opts.signal?.aborted || err.name === "AbortError") {
					reject(abortError(opts.signal));
					return;
				}
				if (err.code === "ENOENT" && typeof err.syscall === "string" && err.syscall.startsWith("spawn")) {
					// spawn reports a missing cwd the same way as a missing executable.
					reject(existsSync(opts.cwd) ? new GitMissingError() : new Error(`Directory ${opts.cwd} does not exist.`));
					return;
				}
				if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					reject(new GitError(args, null, `output exceeded ${opts.maxBuffer ?? MAX_OUTPUT_BYTES} bytes`));
					return;
				}
				const code = typeof err.code === "number" ? err.code : null;
				if (opts.allowFail && code !== null) {
					resolve({ code, stdout, stderr: stderrText });
					return;
				}
				reject(new GitError(args, code, stderrText || err.message));
			},
		);
		child.stdin?.on("error", () => {}); // EPIPE if git exits early; reported via the exit code
		child.stdin?.end(opts.input);
	});
}

async function gitText(args: string[], opts: GitOptions): Promise<string> {
	return (await git(args, opts)).stdout.toString("utf8").trim();
}

function splitNulBytes(buf: Buffer): Buffer[] {
	const out: Buffer[] = [];
	let start = 0;
	for (let i = buf.indexOf(0); i !== -1; i = buf.indexOf(0, start)) {
		out.push(buf.subarray(start, i));
		start = i + 1;
	}
	if (start < buf.length) out.push(buf.subarray(start));
	return out;
}

/** Printable ASCII as is, everything else as \xNN. */
function escapeBytes(buf: Buffer): string {
	let out = "";
	for (const b of buf) out += b >= 0x20 && b < 0x7f && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
	return out;
}

function splitNul(buf: Buffer): string[] {
	return buf
		.toString("utf8")
		.split("\0")
		.filter((s) => s.length > 0);
}

function abortError(signal?: AbortSignal): Error {
	const reason: unknown = signal?.reason;
	if (reason instanceof Error) return reason;
	const err = new Error("Operation aborted");
	err.name = "AbortError";
	return err;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function randomSuffix(): string {
	return randomBytes(4).toString("hex");
}

/** "error: ..." / "fatal: ..." lines of git stderr, condensed for user-facing messages. */
function summarizeGitStderr(stderr: string, max = 4): string {
	const lines = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("warning:") && !l.startsWith("hint:"));
	const errors = lines.filter((l) => /^(error|fatal):/.test(l)).map((l) => l.replace(/^(error|fatal):\s*/, ""));
	const picked = [...new Set(errors.length > 0 ? errors : lines)].slice(0, max);
	return picked.join("; ");
}

let gitVersionPromise: Promise<[number, number]> | undefined;
function gitVersion(): Promise<[number, number]> {
	gitVersionPromise ??= (async () => {
		try {
			const out = await gitText(["version"], { cwd: os.tmpdir() });
			const m = /(\d+)\.(\d+)/.exec(out);
			return m ? ([Number(m[1]), Number(m[2])] as [number, number]) : ([0, 0] as [number, number]);
		} catch {
			return [0, 0] as [number, number];
		}
	})();
	return gitVersionPromise;
}

async function gitAtLeast(major: number, minor: number): Promise<boolean> {
	const [ma, mi] = await gitVersion();
	return ma > major || (ma === major && mi >= minor);
}

// ---------------------------------------------------------------------------------------------
// Private storage
// ---------------------------------------------------------------------------------------------

function configuredRoot(): string {
	const override = process.env.PI_TASK_WORKTREES_DIR?.trim();
	if (override) return path.resolve(override);
	const xdg = process.env.XDG_CACHE_HOME?.trim();
	const cache = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache");
	return path.join(cache, "pi", "task-worktrees");
}

/** mkdir `dir` with mode 0700 (missing parents too); true if `dir` itself was created by this call. */
async function mkdirOwn(dir: string, depth = 0): Promise<boolean> {
	try {
		await fs.mkdir(dir, { mode: 0o700 });
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return false;
		if (code === "ENOENT" && depth === 0) {
			await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
			return mkdirOwn(dir, 1);
		}
		throw err;
	}
}

/** `dir` must be a directory owned by the current user; returns whether others have no access. */
async function checkOwnDir(dir: string): Promise<boolean> {
	const st = await fs.stat(dir);
	if (!st.isDirectory()) throw new Error(`Task worktree storage ${dir} is not a directory.`);
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && st.uid !== uid) {
		throw new Error(
			`Task worktree storage ${dir} is owned by uid ${st.uid}, not the current user (${uid}); refusing to use it. ` +
				"Remove it or set PI_TASK_WORKTREES_DIR to a private directory.",
		);
	}
	return process.platform === "win32" || (st.mode & 0o077) === 0;
}

/**
 * Private storage root. Permissions are only changed on directories created here; if the configured
 * directory already exists and is accessible by others, a private `.pi-task-worktrees/` subdirectory is used.
 */
async function storageRoot(): Promise<string> {
	const root = configuredRoot();
	const created = await mkdirOwn(root);
	let dir = root;
	if (!(await checkOwnDir(root))) {
		if (created) {
			await fs.chmod(root, 0o700);
		} else {
			dir = path.join(root, ".pi-task-worktrees");
			const subCreated = await mkdirOwn(dir);
			if (!(await checkOwnDir(dir))) {
				if (!subCreated) {
					throw new Error(
						`Task worktree storage ${dir} is accessible by other users; refusing to use it. ` +
							"Restrict it (chmod 700) or set PI_TASK_WORKTREES_DIR to a private directory.",
					);
				}
				await fs.chmod(dir, 0o700);
			}
		}
	}
	return fs.realpath(dir);
}

/** Private per-user storage root (realpath), or one of its subdirectories. */
async function storageDir(...sub: string[]): Promise<string> {
	const root = await storageRoot();
	if (sub.length === 0) return root;
	const dir = path.join(root, ...sub);
	const created = await mkdirOwn(dir);
	// Inside the private root a pre-existing looser subdir is not reachable by others: never chmod it.
	if (!(await checkOwnDir(dir)) && created) await fs.chmod(dir, 0o700);
	return dir;
}

/** Create a new private file (O_EXCL, 0600) with `data` in the private temp dir. */
async function writePrivateFile(dir: string, name: string, data: Buffer): Promise<string> {
	const file = path.join(dir, name);
	await fs.writeFile(file, data, { flag: "wx", mode: 0o600 });
	return file;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = repoLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chained = prev.then(() => current);
	repoLocks.set(key, chained);
	await prev;
	try {
		return await fn();
	} finally {
		release();
		if (repoLocks.get(key) === chained) repoLocks.delete(key);
	}
}

async function realpathOr(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

function repoHash(repoRoot: string): string {
	return createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 10);
}

function sanitizeId(id: string): string {
	const clean = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
	return (clean || "task").slice(0, 40);
}

function shellQuote(s: string): string {
	return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

interface RepoInfo {
	repoRoot: string;
	prefix: string;
	commonDir: string;
}

/** Resolve the work-tree top level for `cwd`. Throws a user-facing error outside a git work tree. */
async function repoInfo(cwd: string): Promise<RepoInfo> {
	let stat;
	try {
		stat = await fs.stat(cwd);
	} catch {
		throw new Error(`Cannot create an isolated worktree: directory ${cwd} does not exist.`);
	}
	if (!stat.isDirectory()) throw new Error(`Cannot create an isolated worktree: ${cwd} is not a directory.`);
	const res = await git(["rev-parse", "--show-toplevel", "--show-prefix", "--git-common-dir"], {
		cwd,
		allowFail: true,
	});
	if (res.code !== 0) {
		const detail = res.stderr.trim().replace(/^fatal:\s*/i, "");
		throw new Error(
			`Isolated tasks require a git repository, but ${cwd} is not inside a git work tree (${detail || "git rev-parse failed"}). ` +
				"Run the task without `isolated`, or initialize a repository with at least one commit.",
		);
	}
	const lines = res.stdout.toString("utf8").split("\n");
	const repoRoot = lines[0]?.trim() ?? "";
	if (!repoRoot) throw new Error(`Isolated tasks require a git work tree; could not resolve the top level of ${cwd}.`);
	const prefix = (lines[1] ?? "").trim();
	const commonDir = path.resolve(cwd, (lines[2] ?? ".git").trim());
	return { repoRoot: path.resolve(repoRoot), prefix, commonDir };
}

/** True if `cwd` is inside a git work tree (and git is available). Never throws. */
export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		const res = await git(["rev-parse", "--is-inside-work-tree"], { cwd, allowFail: true });
		return res.code === 0 && res.stdout.toString("utf8").trim() === "true";
	} catch {
		return false;
	}
}

async function resolveHead(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	const res = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd, allowFail: true, signal });
	const sha = res.code === 0 ? res.stdout.toString("utf8").trim() : "";
	return sha || undefined;
}

/** Untracked, non-ignored entries. Nested repositories show up as "dir/" entries. */
async function listUntracked(cwd: string, signal?: AbortSignal): Promise<{ files: string[]; nested: string[] }> {
	const res = await git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd, signal });
	const files: string[] = [];
	const nested: string[] = [];
	for (const entry of splitNul(res.stdout)) {
		if (entry.endsWith("/")) nested.push(entry.slice(0, -1));
		else files.push(entry);
	}
	return { files, nested };
}

async function sumSizes(root: string, files: readonly string[]): Promise<number> {
	const sizes = await mapLimit(files, 16, async (f) => {
		try {
			const st = await fs.lstat(path.join(root, f));
			return st.isFile() ? st.size : 0;
		} catch {
			return 0; // vanished
		}
	});
	return sizes.reduce((a, b) => a + b, 0);
}

function formatBytes(n: number): string {
	if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

/** Copied-index failures worth retrying from a fresh index (as opposed to unreadable files etc.). */
const INDEX_FORMAT_ERROR = /index file|index uses|bad signature|index entry format|unknown index/i;

/**
 * Write the full working state of `dir` (tracked + untracked non-ignored, excluding nested repos and
 * ignored files) as a tree object, using a throwaway index so the real index is never modified.
 */
async function snapshotTree(
	dir: string,
	head: string | undefined,
	nested: readonly string[],
	signal?: AbortSignal,
): Promise<string> {
	const indexPath = path.resolve(dir, await gitText(["rev-parse", "--git-path", "index"], { cwd: dir, signal }));
	const tmpIndex = path.join(await storageDir("tmp"), `index-${process.pid}-${randomSuffix()}`);
	const env = { GIT_INDEX_FILE: tmpIndex };
	const excludes = nested.map((p) => `:(top,exclude,literal)${p}`);
	// --sparse: also record untracked/modified paths outside a sparse-checkout cone (else git add exits 1).
	const sparse = (await gitAtLeast(2, 34)) ? ["--sparse"] : [];
	const addAll = () => git(["add", "-A", ...sparse, "--", ".", ...excludes], { cwd: dir, env, signal });
	try {
		let seeded = false;
		try {
			const st = await fs.stat(indexPath);
			await fs.copyFile(indexPath, tmpIndex, fs.constants.COPYFILE_EXCL);
			await fs.chmod(tmpIndex, 0o600);
			// Keep the copy's mtime at (just below) the original's: a newer index would make git trust stat
			// data of entries that were "racily clean" in the original; much older forces re-hashing.
			await fs.utimes(tmpIndex, st.atime, new Date(st.mtimeMs - 1));
			seeded = true;
		} catch {
			// no index yet (fresh repo) - start from HEAD below
		}
		try {
			if (!seeded && head) await git(["read-tree", head], { cwd: dir, env, signal });
			await addAll();
		} catch (err) {
			const retry = seeded && !signal?.aborted && err instanceof GitError && INDEX_FORMAT_ERROR.test(err.stderr);
			if (!retry) throw err;
			// Copied index unusable (exotic extensions etc.): rebuild from HEAD (slower, re-hashes).
			await fs.rm(tmpIndex, { force: true });
			if (head) await git(["read-tree", head], { cwd: dir, env, signal });
			await addAll();
		}
		return await gitText(["write-tree"], { cwd: dir, env, signal });
	} catch (err) {
		if (err instanceof GitError) {
			throw new Error(`could not snapshot the files (${summarizeGitStderr(err.stderr) || err.message})`);
		}
		throw err;
	} finally {
		await fs.rm(tmpIndex, { force: true }).catch(() => {});
		await fs.rm(`${tmpIndex}.lock`, { force: true }).catch(() => {});
	}
}

async function snapshotWorkingState(dir: string): Promise<string> {
	const head = await resolveHead(dir);
	const { nested } = await listUntracked(dir);
	return snapshotTree(dir, head, nested);
}

async function commitTree(cwd: string, tree: string, parents: string[], message: string): Promise<string> {
	const args = ["commit-tree", "--no-gpg-sign", "-m", message];
	for (const p of parents) args.push("-p", p);
	args.push(tree);
	return gitText(args, { cwd });
}

const DIFF_FLAGS = [
	"-r",
	"--no-renames",
	"--no-ext-diff",
	"--no-textconv",
	"--ignore-submodules=all",
	"--src-prefix=a/",
	"--dst-prefix=b/",
];

async function diffTrees(cwd: string, from: string, to: string): Promise<{ raw: Buffer; files: string[]; stat: string }> {
	const raw = (await git(["diff-tree", "-p", "--binary", "--full-index", ...DIFF_FLAGS, from, to], { cwd })).stdout;
	if (raw.length === 0) return { raw, files: [], stat: "" };
	const files = splitNul((await git(["diff-tree", "--name-only", "-z", ...DIFF_FLAGS, from, to], { cwd })).stdout);
	const stat = (await git(["diff-tree", "--stat=100", "--stat-count=40", ...DIFF_FLAGS, from, to], { cwd })).stdout
		.toString("utf8")
		.replace(/\s+$/, "");
	return { raw, files, stat };
}

function rawPatchOf(delta: Delta): Buffer {
	return deltaMeta.get(delta)?.raw ?? Buffer.from(delta.patch, "utf8");
}

interface DeltaOrigin {
	from: string;
	fork?: string;
	unsure?: string[];
	unrelated?: boolean;
}

/**
 * What a worktree's changes (snapshot `tree`) are measured from. Normally the baseline. If the agent
 * moved HEAD so that the baseline is no longer an ancestor of it (switch / checkout / reset to another
 * commit, amend, rebase), the working tree may have lost what the baseline commit holds on top of that
 * history - including the spawner's uncommitted work - and a delta from the baseline would revert it
 * in the parent. The paths that lost it are then measured from where HEAD forked (`git merge-base`,
 * see forkOrigin); without a common ancestor everything is measured from the empty tree, i.e. as
 * additions only (`unrelated`, never merged automatically).
 */
async function deltaOrigin(dir: string, base: string, tree: string): Promise<DeltaOrigin> {
	const head = await resolveHead(dir);
	// Unborn HEAD (`checkout --orphan`): the files are still the baseline's, stay state-based.
	if (!head || head === base) return { from: base };
	const anc = await git(["merge-base", "--is-ancestor", base, head], { cwd: dir, allowFail: true });
	if (anc.code === 0) return { from: base }; // the agent committed on top of the baseline
	if (anc.code !== 1) {
		throw new Error(`could not relate HEAD to the task baseline (${summarizeGitStderr(anc.stderr) || `git merge-base exited ${anc.code}`})`);
	}
	const mb = await git(["merge-base", base, head], { cwd: dir, allowFail: true });
	const fork = mb.stdout.toString("utf8").trim().split("\n")[0] ?? "";
	if (mb.code === 0 && fork) return forkOrigin(dir, base, head, fork, tree);
	if (mb.code !== 1) {
		throw new Error(`could not find where HEAD forked from the task baseline (${summarizeGitStderr(mb.stderr) || `git merge-base exited ${mb.code}`})`);
	}
	// Unrelated history: nothing to measure from. (The empty tree is known to git without being stored.)
	const empty = await gitText(["hash-object", "-t", "tree", "--stdin"], { cwd: dir, input: "" });
	return { from: empty, unrelated: true };
}

const sameEntry = (a: TreeEntry | undefined, b: TreeEntry | undefined) => a?.mode === b?.mode && a?.oid === b?.oid;

/**
 * Origin for a worktree whose HEAD left the baseline at `fork`. Only the paths that differ between
 * the fork and the baseline can be affected; each is attributed on its own:
 *   - snapshot or HEAD's commit still holds the baseline's version (amend, `reset --soft/--mixed`,
 *     rebase): measured from the baseline as usual;
 *   - snapshot is back at the fork's version (`reset --hard`, switch, checkout): an effect of moving
 *     HEAD - measured from the fork, i.e. no change;
 *   - snapshot holds something else: merge it with the baseline on top of the fork. Nothing added: it
 *     already contains what the baseline added, measured from the baseline. Clean but different: it was
 *     built on the fork's version, measured from the fork (the merge into the parent then keeps both
 *     sides). Conflict (or no usable merge): it could be either - `unsure`, measured from the fork so
 *     that the saved patch cannot revert the spawner's work.
 * The origin is the baseline with the fork's entry at every path measured from the fork.
 */
async function forkOrigin(dir: string, base: string, head: string, fork: string, tree: string): Promise<DeltaOrigin> {
	const lost = await rawDiff(dir, fork, base);
	// Names that do not survive as strings cannot be attributed one by one: everything from the fork.
	if (lost.nonUtf8.length > 0) return { from: fork, fork };
	if (lost.paths.length === 0) return { from: base };
	const [now, atHead] = await Promise.all([rawDiff(dir, base, tree), rawDiff(dir, base, head)]);
	const changedNow = new Set(now.paths);
	const changedAtHead = new Set(atHead.paths);
	const fromFork: string[] = [];
	const open: string[] = [];
	for (const p of lost.paths) {
		if (!changedNow.has(p) || !changedAtHead.has(p)) continue;
		if (sameEntry(now.post.get(p), lost.pre.get(p))) fromFork.push(p);
		else open.push(p);
	}
	const unsure: string[] = [];
	if (open.length > 0) {
		let merged = "";
		let conflicted = new Set<string>();
		if (await gitAtLeast(2, 40)) {
			const theirs = await commitTree(dir, tree, [fork], "pi: task worktree state");
			// No rename detection: the verdict is per path.
			const mt = await git(
				["-c", "merge.renames=false", "merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", `--merge-base=${fork}`, base, theirs],
				{ cwd: dir, allowFail: true },
			);
			if (mt.code === 0 || mt.code === 1) {
				const parts = splitNul(mt.stdout);
				merged = parts[0]?.trim() ?? "";
				conflicted = new Set(parts.slice(1));
			}
		}
		const added = merged ? new Set((await rawDiff(dir, tree, merged)).paths) : undefined;
		for (const p of open) {
			if (!added || conflicted.has(p)) unsure.push(p);
			else if (!added.has(p)) continue; // already contains what the baseline added
			fromFork.push(p);
		}
	}
	if (fromFork.length === 0) return { from: base };
	const extra = unsure.length > 0 ? { unsure } : {};
	if (fromFork.length === lost.paths.length) return { from: fork, fork, ...extra };
	const tmpIndex = path.join(await storageDir("tmp"), `index-${process.pid}-${randomSuffix()}`);
	const env = { GIT_INDEX_FILE: tmpIndex };
	try {
		await git(["read-tree", base], { cwd: dir, env });
		const info = fromFork.map((p) => {
			const e = lost.pre.get(p);
			return e ? `${e.mode} ${e.oid}\t${p}\0` : `0 ${"0".repeat(base.length)}\t${p}\0`;
		});
		await git(["update-index", "-z", "--index-info"], { cwd: dir, env, input: info.join("") });
		const origin = await gitText(["write-tree"], { cwd: dir, env });
		return { from: await commitTree(dir, origin, [fork], "pi: task delta origin"), fork, ...extra };
	} finally {
		await fs.rm(tmpIndex, { force: true }).catch(() => {});
		await fs.rm(`${tmpIndex}.lock`, { force: true }).catch(() => {});
	}
}

const shortOid = (oid: string) => oid.slice(0, 10);

/** Sentence for results whose delta was (partly) measured from a fork point instead of the baseline, else "". */
function movedNote(d: Delta): string {
	const m = deltaMeta.get(d);
	if (!m?.fork || m.unrelated || (m.unsure && m.unsure.length > 0)) return "";
	const what = m.from === m.fork ? "its changes" : "its changes to files that no longer held the baseline's content";
	return ` Note: the agent moved HEAD off the task baseline; ${what} were measured from commit ${shortOid(m.fork)}, where its HEAD forked from the baseline.`;
}

/** What a saved patch of `d` is relative to (for user-facing messages). */
function patchOrigin(d: Delta): string {
	const m = deltaMeta.get(d);
	if (m?.unrelated) return "every file of the agent's checkout as an addition, as its HEAD shares no history with the task's baseline";
	if (m?.fork && m.from === m.fork) return `relative to commit ${shortOid(m.fork)}, where the agent's HEAD forked from the task's baseline`;
	if (m?.fork) {
		return `relative to the task's baseline, but to commit ${shortOid(m.fork)}, where the agent's HEAD forked from it, for files that no longer held the baseline's content`;
	}
	return "relative to the task's baseline";
}

// ---------------------------------------------------------------------------------------------
// Exact, verified writes into the parent working tree
// ---------------------------------------------------------------------------------------------

interface TreeEntry {
	mode: string;
	oid: string;
}

interface CompareCtx {
	algo: string;
	fileMode: boolean;
	symlinks: boolean;
}

const GITLINK = "160000";
const SYMLINK = "120000";
const isRegularMode = (mode: string) => mode === "100644" || mode === "100755";

interface RawDiff {
	/** Changed paths (gitlinks ignored), in git order. */
	paths: string[];
	/** Changed paths whose bytes are not valid UTF-8 (escaped); such merges are refused. */
	nonUtf8: string[];
	/** Entries on the "from" side (absent paths omitted). */
	pre: Map<string, TreeEntry>;
	/** Entries on the "to" side (absent paths omitted). */
	post: Map<string, TreeEntry>;
}

const NULL_MODE = "000000";

/** Per-path entries changed between two tree-ishes (`git diff-tree --raw`), O(changes). */
async function rawDiff(cwd: string, from: string, to: string): Promise<RawDiff> {
	const out = await git(["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", "--ignore-submodules=all", from, to], {
		cwd,
	});
	const parts = splitNulBytes(out.stdout);
	const res: RawDiff = { paths: [], nonUtf8: [], pre: new Map(), post: new Map() };
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const meta = (parts[i] ?? Buffer.alloc(0)).toString("latin1");
		const fileBytes = parts[i + 1] ?? Buffer.alloc(0);
		const file = fileBytes.toString("utf8");
		if (!meta.startsWith(":") || fileBytes.length === 0) continue;
		const [srcMode = "", dstMode = "", srcOid = "", dstOid = ""] = meta.slice(1).split(" ");
		if (srcMode === GITLINK || dstMode === GITLINK) continue;
		// Paths travel as JS strings; a name that does not survive the UTF-8 round trip would be
		// written/compared under a mangled name - refuse instead.
		if (file.includes("\uFFFD") || !Buffer.from(file, "utf8").equals(fileBytes)) {
			res.nonUtf8.push(escapeBytes(fileBytes));
			continue;
		}
		res.paths.push(file);
		if (srcMode !== NULL_MODE) res.pre.set(file, { mode: srcMode, oid: srcOid });
		if (dstMode !== NULL_MODE) res.post.set(file, { mode: dstMode, oid: dstOid });
	}
	return res;
}

async function compareCtx(repoRoot: string): Promise<CompareCtx> {
	const cfg = async (key: string) =>
		(await git(["config", "--bool", "--get", key], { cwd: repoRoot, allowFail: true })).stdout.toString("utf8").trim();
	const [fmt, fileMode, symlinks] = await Promise.all([
		git(["rev-parse", "--show-object-format"], { cwd: repoRoot, allowFail: true }).then((r) =>
			r.code === 0 ? r.stdout.toString("utf8").trim() : "sha1",
		),
		cfg("core.filemode"),
		cfg("core.symlinks"),
	]);
	return { algo: fmt === "sha256" ? "sha256" : "sha1", fileMode: fileMode !== "false", symlinks: symlinks !== "false" };
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** State of one path in a working tree. */
interface WorkState {
	/** "blocked": an ancestor is a symlink or a special file - never read or written through. */
	kind: "absent" | "dir" | "file" | "symlink" | "other" | "blocked";
	/** Exact bytes (file content or symlink target); kept for verification and byte-exact rollback. */
	bytes?: Buffer;
	/** sha256 of `bytes`. */
	raw?: string;
	exec?: boolean;
	/** Permission bits of a regular file. */
	perm?: number;
	/** Blob id as `git add` would record it: filters/eol conversion applied for files, raw for symlinks. */
	oid?: string;
	/** Regular file over MAX_MERGE_FILE_BYTES: not read, never merged automatically. */
	size?: number;
	tooLarge?: boolean;
}

/** lstat every ancestor of `rel`; "blocked" if one is a symlink or special file, "absent" if one is a file/missing. */
async function ancestorsState(root: string, rel: string): Promise<"ok" | "absent" | "blocked"> {
	const parts = rel.split("/");
	parts.pop();
	let cur = root;
	for (const part of parts) {
		cur = path.join(cur, part);
		let st;
		try {
			st = await fs.lstat(cur);
		} catch {
			return "absent";
		}
		if (st.isSymbolicLink()) return "blocked";
		if (!st.isDirectory()) return st.isFile() ? "absent" : "blocked";
	}
	return "ok";
}

async function readState(root: string, rel: string): Promise<WorkState> {
	const anc = await ancestorsState(root, rel);
	if (anc !== "ok") return { kind: anc };
	const full = path.join(root, rel);
	let st;
	try {
		st = await fs.lstat(full);
	} catch {
		return { kind: "absent" };
	}
	if (st.isSymbolicLink()) {
		const bytes = await fs.readlink(full, { encoding: "buffer" });
		return { kind: "symlink", bytes, raw: sha256(bytes) };
	}
	if (st.isFile()) {
		const exec = (st.mode & 0o100) !== 0;
		const perm = st.mode & 0o7777;
		if (st.size > MAX_MERGE_FILE_BYTES) return { kind: "file", exec, perm, size: st.size, tooLarge: true };
		const bytes = await fs.readFile(full);
		return { kind: "file", bytes, raw: sha256(bytes), exec, perm, size: bytes.length };
	}
	return { kind: st.isDirectory() ? "dir" : "other" };
}

function sameBytes(a: WorkState, b: WorkState): boolean {
	if (a.tooLarge || b.tooLarge) return false;
	return a.kind === b.kind && a.raw === b.raw && a.exec === b.exec;
}

/** Read `paths` and compute the blob ids git would record (via `git hash-object`, so filters apply). */
async function readStates(root: string, paths: readonly string[], ctx: CompareCtx): Promise<Map<string, WorkState>> {
	const states = await mapLimit(paths, 16, (p) => readState(root, p));
	const map = new Map<string, WorkState>();
	const files: string[] = [];
	paths.forEach((p, i) => {
		const st = states[i] ?? { kind: "absent" };
		map.set(p, st);
		if (st.kind === "file" && !st.tooLarge) files.push(p);
		else if (st.kind === "symlink" && st.bytes) {
			st.oid = createHash(ctx.algo).update(`blob ${st.bytes.length}\0`).update(st.bytes).digest("hex");
		}
	});
	// `--stdin-paths` C-unquotes a line starting with `"` and drops a trailing CR: such paths (and ones
	// containing a newline) are passed as an argument instead.
	const needsArg = (p: string) => p.includes("\n") || p.startsWith('"') || p.endsWith("\r");
	const batch = files.filter((p) => !needsArg(p));
	if (batch.length > 0) {
		const out = await git(["hash-object", "--stdin-paths"], { cwd: root, input: `${batch.join("\n")}\n` });
		const oids = out.stdout.toString("utf8").split("\n");
		batch.forEach((p, i) => {
			const st = map.get(p);
			if (st) st.oid = oids[i]?.trim();
		});
	}
	for (const p of files.filter(needsArg)) {
		const st = map.get(p);
		if (st) st.oid = await gitText(["hash-object", "--", p], { cwd: root });
	}
	return map;
}

/**
 * A path that is only "blocked" because one of its ancestors is a symlink/file that this merge deletes
 * (e.g. symlink `s` replaced by a real directory `s/`) is effectively absent.
 */
function unblock(states: Map<string, WorkState>, deleting: ReadonlySet<string>): void {
	for (const [p, st] of states) {
		if (st.kind !== "blocked") continue;
		const parts = p.split("/");
		for (let n = 1; n < parts.length; n++) {
			if (deleting.has(parts.slice(0, n).join("/"))) {
				states.set(p, { kind: "absent" });
				break;
			}
		}
	}
}

/** Does the working state match the tree entry as git sees it? A directory counts as "no blob here". */
function matches(expected: TreeEntry | undefined, st: WorkState, ctx: CompareCtx): boolean {
	if (!expected) return st.kind === "absent" || st.kind === "dir";
	if (expected.mode === SYMLINK) {
		return st.oid === expected.oid && (st.kind === "symlink" || (!ctx.symlinks && st.kind === "file"));
	}
	if (isRegularMode(expected.mode)) {
		return st.kind === "file" && st.oid === expected.oid && (!ctx.fileMode || st.exec === (expected.mode === "100755"));
	}
	return false;
}

function describeState(expected: TreeEntry | undefined, st: WorkState): string {
	if (st.kind === "blocked") return "behind a symlink";
	if (st.kind === "other") return "a special file";
	if (st.kind === "absent") return "missing";
	if (!expected) return "an untracked or ignored file is in the way";
	if (st.kind === "dir") return "a directory is in the way";
	return "modified";
}

interface PlanItem {
	path: string;
	/** Expected current entry (undefined = no blob). */
	pre?: TreeEntry;
	/** Intended entry (undefined = delete). */
	post?: TreeEntry;
}

interface Op {
	path: string;
	kind: "deleted" | "written";
	/** State before the merge touched the path (bytes kept for exact rollback). */
	before: WorkState;
	/** What was written (for "written"). */
	wrote?: WorkState;
}

class ConcurrentChange extends Error {
	constructor(readonly file: string) {
		super(`${file} changed during the merge`);
	}
}

const depth = (p: string) => p.split("/").length;

/** Sizes of the intended (post) blobs of a plan, by path. */
async function blobSizes(root: string, items: readonly PlanItem[]): Promise<Map<string, number>> {
	const withPost = items.filter((i) => i.post);
	const sizes = new Map<string, number>();
	if (withPost.length === 0) return sizes;
	const out = await git(["cat-file", "--batch-check=%(objectsize)"], {
		cwd: root,
		input: `${withPost.map((i) => i.post?.oid).join("\n")}\n`,
	});
	const lines = out.stdout.toString("utf8").split("\n");
	withPost.forEach((i, n) => sizes.set(i.path, Number.parseInt(lines[n] ?? "", 10) || 0));
	return sizes;
}

/** Conflict reason if any current file or intended blob exceeds MAX_MERGE_FILE_BYTES. */
function tooLargeList(states: Map<string, WorkState>, postSizes?: Map<string, number>): string | undefined {
	const big: string[] = [];
	for (const [p, st] of states) if (st.tooLarge) big.push(`${p} (${formatBytes(st.size ?? 0)})`);
	for (const [p, size] of postSizes ?? []) if (size > MAX_MERGE_FILE_BYTES) big.push(`${p} (${formatBytes(size)})`);
	if (big.length === 0) return undefined;
	return `files larger than ${formatBytes(MAX_MERGE_FILE_BYTES)} are not merged automatically: ${[...new Set(big)].join(", ")}`;
}

/** "EACCES: permission denied" without the (temp) path Node appends. */
function fsErrorText(err: unknown): string {
	return errorMessage(err).replace(/, \w+ '[^']*'( -> '[^']*')?$/, "");
}

/** Remove now-empty directories from `rel`'s parent up to (excluding) root. */
async function pruneEmptyParents(root: string, rel: string): Promise<void> {
	let dir = path.dirname(rel);
	while (dir && dir !== ".") {
		try {
			await fs.rmdir(path.join(root, dir));
		} catch {
			return;
		}
		dir = path.dirname(dir);
	}
}

/** Create missing ancestors of `rel` (recorded in `created`); refuses symlinked or non-directory ancestors. */
async function ensureParents(root: string, rel: string, created: string[]): Promise<void> {
	const parts = rel.split("/");
	parts.pop();
	let cur = root;
	for (const part of parts) {
		cur = path.join(cur, part);
		let st;
		try {
			st = await fs.lstat(cur);
		} catch {
			await fs.mkdir(cur);
			created.push(cur);
			continue;
		}
		if (st.isSymbolicLink() || !st.isDirectory()) {
			throw new Error(`${path.relative(root, cur)} is not a real directory`);
		}
	}
}

/** Write `bytes` as a new temp file/symlink next to `rel`; returns its absolute path. */
async function writeTemp(root: string, rel: string, bytes: Buffer, link: boolean, perm: number): Promise<string> {
	const tmp = path.join(path.dirname(path.join(root, rel)), `.pi-merge-${process.pid}-${randomSuffix()}`);
	try {
		if (link) await fs.symlink(bytes, tmp);
		else {
			await fs.writeFile(tmp, bytes, { flag: "wx", mode: perm });
			await fs.chmod(tmp, perm);
		}
		return tmp;
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

/** Atomically put `bytes` at `rel` as a file (mode/perm) or symlink, via a temp name + rename. */
async function putEntry(root: string, rel: string, bytes: Buffer, link: boolean, perm: number): Promise<void> {
	const tmp = await writeTemp(root, rel, bytes, link, perm);
	try {
		await fs.rename(tmp, path.join(root, rel));
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

function umaskedPerm(exec: boolean): number {
	const mask = process.umask();
	return (exec ? 0o777 : 0o666) & ~mask;
}

/** Permission bits for writing `entry`: keep the existing file's bits where possible. */
function permFor(entry: TreeEntry, before: WorkState): number {
	const exec = entry.mode === "100755";
	if (before.kind !== "file" || before.perm === undefined) return umaskedPerm(exec);
	if (before.exec === exec) return before.perm;
	return exec ? before.perm | ((before.perm & 0o444) >> 2) : before.perm & ~0o111;
}

async function blobForWorktree(root: string, rel: string, entry: TreeEntry, ctx: CompareCtx): Promise<{ bytes: Buffer; link: boolean }> {
	if (entry.mode === SYMLINK) {
		const bytes = (await git(["cat-file", "blob", entry.oid], { cwd: root })).stdout;
		return { bytes, link: ctx.symlinks };
	}
	// Smudge filters / eol conversion exactly as a checkout would.
	try {
		const out = await git(["cat-file", "--filters", `--path=${rel}`, entry.oid], { cwd: root, maxBuffer: MAX_MERGE_FILE_BYTES });
		return { bytes: out.stdout, link: false };
	} catch (err) {
		if (err instanceof GitError && err.code === null) {
			throw new Error(`its content exceeds ${formatBytes(MAX_MERGE_FILE_BYTES)}; merge it manually`);
		}
		throw err;
	}
}

/** rmdir `dir` and any empty subdirectories (fails, removing nothing more, if a non-directory is found). */
async function removeEmptyTree(dir: string): Promise<void> {
	for (const e of await fs.readdir(dir, { withFileTypes: true })) {
		if (!e.isDirectory()) throw new Error(`${e.name} is in the way`);
		await removeEmptyTree(path.join(dir, e.name));
	}
	await fs.rmdir(dir);
}

/** Recursively list non-directory entries under `rel` (no symlink following). */
async function listFilesUnder(root: string, rel: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (r: string) => {
		for (const e of await fs.readdir(path.join(root, r), { withFileTypes: true })) {
			const child = `${r}/${e.name}`;
			if (e.isDirectory()) await walk(child);
			else out.push(child);
		}
	};
	await walk(rel);
	return out;
}

/**
 * Save `st` (or, for a large file not held in memory, the file at `root/rel`) under
 * rescued/<stamp>/<which>/<rel>; returns the copy's path.
 */
async function rescueCopy(root: string, rel: string, st: WorkState, stamp: string, which: "current" | "original"): Promise<string | undefined> {
	if (!st.bytes && !(st.kind === "file" && st.tooLarge)) return undefined;
	const dir = await storageDir("rescued", stamp);
	const target = path.join(dir, which, ...rel.split("/"));
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	if (st.bytes) await fs.writeFile(target, st.bytes, { flag: "wx", mode: 0o600 });
	else {
		await fs.copyFile(path.join(root, rel), target, fs.constants.COPYFILE_EXCL);
		await fs.chmod(target, 0o600);
	}
	return target;
}

type ExecResult =
	| { ok: true }
	/** Nothing in the parent was changed (or every change was rolled back cleanly). */
	| { ok: false; untouched: true; detail: string }
	| { ok: false; untouched: false; detail: string };

/**
 * Write `items` into the parent working tree. Every path must currently match `pre` (as git sees
 * it) and is re-verified byte-for-byte right before it is written; afterwards every path must hold
 * exactly what was written. On any failure the already written paths are rolled back - but only
 * those still holding exactly what this merge wrote; anything else is left alone (copy saved).
 */
async function executePlan(root: string, items: PlanItem[], ctx: CompareCtx, known?: Map<string, WorkState>): Promise<ExecResult> {
	// 1. Preconditions (as git sees the files).
	const missing = items.map((i) => i.path).filter((p) => !known?.has(p));
	const fresh = missing.length > 0 ? await readStates(root, missing, ctx) : new Map<string, WorkState>();
	unblock(fresh, new Set(items.filter((i) => i.pre && !i.post).map((i) => i.path)));
	const state = (p: string) => known?.get(p) ?? fresh.get(p) ?? { kind: "absent" as const };
	const large = tooLargeList(new Map(items.map((i) => [i.path, state(i.path)])), await blobSizes(root, items));
	if (large) return { ok: false, untouched: true, detail: large };
	const bad = items.filter((i) => !matches(i.pre, state(i.path), ctx));
	if (bad.length > 0) {
		return { ok: false, untouched: true, detail: bad.map((i) => `${i.path} (${describeState(i.pre, state(i.path))})`).join(", ") };
	}
	// 2. Structural checks: nothing in the way of the writes except paths this plan deletes.
	const deletes = items.filter((i) => !i.post && state(i.path).kind !== "absent" && state(i.path).kind !== "dir");
	const writes = items.filter((i) => i.post);
	const deleting = new Set(deletes.map((i) => i.path));
	for (const w of writes) {
		const parts = w.path.split("/");
		for (let n = 1; n < parts.length; n++) {
			const anc = parts.slice(0, n).join("/");
			let st;
			try {
				st = await fs.lstat(path.join(root, anc));
			} catch {
				break;
			}
			if (st.isDirectory() && !st.isSymbolicLink()) continue;
			if (!deleting.has(anc)) {
				return { ok: false, untouched: true, detail: `${anc} (${st.isSymbolicLink() ? "a symlink" : "a file"} is in the way of ${w.path})` };
			}
			break;
		}
		if (state(w.path).kind === "dir") {
			const others = (await listFilesUnder(root, w.path)).filter((f) => !deleting.has(f));
			if (others.length > 0) {
				return { ok: false, untouched: true, detail: `${w.path} (a directory with other files is in the way: ${others.slice(0, 3).join(", ")})` };
			}
		}
	}

	// 3. Execute: deletions deepest-first, then writes shallowest-first.
	const ops: Op[] = [];
	const createdDirs: string[] = [];
	let failure: { path: string; error: unknown } | undefined;
	let current = "";
	try {
		for (const item of [...deletes].sort((a, b) => depth(b.path) - depth(a.path))) {
			current = item.path;
			const before = await readState(root, item.path);
			if (!sameBytes(before, state(item.path))) throw new ConcurrentChange(item.path);
			await fs.unlink(path.join(root, item.path));
			ops.push({ path: item.path, kind: "deleted", before });
			await pruneEmptyParents(root, item.path);
		}
		for (const item of [...writes].sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : 1))) {
			current = item.path;
			const post = item.post as TreeEntry;
			const { bytes, link } = await blobForWorktree(root, item.path, post, ctx);
			await ensureParents(root, item.path, createdDirs);
			// Temp file first, then the final check, then rename: the window for an unseen concurrent
			// edit is only the check + rename, not the (possibly slow) write.
			const tmp = await writeTemp(root, item.path, bytes, link, umaskedPerm(post.mode === "100755"));
			let perm: number;
			try {
				const before = await readState(root, item.path);
				const expectedBefore = state(item.path);
				const unchanged =
					expectedBefore.kind === "dir" ? before.kind === "dir" || before.kind === "absent" : sameBytes(before, expectedBefore);
				if (!unchanged) throw new ConcurrentChange(item.path);
				perm = permFor(post, before);
				if (!link) await fs.chmod(tmp, perm);
				if (before.kind === "dir") await removeEmptyTree(path.join(root, item.path));
				await fs.rename(tmp, path.join(root, item.path));
				ops.push({
					path: item.path,
					kind: "written",
					before,
					wrote: link ? { kind: "symlink", raw: sha256(bytes) } : { kind: "file", raw: sha256(bytes), exec: (perm & 0o100) !== 0 },
				});
			} catch (err) {
				await fs.rm(tmp, { force: true }).catch(() => {});
				throw err;
			}
		}
	} catch (error) {
		failure = { path: current, error };
	}

	// 4. Postconditions: every touched path holds exactly what was written / is gone.
	const concurrent: string[] = [];
	if (!failure) {
		for (const op of ops) {
			const now = await readState(root, op.path);
			const ok = op.kind === "written" ? op.wrote !== undefined && sameBytes(now, op.wrote) : now.kind === "absent" || now.kind === "dir";
			if (!ok) concurrent.push(op.path);
		}
		if (concurrent.length === 0) return { ok: true };
	}

	// 5. Safe rollback.
	const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomSuffix()}`;
	const rolledBack: string[] = [];
	const leftAsIs: string[] = [];
	const notRestored: string[] = [];
	const leave = async (op: Op, now: WorkState) => {
		const notes: string[] = [];
		try {
			const copy = await rescueCopy(root, op.path, now, stamp, "current");
			if (copy) notes.push(`current content copied to ${copy}`);
		} catch {
			// best effort
		}
		try {
			// The pre-merge content is no longer on disk (overwritten or deleted by the merge): save it too.
			const original = await rescueCopy(root, op.path, op.before, stamp, "original");
			if (original) notes.push(`original content saved to ${original}`);
		} catch {
			// best effort
		}
		leftAsIs.push(notes.length > 0 ? `${op.path} (${notes.join("; ")})` : op.path);
	};
	const restoreBefore = async (op: Op) => {
		const b = op.before;
		if (b.kind === "file" || b.kind === "symlink") {
			await ensureParents(root, op.path, []);
			await putEntry(root, op.path, b.bytes ?? Buffer.alloc(0), b.kind === "symlink", b.perm ?? umaskedPerm(false));
		}
	};
	const reversed = [...ops].reverse();
	for (const op of reversed.filter((o) => o.kind === "written")) {
		try {
			const now = await readState(root, op.path);
			if (!op.wrote || !sameBytes(now, op.wrote)) {
				await leave(op, now);
				continue;
			}
			if (op.before.kind === "file" || op.before.kind === "symlink") await restoreBefore(op);
			else {
				await fs.unlink(path.join(root, op.path));
				await pruneEmptyParents(root, op.path);
			}
			rolledBack.push(op.path);
		} catch (err) {
			notRestored.push(`${op.path} (${fsErrorText(err)})`);
		}
	}
	for (const dir of [...createdDirs].reverse()) await fs.rmdir(dir).catch(() => {});
	for (const op of reversed.filter((o) => o.kind === "deleted")) {
		try {
			const now = await readState(root, op.path);
			if (now.kind === "dir") await fs.rmdir(path.join(root, op.path)).catch(() => {});
			const again = now.kind === "dir" ? await readState(root, op.path) : now;
			if (again.kind !== "absent") {
				await leave(op, again);
				continue;
			}
			await restoreBefore(op);
			rolledBack.push(op.path);
		} catch (err) {
			notRestored.push(`${op.path} (${fsErrorText(err)})`);
		}
	}

	const parts: string[] = [];
	if (failure instanceof Object && failure.error instanceof ConcurrentChange) {
		parts.push(`${failure.path} changed in the parent during the merge`);
	} else if (failure) {
		parts.push(`could not write ${failure.path} (${fsErrorText(failure.error)})`);
	} else {
		parts.push(`${concurrent.join(", ")} changed in the parent right after the merge wrote ${concurrent.length === 1 ? "it" : "them"}`);
	}
	if (rolledBack.length > 0) parts.push(`rolled back: ${rolledBack.join(", ")}`);
	if (leftAsIs.length > 0) parts.push(`modified concurrently; left as is: ${leftAsIs.join(", ")}`);
	if (notRestored.length > 0) parts.push(`could not restore: ${notRestored.join(", ")}`);
	const untouched = failure?.error instanceof ConcurrentChange && leftAsIs.length === 0 && notRestored.length === 0;
	return { ok: false, untouched, detail: parts.join("; ") };
}

const APPLY_FLAGS = ["-c", "apply.ignoreWhitespace=no", "apply", "--binary", "--whitespace=nowarn"];

/** Rebuild the child's tree from a patch relative to `base` (a tree-ish; for deltas without metadata). */
async function treeFromPatch(cwd: string, base: string, raw: Buffer): Promise<string> {
	const dir = await storageDir("tmp");
	const tmpIndex = path.join(dir, `index-${process.pid}-${randomSuffix()}`);
	const file = await writePrivateFile(dir, `delta-${process.pid}-${randomSuffix()}.patch`, raw);
	const env = { GIT_INDEX_FILE: tmpIndex };
	try {
		await git(["read-tree", base], { cwd, env });
		const res = await git([...APPLY_FLAGS, "--cached", file], { cwd, env, allowFail: true });
		if (res.code !== 0) {
			throw new Error(`the delta does not apply to the worktree baseline (${summarizeGitStderr(res.stderr)})`);
		}
		return await gitText(["write-tree"], { cwd, env });
	} finally {
		await fs.rm(file, { force: true }).catch(() => {});
		await fs.rm(tmpIndex, { force: true }).catch(() => {});
		await fs.rm(`${tmpIndex}.lock`, { force: true }).catch(() => {});
	}
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Create a detached worktree for `id` reproducing the current working state of the repository
 * containing `cwd` (HEAD + staged + unstaged + untracked non-ignored files). The parent's index,
 * working tree, refs and stash are not modified.
 */
export async function createWorktree(cwd: string, id: string, signal?: AbortSignal): Promise<Worktree> {
	signal?.throwIfAborted();
	const info = await repoInfo(path.resolve(cwd));
	const repoRoot = info.repoRoot;
	const lockKey = await realpathOr(repoRoot);
	// Only the snapshot needs the lock (consistency with concurrent merges into the same checkout);
	// checking out the snapshot commit does not read the parent's working tree.
	const baseCommit = await withRepoLock(lockKey, async () => {
		signal?.throwIfAborted();
		const head = await resolveHead(repoRoot, signal);
		const { files: untracked, nested } = await listUntracked(repoRoot, signal);
		const untrackedBytes = await sumSizes(repoRoot, untracked);
		if (untrackedBytes > MAX_UNTRACKED_BYTES) {
			throw new Error(
				`Refusing to create an isolated worktree: ${repoRoot} has ${formatBytes(untrackedBytes)} of untracked, ` +
					`non-ignored files (limit ${formatBytes(MAX_UNTRACKED_BYTES)}), which would all be copied into the worktree. ` +
					"Add the bulk (build output, datasets, dependencies) to .gitignore or commit it, or run the task without `isolated`.",
			);
		}
		let tree: string;
		try {
			tree = await snapshotTree(repoRoot, head, nested, signal);
		} catch (err) {
			if (signal?.aborted) throw err;
			throw new Error(`Cannot create an isolated worktree of ${repoRoot}: ${errorMessage(err)}`);
		}
		return commitTree(
			repoRoot,
			tree,
			head ? [head] : [],
			`pi: isolated task baseline (${id})\n\nSnapshot of the parent working state.`,
		);
	});
	signal?.throwIfAborted();

	const parentDir = await storageDir(repoHash(lockKey));
	const wtPath = path.join(parentDir, `${sanitizeId(id)}-${randomSuffix()}`);
	try {
		await git(["worktree", "add", "--detach", "--quiet", wtPath, baseCommit], { cwd: repoRoot, signal });
	} catch (err) {
		await destroy(wtPath, repoRoot, info.commonDir);
		if (err instanceof GitError) {
			throw new Error(`Failed to create isolated worktree for ${repoRoot}: ${summarizeGitStderr(err.stderr) || err.message}`);
		}
		throw err;
	}
	const wt: Worktree = {
		repoRoot,
		path: wtPath,
		cwd: info.prefix ? path.join(wtPath, ...info.prefix.split("/").filter(Boolean)) : wtPath,
		baseCommit,
	};
	worktreeMeta.set(wt, { commonDir: info.commonDir, lockKey });
	liveWorktrees.add(wt);
	try {
		// cwd may be an ignored / untracked-empty directory that does not exist in the snapshot.
		await fs.mkdir(wt.cwd, { recursive: true });
	} catch {
		wt.cwd = wtPath;
	}
	if (signal?.aborted) {
		await removeWorktree(wt);
		throw abortError(signal);
	}
	return wt;
}

/**
 * Everything changed in the worktree since `wt.baseCommit` (edits, new untracked files, deletions,
 * mode changes, binaries), whether or not the agent committed. The worktree's index is not modified.
 * If the agent moved HEAD so that the baseline is no longer an ancestor of it, the changes are those
 * since the fork point instead (see deltaOrigin / "Moved HEAD" in the file header).
 * Throws a descriptive Error if the worktree cannot be read (e.g. unreadable files).
 */
export async function collectDelta(wt: Worktree): Promise<Delta> {
	const base = wt.baseCommit;
	let tree: string;
	let origin: DeltaOrigin;
	try {
		tree = await snapshotWorkingState(wt.path);
		origin = await deltaOrigin(wt.path, base, tree);
	} catch (err) {
		throw new Error(
			`Could not collect changes from isolated worktree ${wt.path}: ${errorMessage(err)}. ` +
				"Fix the problem in the worktree (e.g. file permissions) and merge again; the worktree is kept.",
		);
	}
	const { raw, files, stat } = await diffTrees(wt.path, `${origin.from}^{tree}`, tree);
	const delta: Delta = { patch: raw.toString("utf8"), files, stat };
	deltaMeta.set(delta, { raw, tree, base, ...origin });
	return delta;
}

/**
 * Mark the worktree's current state (or the state `delta` was computed from) as merged, so later
 * deltas only contain newer changes. Called automatically after a successful merge; exported so a
 * caller can accept a manually resolved conflict.
 */
export async function advanceBaseline(wt: Worktree, delta?: Delta): Promise<void> {
	const meta = delta ? deltaMeta.get(delta) : undefined;
	const tree = meta && meta.base === wt.baseCommit ? meta.tree : await snapshotWorkingState(wt.path);
	const baseTree = await gitText(["rev-parse", `${wt.baseCommit}^{tree}`], { cwd: wt.path });
	if (tree === baseTree) return;
	// A HEAD the agent moved (own commits, another branch) becomes a second parent: if a later run
	// returns to it, its merge base with the new baseline is that commit, not an older fork point, so
	// what was merged here is neither offered again nor reverted.
	const head = await resolveHead(wt.path);
	const parents = head && head !== wt.baseCommit ? [wt.baseCommit, head] : [wt.baseCommit];
	const commit = await commitTree(wt.path, tree, parents, "pi: isolated task baseline (merged)");
	// Detach (never move a branch the agent may have checked out - refs are shared with the parent).
	await git(["update-ref", "--no-deref", "-m", "pi: advance task baseline", "HEAD", commit], { cwd: wt.path });
	// Index := new baseline; working tree untouched (so `git status` in the worktree shows only new work).
	await git(["reset", "-q", "--mixed", "HEAD"], { cwd: wt.path, allowFail: true });
	wt.baseCommit = commit;
}

/** User-facing recovery instructions for a saved patch that could not be merged. */
export function recoveryHint(patchFile: string, repoRoot: string): string {
	return (
		`Resolve manually: \`git apply --reject ${shellQuote(patchFile)}\` (working tree only; writes .rej files for conflicting hunks), run in ${repoRoot}. ` +
		"`git apply --3way` is an alternative but requires staging your edits first and modifies the index."
	);
}

/**
 * Apply the child's changes (collected now if `delta` is omitted) to the parent's working tree.
 * Never stages or commits; never throws. Merges into the same repoRoot are serialized.
 */
export async function mergeDelta(wt: Worktree, delta?: Delta): Promise<MergeResult> {
	const lockKey = worktreeMeta.get(wt)?.lockKey ?? (await realpathOr(wt.repoRoot));
	return withRepoLock(lockKey, async () => {
		let d: Delta;
		try {
			d = delta ?? (await collectDelta(wt));
		} catch (err) {
			return { status: "error", message: errorMessage(err), files: [] };
		}
		if (rawPatchOf(d).length === 0 || d.patch.trim() === "") {
			return { status: "empty", message: "No changes to merge.", files: [] };
		}
		try {
			return await mergeLocked(wt, d);
		} catch (err) {
			let patchFile: string | undefined;
			try {
				patchFile = await savePatch(wt, d);
			} catch {
				// reported below
			}
			return {
				status: "error",
				message:
					`Failed to merge isolated changes into ${wt.repoRoot}: ${errorMessage(err)}.` +
					(patchFile ? ` Patch saved to ${patchFile}.` : " The patch could not be saved.") +
					` Worktree kept at ${wt.path}.`,
				files: d.files,
				patchFile,
			};
		}
	});
}

async function mergeLocked(wt: Worktree, d: Delta): Promise<MergeResult> {
	const repoRoot = wt.repoRoot;
	let meta = deltaMeta.get(d);
	if (meta && meta.base !== wt.baseCommit) {
		return {
			status: "error",
			message: `Stale delta: it was collected against an older baseline of ${wt.path}; call collectDelta() again.`,
			files: d.files,
		};
	}
	if (!meta) {
		// A delta without metadata is taken to be relative to what collectDelta() measures from now.
		const raw = rawPatchOf(d);
		const origin = await deltaOrigin(wt.path, wt.baseCommit, await snapshotWorkingState(wt.path));
		meta = { raw, tree: await treeFromPatch(wt.path, origin.from, raw), base: wt.baseCommit, ...origin };
		deltaMeta.set(d, meta);
	}
	const m = meta;
	if (m.unrelated) {
		// No fork point: the agent's work cannot be told apart from the history it checked out.
		return conflict(wt, d, d.files, "the agent moved HEAD to a history unrelated to the task baseline, so its changes cannot be measured");
	}
	if (m.unsure && m.unsure.length > 0) {
		// Could be the spawner's version edited further (deliver the edit) or a rewrite of the fork's
		// version (keep the spawner's lines): not decidable, and a wrong guess loses or resurrects work.
		return conflict(
			wt,
			d,
			d.files,
			`the agent moved HEAD off the task baseline and it cannot be told whether its version of ${m.unsure.join(", ")} builds on the baseline's or on the older committed one`,
		);
	}
	// `m.from` is the baseline, or the fork point / a mix of both if the agent moved HEAD off it (see deltaOrigin).
	const [delta, ctx] = await Promise.all([rawDiff(wt.path, m.from, m.tree), compareCtx(repoRoot)]);
	const { paths: touched, pre: baseEntries, post: theirsEntries } = delta;
	const files = d.files.length > 0 ? d.files : touched;
	if (delta.nonUtf8.length > 0) return conflict(wt, d, files, `non-UTF-8 filename: ${delta.nonUtf8.join(", ")}`);
	if (touched.length === 0) return { status: "empty", message: "No changes to merge.", files: [] };

	const applied = async (message: string): Promise<MergeResult> => {
		try {
			await advanceBaseline(wt, d);
		} catch (err) {
			message += ` (warning: could not advance the worktree baseline, these changes may be offered again: ${errorMessage(err)})`;
		}
		return { status: "applied", message: message + movedNote(d), files };
	};

	// Classify each touched path of the parent working tree exactly (as git sees it: filters apply).
	const working = await readStates(repoRoot, touched, ctx);
	unblock(working, new Set(touched.filter((p) => baseEntries.has(p) && !theirsEntries.has(p))));
	const large = tooLargeList(working);
	if (large) return conflict(wt, d, files, large);
	const stateOf = (p: string): WorkState => working.get(p) ?? { kind: "absent" };
	const pending: string[] = [];
	const present: string[] = [];
	const diverged: string[] = [];
	for (const p of touched) {
		if (matches(baseEntries.get(p), stateOf(p), ctx)) pending.push(p);
		else if (matches(theirsEntries.get(p), stateOf(p), ctx)) present.push(p);
		else diverged.push(p);
	}
	const finish = (res: ExecResult, ok: string): Promise<MergeResult> => {
		if (res.ok) return applied(ok);
		if (res.untouched) return conflict(wt, d, files, res.detail);
		return mergeError(wt, d, files, res.detail);
	};

	if (diverged.length === 0) {
		if (pending.length === 0) return applied(`Changes were already present in ${repoRoot}; nothing to apply.`);
		const plan = pending.map((p) => ({ path: p, pre: baseEntries.get(p), post: theirsEntries.get(p) }));
		const res = await executePlan(repoRoot, plan, ctx, working);
		const extra = present.length > 0 ? ` (${present.length} already present)` : "";
		return finish(res, `Applied changes to ${pending.length} file(s) in ${repoRoot}${extra}.`);
	}

	// Parent changed some of the same files since the baseline: 3-way merge in object space.
	const changedList = diverged.join(", ");
	if (!(await gitAtLeast(2, 40))) {
		return conflict(wt, d, files, `the parent also changed ${changedList}; a 3-way merge needs git >= 2.40`);
	}
	const head = await resolveHead(repoRoot);
	const { files: untracked, nested } = await listUntracked(repoRoot);
	if ((await sumSizes(repoRoot, untracked)) > MAX_UNTRACKED_BYTES) {
		return conflict(wt, d, files, `the parent also changed ${changedList} and has too much untracked content for a 3-way merge`);
	}
	const parentTree = await snapshotTree(repoRoot, head, nested);
	const ours = await commitTree(repoRoot, parentTree, [], "pi: parent working state");
	const theirs = await commitTree(repoRoot, m.tree, [m.from], "pi: task changes");
	const mt = await git(
		["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${m.from}`, ours, theirs],
		{ cwd: repoRoot, allowFail: true },
	);
	const lines = mt.stdout.toString("utf8").split("\n").filter(Boolean);
	if (mt.code === 1) {
		const conflicted = [...new Set(lines.slice(1))];
		return conflict(wt, d, files, `conflicting edits in ${(conflicted.length > 0 ? conflicted : diverged).join(", ")}`);
	}
	if (mt.code !== 0 || !lines[0]) {
		return conflict(wt, d, files, `the parent also changed ${changedList}; 3-way merge failed: ${summarizeGitStderr(mt.stderr)}`);
	}
	const merged = lines[0].trim();
	const { paths, nonUtf8, pre: parentEntries, post: mergedEntries } = await rawDiff(repoRoot, parentTree, merged);
	if (nonUtf8.length > 0) return conflict(wt, d, files, `non-UTF-8 filename: ${nonUtf8.join(", ")}`);
	if (paths.length === 0) return applied(`Changes were already present in ${repoRoot}; nothing to apply.`);
	const plan = paths.map((p) => ({ path: p, pre: parentEntries.get(p), post: mergedEntries.get(p) }));
	const res = await executePlan(repoRoot, plan, ctx);
	return finish(res, `Applied changes to ${paths.length} file(s) in ${repoRoot} (3-way merged with concurrent edits in ${changedList}).`);
}

async function conflict(wt: Worktree, d: Delta, files: string[], detail: string): Promise<MergeResult> {
	let patchFile: string | undefined;
	let saveError = "";
	try {
		patchFile = await savePatch(wt, d);
	} catch (err) {
		saveError = errorMessage(err);
	}
	const saved = patchFile
		? `Patch saved to ${patchFile} (${patchOrigin(d)}). ${recoveryHint(patchFile, wt.repoRoot)} `
		: `The patch could not be saved (${saveError}). `;
	return {
		status: "conflict",
		message:
			`Could not merge isolated changes into ${wt.repoRoot} (${detail}); the parent checkout was left untouched. ` +
			saved +
			`The worktree with the full changes is kept at ${wt.path}.` +
			movedNote(d),
		files,
		patchFile,
	};
}

async function mergeError(wt: Worktree, d: Delta, files: string[], detail: string): Promise<MergeResult> {
	let patchFile: string | undefined;
	try {
		patchFile = await savePatch(wt, d);
	} catch {
		// reported below
	}
	return {
		status: "error",
		message:
			`Failed to merge isolated changes into ${wt.repoRoot}: ${detail}.` +
			(patchFile ? ` Patch saved to ${patchFile}.` : " The patch could not be saved.") +
			` Worktree kept at ${wt.path}.`,
		files,
		patchFile,
	};
}

/** Persist `delta` as a private patch file (survives worktree removal); returns its path. */
export async function savePatch(wt: Worktree, delta: Delta): Promise<string> {
	let dir: string;
	try {
		dir = await storageDir("patches");
	} catch (err) {
		throw new Error(`Could not create the patch directory: ${errorMessage(err)}`);
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = `${path.basename(wt.path)}-${stamp}-${randomSuffix()}.patch`;
	try {
		return await writePrivateFile(dir, name, rawPatchOf(delta));
	} catch (err) {
		throw new Error(`Could not write patch file ${path.join(dir, name)}: ${errorMessage(err)}`);
	}
}

async function isRegistered(cwd: string, wtPath: string): Promise<boolean> {
	// `--porcelain -z` needs git >= 2.36; older git: newline-separated porcelain.
	const z = await gitAtLeast(2, 36);
	const res = await git(["worktree", "list", "--porcelain", ...(z ? ["-z"] : [])], { cwd, allowFail: true });
	if (res.code !== 0) return true; // unknown: let the caller prune
	const records = z ? splitNul(res.stdout) : res.stdout.toString("utf8").split("\n");
	const target = path.resolve(wtPath);
	return records.some((l) => l.startsWith("worktree ") && path.resolve(l.slice(9)) === target);
}

async function destroy(wtPath: string, repoRoot: string, commonDir?: string): Promise<void> {
	const candidates: string[] = [];
	for (const dir of [repoRoot, commonDir]) {
		if (!dir) continue;
		try {
			if ((await fs.stat(dir)).isDirectory()) candidates.push(dir);
		} catch {
			// gone
		}
	}
	let gitCwd: string | undefined;
	let removed = false;
	for (const dir of candidates) {
		try {
			const res = await git(["worktree", "remove", "--force", "--force", wtPath], { cwd: dir, allowFail: true });
			gitCwd = dir;
			if (res.code === 0) {
				removed = true;
				break;
			}
		} catch {
			// git missing or dir unusable: try next
		}
	}
	await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
	if (gitCwd && !removed) {
		try {
			if (await isRegistered(gitCwd, wtPath)) await git(["worktree", "prune"], { cwd: gitCwd, allowFail: true });
		} catch {
			// ignore
		}
	}
	await fs.rmdir(path.dirname(wtPath)).catch(() => {}); // only succeeds when empty
}

/** Remove the worktree directory and its git registration. Idempotent; never throws. */
export async function removeWorktree(wt: Worktree): Promise<void> {
	liveWorktrees.delete(wt);
	try {
		await destroy(wt.path, wt.repoRoot, worktreeMeta.get(wt)?.commonDir);
	} catch {
		// never throw
	}
}

/**
 * Keep `wt` on disk and stop tracking it: removeAllWorktrees() will not touch it and listWorktrees()
 * no longer returns it (e.g. it holds changes that could not be merged or saved).
 */
export function retainWorktree(wt: Worktree): void {
	liveWorktrees.delete(wt);
}

/** Remove every tracked worktree created by this process (e.g. on session shutdown). Never throws. */
export async function removeAllWorktrees(): Promise<void> {
	const all = [...liveWorktrees].reverse(); // nested (newer) first
	for (const wt of all) await removeWorktree(wt);
}

/** Worktrees created by this process that have not been removed or retained (the same objects). */
export function listWorktrees(): Worktree[] {
	return [...liveWorktrees];
}

/** One-line transcript summary of a merge. */
export function formatMergeResult(r: MergeResult): string {
	const shown = r.files.slice(0, 3).join(", ");
	const more = r.files.length > 3 ? ` +${r.files.length - 3} more` : "";
	const fileList = r.files.length > 0 ? ` (${shown}${more})` : "";
	switch (r.status) {
		case "applied":
			return `✓ merged ${r.files.length} file(s) into parent checkout${fileList}`;
		case "empty":
			return "no file changes to merge";
		case "conflict":
			return `✗ merge conflict${fileList}: parent untouched, patch at ${r.patchFile ?? "(not saved)"}`;
		case "error":
			return `✗ merge failed: ${r.message}`;
	}
}

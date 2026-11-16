/**
 * Most-recently-used model history, persisted to ~/.pi/agent/model-history.json.
 *
 * Shared by every pi process; writes are atomic (tmp + rename) and merge with
 * what is on disk so concurrent sessions don't clobber each other.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RecentModel {
	provider: string;
	id: string;
	/** epoch ms */
	lastUsed: number;
}

interface HistoryFile {
	version: 1;
	models: RecentModel[];
}

export const MAX_RECENT = 10;
/** Don't rewrite the file if the same model was recorded this recently. */
const RECORD_THROTTLE_MS = 60_000;

export const modelKey = (provider: string, id: string) => `${provider}\0${id}`;

export class ModelHistory {
	constructor(readonly file: string) {}

	exists(): boolean {
		return existsSync(this.file);
	}

	/** Newest first. Never throws. */
	read(): RecentModel[] {
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<HistoryFile>;
			if (!Array.isArray(parsed.models)) return [];
			return parsed.models.filter(
				(m): m is RecentModel =>
					!!m && typeof m.provider === "string" && typeof m.id === "string" && typeof m.lastUsed === "number",
			);
		} catch {
			return [];
		}
	}

	record(provider: string, id: string, at = Date.now()): void {
		const current = this.read();
		const head = current[0];
		if (head && head.provider === provider && head.id === id && at - head.lastUsed < RECORD_THROTTLE_MS) return;
		this.merge([{ provider, id, lastUsed: at }], current);
	}

	/** Merge entries into the on-disk history, keeping the newest timestamp per model. */
	merge(entries: RecentModel[], current = this.read()): void {
		const byKey = new Map<string, RecentModel>();
		for (const m of [...entries, ...current]) {
			const k = modelKey(m.provider, m.id);
			const prev = byKey.get(k);
			if (!prev || m.lastUsed > prev.lastUsed) byKey.set(k, m);
		}
		const models = [...byKey.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_RECENT);
		this.write(models);
	}

	private write(models: RecentModel[]): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify({ version: 1, models } satisfies HistoryFile, null, "\t")}\n`);
			renameSync(tmp, this.file);
		} catch {
			// History is best-effort.
		}
	}
}

/**
 * Build an initial history from `model_change` entries in recent session files,
 * so /model is useful on the first run instead of starting empty.
 */
export async function scanSessionsForModels(sessionsDir: string, maxFiles = 100): Promise<RecentModel[]> {
	const files: { path: string; mtime: number }[] = [];
	let projectDirs: string[];
	try {
		projectDirs = await readdir(sessionsDir);
	} catch {
		return [];
	}
	for (const dir of projectDirs) {
		const full = join(sessionsDir, dir);
		let names: string[];
		try {
			names = await readdir(full);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(full, name);
			try {
				files.push({ path, mtime: (await stat(path)).mtimeMs });
			} catch {}
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);

	const found = new Map<string, RecentModel>();
	for (const { path } of files.slice(0, maxFiles)) {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.includes('"type":"model_change"')) continue;
			try {
				const e = JSON.parse(line) as { type?: string; provider?: unknown; modelId?: unknown; timestamp?: unknown };
				if (e.type !== "model_change" || typeof e.provider !== "string" || typeof e.modelId !== "string") continue;
				const lastUsed = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
				if (!Number.isFinite(lastUsed)) continue;
				const k = modelKey(e.provider, e.modelId);
				const prev = found.get(k);
				if (!prev || lastUsed > prev.lastUsed) found.set(k, { provider: e.provider, id: e.modelId, lastUsed });
			} catch {}
		}
	}
	return [...found.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_RECENT);
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BtwStatus } from "./records.ts";

export const GLYPH = {
	rail: "▎",
	sent: "➤",
	cursor: "❯",
	pending: "⏳",
	warning: "⚠",
	error: "✘",
	check: "✓",
} as const;

const BOX = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" } as const;

export const STATUS: Readonly<Record<BtwStatus, { label: string; color: "accent" | "success" | "warning" | "error" }>> = {
	running: { label: "Running", color: "accent" },
	complete: { label: "Complete", color: "success" },
	cancelled: { label: "Cancelled", color: "warning" },
	error: { label: "Error", color: "error" },
	interrupted: { label: "Interrupted", color: "warning" },
};

function cells(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function pad(line: string, width: number): string {
	width = cells(width);
	if (width === 0) return "";
	const have = visibleWidth(line);
	if (have === width) return line;
	if (have < width) return line + " ".repeat(width - have);
	let cut = truncateToWidth(line, width, "…");
	if (visibleWidth(cut) > width) cut = truncateToWidth(line, width, "");
	const kept = visibleWidth(cut);
	return kept < width ? cut + " ".repeat(width - kept) : cut;
}

export function topBorder(theme: Theme, width: number, title: string): string {
	width = cells(width);
	if (width === 0) return "";
	if (width === 1) return theme.fg("border", BOX.topLeft);
	const inner = width - 2;
	const clean = title.replace(/\s+/g, " ").trim();
	if (!clean || inner < 5) return theme.fg("border", BOX.topLeft + BOX.horizontal.repeat(inner) + BOX.topRight);
	const shown = ` ${truncateToWidth(clean, inner - 4, "…")} `;
	const fill = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		theme.fg("border", BOX.topLeft + BOX.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		theme.fg("border", BOX.horizontal.repeat(fill) + BOX.topRight)
	);
}

export function bottomBorder(theme: Theme, width: number): string {
	width = cells(width);
	if (width === 0) return "";
	if (width === 1) return theme.fg("border", BOX.bottomLeft);
	return theme.fg("border", BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight);
}

export function boxRow(theme: Theme, content: string, width: number): string {
	width = cells(width);
	if (width === 0) return "";
	const bar = theme.fg("border", BOX.vertical);
	const line = `${bar} ${pad(content, width - 4)} ${bar}`;
	return width < 4 ? truncateToWidth(line, width, "") : line;
}

export function formatKey(key: string): string {
	return key === "escape" ? "esc" : key;
}

export function keyHint(theme: Theme, keys: string | readonly string[], description: string): string {
	const shown = (typeof keys === "string" ? [keys] : keys).map(formatKey).join("/");
	return theme.fg("dim", shown) + theme.fg("muted", ` ${description}`);
}

/**
 * Pass the width in terminal cells inside the borders and padding.
 */
export function paneWidths(inner: number): { wide: boolean; left: number; right: number } {
	inner = cells(inner);
	const frame = inner + 4;
	if (frame < 96) return { wide: false, left: inner, right: inner };
	const left = Math.min(46, Math.floor(frame * 0.42), Math.max(0, inner - 3));
	return { wide: true, left, right: Math.max(0, inner - 3 - left) };
}

export function clampScroll(offset: number, totalRows: number, viewRows: number): number {
	const max = Math.max(0, cells(totalRows) - cells(viewRows));
	const safe = Number.isFinite(offset) ? Math.trunc(offset) : offset > 0 ? max : 0;
	return Math.max(0, Math.min(safe, max));
}

export function listWindow(selected: number, scroll: number, total: number, viewRows: number): number {
	total = cells(total);
	viewRows = cells(viewRows);
	if (total === 0 || viewRows === 0) return 0;
	const row = Math.max(0, Math.min(cells(selected), total - 1));
	const current = clampScroll(scroll, total, viewRows);
	if (row < current) return clampScroll(row, total, viewRows);
	if (row >= current + viewRows) return clampScroll(row - viewRows + 1, total, viewRows);
	return current;
}

const TIME_FORMAT = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const FULL_FORMAT = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});
const DAY_FORMAT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const YEAR_DAY_FORMAT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

export function isSameLocalDay(a: number | Date, b: number | Date): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

export function listStamp(timestamp: number, now: Date): string {
	const date = new Date(timestamp);
	if (isSameLocalDay(date, now)) return TIME_FORMAT.format(date);
	return (date.getFullYear() === now.getFullYear() ? DAY_FORMAT : YEAR_DAY_FORMAT).format(date);
}

export function timeStamp(timestamp: number): string {
	return TIME_FORMAT.format(timestamp);
}

export function fullStamp(timestamp: number): string {
	return FULL_FORMAT.format(timestamp);
}

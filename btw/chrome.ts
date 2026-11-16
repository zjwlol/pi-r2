/**
 * ANSI chrome shared by the inline /btw panel and the history overlay: box rows, padding, key
 * hints, the status table, list / scroll arithmetic and time stamps.
 *
 * Ports what the upstream panels take from oh-my-pi `packages/tui/src/chrome/overlay-box.ts`
 * (topBorder, bottomBorder, row), `chrome/keybinding-hints.ts` (rawKeyHint),
 * `components/scroll-viewport.ts` (clampScrollOffset, scrollOffsetForRow "nearest"),
 * `components/layout/split-pane.ts` (the 0.42 / 46 / 96 geometry of the history panes) and the
 * status table and date formats of `overlays/btw-history-panel.ts`. Glyphs are upstream's
 * unicode preset, fixed.
 */

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

/** Badge label and colour per turn status (history list and details). */
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

/** Truncate (with `…`) or right-pad `line` to exactly `width` cells. */
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

/** `╭─ title ───╮`: the title bold accent, cut to fit; whitespace runs in it collapse. */
export function topBorder(theme: Theme, width: number, title: string): string {
	width = cells(width);
	if (width === 0) return "";
	if (width === 1) return theme.fg("border", BOX.topLeft);
	const inner = width - 2;
	const clean = title.replace(/\s+/g, " ").trim();
	// Room for `─`, a space each side of at least one title cell, and one `─` of fill.
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

/** `│ content │`: pre-styled content padded (or cut) to `width - 4` between the borders. */
export function boxRow(theme: Theme, content: string, width: number): string {
	width = cells(width);
	if (width === 0) return "";
	const bar = theme.fg("border", BOX.vertical);
	const line = `${bar} ${pad(content, width - 4)} ${bar}`;
	return width < 4 ? truncateToWidth(line, width, "") : line;
}

/** A key id as hints write it: `escape` → `esc`, anything else unchanged (`c`, `alt+i`, `ctrl+/`). */
export function formatKey(key: string): string {
	return key === "escape" ? "esc" : key;
}

/** One hint: dim keys (alternatives joined with `/`), then the muted description. */
export function keyHint(theme: Theme, keys: string | readonly string[], description: string): string {
	const shown = (typeof keys === "string" ? [keys] : keys).map(formatKey).join("/");
	return theme.fg("dim", shown) + theme.fg("muted", ` ${description}`);
}

/**
 * Two-pane geometry of the history frame for its inner width (frame width − 4). The frame
 * splits from 96 columns (upstream SplitPane `splitAt: 96`, measured on the frame): the list
 * takes `min(46, floor(0.42 × frame width))` cells, 3 cells go to the ` │ ` divider, Details
 * gets the rest. Narrower, both values are the whole inner width (one pane shows).
 */
export function paneWidths(inner: number): { wide: boolean; left: number; right: number } {
	inner = cells(inner);
	const frame = inner + 4;
	if (frame < 96) return { wide: false, left: inner, right: inner };
	const left = Math.min(46, Math.floor(frame * 0.42), Math.max(0, inner - 3));
	return { wide: true, left, right: Math.max(0, inner - 3 - left) };
}

/** `offset` clamped to the legal range of a viewport of `viewRows` over `totalRows`. */
export function clampScroll(offset: number, totalRows: number, viewRows: number): number {
	const max = Math.max(0, cells(totalRows) - cells(viewRows));
	const safe = Number.isFinite(offset) ? Math.trunc(offset) : offset > 0 ? max : 0;
	return Math.max(0, Math.min(safe, max));
}

/** Scroll offset that keeps `selected` inside a window of `viewRows`; unchanged while it is visible. */
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

/** Whether two timestamps fall on the same calendar day in the local time zone. */
export function isSameLocalDay(a: number | Date, b: number | Date): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

/** A history row's stamp: the time for a question asked today, its date (and year, if not this one) before. */
export function listStamp(timestamp: number, now: Date): string {
	const date = new Date(timestamp);
	if (isSameLocalDay(date, now)) return TIME_FORMAT.format(date);
	return (date.getFullYear() === now.getFullYear() ? DAY_FORMAT : YEAR_DAY_FORMAT).format(date);
}

/** `14:02` */
export function timeStamp(timestamp: number): string {
	return TIME_FORMAT.format(timestamp);
}

/** `Nov 16, 2025, 14:02` */
export function fullStamp(timestamp: number): string {
	return FULL_FORMAT.format(timestamp);
}

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { GLYPH } from "./chrome.ts";
import { card, col, md, type NativeNode, span, text } from "./native.ts";
import { formatInjectText, INJECT_LABEL, INJECTED_LABEL, type InjectParts, sanitizeDisplayText } from "./records.ts";

function fit(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

export function renderInjectBlock(theme: Theme, inject: string, width: number, sent: boolean): string[] {
	width = Math.max(0, Math.floor(width));
	if (width === 0) return [];
	const color = sent ? "success" : "customMessageLabel";
	const marker = sent ? GLYPH.sent : " ".repeat(visibleWidth(GLYPH.sent));
	const prefix = `${theme.fg(color, GLYPH.rail)} ${theme.bold(marker)} `;
	const inner = Math.max(1, width - visibleWidth(prefix));
	const body = formatInjectText(inject)
		.split("\n")
		.flatMap((line) => (line.trim() ? wrapTextWithAnsi(line, inner) : [""]))
		.map((line) => fit(`${prefix}${line}`, width));
	const label = `${prefix}${theme.fg(color, sent ? INJECTED_LABEL : INJECT_LABEL)}`;
	return [...body, visibleWidth(label) > width ? truncateToWidth(label, width, width > visibleWidth(prefix) + 1 ? "…" : "") : label];
}

function renderProse(source: string, width: number): string[] {
	const trimmed = source.trim();
	if (!trimmed) return [];
	return new Markdown(sanitizeDisplayText(trimmed), 0, 0, getMarkdownTheme()).render(width);
}

export function renderInjectAnswer(theme: Theme, parts: InjectParts, sent: boolean, width: number): string[] {
	width = Math.max(1, Math.floor(width));
	const before = renderProse(parts.before, width);
	const after = renderProse(parts.after, width);
	return [
		...(before.length > 0 ? [...before, ""] : []),
		...renderInjectBlock(theme, parts.inject, width, sent),
		...(after.length > 0 ? ["", ...after] : []),
	];
}

export function describeInjectAnswer(parts: InjectParts, sent: boolean, stream: boolean): NativeNode {
	const before = parts.before.trim();
	const after = parts.after.trim();
	const label = sent ? `${GLYPH.sent} ${INJECTED_LABEL}` : INJECT_LABEL;
	const block = card({ role: "omp.btw.inject", tone: sent ? "success" : "user" }, [
		...formatInjectText(parts.inject)
			.split("\n")
			.map((line) => text(line, { wrap: "word" })),
		text([span(label, sent ? "success" : "customMessageLabel")]),
	]);
	return col(
		[
			...(before ? [md(sanitizeDisplayText(before), { stream })] : []),
			block,
			...(after ? [md(sanitizeDisplayText(after), { stream })] : []),
		],
		{ gap: "sm" },
	);
}

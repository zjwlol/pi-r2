import type { TspSpan } from "./wire.ts";

let fgTokens = new Map<string, string>();
let mapId = 0;

export interface ThemeLike {
	colors?: Record<string, unknown>;
	getFgAnsi?(token: string): string;
}

export function setThemeForSpans(theme: ThemeLike | undefined): number {
	const next = new Map<string, string>();
	if (theme?.colors && typeof theme.getFgAnsi === "function") {
		for (const token of Object.keys(theme.colors)) {
			try {
				const ansi = theme.getFgAnsi(token);
				if (ansi && !next.has(ansi)) next.set(ansi, token);
				// The pi theme appends dim as a separate SGR sequence.
				const bare = ansi.replace(/\x1b\[2m$/, "");
				if (bare !== ansi && !next.has(bare)) next.set(bare, token);
			} catch {
				// Some theme keys are not color tokens.
			}
		}
	}
	fgTokens = next;
	mapId++;
	return mapId;
}

export function spansTokenCount(): number {
	return fgTokens.size;
}

export function spansThemeId(): number {
	return mapId;
}

interface Style {
	token?: string;
	bold: boolean;
	italic: boolean;
	dim: boolean;
	underline: boolean;
	strike: boolean;
	inverse: boolean;
}

const SGR = /\x1b\[([0-9;:]*)m/g;
// eslint-disable-next-line no-control-regex
const OTHER = /\x1b(?:\[(?![0-9;:]*m)[0-9;?<>=!]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[_P^][^\x1b]*\x1b\\|[()][A-Za-z0-9]|[=>78])/g;

function styleOf(style: Style): string | undefined {
	const parts: string[] = [];
	if (style.token) parts.push(style.token);
	if (style.bold) parts.push("strong");
	if (style.italic) parts.push("em");
	if (style.dim && style.token !== "dim") parts.push("dim");
	if (style.underline) parts.push("link");
	if (style.strike) parts.push("del");
	if (style.inverse) parts.push("mark");
	return parts.length > 0 ? parts.join(" ") : undefined;
}

export function lineToSpans(line: string): TspSpan[] {
	const clean = line.replace(OTHER, "");
	const spans: TspSpan[] = [];
	const style: Style = { bold: false, italic: false, dim: false, underline: false, strike: false, inverse: false };
	let last = 0;
	let buffer = "";
	let current = styleOf(style);
	const flush = () => {
		if (!buffer) return;
		const s = current;
		const prev = spans[spans.length - 1];
		if (prev && prev.s === s) prev.t += buffer;
		else spans.push(s === undefined ? { t: buffer } : { t: buffer, s });
		buffer = "";
	};
	SGR.lastIndex = 0;
	for (let m = SGR.exec(clean); m; m = SGR.exec(clean)) {
		buffer += clean.slice(last, m.index);
		last = m.index + m[0].length;
		const token = fgTokens.get(m[0]);
		if (token !== undefined) style.token = token;
		else applySgr(m[1] ?? "", style);
		const next = styleOf(style);
		if (next !== current) {
			flush();
			current = next;
		}
	}
	buffer += clean.slice(last);
	flush();
	return spans;
}

function applySgr(params: string, style: Style): void {
	if (params === "" || params === "0") {
		style.token = undefined;
		style.bold = style.italic = style.dim = style.underline = style.strike = style.inverse = false;
		return;
	}
	const codes = params.split(";");
	for (let i = 0; i < codes.length; i++) {
		const code = Number(codes[i]);
		switch (code) {
			case 0:
				style.token = undefined;
				style.bold = style.italic = style.dim = style.underline = style.strike = style.inverse = false;
				break;
			case 1:
				style.bold = true;
				break;
			case 2:
				style.dim = true;
				break;
			case 3:
				style.italic = true;
				break;
			case 4:
				style.underline = true;
				break;
			case 7:
				style.inverse = true;
				break;
			case 9:
				style.strike = true;
				break;
			case 22:
				style.bold = style.dim = false;
				break;
			case 23:
				style.italic = false;
				break;
			case 24:
				style.underline = false;
				break;
			case 27:
				style.inverse = false;
				break;
			case 29:
				style.strike = false;
				break;
			case 39:
				style.token = undefined;
				break;
			case 38:
			case 48:
			case 58: {
				// Extended color parameters can look like standalone SGR codes.
				const mode = Number(codes[i + 1]);
				i += mode === 5 ? 2 : mode === 2 ? 4 : 0;
				if (code === 38) style.token = undefined;
				break;
			}
			default:
				if (code >= 30 && code <= 37) style.token = undefined;
				if (code >= 90 && code <= 97) style.token = undefined;
		}
	}
}

export function hasStyle(spans: readonly TspSpan[]): boolean {
	return spans.some((s) => s.s !== undefined);
}

export function spansText(spans: readonly TspSpan[]): string {
	return spans.map((s) => s.t).join("");
}

import { formatHashlineHeader, formatNumberedLine, splitAddressableFileLines } from "./format.ts";

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50 * 1024;

export interface ReadFormatOptions {
	displayPath: string;
	tag: string;
	/**
	 * One-based starting line.
	 */
	offset?: number;
	limit?: number;
	maxLines?: number;
	maxBytes?: number;
}

export interface ReadFormatResult {
	text: string;
	/**
	 * Displayed line numbers start at 1.
	 */
	firstLine: number;
	lastLine: number;
	totalLines: number;
	truncatedBy: "lines" | "bytes" | undefined;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatReadOutput(normalizedText: string, options: ReadFormatOptions): ReadFormatResult {
	const maxLines = options.maxLines ?? READ_MAX_LINES;
	const maxBytes = options.maxBytes ?? READ_MAX_BYTES;
	const lines = splitAddressableFileLines(normalizedText);
	const totalLines = lines.length;
	const firstLine = options.offset !== undefined && Number.isFinite(options.offset) ? Math.max(1, Math.floor(options.offset)) : 1;
	if (firstLine > totalLines) throw new Error(`Offset ${options.offset} is beyond end of file (${totalLines} lines total)`);
	const wanted = options.limit !== undefined && Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : totalLines;
	const endLine = Math.min(totalLines, firstLine + wanted - 1);
	const header = formatHashlineHeader(options.displayPath, options.tag);

	const rows: string[] = [];
	let bytes = 0;
	let truncatedBy: "lines" | "bytes" | undefined;
	for (let line = firstLine; line <= endLine; line++) {
		if (rows.length >= maxLines) {
			truncatedBy = "lines";
			break;
		}
		const row = formatNumberedLine(line, lines[line - 1]);
		const rowBytes = Buffer.byteLength(row, "utf8") + (rows.length > 0 ? 1 : 0);
		if (bytes + rowBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		rows.push(row);
		bytes += rowBytes;
	}
	const lastLine = firstLine + rows.length - 1;

	if (rows.length === 0) {
		// Do not attach edit anchors to partial lines.
		const size = formatSize(Buffer.byteLength(lines[firstLine - 1], "utf8"));
		const notice = `[Line ${firstLine} is ${size}, exceeds ${formatSize(maxBytes)} limit. Use bash: sed -n '${firstLine}p' ${options.displayPath} | head -c ${maxBytes}]`;
		return { text: `${header}\n${notice}`, firstLine, lastLine, totalLines, truncatedBy: "bytes" };
	}
	let notice = "";
	if (truncatedBy === "lines") notice = `[Showing lines ${firstLine}-${lastLine} of ${totalLines}. Use offset=${lastLine + 1} to continue]`;
	else if (truncatedBy === "bytes") notice = `[Showing lines ${firstLine}-${lastLine} of ${totalLines} (${formatSize(maxBytes)} limit). Use offset=${lastLine + 1} to continue]`;
	else if (lastLine < totalLines) notice = `[${totalLines - lastLine} more lines in file. Use offset=${lastLine + 1} to continue]`;
	return { text: `${header}\n${rows.join("\n")}${notice ? `\n\n${notice}` : ""}`, firstLine, lastLine, totalLines, truncatedBy };
}


export const EDIT_DESCRIPTION = `Hashline patches existing files; new files: \`write\`. Each file: \`[PATH#TAG]\`, \`TAG\` required 4-hex snapshot from latest \`read\` or \`edit\` result. Numbers: original \`LINE:TEXT\`, never hunk-shifted.

<ops>
\`PUT N.=M:\` replace inclusive N–M with \`+\` body (\`N.=N\` for one line).
\`PUT <N:\`/\`PUT >N:\` insert before/after N (\`<1\` head, \`>$\` tail).
\`CUT N.=M\` delete and capture, optionally as \`@name\`.
\`PUT <N @name\`/\`PUT >N @name\` paste at gap (omit name for anonymous CUT); \`PUT N.=M @name\` paste over range (name REQUIRED). Register pastes have NO body; named registers persist across calls.
\`REM\` delete file; \`MV DEST\` rename after prior edits (quote spaced paths).
</ops>

<rules>
- \`:\` ops only: body rows \`+TEXT\` verbatim incl. indent; lone \`+\` blank. Literal \`- item\`/\`+ item\` → \`+- item\`/\`++ item\`. NEVER \`-\`/bare context. Body length independent of range; delete with CUT, not empty PUT.
- Touch displayed changed lines only; \`…\`, \`..\` and out-of-window lines UNSEEN. Re-read first. Tight ranges: split nonadjacent changes; NEVER include keepers or start/end mid-expression/block. Pure addition uses gap PUT.
- NEVER restyle unrelated code. After EVERY edit tag/numbers change: use edit response or fresh \`read\`; stale tag/surprise → STOP, re-read.
</rules>

<example>
\`\`\`
[greet.py#A1B2]
PUT 2.=3:
+def greet(name):
+    print(name)
[PLAN.md#3C4D]
PUT >2:
+- task
\`\`\`
Cross-file move: \`CUT 1.=3 @fn\` in source, then \`PUT <1 @fn\` in destination section.
</example>`;

export const EDIT_INPUT_DESCRIPTION = "One or more `[PATH#TAG]` sections, each followed by its ops (`PUT`, `CUT`, `REM`, `MV`) and `+TEXT` body rows.";

export const EDIT_PROMPT_SNIPPET = "Edit existing files with line-anchored patches: `[PATH#TAG]` sections of `PUT` / `CUT` ops";

export const EDIT_PROMPT_GUIDELINES = [
	"Use edit for targeted changes to existing files. Copy the `[PATH#TAG]` header from the latest read (or edit result) of the file and address lines by the numbers shown there.",
	"After every edit the file's tag and line numbers change: continue from the header and rows in the edit result, or read the file again.",
];

export const READ_DESCRIPTION_SUFFIX =
	" Text files come back as a `[PATH#TAG]` header followed by `LINE:TEXT` rows: the header and the line numbers are what `edit` takes. The header and the `LINE:` prefixes are not part of the file.";

export const READ_PROMPT_SNIPPET = "Read file contents (text as a `[PATH#TAG]` header plus `LINE:TEXT` rows, the anchors edit takes)";

export const READ_PROMPT_GUIDELINES = [
	"Use read to examine files instead of cat or sed.",
	"The `[PATH#TAG]` header and the `LINE:` prefixes in read output are not file content: never copy them into write content or shell commands.",
];

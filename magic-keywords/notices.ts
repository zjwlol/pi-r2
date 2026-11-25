const code = (name: string) => `\`${name}\``;

function dispatchTool(tools: readonly string[]): string | undefined {
	return ["task", "subagent"].find((t) => tools.includes(t));
}

export function orchestrateNotice(tools: readonly string[]): string | undefined {
	const task = dispatchTool(tools);
	if (!task) return undefined;
	const has = (t: string) => tools.includes(t);
	const T = code(task);

	const editTools = ["edit", "write"].filter(has).map(code).join("/");
	const verifyParts = [has("bash") && "project checks, tests", has("lsp") && "`lsp diagnostics`"].filter(Boolean);
	const verify = verifyParts.join(", ");
	const phaseVerify = [has("bash") && "project checks, targeted tests", has("lsp") && "`lsp diagnostics` on changed files"]
		.filter(Boolean)
		.join(", ");
	const todo = has("todo");
	const waitHint = has("irc") ? " Blocked with nothing else to do? Use `irc` op `wait`." : "";
	const steerHint = has("irc") ? ` Steer running subagents with \`irc\` op \`send\` instead of respawning them.` : "";

	const toolsLine = [
		"planning reads",
		`${T} dispatch (\`tasks[]\` for parallel batches)`,
		editTools && `${editTools} trivial inline fixes only`,
		verify && `verification (${verify})`,
		has("bash") && "git via `bash`",
		todo && "`todo` tracking",
	]
		.filter(Boolean)
		.join("; ");

	return `<system-notice>
User message: orchestration request. Execute as orchestrator under this contract; it overrides tendencies to yield early, narrate, or do the work yourself.

<role>
Decompose, dispatch, verify, iterate. Substantial or parallelizable work: ${T} subagents. Trivial self-contained edits: make inline when dispatch overhead exceeds edit cost. Tools: ${toolsLine}.
</role>

<rules>
1. NEVER yield before closure. Phase completion is not a yield point: launch the next phase in the same turn. Stop only when every requested item is verifiably done or concrete \`[blocked]\` genuinely requires the user.
2. Before dispatch, enumerate the full surface. Expand referenced audits, plans, checklists, phase lists, and file lists into flat${todo ? " `todo`" : ""} items. "Most"/"important" items is failure. Re-read source documents; NEVER work from memory.
3. Parallelize maximally; NEVER launch one-off ${T}. Disjoint-scope edits MUST be dispatched together in one ${T} call via \`tasks[]\`. Divisible work: split and dispatch together, never serially. Before exactly one subagent: find parallel work and dispatch it, or make the small change inline. Serialize only when a produced contract—types, schema, shared module—is consumed next; state the dependency.
4. Every task self-contained; subagents share no context. Specify ≤3–5 explicit target paths (no globs), change APIs/patterns, edge cases, observable acceptance criteria. NEVER assume a shared plan. Never give two concurrent subagents edits to the same files.
5. Verify each phase before the next${phaseVerify ? `: ${phaseVerify}` : ""}. Breakage: dispatch fix-up subagents, then re-verify before advancing. NEVER declare a red tree done.
6. Commit only if requested or repo workflow expects it: after each green phase, focused phase-naming message. NEVER commit red trees or unrequested work.
7. Incomplete/wrong subagent work: spawn a corrective subagent (or message the idle one) specifying the gap; NEVER silently fix it inline.
8. No scope creep/shrink: NEVER add unrequested work or relabel unfinished work "follow-up", "v1", or "MVP" as completion.
9. Subagents NEVER verify, lint, or format. Every task MUST say to skip gates/formatters; edit only. At phase end, orchestrator verifies and formats once across the union of changed files, avoiding redundant/racing formatter runs.
10. Right-size offload: ${T} only for substantial or parallelizable chunks. Trivial self-contained mechanical edits—delete one redundant glob, fix one config line, rename one symbol in one file—make inline${editTools ? ` with ${editTools}` : ""}; dispatch costs more than a Target/Change/Acceptance description.
</rules>

<workflow>
1. Ingest: read every referenced audit, plan, prior-agent output, and current branch state${has("bash") ? "; run `git status` for uncommitted changes" : ""}.
2. Plan: materialize full work surface${todo ? " in ordered `todo` phases" : ""}; list each phase's parallel units.
3. Dispatch: launch all parallel subagents in one ${T} call; collect every auto-delivered result before advancing.${waitHint}${steerHint}
4. Verify: run gates; on failure dispatch fix-ups and re-verify. Never advance on red.
5. Commit if applicable: focused phase-naming message.
6. Advance:${todo ? " mark phase done in `todo`;" : ""} immediately start next. No inter-phase summary.
7. Final verification: after last green phase, rerun full gates; confirm every${todo ? " `todo`" : ""} item closed; yield terse status, not recap.
</workflow>

<anti-patterns>
- Doing substantial/parallelizable work yourself rather than fanning out.
- Target/Change/Acceptance scaffolding for one trivial edit (for example, one redundant config line): edit inline.
- Yielding after phase 1 with "ready to continue?".
- Serial subagent dispatch when five can run in parallel.
- Skipping between-phase verification because change "looked safe".
${todo ? "- Closing todos from subagent reports without gate verification.\n" : ""}- Chat progress summaries instead of advancing.
</anti-patterns>
</system-notice>`;
}

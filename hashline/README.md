# hashline: oh-my-pi's line-anchored edit mode for pi

A port of oh-my-pi's default edit mode ("hashline") on top of vanilla pi's extension API. While it is on, `read` shows a text file under a header `[PATH#TAG]` with every line as `LINE:TEXT`, and `edit` takes a small patch language that addresses those line numbers under that header instead of quoting the old text. `TAG` is a 4-hex snapshot of the file's content: an edit whose tag no longer names the file is either moved onto the current text when that is provably safe, or rejected with the current tag and the rows around its anchors. The parser, applier, stale-tag recovery and messages are a TypeScript port of oh-my-pi's Rust crate `pi-edit` (`modes/hashline`), checked against that crate's own fixtures (see [Conformance](#conformance)).

It is **off by default**. It works in every mode (TUI, print, JSON, RPC).

## Turning it on

- `/hashline on` replaces pi's `read` and `edit` with the hashline tools; `/hashline off` gives the built-ins back. Either one writes `{"enabled":true|false}` to `<agentDir>/hashline/config.json` (`~/.pi/agent/hashline/`, or under `PI_CODING_AGENT_DIR`) and then reloads pi's extensions, like `/reload`: pi fixes the tool set when extensions load and has no way to unregister a tool. The switch applies to other pi processes at their next start or reload.
- `/hashline` or `/hashline status` shows, as a notification:
  ```
  hashline: on in this session (read and edit are the hashline tools)
  saved setting: on
  ```
  (`off in this session (read and edit are pi's built-ins)` when off), plus a line `PI_HASHLINE forces it on|off for this process` when that variable is set.
- `PI_HASHLINE=1` (or `true`, `on`) forces it on for one process, `PI_HASHLINE=0` (`false`, `off`) forces it off, whatever the saved setting says. `/hashline on|off` still saves the setting then, but tells you the variable wins.
- No config file, or an unreadable one, means off.
- A session that was switched keeps its history: the transcript then holds calls in both edit syntaxes, and the model sees only the current tools' descriptions.

## What `read` returns

For a text file:

```
[greet.py#430B]
1:@cache
2:def greet(name):
3:    print("Hello, " + name)
4:
5:greet("world")
```

- The header path is relative to the working directory for files inside it, absolute otherwise. The header and the `N:` prefixes are not part of the file; the tool's description and guidelines tell the model so.
- `TAG` is the low 16 bits of the xxHash32 of the content with trailing spaces, tabs and CRs removed from every line, as four uppercase hex digits. CRLF files are shown and tagged as LF text and written back with CRLF; a BOM is kept.
- `offset` and `limit` work as in pi and select original line numbers; the same limits apply (2000 lines, 50KB). A cut ends with a notice such as `[Showing lines 1-2000 of 2500. Use offset=2001 to continue]` or `[3 more lines in file. Use offset=8 to continue]`. A final newline does not count as an extra line (`a\nb\n` has two), unlike pi's own read.
- Images, missing files and unreadable files are handled by pi's built-in read, which runs first: the result or error is pi's.
- A file that is larger than 4MB, not valid UTF-8, or contains a NUL character comes back as pi's own output followed by ``[No edit anchors: <reason>; `edit` cannot target this file.]``.
- `details` are pi's read details plus `hashline: { path, tag, firstLine, lastLine, totalLines }`.

`grep`, `find`, `ls`, `write` and `bash` are untouched. A tag comes only from `read` or from an `edit` reply.

## What `edit` takes and returns

One parameter, `input`: one or more sections, each a header copied from the latest `read` (or `edit` reply) of that file, followed by operations. Line numbers always mean the lines of the version the tag names, however many operations the section has.

```
[greet.py#430B]
PUT 3.=3:
+    print(f"Hi, {name}")
PUT >5:
+greet("team")
```

The reply is the new header and the changed region with its new numbers, so the next edit needs no `read`:

```
[greet.py#F182]
1:@cache
2:def greet(name):
3:    print(f"Hi, {name}")
4:
5:greet("world")
6:greet("team")
```

Rows the reply leaves out between two changes are marked `…`; a long run of added rows shows its first and last 20. Repairs and recoveries are listed under a trailing `Warnings:` block. With several sections the replies are separated by a blank line.

### Operations

| Form | Effect |
|---|---|
| `PUT N.=M:` + `+TEXT` rows | Replace lines N to M (inclusive) with the rows. `N.=N` for one line. |
| `PUT <N:` / `PUT >N:` + rows | Insert the rows before / after line N. `PUT <1:` is the head of the file, `PUT >$:` its end. |
| `CUT N.=M` | Delete lines N to M and keep them in the anonymous register. `CUT N.=M @name` keeps them in a named one. |
| `PUT <N` / `PUT >N` / `PUT >$` | Paste the anonymous register at that gap (no colon, no rows). |
| `PUT <N @name` / `PUT >N @name` / `PUT >$ @name` | Paste a named register at that gap. |
| `PUT N.=M @name` | Replace lines N to M with a named register. |
| `REM` | Delete the file. |
| `MV DEST` | After the section's edits, write the file to `DEST` and remove the source (quote a destination with spaces). |

- A body row is `+` followed by the line's exact text, indentation included; a lone `+` is an empty line. The body is the final content, not a before/after pair, and need not have as many rows as the range.
- The anonymous register lives for one call. Named registers stay for the session, so a `CUT … @fn` in one section (or call) can feed a `PUT … @fn` in another file's section.
- Sections for the same file are merged. All sections are checked before anything is written: one rejected section leaves every file as it was. `edit` calls run one at a time.
- New files are created with `write`; `edit` rejects a path that does not exist (`File not found: <path>. Use the write tool to create new files.`).

### Leniency and repairs

As upstream, the parser accepts some near misses and says so in a warning: an optional `*** Begin Patch` / `*** End Patch` envelope, `PUT 3:` / `PUT 3-5:` for a range, a bare `3.=5:` header, body rows without the `+`, `N:TEXT` rows pasted from read output, read notices and `…` rows copied ahead of the operations (ignored), unified-diff `-old` rows next to `+new` rows (dropped), an empty `PUT` body (a deletion), a `:` on `CUT`. Two hunks on exactly the same range keep the later one; any other overlap is an error. Other formats (`@@` hunks, `*** Update File:`) are rejected with a message that names the hashline form.

When applying, three text-only repairs run, each with a warning:

- a replacement body written one indent level too shallow under a `{` line gets the indent of the rows it replaces;
- a `PUT >N:` whose body is indented shallower than line N moves past the closing lines (`}`, `)`, `]`) that follow N, to the body's depth;
- body rows that restate the lines just outside the replaced range are dropped when the rest covers the range. When it does not, the edit is refused, because applying it would delete or duplicate lines the body never mentions.

### Stale tags

The extension remembers, per session, the last four versions of each file it showed or wrote (their tags and text).

- **The tag names the current content**: the edit applies. This needs no memory, so it also works after a restart.
- **The tag names an older remembered version**, e.g. the tag of the `read` before an earlier edit:

  ```
  [greet.py#430B]
  PUT 1.=1:
  +@lru_cache
  ```

  The anchored lines are looked up in the current text. When each is unchanged and a neighbouring line moved with it by the same amount, the edit is applied there:

  ```
  [greet.py#A2F2]
  1:@lru_cache
  2:def greet(name):
  3:    print(f"Hi, {name}")

  Warnings:
  Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).
  ```

  (`Recovered by remapping stale line anchors …` when the lines had moved.) A replacement that reads as written for the current lines at its numbers, rather than for the lines the remap would move it onto, is not remapped.
- **Anything else** (an anchored line changed, an unknown tag, no tag, a placeholder such as `#AUTO`) is rejected without writing. The reply carries the current tag and the rows around the anchors, `*` marking them:

  ```
  Edit rejected for greet.py: file changed between read and edit.
  Section is bound to #430B, but the current file hashes to #A2F2. If a prior edit in this session modified this file, copy the [path#newhash] header from that edit's response; otherwise re-read the file with `read` to refresh the tag before retrying.

   1:@lru_cache
   2:def greet(name):
  *3:    print(f"Hi, {name}")
   4:
   5:greet("world")
  ```

  For an unknown or missing tag the reply offers the current tag for a resend when the rows shown are the ones meant.
- A `PUT <1:` / `PUT >$:` under a stale tag is applied anyway, with a warning: the head and the end do not depend on the content. A bare `REM` or `MV` under a stale tag is rejected.
- A header with no operations is answered with the file's current tag. An edit that changes nothing says so; the third identical one in a row is an error.
- A path that does not exist, whose tag and file name match exactly one remembered file inside the working directory, is taken to mean that file, with a warning naming it.

A rejection is an error result (`isError`) whose `details.errorKind` is one of `parse`, `apply`, `stale_tag`, `unknown_tag`, `other_file_tag`, `missing_tag`, `header_only`, `out_of_range`, `ambiguous_boundary`, `no_change`, `file_not_found`, `invalid_utf8`, `io`, `write_failed`.

## Outside the TUI, subagents, other tools

- **Print, JSON and RPC mode**: the tools behave the same; they have no UI part. `/hashline` shows its notifications only where there is a UI.
- **Subagents**: the `subagent` extension starts children without extensions, so children keep pi's built-in `read` and `edit` even while the parent uses hashline. A file a child changed has a new tag; the parent's next edit of it is recovered or rejected like any outside change.
- **Changes made by `write`, `bash` or anything else** are outside changes too: the next `edit` under an old tag goes through the stale-tag rules above.
- **A new, resumed or forked session** starts with an empty memory (tags from the old transcript still apply when they name the current content).

## Rendering

- **pi's TUI**: both tools use pi's built-in renderers. `edit` results carry pi's own `details.diff` and `details.patch`, so the diff is drawn as for the built-in edit, and the call line shows the first section's path.
- **Native terminals (tsp-native)**: `tsp-native/describers.ts` shows a hashline `read` as the file's own text, without the header row and the `N:` prefixes, numbered from the first line shown, with a cut notice as a muted line under it; a hashline `edit` is headed by its file (`N files` for several) over the diff from `details.patch`. The cards of pi's built-in tools are unchanged.

## Conformance

The engine files are ports of the Rust modules of the same names under `crates/pi-edit/src/modes/hashline/` (plus the parts of `store.rs`, `session.rs`, `diff_string.rs` and `crates/pi-diff` they use), at oh-my-pi commit `67ef5342de`. They were checked with plain-node test scripts against upstream's own JSON fixtures (`crates/pi-edit/tests/fixtures/hashline/`) and against cases ported by hand from upstream's Rust tests. The scripts and fixtures were built in a scratch directory and are not part of this repository.

| What | Result |
|---|---|
| Parser: every `parse` call of the `parity_*.json` fixtures | 330 of 330 give upstream's edit count, file op and warnings, or its error text |
| Applier: every `apply` call of those fixtures | 172 of 211 give upstream's text, first changed line and warnings, or its error text. The other 39 are cases upstream decides with a tree-sitter parse (see below); for 10 of them the text is the same and only upstream's syntax-error warning is missing |
| End to end (`patcher.json`: temp files, snapshots, expected files and replies) | 25 of 26; the other one tests the seen-line guard |
| Stale-tag recovery (15 cases from `tests/hashline_apply.rs`), mismatch / header-only / no-op / out-of-range replies (from `tests/hashline_patcher.rs`), the tag (`F27C` for `before\n`, and upstream's colliding pair) | all as upstream |

## Files

| file | role |
|---|---|
| `index.ts` | Extension entry: registers the two tools when on, clears the session memory at session start, `/hashline`. |
| `config.ts` | The saved switch (`config.json`) and the `PI_HASHLINE` override. |
| `tools.ts` | The `read` and `edit` tool definitions: pi's built-in read first, then the anchored text; `details` for pi's renderers; pi's file mutation queue around writes. |
| `prompt.ts` | Everything the model is told: the edit tool's description (upstream's `hashline.md` without the block forms), parameter description, prompt snippets and guidelines. |
| `read-format.ts` | Pure: header, numbered rows, limits and notices of a read. |
| `patcher.ts` | One edit call: split into sections, stage every file in memory, write, record the new versions, build the reply. |
| `store.ts` | The session memory: versions per file, named registers, the repeated-no-op counter. |
| `recovery.ts` | Moving an edit from an older version onto the current text. |
| `apply.ts` | Pure: applying edits to a text, the three repairs, the echo refusals. |
| `clipboard.ts` | Pure: `CUT` and register pastes as inserts and deletes. |
| `block.ts` | Pure: what happens to block locators (`N*`), see below. |
| `input.ts` | Pure: splitting `input` into sections, header leniency, merging sections of one file. |
| `parser.ts` | Pure: the rows under a header as edits, with the leniency rules. |
| `tokenizer.ts` | Pure: classifying each row (header, operation, body row, envelope). |
| `diff.ts` | Pure: line diff (Myers, as jsdiff), the line map for recovery, similarity, the numbered diff and the reply preview. |
| `messages.ts` | Every error and warning text, as upstream words them. |
| `format.ts` | Pure: header and row format, the tag (xxHash32), line-ending and BOM handling, recognising rows copied from read output. |
| `types.ts` | Shared types and the error class. |

Outside this directory: `tsp-native/describers.ts` (the two cards above).

## Not replicated / differences from oh-my-pi

- **Block forms** (`PUT N*:`, `PUT >N*:`, `CUT N*`, `PUT N* @name`: "the syntactic block that starts on line N"). Upstream resolves them with a tree-sitter parse of the file; vanilla pi ships no parser. They are not in the tool description. If a model writes one anyway it gets what upstream gives for a language it cannot parse: replace and cut forms are rejected with a message naming the `N.=M` form, `PUT >N*` is applied as `PUT >N` with a warning.
- **Parse-checked repairs and warnings.** Upstream also uses the parse to keep a closing line a range swallowed, to move an insert past the block its anchor opens, to treat a neighbouring attribute or decorator as an echo on a one-line range, to warn that an edit introduced a syntax error, and to refuse a recovery that lands in another construct or breaks the parse. Here such an edit is applied as written. One rule stands in for upstream's parse veto of the `PUT >N:` shift: a body that starts with a closing delimiter or with `case`, `default`, `else`, `elif`, `catch`, `except` or `finally` is never moved.
- **The seen-line guard** (upstream's `edit.enforceSeenLines`, on by default there): rejecting edits anchored on lines no read displayed. Not ported; pi's read does not fold or cut lines, and the guard's replies point at oh-my-pi's `path:A-B` read selectors.
- **Anchored search output.** Upstream's `grep` output carries headers and anchors too. Here only `read` and `edit` replies do.
- **oh-my-pi's `read`**: selectors in the path (`:50-100`, `:raw`), structural summaries, bracket-context rows. pi's `offset` / `limit` are kept instead.
- **Reply previews** mark the gap between two changed regions with `…`; upstream does so only next to its bracket-context rows.
- **Streaming previews** of an edit while its arguments arrive, the grammar for constrained decoding, the compact prompt variant and per-model edit modes.
- **Host features**: notebooks, internal URL targets, plan mode, the auto-generated-file guard, format-on-write handling, approval tiers, finding a mistyped path by its unique suffix in the workspace.
- `REM` on a file that is not valid UTF-8 is refused (upstream deletes it); the non-UTF-8 message has no byte offset.

## Known limits

- The session memory is in the pi process only: after a restart, `/reload` or session switch, an edit under an older tag cannot be recovered and is rejected with the current tag.
- Tags are 16 bits. Two different contents of one file can share a tag (about 1 in 65,536); the edit then applies to the current content if its line numbers exist.
- `edit` has no size limit of its own; `read` gives no anchors for files over 4MB.
- With hashline on in the parent and built-in tools in subagents, the two use different edit syntaxes.
- Switching on or off reloads all extensions.

## Not verified

Run once, in print mode with JSON output and only this extension loaded (pi 1.5.2, one model): the model read a four-line file, sent `[notes.txt#6193]` / `PUT 2.=2:` with two body rows, the file changed, and the result carried `details.patch`; with `PI_HASHLINE=0` the same run used pi's built-in read.

Not verified:

- Nothing was watched in a terminal: the TUI rendering of both tools, the native cards in rsttyd, and `/hashline on` / `off` / `status` in a running session (the reload, the notifications, the tool descriptions afterwards) have not been seen.
- How well models other than the one tried handle the syntax, and any task larger than that one edit.
- The Rust engine was not run for this port; agreement rests on upstream's fixtures and tests as described under Conformance. Upstream tests written inline in Rust were ported only in part.
- Windows paths.

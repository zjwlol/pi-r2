# hashline: line-anchored editing for pi

With hashline on, `read` shows text under a `[PATH#TAG]` header with `LINE:TEXT` rows. `edit` takes patches that address those lines under the header. `TAG` is a four-digit hex snapshot of the file contents. For a stale tag, `edit` either moves the patch onto the current text when safe or rejects it with the current tag and rows around the anchors.

It is **off by default**. It works in every mode (TUI, print, JSON, RPC).

## Turning it on

- `/hashline on` installs the hashline `read` and `edit` tools. `/hashline off` restores the built-ins. Each writes `{"enabled":true|false}` to `<agentDir>/hashline/config.json` under `~/.pi/agent/` or `PI_CODING_AGENT_DIR`, then reloads all extensions. The tool set is fixed at extension load. Other pi processes take the saved setting at their next start or reload.
- `/hashline` or `/hashline status` shows, as a notification:
  ```
  hashline: on in this session (read and edit are the hashline tools)
  saved setting: on
  ```
  When off, the first line reads `hashline: off in this session (read and edit are pi's built-ins)`. If set, the override adds `PI_HASHLINE forces it on|off for this process`.
- `PI_HASHLINE=1`, `true` or `on` forces it on for one process. `PI_HASHLINE=0`, `false` or `off` forces it off. `/hashline on|off` still saves the setting and reports the override.
- A missing or unreadable config means off.
- Switching tools keeps the session history. The transcript can hold both edit syntaxes. The model sees only the current tools' descriptions.

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

- Header paths are relative for files inside the working directory and absolute otherwise. The tool description and guidelines tell the model that headers and `N:` prefixes are not file content.
- The tag uses the low 16 bits of xxHash32, shown as four uppercase hex digits. Hashing removes trailing spaces, tabs and CRs from each line. CRLF files appear and hash as LF text. Writes preserve CRLF and any BOM.
- `offset` and `limit` select original line numbers. The limits are 2000 lines and 50KB. A cut ends with a notice such as `[Showing lines 1-2000 of 2500. Use offset=2001 to continue]` or `[3 more lines in file. Use offset=8 to continue]`. A final newline does not add a line. For example, `a\nb\n` has two lines.
- Images, missing files and unreadable files are handled by pi's built-in read, which runs first: the result or error is pi's.
- A file that is larger than 4MB, not valid UTF-8, or contains a NUL character comes back as pi's own output followed by ``[No edit anchors: <reason>; `edit` cannot target this file.]``.
- `details` are pi's read details plus `hashline: { path, tag, firstLine, lastLine, totalLines }`.

`grep`, `find`, `ls`, `write` and `bash` are untouched. A tag comes only from `read` or from an `edit` reply.

## What `edit` takes and returns

`edit` takes one parameter, `input`, with one or more sections. Each section starts with a header from the latest `read` or `edit` reply for that file, followed by operations. Every operation uses line numbers from the version named by the tag.

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

The reply marks gaps between changes with `…`. It shows the first and last 20 rows of a long addition. `Warnings:` lists repairs and recoveries. A blank line separates replies for multiple sections.

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

- A body row starts with `+` followed by the exact text, including indentation. A lone `+` is an empty line. Supply only the final content. Its length can differ from the range length.
- The anonymous register lasts for one call. Named registers last for the session. A `CUT … @fn` can feed a `PUT … @fn` in another file's section or a later call.
- The tool merges sections for the same file. It checks all sections before writing. A rejected section leaves every file as it was. `edit` calls run one at a time.
- New files are created with `write`; `edit` rejects a path that does not exist (`File not found: <path>. Use the write tool to create new files.`).

### Leniency and repairs

The parser accepts near misses, with warnings for repairs. It accepts an optional `*** Begin Patch` / `*** End Patch` envelope, `PUT 3:` or `PUT 3-5:` for a range, a bare `3.=5:` header, body rows without `+`, `N:TEXT` rows pasted from `read`, and a `:` on `CUT`. It ignores read notices and `…` rows ahead of the operations. It drops unified-diff `-old` rows alongside `+new` rows. An empty `PUT` body deletes the range. If two hunks cover the same range, the later one wins. Other overlaps are errors. `@@` hunks and `*** Update File:` are rejected with a message that names the hashline form.

When applying, three text-only repairs run, each with a warning:

- a replacement body written one indent level too shallow under a `{` line gets the indent of the rows it replaces;
- a `PUT >N:` whose body is indented shallower than line N moves past the closing lines (`}`, `)`, `]`) that follow N, to the body's depth;
- body rows that restate the lines just outside the replaced range are dropped when the rest covers the range. When it does not, the edit is refused, because applying it would delete or duplicate lines the body never mentions.

### Stale tags

The extension remembers the tags and text of the last four versions it shows or writes for each file in a session.

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
- **Subagents**: children started by `subagent` load no extensions. They use pi's built-in `read` and `edit`. A file a child changes has a new tag. The parent's next edit goes through stale-tag recovery or rejection.
- **Changes made by `write`, `bash` or anything else** also trigger the stale-tag rules when an edit uses an old tag.
- **A new, resumed or forked session** starts with an empty memory (tags from the old transcript still apply when they name the current content).

## Rendering

- **pi's TUI**: both tools use pi's built-in renderers. `edit` returns `details.diff` and `details.patch` for diff rendering. The call line shows the first section's path.
- **Native terminals (tsp-native)**: `tsp-native/describers.ts` shows `read` output without the hashline header or `N:` prefixes. Numbering starts at the first line shown. A cut notice appears in muted text below. The `edit` card shows the file name or `N files` above the diff from `details.patch`. Built-in tool cards are unchanged.

## Conformance

The results come from Node scripts that check JSON fixtures and selected hand-written cases. The scripts and fixtures were built in a scratch directory outside this repository.

| Check | Result |
|---|---|
| Parser (`parity_*.json`): edit counts, file operations, warnings and errors | 330 of 330 match the fixtures. |
| Applier: text, first changed line, warnings and errors | 172 of 211 match. The other 39 require syntax checks the extension does not perform. In 10 of those cases only the syntax-error warning differs. |
| End to end (`patcher.json`): files, snapshots and replies | 25 of 26 match. The other case requires a seen-line guard. |
| Stale-tag recovery (15 cases), mismatch, header-only, no-op and out-of-range replies, and tags | All match. The tag cases cover `F27C` for `before\n` and a collision. |

## Files

| file | role |
|---|---|
| `index.ts` | Extension entry: registers the two tools when on, clears the session memory at session start, `/hashline`. |
| `config.ts` | The saved switch (`config.json`) and the `PI_HASHLINE` override. |
| `tools.ts` | The `read` and `edit` tool definitions: pi's built-in read first, then the anchored text; `details` for pi's renderers; pi's file mutation queue around writes. |
| `prompt.ts` | Model-facing tool and parameter descriptions, prompt snippets and guidelines. |
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
| `diff.ts` | Pure: Myers line diff, recovery line map, similarity, numbered diff and reply preview. |
| `messages.ts` | Error and warning text. |
| `format.ts` | Pure: header and row format, the tag (xxHash32), line-ending and BOM handling, recognising rows copied from read output. |
| `types.ts` | Shared types and the error class. |

Outside this directory: `tsp-native/describers.ts` (the two cards above).

## Unsupported features

- The tool description omits syntactic block forms such as `PUT N*:`, `PUT >N*:`, `CUT N*` and `PUT N* @name`. Block replacement and cut are rejected with a message naming `N.=M`. `PUT >N*` is treated as `PUT >N` with a warning.
- The extension does not parse code for repairs or stale-tag recovery. It does not warn when an edit introduces a syntax error. It does not preserve swallowed closing lines, move inserts past opened blocks or treat neighboring attributes or decorators as echoes based on syntax. It does not reject a recovery on the basis of a syntax error or a change of construct. The textual `PUT >N:` shift leaves a body in place if it starts with a closing delimiter or with `case`, `default`, `else`, `elif`, `catch`, `except` or `finally`.
- Edits can target lines no `read` displayed. `grep` output has no anchors. `read` uses `offset` and `limit`, not path selectors such as `:50-100` or `:raw`. It has no structural summaries or bracket-context rows.
- There are no previews while edit arguments stream, constrained-decoding grammar, compact prompt variant or per-model edit modes.
- There is no special handling for notebooks, internal URL targets, plan mode, auto-generated files, format-on-write or approval tiers. Mistyped paths are not resolved by a unique workspace suffix.
- `REM` refuses files that are not valid UTF-8. The error has no byte offset.

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
- Windows paths.

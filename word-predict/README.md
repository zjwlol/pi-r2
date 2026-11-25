# word-predict: word autocomplete for pi

While you type prose in the prompt editor, a dim suffix after the caret suggests the rest of the word. Tab or → accepts it. The word N-gram model learns from prompts you submit and uses a fixed table of English web word counts.

It runs only in the interactive TUI. In print, JSON and RPC mode nothing is started, patched, read or written.

## What it does

- **Ghost text.** A ghost is offered when all of these hold:
  - The caret ends any line of the draft and the autocomplete popup is closed.
  - A word of letters, combining marks or apostrophes ends at the caret. One letter is enough.
  - The word passes the prose checks under **No ghost** below.
  - The best candidate has confidence of at least 0.15. This is its share of all words that start with the typed letters. The typed letters also count as a finished word. For example, `the` shows nothing unless a longer word clearly beats stopping there.
- **Ranking** uses your word, word-pair and word-triple counts. The previous one or two prose words form the context. Code, digits and markup break the chain. A sentence or line start is its own context. The engine also uses web counts, the last 2,000 characters before the word in this draft and the words of the last 20 hand-written prompts. See [What it learns from](#what-it-learns-from-and-what-it-stores).
- **Tab** inserts the ghost and a space. **→** inserts the ghost alone, so a suffix can follow (`weath` → → `s` gives `weathers`). Either is one undo step. Both work even when the row had no free cell left to paint the ghost.
- **Typing through.** Typing the ghost's own letters keeps it in place; a letter that differs drops it. Case is ignored for this.
- **The provisional space.** The next key settles the space Tab adds. The hook compares the editor state before and after pi-tui handles the key:
  - a typed space is swallowed (you get one space, not two);
  - one of `- . , ; : ! ? ) ] }` takes its place (`weather` Tab `.` gives `weather.`; undo gives back `weather ` with the space);
  - a newline removes it;
  - anything else, including a quote, a letter or a cursor move, leaves it as an ordinary space.
- **Key precedence.** The open autocomplete popup hides the ghost and handles Tab, Enter and the arrows. With it closed, Tab and → accept a ghost when present. Otherwise those keys go to pi's editor. → only accepts at the end of a line. Extension shortcuts, app keybindings and `ctx.ui.onTerminalInput` listeners run before the editor. That includes paste-images and the agent inspector's ←←, Ctrl+S and Alt+A keys.
- **Painting.** The ghost uses the theme's `dim` colour in free cells after the cursor. It shows `…` when cut short, never wraps and does not move the draft. The magic-keywords gradient can still paint on the same row.
- **No ghost**:
  - on a line that starts with `/` (after leading blanks), `->` or `=>`;
  - in a token that contains any of `\ / @ _ = : { } [ ] < >`, a digit, or a lowercase letter followed by an uppercase one (paths, `@file` mentions, identifiers, `[paste #1 …]` markers);
  - inside inline code, fenced code blocks and HTML/XML sections;
  - with the caret inside a word or not at the end of the line;
  - in a draft over 20,000 characters or on a line over 1,000;
  - in editors other than pi's prompt editor (dialogs, the agent inspector's message input).
- **`!` bash drafts can show suggestions.** For example, `!git sta` can show a ghost.
- **Vocabulary hygiene.** A word outside the web vocabulary and dictionary must occur in hand-written prompts twice before it can appear. The engine counts a rare misspelling one edit away from a real word as that word. It never suggests a habitual slip of a word you also type. Words earlier in the draft bypass these rules.

## `/word-predict [on|off|status]`

- `/word-predict` or `/word-predict status` shows, as a notification:
  ```
  word-predict: on
  worker: ready                                 # stopped / starting / loading / bootstrapping / ready / failed: <reason>
  learned: 1234 prompts, 567 foreign prompts, 8901 words
  state: 1.2 MB, saved 3m ago (/home/you/.pi/agent/word-predict)
  editor: prompt editor seen, last painted ansi  # or: native
  ```
  `foreign prompts` counts Claude Code and Codex prompts read at bootstrap. If no worker is ready, the counts come from the saved state. `engine error: <reason>` follows `worker:` when the engine reports a problem. It can be `ready` even if the state directory is unwritable or a save or journal read fails.
- `/word-predict off` removes the editor hook (ghosts vanish, Tab and → are pi's again), stops the worker, and writes `{"enabled":false}` to `<agentDir>/word-predict/config.json`. While it is off, submitted prompts are not recorded.
- `/word-predict on` writes `{"enabled":true}`, hooks the editor and starts the worker.
- The default (no config file, or an unreadable one) is on. The setting applies to this process at once and to other pi processes at their next session start.
- Outside the TUI the command answers "word-predict runs only in the interactive TUI" where there is a UI, and does nothing otherwise.

## What it learns from and what it stores

Everything stays on this machine. The extension has no network code: it reads and writes local files only.

**First start (no usable state file): bootstrap.** The worker reads these sources in order:

1. Claude Code and Codex histories. The paths are `$CLAUDE_CONFIG_DIR/history.jsonl` with default `~/.claude/history.jsonl`, and `~/.codex/history.jsonl`. The worker reads `display` or falls back to `text`. It skips entries starting with `/` and removes `[Pasted text #n …]` and `[Image #n …]` placeholders. It reads these files once and does not deduplicate them.
2. pi session `*.jsonl` files in `$PI_CODING_AGENT_SESSION_DIR` or `<agentDir>/sessions` and their immediate subdirectories. The worker reads text blocks from `role: "user"` messages and `!` or `!!` bash executions as `!command`. It skips assistant messages, tool results and extension-injected messages. It learns distinct prompts once, oldest first.
3. The journal, if one exists.

The worker saves the result at once. It bootstraps in batches without blocking the UI. A query waits for bootstrap to finish, up to 30 s.

**Afterwards: what you submit.** In a TUI session, while the extension is on:

- every prompt submitted from the editor, including steers and follow-ups typed while the agent runs, as typed (pasted blocks expanded, before skill or template expansion);
- every `!` / `!!` command line.

Not recorded: slash commands; prompts of sessions pi does not save (`pi --no-session`); print / JSON / RPC runs; subagent prompts; anything while the extension is off; empty prompts and prompts over 20,000 characters.

The engine normalises line ends and trailing blanks and learns each distinct prompt once. It counts only prose words using the ghost's prose checks. A prompt looks typed if it has 8 to 1,500 characters, at most 25 lines, no line over 600 characters and at least 60% prose. It must not start with `/`. The hand-written test uses the same rules with a 5,000-character maximum. Words in prompts that do not look typed count a quarter each. Prompts that are not hand-written cannot make new words eligible and do not enter the last-20-prompts list. For example, `fix it` and `ok` are under eight characters and meet neither test.

**Files**, all under `<agentDir>/word-predict/` (`~/.pi/agent/word-predict/`, or under `PI_CODING_AGENT_DIR`). The directory is created with mode `0700` and the files with `0600`; a directory or file that already exists keeps its mode.

| file | content |
|---|---|
| `journal.jsonl` | Append-only. A header line, then one line per recorded submission: the prompt text in plain form and a timestamp. This is the only place besides pi's session files where prompt text is kept. |
| `state.bin` | Word, follower and word-triple counts, casings, and word lists for the last 20 prompts. It also holds the journal position and a 48-bit hash of each pi prompt already learned. Writes replace it atomically. A SHA-1 checksum catches corruption, including truncated zstd frames. |
| `config.json` | `{"enabled": true \| false}`. |

Deleting the directory resets everything; the next start bootstraps again. A `state.bin` that is damaged or of an unknown version is deleted and rebuilt the same way.

## How it runs

- **Worker thread.** One `worker_threads` Worker per interactive process starts 300 ms after the session starts. Node ≥ 22.18 uses type stripping to load `engine/worker.ts` directly. pi 1.5.2 uses Node 22.23.3. The main thread only checks prose, looks up the cache and sends at most one message per keystroke. One request runs at a time. Only the newest waiting request stays queued. Answers are cached per word state.
- **Failures never reach the editor.** An unanswered query shows no ghost after 30 s. A failed worker waits at least 30 s before restarting. Its old-generation heap limit is 512 MB. `/word-predict status` shows `failed: <reason>` with the end of the worker's stderr.
- **Several pi processes** share the two files without a daemon or locks:
  - A submitted prompt is appended to `journal.jsonl` by the main thread, synchronously, with one `O_APPEND` write; then the worker is told to read on.
  - A worker's model is always "the state it loaded or bootstrapped, plus the journal lines after that state's position, in file order, minus prompts already seen". It reads new lines when its own process submits, and when a query arrives and the journal has grown (checked at most every 2 s), so a prompt submitted in one window is learned by the others.
  - Any process may write `state.bin` (temp file, fsync, rename). Before writing it reads the existing file's header and skips the write when that state already covers at least as much of the same journal. Otherwise the last writer wins; every state file is consistent with its own journal position, so a process that loads an older one only replays more lines.
  - A journal that was deleted, replaced or damaged is recreated or repaired with a new id; readers then replay it from the start, and the seen-prompt hashes keep that from counting anything twice.
- **Save schedule**: save 5 minutes after the last learned prompt and no later than 15 minutes after the first unsaved one. Saving first drops word triples seen only in pasted text.
- **Shutdown**: quitting, `/new`, `/resume`, forking, `/reload` and `/word-predict off` remove the editor hook and ask the worker to stop. It saves first only after 64 or more unsaved prompts or if it has never saved the first bootstrap. Otherwise it stops at once. The journal holds unsaved prompts for replay on the next start. The main thread waits at most 400 ms before terminating the worker. Killing it mid-save leaves the old `state.bin` intact.
- **Idle.** After 15 minutes without a query or a submission the worker is stopped the same way; the next query starts a new one, which restores the saved state.
- **Unwritable state directory** (`EACCES` / `EROFS` / `EPERM`): the worker still serves, from the web table and a readable `state.bin` if there is one, and learns and saves nothing. `/word-predict status` then shows `worker: ready` and the reason as `engine error: …`.
- **`/reload`.** pi-tui's `Editor.prototype.render` and `.handleInput` are wrapped once per process by thin trampolines that delegate to a hook on `globalThis`; each extension runtime installs its own hook at session start and clears it at shutdown. For other editors, with no hook installed, or when anything in the hook throws, the trampolines are pi-tui's own methods. If pi-tui's `Editor` does not look as expected, nothing is patched and the extension reports `word-predict disabled: …` once and stays inert. magic-keywords is not modified and does not need to be loaded.

## Conformance

Seven JSONL vector sets cover learning order, misspelling folding and shadowing, vocabulary compaction, save and restore, prompt-local and session caches, casing and non-ASCII text. The vectors are not in this repository.

All 47,586 completions match the expected suffix or lack of one and the exact `f32` confidence. This holds at the default 0.15 threshold and with gating disabled, for 95,172 checked completions.

Run the replay CLI from the repository root with Node. Set `VECTORS` to a directory containing the scripts and expected output:

```sh
VECTORS=/path/to/vectors
for S in basic cold hygiene feedback compaction snapshot corpus; do
  node word-predict/engine/replay.ts "$VECTORS/$S.script.jsonl" --show-threshold -inf --expect "$VECTORS/$S.expected.nogate.jsonl"
  node word-predict/engine/replay.ts "$VECTORS/$S.script.jsonl" --expect "$VECTORS/$S.expected.jsonl"
done
```

Each run prints a summary, `result PASS` or `FAIL`, and up to 20 mismatches. Failure exits with status 1. Confidence checks allow a difference of 1e-6 and count non-bit-equal lines separately. Without `--expect`, the CLI prints one JSON line per operation. `--explain` shows candidate scores for mismatches. `--state-dir DIR` keeps state in `DIR/ngram.snapshot`. `--bench` prints timings and memory. `--info` prints engine parameters.

One `--bench` run over the `corpus` set on the development machine: `complete` p50 6.7 µs, p99 0.12 ms; `observe` p50 33 µs; decoding the web table 84 ms; restoring a 0.5 MB snapshot 81 ms.

## Native terminals (tsp-native)

tsp-native uses the Tern Surface Protocol. The terminal draws the ghost after the caret.

word-predict registers a provider in the ghost slot in `shared/composer-slots.ts`. The `editor` describer sets the `ghost` prop on the prompt editor's node when the draft is not empty. The prop is part of the node fingerprint, so an answer re-emits the node. In rsttyd, tapping or clicking the ghost sends Tab to pi. It accepts the ghost with a provisional space. Hardware keys use the editor's usual key handler.

Native `edit` events from selection editing or soft keyboards bypass the key handler. The ghost follows the new draft on the next frame, but the edit does not settle a provisional space. Tab followed by a soft-keyboard `.` gives `weather .`.

## Files

| file | role |
|---|---|
| `index.ts` | Extension entry: session start / shutdown, the `input` and `user_bash` feeds, `/word-predict`, the status text. |
| `editor-hook.ts` | The trampolines on pi-tui's `Editor`, the ghost for an editor state, Tab / → accept, the provisional space, the native ghost provider. |
| `ghost-row.ts` | Pure helpers: painting the ghost into the cursor row, and reading from the editor state before and after a key what it typed. |
| `provider.ts` | Pure: word selection and prose gates, the answer cache, single-flight requests and typing through a ghost. |
| `host.ts` | Main-thread side of the worker: spawn, requests, timeouts, idle stop, shutdown; appends submissions to the journal; reads and writes `config.json`. |
| `protocol.ts` | Message and status types between `host.ts` and the worker. |
| `engine/worker.ts` | Worker entry: restore or bootstrap, read the journal, answer queries, persist cadence, shutdown. |
| `engine/store.ts` | `journal.jsonl` and `state.bin` formats, atomic write, prompt normalisation and hashing, the session-file and Claude Code / Codex readers, the persist timer. |
| `engine/engine.ts` | The engine as one object: `complete`, `observe`, `snapshot`, the 0.15 threshold. |
| `engine/model.ts` | Counts and learning: weighting of typed and pasted prompts, folding of misspellings, eligibility flags, vocabulary compaction, casing, the session cache. |
| `engine/query.ts` | Ranking of the candidates under a prefix, the prompt-local cache, the confidence. |
| `engine/structures.ts` | Fenwick tree, max segment tree, follower lists, the pair / triple table, byte-order word comparison. |
| `engine/vocab.ts` | Word ↔ id table: sorted base plus overflow list. |
| `engine/web.ts` | Decoder of the web table. |
| `engine/snapshot.ts` | Encoder and decoder for `ngram.snapshot` v1. |
| `engine/prose.ts`, `engine/text.ts`, `engine/hygiene.ts` | The engine's prose rules and typed / pasted test; left context and lowercasing; enumeration of one-edit spellings. |
| `engine/replay.ts` | The conformance and benchmark CLI. |
| `data/web-prior.bin.zst`, `data/NOTICE` | The web table and its notice (next section). |

Also used: the ghost slot in `shared/composer-slots.ts`, the `editor` describer in `tsp-native/describers.ts` and the code and markup mask in `shared/prose.ts`.

## The data file

`data/web-prior.bin.zst` is 2.6 MB compressed and about 6 MB decoded. Its abbreviated SHA-256 is `d930584e…999d1d`. It holds the 150,000 most frequent lowercase word forms and their counts, 258,168 word-pair counts including sentence starts, and dictionary flags for those words and 192,511 more. The engine uses this read-only table for words you have not typed yet and to distinguish spellings from typos. Every process uses the same table.

See `data/NOTICE` for MIT licence text and data sources. The licence terms of the underlying word lists have not been checked.

## Unsupported features

- The extension uses only the N-gram engine. It does not download weights, flag typos in the editor or autocorrect. It does not predict whole messages or offer a list of suggestions.
- Each interactive pi process has its own engine in memory. The journal and state files are shared. There is no daemon or prompt database.
- Lines starting with `/` contain no prose words. Slash commands are not recorded. There is no secret filter for them.
- The engine gets no feedback when you accept or type past a ghost.
- There is no special cursor-row layout, IME layout, Vim selection variant or hint-style theme hook. With pi's hardware cursor on, the ghost starts one cell after the caret.
- There is no settings-panel entry, user-facing prediction CLI or RPC completion request.

## Known limits

- `journal.jsonl` is never rotated or compacted. It grows by one line per recorded submission, repeats included.
- The bootstrap cannot tell what you typed from what merely is a user message in a session file: an expanded skill or prompt template, a prompt of a print / RPC / SDK run, a message another extension sent as the user. All are learned, under the engine's pasted-text rules.
- Sessions are found only under `$PI_CODING_AGENT_SESSION_DIR` or `<agentDir>/sessions`, one directory level deep. A session directory configured another way is not read. A session line longer than 64 MiB is skipped.
- The bootstrap happens once. Prompts submitted while the extension was off, or session files added later, are not picked up unless `state.bin` is deleted.
- On / off changes reach other running pi processes only at their next session start.
- The cache holds 256 word states. Learning new prompts does not clear it.
- The engine uses Node's letter and case tables. pi 1.5.2 uses Unicode 17. Characters added or reclassified in a different Unicode version may behave differently.

## Not verified

Watched in a live terminal (pi 1.5.2 in tmux, ANSI rendering, magic-keywords loaded): the dim ghost after the cursor cell, typing through it, Tab accepting with the trailing space, → accepting without it, no ghost on a slash token, words learned from session files at bootstrap, `/word-predict status` / `off` / `on` with the setting persisted in `config.json`, a keyword shimmer and a ghost on the same row, a prompt exit (about 110 ms), and print / JSON modes staying inert.

Not verified:

- Everything under TSP native rendering: the `ghost` prop drawn by rsttyd, tapping it to accept, and typing from a phone keyboard have never been seen running. The slot, the describer change and rsttyd's drawing and tap handling were read in source; the path was not exercised end to end.
- pi's hardware-cursor setting, where the ghost should start one cell after the caret, was not tried.
- The fixture checks establish bit-exact confidence on x86-64 Linux only. The only platform function involved is `exp` in the prompt-local cache.
- The timings above are one run on one machine.

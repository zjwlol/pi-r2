# word-predict: oh-my-pi's Word Autocomplete for pi

A port of oh-my-pi's "Word Autocomplete" (its `spelling.autocomplete` setting, default `auto`, which is the N-gram engine) on top of vanilla pi's extension API. While you type prose in the prompt editor, the rest of the word you are probably typing is shown dim after the caret; Tab or → accepts it. The predictions come from a word N-gram model that learns from the prompts you submit, backed by a fixed table of English web word counts. The engine is a TypeScript port of oh-my-pi's Rust crate `pi-predict` (`ngram`), checked against the Rust original (see [Conformance](#conformance)).

It runs only in the interactive TUI. In print, JSON and RPC mode nothing is started, patched, read or written.

## What it does

- **Ghost text.** A ghost is offered when all of these hold:
  - the caret is at the end of a line of the draft (any line of a multi-line draft), and pi's own autocomplete popup is closed;
  - a word of letters, combining marks or apostrophes ends at the caret; one letter is enough;
  - the word is prose (see "No ghost" below);
  - the engine's best candidate has a confidence of at least 0.15. The confidence is the candidate's share among every word that starts with what you typed, including the typed letters as a finished word, so `the` shows nothing unless a longer word clearly beats stopping there.
- **What the engine ranks with**: your own word, word-pair and word-triple counts (the previous one or two prose words are the context; code, digits and markup break the chain, a sentence or line start is its own context); the web counts as a prior; words used earlier in the same draft (the last 2,000 characters before the word are sent as context); and the words of the last 20 hand-written prompts (defined under [What it learns from](#what-it-learns-from-and-what-it-stores)).
- **Tab** inserts the ghost and a space. **→** inserts the ghost alone, so a suffix can follow (`weath` → → `s` gives `weathers`). Either is one undo step. Both work even when the row had no free cell left to paint the ghost.
- **Typing through.** Typing the ghost's own letters keeps it in place; a letter that differs drops it. Case is ignored for this.
- **The provisional space.** The space Tab adds is decided by the next key only:
  - a typed space is swallowed (you get one space, not two);
  - one of `- . , ; : ! ? ) ] }` takes its place (`weather` Tab `.` gives `weather.`; undo gives back `weather ` with the space);
  - a newline removes it;
  - anything else, including a quote, a letter or a cursor move, leaves it as an ordinary space.
- **Key precedence.** While pi's autocomplete popup is open there is no ghost, and Tab, →, Enter and the arrows are the popup's. With the popup closed, a shown ghost takes Tab before pi's own Tab completion; without a ghost, Tab and → are pi's. Extension shortcuts, app keybindings and `ctx.ui.onTerminalInput` listeners (the agent inspector's ←← / Ctrl+S / Alt+A, paste-images) run before the editor and are unaffected. → accepts only at the end of a line, because a ghost exists only there.
- **Painting.** The ghost is drawn in the theme's `dim` colour right after the cursor cell, in the free cells of the cursor's row. It is cut with `…` when it does not fit and never wraps or moves the draft. magic-keywords' gradient still paints on the same row.
- **No ghost**:
  - on a line that starts with `/` (after leading blanks), `->` or `=>`;
  - in a token that contains any of `\ / @ _ = : { } [ ] < >`, a digit, or a lowercase letter followed by an uppercase one (paths, `@file` mentions, identifiers, `[paste #1 …]` markers);
  - inside inline code, fenced code blocks and HTML/XML sections;
  - with the caret inside a word or not at the end of the line;
  - in a draft over 20,000 characters or on a line over 1,000;
  - in editors other than pi's prompt editor (dialogs, the agent inspector's message input).
- **`!` bash drafts are not excluded.** oh-my-pi has no gate for them and neither does this port: `!git sta` can show a ghost.
- **Vocabulary hygiene** (the engine's own rules): a word outside the web vocabulary and the dictionary is offered only after it occurred twice in hand-written prompts; a rare misspelling one edit away from a real word is counted as that word; a habitual slip of a word you also type is never offered. A word typed earlier in the same draft is offered regardless.

## `/word-predict [on|off|status]`

- `/word-predict` or `/word-predict status` shows, as a notification:
  ```
  word-predict: on
  worker: ready                                 # stopped / starting / loading / bootstrapping / ready / failed: <reason>
  learned: 1234 prompts, 567 foreign prompts, 8901 words
  state: 1.2 MB, saved 3m ago (/home/you/.pi/agent/word-predict)
  editor: prompt editor seen, last painted ansi  # or: native
  ```
  "foreign prompts" are the Claude Code / Codex prompts read at the first bootstrap. While no worker is ready, the counts come from the saved state file. When the engine reports a problem, a line `engine error: <reason>` follows the `worker:` line; this includes problems that leave it serving (`ready`): an unwritable state directory, a failed save, a failed journal read.
- `/word-predict off` removes the editor hook (ghosts vanish, Tab and → are pi's again), stops the worker, and writes `{"enabled":false}` to `<agentDir>/word-predict/config.json`. While it is off, submitted prompts are not recorded.
- `/word-predict on` writes `{"enabled":true}`, hooks the editor and starts the worker.
- The default (no config file, or an unreadable one) is on. The setting applies to this process at once and to other pi processes at their next session start.
- Outside the TUI the command answers "word-predict runs only in the interactive TUI" where there is a UI, and does nothing otherwise.

## What it learns from and what it stores

Everything stays on this machine. The extension has no network code: it reads and writes local files only.

**First start (no usable state file): bootstrap.** In this order, as oh-my-pi's daemon does with its own sources:

1. Claude Code's and Codex's prompt histories, when they exist: `$CLAUDE_CONFIG_DIR/history.jsonl` (default `~/.claude/history.jsonl`) and `~/.codex/history.jsonl`. Per line the `display` field (else `text`) is taken; entries starting with `/` are skipped and `[Pasted text #n …]` / `[Image #n …]` placeholders are removed. These are read once, at bootstrap, and are not deduplicated.
2. pi's session files: every `*.jsonl` directly in the sessions directory and in its immediate subdirectories (`$PI_CODING_AGENT_SESSION_DIR`, default `<agentDir>/sessions`). Only `role: "user"` messages (their text blocks) and `!` / `!!` bash executions (as `!command`) are read; assistant messages, tool results and extension-injected messages are not. They are learned oldest first, each distinct prompt once.
3. The journal (below), if one already exists.

The result is saved at once. The bootstrap runs in the worker, in batches, and does not block the UI; a ghost requested meanwhile is answered when it is done (or not at all, if that takes more than 30 s).

**Afterwards: what you submit.** In a TUI session, while the extension is on:

- every prompt submitted from the editor, including steers and follow-ups typed while the agent runs, as typed (pasted blocks expanded, before skill or template expansion);
- every `!` / `!!` command line.

Not recorded: slash commands; prompts of sessions pi does not save (`pi --no-session`); print / JSON / RPC runs; subagent prompts; anything while the extension is off; empty prompts and prompts over 20,000 characters.

Each distinct prompt (after normalising line ends and trailing blanks) is learned once, however often it is submitted. From a prompt the engine counts only prose words, by the same rules that decide where a ghost may appear. A prompt looks typed when it has 8 to 1,500 characters, at most 25 lines, no line over 600 characters, does not start with `/`, and is at least 60 % prose; up to 5,000 characters it still counts as hand-written. A prompt that does not look typed counts a quarter per word. One that is not hand-written also cannot make a new word eligible and does not enter the last-20-prompts list (so `fix it` and `ok`, under 8 characters, weigh a quarter and do neither).

**Files**, all under `<agentDir>/word-predict/` (`~/.pi/agent/word-predict/`, or under `PI_CODING_AGENT_DIR`). The directory is created with mode `0700` and the files with `0600`; a directory or file that already exists keeps its mode.

| file | content |
|---|---|
| `journal.jsonl` | Append-only. A header line, then one line per recorded submission: the prompt text in plain form and a timestamp. This is the only place besides pi's session files where prompt text is kept. |
| `state.bin` | The learned model (word counts, follower counts, word-triple counts, casings, the word lists of the last 20 prompts), the journal position it covers, and a 48-bit hash of every pi prompt already learned. Sealed with a SHA-1 and replaced atomically. |
| `config.json` | `{"enabled": true \| false}`. |

Deleting the directory resets everything; the next start bootstraps again. A `state.bin` that is damaged or of an unknown version is deleted and rebuilt the same way.

## How it runs

- **Worker thread.** The engine runs in a `worker_threads` Worker (`engine/worker.ts`), one per interactive pi process, started 300 ms after the session starts. Node loads the `.ts` file directly (type stripping, Node ≥ 22.18; pi 1.5.2's Node is 22.23.3). No engine code runs on the main thread: a keystroke costs the prose gates, a cache lookup and at most one message to the worker. Requests are single-flight (one in flight, only the newest other one queued) and answers are cached per word state.
- **Failures never reach the editor.** A query that cannot be answered shows no ghost. A query unanswered after 30 s resolves empty; a worker that fails is not restarted for 30 s; its old-generation heap is capped at 512 MB. `/word-predict status` shows `failed: <reason>` with the tail of the worker's stderr.
- **Several pi processes** share the two files without a daemon or locks:
  - A submitted prompt is appended to `journal.jsonl` by the main thread, synchronously, with one `O_APPEND` write; then the worker is told to read on.
  - A worker's model is always "the state it loaded or bootstrapped, plus the journal lines after that state's position, in file order, minus prompts already seen". It reads new lines when its own process submits, and when a query arrives and the journal has grown (checked at most every 2 s), so a prompt submitted in one window is learned by the others.
  - Any process may write `state.bin` (temp file, fsync, rename). Before writing it reads the existing file's header and skips the write when that state already covers at least as much of the same journal. Otherwise the last writer wins; every state file is consistent with its own journal position, so a process that loads an older one only replays more lines.
  - A journal that was deleted, replaced or damaged is recreated or repaired with a new id; readers then replay it from the start, and the seen-prompt hashes keep that from counting anything twice.
- **Persist cadence** (oh-my-pi's): 5 minutes after the last learned prompt, at the latest 15 minutes after the first unsaved one. Saving first drops word triples seen only in pasted text, as upstream's persist does.
- **Shutdown** (quit, `/new`, `/resume`, fork, `/reload`, `/word-predict off`): the editor hook is removed and the worker is asked to stop. It saves first only when at least 64 prompts were learned since the last save, or when a first bootstrap was never saved; otherwise it exits at once, because the journal already holds every unsaved prompt and the next start replays it. The main thread waits at most 400 ms, then terminates the worker. A kill in the middle of a save leaves the old `state.bin` intact.
- **Idle.** After 15 minutes without a query or a submission the worker is stopped the same way; the next query starts a new one, which restores the saved state.
- **Unwritable state directory** (`EACCES` / `EROFS` / `EPERM`): the worker still serves, from the web table and a readable `state.bin` if there is one, and learns and saves nothing. `/word-predict status` then shows `worker: ready` and the reason as `engine error: …`.
- **`/reload`.** pi-tui's `Editor.prototype.render` and `.handleInput` are wrapped once per process by thin trampolines that delegate to a hook on `globalThis`; each extension runtime installs its own hook at session start and clears it at shutdown. For other editors, with no hook installed, or when anything in the hook throws, the trampolines are pi-tui's own methods. If pi-tui's `Editor` does not look as expected, nothing is patched and the extension reports `word-predict disabled: …` once and stays inert. magic-keywords is not modified and does not need to be loaded.

## Conformance

The engine under `engine/` is a file-for-file port of `crates/pi-predict/src/ngram/` and `prose.rs`. It was checked against a test oracle that drives the real Rust engine (a small Rust binary built against upstream's `crates/pi-predict` at commit `67ef5342de`, plus seven sets of JSONL scripts with its expected output). The oracle and its vectors were built in a scratch directory and are not part of this repository.

Result on the oracle's seven vector sets (`basic`, `cold`, `hygiene`, `feedback`, `compaction`, `snapshot`, `corpus`): all 47,586 completions return the same suffix (including "no suggestion") and a confidence that is bit-equal as `f32`, in both modes (the default 0.15 threshold and ungated), i.e. 95,172 compared lines with no difference. The sets cover learning order, misspelling folding and shadowing, vocabulary compaction, persist and restore, the prompt-local and session caches, casing and non-ASCII text.

To re-run (plain node, no pi) from the repository root, with `O` pointing at a directory that holds such an oracle's `vectors/`:

```sh
O=/path/to/oracle
for S in basic cold hygiene feedback compaction snapshot corpus; do
  node word-predict/engine/replay.ts $O/vectors/$S.script.jsonl --show-threshold -inf --expect $O/vectors/$S.expected.nogate.jsonl
  node word-predict/engine/replay.ts $O/vectors/$S.script.jsonl                       --expect $O/vectors/$S.expected.jsonl
done
```

Each run prints a summary and `result PASS` or `FAIL` (exit status 1), with the first 20 mismatches. A confidence within 1e-6 of the oracle's passes, and lines that are not bit-equal are counted separately; there are none. Other options: without `--expect` the CLI prints the oracle's output format; `--explain` adds the port's candidate table for each mismatch; `--state-dir DIR` keeps the engine state as `DIR/ngram.snapshot` in upstream's snapshot format (a snapshot written by either engine was read by the other with identical answers on 500 probes); `--bench` prints timings and memory; `--info` prints the engine parameters.

One `--bench` run over the `corpus` set on the development machine: `complete` p50 6.7 µs, p99 0.12 ms; `observe` p50 33 µs; decoding the web table 84 ms; restoring a 0.5 MB snapshot 81 ms.

## Native terminals (tsp-native)

When tsp-native renders pi through the Tern Surface Protocol, the ghost is not painted into rows. `shared/composer-slots.ts` has a ghost slot; word-predict registers a provider there, and tsp-native's `editor` describer puts the provider's answer on the prompt editor's `editor` node as its `ghost` prop (only while the draft is non-empty; it is part of the describer's fingerprint, so an engine answer re-emits the node). The terminal draws it after the caret. rsttyd turns a tap or click on the ghost into a Tab key, which arrives on pi's input like any key and accepts the ghost with the provisional space. Keys typed on a hardware keyboard take the same path as in the ANSI editor.

Edits the terminal applies itself (its `edit` events: selection editing, soft keyboards) change the draft without passing through the key handler. The ghost follows the new text at the next frame, but such an edit does not resolve a provisional space: Tab, then a soft-keyboard `.`, gives `weather .`.

## Files

| file | role |
|---|---|
| `index.ts` | Extension entry: session start / shutdown, the `input` and `user_bash` feeds, `/word-predict`, the status text. |
| `editor-hook.ts` | The trampolines on pi-tui's `Editor`, the ghost for an editor state, Tab / → accept, the provisional space, the native ghost provider. |
| `ghost-row.ts` | Pure helpers: painting the ghost into the cursor row, and reading from the editor state before and after a key what it typed. |
| `provider.ts` | Pure: which word at the caret is asked about (the prose gates), the answer cache, single-flight requests, keeping a ghost while it is typed through. Port of oh-my-pi's `word-completion.ts` and `prose-gate.ts`. |
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
| `engine/snapshot.ts` | Encoder and decoder of the model snapshot, byte-compatible with upstream's `ngram.snapshot` v1. |
| `engine/prose.ts`, `engine/text.ts`, `engine/hygiene.ts` | The engine's prose rules and typed / pasted test; left context and lowercasing; enumeration of one-edit spellings. |
| `engine/replay.ts` | The conformance and benchmark CLI. |
| `data/web-prior.bin.zst`, `data/NOTICE` | The web table and its notice (next section). |

Outside this directory: `shared/composer-slots.ts` (the ghost slot), `tsp-native/describers.ts` (three lines in the `editor` describer), and `shared/prose.ts` (the code / markup mask, used as is).

## The data file

`data/web-prior.bin.zst` (2.6 MB, about 6 MB decoded) is copied byte for byte from oh-my-pi's `crates/pi-predict/data/` (sha256 `d930584e…999d1d`). According to the script that builds it upstream, it holds the 150,000 most frequent lowercase word forms of Peter Norvig's web unigram list with their counts, 258,168 word-pair counts between them (including sentence starts), and which words, among those and 192,511 more, are in `/usr/share/dict/words`. The engine uses it as the prior for words you have not typed yet and to tell real spellings from typos. It is read-only and the same for everyone.

`data/NOTICE` records the origin of the ported code and of this file, oh-my-pi's MIT licence text, and the data's provenance as upstream states it (Norvig's `count_1w.txt` / `count_2w.txt`, derived from the Google Web Trillion Word Corpus, and the system word list). The licence terms of those underlying lists were not checked for this port.

## Not replicated / differences from oh-my-pi

- **The `smollm` and `apple` engines**, and with them the SmolLM / N-gram blend, the weight download, typo detection and autocorrect: out of scope. The setting's five values become on / off.
- **Composer Predictions** (an LLM predicting your next message, with its own Tab behaviour and alternatives list): a separate oh-my-pi feature, not ported.
- **The machine-global daemon.** oh-my-pi serves every process from one daemon under a global broker over a socket. Vanilla pi has no broker, so each interactive process has its own engine in a worker thread and the journal and state file do the sharing. The cost is one engine's memory per interactive pi process instead of one per machine.
- **The learning source.** oh-my-pi learns from its prompt database (`history.db`) with a row cursor. Vanilla pi has none: the bootstrap reads session files instead, and later submissions go through the journal. The "each distinct prompt once" rule of the database is kept with the prompt hashes.
- **Slash commands are not recorded.** oh-my-pi stores them in its history (minus ones carrying secrets); a line starting with `/` has no prose words, so nothing is lost, and no secret filter is needed.
- **Saving at shutdown.** oh-my-pi's daemon saves whenever it stops. Here a stop saves only a large backlog (see above), so quitting does not wait for a save.
- **The bootstrap is saved immediately**; oh-my-pi only arms its 5-minute timer.
- **Accept / typed-past feedback** is not sent to the engine. oh-my-pi sends it, and its N-gram engine ignores it.
- **State integrity.** Node's zstd does not report a truncated frame, so `state.bin` carries its own SHA-1 around the upstream-format snapshot.
- **Hint painting variants** of oh-my-pi's editor (terminal-cursor row, IME-safe layout, Vim selection, a theme hook for the hint style) do not exist in pi-tui's editor. With pi's hardware cursor enabled, the ghost starts one cell after the caret.
- **The provisional space is resolved after pi-tui handled the key**, by comparing the editor state before and after, because the editor itself is not replaced; the outcomes are oh-my-pi's.
- **No settings-panel entry, no `omp predict` CLI, no RPC completion request.**

## Known limits

- `journal.jsonl` is never rotated or compacted. It grows by one line per recorded submission, repeats included.
- The bootstrap cannot tell what you typed from what merely is a user message in a session file: an expanded skill or prompt template, a prompt of a print / RPC / SDK run, a message another extension sent as the user. All are learned, under the engine's pasted-text rules.
- Sessions are found only under `$PI_CODING_AGENT_SESSION_DIR` or `<agentDir>/sessions`, one directory level deep. A session directory configured another way is not read. A session line longer than 64 MiB is skipped.
- The bootstrap happens once. Prompts submitted while the extension was off, or session files added later, are not picked up unless `state.bin` is deleted.
- On / off changes reach other running pi processes only at their next session start.
- Answers are cached per word state (256 entries) and are not dropped when the engine learns, as upstream.
- The engine's letter and case tables are Node's (Unicode 17 in pi 1.5.2's Node); the Rust build it was compared with has Unicode 18. Characters added or reclassified in between can be treated differently.

## Not verified

Watched in a live terminal (pi 1.5.2 in tmux, ANSI rendering, magic-keywords loaded): the dim ghost after the cursor cell, typing through it, Tab accepting with the trailing space, → accepting without it, no ghost on a slash token, words learned from session files at bootstrap, `/word-predict status` / `off` / `on` with the setting persisted in `config.json`, a keyword shimmer and a ghost on the same row, a prompt exit (about 110 ms), and print / JSON modes staying inert.

Not verified:

- Everything under TSP native rendering: the `ghost` prop drawn by rsttyd, tapping it to accept, and typing from a phone keyboard have never been seen running. The slot, the describer change and rsttyd's drawing and tap handling were read in source; the path was not exercised end to end.
- pi's hardware-cursor setting, where the ghost should start one cell after the caret, was not tried.
- Bit-equality with the Rust engine was established on one platform (x86-64 Linux). The only platform function involved is `exp` in the prompt-local cache.
- The timings above are one run on one machine.

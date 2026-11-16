# btw: oh-my-pi's `/btw` side questions for pi

A port of oh-my-pi's `/btw` (ask a question about the running session without putting it in the transcript) on top of vanilla pi's extension API: the inline answer panel, the history overlay with follow-ups, branch promotion, `<inject>` steering prompts and `side: true` prompt templates.

## What it does

- **Asking**: `/btw <question>` sends one extra model request and shows the answer above the editor. The question is everything after `/btw`, trimmed (a line break or tab right after `/btw` works too).
  - It uses the session's current model and thinking level, and works while pi is idle **and while a turn is streaming**. The running turn is not steered, interrupted or delayed; the request goes out next to the agent loop (`ctx.modelRegistry.streamSimple`).
  - The model sees the session as the main loop would send it now (system prompt, tool declarations, the conversation with compaction applied), plus the text the assistant has streamed so far in the current turn, then the question wrapped in oh-my-pi's `<btw>` prompt. It is told that tools are not available; tool calls it emits anyway are dropped.
  - Question and answer are **never added to the transcript** and never reach later main turns. Each `/btw <question>` is independent of earlier ones; only an explicit follow-up continues a topic.
  - One request at a time. A second question while one runs is refused (`A /btw question is still running. Open /btw to view it or cancel it first.`), and so is any question while a start or a branch is in progress. There is no queue. A refused or unsendable question (no model: `No active model available for /btw.`) goes back into the editor if the editor is empty.
  - The finished answer is trimmed, and a run of more than 3 identical consecutive lines is collapsed to the line plus `[…N×]`. There is no length cap.
- **Inline panel** (text rendering): a rounded box above the editor titled `/btw <question>`. It shows `⏳ Waiting for response…` until text arrives, then the answer as Markdown while it streams. The footer names the keys that work now.
  - The body takes at most `max(6, terminal rows − 12)` rows. A longer answer shows its newest rows while streaming and its first rows afterwards, with `… +N more lines · /btw to read it all`; the history overlay shows it whole.
  - Keys are read with `ctx.ui.onTerminalInput` and only while the main prompt editor has focus:
    - **Esc** (pi's `app.interrupt` key): while the answer runs it cancels the request; the partial answer stays, marked `⚠ Cancelled`. On a finished, cancelled or failed panel it closes the panel. While a panel is visible Esc acts on the panel first, so it does not interrupt the main turn. With the editor's autocomplete popup open, Esc goes to the popup.
    - **`c`** copies the completed answer (tabs expanded, trimmed). The title gains `✓ Copied` and the footer `✓ Copied to clipboard · c to copy again`.
    - **`f`** opens the history overlay on this topic with the follow-up input open.
    - **`b`** promotes the question and answer into a new session branch (see below).
    - **Alt+I** sends the answer's `<inject>` block to the main session (only with `btw.inject`, see below).
    - `c`, `f` and `b` are taken only when the editor is blank and its autocomplete popup is closed, and only when their action is available (`c` and `b`: a complete, non-empty answer; `f`: a complete answer); otherwise they are typed as usual. Esc and Alt+I also work with a draft in the editor.
  - A provider failure shows the error as one sanitized line with `✘ Error · esc to close`. A complete answer without text shows `No text returned.` and offers neither copy nor branch.
  - A new question replaces the previous finished panel. Closing a panel does not delete anything; the topic stays in history.
- **History overlay**: bare `/btw` opens a full-screen "BTW history" overlay (`ctx.ui.custom`, `overlay: true`) without a model request. Topics are listed newest first, the newest selected.
  - Two panes, `History (N)` and `Details`. Below 96 columns only the focused pane is drawn. With exactly one topic there is no list to pick from and Details has the keys.
  - A list row shows the time (today) or date, the status (`Running`, `Complete`, `Cancelled`, `Error`, `Interrupted`) and the topic's first question on one line. A pane narrower than 36 columns uses two rows per topic.
  - Details shows every turn of the topic in order: status and date, `Question`, `Answer` (Markdown), the error line of a failed turn, and `Not resumed in this view.` for an interrupted one. Turns are separated by a rule. A pane that overflows gets a scrollbar column.
  - Keys: **↑/↓**, **PgUp/PgDn**, **Home/End** move the selection in the list or scroll Details (pi's `tui.select.*` bindings apply); **Shift+↑/↓** scroll Details by 5 rows; **Tab**, **Shift+Tab** or **Ctrl+/** switch pane; **→** focuses Details, **←** returns to the list; the **mouse wheel** moves the selection over the list and scrolls over Details.
  - **Esc** cancels the selected topic when it is running (the overlay stays open), otherwise it closes the overlay. If a question is still running when the overlay closes, its inline panel comes back with the answer so far.
  - **`c`** copies the selected topic's latest non-blank answer; the hint reads `✓ copied · c to copy again` until that answer changes. **`f`** or **Enter** opens the follow-up input. **`b`** branches, and **Alt+I** injects, under the same conditions as on the inline panel.
  - Empty history reads `No side questions yet.` / `Use /btw QUESTION to start one.`
- **Follow-ups**: a one-line input (`Follow up: `) under the details of the selected topic. Enter sends a non-empty question; Esc drops the draft and returns to the overlay. While it is open every key is text for the input, except ↑/↓, PgUp/PgDn and Shift+↑/↓, which still scroll the answer above.
  - A follow-up appends a turn to its topic. Its request replays the topic's earlier turns after the main conversation as separate user and assistant messages, then the new question. A cancelled turn's partial text is replayed; a turn without any answer text replays only its question. The main conversation in that request is the current one, not the one of the first question.
  - Any topic that is not running can be followed up from the overlay, including cancelled, failed and interrupted ones. `f` on the inline panel needs a complete answer.
  - Follow-ups are refused while any `/btw` request runs. A refused start keeps the draft (`Follow-up was not started. Your draft is kept; enter to retry.`), and Enter while a start is pending does not start a second one.
  - The list keeps showing the topic's first question; Details shows the whole conversation.
- **Branch promotion** (`b`): the completed answer becomes part of a new session. A new session file is created from the current session up to the entry that was the leaf when the question was asked (`SessionManager.createBranchedSession`, with the old file as `parentSession`); the question is appended as a user message and the answer as an assistant message; pi then switches to that file like `/resume`. The new session shows `Branched /btw to <file name>`; the old session is unchanged and still listed by `/resume`.
  - Only the request answered last in this pi run can be promoted, and only while its answer is on screen (the inline panel, or the open sheet on native terminals).
  - Refused with `/btw branch unavailable: <reason>` when: a branch is already in progress; an inject is still being sent; the answer is not complete or is empty; the topic has follow-ups (`multi-turn side conversations remain in BTW history`); the session has no branch point; the session changed since the question (anything other than usage, custom, label or session-name entries was appended, or the leaf moved by `/tree` or compaction); or a main turn is still running.
  - It also fails with `Cannot branch /btw: session is not persisted` under `--no-session` and in a session that has no user message yet (pi has not written its file).
  - The promoted assistant message keeps the request's provider, model, timestamp and usage; its content is the cleaned answer text only (thinking is dropped). The question's images are promoted with it.
  - While it runs the footer shows `⏳ Branching to chat…` and Esc answers `/btw branch is in progress`. A `session_before_switch` handler that cancels the switch leaves no file behind (`/btw branch cancelled`).
- **Saved history**: every topic is one JSON file, `<agent dir>/btw-history/<session id>/entry-<record id>.json` (agent dir: pi's, `~/.pi/agent` by default). The directory is created with mode 0700, files with 0600, and each write replaces the file atomically.
  - History is per session and independent of the session file: it is not part of the transcript, `/export` or `/share`, and it is there again after `/resume`. A fork or a `/btw` branch is a new session and starts with empty history.
  - A turn is saved when it starts (before the model request; if that write fails the question is not asked), and again when it is cancelled, completes or fails. A session switch, fork, `/reload` or quit cancels a running question and saves it as `Cancelled`.
  - A turn found `running` on disk (pi was killed mid-answer) is shown as `Interrupted`; the file is not rewritten for that.
  - A file that changed on disk since this pi process read it is not overwritten (`BTW history conflict for <id>; reopen history before retrying`). A malformed or unknown-field record makes history fail to open (`Cannot open /btw history: …`) and is left as it is.
  - `--no-session`: history is kept in memory only.
  - Images attached to a question are stored in its record (base64).
  - Deleting a session does not delete its history directory.
- **`btw.inject`** (off by default): lets a side answer draft a prompt for the main agent. Turn it on in pi's `settings.json` (`~/.pi/agent/settings.json`, or the project's `.pi/settings.json`), then `/reload` or restart pi:
  ```json
  { "btw": { "inject": true } }
  ```
  - With it on, the `<btw>` prompt asks the model to put a steering prompt in one `<inject>…</inject>` block when the question asks for one (for example `/btw write a prompt telling the agent to stop and fix the build first`).
  - The block is shown apart from the prose: every line behind a `▎` rail, with `Inject into main session` below. It is split out while the answer streams and once the tag is closed; an unclosed block in a finished answer stays plain text.
  - **Alt+I** sends the block's text as shown (control sequences stripped, tabs expanded, trimmed) to the main session as a user message: a steer while the agent runs, a new turn otherwise (`pi.sendUserMessage(text, { deliverAs: "steer" })`). It is never run as a slash command or expanded as a template; other extensions' `input` handlers (`^model` mentions, magic keywords) see it as they see a typed prompt.
  - Once the text has reached the session the rail turns green, the reserved column shows `➤` and the label reads `Injected into main session`. A block is sent at most once. If the text does not reach the session within 3 seconds the block returns to pending (`/btw prompt not sent · alt+i to retry`).
  - Only answers from this pi process that were asked with the setting on can be sent, and only a topic's latest completed turn. In history, blocks of earlier turns and of earlier runs are plain text; sent turns keep their mark until pi exits (also across `/reload` and session switches). Turning the setting on later does not make older answers sendable.
  - The setting is read when a question starts and when the history overlay opens. Alt+I is fixed; when there is nothing to send the key is passed through to pi.
- **`side: true` prompt templates**: a prompt template whose frontmatter has `side: true` runs as a side question when you type it in the TUI, also mid-turn. The expanded template (pi's own argument substitution) is the question; the invocation as typed (`/sitrep`, `/sitrep the migration`) is the topic's title in the panel and in history.
  ```markdown
  ---
  description: Situation report for this session
  argument-hint: "[focus]"
  side: true
  ---
  Situation report. Focus on $ARGUMENTS if given, else the whole session.
  ```
  - An extension command or skill of the same name is not intercepted. The file is re-read when it changes; if it can no longer be read or parsed, pi expands the copy it loaded as an ordinary prompt.
  - A side template carries text only (no draft images), and a refused one (another question is running) is not put back into the editor.
- **Images**: with `paste-images` loaded, `[Image #N]` tokens in a `/btw` draft are sent as image content with the question, stored with the turn and sent again with every follow-up of the topic. An image file path typed or pasted into the follow-up input is attached when the follow-up is sent (the path becomes an `[Image #N]` marker in the saved question).
  - A model without image input gets the path as text (paste-images' rule). With pi's `images.blockImages` setting on, nothing is attached, and images already in the conversation are replaced by pi's `Image reading is disabled.` placeholder in the side request.
  - Without `paste-images`, questions are text only.
- **Cost**: every side request (also a failed or cancelled one that the provider billed) is added to the session as a `usage` entry of kind `btw`, so its tokens and cost count in pi's footer and `/session` totals and persist with the session. The entry is not shown in the transcript.
- **Outside the TUI** (print, JSON, RPC): nothing is mounted and nothing is intercepted. `/btw` only reports `/btw is only available in the interactive TUI` (where there is a UI to report to) and sends no request; `side: true` templates expand as ordinary prompts.

## Native terminals (tsp-native)

On a TSP terminal with tsp-native active the answer is shown in the history sheet instead of the inline panel, as oh-my-pi does in Tern: letters typed into the terminal's native composer never reach pi as keys, and the sheet's body scrolls.

- `/btw <question>` opens the sheet (`omp.overlay.btwHistory`) on the new topic. **Esc** puts the sheet away while the answer keeps streaming (`/btw is still answering in the background · /btw to reopen it`); **`x`** cancels the selected running topic. When the answer completes with the sheet away: `/btw answer ready · /btw to read it`. Bare `/btw` reopens the sheet on the active topic.
- The sheet is the list of topics beside a reader (the topic as a short document: question, date and status line, answer, each follow-up below), the follow-up field, and a footer of buttons that mirror the keys: `Stop answer`, `Inject into main`, `Branch to chat`, `Copy answer`, `Close`, `Follow up`; `Cancel` and `Send` while composing. Clicks come back through `handleNativeEvent`; the terminal's `select` event on a list row selects that topic, its `activate` event also opens the follow-up field.
- The follow-up field and a newly started follow-up turn ask the terminal to scroll them into view (`reveal`).
- An `<inject>` block is a card (`omp.btw.inject`), toned `user` while pending and `success` once sent.
- Which renderer is active is taken from the `btw` widget: it records whether tsp-native described it or the text TUI rendered it last. Nothing is imported from `tsp-native/`, and no file there was changed.
- The inline panel also has a native form (`omp.overlay.btw`), used only if native rendering is switched on while a panel is already showing.

## Files

- `index.ts`: the extension entry. Registers `/btw`, mounts the widget and the key handler, tracks the main turn's in-flight message, routes `side: true` templates, reads the settings, records usage.
- `controller.ts`: the state machine of one session runtime: start, follow-up, cancel, copy, branch, inject, history overlay, dispose.
- `keys.ts`: the terminal-input handler for Esc, `c`, `f`, `b`, Alt+I on the main prompt editor.
- `branch.ts`: branch promotion (the new session file and the switch) and the "did the session change" check.
- `records.ts`: topic and turn types, `<inject>` parsing, record validation, display sanitizing, reply cleanup.
- `store.ts`: the per-session history directory (read, validate, atomic write, revision check).
- `request.ts`: the `<btw>` prompt, the request context (session messages, in-flight text, replayed turns) and the response stream reader.
- `side-commands.ts`: `side: true` detection and pi's template argument substitution.
- `panel.ts`: the inline answer panel and the always-mounted widget that hosts it.
- `history-panel.ts`: the history overlay, text and native, with the follow-up input.
- `inject-view.ts`: the `<inject>` block as railed rows and as a native card.
- `chrome.ts`: box rows, key hints, pane and scroll arithmetic, time stamps.
- `native.ts`: TSP node types and builders (declared locally).
- `../shared/draft-images.ts`: the hook through which `paste-images` hands a command the images of its text. `paste-images/index.ts` registers it; that is the only change to another extension.

## Not replicated / differences from oh-my-pi

- **Always the main session.** oh-my-pi answers about the focused subagent's session when one is focused and keeps separate histories per agent; vanilla pi has no focused session views.
- **No in-app toggle and no rebinding for inject.** oh-my-pi has `btw.inject` in `/settings` and `app.btw.inject` in its keybindings; vanilla's settings UI and keybinding registry are closed to extensions, so it is a `settings.json` key and a fixed Alt+I.
- **How a sent inject is confirmed.** oh-my-pi learns from the session whether a prompt was admitted or dropped. pi reports neither, so a send counts once the text shows up in the `input` event, and falls back to pending after 3 seconds. If another extension's `input` handler consumes the text first, the block reads "not sent" although it was delivered.
- **Branching goes through a session switch.** Extensions can replace the session only from a command context, so `b` dispatches `/btw` with a private token and the branch is loaded like `/resume`: extensions see `session_before_switch` and `session_start` with reason `resume`, not oh-my-pi's `session_before_branch` / `session_branch` with reason `btw`. Thinking blocks of the answer are not carried into the branch.
- **No provider conversation lineage.** oh-my-pi gives each topic its own provider-side conversation id. pi-ai has only `sessionId` and `disableContinuation`; the side request uses the session's id with continuation disabled (as pi's cache warmer does), and follow-ups rely on the provider's prefix cache.
- **Storage.** History lives under pi's agent directory keyed by session id (vanilla has no per-session artifacts directory). Writes are synchronous, so there is no write queue and no retry of failed writes. There is no cross-process lock: the revision check stops silent overwrites, but a second pi process on the same session sees another's running topic as `Interrupted` and can follow it up. The topic title is stored in the record, not in an `entry-<id>.title` file.
- **A session with only side questions is not made resumable.** pi writes a session file only once it has a user message; history saved before that cannot be reached again.
- **No blocking of session moves.** oh-my-pi refuses to relocate a session while a question runs; vanilla has no session relocation. New session, resume, fork and reload cancel the running question, as in oh-my-pi.
- **Hooks do not run for the side request.** Other extensions' `context`, `before_provider_request` and `before_provider_headers` handlers, a system prompt forced in `before_agent_start`, and codemode `only` hidden declarations are not applied. The answer is unaffected, but the request then shares less of the main loop's cached prefix.
- **In-flight thinking.** Of the message being streamed, text is kept and thinking only when it is signed (or redacted) and followed by text; oh-my-pi keeps all of it.
- **The no-tools reminder** is the first text block of the first side message instead of a separate `developer` message (pi-ai has no such role).
- **Images.** No vision-model descriptions for text-only models and no secret obfuscation (oh-my-pi pipelines). In the follow-up input an image path is attached at send time; oh-my-pi shows the marker at paste time.
- **Templates.** `side: true` templates use pi's substitution (`$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, `${@:2}`), not oh-my-pi's handlebars rendering or its appending of arguments to templates without placeholders.
- **Follow-up input.** No push-to-talk, and no hardware-cursor placement for IMEs.
- **Native keyboard scrolling.** oh-my-pi forwards arrow and page keys to the sheet's reader; this repo's tsp-native has no such node field, so the reader scrolls with the pointer only.
- **RPC.** oh-my-pi's `btw`, `btw_cancel` and `get_btw_history` RPC commands are not provided.
- **Added here:** the height cap of the inline panel (vanilla widgets cannot scroll), Shift+↑/↓ in Details, and the scrollbar column.

## Not verified

Checked in a live session (pi 1.5.2 in tmux, text rendering, a Bedrock Claude model, with `word-predict`, `magic-keywords`, `paste-images` and `subagent` loaded):

- `/btw <question>` while idle and while a main turn streamed: the answer quoted the in-flight text and the main turn carried on.
- The inline panel and its footer hints; Esc cancelling a running question (`Cancelled`) and closing the panel.
- `f`: a follow-up through the history overlay, with the topic replayed; bare `/btw` history with both panes.
- The cancelled topic was there again after quitting and resuming with `pi -c`.
- `b` promoting an answer into a new session.
- `btw.inject` on: Alt+I sent the block as a new turn, the block turned to `Injected into main session`, and a second Alt+I did nothing.
- One `usage` entry of kind `btw` per question, and the footer cost rising.
- Prompt-cache reuse: the side requests reported cache-read tokens (5,168 on one answer).
- Print and JSON modes stayed inert.

Not verified:

- **Everything under TSP native rendering in rsttyd**: the sheet, its buttons, the follow-up field and key delivery (Esc, `x`, `f`, `c`, `b`, Alt+I while the sheet or its field has focus). The node shapes, roles, `reveal` and event handling were only checked against this repo's tsp-native reconciler and rsttyd's frontend source (which styles `omp.overlay.btwHistory`, the `omp.btw.*` roles, `omp.actions` and `omp.btn`; `omp.btw.inject` has no rule of its own and falls back to a toned card).
- **`c`**: copying to the clipboard.
- **Mouse wheel** in the history overlay.
- **Images** in questions and in follow-ups.
- **`side: true` templates** in a live session.
- **Alt+I as a steer** while a main turn runs (only the idle case, a new turn, was seen).
- **The `Interrupted` state** after pi is killed mid-answer.
- **Mid-stream request shapes on other providers.** A question asked mid-turn sends an assistant message cut from the stream (text, signed thinking before it, no tool calls), possibly pi-ai's synthetic results for tool calls still executing, and then the side question as a further user message. Bedrock Claude accepted this; no other provider was tried.

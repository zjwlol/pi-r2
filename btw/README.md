# btw: `/btw` side questions for pi

Ask about the current session without adding the question or answer to its transcript. Read answers above the editor or follow up in history. Promote an answer into a branch, send an `<inject>` steering prompt, or run a `side: true` prompt template.

## What it does

- **Asking**: `/btw <question>` sends one extra model request and shows the answer above the editor. The question is all the text after `/btw`, with surrounding whitespace removed. You can put a line break or tab after `/btw`.
  - The request uses the session's current model and thinking level. It works when pi is idle or streaming. It runs alongside the agent loop via `ctx.modelRegistry.streamSimple` and does not steer, interrupt or delay the running turn.
  - The request includes the system prompt, tool declarations and conversation with compaction applied. It adds any in-flight assistant text and wraps the question in a `<btw>` prompt. Signed or redacted in-flight thinking is included only when text follows it. The first text block of the first side message says tools are unavailable. Tool calls in the side answer are dropped.
  - The question and answer stay out of the transcript and later main turns. Each `/btw <question>` starts a separate topic. Only a follow-up continues one.
  - There is no queue. A second question during a request shows `A /btw question is still running. Open /btw to view it or cancel it first.` A start or branch in progress also blocks questions. With no model, pi shows `No active model available for /btw.` A refused or unsendable question returns to an empty editor.
  - The extension trims the finished answer. It collapses more than three identical consecutive lines to one line and `[…N×]`. There is no length cap.
- **Inline panel**: a rounded box above the editor titled `/btw <question>`. It shows `⏳ Waiting for response…` until text arrives. It then shows the streaming answer as Markdown. The footer lists the available keys.
  - The body takes up to `max(6, terminal rows − 12)` rows. Longer answers show their newest rows while streaming and their first rows once finished. The notice reads `… +N more lines · /btw to read it all`. The history overlay shows the full answer.
  - Keys are read with `ctx.ui.onTerminalInput` and only while the main prompt editor has focus:
    - **Esc**, pi's `app.interrupt` key, cancels a running request. The partial answer stays with `⚠ Cancelled`. On a finished, cancelled or failed answer, Esc closes the panel. The panel takes Esc before the main turn, but the autocomplete popup takes it before the panel.
    - **`c`** copies the completed answer with tabs expanded and whitespace trimmed. The title adds `✓ Copied` and the footer adds `✓ Copied to clipboard · c to copy again`.
    - **`f`** opens the history overlay on this topic with the follow-up input open.
    - **`b`** promotes the question and answer into a new session branch.
    - **Alt+I** sends the answer's `<inject>` block to the main session when `btw.inject` is on.
    - `c`, `f` and `b` work when their action is available, the editor is blank and its autocomplete popup is closed. `c` and `b` need a complete, non-empty answer. `f` needs a complete answer. Otherwise the keys insert text. Esc and Alt+I also work with a draft in the editor.
  - A provider failure shows the error as one sanitized line with `✘ Error · esc to close`. A complete answer without text shows `No text returned.` and offers neither copy nor branch.
  - A new question replaces the previous finished panel. Closing the panel leaves the topic in history.
- **History overlay**: bare `/btw` opens the full-screen `BTW history` overlay without a model request. It uses `ctx.ui.custom` with `overlay: true`. Topics appear newest first. The newest is selected.
  - Two panes, `History (N)` and `Details`. Below 96 columns only the focused pane is drawn. With exactly one topic there is no list to pick from and Details has the keys.
  - A list row shows the time (today) or date, the status (`Running`, `Complete`, `Cancelled`, `Error`, `Interrupted`) and the topic's first question on one line. A pane narrower than 36 columns uses two rows per topic.
  - Details shows every turn of the topic in order: status and date, `Question`, `Answer` (Markdown), the error line of a failed turn, and `Not resumed in this view.` for an interrupted one. Turns are separated by a rule. A pane that overflows gets a scrollbar column.
  - **↑/↓**, **PgUp/PgDn** and **Home/End** move the selection or scroll Details. The `tui.select.*` bindings apply. **Shift+↑/↓** scrolls Details by five rows. **Tab**, **Shift+Tab** and **Ctrl+/** switch panes. **→** focuses Details and **←** focuses the list. The mouse wheel moves the selection over the list and scrolls over Details.
  - **Esc** cancels the selected topic if it is running and leaves the overlay open. Otherwise Esc closes the overlay. If a question is still running when the overlay closes, the inline panel returns with the partial answer.
  - **`c`** copies the selected topic's latest non-blank answer. The hint reads `✓ copied · c to copy again` until that answer changes. **`f`** or **Enter** opens the follow-up input. **`b`** branches and **Alt+I** injects. The inline panel's conditions for branching and injecting also apply.
  - Empty history reads `No side questions yet.` / `Use /btw QUESTION to start one.`
- **Follow-ups**: `Follow up: ` is a one-line input under the selected topic's details. Enter sends a non-empty question. Esc drops the draft and returns to the overlay. ↑/↓, PgUp/PgDn and Shift+↑/↓ still scroll the answer. Other typing goes to the input.
  - A follow-up adds a turn to its topic. The request starts with the current main conversation. It then replays the topic's earlier user and assistant messages before the new question. It includes partial text from a cancelled turn. A turn with no answer replays only its question.
  - Any topic that is not running can be followed up from the overlay, including cancelled, failed and interrupted ones. `f` on the inline panel needs a complete answer.
  - Follow-ups are refused while any `/btw` request runs. A refused start keeps the draft (`Follow-up was not started. Your draft is kept; enter to retry.`), and Enter while a start is pending does not start a second one.
  - The list keeps showing the topic's first question; Details shows the whole conversation.
- **Branch promotion** (`b`): `SessionManager.createBranchedSession` copies the session through the leaf where you asked the question. The old file is the new file's `parentSession`. The branch adds the question as a user message and the answer as an assistant message. The `b` action dispatches `/btw` with a private token to switch sessions from a command context. Extensions see `session_before_switch` and `session_start` with reason `resume`. The new session shows `Branched /btw to <file name>`. The old session is unchanged and still listed by `/resume`.
  - Only the request answered last in this pi run can be promoted, and only while its answer is on screen (the inline panel, or the open sheet on native terminals).
  - Refused with `/btw branch unavailable: <reason>` when: a branch is already in progress; an inject is still being sent; the answer is not complete or is empty; the topic has follow-ups (`multi-turn side conversations remain in BTW history`); the session has no branch point; the session changed since the question (anything other than usage, custom, label or session-name entries was appended, or the leaf moved by `/tree` or compaction); or a main turn is still running.
  - It also fails with `Cannot branch /btw: session is not persisted` under `--no-session` and in a session that has no user message yet (pi has not written its file).
  - The promoted assistant message keeps the request's provider, model, timestamp and usage. It contains only the cleaned answer text, without thinking. The branch also includes the question's images.
  - While it runs the footer shows `⏳ Branching to chat…` and Esc answers `/btw branch is in progress`. A `session_before_switch` handler that cancels the switch leaves no file behind (`/btw branch cancelled`).
- **Saved history**: every topic is one JSON file, `<agent dir>/btw-history/<session id>/entry-<record id>.json` (agent dir: pi's, `~/.pi/agent` by default). The directory is created with mode 0700, files with 0600, and each write replaces the file atomically.
  - History belongs to the session but lives outside the session file. It stays out of the transcript, `/export` and `/share`. It returns after `/resume`. A fork or `/btw` branch starts with empty history.
  - The extension saves a turn before sending the model request. A failed write stops it from sending. It saves again on cancellation, completion or failure. Switching sessions, forking, `/reload` or quitting cancels a running question and saves it as `Cancelled`.
  - A turn found `running` on disk shows as `Interrupted` without changing the file. A second pi process on the same session can see and follow up an active topic this way.
  - Writes are synchronous, with no queue, retry or cross-process lock. A revision check rejects changed files with `BTW history conflict for <id>; reopen history before retrying`. A malformed record or one with unknown fields prevents history from opening (`Cannot open /btw history: …`). The record is left unchanged. Its title lives in the record, not a separate `entry-<id>.title` file.
  - `--no-session`: history is kept in memory only.
  - Images attached to a question are stored in its record (base64).
  - Deleting a session does not delete its history directory.
- **`btw.inject`** (off by default): lets a side answer draft a prompt for the main agent. Turn it on in pi's `settings.json` (`~/.pi/agent/settings.json`, or the project's `.pi/settings.json`), then `/reload` or restart pi:
  ```json
  { "btw": { "inject": true } }
  ```
  - With it on, the `<btw>` prompt asks the model to put a steering prompt in one `<inject>…</inject>` block when the question asks for one (for example `/btw write a prompt telling the agent to stop and fix the build first`).
  - The block is shown apart from the prose: every line behind a `▎` rail, with `Inject into main session` below. It is split out while the answer streams and once the tag is closed; an unclosed block in a finished answer stays plain text.
  - **Alt+I** sends the displayed text to the main session as a user message. It strips control sequences, expands tabs and trims whitespace. It uses `pi.sendUserMessage(text, { deliverAs: "steer" })` to steer a running agent or start a new turn. The text does not run as a slash command or template. `input` handlers in extensions such as `^model` mentions and magic keywords still receive it.
  - Once the text has reached the session the rail turns green, the reserved column shows `➤` and the label reads `Injected into main session`. A block is sent at most once. If the text does not reach the session within 3 seconds the block returns to pending (`/btw prompt not sent · alt+i to retry`).
  - Only a topic's latest completed turn can be sent. It must come from this process with the setting on when asked. Turning it on later does not enable older answers. Blocks from earlier turns or runs appear as plain text. Sent blocks keep their mark across `/reload` and session switches until pi exits.
  - The extension confirms a send when its `input` handler sees the text. If another handler consumes it first, the block can show as not sent even though the text was delivered. There is no in-app toggle or key rebinding. The setting is read when a question starts and when history opens. Alt+I passes through when there is nothing to send.
- **`side: true` prompt templates**: a prompt template with `side: true` in its frontmatter runs as a side question in the TUI, even mid-turn. It uses pi's argument substitution (`$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, `${@:2}`). It does not append arguments to templates with no placeholders. The expanded text is the question. The typed invocation (`/sitrep`, `/sitrep the migration`) is the title in the panel and history.
  ```markdown
  ---
  description: Situation report for this session
  argument-hint: "[focus]"
  side: true
  ---
  Situation report. Focus on $ARGUMENTS if given, else the whole session.
  ```
  - The extension does not intercept a command or skill of the same name. It reads the file again when it changes. If it cannot read or parse the file, pi expands its loaded copy as an ordinary prompt.
  - A side template carries text only, without draft images. A refused template invocation does not return to the editor.
- **Images**: with `paste-images` loaded, `[Image #N]` tokens in a `/btw` draft attach images. The turn stores them and includes them in every follow-up request. Type or paste an image path in a follow-up to attach it at send time. The saved question shows an `[Image #N]` marker in place of the path.
  - A model without image input gets the path as text. There are no vision-model descriptions or secret obfuscation. With `images.blockImages` on, nothing is attached. Existing conversation images become `Image reading is disabled.` in the side request.
  - Without `paste-images`, questions are text only.
- **Cost**: every side request (also a failed or cancelled one that the provider billed) is added to the session as a `usage` entry of kind `btw`, so its tokens and cost count in pi's footer and `/session` totals and persist with the session. The entry is not shown in the transcript.
- **Outside the TUI** (print, JSON, RPC): nothing mounts or intercepts input. `/btw` reports `/btw is only available in the interactive TUI` when a UI is available and sends no request. `side: true` templates expand as ordinary prompts. There are no side-question, cancellation or history RPC methods.

## Native terminals (tsp-native)

With tsp-native active, answers appear in the history sheet. The sheet body scrolls with the pointer only. Letters typed into the native composer do not reach pi as keys.

- `/btw <question>` opens the sheet on the new topic. **Esc** closes the sheet while the answer keeps streaming (`/btw is still answering in the background · /btw to reopen it`). **`x`** cancels the selected running topic. If the answer completes with the sheet closed, pi shows `/btw answer ready · /btw to read it`. Bare `/btw` reopens the sheet on the active topic.
- The sheet has a topic list, a reader, a follow-up field and buttons for the key actions. The reader shows each question, date, status and answer in order. The buttons are `Stop answer`, `Inject into main`, `Branch to chat`, `Copy answer`, `Close` and `Follow up`. While composing, they are `Cancel` and `Send`. `handleNativeEvent` handles clicks. A `select` event selects the topic and `activate` also opens the follow-up field.
- The follow-up field and newly started follow-up turn request scrolling into view with `reveal`.
- An `<inject>` block uses a card with `user` tone while pending and `success` after sending.
- The `btw` widget tracks which renderer used it last. The extension imports nothing from `tsp-native/`. The native form of the inline panel appears only if native rendering starts while a panel is showing.

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
- `../shared/draft-images.ts`: the hook that provides images referenced in command text. `paste-images/index.ts` registers it.

## Limits

- Side questions use the main session. There is no separate history or context for a focused subagent.
- A side request uses the current `sessionId` and sets `disableContinuation`. Topics do not have provider-side conversation IDs. Follow-ups rely on the provider's prefix cache.
- Side questions do not make a session resumable. pi writes the session file only after a user message. History from a session that never gets a user message cannot be reopened later.
- A running question does not block a new session, resume, fork or reload. Those actions cancel it. The extension does not handle session relocation.
- Side requests skip other extensions' `context`, `before_provider_request` and `before_provider_headers` handlers. They also omit system prompts forced in `before_agent_start` and codemode `only` hidden declarations. The answer is unaffected, but the request shares less of the cached prefix.
- The follow-up input has no push-to-talk or hardware-cursor placement for IMEs.

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

- **Native rendering in rsttyd**: the sheet, buttons and follow-up field. Key delivery for Esc, `x`, `f`, `c`, `b` and Alt+I is unverified with the sheet or field focused. Only the tsp-native reconciler and rsttyd frontend source were checked for node shapes, styling, `reveal` and event handling. The inject block uses the default toned card style.
- **`c`**: copying to the clipboard.
- **Mouse wheel** in the history overlay.
- **Images** in questions and in follow-ups.
- **`side: true` templates** in a live session.
- **Alt+I as a steer** while a main turn runs (only the idle case, a new turn, was seen).
- **The `Interrupted` state** after pi is killed mid-answer.
- **Mid-stream request shapes on other providers.** A question asked mid-turn sends an assistant message cut from the stream (text, signed thinking before it, no tool calls), possibly pi-ai's synthetic results for tool calls still executing, and then the side question as a further user message. Bedrock Claude accepted this; no other provider was tried.

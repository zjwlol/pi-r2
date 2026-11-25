# subagent: background `task` agents for pi

Spawn agents in batches with `task`. Follow them on a live task card and steer them with `irc`. Agents can spawn their own subagents. Results arrive automatically as `<task-result>` messages.

## What it does

- **`task` tool**: `{ context?, tasks: [{ name?, agent?, task, model?, thinking?, cwd?, isolated?, outputSchema? }] }` (max 16 per call).
  - Every agent runs **in the background**. The tool returns the agent names right away. Each agent's final message is **delivered to the parent automatically** as a `<task-result>` message. If the parent is idle, the delivery starts a new turn. If the parent is busy, the result is injected at its next step. There is no blocking mode. To block, use `irc` op `wait`.
  - `name` is a CamelCase id of at most 32 characters. If you leave it out, one is generated in AdjNoun form (`SwiftFalcon`). Names are unique within the session, and a duplicate gets `-2`. `agent` defaults to `task`.
  - `context` is shared background, for example `# Goal` and `# Contract`. It goes into every child's system prompt under `⁂ Context`. Each `task` should stand on its own, for example `# Target` / `# Change` / `# Acceptance`.
  - `model` takes an exact `provider/model-id[:level]`. A bare id must match exactly. A trailing `:level` sets the thinking level unless the item sets `thinking`. An unresolved `model` fails that item at spawn. It never falls back. An agent's frontmatter `model` allows lenient matching and falls back to its parent's model with a warning in the spawn result.
  - `cwd` defaults to the spawner's cwd. A relative `cwd` resolves against it.
  - `isolated: true` runs the agent in a git worktree. Its changes merge back as a patch when it finishes. See [Isolated tasks](#isolated-tasks).
  - `outputSchema` takes a JSON Schema object or JSON string. It makes the agent return validated JSON through `yield`. See [Structured output](#structured-output).
  - Per-item problems (unknown agent, a `model` that does not resolve, invalid schema, `isolated` outside a git repo, …) are reported per item in the tool result; the other items still spawn.
  - `prepareArguments` repairs calls before validation. It accepts a flat `{ task, agent }` call and a single object or JSON string as `tasks`. Top-level `agent`, `model`, `thinking`, `cwd`, `isolated` or `outputSchema` values fill missing item values. Blank placeholders such as `null`, `""`, whitespace and `[]` in `name`, `agent`, `model`, `thinking` or `cwd` fall back to defaults. A double-encoded `task` or `context` with escaped newlines and quotes is decoded once.
  - The first successful spawn result for each owner includes the `irc` lifecycle reference. It covers `list`, `read`, `kill` and how finished agents stay idle until killed or the session ends. The `task` description does not repeat it.
  - At most **16 runs execute at once per nesting level**. Extra spawns and wake-ups join a first-in, first-out queue. `PI_SUBAGENT_MAX_RUNNING` overrides the cap.
  - **Request budget**: each run has a soft budget of **200** model requests by default. The bundled `scout` and `sonic` agents get **100**. A wake-up turn has its own budget.
    - At the budget the agent is told once, as a steering notice, to finish its current step and deliver its report.
    - At 1.5× the budget the in-flight turn is stopped and the agent gets one prompt asking for its final report from what it has (a structured task: a final `yield`). That report is delivered as the run's normal result. Messages and subagent results that arrived meanwhile wait until it has settled; an owner stopped this way does not wait for subagents that are still running.
    - If it still has not reported 5 requests later, the run is aborted and fails with `Soft request budget exceeded (…)`; a structured task that ends its forced turn without `yield` fails the same way, with no reminders.
    - `PI_SUBAGENT_REQUEST_BUDGET` sets the budget (read once at load). It can only lower an agent's budget, never raise `scout` / `sonic` above 100; `0` turns the guard off.
    - The forced final turn keeps its tool declarations to preserve the prompt cache. It relies on the instruction and the five-request backstop.
  - Agents whose definition has `spawns` get **their own `task` tool**. See [Nested subagents](#nested-subagents) for the depth limit.
- **Result envelope**:
  ```
  <task-result id="SwiftFalcon" agent="scout" status="completed" duration="12.3s">
  <output>…</output>                       # whole output, up to 11,500 chars; longer: <meta …/><preview full-output="irc read SwiftFalcon">first 5,000 chars</preview>
                                           # structured tasks: <data>{ pretty JSON }</data> instead of <output>
  <merge-summary>…</merge-summary>          # isolated tasks only
  </task-result>
  ```
  An idle notice after the result explains how to follow up with `irc send`.
- **`irc` tool (parent)**:
  - `send`: message an agent or `all`. A running agent gets it as a **steering message at its next step**. An idle agent is **woken up**, and its reply is relayed back to you. `all` reaches every agent and draws no automatic replies.
  - `wait`: block for the next result or message. Set `from` to wait for one agent. It returns at once if a matching item is queued for the main session or the `from` agent is not running. A wait also ends when that agent stops or, without `from`, no agent is running. An unknown `from` is an error. An agent spawning from an earlier call in the same tool batch counts as known. On timeout, `wait` lists the run time, requests, cost and context fill for agents still running. A new or already queued user prompt also ends the wait with a notice. Agents keep running and their results still arrive automatically. See [Prompting while subagents work](#prompting-while-subagents-work).
  - `list`: show agents and their status.
  - `read`: full latest output plus recent activity.
  - `kill`: abort an agent and its subagents.
- **`irc` tool (children)**: `send` to `parent` or a peer (subagents cannot send to `all`); `wait` (an unknown `from` is an error, a `from` agent that is not running returns at once, and the wait ends when that agent stops); `list`. Nested children can also address the main agent as `main`. Children that can spawn also get `read` and `kill` for their own subagents.
- **`/irc <id|all> <message>`**: lets you (the user) message agents directly.
- **[Agent inspector](#agent-inspector)**: **Ctrl+S**, Alt+A, **←←** on an empty editor, or `/agents [id]`. See every agent in a live roster, with nested agents under their owners. Open an agent's live transcript to message or kill it. Killing it delivers an aborted `<task-result>` to its owner. In dialog-only UIs such as RPC, `/agents` lets you pick an agent, then message it, show its output or kill it.
- **Print/JSON mode** (`pi -p`): the parent is kept alive until background agents finish, and their results are fed back to it.
- **Cost**: everything your agents spend (any depth, wake-ups, retries, killed runs) is added to pi's footer `$`/token totals and `/session`, and persists with the session (see [Cost accounting](#cost-accounting)).

## UI

- **Task card**: a `⇶ Task · N agents` header, muted shared context and one row per agent:
  ```
  ⠹ SwiftFalcon ⟨scout⟩ claude-opus-4-5:medium · 3 tools · 2 req · 1.2%/200k · $0.02 · 5.2s
    ↳ read: src/auth/login.ts
  ✓ CalmPanda claude-opus-4-5:high · 12 tools · 8 req · 3.4%/200k · $0.10 · 42.1s
  [1 succeeded · 1 running · 10 req · 42.1s]
  ```
  - While arguments stream in, the card shows `• Name: first line ⟨agent⟩` bullets.
  - After the tool returns, the card keeps updating from live hub state (spinner, stats, current tool) until all of its agents settle.
  - Collapsed, the card shows at most 4 rows: finished rows first, live rows at the bottom, and a `… N more agents` line. Expanded (Ctrl+O), it shows every agent's assignment and an output preview.
  - Agents of the default `task` type don't get an `⟨agent⟩` badge.
  - A succeeded agent whose worktree merge failed (conflict, files not applied, merge error) shows `⚠` instead of `✓` and is counted as `N merge failed` in the summary line, not as succeeded. The card header shows `⚠` too once every agent has settled and none failed or was aborted.
  - Nested subagents are drawn as a tree under the agent that spawned them, with the same row format. Collapsed, each level shows at most 3 (live ones last) plus `… N more agents (k done)`. An owner that is waiting on them shows `↳ waiting for N subagents`:
    ```
    ⇶ Task · 1 agent · 2 nested
    ⠋ Lead claude-opus-4-5 · 1 tool · 3 req · 3.0%/200k · $0.30 (+0.12) · 12.0s
      ↳ waiting for 1 subagent
      ├─ ✓ ScoutA ⟨scout⟩ claude-opus-4-5:medium · 2 tools · 2 req · 2.0%/200k · $0.08 · 4.1s
      └─ ⠋ WorkB claude-opus-4-5 · 1 tool · 1 req · $0.04 · 6.0s
           ↳ bash: npm test
    [1 running · 2 nested · 6 req · $0.42 total · 12.0s]
    ```
  - **Cost**: a row's `$x.xx` shows the agent's own spend. It shows its subagents' spend as `(+y.yy)`. The summary's `$z.zz total` covers all rows and their subtrees. The hub adds that amount to pi's totals. See [Cost accounting](#cost-accounting). `/agents`, `irc list` and `irc read` use `$own (+nested)` too.
- **Badges**: `[isolated]` and `{}` for structured output follow the agent badge on previews, cards and widget rows. Finished isolated rows show a merge line such as `↳ merged 3 files` or `↳ no changes to merge`. A conflict or unapplied files show `⚠` and the patch path. Expanded structured rows show a capped, pretty-printed JSON preview under `Data`, not `Output`.
- **Delivered results** are rendered as cards with the same row style, the agent's subagent tree (as it was when the agent settled), an output preview, and an expand option.
- **Bottom widget**: when collapsed, shows one summary line while any agent is running or queued. When expanded, it lists up to six running or queued agents in tree order, with their stats, current activity and any completion estimate. In the ANSI TUI a row is left out only when its task card is fully on screen and the row is not folded away. In native mode the widget lists agents regardless of the transcript's scroll position. The widget disappears when no agents remain to show.
- **Native terminals** (tsp-native on a TSP terminal; `native.ts`): cards, the widget and delivered results are described as `agent` nodes instead of text rows. Each node carries the agent's full assignment as its hover card.

## Agent inspector

`inspector.ts` opens a full-screen overlay with `ctx.ui.custom` and `overlay: true`.

- **Opening**: Ctrl+S, Alt+A and `/agents` open the roster even when it is empty. `/agents <id>` opens that agent's transcript. A deliberate **←←** on an empty editor works only when there are agents. `ctx.ui.onTerminalInput` reads these keys only while the main editor has focus. Selectors keep Ctrl+S for saving the model or thinking level and sorting sessions. In a non-empty editor ← moves the cursor. The second tap must land 40–500 ms after the first. Faster taps, including arrow bursts from stray clicks, do not count. Key repeats and third-or-later taps do not count either.
  - The extension does not use `pi.registerShortcut("ctrl+s")` because pi has selector bindings for Ctrl+S. Registering it would show a shortcut-conflict warning at startup.
- **Roster**: `Roster · By parent / Flat` shows status counts and usage totals. Each `render.ts` row shows status, agent type, badges, model, stats, duration, task and current activity. `t` switches between a tree grouped by owner and a flat list sorted by status with `↳ owner` tags. At 96 columns or more, a detail pane shows state, model, task, current tool, error, usage, spawner, subagents, worktree, last merge and recent activity. Tab toggles this pane on narrow screens. PgUp and PgDn scroll it.
  - Use `j`, `k`, ↑ or ↓ to select. Enter or → opens the transcript. `/` opens a fuzzy filter. Enter keeps the filter and Esc clears it. `x` kills the selection. `t` changes the view. Esc closes after clearing the filter or details. ←← also closes it. Just after opening with ←←, one ← closes it. Ctrl+S and Alt+A close it too.
- **Transcript**: the overlay shows the live conversation and a message input. It uses `UserMessageComponent`, `AssistantMessageComponent` for streaming too, `ToolExecutionComponent` with the session's tool renderers and `CustomMessageComponent`. Steers, wakes and continuations from `irc` show in cards headed `✉ irc from → agent`. A card shows six lines or the whole message as Markdown with Ctrl+O. Only the model sees the `<irc from="…">` envelope. Enter sends via `hub.send` from `user`. A running agent reads it at its next step. An idle agent wakes and its reply appears in the main transcript. The viewer follows the bottom. With an empty input, `j`, `k`, ↑, ↓, Shift+↑/↓, PgUp/PgDn and `g`/`G` or Home/End scroll it. When the input contains text, it takes the keys. Ctrl+O expands tool output and Ctrl+T hides thinking. Ctrl+X twice kills the agent and keeps the view read-only. Esc clears the input first, then returns to the roster. ←← returns to the roster and Ctrl+S closes the inspector.
- **Native** (tsp-native): the roster uses a `picker` sheet and the transcript uses an overlay with IRC cards. Roster rows age in one-second steps while agents run. A selection move, filter keystroke or notice in that second does not resend unchanged rows.
- **Limits**: the main session view does not switch to the subagent's session. There is no combined activity log, agent parking or revival, mouse hover, click or wheel support, unread IRC count, role badge or agent persistence. `r` explains that killed agents cannot be revived. An `⧉ N` badge counts queued inbox items.

## Prompting while subagents work

A prompt you submit while the main agent blocks in `irc wait` ends the wait. Enter sends a steer. Alt+Enter sends a follow-up.

- The extension's `input` handler sees the prompt (`streamingBehavior`), waits until pi has queued it (`ctx.hasPendingMessages()`), then ends the wait. Its result says the user sent a message and which agents keep running. pi injects a steer right after that result, so the model reads it next. A follow-up is delivered when the model ends its turn, and the result says so. Waiting again while that same follow-up is still queued blocks as usual.
- A prompt already queued when a wait starts (typed while the model was writing the call) makes it return at once.
- The subagents keep running. Their results no longer have a waiter, so they auto-deliver as usual (steered in, or starting a new turn).
- Nothing else in the main session blocks on subagents in the interactive UI: `task` returns as soon as the agents are spawned, and `irc send` / `kill` return promptly. Only print/JSON mode (`agent_before_settle`) holds the run open until they finish, and there is no user input there.
- **Why "on screen" matters**: in pi's main-screen TUI, changing a line that has scrolled above the viewport forces a full clear and redraw, including scrollback. So a live card only repaints while all of its lines are inside the viewport. Visibility is checked against `TuiMainScreen.captureRenderState()` (and `getScreenLines()` in fullscreen mode, where repainting off-screen lines costs nothing). A card that scrolled away freezes until pi's next full re-render, and the widget takes over showing progress.

## `^model` mentions (pick a model for a subagent)

Type `^` at the start of a word in the prompt to open the model popup:

```
have ^us.anthropic.claude-haiku-4-5 map the auth code, then fix it yourself
```

- The popup lists **models only**: the session's scoped models if `/scoped-models` is set, else all available ones. Models you recently picked with `^` or used in the main session come first, newest first, with "5m ago" (picks are saved on send to `~/.pi/agent/model-mention-history.json`; main-session use comes from remember-model's `model-history.json`), and typing filters. Tab or Enter inserts `^<model-id> `; ids that exist under several providers are inserted as `^provider/id`.
- A tag always stands for a subagent of the **default agent type** (`task`) running on that model. The main agent still writes its task: on send, a hidden notice tells it to give the work you assigned to each tag its own `tasks[]` item with `model` set to that exact `provider/id`.
- `^model:level` (for example `^us.anthropic.claude-haiku-4-5:high`) also pins that subagent's thinking level: the notice then lists `thinking` for the tag. Levels are `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; an unambiguous abbreviation of two or more characters works (`:hi`). A model id that itself contains a colon still matches as a whole. A suffix that is not a level the model supports (`:off` included) leaves the whole tag as plain text: no notice is sent for it. The popup does not list levels; type the suffix.
- Your message text stays as typed. Tags inside `code`, fenced blocks or XML, mid-word (`x^2`), unknown models, and bash-mode (`!…`) prompts are ignored.
- A recognised tag shows as a **selected model** once text follows it. The popup adds a space. The terminal editor shows a bold pill and tsp-native shows an accent mark. The tag stays editable as plain text. The magic-keywords editor draws the mark via `shared/editor-chips.ts`, where `mentions.ts` registers the tags. Tags also work without the styling.
- Tags work while the agent is busy. The notice follows the steer or follow-up.
- `mentions.ts` uses `addAutocompleteProvider` with the `^` trigger. It works with any editor, including magic-keywords.

## How delivery works

| Recipient state | Delivery |
|---|---|
| Blocked in `irc wait` | The message is returned from that wait directly (the main agent's wait also returns when the user submits a prompt). A broadcast leg never ends a wait; it is delivered after the wait returned |
| Mid-run | From its owner, the main agent, the user or one of its own subagents (results included): `session.steer()` injects it after the current tool calls, before the next model call, also when the run was about to end. From anyone else (a peer message, any broadcast leg, a notice): held, then injected at the next tool step (a held peer message or notice is also returned by the agent's next `irc wait`). If the agent is finishing instead, the message gets a turn of its own after the run's result has settled, so it never replaces or joins that result |
| Queued / starting / between steps | Queued, then folded into its next prompt |
| Idle (finished) | Woken with a new turn. Its final text goes back to the sender, unless it already replied with `irc` during that turn (a failed turn always reports). Nothing is relayed for a broadcast leg or for a relayed reply |
| `parent` | `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` |

Sending never waits for the recipient to reply. A nested subagent's `<task-result>` reaches its owner by the same rules (it resolves the owner's `irc wait`, is steered in while the owner runs, or queues), except that nothing is relayed back to the subagent.

- **Broadcast**: only the main agent and the user (`/irc all`) can send to `all`; a subagent's `send` to `all` is an error. A broadcast is one leg per live agent. A leg draws no automatic reply and never ends the recipient's `irc wait`. (The user's `/irc all` keeps the reply relay: those replies only show in the transcript.)
- **Relayed replies**: the relayed reply of a wake turn is an answer, never a wake source. An idle agent woken by one relays nothing back, so two idle agents cannot ping-pong.
- **Failed or killed wake turns**: if a wake turn fails, or the agent is killed before it replied, whoever woke it is told (a kill does not notify the killer itself).
- **Escaping**: message bodies are escaped inside the `<irc>` envelope, so agent-written text cannot close it or forge another sender.

## Nested subagents

- **Who can spawn**: an agent gets `task` only if its definition has `spawns` and it is below the depth limit. `spawns: "*"` allows every agent. `spawns: scout, planner` or a YAML list restricts spawning to the listed agents. A `task` entry in `tools` means `spawns: "*"`. The child's tool uses the `task` schema and behavior. Its description lists only allowed agents. `agent` defaults to `task` for `"*"` or to the first listed agent otherwise. Other agents are rejected per item.
- **Depth limit**: `MAX_DEPTH = 2` (`hub.ts`). The main agent is depth 0, the agents it spawns are depth 1 and may spawn depth-2 agents, and depth-2 agents never get a `task` tool, whatever their `spawns`.
- **Ids** are unique across the whole tree. The main agent can `irc send` / `read` / `kill` any agent directly. A nested agent woken by the main agent replies to `main`.
- **Results go to the owner**: a nested agent's `<task-result>` is delivered to the agent that spawned it, never to the main session. It resolves the owner's pending `irc wait` (a result that already arrived while the owner was busy makes `wait` return right away), is injected at the owner's next step while it runs, or queues.
- **Owners settle last**: if an owner ends its turn while any of its subagents are still active, it doesn't settle. It pauses (`waiting for N subagents`) until the next result or message arrives, then continues with it. Its own result goes up (to the main agent, or to its owner) only once all its subagents have settled and nothing is queued, so the main agent never gets a result from an agent whose subagents are still working. The same applies when an idle owner is woken by a message: its reply is relayed only once none of its subagents is active. Messages that arrive while an owner is paused are handled like messages arriving mid-run (the owner continues with them; no automatic reply relay).
- **Addressing**: `parent` is the spawner. For top-level agents this is the main agent. Nested agents can also address the main agent as `main`. The `irc list` and `⁂ Coop` rosters show siblings and the agent's own subagents. Only the main agent and the user can send to `all`, which reaches the whole tree. The main agent's `irc list` shows the indented tree.
- **Kill cascades**: killing an agent first kills its whole subtree. Killing a nested agent (from the main agent or `/agents`) delivers an aborted `<task-result>` to its owner, so the owner doesn't wait forever. An owner killing its own subagent with `irc kill` gets no notification.
- **Concurrency**: each nesting level has its own pool of `MAX_RUNNING` permits. With one shared pool, owners holding every permit while waiting on queued subagents would deadlock. With per-level pools, the deepest level never waits on anything below it, so it always makes progress, and so does every level above it. An owner also gives up its permit while it is paused waiting for its subagents, and takes one again before it continues.

## Isolated tasks

`isolated: true` (or `isolated: true` in the agent's frontmatter; the item value wins) gives the agent its own **git worktree**:

- **At spawn** the item's `cwd` must be inside a git work tree, else the item fails with a per-item error.
- **Before it starts**, `isolation.ts` creates a detached worktree in a private temp directory from the spawner's current state. The snapshot includes HEAD, staged and unstaged changes, and non-ignored untracked files. It leaves the spawner's index, worktree, refs and stash untouched. The agent's cwd stays at the corresponding subdirectory. Its `⁂ Coop` prompt gets a `# Working Tree` section. It says to work there only and never commit, push, stash or switch branches. Changes merge back automatically and the original checkout can change concurrently.
- **Every time a run settles**, including the initial task and every wake-up:
  - `completed`: `git apply` puts changes since the last merge into the spawner's working tree. No changes are staged or committed. If the patch fails, the tool tries a three-way merge in object space. Merges into one checkout run in order. Paths can start with a double quote or end in a carriage return.
  - **Moved HEAD**: if HEAD moves off the baseline, the tool checks each file the baseline changed. This covers switching, checking out or resetting to another commit, amending and rebasing. The fork point is the merge base of the baseline and HEAD. If the worktree reverted to the fork point's file, as after `reset --hard`, changes are measured from there. This preserves the spawner's uncommitted work. If the worktree keeps the baseline version, as with an amend or `reset --soft` or `--mixed`, changes are measured from the baseline. `<merge-summary>` says when it uses the fork point. A file that fits neither case is a conflict. A HEAD with no common ancestor is also a conflict.
  - **Conflict**: the checkout stays untouched. The tool saves the patch and keeps the worktree. The result still says `completed`, and `<merge-summary>` gives the conflict and patch path. To resolve it, run `git apply --reject <patch>`. This touches only the working tree and writes `.rej` files for conflicting hunks. The next successful run retries all unmerged changes.
  - `failed` or aborted: nothing is applied. If there are changes, the tool saves a patch.
  - `<merge-summary>` reports applied files, conflicts with patch and worktree paths, a saved patch for a failed run, or `No file changes.` A wake run appends it to the relayed reply. If that reply does not reach the checkout owner, the owner gets a separate notice. The checkout owner is the nearest isolated ancestor or the main agent. This covers replies already sent via `irc` and wakes from a subagent result, the user or a peer. The notice waits for an idle or paused owner's next run and does not wake it. A running owner gets it at its next tool step, not as an extra turn. An unchanged conflict is not sent again. The reply says it is still unmerged.
- **The worktree lives as long as the agent** (it stays idle and can be woken). When the agent is killed or the session ends, unmerged changes are saved as a patch (reported in the `irc kill` result / `/agents` notification and in the aborted `<task-result>`), then the worktree is removed. If the changes cannot be collected or saved (e.g. an unreadable file), the worktree is **kept** and the note says `changes NOT saved; worktree kept at <path>`. A merge that was still running when the agent was killed is reported the same way. `session_shutdown` then removes every other worktree this process created.
- **Nesting**: subagents default to their owner's cwd, so a subagent of an isolated agent works inside the owner's worktree; an *isolated* subagent branches from the owner's worktree and merges back into it, and the owner's own merge then carries everything into the main checkout.

Limitations: submodules and nested repositories are not copied or merged back. Ignored files, such as `node_modules` and build output, are not copied or merged either. The worktree preserves git file modes, including the executable bit and symlinks. It does not preserve empty directories. Clean or smudge filters such as git-lfs and line-ending conversion such as `core.autocrlf` can cause merge conflicts. The three-way fallback requires git ≥ 2.40. Older git reports a conflict when the plain patch does not apply. More than 200 MB of untracked, non-ignored files prevents isolation. Kept worktrees and worktrees from crashed processes are not cleaned up. Remove them with `git worktree remove --force <path>`, or delete the directory and run `git worktree prune`.

## Structured output

Set `outputSchema` on an item to make the task **structured**. It takes a JSON Schema object, a JSON string of one, or `true` for any JSON value. `output:` in the agent's frontmatter sets the default. An item's `outputSchema: false` or `null` disables it.

- The extension validates the schema at spawn. An invalid schema fails only the items that use it.
- The child gets `yield` even with a `tools` allowlist. It takes `{ data }` matching the schema or `{ error }`. The new `⁂ Completion` section shows the full schema and directs the child to report through `yield`. Invalid `data` gets an issue list and the child retries. A JSON string is decoded when the decoded value is valid. If that value fails validation and the schema does not accept a string there, the rejection explains the decoded value's issues and asks for that value.
- For `openai-codex-responses`, arrays without `items` in the `yield` tool schema get `items: {}`. This still permits any item.
- **Initial run**: a valid `yield` → the parent gets the JSON in `<data>` (and `DoneInfo.data`); `{ error }` → the task fails with that reason. A run that ends without a successful `yield` is re-prompted with a reminder up to 3 times (`MAX_YIELD_REMINDERS`), then the task fails with the reason (and the last rejection). A run that errored or was aborted fails right away, without reminders.
- **Follow-up (wake) runs**: if the child yields during that turn, the relayed reply is the JSON; otherwise its final text, as for any agent. No reminders. Each turn needs its own `yield` (the state is reset after every settled run).
- **Agents that spawn**: `yield` is rejected while any of the child's own subagents is still running (a subagent being killed counts until its aborted result is delivered); it must report after they settle (a `yield` made before subagent results arrived is discarded when it is resumed with them).
- Combined with `isolated`, the envelope has both `<data>` and `<merge-summary>`.

## Agents

Agents are Markdown files with frontmatter. If two have the same name, the first location in this list wins:

1. `.pi/agents/*.md` in the project (trusted projects only)
2. `~/.pi/agent/agents/*.md`
3. `./agents/*.md` in this folder:

| Agent | Tools | Spawns | Notes |
|---|---|---|---|
| `task` (default) | pi defaults | `*` | General-purpose worker |
| `sonic` | pi defaults | None | Strictly mechanical updates. `thinking: medium`. |
| `scout` | read, grep, find, ls | None | Read-only. Its final message covers Summary, Files, Architecture and Report. |
| `reviewer` | read, grep, find, ls, bash | `scout` | Bash is read-only by instruction. Its final message is a verdict plus P0–P3 findings. |
| `planner` | read, grep, find, ls | None | Read-only. Produces an implementation plan. |

```markdown
---
name: my-agent
description: What it's for
tools: read, grep, find, ls, bash   # optional allowlist; irc (and task, when it can spawn) is always added
spawns: scout, planner              # optional: agents it may spawn with its own task tool ("*" = any; quote it in YAML)
model: provider/model-id            # optional; default = parent's current model (also used, with a warning, when it is not found)
thinking: low                       # optional (aliases: thinking-level, thinkingLevel); default = parent's level
isolated: true                      # optional: run in its own git worktree by default (item `isolated` wins)
output:                             # optional default output schema (YAML mapping or a JSON string); item `outputSchema` wins
  type: object
  properties: { summary: { type: string } }
  required: [summary]
---
Role prompt (becomes ⁂ Role of the child system prompt)...
```

In the tool description, an agent is tagged `(read-only, no edits)` when its `tools` list is non-empty and only contains `read`, `grep`, `find`, or `ls`; **STRUCTURED** when it has `output:`; **ISOLATED** when it has `isolated: true`. (No bundled agent sets `output:` or `isolated:`.)

Each child's system prompt adds these sections to pi's default prompt:

- `⁂ Role`: the agent body.
- `⁂ Context`: the batch `context`.
- `⁂ Coop`: its own id, the peer roster, and `irc` usage rules (message a peer only with a question that blocks you or a blocker / decision report; no FYI or progress notes; never `irc wait` on a peer's or the parent's progress), plus a `# Working Tree` part for isolated agents and a `# Subagents` part for agents that can spawn.
- `⁂ Completion`: "your final message is your result … NEVER end on a plan", and: never run builds, tests, linters, formatters or smoke runs unless the assignment says to; name the checks to run when done (structured tasks: the `yield` protocol and the schema, with the same rule).

The first user message is `Complete assignment thoroughly:\n\n<task>`.

## Cost accounting

The footer's dollars and tokens and `/session`'s per-model breakdown sum assistant usage, tool-result `usage`, compaction and branch-summary `usage`, and `usage` entries. `SessionManager.appendUsage` requires pi ≥ 0.86. See `UsageEntry` in `docs/session-format.md`. Custom messages and `appendEntry` entries do not count. The `task` tool returns before its agents run.

`usage.ts` mirrors every child's spend into the main session as `usage` entries of kind `subagent`:

- **What**: after every spending event of a child session (model response, compaction summary, cache-warm entry) and at teardown, `AgentHub.syncUsage` applies pi's own footer formula to the child's new session entries (a cursor over its append-only entries makes every entry count exactly once) and appends one entry per provider/model of the batch, attributed to the child's `provider`/`model` (so `/session`'s breakdown stays per model) with `note` = the agent id. A child's recorded total includes that session spend plus its completion estimates.
- **Covers**: agents of every depth (each child reports itself; nothing is folded into an owner's result, so nothing is counted twice), wake-up and follow-up runs, yield-reminder and isolation-merge retries, agents killed mid-step (the aborted partial response is mirrored before its session is disposed) and agents killed by `/new`, `/resume`, `/reload` or quitting (`disposeAll` runs inside `session_shutdown`, while the session is still writable).
- **Persisted**: the entries live in the session file, so a resumed session's footer and `/session` include past subagent spend. pi hides `usage` entries from the conversation and `/tree`; they are not model context.
- **Limits**: the footer shows one `$` total. The task card's `$x.xx (+y.yy)` rows and `$z.zz total` line show the split. `/session` breaks usage down by model, not by agent. The `note` field in the session file holds the agent id. Without `appendUsage`, spend is not recorded. The card still shows the hub's numbers.

## Design notes / limits

- Children are **in-process SDK sessions** (`createAgentSession` with an in-memory session manager). That's what lets `steer()` work directly. They reuse the parent's model runtime and auth, plus an in-memory copy of the parent's settings.
- Children load **no extensions**. Nested spawning goes through the hub's own depth- and policy-limited `task` tool, and other extensions can't change your settings. Children still get skills and AGENTS.md context files.
- Nested agents default to their owner's model and thinking level (an agent's own `model`/`thinking` frontmatter and per-item overrides still win).
- **Not implemented**:
  - branch-mode isolation, `schemaMode`, incremental / workpool `yield` sections, `agent://` payload addressing
  - `agent://` / `history://` / `proc://` URLs (use `irc` `read` / `list` / `kill` instead)
- Non-isolated children share the filesystem, so give overlapping edits to one integration owner (or use `isolated`).
- Agents live until you kill them, or until the parent session ends (`/new`, `/resume`, `/reload`, or quitting). Task cards from earlier sessions show their agents as `detached`.
- A child blocked in `irc wait` keeps its run permit. If 16 agents at the same level all wait on queued peers at that level, they stall until their waits time out (120s by default). Waiting on your own subagents is safe, because they use the next level's permits.
- Per-item features plug into `AgentHub.hooks` (`ChildHooks`: `validate`, `prepare`, `tools`, `resume`, `beforeSettle`, `dispose`) with `Child.item`, the raw `tasks[]` item. `features.ts` implements isolation (`isolation.ts`) and structured output (`structured.ts`) on them.

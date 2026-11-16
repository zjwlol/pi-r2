# subagent: oh-my-pi style `task` subagents for pi

A port of oh-my-pi's `task` tool (async batch spawning, `<task-result>` delivery, live task card, nested subagents) on top of vanilla pi's extension API, plus oh-my-pi's IRC-style steering.

## What it does

- **`task` tool**: `{ context?, tasks: [{ name?, agent?, task, model?, thinking?, cwd?, isolated?, outputSchema? }] }` (max 16 per call).
  - Every agent runs **in the background**. The tool returns the agent names right away. Each agent's final message is **delivered to the parent automatically** as a `<task-result>` message. If the parent is idle, the delivery starts a new turn. If the parent is busy, the result is injected at its next step. There is no blocking mode. To block, use `irc` op `wait`.
  - `name` is a CamelCase id of at most 32 characters. If you leave it out, one is generated in AdjNoun form (`SwiftFalcon`). Names are unique within the session, and a duplicate gets `-2`. `agent` defaults to `task`.
  - `context` is shared background, for example `# Goal` and `# Contract`. It goes into every child's system prompt under `§ Context`. Each `task` should stand on its own, for example `# Target` / `# Change` / `# Acceptance`.
  - `cwd` defaults to the spawner's cwd; a relative `cwd` resolves against it.
  - `isolated: true` runs the agent in its own git worktree; its changes are merged back into your checkout as a patch when it finishes (see [Isolated tasks](#isolated-tasks)).
  - `outputSchema` (JSON Schema: object or JSON string) makes the agent return validated JSON through a `yield` tool (see [Structured output](#structured-output)).
  - Per-item problems (unknown agent, invalid schema, `isolated` outside a git repo, …) are reported per item in the tool result; the other items still spawn.
  - Common malformed calls are repaired before validation (`prepareArguments`): a flat `{ task, agent }` call, a single object or JSON string passed as `tasks`, or a top-level `agent` next to `tasks[]`.
  - At most **16 runs execute at once per nesting level** (top-level agents, their subagents). Extra spawns and wake-ups **queue** (FIFO semaphore) instead of failing. `PI_SUBAGENT_MAX_RUNNING` overrides the cap.
  - Agents whose definition has `spawns` get **their own `task` tool** (see [Nested subagents](#nested-subagents)).
- **Result envelope** (same shape as OMP's `task-summary.md`):
  ```
  <task-result id="SwiftFalcon" agent="scout" status="completed" duration="12.3s">
  <output>…</output>                       # or <meta …/><preview full-output="irc read SwiftFalcon">…</preview> past 5000 chars
                                           # structured tasks: <data>{ pretty JSON }</data> instead of <output>
  <merge-summary>…</merge-summary>          # isolated tasks only
  </task-result>
  SwiftFalcon is now idle — message it with irc op "send" (to: "SwiftFalcon") to follow up …
  ```
- **`irc` tool (parent)**:
  - `send`: message an agent or `all`. A running agent gets it as a **steering message at its next step**. An idle agent is **woken up**, and its reply is relayed back to you.
  - `wait`: block for the next result or message, optionally only `from` one agent. It returns early when **you (the user) send a prompt** while it blocks (or one is already queued when it starts), saying so; the subagents keep running and their results still auto-deliver (see [Prompting while subagents work](#prompting-while-subagents-work)).
  - `list`: show agents and their status.
  - `read`: full latest output plus recent activity.
  - `kill`: abort an agent and its subagents.
- **`irc` tool (children)**: `send` to `parent`, a peer, or `all`; `wait`; `list`. Nested children can also address the main agent as `main`. Children that can spawn also get `read` and `kill` for their own subagents.
- **`/irc <id|all> <message>`**: lets you (the user) message agents directly.
- **Agent inspector** (**Ctrl+S**, Alt+A, a deliberate **←←** on an empty editor, or `/agents [id]`): oh-my-pi's Agent Hub. A live roster of every agent (nested ones under their owner) and a live transcript of any of them, where you can message (steer / wake) or kill it. See [Agent inspector](#agent-inspector). Killing an agent here also delivers an aborted `<task-result>` to whoever spawned it, because they may still be waiting on it. In dialog-only UIs (RPC), `/agents` keeps the old pick-an-agent → message / show output / kill flow.
- **Print/JSON mode** (`pi -p`): the parent is kept alive until background agents finish, and their results are fed back to it.
- **Cost**: everything your agents spend (any depth, wake-ups, retries, killed runs) is added to pi's footer `$`/token totals and `/session`, and persists with the session (see [Cost accounting](#cost-accounting)).

## UI

- **Task card** (OMP `task` card layout): a `⇶ Task · N agents` header, the shared context (muted), and one row per agent:
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
  - **Cost** (OMP status-line style): a row's `$x.xx` is that agent's own spend; an agent with nested subagents shows theirs as `(+y.yy)` next to it. The summary line's `$z.zz total` is everything the call spent (all rows and their subtrees), and that is exactly the amount the hub adds to pi's totals (see [Cost accounting](#cost-accounting)). `/agents`, `irc list` and `irc read` use the same `$own (+nested)` form.
- **Badges**: `[isolated]` and `{}` (structured) follow the agent badge on every row (call preview, live card, widget, delivered card). Finished isolated rows get a merge line: `↳ merged 3 files`, `↳ no changes to merge`, `↳ ⚠ merge conflict — patch: <path>`, `↳ ⚠ 2 files not applied — patch: <path>`. Expanded rows of structured tasks show a `Data` preview (pretty JSON, capped) instead of `Output`.
- **Delivered results** are rendered as cards with the same row style, the agent's subagent tree (as it was when the agent settled), an output preview, and an expand option.
- **Bottom widget**: lists running agents (nested ones included, under their owner) whose task card is **not on screen**, with name, stats, and current tool. It is hidden while the card itself is visible.

## Agent inspector

`inspector.ts`, after oh-my-pi's Agent Hub overlay (`tui/src/overlays/agent-hub.ts`) and its transcript viewer (`agent-transcript-viewer.ts`). A full-screen overlay (`ctx.ui.custom`, `overlay: true`).

- **Opening**: **Ctrl+S** or **Alt+A** (oh-my-pi's `app.session.observe` / `app.agents.hub`), or `/agents` (`/agents <id>` opens that agent's transcript), even with no agents (empty roster). A **deliberate ←←** on an empty editor opens it only when there are agents (oh-my-pi `requireContent`). Keys are read with `ctx.ui.onTerminalInput`, only while the main editor has focus: pi's selectors keep their own Ctrl+S (save model / thinking level, session sort), and ← in a non-empty editor moves the cursor as usual. The double tap uses oh-my-pi's burst rejection: the second tap must land 40–500 ms after the first; faster taps (terminals emit several arrows in one read on a stray click), key repeats, and third-or-later taps never fire.
  - Not `pi.registerShortcut("ctrl+s")`: pi binds Ctrl+S in several selectors, so registering it prints a shortcut-conflict warning on every start.
- **Roster** (`1 Agents` of oh-my-pi): `Roster · By parent / Flat`, status counts, and usage totals; one entry per agent in render.ts row format (status, ⟨agent⟩, badges, model, stats, duration), its task, and its current activity. `t` toggles grouping by parent (tree rails under the owner's status icon) and a flat status-ordered list (`↳ owner` tags). On terminals ≥ 96 columns a detail pane shows the selected agent: state, model, task, current tool, error, usage, lineage (spawner, subagents, worktree, last merge) and recent activity; `Tab` toggles it on narrow terminals, PgUp/PgDn scroll it.
  - Keys: `j`/`k`/↑/↓ select, Enter (or →) open the transcript, `/` fuzzy filter (Enter keeps it, Esc clears), `x` kill, `t` view, Esc close (clears the filter / details first), **←←** close (a single ← right after the ←← that opened it closes it again, as with oh-my-pi's `armCloseTap`), Ctrl+S / Alt+A close.
- **Transcript**: the agent's conversation, live, drawn with pi's own `UserMessageComponent`, `AssistantMessageComponent` (streaming too), `ToolExecutionComponent` (the session's tool renderers) and `CustomMessageComponent`, plus a message input. Enter sends as the user (`hub.send` from `user`): a running agent reads it at its next step, an idle one is woken and its reply lands in the main transcript. It follows the bottom; with an empty input `j`/`k`/↑/↓, Shift+↑/↓, PgUp/PgDn, `g`/`G` (Home/End) scroll (as in oh-my-pi, once you type, the input owns every key). Ctrl+O expands tool output, Ctrl+T hides thinking, **Ctrl+X twice** kills the agent (the view stays, read-only), Esc (clearing the input first) or **←←** goes back to the roster, Ctrl+S closes everything.
- **Not replicated**: oh-my-pi's Enter *focuses the main view* on the subagent's session (its chat replaces the main one until ←← / Esc) — vanilla pi has one session view, so the in-hub transcript viewer (oh-my-pi's fallback for collab guests) is used instead. Also missing: the `2 Activity` section (a time-ordered log across agents; the hub keeps no timestamped event log), `r` revive (agents here are never parked; killed ones are gone, so `r` only explains that), mouse hover/click/wheel, the per-agent unread IRC count (an `⧉ N` badge shows queued inbox items instead), role badges, and persisted agents from earlier sessions (the hub only knows live agents).

## Prompting while subagents work

When the main agent blocks in `irc wait`, a prompt you submit (Enter = steer, Alt+Enter = follow-up) ends the wait right away instead of queueing behind it (oh-my-pi's `wait` returns on a steering interrupt the same way; it ignores follow-ups, which end the wait here too):

- The extension's `input` handler sees the prompt (`streamingBehavior`), waits until pi has queued it (`ctx.hasPendingMessages()`), then ends the wait. Its result says the user sent a message and which agents keep running. pi injects a steer right after that result, so the model reads it next. A follow-up is delivered when the model ends its turn, and the result says so. Waiting again while that same follow-up is still queued blocks as usual.
- A prompt already queued when a wait starts (typed while the model was writing the call) makes it return at once.
- The subagents keep running. Their results no longer have a waiter, so they auto-deliver as usual (steered in, or starting a new turn).
- Nothing else in the main session blocks on subagents in the interactive UI: `task` returns as soon as the agents are spawned, and `irc send` / `kill` return promptly. Only print/JSON mode (`agent_before_settle`) holds the run open until they finish, and there is no user input there.
- **Why "on screen" matters**: in pi's main-screen TUI, changing a line that has scrolled above the viewport forces a full clear and redraw, including scrollback. So a live card only repaints while all of its lines are inside the viewport. Visibility is checked against `TuiMainScreen.captureRenderState()` (and `getScreenLines()` in fullscreen mode, where repainting off-screen lines costs nothing). A card that scrolled away freezes until pi's next full re-render, and the widget takes over showing progress.

## `^model` mentions (pick a model for a subagent)

Type `^` at the start of a word in the prompt to open a model popup, like oh-my-pi's model mentions:

```
have ^us.anthropic.claude-haiku-4-5 map the auth code, then fix it yourself
```

- The popup lists **models only**: the session's scoped models if `/scoped-models` is set, else all available ones. Models you recently picked with `^` or used in the main session come first, newest first, with "5m ago" (picks are saved on send to `~/.pi/agent/model-mention-history.json`; main-session use comes from remember-model's `model-history.json`), and typing filters. Tab or Enter inserts `^<model-id> `; ids that exist under several providers are inserted as `^provider/id`.
- A tag always stands for a subagent of the **default agent type** (`task`) running on that model. The main agent still writes its task: on send, a hidden notice tells it to give the work you assigned to each tag its own `tasks[]` item with `model` set to that exact `provider/id`.
- Your message text stays as typed. Tags inside `code`, fenced blocks or XML, mid-word (`x^2`), unknown models, and bash-mode (`!…`) prompts are ignored.
- Typing while the agent is busy works too (the notice rides along with the steer or follow-up).
- Code: `mentions.ts`. It uses pi's public `addAutocompleteProvider` (trigger character `^`), so it works with any editor, including the magic-keywords one.

## How delivery works (same model as oh-my-pi's IrcBus)

| Recipient state | Delivery |
|---|---|
| Blocked in `irc wait` | The message is returned from that wait directly (the main agent's wait also returns when the user submits a prompt) |
| Mid-run | `session.steer()` injects it after the current tool calls, before the next model call |
| Queued / starting / between steps | Queued, then folded into its next prompt |
| Idle (finished) | Woken with a new turn. Its final text goes back to the sender, unless it already replied with `irc` during that turn |
| `parent` | `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` |

Sending never waits for the recipient to reply. A nested subagent's `<task-result>` reaches its owner by the same rules (it resolves the owner's `irc wait`, is steered in while the owner runs, or queues), except that nothing is relayed back to the subagent.

## Nested subagents

- **Who can spawn**: an agent gets a `task` tool iff its definition has `spawns` and it runs below the depth limit. `spawns: "*"` allows every agent; `spawns: scout, planner` (or a YAML list) allows only those. A `task` entry in `tools` means `spawns: "*"` (oh-my-pi compat). The child's `task` tool has the same schema and behavior as the main agent's, but its description lists only the allowed agents, and `agent` defaults to `task` for `"*"` or to the first listed agent otherwise. Other agents are rejected per item.
- **Depth limit**: `MAX_DEPTH = 2` (`hub.ts`). The main agent is depth 0, the agents it spawns are depth 1 and may spawn depth-2 agents, and depth-2 agents never get a `task` tool, whatever their `spawns`.
- **Ids** are unique across the whole tree. The main agent can `irc send` / `read` / `kill` any agent directly. A nested agent woken by the main agent replies to `main`.
- **Results go to the owner**: a nested agent's `<task-result>` is delivered to the agent that spawned it, never to the main session. It resolves the owner's pending `irc wait` (a result that already arrived while the owner was busy makes `wait` return right away), is injected at the owner's next step while it runs, or queues.
- **Owners settle last**: if an owner ends its turn while any of its subagents are still active, it doesn't settle. It pauses (`waiting for N subagents`) until the next result or message arrives, then continues with it. Its own result goes up (to the main agent, or to its owner) only once all its subagents have settled and nothing is queued, so the main agent never gets a result from an agent whose subagents are still working. The same applies when an idle owner is woken by a message: its reply is relayed only once none of its subagents is active. Messages that arrive while an owner is paused are handled like messages arriving mid-run (the owner continues with them; no automatic reply relay).
- **Addressing**: for a nested agent, `parent` is the agent that spawned it, and `main` is the main agent (for top-level agents, `parent` is the main agent, as before). Rosters (`irc list`, the `§ Coop` peer list) show siblings and own subagents, and `all` broadcasts to that roster plus `parent`. The main agent's `irc list` shows the whole tree, indented, and its (or the user's) `all` reaches every agent in the tree.
- **Kill cascades**: killing an agent first kills its whole subtree. Killing a nested agent (from the main agent or `/agents`) delivers an aborted `<task-result>` to its owner, so the owner doesn't wait forever. An owner killing its own subagent with `irc kill` gets no notification.
- **Concurrency**: each nesting level has its own pool of `MAX_RUNNING` permits. With one shared pool, owners holding every permit while waiting on queued subagents would deadlock. With per-level pools, the deepest level never waits on anything below it, so it always makes progress, and so does every level above it. An owner also gives up its permit while it is paused waiting for its subagents, and takes one again before it continues.

## Isolated tasks

`isolated: true` (or `isolated: true` in the agent's frontmatter; the item value wins) gives the agent its own **git worktree**:

- **At spawn** the item's `cwd` must be inside a git work tree, else the item fails with a per-item error.
- **Before it starts** a detached worktree is created in a private temp directory (isolation.ts decides where) from an exact snapshot of the spawner's *current working state*: HEAD + staged + unstaged + untracked (non-ignored) files. The spawner's index, working tree, refs and stash are not touched. The agent's cwd is the same subdirectory inside the worktree, and its system prompt gets a `§ Coop` `# Working Tree` section (work only there; changes merge back automatically; never commit / push / stash / switch branches; the original checkout may change concurrently).
- **Every time a run settles** (the initial task and every later wake-up):
  - `completed` → the changes since the last merge are applied to the spawner's **working tree** (never staged or committed), via `git apply`, falling back to a 3-way merge done in object space. Merges into one checkout are serialized.
  - conflict → the spawner's checkout is left untouched; the patch is saved (its path is in the summary) and the worktree is kept. The result still reports `completed`, with the conflict in `<merge-summary>`. Resolve manually: `git apply --reject <patch>` (working tree only; writes .rej files for conflicting hunks). The agent's next successful run retries with all unmerged changes.
  - `failed` / aborted run → nothing is applied; if there are changes, a patch is saved.
  - The outcome is in the envelope's `<merge-summary>` (applied files / conflict + patch + worktree / patch saved for a failed run / "No file changes."). For a follow-up (wake) run, the summary is appended to the relayed reply; when that reply doesn't go to whoever owns the merged-into checkout (the nearest isolated ancestor, else the main agent) — e.g. the agent already answered via `irc`, it was woken by a subagent result, or the user / a peer woke it — the owner gets it as a separate notice, so a merge into a checkout is never silent. Idle or paused agents get the notice with their next run (it doesn't wake them); an unchanged conflict is not re-sent (the reply notes it is still not merged).
- **The worktree lives as long as the agent** (it stays idle and can be woken). When the agent is killed or the session ends, unmerged changes are saved as a patch (reported in the `irc kill` result / `/agents` notification and in the aborted `<task-result>`), then the worktree is removed. If the changes cannot be collected or saved (e.g. an unreadable file), the worktree is **kept** and the note says `changes NOT saved; worktree kept at <path>`. A merge that was still running when the agent was killed is reported the same way. `session_shutdown` then removes every other worktree this process created.
- **Nesting**: subagents default to their owner's cwd, so a subagent of an isolated agent works inside the owner's worktree; an *isolated* subagent branches from the owner's worktree and merges back into it, and the owner's own merge then carries everything into the main checkout.

Limitations: submodules and nested (non-submodule) repositories are not reproduced in the worktree and their changes are ignored; ignored files (`node_modules`, build output) are neither copied in nor merged back; only git file modes are reproduced (exec bit / symlink) and empty directories are not; files with clean/smudge filters or eol conversion (git-lfs, `core.autocrlf`) may fail to merge and are then reported as a conflict; the 3-way fallback needs git ≥ 2.40 (older git reports a conflict whenever the plain patch doesn't apply); a repository with more than 200 MB of untracked, non-ignored files is refused. Worktrees of a crashed process (and kept ones) are not cleaned up: `git worktree remove --force <path>`, or delete the directory and run `git worktree prune`.

## Structured output

`outputSchema` on an item (a JSON Schema object, a JSON string of one, or `true` for "any JSON value"), or `output:` in the agent's frontmatter as its default (`outputSchema: false` / `null` on the item disables it), makes the task **structured**:

- The schema is validated at spawn; an invalid one is a per-item error (an agent with an invalid `output:` fails every item that would use it).
- The child gets a `yield` tool (`{ data }` matching the schema, or `{ error }`), added to any `tools` allowlist, and its `§ Completion` section is replaced: the result goes through `yield`, not the final message, and the schema is shown in full. Invalid `data` is rejected with an issue list and the child retries.
- **Initial run**: a valid `yield` → the parent gets the JSON in `<data>` (and `DoneInfo.data`); `{ error }` → the task fails with that reason. A run that ends without a successful `yield` is re-prompted with a reminder up to 3 times (`MAX_YIELD_REMINDERS`), then the task fails with the reason (and the last rejection). A run that errored or was aborted fails right away, without reminders.
- **Follow-up (wake) runs**: if the child yields during that turn, the relayed reply is the JSON; otherwise its final text, as for any agent. No reminders. Each turn needs its own `yield` (the state is reset after every settled run).
- **Agents that spawn**: `yield` is rejected while any of the child's own subagents is still running (a subagent being killed counts until its aborted result is delivered); it must report after they settle (a `yield` made before subagent results arrived is discarded when it is resumed with them).
- Combined with `isolated`, the envelope has both `<data>` and `<merge-summary>`.

## Agents

Agents are Markdown files with frontmatter. If two have the same name, the first location in this list wins:

1. `.pi/agents/*.md` in the project (trusted projects only)
2. `~/.pi/agent/agents/*.md`
3. `./agents/*.md` in this folder:

| Agent | Port of | Tools | Spawns | Notes |
|---|---|---|---|---|
| `task` (default) | OMP `task` | pi defaults | `*` | General-purpose worker |
| `sonic` | OMP `sonic` | pi defaults | — | Same body, plus "strictly mechanical updates" scope; `thinking: medium` |
| `scout` | OMP `scout` | read, grep, find, ls | — | READ-ONLY. Its final message covers Summary / Files / Architecture / Report |
| `reviewer` | OMP `reviewer` | read, grep, find, ls, bash | `scout` | Bash is read-only by instruction. Its final message is a verdict plus P0–P3 findings |
| `planner` | (this repo) | read, grep, find, ls | — | READ-ONLY. Produces an implementation plan |

```markdown
---
name: my-agent
description: What it's for
tools: read, grep, find, ls, bash   # optional allowlist; irc (and task, when it can spawn) is always added
spawns: scout, planner              # optional: agents it may spawn with its own task tool ("*" = any; quote it in YAML)
model: provider/model-id            # optional; default = parent's current model
thinking: low                       # optional (aliases: thinking-level, thinkingLevel); default = parent's level
isolated: true                      # optional: run in its own git worktree by default (item `isolated` wins)
output:                             # optional default output schema (YAML mapping or a JSON string); item `outputSchema` wins
  type: object
  properties: { summary: { type: string } }
  required: [summary]
---
Role prompt (becomes § Role of the child system prompt)...
```

In the tool description, an agent is tagged **READ-ONLY** when its `tools` list is non-empty and only contains `read`, `grep`, `find`, or `ls`; **STRUCTURED** when it has `output:`; **ISOLATED** when it has `isolated: true`. (No bundled agent sets `output:` or `isolated:`.)

Each child's system prompt is pi's default prompt plus OMP's subagent sections:

- `§ Role`: the agent body.
- `§ Context`: the batch `context`.
- `§ Coop`: its own id, the peer roster, and `irc` usage rules, plus a `# Working Tree` part for isolated agents and a `# Subagents` part for agents that can spawn.
- `§ Completion`: "your final message is your result … NEVER end on a plan" (structured tasks: the `yield` protocol and the schema).

The first user message is `Complete assignment thoroughly:\n\n<task>`.

## Cost accounting

pi's footer (`$`, `↑`/`↓` tokens), `/session` and its per-model breakdown sum the same four sources over every entry of the session: assistant message usage, tool-result `usage`, compaction/branch-summary `usage`, and `usage` entries (`SessionManager.appendUsage`, pi ≥ 0.86; documented in `docs/session-format.md`, "UsageEntry"). Custom messages and `appendEntry` entries count for nothing, and the `task` tool returns before its agents run, so a subagent's spend would never reach those totals on its own (oh-my-pi solves this natively: completed `task` results carry the child's usage and the status line shows `$own (+tree)`).

The hub therefore mirrors every child's spend into the main session as `usage` entries of kind `subagent` (`usage.ts`):

- **What**: after every spending event of a child session (model response, compaction summary, cache-warm entry) and at teardown, `AgentHub.syncUsage` applies pi's own footer formula to the child's new session entries (a cursor over its append-only entries makes every entry count exactly once) and appends one entry per provider/model of the batch, attributed to the child's `provider`/`model` (so `/session`'s breakdown stays per model) with `note` = the agent id. A child's recorded total is therefore exactly what pi would show for that child's own session.
- **Covers**: agents of every depth (each child reports itself; nothing is folded into an owner's result, so nothing is counted twice), wake-up and follow-up runs, yield-reminder and isolation-merge retries, agents killed mid-step (the aborted partial response is mirrored before its session is disposed) and agents killed by `/new`, `/resume`, `/reload` or quitting (`disposeAll` runs inside `session_shutdown`, while the session is still writable).
- **Persisted**: the entries live in the session file, so a resumed session's footer and `/session` include past subagent spend. pi hides `usage` entries from the conversation and `/tree`; they are not model context.
- **Limits**: the footer has a single `$` total, so it cannot show pi's own spend and the subagent share separately the way oh-my-pi's status line does; the task card's `$x.xx (+y.yy)` rows and `$z.zz total` line are where that split lives. Spend is attributed per model, not per agent, in `/session`'s breakdown (the `note` field in the session file carries the agent id). On a pi without `appendUsage` nothing is recorded (the card still shows the hub's numbers).

## Design notes / limits

- Children are **in-process SDK sessions** (`createAgentSession` with an in-memory session manager). That's what lets `steer()` work directly. They reuse the parent's model runtime and auth, plus an in-memory copy of the parent's settings.
- Children load **no extensions**. Nested spawning goes through the hub's own depth- and policy-limited `task` tool, and other extensions can't change your settings. Children still get skills and AGENTS.md context files.
- Nested agents default to their owner's model and thinking level (an agent's own `model`/`thinking` frontmatter and per-item overrides still win).
- **Not implemented** (oh-my-pi has these):
  - branch-mode isolation, `schemaMode`, incremental / workpool `yield` sections, `agent://` payload addressing
  - `agent://` / `history://` / `proc://` URLs (use `irc` `read` / `list` / `kill` instead)
- Non-isolated children share the filesystem, so give overlapping edits to one integration owner (or use `isolated`).
- Agents live until you kill them, or until the parent session ends (`/new`, `/resume`, `/reload`, or quitting). Task cards from earlier sessions show their agents as `detached`.
- A child blocked in `irc wait` keeps its run permit. If 16 agents at the same level all wait on queued peers at that level, they stall until their waits time out (120s by default). Waiting on your own subagents is safe, because they use the next level's permits.
- Per-item features plug into `AgentHub.hooks` (`ChildHooks`: `validate`, `prepare`, `tools`, `resume`, `beforeSettle`, `dispose`) with `Child.item`, the raw `tasks[]` item. `features.ts` implements isolation (`isolation.ts`) and structured output (`structured.ts`) on them.

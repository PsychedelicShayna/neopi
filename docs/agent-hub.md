# Agent Hub

Agent Hub is the interactive TUI for watching and controlling subagents associated with the current session. It combines a live roster, per-agent activity and usage, transcript access, steering, revive, and kill controls. The main agent is not listed because its conversation is the ambient session view.

The Hub also discovers parked subagents from the current session's persisted artifacts when a session is resumed. Advisor transcript files appear as read-only rows.

## Open the Hub

| Input          | Behavior                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `Alt+A`        | Open or close Agent Hub through `app.agents.hub`. This opens the roster even when it is empty. |
| `Ctrl+S`       | Open or close the same Hub through the legacy `app.session.observe` action.                    |
| Double-tap `←` | Open the Hub from an empty main-session editor when the current session has an agent to show.  |

Run `/hotkeys` to see the active chords. Remap either action in `~/.omp/agent/keybindings.yml`:

```yaml
app.agents.hub: Alt+A
app.session.observe: Ctrl+S
```

The double-`←` gesture is not a keybinding action. While focused on a subagent, double-`←` returns to the main session instead of opening the Hub.

## Roster and inspector

The roster updates from the session's agent registry and progress events. Its responsive rows show:

- status (`running`, `idle`, `parked`, or `aborted`), agent identity, parent, and unread IRC count;
- model role, resolved model, and age since last activity;
- assigned task or current activity;
- cost, active time or elapsed span, request count, tool-call count, and tokens.

The header aggregates status and usage across measured agents. Press `t` to switch between the operationally ordered flat roster and a parent/child tree. Press `/` to filter agents by id or display name.

On a wide terminal, the selected agent's inspector appears beside the roster. On a narrow terminal, press `Tab` to replace the roster with it. The inspector adds:

- the current tool and arguments, last intent, and retry state;
- context-window use when available;
- parent and child lineage;
- output and patch paths, plus isolated-worktree branch metadata when present.

Metrics depend on the progress or persisted usage data available for that agent. Missing data appears as `usage —` rather than an estimate.

### Roster controls

Vim navigation is off by default. Enable **Vim Navigation and Editing** in `/settings`, or set `tui.vimMode: true`, to use `j`/`k` and the shared Vim menu/viewer motions. Arrows, the mouse, ordinary paging, search, activation and the Hub's surface actions remain available without opting in.

| Key or input                | Action                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| `j` / `k`, `↑` / `↓`, wheel | Select an agent.                                                             |
| `Enter` or click            | Open the selected agent.                                                     |
| `t`                         | Toggle flat and parent/child views.                                          |
| `/`                         | Filter agents by id or display name.                                         |
| `1` / `2`                   | Switch between Agents and Activity sections.                                 |
| `Tab`                       | Toggle the inspector on narrow terminals.                                    |
| `PageUp` / `PageDown`       | Scroll an open inspector.                                                    |
| `r`                         | Revive the selected parked or killed agent.                                  |
| `Shift+R`                   | Restart the selected live advisor without losing its conversation.          |
| `x`                         | Abort a running turn if necessary, then kill and release the selected agent. |
| `Esc`                       | Clear an active filter first, then close the narrow inspector or the Hub.    |

`parked` and killed (`aborted`) agents can be explicitly revived with `r` or **Revive**. A killed agent needs a resumable saved transcript and comes back as a fresh instance with its history; its old registry generation remains terminal. `x` is immediate. Opening or focusing a killed transcript, ordinary chat, and IRC messages do not undo the kill.

`Shift+R` (or **Restart advisor** in the native roster) immediately restarts only the selected live advisor. The shortcut is a roster action, not a transcript-viewer shortcut. Historical advisor rows have no live runtime to restart; for live advisors, `/advisor restart [slug|name]` is also available.

## Activity log

Press `2` for the combined activity log; `1` returns to the roster. The log includes responses, tool calls, IRC messages, and lifecycle activity. `Enter` opens the selected entry's agent transcript at that entry when an anchor is available.

- `f` cycles All, Errors, Responses, and Tools filters.
- `s` cycles the scope between all agents, the selected agent, and its subtree.
- `/` searches the activity log.
- `Space` toggles following the newest entry; manual selection pauses following.
- `Esc` clears the search first, then closes the Hub.

## Read and steer a subagent

For a normal local subagent, `Enter` or click focuses the main TUI on that agent's session and closes the Hub. Focusing a parked agent revives it. A killed agent instead opens a read-only transcript; return to the roster and explicitly **Revive** it before focusing or messaging it. The focused transcript, status line, and editor then belong to that subagent:

1. Read its live transcript and tool activity.
2. Type a message and press `Enter` to steer a running turn or prompt an idle agent.
3. Change its model or thinking level with `Alt+P`, `/model [selector]`, `Ctrl+P`, `Shift+Tab`, or `/effort`. These switches are session-only and leave the main session alone. `/roles` and `Alt+M` also open the session-only picker while a subagent is focused, because role assignments configure the main session.
4. Press `Esc` with an empty editor, or double-tap `←`, to return to the main session.

Steering uses the normal prompt path, so the message and response are written to the subagent's persisted session history. While a subagent is focused, `Esc` returns to the main session; it does not interrupt the subagent.

Contexts without a local focusable session use the Hub's full-screen transcript viewer instead. This includes collab guests and advisor rows; advisor transcripts are read-only. The viewer incrementally tails the file-backed transcript and provides an input line only when the selected agent can be messaged. Sending there has the same semantics: revive if parked or killed, steer if running, and prompt if idle.

## Pinned jump list and click to focus

While subagents run, a pinned `Subagents` block above the editor lists every live agent — sync task calls and detached background spawns alike.

The list stays short: it shows a few rows plus an expander (`display.pinnedAgents: collapsed`, the default), lists everything (`full`), or hides entirely (`off`). Clicking the expander toggles between the two while `tui.mouse` is on.

Set `display.subagentLivePreview: true` to add a second line under each row showing what that agent is doing: its current tool call (or, between calls, the most recent one) with a one-line detail, plus the elapsed time once a call runs longer than five seconds. Off by default.

Enable `tui.mouse` to click live subagent cards and jump-list rows directly in the main session, without opening the Hub first. A click focuses that card's most recent agent (a jump-list row focuses its exact agent); focusing a parked agent revives it. Hovering a live target lights it up first, so you can see what a click will open.

Only rows currently in the live viewport are clickable — retired transcript rows live in terminal scrollback, where clicks cannot map back to content. Enabling capture changes terminal gestures while on: text selection becomes Shift+drag, and the terminal reports wheel ticks to omp instead of scrolling, so plain wheel scrolling stops; scroll with the terminal's keyboard scrollback keys or turn capture off. Off by default.

## Persisted agents and advisors

Opening the Hub for a persisted session scans that session's artifact tree. Historical subagent JSONL files become parked rows; a killed agent's tombstone keeps it aborted until it is revived, which removes the tombstone. Nested subagents retain their parent/child lineage. Output and patch artifacts are attached to the corresponding inspector row.

Advisor transcript files (`__advisor*.jsonl`) appear as `advisor`-kind rows under their owning session. They are observability records, not peers:

- their transcripts can be opened and followed;
- they cannot be messaged;
- they cannot be revived;
- they cannot be killed;
- a live advisor can be restarted from its roster row without making its transcript writable.

Collab does not replicate advisor rows or serve their transcripts to guests; the host also rejects advisor chat, revive, and kill requests by id.

## IRC client

`Alt+I` (`app.irc.viewer`) opens the IRC client. It goes to the newest conversation that notified you while it was closed, or resumes your last conversation. `Alt+Shift+I` (`app.irc.traffic`) jumps to the latest global Traffic, including exchanges between other agents. Passive traffic does not change what `Alt+I` reopens.

The left sidebar switches between Traffic, the room roster, recent direct messages, and rooms. Moving the cursor previews a conversation without marking it read. Enter opens it. The center shows whole messages in send order; a room message appears once, not once per recipient. The composer sends as you to your DMs and rooms you belong to. You can inspect other conversations read-only. The right pane shows a room's members.

| Key | Action |
| --- | --- |
| `↑`/`↓` | Preview a conversation or select a row |
| `Enter` | Open a conversation; in the composer, send to that conversation |
| `Alt+Enter` | Insert a newline in the composer |
| `Tab` / `Shift+Tab` | Move between the sidebar, center, and members |
| `PgUp` / `PgDn` | Scroll the message history |
| `/` | Filter the focused conversation list |
| `Alt+K` / `Alt+Shift+K` | Pin / unpin a room or DM |
| `Esc` / `Alt+I` | Back out of a field or popup / close the client |

IRC belongs to the UI's primary conversation even while you view an agent's transcript. Messages delivered to the agent you are viewing still appear in full in its transcript. A DM to you or a room message that mentions you can show a short card, which retires after ten seconds. A direct message from your own `Main` is already visible in its tool call and does not produce an extra card or change the reopen target.

Recent history is capped per root conversation. Persisted sessions keep the IRC journal and your pins, read state and last conversation in owner-only sidecars in the local NeoPi profile, not in the transcript. In-memory sessions do not write those files. Resuming in the same profile restores available history without dispatching old messages or showing old notifications; without the sidecar, the client starts with empty history. Session export, forks, and another profile do not carry these files. Deleting a transcript does not erase the profile sidecars.

Settings:

- `irc.operator.viewerEnabled` (default `true`) allows opening the client.
- `irc.operator.relayToMainTranscript` (default `true`) lets live voice, event sounds and connected clients hear messages between other agents. Those messages never show in the main transcript, and IRC Traffic includes them either way.
- `irc.history.maxEntries` (default `1000`) caps recent IRC history. The oldest messages drop first.
- `irc.operator.handle` (default `Operator`) is your own IRC id; see below.

The client is for the operator only. Agents still receive only messages addressed to them, and no tool exposes the operator's history to them.

### You as a participant

You take part in IRC under your own id, `Operator` unless `irc.operator.handle` names another (it takes effect the next time npi starts). This id is separate from `Main`, the model behind the composer:

- Agents can message you with [`irc`](./tools/irc.md) or `write agent://Operator`. Direct messages from other agents appear in the client and can notify you without waiting for a model turn.
- `/irc <agent> <message>`, `/irc #<group> <message>`, and `/irc all <message>` send as you, never as `Main`. Use `/irc group list` to see groups and [the other group commands](./tools/irc.md#operator-irc) to manage membership. `/irc` alone opens the client.
- The composer still talks to `Main`.

You are not listed in the Agent Hub, and collab guests do not get an id of their own.

## Related surfaces

Agent Hub is the human-facing live session view. Adjacent commands and internal URLs serve narrower purposes:

`/agents` is a separate agent-definition/settings hub, not the live roster. It manages discovered agents, enable/disable state, model overrides, prewalk, and advisor selection. Its definition editor (Ctrl-G on an agent, or **+ New agent**) lists every manifest field beside a live preview of the effective model, tools, spawn policy, output contract, prewalk and advisor, the problems found, and the file as it will be saved. Each field opens its own picker; `r` regenerates the highlighted field with the `agent-author` role, `R` with a comment; `c` saves a copy and Delete removes a user or project definition file.

- `/jobs` prints a snapshot of running and recently settled asynchronous tool jobs. It does not replace the per-agent transcript or control view. `/jobs kill <id>|all` cancels running jobs from the command line.
- `history://<id>` gives the coding agent a concise transcript for a live/parked subagent or a retained on-disk transcript.
- `agent://<id>` resolves a subagent's saved final output artifact; it is not the live transcript. Before that artifact exists, a registered agent resolves to its status, the `yield` payloads it has submitted so far, and its latest assistant text.
- [`irc`](./tools/irc.md) is the built-in agent tool for direct messages and named address lists. `write agent://<id>` still steers or follows up with a normal subagent; `agent://all` broadcasts to visible live members of `everyone`. Messaging a parked subagent revives it; a killed subagent rejects messages until explicitly revived in the Hub. `read history://` lists registered agents and retained on-disk transcripts, refreshing the caller root's persisted roster first, the same as `history://<id>` lookups.
- `read proc://` lists background jobs and project services; `read proc://<id>` inspects status/output without consuming delivery.

Advisor rows are excluded from the regular peer roster and cannot receive IRC into their read-only transcripts. A live advisor explicitly granted `irc` can join named groups and send under its own registry ID.

See also [Task Agent Discovery and Selection](./task-agent-discovery.md), [Collaboration](./collab.md), and [Advisor, WATCHDOG.md, and WATCHDOG.yml](./advisor-watchdog.md).

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
| `x`                         | Abort a running turn if necessary, then kill and release the selected agent. |
| `Esc`                       | Clear an active filter first, then close the narrow inspector or the Hub.    |

`parked` and killed (`aborted`) agents can be explicitly revived with `r` or **Revive**. A killed agent needs a resumable saved transcript and comes back as a fresh instance with its history; its old registry generation remains terminal. `x` is immediate. Opening or focusing a killed transcript, ordinary chat, and IRC messages do not undo the kill.

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
3. Change its model or thinking level with `Alt+P`, `/switch`, `Ctrl+P`, `Shift+Tab`, or `/effort`. These switches are session-only and leave the main session alone. `/model` and `Alt+M` open the same session-only picker, because role assignments configure the main session.
4. Press `Esc` with an empty editor, or double-tap `←`, to return to the main session.

Steering uses the normal prompt path, so the message and response are written to the subagent's persisted session history. While a subagent is focused, `Esc` returns to the main session; it does not interrupt the subagent.

Contexts without a local focusable session use the Hub's full-screen transcript viewer instead. This includes collab guests and advisor rows; advisor transcripts are read-only. The viewer incrementally tails the file-backed transcript and provides an input line only when the selected agent can be messaged. Sending there has the same semantics: revive if parked or killed, steer if running, and prompt if idle.

## Pinned jump list and click to focus

While subagents run, a pinned `Subagents` block above the editor lists every live agent — sync task calls and detached background spawns alike.

The list stays short: it shows a few rows plus an expander (`display.pinnedAgents: collapsed`, the default), lists everything (`full`), or hides entirely (`off`). Clicking the expander toggles between the two while `tui.mouse` is on.

Set `display.subagentLivePreview: true` to add a second line under each row showing what that agent is doing: its current tool call (or, between calls, the most recent one) with a one-line detail, plus the elapsed time once a call runs longer than five seconds. Off by default.

Enable `tui.mouse` to click live subagent cards and jump-list rows directly in the main session, without opening the Hub first. A click focuses that card's most recent agent (a jump-list row focuses its exact agent); focusing a parked agent revives it. Hovering a live target lights it up first, so you can see what a click will open.

Only rows currently in the live viewport are clickable — retired transcript rows live in terminal scrollback, where clicks cannot map back to content. Enabling capture changes terminal gestures while on: text selection becomes Shift+drag and wheel scroll becomes Shift+wheel. Off by default.

## Persisted agents and advisors

Opening the Hub for a persisted session scans that session's artifact tree. Historical subagent JSONL files become parked rows; a killed agent's tombstone keeps it aborted until it is revived, which removes the tombstone. Nested subagents retain their parent/child lineage. Output and patch artifacts are attached to the corresponding inspector row.

Advisor transcript files (`__advisor*.jsonl`) appear as `advisor`-kind rows under their owning session. They are observability records, not peers:

- their transcripts can be opened and followed;
- they cannot be messaged;
- they cannot be revived;
- they cannot be killed.

Collab does not replicate advisor rows or serve their transcripts to guests; the host also rejects advisor chat, revive, and kill requests by id.

## IRC viewer

`Alt+I` (`app.irc.viewer`) opens a fullscreen history of the agent-to-agent messages in this session. The live IRC cards in the main transcript retire after a few seconds and only four show at once; the viewer keeps every message.

Each row shows the time, sender `➤` recipient, and the message body. Broadcasts appear as one row per recipient, marked `broadcast`. Replies are marked `reply`, wake-turn relays `relay`, and failed deliveries show the error. Long bodies are collapsed to two lines.

| Key | Action |
| --- | --- |
| `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End`, wheel | Select a message; `End` follows new traffic again. An expanded message taller than the screen scrolls through its lines first |
| `Enter` or the tool-expand key | Expand or collapse the selected message |
| `/` | Filter by participant (sender or recipient); `Enter` applies, `Esc` clears |
| `r` | Reply to the selected message as yourself; `Enter` sends, `Esc` cancels |
| `Esc` or `Alt+I` | Close |

The history belongs to this UI's root session and its current conversation: `/new` or resuming another session shows that conversation's messages, with or without a session file. It lives in memory and is lost when the process exits. Settings:

- `irc.operator.viewerEnabled` (default `true`) lets the key open the viewer.
- `irc.operator.relayToMainTranscript` (default `true`) controls the live cards in the main transcript; the viewer keeps messages either way.
- `irc.history.maxEntries` (default `1000`) caps the history per process; the oldest messages drop first.
- `irc.operator.handle` (default `Operator`) is your own IRC id; see below.

The viewer is for the operator only. Agents still receive only messages addressed to them, and no tool exposes this history to them.

### You as a participant

You take part in IRC under your own id, `Operator` unless `irc.operator.handle` names another (it takes effect the next time npi starts). This id is separate from `Main`, the model behind the composer:

- Agents list you among their peers and can message you with `write agent://Operator`. Delivery does not wait for any model's turn: the message shows as a card in the main transcript and stays in the viewer. Broadcasts to `agent://all` reach you too.
- `/irc <agent> <message>` or `/irc all <message>` sends as you, and `r` in the viewer replies to the selected message. Agents see these messages as coming from your id, never from `Main`. `/irc` alone opens the viewer.
- The composer still talks to `Main`.

You are not listed in the Agent Hub, and collab guests do not get an id of their own.

## Related surfaces

Agent Hub is the human-facing live session view. Adjacent commands and internal URLs serve narrower purposes:

`/agents` is a separate agent-definition/settings hub, not the live roster. It manages discovered agents, enable/disable state, model overrides, prewalk, and advisor selection.

- `/jobs` prints a snapshot of running and recently settled asynchronous tool jobs. It does not replace the per-agent transcript or control view. `/jobs kill <id>|all` cancels running jobs from the command line.
- `history://<id>` gives the coding agent a concise transcript for a live/parked subagent or a retained on-disk transcript.
- `agent://<id>` resolves a subagent's saved final output artifact; it is not the live transcript. Before that artifact exists, a registered agent resolves to its status, the `yield` payloads it has submitted so far, and its latest assistant text.
- `write agent://<id>` steers or follows up with a normal subagent; `agent://all` broadcasts to visible live peers. Messaging a parked subagent revives it; a killed subagent rejects messages until explicitly revived in the Hub. `read history://` lists registered agents and retained on-disk transcripts, refreshing the caller root's persisted roster first, the same as `history://<id>` lookups.
- `read proc://` lists background jobs and project services; `read proc://<id>` inspects status/output without consuming delivery.

Advisor rows are intentionally excluded from the agent-facing peer roster, `history://` index, and `agent://` messaging workflows.

See also [Task Agent Discovery and Selection](./task-agent-discovery.md), [Collaboration](./collab.md), and [Advisor, WATCHDOG.md, and WATCHDOG.yml](./advisor-watchdog.md).

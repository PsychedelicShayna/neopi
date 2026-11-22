# ctl

> Inspect or control a running npi session over its control socket, including the calling session. Does not spawn a session or inject keystrokes with tmux.

## Source
- Entry: `packages/coding-agent/src/tools/ctl.ts`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| op | string | yes | `list`, `state`, `send`, `input`, `steer`, `follow_up`, `abort`, `esc`, `slash`, `action`, `keys`, `dialogs`, `dialog_answer`, `settings`, or `rpc` |
| target | string | no | Instance id, id prefix, session id, tmux pane (`%3`), `pid:<pid>`, title, or working directory. Omit or pass `self` for your session; ignored by `list`. |
| text | string | no | Prompt, slash command, or settings path |
| actionId | string | no | Keybinding id for `action` |
| dialogId | string | no | Dialog to settle |
| answer | unknown | no | Typed dialog answer |
| rpcType | string | no | RPC command name when `op` is `rpc` |
| params | object | no | Extra RPC parameters |

## Outputs
A text block with the target's JSON response. For `state`, `session` includes `model` (`provider` and `id`), `thinkingLevel`, `fastModeEnabled`, `fastModeActive`, `sessionName`, and `sessionFile` when available. `rpc get_state` also exposes the full state, including dump fields.

Use `rpc get_last_assistant_text` for the last visible reply, `rpc get_messages` for the live transcript, or `read` on `session.sessionFile` for the persisted journal. An in-memory session has no journal to read.

Read `state` before writing. A conflict means the human at the pane edited concurrently; re-read state before retrying. Approvals stay with that pane unless `control.approvals` is on.

## CLI parity

CLI examples below use `T` as the target selector. Unless noted, set `target` to the same selector in the tool; `rpc` takes the command as `rpcType` and its JSON fields as `params`.

| `npi ctl` operation | `ctl` tool equivalent |
| --- | --- |
| No arguments, `list` | `list` (JSON, like `list --json`) |
| `T`, `T state`, `T status` | `state` (JSON, like `T state --json`); CLI human-readable output also shows model, effort, fast status, session name and file |
| `T send TEXT` | `send` with `text` |
| `T input TEXT`, `T slash TEXT` | `input` or `slash` with `text` |
| `T steer TEXT`, `T follow-up TEXT`, or send with `--steer` / `--follow-up` | `steer` or `follow_up` with `text` |
| `T abort`, `T esc` | `abort` cancels; `esc` navigates |
| `T action ID` | `action` with `actionId` |
| `T keys KEY …` | `keys` with one key in `text`; for a sequence, `rpc` with `rpcType: "keys"` and `params: {"keys":[{"key":"down"},{"key":"enter"}]}` |
| `T dialogs`, `T dialog-answer ID JSON` (also `dialog_answer`) | `dialogs`, `dialog_answer` with `dialogId` and `answer` |
| `T rpc TYPE [JSON]`, or `T TYPE` with no parameters | `rpc` with `rpcType` and optional `params`; hyphenated CLI shorthand names map to underscored RPC types |
| `T rpc settings_get`, `T rpc settings_set` / `settings_unset` | `settings` with optional path in `text` to read; `rpc` for layered reads and writes (`path`, `scope`, and `value` for a set) |
| `T rpc set_model` / `set_thinking_level` / `set_fast_mode` | `rpc` with `params: {"provider":"…","modelId":"…"}`, `{"level":"high"}`, or `{"enabled":true}`, respectively |
| Self-target: CLI selects the session explicitly by id or pane | Omit `target` or use `self` to read and write the calling session. It must have a published control socket; the tool never guesses another session. |
| `pipe T [--label LABEL]` | **CLI only.** `pipe` maintains a bidirectional stdin/stdout connection for event streams, subscriptions and connection-scoped services. The tool returns one response per call and closes its connection. |

## Notes
The human's draft is never overwritten. `app.suspend` and external editors are exempt.

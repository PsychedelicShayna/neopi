Inspect or control a running npi session without shelling out to `npi ctl`.

Omit `target` or pass `"self"` for the calling session. For another session, use `list` to find an instance id, or pass its id prefix, session id, tmux pane (`%3`), or title.

- `{"op":"state","target":"%3"}` shows `session.model` (provider/id), `thinkingLevel`, `fastModeEnabled`, `fastModeActive`, `sessionName`, and `sessionFile`.
- `{"op":"rpc","target":"%3","rpcType":"get_last_assistant_text"}` reads the last visible reply. For the transcript, use `get_messages` or `read` on `sessionFile` when present. `get_state` returns full session state.
- `{"op":"rpc","rpcType":"set_model","params":{"provider":"anthropic","modelId":"claude-sonnet-4-5"}}` sets your own model. Set effort with `set_thinking_level` and `params.level`, or fast mode with `set_fast_mode` and `params.enabled`.
- Run a slash command with `op:"slash"` and `text`. Read settings with `op:"settings"` and an optional path in `text`; write with RPC `settings_set` (`path`, `value`, `scope`) or `settings_unset` (`path`, `scope`).

Use `op:"rpc"` with `rpcType` and `params` for other control commands. Use `abort` to cancel work; `esc` navigates.
`text` is the prompt, slash command, or settings path.
`actionId` is a keybinding id (`app.model.select`, `tui.select.confirm`).
`dialogId` plus `answer` settles the open dialog (`{index:0}`, a string, or `"cancel"`).

Use `steer` to reach a busy agent without interrupting; use `send` to interrupt. `follow_up` waits until the target yields and may never reach an automated agent. Its first successful use warns once per calling session (or connection for unbound clients), but still queues the message.

Read `state` before you write. The human at the target pane always wins a concurrent edit: a conflict (`⌁ backed off`) means re-read and retry only if it is still the right thing. Tool approvals stay with that pane unless `control.approvals` is on. Do not use tmux send-keys for npi panes.

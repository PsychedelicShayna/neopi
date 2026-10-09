Drive another running npi session over its control socket. The pane updates as if the human typed it.

`op` is list, state, send, steer, follow_up, abort, slash, action, keys, dialogs, dialog_answer, settings, or rpc.
`target` is an instance id, a prefix of one, a tmux pane id (`%3`), or a title.
`text` is the prompt, slash command, or settings path.
`actionId` is a keybinding id (`app.model.select`, `tui.select.confirm`).
`dialogId` plus `answer` settles the open dialog (`{index:0}`, a string, or `"cancel"`).

Read `state` before you write. The human at the target pane always wins a concurrent edit: a conflict (`⌁ backed off`) means re-read and retry only if it is still the right thing. Tool approvals stay with that pane unless `control.approvals` is on. Do not use tmux send-keys for npi panes.

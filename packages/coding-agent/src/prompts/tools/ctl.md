Drive another running npi session over its control socket.

`op` is list, state, send, steer, follow_up, abort, or slash.
`target` is an instance id, a prefix of one, a tmux pane id (`%3`), or a title.
`text` is the prompt or slash command.

The human at the target pane always wins a concurrent edit: a conflict means back off and re-read state. Tool approvals stay with that pane unless `control.approvals` is on. Do not use tmux send-keys for npi panes.

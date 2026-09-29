# Control socket

Every npi process publishes a same-user Unix socket under `~/.omp/run/control-sessions` so one session can drive the others. `npi ctl` and the `ctl` tool speak that socket. They never spawn a session and they never inject keystrokes with tmux.

```
npi ctl list
npi ctl %3 state
npi ctl %3 send "Reply with exactly: PONG"
npi ctl %3 steer "stop and summarize"
npi ctl %3 abort
npi ctl %3 slash "/fast on"
npi ctl %3 action app.model.select
npi ctl %3 keys escape
npi ctl %3 dialog_answer <id> '{"index":0}'
```

Read `state` before a write. Pass `if` revisions on draft and surface commands. A stale revision is `conflict` and the pane shows `⌁ <label> backed off`. Retry only after re-reading state. Do not use `tmux send-keys` on npi panes.

`app.suspend`, external `$EDITOR`, and `/todo edit` are exempt. Everything else a human can do from the keyboard is reachable by `input`, `keys`, `action`, or a structured twin (`set_model`, `settings_set`, `dialog_answer`).

Disable publishing with `--no-control-socket` or `control.enabled=false`.

# Control socket

Every npi process publishes a same-user Unix socket under `~/.omp/run/control-sessions` so one session can drive the others. `npi ctl` and the `ctl` tool speak that socket. They never spawn a session and they never inject keystrokes with tmux.

```
npi ctl list
npi ctl %3 state
npi ctl %3 send "Reply with exactly: PONG"
npi ctl %3 steer "stop and summarize"
npi ctl %3 abort
npi ctl %3 slash "/fast on"
```

Targets match an instance id, a prefix of one, a session id, a tmux pane (`%3`), `pid:N`, or a title.

The human at the pane always wins a concurrent edit. A control step that carries `if` revisions is refused with `conflict` when the pane changed, and the draft is not overwritten. Tool approvals stay with the pane unless `control.approvals` is on. `app.suspend` and external editors are exempt.

Disable publishing with `--no-control-socket` or `control.enabled=false`.

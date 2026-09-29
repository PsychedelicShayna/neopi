# ctl

> Drive another running npi session over its control socket. Does not spawn a session and does not inject keystrokes with tmux.

## Source
- Entry: `packages/coding-agent/src/tools/ctl.ts`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| op | string | yes | `list`, `state`, `send`, `steer`, `follow_up`, `abort`, `slash`, `action`, `keys`, `dialogs`, `dialog_answer`, `settings`, or `rpc` |
| target | string | no | Instance id, prefix, tmux pane (`%3`), or title. Required except for `list`. |
| text | string | no | Prompt, slash command, or settings path |
| actionId | string | no | Keybinding id for `action` |
| dialogId | string | no | Dialog to settle |
| answer | unknown | no | Typed dialog answer |
| rpcType | string | no | RPC command name when `op` is `rpc` |
| params | object | no | Extra RPC parameters |

## Outputs
A text block with the target's JSON response. A conflict means the human at the pane edited concurrently; re-read state before retrying. Tool approvals stay with that pane unless `control.approvals` is on.

## Notes
The human's draft is never overwritten. `app.suspend` and external editors are exempt.

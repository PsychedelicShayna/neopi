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
npi ctl %3 rpc set_subagent_thinking_level '{"subagentId":"Worker","level":"high"}'
npi ctl %3 rpc set_subagent_fast '{"subagentId":"Worker","enabled":true}'
```

Read `state` before a write. Pass `if` revisions on draft and surface commands. A stale revision is `conflict` and the pane shows `⌁ <label> backed off`. Retry only after re-reading state. Do not use `tmux send-keys` on npi panes.

`app.suspend`, `app.exit` (which would close the socket before replying), external `$EDITOR`, and `/todo edit` are exempt and return an explicit `exempt_*` error. `app.clear` clears the composer without entering the human Ctrl-C double-press shutdown path. Everything else a human can do from the keyboard is reachable by `input`, `keys`, `action`, or a structured twin (`set_model`, `settings_set`, `dialog_answer`).

`commands` includes the pane's TUI-only slash commands and aliases as well as RPC commands. `get_available_models` uses protocol-v2 chunking when its full catalog exceeds one transport frame.

The `hello`, `get_status`, and `state` snapshots carry `session`: the same RPC session state `get_state` returns, minus the `systemPrompt` and `dumpTools` dump fields, so a snapshot stays one frame. `state` with `target: "view"` reports the subagent the pane is focused on and adds `root` (the root session id and generation); with nothing focused, or with the default `target: "root"`, it reports the root session.

Control snapshots and subscribed `queue_update` events include an exact oldest prefix of each queue: at most 256 entries and 43,690 text characters per queue. The combined queues reserve at most half of a protocol-v1 frame even with worst-case JSON escaping. They stop before the first entry that would exceed either budget; no returned queue-chip text is shortened, so it remains valid for `remove_queued_message` and `promote_queued_message`. `queuedMessageCount` and `liveSteered` remain exact even when not all entries fit. RPC `get_state` keeps the full queue; `dequeue` can retrieve a full queued message.

`get_subagents`, `get_subagent_messages`, `cancel_subagent`, `steer_subagent`, `set_subagent_thinking_level`, `set_subagent_fast`, and `set_subagent_subscription` use the process's live subagent registry. Every connection sees the same roster, including subagents that started before it connected. `set_subagent_subscription` is per connection: lifecycle and progress frames (and, at `events`, raw subagent events) go only to connections that asked for them. Thinking-level and fast-mode changes apply to the selected running subagent's next provider request and persist across restart without changing the parent or global defaults. `get_subagents` reports the live model, effort and fast enabled/active state, including edits made from the focused Agent Hub view.

Disable publishing with `--no-control-socket` or `control.enabled=false`.

## Host session discovery and attachment

Hosts can discover persisted sessions without launching an agent or taking its
writer lease:

```sh
npi sessions list --json --cwd /path/to/project
npi sessions list --json --all
npi sessions list --json --session-dir /legacy/session-dir
npi sessions read --json /absolute/session.jsonl --max-messages 200
npi sessions entries --json --scope branch --direction backward --limit 100 /absolute/session.jsonl
npi ctl pipe <instance-id> --label neocode
```

`sessions list` defaults to the current working directory and uses the resume
picker's session set, including sibling worktrees, empty-session filtering and
pinned sessions. `--all` selects every project. Repeated `--session-dir` flags
select exactly those directories instead; they cannot be combined with `--all`.
Discovery never creates a session directory, repairs backups, or takes a writer
lease. Results are sorted by modification time, newest first.

The single JSON document is `{ "version": 1, "sessions": [...] }`. Each entry has
`path`, `id`, `cwd`, nullable `title` and `parentSessionPath`, ISO-8601 `created`
and `modified` (or `null` if unavailable), `messageCount`, nullable lifecycle `status`, and a trimmed
`firstMessage` of at most 300 characters. `inUse` is `null` or `{ "pid": 1234 }`
(`0` means an unknown live holder). `control` is `null` or
`{ "instanceId": "...", "role": "tui", "pid": 1234 }`, matched against a live
control publication by the session file's resolved real path. Roles can also be
`rpc`, `acp`, or `print`. A busy session without a control endpoint cannot be
attached; do not open it as another writer.
An invalid creation timestamp falls back to the file's modification time.

`sessions read` returns `{ "version": 1, "session": { "path": "...", "id": "...",
"cwd": "...", "title": null }, "messages": [...], "truncated": false }`. Each
message has `role` (`user` or `assistant`), visible `text`, and an ISO-8601
`timestamp` (or `null` when the persisted message timestamp is missing or invalid).
Text blocks are joined with two newlines. Thinking, tools, custom
entries, and empty visible messages are omitted. The read-only display transcript
follows the persisted leaf and the latest compaction. `--max-messages N` retains
the last N visible messages and sets `truncated` when anything was dropped
(`0` returns no messages). No lease is acquired, even against a busy session.
With `--json`, errors are a single stderr JSON line with `type: "error"`,
`code`, and `message`, and a nonzero exit status.

Modern journals also expose each visible message's persisted `entryId`,
`leafId` (nullable), and the complete root-to-leaf `branchEntryIds`. The ancestry
includes nonvisible entries and is never truncated. `branchMessages` is a separate
full selected-branch text projection, including messages before compaction;
`--max-messages` caps it independently and sets `branchMessagesTruncated`.
The existing `messages` projection still follows the latest compaction.

For safe restoration across process lifetimes, `userEntryIds` includes even
textless user messages. `sessionExitEntryIds` includes every exact `session_exit`
marker, including malformed markers; `sessionExits` contains only validated
`{ entryId, kind, reason, pendingToolCallCount, lastAssistantStopReason }`
metadata. A consumer must not skip an earlier malformed exit to certify a later
process lifetime. These identity fields are absent for legacy journals without
persisted IDs; ordinary transcript reads still work without modifying the file.
Open and continue such a journal in NeoPi to persist migrated IDs before relying
on them for restoration.

`ctl pipe` accepts the same selectors as other ctl operations. It verifies the
challenge, authenticates, and subscribes to all session events. Stdout starts
with the owner's `ready` frame, carrying `protocolVersion: 1`,
`supportedProtocolVersions: [1, 2]`, the same `maxFrameBytes` and
`maxReassembledFrameBytes` limits as stdio RPC, and `control_v1`. It relays every subsequent
frame except the responses to its own hello and subscription. Stdin accepts
ordinary RPC JSONL, including v2 `rpc_chunk` frames. Stdout remains v1 until a
successful relayed `negotiate_protocol` response, then uses v2 chunking, just like
stdio RPC. Request ids and responses pass through unchanged. A blocked stdout
pauses owner-frame consumption until the consumer drains. A blocked control socket
pauses stdin consumption, including frames already buffered in the current chunk,
until the socket drains.

With `session_journal_events`, attachment also relays native journal commits,
leaf changes, session identity changes and durable message-ID associations.
Subscribe before fetching initial native pages and buffer those events while
reconciling the snapshot. An owner changing session ID or canonical file
invalidates the old binding. These are notifications from the existing writer,
not a request to open the journal for writing. See [Native journal events](./rpc.md#native-journal-events).
On an existing connection, use `snapshot_session_journal` after installing a new
watcher and before paging. It emits the current native unsaved assistant as
`message_start` with `snapshot: true` and the same ID future live events use,
then replies. This does not create another writer or subscription.

Stdin EOF sends `bye` and exits successfully; it detaches without stopping or
aborting the owner. Owner socket closure also exits successfully. Resolution or
authentication failure before any relayed frame produces one stderr JSON line
`{ "type": "startup_error", "code": "control_unavailable", "message": "..." }`
and exits with status 1. Full control access can mutate the owner's session:
attachment itself does not open a second writer, but callers must still respect
the human-edit and approval rules above.

RPC `ready` capabilities advertise `session_catalog` for the two session
commands, `session_history_identity` for durable transcript/branch identity, and
`control_pipe` for the stdio attachment command. Hosts should gate on these
capabilities, not a version-number guess. History synchronization should read
without a message cap and verify the saved leaf remains in the selected ancestry
before appending new native entries; changed branches must not silently replace
an existing host transcript.

`session_journal` advertises canonical journal paging over RPC/control and the
read-only `sessions entries` command. Prefer it for complete native history:
`sessions read` remains the existing collapsed transcript export. `sessions entries`
accepts `--scope journal|branch`, `--direction forward|backward`, `--cursor` and
`--limit` and returns the [native journal page](./rpc.md#native-journal-pages).
It never starts an agent, claims a writer lease, or rewrites a journal. Use the live
owner's `get_entries_page` when attached; a disk reader can only observe the
persisted leaf. JSON failures are stdout `{ "error": { "code": "...", "message": "..." } }`
documents with a nonzero exit status.

## Monitor connections

The [tmux agent monitor](./monitor.md) uses narrower connections. A full (token) connection sends `monitor_grant` with an `agentId` and gets back a capability for one subagent or advisor of this session's root. A pane says `hello` with `monitor: { capability }` and `protocolVersion: 2` instead of the token. Its hello reply carries the grant's scope (`agentId`, `kind`, `canChat`) and no session snapshot.

A monitor connection can send only `monitor_subscribe` (agent snapshot, owner title and cwd, and the initial unsaved state), `monitor_transcript` (`fromByte`, returns complete JSONL lines), and `monitor_chat` (`text`, subagents only, not aborted ones). Anything else returns `monitor_only`. The owner pushes `monitor_live`, `monitor_agent`, `monitor_notice`, and `monitor_gone`. A grant ends when its agent is removed or replaced, when the root session changes, or when the owner revokes it, and the connection then gets `monitor_gone` with the reason.


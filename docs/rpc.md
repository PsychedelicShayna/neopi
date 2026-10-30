# RPC Protocol Reference

RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

- **stdin**: commands (`RpcCommand`), extension UI responses, host-tool updates/results, and host-URI results
- **stdout**: a ready frame, command responses (`RpcResponse`), session/agent events, extension UI requests, and host-tool/host-URI requests and cancellations

This is a custom JSONL protocol, not JSON-RPC 2.0.

Primary implementation:

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/agent-session-events.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## Startup

```bash
omp --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- `--no-ui` (with `--mode rpc` or `--mode rpc-ui`) runs extensions headless: `ctx.hasUI` is `false`, dialogs resolve to their defaults, and extension presentation updates are dropped. With `rpc-ui`, tool UI such as `ask` remains enabled. With `rpc`, no UI requests are emitted except for a host-issued `login`. See [Extension UI Sub-Protocol](#extension-ui-sub-protocol) for the exact boundaries.
- CLI RPC modes disable automatic session title generation (`PI_NO_TITLE=1`) to avoid an extra model call. `rpc-ui` also sets `PI_NO_PTY=1`.
- A flagless RPC launch (`--mode rpc` or `--mode rpc-ui` with no session flags) always starts a new session in the default per-cwd session directory. Protocol modes (`rpc`, `rpc-ui`, `acp`) ignore the user's `autoResume` setting. `--new-session` makes that explicit (and applies it in every mode); it combines with `--session-dir <dir>` to create the session in `<dir>`, and is rejected at argument parsing together with `--continue`, `--resume`/`--session`, or `--fork`.
- RPC/ACP pin neutral defaults for settings declaring the corresponding `protocolDefault`, including task isolation/execution, memory, advisor, and advisor tier settings. RPC additionally pins async-job and bash/eval auto-background defaults. Explicit project/global config, `--config`, and isolated settings remain authoritative; on-disk config changes are watched in long-lived CLI RPC processes. Todo settings are not host-defaulted.
- The process claims stdin before extension discovery, then parses it one non-empty JSONL line at a time. Malformed JSON emits a recoverable `command: "parse"` failure and does not terminate the loop.
- At startup it writes a `ready` frame, then starts reading stdin while extensions initialize. Control frames (`extension_ui_response`, `set_ask_dialog`, `tool_approval_response`, `plan_proposal_response`, `host_tool_result`, `host_tool_update`, `host_uri_result`) are dispatched on arrival, so an extension that asks a dialog question during `session_start` receives the host's answer. `negotiate_protocol` is also answered on arrival during startup, since it needs no session, so a bounded host handshake completes while a startup dialog is open. Commands, `bash` included, are queued and processed in arrival order once initialization completes. Hosts that send no startup dialog answers observe no change in frame order.
- When stdin closes, pending extension UI, tool approval, host-tool, and host-URI requests are rejected and a pending plan proposal resolves as `refine` (announced with `plan_proposal_cancel`, `reason: "shutdown"`); accepted commands are drained, the session is disposed, and pending stdout is delivered. Normal shutdown exits with code `0`. A session-persistence failure still latched at disposal exits with code `1` after delivering its `notice` frame.
- Responses/events are written as one JSON object per line.

### Capabilities

| String | Feature |
| --- | --- |
| `get_usage` | The `get_usage` command returns account-level provider usage reports. See [Session](#session). |
| `get_roles` | `get_roles` / `set_role` commands and `get_state.activeRole` ([payloads](#get_roles-and-set_role-payloads)) |
| `themes_configuration` | `get_themes_configuration`, scoped `update_theme`, and `themes_configuration_changed`. |
| `theme_palette` | Read any installed theme's resolved palette by name with `get_theme`, without changing the selected theme. |
| `model_selector` | Read-only `query_model_selector` returns native `/switch` matches, ordering, role aliases and row facts. |
| `models_configuration` | Native provider/model catalog and scoped role/effort configuration, with expected-value write conflicts. |
| `cancellable_login` | Login prompts can request secret input; `cancel_login` cancels only a login owned by the same connection. |
| `set_chat_mode` | Live chat-mode switching: the `set_chat_mode` command, `get_state.chatMode`, the `chat_mode_changed` event, and the `/chat` builtin in `get_available_commands`. |
| `tool_approval_request` | `set_approval_handler` and the typed `tool_approval_request` / `tool_approval_response` / `tool_approval_cancel` frames; see [Tool Approval Sub-Protocol](#tool-approval-sub-protocol) |
| `set_mode` | `set_mode` command, `get_state` `mode`/`planMode`, `mode_changed` event, and the `plan_proposal_request`/`plan_proposal_response` round trip. See [Plan Mode Sub-Protocol](#plan-mode-sub-protocol). |
| `new_session` | `--new-session` is accepted, and a flagless protocol launch never auto-resumes: the process starts a fresh session in the default per-cwd session directory regardless of `autoResume` (see [Startup](#startup)). |
| `session_lease` | A process holds an exclusive lifetime lease on every session file it writes, so two processes never append to one transcript. `--session <file>` onto a file another process holds fails at startup with a `startup_error` stderr line; `switch_session` and `branch` onto one fail with `code: "session_in_use"` (see [Session lease](#session-lease)). |
| `plan_proposal_cancel` | A pending plan proposal that resolves without a host answer is announced with a `plan_proposal_cancel` frame, and a later `plan_proposal_response` for it fails with `code: "proposal_cancelled"`. See [`plan_proposal_cancel`](#plan_proposal_cancel). |
| `prompt_entry_ids` | `prompt`, `steer`, `follow_up` and `abort_and_prompt` responses carry `data.userEntryId`, the id of the session entry their message is written as, and every `get_messages_page` message carries the `entryId` of its entry. See [Entry ids](#entry-ids). |
| `session_journal_events` | Native journal commits, active-leaf changes, session identity changes and durable streaming-message associations. See [Native journal events](#native-journal-events). |
| `session_tree_navigation` | Guarded native same-file `navigate_tree`, restored drafts and images, and explicit `resume_tree` acknowledgement for ask re-answers. See [Native tree navigation](#native-tree-navigation). |
| `session_journal` | `get_entries_page` reads complete native journal or active-branch entries over RPC/control; `npi sessions entries --json` reads the same persisted records without a writer lease. |

### Native models configuration

`get_models_configuration` returns safe native model facts, inference providers and auth sources, effective role resolutions, persisted `global` and `project` selector/effort pairs, and effective/scoped effort rules. `contextWindow` remains a model capability; `effectiveContextWindow` comes from the native maintenance-budget resolver, including session/role overrides, model limits and context rules. Model secrets, transport headers and raw settings are not included. Provider identity and login methods come from the native registry rather than a host inventory.

Provider `acceptsKeys` reports the native `set_provider_api_key` eligibility gate
(`ModelRegistry.hasProvider`), not whether an arbitrary platform key will be
accepted upstream. It does not derive key support from environment-variable names.
Each `loginProviders` entry includes `loginKind` (`api-key`, `oauth-code`,
`device-code` or `custom`), `deviceCode`, and optional `storeCredentialsAs`.
`deviceCode` also covers custom device-code hooks; preserve the alias ID when
starting login and use `storeCredentialsAs` to identify the credential provider.
Models include their optional native catalog `description`.

`set_model_role_configuration` takes `role`, explicit write-target `scope`, optional single `selector`, optional native `effort`, and `expected`, the previous scoped `{selector, effort}` pair with unset fields represented as `null`. Omitting the selector clears that scope. It uses the model hub's Settings transaction. Both scopes are writable regardless of the `roleStorage` preference; writing a project assignment never changes that preference. Assigning a new role id creates a custom role through the ordinary role registry. `set_effort_rules` takes `scope`, optional ordered `rules`, and the prior scoped list as `expected`, or `null` for an unset layer. Omitting `rules` clears the layer. Both await persistence and reject stale snapshots with `configuration_conflict`. Patterns, `re:` expressions and effort choices, including `off`, retain native semantics.

`set_model_role_storage` takes `value` and the previous `expected` preference, each `global` or `project`. It uses the native setting owner and persistence receipt without deleting either scope's saved roles. Configuration writes consume the applied/conflict decision made under the native YAML lock; matching a value after saving is not proof that a stale transaction won.

Each configuration role includes `source: "builtin" | "configured"`, `section`, and effective `patterns`, the same metadata already available from `get_roles`. `scopedResolutions.global` resolves persisted global aliases without borrowing a project/runtime assignment; `scopedResolutions.project` resolves project aliases with global inheritance. Each is a native `{provider, modelId, thinkingLevel?}` resolution or `null`; the existing `resolved` remains the effective session view. The scoped selector/effort CAS pairs are unchanged. Its `fallbacks` is the effective `{chain, efforts}` pair; `fallbacksGlobal` is the persisted global pair used for expected-value writes. `set_model_role_fallbacks` takes `role`, `scope: "global"`, ordered `chain`, per-selector native `efforts`, and `expected` matching `fallbacksGlobal`. Empty chains clear the global fallback definition. It uses the same paired selector/effort transaction as the model hub. Effort keys must belong to the chain.

`set_model_role_description` takes a known `role`, `scope: "global"`, `description`, and the last effective description as `expected` (`null` when absent). It preserves the role's other display metadata. Fallback and description writes currently use their native global storage; requesting project scope returns `scope_mismatch` rather than changing the storage policy.

`delete_model_role` takes a custom `role`, `scope`, and the prior scoped `{selector, effort}` pair as `expected`. It removes that scope's assignment, effort and role metadata/cycle membership; global deletion also clears that role's global fallback definition. Definitions inherited from another scope remain visible. Unknown roles return `unknown_role`, built-in deletion returns `builtin_role`, and deleting a role not defined in the requested scope returns `scope_mismatch`. These writes reject stale expected values with `configuration_conflict` and do not change the session's explicitly selected model.

Authored role, fallback and effort-rule patterns are validated before persistence. Invalid explicit `re:` expressions return `invalid_value` with the offending pattern instead of saving a rule that would later be skipped. Glob syntax remains Bun's native grammar. Previously loaded invalid regex rules remain safe to read and skip during resolution.

Model-role and effort changes emit `models_configuration_changed`, including adopted raw scope changes hidden by a higher layer and native settings-file notifications from another client. Equal disk reloads do not emit. Hosts should reread configuration instead of resolving patterns themselves. Role definitions change configuration, not another session's explicit current model selection.

`set_provider_api_key` upserts a key through the native credential pool without replacing other accounts. `get_logout_accounts` and `logout` retain account-specific removal. `login` requires a unique request ID and runs without blocking later commands. Its `extension_ui_request` frames include `loginId`; input frames may set `secret: true`. Answer them through `extension_ui_response`. `cancel_login` takes that login request ID, aborts the native flow and cancels its outstanding input. Disconnect also aborts the flow. A cancelled login never reports a saved credential.


### Session lease

A process that writes a session file holds an exclusive OS-level lease on it from open to close (`.{basename}.lease` beside the file, plus a kernel-owned gate). The kernel releases it when the process exits, including SIGKILL, so a crashed holder never needs manual cleanup. Managers inside one process share the lease; only other processes are excluded. Leases are local to one machine: a session directory on a network filesystem shared between hosts is unsupported.

- **Startup.** `--mode rpc --session <file>` (or `--resume <file>`) when another live process holds `<file>` writes exactly one JSON line to **stderr** and exits non-zero before any `ready` frame:

  ```json
  { "type": "startup_error", "code": "session_in_use", "pid": 4242, "sessionFile": "/home/u/.omp/agent/sessions/.../2026-...jsonl" }
  ```

  `pid` is the holder's process id, or `0` when the holder has not recorded itself (it is still starting, or its session directory is read-only or full and the record could not be written). A holder with `pid: 0` still owns the file.
- **Commands.** `switch_session` (and `branch`) targeting a file another process holds return `success: false` with `code: "session_in_use"`; the current session, including a running turn, is left unchanged. `open_session` skips leased sessions when picking the newest one in `sessionDir`, as `--continue` does.
- **Flagless launches** create a new file and hold its lease, so a later `--resume` of that file from another process is refused while this process lives.
- Read-only consumers (`get_subagent_messages`, `export_html`, `npi render`, transcript readers) never take the lease and work on leased files.

## Transport and Framing

Protocol v1 stdout frames are a single JSON object followed by `\n`. The server caps each physical stdout frame at 1 MiB, including the newline. Inbound frames are always one unchunked JSONL object; clients SHOULD keep them within the advertised physical-frame limit. Input is not reassembled from `rpc_chunk` frames.

The initial ready frame uses protocol v1 and advertises the opt-in lossless transport:

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864,
  "capabilities": []
}
```

`capabilities` lists optional features this process supports. Hosts MUST gate optional features on these exact strings rather than on NeoPi version numbers; strings are never renamed. See [Capabilities](#capabilities).

Clients that support protocol v2 SHOULD immediately send:

```json
{ "id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2 }
```

After the success response, oversized stdout objects use an uninterrupted sequence of `rpc_chunk` frames rather than content truncation. Each chunk carries a base64 segment of the UTF-8 JSON object:

```json
{
	"type": "rpc_chunk",
	"chunkId": "rpc-1",
	"index": 0,
	"count": 7,
	"byteLength": 1600042,
	"data": "eyJ0eXBlIjoicmVzcG9uc2UiLC4uLn0="
}
```

Clients MUST validate `chunkId`, `index`, `count`, and `byteLength`, reject interleaved or interrupted sequences, enforce the advertised reassembly limit, concatenate decoded bytes in index order, decode them as strict UTF-8, and parse the result as one JSON object. The TypeScript `RpcFrameDecoder`, exported from `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame`, implements this validation. The bundled TypeScript and Python `RpcClient` implementations and the Rust and Go clients negotiate v2 automatically when the ready frame advertises it.

For an oversized `agent_end` in either version, the encoder first removes the leading messages already delivered unchanged in `message_end` frames and adds `messageCount` with the original count. Hosts must retain streamed messages rather than treating `agent_end.messages` as a complete transcript.

Legacy clients may ignore the added ready fields and remain on v1. In v1, an oversized response becomes `success: false` with `error: "RPC response exceeded the transport limit"`; oversized events may have strings, arrays, or object fields elided. If a v2 logical frame exceeds 64 MiB after terminal-frame compaction, responses receive the same overflow error, other events produce `rpc_frame_error`, and `agent_end` falls back to an empty `messages` array plus `messageCount`. Large history APIs should use pagination rather than depending on arbitrarily large logical frames.

Output goes directly to stdout while the reader keeps up. Under backpressure, the server spills pending bytes to a private temporary file and drains it in 64 KiB blocks, preserving frame order. This limits queued output memory at the cost of disk I/O and temporary disk usage, which can grow until the reader catches up. The file is removed when the backlog drains or the process shuts down. Output or spool failures are logged, dispose the session, and exit with code `1`.

Clients MUST continue reading stdout after closing stdin. Normal EOF and extension-requested shutdown wait for pending output delivery; a client that keeps its stdout pipe open without reading can delay exit indefinitely.

### Outbound frame categories (stdout)

1. Ready frame (`{ type: "ready" }`)
2. `RpcResponse` (`{ type: "response", ... }`)
3. `AgentSessionEvent` objects (`agent_start`, `message_update`, etc.)
4. `RpcExtensionUIRequest` (`{ type: "extension_ui_request", ... }`)
5. Host tool requests/cancellations (`host_tool_call`, `host_tool_cancel`)
6. Host URI requests/cancellations (`host_uri_request`, `host_uri_cancel`)
7. Extension errors (`{ type: "extension_error", extensionPath, event, error }`)
8. Available-commands updates (`{ type: "available_commands_update", commands }`), emitted at startup and whenever command metadata changes
9. Prompt completion (`{ type: "prompt_result", id?, agentInvoked, status, error?, sessionSettled }`), unless the response already completed the prompt locally; see [`prompt` payload](#prompt-payload)
10. Session quiescence (`{ type: "session_settled" }`); see [Yield vs settled](#yield-vs-settled)
11. Subagent frames (`subagent_lifecycle`, `subagent_progress`, `subagent_event`), gated by `set_subagent_subscription`
12. Builtin slash-command side channels (`command_output`, `session_info_update`, `config_update`)
13. Tool approval requests/cancellations (`tool_approval_request`, `tool_approval_cancel`), only after `set_approval_handler` with `handler: "host"`
14. Plan mode frames (`mode_changed`, `plan_proposal_request`, `plan_proposal_cancel`); see [Plan Mode Sub-Protocol](#plan-mode-sub-protocol)
15. Transport overflow notifications (`rpc_frame_error`), when an event cannot fit within the transport limits
16. Side-question frames (`btw_delta`, `btw_record`); see [Side questions](#side-questions-btw)
17. Live voice frames (`live_phase`, `live_levels`, `live_transcript`, `live_end`); see [Live Voice Sub-Protocol](#live-voice-sub-protocol)
18. Draft-only dictation frames (`dictation_state`, `dictation_transcript`, `dictation_end`); see [Dictation Sub-Protocol](#dictation-sub-protocol)

Protocol v2 may wrap oversized logical frames from these categories in `rpc_chunk` frames.

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)
3. Host tool updates/results (`host_tool_update`, `host_tool_result`)
4. Host URI results (`host_uri_result`)
5. Tool approval answers (`tool_approval_response`)
6. Plan proposal decisions (`plan_proposal_response`)

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.

Important edge behavior from runtime:

- Unknown command responses echo the request `id` when one was provided.
- Malformed JSON and synchronous dispatch failures emit `command: "parse"` without an `id`. Exceptions while handling a recognized command emit a failure with that command's `type` and `id`.
- Ordinary `prompt` handling acknowledges after the message is admitted (queued, given an idle turn slot, or routed to an extension command), not before native `input` handlers or image preparation finish, and without waiting for the agent run. `abort_and_prompt` first awaits the abort, then acknowledges. A failure before admission is the command's error response. A failure after admission can still emit a later error response with the same `id`.
- An accepted `prompt` or `abort_and_prompt` completes exactly once: either its success response carries `data.agentInvoked: false` (finished locally), or a later `prompt_result` frame with the same `id` reports how its work ended. `prompt_result` is always written after the response for that `id`.

## Command Schema (canonical)

`RpcCommand` is defined in `packages/coding-agent/src/modes/rpc/rpc-types.ts`:

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "remove_queued_message", message: string, queue: "steering" | "followUp" }`
- `{ id?, type: "promote_queued_message", message: string }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort_and_restore_queue" }`
- `{ id?, type: "new_session", parentSession?: string }`
- `{ id?, type: "open_session", sessionDir: string, provider?: string, modelId?: string }`

### Protocol

- `{ id?, type: "negotiate_protocol", protocolVersion: 2 }`

### State

- `{ id?, type: "get_state" }`
- `{ id?, type: "set_fast_mode", enabled: boolean }`
- `{ id?, type: "set_chat_mode", mode: "off" | "chat" | "erp" | "raw", include?: string | string[] }`
- `{ id?, type: "set_mode", mode: "default" | "plan", planFilePath?: string }`
- `{ id?, type: "set_slow_mode", enabled: boolean }`
- `{ id?, type: "goal", op: "get" | "create" | "resume" | "pause" | "drop", objective?: string, token_budget?: number }`
- `{ id?, type: "set_ask_dialog", enabled: boolean }`
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "get_entries", since?: string }`
- `{ id?, type: "snapshot_session_journal" }`
- `{ id?, type: "get_entries_page", scope?: "journal" | "branch", direction?: "forward" | "backward", cursor?: string, limit?: number }`
- `{ id?, type: "get_tree" }`
- `{ id?, type: "navigate_tree", targetId: string, expectedSessionId: string, expectedSessionFile: string | null, expectedLeafId: string | null, summarize?: boolean, customInstructions?: string, allowAskReopen?: boolean, reanswerAskResult?: TreeAskReanswer }`
- `{ id?, type: "resume_tree", resumeToken: string, expectedSessionId: string, expectedSessionFile: string | null, expectedLeafId: string | null }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "set_event_filter", events: string[] | null, messageUpdates?: "full" | "delta" }`
- `{ id?, type: "set_approval_handler", handler: "host" | "ui" }`; see [Tool Approval Sub-Protocol](#tool-approval-sub-protocol)
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number }`
- `{ id?, type: "cancel_subagent", subagentId: string }`
- `{ id?, type: "steer_subagent", subagentId: string, message: string }`

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`
- `{ id?, type: "get_roles" }`
- `{ id?, type: "set_role", role: string }`

`get_available_models` waits for background model discovery before returning. `set_model` also waits when the requested model is not already in the available catalog; it returns the selected `Model` or a `Model not found: <provider>/<modelId>` failure.

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`
- `{ id?, type: "get_available_thinking_levels" }`

`ThinkingLevel` is `"inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`. Discovery returns `"off"` followed by the live model's supported efforts, omitting `"inherit"` and the session-only `"auto"` selector.

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

`compact` answers with the `CompactionResult` once the compaction ends. Progress
arrives as `manual_compaction_start` and `manual_compaction_end` events (see
[Progress events](#progress-events)).

### Cache warming

- `{ id?, type: "set_cache_warming", mode: "off" | "streaming" | "idle" }`

Sets `providers.cacheWarming` for the current session without writing `config.yml`.
`off` clears scheduled refreshes and aborts any refresh in flight; `streaming`
warms during active agent runs; `idle` also warms between runs. Enabling warming
does not replay an old, cancelled run: the next real provider request arms it.
Invalid modes return the usual `success: false` response. Success reports the
effective mode after applying the override:

```json
{ "id": "warming-off", "type": "response", "command": "set_cache_warming", "success": true, "data": { "mode": "off" } }
```

The TypeScript client exposes `setCacheWarming(mode): Promise<CacheWarmingMode>`.

### Retry

- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

### Bash

- `{ id?, type: "bash", command: string }`
- `{ id?, type: "abort_bash" }`

`bash` is dispatched concurrently: the RPC server continues reading commands
while the shell command runs, so `abort_bash` (or any other command) sent
during a long-running `bash` is handled without waiting for it to finish on
its own. The `bash` response is emitted when the command completes; hosts
correlate it via `id`. Ordering across concurrent commands is not guaranteed
— clients MUST match responses on `id`, not on emission order.

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "get_usage", provider?: string, refresh?: boolean, redact?: boolean }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }` — fails with `code: "session_in_use"` when another process holds the file (see [Session lease](#session-lease))
- `{ id?, type: "branch", entryId: string }` — same `session_in_use` code if the branch file is held elsewhere. `entryId` must be a user request: a user message or a user-invoked `/skill:` prompt (a `custom_message` entry); `data.text` is the request as typed, `/skill:<name> <args>` for a skill prompt
- `{ id?, type: "switch_session", sessionPath: string, provider?: string, modelId?: string }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "fork", entryId?: string }`
- `{ id?, type: "navigate_tree", entryId: string, summarize?: boolean, customInstructions?: string }` → `data: { cancelled: boolean, aborted?: true, editorText?: string }`
- `{ id?, type: "abort_branch_summary" }`
- `{ id?, type: "set_label", entryId: string, label?: string }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "handoff", customInstructions?: string }`

`get_usage` returns `data: { generatedAt: number, reports: UsageReport[] }`: the
same report objects `npi usage --json` prints in its `reports` field, without
the provider-specific `raw` payload. `UsageReport` is defined in
[`packages/ai/src/usage.ts`](../packages/ai/src/usage.ts). `generatedAt` is
the epoch-ms time the response was built; each report carries its own
`fetchedAt`. The reports come from the session's auth storage, so they share
its usage cache and in-flight coalescing with the status line and `/usage`:
back-to-back requests make one upstream fetch.
`handoff` fails while a response is streaming. On success, its payload is `{ savedPath? }` or `null` when no handoff was produced. Session transitions (`new_session`, `switch_session`, `branch`, `fork`, `open_session`) report cancellation when an extension prevents the transition.

`fork` moves the process onto a new session file and returns `{ cancelled }`; read the new `sessionFile`/`sessionId` with `get_state`. With `entryId` (any `message` entry from `get_entries`, such as a user or assistant message), the new file holds the root-to-entry path including that entry plus the session's artifacts, so kept `artifact://` references still resolve, and its header's `parentSession` is the old session file. When `entryId` sits inside an assistant tool-call batch (the assistant message itself, or one of its tool results), the cut extends through the batch's recorded tool results so the fork never ends on tool calls whose results were dropped. This runs `session_before_branch`/`session_branch` hooks with reason `"fork"`, and the hook's `entryId` is the last kept entry. Without `entryId` it copies the whole session and its artifacts (`/fork`), records the old session id as `parentSession`, runs `session_before_switch`/`session_switch` with reason `"fork"`, and reports `cancelled: true` when the session is not persisted. A non-message `entryId` fails. Both variants fail with `code: "session_busy"` while a response is streaming or bash, eval, compaction, handoff, or retry work is running, including work that starts while the fork's hooks or flushes are awaited; a refused fork keeps the current session, its transcript, and its queued next-turn messages and background jobs. The Python client exposes `fork(entry_id=None) -> CancellationResult`.

- `provider` keeps only reports for that provider id (case-insensitive). An
  unknown id yields `reports: []` with `success: true`.
- `refresh: true` invalidates the cached reports for `provider` (or every
  provider) before fetching, like `npi usage invalidate [--provider <id>]`.
- `redact: true` masks account identifiers (`metadata.email`, `accountId`,
  `projectId`, `orgId`, `orgName`, and the `accountId`/`projectId`/`orgId` of
  each limit's `scope`) exactly as `npi usage --redact` does. Masked values keep
  a short prefix, e.g. `al*`, so hosts can still tell accounts apart.
- Providers without credentials or without a usage endpoint are absent. A
  failed fetch of one account is absorbed by the usage cache (last good report
  or omission), as in `npi usage`. When the fetch as a whole fails, every
  provider it would have covered is reported with `limits: []` and a `notes`
  entry that describes the failure, and the command still succeeds.
- The command fails with `code: "usage_unavailable"` only when the session has
  no initialized auth storage.

Like `bash`, `get_usage` is dispatched concurrently: a `prompt` or other
command sent while it waits on a slow provider is handled without waiting for
it, and the `get_usage` response may arrive after later responses. Match
responses on `id`. There is no usage push event; poll `get_usage`, for example
after `agent_end`.

`handoff` fails while a response is streaming. On success, its payload is `{ savedPath? }` or `null` when no handoff was produced. Session transitions (`new_session`, `switch_session`, `branch`, `open_session`) report cancellation when an extension prevents the transition.
`navigate_tree` moves the session's leaf to `entryId` in the same session file, as the interactive `/tree` selector does: a user message rewinds past itself (the leaf moves to its parent and `editorText` carries its text), any other entry becomes the leaf. With `summarize`, the abandoned branch is summarized by the session's model (with `customInstructions`, if given) and the summary entry lands at the target. A refusal never moves the leaf or writes to the transcript. An unknown `entryId` (`code: "entry_not_found"`) and a session already busy when the command runs (`code: "session_busy"`, as for `fork`) are refused before any side effect, so a running `btw` question and a waiting goal continuation are left alone. Two refusals come after the navigation has started, so they still cancel a running `btw` question (a waiting goal continuation is held and then resumes): `code: "session_busy"` when work started while the summary was generated, and `code: "ask_reanswer_unsupported"` for an `ask` tool result whose questions the interactive picker could reopen, since re-answering needs that picker (an `ask` result whose original questions cannot be recovered is a plain leaf move). A goal continuation waiting to start is held until the navigation ends and then runs on the new leaf. Read the new transcript with `get_messages`. `abort_branch_summary` stops a running summary: that `navigate_tree` answers `{ cancelled: true, aborted: true }` and nothing moves; it skips the command queue, which would otherwise hold it behind the `navigate_tree` it stops.

`set_label` sets an entry's label, or clears it when `label` is omitted; it fails for an unknown `entryId`.
### Messages

- `{ id?, type: "get_messages" }`
- `{ id?, type: "get_messages_page", cursor?: string, limit?: number }`

`get_messages_page` returns a stable chronological page with `messages`, `totalMessages`, and an opaque `nextCursor` when more messages remain. Cursors are bound to the session ID, durable leaf, and message count. The server rejects stale cursors if the session changes between requests, and refuses to start a paging walk while the session is streaming or compacting. Failed page requests carry a machine-readable `code` on the error response — `session_busy` (session is streaming or compacting) or `stale_cursor` (the snapshot behind the cursor changed, e.g. a background bash appended a message between pages) — so clients can react without matching error-message text. Pages default to 100 messages; `limit` must be an integer from 1 through 256. The page builder normally caps serialized message content at 768 KiB, but always includes at least one message, so a single large message can exceed that budget. A v1 caller can page ordinary histories, but an individual message whose response exceeds the 1 MiB physical-frame ceiling produces an overflow error; retrieving it losslessly requires negotiated v2 framing.

The bundled TypeScript `RpcClient.getMessages()` and Python `RpcClient.get_messages()` drain this paged endpoint automatically after negotiating v2. They retain the legacy monolithic command when connected to a v1 server, and on either `session_busy` or `stale_cursor` they discard partial pages and fall back to the legacy best-effort snapshot. Direct `getMessagesPage()` and `get_messages_page()` calls remain strict so incremental hosts never mix snapshots silently.

### Login

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`
- `{ id?, type: "get_logout_accounts", providerId: string }` → `data: { accounts: LogoutAccount[] }`
- `{ id?, type: "logout", providerId: string, credentialId: number }` → `data: { remainingSource?: string }`
- `{ id?, type: "activate_account", providerId: string, credentialId: number }`

Login forwards ordinary OAuth input prompts only after the provider emits an
authorization URL. Prompts marked `secret: true` are always rejected with a
failed `login` response directing the user to the terminal UI; no ordinary
`input` request is emitted because RPC does not negotiate whether a host masks
`secret` inputs. (Extension and tool `input` dialogs may still attach an
unnegotiated `secret?: boolean` hint on `extension_ui_request`; see below.)

Logout works per stored credential, as `/logout` does in the TUI, because one
provider can hold several accounts. `get_logout_accounts` lists them (`credentialId`,
`provider`, `label`, `detail`, `type`, and `active` for credentials the session may
be using), active first. `logout` removes one and refreshes that provider's models;
it fails when the credential is no longer stored. `remainingSource` names the source
that still authenticates the provider: another stored credential, an environment
variable, or a config key.

`get_login_providers` retains `id`, `name`, `available` and `authenticated`, and
adds `loginKind`, `deviceCode`, optional `storeCredentialsAs`, and `acceptsKeys`
with the same meanings as model configuration. No saved key, access token or
refresh token is included.

For a real device-code flow, `extension_ui_request` with `method: "open_url"`
also carries `userCode`, the user-facing verification code from the provider's
response. It is not extracted from `instructions`; the private polling
`device_code` is never sent. The TypeScript login callback receives this as its
fourth `onOpenUrl` argument; generated SDK frames expose the same `userCode`.

`activate_account` accepts the inference/credential provider ID and the durable
ID of a stored **OAuth** account from `get_logout_accounts`. It uses the same
session preference as native account switching and records the account identity
hash through the session credential-pin journal. It neither changes the current
model nor another session's account. The native affinity owner retains its
existing availability, restrictions and runtime/config auth-override checks.
Unknown providers, missing or foreign accounts, API-key rows and malformed input
fail with `invalid_value`; streaming or compaction returns `session_busy`.
Success has no data payload and never returns credential bytes.

### Word prediction

- `{ id?, type: "predict_word", text: string, cursor: number }` → `data: { suffix: string | null }`
- `{ id?, type: "predict_word_feedback", text: string, cursor: number, suggestion: string, accepted: boolean }`

Composer ghost text for hosts that render their own input box. `text` is the
whole draft and `cursor` a UTF-16 offset into it. The server applies the same
gates as the terminal editor (the cursor must sit at the end of its line and
end a prose word; code, paths, and slash commands get nothing) and answers from the engine selected by
`spelling.autocomplete`; `off` always answers `suffix: null`.

`predict_word` is dispatched concurrently like `bash`, so a slow prediction
never delays other commands; match responses on `id`. Per session the server
keeps one engine request in flight: a request arriving while one runs waits,
and a newer one replaces it, answering the replaced request `suffix: null`.
Hosts may send on every keystroke; only the newest draft reaches the engine.

The first request may take seconds (worst case about two minutes) while the
shared prediction daemon starts and loads its engine. When the daemon cannot
start or answer, `predict_word` fails (`success: false`), and keeps failing
fast for about 30 seconds while the daemon is backed off. Treat failures as
"no ghost text" rather than surfacing them per keystroke.

Send `predict_word_feedback` with the `text` and `cursor` at which a
suggestion was shown: `accepted: true` when the user took it, `false` when
they typed past it. Feedback tunes the engine's learned state.

### Side questions

- `{ id?, type: "btw", question: string, recordId?: string }` → `data: { record: BtwHistoryRecord }`
- `{ id?, type: "btw_cancel", recordId?: string }` → `data: { cancelled: boolean }`
- `{ id?, type: "get_btw_history" }` → `data: { records: BtwHistoryRecord[] }`

See [Side questions (`/btw`)](#side-questions-btw).

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string, code?: string }`

Data payloads are command-specific and defined in `rpc-types.ts`.

### `prompt` payload

`prompt` is acknowledged once the message is admitted — an idle turn has started for it, it has been pushed onto the steer/follow-up/aside queue while the agent is busy, or it has been routed to a registered extension command (before that command's handler runs) — not after a model turn finishes. Admission runs any image normalization first (and, for a text-only model with vision description enabled, the vision-description call), so those complete before the acknowledgement. The vision-description call is capped at 20 seconds, which keeps the acknowledgement inside the bundled clients' 30-second request timeout; past the cap the image is still saved and the model is told its description is unavailable. The same applies to a `/skill:` invocation sent through `prompt`. A prompt that settles without ever being admitted (dropped by an `abort`, or failing first) is acknowledged once it settles. Gating the acknowledgement does not change completion: the prompt still completes exactly once, through `data.agentInvoked: false` or its `prompt_result` (below).

`prompt` starts after previously received ordinary commands, such as `new_session` or `set_model`, have completed. Its admission then runs in the background: the RPC server keeps handling later commands — `abort`, `steer`, `follow_up`, `get_state`, and so on — without waiting for slow image normalization or vision description. An `abort` that lands while a prompt's images are still being prepared cancels the vision-description call and drops the prompt, whether it would have started an idle turn or been queued with `streamingBehavior`.

```json
{
	"id": "req_1",
	"type": "response",
	"command": "prompt",
	"success": true,
	"data": { "agentInvoked": false }
}
```

`data.agentInvoked: false` is the completion signal for builtin slash commands that finish synchronously without starting an agent turn; no `prompt_result` follows. Every other accepted `prompt` (and every `abort_and_prompt`) is completed by one `prompt_result` frame carrying the command `id`, once its local outcome or agent yield is known. Background work need not have settled:

```json
{ "type": "prompt_result", "id": "req_1", "agentInvoked": true, "status": "completed", "sessionSettled": true }
```

- `agentInvoked: false`: the prompt finished locally (an extension or custom command that started no turn) or failed before reaching the agent.
- `agentInvoked: true`: the prompt was dispatched or queued for agent work; normal completion reports when the agent **yielded** — see [Yield vs settled](#yield-vs-settled). An abort that wins before dispatch can still report `true` with `status: "aborted"`. A prompt dispatched as a fresh turn reports the first run that started after it was accepted, so a late `agent_end` from an earlier run never completes it. A prompt queued into a live run (`streamingBehavior`) reports at the first yield after its message left the queue. An `agent_end` with `yielded: false` (the agent is retrying, compacting, or answering a stop-time reminder) never completes a prompt.
- `status`: `"completed"`, `"aborted"` (interrupted by `abort`, `abort_and_prompt`, or a session transition, or dropped by an abort before dispatch), or `"error"`.
- `error` (only with `status: "error"`): `{ message, provider?, model?, httpStatus?, retryable, code? }`. `message` is the provider's error text with OMP-local diagnostics (such as saved request-dump paths) removed. `retryable` marks a transient failure; OMP's own automatic retries have already been exhausted. `code: "cost_cap"` means the session reached `session.maxCost` and OMP did not send the next request; the server keeps running, and later prompts end the same way until the cap is raised. A prompt that fails before reaching the agent also gets the legacy error response with the same `id` before its `prompt_result`.
- `sessionSettled`: whether the session is already done when the result is written — see [Yield vs settled](#yield-vs-settled). `false` means background work can still wake the agent; a `session_settled` frame follows once it has.

A failed provider turn is not a failed command: the prompt response is still `success: true`, and the turn ends with a normal terminal `agent_end` whose last assistant message has `stopReason: "error"`. Use `prompt_result.status` rather than parsing that message.

Local-only slash commands may emit `command_output` frames before completing. They do not emit `agent_end`.

#### Entry ids

`prompt` (with or without `streamingBehavior`), `abort_and_prompt`, `steer` and `follow_up` answer with the id of the session entry their message is written as:

```json
{ "id": "req_2", "type": "response", "command": "steer", "success": true, "data": { "userEntryId": "3f9a1c07" } }
```

- The id is allocated when the command is accepted, so the response still arrives before the turn runs. The entry is written under exactly that id once the message reaches the session: at the start of the turn for a prompt, when the queue delivers it for a steer, follow-up, or queued prompt. From then on it is the `id` in `get_entries` and the `entryId` of the message in `get_messages_page`.
- The entry is a `message` entry with `role: "user"`, or a `custom_message` entry (`customType: "skill-prompt"`) for a `/skill:` prompt. `branch` accepts either kind and removes that turn together with everything after it. Hidden context the session writes just before the message in the same turn (magic-keyword notices, attachment notes) has its own entries and stays on the branch.
- `userEntryId` is absent when the prompt writes no entry of its own: an extension command, a locally consumed TypeScript or MCP prompt command (including a failed one), or a builtin slash command consumed on the spot (`data.agentInvoked` is set; a builtin that schedules its own turn, like `/retry`, reports `agentInvoked: true` and still writes no new user entry). A custom command that returns a prompt instead receives the id of the resulting user entry.
- A message that never reaches the session writes no entry: a prompt that fails or is dropped before the turn starts (its `prompt_result` reports `agentInvoked: false` or `status: "error"`), or a queued steer/follow-up cancelled before the queue delivers it. Such unused reservations are released; a session change also releases any remaining reservations.

Each `get_messages_page` message carries `entryId`, including custom messages (`custom_message` entries), the compaction summary (`compaction` entry) and branch summaries (`branch_summary` entry). Context the session injects per turn without persisting it (for example Vibe-mode context) has no entry and no `entryId`.

### Native journal events

Stdio RPC and control owners advertise `session_journal_events` and emit:

- `journal_state` with `reason: "snapshot" | "identity" | "leaf"`.
- `journal_entry` with the complete canonical native `entry`, only after storage acknowledges persistence.
- `message_persisted` with the streaming `messageId` and canonical journal `entryId`.
- `message_start` with `snapshot: true`, the current unsaved assistant `message` and its streaming `messageId`, when an assistant is already in flight at the snapshot boundary.

Every frame carries `sessionId`, canonical absolute `sessionFile` and `leafId`.
`sessionFile` is `null` for an in-memory owner. The leaf describes the running
owner's current branch, including pointer-only tree navigation. A leaf change
alone does not claim that a new entry or a pointer change was persisted.

Observers subscribe before the initial `journal_state` snapshot. Attach with
`npi ctl pipe` or control `subscribe` before requesting native journal pages.
Buffer notifications while fetching the initial pages, deduplicate entries by
their native IDs and discard the old binding when either session ID or file
changes. Restart branch paging when the leaf changes. The initial state frame
contains identity and bounded recovery mappings, not a second copy of the journal.

For a new watcher on an already connected runtime, register the local event
listener, then send `snapshot_session_journal` before reading history pages.
The command emits `journal_state`, any current assistant snapshot, and the
`tool_execution_start` plus latest `tool_execution_update` for each still-running
call before its response. Tool replay frames carry `snapshot: true`; they describe
an existing execution, never a request to run it again. Their original call IDs,
arguments and latest partial results are preserved, and they respect the event
filter. A tool can be running even when no assistant message is streaming.
Snapshot tool frames carry the ordinary tool-event fields rather than journal
identity fields. Its response data is `{ sessionId, sessionFile, leafId }`.
It never replaces subscriptions or restarts a stream. Repeated snapshots and
new control connections reuse the native owner's current `messageId` across
stdio/control updates, end and persistence receipt.
Native live IDs are opaque and unique across owner incarnations, including
reopening the same session ID/file after a restart. Compare the complete string;
do not parse a counter or derive identity from a journal filename. A new owner
cannot reuse a cached pre-restart message's ID for different output.
The snapshot reads the native in-flight assistant directly, so a quiet reply
appears immediately without waiting for another delta. It is unsaved output,
not a journal entry. No assistant frame is emitted when none is in flight.
Native session transitions return `session_busy`.

Snapshot frames carry the same canonical identity fields. An intervening
newer message event or owner/leaf change suppresses an older captured snapshot.
The client's ordered event stream remains authoritative; a snapshot is never
published after a newer event with stale content.

Live `message_start`, updates and `message_end` remain unsaved output until a
`message_persisted` frame associates them with a journal entry. An opaque live
`messageId`, an accepted prompt's reserved `userEntryId`, or a completed stream is
not a durability receipt. Failed or intentionally skipped persistence produces
no association. Recovery announces entries only after native persistence succeeds.
Messages already present in the initial history use their native entry IDs;
they need no live-message association.

On every attachment and `snapshot_session_journal`, the `journal_state` frame
with `reason: "snapshot"` also includes `messageEntryIds`:

```json
{ "type": "journal_state", "reason": "snapshot", "sessionId": "01a0...", "sessionFile": "/srv/session.jsonl", "leafId": "a12bc345", "messageEntryIds": [{ "messageId": "msg-019ac518-1122-7333-8444-556677889900-7", "entryId": "a12bc345" }] }
```

Use these authoritative pairs to reconcile cached live output when a disconnect
lost its `message_persisted` frame, even if no assistant is currently streaming.
Connected observers still receive the original one-shot persistence frame.
Mappings belong to the native session owner, not an observer: disconnecting all
observers or finishing a run does not clear them. The owner retains only ID
strings for its last **256 live messages assigned entry IDs**, in association
order, and snapshots publish only those whose entries are currently durable.
Queued/failed writes never become durability receipts. Repeated snapshots do not
consume mappings; ordinary branch navigation retains them. A session ID/file
change or native process restart clears the recovery window. Older producers
omit `messageEntryIds`; current producers send an empty array when none qualify.
Absence of a pair, including eviction from this bounded window, does **not**
prove that a live message was discarded or not persisted. Do not content-match
or silently drop unmatched output.

These frames respect `set_event_filter`, including `message_start` for snapshots. Protocol v2 uses the existing
chunking limits for large entries without truncation. The TypeScript client
exposes journal notifications and assistant snapshots through `onJournalEvent`;
existing `onEvent` and `onSessionEvent` listeners retain their event types.
Consumers must ignore unknown event kinds.

### Yield vs settled

For agent-invoking work, a prompt's `prompt_result` reports the **agent yield**: it finished its turn (`agent_end` with `yielded: true`), or the prompt was aborted before dispatch or by a session transition. Local-only results and pre-dispatch errors do not require an `agent_end`. The **session is done** only when nothing can wake it again — no run is live or admitted, no steer/follow-up is queued, and no background job (auto-backgrounded `bash`, async `task`, `eval`) or pending delivery will inject its result and start a follow-up turn.

- `session_settled` is written once per stretch of agent activity, when the session becomes done. If background work was pending at the yield, OMP waits it out; any follow-up runs it triggers stream normally (`agent_start` … `agent_end`) before `session_settled`. It always follows the `prompt_result` frames of the final yield, and is not emitted for prompts that never reached the agent.
- `prompt_result.sessionSettled` answers the same question at the yield, so a host can tear down immediately when it is `true`.
- `get_state` reports `isSettled` (same predicate) and `hasPendingAsyncWork`, for hosts that attach mid-stream.

Wait on `prompt_result` to present a turn's answer; wait on `session_settled` (or `isSettled`) before treating the conversation as finished, e.g. before pausing or recycling a sandbox.

### `open_session` payload

`open_session` binds the process to a host-keyed conversation directory — the runtime equivalent of `--session-dir <dir> --continue`, so a pre-spawned process can adopt a thread after startup. It continues the newest non-empty session in `sessionDir` (or, like `--continue` in a terminal with no record of its last session, the copy of that session's conversation with the newest turn when it went on in another file), or starts a fresh session there when none exists. Reopening the session that is already active (including a still-empty fresh session in the same directory) is a no-op that does not interrupt a running turn; otherwise the current run is aborted as with `switch_session`, and open prompts complete with `status: "aborted"`.

```json
{ "cancelled": false, "resumed": true, "sessionId": "01a0...", "sessionFile": "/srv/threads/t1/2026-...jsonl" }
```

`resumed` is `false` when a fresh session was started. The command fails when the process runs without persistence (`--no-session`).

A successful `open_session` also marks still-open RPC prompt tickets aborted, even for an already-open directory; in that no-op case the underlying turn continues streaming. `cancelled: true` leaves the active session and prompt tickets unchanged.

A resumed session restores its saved model, as `--continue` does. When none of its saved models can be restored (for example, after a model id rename or with no credentials for the provider), `open_session` fails with `Could not restore model <provider/id>` rather than send the transcript to another model. The previous session stays active, and the process keeps serving, but a turn that was running in it has been aborted, as with any session switch. `switch_session` fails the same way.

To bind with a specific model instead, pass `provider` and `modelId` together, as in `set_model`. Like `--model` at startup, they replace the saved model and skip its check. An unknown pair fails with `Model not found: <provider>/<modelId>` before any session change. A resumed session records the model when it differs from the saved one, and an already-open or fresh session selects it as `set_model` does. `switch_session` accepts the same pair.

```json
{
	"id": "open-1",
	"type": "open_session",
	"sessionDir": "/srv/threads/t1",
	"provider": "anthropic",
	"modelId": "claude-sonnet-4-5"
}
```

### `remove_queued_message` payload

Remove the first matching user-authored message from the selected pending queue:

```json
{"id":"req_2","type":"remove_queued_message","message":"Use the existing parser","queue":"steering"}
{"id":"req_2","type":"response","command":"remove_queued_message","success":true,"data":{"removed":true}}
```

`message` first matches the original submitted text retained before slash/custom-command rewriting, prompt-template expansion, or `^model` mention substitution; if that finds nothing, it matches the exact queue-chip text. Removal never reruns a command or template to find a match. Queued RPC skill commands retain their original `/skill:<name>` invocation as the chip text. Removal also drops that message's attachments and contiguous preceding hidden user companions (keyword notices, image descriptions, and video source paths), preserving other messages and the other queue.

Companions and their prompt are enqueued and dequeued as a complete group, including in `one-at-a-time` mode. Once that group leaves the pending queue for delivery, a removal request cannot report success after only part of its context has been emitted.

Agent-authored entries never match, including internal handoffs with `role: "user"` and `attribution: "agent"`. With duplicate text, each request removes only the first matching occurrence; repeating a successful request can remove another occurrence.

The check and removal are synchronous: `data.removed: false` means no matching user message is pending in that queue at dispatch time. Already-dequeued messages and inputs still being preprocessed cannot be cancelled by this command. Live-steered input may remain visible in queue snapshots until the transcript records it, even though it has already left the removable pending queue. It does not resend input, abort a turn, or change interruption behavior. Non-string `message` values and missing or invalid `queue` values produce an error response.

A removal request may hide the chip or restore its draft only after `removed: true`; normal delivery still removes chips through queue snapshots. Older runtimes reject this command; clients must not fall back to aborting or resending queued messages. The TypeScript client exposes `removeQueuedMessage(message, queue): Promise<{ removed, images?, imagesDropped? }>`.

When the removed message carried images, `data.images` lists them (the same `ImageContent` entries `abort_and_restore_queue` returns), so a client can restore the draft with its attachments; text-only messages and `removed: false` responses omit it. If the images would exceed the negotiated transport limit (see `abort_and_restore_queue`), the server omits them and sets `data.imagesDropped: true` instead of failing; the message is still removed. Older runtimes return neither field.

The official Python client exposes `remove_queued_message(message, queue) -> RemoveQueuedMessageResult`; inspect its `.removed` boolean rather than the result object's truthiness.

### `promote_queued_message` payload

Move the first matching user-authored follow-up to the end of the steering queue:

```json
{"id":"req_3","type":"promote_queued_message","message":"Use the existing parser"}
{"id":"req_3","type":"response","command":"promote_queued_message","success":true,"data":{"promoted":true}}
```

The command moves the existing queued message, including its attachments and contiguous preceding hidden user companions, without reprocessing or duplicating it. `message` matches exactly as for `remove_queued_message`, so agent-authored entries never match. With duplicate text, each request moves only the first matching follow-up; repeating a successful request can move another occurrence.

`data.promoted: false` means no matching user follow-up is pending at dispatch time (for example, it was already delivered). Non-string `message` values produce an error response. Existing steering, follow-up, and interrupt modes still apply; promotion does not abort the model stream or guarantee cancellation of running tools. While the agent is idle, a promoted message starts a turn right away, including after a user `abort` — promoting is an explicit request to steer now. The move is reported as one `queue_update` in which the message has already left `followUp` and joined `steering`.

Since `prompt` acknowledges only once the message is admitted (see above), a `promote_queued_message` sent immediately after a queued `prompt`'s acknowledgement reliably observes it. Older runtimes reject this command; clients must not fall back to `steer`, which would enqueue a duplicate. The TypeScript client exposes `promoteQueuedMessage(message): Promise<{ promoted: boolean }>`, and its `prompt(message, images?, streamingBehavior?)` accepts `"steer"` or `"followUp"` to queue a prompt sent while the agent is busy.

The official Python client exposes `promote_queued_message(message) -> PromoteQueuedMessageResult`; inspect its `.promoted` boolean rather than the result object's truthiness.

### `abort_and_restore_queue` payload

Take queued user input back and abort, atomically — the RPC equivalent of pressing Esc in the TUI:

```json
{"id":"req_4","type":"abort_and_restore_queue"}
{"id":"req_4","type":"response","command":"abort_and_restore_queue","success":true,"data":{"steering":[{"text":"Use the existing parser"}],"followUp":[{"text":"Then run the tests","images":[{"type":"image","mimeType":"image/png","data":"..."}]}]}}
```

Before aborting, the server withdraws every user-authored steering and follow-up message, including input the run already took from the queue but never recorded in the transcript: steering the aborted response claimed live, and steering or follow-ups dequeued for its next model call. Visible queued messages that an extension or agent sent (extension cards from `pi.sendMessage`, a parent agent's steer, agent-attributed prompts with their hidden companions, advisor cards) are not returned and not lost: once the run stops, the abort records them in the transcript without starting a turn, so the model sees them with the next prompt. Other hidden queued context is dropped: `display: false` custom messages (goal/plan/budget notices) and synthetic developer directives. The abort starts no turn from the old queue; if another source started a turn while it was finishing, the visible messages join that turn as follow-ups. A plain `abort` instead requeues stranded steers and drains them into a fresh turn; withdrawing them first with `remove_queued_message` races the agent loop.

`data.steering` and `data.followUp` list the withdrawn messages oldest first, as `{ text, images? }` with `text` being the queue-chip text, so a client can put them back in its editor. The command otherwise behaves like `abort`: it stops goal continuation, cancels input received before it that is not yet admitted (that input is dropped, not returned), and responds after the abort completes. Older runtimes reject this command. The TypeScript client exposes `abortAndRestoreQueue(): Promise<{ steering, followUp }>`.

The response always succeeds, even when the withdrawn input is too large for one response under the negotiated protocol (1 MiB per frame on v1, 64 MiB reassembled on v2). Instead of failing with a transport-limit error, which would lose the already-withdrawn input, the server first omits every entry's `images` and sets `data.imagesDropped: true`, keeping all texts. If the texts alone still do not fit, it returns only the oldest entries that fit (steering first, then follow-ups) and sets `data.truncated: true`; entries after the last one listed are gone. Neither flag is present when the full result fits.

### `get_state` payload

Use `{ "type": "get_state", "includeDump": false }` for repeated status reads
that do not need `systemPrompt` and `dumpTools`. Omitting the option preserves
the full response.

`sessionUsage` is the native journal index's cumulative usage across all branches,
including messages before compaction and completed task results. Its `cost` already
includes `subagentCost`; do not add that field again. `advisorCost` is separate.
Only combine it with journal cost when `advisorCostState` is `ready`. During
resume it may be `restoring`, or `unavailable` if restoration failed. These are
recorded costs, not a bill estimate for unfinished child runs. `get_session_stats`
continues to describe the active transcript window.

`approvalMode` reports the effective native tool policy, including the
process-local auto-approve override. Reading it does not change permissions.
Per-tool policies and safety checks still apply.
`approval_mode_changed` announces native approval-setting changes, including
watched file reloads. Re-read state after the event; it is not a policy mutation
request or confirmation that a GUI preference was applied.

`tokensPerSecond` is a number when output throughput is available and `null`
otherwise. `fastModeEnabled` reports the session's selected model-family tier
(`priority` or `ultrafast`), while `fastModeActive` reports the actual computed
active state. For Fireworks, `providers.fireworksTier: priority` is independent
of the `/fast` family setting, so `fastModeActive` may remain `true` for a model
that `/fast` cannot toggle. Fireworks `-fast` serving variants do not use priority.

For direct Anthropic, a provider rejection of `speed: "fast"` uses a sticky
fallback scoped by the resolved endpoint and exact model: `fastModeEnabled` may
remain `true` while `fastModeActive` is `false`. An explicit `set_fast_mode`
enable expresses retry intent and clears that fallback so the provider attempt
is re-armed.

`slowModeSupported` reports whether `/slow` applies to the active model: the
`flex` service tier on OpenAI- and Google-family models, or the low-priority
lane on direct Anthropic models. `slowModeEnabled` reports whether it is on for
the active model, so it is always `false` when `slowModeSupported` is `false`.
That does not mean a persisted setting was turned off. `slowModeScope` says
where the active model's setting lives: `global` for persisted config that
survives model switches and applies to every session and terminal (Claude low
priority, `providers.anthropic.slowMode`), or `session` for this session's
per-family flex tier. It is absent when unsupported. Re-read all three after a
model change; a `global` change made by another session emits no event.

`usageLimit` reports the active model's account past its usage limit, in a
provider-neutral shape. `stage` is `wrap_up` during a short allowance after the
limit or `low_priority` once the account is served on spare capacity.
`resetsAtSec` is an epoch timestamp for client-local formatting; low priority
may also report `allowanceLeftPercent`, while wrap-up reports whether
`extraUsage` follows. Claude subscriptions are the only producer today. The
field is absent outside both stages. No event carries it, so re-read
`get_state` while a run is active, after `agent_end`, and after slash commands.

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh|max",
  "isStreaming": false,
  "isCompacting": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "fastModeEnabled": false,
  "tokensPerSecond": null,
  "fastModeActive": false,
  "slowModeSupported": true,
  "slowModeEnabled": true,
  "slowModeScope": "global",
  "usageLimit": {
    "stage": "low_priority",
    "resetsAtSec": 1770000000,
    "allowanceLeftPercent": 62
  },
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "hasPendingAsyncWork": false,
  "isSettled": true,
  "queuedMessages": { "steering": [], "followUp": [] },
  "todoPhases": [
    {
      "name": "Todos",
      "tasks": [
        {
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
  "systemPrompt": ["..."],
  "dumpTools": [
    {
      "name": "read",
      "description": "Read files and URLs",
      "parameters": {}
    }
  ],
  "contextUsage": {
    "tokens": 1100,
    "contextWindow": 200000,
    "percent": 0.55
  },
  "activeRole": "smol",
  "chatMode": "off|chat|erp|raw",
  "mode": "plan",
  "planMode": {
    "planFilePath": "local://PLAN.md",
    "workflow": "parallel"
  },
  "chronicler": {
    "status": "running",
    "sessionId": "...",
    "sessionFile": "...",
    "artifactsDir": "...",
    "lastCommittedAt": "2026-10-08T14:11:33.132Z",
    "error": "...",
    "retryAt": 1791500000000
  },
  "goal": null
}
```

`chronicler` reports the session diary's capture health. `status` is one of:

| Status | Meaning |
|---|---|
| `off` | Chronicler is disabled for this session. |
| `no_model` | Enabled, but its model role does not resolve. |
| `running` | Bound to the current session and capturing. |
| `retrying` | A capture, store, or ownership step failed; recovery is scheduled at `retryAt`. |
| `contended` | Another live writer holds the session's Chronicle lease, or a legacy lease cannot be proven abandoned. `error` carries the lock diagnostic. |
| `halted` | The stored Chronicle is invalid or oversized; `error` says why. Live sessions keep revalidating it and resume once it is repaired. |
| `suspended` | Paused across a new session, fork, resume, branch, or cwd move; rebinds when the transition finishes or rolls back. |
| `stopping` / `stopped` | The session is shutting down. |

`sessionId`, `sessionFile`, and `artifactsDir` describe the session Chronicler is bound to now, not the one it started with. `lastCommittedAt` is the last committed beat's timestamp, including history inherited through a fork. `error` and `retryAt` (epoch milliseconds) are present only while a failure is outstanding.

`activeRole` is the model role the current model was selected through, and is
absent when the model was chosen directly. `set_role` sets it, and so does a
launch through a role selector (`--model @smol`, or a bare configured role
name) when that selector produced the session's model. `--smol`, `--slow` and
`--plan` only reassign those roles, so they set nothing on their own. Any later
direct model change (`set_model`, `cycle_model`, `/model`, switching session or
branch to a different model) clears it. A retry fallback does not: the fallback
model is part of the role's chain. A resumed session reports the role recorded
with its last model change, except `default`, which is also what a direct model
pick records.

### Shared native themes

`get_themes_configuration` discovers installed native theme names and returns
`selection.dark` and `selection.light`. Each has its effective name, the explicit
`global` and `project` values or `null`, and resolved semantic `colors`.

To preview a discovered theme without selecting it, send
`{"type":"get_theme","name":"dark"}`. With the `theme_palette` capability, RPC
and terminal control return `{ "name": "dark", "colors": { ... } }`, including
the native theme's resolved semantic and exported colors. Unknown names return
an error; the active theme and persisted configuration are unchanged.

Send `update_theme` with `appearance: "dark" | "light"`, `scope: "global" | "project"`,
`name` and `expected`. Both names are strings or `null`. `expected` must match the
last read value in that scope. A mismatch returns error code `conflict`; refresh
and let the user choose again. A null `name` removes that scope's override.
Project values take precedence over global values. Native configuration overlays
can still determine the effective value, which is always returned after a write.

Connected terminal and RPC sessions emit `themes_configuration_changed` when an
effective theme setting changes. Re-read the configuration after that event and
on reconnection. Themes remain native configuration; a client should not write
configuration files or substitute a bundled theme inventory.

### Native model selector query

Send `{"type":"query_model_selector","query":"example"}` to read the native
`/switch` filter without selecting a model or starting a turn. The same command
is available through terminal control. Check the `model_selector` capability
before using it.

The result contains `items`, `roles` and `error`. `items` is the native picker's
ordered concrete model list after applying the session's enabled scope and
query. `roles` contains visible, resolved chat-role aliases, filtered by the
same native browser. Each row carries its selectable `selector`, native
`provider`, `id`, `name`, optional `description`, `resolvedSelector` and `facts`.
Keep role aliases intact when selecting them so the session follows the role.
Clients must not apply another text filter or reorder native matches.

Facts include `intelligence`, measured `ttftMs`, `tokensPerSecond`, catalog
`contextWindow`, native `effectiveContextWindow`, `inputCostPerMillion` and
`outputCostPerMillion`. Missing values are `null`, not zero. Performance uses
the session's service tier when measured, then the standard aggregate, then the
fastest measured tier. Catalog throughput is used only when measured throughput
is unavailable. `performanceSource` and `serviceTier` identify those values.
Effective context is the native maintenance budget, not a provider capability.
`error` reports an unavailable catalog while preserving any usable scoped rows.
### `get_roles` and `set_role` payloads

Advertised by the `get_roles` capability. `get_roles` lists every known model
role:

```json
{
  "roles": [
    {
      "id": "smol",
      "alias": "@smol",
      "name": "Fast",
      "tag": "SMOL",
      "section": "chat",
      "source": "builtin",
      "configured": "openai/gpt-5.6-luna:low, anthropic/claude-haiku",
      "patterns": ["openai/gpt-5.6-luna:low", "anthropic/claude-haiku"],
      "resolved": { "provider": "openai", "modelId": "gpt-5.6-luna", "thinkingLevel": "low" },
      "hidden": false
    }
  ],
  "activeRole": "smol"
}
```

- `roles` includes every built-in in its fixed order, then roles introduced
  by `cycleOrder`, `modelRoles` and `modelTags`, including roles marked hidden.
- `section` is `"chat"`, or `"kind"` for the non-chat model-kind roles
  (`image`, `web`, `speech`, `dictation`, `judge`); hosts that only pick chat
  models filter on it.
- `source` is `"builtin"` for built-in role ids and `"configured"` for roles
  that exist only through configuration.
- `namespace` is `"deck"` for every `deck-*` role, built-in or configured, and absent for other roles. The built-in `deck-inbox` chat role defaults to `openai-codex/gpt-6-luna`; consumers can register further `deck-*` roles through the ordinary [role settings](./models.md#neodeck-roles).
- `tag` is absent for custom roles, which have no built-in tag.
- `description` is the effective `modelTags.<id>.description` override or the
  built-in default. Custom roles have no default description. An empty string
  deliberately clears the description. In `/models`, `D` edits this metadata
  and the selected role's description appears above its rows.
- `configured` is the raw `modelRoles` selector (lists joined with `", "`),
  absent when the role is not configured.
- `patterns` is the effective pattern chain for `@<id>`: nested role aliases
  expanded, `:thinking` suffixes kept, built-in fallbacks and priority
  defaults applied. It is empty when the role has nothing to try.
- `resolved` is the first pattern that matches an available (authenticated,
  provider not disabled) model, trying chat models first and then models of
  any kind. `thinkingLevel` is present when the pattern carries a suffix.
  `resolved` is absent when no pattern matches.
- `hidden` reflects `modelTags.<id>.hidden`.

`set_role { role }` switches the primary session model to the role, resolving
it the way `--model @<role>` does at launch: same resolver, same fallback
chain, and the pattern's thinking suffix is applied. Without a suffix the
current thinking level carries over, as with `set_model`. It writes no
configuration and does not affect the models subagents or the advisor use.
Success data:

```json
{ "role": "smol", "model": { "provider": "openai", "id": "gpt-5.6-luna" }, "thinkingLevel": "low" }
```

`model` is the full `Model` object, as in `set_model`. `model_changed` (when
the model differs), `thinking_level_changed` (when the level differs) and
`config_update { model, thinkingLevel }` are emitted before the response.

Failures carry a `code`, and none of them change the model:

| `code` | When |
| --- | --- |
| `unknown_role` | `role` is not an id listed by `get_roles`. |
| `session_busy` | The session is streaming or compacting. |
| `role_unresolved` | No pattern in the role's chain matches an available model. |

`chatMode` is the session's live chat mode; `off` is an ordinary coding session.

### `set_chat_mode` payload

`set_chat_mode` switches chat mode on the live session, the same switch the
`/chat [chat|erp|raw|off] [--include <categories>]` builtin performs (bare
`/chat` toggles between `off` and the last-used mode). The system prompt is
rebuilt immediately, so the next turn uses it; the prompt-cache break is
intended. `include` names the context categories kept in chat mode (`date`,
`cwd`, `contextFiles`, `skills`, `rules`, `memory`), comma-separated or as an
array; omitted keeps the current or last-used set, falling back to the
`chat.include` setting. `include` with `mode: "off"` is rejected.

```json
{ "id": "chat1", "type": "set_chat_mode", "mode": "erp", "include": "date,cwd" }
```

```json
{
  "id": "chat1",
  "type": "response",
  "command": "set_chat_mode",
  "success": true,
  "data": { "mode": "erp", "include": "date,cwd" }
}
```

`data.include` is always the comma-joined include list (`""` when none). When
the state changes, a `chat_mode_changed` event with the same `{ mode, include }`
fields follows; setting the current state again responds without an event.

- Entering chat mode deactivates every tool, as a `--chat` launch without
  `--tools` does; leaving restores the tool selection saved on entry, or, for a
  session launched or resumed in chat mode, the selection a coding launch with
  the same flags would have. A failed switch changes nothing. Chat mode
  also drops discovered `SYSTEM.md` / `APPEND_SYSTEM.md`, memory instructions,
  the date/cwd reminder, and non-chat extension prompt injection, exactly as
  `--chat` does. Only explicit `--system-prompt` / `--append-system-prompt`
  text carries into chat mode.
- Chat mode cannot start while plan mode is on: `set_chat_mode` (and `/chat`)
  fails with `Exit plan mode first.` and no `code`, like the other chat-mode
  refusals. Leave plan mode with `set_mode { mode: "default" }` first. See
  [Plan Mode Sub-Protocol](#plan-mode-sub-protocol).
- The change is journaled on the session, so `--resume` / `--session` restores
  the last mode. `--chat` flags still set the initial mode at launch.
- Failures: `session_busy` while a turn is streaming; a session launched with
  `--system-prompt-template` rejects every chat mode (same rule as the launch
  flag); unknown modes or include categories fail with a message.
- A session launched in chat mode never loaded what chat mode skips at launch
  (MCP, LSP, memory, discovered skills, rules, and `SYSTEM.md`). Switching it
  `off` restores the coding tools and system prompt but not those resources;
  relaunch without `--chat` for a full coding session.

`mode` is `"plan"` while plan mode is active, whichever path entered it, and `"default"` otherwise. `planMode` is present only in plan mode: `planFilePath` is the plan file the agent drafts, and `workflow` is `"parallel"` or `"iterative"`. See [Plan Mode Sub-Protocol](#plan-mode-sub-protocol).

Fields whose values are `undefined` are omitted from JSON, including an unset
model/thinking level, session name/file, or unavailable `contextUsage`.
`dumpTools` may also include each tool's `examples` alongside its schema.
It lists only the agent's **top-level tool definitions**, not the full mounted
inventory. With the default `tools.xdev: true`, enabled discoverable tools,
including MCP tools, can be mounted as `xd://` devices instead. An MCP tool's
absence from `dumpTools` does **not** mean its server failed to connect. This
applies to both `--mode rpc` and `--mode rpc-ui`.

The agent discovers and invokes mounted tools through the ordinary `read` and
`write` tools:

- `read({"path":"xd://"})` lists mounted devices.
- `read({"path":"xd://mcp__stub_announce"})` returns a device's documentation and input schema.
- `write({"path":"xd://mcp__stub_announce","content":"{}"})` invokes that device with a JSON arguments object. Replace `{}` with the tool's required arguments.

These are **agent tool calls**, not additional RPC command types. Use the actual
device name from the listing; MCP runtime names are sanitized and may differ
from the server's original tool name. For invocation verification, inspect the
current turn's `tool_execution_start` / `tool_execution_end` events and result,
not just assistant text or an earlier transcript entry.

MCP configuration follows the normal [MCP configuration rules](./mcp-config.md):
`disabledServers` and `enabledServers` are active-profile **user** lists, and the
denylist wins over the allowlist. Project config can disable a server with its
per-server `enabled: false`; a project `disabledServers` list is not a substitute
for the user denylist. After editing MCP config files externally, restart the
RPC process to apply and verify the new configuration.
`queuedMessages` holds the same displayable queue-chip text as the `queue_update`
event below. Use this text with `remove_queued_message`, subject to its pending-queue
boundary: live-steered input stays visible until recorded but is no longer removable.
Clients should render the queue from these snapshots instead of tracking chips
independently, and treat removal responses as confirmation rather than a second
source of truth. `queuedMessageCount` also includes advisor cards and pending
next-turn messages, so it is not necessarily the number of user-authored chips.

### `goal` payload
`goal` manages goal mode with the same lifecycle as the interactive `/goal` command.
Every op answers `{ goal: Goal | null, state: GoalModeState | null }`; `get_state`
carries the same state as `goal`. `goal_updated` events report every change,
including those made by the agent's `goal` tool.
- `get` only reads. It never starts a turn.
- `create` needs `goal.enabled`, a non-empty `objective`, and no active or paused
  goal. It is refused in plan mode, and `token_budget` must be a positive integer.
  It adds the `goal` tool to the active tools.
- `resume` resumes a paused goal (refused in plan mode). `pause` and `drop` restore
  the active tools from before the goal started.
- Failures are ordinary `success: false` responses.
Goals do not continue on their own over RPC unless `goal.continuationModes`
contains `"rpc"`; this covers both `--mode rpc` and `--mode rpc-ui`. When enabled,
`create`/`resume` and each terminal `agent_end` decide whether to start another goal
turn, sent as a hidden `goal-continuation` message.
- The turn starts once the yielding run has fully unwound. At that moment the goal
  must still be active, the session idle with nothing queued, plan mode off, open
  todos not all blocked, and the session not being disposed.
- While the turn is decided but not yet started, `get_state.isSettled`,
  `prompt_result.sessionSettled` and `session_settled` treat the session as busy.
  `session_settled` follows if the continuation is abandoned.
- `abort` stops continuation before the abort takes effect and pauses the
  interrupted goal, so a later prompt does not restart it; only `goal resume` does
  (or `drop` and a new `create`).
- Continuation also stops after a goal turn with no new tool activity. The next
  turn that is not itself a goal continuation (a host prompt, steer or follow-up,
  for example) re-arms it.
- A session change leaves the previous goal and its tool behind and restores a goal
  journaled in the target session. This covers `new_session`, `switch_session`,
  `branch`, `fork` and `open_session`, and the same changes made by extension commands. As
  in the TUI, an active goal stays active across such a change and continues; a goal
  restored when the process starts is paused until `goal resume`. A change is
  detected by the transcript id, so a host-pinned `--provider-session-id` does not
  hide it. A goal turn that is waiting or becomes due while a change is in progress
  is held. If the change is cancelled, or leaves the session unchanged (tree
  navigation, reopening the open session), the goal continues. While such a turn is
  held, the session is not reported as settled.
When the agent completes the goal, the goal tool is removed again and
`get_state.goal` becomes `null`.
### `set_slow_mode` payload
`set_slow_mode` turns `/slow` on or off for the active model, exactly like the
slash command: on OpenAI/Google models it sets or clears this session's `flex`
tier for that family; on direct Anthropic models it writes the persisted global
`providers.anthropic.slowMode` setting (`auto`/`off`), entering an offered
low-priority window on enable and stopping an active one on disable.
```json
{ "id": "req_slow_on", "type": "set_slow_mode", "enabled": true }
```
On success, `data.enabled` reports whether `/slow` is now on for the active
model:
{
	"id": "req_slow_on",
	"type": "response",
	"command": "set_slow_mode",
	"success": true,
	"data": { "enabled": true }
}
Enabling on a model without a slow mode fails with
`"Slow mode is unavailable for the current model."`. Disabling on such a model
succeeds with `{ "enabled": false }` and changes nothing, so it never clears
another provider's persisted setting. A non-boolean `enabled` is rejected with
`"set_slow_mode requires boolean enabled"`. A change made mid-run applies from
the next request (stopping an active Claude low-priority window takes effect
immediately); no event announces it, so re-read `get_state`.
### `set_fast_mode` payload

`set_fast_mode` changes whether fast mode is enabled for the session. The
request is:

```json
{ "id": "req_fast_on", "type": "set_fast_mode", "enabled": true }
```

On success, `data` always contains both `enabled` and `active`. These are the
actual computed values: `enabled` reports the session setting, and `active`
reports the resulting active state, including any provider-level Fireworks
priority setting:

For direct Anthropic, an explicit enable also re-arms a provider attempt after
the sticky rejection fallback, even when fast mode was already enabled.

```json
{
	"id": "req_fast_on",
	"type": "response",
	"command": "set_fast_mode",
	"success": true,
	"data": { "enabled": true, "active": true }
}
```

Enabling fast mode on a model without a service-tier family, or an OpenAI-family
model that does not offer the priority tier, fails with the error below:

```json
{
	"id": "req_fast_on",
	"type": "response",
	"command": "set_fast_mode",
	"success": false,
	"error": "Fast mode is unavailable for the current model."
}
```

Disabling fast mode is idempotent, including on an unsupported model. It
succeeds as an off/no-op result, but disabling `/fast` does not override
provider-level settings, so a successful disable does not guarantee
`active: false`. For example, with an unsupported
`fireworks/deepseek-v4-flash` model and `providers.fireworksTier: priority`,
the response reports the session setting as disabled while the provider
priority keeps the computed active state true:

```json
{
	"id": "req_fast_off",
	"type": "response",
	"command": "set_fast_mode",
	"success": true,
	"data": { "enabled": false, "active": true }
}
```

The corresponding `get_state` result reports the same computed state:

```json
{
	"fastModeEnabled": false,
	"fastModeActive": true
}
```

### `set_ask_dialog` payload

`set_ask_dialog` opts the host in to the `ask` extension UI request (see
[Extension UI Sub-Protocol](#extension-ui-sub-protocol)). It is off by default
for every process; until a host enables it, the `ask` tool keeps prompting with
one `select` (plus `editor` for free text) per choice. Builds without the
command answer with a failed `response`, so hosts should keep the `select`
fallback when enabling fails.

```json
{ "id": "req_ask", "type": "set_ask_dialog", "enabled": true }
```

```json
{
	"id": "req_ask",
	"type": "response",
	"command": "set_ask_dialog",
	"success": true,
	"data": { "enabled": true }
}
```

### `set_todos` payload

Replaces the todo state for the current session and returns `{ todoPhases }`. The list is recorded on the current session branch and restored when that branch is reloaded, compacted, or resumed, like an interactive `/todo` edit.
Phases use `{ name, tasks }`; tasks retain `{ content, status, blocker? }`. There
are no phase or task IDs. Status is `"pending"`, `"in_progress"`, `"completed"`,
`"abandoned"`, or `"blocked"`. Snapshot cloning drops extra fields, including
task `details` and `notes`.

```json
{
	"id": "req_2",
	"type": "set_todos",
	"phases": [
		{
			"name": "Evaluation",
			"tasks": [
				{
					"content": "Map the read tool surface",
					"status": "in_progress"
				},
				{
					"content": "Exercise edit operations",
					"status": "pending"
				}
			]
		}
	]
}
```

This is useful for hosts that want to pre-seed a plan before the first prompt.

### `set_host_tools` payload

Replaces the current set of host-owned tools that the RPC server may call back
into over stdio:

```json
{
	"id": "req_3",
	"type": "set_host_tools",
	"tools": [
		{
			"name": "echo_host",
			"label": "Echo Host",
			"description": "Echo a value from the embedding host",
			"parameters": {
				"type": "object",
				"properties": {
					"message": { "type": "string" }
				},
				"required": ["message"],
				"additionalProperties": false
			}
		}
	]
}
```

The response payload is:

```json
{
	"toolNames": ["echo_host"]
}
```

These tools are registered before the next model call. New non-hidden tools
are enabled automatically; new hidden tools are registered without being enabled.
Re-sending `set_host_tools` replaces only the registering connection's previous
set, preserving the enabled state of its surviving tools. The session exposes
the union of the stdio owner's and all control connections' tools. Names must
be unique within a registration and cannot conflict with a non-host tool or a
tool owned by another connection. A collision rejects the entire replacement:
the first successful registrant retains the name, and neither owner's tools,
enabled state, nor pending calls change.

Sending an empty set, control `unserve`, or disconnect removes only that
connection's tools. A successful replacement cancels pending calls to removed
tools and revokes its previous adapters; calls to surviving names can finish.
A rejected replacement changes neither registrations nor pending calls.
Control session-generation changes also revoke control registrations:
clients must register again for the new canonical generation. Requests, updates,
results, and cancellation stay on the registering connection; another connection
cannot complete its calls, and replies after revocation are ignored.

Definitions also accept `hidden?: boolean`,
`loadMode?: "essential" | "discoverable"`, and `readsSkillUris?: boolean`.
Set `readsSkillUris: true` when the tool can read `skill://` instruction content;
prompt builders use this capability to decide whether to include skill guidance.
An explicit load mode wins. When omitted, known essential built-in names remain
`"essential"`; other host tools default to `"discoverable"`. `toolNames` in the
response lists the registered names.

### `set_host_uri_schemes` payload

Replaces the current set of host-owned URL schemes the RPC server should
dispatch reads/writes through:

```json
{
	"id": "req_4",
	"type": "set_host_uri_schemes",
	"schemes": [
		{
			"scheme": "db",
			"description": "Virtual db row files",
			"writable": true,
			"immutable": false
		}
	]
}
```

The response payload is:

```json
{
	"schemes": ["db"]
}
```

Scheme names are trimmed and lowercased and must match `[a-z][a-z0-9+.-]*`.
`writable` and `immutable` default to `false`. Re-sending `set_host_uri_schemes`
replaces the entire previous set — schemes missing from the new list are
unregistered; an empty list clears all host schemes.

Every built-in scheme (`local://`, `skill://`, `artifact://`, `security://`,
`mcp://`, …) is reserved: RPC hosts cannot register or shadow one, and the
request fails with `Host URI scheme is reserved by OMP: <scheme>://`.

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Common event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_stream_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`, `manual_compaction_start`, `manual_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `cache_warming_start`, `cache_warming_end`
- `retry_fallback_applied`, `retry_fallback_succeeded`
- `model_changed`, `thinking_level_changed`, `config_warnings_changed`
- `advisor_cost_changed`, `advisor_yielded`
- `ttsr_triggered` (rule injection)
- `todo_reminder`, `todo_auto_clear`
- `irc_message`, `notice`, `goal_updated`
- `chat_mode_changed` (`{ type, mode: "off" | "chat" | "erp" | "raw", include: string }`, see `set_chat_mode`)
- `queue_update`

### `queue_update` event

```json
{ "type": "queue_update", "steering": ["Use the existing parser"], "followUp": [] }
```

Emitted whenever the displayable steering/follow-up queue changes: a `steer`,
`follow_up`, or queued `prompt` adds to it; delivery into the transcript,
`remove_queued_message`, an abort that drops in-flight queued messages,
or a session switch removes from or clears it. The server coalesces this
against the last value sent — a mutation that leaves the snapshot unchanged
(for example, an agent-authored aside that never renders as a chip) never
re-emits. `steering`/`followUp` mirror `get_state`'s `queuedMessages` field and
carry the queue-chip text accepted by `remove_queued_message` while the message
is still pending. Live-steered messages stay listed until recorded in the
transcript, even after they cease to be removable. Render the queue from this
event rather than tracking chips independently, and treat removal replies as
confirmation of a change rather than independent queue state.

Extension runner errors are emitted separately as:

```json
{
	"type": "extension_error",
	"extensionPath": "...",
	"event": "...",
	"error": "..."
}
```

`message_update` includes streaming deltas in `assistantMessageEvent` (text/thinking/toolcall deltas).

`message_start`, `message_update`, and `message_end` carry an opaque live `messageId` string. One message keeps its ID across the native owner's stdio and control observers, including a new attachment's in-flight snapshot. Native IDs are unique across owner incarnations, even when a new owner opens the same session ID/file; they are not journal entry IDs, and clients must not parse their format. Records injected mid-stream, such as advisor cards and IRC messages, get their own IDs and do not disturb the reply streaming around them.

`set_event_filter` restricts which session event frames are written: pass the event `type` strings to forward, or `null` to forward everything (the default). The response echoes the active selection as `{ events, messageUpdates }`. The filter applies to all events emitted through the session subscription, not just the common types listed above; every other outbound category (responses, `prompt_result`, `session_settled`, extension UI and host tool/URI requests, plan mode frames, `extension_error`, `available_commands_update`, subagent frames, side-question frames, builtin slash-command side channels, and session-persistence and `btw-history` `notice` frames) is unaffected by this filter. Hosts that fail closed on unknown event kinds can pin the set they understand here instead of breaking when NeoPi adds an event.

The optional `messageUpdates: "delta"` projects only `message_update` frames to `{ type: "message_update", messageId, message: { role }, assistantMessageEvent }`: `assistantMessageEvent.partial` is omitted, while all other event fields (including subtype, `delta`, and `contentIndex`) are preserved, and enough is added to rebuild the message client-side. `text_start`, `thinking_start`, and `toolcall_start` carry `block`: the shell of the content block at `contentIndex`, with its streamed content emptied (`text` and `thinking` are `""`, a tool call's `arguments` are `{}`; its `id`, `name`, and other metadata are kept), so the deltas that follow always apply from empty. The server snapshots a block when it handles the event, not when the model emitted it, so a start's snapshot can already hold text that a later delta delivers; hence the emptying. `text_end` and `thinking_end` keep `content` and add `block`: the same block without its text, so its signature and other metadata (`textSignature`, `thinkingSignature`, ...) are available; rebuild the block as `{ ...block, text: content }` or `{ ...block, thinking: content }`. `image_end` carries the whole image as `content` and `toolcall_end` the whole tool call as `toolCall`; each is the block at `contentIndex`. A `start` (a restart of the streaming message within a turn) carries `message`: the whole message to restart from; that snapshot can likewise be ahead of the deltas that follow, so treat each block's `*_end` as authoritative for its final content. `text_delta` and `thinking_delta` carry the text to append to the block at `contentIndex`; `toolcall_delta` carries a fragment of the tool call's arguments JSON, and the arguments are complete only in `toolcall_end`'s `toolCall`. Rebuilding covers the message's `content`: `usage`, `responseId`, `stopReason`, and the other message fields arrive only in `message_end`. `message_start`, `message_end`, and all other frames are unchanged; `message_end` still carries the full message and is authoritative: it can differ from the rebuilt content, for example when inline-edit recovery lifts edit payload text out of a text block and synthesizes an `edit` tool call just before it. Block kinds with no start event also arrive only in full there. Hosts must still accept chunked protocol-v2 frames for large blocks and full messages. Switching modes mid-message does not change its `messageId`. The projection applies to the session's own frames only: `subagent_event` payloads forwarded under `set_subagent_subscription` level `"events"` keep their full `message_update` snapshots.

Each command replaces the whole filter state: omitting `messageUpdates` resets it to `"full"`, the default, which retains the original full snapshots. An invalid `events` shape (anything other than `null` or an array of non-empty strings), or a mode other than `"full"` or `"delta"`, returns an error without changing either setting. Event names are not checked against a fixed catalog; unknown non-empty names are accepted. Projection works in protocol v1 and v2, including with `events: null`. Detect support from the echoed `data.messageUpdates` field: older servers ignore the option and do not echo it. This opt-in is raw-protocol only; the TypeScript `RpcClient` and Python client keep their full-message listener contracts.

`agent_end` has this session-level shape (in addition to optional telemetry fields):

```ts
{
  type: "agent_end";
  messages: AgentMessage[];
  isTerminal?: boolean;
  yielded?: boolean;
  awaitingAsyncWork?: boolean;
}
```

`yielded` is `true` when the agent finished its turn: the end is terminal, or the session resumes only for queued input or background-job results. It is `false` while the agent continues its own work (retry, compaction continuation, stop-time reminders). Frames from older runtimes omit it; treat those as yielded only when terminal.

`isTerminal: false` means a continuation or possible async delivery remains.
`awaitingAsyncWork: true` identifies a non-terminal end whose only possible
resume is a background-job result; cancelled or suppressed delivery may mean
no follow-up run occurs. The optional fields keep older frames terminal-compatible
when `isTerminal` is absent. Use `yielded` for a prompt's yield and
`session_settled` for quiescence, rather than assuming every non-terminal end
guarantees another turn.

### Progress events

These events report work the host should show as a thread notice. RPC mode
always forwards them, subject only to `set_event_filter`.
Servers that predate `manual_compaction_start` and `manual_compaction_end`
report a manual compaction only through the `compact` response.

| Event                                          | When                                                                                                                               | Payload                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual_compaction_start`                      | A manual compaction began: the `compact` command, `/compact`, or an extension's `ctx.compact()`. The live turn is already aborted. | `mode?`: the `/compact <mode>` subcommand                                                                                                      |
| `manual_compaction_end`                        | That compaction ended.                                                                                                             | `aborted`, and one of: `result` (committed), `skipped: true` with `errorMessage` (nothing to compact), or `errorMessage` (failed or cancelled) |
| `auto_compaction_start`, `auto_compaction_end` | An automatic compaction (threshold, overflow, idle, incomplete response) began or ended. Never sent for a manual compaction.       | `reason`, `action`; `result?`, `aborted`, `willRetry`, `errorMessage?`, `skipped?`                                                             |
| `retry_fallback_applied`                       | A retryable failure switched the session to the next model of a `retry.fallbackChains` chain.                                      | `from`, `to` (model selectors), `role`, `reason?` (the error)                                                                                  |
| `retry_fallback_succeeded`                     | The fallback model answered.                                                                                                       | `model`, `role`                                                                                                                                |
| `ttsr_triggered`                               | Rule injection: a TTSR rule matched the streamed output and its text was injected into the conversation.                           | `rules`: each rule object carries at least `name`, `path`, and `content`                                                                       |
| `goal_updated`                                 | Goal mode changed, through the `goal` command or the agent's `goal` tool.                                                          | `goal` (or `null`), `state?`                                                                                                                   |

Every manual compaction sends exactly one start/end pair. When a configured
method fails and the next one is tried, the fallback stays inside the same pair.
A `compact` call refused before it starts (another compaction is running, or
`/compact <mode>` was given focus text it does not take) sends no pair.

```json
{ "type": "manual_compaction_start" }
{ "type": "manual_compaction_end", "aborted": false, "result": { "summary": "…", "firstKeptEntryId": "…", "tokensBefore": 48210, "details": {} } }
{ "type": "manual_compaction_end", "aborted": false, "skipped": true, "errorMessage": "Already compacted" }
{ "type": "retry_fallback_applied", "from": "anthropic/claude-sonnet-4-5:high", "to": "openai/gpt-4o-mini", "role": "default", "reason": "Request failed: overloaded_error: provider returned error 503" }
{ "type": "ttsr_triggered", "rules": [{ "name": "no-forbidden", "path": "/repo/.omp/rules/no-forbidden.md", "content": "Never write the forbidden word." }] }
```

### Cache warming events

Each refresh handed to the provider stream emits one start and one matching end
(a session disposed mid-refresh emits no end).
Warm-or-stop decisions that do not send a request emit neither. These are
session events, so **both types must be listed in `set_event_filter` when a filter
is active** to observe complete refresh lifecycles:

```ts
{
  type: "cache_warming_start";
  phase: "streaming" | "idle";
  provider: string;
  model: string; // model id
}
{
  type: "cache_warming_end";
  phase: "streaming" | "idle"; // same phase as the matching start
  provider: string;
  model: string;
  outcome: "hit" | "miss" | "error" | "aborted";
  usage?: Usage;
  warmingStopReason?: string;
}
```

- `hit`: the refresh read cached tokens without writing a new cache entry.
- `miss`: it read no cached tokens or wrote cache tokens; warming stops.
- `error`: no response was available or the response reported an error; warming stops.
- `aborted`: the run was cancelled or replaced while the refresh was in flight.

`usage` is present only when the refresh was recorded as a `model_usage` entry
(`purpose: "cache-warm"`, or `"cache-warm:extension-override"` when an extension
forced it). This includes paid misses, errors, and `aborted` refreshes the
provider had already accepted (usage reported before the cancellation); an
abort before the provider responded has no usage. Summing `usage.cost.total`
attributes the warming costs already included in `get_session_stats`, rather
than adding another charge.

These events are ordinary session events, so `--mode json` output includes them
as well.

`warmingStopReason` explains why warming stopped because of or during the
refresh, for example `"refresh missed the cache"`, `"refresh failed"`,
`"cache warming disabled"`, or `"conversation context changed"`. It is absent
when warming continues: the refresh rescheduled, or a new request replaced the
run.

### Available commands

`get_available_commands` returns `{ commands }`, and the same array is pushed
in `available_commands_update` frames at startup and after command metadata
changes. Each command has `name`, `source`, and optional `aliases`,
`description`, `input.hint`, and `subcommands`.

Command discovery is intentionally an OMP dialect: Pi's `get_commands` (a
`RpcSlashCommand[]` projection over extensions → prompt templates → skills) is
not served because OMP's richer catalog (builtins/custom/MCP/file commands,
broader `source` enum, no Pi `sourceInfo`) is not wire-compatible with it.

### Native tree navigation

Gate these commands on `session_tree_navigation`. `navigate_tree` runs the same
native operation as `/tree`, preserving the session file and alternate branches.
It does not call `branch`, which creates another file.

Every request must supply the native `expectedSessionId`, `expectedSessionFile`
and `expectedLeafId` it observed. Use `null` for an unsaved session file or a
root leaf. NeoPi compares the normalized file path as well as the ID, since a
copied journal can retain its original IDs. It checks these values under native
mutation admission and again after asynchronous preparation. A busy session or
transition returns `code: "session_busy"` without interrupting another turn.
A changed session or leaf returns `session_changed` or `leaf_changed`.

Success returns:

```ts
{
  sessionId: string;
  sessionFile?: string;
  leafId: string | null;
  outcome: "navigated" | "unchanged" | "cancelled" | "ask_reopen";
  cancelled: boolean;
  aborted?: boolean;
  editorText?: string;
  editorImages?: ImageContent[];
  summaryEntry?: BranchSummaryEntry;
  reopenAsk?: { toolCallId: string; questions: AskQuestion[] };
  askReanswerCommitted?: boolean;
  resumeToken?: string;
}
```

Selecting a user request moves to its parent and returns the native draft and
its ordered images. Selecting another entry normally lands on it. An already
selected non-user leaf reports `unchanged`. Native extension cancellation
reports `cancelled`. `summarize` and `customInstructions` use NeoPi's summarizer,
and a cancelled summary returns `cancelled: true, aborted: true` without moving
the leaf. The ordinary `abort` command can cancel pending remote navigation,
including its summary. Navigation starts in input order but settles in the
background so cancellation remains reachable. No internal `sessionContext` is
sent on the wire.

For native ask re-answering, send `allowAskReopen: true`. A probe returns
`outcome: "ask_reopen"` with `reopenAsk`, without moving the leaf or claiming
navigation happened. Display those questions and submit the fresh answer in
another `navigate_tree` request to the same target with current preconditions.
`reanswerAskResult` contains native `content` text/image blocks, optional
`details: AskToolDetails` and optional `isError`. The original answer remains
on its branch; NeoPi appends a sibling answer.

A committed re-answer returns `askReanswerCommitted: true` and an opaque
`resumeToken`, but does not start the agent. First consume this result and
rebuild the transcript. Then send `resume_tree` with that token and the
returned session identity and leaf. It calls native `resumeAfterAskReanswer`
and returns `{ resumed: true }`. Tokens are in-memory, single-use and bound to
the committed native session file, ID, leaf and prompt generation. A replacement
or intervening navigation invalidates them. Invalid or consumed tokens return
`invalid_resume`; stale identity and leaf preconditions retain their named
errors. Invalid targets return `invalid_target`, and malformed request fields
return `invalid_request`.

The TypeScript SDK exposes `navigateTree(options)` and `resumeTree(options)`.
Generated Python, Rust and Go clients carry the same contracts. Control clients
send the same RPC commands to the existing terminal owner through `npi ctl pipe`;
no second writer or session file is created.

### Native journal pages

`get_entries_page` returns `{ entries, sessionId, sessionFile, leafId, totalEntries, nextCursor? }`.
`sessionFile` is the canonical absolute path. `entries` contains native `SessionEntry`
records, including tool output, custom records, compaction, branch summaries and reset
boundaries. Nothing is folded into model context or reduced to visible message text.
The header is not an entry. `totalEntries` counts entries in the selected scope.

The defaults are `scope: "journal"`, `direction: "forward"` and `limit: 100`.
Limits range from 1 to 256. `branch` selects the current native leaf's ancestry.
`journal` includes alternate branches in append order. A backward page starts at the
newest end, but entries within every page remain chronological. Pass `nextCursor`
with the same scope and direction to continue, and stop when it is absent.

A journal cursor pins the initial prefix and snapshot leaf. Appends and pointer-only
leaf changes do not extend or invalidate that walk. A branch cursor pins the active
leaf and fails with `code: "leaf_changed"` if it changes, including after an append.
Restart branch paging instead of combining pages from different leaves.
Session/file changes and a missing or replaced prefix boundary fail with
`stale_cursor`. Invalid cursors or changed scope/direction fail with `invalid_cursor`;
invalid limits/options fail with `invalid_request`.
An owner applying or rolling back a session/transcript transition returns
`session_busy` rather than mixing identities. Ordinary streaming does not block
journal reads.

Pages use the same 768 KiB soft budget as message paging. Entries are never split
or truncated. An oversized entry travels alone with negotiated protocol v2 chunking,
or returns the existing transport-limit failure when it cannot fit. Legacy history
without persisted IDs fails with `legacy_history_identity_required`, including a
running owner whose pre-tree migration has not yet persisted. Reading does not
trigger migration or persistence. An owner without a journal file returns
`session_unavailable`.

For a stopped session, `npi sessions entries --json --scope branch --direction backward
--limit 100 /absolute/session.jsonl` uses the same page format and cursor options.
Its leaf is the last persisted entry, not an unpersisted pointer-only move in a
running owner. Live owners must be read over RPC/control. CLI failures emit
`{ "error": { "code": "...", "message": "..." } }` on stdout even with a nonzero exit.
Unreadable or malformed journals return `session_unavailable`, not partial history.
Existing `get_entries`, `get_tree`, `get_messages` and `get_messages_page` keep their
previous semantics.
### Pi-compatible history/tree commands with OMP-native entry payloads

The commands and reconciliation semantics below are Pi-compatible, but the
returned `SessionEntry` payload union is OMP-native, not wire-identical to
Pi. Concretely: Pi `model_change` carries `provider` + `modelId` while OMP
carries a combined `model` plus role/fallback metadata; Pi uses a `usage`
entry where OMP uses `model_usage`; and OMP has additional entry types (for
example service-tier, title, mode, credential, and reset records). A
permissive client that consumes the common structural subset
(`id`/`parentId` plus message entries) can share one durable-history
algorithm across both, while a strict Pi `SessionEntry` decoder cannot assume
identical payloads.

`get_entries` reads the canonical append-history (not the active branch only)
and returns `{ entries, leafId }`. Without `since` it returns all entries in
append order; with `since` it returns entries strictly after the matching
durable entry id. An unknown `since` fails explicitly with
`code: "unknown_since"`. `get_tree` returns the raw session tree as
`{ tree, leafId }` straight from `SessionManager`, not a UI projection.

`get_available_thinking_levels` returns `{ levels }`: the selectable levels
for the live model with `"off"` first (it is accepted by
`set_thinking_level` but excluded from the effort-only model helper). OMP-only
`auto`/`inherit` selectors are intentionally omitted from discovery.

Lifecycle stays OMP: `agent_end` carries `isTerminal`, `yielded`, and optional
`awaitingAsyncWork`; `prompt_result` correlates prompt completion and
`session_settled` reports quiescence. There is no Pi `agent_settled` frame.
These, `agentInvoked`, `open_session`, `set_event_filter`, `messageId`, `ready`,
negotiation, chunking, host tools, and subagents are OMP extensions a
Pi-family adapter must dialect around.

### Subagent subscriptions

Subagent forwarding defaults to `"off"`. `set_subagent_subscription` selects:

- `"off"`: no forwarded subagent frames
- `"progress"`: lifecycle and progress frames
- `"events"`: lifecycle, progress, and full subagent event frames

`get_subagents` returns the registry snapshot sorted by subagent index and id.
`get_subagent_messages` selects a transcript by `subagentId` or a registered
`sessionFile` (`subagentId` takes precedence); arbitrary file paths are rejected.
`fromByte` supports incremental reads, defaults to zero, and is clamped to a
non-negative integer. Non-finite values fail. The result contains `sessionFile`,
`fromByte`, `nextByte`, `reset`, raw transcript `entries`, and `messages` from
message entries. Only complete newline-terminated records are consumed; reuse
`nextByte` on the next request. A missing transcript returns empty arrays.
If `fromByte` exceeds the current file size, reading restarts at byte zero and
reports `reset: true`.

### Cancelling subagents

`cancel_subagent` hard-kills one subagent currently listed by `get_subagents`
(foreground or background, at any nesting depth) without aborting the parent
turn. It uses the same path as the Agent Hub kill: the subagent's live turn is
aborted and its registry entry becomes an `aborted` tombstone, so the owning
`task` call settles with an aborted result. The kill stops the subagent without
discarding it: a later `write agent://<id>` message or Agent Hub revive brings it
back from its transcript.
When `set_subagent_subscription` is `"progress"` or `"events"`, a
`subagent_lifecycle` frame with `status: "aborted"` follows.

```json
{ "id": "req_1", "type": "cancel_subagent", "subagentId": "OmpWorker" }
{ "id": "req_1", "type": "response", "command": "cancel_subagent", "success": true, "data": { "cancelled": true } }
```

`cancelled` is `false` when the id is not a running subagent of this session:
unknown, another session's same-name agent, finished (including a subagent
whose result the parent already accepted, even before its terminal lifecycle
frame), or already cancelled, so hosts can treat it as idempotent. If the
`aborted` tombstone cannot be persisted, the subagent is still aborted and
disposed, and the command returns an error response with the write failure.

### Steering subagents

`steer_subagent` sends a message to a running subagent as its user, the same
way Agent Hub chat does: a mid-turn subagent is steered at its next step
boundary, and one between turns starts its next turn. The message is recorded
in the subagent's own transcript; it is not attributed to the parent agent,
and the parent sees only the subagent's eventual result. Isolated (worktree)
subagents run in-process and are steered the same way.

```json
{ "id": "req_1", "type": "steer_subagent", "subagentId": "OmpWorker", "message": "Drop the glob, keep the direct path." }
{ "id": "req_1", "type": "response", "command": "steer_subagent", "success": true }
```

The response arrives once the message is accepted: queued into the running
turn, or the subagent's new turn started. It does not wait for the turn to
finish. Like `prompt`, the command starts in queue order but waits for
acceptance in the background, so later commands (including `abort`) are not
held behind it. As in Agent Hub chat (not RPC `steer`), the message goes
through the subagent's `prompt()`: extension, custom and file slash commands
run and prompt templates expand.

Failure responses:

- missing/empty `subagentId` or blank `message` → validation error
- `subagentId` not currently listed as running by `get_subagents` (unknown,
  finished, already cancelled, another session's agent, or one whose result
  the parent already accepted) → `error: "Subagent not running: <id>"`
- the subagent drops or rejects the message before accepting it (for example
  an abort or a usage-limit preflight denial lands first) →
  `error: "Subagent refused the message: <reason>"`

### Changing a running subagent's thinking level

`set_subagent_thinking_level` selects the level on that subagent's own session,
without interrupting its current turn or provider request. Its next provider
request uses the new level, including the next step of the current turn.

```json
{ "id": "req_2", "type": "set_subagent_thinking_level", "subagentId": "OmpWorker", "level": "high" }
{ "id": "req_2", "type": "response", "command": "set_subagent_thinking_level", "success": true }
```

The command accepts `off` and the subagent model's supported effort levels,
within its existing session effort ceiling. Unsupported levels fail with the
available choices rather than silently clamping to another level. The same
ownership and running-state restrictions as `steer_subagent` apply; an unknown or finished id returns
`Subagent not running: <id>`.

The change appends a `thinking_level_change` entry to the subagent's session
file. Restart recovery and cold revival resume at that selection. It does not
change the parent session's level or the global default.

### Changing a running subagent's fast mode

`set_subagent_fast` changes only the selected running subagent's service tier,
from its next provider request. It does not abort the current request, change
the parent or siblings, or update a global setting. The tier is recorded as a
`service_tier_change` entry and survives revival and restart.

```json
{ "id": "req_3", "type": "set_subagent_fast", "subagentId": "OmpWorker", "enabled": true }
{ "id": "req_3", "type": "response", "command": "set_subagent_fast", "success": true, "data": { "enabled": true, "active": true } }
```

`enabled` reports the selected fast preference. `active` reports whether the
current model/provider can actually honor it, including a provider fallback
that temporarily disabled fast requests. A provider without a supported fast
selection returns an error. Invalid ids follow the same rules as the thinking
command, and `enabled` must be a boolean.

`get_subagents` reads each owned live session's `resolvedModel`,
`resolvedModelIdentity`, `resolvedThinkingLevel`, `fastModeEnabled` and
`fastModeActive` when queried. These are current values, not launch snapshots.
Task/job listings and peer rosters also report current model and effort.

In the Agent Hub, focus a subagent's transcript to cycle its effort with the
existing Shift+Tab binding or run `/fast [on|ultra|off|status]`. These controls
target the focused session. Model switching and other mutation commands remain
unavailable in that view.

### Side questions (`/btw`)

`btw` asks the TUI's `/btw` side question: one ephemeral model turn over the
current session's context (including a turn still streaming), answered as
text with no tool use. The question and answer are never added to the
transcript; they are checkpointed in the session's BTW history sidecar, which
the TUI `/btw` history reads too. With `recordId`, the question is a follow-up
in that topic and its earlier turns are replayed as context.

```ts
type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";
interface BtwHistoryTurn {
	question: string;
	answer: string;
	status: BtwStatus;
	createdAt: number;
	updatedAt: number;
	error?: string;
}
interface BtwHistoryRecord extends BtwHistoryTurn {
	id: string;
	leafId: string | null;
	followUps?: BtwHistoryTurn[];
}
```

A record's latest turn is its last follow-up, else the record itself.
`interrupted` marks a turn whose process died while it ran.

```json
{ "id": "req_1", "type": "btw", "question": "why does this test need a lock?" }
{ "type": "btw_record", "record": { "id": "1596…", "question": "why does this test need a lock?", "answer": "", "status": "running", "leafId": "a1b2c3d4", … } }
{ "id": "req_1", "type": "response", "command": "btw", "success": true, "data": { "record": { … } } }
{ "type": "btw_delta", "recordId": "1596…", "delta": "Two workers " }
{ "type": "btw_record", "record": { "id": "1596…", "answer": "Two workers …", "status": "complete", … } }
```

The `btw_record` frame for the started turn and then the response arrive once
the question is checkpointed as running; the turn starts only after that, so
every `btw_delta` and later `btw_record` follows the response. A `btw_record`
frame carries the full record at every lifecycle change (started, complete,
cancelled, error); the last one for an id wins. Side questions run beside the
main agent: they neither wait for nor block a running prompt.

One side question runs at a time per session. `btw_cancel` bypasses the
command queue and cancels the running question, or a `btw` still starting
(which then fails), only if it is topic `recordId` when given. It answers
`cancelled: false` when nothing matching is running, including for a `btw`
still queued behind other commands. `new_session`, `switch_session`,
`branch`, `fork`, `open_session`, extension-initiated session changes and shutdown
cancel a running question and wait for its checkpoint first, even if the
change is then vetoed.

`get_btw_history` lists the current session's records newest first; a running
record carries its partial answer, so a host that reconnects can rebuild its
view. While nothing runs it re-reads the history from disk, so topics the TUI
added are listed and can take follow-ups; a topic another process is still
answering reads as `interrupted`. The list is not paged: a history larger than
the transport limit fails like any oversized response (protocol v2 chunks it).

Failure responses for `btw`:

- blank `question`
- another side question is still running or starting
- `recordId` is unknown
- no active model
- the history cannot be saved (including a topic another process still holds)
- cancelled by `btw_cancel` or a session change before it started

A checkpoint that fails after the response is reported as a
`{ type: "notice", level: "error", source: "btw-history", message }` frame.
The answer is kept in memory: the next `btw` and every session change retry
it first, and while it still cannot be saved they fail with
`/btw history could not be saved: …` and the session stays where it is. At
shutdown the process exits anyway and reports the loss as another such notice.
If the retry finds the topic deleted or rewritten on disk (for example by
another process), it can never succeed: the answer is reported lost as another
such notice and dropped, and the `btw` or session change proceeds.

## Prompt/Queue Concurrency and Ordering

Ordinary commands run on a serialized queue. Extension UI responses and host
tool/URI updates/results bypass that queue, so they can complete a request
while its command handler is waiting. `bash` also bypasses the serial queue and
is tracked as background command work; its response may arrive out of order.
`prompt` and `steer_subagent` start in queue order but await admission in the
background, so their responses may also arrive after later commands'.

### Immediate ack vs completion

Ordinary `prompt` requests are **acknowledged without waiting for the agent run**;
`abort_and_prompt` first waits for the abort. Builtin slash-command handlers and
skill-file loading can delay acknowledgement:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true, "data": { "userEntryId": "3f9a1c07" } }
```

That means:

- command acceptance != run completion
- a prompt completes via `data.agentInvoked: false` on its response or via its own `prompt_result`
- a run completes on an `agent_end` frame where `isTerminal !== false`; that frame carries no prompt identity, so correlate prompts through `prompt_result`
- native `input` handlers run once, in submission order, before command, skill, or queue dispatch. Later input waits until the earlier submission is admitted, including an idle skill's vision description, and does not wait for its model turn. An `abort` cancels input received before it that is not yet admitted, even if that input is still in a hook. A successful `new_session`, `switch_session`, `branch`, `fork` or `open_session` does the same for input received before it; a vetoed one cancels nothing, and input sent after the session change runs in the new session.
- the session is done only at `session_settled`: background jobs can wake the agent after it yields

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails.

Providers supporting live steering may consume queued steering during the
streaming response; otherwise it is delivered at a turn/tool-batch boundary.
`follow_up` waits until the agent would otherwise stop.

### Queue defaults

From `packages/coding-agent/src/modes/settings.ts` (also the core `Agent` defaults):

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

CLI settings can change these initial values. `set_steering_mode`,
`set_follow_up_mode`, and `set_interrupt_mode` affect the calling session only;
they do not write global `config.yml`. `set_auto_compaction` and
`set_auto_retry` likewise use session-scoped settings overrides.

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
   - `"one-at-a-time"`: dequeue one delivery group per queue drain, keeping hidden companions with their user message
   - `"all"`: dequeue the entire queue at once
- `set_interrupt_mode`
   - `"immediate"`: queued steering raises a cooperative signal for foreground tools, allowing auto-backgroundable work to step aside; it does not hard-kill or skip non-interruptible tools
   - `"wait"`: omit that cooperative steering signal and let side-effecting work finish before injecting steering at the tool-batch boundary
   - In both modes, interruptible waits are cancelled or skipped when steering arrives. This setting is not equivalent to `abort`.

## Extension UI Sub-Protocol

Extensions in RPC mode use request/response UI frames. `--no-ui` disables the extension runner's UI in both RPC modes: extensions see `ctx.hasUI === false`, dialogs resolve to their defaults without emitting frames, and presentation updates (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) are dropped.

`--mode rpc-ui` independently enables the tool UI context, including with `--no-ui`:

- `ask` still sends `select` requests. Free-text answers use `editor` with `promptStyle: true`; `ask` does not send `input` requests. Dialog cancellation can send `cancel`.
- Other callers using the tool UI context retain its supported dialog methods (`select`, `confirm`, `input`, `editor`, and cancellation) and presentation methods (`notify`, `setStatus`, string-array `setWidget`, `set_editor_text`, and opt-in `setTitle`). `--no-ui` is not a transport-level filter on these methods.
- Tool approval prompts use the extension runner, not the tool UI context. Under `--no-ui`, tools requiring approval fail closed with a no-interactive-UI error rather than sending an approval dialog, just as with `--mode rpc --no-ui`.
- MCP authentication challenges do not gain an RPC UI handler in either mode; the interactive-mode MCP auth handler is not installed.
- A host-issued `login` is independent of both UI settings: it can emit `open_url`, progress `notify`, and non-secret `input` requests after the authorization URL. Provider login prompts marked `secret: true` and prompts before an authorization URL remain unsupported.

Use `--mode rpc --no-ui` for a host without a tool UI surface; use `--mode rpc-ui --no-ui` to answer tool dialogs while keeping extensions headless. Plain `--mode rpc-ui` enables both extension and tool UI.

### Outbound request

`RpcExtensionUIRequest` (`type: "extension_ui_request"`) methods:

- `select`, `confirm`, `input`, `editor`, `ask`, `cancel`
   - `select` keeps labels in `options: string[]` and, when any option has a
     description, emits a positionally aligned
     `optionDetails: Array<{ description?: string }>` array. Hosts that do not
     render descriptions can continue using `options` alone.
   - `input` carries `title: string` and optional `placeholder?: string`,
     `timeout?: number`, and `secret?: boolean`. `secret` is an unnegotiated
     host hint from `ExtensionUIDialogOptions.secret`; hosts that support
     masked input should hide typed characters when `secret: true`.
   - `ask` is emitted only after `set_ask_dialog` enables it. It carries every
     question of one `ask` tool call:
     `questions: Array<{ id: string, question: string, header?: string, options: Array<{ label: string, description?: string, preview?: string }>, multi?: boolean, recommended?: number }>`
     plus `timeout?: number`. `options` never include an "Other" entry; hosts
     always offer free text.
- `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
- `open_url` (emitted by RPC login flows): includes `url`, optional `launchUrl`, and optional `instructions`. When present, `launchUrl` is a short loopback redirect and is the recommended copy target so terminal truncation cannot corrupt OAuth query parameters.

Runtime note:

- Automatic session title generation is disabled in RPC mode, and `setTitle` UI
  requests are also suppressed by default because most hosts do not have a
  meaningful terminal-title surface. Set `PI_RPC_EMIT_TITLE=1` to opt back in to
  the UI event only.

Example:

```json
{
	"type": "extension_ui_request",
	"id": "123",
	"method": "confirm",
	"title": "Confirm",
	"message": "Continue?",
	"timeout": 30000
}
```

### Inbound response

`RpcExtensionUIResponse` (`type: "extension_ui_response"`):

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, cancelled: true, timedOut?: boolean }`
- `{ type: "extension_ui_response", id: string, answers: Array<{ id: string, selectedOptions: string[], customInput?: string }> }` (answers an `ask` request)

`select` and `input` resolve to `undefined`, and `confirm` to `false`, on
cancellation, timeout, or signal abort. Signal abort emits a `cancel` request
with `targetId`. `editor` supports cancellation and signal abort but has no wire timeout.
Presentation methods and `open_url` are fire-and-forget and require no response.

If a dialog has a timeout, RPC mode resolves to a default value when timeout/abort fires, and emits
`{ method: "cancel", targetId }` so the host closes the dialog; a later answer to it is ignored. For `ask`, a timeout
(omp's timer or a host `cancelled: true, timedOut: true` reply) answers every question with its recommended
option, else its first.

`answers` must list one entry per question in request order, with each `id` equal to that question's `id`.
`selectedOptions` holds exact option labels without duplicates; a multi-select may be empty. A single-select
(`multi` absent or false) takes at most one option and not both an option and `customInput`. `customInput`
is trimmed and ignored when empty. Any other shape fails the `ask` tool call instead of guessing.

```json
{
	"type": "extension_ui_request",
	"id": "ui_9",
	"method": "ask",
	"questions": [
		{
			"id": "db",
			"question": "Which database?",
			"options": [{ "label": "Postgres" }, { "label": "SQLite" }],
			"recommended": 1
		},
		{
			"id": "features",
			"question": "Which features?",
			"options": [{ "label": "Auth" }, { "label": "Billing" }, { "label": "Search" }],
			"multi": true
		}
	]
}
```

```json
{
	"type": "extension_ui_response",
	"id": "ui_9",
	"answers": [
		{ "id": "db", "selectedOptions": [], "customInput": "DuckDB" },
		{ "id": "features", "selectedOptions": ["Auth", "Search"] }
	]
}
```

Terminal-only UI features are unsupported: component factories, custom
headers/footers/editors, raw terminal input, autocomplete composition, theme
switching, and tool expansion. `getEditorText()` returns `""`;
`pasteToEditor()` falls back to `set_editor_text`.

## Tool Approval Sub-Protocol

A tool call that needs approval (its policy resolves to `prompt`, or it carries provider safety checks) asks the host. By default (`handler: "ui"`) it asks through the [Extension UI Sub-Protocol](#extension-ui-sub-protocol): a `select` request whose `title` starts with `Allow tool: <name>` and whose `options` are `["Approve", "Deny"]`. Hosts that render their own approval UI opt in to typed frames instead, once per process:

```json
{ "id": "req_1", "type": "set_approval_handler", "handler": "host" }
```

The response payload is `{ "handler": "host" }`. `handler: "ui"` switches back; any other value fails with `success: false`. The setting works in `--mode rpc`, `--mode rpc-ui`, and with `--no-ui`. Hosts that never send the command see the `select` dialog exactly as before. Which calls require approval does not change: a configured `tools.approval.<name>: deny` still denies without a request, and only calls that would have shown the dialog emit one. This covers approvals raised from inside an `eval` cell as well: tools called through the eval bridge and eval prelude host calls (such as `browser.*` or `computer.*`) emit `tool_approval_request` under the host handler, so no `Allow tool:` select appears while it is active.

### Outbound request

```json
{
  "type": "tool_approval_request",
  "id": "appr_1",
  "toolCallId": "toolu_123",
  "toolName": "bash",
  "args": { "command": "rm -rf build" },
  "tier": "exec",
  "approvalMode": "always-ask",
  "reason": "Critical pattern detected",
  "details": ["Command: rm -rf build"],
  "timeout": 600000
}
```

- `toolCallId` matches the `tool_execution_start` event of the same call. Approval runs inside tool execution, so the request is always written after that `tool_execution_start` frame; hosts can attach it to the in-flight tool item. Calls made from inside an `eval` cell have no agent tool call of their own: they carry a synthetic id (`prelude-<name>-<uuid>` for an eval prelude host call such as `browser`, `js-<tool>-<uuid>` for a bridged tool) that matches no `tool_execution_start`. Their request is written while the enclosing `eval` call is executing, between its `tool_execution_start` and `tool_execution_end`.
- For an eval prelude call, `toolName` is the prelude name (`browser`, `computer`), `args` are the prelude call's parameters (for example `{ "action": "tabs" }`), and `details` is `[]`. A denial fails the prelude call inside the cell with `Eval prelude call denied by user: <name>`, followed by `Reason: <reason>` when the host gave one.
- `args` is the exact input that runs when approved, including any revision a `tool_call` extension handler made.
- `tier` is the resolved tool tier (`read | write | exec`); `approvalMode` is the session approval mode (`always-ask | write | yolo`).
- `reason` is present only when the policy gave one. `details` are the tool's own approval detail lines, without the `Allow tool:` header.
- `safetyChecks` (`Array<{ id, code?, message? }>`) is present only when provider safety checks are pending (computer-use calls).
- `timeout` is in milliseconds. A request still unanswered after it resolves as `deny`.

If the turn is aborted while a request is pending, RPC mode emits a cancellation and the call is denied:

```json
{ "type": "tool_approval_cancel", "id": "appr_cancel_1", "targetId": "appr_1" }
```

### Inbound response

```json
{ "type": "tool_approval_response", "id": "appr_1", "decision": "allow_once" }
```

- `decision: "allow_once"` runs this call.
- `decision: "allow_session"` runs this call and records an in-memory `tools.approval.<toolName>: allow` for the rest of the process, so later calls of that tool that this policy would allow run without a request. It is never written to `config.yml` or project config. Calls that prompt regardless of a user `allow` (for example critical `bash` patterns outside `yolo`) still ask.
- `decision: "deny"` fails the call with `isError: true`. An optional `reason` string is included in the tool error text the model sees.
- `{ "type": "tool_approval_response", "id": "appr_1", "cancelled": true }` resolves as `deny`, like a cancelled dialog.
- If a malformed host frame carries both `cancelled: true` and a `decision`, cancellation wins: the call is denied and no `allow_session` policy is recorded.

A missing or unknown `decision` resolves as `deny`. Responses to an unknown, timed-out, or cancelled `id` are ignored. When stdin closes, pending requests are rejected and their calls fail as denied.

The extension events `tool_approval_requested` and `tool_approval_resolved` fire for these requests exactly as they do for the dialog.

## Host Tool Sub-Protocol

RPC hosts can expose custom tools to the agent by sending `set_host_tools`, then
serving execution requests over the same transport.

### Outbound request

When the agent wants the host to execute one of those tools, RPC mode emits:

```json
{
	"type": "host_tool_call",
	"id": "host_1",
	"toolCallId": "toolu_123",
	"toolName": "echo_host",
	"arguments": { "message": "hello" }
}
```

If the tool execution is later aborted, RPC mode emits:

```json
{
	"type": "host_tool_cancel",
	"id": "host_cancel_1",
	"targetId": "host_1"
}
```

### Inbound updates and completion

Hosts can optionally stream progress:

```json
{
	"type": "host_tool_update",
	"id": "host_1",
	"partialResult": {
		"content": [{ "type": "text", "text": "working" }]
	}
}
```

Completion uses:

```json
{
	"type": "host_tool_result",
	"id": "host_1",
	"result": {
		"content": [{ "type": "text", "text": "done" }]
	}
}
```

Set top-level `isError: true` on `host_tool_result` to reject the pending host tool call and surface the returned text content as a tool error.

## Live Voice Sub-Protocol

RPC hosts can run a GPT live voice session (the realtime surface behind the
terminal's `/live`) bound to the RPC session. The realtime model talks to the
user through the machine's microphone and speakers and delegates work into the
RPC session as ordinary turns, so delegated work runs with the session's model
and any host tools registered through `set_host_tools`. At most one live
session runs per RPC server.

### Commands

- `{ id?, type: "live_start", voice?: string }` → `data: { voice: string }`
- `{ id?, type: "live_connect", sdpOffer: string, voice?: string }` → `data: { voice: string, sdpAnswer: string }`
- `{ id?, type: "live_stop" }`
- `{ id?, type: "live_mute", muted?: boolean }` → `data: { muted: boolean }`

`live_start` responds once the session is connected and recording, so it is
dispatched concurrently like `bash`; `live_stop` sent meanwhile cancels the
connection and the pending `live_start` then fails. `voice` defaults to the
`live.voice` setting and the response reports the voice used. The live
instructions come from the active live persona (`/persona`), not from the
request. Starting while a session is connecting, active, or closing fails.

`live_connect` starts the same session with the audio on the client's own
WebRTC peer instead of the host's microphone and speakers. `sdpOffer` is that
peer's offer: one sendrecv Opus audio track plus an `oai-events` data channel.
Apply the returned `sdpAnswer` to the peer right away; the response comes once
the call is signaled and its control socket is open. A missing or empty
`sdpOffer` fails without starting anything. The peer handles echo cancellation
and mute: `live_mute` only moves the phase to `muted`, so silence the peer's
microphone track while that phase lasts. The server sends no `live_levels` and
no `speaking` phase for these sessions. `voice`, the active live persona, `live_stop` and
the frames work as for `live_start`. The server cannot see the client's peer, so
send `live_stop` when that peer disconnects (`connectionstatechange` to `failed`
or `closed`); otherwise the session stays open.

`live_stop` responds after the session has stopped and succeeds when none is
active. `live_mute` sets the microphone mute, or toggles it when `muted` is
omitted, and fails when no session is active.

```json
{ "id": "l1", "type": "live_start", "voice": "cedar" }
{ "id": "l1", "type": "response", "command": "live_start", "success": true, "data": { "voice": "sol" } }
```

### Frames

Live frames are not session events: `set_event_filter` never drops them.

- `{ type: "live_phase", phase }` on every phase change; `phase` is one of `connecting`, `listening`, `working`, `speaking`, `muted`, `error`.
- `{ type: "live_levels", input: number, output: number }` — microphone and speaker RMS in `[0, 1]`, at most one frame per 100 ms. Intermediate values are dropped; the latest values are always delivered. Not sent for `live_connect` sessions.
- `{ type: "live_transcript", role: "user" | "assistant", turn: number, text: string, final: boolean }` — the accumulated text of one turn; later frames for the same `role` and `turn` replace earlier ones until `final: true`.
- `{ type: "live_end", error?: string }` — exactly once per session when it ends, carrying the failure when it ended on one (including a failed `live_start` or `live_connect`).

Closing stdin, or `pi.shutdown()`, stops an active live session before the
process exits.

## Dictation Sub-Protocol

Draft-only dictation captures from the machine's microphone using the session's
configured `modelRoles.dictation` speech-to-text engine and `stt.language`.
It requires `stt.enabled: true`; when disabled, start fails before opening the
microphone or initializing a speech model. It does not submit a prompt,
interpret speech submit triggers, or play audio.
Live voice and dictation are mutually exclusive, including while either starts
or stops.

- `{ id?, type: "dictation_start", captureId: string }` starts a capture and responds when recording. `captureId` must be a non-blank string of at most 128 UTF-16 code units; the host must choose a unique ID for each capture.
- `{ id?, type: "dictation_stop" }` stops the microphone and flushes transcription, then responds with `data: { text: string }`. With no capture it succeeds with empty text. A failure returns an error response.

Bundled clients allow 600 seconds for both dictation commands: start may need to download and load a cold speech model, and stop may need to finish a slow local or cloud transcription flush. The TypeScript `RpcClient.dictationStart(captureId, timeoutMs)` and `RpcClient.dictationStop(timeoutMs)` accept caller-selected deadlines in milliseconds. A client timeout only stops waiting; it does not cancel the server operation. Send `dictation_stop` (or call `dictationStop()`) to cancel a pending start or stop an active capture, and keep the `dictation_end` subscription active to receive a flush result that arrives after a request deadline.

Stop can be sent while start is pending: it cancels the start, waits for the
microphone to close, and causes the pending start to fail. The terminal frame
may arrive before either response, so subscribe before starting and correlate
by `captureId` rather than response order.

These unsolicited frames bypass `set_event_filter`:

- `{ type: "dictation_state", captureId, state: "starting" | "recording" | "transcribing" }`
- `{ type: "dictation_transcript", captureId, text }` — full accumulated preview; replace the prior preview for this capture rather than appending it.
- `{ type: "dictation_end", captureId, text, error? }` — exactly one terminal frame for a started capture, with its accumulated result and an optional error. The stop result and terminal frame describe the same text; insert it only once into the draft that initiated the capture.

Session changes stop and flush dictation before changing sessions, including
extension-initiated transitions. A transcription failure is reported in the
terminal frame but does not veto the session change once capture has been
released. On stdin EOF, RPC output failure, or process shutdown, active capture
is disposed and the microphone is closed without waiting for transcription.

## Host URI Sub-Protocol

RPC hosts can also own custom URL schemes (virtual files). After
`set_host_uri_schemes`, every read of `<scheme>://…` and write of
`<scheme>://…` (when registered as `writable`) is bounced back to the host
over the same transport.

### Outbound request

When a session tool resolves a host-owned URL, RPC mode emits:

```json
{
	"type": "host_uri_request",
	"id": "uri_1",
	"operation": "read",
	"url": "db://users/42"
}
```

Writes look the same with `"operation": "write"` and an additional
`"content": "..."` field carrying the full replacement text.

If the request is later aborted (caller cancels, session ends), RPC mode
emits:

```json
{
	"type": "host_uri_cancel",
	"id": "uri_cancel_1",
	"targetId": "uri_1"
}
```

### Inbound result

For successful reads:

```json
{
	"type": "host_uri_result",
	"id": "uri_1",
	"content": "id=42\nname=Alice\n",
	"contentType": "text/plain",
	"notes": ["fresh from cache"],
	"immutable": false
}
```

For successful writes, omit content:

```json
{ "type": "host_uri_result", "id": "uri_1" }
```

To reject the request, set `isError: true` and either populate `error` with
a message or fall back to `content` for textual error surfacing:

```json
{
	"type": "host_uri_result",
	"id": "uri_1",
	"isError": true,
	"error": "row 42 not found"
}
```

### Constraints

- The agent's `edit` tool does not target host URIs. Hosts that want to
  mutate virtual files expose `write` and let the model use the `write` tool
  with replacement content.
- Schemes are global to the process; `set_host_uri_schemes` replaces the
  previous set, unregistering anything not in the new list.
- Schemes are normalized to lowercase before registration.
- Send `content` for successful reads; the current bridge treats an omitted
  value as an empty string. `contentType` defaults to `text/plain` and its
  declared values are `"text/plain"`, `"text/markdown"`, or `"application/json"`.
  A result-level `immutable` overrides the registered scheme's value for that read.

## Plan Mode Sub-Protocol

Capability: `set_mode`. It mirrors ACP `session/set_mode`: a host switches the session between `default` and `plan` mode, observes every mode change, and approves or refines the plan the agent proposes.

### `set_mode`

```json
{ "id": "m1", "type": "set_mode", "mode": "plan", "planFilePath": "local://auth-plan.md" }
```

Response data: `{ "mode": "plan" | "default", "planFilePath"?: string }`. `planFilePath` is present only for `plan`.

- `mode: "plan"` enters plan mode like the interactive `/plan`: the session gets a plan-mode state with `planFilePath` (the supplied path, else the path of the plan state being re-entered, else `local://PLAN.md`) and `workflow` (carried over, else `"parallel"`); the built-in `write` tool joins the active tools so the agent can draft the plan and submit it; the session switches to the `plan` model role when one is configured; and a `mode_change` entry is appended to the session. Sending `plan` while already in plan mode only retargets the plan file when `planFilePath` differs.
- `mode: "default"` leaves plan mode: plan state and the proposal handler are cleared, the pre-plan tools return, the pre-plan model and thinking level are restored, and a `mode_change` entry is appended. If a plan proposal is pending, it is first resolved as `refine` without feedback and cancelled with `reason: "mode_change"` (before `mode_changed`). Sending `default` outside plan mode succeeds without changes. The exit is all-or-nothing: if restoring the pre-plan model or tools fails, the command fails and the session stays in plan mode with the plan tools, the plan model, and its proposal handler, so a retry can complete the exit.
- A model or thinking level the host picks while planning (`set_model`, `cycle_model`, `set_role`, `set_thinking_level`, or `/model`) is kept when plan mode ends. The pre-plan model and thinking level are restored only while the session still runs the exact model and thinking level plan mode switched to. On a session transition, that model must also have been carried live into the new conversation; a loaded session's own model is kept even if it matches the plan model and thinking level.
- Plan mode and chat mode are mutually exclusive. Chat mode runs without tools, and plan mode adds `write` to draft and propose the plan. `set_mode { mode: "plan" }` fails with `mode_blocked` while chat mode is on, and entering chat mode fails while plan mode is on (see [`set_chat_mode`](#set_chat_mode-payload)). So leaving plan mode never reactivates tools under chat mode.
- A session transition ends the plan mode `set_mode` entered, whichever path runs it: `new_session`, `switch_session`, `open_session`, `branch`, `handoff`, or the same through a slash command or an extension. The plan belongs to the conversation that was left. A pending proposal resolves as `refine`, plan state and the proposal handler clear, and `mode_changed { mode: "default" }` is written. The pre-plan tools return. The pre-plan model returns only when the transition carried the live plan model over, as after `new_session` or `branch`. A switched-to or opened session keeps the model it loaded, even when it is identical to the plan model; the entry snapshot is never applied to it. No `mode_change` entry is appended. The transition's response is written after this cleanup finishes. Send `set_mode { mode: "plan" }` again to plan in the new conversation.
- Only `"default"` and `"plan"` are accepted; any other value, or a non-string or empty `planFilePath`, fails without a `code`.

Failures leave the session unchanged and carry a machine-readable `code`:

| `code` | When |
| --- | --- |
| `plan_disabled` | `mode: "plan"` while the `plan.enabled` setting is `false`. |
| `mode_blocked` | `mode: "plan"` while goal mode (active or paused), vibe mode, or chat mode is on. |
| `session_busy` | The session is streaming or compacting. Mode changes apply between turns. `mode: "default"` is exempt while a plan proposal is pending, since the proposing turn is still streaming. |

### `mode_changed`

```json
{ "type": "mode_changed", "mode": "plan", "planFilePath": "local://PLAN.md" }
```

Written whenever the session mode or the active plan file changes, whichever path caused it: `set_mode`, plan approval clearing plan mode, a refinement that retargets the plan file, or plan mode entered by other means (for example `--plan-yolo`). `planFilePath` is present only for `plan`. A `set_mode` that changes the mode writes `mode_changed` before its response. The frame is not a session event, so `set_event_filter` does not suppress it.

### Plan proposal round trip

After `set_mode { mode: "plan" }`, the agent submits its finished plan by writing the plan title to `xd://propose`. RPC mode validates the plan file and asks the host:

```json
{
  "type": "plan_proposal_request",
  "id": "7342",
  "title": "auth-refactor",
  "planFilePath": "local://auth-refactor-plan.md",
  "planMarkdown": "# Auth refactor\n\n1. ..."
}
```

The host answers on stdin. The answer is a control frame: it is dispatched on arrival, not queued behind commands, because the proposing turn is waiting on it.

```json
{ "type": "plan_proposal_response", "id": "7342", "decision": "approve" }
{ "type": "plan_proposal_response", "id": "7342", "decision": "refine", "feedback": "Split step 2 into tests first." }
```

- `approve`: the approved file becomes the plan reference for the next turn, plan mode is cleared (`mode_changed { mode: "default" }`), the pre-plan tools and model are restored (a model switch waits for the turn to end), the plan is autosaved when `plan.autosave` is on, and the agent is told to proceed with the implementation.
- `refine`: plan mode stays on, the reviewed file becomes the plan-mode target, and the agent is asked to revise and resubmit. Non-empty `feedback` is appended to that tool result under `Reviewer feedback:`, so the agent sees the note.
- Any `decision` other than `approve` counts as `refine`. A proposal the host never answers resolves as `refine` without feedback, never as `approve`, and RPC mode announces it with one `plan_proposal_cancel` frame (see below). There is no proposal timeout.
- Responses with an unknown or already-answered `id` are ignored.

A host that never sends `set_mode` keeps the previous behavior in both `--mode rpc` and `--mode rpc-ui`: no proposal handler is installed, so an `xd://propose` write fails with "No plan is awaiting approval", and no tools or models change.

### `plan_proposal_cancel`

Capability: `plan_proposal_cancel`. Written exactly once when a pending proposal resolves without a host answer; `id` is the `plan_proposal_request` id:

```json
{ "type": "plan_proposal_cancel", "id": "7342", "reason": "abort" }
```

| `reason` | When |
| --- | --- |
| `abort` | The proposing turn was aborted (`abort`, `abort_and_prompt`). |
| `mode_change` | `set_mode { mode: "default" }` arrived; the frame precedes that command's `mode_changed` and response. |
| `agent_end` | The run ended with the proposal still pending; the frame follows that `agent_end`. |
| `shutdown` | stdin closed. |

Hosts should dismiss the matching plan card on this frame. A proposal that was answered is never cancelled. A `plan_proposal_response` sent for a cancelled `id` fails with a response frame correlated by that `id`:

```json
{ "id": "7342", "type": "response", "command": "plan_proposal_response", "success": false, "error": "Plan proposal 7342 was cancelled (abort)", "code": "proposal_cancelled" }
```

## Error Model and Recoverability

### Command-level failures

Failures are `success: false` with string `error`.

`code` is an optional machine-readable reason on some failures, for example `session_in_use` from `switch_session`/`branch` (see [Session lease](#session-lease)).

```json
{
	"id": "req_2",
	"type": "response",
	"command": "set_model",
	"success": false,
	"error": "Model not found: provider/model"
}
```

### Recoverability expectations

- Most command failures are recoverable; process remains alive.
- Malformed JSONL / parse-loop exceptions emit a `parse` error response and continue reading subsequent lines.
- Empty `set_session_name` is rejected (`Session name cannot be empty`).
- Extension UI responses and valid host-tool/host-URI updates/results with unknown `id` are ignored. These side-channel frames do not receive command response frames.
- Plan proposal responses with unknown `id` are ignored.
- Normal termination occurs on stdin close or extension-triggered shutdown. Output/spool failures and unrecovered session-persistence failures are fatal.
- Session-persistence errors emit an unfiltered `{ type: "notice", level: "error", message, source: "session-persistence" }` frame and a stderr mirror. A recovered failure can still shut down normally; a failure still latched during disposal exits with code `1` after draining stdout.

## Compact Command Flows

### 1) Prompt and stream

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout sequence (simplified; message contents omitted):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "messageId": "msg-019ac518-1122-7333-8444-556677889900-2", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [], "isTerminal": true, "yielded": true }
{ "type": "prompt_result", "id": "req_1", "agentInvoked": true, "status": "completed", "sessionSettled": true }
{ "type": "session_settled" }
```

### 2) Prompt during streaming with explicit queue policy

stdin:

```json
{
	"id": "req_2",
	"type": "prompt",
	"message": "Also include risks",
	"streamingBehavior": "followUp"
}
```

### 3) Inspect and tune queue behavior

stdin:

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) Extension UI round trip

stdout:

```json
{
	"type": "extension_ui_request",
	"id": "ui_7",
	"method": "input",
	"title": "Branch name",
	"placeholder": "feature/...",
	"secret": false
}
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## Client libraries

### Wire schema and generated clients

`packages/coding-agent/src/modes/rpc/wire` describes every command (parameters,
success `data`, nullability, timeouts), every unsolicited frame, and every shared
type as omptype schemas. `bun run gen:rpc` emits:

- `rpc-wire.schema.json`: a JSON Schema 2020-12 bundle plus an `x-rpc` section:
  the command table, the stdout frame union (`serverFrame`: responses, host
  requests, notifications), the notification and session-event unions, and the
  host-to-server frame union (`inbound`). It is the language-neutral input for
  client generators, with these decoder rules:
   - objects marked `"x-open": true` are open records (messages, content, usage,
     assistant streaming events): decoders check the `role`/`type` discriminator
     and keep every key, so persisted messages missing newer fields still decode;
   - a property `default` is the value decoders substitute when an older server
     omits the field;
   - string enums are closed: an unknown value fails the frame, which clients then
     surface as an unknown notification instead of stopping;
   - `x-unknown-fallback` on a property (a subagent's forwarded event) degrades a
     value that fails to decode to an unknown notification without failing its
     frame, and `x-scalar-or-array` marks an array older servers sent as a bare
     scalar.
- `rpc-wire.generated.ts`: the wire types in TypeScript.
- `sdk/python/omp-rpc/src/omp_rpc/_wire.py`: Python types, decoders, command methods,
  and frame listeners for the `omp-rpc` package.
- `sdk/rust/omp-rpc/src/wire.rs`: Rust serde types, frame decoders, and a `Command`
  trait implemented by one params struct per command (crate `omp-rpc`).
- `sdk/go/omp-rpc/wire.go`: Go types, frame decoders, and one `Commands` method per
  command (module `github.com/can1357/oh-my-pi/sdk/go/omp-rpc`).

The Rust and Go packages ship hand-written process transports on top of the
generated types: they negotiate v2 and reassemble chunks, page message history,
wait for a prompt's `prompt_result` (`prompt_and_wait` / `PromptAndWait`), and serve
host-owned tools and URI schemes. Their READMEs cover the APIs.

`packages/coding-agent/test/rpc-wire` fails when a committed output is stale, and
type-checks the generated TypeScript against `rpc-types.ts` and the internal types
behind it: a new command, command parameter, event, event field, or enum value on
the server breaks `bun check` until the schema covers it.

### TypeScript helper

`packages/coding-agent/src/modes/rpc/rpc-client.ts` is a convenience wrapper, not the protocol definition.

Current helper characteristics:

- Spawns `bun <cliPath> --mode rpc` by default (`cliPath` defaults to `dist/cli.js`). A `command` argv prefix receives generated agent arguments; a command builder returns complete argv. A custom `spawn` transport takes precedence.
- Correlates responses by generated `req_<n>` ids, negotiates v2, reassembles chunks, and pages message history
- Dispatches recognized core `AgentEvent` types through `onEvent()` and recognized session events through `onSessionEvent()`; the raw server stream can include additional event types
- Exposes `onPromptResult()`, `onSessionSettled()`, command-availability and subagent listeners, plus extension UI requests
- Supports host-owned custom tools via `setCustomTools()` and automatic handling of `host_tool_call` / `host_tool_cancel`
- Plan mode via `setMode(...)`, `onModeChanged(...)`, `onPlanProposalRequest(...)`, and `respondToPlanProposal(id, decision, feedback?)`
- Host tool approvals via `setApprovalHandler("host" | "ui")`, `onToolApprovalRequest(...)`, `onToolApprovalCancel(...)`, and `respondToToolApproval(id, decision, reason?)`
- Provider usage via `getUsage({ provider?, refresh?, redact? })`
- Drives live voice sessions with `liveStart()`, `liveStop()`, `liveMute()`, and delivers live frames through `onLive()`
- Drives draft-only speech input with `dictationStart(captureId)`, `dictationStop()`, and `onDictation()`
- `promptAndWait()` waits for that prompt's result (or synchronous local completion); `waitForSettled()` also waits for session quiescence. `waitForIdle()` and `collectEvents()` stop at the next `agent_end`, including a non-terminal one, and are not settle barriers.
- Wraps common protocol commands including OAuth `getLoginProviders()` / `login(...)`, session account selection with `activateAccount(...)`, and `getLogoutAccounts(...)` / `logout(...)`; use raw protocol frames for unwrapped surfaces such as host-URI registration or delta-only message updates.

### Python package

The bundled [`omp-rpc`](../sdk/python/omp-rpc/pyproject.toml) distribution provides the process-backed Python client. Its import package is `omp_rpc`; the package API, typed commands and events, host-tool/host-URI helpers, and orchestration examples are maintained in the [`omp-rpc` README](../sdk/python/omp-rpc/README.md).

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

By default, `RpcClient` starts `omp --mode rpc`; pass `command=[...]` to own the exact child command. It handles request correlation, typed notifications, v2 negotiation and chunk reassembly, message pagination, extension UI (including the opt-in `ask` dialog), and host-owned tools and URI schemes. Its command methods and `on_<frame type>` listeners are generated from the wire schema, so it wraps every command above; the `messageUpdates: "delta"` projection stays raw-protocol only. The Python package owns that client API and process lifecycle; this document and `rpc-types.ts` remain the canonical wire contract. Use raw protocol frames when a client library does not wrap the surface you need.

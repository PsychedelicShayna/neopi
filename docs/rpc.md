# RPC Protocol Reference

RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

- **stdin**: commands (`RpcCommand`), extension UI responses, and host-tool updates/results
- **stdout**: a ready frame, command responses (`RpcResponse`), session/agent events, extension UI requests, host-tool requests/cancellations

Primary implementation:

- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## Startup

```bash
omp --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- `--no-ui` (only with `--mode rpc`) runs extensions headless: `ctx.hasUI` is `false`, dialogs resolve to their defaults, and no `extension_ui_request` frames are emitted except for a host-issued `login`. Use it when the host has no interactive surface and must not be left owing dialog answers.
- RPC mode disables automatic session title generation by default to avoid an extra model call.
- A flagless RPC launch (`--mode rpc` or `--mode rpc-ui` with no session flags) always starts a new session in the default per-cwd session directory. Protocol modes (`rpc`, `rpc-ui`, `acp`) ignore the user's `autoResume` setting. `--new-session` makes that explicit (and applies it in every mode); it combines with `--session-dir <dir>` to create the session in `<dir>`, and is rejected at argument parsing together with `--continue`, `--resume`/`--session`, or `--fork`.
- RPC/ACP host defaults cover task isolation/execution, memory, advisor, tier, async-job, and bash auto-background settings. They are applied only when a path is not explicitly configured; project/global config, `--config`, and isolated settings remain authoritative. Todo settings are not host-defaulted.
- The process claims stdin before extension discovery, then parses it one non-empty JSONL line at a time. Malformed JSON emits a recoverable `command: "parse"` failure and does not terminate the loop.
- At startup it writes a `ready` frame, then starts reading stdin while extensions initialize. Control frames (`extension_ui_response`, `tool_approval_response`, `plan_proposal_response`, `host_tool_result`, `host_tool_update`, `host_uri_result`) are dispatched on arrival, so an extension that asks a dialog question during `session_start` receives the host's answer. `negotiate_protocol` is also answered on arrival during startup, since it needs no session, so a bounded host handshake completes while a startup dialog is open. Commands, `bash` included, are queued and processed in arrival order once initialization completes. Hosts that send no startup dialog answers observe no change in frame order.
- When stdin closes, pending extension UI, tool approval, host-tool, and host-URI requests are rejected and a pending plan proposal resolves as `refine` (announced with `plan_proposal_cancel`, `reason: "shutdown"`); accepted commands are drained, the session is disposed, pending stdout is delivered, and the process exits with code `0`.
- Responses/events are written as one JSON object per line.

### Capabilities

| String | Feature |
| --- | --- |
| `get_usage` | The `get_usage` command returns account-level provider usage reports. See [Session](#session). |
| `get_roles` | `get_roles` / `set_role` commands and `get_state.activeRole` ([payloads](#get_roles-and-set_role-payloads)) |
| `set_chat_mode` | Live chat-mode switching: the `set_chat_mode` command, `get_state.chatMode`, the `chat_mode_changed` event, and the `/chat` builtin in `get_available_commands`. |
| `tool_approval_request` | `set_approval_handler` and the typed `tool_approval_request` / `tool_approval_response` / `tool_approval_cancel` frames; see [Tool Approval Sub-Protocol](#tool-approval-sub-protocol) |
| `set_mode` | `set_mode` command, `get_state` `mode`/`planMode`, `mode_changed` event, and the `plan_proposal_request`/`plan_proposal_response` round trip. See [Plan Mode Sub-Protocol](#plan-mode-sub-protocol). |
| `new_session` | `--new-session` is accepted, and a flagless protocol launch never auto-resumes: the process starts a fresh session in the default per-cwd session directory regardless of `autoResume` (see [Startup](#startup)). |
| `session_lease` | A process holds an exclusive lifetime lease on every session file it writes, so two processes never append to one transcript. `--session <file>` onto a file another process holds fails at startup with a `startup_error` stderr line; `switch_session` and `branch` onto one fail with `code: "session_in_use"` (see [Session lease](#session-lease)). |
| `plan_proposal_cancel` | A pending plan proposal that resolves without a host answer is announced with a `plan_proposal_cancel` frame, and a later `plan_proposal_response` for it fails with `code: "proposal_cancelled"`. See [`plan_proposal_cancel`](#plan_proposal_cancel). |
| `prompt_entry_ids` | `prompt`, `steer`, `follow_up` and `abort_and_prompt` responses carry `data.userEntryId`, the id of the session entry their message is written as, and every `get_messages_page` message carries the `entryId` of its entry. See [Entry ids](#entry-ids). |

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

Protocol v1 stdout frames are a single JSON object followed by `\n`. The server caps each physical stdout frame at 1 MiB. Inbound commands are always one unchunked JSONL object; clients SHOULD keep them within the advertised physical-frame limit.

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

After the success response, oversized stdout objects are emitted losslessly as an uninterrupted sequence of `rpc_chunk` frames. Each chunk carries a base64 segment of the original UTF-8 JSON object:

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

Clients MUST validate `chunkId`, `index`, `count`, and `byteLength`, reject interleaved or interrupted sequences, enforce the advertised reassembly limit, concatenate decoded bytes in index order, decode them as strict UTF-8, and parse the result as one JSON object. The TypeScript `RpcFrameDecoder`, exported from `@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame`, implements this validation. The bundled TypeScript and Python `RpcClient` implementations negotiate v2 automatically when the ready frame advertises it.

Legacy clients may ignore the added ready fields and remain on v1. V1 retains its bounded fallback behavior for oversized output. Frames above the v2 reassembly ceiling still fail explicitly; large history APIs should use pagination rather than depending on arbitrarily large logical frames.

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
9. Prompt completion (`{ type: "prompt_result", id?, agentInvoked, status, error?, sessionSettled }`), one per accepted prompt; see [`prompt` payload](#prompt-payload)
10. Session quiescence (`{ type: "session_settled" }`); see [Yield vs settled](#yield-vs-settled)
11. Subagent frames (`subagent_lifecycle`, `subagent_progress`, `subagent_event`), gated by `set_subagent_subscription`
12. Builtin slash-command side channels (`command_output`, `session_info_update`, `config_update`)
13. Tool approval requests/cancellations (`tool_approval_request`, `tool_approval_cancel`), only after `set_approval_handler` with `handler: "host"`
14. Plan mode frames (`mode_changed`, `plan_proposal_request`, `plan_proposal_cancel`); see [Plan Mode Sub-Protocol](#plan-mode-sub-protocol)

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
- Malformed JSON and synchronous dispatch failures emit `command: "parse"` with `id: undefined`. Exceptions while handling a recognized command emit a failure with that command's `type` and `id`.
- `prompt` and `abort_and_prompt` return immediate success, then may emit a later error response with the **same** id if async prompt scheduling fails.
- An accepted `prompt` or `abort_and_prompt` completes exactly once: either its success response carries `data.agentInvoked: false` (finished locally), or a later `prompt_result` frame with the same `id` reports how its work ended. `prompt_result` is always written after the response for that `id`.

## Command Schema (canonical)

`RpcCommand` is defined in `packages/coding-agent/src/modes/rpc/rpc-types.ts`:

### Prompting

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "new_session", parentSession?: string }`
- `{ id?, type: "open_session", sessionDir: string }`

### Protocol

- `{ id?, type: "negotiate_protocol", protocolVersion: 2 }`

### State

- `{ id?, type: "get_state" }`
- `{ id?, type: "set_fast_mode", enabled: boolean }`
- `{ id?, type: "set_chat_mode", mode: "off" | "chat" | "erp" | "raw", include?: string | string[] }`
- `{ id?, type: "set_mode", mode: "default" | "plan", planFilePath?: string }`
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "get_entries", since?: string }`
- `{ id?, type: "get_tree" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "set_event_filter", events: string[] | null }`
- `{ id?, type: "set_approval_handler", handler: "host" | "ui" }`; see [Tool Approval Sub-Protocol](#tool-approval-sub-protocol)
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number }`

### Model

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "cycle_model" }`
- `{ id?, type: "get_available_models" }`
- `{ id?, type: "get_roles" }`
- `{ id?, type: "set_role", role: string }`

### Thinking

- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`
- `{ id?, type: "get_available_thinking_levels" }`

### Queue modes

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`

### Compaction

- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`

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

### Messages

- `{ id?, type: "get_messages" }`
- `{ id?, type: "get_messages_page", cursor?: string, limit?: number }`

`get_messages_page` returns a stable chronological page with `messages`, `totalMessages`, and an opaque `nextCursor` when more messages remain. Cursors are bound to the session ID, durable leaf, and message count. The server rejects stale cursors if the session changes between requests, and refuses to start a paging walk while the session is streaming or compacting. Failed page requests carry a machine-readable `code` on the error response — `session_busy` (session is streaming or compacting) or `stale_cursor` (the snapshot behind the cursor changed, e.g. a background bash appended a message between pages) — so clients can react without matching error-message text. Pages contain at most 256 messages and normally stay below the v1 physical-frame ceiling. A v1 caller can page ordinary histories, but an individual message whose response exceeds that ceiling produces an overflow error; retrieving it losslessly requires negotiated v2 framing. Every paged message carries `entryId`, the id of the session entry it came from (see [Entry ids](#entry-ids)).

The bundled TypeScript `RpcClient.getMessages()` and Python `RpcClient.get_messages()` drain this paged endpoint automatically after negotiating v2. They retain the legacy monolithic command when connected to a v1 server, and on either `session_busy` or `stale_cursor` they discard partial pages and fall back to the legacy best-effort snapshot. Direct `getMessagesPage()` and `get_messages_page()` calls remain strict so incremental hosts never mix snapshots silently.

### Login

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`

Login forwards ordinary OAuth input prompts only after the provider emits an
authorization URL. Prompts marked `secret: true` are always rejected with a
failed `login` response directing the user to the terminal UI; no ordinary
`input` request is emitted. RPC does not negotiate secret-input support.

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string, code?: string }`

Data payloads are command-specific and defined in `rpc-types.ts`.

### `prompt` payload

`prompt` is acknowledged after the command is accepted, not after a model turn finishes:

```json
{
  "id": "req_1",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "agentInvoked": false }
}
```

`data.agentInvoked: false` is the completion signal for slash commands that finish synchronously without starting an agent turn; no `prompt_result` follows. Every other accepted `prompt` (and every `abort_and_prompt`) is completed by one `prompt_result` frame carrying the command `id`, emitted once all work the prompt caused has settled:

```json
{ "type": "prompt_result", "id": "req_1", "agentInvoked": true, "status": "completed", "sessionSettled": true }
```

- `agentInvoked: false`: the prompt finished locally (an extension or custom command that started no turn) or failed before reaching the agent.
- `agentInvoked: true`: the prompt reached the agent and the agent **yielded** — see [Yield vs settled](#yield-vs-settled). A prompt dispatched as a fresh turn reports the first run that started after it was accepted, so a late `agent_end` from an earlier run never completes it. A prompt queued into a live run (`streamingBehavior`) reports at the first yield after its message left the queue. An `agent_end` with `yielded: false` (the agent is retrying, compacting, or answering a stop-time reminder) never completes a prompt.
- `status`: `"completed"`, `"aborted"` (interrupted by `abort`, `abort_and_prompt`, or a session transition, or dropped by an abort before dispatch), or `"error"`.
- `error` (only with `status: "error"`): `{ message, provider?, model?, httpStatus?, retryable }`. `message` is the provider's error text with OMP-local diagnostics (such as saved request-dump paths) removed. `retryable` marks a transient failure; OMP's own automatic retries have already been exhausted. A prompt that fails before reaching the agent also gets the legacy error response with the same `id` before its `prompt_result`.
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

### Yield vs settled

A prompt's `prompt_result` means the **agent yielded**: it finished its turn (`agent_end` with `yielded: true`). The **session is done** only when, in addition, nothing can wake it again — no run is live or admitted, no steer/follow-up is queued, and no background job (auto-backgrounded `bash`, async `task`, `eval`) or pending delivery will inject its result and start a follow-up turn.

- `session_settled` is written once per stretch of agent activity, when the session becomes done. If background work was pending at the yield, OMP waits it out; any follow-up runs it triggers stream normally (`agent_start` … `agent_end`) before `session_settled`. It always follows the `prompt_result` frames of the final yield, and is not emitted for prompts that never reached the agent.
- `prompt_result.sessionSettled` answers the same question at the yield, so a host can tear down immediately when it is `true`.
- `get_state` reports `isSettled` (same predicate) and `hasPendingAsyncWork`, for hosts that attach mid-stream.

Wait on `prompt_result` to present a turn's answer; wait on `session_settled` (or `isSettled`) before treating the conversation as finished, e.g. before pausing or recycling a sandbox.

### `open_session` payload

`open_session` binds the process to a host-keyed conversation directory — the runtime equivalent of `--session-dir <dir> --continue`, so a pre-spawned process can adopt a thread after startup. It continues the newest non-empty session in `sessionDir`, or starts a fresh session there when none exists. Reopening the session that is already active (including a still-empty fresh session in the same directory) is a no-op that does not interrupt a running turn; otherwise the current run is aborted as with `switch_session`, and open prompts complete with `status: "aborted"`.

```json
{ "cancelled": false, "resumed": true, "sessionId": "01a0...", "sessionFile": "/srv/threads/t1/2026-...jsonl" }
```

`resumed` is `false` when a fresh session was started. The command fails when the process runs without persistence (`--no-session`).

### `get_state` payload

`tokensPerSecond` is a number when output throughput is available and `null`
otherwise. `fastModeEnabled` reports the session setting, while
`fastModeActive` reports the actual computed active state. For Fireworks,
`providers.fireworksTier: priority` is a provider-level setting independent of
the `/fast` family setting, so `fastModeActive` may remain `true` for an
unsupported Fireworks model.

For direct Anthropic, a provider rejection of `speed: "fast"` uses a sticky
fallback scoped by the resolved endpoint and exact model: `fastModeEnabled` may
remain `true` while `fastModeActive` is `false`. An explicit `set_fast_mode`
enable expresses retry intent and clears that fallback so the provider attempt
is re-armed.

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
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [
    {
      "id": "phase-1",
      "name": "Todos",
      "tasks": [
        {
          "id": "task-1",
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
  }
}
```

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

- `roles` follows the carousel order: non-hidden built-ins in their fixed
  order, then roles introduced by `cycleOrder`, `modelRoles` and `modelTags`.
- `section` is `"chat"`, or `"kind"` for the non-chat model-kind roles
  (`image`, `web`, `speech`, `dictation`, `judge`); hosts that only pick chat
  models filter on it.
- `source` is `"builtin"` for built-in role ids and `"configured"` for roles
  that exist only through configuration.
- `tag` is absent for custom roles, which have no built-in tag.
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
```

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

Enabling fast mode on a model without a service-tier family fails with the
exact error below:

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

### `set_todos` payload

Replaces the in-memory todo state for the current session and returns the normalized phase list:

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "id": "task-2",
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

These tools are added to the active session tool registry before the next model
call. Re-sending `set_host_tools` replaces the previous host-owned set.

Definitions also accept `hidden?: boolean` and
`loadMode?: "essential" | "discoverable"`. An explicit mode wins. When omitted,
known essential built-in names remain `"essential"`; other host tools default
to `"discoverable"`. `toolNames` in the response lists the registered names.

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

Schemes are case-insensitive on the wire and normalized to lowercase before
the response is sent. Re-sending `set_host_uri_schemes` replaces the entire
previous set — schemes missing from the new list are unregistered.

Every built-in scheme (`local://`, `skill://`, `artifact://`, `security://`,
`mcp://`, …) is reserved: RPC hosts cannot register or shadow one, and the
request fails with `Host URI scheme is reserved by OMP: <scheme>://`.

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Common event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `retry_fallback_applied`, `retry_fallback_succeeded`
- `model_changed`, `thinking_level_changed`
- `ttsr_triggered`
- `todo_reminder`, `todo_auto_clear`
- `irc_message`, `notice`, `goal_updated`
- `chat_mode_changed` (`{ type, mode: "off" | "chat" | "erp" | "raw", include: string }`, see `set_chat_mode`)

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

`message_start`, `message_update`, and `message_end` carry a `messageId` string assigned by RPC mode. One message keeps the same id from its start through every update to its end; ids are unique within the process. Records injected mid-stream (advisor cards, IRC messages) get their own id and do not disturb the id of the reply streaming around them.

`set_event_filter` restricts which session event frames are written: pass the event `type` strings to forward, or `null` to forward everything (the default). The response echoes the active selection as `{ events }`. The filter applies only to the session events listed above; every other outbound category (responses, `prompt_result`, `session_settled`, extension UI and host tool/URI requests, plan mode frames, `extension_error`, `available_commands_update`, subagent frames, builtin slash-command side channels, and session-persistence `notice` frames) is always written. Hosts that fail closed on unknown event kinds can pin the set they understand here instead of breaking when OMP adds an event.

`agent_end` has this session-level shape (in addition to optional telemetry fields):

```ts
{
  type: "agent_end";
  messages: AgentMessage[];
  isTerminal?: boolean;
  yielded?: boolean;
}
```

`yielded` is `true` when the agent finished its turn: the end is terminal, or the session resumes only for queued input or background-job results. It is `false` while the agent continues its own work (retry, compaction continuation, stop-time reminders). Frames from older runtimes omit it; treat those as yielded only when terminal.

`isTerminal: false` means maintenance or async delivery has scheduled more work,
so the session will resume before its true final settle. Treat an `agent_end` as
run completion only when `isTerminal !== false`; the field is optional so frames
from older runtimes, where it is absent, remain terminal-compatible.

### Available commands

`get_available_commands` returns `{ commands }`, and the same array is pushed
in `available_commands_update` frames at startup and after command metadata
changes. Each command has `name`, `source`, and optional `aliases`,
`description`, `input.hint`, and `subcommands`.

Command discovery is intentionally an OMP dialect: Pi's `get_commands` (a
`RpcSlashCommand[]` projection over extensions → prompt templates → skills) is
not served because OMP's richer catalog (builtins/custom/MCP/file commands,
broader `source` enum, no Pi `sourceInfo`) is not wire-compatible with it.

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

Lifecycle stays OMP: terminal settle is `agent_end` with
`isTerminal !== false`, not Pi's `agent_settled`; `prompt_result`/
`agentInvoked`, `open_session`, `set_event_filter`, `messageId`, `ready`,
negotiation, chunking, host tools, and subagents are OMP extensions a
Pi-family adapter must dialect around.

### Subagent subscriptions

Subagent forwarding defaults to `"off"`. `set_subagent_subscription` selects:

- `"off"`: no forwarded subagent frames
- `"progress"`: lifecycle and progress frames
- `"events"`: lifecycle, progress, and full subagent event frames

`get_subagents` returns the registry snapshot sorted by subagent index and id.
`get_subagent_messages` selects a transcript by `subagentId` or `sessionFile`;
`fromByte` supports incremental reads. Its result contains `sessionFile`,
`fromByte`, `nextByte`, `reset`, raw transcript `entries`, and converted
`messages`. If `fromByte` exceeds the current file size, reading restarts at
byte zero and reports `reset: true`.

## Prompt/Queue Concurrency and Ordering

This is the most important operational behavior.

### Immediate ack vs completion

`prompt` and `abort_and_prompt` are **acknowledged immediately**:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true, "data": { "userEntryId": "3f9a1c07" } }
```

That means:

- command acceptance != run completion
- a prompt completes via `data.agentInvoked: false` on its response or via its own `prompt_result`
- a run completes on an `agent_end` frame where `isTerminal !== false`; that frame carries no prompt identity, so correlate prompts through `prompt_result`
- the session is done only at `session_settled`: background jobs can wake the agent after it yields

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails.

### Queue defaults

From `packages/agent/src/agent.ts` defaults:

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one queued message per turn
  - `"all"`: dequeue entire queue at once
- `set_interrupt_mode`
  - `"immediate"`: tool execution checks steering between tool calls; pending steering can abort remaining tool calls in the turn
  - `"wait"`: defer steering until turn completion

## Extension UI Sub-Protocol

Extensions in RPC mode use request/response UI frames. A host that cannot answer them starts with `--no-ui`: extensions then see `ctx.hasUI === false`, dialogs resolve to their defaults without emitting frames, and presentation updates (`notify`, `setStatus`, `setWidget`, `set_editor_text`) are dropped. `--mode rpc-ui` additionally routes tool UI (e.g. the `ask` tool) through this sub-protocol.

### Outbound request

`RpcExtensionUIRequest` (`type: "extension_ui_request"`) methods:

- `select`, `confirm`, `input`, `editor`, `cancel`
  - `select` keeps labels in `options: string[]` and, when any option has a
    description, emits a positionally aligned
    `optionDetails: Array<{ description?: string }>` array. Hosts that do not
    render descriptions can continue using `options` alone.
- `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
- `open_url` (emitted by RPC login flows)

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

If a dialog has a timeout, RPC mode resolves to a default value when timeout/abort fires.

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
`"content": "..."` field carrying the full replacement bytes.

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
- Successful reads require `content`. `contentType` defaults to `text/plain`
  and, when supplied, is `"text/plain"`, `"text/markdown"`, or
  `"application/json"`. A result-level `immutable` overrides the registered
  scheme's value for that read.

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
- Extension UI responses with unknown `id` are ignored.
- Plan proposal responses with unknown `id` are ignored.
- Process termination conditions are stdin close or explicit extension-triggered shutdown after the current command.

## Compact Command Flows

### 1) Prompt and stream

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout sequence (typical):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "messageId": "msg-2", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [], "isTerminal": true }
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
  "placeholder": "feature/..."
}
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## Client libraries

### TypeScript helper

`packages/coding-agent/src/modes/rpc/rpc-client.ts` is a convenience wrapper, not the protocol definition.

Current helper characteristics:

- Spawns `bun <cliPath> --mode rpc`
- Correlates responses by generated `req_<n>` ids
- Dispatches recognized core `AgentEvent` types to listeners
- Supports host-owned custom tools via `setCustomTools()` and automatic handling of `host_tool_call` / `host_tool_cancel`
- Plan mode via `setMode(...)`, `onModeChanged(...)`, `onPlanProposalRequest(...)`, and `respondToPlanProposal(id, decision, feedback?)`
- Host tool approvals via `setApprovalHandler("host" | "ui")`, `onToolApprovalRequest(...)`, `onToolApprovalCancel(...)`, and `respondToToolApproval(id, decision, reason?)`
- Provider usage via `getUsage({ provider?, refresh?, redact? })`
- Wraps common protocol commands including OAuth `getLoginProviders()` / `login(...)`; use raw protocol frames for any surface not wrapped by the helper.

### Python package

The bundled [`omp-rpc`](../python/omp-rpc/pyproject.toml) distribution provides the process-backed Python client. Its import package is `omp_rpc`; the package API, typed commands and events, host-tool/host-URI helpers, and orchestration examples are maintained in the [`omp-rpc` README](../python/omp-rpc/README.md).

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

By default, `RpcClient` starts `omp --mode rpc`; pass `command=[...]` to own the exact child command. It handles request correlation, typed notifications, v2 negotiation and chunk reassembly, message pagination, extension UI, and host-owned tools and URI schemes. The Python package owns that client API and process lifecycle; this document and `rpc-types.ts` remain the canonical wire contract. Use raw protocol frames when a client library does not wrap the surface you need.

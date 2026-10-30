# checkpoint

> Mark the current top-level conversation state so later `rewind` can collapse exploratory context into a report.

## Source

- Entry: `packages/coding-agent/src/tools/checkpoint.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/checkpoint.md`
- Key collaborators:
   - `packages/coding-agent/src/session/agent-session.ts` — captures the active checkpoint after tool success.
   - `packages/coding-agent/src/session/session-manager.ts` — persists the normal session entry stream; not the active checkpoint marker.
   - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates it behind `checkpoint.enabled`.
   - `packages/coding-agent/src/tools/settings.ts` — defines the disabled-by-default feature flag (`cfgCheckpointEnabled`).

## Registration / Visibility

- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`. Execution is single-shot; the tool does not stream progress updates.
- Registration requires `checkpoint.enabled = true` (default `false`).
- Top-level sessions receive the tool when enabled. Subagents do not discover it by default, but may receive it through an explicit `tools:`/requested-tools list.
- `checkpoint` and `rewind` are a safety pair: when either name is explicitly requested while the feature is enabled, registration automatically includes the other.
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://checkpoint`; an explicitly requested tool remains top-level.

## Context-pressure decisions

Pressure guidance is opt-in through the existing `telemetry.agent_context`
setting, `minimal` or `full`. It remains off by default, independently of
`checkpoint.enabled`. `runtime.inspect()` exposes the same local snapshot.

The agent receives estimated `context.usedTokens`, `limitTokens`, and `percent`;
resolved `compaction.thresholdTokens` and `speculationStartsAtTokens`; and
`checkpoint.active` and `available`. Availability requires both checkpoint tools
in the enabled tool catalog, including discoverable `xd://` tools, and no active
checkpoint. A disabled setting or a restricted subagent cannot claim availability.
Disabled compaction has null boundaries; disabled or unavailable speculation has
a null speculation boundary.

`recentTurnFootprint` estimates retained message tokens from the latest user
message through the current point, including intermediate tool calls and results.
It reports the message count and `scope: "latest_user_turn"`, or null when no user
turn remains in active context. It is not the sum of billed input tokens, which
would repeatedly count the conversation prefix. After rewind, it counts only
retained messages. It does not predict the next excursion or promise exact
provider capacity. Tokenization, cache handling, images and future output vary.

Compare estimated occupancy plus the expected excursion footprint with the
earliest non-null boundary. These are illustrative estimates, not measurements:

- At 136K of a 200K window, speculation beginning at 144K leaves about 8K.
  A recent similar turn retained about 12K, so checkpoint before another such
  excursion if available. A planned 40–60K survey crosses that boundary too.
- At 40K used with the same 144K boundary, an expected 4K lookup stays below it.
  Context pressure alone does not justify a checkpoint.
- With speculation off and compaction at 170K, compare against 170K instead.
  With all compaction off, there is no compaction boundary to cross; the context
  window still limits retained exploration.

These numbers guide the agent, not an automatic checkpoint or compaction trigger.
An active checkpoint still forbids nesting and MUST rewind before yielding,
regardless of occupancy.


## Inputs

| Field  | Type     | Required | Description                                                                                                                                        |
| ------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal` | `string` | Yes      | Investigation goal. Required by the schema and echoed unchanged in the tool result; the implementation does not trim it or reject an empty string. |

## Outputs

The tool returns a single text result plus structured details:

- text body:
   - `Checkpoint: <goal>`
   - `Finish exploration and formulate findings.`
- `details`:
   - `goal: string`
   - `startedAt: string` — ISO timestamp created inside `CheckpointTool.execute()`

No checkpoint ID, artifact URI, job handle, file path, or restore token is returned.

## Flow

1. Tool registration in `packages/coding-agent/src/tools/index.ts` enforces `checkpoint.enabled` and the top-level/explicit-subagent visibility rules. `CheckpointTool.createIf()` itself always constructs the tool.
2. `CheckpointTool.execute()` rejects nested checkpoints with `ToolError("Checkpoint already active.")` when `session.getCheckpointState?.()` is already set.
3. It creates `startedAt = new Date().toISOString()` and returns a normal `toolResult()` payload. The tool method itself does not mutate checkpoint state.
4. On successful checkpoint `message_end`, `AgentSession` synchronously captures:
   - `checkpointMessageCount` — current `agent.state.messages.length`, after the checkpoint tool result has already been appended
   - `checkpointEntryId` — initially `null`, then backfilled with the persisted checkpoint tool-result entry's own ID by message identity
   - `startedAt` — copied from tool details or regenerated
5. It clears `#pendingRewindReport` and `#lastCompletedRewind`, and queues a hidden `checkpoint-active-reminder` as steering before any awaited work. That reminder reaches the next provider call and is persisted after the checkpoint entry; rewind's branch cut removes it.
6. On resume, session switch, or tree navigation, `#rehydrateCheckpointRewindState()` scans the current persisted branch. A most-recent successful checkpoint without a later retained rewind report reconstructs the active checkpoint boundary and guard.

## Side Effects

- Session state (transcript, memory, jobs, checkpoints, registries)
   - Sets `AgentSession.#checkpointState` in memory.
   - Records the checkpoint boundary as a message count plus the persisted checkpoint tool-result entry ID.
   - The ordinary successful tool-result entry is enough to reconstruct an unfinished checkpoint after resume; there is no separate checkpoint-marker entry.
   - Enables the later settle guard: if a checkpoint is active and no rewind report is pending, `#enforceRewindBeforeYield()` injects a developer-role warning and schedules another turn.
- User-visible prompts / interactive UI
   - The tool prompt and hidden checkpoint-active reminder tell the model to call `rewind` after the investigation.
   - If the agent tries to `yield` first, `AgentSession` injects:

```text
<system-warning>
You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.
</system-warning>
```

## Limits & Caps

- Availability is gated by `checkpoint.enabled`, default `false`.
- Only one active checkpoint is allowed per session or subagent.
- Subagents require an explicit requested-tools entry; requesting either checkpoint tool auto-includes its sister.
- Checkpoint state is not persisted as a dedicated entry. It is reconstructed from the successful checkpoint tool-result entry on the active branch, including after process resume.
- Session persistence applies to the ordinary checkpoint tool-call/result messages. Global session persistence truncation is `MAX_PERSIST_CHARS = 500_000` in `packages/coding-agent/src/session/session-persistence.ts`.

## Errors

- `ToolError("Checkpoint already active.")` — thrown when a prior checkpoint has not been rewound or cleared.
- The tool body has no local `try/catch`; unexpected exceptions propagate.

## Notes
- Checkpoint saves conversation state, not a git or filesystem snapshot.
- Captured state is conversation/session metadata only:
   - in-memory message count
   - persisted checkpoint tool-result entry ID in the session tree
   - timestamp
- Not captured:
   - working tree contents or staged changes
   - artifacts or blob-store contents
   - SQLite prompt-history rows from `packages/coding-agent/src/session/history-storage.ts`
   - auth or agent records from `packages/coding-agent/src/session/agent-storage.ts`

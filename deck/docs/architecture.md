# Architecture

## High level

```
Browser tabs (Vite dev :5173 · Bun prod :1701)
   │  WS frames (subscribe / prompt / abort) + REST control plane
   ▼
Bun server  (apps/server)
   ├─ AgentBridge interface
   │   └─ InProcessAgentBridge → @oh-my-pi/pi-coding-agent SDK
   │       └─ Map<sessionId, AgentSession>
   ├─ Hono REST router  /api/{health, sessions, tasks, routines, inbox,
   │                         settings, models, marketplace, bridges, slash-commands, fs}
   ├─ Bun.serve WebSocket hub  /ws
   ├─ BroadcastBus (non-session frames: tasks_changed)
   ├─ MarketplaceService (lazy SDK MarketplaceManager wrapper)
   ├─ BridgeSupervisor (telegram and future messaging bridges)
   ├─ Routines runner (croner)
   └─ Static file serving for the built web bundle
```

```
apps/bridges/telegram (standalone Bun process — only when started)
   ├─ Long-poll Telegram API
   ├─ Per-chat session map (SQLite)
   ├─ Deck REST + WS client (talks to the deck like any other client)
   └─ Supervised by the deck's BridgeSupervisor
```

## Workspaces

- **`apps/server`** — Bun + Hono backend. Embeds the omp SDK.
- **`apps/web`** — Vite + React + Tailwind frontend. Pure consumer of the WS
  event stream; reduces events into a structured `SessionUi` in
  `lib/reducer.ts`.
- **`apps/bridges/telegram`** — Standalone Bun process. Independent
  package, depends on `@npi-deck/protocol` for shared types.
- **`packages/protocol`** — Dep-free shared types (REST + WS frames + DB
  shapes). The contract layer.

## The `AgentBridge` interface

`apps/server/src/bridge/types.ts` defines the contract. Current impl is
`InProcessAgentBridge` which embeds the SDK in the same Bun process. A
future subprocess-per-session impl (`omp --mode rpc` over stdio) can drop in
behind the same interface — useful when you want crash isolation per session
or to run sessions on different machines.

Routes never import `@oh-my-pi/pi-coding-agent` directly. Everything
sessions-related flows through `AgentBridge` or `SessionHandle`.

## Mixtures of agents

NeoPi owns mixture parsing, resolution, validation, persistence and execution.
`apps/server/src/mixtures-service.ts` (routes in `routes-mixtures.ts`) lists
every `MIXTURES.toml` on NeoPi's search path for a known workspace, addressed
by opaque ids, and validates drafts through the `mixture-config` manifest
feature. `mixture-files.ts` reads and writes those files without following
links (temp file + rename in the expected directory). A save holds NeoPi's
cross-process file lock across the hash compare, write and read-back, then
calls `AgentBridge.refreshMixtureRoster(cwd)`, the only place the deck
replaces a workspace's mixture roster. The bridge otherwise leases a
workspace scope per request (picker listing, chat creation, model switch) and
re-validates the chosen mixture under the chat's settings.

The web side keeps the chat's trace cards (`reducer.ts`) and the inspector's
MoA panel (`mixture-reducer.ts`) on the same `mixture_*` events. The routine
canvas and the mixture flowchart share `components/graph/GraphCanvasSurface.tsx`
for React Flow chrome only; each keeps its own nodes, edges and semantics.

## Frame model

The WS hub maintains:

- **Per-connection subscriptions** — `Set<sessionId>` per WS. Used to
  forward `session_event` frames + per-session bridge frames (UI dialog,
  plan-mode, subagent tree).
- **A global connection set** — `Set<ServerWebSocket>`. Used for broadcast
  frames (`tasks_changed`, `skills_changed`, `kb_changed`, `heartbeat`,
  `notification`) sent to every open client.

The `BroadcastBus` singleton (`apps/server/src/broadcast-bus.ts`) is the
producer side. Routes (`routes-tasks.ts`, `routes-skills.ts`, …) and deck
slash commands (`deck-slash-commands.ts`) call
`broadcastBus.broadcast(frame)`. The hub subscribes once at construction
and relays to every open connection.

Each in-process root subscribes to its own NeoPi `subagentEventBus` and joins
task lifecycle/progress/event updates to the global `AgentRegistry` parentId
chain. Only descendants of that root generation enter its `subagents_snapshot`
frames. `GET /api/subagents/:sessionId/:id/transcript` reads the child JSONL
incrementally; `POST /api/subagents/:sessionId/:id/abort` aborts the exact
registered session and tombstones its ref. Both reject another session's child
with 403. These routes do not resume parked agents or spawn a session while
browsing. Subagents remain visible in the chat's collapsible read-only panel
after completion; cross-process sessions are not part of this feature.

## Synthetic events

"Synthetic" event flavors flow over the same WS as the SDK's own events,
dispatched by the deck-side bridge code so the UI can react without
custom plumbing per feature:

- **`context_usage`** — emitted after every turn-end or compaction so the
  context indicator updates without a re-snapshot.
- **`session_updated`** — emitted after `session.setModel()` so the chat
  header's model label flips immediately.
- **`todo_phases_set`** — emitted after every `todo_write` tool result so
  the Inspector TodoPanel reflects intra-turn changes (the SDK's own
  `todo_reminder` only fires on reminder ticks — typically at turn
  boundaries — leaving the panel stale between cycles).
- **`prompt_queued`** + **`queue_state`** — emitted by the bridge's shadow
  queue when the user sends a prompt while streaming. `queue_state`
  re-broadcasts the canonical queue after every queue mutation (queue,
  cancel, edit, drain) so clients replace `queuedPrompts` wholesale.
- **`plan_mode_changed`**, **`plan_proposed`**, **`plan_proposal_resolved`**
  — plan-mode lifecycle. Pending proposals are replayed to late
  subscribers so a page reload during approval re-renders the card.
- **`ext_ui_dialog_open`** + **`ext_ui_dialog_cancel`** — `ask` tool +
  arbitrary `ctx.ui.*` extension calls. Replayed to late subscribers
  similarly.
- **`message_start` with `synthetic: true`** — emitted by both the SDK
  slash dispatcher and the deck slash dispatcher to inject the user's
  typed command + the handler's output into the transcript. The reducer
  ingests these as regular messages; the UI shows a `SYNTHETIC` badge.

The reducer (`apps/web/src/lib/reducer.ts`) handles each from a single
union case. No special protocol fork.

## Database

SQLite via Bun's built-in `bun:sqlite`. WAL mode, foreign keys on.

The shared connection owns every statement returned by `query()`, including
migration bookkeeping, initial seeding and DAO mutations. Its SQL-keyed cache
has no eviction: callers can retain a statement across transaction callbacks
or loops without it being finalized underneath them. The key space is the
finite set of SQL strings generated by the data layer; user values stay in
bound parameters. This avoids Bun's native 20-query cache limit, after which
new queries otherwise depend on GC for finalization.

Closing explicitly finalizes the connection's query cache before a strict
native close. The singleton is cleared only after close succeeds. Deliberately
uncached `prepare()` statements remain the caller's responsibility and must
be finalized before closing. Teardown removes database directories only after
that resource barrier, without forced GC, ignored errors or removal retries.

Schema lives in `apps/server/src/db/migrations/*.sql`. Migrations are
filename-sorted and applied at boot; a `schema_migrations` table records
which ones have been applied.

Tables:

- `schema_migrations` — applied migrations.
- `task_states` — kanban columns. Configurable.
- `tasks` — backlog/active/blocked/done items. `display_id` for human IDs (`T-1`, ...).
- `inbox_items` — quick captures + promote-to-task records.
- `routines` — cron / webhook / manual / event definitions: V0 single-action, V1 direct `RoutineSpec` TOML in `spec_toml`, or V2 native graphs in `graph_json`. The additive TOML column leaves legacy `spec_yaml` intact as read-only import provenance.
- `routine_runs` — per-run history with status, duration, total cost, pinned NeoPi backend identity for agent steps, and immutable V2 execution traces in `graph_run_json`.
- `routine_step_runs` — per-step records inside a V1 run (stdout / stderr excerpts, JSON output, model, tokens, cost, retry attempt).
- `routine_state` — cross-run persistent state per routine, addressable from the templating engine.
- `bridge_state` — supervised bridge process records (currently Telegram).
- `env_settings` — masked secret store backing Settings → Env (atomic writes paired with `env-audit.log`).
- `sequences` — monotonic counters (currently just `tasks`).

On first boot against an empty `tasks` table the deck seeds a single
"Welcome to npi-deck" backlog task — see `apps/server/src/db/index.ts`
`seedWelcomeTaskIfEmpty`.

### One-shot routine conversion

At startup, valid legacy V1 YAML is imported losslessly into `spec_toml` once;
first reads also import legacy rows added after startup. Invalid or unsupported
values leave both the original YAML and any existing TOML unchanged and produce
source-free diagnostics. All V1 API writes, execution parsers and bundled
`.toml` templates use the shared TOML codec; the browser binds `smol-toml` and
the embedded server binds Bun's TOML parser. YAML parsing is import-only.
Explicit nested null values use reserved `[__npi]` metadata with `version = 1`
and JSON Pointer `null_paths`; callers validate and execute the decoded direct
`RoutineSpec`, never a wrapper. Empty strings and absent keys stay distinct.
Legacy YAML comments are carried into the TOML preamble when their original
table association cannot be preserved; the original YAML also remains exact.
Subsequent TOML edits patch the source rather than discarding those comments.

YAML-only user templates import on first listing or install into atomic,
no-clobber `.toml` siblings with the source permissions. Original `.yaml` and
`.yml` files remain untouched. Existing TOML always wins, with a warning even
when a legacy sibling is malformed; edits to the old file never replace TOML.

`GET /api/routine-migrations` inventories raw database columns and TOML, not
the normalized routine reader. `POST /api/routine-migrations/:id` explicitly
converts one supported original in place. Neither listing, server startup nor
conversion invokes an action. Active or queued routine work blocks the API
operation. A blocked original remains enabled or disabled exactly as it was.

Before the first changed row, conversion serializes the complete SQLite
database, including committed WAL pages, into `routine-migration-backups`
beside the configured database. The directory is owner-only and snapshots
are mode 0600. A temporary file, file fsync, rename and directory fsync publish
the snapshot before any definition changes. Backups contain credentials and
must not be attached to issues, ordinary reports or exports.

The `routine_graph_conversions` journal saves the raw row, converted graph,
source digest and backup path in the same transaction as the definition.
Routine ids, enabled state, timestamps, schedules, state, credential
registrations and historical relationships are not rewritten. A converted
row has `spec_version=2`, `graph_json` populated and `spec_toml=NULL`; its legacy `spec_yaml` is untouched. Execution
never consults the original backup. Repeating conversion after restart is a
no-op for a native row.

Reports identify each original by digest and exact field path without
including its value. Supported fields have a native configuration or
unchanged metadata mapping. Informational state declarations and visual
legacy edges remain in the protected original. Those visual edges do not
become executable connections. Semantic TOML export does not reproduce source
comments, formatting or key order, which the report names as a syntax loss.
The raw snapshot retains them exactly.

Conversion supports V1 `run`, `write`, `http`, `deck`, `mcp`, `transform`,
`wait` and `set_state` actions. The production registry validates every
mapped `step.*` node against the existing action schema. Unknown fields
remain blockers. No YAML is read by native execution.

Converted V1 graphs use `execution.mode = "routine-v1"`. Their `completed`
connections continue after a skipped condition or a deliberately continued
failure. The separate `result` port contains only an actual successful
action value. Completion retains that result and the original upstream
input envelopes. Failed and skipped steps never manufacture result values.
The native trace keeps skipped status, failed status, each retry attempt,
stdout, stderr and errors. Diagnostics project the original `steps.<id>`
context, including failure details.

`when` uses the same bounded expression evaluator and truthiness as V1.
Evaluation errors skip the step, and an empty expression is not evaluated.
Exact-value gates remain available for graph routing, but they cannot replace
this expression/error-skip/continue contract. Retry `times` counts total
attempts, with the original linear or exponential delay, delay cap and
`after_retry` behavior. Cancellation interrupts retry delay and active work.
The native routine-v1 budget mode counts dispatched attempts, including
failures and retries, not sources or skipped conditions. It checks the
original strict-greater-than caps after each attempt. A duration cap bounds
the active attempt's remaining timeout, preserving timeout precedence over
budget and cancellation causes. All usage fields retain their actual reported
values. Ordinary native graphs keep their existing node-count budgets.
Run history counts final dispatched steps, failed final steps and final
stdout like the original V1 runtime.

Manual declarations, including arbitrary `params_schema` values, survive in
the source's `manualTriggers` array. They remain informational because the
original manual API does not enforce schemas. Event declarations survive in
`eventTriggers` on one generic `event` source. Explicit event admission
remains available; conversion does not invent subscriptions or evaluate
filters that the original runtime never consumed. Duplicate declarations
share one source so they cannot execute a step twice.

Webhook sources use `config.webhook.path` and the existing signed-delivery
admission. Conversion never creates, moves or rotates a credential.
Orphaned or divergent registrations and multiple webhook declarations stay
blocked. Native saves, explicit rotation, refusal of bare secrets and status
reads use the existing credential-management rules.

V0 `bash` and `script` rows convert to `process.v0`, with
`execution.mode = "routine-v0"`. The original process helper supplies the
exact argv, whitespace splitting, lack of interpolation, cwd fallback,
output clipping and ten-minute runtime limit. Original stdout, stderr and
exit codes remain in run history. `prompt` stays blocked because it starts
an agent.

Disabled routines still admit explicit manual runs. The shared `set_state`
handler refreshes active state only after persistence succeeds, and queued
expression clocks start at execution admission.

Agent steps, malformed or divergent source data, duplicate ids and ambiguous
write cwd overrides remain blocked. The bundled census can now convert;
the daily briefing still needs native agent support from neopi#11.
MCP schemas and configuration can migrate, but live MCP equivalence is not
established by these tests.

`GET /api/routine-migrations/:id/:sourceDigest/export` returns the original's
semantic TOML for one-shot round trips, only while its native definition is
unchanged. V0 export contains its original single-action request fields,
`version = 0` and raw concurrency/budget/timezone/tag columns in `metadata`;
V1 export contains the original semantic spec. Neither is an authoring
source. `POST
/api/routine-migrations/:id/:sourceDigest/restore` restores that definition,
refusing later native or metadata edits. State and history remain as they
are; restoration never claims to undo external actions. For a complete
point-in-time rollback, stop the server, preserve the current database and
its WAL/SHM files separately, replace the database with the protected snapshot
and remove the old WAL/SHM files before restarting. A full rollback also
rewinds unrelated database changes since the snapshot.

This is not the completed #163 graph-runtime cutover. V0/V1 execution and the
linear builder/compiler still serve unconverted callers and rows, but V1
authoring and execution source are now TOML. YAML is retained only as read-only
import provenance. Studio TOML documents in `studio_graphs` are a distinct model;
conversion here targets the executable `/api/routines` native graph, not a
lossy copy into Studio. Pre-TOML conversion journals remain restorable: their
exact protected YAML is recovered and imported into canonical TOML without
rewriting the journal or running an action.

## Native routine graphs

`packages/protocol/src/graph.ts` owns the shared V2 contracts. A `RoutineGraph`
contains typed nodes, named input/output ports and directed edges; its JSON,
not TOML or canvas layout, is the execution source of truth. Port types are
`object`, `array`, `string`, `number`, `boolean` and `null`. `object` is the
general type: narrower outputs may connect to it, but a general output cannot
connect to a narrower input. Required inputs and single/multiple cardinality
are validated before persistence or dispatch, together with node configuration.

`GraphNodeRegistry.register({ definition, execute })` registers one node type.
The definition supplies its ports and optional configuration JSON Schema;
`execute(context)` returns named `{ port, value }` emissions, synchronously or
asynchronously. `GraphNodeContext` provides the node, ordered
`{ port, edgeId, output }` inputs, activation, run ID, abort signal and incremental
usage reporting. Handlers must cooperate with the abort signal; settled handlers
cannot report later usage. Validation, execution and the HTTP catalogue use the
same registry. `RoutinesRunner.graphRegistry` is the registration point for
subsequent node catalogues.

Every emitted `GraphOutput` contains `{ nodeId, port, result, inputs }`. Object
results and input envelopes retain their original in-memory objects; scalar,
null and array values reside in `result.value`. `inputs` preserves incoming edge
order and recursively retains upstream envelopes. Only an emitted port activates
its connected branch: `1`, a truthy string and literal `true` remain different
values. `readGraphPath(output, path)` traverses own keys, and
`findGraphOutput(output, nodeId, port?)` finds the nearest upstream envelope in
stable input order.

`GraphActivation` carries an `eventType`, the original event object and an
optional selected source node. The built-in `event.source` emits that event
through its `event` port; one activation runs each matching source once.
Unselected sources and disconnected branches produce skipped records, not
invented values. Execution is a deterministic DAG; gate and operation catalogues,
external actions, iteration and canvas authoring have their own slices and do not
change this envelope contract.

Create and update through `POST /api/routines` and
`PATCH /api/routines/:id` with `graph`, and execute through the existing run
endpoint. `GET /api/routine-node-types` returns the shared catalogue;
`POST /api/routine-graphs/validate` rejects invalid connections before saving or
running them. Native graphs reject legacy action/TOML-pipeline authoring fields.
`GET /api/routines/:id/runs/:runId/graph` returns a `GraphRunRecord`, including
the executed definition, activation, ordered node records, outputs, status and
usage. Final traces and existing run aggregates persist atomically. Before
persisting a trace, the trigger-payload credential-key policy redacts values
within activation events, node configurations and output results, including
recursive provenance. Execution still receives the original objects; structural
fields such as token budgets and usage counters are not redacted. Later edits
do not replace a historical trace; reopening the database preserves the stored
JSON values and recursive provenance.
Trace serialization has an 8 MiB conservative byte budget, charged during
expansion of every recursive envelope occurrence. Oversized traces are not
stored or served; run history instead records a terminal serialization-budget
failure while retaining execution usage and step aggregates. No partial or
truncated provenance is presented as a complete trace.
Trace nesting is bounded at 256 levels during serialization, independently of
the JavaScript engine's stack behavior. Other JSON serialization failures use
the same terminal-history path without discarding execution aggregates.
History error excerpts are capped at 8,192 characters, including the diagnostic.

Studio's Flows section opens native routines in the existing canvas. New flows
start as V2 JSON. Palette entries, typed handles and configuration fields consume
the production registry, with shared connection validation during authoring and
server configuration validation before saving or running. Incomplete local drafts
can be wired progressively; saved executable graphs must pass full validation.
Source view deliberately exposes the same native JSON, not generated TOML.
Existing legacy routines retain their editor until explicit migration.

The Runs panel and node inspector read the selected run's `trace.graph`, never
the current draft. Expandable result and input trees retain output occurrences,
consuming ports and iteration addresses. Successful executions with no emissions,
inactive branches, failed nodes and aborted nodes remain distinct. Connection
associations reconstructed from a snapshot are marked as derived; unavailable
associations are not guessed. `GET /api/routines/:id/runs/:runId` retrieves a run
directly, including older runs outside the recent-summary limit. Both run and
trace endpoints verify routine ownership. Full traces finalize at completion;
running, missing-completed and failed-fetch states are shown separately.

`POST /api/routines/:id/preview` returns a transient `GraphRunRecord` from the
production executor with `dryRun: true`. Its body is a `GraphActivation` selecting
an actual source and a sample event, or `{}` for a manual event with a generated
identity. Each preview has a transient operation identity unless the caller
supplies one. It does not create a run row, update schedules, claim inbox
deliveries, reserve effects or dispatch actions. Response serialization shares persisted
traces' credential redaction, size and depth bounds. Preview caps the copied
graph at 120 seconds and 10,000 executed nodes, or its lower configured limits.
The trace includes those effective controls and remains in the current editor
session, not durable history. The existing `/run` endpoint still admits a manual
event and returns HTTP 202; it does not let a caller turn a manual run into an
inbox delivery. Enabled inbox sources run when a new capture is committed.

Studio's TOML graph documents remain a separate `/api/graphs` store. Editing a
native flow does not translate or merge those documents.

### Inbox intake

Fresh navigation opens Inbox (`/inbox`); Chat is `/chat` and Kanban remains
available at `/tasks`. Explicit deep links and the first-run onboarding gate
keep their meaning.

The production registry includes `inbox.card_added`, labelled **inbox: card
added**, with no inputs, an object-valued `event` output and a config schema
requiring `{ "eventType": "inbox.card_added" }`. A generic `event.source` with
that event type can subscribe too. Wire its output to ordinary registered graph
operations/actions; intake is not a separate kind-specific classifier or filing
pipeline. Model operations report actual usage through `recordUsage`.

`db/inbox.ts::createInbox` commits the card and its `inbox_graph_events`
deliveries in one transaction. The card snapshot includes all currently
persisted inbox properties (including an empty body/source and TOML in the body).
Each enabled native flow/source configured at creation gets one durable delivery,
keyed by `(card id, routine id, source node id)`. No title/body deduplication is
used. Transaction rollback drops both the delivery and its after-commit wakeup;
HTTP idempotency receipts therefore cannot produce an extra event. Internal
deck creation and graph-created cards use the same boundary, with a new card ID
for each genuine new card. Reads, edits, promotion, processing, deletion and
websocket refreshes do not emit creation events.

After commit, the runner calls `fireGraphEvent`, selecting each intended source
explicitly. Notification payloads only identify the delivery: execution reads
the original committed snapshot, not a subsequent edit or caller replacement.
Admission atomically claims the durable delivery and starts its run before any
async graph work. Replays and concurrent notifications cannot start a second
run. The existing enabled-state, concurrency, cancellation and graph-budget
controls apply, including visible concurrency-skipped/aborted runs; admission
is not a claim that filing or any downstream effect succeeded.

Restart drains only committed **pending deliveries**, never an inbox list.
Disabled flows get no deliveries for new cards; deliveries whose source was
removed, changed or disabled before dispatch are discarded, not held until
re-enable. Already admitted work is **not retried** after a crash because an
external effect may have happened: the interrupted run becomes visibly aborted
with `server_restarted`, its admitted graph/activation snapshot, and no invented
node results. Per-source receipts remain even when an inbox card is deleted.
This is at-most-once admission, not a promise of exactly-once external effects
or completion across a crash; individual action nodes own effect receipts.
### Native action nodes

The production catalogue includes `action.create-card`, `action.send-message`
and `action.file-issue`. Each accepts multiple generic `in` envelopes and emits
one `result` envelope. Its config is `{ request: { ... }, operationId?: ... }`.
Request fields can be literal JSON or explicit envelope bindings, for example
`{"$from":{"nodeId":"source","path":["result","title"]}}`. Bindings can select
an upstream port or incoming `inputPort`; missing paths fail rather than
silently becoming empty strings. The action result holds `status`, `logicalKey`,
`replayed` and a real `receipt`; original inputs remain in the executor's
recursive envelopes, including on failure or cancellation.

- Create-card requests support `title`, `body`, `stateId`, `cwd`, `properties`,
  `orderInState` and `archived`. Leading TOML and arbitrary stored properties
  survive; execution properties (`read-only`, `worktree`, `model`, `role`) use
  the same validation as card execution. Unknown top-level properties fail.
  The receipt is the persisted card, including id/displayId and parsed front
  matter. Creation, requested ordering/archive and journal confirmation share
  one DB transaction. `cwd` is not a linked-worktree declaration.
- Send-message requests use `{destination: "<registered channel id>", payload:
  {kind, level, title, ...}}`. Only one explicit destination is addressed.
  Current kinds are `routine_failed`, `task_shipped`, `auth_fallback`; disabled,
  missing and rejecting destinations fail visibly. Browser delivery confirms
  fan-out dispatch, **not** provider acceptance or recipient reading. A channel
  may return an accepted receipt with a native identity. Telegram is not
  implicitly available as a server notification channel.
- File-issue requests require explicit `host`, `owner`, `repo`, `title`, `body`;
  optional `labels`, `assignees`, numeric `milestone` and
  `attribution: {agent, onBehalfOf: "PsychedelicShayna"}` are supported. Existing
  `gh` authentication is used, never tokens in graph config. GitHub bodies
  retain valid agent attribution or receive NeoDeck's Captain attribution.
  A hidden operation marker enables read-only reconciliation. Acceptance
  requires the native issue id, number, URL and matching repository; mere
  command completion is insufficient. No classifier/repository policy is built
  into the action.

`GraphActivation.operationId`, config `operationId`, or the original `event.id`
(including `event.card.id`) supplies stable logical identity. Actions reject
events without one: a new run/time is never evidence of a new intended write.
The key scopes routine, action node, event type and operation; its immutable
fingerprint covers the complete resolved request and destination. Replaying
with changed content/destination fails. An intentional repeat needs a new
operation identity. Reservations and receipts persist in `graph_actions`
independently of run success. Concurrent same-process dispatches await the
same settlement; interrupted remote reservations remain uncertain, never
blindly retried. GitHub can reconcile a matching marker using search plus
native identity lookup; a missing search result does not authorize retry.
Providers without an idempotency/reconciliation API cannot promise exactly
once. Definitive rejection and not-dispatched results are distinguished from
uncertainty. A new operation identity is required to try a failed logical
write again.

Native `POST /api/routines/:id/run?dryRun=true&operationId=<stable-id>` resolves
and validates the same requests but records planned effects only: no card
mutations, message sends, writing `gh` calls, fake target identities or live
reservations. `RoutinesRunner.fire`/`fireGraphEvent` and `executeGraph` expose
the same `dryRun` option. Traces identify simulation with `dryRun: true`.
Simulation starts a separate trace before live event admission and must never
claim or discard a pending inbox delivery. When integrating inbox intake (#204),
forward `dryRun` through event activation, bypass live intake filtering/discard
for simulations, and keep `admitInboxGraphEvent` exclusively after the simulation
guard. A later live call must still admit the committed delivery exactly once.
After possible remote dispatch, abort can settle the run while the provider
operation continues. Its journal starts uncertain before dispatch; a late
native receipt updates durable evidence without waking downstream nodes.
The trace endpoint hydrates that effect evidence while retaining the run's
aborted/failed status. Credential-key redaction also covers stored requests
and receipts. Downstream action bindings receive that same privacy-safe receipt
on first execution and replay, including redacted card front matter. The
created card itself retains its requested properties; receipt bindings do not
expose credential properties from it.

Bounded/nested iteration belongs to #159 and is not implemented by this action
slice. Its per-occurrence identity and dry-run propagation must be added with
that executor; do not reuse one operation identity for distinct iterations.


## Theming

CSS custom properties on `<html data-theme="…">`. Tailwind reads each
color token through `rgb(var(--token) / <alpha-value>)`. An inline script
in `apps/web/index.html`'s `<head>` applies the saved theme **before**
React mounts to avoid flash-of-default. Full reference in
[docs/themes.md](./themes.md).

## Stores

The web frontend uses Zustand (`apps/web/src/lib/store.ts`) as the single
source of truth for sessions, WS connection, workspace metadata, and the
`tasksChangeCounter` that drives live kanban refreshes.

The TasksView, RoutinesView, and InboxView own their own local fetches and
caches — they subscribe to relevant change counters or refetch on mount.
Chat is fully store-driven because it needs cross-session state.

## Build outputs

- `apps/web/dist/` — production static bundle. Served by the deck server
  when `NPI_DECK_WEB_DIST` resolves to it (auto-detected).
- `apps/server/dist/` — `bun run build` also bundles the server
  (`bun build --target=bun`): `index.js` plus `structured-output-worker.js`,
  the worker thread that validates routine structured output, which must
  stay beside `index.js`. Nothing runs that bundle: the `npi-deck`
  launcher, `bun run start` and `bun run dev` all run
  `apps/server/src/index.ts` from source.

## Where omp lives

The deck typechecks against NeoPi's workspace packages in the same repository.
At runtime it loads the source tree selected by `NPI_DECK_BACKEND` or
`activeBackend` in `~/.npi-deck/config.toml`. Point that selection at the repository
root to run the in-tree NeoPi. The deck reads from:

- NeoPi's agent dir (`getAgentDir()`, default `~/.omp/agent/`; `PI_CODING_AGENT_DIR` overrides) — sessions JSONL, auth.db,
  marketplaces.json, installed_plugins.json.
- The SDK's in-process `ModelRegistry`, `SessionManager`, `Settings`,
  `MarketplaceManager`, `BUILTIN_SLASH_COMMANDS_INTERNAL`,
  `ACP_BUILTIN_SLASH_COMMANDS`, and friends.

The deck never re-derives state the SDK already knows about — it calls
through.

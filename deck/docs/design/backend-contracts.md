# Backend contracts the new deck designs against

Every domain in `apps/web/src/neo/client/` has a typed client with a `live`
adapter (existing deck endpoints) and a `preview` adapter (in-memory
fixtures that mutate, so the page is fully interactive). The registry in
`client/source.ts` says which is in use per domain, with the reason. This
file is the contract a backend implements to flip a domain to `live`; the
TypeScript shapes in the client files are authoritative, and the fixtures
are the examples.

Vocabulary shared with NeoProxy (`NeoProxy/docs/design/backend-contracts.md`):
a **virtual model** is `neoproxy/<name>` (`default`, `small`, `heavy`, `live`
are virtual models, not a separate "role" object); its **chain** is a list
of **stages** `{ model, accounts, draw, perAccount, cap, window, per, effort }`
joined by "demote", ending in a **terminal** `{ kind: limit | queue |
passthrough, message }`; an account's grant carries an `allotment` (0..1)
that scales every budget. NeoDeck's "hidden from pickers" is local to the
deck (still served); NeoProxy's `exposed: false` removes a provider.

## 1. Auth and accounts (`auth`, `accounts`)

- `POST /api/auth/login` `{ handle, password }` → `200 { account: Account, token }`, `401` on mismatch. Cookie or bearer; the client sends nothing extra.
- `GET /api/auth/me` → `{ account }` or `401`. `POST /api/auth/logout` → `204`.
- `GET /api/accounts` (admin) → `{ accounts: Account[] }`; `POST /api/accounts` `{ handle, name, password, role, models }`; `PATCH /api/accounts/:id` `{ name?, role?, models?, allotment?, password? }`.
- `Account { id, handle, name, role: "admin"|"member", hue, roles: string[], allotment?: number }`; `roles` are the virtual models (`neoproxy/<name>`) the admin granted the account.

## 2. Classifier and inbox history (`classifier`, live)

- `GET /api/inbox/routing` → `InboxRouting { classifier, flows, columns, defaultColumn, destinations }`. The classifier names the current handler; flows list the actual routine inbox subscriptions, including disabled subscriptions. Only enabled subscriptions receive new captures. A saved Studio classifier document is not an active inbox subscription.
- `GET /api/inbox/:id/proposal` → `InboxProposal { itemId, kind, destination, confidence, reason, classifier: "manual" }`. The live adapter preserves the capture's chosen kind and proposes the board's configured default column without inferring a project. Confidence is zero because no model classification occurred. The interface does not display this as a model certainty score.
- `POST /api/inbox/:id/file` `{ destination }` → `{ receipt: { kind, ref, url, label } }`. Board filing creates the card, records its inbox origin, stores the receipt and marks the item processed in one transaction. Repeating the same destination returns the receipt; a different destination returns `409` instead of duplicating a card. `card{project,column}` uses a working directory or an empty string for unassigned, and an actual column ID or exact column name.
- GitHub issue filing reuses the native `action.file-issue` implementation, including its stable operation marker, provider journal and uncertain-acceptance reconciliation. `issue{repo}` requires `owner/repository`; the actual issue uses this server's existing GitHub login. A destination reservation preserves the original capture across retries and blocks a racing board filing while acceptance is unresolved.
- `POST /api/inbox/:id/file` `{ destination: issue{repo}, dryRun: true }` → `{ plan: { destination, title, body } }`. Preview validates the same action request but creates no issue, no provider journal entry, no reservation and no processing update. The interface offers this separately from **File issue**.
- `GET /api/inbox/:id/history` → `{ events: { at, actor, text, url?, receipt? }[] }`. History includes capture, persisted filing receipts, legacy keyed promotion receipts, processing state and queued/running/completed routine delivery records. It survives a server restart.
- Destination shapes remain `card{project,column}`, `issue{repo}`, `thread{agent}`, `note{path}`. Thread and note destinations return `501` with a reason and leave the item untouched. Agent-template instantiation needs the NeoPi contract; knowledge writes deliberately require a project agent's `kb_write` capability. The inbox lists these restrictions instead of simulating a successful write.
- Model-driven suggestions remain unavailable, explicitly separate from the live manual proposal and filing contract. The required NeoPi inference and agent-instantiation contracts are recorded in the pool's upstream-needs handoff. No title-keyword fixture classifier runs in the live interface.
- Captures support multiline Markdown bodies and PNG/JPEG/GIF/WebP image attachments through the existing `POST /api/uploads/image`, up to 10 MB each.

## 3. Presence (`presence`)

- `GET /api/presence` → `{ needsYou, working, inReview }`; also pushed on the websocket as `presence` frames.

## 4. Threads with several agents (`threadAgents`)

The native instance is the unit of identity. Main is an ordinary depth-zero instance, and a template never has a lifecycle state. `AgentTemplate` and `AgentInstance` in `packages/protocol/src/agents.ts` are the shared wire types.

- `GET /api/threads/:id/agents` → `{ agents: AgentInstance[], capabilities }`. Requires a live session; browsing this endpoint never resumes one. Includes Main and owned native children and observers. A persisted thread must be resumed before its runtime roster is available.
- `DELETE /api/threads/:id/agents/:agentId` cancels an owned instance when its advertised `actions.cancel` permits it. For Main, cancellation aborts the current turn, not the session history.
- `POST /api/threads/:id/send` `{ text, to: instanceId }` steers an existing runtime when `actions.steer` permits it. Main must already be running; use the existing WebSocket composer to start a new Main turn. Child image steering is unavailable. Broadcast to `"all"` returns 501 until NeoPi's equal-participant conversation design is decided.
- `PATCH /api/threads/:id/agents/:agentId` `{ model }` updates Main through the native model selector when available. This SDK cannot mutate child models or arbitrary restrictions. Unsupported operations return explicit errors, never local cosmetic state.
- `POST /api/threads/:id/agents` returns 501. Native template instantiation waits for neopi#11. The aggregate `threadAgents` source stays preview; live runtime reads are separately marked `agentInstances: live`.

## 5. Agents, templates and the judge (`agents`, `agentTemplates`, `agentInstances`, `judge`)

- `GET /api/agents/instances` → `{ instances: AgentInstance[], capabilities }`. `GET /api/agents` returns the same native instances under `agents`. Lists live deck sessions and their owned native children. It does not invent card/routine instances, ownership, costs or usage the runtime has not reported.
- An instance exposes `id`, `templateId`, `sessionId`, optional `threadId` and journal `sessionFile`, `parentInstanceId`, `label`, lifecycle `status`, optional native `model`, `thinking`, task and timestamps, and `actions: { steer, cancel, setThinking, setFast, enter }`. An unavailable fact stays absent. Template identity is null unless native authority establishes it.
- `POST /api/agents/instances/:id/steer` `{ text }` and `POST /api/agents/instances/:id/cancel` act only on the instance's current native generation. `/api/agents/:id/stop` and `/api/agents/instances/:id/stop` also cancel. Parked children cannot be revived by steering.
- `GET /api/agents/templates` → `{ templates: AgentTemplate[], capabilities }`; `GET /api/agents/templates/:id`, `POST /api/agents/templates`, `PUT /api/agents/templates/:id`, and `DELETE /api/agents/templates/:id` persist **deck-authored** configuration in SQLite. Definition fields are `id`, `name`, optional `description`, opaque `model`, `thinking`, `tools`, `systemPrompt` and informational `preset`. Provenance is assigned by the server as `{ format: "deck" }`. A fresh database has no seeded definitions. These records are not installed into NeoPi and cannot be executed yet.
- `GET /api/agents/capabilities` distinguishes local template persistence, native instance listing, native definition discovery, spawn, restrictions and judge support. Native definition discovery needs `list_agent_definitions`; Deck does not read agent files as an alternate authority. Neither a model role such as `@default` nor today's advisor/task preset is an agent type.
- `POST /api/agents` and `POST /api/agents/instances` return 501, with the native spawn dependency explained. `PATCH /api/agents/instances/:id` and `/api/agents/:id` support Main's model updates under the same limits as thread updates.
- `GET /api/judge` → `{ available: false, reason }`; `GET /api/judge/events?limit=1..500` → `{ events: [], available: false, reason }`. No fleet judge exists in the pin. `PUT /api/judge` and `POST /api/judge/events/:id/undo` return 501. No fabricated judge events or `judge_event` WebSocket frames are emitted. Native TTSR judging is not a fleet judge.
- `agentTemplates` and `agentInstances` are live. Aggregate `agents`, equal-participant `threadAgents` and `judge` remain preview because their full capabilities are not backed.

## 6. Board evidence (`boardEvidence`)

Cards, columns and evidence are live (`/api/tasks`, `/api/task-states`).

- `GET /api/tasks/:id/events` → `{ events: BoardEvent[] }`; `BoardEvent { id, at, actor, text, tone? }`. Notes and card edits/moves are durable SQLite receipts. Assignment, start and result receipts come from every persisted run, including previous attempts. Older cards have a creation receipt; historical moves before this journal existed are not invented.
- `POST /api/tasks/:id/events` `{ text, actor? }` appends a note or agent handoff, then notifies open boards. Text is required and capped at 20,000 characters. It does not trigger inference or change the card's state.
- `GET /api/tasks/:id/links` → `{ issue?: { repo, number, url }, pr?: { repo, number, url }, thread?: { id }, flow?: { id, name } }`. Frontmatter `links` is authoritative for explicit references. GitHub URLs in instructions, notes and run output supply additional evidence. A URL is not proof of checks, review or merge.
- Card properties remain in frontmatter: `origin: inbox|github|thread|routine|manual`, `origin_ref`, `holder: { kind: "person", handle, name?, hue? } | { kind: "agent", id, name?, model?, hue? }`, `links`, and optional `parent` pointing to a task id or `T-N`. Related cards describe decomposition, not execution dependencies. They do not silently gate or launch one another.
- Task responses include `evidence?: { text, at }`, the latest stored activity. The UI uses persisted run identities, not a fictional worker roster.
- `POST /api/tasks/:id/assign` accepts `{ model? }`. A concrete selector or `@role:effort` overrides only this run; omission inherits the card/deck configuration. The selector is carried through to NeoPi, without resolving policy in the browser or rewriting card metadata.
- Board is an agent-managed content queue. Inbox is its capture door; people inspect assignments, linked work and receipts. Direct card creation, manual state changes and column editing remain explicit secondary controls. Automatic decomposition and native template spawning are not claimed.

Logic reference: [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent), MIT, especially its durable card/run/event separation and profile-based orchestration. No Hermes source code is copied into this implementation.

## 7. Studio graphs (`studioGraphs`)

Flows remain routines under `/api/routines`; the knowledge map is virtual. The
graph backend persists pipelines, classifiers and board flows as canonical TOML
in the deck database. The Studio client combines those lists without seeding the
server with example graphs. Existing browser-authored documents import once,
preserving their ids and leaving the browser copy intact.

- `GET /api/graphs` → `{ graphs: GraphSummary[] }` for persisted `pipeline | classifier | boardflow` documents, mirrored `flow` summaries and the virtual knowledge `map`. Router previews are combined by the browser adapter.
- `GET/PUT/DELETE /api/graphs/:id` → `StudioGraph { id, kind, name, description, enabled, nodes: { id, type, config, position }[], edges: { id, from: { node, port }, to: { node, port } }[], settings, lastRun?, updatedAt }`; `POST /api/graphs` accepts `{ kind, name }` or a complete browser-authored document. An existing id is never overwritten by POST. Drafts may be empty; connections must have compatible ports and cannot form cycles.
- `GET /api/graphs/node-types?kind=` → `{ nodeTypes: NodeType[] }`. The server and canvas share `packages/protocol/src/studio-vocab.ts`, exposed to the canvas by `apps/web/src/neo/pages/studio/vocab.ts`. Entries include typed ports, editable fields and `execution: "local" | "action" | "preview"`.
- `POST /api/graphs/:id/run` accepts `{ mode?: "preview" | "execute", input?: JSON }`. Missing mode always means preview. `GET /api/graphs/:id/runs` returns `{ runs: StudioRun[] }`, newest first, up to 100. `StudioRun { id, graphId, startedAt, endedAt?, ok, trigger, mode, costUsd?, nodes: { nodeId, startedAt, endedAt?, status, note?, output? }[] }`. Definition snapshots and node results survive edits and server restarts.
- Preview runs evaluate local text/JSON transforms and deterministic branches, then skip inference and output actions. Skipped work does not activate downstream branches. Timings are measured, not simulated; absent cost stays absent. Explicit execution supports local nodes, card creation/movement, inbox completion, notifications and GitHub issue filing through the existing action adapters. A graph containing any unsupported node is rejected before any action is sent.
- Preview accepts disconnected drafts. It runs only nodes reachable from a trigger and returns every other node as `skipped`, with its title/id and a connection note. A draft with no trigger is entirely skipped, never treated as a request to run its loose actions. Explicit execution rejects disconnected nodes before dispatch, returning `{ error, problems: { nodeId?, message }[] }`. The client exposes these as `StudioRequestError.problems`; Studio errors name graph nodes, not internal routine array indexes.
- Agent lifecycle, inference, approvals, retry plans and the remaining output adapters are visibly planned nodes, not fake executions. Enabling a document stores its intent but never subscribes it to events or starts automatic work. Automatic triggers remain the routine runner's responsibility. Conditions use the bounded routine sandbox and must return a literal boolean using `context.input`; board gates require literal boolean evidence on the supplied card.
- Routers use the separate `studioRouters: preview` adapter and stay browser-local. They are editors of NeoProxy-owned virtual models, never a second routing-policy store. NeoProxy's save API is not available in this pin. Its eventual adapter must preserve opaque ids, expected-value writes and layout metadata, and convert percentages to fractions once. Passthrough terminals name their target model.
- Source is TOML with `text/toml` on `GET /api/graphs/:id?format=toml` and `PUT` with the same type. Server source writes accept full TOML syntax; the browser editor reads the canonical subset it writes. Null is not a TOML value and is rejected rather than silently discarded. Legacy flows stay YAML and cannot be previewed safely; native V2 routines use `?dryRun=true`. Running a legacy flow requires explicit execution.

## 8. Dictation (`dictation`)

- `POST /api/dictation/transcribe` body `audio/webm` (or whatever MediaRecorder produced) → `{ text }`. Routed through xAI STT with a local parakeet fallback; `404` until wired, which the composer reports as "Dictation isn't wired on this deck yet."
- `GET/PUT /api/settings/dictation` `{ engine: "xai"|"parakeet"|"off", language, holdKey }`.

## 9. Knowledge history (`knowledgeHistory`)

Notes are read live through `/api/kb/*`. Humans request edits through a project agent; the server reserves `kb_write` for authenticated agents. Notes and Map are separate workspaces. `/knowledge?view=map` opens the full map from Knowledge or Studio; an optional `note` selects its focus. Map search lives in the toolbar, outside the canvas stacking context.

- `GET /api/kb/history?path=` returns `{ available: boolean, entries: { id, at, actor, kind: "committed", text }[] }`. This is live Git history, capped at 40 commits and following renames. `id` is the commit hash, `at` the author's ISO timestamp, `actor` the Git author and `text` the subject. It does not claim the author was an agent.
- A directory outside Git returns `available: false` with no entries; an uncommitted note in a Git repository returns `available: true` with no entries. Missing, excluded and escaping paths return 404. Git failures after repository discovery return 500 rather than fabricated history.
- Agent activity events remain unavailable. Git history is labeled separately and does not imply a thread link or capture receipt.

## 10. Skills, commands, extensions and usage

Skills and marketplace operations are live. `GET /api/slash-commands` lists NeoPi built-ins, Deck commands and saved user/project prompts. `GET /api/skills/extensions?cwd=` lists discoverable code modules and manifest bundles through NeoPi's capability loader without executing extension code. It returns `{ extensions: ExtensionSummary[], warnings: string[] }`; the protocol owns the row shape. Discovery does not claim an extension is active in a particular session.

The skill discovery source `agents` means shared `.agent/skills` and `.agents/skills` directories. It does not mean running agents, agent templates or inference providers. Marketplace plugins may separately bundle agent templates.

Usage remains an explicitly enabled preview, hidden by default:

- `GET /api/skills/usage` → `{ [skillId]: { lastUsedAt, uses7d } }`.
- NeoPi must supply persisted per-skill invocation events with resolved path identity and coverage before this can become live. An available skill or arbitrary file read does not prove invocation. Unknown history must remain unknown.

## 11. GitHub (`github`)

The GitHub page is live and read-only through the server's authenticated
`gh api graphql`. Queries name the configured repository explicitly, never a
fork's upstream. No GitHub mutations are exposed by this adapter.

- `GET /api/github/repos` → `{ repos: string[] }`, tracked `owner/repo` addresses.
- `PUT /api/github/repos` `{ repos: string[] }` saves only the local watchlist in `$NPI_DECK_HOME/github-repos.json`, up to 20 repositories. An empty list tracks nothing. Before the first save, `NPI_DECK_GITHUB_REPOS` supplies comma/space-separated addresses, or the server discovers GitHub `origin` remotes from configured workspaces.
- `GET /api/github/snapshot` → `{ repos, issues, pulls, wheel, viewer, configuredRepos, errors, fetchedAt, limit: 100 }`. One query per repository retrieves the 100 most recently updated issues and PRs, repository-wide open counts, PR checks/review decisions and the last 20 conversation comments. `viewer` is the server CLI's GitHub login and supports the PR author filter, not Deck account identity. Inline reviews and full history stay on GitHub. Results are cached for 30 seconds with single-flight refreshes. Four workers share a 45-second deadline; each CLI call also has a 30-second limit. Timed-out or failed repositories report errors without hiding successful repositories. The HTTP request has a finite 60-second ceiling.
- Ready follows `ready`, `agent: pending` or `state: ready`; Implementing follows `implementing`, `agent: started`, `human: started` or `state: implementing`. Open PRs enter PR open, then Review when GitHub reports a review decision or review label. Merged is GitHub's merged state. Nightly requires an explicit `nightly`, `state: nightly` or `status: nightly` label, never an inferred deployment. Wheel timestamps are last updates, not claimed transition history.

The GitHub App installation in Settings remains preview. App-backed writes,
issue filing, wheel advancement, agent assignment and full event timelines
are not implemented by the CLI adapter.

## 12. Usage and providers (`usage`, `providers`)

- `GET /api/usage/me?period=today|week|month` → `{ pools: Pool[], spend: SpendPoint[], requests: UsageRequest[], resetsAt }`; `GET /api/usage/accounts/:id?period=` (admin). `Pool { role /* virtual model name */, chain: Stage[], terminal, spentUsd, requests, resetsAt }`, `UsageRequest { at, model /* virtual */, resolved, where, tokens, costUsd }`.
- `GET /api/providers` → `{ providers: ProviderExposure[] }`; `PATCH /api/providers/:id` `{ hidden }` (admin; hidden from pickers, still served).

## 13. Settings

Env (`/api/settings/env`), NeoPi config (`/api/npi-config`), models (`/api/models-config`), MCP (`/api/mcp-servers`), bridges (`/api/bridges`), workspaces and notifications are live. The contract adds accounts (§1), dictation (§8), the GitHub app (§11), and a deck-config read: `GET /api/state` already serves it.

`GET /api/npi-config/model-roles?cwd=` reads role provenance for the requested
workspace through the pinned SDK. `PATCH /api/npi-config` accepts optional
`expectedValue` for non-secret settings and rejects a changed global value
with HTTP 409 before invoking the native setting setter and `Settings.flush`.
Role assignments and ordinary non-secret configuration forms send this snapshot.
Secrets cannot be compared through this field.

The dedicated `/models` workspace uses the live inventory, SDK-backed global
role assignments and the existing revision-checked custom catalogue editor.
Project-scope role writes and effort-rule editing require the newer native
`get_models_configuration`, `set_model_role_configuration`,
`set_model_role_storage` and `set_effort_rules` contracts. The current pin does
not expose these, so Deck reports the unavailable capability without inventing
native policy or writing role YAML in the browser.

Preview provider visibility is persisted under the browser key
`neodeck.provider-picker-visibility` and published through `useProviders()`.
It hides matching inference providers in Deck pickers, including for admins,
without changing served-model exposure or credentials.

## 14. Native model selection

- `GET /api/models?sessionId=&cwd=` reads the live catalogue within the session or workspace.
- `GET /api/models/selector?q=&sessionId=&cwd=` delegates search and ranking to NeoPi's native `query_model_selector` implementation. Returns `{ items, roles, error }`, preserving each opaque `selector`, `resolvedSelector` and nullable facts. A backend without the optional native selector feature returns `501`; the GUI can browse its live catalogue but does not emulate search.
- `PATCH /api/sessions/:id` accepts `{ selector: string }`. Native resolution retains `@role` policy and effort suffixes, and snapshots expose `modelSelector` separately from the resolved concrete `model`. Existing `{ model: { provider, id } }` clients remain supported.
- Provider visibility is Deck-local picker state, not NeoProxy exposure or an inference permission. Hidden providers are omitted for every account, including admins, and cannot return through search results or old recent selections.

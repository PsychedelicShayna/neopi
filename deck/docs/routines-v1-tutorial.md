# Routines — Canvas guide

Routines open directly on the canvas. Choose what should happen, arrange
the actions, save, and run. You do not need to read source or configure
webhooks to create a routine.

## Create and run

1. Open **Routines**. The empty canvas is ready for a new routine.
2. Set **Name**, then choose **Add action**. For example, choose **Run command**
   and enter `echo hello` in the action inspector.
3. Add more actions as needed. Click an action to edit it; drag to arrange
   the canvas. Connections determine execution order.
4. Click **Create**, then **Run now**. New routines can run on demand without
   enabling a schedule. The canvas shows the latest run's status and output.
5. Select a saved routine in the left sidebar to load and edit it. Existing
   routines open on the canvas even when they have no saved canvas layout.

Saving from the canvas does not open a source preview. Existing single-action
routines keep their original storage and execution behavior; their command or
prompt is editable on the canvas, with schedule, action kind and working
directory under **Advanced → Options**. They remain single-action routines.

New agent prompts and card bodies start without reference expressions. Plain
prompts, titles and body text are editable directly. Existing expressions stay
intact but are hidden in basic mode, including node previews; choose
**Advanced** to edit them. Card body text remains editable separately from
its frontmatter. Saving an untouched loaded routine keeps its original source
bytes, step order and execution settings, without a graph migration.

Open **Card properties** in the Create card inspector for **Read-only research**,
**Linked worktree** and named custom properties. Choose **Advanced** to reveal
its destination column, working directory and the arbitrary YAML property editor.
The controls compose leading body frontmatter without replacing unrelated
properties or body text. They are also available on Create inbox item, so its
properties can travel with a later promotion. For **Make a card from inbox**,
edit the source item's body/properties in Inbox
before promotion; promotion keeps that content unchanged. Advanced also
reveals actions that require card/inbox identifiers, their destination
references and the settings of existing technical actions.

## Deliberate advanced access

Choose **Advanced** to reveal the steps list, triggers, execution options,
additional action types and per-action identifiers, conditions and failure
handling. **View source** opens the existing routine's source editor. Use
**Apply to canvas** to apply source edits; saving from this view offers a
source-change review. Invalid source must be corrected before returning to
the canvas or hiding advanced controls.

Advanced controls are hidden again when you open another routine or reopen
Routines. Source is an expert compatibility tool, not the authoring contract:
the underlying model is intended to change separately from this canvas-first UI.

## Advanced reference

The following sections describe the current runtime for existing routines and
expert editing. None of these concepts is required for the create-and-run path.

### Optional shipped examples

Templates are no longer the routines entry point. Existing templates remain
available through the API, for example:

```bash
curl http://127.0.0.1:1701/api/routine-templates
curl -X POST http://127.0.0.1:1701/api/routine-templates/daily-briefing
```

The installed routine is disabled. Select it in the routines sidebar to see
its canvas, then choose **Run now**. The daily briefing creates a capture in
the deck's native Inbox. `kb-orphan-census` lists unlinked KB notes without
editing them.

## The 9 step types

| type        | use                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------- |
| `run`       | shell out to a command, capture stdout/stderr                                            |
| `agent`     | prompt the omp SDK; costs LLM tokens                                                     |
| `write`     | write a templated string to a file (overwrite or append)                                 |
| `http`      | GET / POST / PUT / PATCH / DELETE against a URL; internal calls get an HMAC bearer token |
| `deck`      | read or mutate deck-native state without hand-rolling API calls (`create_inbox_item`, `create_task`, `move_task`, `promote_inbox_item_to_task`, `list_tasks`, `list_inbox`, `get_task`, `get_inbox_item`, `kb_orphan_census`, `kb_read`) |
| `transform` | JS expression in a quickjs sandbox; sets `steps.<id>.json`                               |
| `set_state` | UPSERT key/value pairs into the routine's persistent state                               |
| `wait`      | sleep N seconds (useful between polling steps)                                           |
| `mcp`       | call one MCP server tool directly (no model); see [The `mcp` step](#the-mcp-step)         |

Every step type has the shared fields:

- `id` — referenced by downstream steps via `steps.<id>.json`, `.stdout`, `.stderr`
- `when` — a JS expression evaluated in the sandbox; if it returns falsy, the
  step is skipped
- `on_failure` — `abort` (default), `continue`, `retry`
- `retry` — `{ times, backoff: linear | exponential, max_delay_secs?, after_retry? }`
- `timeout_secs` — per-step wall-clock cap

## Explicit KB inputs

No routine receives KB content automatically. An agent step can opt in with
`kb_inputs: [projects/neodeck/overview.md]`; only those notes are appended to
its prompt. Alternatively, add a **read KB note** deck step:

```toml
[[steps]]
id = "knowledge"
type = "deck"
action = "kb_read"
path = "projects/neodeck/overview.md"

[[steps]]
id = "use_knowledge"
type = "agent"
prompt = "Use this requested section: {{ steps.knowledge.json.body }}"
```

Wire the read step into its consumer on the canvas. KB outputs remain in the
existing upstream-only step context; unrelated branches cannot access them.
This is also explicit agent memory: knowledge is read only when the agent is
told to consult a section or the routine wires it into a prompt. Entry search
indexes filenames and leading YAML title/tags; cold and warm results retain
the same human title.

Complete backlinks require a one-time server-side read of every visible note
body per vault invalidation: an inbound link can appear anywhere. That shared,
single-flight pass builds reverse edges and compact substring signatures; warm
backlinks reuse the index without reopening notes. Agents receive only the
requested node or edges, never the whole vault. This is an initialization
interpretation, not a claim that cold traversal performs zero whole-vault I/O.

Different full-text queries inspect generation-owned per-note signatures and
reopen only possible matches to verify exact substrings, scores and snippets.
Signatures retain at most 8 KiB per note, approximately one byte per source
UTF-16 code unit for smaller notes, rather than a Map/Set per distinct gram.
Hash collisions can add candidate reads but never false search results.
No note bodies or per-query results are retained. Common short queries,
high-entropy notes and adversarial texts can still make all notes candidates.
Metadata scoring still visits the inventory; initialization and invalidation
rebuilds are corpus-linear, and 32 concurrent reads bound concurrency, not
total bytes.


## Templating

The runner exposes a `{{ expr }}` template surface for string fields:

- `{{ run.id }}` — opaque run ID, prefixed `run_`
- `{{ run.date }}` — `YYYY-MM-DD` in the routine's timezone
- `{{ run.started }}` — ISO start timestamp
- `{{ trigger.kind }}` — `cron` | `manual` | `webhook` | `event`
- `{{ trigger.payload.<field> }}` — webhook body or manual params
- `{{ steps.<id>.json.<field> }}` — structured output (e.g. parsed HTTP response)
- `{{ steps.<id>.stdout }}` — captured stdout text
- `{{ state.<key> }}` — persisted state from prior runs (or `set_state` earlier this run)
- `{{ env.NAME }}` — environment variable
- `{{ secrets.NAME }}` — env var, but redacted in logs

Helpers: `{{ steps.X.json | json }}` (JSON-stringify), `{{ items | length }}`.

In a single-expression payload (e.g. an HTTP body), the value is preserved
as its native type, not coerced to a string.

## The `mcp` step

```toml
[[steps]]
id = "issues"
type = "mcp"
server = "github" # a server enabled for the routine's cwd
tool = "search_issues" # a tool that server advertises
[steps.args]
query = "repo:me/app is:open label:{{ trigger.label }}"
per_page = "{{ state.page_size }}" # a lone {{ }} keeps its type
```

- The server is found the way a chat opened in the routine's cwd (its
  `actionCwd`, else the deck's default cwd) would find it: user and project
  `mcp.json`, other tools' configs, the deny and force-enable lists,
  `mcp.enableProjectConfig` and `mcp.includeServers`. A routine does not
  borrow a live chat's MCP connection; routines run from cron and webhooks
  with no chat open. The step connects the server, makes the call and closes
  it, so every attempt (retries included) gets a fresh server process.
- `args` are templated, then validated against the tool's input schema
  before anything is sent. If the tool's schema cannot be compiled, the call
  goes out anyway and `stderr` says local validation was skipped.
- The step's timeout (`timeout_secs`, default 60) and cancelling the run both
  abort the handshake or the call and stop the server.
- `steps.<id>.stdout` holds the text content; `steps.<id>.json` holds
  `{ content, structuredContent?, isError? }`, with image and audio data
  replaced by its size. A result with `isError: true` fails the step with the
  tool's text.
- Values from the server's config that can be credentials (env and header
  values, URL parts, the value after a key-shaped flag, resolved `!command`
  and OAuth tokens) are replaced with `••••••` in everything the step records,
  even when the server echoes them back.
- **Integrations** lists every enabled server for the deck's workspace with
  its tools and input schemas, and a step snippet for each tool.

## Triggers

A routine can have multiple triggers, even of the same kind. Examples:

```toml
[[trigger]]
cron = "0 7 * * *" # 7am daily
[[trigger]]
cron = "0 17 * * 1-5" # 5pm weekdays
[[trigger]]
webhook = { path = "/hooks/refresh", secret_env = "REFRESH_SECRET" }
[[trigger]]
manual = {}
```

Cron expressions are 5-field standard (minute / hour / day / month / weekday).
Set `timezone = "America/Chicago"` on the spec to evaluate against an IANA zone.

For webhook triggers, click **Rotate secret** in the routine's Settings tab
to mint a fresh secret. The plaintext is shown **once**; the deck keeps it
in `deck.db` to verify signatures and never sends it back. Every delivery
carries two headers:

```
X-Routine-Timestamp: <unix seconds>
X-Routine-Signature: sha256=<hex>
```

where `<hex>` is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`: the
timestamp header's value, a `.`, then the exact request body bytes. The deck
recomputes the MAC over the bytes it received and compares in constant time,
so a signature does not carry over to another body. A timestamp more than
five minutes from the deck's clock is refused, which bounds how long a
captured delivery can be replayed. Refused deliveries answer `401` and are
recorded as runs aborted with `signature_invalid`.

```sh
ts=$(date +%s)
body='{"hello":"world"}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$REFRESH_SECRET" -hex | sed 's/^.* //')
curl -X POST http://127.0.0.1:1701/api/hooks/refresh \
  -H 'content-type: application/json' \
  -H "X-Routine-Timestamp: $ts" \
  -H "X-Routine-Signature: sha256=$sig" \
  --data-raw "$body"
```

Webhooks registered before signed deliveries existed sent the bare secret as
`X-Routine-Signature`. Those registrations keep accepting it, and the
Settings tab shows a deprecation warning with the last such delivery. The
first bare-secret delivery also lets the deck store that secret, so the same
sender can switch to signing with the secret it already has; then click
**Stop accepting the bare secret** and confirm (or
`PATCH /api/routines/:id/webhook {"acceptBareSecret": false}`). This is
permanent: `{"acceptBareSecret": true}` answers `409` for any registration
that has stopped accepting it. Rotating the secret also ends bare-secret
deliveries for good. New registrations never accept the bare secret.

The checks run again when the body has arrived, against the registration
as it is at that moment: a delivery still uploading when the secret is
rotated or the bare secret is refused is rejected, and so is one whose
timestamp leaves the window during the upload.

Because `deck.db` holds the secrets, the deck keeps its data dir
(`~/.npi-deck`) at `0700` and `deck.db`, `deck.db-wal` and `deck.db-shm` at
`0600`, narrowing files left more open by earlier versions at startup.

## Concurrency

What happens when a trigger fires while a previous run is in flight:

- `skip` (default): drop the new fire
- `queue`: queue it; run after the current one finishes
- `cancel-previous`: abort the in-flight run, start the new one
- `parallel`: run concurrently (costs add up)

## Budget

`max_duration_secs`, `max_llm_cost_usd`, `max_llm_tokens_input`,
`max_llm_tokens_output`, `max_steps_executed`. Checked after each attempt,
including failed retries. On excess the runner stops with
`abort_reason: 'budget'` and persists the usage and partial results.

Agent-step token totals include cached and orchestration tokens when reported;
USD cost comes from NeoPi's provider-reported usage, not a static model-price
estimate. Your LLM vendor's bill remains authoritative.

The run history records the NeoPi backend tree path, commit, and version
selected by its first agent step. Later steps and retries use that same
command; deck-only and historical runs have no backend field.

Each run also records its trigger payload (`triggerPayload`, a JSON string):
the webhook body, manual params, or event payload. Steps always receive the
full, unredacted payload; only the stored copy is changed.

The stored copy is redacted by key name. At any depth, the value of a key
whose name contains `token`, `secret`, `passw`, `pwd`, `api_key` / `api-key` /
`apikey`, `auth`, `signature`, `cookie`, `credential`, `session` or `bearer`
(any case) is stored as `"[redacted]"`. Values under any other key are stored
as sent, so a credential under an innocuous key name is kept. Keys such as
`author` or `session_count` match too and are redacted.

After redaction the copy is capped at 8 KiB. A larger payload is stored as
`{ "truncated": true, "bytes": <size of the redacted JSON>, "preview": "<its head>" }`.
A webhook rejected for a bad signature records only its path and the sorted
names of the request headers, never a header value.

## Cross-run state

Persistent key-value store scoped per routine:

```toml
[state]
declared_keys = ["last_seen_id"]

[[steps]]
id = "should_run"
type = "transform"
body = """
if (state.last_seen_id === run.id) return { ok: false };
return { ok: true };
"""
[[steps]]
id = "do_thing"
type = "run"
when = "steps.should_run.json.ok"
command = "./script.sh"
[[steps]]
id = "persist"
type = "set_state"
[steps.state]
last_seen_id = "{{ run.id }}"
```

`declared_keys` is informational — the runtime can write any key via
`set_state`. State writes are atomic per step.

## Observability

- Routine detail page → **Runs** section lists recent runs.
- Click a run → `/routines/:id/runs/:runId` opens **RunDetailView** with a
  live-polling timeline. Click any step to expand stdout / stderr /
  structured JSON / error.
- `GET /api/routines/:id/metrics` returns success rate, p50/p95 duration,
  MTD cost, and a last-30 sparkline series.

## Programmatic install

If you'd rather not click through the builder:

```bash
# Author the direct RoutineSpec object as TOML (no spec wrapper)
cat > /tmp/my-routine.toml <<'TOML'
name = "hello-world"
description = "minimal one-step routine"
concurrency = "skip"
[[trigger]]
manual = {}
[[steps]]
id = "greet"
type = "run"
command = 'echo "hello from {{ run.id }}"'
TOML

curl -X POST http://127.0.0.1:1701/api/routines \
  -H "content-type: application/json" \
  -d "$(jq -Rs '{ name: "hello-world", specToml: . }' < /tmp/my-routine.toml)"
```

The server parses native TOML and validates the direct spec object against the
JSON Schemas in `packages/protocol/src/schemas/`, returning 400 with a list of
schema errors if anything is off. Bundled templates use `.toml` as well.

Existing V1 database specs are imported from read-only `spec_yaml` to the new
`spec_toml` column at startup or first read. The original YAML is never rewritten
or deleted, including when the imported routine is edited or converted to a graph.
Successful imports are persisted once and logged using only the routine ID.
User comment text is carried into the imported TOML preamble when source
association cannot be retained; subsequent builder and source edits preserve it.
YAML/YML-only user templates use the same import behavior, publish a
same-permission TOML sibling atomically, and retain the original unchanged.
When both formats exist, TOML wins with a warning.
Invalid specs or values the shared codec cannot preserve losslessly remain
untouched and produce an explicit error identifying the affected routine.
Explicit JSON nulls use shared reserved TOML metadata, not a wrapper around the
spec: `[__npi]` contains `version = 1` and `null_paths = ["/steps/0/state/cleared"]`.
Pointers use JSON Pointer escaping. Null object properties are omitted from
the ordinary TOML tables; null array entries use empty-string placeholders.
The browser and server decode this metadata before validating or executing
the direct `RoutineSpec` object, preserving null, empty string and omitted values.
New API writes and all execution parsers use `specToml`; YAML is import-only.

## Limitations in V1

- For `agent` steps, omitting
  `mcp_servers_allowed` inherits the backend's configured MCP servers; `[]`
  disables them. Any explicit MCP restriction requires a probed backend with
  NeoPi's `mcp.includeServers` and `--mcp`/`--no-mcp` support (neopi#120);
  older backends reject the step before spawning. Entries must be literal
  enabled server names, not globs. Typos, disabled servers and names shadowed
  by a disabled higher-priority config fail before a session starts.
- Omitting `skills_allowed` inherits all installed skills. Literal
  `skills_allowed: [name]` restricts skills with NeoPi's `--skills` flag;
  globs are rejected before spawning, and `skills_allowed: []` disables
  skills. In the visual builder, select **Only listed** to restrict either
  surface; removing its last tag preserves the empty deny-all list. Select
  **All** explicitly to restore the unrestricted default.
- DnD step reordering lands in V1.5. Up/down arrows work today.
- No "test this step in isolation" runner yet — full re-run is the only
  way to debug. Coming in V2.
- Windows console codepage mangles em-dashes in `agent` step stdout
  (cosmetic; the briefing is fully usable).

## What's next (V1.5)

- Workspace MCP integration: Gmail / Calendar / Drive / Docs via the
  [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)
  server. Inbox-triager is the V1.5 proof point.
- `server` + `tool` dropdowns in the `mcp` step form, sourced from the
  Integrations listing (today they are typed by name).
- Drag-and-drop step reordering with smart warnings when a reorder breaks
  a downstream context reference.
- Per-step "Test this step" runner against the last-run context.

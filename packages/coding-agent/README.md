# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Session work contracts

`/contract` manages operational clauses for the current session. No clauses or agent permissions are enabled by default. Active clauses are stored in the session journal and injected in a reserved system-prompt block on each provider request, including continuations and mixture members. Compaction and resume retain them; `/new` starts empty. They do not replace sticky `RULES.md` or assignment tracking.

```text
/contract list
/contract set lane The funnel publishes; the lane stays free.
/contract show lane
/contract edit lane
/contract disable lane
/contract enable lane
/contract remove lane
```

`edit` opens the multi-line editor, or accepts replacement text after the id. `set` creates or replaces a clause. IDs use letters, digits, underscores and hyphens, at most 64 characters. List/show include the clause's activation, author, timestamps, originating user turn, agent tool-call ids, and promotion paths. Mutation events remain in the journal even after removal.

The agent's `contract` tool is inactive and denied by policy until you explicitly run `/contract policy on`. `/contract policy off` revokes that permission without disabling the clauses. The tool and command share the same request schema and journal. Commands also accept JSON, for example `/contract {"action":"set","id":"lane","text":"Keep the lane free."}`.

Only `/contract promote lane user` or `/contract promote lane project` copies a clause to an always-apply rule. User rules go in the configured agent directory's `rules/`, normally `~/.omp/agent/rules/`; project rules go in `.omp/rules/`. Promotion never overwrites an existing rule, leaves the session clause unchanged, and cannot be performed by the agent tool. Run `/reload` or start a new session to load the persistent copy.

The reserved block is added after context pruning, never sliced to fit a budget. If the estimated request cannot fit with the complete block, the request fails visibly with instructions to compact context or edit/disable clauses. Nothing silently drops contract text.

## Session compaction controls

`/compact control` shows resolved compaction settings and trigger boundaries without compacting. Bare `/compact` and its existing mode/focus arguments still compact immediately.

```text
/compact control {"action":"set","values":{"thresholdTokens":90000,"asyncEnabled":false}}
/compact control {"action":"propose","values":{"thresholdPercent":80}}
/compact control {"action":"reset"}
/compact control {"action":"set","scope":"project","values":{"reserveTokens":20000}}
```

The same JSON request is accepted by the agent's `write` tool at `compaction://`; `read compaction://` inspects it. Actions are `show`, `propose`, `set` and `reset`. Proposals validate the request but change nothing. `compaction.agentControl` defaults to `propose-only`; `read-only` disallows proposals and `write` explicitly allows agent changes. The agent cannot change that permission through this API.

Controls include `enabled`, `thresholdPercent`, `thresholdTokens`, `reserveTokens`, `keepRecentTokens`, `methodOrder`, `asyncEnabled`, `midTurnEnabled` and `autoContinue`. Percent thresholds accept 1 through 99 or -1 for default; token thresholds accept positive integers or -1 for default. Reserve and retained tokens accept non-negative integers. Method order accepts distinct `remote`, `snapcompact`, `handoff`, `shake` and `soft` entries. An empty order disables automatic methods. Setting one threshold resets its competing threshold to -1.
Resetting either threshold resets the pair, so the other half of an ad-hoc threshold cannot hide the configured policy.

The default scope is `session`. It never writes config files, takes precedence over per-model thresholds, survives compaction, and clears at a logical session reset, switch, or tree navigation. Restarting does not retain it. `reset` restores settings-layer values; optional `keys` limits the reset. Scopes `project` and `user` persist to their own config files; resetting those scopes removes their keys instead. Persisted changes still obey existing environment, runtime, role and per-model precedence. The inspection result reports the current settings and actual trigger, so a shadowed write is visible.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.

## Chronicler capture

Chronicler is an independent, opt-in background capture feature, not a memory backend or advisor. In `/settings` → Memory, **Chronicler capture** appears directly beneath **Memory Backend**; it can run alongside Local memory. The built-in `chronicler` model role is selectable in the ordinary role UI and cannot be deleted. An unset role follows the `slow` fallback chain.

For example, in `~/.omp/agent/config.yml` or project `.omp/config.yml`:

```yaml
memory:
  backend: local
chronicler:
  enabled: true
modelRoles:
  chronicler: openai-codex/gpt-5.6-luna:max
```

The model choice is configuration, not a hard-coded requirement. Capture defaults off and is always disabled for task subagents, including SDK sessions identified by `taskDepth` or `parentTaskPrefix`. No primary-agent `retain` call, advisor, or prose reviewer is involved.

Enabled sessions capture their remaining persisted append history in bounded passes, including idle resumed sessions. Each pass can stage standalone markdown beats and retain bounded pending carry for an unfinished thought. Intentions remain distinct from observed results; corrections create linked new beats rather than rewriting old ones. Missing completion markers, provider failures, or revocation do not advance coverage. An oversized individual entry pauses capture with a warning and remains unprocessed; selecting a suitable model or toggling capture off and on retries it without truncation.

Files live beneath that session’s own artifacts directory, in `chronicler/`:

- `beats/<batch-id>/COMMIT.json` records the covered entry IDs, parent links, timestamps, and carry. Its immutable markdown beat files include session, source, model, and time provenance. A completed pass with no beat still commits entry coverage.
- The manifest and beats publish together through one directory rename. A process interrupted before publication leaves no committed coverage; reopening after publication recovers coverage from the committed batch without replaying it. Abandoned `.pending-*` directories are ignored. This is local-filesystem process-interruption recovery, not a power-loss guarantee or a claim that models never repeat an idea.
- `INDEX.md` and `state.json` are rebuildable caches, not checkpoint authority. Corrupt committed manifests or missing referenced beats halt capture and preserve the files instead of silently recapturing.
- `__chronicler.jsonl` is the diagnostic model transcript, not replay authority.

Distinct sessions in one working directory have distinct artifact roots. Copied-artifact forks (`SessionManager.forkFrom` and `AgentSession.fork`) retain ancestor beat provenance and committed coverage. Interactive `AgentSession.branch` uses `createBranchedSession`, which records the source session file as its parent but does **not** copy artifacts: its fresh root captures the branch’s transcript under the child session identity. A plain in-process `SessionManager.fork()` does not copy artifacts either. These existing branch/fork semantics are unchanged.

Capture itself injects nothing into sessions. `npi chronicle index` derives a cross-session year/month/week/day/hour view from the committed beats, and `npi chronicle recall` or the opt-in `chronicle_recall` tool (`chronicler.recall.enabled`) searches it coarse to fine and returns canonical beats with transcript provenance; see [docs/chronicle.md](../../docs/chronicle.md). There is still no default recall injection, refinement, or reflection pipeline.

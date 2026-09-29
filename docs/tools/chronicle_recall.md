# chronicle_recall

> Recall captured Chronicler atoms by coarse-to-fine descent through the derived temporal view.

## Source
- Entry: `packages/coding-agent/src/tools/chronicle-recall.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/chronicle-recall.md`
- Search: `packages/coding-agent/src/chronicler/temporal/recall.ts` (`recallChronicle`)
- Ranking: `packages/coding-agent/src/chronicler/temporal/rank.ts` (model and lexical rankers)
- View: `packages/coding-agent/src/chronicler/temporal/{tree,view,indexer}.ts`; built by `npi chronicle index`
- Settings: `packages/coding-agent/src/chronicler/settings.ts`
- User docs: `docs/chronicle.md`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`.
- Off by default. `chronicler.recall.enabled: true` grants it to top-level sessions; it follows the setting live through the settings-gated built-in reconcile.
- Independent of `memory.backend`: it coexists with `recall`/`retain` from Hindsight or Mnemopi, and with Local memory.
- Task subagents get it only when their explicit tool list names `chronicle_recall`. Restricted tool lists are never widened with it.
- Advisors get it only when their `WATCHDOG.yml` `tools:` list names it; the default advisor roster adds `recall`, not `chronicle_recall`.
- Nothing is injected at session start: no system-prompt section, no first-turn context, no compaction context.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | Yes | What is remembered, in any wording. |
| `from` | `string` | No | Earliest time: ISO instant, or local `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `YYYY-MM-DDTHH` prefix in the view's timezone. |
| `to` | `string` | No | Latest time, same forms; prefixes are inclusive (`2026-09` covers all of September). |
| `project` | `string` | No | Case-insensitive substring of the project (session cwd) path. |
| `session` | `string` | No | Session id or id prefix. |
| `hint` | `string` | No | An adjacent event remembered from around the same time. |
| `resolution` | `'year' \| 'month' \| 'week' \| 'day' \| 'hour' \| 'atom'` | No | Stop at this level and return candidate periods (default `atom`). |
| `node` | `string` | No | Candidate key from an earlier call; the search starts inside that node. |
| `budget` | `number` | No | Maximum atoms returned (default `chronicler.recall.results`, 5). |

## Outputs
Single-shot result. `content[0].text` renders the results; `details` is the full `RecallResult`:
- `results[]`: `id`, `title`, `kind`, `eventTime`, `project`, `sessionId`, `score`, `confident`, `via` (`descent` or `adjacent`), `anchor` (hint anchor id for adjacency), `beat` (canonical beat file), `stub` (view stub), `transcript: { path, entryIds }`, `body` (canonical text, capped at 12,000 characters with `bodyTruncated`), `stale`, `neighbors[]`.
- `candidates[]`: ranked periods (`key`, `level`, `label`, local period, `atomCount`, `projects`, `description`, `score`) for a non-atom `resolution`, or when recall is ambiguous.
- `ambiguous` and `ask` (`time-range` or `adjacent-event`): set when no atom is confident; `ask` names the follow-up that would discriminate best.
- `trace[]`: the branches considered — `rank`, `terminal`, `collapse`, `backtrack`, `evict`, `candidate`, `anchor`, `adjacent`, and evidence notes (`atom-missing`, `stale-atom`, `moved-out-of-scope`, `view-drift`, `ranker-fallback`) with candidate scores.
- `evidenceErrors[]`, `view: { root, indexedAt, complete, viewStale }`, `ranker`, `rankerFallback`.
- A result with neither atoms nor candidates is marked `useless`.

## Flow
1. Settings resolve the view root (`chronicler.index.dir`, default `<agentDir>/chronicle`), beam, result budget, neighborhood window, and ranker. The `model` ranker uses the `chronicler-summary` role and falls back to lexical scoring when no model resolves or a reply cannot be parsed.
2. Best-first descent from the root (or `node`): each expansion ranks the in-scope children's parent-authored descriptions and keeps the best `beam` plus near-ties in a frontier bounded to `beam × 4`. A branch whose best child or atom scores below half its own score (and below 0.6) is recorded as collapsed; the next pop from another branch is recorded as a backtrack.
3. Terminal buckets rank their enumerated atoms. Atoms scoring at least 0.25 become candidates; 0.6 is confident.
4. With `hint`, a second descent finds an anchor atom; in-scope atoms within `chronicler.recall.neighborhoodMinutes` of it are ranked against the query and fill up to half the budget as `adjacent` results.
5. Each selected atom is re-read from its committed batch. A changed atom is returned with its current fields and `stale: true`; a deleted or unlisted atom goes to `evidenceErrors`; an atom whose current metadata left the scope is dropped. Confident results list in-scope neighbors within the window.

## Errors
- No view: `No chronicle view at <root>. Run \`npi chronicle index\` first.`
- Unknown `node`: `No chronicle node <key> in <root>`.
- Invalid `from`/`to`: `Invalid time bound: <value>`.

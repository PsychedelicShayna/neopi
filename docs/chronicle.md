# Chronicle: temporal view and recall

Chronicler capture (`chronicler.enabled`) writes **atoms** — self-contained beats — into each session's `chronicler/beats/` store. This page covers what is built on top of them: a derived year → month → week → day → hour view across every session and project, the `npi chronicle index` command that maintains it, and explicit recall through `npi chronicle recall` and the `chronicle_recall` tool.

Atoms stay the only source of truth. The view is a cache: deleting it loses nothing, and `npi chronicle index` rebuilds it from the atoms. Nothing from it is injected into sessions.

## The hierarchy

```
<agentDir>/chronicle/                 chronicler.index.dir
  VIEW.json                           config, completeness, last index time
  node.json  NODE.md                  root: all atoms
  2026/                               year
    09/                               month
      w2/                             month-clamped week
        10/                           day
          20/                         hour (terminal, or split below)
            NODE.md                   enumerates every atom in the bucket
            20260910T233227Z-local-gui-handoff-for-anthropic-login-a6b257ce52d7.md   atom stub
```

- **Buckets** use the wall clock of `chronicler.index.timezone` (empty = system zone) and each atom's `event_time`. Only non-empty buckets exist.
- **Weeks** are Monday-start calendar weeks clamped to the month: when Aug 31 is a Monday, Aug 31 is `2026/08/w6` and Sep 1–6 is `2026/09/w1`.
- **Terminal buckets** enumerate every atom: id, time, kind, title, project, session, stub name, and the leading paragraph up to `chronicler.index.leadTokens`. A clipped lead says how many characters remain in the canonical atom. Each atom also gets a stub file whose name carries its time, a title slug, and the end of its id, so listing a directory shows what is in it without opening atoms. Stubs point at the canonical beat and transcript.
- **Dense periods** split: an hour holding more than `chronicler.index.terminalAtoms` atoms, or more text than one hop allows, splits at minute midpoints (`14/00-29/`), and atoms sharing one minute are paginated (`14/07-p01/`). A node with more children than one hop can route gets fan-out groups (`g1-01/`). No atom is dropped to fit a budget.
- **Summaries** are generated bottom-up from the children's texts only: an overview plus one description per child, written to keep discriminating nouns, projects, mechanisms, and adjacent events. The whole routing text of a node — what one recall hop reads — stays within `chronicler.index.hopTokens` (default 1000); `chronicler.index.summaryTokens` (default 500) is the target. A node with one child reuses that child's text instead of calling the model.

Every `node.json` records the generating model and effort, prompt version, generation time, its identity (from atom fingerprints, budgets, timezone, prompt version, and model), its content hash, and the identity and content hash of each child it summarized. `NODE.md` and stubs are renders of `node.json` and are checked byte for byte.

An agent without the tool can recall the same way by hand: read `NODE.md` (or `node.json`) at the root, pick the child whose description fits, descend, and read the stubs of the terminal bucket.

## `npi chronicle index`

```
npi chronicle index [--dry-run] [--rebuild] [--since D] [--until D] [--json] [--agent-dir DIR]
```

Regenerates only stale nodes, children first. A node is stale when it is missing or unreadable; when an atom under it changed, appeared, or disappeared; when the summary model, effort, timezone, budgets, or prompt changed; when a child was regenerated; or when its files no longer match `node.json`. Directories that no atom maps to any more are removed.

- `--dry-run`: report without model calls or writes.
- `--rebuild`: regenerate every node.
- `--since`/`--until` (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or an ISO instant): regenerate only nodes overlapping the window. Ancestors of a stale node left outside the window are reported **blocked** and stay stale; the view is then marked incomplete.

The view root must be dedicated to the view: index refuses a root that is, contains, or sits inside the sessions directory, contains the agent directory, or is a non-empty directory without `VIEW.json`, because refreshing removes entries the view does not recognize.

The report also lists canonical problems without touching atoms: malformed batches (other batches of the session are still indexed), duplicate atom ids, entries committed twice, beats citing uncommitted or missing transcript entries, missing transcripts, and `related`/`supersedes` ids that match no atom. `VIEW.json` is marked incomplete before the first write and complete only when every node settled. Exit status is 1 when a summary failed.

## Recall

```
npi chronicle recall "<query>" [--from D] [--to D] [--project P] [--session S] [--hint EVENT]
                               [--resolution year|month|week|day|hour|atom] [--node KEY]
                               [--budget N] [--beam N] [--ranker model|lexical] [--json]
```

The `chronicle_recall` tool takes the same inputs (without `beam`/`ranker`); see `docs/tools/chronicle_recall.md`.

Recall descends coarse to fine. At each node it ranks the in-scope children's descriptions against the query, keeps the best `beam` of them (plus near-ties) as alternatives, and expands the most relevant candidate next. When a branch's best child or atom scores far below the branch itself, the branch has collapsed and the search moves to the strongest retained alternative; the trace records both. Terminal buckets rank their atoms directly.

- **Scope**: `from`/`to`, `project` (path substring), and `session` (id prefix) apply to every step, including adjacency and neighbors.
- **Adjacent event**: `hint` describes something remembered from around the same time. Recall finds that event, then ranks the atoms within `chronicler.recall.neighborhoodMinutes` of it, across sessions, so a poorly described target next to a well described event is still found.
- **Step-by-step narrowing**: `--resolution month` returns ranked candidate periods; call again with `--node <key> --resolution week`, and so on down to atoms.
- **Uncertainty**: when no atom is confident, or when an atom in another period ties the chosen one, the result says so, lists the best candidate periods, and names the follow-up that would discriminate best (a time range or an adjacent event).
- **Evidence**: returned atoms, hint anchors, and listed neighbors are re-read from their committed batch — body, transcript path, and cited entry ids come from the store. An atom changed since indexing is marked stale and shown as it is now; a deleted one is reported instead of returned.

The `model` ranker (default) uses the `chronicler-summary` role; `lexical` scores word overlap and needs no model, but it cannot match a memory described in different words.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `chronicler.recall.enabled` | `false` | Grant `chronicle_recall` to top-level sessions. Subagents and advisors get it only by naming it in their tool lists. |
| `chronicler.index.dir` | `<agentDir>/chronicle` | View root. |
| `chronicler.index.timezone` | system zone | IANA zone for calendar buckets. |
| `chronicler.index.summaryTokens` | `500` | Target size of a generated node. |
| `chronicler.index.hopTokens` | `1000` | Ceiling for one hop: a node's routing text or a terminal enumeration. |
| `chronicler.index.terminalAtoms` | `8` | Atoms per terminal bucket before subdivision. |
| `chronicler.index.leadTokens` | `120` | Leading-paragraph length per atom in enumerations. |
| `chronicler.index.shortNames` | `false` | Stub names `<time>-<id>.md` for restrictive filesystems. |
| `chronicler.recall.beam` | `2` | Branches kept per expansion. |
| `chronicler.recall.results` | `5` | Atoms per recall. |
| `chronicler.recall.ranker` | `model` | `model` or `lexical`. |
| `chronicler.recall.neighborhoodMinutes` | `90` | Window for adjacency and neighbors. |

```yaml
chronicler:
  enabled: true
  recall:
    enabled: true
  index:
    timezone: America/Sao_Paulo
modelRoles:
  chronicler: openai-codex/gpt-6-luna:max
  chronicler-summary: openai-codex/gpt-6-luna:low
```

The `chronicler-summary` role writes summaries and ranks during recall. Unset, it follows the `chronicler` role, then the `slow` chain. Summaries send atom text to that model's provider, the same boundary as capture.

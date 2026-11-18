# Tracker label vocabulary

Labels compose facts rather than encode one compound category. This iteration-1
vocabulary is shared by issues and PRs. [triage.md](triage.md) defines assignment
and reconciliation; [pr-review-bots.md](pr-review-bots.md) defines review receipts.
Spellings marked **proposal** remain revisable.

## Kind

| Label | Meaning |
| --- | --- |
| `bug` | Something is not working |
| `enhancement` | New feature or request |
| `documentation` | User- or agent-facing docs, README or changelog |
| `accessibility` | Barrier affecting people with disabilities |
| `idea` | Undecided possibility; not a spec or authorized work |
| `experiment` | Tried on an `experimental/` branch; owner decision required before integration or default-branch merge |
| `spec` | Is or contains an implementation specification |
| `hotfix` | Urgent targeted fix to the default branch |
| `chore` | Maintenance with no product behavior change: promotion, sync merge, formatting, CI upkeep |

## Relationships and disposition

| Label | Meaning |
| --- | --- |
| `upstream` | Upstream is involved: sync, compatibility, conflict avoidance or divergence |
| `downstream` | Needed by a project that consumes this one |
| `duplicate` | Same request as another issue; useful context reconciled into the canonical issue |
| `entangled` | Incompatible alternatives; owner chooses one and the rest close |
| `baseline` | Pre-existing defect found on the base during review; retained this iteration |
| `invalid` | Closed: wrong repo, missing required information/format, or policy violation |
| `wontfix` | Closed: will not be worked on |
| `stale: identical` | Already implemented essentially as specified |
| `stale: similar` | Implemented differently; open for remaining differences |

## Priority and estimates

| Label | Meaning |
| --- | --- |
| `priority: p0` | Blocks current work or handles an active incident |
| `priority: p1` | High value or prerequisite for several issues |
| `priority: p2` | Useful planned work |
| `priority: p3` | Backlog or opportunistic work |
| `difficulty: 0.000-0.125` | Estimated implementation difficulty in this band |
| `difficulty: 0.125-0.250` | Estimated implementation difficulty in this band |
| `difficulty: 0.250-0.375` | Estimated implementation difficulty in this band |
| `difficulty: 0.375-0.500` | Estimated implementation difficulty in this band |
| `difficulty: 0.500-0.625` | Estimated implementation difficulty in this band |
| `difficulty: 0.625-0.750` | Estimated implementation difficulty in this band |
| `difficulty: 0.750-0.875` | Estimated implementation difficulty in this band |
| `difficulty: 0.875-1.000` | Estimated implementation difficulty in this band |
| `frame: hours` | Estimated time frame: hours (agent estimates lowered one unit) |
| `frame: days` | Estimated time frame: days (agent estimates lowered one unit) |
| `frame: weeks` | Estimated time frame: weeks (agent estimates lowered one unit) |
| `frame: months` | Estimated time frame: months (agent estimates lowered one unit) |
| `frame: years` | Estimated time frame: years (agent estimates lowered one unit) |

Difficulty bounds are lower-inclusive and upper-exclusive except `1.000`.
Priority, difficulty and time are separate dimensions. Record estimator and
original time unit; apply the [manual's normalization](triage.md#classification-and-estimates)
once for agent estimates, with hours as the floor. Human estimates are unchanged.

## Triage and participation

| Label | Meaning |
| --- | --- |
| `needs-triage` | Not yet triaged |
| `triage: started` (**proposal**) | Triage in progress; labels are provisional |
| `needs-info` | Cannot proceed until named information arrives |
| `agent: pending` | Ready for an out-of-the-loop agent to pick up |
| `agent: started` | An agent has claimed this; do not duplicate the work |
| `agent: finished` | Agent's part is done; not necessarily mergeable |
| `human: pending` | Needs an in-the-loop session with a human |
| `human: started` | A human has claimed the in-the-loop part |
| `human: finished` | Human's in-the-loop part is done |

Started is a claim, not a heartbeat. Human refers to participation, not who
writes code. Use one state per actor; distinct actor states can coexist.
`entangled` and `needs-info` issues have no pending actor state until unblocked.

## Review and merge

| Label | Meaning |
| --- | --- |
| `review: codex` | Codex chosen as an optional double-checker |
| `review: requested (codex)` | Optional Codex round requested or running |
| `review: open (codex)` | Findings noted or under consideration |
| `review: closed (codex)` | Optional round handled; important findings fixed, others noted or ignored |
| `review: stalled (codex)` | Optional round failed/stopped; informational only |
| `mergeable` | Integrator considers this ready under nightly delivery policy; not CI/review approval |

Use at most one state per chosen reviewer. No review is needed by default.
Base changes never invalidate anything, including review state or merge
readiness. None of these labels gates `nightly`; [policy.md](policy.md) owns the
confidence decision and owner-decided promotion.

## Composition

`upstream` + `bug` means an upstream-involved bug; `downstream` + `enhancement`
means an enhancement needed by a consumer. `experiment` can compose with `idea`,
`bug` or another kind while keeping experimental work off integration/default
branches without an owner decision. `duplicate` + `entangled` is valid when
requests overlap but their proposed implementations conflict. `spec` describes
specification presence, not authorization, ownership or acceptance. Use the
labels supported by the evidence rather than forcing exactly one kind.


## Open decisions

These remain open, not implemented by this iteration:

- Retiring `baseline`: proposed bug plus upstream composition loses the marker
  for fork-local base defects; base and upstream are different facts.
- Separate upstream-conflict-potential and user-disruption axes.
- A label for blocking questions and the needs-info/invalid boundary.
- Resource allocation replacing the former contributor-help category.
- A narrow squash/rebase exception; merge commits remain the live rule.
- Owner approval mechanism for policy files.
- Setup skill and HTML questionnaire.
- Magi, the future tribunal reviewer; it is not configured.
- Automated triage runner/webhook.
- GitHub Projects/Discussions reporting.

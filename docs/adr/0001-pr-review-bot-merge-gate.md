# 0001: Merge only when CI and every review bot's latest round are clean

Status: superseded (2026-10-09) by the workspace policy in `~/repos/AGENTS.md`.
Review bots are advisory; the authoring agent merges on its own judgment once
the workspace gates pass. Kept for the reasoning and the history below.

Original status: accepted (2026-09-28)

Automated reviewers comment on every fork PR. As of this ADR, that is the
Codex connector (`chatgpt-codex-connector[bot]`), which runs a code review and
a separate security review. Macroscope and a Claude review bot are planned.
The bots do not re-review a new push on their own, and their findings vary in
severity and accuracy. We decided that a PR merges only when CI is green and
the latest review round from every configured bot, including the security
review of the head commit, has no P0/P1 finding. After every push, agents
explicitly request a new round from each bot. Every bot thread gets a factual
reply before it is resolved. Security findings are never deferred. The
operating rules are in
[`docs/agents/pr-review-bots.md`](../agents/pr-review-bots.md).

## Context

- On PR #113 the code review of head `2ff9cc8a93` came back clean at
  02:53Z, and the PR merged at 02:57Z. The security review of the same commit
  finished at 03:01Z and opened a new security thread on the merged code.
  Waiting for the code review alone left a security finding unhandled.
- The Codex bot reviews when a PR opens, when a draft is marked ready, or when
  someone comments `@codex review`. A push alone does not start a round, so a
  green CI run can sit on code no bot has seen.
- Review threads are the fork's audit trail. On PRs #95 and #99, every thread
  was answered with the fixing commit, or with the issue tracking the
  deferral, before it was resolved. A thread resolved without a reply loses
  that record.

## Considered options

- **Treat bot reviews as advisory and merge on CI alone.** Rejected because
  of the #113 incident: a clean CI run says nothing about findings that arrive
  after it.
- **Require zero open findings of any severity.** Rejected because fixing
  every P2 in the same PR inflates PRs well beyond their goal. P2s may move to
  a follow-up PR (as #114 did for #111) as long as they are recorded.
- **Rely on a bot's built-in merge gate.** The Codex summary comment on this
  repository reports `mergeGateEnabled: false` with a P0 threshold. A gate
  inside one bot cannot cover several bots, and its threshold is looser than
  P1. Rejected as the primary gate.

## Consequences

- A merge waits for each bot's round on the final head commit, up to about
  20 minutes per round. Past that, the owner decides.
- Adding a bot means adding its row to the bot table in the policy doc. The
  gate itself does not change.
- The `AGENTS.md` rule that GitHub posts need user confirmation gets one
  exception: an owner's standing authorization to babysit a PR covers replies
  to bot threads and resolving them. Threads from human reviewers still need
  confirmation.

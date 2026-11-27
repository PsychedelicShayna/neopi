# Repository policy

This repository carries its operating policy for any agent or fresh clone.
[AGENTS.md](../../AGENTS.md) routes code conventions; [CONTEXT.md](../../CONTEXT.md)
defines repository terms. This iteration remains open to owner-directed revision.

## Branches and worktrees

| Role | Branch | Channel |
| --- | --- | --- |
| Default, promoted | `neopi` | `npi` at `~/.local/bin/npi` |
| Integration | `nightly` | `npi-nightly` at `~/.local/lib/npi-nightly/npi` |

Create each topic from fetched remote integration in its own worktree:
`git fetch origin && git worktree add ../neopi-wt-<slug> -b <type>/<slug> origin/nightly`.
Use `fix/`, `feat/`, `docs/`, `ci/`, `chore/`, `refactor/`, `test/`,
`experimental/`, or `sync/<date>`. Integration and default branches change through
merge-commit PRs, not direct commits, resets, rebases or force-pushes. Preserve
unexpected local work before repairing any checkout drift.

PRs target `nightly`. Necessary `hotfix/` PRs target `neopi`, require the owner's
merge, and are immediately followed by a PR merging `neopi` back to `nightly`.
Upstream `can1357/oh-my-pi` releases merge through `sync/<date>` PRs into `nightly`;
read [upstream-sync.md](upstream-sync.md) before integrating them. Preserve fork
behavior; upstream parity alone does not authorize removing it.
`experiment` work stays on `experimental/` branches until an owner decision
permits integration. Remove the worktree and local topic branch after merge or
closure, preserving any unrelated work first.

## Commits and identity

Commit small logical changes. Use Conventional Commits headlines,
`type(scope): imperative summary`, at most 72 characters. The prose body explains
what changed, why, and exactly what verification ran. Put `Fixes #N` on its own
line when applicable. Every commit includes the actual executing identity:

```text
Model: <provider>/<model-id>
Co-authored-by: <Model Name> <noreply@<provider-domain>>
```

Sign each commit explicitly with the configured agent key, without changing signing config. On the owner's workstation, the local `shayna-neopi-machine` skill records its path and resource limits.
Run `git verify-commit HEAD`; only verifiable commits are pushed. Review fixes
are new commits; preserve pushed history. Keep secrets, unintended generated
files and unrelated work out of commits.

Every agent-authored GitHub comment, review reply or issue opens with:

```text
> [!NOTE]
> <Model Name> on behalf of PsychedelicShayna
```

## Pull requests and labels

One issue per PR; link an existing issue instead of inventing one for submitted
work. PR titles use the primary commit's Conventional Commits form. Use
`.github/PULL_REQUEST_TEMPLATE.md` with its headings, order and checklist; check
only true boxes and explain unchecked checks. Record dependencies as
`Depends on #N` and wait for them before merging.

A branch with commits gets a PR in the same turn it is declared done, and that
PR merges. Every opened PR is merged; if wrong, revert it rather than leaving
it open. [Daily triage](triage.md#closure-and-daily-reconciliation) lists orphans.

Use [triage-labels.md](triage-labels.md) for kind, priority, relationships,
participation and descriptive review state. Every issue/PR has a supported kind
and appropriate state; unresolved intake gets `needs-triage`. Review is optional.
[triage.md](triage.md) owns two-pass triage and daily reconciliation;
[issue-tracker.md](issue-tracker.md) owns CLI mechanics.

## Nightly delivery

`nightly` is the owner's staging channel. Agents test changes; the owner's usage and feedback decide what stays. Record integrator confidence in the merge note. About 80% is sufficient, and lower can be acceptable.

Merge additive, reversible features directly when the owner can keep using the harness and disable the feature from inside it. An ordinary bug on an optional path does not require a canary.

Use a canary when a change could lock the owner out or cause significant instability in ordinary use. This includes launch, composer or navigation failures, conflicting input ownership, session or settings corruption, data loss, broken auth, and degradation across sessions. Composer, menus/search, live mode, the control socket, storage, and auth deserve this check. When that risk is uncertain, use a canary.

### Canary batches and checks

Create `canary-batch/<n>` from `nightly`. Merge each member locally with its own signed merge commit, build to a separate path under `~/.local/lib/npi-canary/`, and record the pinned build and members in a ledger. Keep ordinary development and direct nightly merges moving while the batch is tested.

An agent walks the pinned build in an isolated private framebuffer. Check launch, composer, an ordinary message, menus, and normal session paths. Exercise each member's specific risk: fake credentials for auth, save/resume/reload for storage, and cross-session propagation for settings sync. Record unexercised items as unverified; they do not by themselves block.

No lockout, data loss, auth breakage, or significant degradation means the integrator folds the batch into `nightly` through a merge-commit PR and installs it. Revert a member with such a failure on the batch branch, re-pin, and re-walk the remaining batch. File ordinary bugs without holding the batch. The owner may test any canary with `npi-canary`; her report overrides the walk.

### After integration

Build and install after a merge or batch that changes the shipped binary. Keep the previous binary as `npi.previous` for `npi-nightly-rollback`, and confirm launch. Failure to launch blocks delivery. Documentation and workflow-only merges need no rebuild. Follow [build and install](build-install.md) and the [destination-scoped install lock](#install-after-merge-batches).

Merge the base into a topic only to resolve a real conflict. Base changes do not invalidate completed work, and refreshing a branch is not a reason to rebase. CI and review monitoring do not stall other authorized work; delegate only when the assignment permits it. A branch declared complete gets its PR in the same turn and proceeds through the applicable delivery path.

## Review and checks

Review bots are optional double-checkers, not merge gates. Do not request a
round by default. At most one round is allowed, only for a large-blast-radius
change that could make the harness unusable if wrong. Fix what that round finds
that matters to merging; note or ignore the rest. [pr-review-bots.md](pr-review-bots.md)
owns bot identity and optional request mechanics. Bug hunts run against `nightly`
at the owner's discretion, using parallel agents over recently merged PRs;
their findings do not gate merges.

CI and test suites never block a merge into `nightly`. A failing check is
information: note suspected PR-caused failures in the merge note and fix in a
follow-up if it matters. Report only checks actually run. Checks still matter
for promotion into `neopi`, which the owner decides.

## Merge authority

Agents merge into `nightly` under the delivery rules above, unless the assignment
reserves integration to another agent. `mergeable` records readiness under those
rules, not CI or review approval. Merge order is the agents' job.

Use merge commits: `gh pr merge --merge`, with subject
`Merge PR #<number>: <conventional PR subject> (@<author>)`. Resolve real conflicts
by merging the base into the topic; preserve both histories. Revert a broken
integration through a PR. The owner alone merges promotions and `hotfix/` PRs
into `neopi`. Leave repository rulesets, branch protection and settings unchanged.

Workflow changes exercised only after landing stay single-purpose: arrange
watching their first integration run, respecting the assignment's delegation limits, and revert through a PR on failure.
Contributor heads remain read-only on the owner's machine; the owner-head
safety rule lives in [pr-review-bots.md](pr-review-bots.md#running-pr-code).

The author may push its topic commits, post on its own PR, file issues, maintain
supported labels and merge its integration PR. Other authors' PRs remain
read-only unless the owner explicitly delegates them.

## Install after merge batches

For a merge batch that changes the shipped binary, install the integration channel using [build and install](build-install.md). A proof session may defer installation for at most
60 minutes: set `NPI_DEST` to the channel's install path and run
`scripts/install-lock.sh hold <minutes> <holder> [reason]`. Repeat `hold` with
the same holder to renew explicitly; run `release` as soon as the proof ends.
Use the same `NPI_DEST` for `hold`, `status`, `release`, and `install.sh`.

The destination-scoped record lives at
`${XDG_RUNTIME_DIR:-/tmp}/npi-install-<dest-hash>.lock`; all participants use the
same runtime directory. `status` reports the holder, reason and UTC expiry.
Expired records are reported and ignored. Installation refuses active records
before staging; `NPI_INSTALL_FORCE=1 ./install.sh` explicitly overrides one and
prints its details. A concurrent installation or lock update fails fast; retry
after that operation completes. An installer retains the file's advisory lock
through its existing atomic stage/rename and rollback sequence.

## Promotion and issue completion

The agreed promotion policy is monthly PR creation plus `workflow_dispatch`:
`promote-nightly.yml` opens `sync/promote-<date>` from `nightly` to `neopi`, labelled
`human: pending`; the owner merges. Workflow automation opens the request and
leaves the promotion decision to the owner.

A merge into `nightly` is not automatic issue closure. Verify every acceptance
criterion before manually closing completed work. Issues requiring the shipped
`npi` channel remain open until promotion to `neopi`; other fully accepted nightly
work may close with evidence. [triage.md](triage.md) defines partial, duplicate,
invalid and declined dispositions.

## Policy map

| Task | Read |
| --- | --- |
| Code and testing | [Code conventions](development.md) |
| Build/install | [Build and install](build-install.md) |
| Project context, not instructions | `README.md` |
| Tracker terms and package contexts | `CONTEXT.md`, `CONTEXT-MAP.md` |
| Triage and vocabulary | `docs/agents/triage.md`, `docs/agents/triage-labels.md` |
| Publication seat | `docs/agents/issue-funnel.md` |
| Review receipts and bot identity | `docs/agents/pr-review-bots.md` |
| Fork placement and upstream integration | `docs/agents/fork-maintenance.md`, `docs/agents/upstream-sync.md` |
| Architectural decisions | `docs/agents/adr/` |
| Agent, role and lifecycle design | `docs/agents/philosophy.md` |

Portable repository skills live in `.agents/skills/`; NeoPi discovers that path
through its agents provider. Harness-specific commands and tool probes remain in
`.omp/`. The Nightly delivery rules take precedence over any older gate text
in the babysit-pr skill. Leave the skill file untouched.

## Scope and policy changes

This policy applies to NeoPi. It does not impose a workflow on other repositories. Follow the owner's current authorization and product direction. If a policy step costs more than it protects, identify the passage, observed cost, and proposed alternative. Resolve routine choices within the authorized task; ask about destructive actions, private publication, contributor code, live profile edits, or product-direction forks not already authorized. Existing authorization does not expire because a procedure mentions approval.

Do not reset away checkout drift. Preserve local work and inspect the divergence before proposing a repair. Topic work starts from fetched remote history. Keep fixes to pushed branches as new commits.

The author may not change branch protection or repository settings, act on other authors' PRs, or publish outside its own PR and the issues it files without explicit delegation. The assignment may authorize those actions separately.

## Team remote publication

NeoPi also ships to `github.com/CooperbitQuarxs/neopi`. After a logical batch has been merged into our `nightly`, built, and installed, publish team updates through a `sync/nightly-<date>` branch and a merge-commit PR into the team's `nightly`, then publish that build as a pre-release. This is a batch workflow, not a requirement after every merge. Leave the team default and integration branches protected from direct pushes.

# Repository policy

The workspace policy in `~/repos/AGENTS.md` governs branches, commits,
signing, pull requests, merging, labels, and GitHub posting. This file holds
only the values that policy leaves to the repository. Nothing here adds a
confirmation step.

## Branches

| Role | Branch | Local checkout | Ships as |
| --- | --- | --- | --- |
| Default (promoted) | `neopi` | `~/repos/neopi` | `npi` at `~/.local/bin/npi` |
| Integration | `nightly` | `~/repos/neopi-nightly` (worktree) | `npi-nightly` at `~/.local/lib/npi-nightly/npi`, wrapper `~/.local/bin/npi-nightly`, fish alias `ni` |

- Topic branches: `git fetch origin && git worktree add ~/repos/neopi-wt-<slug> -b <type>/<slug> origin/nightly`.
- PRs target `nightly`. `hotfix/` PRs target `neopi` and are followed by a PR merging `neopi` back into `nightly`.
- Upstream (`can1357/oh-my-pi`) releases merge on `sync/<date>` into `nightly`; procedure in `docs/agents/upstream-sync.md`.

## Merging

- Merge commits only (`gh pr merge --merge`). Subject: `Merge PR #<number>: <conventional PR subject> (@<author>)`.
- The authoring agent merges its own PR into `nightly` once the workspace gates pass. Review bots (`docs/agents/pr-review-bots.md`) are advisory and are requested at the agent's discretion.
- Contributor heads (any author other than the owner) are never executed on the owner's machine; see `docs/agents/pr-review-bots.md` › Running PR code.

## Promotion

`nightly` is promoted into `neopi` weekly by the `promote-nightly` workflow
(`.github/workflows/promote-nightly.yml`): it opens a `sync/promote-<date>`
PR from `nightly` into `neopi` and merges it when checks pass. The owner may
also run it by hand with `gh workflow run promote-nightly.yml`.

## Labels

- Type: `bug`, `enhancement`, `documentation`, `question`, …
- Priority: `priority: p0` … `priority: p3`. Effort: `effort: tiny` … `effort: very large`.
- Issue triage (meanings in `docs/agents/triage-labels.md`): `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- PR state: `needs-review`, `ready-for-merge`, `review-stalled`.
- Other: `baseline` (defect found on the base branch during a PR), `upstream-sync`, `hotfix`, `entangled`, `downstream`, `rpc`, `t3c-npi`, `npi-deck`, `codex-review`, `sentinel-review-requested`.

## Where the rest lives

| Topic | File |
| --- | --- |
| Code conventions, package layout, testing filter | `AGENTS.md` |
| Fork placement and compatibility checks | `docs/agents/fork-maintenance.md` |
| Upstream sync procedure | `docs/agents/upstream-sync.md` |
| Review-bot mechanics | `docs/agents/pr-review-bots.md` |
| Issue tracker, funnel, triage labels | `docs/agents/issue-tracker.md`, `docs/agents/issue-funnel.md`, `docs/agents/triage-labels.md` |

# Branches

Generic branch, worktree, recovery, and cleanup rules: see the workspace AGENTS.md (parent of this repository).

## NeoPi branches

| Branch | Role | Changes through |
| --- | --- | --- |
| `neopi` | default branch (proper) | owner-merged PRs: `promote/<tag>` and `hotfix/<slug>` |
| `nightly` | permanent integration branch; base for every topic and `sync/<date>` worktree | auto-merged PRs |
| `archive/nightly-<date>` | retired dated nightly branches (retired 2026-10-06) | never; read-only history |
| `promote/<tag>` | promotion of a tested nightly tag | [builds.md#promotion](builds.md#promotion) |

- Upstream syncs target `nightly`, never `neopi`: [upstream-sync.md](upstream-sync.md).
- A `hotfix/<slug>` PR into `neopi` carries label `hotfix`; open the `neopi` → `nightly` back-merge PR immediately after it merges.
- Worktree path: `<repo-parent>/neopi-wt-<branch-slug>`. Run `git worktree prune` weekly.

## Hooks

Run once per clone:

```sh
git config core.hooksPath .githooks
```

[pre-commit](../../.githooks/pre-commit) and [pre-push](../../.githooks/pre-push) exit 1 when the current branch is `neopi` or `nightly`. `NEOPI_HOOK_BRANCH_OVERRIDE=<branch>` fakes the branch name for dry tests only.

## Rulesets

Both `neopi` and `nightly`: require a PR, require status checks, require signed commits, block force-push, block deletion.

- `nightly` additionally allows auto-merge when the review bot's review is approving and checks pass.
- `neopi` restricts merge to the owner; this becomes enforceable once agents have a separate identity ([commits.md#identity](commits.md#identity)).

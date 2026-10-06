# Pull requests

PR lifecycle, body sections, babysitting loop and round cap, flaky-CI evidence, comment header, autonomy, merge authority, and the pipeline-config exception: see the workspace AGENTS.md (parent of this repository).

## NeoPi pipeline

issue → worktree from `origin/nightly` → PR into `nightly` labelled `needs-review` → scoped Codex review ([review-bots.md#codex](review-bots.md#codex)) → babysit → `ready-for-merge` → GitHub auto-merge → worktree removed.

`neopi` receives only `promote/<tag>` PRs ([builds.md#promotion](builds.md#promotion)) and `hotfix/<slug>` PRs; the owner merges both.

## Labels

These exist as of 2026-10-06.

| Label | Where | Meaning |
| --- | --- | --- |
| `needs-review` | PR | Published; review loop running. |
| `ready-for-merge` | PR | Bot clean; `nightly` auto-merge may proceed. |
| `ready-for-human` | PR | Round cap or bot silence reached; owner decides. |
| `codex-review` | issue | Its PR gets the scoped Codex review (default for all `nightly` PRs). |
| `sentinel-review-requested` | issue or PR | The PR must also pass the [sentinel panel](review-bots.md#sentinel) before `ready-for-merge`; always set on promotions. |
| `baseline` | issue | Pre-existing defect found during review; fixed outside the PR. |
| `upstream-sync` | PR | `sync/<date>` PR ([upstream-sync.md](upstream-sync.md)). |
| `hotfix` | PR | `hotfix/<slug>` into `neopi`. |
| `bug`, `enhancement`, `documentation` | issue or PR | Type labels. |

# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues at `PsychedelicShayna/neopi`. Use the `gh` CLI from this clone so it resolves the repository from `origin`.

## Conventions

- Create: `gh issue create --title "..." --body-file <path>`.
- Read: `gh issue view <number> --comments`, including labels.
- List: `gh issue list --state <state> --json number,title,body,labels,comments` with the filters the task requires.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close an issue when the fix merged (`Fixes #<n>` in the merging commit does it), when it is a verified duplicate, or when the owner said so. Say why in the closing comment.
- Posting rules are the workspace policy in `~/repos/AGENTS.md` (comment identity block, labels). This guide is mechanics only.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill meanings

- "Publish to the issue tracker" means create a GitHub issue.
- "Fetch the relevant ticket" means read the GitHub issue, its comments, and labels.

## Dual taxonomy

House labels (type, `effort:*`, `priority:*`, and `entangled` only for true alternative clusters) and Matt triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) are **orthogonal layers**, not replacements. An issue may carry both. Do not strip house labels to be Matt-only. The Issue Funnel contract is `docs/agents/issue-funnel.md`.

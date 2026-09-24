# Synchronizing an upstream release

Use this procedure for every upstream release integration. GitHub's remote default branch is the source of truth. A local checkout is a work surface, not a release baseline.

RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT`.

## Invariants

- MUST start from freshly fetched `origin/<default>` after every prerequisite PR has merged with checks, build, and runtime proof.
- MUST use the newest upstream release tag, not an arbitrary branch tip.
- MUST preserve dirty work and local-ahead commits before integration.
- MUST resolve conflicts personally, sequentially, one file at a time. NEVER delegate conflict resolution.
- MUST record each resolution in the ledger while resolving it.
- MUST preserve fork behavior unless upstream satisfies the same observable contract.
- MUST land through a PR after checks, build, staged installation, and runtime proof pass. NEVER commit or push directly to the default branch.
- MUST sign every commit with the agent signing key and attribute the actual executing provider/model.

## 1. Preserve local work

Identify the remote default branch and fetch both remotes:

```sh
DEFAULT=$(git remote show origin | sed -n '/HEAD branch/s/.*: //p')
git fetch origin --prune
git fetch upstream --tags --prune
```

Before creating the integration worktree:

1. Inspect the main checkout's tracked, untracked, and ignored-in-scope work.
2. Put unfinished dirty work on a named local `wip/<topic>` branch and create a signed WIP commit that names exactly what is preserved. Keep that branch local when the work is not ready for review; do not use a stash as durable storage.
3. Put reviewable work and every ready local-ahead commit on a topic branch. Validate its checks, build, and runtime behavior, then push and merge through a PR. Preserve unrelated topics as separate PRs; park unfinished commits on WIP branches.
4. Fetch `origin` again. Confirm each prerequisite PR merge is present in `origin/$DEFAULT`.
5. Leave WIP branches and recovery refs intact until the integration is merged, installed, and smoke-tested.

A local-ahead default branch is never silently reset or used as the integration base. Its commits must first be preserved on a topic branch. If they are ready, the corresponding PR must be merged before the integration worktree is created; otherwise they remain parked on the WIP branch and are not part of this sync.

## 2. Select the release and create a fresh worktree

Find the highest release tag from the upstream remote:

```sh
TAG=$(git ls-remote --tags upstream 'v*' \
  | sed 's#.*refs/tags/##' \
  | grep -v '\^{}' \
  | sort -V \
  | tail -1)
printf '%s\n' "$TAG"
```

Confirm the tag is the intended release and that `origin/$DEFAULT` contains every prerequisite merge. Then create a new branch and worktree directly from the remote-tracking ref:

```sh
git worktree add -b "sync/upstream-$TAG" \
  "$HOME/source/github/PsychedelicShayna/neopi-sync-$TAG" \
  "origin/$DEFAULT"
```

Never branch this worktree from the main checkout's local default branch, another integration branch, or a directory containing WIP.

## 3. Create recovery refs

In the fresh worktree, record immutable recovery points before merging:

```sh
git branch "backup/neopi-pre-upstream-$TAG" "origin/$DEFAULT"
git rev-parse "$TAG^{}"
```

Inspect and verify the tag signature where present; an invalid signature is a blocker, not an unsigned-tag fallback. Record an unsigned tag explicitly. Record the source commit, tag commit, and recovery ref at the top of `docs/updates/<date>-upstream-$TAG.md`.

## 4. Merge and keep the conflict ledger live

Start the merge from the tag object:

```sh
git merge --no-ff --no-commit "$TAG"
```

Create the ledger immediately. Its conflict table has these columns:

| Path | Resolution | Fork behavior kept | Upstream change taken | Why |
| --- | --- | --- | --- | --- |

Process `git diff --name-only --diff-filter=U` in its printed order:

1. Read the base, ours, theirs, surrounding owner modules, and relevant tests.
2. Resolve exactly one file personally. Use `ours` or `theirs` only when the whole file has that ownership; otherwise merge manually.
3. Preserve the fork's advisor delivery, Chronicler, eval backends, live/STT behavior, portable/flash path, extension installer hooks, and NeoPi identity unless the upstream implementation demonstrably replaces the same contract.
4. Adopt upstream refactors and reseat fork behavior on the new owner rather than restoring obsolete structure.
5. Append that file's ledger row before staging it.
6. Stage the file, confirm its conflict markers are gone, then continue to the next path.

Never batch-write the ledger after all conflicts are resolved. Never ask a subagent to choose or implement a conflict resolution. Read-only research may explain upstream intent, but the integrating agent owns every decision and edit.

After explicit conflicts are resolved, inspect automatically merged changes at every fork integration point. A clean textual merge is not evidence of behavioral compatibility. Add a `brand re-seat` ledger entry for any upstream text or code routed back through NeoPi's `APP_NAME` or `PRODUCT_NAME` contracts.

For generated lockfiles, take upstream as the starting point, then regenerate from the merged tree. Review dependency changes before executing installers; audit every newly introduced dependency rather than accepting it because a lockfile changed.

## 5. Commit and verify

Complete the merge with a signed merge commit:

```sh
git commit -S/home/shayna/.ssh/id_ed25519_github_signing_agents.pub \
  -m "Merge upstream $TAG into neopi" \
  -m "Integrate the release with the per-file resolution ledger in docs/updates/." \
  -m "Co-authored-by: <actual executing model identity and address>"
git verify-commit HEAD
```

Replace the attribution placeholder with the actual model identity from the running session. Never claim another model performed the work. Put post-merge fixes in separate signed logical commits with a short subject, explanatory body, actual-model attribution trailer, and `git verify-commit` proof for each commit.

Run verification from the integration worktree. At minimum:

```sh
bun install --frozen-lockfile
./build.sh    # fresh native addon first: tests load it too
CARGO_BUILD_JOBS=6 bun run check
bun --cwd=packages/coding-agent test
bun --cwd=packages/catalog test
bun --cwd=packages/ai test
bun --cwd=packages/tui test
bun run test:scripts
packages/coding-agent/dist/npi --smoke-test
```

Also run every focused test that covers a conflicted path. Exercise the changed runtime path rather than relying only on tests. Record exact commands, pass counts, failures, and any unavailable check in the ledger's `## Verification` section. Record binary version and smoke evidence under `## Binary`. A failure may be classified as pre-existing only with evidence from the unmodified base or upstream tag.

The built artifact must be `packages/coding-agent/dist/npi`, produced by `./build.sh`. Every upstream version bump invalidates the gitignored native addon in each checkout; `build.sh` detects that and rebuilds it, so never assemble the build from individual `bun run` commands. Source-fork verification and installation never use a remote installer, `bun setup`, a global package install, or a differently named binary.

Before PR merge, stage an installation in a temporary prefix: `NPI_DEST=<prefix>/bin/npi PI_CODING_AGENT_DIR=<prefix>/agent ./install.sh`, then verify the managed links resolve to this checkout. Exercise that installed binary's `--version`, `--smoke-test`, `--help`, and a real prompt (`-p "Reply with exactly: OK"`). Record the observed version, exit statuses, response, and extension result. MUST keep the live installation and profile untouched during this proof.

## 6. Publish through a PR

Push the integration branch, create a PR targeting the remote default branch, and summarize:

- upstream tag and commits;
- recovery ref;
- conflict count and ledger path;
- fork contracts preserved or replaced;
- dependency changes and audit result;
- checks, focused tests, package suites, build, version, and smoke result;
- pre-existing failures with base evidence.

Merge only after the local evidence is green and the PR's required checks pass. Preserve the merge commit; do not bypass the PR by pushing the integration directly to the default branch.

## 7. Realign the main checkout safely

After the PR merges:

```sh
git fetch origin --prune
git switch "$DEFAULT"
git merge-base --is-ancestor HEAD "origin/$DEFAULT" &&
  git merge --ff-only "origin/$DEFAULT"
```

Run that fast-forward path only after preserving dirty work and confirming the main checkout is clean. If its tip is not an ancestor of the fetched remote default:

1. Stop and enumerate the local-ahead commits.
2. Confirm each commit is preserved on a WIP/topic branch and, when intended for the default branch, represented by an already merged PR.
3. Create `backup/local-$DEFAULT-<date>-<time>` at the current local tip.
4. Detach at `origin/$DEFAULT`, repoint the local default branch to that fetched ref, then switch back to it.
5. Keep the backup and WIP refs until the installed `npi` build passes version, smoke, and a real prompt.

Never realign a local default branch merely because a similarly named PR exists. Verify the PR incorporated the commit's intended tree changes first. Never delete or overwrite a WIP branch as cleanup for an upstream sync.

Before installing, compare the verified integration tree with `origin/$DEFAULT`. If they differ, build and verify the fetched remote tree in a fresh worktree. Back up the existing `npi` binary, then run `./build.sh && ./install.sh` from the realigned checkout; this also refreshes that checkout's native addon, which otherwise stays at the previous release and fails the next build. MUST verify the installed binary's version, smoke test, help, and a real prompt, plus extension links and startup errors. Restore preserved local-only configuration afterward without overwriting source changes; keep recovery refs. The upstream installer is not part of this source-fork workflow.

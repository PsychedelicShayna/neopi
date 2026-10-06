# Synchronizing an upstream release

Use this runbook for every upstream release integration. The workspace AGENTS.md (parent of this repository) sets the `sync/<date>` target, the fork bias, and the immutable-marker rule; this file is NeoPi's procedure.

RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT`.

## Invariants

- MUST start from freshly fetched `origin/nightly` after every prerequisite PR has merged.
- MUST merge the newest upstream release tag, not `main` head or another branch tip.
- MUST preserve dirty work and local-ahead commits before integration.
- MUST resolve conflicts personally, sequentially, one file at a time. NEVER delegate conflict resolution.
- MUST record each resolution in `SYNC-LEDGER.md` while resolving it.

## Immutable fork code

The Ctrl+Space xAI STT path (PR #241) carries an immutable marker. Look up each fork feature's immutability in [fork-maintenance.md](../agents/fork-maintenance.md#fork-feature-register) before resolving a conflict in it.

Case study: an earlier sync rewired Ctrl+Space, the owner's accessibility STT path, into upstream's new STT route because "upstream implemented it". Upstream's route was live transcription with lower quality on the owner's mic. The fork path is a reserved escape hatch that must behave identically forever.

## 1. Preserve local work

Fetch both remotes:

```sh
git fetch origin --prune
git fetch upstream --tags --prune
```

Before creating the integration worktree:

1. Inspect the main checkout's tracked, untracked, and ignored-in-scope work.
2. Put unfinished dirty work on a named local `wip/<topic>` branch and create a [signed](commits.md#signer) WIP commit naming exactly what is preserved. Keep that branch local when the work is not ready for review; do not use a stash as durable storage.
3. Put reviewable work and every ready local-ahead commit on a topic branch; land it through the [PR pipeline](pull-requests.md). Preserve unrelated topics as separate PRs; park unfinished commits on WIP branches.
4. Fetch `origin` again. Confirm each prerequisite PR merge is present in `origin/nightly`.
5. Leave WIP branches and recovery refs intact until the sync has shipped in a tested nightly build.

Never silently reset a local-ahead protected branch or use it as the integration base; preserve it first, then recover it per the workspace AGENTS.md.

## 2. Select the release and create the worktree

Find the highest release tag from the upstream remote:

```sh
TAG=$(git ls-remote --tags upstream 'v*' \
  | sed 's#.*refs/tags/##' \
  | grep -v '\^{}' \
  | sort -V \
  | tail -1)
printf '%s\n' "$TAG"
```

Confirm the tag is the intended release. Then create the worktree from the remote-tracking ref:

```sh
DATE=$(date +%F)
git worktree add -b "sync/$DATE" \
  "<repo-parent>/neopi-wt-sync-$DATE" \
  origin/nightly
```

## 3. Create recovery refs

In the fresh worktree, record recovery points before merging:

```sh
git branch "backup/nightly-pre-upstream-$TAG" origin/nightly
git rev-parse "$TAG^{}"
```

Inspect and verify the tag signature where present; an invalid signature is a blocker, not an unsigned-tag fallback. Record an unsigned tag explicitly. Record the source commit, tag commit, and recovery ref at the top of `SYNC-LEDGER.md`.

## 4. Merge and keep the ledger live

```sh
git merge --no-ff --no-commit "$TAG"
```

Create `SYNC-LEDGER.md` immediately and commit it with the merge. Its conflict table has these columns:

| Path | Resolution | Fork behavior kept | Upstream change taken | Why |
| --- | --- | --- | --- | --- |

Process `git diff --name-only --diff-filter=U` in its printed order:

1. Read the base, ours, theirs, surrounding owner modules, and relevant tests.
2. Resolve exactly one file personally. Use `ours` or `theirs` only when the whole file has that ownership; otherwise merge manually.
3. Apply the fork bias and the [immutable fork code](#immutable-fork-code) check. Preserve advisor delivery, Chronicler, eval backends, live/STT behavior, portable/flash path, extension installer hooks, and NeoPi identity.
4. Adopt upstream refactors only where they keep fork behavior intact; reseat that behavior on the new owner rather than restoring obsolete structure.
5. Append that file's ledger row before staging it.
6. Stage the file, confirm its conflict markers are gone, then continue to the next path.

Never batch-write the ledger after resolution. Read-only research may explain upstream intent, but the integrating agent owns every decision and edit.

After explicit conflicts are resolved, inspect automatically merged changes at every fork integration point. A clean textual merge is not evidence of behavioral compatibility. Add a `brand re-seat` ledger entry for any upstream text or code routed back through NeoPi's `APP_NAME` or `PRODUCT_NAME` contracts.

For generated lockfiles, take upstream as the starting point, then regenerate from the merged tree. Review dependency changes before executing installers; audit every newly introduced dependency.

## 5. Commit and verify

Create the merge commit with the [signer](commits.md#signer), subject `chore(sync): merge upstream $TAG into nightly`. Put post-merge fixes in separate signed logical commits.

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

Also run focused tests for every touched package and conflicted path. Exercise the changed runtime path. Record exact commands, pass counts, failures, and unavailable checks in `SYNC-LEDGER.md` under `## Verification`; record binary version and smoke evidence under `## Binary`. Classify a failure as pre-existing only with evidence from the unmodified base or upstream tag.

Stage an installation in a temporary prefix: `NPI_DEST=<prefix>/bin/npi PI_CODING_AGENT_DIR=<prefix>/agent ./install.sh`. Verify the managed links resolve to this worktree. Exercise the staged binary's `--version`, `--smoke-test`, `--help`, and a real prompt (`-p "Reply with exactly: OK"`). Keep the live installation and profile untouched.

## 6. Publish

Push `sync/$DATE`, then open a PR into `nightly` under [PR policy](pull-requests.md) with label `upstream-sync`. Summarize the upstream tag and commits, recovery ref, conflict count and `SYNC-LEDGER.md`, preserved fork contracts, dependency audit, checks, build, version, smoke result, and evidence for pre-existing failures.

Post the [Codex template](review-bots.md#codex) with this extra Context instruction: `Look for interaction bugs the merge could not see: fork features built under the old upstream system now running under the new one. Do not review upstream's own defects.`

## 7. After merge

Remove the worktree. Do not promote the sync to `neopi` until it has shipped in a tested nightly build; use [builds.md](builds.md).

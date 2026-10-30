# Synchronizing an upstream release

Use this procedure for every upstream release integration. Upstream syncs land on the integration branch `nightly` ([repository policy](policy.md) › Branches and worktrees), never directly on the default branch; `nightly` is promoted to `neopi` on its own schedule. Everywhere below, `$DEFAULT` therefore means `nightly`. GitHub's remote branch is the source of truth. A local checkout is a work surface, not a release baseline.

RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT`.

## Invariants

- MUST start from freshly fetched `origin/nightly`; merge prerequisite PRs first without waiting for CI or review.
- MUST use the newest upstream release tag, not an arbitrary branch tip.
- MUST preserve dirty work and local-ahead commits before integration.
- MUST resolve conflicts personally, sequentially, one file at a time. NEVER delegate conflict resolution.
- MUST record each resolution in the ledger while resolving it.
- MUST preserve fork behavior unless upstream satisfies the same observable contract.
- MUST land through a PR under [Nightly delivery](policy.md#nightly-delivery), then build/install and check launch. CI/tests never block integration. NEVER commit or push directly to `nightly` or the default branch.
- MUST sign every commit with the agent signing key and attribute the actual executing provider/model.

## 1. Preserve local work

Set the integration branch and fetch both remotes:

```sh
DEFAULT=nightly
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
   The fork-owned Ctrl+Space whole-recording xAI route and its takeover gate in `packages/coding-agent/src/modes/interactive-mode.ts` must always preempt configured dictation; preserve this priority across upstream STT and key-event changes (#225).
4. Adopt upstream refactors and reseat fork behavior on the new owner rather than restoring obsolete structure.
5. Append that file's ledger row before staging it.
6. Stage the file, confirm its conflict markers are gone, then continue to the next path.

Never batch-write the ledger after all conflicts are resolved. Never ask a subagent to choose or implement a conflict resolution. Read-only research may explain upstream intent, but the integrating agent owns every decision and edit.

After explicit conflicts are resolved, inspect automatically merged changes at every fork integration point. A clean textual merge is not evidence of behavioral compatibility. Add a `brand re-seat` ledger entry for any upstream text or code routed back through NeoPi's `APP_NAME` or `PRODUCT_NAME` contracts.

For generated lockfiles, take upstream as the starting point, then regenerate from the merged tree. Review dependency changes before executing installers; audit every newly introduced dependency rather than accepting it because a lockfile changed.

### Regenerate Settings and command provenance

After the integrated tree is committed, regenerate the committed provenance inventory:

```sh
bun scripts/generate-entry-provenance.ts "$PREVIOUS_UPSTREAM_COMMIT" "$TAG" "$(git rev-parse HEAD)"
bun test scripts/generate-entry-provenance.test.ts packages/tui/test/entry-provenance.test.ts
```

`PREVIOUS_UPSTREAM_COMMIT` is the upstream release commit from the preceding sync, not the fork's pre-merge head. The generator parses the setting and builtin slash-command registries at all three revisions without executing historical code. Commit `packages/coding-agent/src/config/entry-provenance.json` with the sync's post-merge changes. It replaces, rather than accumulates, the latest-release marks: entries added between the two upstream revisions receive a star; entries in the integrated fork but absent from the new upstream receive a crescent. The theme's Unicode, Nerd Font and ASCII presets supply the corresponding glyphs. The star means “new in the most recent upstream sync,” not “new to this session.”

Regenerate against the same two upstream revisions after adding or removing fork settings or builtin commands. The generator records the fork revision used for the inventory; pass an immutable commit as above. Its regression test also compares the resulting classifications with the current registries, so stale inventories are detected.


## 5. Commit and verify

Complete the merge with a signed merge commit:

```sh
git commit -S/home/shayna/.ssh/id_ed25519_github_signing_agents.pub \
  -m "Merge upstream $TAG into nightly" \
  -m "Integrate the release with the per-file resolution ledger in docs/updates/." \
  -m "Co-authored-by: <actual executing model identity and address>"
git verify-commit HEAD
```

Replace the attribution placeholder with the actual model identity from the running session. Never claim another model performed the work. Put post-merge fixes in separate signed logical commits with a short subject, explanatory body, actual-model attribution trailer, and `git verify-commit` proof for each commit.

Checks provide information rather than blocking nightly. Delegate any watching to a cheap poller; choose focused checks relevant to the sync and report only what ran. Examples:

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

Record observed commands, results and unavailable checks in the ledger's `## Verification` section. Note suspected sync-caused failures in the merge note and follow up if they matter. Record post-merge build/install and launch evidence under `## Binary`; owner-decided promotion retains its check requirements.

The built artifact must be `packages/coding-agent/dist/npi`, produced by `./build.sh`. Every upstream version bump invalidates the gitignored native addon in each checkout; `build.sh` detects that and rebuilds it, so never assemble the build from individual `bun run` commands. Source-fork verification and installation never use a remote installer, `bun setup`, a global package install, or a differently named binary.

After the nightly merge or batch, build and install `npi-nightly` using `AGENTS.md` and check that it launches. A temporary-prefix installation may supply additional evidence without replacing the delivery step. Proof sessions use the bounded destination lock in [policy.md](policy.md#nightly-delivery), releasing promptly; protect the separate default-channel installation and profile.

## 6. Publish through a PR

Push the `sync/<date>` topic branch, create a PR targeting `nightly`, and summarize:

- upstream tag and commits;
- recovery ref;
- conflict count and ledger path;
- fork contracts preserved or replaced;
- dependency changes and audit result;
- checks, focused tests, package suites, build, version, and smoke result;
- pre-existing failures with base evidence.

Merge into `nightly` at about 80% integrator confidence (lower acceptable), recording confidence and suspected PR-caused check failures in the merge note; CI/tests and optional review do not block integration. Build/install nightly after the merge or batch and check launch under [policy.md](policy.md#nightly-delivery). The owner alone decides promotion into the default branch. Preserve merge commits and never push either protected branch directly.

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

After each nightly merge or batch, use `AGENTS.md`'s `./build.sh` and nightly-destination `install.sh` commands, then check that `npi-nightly` launches. Respect the ten-minute proof hold and release in [policy.md](policy.md#nightly-delivery); preserve local configuration and recovery refs. Additional smoke/version checks are information, not integration prerequisites. Updating the separate `npi` default channel belongs to owner-decided promotion.

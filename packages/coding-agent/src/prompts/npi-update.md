Update the local `PsychedelicShayna/neopi` source fork to the newest stable upstream release and leave the separate `npi` installation ready to use.

<critical>
- NEVER replace, overwrite, move, relink, or reinstall the live `omp` executable.
- Resolve every merge conflict yourself, sequentially. NEVER delegate conflict resolution.
- Land changes through a pull request into `nightly`; agents NEVER merge. Apply `ready-for-merge` only after checks, build, staged installation, runtime smoke verification, and a clean scoped review.
</critical>

1. Locate the `PsychedelicShayna/neopi` checkout; verify its remotes before changing it. Read `AGENTS.md` and `docs/policy/upstream-sync.md`.
2. Preserve local edits, untracked work, and divergent commits. Park unrelated work without discarding it. Relevant prerequisite changes MUST land through validated PRs before the sync starts.
3. Fetch `origin` and pin the current `origin/nightly` commit. Fetch upstream tags and select the newest stable release tag, not an arbitrary upstream branch tip.
4. Create a recovery ref and a fresh `sync/<date>` worktree from that pinned `origin/nightly` commit. NEVER reuse a dirty checkout, a rename worktree, or an unmerged local branch as the sync base.
5. Merge the selected release with `--no-ff --no-commit`. Resolve conflicts one file at a time. As each is resolved, record its path, resolution, retained fork behavior, adopted upstream behavior, and rationale in `SYNC-LEDGER.md`.
6. Preserve intentional fork behavior while adopting upstream refactors. Re-seat NeoPi branding through the central constants; keep `.omp` state, package identifiers, and internal protocols compatible. NEVER discard a fork feature to ease the merge.
7. Build with `./build.sh` from the sync worktree before any test run, so tests load a current native addon; NEVER assemble the build from individual `bun run` commands. It rebuilds the native addon when stale and never deploys extensions.
8. Run focused regression coverage and required repository checks with `CARGO_BUILD_JOBS=6`. Fix update-caused failures and rebuild. Record exact commands, results, and any independently established pre-existing failures; NEVER claim unrun checks passed. Verify the binary's version, help, worker smoke probe, and affected runtime paths. Stage with `NPI_DEST=<temp>/bin/npi PI_CODING_AGENT_DIR=<temp>/agent ./install.sh` and exercise that executable before applying `ready-for-merge`.
9. Make small logical commits with the explicit agent signing key and actual provider/model attribution. Verify each signature. Push the branch, open the PR into `nightly` with label `upstream-sync`, post the scoped Codex request from `docs/policy/review-bots.md`, and babysit it per `docs/policy/pull-requests.md`.
10. After GitHub merges the PR, update local protected-branch checkouts only with `git fetch origin && git reset --hard origin/<branch>` after preserving divergent work; NEVER discard it.
11. Install per `docs/policy/builds.md`: back up the existing executable and preserve unrelated extensions and backups. Promotion to `neopi` and stable `npi` rebuilds wait for the owner's word.
12. Smoke-test the installed `npi`, verify the expected release version, and confirm the live `omp` fingerprint is unchanged. Report PRs, commits, upstream tag, conflict ledger, checks, build/install paths, extension deployment, runtime proof, and preserved work.

Do not invoke the upstream update installer or any setup/link command that targets `omp`. Finish the complete source-fork update; do not stop at a merge, build, or plan boundary.

Update the local `PsychedelicShayna/neopi` source fork to the newest stable upstream release and leave the separate `npi` installation ready to use.

<critical>
- NEVER replace, overwrite, move, relink, or reinstall the live `omp` executable.
- Resolve every merge conflict yourself, sequentially. NEVER delegate conflict resolution.
- Land changes through a pull request, merged ONLY after checks, build, staged installation, and runtime smoke verification pass.
</critical>

1. Locate the `PsychedelicShayna/neopi` checkout; verify its remotes before changing it. Read `AGENTS.md` and `docs/agents/upstream-sync.md`.
2. Preserve local edits, untracked work, and divergent commits. Park unrelated work without discarding it. Relevant prerequisite changes MUST land through validated PRs before the sync starts.
3. Fetch `origin`, discover its default branch, and pin the current `origin/<default>` commit. Fetch upstream tags and select the newest stable release tag, not an arbitrary upstream branch tip.
4. Create a recovery ref and a fresh sync worktree from that pinned remote-default commit. NEVER reuse a dirty checkout, a rename worktree, or an unmerged local branch as the sync base.
5. Merge the selected release with `--no-ff --no-commit`. Resolve conflicts one file at a time. As each is resolved, record its path, resolution, retained fork behavior, adopted upstream behavior, and rationale in `docs/updates/<date>-upstream-<tag>.md`.
6. Preserve intentional fork behavior while adopting upstream refactors. Re-seat NeoPi branding through the central constants; keep `.omp` state, package identifiers, and internal protocols compatible. NEVER discard a fork feature to ease the merge.
7. Build with `./build.sh` from the sync worktree before any test run, so tests load a current native addon; NEVER assemble the build from individual `bun run` commands. It rebuilds the native addon when stale and never deploys extensions.
8. Run focused regression coverage and required repository checks with `CARGO_BUILD_JOBS=6`. Fix update-caused failures and rebuild. Record exact commands, results, and any independently established pre-existing failures; NEVER claim unrun checks passed. Verify the binary's version, help, worker smoke probe, and affected runtime paths. Stage with `NPI_DEST=<temp>/bin/npi PI_CODING_AGENT_DIR=<temp>/agent ./install.sh` and exercise that executable before merging the PR.
9. Make small logical commits with the explicit agent signing key and actual provider/model attribution. Verify each signature. Push the branch, open the PR, and merge only after the required evidence and checks are green.
10. Confirm the merged remote tree matches the verified build. Preserve any divergent local default-branch work before bringing the checkout to the merged remote state; NEVER discard it to force a fast-forward.
11. Back up the existing `npi` executable, then run `./build.sh && ./install.sh` from the realigned stable checkout. It installs only `npi` at `~/.local/bin/npi` (override with `NPI_DEST`) and deploys extensions. Preserve unrelated extensions and backups.
12. Smoke-test the installed `npi`, verify the expected release version, and confirm the live `omp` fingerprint is unchanged. Report PRs, commits, upstream tag, conflict ledger, checks, build/install paths, extension deployment, runtime proof, and preserved work.

Do not invoke the upstream update installer or any setup/link command that targets `omp`. Finish the complete source-fork update; do not stop at a merge, build, or plan boundary.

# Upstream 18.2.1 and advisor delivery assessment

## Pinned inputs

- Fork base: `origin/omomp`, `8f7d9c9207dcfcd209336690511314cc938e7cb3`, version 18.1.15.
- Upstream target: published release `v18.2.1`, `acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a`.
- Shared ancestor: `a33cc26824e3c91edd9fa42d681f10dceb4ac2f0`.
- Advisor PR #63: `2cd6808198d0c97d5163c4d2190ed7bd267f2da5`.
- Nix PR #64: `6c9b55abbf9b5b21d3be714190ec49ad16002832`.
- Integration branch: `sync/upstream-2026-09-16`, created from fetched `origin/omomp` in a separate worktree.
- Recovery ref: `backup/omomp-pre-upstream-2026-09-16`.

At selection time, GitHub listed 18.2.1 as its latest published release. Tag 18.2.2 existed and matched upstream/main, but had no published release. This assessment pins 18.2.1 rather than following a moving main branch.

The active advisor checkout contained changes to `.omp/config.yml`, `.omp/agents/`, and `WATCHDOG.yml`. Those were left in place. No origin branch or installed executable has been changed by this integration exercise.

## Recommendation for PR #63

Retain its requirements and adapt the implementation after integrating upstream. Do not merge the old implementation unchanged merely because GitHub currently reports it mergeable against the old fork base.

| Requirement | Upstream 18.2.1 | PR #63 requirement still needed |
| --- | --- | --- |
| Concern reaches next tool-batch boundary without cancelling running tools | Concerns emitted during in-progress review are deferred; later steering shares the global interruption policy | Yes, route concerns promptly with a per-message wait policy |
| Blocker requests immediate interruption even when global policy waits | Blockers use steering, without the PR's per-message override | Yes, retain immediate override and non-interruptible tool guarantees |
| Nits wait until the definitive full-run end without waking the model | Upstream preserves late non-blocking cards during terminal unwind, but does not implement the same full-run release contract | Yes, adapt terminal release and persistence ordering |
| Later concerns remain actionable | Upstream retains the post-interrupt immunity window | Yes, preserve the PR's removal of that window |

Upstream materially rewrote advisor admission. Keep its centralized emission guard, severity escalation, pending-note displacement, budget accounting, and truthful suppression acknowledgments. Change the delivery timing on top of those mechanisms. Copying the old AdviseTool implementation would undo new upstream correctness fixes.

Use upstream's `flushDeferredNotes()` for a terminal flush that must not reset the update budget. Reconsider the PR's `beginUpdate(false)` terminal call accordingly. Preserve upstream terminal-unwind guards and the PR's cancellation, session-reset, subscriber-drain, and queued-continuation protections together.

The agent queue now prepares messages through extension policy hooks and restores cancelled or undelivered batches. Re-run the per-message policy tests through those preparation/restoration paths, including mixed queues and the global policy opposite to the note's override.

Suggested order: validate upstream plus existing fork behavior in the integration worktree; port #63 to that result in a separate branch; validate both test families together; then promote in that order. Keep a real held-tool check in the final advisor acceptance run.

## Conflicts and retained fork behavior

The base integration had ten conflicted files. A non-checkout merge simulation including #63 had fifteen. Its five additional conflict paths were advisor-watchdog documentation, AdviseTool, SessionAdvisors, advisor-toggle tests, and advisor tests. This count does not measure semantic compatibility.

| Area | Resolution |
| --- | --- |
| Agent event loop | Preserve the fork's acceptance callback after upstream's stale-run guard |
| Session custom-message delivery | Retain receipts and cancellation, while adding upstream submission admission and compaction-resume ownership |
| Advisor configuration | Retain systemPrompt overrides through upstream entry validation and warning collection |
| Settings | Keep atomic model loadouts and upstream revision-based group caching |
| CLI | Keep exact omomp-update dispatch with upstream worker-host imports and startup structure |
| Eval | Keep extension backend registration and generic user eval, with upstream tool-session bridge access |
| Transcript/replay | Retain generic and legacy eval records with upstream artifact-error display and bounded metadata replay |
| Tests | Preserve both Chronicler settings coverage and upstream settings-cache tests |

Review also identified two lifecycle gaps. Pending receipts must acquire submission and compaction ownership before waiting for an earlier receipt. Fallback eval ToolSession objects must expose the same parent session and owner used by kernel disposal. Both are addressed in this worktree with focused regression coverage.

PR #64 adds no additional textual conflicts in the same merge simulation. Its packaging rename remains separate work, and a clean textual result does not establish that its Nix derivations build against the new release.

## Breaking changes to carry forward

- Settings.getGroup returns shallow-frozen cached snapshots. Fork atomic overrides already rebuild the effective settings and invalidate those snapshots.
- MCP removes parseSSE and the unchecked response types; callMCP returns JsonRpcResponse with an unknown result.
- Hub message/job waits use an adaptive window; timeoutMs and async.pollWaitDuration were removed.
- The session deletion command changes from /drop to /delete.
- Read results no longer duplicate content under details.truncation.content.
- Hashline DEL, DEL.BLK, COPY, and COPY.BLK are removed; deletion uses CUT/CUT.BLK.
- Browser tab.screenshot no longer accepts a per-call save path.

Targeted searches found no references to the removed MCP types, truncation.content, per-call screenshot API, or pollWaitDuration in the fork extensions, Chronicler, Iris live code, or external-harness adapters. Type checks and runtime tests remain the actual compatibility gates.

## Follow-up project reminder

Issue #66 records T3 Code as a possible frontend alongside OMP Deck, Hermes integrations, and Project Iron Dome. It explicitly preserves the missing context and does not claim ACP support or an approved combined architecture.

## Build compatibility

The installed Bun is `1.3.14-canary.1+0d9b296af`. Upstream's default bytecode build compiles successfully but crashes at both `--version` and `--smoke-test` with `TypeError: Expected CommonJS module to have a function wrapper`. The source CLI reports 18.2.1 normally. Disabling only bytecode produces a working compiled binary and a passing worker smoke test.

The shared compiler now accepts `OMP_BUILD_BYTECODE=0` as an explicit opt-out; its default remains upstream's bytecode setting. This does not establish which other Bun versions are affected. The candidate build uses:

```sh
OMP_BUILD_BYTECODE=0 OMOMP_SKIP_EXTENSION_INSTALL=1 CARGO_BUILD_JOBS=6 bun --cwd=packages/coding-agent run build
```

Extension deployment was disabled for this isolated validation build. The executable remains at `packages/coding-agent/dist/omp`; neither installed executable was replaced.

## Validation and handoff

- Original PR #63 baseline: 265 tests passed, 971 assertions across 3 files.
- Integrated candidate: 829 tests passed, 3689 assertions across 31 files. Includes agent queue behavior, advisor routing/admission/terminal unwind, compaction, receipt preflight cancellation, eval ownership, settings, Chronicler, live-controller races, and extension backend recovery.
- Native addon built from the integrated source using six Cargo jobs.
- Final `CARGO_BUILD_JOBS=6 bun check` passed after the review fixes and build option change, including all workspace TypeScript, lint/format, and Rust checks.
- Final compiled candidate built with `OMP_BUILD_BYTECODE=0` reports `omp/18.2.1` and passes `--smoke-test`.
- No unmerged index entries or unstaged tracked changes remain. `git diff --cached --check` reports one inherited trailing-space warning in upstream-generated `crates/vendor/cfg_aliases/BUILD.bazel:3`; that vendor file was preserved.
- Fresh read-only critic identified the receipt and eval ownership gaps, then reviewed their fixes and found no remaining confirmed defect in those changes. The reviewer did not run runtime tests. Its process was terminated and teardown verified.
- Python subprocess cleanup is not directly covered by the new eval regression, which exercises the shared identity mechanism through JavaScript. The combined delayed-preflight plus compaction cancellation case is covered by separate tests, not one end-to-end scenario.
- No PR was merged or updated. No integration commit or push was made. The worktree retains the merge in progress with resolved conflict paths, ready for review; the advisor checkout remains on its original branch with its original dirty paths.

# Nightly upstream v18.4.9 integration — 2026-10-01

## Sources and recovery

- Existing remote nightly: `origin/nightly/2026-09-30-b` at `99012ea97cea6c21bac88d09d83b789074a37fb5`.
- Preserved local-ahead nightly fix: `0e726bc343fa5cf55a73219b22c70fab52df425a` (minimal live effort support).
- Origin default: `origin/neopi` at `69ba5f25f110f5363d4559fddcdf9b8d7b1bb7a4`.
- Upstream release: `v18.4.9`, lightweight unsigned tag at `d3a32f6c9e2db84a54741464099422b8f2b2ad51`; object matches upstream remote.
- Recovery ref: `backup/nightly-pre-v18.4.9-2026-10-01` at `0e726bc343fa5cf55a73219b22c70fab52df425a`.
- Integration branch: `sync/nightly-upstream-v18.4.9` in a fresh worktree.
- Captain amended the normal update procedure: target nightly, preserve installed stable npi, publish through PR and require green review/CI/runtime proof before installation.
- Main checkout remains on its existing feature branch with user WIP untouched. Existing nightly checkout remains untouched.
- Fetch retained existing local `v18.2.2` rather than clobbering the divergent tag. Selected v18.4.9 fetched successfully and verified against remote.

## Conflict ledger

| Path | Resolution | Fork behavior kept | Upstream change taken | Why |
| --- | --- | --- | --- | --- |
| `packages/coding-agent/src/advisor/delta-split.ts` | Use origin's `primaryThinkingXml` option instead of the equivalent nightly `wrapPrimaryThinking` option. | Per-advisor reasoning visibility, escaped provisional reasoning, split-message cache and redaction safety. | Current origin advisor preference API from PR #217; no upstream release merge yet. | Both commits implement the same contract; use the current origin spelling to avoid duplicate formatter options. |
| `packages/coding-agent/src/advisor/runtime.ts` | Retain nightly host-based visibility preference and refusal/model-switch reset; use origin XML formatter option. | Roster preference remains authoritative across recovery and model switches; existing runtime host contract stays intact. | Origin's equivalent formatter spelling. | Host preference and constructor preference are alternate implementations of the same contract; retaining the nightly host avoids parallel configuration paths. |
| `packages/coding-agent/src/prompts/advisor/system.md` | Keep origin's conditional provisional-reasoning description. | Advisors distinguish provisional thinking from decided output; disabled thinking is not promised. | Origin's wording names the XML envelope explicitly. | Both sides express the same contract. |
| `packages/coding-agent/src/session/session-advisors.ts` | Retain all lifecycle callbacks and pass reasoning preference through the nightly runtime host, not a fourth constructor argument. | Visibility configuration and advisor lifecycle remain intact. | Origin formatting of the construction expression. | Match the preserved host-based runtime API without losing callbacks across the conflict boundary. |
| `packages/coding-agent/src/session/session-history-format.ts` | Use origin's single `primaryThinkingXml` option and implementation. | Escaped reasoning envelope; ordinary history unchanged; redacted thinking omitted. | Current origin formatter option spelling. | Identical transformation under two option names; migrate consumers rather than keep aliases. |
| `packages/coding-agent/src/slash-commands/builtin-collaboration.ts` | Keep nightly mixture commands and origin's `/chain` usage. | Mixture configuration/list/selection; chaining behavior. | PR #216 command rename. | Additive feature versus renamed shared usage constant; preserve both intents. |
| `packages/coding-agent/test/advisor/advisor.test.ts` | Update old formatter option and retain origin's redacted-thinking XML boundary assertion. | Ordinary history and escaped reasoning/security contracts remain exercised. | Origin's XML boundary expectation. | Align tests with the unified formatter API, not the superseded option name. |
| `packages/tui/src/overlays/advisor-config.ts` | Use origin's reasoning toggle key and explicit true/false persistence; preserve other nightly overlay features. | Per-advisor toggle, selected-row retention, and default visibility. | PR #217 explicit preference round-trip and synthetic-default exclusion. | Avoid discarding explicitly saved true settings as a synthetic roster. |

## Verification

Origin-to-nightly merge: eight conflicted files resolved personally and recorded above. Origin phase verification is green; upstream v18.4.9 integration follows.

- `git diff --check` and `git diff --cached --check`: passed.
- LSP diagnostics exposed two consumers of origin's alternate fourth constructor argument; both migrated to nightly's host preference. Refreshed runtime, session-advisor, and mixture-fixture diagnostics are clear.
- Initial capped-runner blocker: polite exited 75 with a refused relay connection. Captain authorized restoration; a dedicated `belt:polite` window now hosts the relay with idle/lifetime limits disabled, CPUQuota=500%, MemoryHigh=8G. Authentication succeeded and the relay reports a live grant.
- Existing nightly node_modules and native artifact were copied into the isolated worktree without installing new dependency versions. Generated HTML tool views were rebuilt through their existing generator.
- Initial checks exposed a missing `revision` on the inherited MixtureConfig test fixture; it now satisfies ModelBrowserSource's existing cache-revision contract.
- Affected contract run: 364 passed, 0 failed across 9 files (advisor configuration/rendering/recovery, ACP builtins, xAI recording, advisor UI, mixture configuration, update routing).
- Coding-agent and TUI `check:types`: passed.
- Source CLI with isolated PI_CONFIG_DIR: `--smoke-test` reported `smoke-test: ok`.
- `check:tools` exposed formatting drift in 36 inherited nightly files; the existing formatter corrected those files. Non-fatal existing lint warnings were not suppressed.
- Rechecked `check:tools`: passed with no lint errors and all 5,819 matched files formatted. Existing warnings remain visible.

## Binary

Stable binary and live profile unchanged. No new installation performed.

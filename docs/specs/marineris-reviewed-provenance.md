# Marineris reviewed implementation basis

The Captain closed the specification gate and authorized implementation against the preserved lease-closed pair. This records that handoff without editing the original mixed draft or any preceding proposal. The copied documents below are byte-for-byte artifacts; their historical candidate headers and internal local-artifact references remain unchanged.

Implementation starts on `feat/marineris-reviewed-backend`, isolated from all existing worktrees, at `origin/neopi` commit `50ef63f5b0` (merged runtime cancellation prerequisite PR #157). The switch backend owner is Astra (`openai-codex/gpt-6-astra`). Deck transport/UI and active MoA work have separate owners.

| Preserved artifact | SHA-256 |
|---|---|
| [Complete lease-closed specification](marineris-v3-astra-lease-closed-candidate.md) | `69087bd0f979dc351d0d0c6e3530cc8d617f78f810875a14506fc1447135d5dd` |
| [Complete lease-closed resolution ledger](marineris-backend-resolution-ledger-lease-closed-candidate.md) | `f0498b5f12e027fe36ad11f870f4f8a270b9eb488ca005f07662eb568cf4e4b3` |
| [Accounting specification review](marineris-reviews/accounting-closed-review.md) | `514100ff6cef9ccf4e7ef97073662fcb0217a2d23da81531ff672e8016e39583` |
| [Exact-pair security/lifecycle review](marineris-reviews/lease-closed-security-review.md) | `3b52909a797ab4d302c0eedb0b8535dc53c04237f83c333f46d526f934131da4` |

The accounting review cleared the shared Attempt/Job financial ownership contract. The subsequent lease amendment supplies a separate bounded, nonfinancial termination owner for video retrieval; its exact-pair security review found no conflict with the approved accounting boundary. These are scoped specification approvals, not code, runtime, deployment or production-readiness evidence.

The original mixed specification remains untouched in the prior `feat/marineris-v3` worktree, with SHA-256 `11e9bc97298674a1da18193adb1ecdda2cfe0928b931d6af845f7168db76e061`. The resolution ledger retains all predecessor hashes and findings. Implementation follows `docs/agents/fork-maintenance.md`: reuse canonical utilities and keep necessary gateway/auth/lifecycle integration seams narrow. The accepted specification and its required behavioral proofs, not a dashboard prototype, own the wire and accounting contracts.

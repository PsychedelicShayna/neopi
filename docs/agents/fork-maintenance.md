# Maintaining fork behavior across upstream updates

## Placement of new behavior

Before adding fork behavior, locate the upstream owner and inspect existing extension hooks and shared utilities. Prefer an extension when its supported hooks can express the complete behavior, including cancellation, persistence, and session changes.

Keep substantial fork-specific logic in focused modules or extension directories. When a core change is required, make the integration point narrow and explicit. Extend the existing owner when it must enforce a lifecycle or protocol invariant. A new file alone does not provide isolation if it copies upstream internals or depends on their incidental order.

For each core integration, record the missing extension capability and the observable contract that requires the core change in the PR or associated design document. Test that contract through its consumer. Use shared utilities rather than duplicating their implementations. Avoid unrelated refactoring of upstream-owned code in the same change.

Examples in this fork:

- Persona and loadout command interfaces belong in extensions. Atomic settings changes remain the responsibility of Settings and AgentSession.
- Additional eval backends use the registration API; execution ownership, cancellation, and transcript persistence remain session responsibilities.
- Advisor severity policy can live in its own module, but queue delivery and interruption guarantees require agent-loop and session integration.

## Integrating an upstream release

Pin the source fork commit, upstream release commit, and relevant open PR heads before resolving conflicts. Use a separate worktree for integration when the active checkout contains unrelated work or an open feature branch. Preserve a recovery ref.

Review upstream changes to every fork integration point, including files Git merged automatically. For each fork behavior, determine whether upstream preserves it, replaces it fully, overlaps it partly, or conflicts with it. A clean textual merge is not evidence of behavioral compatibility.

Keep open PRs separate until their contracts have been compared with the new upstream behavior. If upstream replaces part of a PR, retain the remaining requirement and adapt its tests; do not infer redundancy from similar changelog wording. Report the recommended merge order and unresolved behavior decisions before promoting an integration that depends on those decisions.

Validate both upstream regressions and fork contracts at the affected boundaries. Record source changes, failed or unavailable checks, and actual test results separately. Apply the binary installation rules in AGENTS.md only when reaching the authorized installation stage.

# Maintaining fork behavior across upstream updates

NPI deck is a fork of `Shreyans13/omp-deck`, maintained in NeoPi as the
`deck/` subtree. `Shreyans13/omp-deck` is the active deck upstream; original
`bjb2/omp-deck` author/fork credits remain historical provenance.

## Placement of new behavior

Before adding fork behavior, locate the upstream owner and inspect existing
extension hooks and shared utilities. Prefer supported hooks when they can
express the complete behavior, including cancellation, persistence, and
session changes. Keep substantial fork-specific logic in focused modules;
make required core integration points narrow and explicit. Extend the existing
owner when it must enforce a lifecycle or protocol invariant.

A new file alone does not isolate code that copies upstream internals or relies
on their incidental order. Record the missing extension capability and the
observable contract requiring a core change in the PR or design document.
Test through the consumer, reuse shared utilities, and keep unrelated upstream
refactoring out of the change.

Deck compatibility boundaries include the in-tree NeoPi SDK and runtime backend contract,
multi-session chat and streaming, canvas/cards and front matter, approvals,
worktree routing, messaging bridges, and launcher/setup behavior. Preserve
`@npi-deck/*`, `NPI_DECK_*`, installed paths, `npi-deck`, and `npi-deck.service`;
repository renaming alone does not authorize runtime rebranding.

## Integrating an upstream release

Follow [upstream-sync.md](upstream-sync.md). Pin the `origin/nightly` commit, upstream
release commit, and relevant open PR heads before resolving conflicts. Use a
fresh worktree from `origin/nightly` and preserve recovery refs.

Review every fork integration point, including automatically merged files.
Determine whether upstream preserves, replaces fully, overlaps partly, or
conflicts with each contract; a clean textual merge is not compatibility proof.
Keep open PRs separate until their contracts are compared with upstream.
Preserve requirements not actually replaced and report the recommended merge
order and unresolved behavior decisions before merging.

Record affected-boundary validation and unavailable checks honestly.
Isolated verification leaves default/live state, display, and service untouched.
After landing, follow NeoPi's [nightly delivery](../../../docs/agents/policy.md#nightly-delivery)
policy; default/live promotion remains separate.
Installation details live in [docs/install.md](../install.md).

# Synchronizing an upstream release

The deck's active upstream is `Shreyans13/omp-deck`. Original `bjb2/omp-deck`
credits are historical provenance, not a release source. The deck is NeoPi's
`deck/` subtree, so an omp-deck release merges under the `deck/` prefix only.

Syncs land on `sync/deck-<date>` through a PR into NeoPi's `nightly`, under NeoPi's
[repository policy](../../../docs/agents/policy.md); promotion into `neopi` is
separate. The fetched remote branch is the source of truth, not a local
checkout or another feature worktree.

## 1. Preserve and establish the baseline

Fetch `origin`. Preserve dirty work and local-ahead commits on named local
WIP/topic branches with signed commits; leave unrelated checkouts untouched.
Do not use a stash as durable storage or reset a local default branch.
Merge prerequisite topic PRs before syncing, then fetch again.

Read [fork-maintenance.md](fork-maintenance.md). Pin `origin/nightly`, the selected
upstream release tag and peeled commit, and relevant open PR heads. Select
the newest intended upstream release tag, not an arbitrary branch tip:

```sh
git ls-remote --tags https://github.com/Shreyans13/omp-deck.git 'v*'
```

Inspect tag versions and verify any tag signature. An invalid signature is a
blocker to trusting that release source; record an unsigned tag explicitly.
Preserve recovery refs through integration and the nightly launch check.

## 2. Create a fresh integration worktree

Fetch the selected tag explicitly from `https://github.com/Shreyans13/omp-deck.git`,
record its exact commit, and create the worktree from freshly fetched
`origin/nightly`:

```sh
git worktree add ../neopi-wt-deck-sync-<date> -b sync/deck-<date> origin/nightly
```

In that new worktree, create `backup/deck-pre-upstream-<date>` at the pinned
baseline. Record the source commit, tag commit, recovery ref, and open PR
heads in `deck/docs/updates/<date>-upstream-<tag>.md`.

## 3. Merge and maintain the conflict ledger

Merge the selected tag into the subtree with
`git merge -X subtree=deck --no-ff --no-commit <tag>`; never merge an omp-deck
tag at the repository root. Confirm that the merge touches only `deck/`. Resolve
conflicts personally, sequentially, one file at a time; research may be
read-only delegated, but resolution ownership stays with the integrating agent.

For each file, inspect base/ours/theirs and affected owners/tests; retain deck
contracts unless upstream demonstrably replaces the same observable behavior.
Adopt upstream refactors and reseat fork behavior on their new owners. Append
its ledger row before staging:

| Path | Resolution | Fork behavior kept | Upstream change taken | Why |
| --- | --- | --- | --- | --- |

Inspect automatically merged fork integration points too. Preserve the in-tree
NeoPi SDK contract, streaming sessions, canvas/card properties, approvals,
bridges, and installed-runtime identity. The deck has no NeoPi pin, setup
script, or lockfile of its own: drop any upstream `bun.lock`, `neopi.pin`,
`neopi-setup` or standalone workflow it reintroduces. Regenerate the root
`bun.lock` only after auditing new dependencies; never execute unaudited installers.

## 4. Commit and verify in isolation

Complete the merge with a signed, verified commit under NeoPi's
[commit policy](../../../docs/agents/policy.md#commits-and-identity).
Post-merge fixes are separate signed logical commits.

Useful CI-equivalent checks (informational for nightly), from the repository root:

```sh
bun install --frozen-lockfile
bun deck/.github/scripts/typecheck.ts
(cd deck && bun test . ./.github/scripts)
(cd deck/apps/web && bun run build)
```

When useful, exercise conflicted boundaries and changed runtime behavior using
a separate service instance/port and temporary state for isolated verification.
Follow `docs/install.md` for isolated setup; do not touch `~/.npi-deck`, the live
snapshot `~/.local/share/npi-deck`, or the live `npi-deck.service`. Never stop,
restart, reload, or reprovision that service. Do not mutate the live desktop,
windows, workspaces, tmux, desktop entries, or XDG configuration. Auto-open and
other non-browser GUI commands must use `timeout` + `xvfb-run -a <cmd>` with
private HOME/XDG state and no inherited live D-Bus or desktop/session variables.
Direct Chromium/Electron launches must use only
`bun scripts/browser-smoke.ts --home <private-tmp-dir> --timeout <seconds> -- <absolute-browser> --user-data-dir=<private-profile>`.
The wrapper already invokes `timeout` + `xvfb-run -a` with mandatory
`--password-store=basic`; it does not inherit `DBUS_SESSION_BUS_ADDRESS`,
`XDG_CURRENT_DESKTOP`, `XDG_SESSION_DESKTOP`, `DESKTOP_SESSION`, or live display,
Wayland and credential variables. HOME and XDG paths are private. Follow the
invocation and actual-child argv/environment checks in `deck/CONTRIBUTING.md`.
Never use display `:0` or Xephyr. Terminate the entire process tree, including
detached crash handlers and Xvfb, and verify termination with `pgrep` matching
the private profile, debugging port and Xvfb display. If Xvfb cannot perform a
check, report the limitation without a fallback.

Record commands actually run, observed failures, and unavailable checks in the
ledger. Call a failure baseline only with evidence; investigation is not a
nightly gate. Source inspection alone does not prove runtime behavior.

## 5. Publish and realign safely

Push the sync branch and open a PR into `nightly` under NeoPi's policy.
Summarize commits/tag, recovery ref, ledger/conflicts, retained or
replaced contracts, audited dependencies, checks/build/smoke proof, and any
baseline defects. Merge with a merge commit under NeoPi's
[nightly delivery](../../../docs/agents/policy.md#nightly-delivery) rules.

After merging, fetch and confirm the intended tree is in `origin/nightly`.
Only fast-forward a clean local integration checkout when its tip is an
ancestor; otherwise preserve local-ahead commits and recovery refs before any
realignment. Do not alter someone else's checkout or discard WIP. Complete
the authorized nightly build/install/launch under the delivery policy;
default/live deployment remains the Captain's decision.

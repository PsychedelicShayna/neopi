# NPI deck

NeoDeck is [NeoPi](https://github.com/PsychedelicShayna/neopi)'s orchestration and integration frontend; [NeoCode](https://github.com/PsychedelicShayna/neocode) is its graphical frontend.

NeoDeck lives in NeoPi as the `deck/` subtree. The repository and issue tracker
are `PsychedelicShayna/neopi`; the former `PsychedelicShayna/neodeck` repository
is archived. Active upstream: `Shreyans13/omp-deck`. Original `bjb2/omp-deck`
credits in README/CHANGELOG record historical provenance, not the active upstream.

## Read before acting

- Read `README.md` for project context and runtime layout; it is not agent policy.
- NeoPi's root [AGENTS.md](../AGENTS.md) and [`docs/agents/`](../docs/agents/) own
  agent policy for the deck: branches, commits, signing, GitHub posts, PRs,
  merges, nightly delivery, promotion, review mechanics, and triage. Read
  [policy.md](../docs/agents/policy.md) before any of those.
- Read the root [CONTEXT.md](../CONTEXT.md) for tracker vocabulary and
  [deck/CONTEXT.md](CONTEXT.md) for deck terms.

## Fork maintenance

Before adding fork behavior or integrating upstream, read
`docs/agents/fork-maintenance.md` for placement and compatibility rules.
Before synchronizing an omp-deck release, follow `docs/agents/upstream-sync.md`.
Repository slug changes do not rename package scopes, environment variables,
installed paths, launchers, or services. The default/live snapshot remains
`~/.local/share/npi-deck`, served by `npi-deck.service`; switching it is the
owner's decision.

## Issues

Deck issues live in `PsychedelicShayna/neopi` GitHub Issues with the `npi-deck`
label. Follow the root [issue tracker](../docs/agents/issue-tracker.md),
[triage](../docs/agents/triage.md), and [Issue Funnel](../docs/agents/issue-funnel.md)
guides. Former NeoDeck issues that were still relevant were migrated to NeoPi;
a bare `#N` in deck code written before the fold may mean
`PsychedelicShayna/neodeck#N`, so qualify new references.

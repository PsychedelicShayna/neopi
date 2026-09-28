# Architecture decision records

System-wide decisions for this fork. Package- or crate-scoped decisions go in
that context's own `docs/adr/` (see
[`docs/agents/domain.md`](../agents/domain.md)).

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-pr-review-bot-merge-gate.md) | PRs merge only when CI and the latest round from every review bot are clean | accepted |

## When to write one

Record a decision only when all three hold:

1. It is hard to reverse.
2. A future reader would find it surprising without the context.
3. It came out of a real trade-off between alternatives.

Easy-to-reverse or obvious choices do not need an ADR.

## Format

- File name: `NNNN-slug.md`. Take the highest existing number and add one.
- Required: a title and a short statement of the context, the decision, and
  the reason. One paragraph is enough.
- Optional, only when useful: a `Status` line (`proposed`, `accepted`,
  `deprecated`, or `superseded by ADR-NNNN`), `Considered options`, and
  `Consequences`.
- Never rewrite an accepted decision in place. Supersede it with a new ADR and
  update the old one's status.
- If a change contradicts an ADR, say so in the PR and link the ADR instead of
  silently overriding it.
- Add the new ADR to the index above.

The format follows the ADR guidance in Matt Pocock's `domain-modeling` skill
([mattpocock/skills](https://github.com/mattpocock/skills)), adapted for this
repository.

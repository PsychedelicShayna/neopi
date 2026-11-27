# NeoPi changelog

## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:

- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**

- New entries always go under `## [Unreleased]`.
- Entries are one line, brief, and user-facing: lead with what the user will see or can now do. Root-cause narration and implementation detail belong in the commit/PR, not the changelog.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — `bun run fix:changelogs` normalizes everything automatically.

**Attribution:**

- Fork issues: `Fixed foo bar ([#123](https://github.com/PsychedelicShayna/neopi/issues/123))`. Entries carried in from upstream keep their `can1357/oh-my-pi` links.
- External contributions: `Added feature X ([#456](https://github.com/PsychedelicShayna/neopi/pull/456) by [@username](https://github.com/username))`.

# Development guidance

## Feature provenance

A PR adding a command, setting, or feature with a new interactive TUI component MUST also add its provenance mark in that PR. Mark each new command/setting row and the feature's visible launch entry or component title, so coverage stays current without a later manual refresh.

NeoPi-only additions use the existing crescent; upstream additions use the upstream star cohorts. Reuse the shared provenance registry and renderer rather than embedding a separate icon scheme. Apply the published stable-tag classification even when the stable branch has newer unshipped commits.

For classification evidence, release-cohort aging and rendering verification, follow [Synchronize moon and stars](../../.agents/skills/sync-moon-and-stars/SKILL.md).

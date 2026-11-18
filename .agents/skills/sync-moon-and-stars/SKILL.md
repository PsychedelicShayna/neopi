---
name: sync-moon-and-stars
description: Refresh NeoPi provenance automatically during an upstream sync with oh-my-pi, or when the user asks to "synchronize moon and stars".
---

# Synchronize moon and stars

RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT`.

## Marker contract

- NeoPi uses one crescent: `provenancePurple` for nightly-only additions; the original upstream star's `success` green for additions shipped in stable.
- Stars identify upstream additions only: newest synced cohort gold, preceding cohort silver, every older cohort bronze. Upstream cohorts never expire.
- Unicode and Nerd Font modes MUST use the same crescent within each mode for both NeoPi tiers. Plain labels retain the crescent without ANSI; age is conveyed only where color is supported.

## Refresh procedure

1. **Pin evidence.** Record the current fork revision, previous synced upstream release commit, incoming upstream release tag and peeled commit. Query the personal repository's latest published non-draft, non-prerelease GitHub release; peel its tag and record both as `stableRelease`. A newer `neopi` branch head is not a shipped release. Completion: every baseline is an immutable commit with its release source recorded.

2. **Enumerate actual surfaces.** Locate the existing registries and generator before editing. Inventory builtins and aliases, bundled extension/file commands, and every `orderedSettings()` / `createSettingsHost()` entry, including generated and conditionally hidden settings. Include the existing auxiliary UI registries and any newly introduced interactive feature's visible entry/title. Classify bundled extensions by their registration source, not arbitrary external commands sharing a name. Completion: every current in-scope item has one inventory row.

3. **Prove origins.** Compare declarations at the pinned revisions; use upstream changelog sections, introduction history and the fork's maintenance records to explain additions, renames and adoption. Follow moved files and generated declarations: absence from an old filename is not absence of a feature. Retired entries leave the active inventory. Completion: each row is NeoPi-only, an upstream cohort, or older upstream, with a commit/path/line or changelog citation.

4. **Split NeoPi by shipped stable.** A NeoPi-only entry present in the published release commit belongs in `fork.stable`; otherwise it belongs in `fork.nightly`. An addition adopted upstream receives upstream classification instead. Preserve this classification separately from glyph/color selection. Completion: every NeoPi row is assigned against the published tag, not a branch or version-string guess.

5. **Age upstream cohorts once.** A newly synced upstream range records its version, exclusive previous commit, inclusive release commit and introduced IDs. Prepend it to `upstream`: existing gold becomes silver, existing silver becomes bronze, and every older cohort stays bronze. Preserve all cohorts. Refreshing coverage against the same synced range MUST NOT prepend another cohort or demote anything again. Completion: each upstream item has one release cohort and repeat refreshes preserve its age.

6. **Update the existing owners.** Command/setting data lives in `packages/coding-agent/src/config/entry-provenance.json`; auxiliary UI data lives in `packages/tui/src/theme/ui-entry-provenance.json`; the shared lookup/rendering owner is `packages/tui/src/theme/provenance.ts`. Maintain these as evidence-reviewed inventories: reconcile current registered IDs with the pinned release declarations, preserving `stableRelease`, `fork.stable` / `fork.nightly` and every newest-first upstream range. Reuse registry metadata and shared suffixes, preserving aliases, accepted command values and original type icons. Completion: one marking system covers every inventoried surface.

7. **Prove rendering where changed.** Use theme tokens; stable crescents reuse `success`, nightly crescents use `provenancePurple`, and upstream stars use the gold/silver/bronze tokens. Keep native span colors separate from label styling and plain labels ANSI-free. Glyph edits also update Unicode, Nerd Font and ASCII presets and regenerate `glyph-bundle.json` through its existing generator when private-use outlines are missing. Exercise affected behavior tests and the real TUI with the owner's configuration and theme; check light/dark and Unicode/Nerd Font modes when rendering changes. Completion: evidence shows the expected markers without changing navigation, identifiers or completion values; four or more upstream cohorts retain bronze marks.

8. **Publish the receipt.** Record the stable tag/commit, upstream ranges, exhaustive classification table with evidence, exercised checks and any unverified paths in the PR or sync ledger. Rendering changes include inspected before/after screenshots. Follow [repository delivery policy](../../../docs/agents/policy.md); distinguish merged, installed and published artifacts. Completion: every inventory row is accounted for and each delivery claim has its own evidence.

New-feature PRs follow [Feature provenance](../../../docs/agents/development.md#feature-provenance) instead of waiting for a periodic refresh.

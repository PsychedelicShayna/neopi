# Upstream 18.2.5 integration and startup diagnosis

## Decision and pinned inputs

Use the reconciled integration branch `sync/upstream-2026-09-16`, including the adapted advisor PR #63. Do not merge its old implementation directly into the new upstream state. PR #64 (Nix packaging rename) remains separate and is not required for this binary update. T3 Code / OMP Deck / Hermes / Project Iron Dome planning remains issue #66.

- Fork base: `8f7d9c9207dcfcd209336690511314cc938e7cb3` (`origin/omomp`, 18.1.15).
- Upstream target: published `v18.2.5`, `37273117021129e96bd05d8277b140ec3fd61990`.
- Advisor input: `2cd6808198d0c97d5163c4d2190ed7bd267f2da5` (PR #63).
- Earlier 18.2.1 integration checkpoint: signed commit `96417b93ee`.
- 18.2.5 integration before the advisor port: signed commit `4e4074c52753d4e77a28e74fab61a100a20bb387`, also `backup/omomp-18.2.5-before-advisor-port`.
- Initial recovery: `backup/omomp-pre-upstream-2026-09-16`; intermediate recovery: `backup/omomp-integration-pre-18.2.5`.

The original checkout stays on `fix/advisor-severity-delivery`. Its existing `.omp/config.yml`, `.omp/agents/`, and `WATCHDOG.yml` work is preserved. The local integration worktree contains all conflict resolutions; the operator need not resolve conflicts.

## Startup failure

The supplied `omp.2026-09-18.2101688.log` contains 2,554 extension parse-cache read errors and 2,554 write errors. The missing columns are `commonjs_named_exports` and `commonjs_reexport_specifiers`. The failures span 16.59 seconds; this is a measured error interval, not a controlled estimate of recoverable startup time.

The shared `~/.omp/cache/legacy-pi-extension-cache.db` has SQLite user version 2 and three columns (`cache_key`, `source_type`, `references`). Upstream commit `67e94ac16e` removed the older CommonJS-analysis columns and recreated this table at the same pathname. The old reader only creates its five-column table if absent, then repeatedly queries the missing columns and reparses each source after each failed cache lookup.

Static inspection confirms that installed `omp` 18.2.1 contains the new three-column SELECT; installed `omomp` 18.1.15 contains the old five-column SELECT. Both use `omp.*` log filenames. The evidence identifies cross-version cache interference, not an inherently slow new `omp` binary.

The fix selects `legacy-pi-extension-cache-v2.db` using the persisted analysis schema version. The unversioned database remains untouched by the fork. Incompatible future schemas must select a new filename before migration. Existing cache tests now prove old one- and two-version unversioned databases remain readable and unchanged while the new loader populates and reuses its own warm cache.

A temporary additive repair of the live database is unnecessary when installing the updated fork. No live cache was deleted, renamed, or patched.

## What “legacy” covers

`loadLegacyPiModule` is the active extension loader, including modern native extensions and their dependencies. Its name includes compatibility work: historical `@mariozechner` / `@earendil-works` package aliases, host-pinned `@oh-my-pi` imports, TypeBox and package-root shims, graph reloads, and CommonJS interop. Removing it would also break current extensions.

Other separate compatibility paths include `pi.extensions` manifests, old `settings.json` extension lists and config migration, YAML filename fallbacks, `.pi/SYSTEM.md`, `PI_PROFILE`, and old transcript message shapes such as `pythonExecution` and `hookMessage`. These are not all repeated expensive migrations. Native extension discovery uses `.omp` and the active agent directory; `.pi/extensions` is not a native discovery root. Each path needs actual use and timing evidence before removal.

## Reconciliation details

The step from the earlier integration to 18.2.5 produced 14 conflicted paths. The advisor merge produced 8 more. Counts exclude semantic changes in automatically merged files.

Upstream moved terminal presentation and shared UI types into `packages/tui`. Fork advisor prompt editing, Chronicler model roles, generic eval transcript messages/rendering, and external-harness imports now use the new owners. The advisor editor gets the rendered default prompt through a host callback; TUI does not import coding-agent internals.

Advisor delivery retains the requested behavior:

- Concerns steer at a tool boundary without cancelling the running tool, even under global immediate mode.
- Blockers request immediate interruption, even under global wait mode. Tool interruptibility remains authoritative.
- Nits are withheld until the definitive full-run end, then persisted/rendered before terminal notification without starting a model turn.
- Later concerns are not downgraded by an immunity window.

Upstream's single emission guard still owns normalization, dedupe, severity escalation, per-review budgets, and pending-note displacement. A live concern that displaces a deferred nit removes that nit from the pending list. Primary tool-turn starts do not reset advisor budgets. Terminal release uses `flushDeferredNotes()` rather than pretending to begin another review.

Upstream now persists message-end events independently of slow notification hooks. The port preserves that change, including stale-conversation and deferred TTSR cleanup. Chronicler's regression now expects durable evidence before hook completion and still checks exact-once capture. A late concern after an already terminal answer remains visible without reopening completed work; a late blocker can continue it. The held-tool continuation test uses that blocker contract.

## Verification

- Base integration: workspace TypeScript, lint/format, and Rust checks passed.
- Advisor-integrated candidate: `CARGO_BUILD_JOBS=6 bun check` passed; Rust was unchanged by the advisor port and had already passed in the base integration.
- Combined regression run: 1,329 passing tests, zero failures, 5,546 assertions across 76 files. Includes all agent tests, advisor routing/admission/terminal drain, compaction receipts, eval ownership, Chronicler, external-harness contracts, cache isolation, and relocated advisor UI/settings tests.
- Fresh read-only review found no confirmed regression. It inspected preparation/restoration identity, severity overrides, budget ownership, terminal persistence, and selected relocated UI/cache changes. It did not run the tests itself.
- Remaining targeted coverage gaps from review: IRC arriving during the asynchronous terminal-card drain, and per-message override retention through an actual preparation-claim failure. Existing source inspection and adjacent tests support correctness; these exact combined races are not proven by this run.

Build and installed-startup evidence is recorded below after binary validation. Native builds use six Cargo jobs. Local compilation uses `OMP_BUILD_BYTECODE=0` because the installed Bun canary produced invalid bytecode executables in the earlier update trial.

## Binary and startup validation

The 18.2.5 native addon and compiled binary built successfully. The binary reports `omp/18.2.5` and passes `--smoke-test` (worker and tiny-subprocess wiring). Bytecode was explicitly disabled; extension deployment was deferred until installation.

No-prompt RPC probes used the existing user configuration and original checkout cwd, streamed `PI_DEBUG_STARTUP=1` markers, and measured a response to `get_state` rather than merely the early `ready` event:

| Executable | Result | Extension phase |
| --- | --- | --- |
| Installed upstream omp 18.2.1 | Session creation at 1.515 s (initial marker-only probe) | 1.187 s |
| Old installed omomp 18.1.15 | No `get_state` response within 40 s; terminated during extension loading | No completion marker |
| Compiled candidate, cold schema-v2 cache | `get_state` at 13.487 s | 12.117 s |
| Same candidate, warm cache | `get_state` at 3.142 s | 1.745 s |

These are individual real-configuration probes, not controlled medians; native compilation overlapped the old-fork probe. The candidate logs contain zero extension cache schema errors. The versioned cache has 2,358 rows and is about 1.0 MiB. Cold parsing still costs time, while subsequent launches can reuse the cache.

PR #64 was rechecked with `git merge-tree` against the advisor-integrated candidate and adds no textual conflict. Its Nix derivations were not built in this update.

The original installed `omomp` was backed up to `~/.local/state/omomp-updates/2026-09-18-1825/omomp-18.1.15`, with source and binary hashes in `manifest.json`. The new executable was atomically installed only at `~/.local/bin/omomp`. The live `omp` SHA-256 remains `9c76485c4e65875678b88c7926c7e6891d488796676f359de9c4df584c886fc9`.

Desktop notification was attempted after the recommendation became concrete, but the installed `notify-send` failed with an undefined libnotify symbol. The recommendation and progress were delivered in the conversation; the notification utility was not modified.


## Final decision: retire Ruby/Julia

After refreshing the fork extension links, the full installed configuration stalled in extension loading for 40 seconds. Isolated probes identified `omomp-eval-langs`; each of the other four fork extensions loaded successfully. Investigation found that the loader follows type-only source imports into host implementation graphs. Experimental host-bridge injection and loader filtering were not shipped: the operator explicitly chose to retire Ruby/Julia instead of maintaining the extension.

Removed the nine-file Ruby/Julia extension (3,927 lines) from the fork. Its installed symlink was moved outside extension discovery into the update backup directory. Future extension deployment from this branch will not reinstall it. Python/JavaScript and the generic third-party eval registration API remain. This reduces the extension source and startup surface; no meaningful compiled-binary size reduction is claimed.

Final installed 18.2.5 probes, with the remaining four fork extensions and existing user configuration, reached RPC `get_state` in **1.460 s** and **1.441 s**. Extension loading took **0.106 s** and **0.094 s**, respectively. These individual timings supersede the earlier candidate timings above for the delivered configuration. The final compiled/installed worker smoke passed. Extension installer, registration-recovery, and eval fallback tests: **20 pass, zero failures, 65 assertions**. Earlier workspace checks and 1,329-test integration run cover the unchanged core implementation.

Final installed binary SHA-256: `fa41d2e46dfc380bc035667a00aabad0b532badfb1fa0b62b35cc3b8a211c497`. The live upstream `omp` hash is unchanged. The original fork binary backup remains available.

# NeoPi

A source-built coding harness for long-running, multi-agent work where the operator keeps control.

## Lineage

NeoPi is a fork of [Oh My Pi](https://github.com/can1357/oh-my-pi) by Can Bölük, itself a fork of [Pi](https://github.com/badlogic/pi-mono) by Mario Zechner. The project is MIT-licensed; see the upstream [README](https://github.com/can1357/oh-my-pi/blob/main/README.md) for the full inherited feature tour.

## Why this fork exists

NeoPi develops around an operator-driven backlog. The links below are plans and open problems, not claims that every item has shipped.

- **Advisor and watchdog crews.** Make independent reviewers configurable, reloadable, and visible without flattening their roles into the main agent ([#3](https://github.com/PsychedelicShayna/neopi/issues/3), [#5](https://github.com/PsychedelicShayna/neopi/issues/5), [#42](https://github.com/PsychedelicShayna/neopi/issues/42), [#59](https://github.com/PsychedelicShayna/neopi/issues/59)).
- **Parallel-agent lifecycle and IRC.** Treat workers, advisors, operator messages, steering, and completion as first-class lifecycle concepts rather than detached jobs ([#1](https://github.com/PsychedelicShayna/neopi/issues/1), [#11](https://github.com/PsychedelicShayna/neopi/issues/11), [#12](https://github.com/PsychedelicShayna/neopi/issues/12), [#13](https://github.com/PsychedelicShayna/neopi/issues/13), [#31](https://github.com/PsychedelicShayna/neopi/issues/31), [#42–#45](https://github.com/PsychedelicShayna/neopi/issues/42)).
- **Live voice.** Keep spoken interaction honest about ownership, delegation, transcript placement, and turn boundaries ([#22](https://github.com/PsychedelicShayna/neopi/issues/22), [#38](https://github.com/PsychedelicShayna/neopi/issues/38), [#39](https://github.com/PsychedelicShayna/neopi/issues/39), [#40](https://github.com/PsychedelicShayna/neopi/issues/40), [#41](https://github.com/PsychedelicShayna/neopi/issues/41)).
- **Model routing, roles, and fallbacks.** Make model behavior, per-role settings, loadouts, and fallback chains explicit and editable ([#8](https://github.com/PsychedelicShayna/neopi/issues/8), [#23](https://github.com/PsychedelicShayna/neopi/issues/23), [#30](https://github.com/PsychedelicShayna/neopi/issues/30), [#52–#58](https://github.com/PsychedelicShayna/neopi/issues/52), [#70](https://github.com/PsychedelicShayna/neopi/issues/70)).
- **Context control plane.** Give the operator inspectable control over assignment boundaries, compaction, telemetry, capabilities, prompts, and work contracts ([#6–#10](https://github.com/PsychedelicShayna/neopi/issues/6), [#14–#21](https://github.com/PsychedelicShayna/neopi/issues/14), [#24–#29](https://github.com/PsychedelicShayna/neopi/issues/24)).
- **Portable flash and RAM operation.** Build a bootable, encrypted harness and make its intended portable workflow run safely from RAM ([#47](https://github.com/PsychedelicShayna/neopi/issues/47), [#49](https://github.com/PsychedelicShayna/neopi/issues/49), [#69](https://github.com/PsychedelicShayna/neopi/issues/69)).
- **Native Chronicler memory.** Capture durable session facts now and grow toward hierarchical temporal recall and named launch context ([#46](https://github.com/PsychedelicShayna/neopi/issues/46), [#65](https://github.com/PsychedelicShayna/neopi/issues/65)).
- **Personas, REPL, loadouts, and chat.** Keep prompt identity, runtime model configuration, evaluation kernels, live personas, and explicit conversational modes available to the operator ([#2](https://github.com/PsychedelicShayna/neopi/issues/2), [#54](https://github.com/PsychedelicShayna/neopi/issues/54), [#68](https://github.com/PsychedelicShayna/neopi/issues/68)).
- **TUI glyphs and navigation.** Restore intentional terminal glyphs, support keyboard-driven lists and external editing, and bound browser screenshot size ([#32](https://github.com/PsychedelicShayna/neopi/issues/32), [#33](https://github.com/PsychedelicShayna/neopi/issues/33), [#34](https://github.com/PsychedelicShayna/neopi/issues/34), [#35](https://github.com/PsychedelicShayna/neopi/issues/35), [#36](https://github.com/PsychedelicShayna/neopi/issues/36), [#37](https://github.com/PsychedelicShayna/neopi/issues/37), [#51](https://github.com/PsychedelicShayna/neopi/issues/51)).
- **NeoPi identity and ecosystem.** Give the fork an independent release path while exploring compatible frontends and neighboring harness projects ([#66](https://github.com/PsychedelicShayna/neopi/issues/66), [#69](https://github.com/PsychedelicShayna/neopi/issues/69)).

## What has landed

The following work is merged in the repository:

- [PR #48](https://github.com/PsychedelicShayna/neopi/pull/48): portable build and encrypted flash baseline, including the bounded RAM wrapper.
- [PR #50](https://github.com/PsychedelicShayna/neopi/pull/50): corrected the speech-to-text hold gesture when capture began from a chord.
- [PR #60](https://github.com/PsychedelicShayna/neopi/pull/60): per-advisor system-prompt overrides.
- [PR #61](https://github.com/PsychedelicShayna/neopi/pull/61): native session Chronicler capture. Hierarchical recall remains tracked in [#46](https://github.com/PsychedelicShayna/neopi/issues/46).
- [PR #63](https://github.com/PsychedelicShayna/neopi/pull/63): severity-aware advisor delivery boundaries.
- [PR #62](https://github.com/PsychedelicShayna/neopi/pull/62) and [PR #67](https://github.com/PsychedelicShayna/neopi/pull/67): upstream release synchronization.

Fork extensions provide these operator commands:

| Command | Source directory |
| --- | --- |
| `/persona` | `extensions/neopi-persona/` |
| `/loadout` | `extensions/neopi-loadout/` |
| `/repl`, `/kernel` | `extensions/neopi-repl/` |
| `/live-persona` | `extensions/neopi-live-persona/` |

See [docs/neopi-fork.md](docs/neopi-fork.md) for the committed fork history and boundaries.

## Install from source

Use a dedicated `npi` path. Never install this fork over another harness binary.

```sh
git clone https://github.com/PsychedelicShayna/neopi.git
cd neopi

# Review the source and bun.lock first. Audit any newly proposed dependency.
bun install --frozen-lockfile
./build.sh     # rebuilds the native addon only when stale, then packages/coding-agent/dist/npi
./install.sh   # atomic install to ~/.local/bin/npi (NPI_DEST overrides), extensions, smoke test
```

`build.sh` and `install.sh` support Linux. On macOS, run the same steps by hand:

```sh
CARGO_BUILD_JOBS=6 bun --cwd=packages/natives run build   # first, and after every version bump
OMP_BUILD_BYTECODE=0 NPI_SKIP_EXTENSION_INSTALL=1 bun --cwd=packages/coding-agent run build
cp packages/coding-agent/dist/npi ~/.local/bin/npi        # a dedicated npi path
bun scripts/install-neopi-extensions.ts
```

This repository does not prescribe a remote installer or a global package-manager install. The existing package scope and protocol identifiers remain `@oh-my-pi/*`; configuration remains under `~/.omp` unless `PI_CONFIG_DIR` or the documented profile settings select another location.

## Updating

Run `npi update` for the fork-aware interactive update path. Maintainers integrating upstream releases must use the origin-based worktree and PR procedure in [docs/agents/upstream-sync.md](docs/agents/upstream-sync.md); the remote default branch is the source of truth.

## Working on NeoPi

- Read [AGENTS.md](AGENTS.md) before changing code or installing a build.
- Read [docs/neopi-fork.md](docs/neopi-fork.md) before changing fork-specific behavior.
- Track work in [GitHub Issues](https://github.com/PsychedelicShayna/neopi/issues).
- Follow [issue-tracker mechanics](docs/agents/issue-tracker.md) and [triage-label definitions](docs/agents/triage-labels.md) when publishing or triaging issues.

## License

NeoPi is licensed under the [MIT License](LICENSE).

Third-party and vendored code remains under its respective license. See [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) and component-local notices.

Copyright notices carried by this repository:

- Copyright © 2025 Mario Zechner
- Copyright © 2025–2026 Can Bölük
- Copyright © 2026 Stencil Labs, Inc.
- Copyright © 2026 PsychedelicShayna

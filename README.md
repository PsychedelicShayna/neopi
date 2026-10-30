# NeoPi

A source-built coding harness for long-running, multi-agent work where the operator keeps control.

[NeoCode](https://github.com/PsychedelicShayna/neocode) is NeoPi's graphical frontend. [NeoDeck](https://github.com/PsychedelicShayna/neodeck) is its orchestration and integration frontend for cards, routines, inbox, and messaging. NeoPi itself is the terminal harness and the engine both use.

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

Built-in operator commands added by the fork:

| Command | Purpose |
| --- | --- |
| `/persona`, `/persona live` | Edit and switch system-prompt personas and live-voice personas |
| `/loadout` | Switch runtime model loadouts |
| `/repl`, `/kernel` | Point the composer at a JavaScript, Python, or Bash kernel |
| `/notice <text>` | Send a literal operator-authored developer notice to the current session |

See [docs/neopi-fork.md](docs/neopi-fork.md) for the committed fork history and boundaries.

## Install from source

Use a dedicated `npi` path. Never install this fork over another harness binary.

```sh
git clone https://github.com/PsychedelicShayna/neopi.git
cd neopi

# Review the source and bun.lock first. Audit any newly proposed dependency.
bun install --frozen-lockfile
./build.sh     # rebuilds the native addon only when stale, then packages/coding-agent/dist/npi
./install.sh   # atomic install to ~/.local/bin/npi (NPI_DEST overrides), smoke test
```

Linux builds reuse verified native addons across worktrees on the same host.
`NPI_NATIVE_CACHE` selects the shared cache directory, defaulting to
`/mnt/alias/m2/agents/native-cache`. Set `NPI_NATIVE_CACHE=off` to use only the
checkout's addon and the normal rebuild path. `NPI_FORCE_NATIVE=1` bypasses
both local freshness and cache restoration, then stores the new addon.
An unavailable cache falls back to the normal build.

The key hashes native source and build-driver bytes, compiler settings including
`OMP_NATIVE_FEATURES`, and the host/toolchain fingerprint. It includes `RUSTC`,
`RUSTC_WRAPPER`, `RUSTC_WORKSPACE_WRAPPER`, `CARGO_PROFILE_*` and `CARGO_BUILD_*`
overrides. Compiler fingerprinting uses `RUSTC`, then `CARGO_BUILD_RUSTC`, then
`rustc` on PATH. `RUSTDOCFLAGS` is excluded because this build does not run rustdoc.
Cache hits verify SHA-256 and the native release version before writing a
checkout-local stamp.
The cache keeps eight recently stored addons, skipping entries in use.
`ledger.jsonl` records each native build phase as `hit`, `miss`, or `store`,
with its key, duration in seconds, exit code, and whether it published an addon.
Failed native builds are recorded too. A current local addon can seed an empty
cache without compiling Rust.

`build.sh` and `install.sh` support Linux. On macOS, run the same steps by hand:

```sh
CARGO_BUILD_JOBS=6 bun --cwd=packages/natives run build   # first, and after every version bump
OMP_BUILD_BYTECODE=0 bun --cwd=packages/coding-agent run build
mkdir -p ~/.local/bin
cp packages/coding-agent/dist/npi ~/.local/bin/npi        # a dedicated npi path
~/.local/bin/npi --version && ~/.local/bin/npi --smoke-test
```

This repository does not prescribe a remote installer or a global package-manager install. The existing package scope and protocol identifiers remain `@oh-my-pi/*`; configuration remains under `~/.omp` unless `PI_CONFIG_DIR` or the documented profile settings select another location.

## GitHub releases

The existing **CI** workflow builds and publishes downloadable binaries on every
push to `nightly` and `neopi`, including documentation-only pushes. A merge into
`neopi` publishes a stable release; a `nightly` push publishes a prerelease that
does not replace the latest stable release. Publishing waits for the binary
builds and their platform smoke checks, not the unrelated CI validation jobs.

To compile and publish a stable version manually, open **Actions → CI → Run
workflow**, choose a branch or tag in **Use workflow from**, and run it. That
selection determines the exact source commit; manual runs are always stable,
even when selecting `nightly`. The CLI equivalent is:

```sh
gh workflow run ci.yml --repo PsychedelicShayna/neopi --ref neopi
```

Tags derive from `packages/coding-agent/package.json`: stable builds use
`v<version>+build.<run-id>.<attempt>` and nightlies use
`v<version>-nightly.<short-sha>.<run-id>.<attempt>`. Repeated builds get new tags;
existing releases and tags are never overwritten or deleted. Release assets
include all platform binaries, the browser relay extension, legal notices and
`SHA256SUMS.txt`. The fork publishes only to GitHub; the inherited npm,
build.stencil.so and upstream Homebrew publishing jobs have been removed.

The workflow must reach the default branch before GitHub exposes its manual
dispatch controls. After the first merge into `nightly`, watch that push's
**Publish GitHub release** job and check the prerelease's commit and assets.
After promotion to `neopi`, check that its push publishes a stable release
marked **Latest**. Builds run in GitHub Actions; a local `./build.sh` does not
publish a release or change your installed binary automatically.

### CI checks and platform coverage

GitHub's checks summary counts the jobs created by `.github/workflows/ci.yml`,
including separate matrix jobs. PRs run Linux validation and reuse cached Linux
native addons. Pushes to `nightly` and `neopi` also validate Rust, build the
remaining native targets, and cross-compile eight release binaries on Linux:
Linux glibc and musl on x64 and ARM64, macOS on Intel and Apple Silicon, and
Windows on x64 and ARM64.

Every release binary then runs `--version` and `--smoke-test` on its target
platform. macOS uses macOS runners and verifies the code signature; Windows
uses Windows runners; musl uses Alpine containers. These are startup and worker
smoke checks, not the full TypeScript test suite on every OS.

The three boxes in `.github/PULL_REQUEST_TEMPLATE.md` are the author's manual
verification notes, not CI jobs or required status checks. Leave an unchecked
box with a reason when that check was not run. Keep useful validation red until
its underlying failure is repaired; an obsolete publisher is different from a
failing regression test.

## Updating

Run `npi update` for the fork-aware interactive update path. Maintainers integrating upstream releases must use the origin-based worktree and PR procedure in [docs/agents/upstream-sync.md](docs/agents/upstream-sync.md); the remote default branch is the source of truth.

## Capture an idea

`npi idea "describe the change"` starts an interactive issue funnel. It reads the tracker conventions, checks for duplicates, asks for missing boundaries and acceptance, and shows the proposed issue for approval before publishing to `PsychedelicShayna/neopi`. To shorten the command in a POSIX shell, optionally add `alias ni='npi idea'` to your shell configuration, then run `ni "describe the change"`.

## Working on NeoPi

- Read [AGENTS.md](AGENTS.md) before changing code or installing a build.
- Read [docs/neopi-fork.md](docs/neopi-fork.md) before changing fork-specific behavior.
- Track work in [GitHub Issues](https://github.com/PsychedelicShayna/neopi/issues).
- Follow [issue-tracker mechanics](docs/agents/issue-tracker.md) and [triage-label definitions](docs/agents/triage-labels.md) when publishing or triaging issues.

## License

NeoPi is licensed under the [MIT License](LICENSE).

Third-party and vendored code remains under its respective license. Each shipped component carries its own `THIRD-PARTY-NOTICES.txt`: the CLI (`packages/coding-agent`), the native addon (`packages/natives`), and robomp (`python/robomp`). `npi --license` prints the CLI and addon notices.

Copyright notices carried by this repository:

- Copyright © 2025 Mario Zechner
- Copyright © 2025–2026 Can Bölük
- Copyright © 2026 Stencil Labs, Inc.
- Copyright © 2026 PsychedelicShayna

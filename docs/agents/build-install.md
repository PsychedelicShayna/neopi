# NeoPi build and delivery

## Build and install

Two channels ship from this repository, both built by `./build.sh` and
installed by `./install.sh` (Linux only; README.md "Install from source" has
the macOS path). Never assemble the binary from individual `bun run` commands:
every upstream version bump invalidates the gitignored native addon in each
checkout, and only `build.sh` detects and rebuilds it.

| Channel | Branch | Checkout | Install |
| --- | --- | --- | --- |
| `npi` | `neopi` | `~/repos/neopi` | `./install.sh` → `~/.local/bin/npi` |
| `npi-nightly` | `nightly` | `~/repos/neopi-nightly` | `NPI_DEST=~/.local/lib/npi-nightly/npi ./install.sh`; `~/.local/bin/npi-nightly` is a wrapper, `ni` the fish alias |

Install after merge batches that change the shipped binary; proof sessions hold a time-bounded [install lock](policy.md#install-after-merge-batches).

- The compiled artifact is `packages/coding-agent/dist/npi`. Source runs use
  `bun run dev` or `bun --cwd=packages/coding-agent src/cli.ts`.
- The fork's operator commands (`/persona`, `/loadout`, `/repl`, `/kernel`)
  are built in; no extension deployment step.
- Never install this fork through a remote installer, a global package
  manager, `bun setup`, or `scripts/link-omp.sh`.
- Stage a throwaway install with `NPI_DEST=<temp>/bin/npi PI_CODING_AGENT_DIR=<temp>/agent ./install.sh`.
- Installing an offloaded build requires the identical source tree: same `HEAD`,
  `git diff HEAD`, and untracked files on both hosts. `install.sh` checks the
  `dist/npi.source` record written by `build.sh`. Use the workstation skill for
  the owner's offload command.

## Commands

- Never use `tsc`/`npx tsc` — always `bun check`.
- Use `bun run test:rs` for Rust tests. It runs both `cargo nextest run` and
  `cargo test --doc`; nextest alone does not run doctests.
- Keep Cargo builds at six jobs for interactive work. `build.sh` pins six and
  ignores ambient `CARGO_BUILD_JOBS`. Only a dedicated build host should raise
  the limit explicitly with `NPI_CARGO_JOBS=<n>`; it is not part of the native cache key.
  For direct Cargo builds use `-j 6`.
- `bun check` runs the Rust half when Rust-affecting files changed since the
  upstream merge base, in GitHub Actions, when the base cannot be determined,
  or when `OMP_FORCE_RUST_TASKS=1`.

## Releasing

This fork does not publish to npm; `bun run release` is upstream's flow and is never run here. Promotion of `nightly` into `neopi` follows `docs/agents/policy.md` › Promotion and issue completion. Version bumps arrive through upstream syncs.

On Shayna's Linux workstation, use the local `shayna-neopi-machine` skill before running builds, tests, checks, or signed commits. It owns machine-specific paths, locks, and resource limits. On other machines, use their own available configuration.

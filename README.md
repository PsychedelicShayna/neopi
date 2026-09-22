# NeoPi

NeoPi is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`), which is itself a fork of [Pi](https://github.com/badlogic/pi-mono). The π mark stays. The name does not.

The binary is `npi`. It does not install over `omp`, and it does not share `omp`'s config directory.

This checkout's GitHub repository is still [PsychedelicShayna/omomp](https://github.com/PsychedelicShayna/omomp). It is being renamed to `neopi`. Until that repository exists, `origin` stays on `omomp`.

## Why the fork exists

The reason is the issue tracker and what has already merged. Not a percentage, and not a claim that upstream is unfinished coding-agent work. Upstream is the coding agent this tree is built on. The filed work is a different shape of harness.

Already in the tree, and not upstream:

- Native session Chronicler ([#61](https://github.com/PsychedelicShayna/omomp/pull/61)). Hierarchical temporal recall is still open ([#46](https://github.com/PsychedelicShayna/omomp/issues/46)).
- Advisor delivery by severity ([#63](https://github.com/PsychedelicShayna/omomp/pull/63)) and per-advisor system prompts ([#60](https://github.com/PsychedelicShayna/omomp/pull/60)).
- A portable encrypted stick ([#48](https://github.com/PsychedelicShayna/omomp/pull/48)). Bootable flash and running the portable system from RAM are still open ([#47](https://github.com/PsychedelicShayna/omomp/issues/47), [#49](https://github.com/PsychedelicShayna/omomp/issues/49)).
- The space-hold speech gesture no longer eats a chord-started capture ([#50](https://github.com/PsychedelicShayna/omomp/pull/50)).

Earlier fork work, committed before those pull requests and recorded in [docs/omomp-fork.md](docs/omomp-fork.md): user eval in JavaScript, Ruby, and Julia; runtime model loadouts; Iris as a live voice model that is not the coder wearing a headset; task agents addressed by model selector; a separate install path so the fork cannot replace a live `omp`.

The open tracker is the rest of the reason. It describes a station, not a single coding assignment:

- Parallel agents, with advisor as a preset, and the operator as a participant on IRC ([#11](https://github.com/PsychedelicShayna/omomp/issues/11), [#31](https://github.com/PsychedelicShayna/omomp/issues/31), [#45](https://github.com/PsychedelicShayna/omomp/issues/45)). A conversation lane that is a control plane rather than the default worker ([#9](https://github.com/PsychedelicShayna/omomp/issues/9), [#10](https://github.com/PsychedelicShayna/omomp/issues/10)).
- Advisors whose roster and prompts stay live when the files change ([#4](https://github.com/PsychedelicShayna/omomp/issues/4), [#5](https://github.com/PsychedelicShayna/omomp/issues/5), [#59](https://github.com/PsychedelicShayna/omomp/issues/59)).
- Context as something the session controls: work contracts, compaction, pressure, and role-scoped budgets ([#25](https://github.com/PsychedelicShayna/omomp/issues/25), [#28](https://github.com/PsychedelicShayna/omomp/issues/28), [#29](https://github.com/PsychedelicShayna/omomp/issues/29), [#52](https://github.com/PsychedelicShayna/omomp/issues/52)).
- Live voice as its own architecture ([#22](https://github.com/PsychedelicShayna/omomp/issues/22)), including narration that must not bury the transcript ([#38](https://github.com/PsychedelicShayna/omomp/issues/38)).
- Role and model configuration the stock picker does not provide ([#53](https://github.com/PsychedelicShayna/omomp/issues/53)–[#58](https://github.com/PsychedelicShayna/omomp/issues/58)).
- An explicit chat mode that is not a coding assignment ([#68](https://github.com/PsychedelicShayna/omomp/issues/68)), and named launch profiles that preload selected memory ([#65](https://github.com/PsychedelicShayna/omomp/issues/65)).

[#66](https://github.com/PsychedelicShayna/omomp/issues/66) asks whether a desktop frontend is worth exploring, and names T3 Code, OMP Deck, Hermes, and Project Iron Dome. Protocol support is unconfirmed. It is an open question, not a direction this README treats as settled.

Release updates for this fork, including a separate notice when upstream Oh My Pi has moved, are [#69](https://github.com/PsychedelicShayna/omomp/issues/69). They are not built yet.

## Install

Build from this checkout. Install the artifact as `npi`. Never copy it onto `omp`.

```sh
bun --cwd=packages/coding-agent run build
install -m 0755 packages/coding-agent/dist/omp ~/.local/bin/npi
bun scripts/install-omomp-extensions.ts
```

The build output is still named `dist/omp`. That name is the upstream artifact. The installed command is `npi`.

`~/.local/bin/omp` is upstream. Do not replace it. `scripts/link-omp.sh` and `bun setup` can target that name. Do not use them to install this fork.

## Config

NeoPi keeps its own config.

| | NeoPi | upstream `omp` |
| --- | --- | --- |
| Home | `~/.npi` | `~/.omp` |
| XDG segment | `$XDG_*_HOME/npi` | `$XDG_*_HOME/omp` |
| Project | `.npi/` | `.omp/` |

Nothing is copied across on first launch. A NeoPi process will not see sessions, auth, or extensions that still live under `~/.omp`. Copy only what you intend to split, then let the two trees diverge.

`PI_CONFIG_DIR`, `OMP_PROFILE`, and `PI_CODING_AGENT_DIR` keep their names. They override paths. They are not a second product name.

Package names stay `@oh-my-pi/*`. Renaming those on every upstream sync is how this fork would spend its life in merge conflicts. User-facing text says NeoPi. Internal identifiers that upstream owns stay.

## Upstream

Upstream is [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). `omp update` still tracks that repository. `npi update`, with no other arguments, is the fork's source-sync session. It is not a release installer. Release installs are [#69](https://github.com/PsychedelicShayna/omomp/issues/69).

Completed fork differences that predate the pull-request record: [docs/omomp-fork.md](docs/omomp-fork.md).

# NeoPi fork

This tree is [PsychedelicShayna/neopi](https://github.com/PsychedelicShayna/neopi), a source fork that builds and installs as `npi`. The package scope, protocol identifiers, and configuration directory remain compatible with the inherited implementation; `~/.omp` is still the default configuration root. Binary and update policy lives in `AGENTS.md`.

This note records committed fork work. Open issues describe desired work and are not shipped-feature claims.

## Comparison point

The pre-rebrand remote baseline was merge commit `bf8b60f0e0086a29a9c5bd492beb35af95cfc2d4`, which merged [PR #67](https://github.com/PsychedelicShayna/neopi/pull/67), the v18.2.5 synchronization and advisor-delivery reconciliation. Use the remote default branch rather than a local checkout as the comparison source:

```sh
git fetch origin --prune
git log --no-merges v18.2.5..origin/neopi
git diff --stat v18.2.5...origin/neopi
```

Counts move; rerun the commands. For the repeatable release-integration procedure, read [docs/agents/upstream-sync.md](agents/upstream-sync.md).

## User eval: JavaScript, Ruby, Julia, and plugins

Landed 11 Aug 2026, with follow-up through 27 Aug.

User cells that were limited to the Python-facing path now go through `EvalRunner` and a session-scoped `EvalBackendRegistry`. Built-in tokens are `py`/`python`, `js`/`javascript`, `rb`/`ruby`, and `jl`/`julia`. Extensions may register other tokens; the built-in tokens remain reserved.

A busy gate is maintained per language, so independent kernels can run concurrently. Legacy `pythonExecution` session records still obfuscate and replay. User cells route through `handleEvalCommand`; REPL prefix parsing lives in `repl-input.ts`.

Provenance: `243cb14bb5`, `0d81cc5273`, `fb0119faba`, `7342fba72b`, `a7caec171b`, `935dea0259`, `95e78b125c`, `d9339a9e1d`.

## Runtime model loadouts

Landed 11 Aug 2026 in `c81c99786e` and `29d9fc3597`.

`Settings.applyRuntimeOverridesAtomically` swaps `modelRoles`, `retry.fallbackChains`, and `task.agentModelOverrides` as one volatile overlay with baseline restoration. `AgentSession.applyRuntimeModelLoadout` is idle-only. Extensions use `ctx.applyRuntimeModelLoadout`.

## External harness dispatch

Landed 11 Aug 2026 in `cc3819def5`, `2407c059ba`, and `c9ca7ae0a5`.

Agent frontmatter may select the inherited `omp`, `claude`, or `codex` harness identifiers. Claude has an adapter and sidecar. Codex adapter code exists under `task/external-harness/codex.ts`, but `assertExternalHarnessCapabilities` rejects that route because its tool and containment contract cannot be represented exactly. Codex dispatch is present but disabled, not a working feature.

## Fork extensions

The extensions were introduced on 11 Aug 2026 and received their first fork-specific names in `a176f94a08` on 22 Aug. Overlay dashboards were removed in `4aea05b2fb`; current menus use `ctx.ui.select`, `input`, `editor`, and `confirm`.

| Command | Directory | State file |
| --- | --- | --- |
| `/persona` | `extensions/neopi-persona/` | `neopi-persona.json` |
| `/loadout` | `extensions/neopi-loadout/` | `neopi-loadout.json` |
| `/repl`, `/kernel` | `extensions/neopi-repl/` | `neopi-repl.json` |
| `/live-persona` | `extensions/neopi-live-persona/` | `neopi-live-personas.json` |

`/persona` swaps session system-prompt personas in replace, prepend, append, or literal-substitute mode. `/repl` selects agent chat or a built-in eval backend and may register additional backends when `registerEvalBackend` is available. `/live-persona` is command UX over `packages/coding-agent/src/live/personas.ts`.

## Iris live voice

Landed from 22–26 Aug 2026.

The voice model is Iris, separate from the coding agent. Relays stay silent unless addressed. A live handoff aborts through a bounded subscriber drain so barge-in works; spoken responses may continue while background jobs keep the session awake. Crew IRC and provisional reasoning use a speakable channel, live personas resolve transport instructions, and speakable chunks truncate on Unicode code points.

Provenance: `c7bb908557`, `7a87cfe115`, `3b4dd762b6`, `6fa90d9a09`, `14c6e4406f`, `21b0e7cf7e`, `6983ee1a60`, `990964437a`, `4eb5e2594f`, `a991cf58d0`.

## Model selectors on `task`

Landed 23 Aug 2026 in `e4fadf1299` and `7039de1ad4`.

An unregistered `agent` value shaped like `provider/model[:effort]` or `@role[:effort]` crews the generic task agent. Registered agent names take precedence. Invalid selectors fail during preflight.

## Binary, extension deployment, and update

NeoPi builds `packages/coding-agent/dist/npi` and installs only as `npi`. `scripts/install-neopi-extensions.ts` manages the fork extension links without deleting unrelated user extensions. Exact argv `npi update` launches the fork-specific interactive update request from `packages/coding-agent/src/prompts/npi-update.md`; extra update flags retain ordinary updater behavior.

Early binary and deployment work is recorded by `da8bb86645`, `e795702ff4`, `64380829e2`, `05380db554`, and `bc1c74703d`. Current policy supersedes their historical command names; follow `AGENTS.md` and `docs/agents/upstream-sync.md`.

## Portable flash and RAM operation

[PR #48](https://github.com/PsychedelicShayna/neopi/pull/48) landed the portable build and encrypted flash baseline, including the bounded RAM wrapper and resume-state machinery. The PR records host, QEMU Sandy Bridge, and loop-device verification as well as the limits of physical-hardware verification at merge time. RAM-only operation beyond that baseline remains tracked in [#49](https://github.com/PsychedelicShayna/neopi/issues/49).

## Native Chronicler capture

[PR #61](https://github.com/PsychedelicShayna/neopi/pull/61) landed bounded, asynchronous session capture with canonical publication and recovery behavior. It is the capture half of [#46](https://github.com/PsychedelicShayna/neopi/issues/46); hierarchical recall and cross-session synthesis remain open.

## Advisor behavior

[PR #60](https://github.com/PsychedelicShayna/neopi/pull/60) added per-advisor system-prompt overrides. [PR #63](https://github.com/PsychedelicShayna/neopi/pull/63) separated concern, blocker, and nit delivery boundaries while preserving session safety gates.

## xAI dictation

Native xAI batch transcription uses the shared **Dictation** model role: `xai-oauth/grok-stt` for the OAuth provider or `xai/grok-stt` for the API-key provider. An existing legacy xAI selection migrates to the OAuth-first chain `xai-oauth/grok-stt,xai/grok-stt` only when no explicit dictation role is configured. The retired `stt.modelName` selector is no longer a separate control.

Cloud dictation keeps hold-to-talk behavior and writes audio to disk-backed WAV files. The controller retains at most five completed recordings; transcription failures report the retained file's recovery path. These files are temporary: they are removed when they leave the five-recording history or the controller is disposed.

## Upstream synchronization

Recent release integrations landed through [PR #62](https://github.com/PsychedelicShayna/neopi/pull/62) and [PR #67](https://github.com/PsychedelicShayna/neopi/pull/67). Future integrations follow the origin-snapshot, recovery-ref, conflict-ledger, verification, and PR process in [docs/agents/upstream-sync.md](agents/upstream-sync.md).

## Boundaries

- This is not an upstream changelog.
- Open tracker issues are plans, not shipped features.
- Codex external-harness dispatch remains disabled.
- Released changelogs and `docs/updates/` retain their historical names and provenance.
- Inherited package names, wire identifiers, and `~/.omp` compatibility paths are intentionally unchanged.

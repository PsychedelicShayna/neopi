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

The installer and post-build hook honor a hidden `.<extension-name>.quarantined` marker in the destination extensions directory (by default `~/.omp/agent/extensions`). A marked extension is not linked or refreshed, and its legacy counterpart is not retired. The installer reports quarantined names without removing their markers.

To quarantine an active extension, move its link out of the extensions directory and create the corresponding marker, for example `.neopi-repl.quarantined`. The marker prevents reinstallation; it does not disable an already-present link. Remove the marker and rerun `bun scripts/install-neopi-extensions.ts` to restore deployment.

Early binary and deployment work is recorded by `da8bb86645`, `e795702ff4`, `64380829e2`, `05380db554`, and `bc1c74703d`. Current policy supersedes their historical command names; follow `AGENTS.md` and `docs/agents/upstream-sync.md`.

## Portable flash and RAM operation

[PR #48](https://github.com/PsychedelicShayna/neopi/pull/48) landed the portable build and encrypted flash baseline, including the bounded RAM wrapper and resume-state machinery. The PR records host, QEMU Sandy Bridge, and loop-device verification as well as the limits of physical-hardware verification at merge time. RAM-only operation beyond that baseline remains tracked in [#49](https://github.com/PsychedelicShayna/neopi/issues/49).

## Native Chronicler capture

[PR #61](https://github.com/PsychedelicShayna/neopi/pull/61) landed bounded, asynchronous session capture with canonical publication and recovery behavior. It is the capture half of [#46](https://github.com/PsychedelicShayna/neopi/issues/46); hierarchical recall and cross-session synthesis remain open.

## Advisor behavior

[PR #60](https://github.com/PsychedelicShayna/neopi/pull/60) added per-advisor system-prompt overrides. [PR #63](https://github.com/PsychedelicShayna/neopi/pull/63) separated concern, blocker, and nit delivery boundaries while preserving session safety gates.

## Whole-recording xAI speech input

`Ctrl+Space` (`app.stt.toggle`) starts an independent xAI recording; press it again to stop and transcribe the complete WAV through native `grok-stt`. Pauses and silence remain in the recording. Nothing is segmented, streamed, or transcribed while recording. Existing xAI OAuth credentials are preferred, with xAI API-key credentials as the fallback; no Dictation model selection, `stt.enabled` setting, local speech model, or helper executable is required.

Configured upstream dictation remains separate: `Ctrl+Alt+Space` (`app.dictation.toggle`) or the Space-hold gesture uses the **Dictation** model role and `stt.enabled`. The xAI models remain available there as `xai-oauth/grok-stt` and `xai/grok-stt`, but that pipeline does not own Ctrl+Space. Pressing Backspace while holding Space latches the recording so it survives releasing the bar; a later Space or Backspace tap stops it, and other keys type normally meanwhile.

Ctrl+Space is system-reserved for the xAI path (`RESERVED_KEYS` in `packages/tui/src/app-keybindings.ts`). User keybinding overrides cannot remap `app.stt.toggle` or bind Ctrl+Space elsewhere, and extension shortcuts on it are refused with an extension error.

Cloud dictation keeps hold-to-talk behavior and writes audio to disk-backed WAV files. The controller retains at most five completed recordings; transcription failures report the retained file's recovery path. These files are temporary: they are removed when they leave the five-recording history or the controller is disposed.

## Post-processing chains

A chain rewrites a composer prompt through ordered model steps before it is sent. Each step's output is the next step's input, and the last output is what gets sent. Voice input needs nothing special: Ctrl+Space puts the transcript in the composer, and chaining happens when that text is sent.

- **Alt+C** (`app.message.chain`) sends the composer text through the active chain once.
- **`/chaining on`** runs every prompt through it; **`/chaining off`** stops that (Alt+C still works).
- **`/chaining use <name>`** sets the active chain; with no name it clears it. With no active chain, a chained send asks which chain to use (or to send unchanged), and the pick becomes active.
- **`/chaining status`** lists the mode, the active chain, and every chain's steps; **`/chaining configure`** opens the editor.

Only plain prompts are chained; slash commands, skills, `!bash`, eval input, and continue shortcuts are not. A failing step sends nothing and puts the typed text back in the composer. Up-arrow history keeps the typed text, not the rewrite. `chaining.auto` and `chaining.active` are settings, so a project can override them in its `.omp/config.yml`.

Chains live in `CHAINS.yml` beside advisors' `WATCHDOG.yml`: `<agent dir>/CHAINS.yml` (global) and the project root's `CHAINS.yml`; a project chain shadows a global chain with the same name. `/chaining configure` edits either scope. Each step has a name, a prompt (its system prompt; the incoming text is the user message), an optional model (`provider/id`, `provider/id:level`, or `@role`), and optional tools (none by default):

```yaml
chains:
  - name: decompose
    description: Vague request to concrete instructions
    steps:
      - name: names
        model: xai-oauth/grok-4.7:low
        tools: [bash]
        prompt: |
          Check the system username with bash and correct any misspelling of it in the text. Output only the text.
      - name: instructions
        prompt: |
          Rewrite the text as clear, numbered instructions for a coding agent. Output only the rewrite.
```

Steps without a model use the **Prose** role (`@prose`), which falls back to the fast `smol` chain when unset; switching that one role in the model menu retargets every such step.

## Upstream synchronization

Recent release integrations landed through [PR #62](https://github.com/PsychedelicShayna/neopi/pull/62) and [PR #67](https://github.com/PsychedelicShayna/neopi/pull/67). Future integrations follow the origin-snapshot, recovery-ref, conflict-ledger, verification, and PR process in [docs/agents/upstream-sync.md](agents/upstream-sync.md).

## Boundaries

- This is not an upstream changelog.
- Open tracker issues are plans, not shipped features.
- Codex external-harness dispatch remains disabled.
- Released changelogs and `docs/updates/` retain their historical names and provenance.
- Inherited package names, wire identifiers, and `~/.omp` compatibility paths are intentionally unchanged.

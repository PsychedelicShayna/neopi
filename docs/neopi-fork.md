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

## Terminal image protocol

`/settings` → Appearance → Images → **Terminal Image Protocol** switches terminal image rendering without restarting. The same setting is available at `cfg://terminal.imageProtocol`: `auto` (default), `kitty`, `sixel`, `iterm2`, or `off`.

An explicit setting wins over `PI_FORCE_IMAGE_PROTOCOL`; `auto` uses that environment variable when present and otherwise restores terminal detection and probing. `off` disables new terminal images. Kitty placeholder support follows the effective choice; passing through raw Sixel output still also requires `PI_ALLOW_SIXEL_PASSTHROUGH=1`.

Switching applies from that point forward with a redraw. It does not delete or retransmit images already shown, so earlier images may not render correctly under the new protocol. The setting only controls terminal output: images sent to the model and provider prompt caching are unaffected.

## Operator commands

Introduced as extensions on 11 Aug 2026 and made built-in commands on 28 Sep 2026. The `extensions/` directory, its installer, and the build and install deployment hooks are gone; state files are unchanged.

Before extension discovery, startup runs a one-time migration in the active agent directory to unlink the former managed `neopi-*` and `omomp-*` extension links. Only links targeting `extensions/<same-name>` are retired, including dangling links to old checkouts. Real directories, custom links, backups, quarantine markers, and saved command state stay untouched. Completion is recorded in `.neopi-extensions-retired`; installing a binary no longer performs this migration.

| Command | State file (agent dir) |
| --- | --- |
| `/persona` | `neopi-persona.json` |
| `/persona live` | `neopi-live-personas.json` |
| `/loadout` | `neopi-loadout.json` |
| `/repl`, `/kernel` | none (per TUI session) |
| `/notice <text>` | current session transcript |

Each store is schema-v1 JSON written atomically with a `.bak` of the previous file. A missing `neopi-*` file falls back to the pre-rename `omomp-*` file.

### Personas

`/persona` opens a fullscreen editor in the style of `/chain configure`: personas on the left, the highlighted definition on the right. Keys are listed in the footer: Enter edits, Space makes the highlighted persona active (again to turn it off), Delete twice removes, `s` saves and applies, and Esc closes (it asks once before discarding unsaved changes). A persona has a mode (replace, prepend, append, or literal-substitute), an inline text or a file path inside the agent directory, and an inherit-to-tasks flag.

`/persona live` opens the same editor for the live voice model. The bundled default is read-only; clone it to customize. A new live persona starts from the default instructions.

Choose **Generate live persona** to select a generator model, then reference prompts with Space, then describe the persona and press Enter. The reference pool includes the default live template, all custom live and session personas, and discovered prompt templates. Nothing is selected automatically. Use the default template alone, existing prompts alone, or both. Generation opens the new entry in the existing editor with Name selected. Its instructions and context sources remain editable, and Save & apply persists it without changing any running voice session. Esc cancels generation or returns to the preceding step.

The live pane's Sources settings include **Seed primary transcript on call start**, off by default, and **History seed token budget**, default 8000 tokens with a range of 128 to 64000. Both persist per persona, including the bundled default, and apply on the next call. Seeding copies the current session's recent authored prose in chronological order, retaining role/provenance labels and summaries but excluding tool output, image payloads, and private reasoning. Whole recent blocks are preferred; an oversized latest block keeps its beginning and end with a truncation marker. Each transport chunk is labelled as silent history, is not spoken, and does not request delegation. Labels count toward the token budget.
Both scopes take the same subcommands: `set <name>`, `off` (live: back to the default), `list`, `show <name>`, `status`, `clone <source> <name>`, and `delete <name>`. For example, `/persona set reviewer` or `/persona live set iris`. Changing the active persona invalidates the prompt cache, so switch deliberately.

The session persona is selected per session id. `AgentSession` applies it while preparing each turn, before extension `before_agent_start` handlers, so extensions see and may further change the persona prompt. A persona that cannot apply (missing file, literal not found) leaves the base prompt in place and shows a warning.

### Loadouts

`/loadout` lists loadouts; picking one applies it, and "Turn loadout off" restores the configured models. `/loadout set|use|off|list|show|status` do the same from the composer; `use <name>` is an alias for `set <name>`. The normal command catalogue includes its description and icon, and argument completion offers subcommands and loadout names. Accepting `set` or `use` waits for the required name before submitting. `AgentSession.applyRuntimeModelLoadout` swaps model roles, retry fallback chains, and task-agent model overrides as one volatile overlay, and only while the session is idle.

### REPL mode

`/repl` points the composer at a kernel: JavaScript, Python, Bash, or back at the agent (`/repl js`, `/repl py`, `/repl bash`, `/repl agent`). `Alt+Shift+R` (`app.repl.toggle`) toggles between the agent and the last kernel.

In REPL mode, Enter inserts a newline so multi-line code is written as in an editor; with Vim mode on, Normal-mode Enter moves down a line. `Ctrl+Q` or `Ctrl+Enter` (`app.repl.execute`, the follow-up chords) runs the whole buffer in the kernel. A one-line draft starting with `/` still submits on Enter, so `/repl agent` and other commands work from REPL mode. JavaScript and Python cells use the built-in eval kernels; Bash cells use the bash executor. The status line shows the target and keys.

`/kernel` shows which kernels are running, `/kernel reset <py|js>` starts the next cell in a fresh kernel, and `/kernel interrupt` cancels running cells.

### Operator notices

`/notice <text>` sends a hidden, operator-authored developer-role message to the foreground main session, wrapped in `<system-notice>` tags. It starts a turn when idle and uses the normal steering queue while the agent is busy. The developer role and operator attribution survive transcript persistence and replay.

Queued notices appear with their original `/notice …` text in the pending bar. Alt+Up returns a notice to the composer for editing; Esc restores pending operator notices before interrupting the turn. Notices cancelled during turn setup are also returned as the original command, not as wrapped prompt text. Automatic agent-authored notices remain hidden.

Text after the command separator is literal: multiline content, whitespace, shell characters, model mentions, and template expressions are not expanded. `/notice` without non-whitespace text shows `Usage: /notice <text>` without starting a turn. The command is host-only during collaboration, does not target focused subagents or broadcast, and is not an agent tool.

## Delayed composer submissions

`/defer <duration> <input>` submits the remaining input through the normal composer interpreter after the delay. For example, `/defer 10m /compact` runs compaction in ten minutes, while `/defer 10m hi` sends `hi` just like Enter. Busy prompts use the existing session message queue; slash commands keep their normal behavior. Your current draft and its images are not submitted with the deferred input.

Images attached to the `/defer` submission travel with that scheduled input, not your next message. A timer is not a new Enter gesture: during a live call it follows the session input path without retiring or handing off your current speech. If confirmation, a read-only session, or a busy kernel refuses the input, it returns to the composer alongside your newer draft, with a warning and its own attachments preserved.

Durations accept numbers immediately followed by `ms`, `s`, `m`, `h`, `d`, `w`, `M`, or `Y`, including fractions (`.5h`). Units are case-sensitive: `M` means 30 days and `Y` means 365 days, not calendar arithmetic. Zero or negative delays submit immediately.

Scheduling reports an ID. `/defer cancel <id>` cancels that submission, including delivery still waiting on an input hook or command; `/defer cancel all` cancels every pending submission. Deferred input stays bound to the scheduling conversation even if you focus a subagent before it fires. A session change or shutdown cancels both waiting timers and in-flight delivery, so resumed hooks cannot send old input into a new conversation or restore its attachments there. Timers are local to the running conversation and are not persisted across restarts.

## Iris live voice

Landed from 22–26 Aug 2026.

The voice model is Iris, separate from the coding agent. Relays stay silent unless addressed. Live handoffs steer without cancelling active work by default; spoken responses may continue while background jobs keep the session awake. Crew IRC and provisional reasoning use a speakable channel, live personas resolve transport instructions, and speakable chunks truncate on Unicode code points.

Use `/live model` to show the configured realtime model slug, or `/live model <slug>` to save a new one for the next call. Settings > Providers > Services > Live Model edits the same `live.model` setting. The default remains `gpt-live-1-codex`; selecting a different model does not interrupt an active call. RPC live calls use the same setting.

Provenance: `c7bb908557`, `7a87cfe115`, `3b4dd762b6`, `6fa90d9a09`, `14c6e4406f`, `21b0e7cf7e`, `6983ee1a60`, `990964437a`, `4eb5e2594f`, `a991cf58d0`.

### Live composer (issue #41)

`/live` leaves the ordinary composer mounted and focused. Speech appears as a volatile preview while speaking, then the final transcript replaces it. A sent speech batch clears the entire draft and saves the exact delivered text in composer history; Up recalls it even when Iris answered without delegating.

Iris's in-flight reply appears in a single-row **Voice:** caption above the status line, rather than extending a transcript block below an active primary-agent turn. Finalized replies are written in full to the transcript when the primary turn settles; while it is still streaming, operator-run command output shows a bounded preview with older rows hidden, not discarded. Enter still steers the main agent between tool calls, whereas Ctrl+Enter queues for the next yield.

- Keys: `Ctrl+L` starts and ends the call; `Alt+Shift+M` (`app.live.mute`) mutes; `Ctrl+Alt+L` (`app.live.destination.cycle`) cycles where Enter sends plain text: main agent, voice agent only, or both. Esc and Ctrl+C keep their composer meanings.
- Status: the model segment shows a mic colored by call phase, slashed while muted, labelled `voice` or `both` when Enter does not target the main agent, and red after a call ends in an error.
- Enter is the operator's handoff: submitting (or clearing the draft with Ctrl+C) drops unclaimed spoken turns and cancels a handoff not yet accepted, so the voice agent cannot relay them again. If a handoff of that speech is landing at that moment, Enter holds the draft instead. Voice-only text reaches the voice model as an `"Operator Typed Message"`; `both` also sends the final prompt, after input hooks and any post-processing chain, as silent commentary, and the voice agent speaks that turn's final answer.
- **Live Handoff Delivery** in settings (`live.delegationDelivery`) selects `steer` (default: deliver between steps without cancelling reasoning or running tools), `followUp` (queue until the active run yields), or `interrupt` (abort through a bounded subscriber drain and restart). Changes apply to the next handoff, including force-delegation, without restarting the call. When no model run is active, a handoff starts a new turn; standalone operator bash/eval work is left running unless `interrupt` is selected. Esc still explicitly stops the main agent.
- Queued vocal requests appear as their canonical operator text. Esc restores undelivered speech to the composer without Iris's routing prose; Alt+Up can also take queued speech back for editing. Queue-for-yield preserves the preceding task's spoken final answer. Steering and queued follow-ups activate the next handoff's voice routing only when its message is consumed, so ongoing reasoning and progress keep their original request's route.
- Rapid handoffs follow actual consumption order, not arrival order: a steered request C can overtake queued follow-up B while A finishes. Each completed request's final answer is relayed on its own route before the next handoff takes over, including handoffs accepted at the yield boundary. When C and B are consumed into one provider response, that combined final answer is delivered once to each handoff's route, so neither request is left unanswered.
- If a typed prompt replayed after compaction fails, its rollback restores only the typed queue it owns. Independently accepted vocal handoffs stay in the main agent's existing queue and are delivered once when work resumes.
- Crew reports, reasoning narration, and final answers wait while the operator speaks or edits the composer (10-second quiet window), releasing early when the voice agent speaks or delegates.
- `live.submitKeyword` releases one complete composer request to Iris, who may answer or delegate it; it does not press Enter or force the primary. `live.forceDelegateKeyword` explicitly sends the request to the primary and silently notifies Iris. Enter's main/voice/both destination remains independent of these spoken controls.
- Interactive and RPC live calls share one trailing-keyword timer. The phrase must remain at the end through `max(live.submitSilenceMs, live.quietFloorMs)` of microphone and composer inactivity; speech also waits for its authoritative final transcript. More speech, a typed edit, or a correction resets the boundary. Earlier keyword occurrences remain ordinary text. Matching is case/punctuation/whitespace insensitive. Attachments are expanded for delivery, not inspected for routing phrases.
- `live.holdMode` retains unsent input; configuring a submit keyword also prevents premature model handoffs before that keyword's boundary. Holding the next draft does not cut off an admitted Iris reply or the returned answer to earlier work. A new utterance re-arms holding, and an explicit submission discards obsolete pre-submit routing/reply state.
- Per-utterance routing remains separate from submission timing: a leading `live.suppressDelegateKeyword` direct address or a `live.blockDelegateKeyword` keeps that utterance with Iris; `live.forceUtteranceKeyword` anywhere in ordinary finalized speech requires delegation once the input is released. Direct address and block take precedence over force-utterance. An empty keyword disables its action.
- Iris-only speech is removed from the composer and added to history only after its sanitized message reaches the voice transport. Its receipt removes only that utterance's unchanged spoken spans: newer typed text, partial/final speech, attachments, and operator rewrites remain in the composer. If the call stops or delivery fails first, the sanitized text stays for manual recovery. Stopping after the main agent accepts a handoff records that speech in history exactly once.

- `/persona live` stores context-source defaults per live persona. Open a persona's **Context sources** pane to choose IRC, subagent depth and voiced slots, classifier timing, catalog effort alerts, advisor notes, reasoning/progress/final-answer relays, and delegation provenance; the built-in default has editable source settings too. **Importance classifier** and **Effort red alerts (catalog)** are independent switches: disabling ranking does not disable authorization checks. Turning **Primary final answers** (`relayFinalAnswers`) off also silences delegated answers returned to Iris.
- Importance scoring uses the `classifier` model role followed by the configured global fallback chain. Effort alerts consult the schema-v1 model catalog (the configured path supports `~` expansion): a present `null` model/effort slot means no policy recommendation, while an absent model or slot is reported as missing metadata. Authorization attempts each candidate model up to three times before falling through. Cooperative timeout/backoff arithmetic does not bound real latency because provider setup, prior single-flight work, and streams that ignore abort may wait indefinitely. When alert bookkeeping overflows, Iris receives a counted `authorization not checked` notice; the client never blocks or kills those agents.
- Scoring tries each fitting classifier candidate until one returns usable scores, including when authorization was already resolved independently. It keeps start-order tracking and warns only after the chain is exhausted without scores.
- Failed scoring attempts log the model, reason, and roster/alert counts. If all candidates fail, the start-order warning includes the first failure's model and reason rather than discarding the provider error or timeout.
- Catalog schema-v1 effort levels are `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; the live loader accepts the operator catalog's complete effort list.
- Classifier requests preserve every agent identity and state. If a request does not fit, they trim optional transcript excerpts first and task descriptions second, without dropping agents, against the model's **standard** context window minus its actual mapped output allowance, system/framing tokens, and reserve. A candidate may still not fit and is then skipped for the next fallback.
- Returned context uses stable prefixes: `Crew relay from`, `Subagents started` (optionally `Priority:` or `High priority:`), `Now tracking`/`released`, `Red alert:`, `Subagent report from`, subagent/advisor reasoning and progress labels, and `Advisor note from`. Delegations keep the operator transcript verbatim and carry Iris's separate prose in `<voice-agent-note>` provenance; Iris may also ask the primary a voice-only question as a non-interrupting note whose answer returns as `Agent Final Message`.

## Model selectors on `task`

Landed 23 Aug 2026 in `e4fadf1299` and `7039de1ad4`.

An unregistered `agent` value shaped like `provider/model[:effort]` or `@role[:effort]` crews the generic task agent. Registered agent names take precedence. Invalid selectors fail during preflight.

A registered agent name may carry an effort suffix: `scout:high` runs the `scout` agent, with its own prompt, tools, restrictions and model, at `high` effort. An exact registered name wins first, so a name that itself contains `:` keeps working. The suffix is a caller-explicit level, like a model selector's; an effort the agent's model cannot honor fails preflight and names that model. The same grammar applies to task, eval `agent()` and `workpool()` ([#230](https://github.com/PsychedelicShayna/neopi/issues/230)).

## Binary and update

NeoPi builds `packages/coding-agent/dist/npi` and installs only as `npi`. Exact argv `npi update` launches the fork-specific interactive update request from `packages/coding-agent/src/prompts/npi-update.md`; extra update flags retain ordinary updater behavior.

Early binary and deployment work is recorded by `da8bb86645`, `e795702ff4`, `64380829e2`, `05380db554`, and `bc1c74703d`. Current policy supersedes their historical command names; follow `AGENTS.md` and `docs/agents/upstream-sync.md`.

## Portable flash and RAM operation

[PR #48](https://github.com/PsychedelicShayna/neopi/pull/48) landed the portable build and encrypted flash baseline, including the bounded RAM wrapper and resume-state machinery. The PR records host, QEMU Sandy Bridge, and loop-device verification as well as the limits of physical-hardware verification at merge time. RAM-only operation beyond that baseline remains tracked in [#49](https://github.com/PsychedelicShayna/neopi/issues/49).

## Native Chronicler capture

[PR #61](https://github.com/PsychedelicShayna/neopi/pull/61) landed bounded, asynchronous session capture with canonical publication and recovery behavior. It is the capture half of [#46](https://github.com/PsychedelicShayna/neopi/issues/46); hierarchical recall and cross-session synthesis remain open.

## Advisor behavior

[PR #60](https://github.com/PsychedelicShayna/neopi/pull/60) added per-advisor system-prompt overrides. [PR #63](https://github.com/PsychedelicShayna/neopi/pull/63) separated concern, blocker, and nit delivery boundaries while preserving session safety gates.

## Background issue filing

`/issue <prose>` ([#305](https://github.com/PsychedelicShayna/neopi/issues/305)) files the operator's own words as an issue without taking over the conversation. Everything after `/issue` is ordinary prose; there is no project, type, or label syntax. It runs as a background job on the `issues` model role, which must be assigned explicitly (it never falls back to the active model, and the job disables provider model fallback).

Two agents run in sequence, both visible in the Agent Hub:

1. `IssueTarget-<id>` picks the tracker. It sees the prose plus an inventory merged from the foreground checkout, the `issues.checkouts` override map (`OWNER/REPO` → local path), checkouts found through session history, and `gh repo list`. Only GitHub remotes count (github.com or the configured `GH_HOST`), and a checkout counts only for its `origin`. The agent can select only a repository from that inventory that has a verified local checkout; it never clones. If the target is ambiguous it asks.
2. `Issue-<id>` starts with its cwd in that checkout, so the target's own `AGENTS.md` chain is loaded. Its tools are pinned to the selected repository:
   - read-only file tools;
   - issue search and view, and the live label list;
   - five sampled historical issues: the newest, the ordinal midpoint, and three random issues between them (all issues when there are five or fewer);
   - one `issue_publish`.

   Labels must already exist. Publication is exactly-once: repeated calls share one create. A create whose result is uncertain is reconciled against the operator's own issues with the same title and body before anything is retried. When an existing issue owns the subject, the agent returns a drafted amendment instead and posts nothing.

Either agent can end the request with `issue_decline`, for example when the operator replies that nothing should be filed. A declined request files nothing and records the reason.

Questions from either agent appear in the transcript; answer them in the Agent Hub, where the request is kept. Status records (dispatch, question, filed URL with the submitted body and applied labels, existing owner, failure) are display-only: they never start a foreground turn and do not lift holds. While the foreground is mid-turn the status line shows them immediately and the record follows at the next turn.

## Whole-recording xAI speech input

`Ctrl+Space` (`app.stt.toggle`) starts an independent xAI recording; press it again to stop and transcribe the complete WAV through native `grok-stt`. Pauses and silence remain in the recording, and 750 ms of synthetic silence is appended after nonempty captures so the recognizer hears the end of the utterance. Nothing is segmented, streamed, or transcribed while recording. Existing xAI OAuth credentials are preferred, with xAI API-key credentials as the fallback; no Dictation model selection, `stt.enabled` setting, local speech model, or helper executable is required.

Configured upstream dictation remains separate: `Ctrl+Alt+Space` (`app.dictation.toggle`) or the Space-hold gesture uses the **Dictation** model role and `stt.enabled`. The xAI models remain available there as `xai-oauth/grok-stt` and `xai/grok-stt`, but that pipeline does not own Ctrl+Space. Pressing Backspace while holding Space latches the recording so it survives releasing the bar; a later Space or Backspace tap stops it, and other keys type normally meanwhile.

Live voice and both dictation shortcuts share one microphone capture. Recording into the composer does not mute or end the call: the live model continues hearing the same microphone frames, including speech spoken for dictation, and its ordinary live transcript may also appear in the composer.

Ctrl+Space is system-reserved for the xAI path (`RESERVED_KEYS` in `packages/tui/src/app-keybindings.ts`). User keybinding overrides cannot remap `app.stt.toggle` or bind Ctrl+Space elsewhere, and extension shortcuts on it are refused with an extension error.

Cloud dictation keeps hold-to-talk behavior and writes audio to disk-backed WAV files. The controller retains at most five completed recordings; transcription failures report the retained file's recovery path. These files are temporary: they are removed when they leave the five-recording history or the controller is disposed.

## Post-processing chains

A chain rewrites a composer prompt through ordered model steps before it is sent. Each step's output is the next step's input, and the last output is what gets sent. Voice input needs nothing special: Ctrl+Space puts the transcript in the composer, and chaining happens when that text is sent.

- **Alt+C** (`app.message.chain`) sends the composer text through the active chain once.
- **`/chain on`** runs every prompt through it; **`/chain off`** stops that (Alt+C still works).
- **`/chain use <name>`** sets the active chain; with no name it clears it. With no active chain, a chained send asks which chain to use (or to send unchanged), and the pick becomes active.
- **`/chain status`** lists the mode, the active chain, and every chain's steps; **`/chain configure`** opens the editor.

Only plain prompts are chained; slash commands, skills, `!bash`, eval input, and continue shortcuts are not. Up-arrow history keeps the typed text, not the rewrite. `chaining.auto` and `chaining.active` are settings, so a project can override them in its `.omp/config.toml`.

While a chain runs, the composer is locked: the draft stays visible with every line painted by the `display.shimmer` sweep (static muted text when shimmer is disabled), typing is ignored, and the status line shows the chain, the step, and `preprocessing…`. Each completed step replaces the composer text, so the rewrite is visible as it happens.

- **Esc Esc** (within 3 s) skips the step in flight; its input passes to the next step unchanged.
- **Esc Esc Esc** (within the same 3 s) or **Ctrl+C** aborts the chain and puts the typed draft back, nothing sent.
- A failing step stops the chain and leaves the last completed output in the composer, editable and unsent.

Chains live in `CHAINS.toml` beside advisors' `WATCHDOG.toml`: `<agent dir>/CHAINS.toml` (global) and the project root's `CHAINS.toml`; a project chain shadows a global chain with the same name. `/chain configure` edits either scope. Each step has a name, a prompt (step instructions; the incoming text is the user message), an optional model (`provider/id`, `provider/id:level`, or `@role`), optional tools (none by default), and three optional keys:

- **`enabled: false`** turns a step off without deleting it: the chain skips it and runs the remaining steps in their configured order, and the step keeps its prompt, model, and position for when it is turned back on. Steps without the key are on. In `/chain configure`, Space on a step row of the chain screen turns that step on or off; the row shows `[x]` or `[ ]`, and `/chain status` and the configure preview mark it `(off)`. A chain whose steps are all off sends the text unchanged, the same as a chain with no steps.
- **`context: true`** gives the step the live session transcript (thinking elided, tool calls collapsed) wrapped in `<transcript>`, with the text to rewrite in `<draft>`, so references like "remove mine" resolve against the conversation. Both tags carry a per-run boundary so tag-like text inside them cannot close a block. The transcript keeps only the newest messages that fit after the step prompt, granted tool schemas, framing, and the provider's maximum output are reserved; the output reserve includes provider-added reasoning tokens when enabled. Off by default; the configure screen's "Transcript context" row toggles it.
- **`systemPrompt`** replaces the bundled chain system prompt, which tells the model it is rewriting a draft and to output only the rewrite, with no notes about what changed. The step `prompt` is always appended after it. In `/chain configure` the "System prompt" row shows `(bundled default)`, Enter opens the current text, and Backspace on the row resets an override.

```toml
[[chains]]
name = "decompose"
description = "Vague request to concrete instructions"

[[chains.steps]]
name = "names"
model = "xai-oauth/grok-4.7:low"
tools = ["bash"]
context = true
prompt = """Check the system username with bash and correct any misspelling of it in the text. Output only the text.
"""

[[chains.steps]]
name = "instructions"
prompt = """Rewrite the text as clear, numbered instructions for a coding agent. Output only the rewrite.
"""
```

Legacy `CHAINS.yml` / `CHAINS.yaml` is imported once into a sibling TOML file atomically with the same permissions. The YAML remains unchanged; existing TOML wins with a paths-only warning when both formats exist. Editor saves patch TOML while preserving top-level, chain, and step comments and future fields.

YAML comment text is retained in a labelled TOML preamble; its original field associations cannot survive the format change.

Steps without a model use the **Prose** role (`@prose`), which falls back to the fast `smol` chain when unset; switching that one role in the model menu retargets every such step.

## Upstream synchronization

Recent release integrations landed through [PR #62](https://github.com/PsychedelicShayna/neopi/pull/62) and [PR #67](https://github.com/PsychedelicShayna/neopi/pull/67). Future integrations follow the origin-snapshot, recovery-ref, conflict-ledger, verification, and PR process in [docs/agents/upstream-sync.md](agents/upstream-sync.md).

## Boundaries

- This is not an upstream changelog.
- Open tracker issues are plans, not shipped features.
- Codex external-harness dispatch remains disabled.
- Released changelogs and `docs/updates/` retain their historical names and provenance.
- Inherited package names, wire identifiers, and `~/.omp` compatibility paths are intentionally unchanged.

# Advisor, WATCHDOG.md, and WATCHDOG.yml

The advisor subsystem attaches one or more optional reviewer models to a session. Each advisor reviews primary-agent transcript updates, can inspect the workspace with its own tools, and injects concise advice back into the primary session.

An advisor does not approve actions or mutate primary session state directly. Its default investigative toolset is `read`, `grep`, and `glob`, plus `recall` when the active memory backend provides it, but a `WATCHDOG.yml` roster entry may grant any built-in — including mutating tools such as `edit`, `write`, `bash`, and `eval`. Those tools run in an isolated advisor `ToolSession`, but they honor the session's normal approval mode and per-tool policies; grant them only when the advisor model and workspace are trusted (see [Tools and isolation](#tools-and-isolation)).

## Implementation files

- [`src/advisor/runtime.ts`](../packages/coding-agent/src/advisor/runtime.ts)
- [`src/advisor/advise-tool.ts`](../packages/coding-agent/src/advisor/advise-tool.ts)
- [`src/advisor/emission-guard.ts`](../packages/coding-agent/src/advisor/emission-guard.ts)
- [`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)
- [`src/advisor/config.ts`](../packages/coding-agent/src/advisor/config.ts)
- [`src/advisor/transcript-recorder.ts`](../packages/coding-agent/src/advisor/transcript-recorder.ts)
- [`src/prompts/advisor/system.md`](../packages/coding-agent/src/prompts/advisor/system.md)
- [`src/prompts/advisor/advise-tool.md`](../packages/coding-agent/src/prompts/advisor/advise-tool.md)
- [`src/session/session-advisors.ts`](../packages/coding-agent/src/session/session-advisors.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/advisor/settings.ts`](../packages/coding-agent/src/advisor/settings.ts) — `advisor.*` setting definitions

---

## Enabling the advisor

The subsystem requires `advisor.enabled: true`. RPC and ACP hosts use protocol defaults for `advisor.*` instead of inheriting local interactive preferences: the advisor starts disabled unless that host explicitly opts in.

Model selection depends on the roster:

- Without any discovered `WATCHDOG.yml` advisor entries, OMP creates the legacy/default advisor and resolves the `advisor` role.
- With a roster, each enabled entry uses its explicit `model` when present, otherwise the `advisor` role. An unresolvable entry is reported as `no_model` without preventing other entries from running.
- Without a role activation set, `advisors[].enabled: false` keeps an entry visible as paused but does not build its runtime.

Example:

```yaml
modelRoles:
   advisor: anthropic/claude-sonnet-4-5:medium

advisor:
   enabled: true
```

Model selectors use normal role/model resolution, including provider-prefixed ids, canonical ids, fallback lists, and optional thinking suffixes.

A configured `modelRoles.advisor` wins without silently falling back when it is invalid. When unset, advisor-role resolution uses a configured `slow` role, then the built-in slow priority chain; it does not simply inherit the primary model.

Without an effort suffix, advisors request `medium`, clamped to the model's supported range. `:auto` follows the primary agent's resolved effort at review boundaries rather than running a separate advisor classifier. Models without controllable effort inherit their normal reasoning behavior.

### Role activation sets

Each saved roster advisor has a hidden `id`. New advisors and clones get fresh IDs, even when their other fields match. Existing entries receive IDs on their first save in `/advisor configure`. Renaming preserves the ID. Copy the persisted ID from `WATCHDOG.yml` when declaring a role activation set.

Duplicate IDs within one file emit a warning without hiding rows. Only the first row uses the shared ID during discovery. Saving in `/advisor configure` gives later duplicates fresh IDs and preserves each row's settings.

Store the set alongside the role's other settings in the user settings file or the project's `.omp/config.yml`:

```yaml
roleSettings:
  slow:
    advisor.activationSet:
      - 0198ad12-6751-7455-b102-45e8fe384b9e
```

User-scoped sets can reference user advisors only. Project-scoped sets can reference any advisor visible in that project. A missing or out-of-scope reference produces a warning and is skipped without failing the role switch.

Activation precedence is:

1. The global/session advisor switch must be on. A role never turns that switch on.
2. An explicit role activation set selects exactly its listed advisors, including entries whose own `enabled` flag is false. `[]` selects none.
3. Without a set, each advisor's own `enabled` flag decides, including the legacy default when no roster exists. Omit the setting or use `null` to restore this behavior.

Switching roles stops old-only advisors and starts new-only advisors. Advisors selected by both roles keep their running context and pending reviews. `/advisor status` explains the current activation policy. Activation-set editing belongs to the role editor, not the model picker.


### Backup reviewer

When the advisor's model fails (outage, rate limit, unreachable endpoint), the advisor switches to the next model in its `retry.fallbackChains` entry and retries the same review. Key the chain on the `advisor` role, or on the advisor's exact model selector:

```yaml
modelRoles:
   advisor: openai/gpt-5.5:medium

retry:
   fallbackChains:
      advisor:
         - anthropic/claude-sonnet-4-5:medium
         - google-vertex/gemini-3-pro
```

This follows the same rules as the primary's fallback: `retry.enabled` and `retry.modelFallback` must be on, candidates still cooling down, without credentials, or incompatible with native advisor history are skipped, and `retry.fallbackRevertPolicy: cooldown-expiry` returns the advisor to its primary model once the cooldown ends. Credential rotation is attempted before switching models. Short usage-limit blocks can instead be waited out within `retry.maxDelayMs` and the retry budget; longer/exhausted blocks pause the advisor.

A classifier refusal by the advisor's primary model (for example Anthropic's `Refusal (cyber)`) is treated as a judgment of the reviewed content rather than a model failure: it puts no cooldown on that model and pins the advisor to its fallback. The pin lasts until a compaction (the session's or the advisor's own), a handoff, or a new conversation replaces that content; the next review then retries the primary under `retry.fallbackRevertPolicy`. A fallback model that refuses is skipped with the usual cooldown and does not pin, so a primary that only failed for another reason still returns once its cooldown ends.

`tier.advisor` controls service tier for all advisors. It defaults to `none` (standard processing); `inherit` follows the primary's live per-family tier, including `/fast` changes. Concrete values (`auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`) are applied only when the advisor model's provider family supports them.

`retry.fallbackOn` also decides which advisor failures may switch models: under `usage-limit` only a usage limit walks the chain, and any other failure stays on the advisor's own model with its usual retries before the review is dropped; under `except-usage-limit` a usage limit rotates credentials, waits, or pauses the advisor instead of switching.

### Default advisor settings

When no `WATCHDOG.yml` roster is present, the default advisor uses these settings from the Model tab:

- `advisor.reviewMode` — review cadence: `turn` (default) reviews every primary turn; `agent-end` reviews only final yields.
- `advisor.reviewInterval` — review every Nth eligible update (default `1`). Skipped updates are captured as the primary saw them and sent with the next scheduled review.
- `advisor.maxNotesPerUpdate` — maximum non-blocker advice notes accepted per advisor update (default `4`, range 1–32). Blockers are exempt.
- `advisor.syncBacklog` — catch-up policy (default `off`); numeric thresholds are bounded, while `strict` waits without a wall-clock cap.

Edits to these settings apply to the running advisor at its next primary boundary without rebuilding it.

Roster entries set their own cadence: an omitted `reviewMode` means `turn` and an omitted `reviewInterval` means `1`, regardless of the settings above. An omitted `syncBacklog` inherits `advisor.syncBacklog`, and an omitted `maxNotesPerUpdate` inherits the shared `WATCHDOG.yml` top-level value, then `advisor.maxNotesPerUpdate`. An explicit `syncBacklog: off` overrides a global `strict`.

Rebuilding advisors (saving `/advisor configure`, model-role or context changes) keeps updates the cadence skipped: each rebuilt advisor receives them with its next scheduled review.

### Delivery controls

These settings apply to both the default advisor and named roster advisors, independently of review cadence:

- `advisor.continueSeverity` — lowest severity that may request a continuation after a terminal answer: `nit`, `concern` (default), or `blocker`. `nit` allows any accepted severity to request continuation; `blocker` leaves lower-severity notes as visible cards. Stop, immunity, mode, and client constraints still apply.
- `advisor.immuneTurns` — completed primary turns protected from further non-blocker steering after successful concern/blocker steering (default `3`; `0` disables the cooldown). Tool-loop continuations count even when the reviewer uses `agent-end`. Blockers are exempt from immunity, not from stop or client guards.

`reviewMode` decides when an advisor reviews, not which advisor owns continuation rights. Both turn and final-yield reviewers use the same severity threshold and delivery guards.

### Headless runs

Use `--advisor` to enable the advisor for one print-mode process without
persisting `advisor.enabled`:

```sh
omp -p --advisor "Review this task."
```

While a primary prompt is running, eligible advisor notes can steer that run. After the final prompt settles, print mode preserves late advisor notes without starting hidden primary turns, sends updates the review cadence skipped (so an `agent-end` or interval reviewer still reviews the final answer), then waits up to ten minutes for final reviews before disposing the session. That wait covers a failing advisor's retries and [backup reviewer](#backup-reviewer) switch, so a review that fails on the advisor's model finishes on its fallback instead of being abandoned. Error exits use a 30-second drain budget so failed automation can terminate. An advisor whose catch-up policy is `strict` is waited on without either budget; aborts, halts, and quota pauses still end its wait. If a budget expires, or the advisor stops for good (halted or quota-paused), OMP logs the reviews that disposal will abandon; completed reviews retain their transcript and token/cost usage.

Slash commands:

| Command              | Effect                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/advisor`           | Toggle the advisor subsystem for this session (session-scoped override; does not change persisted `advisor.enabled`).                 |
| `/advisor on`        | Enable the configured/default advisor runtimes for this session. Session-scoped; not persisted to config.                             |
| `/advisor off`       | Disable the advisor subsystem for this session and stop its runtimes. Session-scoped; not persisted to config.                        |
| `/advisor status`    | Show each advisor's runtime state, model, context usage, token usage, and cost.                                                       |
| `/advisor dump`      | In the TUI, copy the compact transcript (all active advisors when a roster is present) to the clipboard; other hosts return the text. |
| `/advisor dump raw`  | Copy/return the full dump, including system prompt, tools, thinking, and calls.                                                      |
| `/advisor configure` | List every discovered advisor file, then edit the selected file's advisors. Non-TUI command hosts report that the editor is TUI-only. |

Enabling advisors (including a toggle to on) names the runtimes that started; paused and unresolved entries are not announced as running.

If the subsystem is enabled but no legacy/default or roster model resolves, status reports the configured advisors as inactive/`no_model`.

Entries left at `no_model` during startup are retried after background model discovery settles, so a model that arrives late in the catalog can start without a manual toggle.

## What the advisor sees

At each primary update, `AdvisorRuntime` receives only the new transcript delta since its previous update. Deltas are rendered with reasoning, tool intent, watched-role markers, and expanded primary constraint context, so advisors can review assistant reasoning as well as user-visible text, tool calls, and tool results. Provider-bound messages and tool arguments/results are passed through the session secret obfuscator before reaching the advisor model.

Most hidden `custom` messages collapse to a one-line summary in the delta. The primary agent's injected constraint context (`plan-mode-context` and `plan-mode-reference`) is instead rendered verbatim inside an XML-escaped `<primary-context kind="…">` wrapper, while repeated copies are deduplicated. Advisors also receive the primary's discovered project context files (`AGENTS.md` and related standing instructions) in a `<project-context>` system-prompt block and the active memory backend's shared developer instructions. Those instructions do not grant tools; explicit tool lists remain unchanged. If the session cwd is outside Git with exactly one direct child repository, an additional watchdog block tells the advisor which child is the active project.

Advisor messages already injected into the primary transcript are filtered out before the next delta is rendered. This prevents the advisor from recursively reviewing its own advice.

When the primary transcript is rewritten, the advisor runtime is reset:

- compaction
- session switch/resume
- branch/fork style history replacement
- context-maintenance re-prime when the advisor's own context cannot fit

Reset clears the advisor's private in-memory transcript and rewinds its cursor. The next advisor update replays the current bounded primary transcript instead of continuing from stale pre-rewrite context.

When the advisor is enabled mid-session, the cursor seeds to the current primary transcript length. That avoids replaying the whole old conversation on the first enabled turn.

## Tools and isolation

The advisor is a full agent with its own `Agent` instance and a distinct `ToolSession` whose id is suffixed `-advisor`. It does not share the primary agent's file snapshots, seen-lines tracking, conflict state, or summary cache.

Every advisor has the `advise` tool for surfacing notes into the primary transcript. When `tools` is omitted, its investigative grant is:

- `read`
- `grep`
- `glob`
- `recall`, only when the active memory backend constructs it (Hindsight or Mnemopi)

A `WATCHDOG.yml` roster entry may select any subset of built-ins that were actually constructed for the session (a factory that returned `null`, such as unavailable `lsp`, is absent). An explicit empty `tools: []` grants no investigative tools; `advise` remains available. Unknown-only lists are dropped with a warning and currently fall back to the default subset. Grantable names include mutating tools such as `edit`, `write`, `bash`, `eval`, `debug`, `ast_edit`, `task`, and memory tools, plus the read-approved `wait` tool. Enabled browser/computer preludes are reached through `eval`, not granted as tools.

Advisor tools are built against the isolated advisor `ToolSession` and wrapped with `ExtensionToolWrapper`, so `tools.approvalMode`, per-tool approval policies, and `autoApprove` apply just as they do to registry tools. Cursor's server-side exec bridge uses the same approval context and only exposes delete/edit/search capabilities when the corresponding advisor grant exists.

The `advise` tool accepts one note and an optional severity:

| Severity        | Delivery | Intended use |
| --------------- | -------- | ------------ |
| omitted / `nit` | Non-interrupting aside at the next turn boundary once released. An in-progress review defers it until a final boundary. After a terminal answer, it leaves a visible card unless `advisor.continueSeverity` is `nit` and continuation guards permit waking the primary. | Cleanup, simplification, low-risk edge cases. |
| `concern` | An in-progress review defers it until a final boundary. Once released, it uses interrupting steering when permitted; immunity downgrades it to an aside, or a visible card when terminal-idle. After a terminal answer it may request continuation at the default `advisor.continueSeverity: concern`, regardless of review mode. | Material risk, likely wrong direction, missing constraint, hallucinated API. |
| `blocker` | Immediately eligible for interrupting steering, including during partial work and the immunity window. A terminal answer alone does not prevent continuation; stop, mode, and client guards still apply. Interruptible tools may be cancelled; non-interruptible tools retain their execution guarantees. | Continuing would clearly waste work or produce broken output. |

Accepted notes are rendered into the primary transcript as XML-escaped `<advisory>` elements. Named roster advisors add an `advisor` attribute:

```text
<advisory advisor="Architecture" severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

When you deliberately interrupt the agent (Esc, or a cancel from collab, ACP, RPC, the SDK, or an extension), the advisor stops auto-resuming it. A `concern`/`blocker` raised while the run is stopped is recorded as a visible advisor card instead of restarting the turn, and a concern already in flight when you interrupt is preserved the same way rather than driving a surprise resume. The advice re-enters context the next time you resume — a new message, the `.`/`c` continue shortcut, or a steer/follow-up.

A normal yield the agent drove itself is treated differently from a deliberate interrupt. The loop state and completed turn determine the delivery path:

- **While the loop is still streaming**, blockers can steer immediately. Nits and concerns from an in-progress review remain deferred until a final boundary; they are not released merely because the current tool batch finished.
- **Once the loop has yielded and gone idle**, delivery keys on how the turn ended:
  - If the primary's tail is a **terminal text answer with no queued work**, a note at or above `advisor.continueSeverity` (default `concern`) may request one continuation. A note below the threshold remains a visible card and reaches the primary with your next message. Both `turn` and `agent-end` reviewers follow this rule; neither has an exclusive continuation exception.
  - Otherwise (the agent yielded mid-work, no terminal answer), a released `concern`/`blocker` normally triggers a fresh turn. A nit uses the non-interrupting aside queue.

The threshold does not bypass stop/abort suppression, immunity, plan mode, or client constraints. If they block terminal continuation, the note is preserved as a card rather than stranded in an aside queue the idle primary would never consume.

Session/client constraints can preserve a note whose normal delivery path is steering:

- **Plan mode:** every would-be advisor steer is preserved as a visible card, even while the primary loop is streaming, because only user-driven turns converge on ask/resolve.
- **ACP with deferred agent-initiated turns:** when `deferAgentInitiatedTurns` is enabled and the bridge has not allowed agent-initiated turns, an idle would-be steer is preserved because the client cannot represent the triggered turn as busy. Advice raised while the primary loop is already streaming can still steer into that live turn.

The three delivery channels are **aside** (non-interrupting boundary delivery), **steer** (interrupting delivery or an allowed continuation), and **preserve** (a visible card without waking the primary). Once released, a concern outside immunity can cancel interruptible tools through steering; it no longer has a special wait-for-the-tool-batch override.

`advisor.immuneTurns` limits repeated non-blocker steering independently of review cadence. After successful concern/blocker steering, later concerns use asides until the configured number of primary turns has completed; at terminal idle, eligible non-blocker continuations are preserved instead. The default is `3`, and tool-loop continuations count even for an `agent-end` reviewer. Blockers bypass immunity but still obey deliberate-stop, mode, and client preservation constraints. Ordinary nits remain non-interrupting; even with `continueSeverity: nit`, immunity can prevent a nit from waking a terminal-idle primary.

While an advisor update reviews work still in progress, `AdviseTool` defers **both nits and concerns** until a final boundary; only a blocker may interrupt partial work. Deferred notes pass the emission guard before reservation. A higher-severity note may displace a pending lower-severity note from the same review, but cannot displace notes from earlier reviews or retract routed advice. The completed-update transition or an explicit final-boundary flush releases pending notes even when cadence skips a new review, without resetting the current review's budget. No separate full-run nit-release gate remains.

### Emission guard

Each advisor has its own `AdvisorEmissionGuard` (`src/advisor/emission-guard.ts`) on the route from `AdviseTool` to the YieldQueue/steer channel. It enforces the system prompt's per-update non-blocker advice budget and no-repeat rules:

1. **Normalization.** Lowercase, NFKC, collapse every run of non-alphanumeric characters to one space, then trim. `"Stop."`, `"*Stop*"`, and `"  stop  "` all key to `stop`.
2. **Content-free phrase filter.** Short phrases with no concrete reason — `stop`, `done`, `complete`, `no issue continue`, `lgtm`, `nothing to add`, and similar — are suppressed.
3. **Severity-aware dedupe.** A repeated normalized note is dropped at equal or lower severity. A higher-severity re-raise (`nit` → `concern` → `blocker`) remains eligible even after the earlier note was delivered. The prompt is stricter: it permits re-raising prior non-blocker advice only as a `blocker`, once new transcript evidence meets `blocker` criteria. The FIFO history holds at most 4096 entries.
4. **Per-update rank budget.** Up to N non-blocker notes per advisor model `prompt()` cycle (default 4, configurable from 1–32). At capacity, a higher-severity note may replace the lowest-rank still-pending note from the same update. Routed notes retain their slots; earlier updates' pending notes remain reserved. Blockers are exempt, and suppressed noise consumes no budget. Precedence: per-advisor config > shared `WATCHDOG.yml` top-level > `advisor.maxNotesPerUpdate` setting > default 4. There is no additional aggregate backlog budget.

Acknowledgments distinguish acceptance, conditional deferral, duplicates, noise, and budget suppression. Acceptance means the host accepted the note for primary delivery, not that the primary model consumed it. Deferred acceptance warns that a higher-severity finding from the same review may displace the note. A rejected note receives no delivery promise; the advisor should not rephrase rejected findings to evade the guard.

The guard's full state — dedupe history and per-update gate — clears on every advisor reset (compaction, session switch, `/new`). That reset does not permit replaying old advice indiscriminately: the advisor prompt allows a prior non-blocker finding to be raised again only as a blocker when **new transcript evidence** now meets blocker criteria, not merely because the primary ignored it or a reminder arrived.

## Catch-up with `advisor.syncBacklog`

Catch-up policy controls how long the primary waits for each scheduled advisor, not how often that advisor reviews. Each `WATCHDOG.yml` entry may set `syncBacklog`; omission inherits the current global `advisor.syncBacklog` setting.

Allowed values:

- `off` — never wait for advisor catch-up (default)
- `1`
- `3`
- `5`
- `strict` — wait until scheduled advisor reviews finish; no wall-clock timeout, but aborts and advisor failures still release the primary

On primary turn end:

1. every advisor captures the primary delta; an advisor whose review is scheduled queues it together with any updates its cadence held since its last review
2. the advisor drain loop starts or continues in the background
3. each scheduled advisor resolves its own override or the global policy; unless it is `off`, the primary waits while that advisor's backlog is at or above its threshold
4. bounded values cap the wait at 30 seconds; `strict` waits without a wall-clock cap
5. if the advisor catches up below the threshold, the primary continues immediately
6. abort, failure, quota pause, session-transition pause, or disposal releases waiters; paused transitions also reject new waits

Practical interpretation:

- `off` favors maximum primary throughput.
- `1` is the closest mode to synchronous review: after each queued advisor delta, the primary waits up to 30 seconds for backlog to return to zero.
- `3` and `5` allow more advisor lag before the primary pauses.

`strict` with an `agent-end` advisor provides synchronous final review: the primary reaches its final boundary, the advisor reviews the accumulated run, then the primary can finish. Notes released at that boundary are buffered through terminal unwind and merged into one message, ordered newest turn first, then severity (`blocker` → `concern` → `nit`). Notes about earlier turns carry a `turns_ago` attribute and a dim `T-N` transcript marker between severity and advisor name. The first merged delivery, then at most once every 50 primary turns, includes guidance that findings may be outdated or wrong and may be ignored; reminder state is tracked per advisor.

A batch containing a note at or above `advisor.continueSeverity` can request **at most one permitted continuation**, even when several advisors report findings together. The continuation latch covers terminal-unwind races as well as live delivery. Stop/abort suppression, non-blocker immunity, plan-mode policy, and client preservation constraints are rechecked for buffered and live notes; they cannot be bypassed by a note admitted before a stop. Otherwise the notes remain visible without restarting the primary. A continuation an advisor delivery starts does not schedule another review or advance cadence; its updates are captured and sent with the next review, without feeding advisor notes back into them.

Keep turn reviews asynchronous while waiting for final reviews:

```yaml
advisors:
   - name: Turn reviewer
     reviewMode: turn
     syncBacklog: off
   - name: Final reviewer
     reviewMode: agent-end
     syncBacklog: strict
```

Advisor failures do not permanently stall the primary. The host first attempts its credential/fallback recovery. Retriable failures are attempted up to three times before that backlog is dropped; three dropped-backlog cycles halt the runtime until an explicit reset, and a permanent request rejection can halt it after one cycle. Context-maintenance re-primes do not erase these strikes. A quota/usage-limit failure that cannot recover through credential rotation, model fallback, or a bounded cooldown wait pauses the advisor with its batch retained until its runtime is reset or rebuilt: compaction, dropping images, a shake, a session switch or new session, an `/advisor` rebuild, a configuration reload, or a restart. Provider-stated Codex 429 waits use the bounded provider-wait recovery path rather than immediately discarding the review. Tool-output pruning keeps the pause, and no timer resumes it. The primary's catch-up waiters (`advisor.syncBacklog`) are released as soon as an advisor is failing; only the headless shutdown drain waits through recovery.

The advisor also uses `model.toolCallLoopGuard.*` to bound repeated identical tool calls. One detected loop injects a corrective; if the same bound trips again during that review, the review is aborted without treating the stop as a provider failure or starting fallback recovery. The detector resets at the next review/context boundary.

Unsafe Advisor output follows a separate quarantine path rather than that
three-attempt request-retry policy. Calls to tools not granted to the advisor receive `Tool <name> not found`
results so the model can correct itself; they do not quarantine a turn.
Before tool dispatch, the runtime quarantines generated text/advice when an output-only destructive-shell
directive is detected, or when at least three output-only hazard classes match
among destructive shell, instruction override, denial instruction, and
account-deletion claim. A new instruction override paired with a destructive
command quoted in the input also qualifies. The entire Advisor turn, including
any advice in it, is discarded before dispatch.

The first consecutive quarantine silently resets and re-primes the Advisor with
the latest pending context. A second consecutive quarantine emits one
deduplicated host warning, drops the affected batch, and resets the Advisor
context to break the loop. Any successful Advisor turn resets the quarantine
counter.

## WATCHDOG.md

`WATCHDOG.md` is advisor-only guidance. It is appended to the advisor system prompt; it is not injected into the primary agent's normal context and does not behave like `AGENTS.md`, `RULES.md`, or other context files.

Use it for review priorities: risks the advisor should watch for, project-specific traps, dangerous APIs, architectural boundaries, and quality bars that are useful to a reviewer but too noisy for the main executor.

Example:

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI renderer paths that display unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

### Discovery locations

`discoverWatchdogFiles(cwd, agentDir)` loads every readable candidate from these locations:

1. user level: `<active agent dir>/WATCHDOG.md` (`~/.omp/agent/WATCHDOG.md` by default; relocated by `PI_CODING_AGENT_DIR`)
2. project levels while walking from `cwd` upward to the git repository root, or to the home directory when no repo root is found:
   - `<dir>/WATCHDOG.md`
   - `<dir>/.omp/WATCHDOG.md`

Unlike native context files, watchdog discovery does not stop at the nearest project file. Multiple project watchdog files can load together.

Candidates in hidden owner directories are ignored unless the file is inside an `.omp` directory. This keeps unrelated dot-directory conventions from being picked up accidentally while still allowing `.omp/WATCHDOG.md`.

### `@` imports

`WATCHDOG.md` content is expanded with the same `@` import helper used by context files:

- relative imports resolve from the importing file's directory
- `~/` resolves from the user's home directory
- imports inside fenced code blocks and inline code spans stay literal
- recursive imports are expanded up to five hops; cycles and repeated paths are skipped without removing the literal token
- missing or unreadable imports leave the original `@path` text in place

### Prompt order

Loaded watchdog blocks are sorted as:

1. user-level `WATCHDOG.md`
2. project-level files from farther ancestors down toward `cwd`

Each file is appended to the advisor system prompt as:

```xml
Especially pay attention to:
<attention>
...expanded watchdog content...
</attention>
```

Later project files sit closer to the end of the advisor prompt, so narrower directory guidance is more prominent than broad ancestor guidance.

## WATCHDOG.yml

`WATCHDOG.yml` (or `WATCHDOG.yaml`) is the advisor roster. Each named entry can set its own enabled state, model, tools, and specialization prompt; `WATCHDOG.md` supplies shared review guidance.

Discovery and `/advisor configure` use the same per-entry validation: malformed entries are skipped with named warnings while healthy advisors remain usable. Invalid YAML or a non-mapping document is skipped with a file warning. Problems appear in an aggregated startup warning and remain visible in the selected file's editor. Saving the editor document writes only valid entries.

The editor opens with every discovered user, ancestor, `.omp`, and launch-directory file in load order. Each row shows its exact path. Hover or select a row to preview that file's advisor names and enabled states; Enter opens its per-advisor editor. Esc from that editor returns to the file list. When no files exist, the list offers the repository-root file, or cwd outside a repository, so a roster can still be created.

Space toggles the whole highlighted file, persisting top-level `enabled: false` without changing its entries. Disabled files remain editable and contribute neither advisors nor shared instructions or budgets. Turning all discovered files off does not create a replacement default advisor. Press `a` to apply the saved configuration; the existing file watcher can also pick it up. Re-enabling a file restores its entries with their own enabled states intact.

Below the file list, bulk actions disable all files and entries, enable all files and entries, or invert effective enabled states. Inverting a disabled file enables its entries, since none were active. Bulk actions save each source file, and `a` applies the result. Advisor activation sets still decide which eligible advisors run for the primary role.

On an advisor row or its detail page, `c` clones every field into a new entry in the same file and opens the copy for editing. The name starts as `<name> (copy)` with a number added if needed. `Delete` opens a confirmation naming the advisor and its source file. Cancel is selected first; `Esc` cancels, and Space never confirms deletion. Deletion is not a menu row. These edits still require Save to persist and Apply to update the live advisors.

Example:

```yaml
instructions: |
   Everyone: prefer diffs that keep tests unified.

advisors:
  - name: Architecture
    enabled: true
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, grep, glob]
    includeThinking: false
    instructions: |
      Watch cross-module coupling and public-API growth.

   - name: Fixer
     enabled: false
     model: anthropic/claude-sonnet-4-5:high
     tools: [read, grep, glob, edit, bash]
     instructions: |
        You may edit and run tests to prove a fix locally, then advise.
```

For a final-yield reviewer that runs every third completed primary turn:

```yaml
advisors:
   - name: Final reviewer
     reviewMode: agent-end
     reviewInterval: 3
     instructions: |
        Review the complete turn. Stay silent unless concrete evidence shows a material problem.
```

Fields:

- `enabled` (top level): optional whole-file switch, default `true`. `false` excludes the file's advisors, shared instructions, and budget while preserving its editable entries.
- `instructions` (top level): shared prompt prepended to every advisor's system prompt alongside `WATCHDOG.md`. Concatenated across all discovered `WATCHDOG.yml` files.
- `advisors[].id`: hidden persistent identity assigned at creation or a legacy entry's first save. Distinct IDs keep identical configurations separate; renames preserve references.
- `advisors[].name`: human label, slugified for transcript filenames. Entries without persisted IDs retain legacy slug precedence until their first save.
- `advisors[].enabled`: optional per-advisor switch, default `true`. Without a role activation set, `false` leaves the advisor paused. An explicit set replaces this flag.
- `advisors[].includeThinking`: optional per-advisor **Read primary reasoning stream** switch, default `true`. When enabled, readable primary thinking appears in escaped `<primary-thinking>` blocks in advisor updates; `false` omits thinking while retaining assistant text and tool activity. Redacted or unavailable reasoning is never forwarded. Human hide-thinking controls do not affect this setting.
- `advisors[].model`: optional model selector with optional `:level` thinking suffix (e.g. `x-ai/grok-code-fast:high`). Omitted → the advisor uses `modelRoles.advisor`.
- `advisors[].tools`: optional list of built-in tool names to grant. Omitted → `read`/`grep`/`glob`, plus `recall` when the active memory backend provides it; explicit `[]` → no investigative tools. Any name in [`BUILTIN_TOOL_NAMES`](../packages/coding-agent/src/tools/builtin-names.ts) is accepted, including mutating tools. Legacy aliases (`search`→`grep`, `find`→`glob`) are normalized. Unknown names are dropped with a warning; if that leaves a nonempty input with no valid names, the implementation currently treats the result as omitted and uses the default subset.
- `advisors[].reviewMode`: optional cadence mode. `turn` (default) reviews every primary turn — every tool-call round, including `willContinue: true` tool-loop continuations; `agent-end` reviews only final yields where `willContinue` is not true, i.e. once per run.
- `advisors[].reviewInterval`: optional positive safe integer (at most `9007199254740991`), default `1`. Reviews every Nth eligible update; skipped updates accumulate and are sent in the next scheduled review. For a review every Nth completed run, combine `reviewMode: agent-end` with this field. Deferred advice still becomes eligible for delivery at final boundaries even when cadence skips that review.
- `advisors[].syncBacklog`: optional `off`, `1`, `3`, `5`, or `strict`. Numeric thresholds may be unquoted YAML numbers. Omitted → inherit the current global `advisor.syncBacklog`; explicit `off` always disables waiting for this advisor. The editor shows the effective policy and offers `inherit` to remove an override.
- `advisors[].scope`: optional `main`, `subagent`, or `all` (default `all`). Restricts which session kinds build this advisor: `main` attaches only to the top-level session, while `subagent` attaches only to advised spawned subagent sessions.
- `maxNotesPerUpdate` (top level or per advisor): accepted non-blocker notes per prompt update, default `4`. A per-advisor value overrides the top-level value, which overrides the `advisor.maxNotesPerUpdate` setting.
- `advisors[].instructions`: this advisor's specialization, appended after the shared baseline. Both instruction fields expand `@path` imports like `WATCHDOG.md`.
- `advisors[].systemPrompt`: optional literal base prompt that replaces the bundled advisor system prompt. Project context, memory instructions, `WATCHDOG.md`, shared instructions, and per-advisor instructions still append in their normal order. Omitted uses the bundled default; an explicit empty string is an empty base, not a reset. Unlike the instruction fields, this field does not expand `@path` imports.

In `/advisor configure`, open an advisor to toggle **Read primary reasoning stream** next to **Enabled**. For the implicit default advisor, turning this off saves a roster entry; untouched defaults are not written. Changes apply to the live advisor on **Save & apply**, without `/new`.

Select **System prompt** below **Instructions** to edit the base prompt. Enter opens the shared multiline editor, prefilled with the current override or the bundled default. Ctrl+G opens your external editor; Ctrl+Q / Ctrl+Enter accepts the text, and Esc cancels without changing the override. Backspace while **System prompt** is highlighted in the list clears the override; Backspace inside the editor only edits text. **Save & apply** persists the change and rebuilds the live advisors. Clearing removes `systemPrompt` from the saved YAML.

Saves stage and sync the complete `WATCHDOG.yml` beside its destination,
then publish it under the existing file lock. Readers see either the previous
complete YAML or the new one, never a truncated write. Existing symlinks to
a shared roster keep pointing at that roster after a save.

The editor updates the existing YAML document while preserving comments and fields outside the edited advisor configuration; it does not replace the roster with a freshly serialized subset.

The **Read primary reasoning stream** checkbox sits beside **Enabled** in each advisor's detail screen. Save & apply writes an explicit `false` to `WATCHDOG.yml` and rebuilds that advisor; turning it back on restores readable primary reasoning for future updates.

A continuation an advisor delivery itself starts — a steer while the primary is idle or past its final boundary — neither schedules reviews nor advances interval counters through its own final boundary, so advisor deliveries cannot re-wake reviewers into an advisor→primary→advisor cascade. Its updates are still captured and reach the next scheduled review. Continuations started by anything else (todo reminders, async job wakes, live delegations, user input) are reviewed under the normal cadence, so an `agent-end` reviewer also reviews the run a todo reminder resumes. Delivery itself never pauses: advice already produced still steers, flushes, or rides asides to the primary.

### Discovery locations

`WATCHDOG.yml`/`WATCHDOG.yaml` share the same user and project search path as `WATCHDOG.md`: the user-level `<active agent dir>/WATCHDOG.yml` plus every `WATCHDOG.yml`/`.omp/WATCHDOG.yml` encountered while walking from `cwd` up to the repository root, or the home directory when no repo root is found. All discovered files load together. A more-specific file replaces an earlier entry with the same persisted ID, or the same name slug for legacy entries without IDs.

For compatibility, a `$HOME/WATCHDOG.yml` or `$HOME/.omp/WATCHDOG.yml` found by the ancestor walk remains **project scope**, not user scope. It applies to non-repository sessions beneath `$HOME`; inside a repository the walk stops at its root and does not reach `$HOME` unless that is the root itself. User scope specifically means the active agent directory. This display distinction does not change which rosters load.

The main session watches these roster locations, including files created later in an existing or new `.omp` directory. Creating, editing, removing, or atomically replacing a file rediscovers the merged roster after a short debounce. Unchanged advisors keep their context; new or changed advisors start from the current transcript, and removed or disabled advisors stop. If the advisor subsystem is off, only its stored roster changes; the edit does not enable it. An unreadable file or malformed YAML leaves the previous live roster running, with a logged warning, until a subsequent valid edit.

At the same directory depth, `.yml` candidates precede `.yaml` candidates, and `.omp/<filename>` precedes the standalone `<filename>`. Later entries win identity collisions; top-level instructions still concatenate.
## Subagents

Subagents run unadvised by default; advisors are opted in **per agent** instead of via a blanket toggle:

- Agent definition frontmatter `advisor`: `true` advises spawned sessions of that agent with the model resolved for the `advisor` role; a string (e.g. `advisor: "deepseek/deepseek-v4-flash"` or `advisor: "@smol:high"`) sets an explicit advisor model pattern with an optional `:level` thinking suffix.
- The `task.agentAdvisor` settings record (agent name → `"on"` / `"off"` / model pattern) overrides the frontmatter, and is configured per agent from the `/agents` hub: Enter on an agent opens its property strip; the advisor strip offers on/off, a model-browser pick, or a raw pattern.

The legacy `advisor.subagents: true` setting migrates to `task.agentAdvisor: { task: "on" }` — the bundled generic `task` agent keeps its advisor, other agents start unadvised.

An advised subagent session builds its own advisor subsystem with the same settings/model-role resolution (an explicit pattern lands on the spawned session's `modelRoles.advisor`), then reruns both `WATCHDOG.md` and `WATCHDOG.yml` discovery for that subagent session's `cwd` and agent directory. Subagent advisors remain isolated from the subagent's primary tool session in the same way the main advisor is isolated from the main agent.

## Cost and context behavior

Advisor usage is separate model usage. `/advisor status` computes token/context counts from the advisor's live transcript, while cost comes from a cumulative per-session ledger that survives advisor resets and is restored from persisted advisor transcripts on resume. Token counts can therefore reset or shrink independently of accumulated spend.

`advisor.evictStaleResults` defaults to `true`. Before each review, investigative `read`/`grep`/`glob` results from older reviews are replaced with short placeholders; the latest review's results remain. Set it to `false` to retain those older tool results in the advisor's live context.

On prefix-bound thinking models, that eviction also drops signed reasoning after the pruning boundary, including reasoning in the latest review. Primary deltas and advice notes are not evicted.

The advisor has its own append-only context. Before each advisor prompt, `AgentSession` estimates incoming tokens and may maintain advisor context:

1. try model-level context promotion when enabled and a larger compatible model is available
2. if promotion cannot fit enough context, compact the advisor's own message history
3. for readable history, re-prime from the current bounded primary transcript if compaction has no candidates or still cannot fit

Native compaction replaces advisor history only when the active model can replay its provider and Responses API format. A foreign native-enabled summarizer uses portable text summarization for readable history instead. Once the advisor holds native history, incompatible summarizers, retry fallbacks, cooldown restorations, and context promotions are skipped. Maintenance failure preserves that history rather than re-priming it away; normal advisor request-failure handling still applies.

Replay compatibility does not require new native compaction to be enabled. Same-provider Responses models can receive existing native history during fallback, cooldown restoration, or promotion even when their own compaction endpoint is disabled. Creating a new native result still requires `remote` in `compaction.methodOrder` and an eligible writer; a separate compatible writer can maintain a reader whose native endpoint is disabled.

The advisor's live context is in-memory and append-only; it is retained while the session runs so `/advisor dump` can inspect it, and is independently promoted/compacted/re-primed (above). It is not a replacement for the primary persisted transcript.

## Transcript persistence and observability

The advisor is a passive reviewer with its own model usage, so — like a task subagent — every finalized advisor turn is appended to JSONL inside the owning session's artifacts directory:

- legacy/default advisor: `<session>/__advisor.jsonl`
- named advisor: `<session>/__advisor.<slug>.jsonl`
- subagent advisor (frontmatter `advisor` / `task.agentAdvisor`): `<session>/<SubId>/__advisor[.<slug>].jsonl`

Paths derive from the owning session file (not the shared artifacts root), so each primary/subagent advisor writes a distinct file. The reserved `__advisor` stem cannot collide with a task subagent id.

Why a file:

- **Usage attribution.** `omp stats` scans each session folder recursively, so advisor assistant turns (with their usage/cost) are attributed to the same project/session like any other subagent. Advisor "session update" prompts are persisted as `synthetic`, agent-attributed user messages so they never inflate user-message metrics.
- **Observability.** [Agent Hub](./agent-hub.md) discovers legacy and named `__advisor*.jsonl` files on open and shows each as a read-only `advisor`-kind transcript under its owning session.

The file follows session switches: on `/new`, resume/switch, and branch the recorder reopens at the new session's path on the next advisor turn; before a `/delete` deletes the old artifacts dir the recorder feed is detached and drained so a queued write cannot recreate the deleted file. The on-disk log is append-only and independent of the in-memory context — re-primes and compaction never truncate it.

The advisor is never a peer. The `advisor`-kind registry ref is excluded from agent-facing peer rosters and `agent://all` broadcasts, the subagent peer prompt, and the `history://` index/lookup/completions — and cannot be messaged through `write agent://<id>` or collab chat, nor [revived or killed from Agent Hub](./agent-hub.md#persisted-agents-and-advisors) or collab. It is not addressable as a peer, regardless of what tools it has been granted.

# Prewalk

Prewalk is a one-shot handoff from a planning model to an execution model after planning reaches implementation. The planner can inspect the repository, create a todo list, and begin the change before the execution model continues the same session.

Prewalk is off by default. With no crew settings, it plans on the active model and executes on the `@smol` role. Plan mode remains a separate read-only overlay.

## Enable prewalk

Enable prewalk persistently in the global config:

```bash
omp config set prewalk.enabled true
```

The equivalent YAML in `~/.omp/agent/config.yml` or a project `.omp/config.yml` is:

```yaml
prewalk:
   enabled: true
```

## Configure the crews

Settings > Model > Prewalk exposes the enable switch, both selectors, and ordered fallback lists. The same keys work in the active profile's `config.yml`, project `.omp/config.yml`, a `--config` overlay, or session settings through `cfg://`. Project and session values do not require changes to global model roles.

```yaml
prewalk:
  enabled: true
  planner: "@slow:high"
  plannerFallbacks: ["anthropic/claude-sonnet-4-6:high"]
  execution: "@smol:low"
  executionFallbacks: ["openai/gpt-5-mini:low"]
```

Selectors accept role aliases and `provider/model[:effort]`. An empty planner keeps the active model, except `/prewalk restart` returns to `@default`. Each phase tries its primary selector's role chain, then its ordered fallback selectors, skipping disabled or unauthenticated models. Unqualified selectors prefer the session's scoped models; explicit `provider/model` selectors retain normal model-resolver precedence. These are selection fallbacks, not request-retry chains. If either configured crew is unavailable, startup warns and leaves prewalk unarmed without changing the normal starting model.

Before the first request, the CLI shows `Prewalk crew: plan provider/model:effort → execute provider/model:effort`. Extension-backed planners resolve after provider registration, like execution targets. `--prewalk-into` replaces the execution primary selector for that startup session; execution fallbacks still apply.

## Session overrides

The configured setting arms new sessions, not resumed/imported sessions. Explicit session flags can arm either:

| Flag | Effect |
| --- | --- |
| `--prewalk` | Arm prewalk for the new session. |
| `--no-prewalk` | Leave prewalk disabled for the startup session, even when `prewalk.enabled` is `true`, and suppress auto-prewalk for that startup session. `/new` still follows `prewalk.enabled`. |
| `--prewalk-into <model-or-role>` | Arm prewalk and override `prewalk.execution` for the startup session. |

For example:

```bash
omp --prewalk
omp --prewalk-into @smol
omp --prewalk-into openai/gpt-5-mini
```

At startup, NeoPi resolves both crews with the normal model-role and model-matching rules. If no usable crew remains, it prints a warning and starts with prewalk unarmed.

`--no-prewalk` cannot be combined with `--prewalk` or `--prewalk-into`. An explicit `--prewalk-into @default` resolves against the default role from before `--model` overrides it. A configured `prewalk.execution: "@default"` instead follows the current session role after `--model`, as it does on `/new`. A configured planning crew retains its own role assignment rather than being rewritten by `--model`.

`/new` starts a fresh cycle using `prewalk.enabled` and the current crew settings, rather than inheriting a consumed handoff or the previous todo gate. Startup flags apply only to the startup session. A configured planner takes precedence; an empty planner restores the previous planning model and thinking level after a handoff unless a later selection replaced them. If restoration fails, `/new` warns and stays on the current model. Resuming an existing session does not automatically re-arm prewalk.

Any model or thinking-level change made after the handoff counts as a replacement, including the switches plan mode makes on entry and exit. Automatic retry fallback, fallback restoration, and context promotion do not; if the session is back on the handoff model and thinking level when you run `/new`, it still restores the planning model.

## Handoff trigger

An armed prewalk injects a planning nudge. When the `todo` tool is active, any successful `todo` call—including the read-only `view` operation—opens the handoff gate. Without an active `todo` tool, the gate is already open.

OMP switches at the completed assistant-turn boundary containing the first eligible `edit` or `write` result, after persisting that turn's assistant message and tool results. Unlike the todo gate, the edit/write trigger does not require a successful result.

Calls to other tools do not trigger the handoff. A read-only `xd://` device request routed through `write`, such as LSP navigation, also does not count; only device operations classified as workspace writes or execution count.

The switch is one-shot: after the handoff, prewalk disarms itself, removes the planning nudge, and steers the execution model with the written planning text, successful todo output, and implementation checklist. It also records a versioned `prewalk-handoff` session object containing the brief, planner, execution model, efforts, and timestamp. The delivered brief remains in rebuilt session context. Hidden reasoning is never copied into the brief. Model-role assignments do not change. A same-model handoff can still change thinking; when both model and thinking configuration already match, prewalk disarms without switching.

The handoff is recorded in the session, so resuming it, restoring it with `--restore`, or reviving a parked subagent continues on the handoff model and thinking level instead of returning to the planning model. A retry fallback taken after the handoff supersedes it, as for any session-local model. A revived subagent does not arm its prewalk again while it is still on that target.

## Arm from an active session

In a top-level session, turning `prewalk.enabled` on selects the configured planner and arms the execution handoff; turning it off cancels a pending handoff without changing the active model. Editing a crew selector while enabled starts a fresh configured arm. These settings do not enable subagent prewalk by themselves.

Run these slash commands without restarting OMP:

```text
/prewalk [into]
/prewalk restart [from] [into]
/prewalk off
```

`/prewalk` arms the configured execution crew, selecting the configured planner when present. With empty planning settings it keeps the active model.

`/prewalk off` cancels a pending handoff and clears its planning steering without changing the active model, saved configuration, or already-delivered continuation history. It is safe to run when already off or after a handoff; it does not switch back to the planning model. Cancellation applies only to the current session: `/new` re-arms prewalk when the configured setting is enabled. It also keeps [auto-prewalk](#auto-prewalk) from arming again until `/new`.

`/prewalk restart` selects the configured planner and re-arms the execution crew. When no planner is configured, it retains the existing `@default` restart behavior. Both crews resolve when the command runs without altering role assignments.

An existing matching arm is preserved. If restart would replace a different armed target, it is rejected before changing the active model. `/prewalk off` followed by `/prewalk` selects a fresh crew.

## Auto-prewalk

`prewalk.enabled` and `/prewalk` unconditionally arm a one-shot handoff. Auto-prewalk asks NeoPi's native judge, per task, whether prewalk is worthwhile, and arms the same handoff from the active model when it is. It is a prewalk-suitability check, not a difficulty rating or a general model router: it never picks a different planning model.

```yaml
prewalk:
   enabled: false
   auto: on
   autoTarget: "@smol"
```

`prewalk.autoTarget` (default `@smol`) takes a model pattern or role, resolved with the normal role and model-matching rules, including authentication.

| `prewalk.auto`  | Behavior                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | No classification; nothing changes.                                                                                                                                                                  |
| `suggest`       | Classifies each new task and reports the decision only. Never arms prewalk or switches models.                                                                                                       |
| `on`            | Classifies each new task. When the judge is confident the task fits and the target resolves with a usable credential, arms a handoff from the active model to the target; otherwise nothing changes. |

Run `suggest` for a while to see how it judges your prompts, then set `auto: on`. To plan on a stronger model, make it your active (`@default`) model; auto-prewalk hands off from whatever you are on.

`prewalk.enabled` keeps its meaning: unconditional prewalk, independent of `prewalk.auto`.

### Requirements

Auto-prewalk needs the `judge` model role to resolve first to a native judgment backend, the same condition as `find.enabled: auto`. It uses the existing judge-role provider support, including TypeSafe `jev`, OpenRouter, OpenAI Decisions, and Workers AI Clef. It relies on calibrated probabilities and never executes a prompted on-device or chat judge, even if the judge-role cache predates a login or discovery change. Without a native judge nothing is classified, and nothing is reported.

### What it decides

The judge sorts each task by where its expensive reasoning belongs, not by how hard or large it is:

| Route     | Meaning                                                                                                                    | Typical tasks                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prewalk` | The hard thinking comes first; once it settles the approach, the remaining implementation and verification are bounded.    | Tracing an unfamiliar subsystem before a localized change; reading several interacting files before implementing a clear design; diagnosing a bug down to a concrete fix; a migration whose hard part is finding the transformation and everything it touches. |
| `primary` | Strong reasoning stays necessary while implementing, debugging, or validating, so the first edit is too early to hand off. | Unresolved races or invariants; subtle lifecycle changes; a bug whose cause will still be unclear after a first look; high-risk or algorithmically hard changes.                                                                                               |
| `direct`  | There is no up-front phase worth handing off from.                                                                         | Explanations and read-only questions; trivial, mechanical, or fully specified edits; tiny localized fixes.                                                                                                                                                     |

Volume of work alone and difficulty alone never make a task a prewalk candidate, and a wrong handoff costs more than a missed one: between `prewalk` and `primary` the judge is told to choose `primary`, and for a small task to choose `direct`. NeoPi arms only when `prewalk` wins **and** its probability is at least 0.70. That threshold is fixed, and a `prewalk` winner below it counts as a "no".

`suggest` reports one line per judged task:

```text
Auto-prewalk: prewalk 0.84
Auto-prewalk: primary (prewalk 0.18)
Auto-prewalk: direct (prewalk 0.06)
Auto-prewalk: prewalk 0.55 (below threshold)
```

Under `on`, a confident decision shows the usual `Prewalk: armed for …` notice; other decisions are only logged. The plan nudge travels with the task's first request, and the existing handoff does the switching, with its todo gate and first `edit`/`write` trigger unchanged. Like a configured prewalk, an armed task skips the `todo.eager` reminder, since the plan nudge owns todo creation.

### One task at a time

An automatic handoff belongs to the task that armed it. When the next task starts, NeoPi returns to the model and thinking level that task planned on, then judges the new task, so a `primary` task is never left on the handoff target. `/new` does the same. An auto arm that its task never used is dropped at the next task, which is judged on its own.

An explicit model or thinking-level selection after the handoff takes ownership: the session stays where you put it. Handoffs made by `/prewalk`, `--prewalk`, or `prewalk.enabled` are never restored by auto-prewalk.

### What is classified

Only new, user-authored tasks in the top-level session: typed prompts, user-invoked `/skill:` prompts, and queued follow-ups when they are delivered. Steering is never classified, since it amends the task already running. Acknowledgements such as `ok` or `thanks`, synthetic continuation turns, agent-attributed messages, subagents, plan mode, and tasks where prewalk is already armed are skipped.

The judge runs alongside the rest of prompt setup (memory recall, hooks, auto thinking), and its decision is applied just before the request is sent, so it adds latency only when it is the slowest setup step.

A follow-up such as `do that` or `continue` cannot be judged alone, so the judge also sees the previous substantive user request and the agent's last reply, each truncated like other small-model input. The current request stays authoritative: the context only resolves what it points at.

### Manual controls win

A negative, direct, or sub-threshold decision, or a classifier error, leaves the model, thinking level, and prewalk exactly as they were.

A pending prewalk from `/prewalk`, `prewalk.enabled`, or `--prewalk` is never replaced, retargeted, or reclassified. `/prewalk off` and `--no-prewalk` keep auto-prewalk out of the session (for `--no-prewalk`, the startup session) until `/new`, and neither switches models. An explicit `/prewalk` or `/prewalk restart` takes over a pending auto arm, which then behaves like a manual one.

### Failure behavior

Auto-prewalk is an optimization and fails open. A missing native judge, a judge error or malformed answer, the 4-second timeout, an abort, or a prompt superseded while the judge ran all leave the task exactly as it would be without auto-prewalk. Answers with invalid probabilities, an inconsistent winning route, or invalid confidence are rejected. Judge failures are logged rather than shown; an unusable target reports an `Auto-prewalk not armed: target …` warning. Judgments are journaled as model usage under the purpose `auto-prewalk`.

## Subagent prewalk

Task subagents have separate prewalk controls: agent frontmatter, `task.prewalk`, and per-agent `task.agentPrewalk` overrides. See [Task agent discovery](./task-agent-discovery.md) for their precedence and target selection.

Enabled task prewalks use these same planner/execution selectors and fallbacks. An explicit agent prewalk string or per-agent target overrides the execution primary selector. An empty planner preserves normal task model routing. Persistent-seat downgrade-after-no-write behavior is separate and unchanged.

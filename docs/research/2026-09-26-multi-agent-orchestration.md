# Multi-agent orchestration landscape (2026-09-26)

Research gathered while scoping live-mode composer coexistence and a
mixture-of-agents (MoA) provider. Every external claim below cites its source;
lines marked [INFERENCE] are interpretation, not sourced fact.

## Live-mode visualizer: upstream and fork state

- Upstream issue [can1357/oh-my-pi#11726](https://github.com/can1357/oh-my-pi/issues/11726)
  (open, `enhancement`, `tui`, `ux`, `triaged`): `/live` replaces the text
  composer, blocking paste, slash commands, and settings. The triage comment
  confirms the takeover is intentional: `LiveCommandController#mountVisualizer`
  clears `editorContainer`, mounts `LiveVisualizer`, and focuses it;
  `#restoreEditor` reattaches the composer only when `/live` stops. No PR.
- Related open upstream PRs that touch `live-command-controller.ts` and would
  conflict with a rewrite:
  - [#8591](https://github.com/can1357/oh-my-pi/pull/8591): typed
    `live:activity` EventBus channel (phase + mic/speaker RMS, 80 ms cadence).
  - [#10514](https://github.com/can1357/oh-my-pi/pull/10514): opt-in
    thinking-orbs indicators (`tui.voiceOrbs`); vendors an npm-ecosystem dist
    snapshot under `vendor/thinking-orbs` (requires audit before any adoption).
- Fork spec: [PsychedelicShayna/neopi#41](https://github.com/PsychedelicShayna/neopi/issues/41)
  "Reductive live-mode composer redesign" answers #11726's open questions:
  keep the ordinary composer mounted with STT appending into it, delete
  `LiveVisualizer` from the live path, add a status icon, a keybind-cycled
  voice / primary / both input destination, and a ~10 s context mutex that
  queues speak-triggers during composer activity.
- #41 depends on [#39](https://github.com/PsychedelicShayna/neopi/issues/39)
  (assistant `turn.done` purges unclaimed operator utterances; `ready-for-agent`,
  `effort: tiny`). Siblings kept out of scope: #40 (keyword gating) and #38
  (live narration buries the main transcript).

## TypeSafe Jev (System One decision model)

Sources: [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
[docs index](https://docs.typesafe.ai/llms.txt),
[How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md),
[Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents.md),
[jev-1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md),
[Cloudflare model page](https://developers.cloudflare.com/ai/models/typesafe/jev/).

- Contract: a `state` (text or JSON) plus typed questions return typed answers
  with calibrated probabilities. Question types: `choice` (one of N, per-option
  probabilities, confidence), `score` (ordered rubric levels), `noul`
  (probability a statement is true).
- It does not generate text by design. Code owns control flow; Jev answers
  narrow decisions at fixed points ("smart if-statements"). TypeSafe states it
  is not a drop-in coding-agent LLM.
- Questions in one call are evaluated independently and in parallel; most calls
  complete in ~100 ms. Pricing: $0.042 / MTok input, output free. Context
  window: 32k tokens (Cloudflare page).
- Documented patterns relevant to orchestration: intent routing, confidence-gated
  routing, speculative fan-out, composite scoring, SDE cascade (cheap extract →
  Jev verify → escalate), function calling over closed-set arguments, LLM
  guardrails.
- Known weaknesses (jev-1.13): literal reading, no arithmetic/counting/date
  comparison, accuracy loss with irrelevant state, susceptibility to
  adversarial content in state, no structural invariants between questions,
  poor at generation.
- Already integrated in this repo: `packages/ai/src/judgment/typesafe.ts`
  (`TypeSafeJudge`, default `jev-latest`), catalog provider
  `rules/providers/typesafe.kdl` plus OpenRouter route `~typesafe/jev-latest`,
  auth `rules/auth/typesafe.kdl` (`TYPESAFE_API_KEY`), auth-gateway route
  `POST /v1/systemone` and `/alpha/decisions`. Eval `judge()` /
  `judge_batch()` use it when credentialed, else fall back to the smol chat
  model. The `jevify` keyword rule steers bulk classification through `judge()`.

## Ralph (Ralph Wiggum technique)

Source: [Geoffrey Huntley, "Ralph Wiggum as a software engineer"](https://ghuntley.com/ralph/)
(2025-07-14).

- A coding agent restarted in an infinite loop with the same prompt:
  `while :; do cat PROMPT.md | claude-code ; done`.
- Fresh context every iteration; state lives on disk (`fix_plan.md`, `specs/`).
  One task per loop. The main context schedules subagents; only one subagent
  runs build/test. Backpressure (types, tests, linters, scanners) rejects bad
  output. The operator tunes the prompt by adding "signs" after failures.
- Explicitly anti multi-agent: Huntley compares agent-to-agent communication to
  non-deterministic microservices. "Fleets" means many independent Ralph loops.
- [INFERENCE] Perceived as superseded because harnesses now provide auto
  compaction, persisted plans/todos, goal loops/stop hooks, native subagents,
  and rules/skills. The spec-on-disk + one-task + backpressure discipline still
  applies. A Reddit thread titles it directly:
  ["Agent Teams completely replaces Ralph loops"](https://www.reddit.com/r/ClaudeAI/comments/1qxy1qk/agent_teams_completely_replaces_ralph_loops/).
- In MoA-graph terms: one node with a self-edge whose transit context is
  "files on disk, no transcript", terminated by a completion check.

## Agent swarms

- General meaning: multiple agents with separate contexts working one larger
  task in parallel, usually lead-orchestrated; most "swarms" are teams, not
  decentralized swarms.
- [OpenAI Swarm](https://github.com/openai/swarm): educational, stateless;
  primitives are `Agent` (instructions + tools) and handoff (a tool returning
  another agent). One active agent at a time: a relay, not parallelism.
  Replaced by the OpenAI Agents SDK.
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
  ("swarm mode", experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`): team
  lead plus teammate sessions with separate contexts, a shared task list with
  dependencies, and a direct inter-agent mailbox. Recommended for parallel
  review, competing hypotheses, and split frontend/backend/test work; not for
  sequential or tightly coupled work.
- NeoPi already has the swarm primitives: `task` subagents (parked, revived by
  message), hub/IRC messaging, ranks/roles, `isolated` worktrees. Missing as
  enforced mechanisms: a shared task board with claiming and dependencies,
  edit-conflict control beyond worktrees, and termination.

## Coordination styles

- Message passing (hub/IRC fleet, Agent Teams mailbox): flexible and fast;
  state lives in agent contexts.
- Blackboard / stigmergy (Hermes Kanban): agents read and write shared durable
  state; a scheduler picks who runs next; auditable and crash-safe.
- Relay / handoff (OpenAI Swarm): one active agent passes control.
- Declared graph (proposed MoA provider): operator-defined edges with explicit
  transit context; Jev decides branches.

## Hermes Agent Kanban

Source: [Hermes Kanban docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban).

- SQLite board shared by named profiles. Task: title, body, one assignee,
  status (`triage | todo | ready | running | blocked | review | done |
  archived`), optional tenant and idempotency key. Parent→child links gate
  readiness.
- A dispatcher loop (default 60 s, runs in the gateway) reclaims stale and
  crashed claims, promotes ready tasks, atomically claims, and spawns the
  assigned profile as its own OS process. Consecutive spawn failures
  auto-block a task.
- Worker tools: `kanban_show`, `kanban_list`, `kanban_create`,
  `kanban_comment`, `kanban_complete`, `kanban_block`, `kanban_unblock`,
  `kanban_request_review`, `kanban_request_changes`, `kanban_link`,
  `kanban_heartbeat`, attachments. Comments are the inter-agent protocol; a
  respawned worker reads the full thread.
- Workspaces: `scratch` (deleted on completion unless declared artifacts),
  `dir:<abs path>`, `worktree`. Multiple boards with hard isolation.
- PR completion contracts gate `complete` on required GitHub checks.
- Their framing: an alternative to "fragile in-process subagent swarms". By
  the general definition it is a peer-coordinated blackboard swarm.

## Weave and "CodeWeave"

- No project named "CodeWeave" matches a model-to-model loop harness. Name
  collisions: [abhij1306/codeweave](https://github.com/abhij1306/codeweave)
  (Rust MCP server), [SynapticSage/CodeWeave](https://github.com/SynapticSage/CodeWeave)
  (repo-to-text CLI), a VS Code search extension, codeweave.co (DevOps
  generator), and [CodeWeaver](https://devpost.com/software/codeweaver)
  (hackathon: coordinator → analyst → engineer → verifier, JSON handoffs).
- Most likely intended: [Weave](https://tryweave.io/docs/)
  ([weave-io/weave](https://github.com/weave-io/weave)), harness-agnostic agent
  configuration via `.weave` files with adapters for OpenCode, Pi (extension,
  Pi ≥ 0.81.1), and Claude Code.
  - Eight roles: Loom (router), Tapestry (plan executor), Pattern (planner),
    Thread (explorer), Spindle (researcher), Shuttle (implementer), Weft
    (reviewer), Warp (security auditor).
  - Per-agent ordered model preferences and tool policy (read / write /
    execute / network / delegate, each allow / ask / deny).
  - [Workflows](https://tryweave.io/docs/workflows/): ordered steps with type
    `autonomous | interactive | gate`, completion methods (`agent_signal`,
    `user_confirm`, `plan_created`, `plan_complete`, `review_verdict`),
    declared `inputs`/`outputs` artifacts validated before advancing,
    `on_reject` policy for gates. Parallel multi-model review variants merge
    into one verdict.
  - Routing is LLM-orchestrated (Loom); workflows are linear. npm-ecosystem
    project: reference only, audit before any install.

## OMP Deck

- Canonical repo: [bjb2/omp-deck](https://github.com/bjb2/omp-deck) (Bryan
  Bartley). [mcbarlowe/omp-deck](https://github.com/mcbarlowe/omp-deck) is a
  stale subset at v0.5.0. [yukimemi/omp-deck](https://github.com/yukimemi/omp-deck)
  is an unrelated collab-session dashboard.
- Activity: last commit and release v0.6.1 on 2026-05-29. Since then only issue
  and PR traffic: open PR #14 "Remote Updates" (2026-08-17, unmerged), open bug
  #15 (2026-09-15, published npm package missing `apps/bridges/*`, breaks the
  Telegram bridge), open issue #11 (session archive/delete).
- Kanban (`apps/server/src/db/tasks.ts`): task = title, body, state, order,
  optional `cwd`, timestamps, archived. Editable columns; done is `s_done`. No
  assignee, dependencies, claims, or dispatcher.
- Agent use: `.omp/agent/commands/pick-task.md` has a session curl
  `GET /api/tasks`, take the top card of the "active" column (or a named card),
  treat the body as instructions and acceptance criteria, and
  `POST /api/tasks/<id>/move` to `s_done`. The operator curates priority by
  ordering; the prompt forbids the agent from rearranging the board.
- Inbox (`apps/server/src/db/inbox.ts`): capture queue with kinds `email`,
  `ticket`, `idea`, `decision`, `investigation`, `capture`, a processed flag,
  and promotion to a task with a provenance footer.
- Routines (`apps/server/src/routines/`): cron/webhook-triggered sequential
  steps with `when:` gating. Step types: `agent` (spawns `omp -p <prompt>`,
  optional `-m`, optional JSON schema; prompt truncated at 30 KB; per-step
  skill/MCP restriction not yet plumbed), `deck` (task/inbox CRUD and moves),
  `http`, `mcp`, `transform`, `wait`, `write`, `set_state`. Per-routine
  concurrency: `skip | queue | cancel-previous | parallel`. Visual canvas
  editor with sequential edges only.
- Not a swarm: no inter-agent messaging, no roles/assignees, one session pulls
  one card. Becomes a blackboard swarm with assignee + claim/lease +
  dependency links + dispatcher.

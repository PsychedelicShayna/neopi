# Mixture of Agents M2: graph control, limits, pause and resume

Implementation plan for milestone M2 of `docs/specs/mixture-of-agents.md`
(§14 "M2: graph control, limits, pause and resume"). Read every section of
this plan before the first command. The plan is written as rules: what it
says happens; what it does not say does not happen.

## 0. How to read this plan

### 0.1 Precedence

1. `docs/specs/mixture-of-agents.md` ("the spec") at the cited section is
   authoritative over this plan.
2. This plan is authoritative over the implementer's judgment.
3. When the spec and this plan disagree, STOP (§0.3) and ask; do not pick.
4. Line numbers in this plan are locators taken at commit `955b7b385f`
   (`origin/neopi` when the plan was written) and are always paired with a
   symbol. The symbol governs. If the symbol exists at a different line,
   proceed. If the symbol does not exist in the file at all, STOP.

### 0.2 Modal verbs

MUST, MUST NOT, SHOULD, MAY carry their RFC 2119 meanings. Nothing else in
this plan is optional.

### 0.3 Stop conditions and how to ask

STOP means: make no further commit, append the question to
`docs/plans/QUESTIONS-moa-m2.md` (create the file on first use), quoting the
step number, the exact evidence (command, output, file, symbol), and the
question, then tell the operator in chat. The implementer cannot reach any
other agent. STOP when any of the following happens:

- the spec and this plan disagree on a behaviour;
- a cited symbol does not exist in the cited file;
- a test this plan says MUST FAIL before a change passes before the change;
- a test this plan says MUST PASS after a change fails after the change and
  two attempts at a fix within the closed world (§2.3) have not made it pass;
- a command this plan lists exits non-zero in a way this plan does not
  predict;
- `polite` exits 75;
- a change would require a file outside the closed world (§2.3);
- `compact` from `@oh-my-pi/snapcompact` throws an error mentioning a
  native addon, a `.node` file, or `dlopen` (Step 5 item 6);
- `docs/specs/mixture-of-agents.md` at the worktree HEAD lacks the line
  starting with `### Amendment 6.10` (Step 0).

### 0.4 Terms

Each term is defined once and used with exactly this meaning everywhere in
this plan.

- **worktree**: `/home/shayna/source/github/PsychedelicShayna/neopi-moa-m2`.
- **branch**: `feat/moa-m2`.
- **spec**: `docs/specs/mixture-of-agents.md` in the worktree.
- **mixture**: one `[[mixtures]]` definition (spec §1.2), addressed as the
  model id `mixture/<name>`.
- **member**: one entry of `definition.members`; a **model member** has
  `kind` absent or `"model"`; a **verdict member** has `kind = "verdict"`.
- **edge**: one entry of `definition.edges`; its id is `mixtureEdgeId(edge)`.
- **run**: one `MixtureRun` (`packages/coding-agent/src/moa/types.ts`,
  `interface MixtureRun`).
- **hop**: one `HopRecord` in `run.hops`. A hop is a member's turn. At M2 a
  hop is one of: an **entry hop** (`edgeInId` undefined), an **edge hop**
  (`edgeInId` is an edge id), a **limit hop** (`edgeInId === "limit"`), or a
  **verdict hop** (the member is a verdict member).
- **decision**: one `MixtureDecision` pushed onto `hop.decisions`.
- **phase**: `run.phase` (`type RunPhase` in `moa/types.ts`).
- **checkpoint**: one `MixtureCheckpoint` written as a `custom` session
  entry with `customType === "mixture_run"` (`MIXTURE_RUN_ENTRY_TYPE`).
- **outer response**: the assistant message the engine finishes on the
  caller's stream for one request (`PendingResponse` in `moa/types.ts`).
- **window**: `run.window` (spec §4.7): counters that reset on resume.
- **lifetime**: `run.lifetime`: counters that never reset.
- **soft limit**: `limits.max_hops`, `limits.budget_usd`,
  `limits.wall_clock_minutes` (each with its `moa.*` default), enforced on
  the window.
- **hard cap**: `moa.hard_max_hops`, `moa.hard_budget_usd`, enforced on the
  lifetime.
- **judge**: the `MixtureJudge` the host returns from `host.judge(...)`
  (Step 3 item 5).
- **transcript**: the canonical run transcript of spec §2.1.
- **fold**: the transcript's hops older than the last two completed hops
  (spec §2.1).
- **coverage cursor**: `run.summaries[edgeId].throughHop` (spec §2.1).
- **card**: one `custom_message` session entry with
  `customType === "mixture_trace"`.
- **restore**: `restoreMixtureRun` (Step 8).
- **fixture**: the `COURTROOM_TOML` document of Step 4 item 7.
- **test command**: the exact `polite -- bun test <file>` line of §2.4 for
  one test file.

## 1. Standing implementer rules

- **Worktree:** work only in the worktree and branch the plan names. Use absolute paths. MUST NOT touch `/home/shayna/source/github/PsychedelicShayna/neopi`, the main checkout, which holds the user's uncommitted work.
- **Heavy commands:** every heavy command (any `bun test`, `bun run check:ts`, a build, or a CLI smoke) MUST run as `/home/shayna/.local/share/polite-relay/polite [--mem] [--label NAME] -- <command>`. Use `--mem` for `bun run check:ts`.
  - If polite exits 75, STOP and tell the operator. MUST NOT run the command without polite.
  - MUST NOT call `sudo`, `sado` or `systemd-run`.
  - MUST NOT run `bun check` (it compiles Rust).
  - Run test files one at a time, with `GIT_CONFIG_GLOBAL=/tmp/test-gitconfig`.
  - Leave nothing running.
- **Commits:**
  - Each commit is small and logical, with a short `-m` and a long `-m` that says what changed and why.
  - Command: `git commit -S/home/shayna/.ssh/id_ed25519_github_signing_agents.pub`.
  - Trailer: `Co-authored-by: GPT-6 Sol <noreply@openai.com>`, the implementer's actual model identity.
  - After every commit, run `git verify-commit HEAD`.
  - MUST NOT push, open PRs or post on GitHub. The operator does that.
- **Repo rules:** follow `AGENTS.md` at the worktree root:
  - `#private` fields; no `any`, no `ReturnType<>`, no inline imports.
  - Prompts go in `.md` files.
  - Use `logger`, never `console`, in runtime code.
  - Follow the Testing Guidance.
  - No YAML in new files; use TOML.
- **Tests:** every behaviour change gets a test that the implementer MUST run and see FAIL before the fix and PASS after. Record both results in the final report.
- **Final report** (in chat to the operator):
  - the commit list (hash and subject)
  - each test command with its result
  - the acceptance → evidence table
  - every stop/question raised

In this plan the worktree is `/home/shayna/source/github/PsychedelicShayna/neopi-moa-m2` and the branch is `feat/moa-m2`.

## 2. Baseline and closed world

### 2.1 Baseline

The worktree was created from `origin/neopi` at `955b7b385f` (M1 merged,
spec amendments through 6.8). Two further spec amendments and their code
land on `origin/neopi` **before** M2 starts, on a separate fix branch owned
by another lane: amendment 6.9 (size caps and iterative graph passes in
`moa/validate.ts`) and amendment 6.10 (rosters scoped per workspace in
`moa/provider.ts`, `moa/registration.ts`, `moa/host.ts`). The operator
updates the branch to include them before handing this plan over. Step 0
verifies that. Line numbers in this plan for `moa/validate.ts`,
`moa/resolve.ts`, `moa/provider.ts`, `moa/registration.ts`, and
`moa/host.ts` will have drifted by those amendments; §0.1 rule 4 applies.

### 2.2 Commands

Every command runs with the worktree as the working directory. `polite`
is `/home/shayna/.local/share/polite-relay/polite`.

| Purpose | Exact command |
|---|---|
| one test file | `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && GIT_CONFIG_GLOBAL=/tmp/test-gitconfig /home/shayna/.local/share/polite-relay/polite --label moa-test -- bun test <file>` |
| typecheck and lint | `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && /home/shayna/.local/share/polite-relay/polite --mem --label check-ts -- bun run check:ts` |
| commit | `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && git add <paths> && git commit -S/home/shayna/.ssh/id_ed25519_github_signing_agents.pub -m "<subject>" -m "<body>" -m "Co-authored-by: GPT-6 Sol <noreply@openai.com>" && git verify-commit HEAD` |

`<file>` is one of the test files named in this plan, as a repo-relative
path. `bun test` accepts a repo-relative file path from the worktree root.
`/tmp/test-gitconfig` MAY not exist; git treats a missing file as empty
configuration. The `check:ts` script runs `oxlint`, `oxfmt --check`, and
every package's `check:types`; it MUST exit 0 at the end of Step 10 and
MAY be run at the end of any earlier step.

### 2.3 Closed world

The implementer MAY create exactly these files:

- `docs/plans/QUESTIONS-moa-m2.md`
- `packages/coding-agent/src/moa/restore.ts`
- `packages/coding-agent/src/moa/transcript.ts`
- `packages/coding-agent/src/moa/decisions.ts`
- `packages/coding-agent/src/moa/status.ts`
- `packages/coding-agent/src/prompts/moa/envelopes/disagree.md`
- `packages/coding-agent/src/prompts/moa/envelopes/defend.md`
- `packages/coding-agent/src/prompts/moa/envelopes/judge.md`
- `packages/coding-agent/src/prompts/moa/envelopes/limit.md`
- `packages/coding-agent/src/prompts/moa/roles/prosecution.md`
- `packages/coding-agent/src/prompts/moa/roles/defense.md`
- `packages/coding-agent/src/prompts/moa/roles/judge.md`
- `packages/coding-agent/src/prompts/moa/verdict.md`
- `packages/coding-agent/src/prompts/moa/tool-trace.md`
- `packages/coding-agent/src/prompts/moa/notices/pause.md`
- `packages/coding-agent/test/moa-transit.test.ts`
- `packages/coding-agent/test/moa-checkpoint.test.ts`

The implementer MAY modify exactly these files:

- `docs/specs/mixture-of-agents.md` (Step 1 only)
- `packages/coding-agent/src/moa/types.ts`
- `packages/coding-agent/src/moa/engine.ts`
- `packages/coding-agent/src/moa/host.ts`
- `packages/coding-agent/src/moa/resolve.ts`
- `packages/coding-agent/src/moa/validate.ts`
- `packages/coding-agent/src/moa/settings.ts`
- `packages/coding-agent/src/moa/budget.ts`
- `packages/coding-agent/src/moa/envelopes.ts`
- `packages/coding-agent/src/moa/member-call.ts`
- `packages/coding-agent/src/judgment/index.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/slash-commands/builtin-collaboration.ts`
- `packages/coding-agent/src/modes/controllers/event-controller.ts`
- `packages/tui/src/overlays/mixture-types.ts`
- `packages/tui/src/chat/mixture-trace.ts`
- `packages/coding-agent/test/helpers/moa-setup.ts`
- `packages/coding-agent/test/moa-engine.test.ts`
- `packages/coding-agent/test/moa-validate.test.ts`
- `packages/coding-agent/test/moa-trace-ui.test.ts`
- `packages/coding-agent/test/judgment-chain.test.ts`

Every other file is forbidden. In particular the implementer MUST NOT modify
`packages/coding-agent/src/moa/config.ts` (its parser already reads every
M2 field: `parseRoute`, `parseTerminate`, `parseLimits`, and the
`transcript` branch of the `x` parser), `packages/coding-agent/src/moa/toml.ts`,
`packages/coding-agent/src/moa/provider.ts`,
`packages/coding-agent/src/moa/registration.ts`,
`packages/coding-agent/src/moa/run-store.ts`,
`packages/coding-agent/src/moa/request.ts`,
`packages/coding-agent/src/moa/outer-stream.ts`, anything under
`packages/agent/`, `packages/ai/`, or `packages/snapcompact/`, and this plan
file.

### 2.4 Test files and their commands

| Test file (repo-relative `<file>`) | Exists at baseline |
|---|---|
| `packages/coding-agent/test/moa-engine.test.ts` | yes |
| `packages/coding-agent/test/moa-validate.test.ts` | yes |
| `packages/coding-agent/test/moa-config.test.ts` | yes (not modified; run in Step 10) |
| `packages/coding-agent/test/moa-provider.test.ts` | yes (not modified; run in Step 10) |
| `packages/coding-agent/test/moa-trace-ui.test.ts` | yes |
| `packages/coding-agent/test/judgment-chain.test.ts` | yes |
| `packages/coding-agent/test/moa-transit.test.ts` | created in Step 5 |
| `packages/coding-agent/test/moa-checkpoint.test.ts` | created in Step 2 |

Test conventions (copied from the existing MoA tests; MUST be followed):
`bun:test` `describe`/`it`/`it.each`/`expect`; `vi.spyOn` with
`vi.restoreAllMocks()` in `afterEach`; `TempDir.createSync("@moa-…-")`;
`Settings.isolated({...})`; `clearCustomApis()` in `afterEach` of every file
that constructs `FakeMembers`; test names are behavioural sentences in the
present tense. Each `it(...)` name given in this plan MUST be used verbatim.

**Proof ordering inside every step** (this is how §1 "Tests" is satisfied;
there is no exception): (1) write or change the step's tests first; (2) run
the test command for each test file the step names and record the result
as the **before** state: a listed test that fails is FAIL, and a test file
that does not load because a symbol the step adds does not exist yet is
FAIL for every test in it; (3) if a test this plan lists as new or as
expected to fail PASSES in the before run, STOP; (4) make the step's code
changes; (5) run the same test commands and record the **after** state:
every listed test MUST PASS and every pre-existing test in the file MUST
still PASS; (6) run the typecheck command when the step's exit condition
names it; (7) commit; (8) `git verify-commit HEAD`. A step's exit condition
is met when (5) through (8) hold.

## 3. What M1 shipped and what M2 changes

Read-only orientation; every claim here was verified at `955b7b385f`.

| Concern | M1 state (file, symbol) | M2 change (step) |
|---|---|---|
| phase loop | `moa/engine.ts:424 (#loop)`: `hop_ready`, `decision_pending`, `finalizing`, `ended`; other phases fail | unchanged set of phases; `#decide` becomes async and judges (6) |
| decision | `moa/engine.ts:667 (#decide)`: single outgoing edge or terminal | terminate, route, `max_traversals`, verdict, limit-hop decision, `#pause` (6) |
| limits | `moa/engine.ts:448 (#hopReady)`: hard hop cap and window hops only; `moa/engine.ts:696 (#limitStop)`: stop only; no deadline | deadline signal and transcript-failure routing (5); budget, wall clock, hard budget, `on_limit` stop/judge/pause, the limit hop, resume, live-stream reconciliation (7) |
| transit parts | `moa/engine.ts:539 (#envelopeContext)`: `output`, `input`, `reasoning`; `moa/budget.ts:13 (HopParts)` without `transcript` | `transcript` (verbatim/compact/snapcompact) and `tool_trace` (5) |
| judge | `judgment/index.ts:51 (JudgeDeps)` has no `candidates`; `moa/types.ts:290 (MixtureHost)` has no `judge`; `moa/resolve.ts:75 (resolveJudgePlan)` pins `judgePlan` | `JudgeDeps.candidates`, `MixtureHost.judge`, `MixtureJudge` (3) |
| settings | `moa/settings.ts`: five M1 keys | eight M2 keys (3) |
| validation | `moa/validate.ts:88 (capabilityGate)` refuses every M2 feature; `IMPLEMENTED_MILESTONE = "M1"` | gate lifted for M2 features; E11–E15, E18 (4) |
| presets | `moa/envelopes.ts:14 (BUNDLED_ENVELOPES)`: `entry`, `handoff`; `moa/resolve.ts:149` looks roles up with an empty bundled map | bundled `disagree`, `defend`, `judge`, `limit` envelopes; `prosecution`, `defense`, `judge` roles; `verdict.md`; `tool-trace.md`; `notices/pause.md` (4, 5) |
| checkpoints | `moa/engine.ts:903 (#checkpoint)` writes every checkpoint; `moa/host.ts:128` (`onEvent`, case `"checkpoint"`) persists it; no restore anywhere | `moa/restore.ts` predicate (2); `entry` state, key rebind, restore on load/switch/branch/tree (8) |
| lifecycle | `moa/host.ts:220 (commitPersisted)` appends `run_end`; `run_reset` is typed but never written | `/mixture reset` writes `run_reset` (9) |
| session events | `moa/host.ts:31 (MixtureSessionEvent)`: `mixture_hop_end`, `mixture_limit`, `mixture_checkpoint`, `mixture_run_end` | `mixture_decision` (6) |
| slash command | none | `/mixture` (alias `/moa`) with `reset` and `status` (9) |

## 4. Steps

Each step states its input state, its actions, its exit condition, and the
commit it produces. Steps run in order. A step's commit MUST be made before
the next step starts. Every step follows the proof ordering of §2.4: tests
first, a recorded before run, the code, a recorded after run, the
typecheck when named, the commit, the verification. No step calls a
symbol that a later step introduces; where a later step extends a
function this step creates, this step says so and gives the function a
complete body for this step's tests.

### Step 0: verify the baseline

Input state: the worktree exists on the branch; the operator says it is
updated.

Actions:

1. `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && git status --short` MUST print nothing.
2. `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && git rev-parse --abbrev-ref HEAD` MUST print `feat/moa-m2`.
3. `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && grep -c '^### Amendment 6\.10' docs/specs/mixture-of-agents.md` MUST print `1`. If it prints `0`, STOP (§0.3).
4. `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && grep -c '^### Amendment 6\.9' docs/specs/mixture-of-agents.md` MUST print `1`. If it prints `0`, STOP.
5. `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && git log -1 --format=%H` — record the hash in the final report as the base commit.
6. `touch /tmp/test-gitconfig`.
7. Run the test command for `packages/coding-agent/test/moa-engine.test.ts` and for `packages/coding-agent/test/moa-validate.test.ts`. Both MUST exit 0. Record the pass counts.

Exit condition: actions 1–4 and 7 hold.

Commit: none.

### Step 1: spec amendment 6.11

Input state: Step 0 passed.

Actions: apply the sixteen replacements of §1.A below to
`docs/specs/mixture-of-agents.md`. Each replacement names the exact current
text; the current text MUST occur exactly once in the file (verify with
`grep -c` on a distinctive fragment before editing). Replace it with the
exact new text. Change nothing else in the file.

Exit condition: `grep -c '^### Amendment 6\.11' docs/specs/mixture-of-agents.md`
prints `1`; `git diff --stat` shows only `docs/specs/mixture-of-agents.md`.

Commit: subject `docs(specs): MoA amendment 6.11 — M2 pause resume, judge seam, limit check points, verdict and limit hops`; body: one paragraph stating that the amendment pins the M2 behaviours the plan implements (paused-run resume before M3, the `MixtureJudge` seam, the two limit check points, verdict and limit hops as `HopRecord`s, restore re-resolution, `/mixture reset` semantics, M2 preset files, decision cards) and that the text was supplied by the spec author.

#### 1.A The sixteen replacements

**R1** (§4.5 step-0 table). Replace the line

```
| operator prompt | `paused`, `checkpoint` | treated as a steer (the pause/checkpoint notice told the operator so); `/mixture reset` or a new conversation starts fresh. **Before M3 ships steering hops**, this row instead starts a new run and the abort/checkpoint notice says so (§14 M1); M3 replaces the row with the steer |
```

with the two lines

```
| operator prompt | `paused` | treated as a steer (the pause notice told the operator so); `/mixture reset` or a new conversation starts fresh. **Before M3 ships steering hops** (M2): the run **resumes** at its checkpointed phase with a fresh soft-limit window (§4.7), `lastRequest` is set to this request, the prompt's text and images are not forwarded to any member (the pause notice said so), and the engine emits a `resume` event that the session host turns into a notice and persists nothing for; M3 replaces the row with the steer |
| operator prompt | `checkpoint` | treated as a steer (the checkpoint notice told the operator so); `/mixture reset` or a new conversation starts fresh. **Before M3 ships steering hops**, this row instead starts a new run and the abort/checkpoint notice says so (§14 M1); M3 replaces the row with the steer |
```

**R2** (§4.2 host interface). Replace the line

```
  judge(plan: RoleChainCandidate[], onAttempt: (s: Settlement) => void): Judge;   // §5: pinned candidates
```

with

```
  judge(plan: RoleChainCandidate[], onAttempt: (attempt: JudgmentUsage) => void): MixtureJudge;   // §5: pinned candidates; MixtureJudge is the `withCandidate` surface of ChainJudge (judgment/index.ts); the engine builds each kind:"judge" Settlement from the JudgmentUsage it receives
```

**R3** (§4.7 settlement paragraph). Replace the two lines

```
`JudgmentResult.usage` is not added a second time), summarizer calls
(through `completeImpl`), slicer calls. `run.lifetime.usd` and
```

with

```
`JudgmentResult.usage` is not added a second time), summarizer calls
(through `completeImpl`), slicer calls. A judge settlement's `hop` is the hop
whose decision it served; a summary settlement's `hop` is undefined (it is
made while the next hop is prepared), so its cost is in the run totals and
in no hop card. `run.lifetime.usd` and
```

**R4** (§4.7 limits lead-in). Replace the three lines

```
**Limits.** Enforced by the engine after every settlement (member, judge,
summary, slicer, branch) and at the start of every hop and every fan-out
group, never asked of Jev:
```

with

```
**Limits.** Enforced by the engine after every settlement (member, judge,
summary, slicer, branch) and at the start of every hop and every fan-out
group, never asked of Jev. Concretely the engine checks, in the order hard
hop cap, hard budget, soft hops, soft budget, wall clock, at these points
and no others: (1) on entering `hop_ready`, before anything else; (2) in
`hop_ready` again, after the transit context was prepared, when preparing
it settled a summary; (3) on entering `decision_pending`, when the hop's
member has at least one outgoing edge; (4) in `decision_pending` again,
after a `terminate` judgment that did not terminate, when a `route`
judgment would follow. A settlement whose continuation is terminal (the hop
has no outgoing edges, a verdict hop, a limit hop) is followed by no check:
the run ends with that hop and its answer is the outer text, so there is
nothing left to stop. A limit hop (`edgeInId: "limit"`) is checked against
the hard caps only, at point (1), and is exempt from the run deadline. A
`pause` taken at `decision_pending` keeps that phase as the continuation,
so the resumed run decides that hop first. Whenever the decision phase
leaves without taking an edge and without ending the run at that hop (a
limit action at points (3) or (4), a pause from a failed or low-confidence
judgment), the completed deciding hop is published first (§7: its
`hop_end`, with visibility from the member's `show` alone, since no edge
was taken), so the persisted trace carries every completed hop; a resumed
decision that later takes an edge does not publish it again. The mid-call
wall clock is the run deadline signal, `AbortSignal.timeout` on the
window's remaining time combined with the caller's signal by
`AbortSignal.any`, passed to every member, judge, and summary call except
the limit hop's; a deadline that fires inside a judge or summary call takes
the wall-clock action from the phase that made the call
(`decision_pending` or `hop_ready`), exactly as a member call's deadline
does:
```

**R5** (§4.7 `judge` bullet). Replace the four lines

```
  - `judge`: one final hop at `limit_target` with the `limit` envelope
    (transcript verbatim within budget), tools off, `show` forced to `final`,
    exempt from the soft limits but not the hard caps; then stop. If
    `limit_target` is the member that just ran, `stop` applies.
```

with

```
  - `judge`: one final hop at `limit_target` with the `limit` envelope
    (transcript verbatim within budget), tools off, `show` forced to `final`,
    exempt from the soft limits and from the run deadline but not the hard
    caps; then stop. If `limit_target` is the member that just ran, `stop`
    applies. The limit hop is a `HopRecord` with `edgeInId: "limit"`,
    `x = { transcript }` over the completed hops within
    `moa.transcript_budget_tokens` (the `verbatim` fold), the envelope
    context's `limit: { kind, value }`, `from` set to the last completed
    hop's member, and `endReason: "limit:<kind>"` when it completes; it
    counts toward the window and lifetime hop counters; if a hard cap
    refuses it at `hop_ready`, `stop` applies with the hard-cap notice.
```

**R6** (§4.7 `pause` bullet). Replace the three lines

```
  - `pause`: run ends this turn with `notices/pause.md` as the outer text
    (which member is waiting, what was hit, that the next message resumes it
    with a fresh window); `status: "paused"`.
```

with

```
  - `pause`: run ends this turn with `notices/pause.md` as the outer text
    (which member is waiting, what was hit, that the next message resumes it
    with a fresh window, and, until M3 ships steering hops, that the
    message's text is not forwarded to the members); `status: "paused"`;
    the phase is unchanged and is the continuation; the outer-return
    checkpoint has `reason: "pause"` and a `checkpoint` card whose note
    names the waiting member. A `route` fallback that lands on `pause` takes
    the same path with the route's reason in the notice and no `limit`
    event.
```

**R7** (§4.8 restore step 5). Replace the two lines

```
5. Seed the run store with the run; the next engine call proceeds from step 0
   and dispatches on the restored `phase` (§4.5 step 1).
```

with

```
5. Rebuild `resolved` by resolving the **checkpoint's own** `definition`
   (the pinned one, not the currently registered one) with `resolveMixture`
   against the host's registry and settings and the scope's current document
   presets, then `validateMixture`. A resolution with errors means the run
   cannot be restored: the host logs it, notices it, and seeds nothing (the
   next prompt starts a new run). Otherwise rebind the run to the host it
   restores into: `key.host` and `key.conversation` are re-derived from the
   host (in the session host both are the current session id; a branched
   session has a new id), because the store indexes by the full key and the
   next call acquires the host's current key. Seed the run store with the
   run in a fresh entry whose `conversation` and `topicImages` come from the
   checkpoint's `entry` field (every hop's envelope reads the conversation;
   a redone entry hop forwards the images) and whose provider state is
   empty; a checkpoint written before `summaries` existed restores with
   `summaries: {}`, and one written before `entry` existed restores with an
   empty conversation and no images. The next engine call proceeds from
   step 0 and dispatches on the restored `phase` (§4.5 step 1).
```

**R8** (§5 verdict row). Replace the line

```
| Verdict member | the member's own question | the inbound edge's declared parts (or `state` subset) | rendered through `verdict.md`; the run ends (`endReason: "verdict"`) |
```

with

```
| Verdict member | the member's own question | the inbound edge's declared parts (or `state` subset), each capped at `moa.decision_state_tokens` | rendered through `verdict.md`; the run ends (`endReason: "verdict"`). The verdict runs as a hop of its own: a `HopRecord` whose `input` is empty, whose `output` is the rendered verdict, whose `decisions` carry the verdict decision, and whose `usage` is the judge settlements; it counts toward the hop limits and appears in the transcript like any hop; a failed verdict judgment is a run error (`verdict.failed`), retryable at the verdict hop |
```

**R9** (§5 judgment failure). Replace the three lines

```
failure (`JudgmentParseError`, transport error after the chain's cascade)
counts as confidence 0: fallback if eligible, else pause, never a silent
default edge.
```

with

```
failure (`JudgmentParseError`, transport error after the chain's cascade)
counts as confidence 0: fallback if eligible, else pause, never a silent
default edge. A failed `terminate` judgment pauses the run the same way
(never a silent "not terminated"). Confidence floors apply only when
`judgeKind === "native"`; a decision made under an inactive floor records
that in its `outcome`.
```

**R10** (§7.1 card sentence). Replace the three lines

```
collapsed by default (expanded with the tool-output toggle), body = output
when visible, decisions rendered as one-liners
(`route → rebut 0.71 · judge typesafe/jev-latest`).
```

with

```
collapsed by default (expanded with the tool-output toggle), body = output
when visible. A `decision` event is its own header-only card whose title is
`<mixture> · hop <n> · <kind> <outcome> · <judge> (<judgeKind>)`, where
`outcome` is the decision's own short phrase (`MixtureDecision.outcome`):
`→ rebut 0.71` for a route, `fallback → verdict (0.31 < 0.60)` or
`fallback → pause (0.31 < 0.60)` for a route below its floor,
`fallback → pause (judgment failed)` for a route whose judgment threw
(the recorded answer is then an empty choice with confidence 0 and the
judge label `failed`), `→ rebut (floor inactive)` for a route decided by a
non-native judge, `yes 0.91` or `no 0.12` for a terminate (the probability
of yes), and `guilty 0.80` for a verdict; decisions therefore read in order
between the hop cards.
```

**R11** (§10 slash command). Replace the four lines

```
<name>` is `/model mixture/<name>`, `/mixture reset` drops the current run
(§6.3) and appends a `run_reset` lifecycle record (§4.8) so the dropped run
cannot be restored or re-hydrated, `/mixture status` prints the active run's
hop, member, and spend.
```

with

```
<name>` is `/model mixture/<name>`, `/mixture reset` drops every run the
session's host holds (one per mixture the conversation ran; §6.3) and
appends a `run_reset` lifecycle record (§4.8) per dropped run so none can be
restored or re-hydrated, `/mixture status` prints, per held run, its
mixture, status, phase, active member, lifetime and window hops against the
hop limit, and lifetime and window spend; with no held run either verb
reports `no active mixture run`. `reset` and `status` ship with M2;
`configure`, `list`, and `use` ship with M5.
```

**R12** (§3 preset table). Replace the line

```
| `envelopes/disagree.md`, `defend.md`, `judge.md`, `review.md` | starter presets mirroring the issue's example |
```

with

```
| `envelopes/disagree.md`, `defend.md`, `judge.md` (M2), `review.md` (M4) | starter presets mirroring the issue's example |
```

and replace the line

```
| `roles/prosecution.md`, `defense.md`, `judge.md`, `reviewer.md`, `worker.md` | role presets |
```

with

```
| `roles/prosecution.md`, `defense.md`, `judge.md` (M2), `reviewer.md`, `worker.md` (M4) | role presets; bundled roles are the last lookup after mixture-local and document `roles` |
```

and replace the line

```
| `tool-trace.md` | renders the `toolTrace` part |
```

with

```
| `tool-trace.md` | renders the `toolTrace` part: one line per tool call at M2; the file-operations summary joins at M3, when hop messages first carry tool results |
```

**R13** (§2.1 snapcompact degrade). Replace the phrase

```
if undefined the edge degrades to `compact` with a trace warning.
```

with

```
if undefined, or when the frame budget is zero, the edge degrades to `compact` for that traversal with a `logger.warn` naming the edge (a card for it is M7 polish).
```

**R14** (§4.8 checkpoint interface). Replace the two lines

```
  outerResponseId?: string;             // outer-return checkpoints: the outer message this checkpoint precedes
  report?: { from: number; to: number };   // outer-return checkpoints: the settlement range that response reports
```

with

```
  outerResponseId?: string;             // outer-return checkpoints: the outer message this checkpoint precedes
  report?: { from: number; to: number };   // outer-return checkpoints: the settlement range that response reports
  entry: { conversation: string; topicImages: ImageContent[] };   // the store entry's serializable state: `conversation` always; `topicImages` only when `run.phase` is the entry hop's `hop_ready` (the one continuation that forwards them), else `[]`
```

**R15** (§4.5 live-streaming paragraph). Replace the six lines

```
Live streaming of a structurally terminal member's text (§4.3) is an
optimization of step 7 that is taken only when no `toolRequirement` is
pending and the member has no `terminate`; in every other case the answer is
buffered until `finalizing`, so a closing call never has to replace text a
client already received (the writer is append-only and SSE encoders publish
deltas immediately, `packages/ai/src/providers/openai-chat-server.ts:595-602`).
```

with

```
Live streaming of a structurally terminal member's text (§4.3) is an
optimization of step 7 that is taken only when no `toolRequirement` is
pending and the member has no `terminate`; in every other case the answer is
buffered until `finalizing`, so a closing call never has to replace text a
client already received (the writer is append-only and SSE encoders publish
deltas immediately, `packages/ai/src/providers/openai-chat-server.ts:595-602`).
A live-streamed hop's decision is terminal by construction (no outgoing
edges, no `terminate`), so no limit check follows its settlement (§4.7).
When the run deadline aborts a live-streamed hop mid-call, the partial text
already on the wire stays, the aborted hop's output is dropped from the run
as for any abort, and the wall-clock action's text follows the partial text
after a blank line: the stop notice, the pause notice, or the limit hop's
answer. `finalizing` therefore emits `run.final.text` only when it is not
the text that already streamed (`run.final.hop` is not the live hop), and
the stored `PendingResponse` is the writer's whole content, so a replay
carries both.
```

**R16** (§19). Insert, immediately before the first line of §19 that starts
with `### Amendment 6.` (at revision 6.10 that is the `### Amendment 6.10`
heading), the block:

```
### Amendment 6.11 (M2 plan: behaviours the milestone pins)

- Step-0 row split: an operator prompt on a `paused` run resumes it at M2
  (fresh window, text not forwarded, `resume` event → notice); the
  `checkpoint` row keeps the M1 new-run behaviour until M3.
- `MixtureHost.judge(plan, onAttempt: (attempt: JudgmentUsage) => void): MixtureJudge`;
  the engine builds judge settlements; a judge settlement's `hop` is the
  deciding hop, a summary settlement's `hop` is undefined.
- Limit check points, exhaustively: `hop_ready` entry; `hop_ready` again
  after a summary settled; `decision_pending` entry when the hop has an
  outgoing edge; `decision_pending` again after a non-terminating
  `terminate` judgment when a `route` judgment follows. No check after a
  settlement whose continuation is terminal. Limit hops: hard caps at
  `hop_ready` only, exempt from the deadline. The deadline signal is
  `AbortSignal.timeout` ∪ caller signal; a deadline inside a judge or
  summary call takes the wall-clock action from the calling phase.
- A decision phase that leaves without taking an edge and without ending
  the run at that hop (limit action, judgment-failure or low-confidence
  pause) publishes the completed deciding hop first, with visibility from
  the member's `show`; a resumed decision never publishes it twice.
- A deadline-aborted live-streamed hop keeps its partial text on the wire;
  the wall-clock action's text follows after a blank line.
- Verdict and limit hops are `HopRecord`s that count toward hop limits; a
  failed terminate judgment pauses; a failed verdict judgment is
  `verdict.failed`.
- Restore re-resolves the checkpoint's pinned definition (unresolvable →
  not restored, noticed), rebinds the run key to the restoring host, and
  seeds the entry's `conversation`/`topicImages` from the checkpoint's new
  `entry` field.
- `/mixture reset` resets every held run with one `run_reset` each;
  `/mixture status` prints per run.
- Decision cards are header-only with `MixtureDecision.outcome` in the
  title; M2 bundles `disagree`/`defend`/`judge`/`limit` envelopes,
  `prosecution`/`defense`/`judge` roles, `verdict.md`, `tool-trace.md`
  (tool-call lines only), `notices/pause.md`; snapcompact degrade is a
  `logger.warn`.
```

### Step 2: the terminal predicate (`restore.ts`, early PR)

Input state: Step 1 committed.

Actions, in this order:

1. Create `packages/coding-agent/test/moa-checkpoint.test.ts` (item 3
   below describes it), then run its test command and record the before
   state: the file fails to load because `../src/moa/restore` does not
   exist, which is FAIL for its three tests (§2.4 proof ordering). If the
   command exits 0, STOP.

2. Create `packages/coding-agent/src/moa/restore.ts` with exactly two
   exports and no other export:

   ```ts
   export function completedMixtureRun(branch: readonly SessionEntry[], runId: string): MixtureCheckpoint | undefined
   export function isMixtureRunComplete(branch: readonly SessionEntry[], runId: string): boolean
   ```

   `SessionEntry` is imported from `../session/session-entries` (the union
   at `packages/coding-agent/src/session/session-entries.ts:300 (type SessionEntry)`);
   `MixtureCheckpoint` and `MIXTURE_RUN_ENTRY_TYPE` from `./types`. The
   parameter type MUST be `readonly SessionEntry[]` (another lane passes
   `sessionManager.getBranch()` without a cast).

   `completedMixtureRun` implements the spec §4.8 predicate verbatim:
   "complete(run) := ∃ c, a on branch, index(c) < index(a), no reset_boundary after c, c.type = "custom" ∧ c.customType = "mixture_run" ∧ c.data.reason = "done" ∧ c.data.run.id = run ∧ a.type = "message" ∧ a.message.role = "assistant" ∧ a.message.responseId = c.data.outerResponseId".
   Algorithm: walk `branch` from the last index to the first; stop at the
   first entry with `type === "reset_boundary"`; remember every assistant
   `message` entry's `message.responseId` seen so far (they are after the
   current index); at a `custom` entry with `customType === MIXTURE_RUN_ENTRY_TYPE`
   whose `data` is an object with `reason === "done"`, `run.id === runId`,
   and a string `outerResponseId` that is in the remembered set, return
   that `data` as `MixtureCheckpoint`. Return `undefined` when the walk
   ends. The newest satisfying checkpoint is therefore returned when
   several exist. A `run_end` or `run_reset` lifecycle record (`data.kind`
   present, `data.reason` absent) never affects the result.
   `isMixtureRunComplete` returns `completedMixtureRun(branch, runId) !== undefined`.

3. The test file created in item 1, `packages/coding-agent/test/moa-checkpoint.test.ts`, has a
   `describe("terminal predicate", …)` block whose tests build
   `SessionEntry[]` arrays by hand (helper functions in the test file that
   return `{ type: "custom", customType: MIXTURE_RUN_ENTRY_TYPE, data, id, parentId, timestamp }`-shaped
   entries, an assistant `message` entry with a `responseId`, and a
   `reset_boundary` entry; copy the field set of each entry type from
   `session-entries.ts`). Tests:
   - `it("completes a run only when its done checkpoint is followed by the assistant entry it names")`:
     `[c(done, run A, response r1), a(r1)]` → `completedMixtureRun` returns
     `c.data` and `isMixtureRunComplete` is true; `[c(done, A, r1)]` alone →
     undefined/false; `[a(r1), c(done, A, r1)]` (assistant before the
     checkpoint) → undefined/false; `[c(done, A, r1), a(r2)]` → false;
     `[c(done, B, r1), a(r1)]` queried for A → false.
   - `it("ignores a run_end record and a reset_boundary after the checkpoint")`:
     `[c(done, A, r1), a(r1), run_end(A)]` → true; `[run_end(A)]` alone →
     false; `[c(done, A, r1), reset_boundary, a(r1)]` → false;
     `[c(done, A, r1), a(r1), reset_boundary]` → false.
   - `it("returns the newest satisfying done checkpoint when a done response was replayed")`:
     `[c1(done, A, r1), a(r1), c2(done, A, r2), a(r2)]` → returns `c2.data`.

4. Run the test command for `packages/coding-agent/test/moa-checkpoint.test.ts`;
   all three MUST PASS (the after state).

5. Commit (subject below), then `git verify-commit HEAD`.

6. Create the local branch for the operator's early PR:
   `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && git branch feat/moa-restore-predicate HEAD`.
   This creates a branch; it does not push.

7. Tell the operator in chat, before starting Step 3: "restore.ts predicate
   committed as <hash> on feat/moa-restore-predicate; push it and open the
   early PR when convenient. The side-panel lane's Phase 3 waits for the
   full M2 merge on origin/neopi; this early PR is an earlier dependency
   milestone only." M2 does not wait for that merge; Step 3 starts at once.

Exit condition: the three tests passed in item 4; `restore.ts` has exactly
the two exports; the commit of item 5 verifies; the branch of item 6
exists (`git branch --list feat/moa-restore-predicate` prints it); the
message of item 7 was sent.

Commit: subject `feat(moa): terminal predicate for mixture runs (restore.ts)`; body: states that `completedMixtureRun`/`isMixtureRunComplete` implement spec §4.8's predicate over a branch array, that the side-panel lane imports them, and names the three tests.

### Step 3: settings, types, and the judge seam

Input state: Step 2 committed.

Actions:

1. `packages/coding-agent/src/moa/settings.ts`: append, after
   `cfgMoaConversationBudgetTokens`, eight registrations with `register`
   from `../config/registry`, in this order, each with `ui: { tab: "model", group: "Mixture of Agents", label, description }`:

   | Export | `id` | `type` | `default` | `values` |
   |---|---|---|---|---|
   | `cfgMoaBudgetUsd` | `moa.budget_usd` | `"number"` | `0` | |
   | `cfgMoaHardBudgetUsd` | `moa.hard_budget_usd` | `"number"` | `0` | |
   | `cfgMoaWallClockMinutes` | `moa.wall_clock_minutes` | `"number"` | `240` | |
   | `cfgMoaOnLimit` | `moa.on_limit` | `"enum"` | `"pause"` | `["stop", "pause", "judge"] as const` |
   | `cfgMoaJudgeMinConfidence` | `moa.judge_min_confidence` | `"number"` | `0.55` | |
   | `cfgMoaDecisionStateTokens` | `moa.decision_state_tokens` | `"number"` | `4_000` | |
   | `cfgMoaTranscriptBudgetTokens` | `moa.transcript_budget_tokens` | `"number"` | `24_000` | |
   | `cfgMoaSummaryModel` | `moa.summary_model` | `"string"` | `"@smol"` | |

   The enum registration follows the shape of `cfgAdvisorSyncBacklog`
   (`packages/coding-agent/src/advisor/settings.ts:24`). Labels and
   descriptions are one sentence each, taken from the "Purpose" column of
   spec §12 for that key.

2. `packages/tui/src/overlays/mixture-types.ts`, `interface MixtureDecision`
   (line 198): add the field `outcome: string;` with the doc comment
   `/** The decision's short phrase for the trace title (spec §7.1). */`
   after `kind`. If an existing test file in the closed world constructs a
   `MixtureDecision` literal, add `outcome: ""` to that literal in this step.

3. `packages/coding-agent/src/moa/types.ts`:
   - `interface ResolvedMixture` (line 74): add `summaryModel?: Model<Api>;`
     after `judgePlan`, doc comment `/** \`moa.summary_model\`; only when \`uses.summary\`. */`.
   - `interface MixtureRun` (line 194): add, after `traversals`,
     `summaries: Record<string, { text?: string; preserveData?: Record<string, unknown>; throughHop: number }>;`
     (spec §2.1 "Per-edge summary state"), and, after `final`,
     `limitHop?: { kind: "hops" | "budget" | "wall_clock"; value: string };`
     with the doc comment `/** The pending or completed limit hop's cause (\`on_limit = "judge"\`). */`.
   - Add, before `interface MixtureHost`:
     ```ts
     /** The judge surface the engine drives: `ChainJudge.withCandidate` (judgment/index.ts), so every decision learns which backend kind answered. */
     export interface MixtureJudge {
     	withCandidate<T>(run: (judge: Judge, kind: JudgeKind) => Promise<T>, options?: JudgeOptions): Promise<T>;
     }
     ```
     importing `Judge` and `JudgeOptions` as types from `@oh-my-pi/pi-ai/judgment`
     (beside the existing `Question` import) and `JudgeKind`, `JudgmentUsage`
     as types from `../judgment`.
   - `interface MixtureHost`: add, after `conversationKey`,
     `judge(plan: RoleChainCandidate[], onAttempt: (attempt: JudgmentUsage) => void): MixtureJudge;`
     with the doc comment `/** A judge over the run's pinned candidates (§5); \`onAttempt\` receives every billed judgment attempt. */`.
   - `type MixtureEvent`: add the variant
     `| { type: "resume"; run: MixtureRun; note: string }` after the
     `"limit"` variant.
   - `MixtureRun.summaries` is required: in this step,
     `packages/coding-agent/src/moa/engine.ts:366 (#startRun)` initialises
     it to `{}` in the `MixtureRun` literal (the only engine change of this
     step); `serializeRun` needs no change (it spreads the run).

4. `packages/coding-agent/src/judgment/index.ts`:
   - `interface JudgeDeps` (line 51): add
     `/** Pinned candidates: used instead of the live judge role chain and never refreshed (a mixture's judge plan). */ candidates?: RoleChainCandidate[];`.
   - `ChainJudge.#resolveCandidates` (line 231): as its first statement,
     `if (this.#deps.candidates) return this.#deps.candidates;` (no TTL
     cache, no `sessionModel` append, exactly as spec §5: "when present,
     `ChainJudge` uses that list instead of `#buildCandidates()` and skips
     the `CANDIDATE_TTL_MS` refresh").
   - No other change: `#createJudge` still resolves credentials per call.

5. `packages/coding-agent/src/moa/host.ts`, in the object returned by
   `createSessionMixtureHost` (line 149), add after `conversationKey`:
   ```ts
   judge(plan, onAttempt) {
   	return resolveJudge({
   		settings,
   		registry: modelRegistry,
   		sessionId: sessionManager.getSessionId(),
   		candidates: plan,
   		onUsage: onAttempt,
   	});
   },
   ```
   importing `resolveJudge` from `../judgment`. This is spec §4.2's
   "`judge(plan, onAttempt)` = `resolveJudge({ settings, registry, sessionId, candidates: plan, onUsage: onAttempt })`".

6. `packages/coding-agent/test/judgment-chain.test.ts`: add
   `it("uses pinned candidates and never rebuilds the chain from settings")`
   inside `describe("ChainJudge", …)`, built from the file's own fixtures
   (`LOCAL`, `ONLINE`, `ONLINE_BACKUP`, `makeRegistry`, `reply`,
   `TIER_QUESTION`): `settings = Settings.isolated({ modelRoles: { judge: \`${LOCAL.provider}/${LOCAL.id}\` }, "retry.fallbackChains": { judge: [] } })`
   (the live chain would be `LOCAL` alone);
   `registry = makeRegistry([LOCAL, ONLINE, ONLINE_BACKUP], { [ONLINE.provider]: "online-key" })`;
   spy `tinyModelClient.complete` to record that it was called and return
   `"low"`; spy `ai.completeSimple` as the file's first test does,
   recording `model.id` of every call and replying `reply(model, "level: high")`;
   construct `new ChainJudge({ settings, registry, candidates: [{ model: ONLINE_BACKUP, explicit: true }] })`;
   run `judge.withCandidate(async (candidate, kind) => { kinds.push(kind); const result = await candidate.judge({ state: "refactor the scheduler", questions: { level: TIER_QUESTION } }); return result.answers.level.choice; })`
   twice; assert both answers are `"high"`, `kinds` is `["online", "online"]`,
   every recorded `completeSimple` model id is `ONLINE_BACKUP.id`, and
   `tinyModelClient.complete` was never called (the settings-derived
   `LOCAL` candidate was never consulted). Before the change this test
   MUST FAIL (the `candidates` field does not exist, so the chain resolves
   to `LOCAL` and `tinyModelClient.complete` is called); after it MUST
   PASS.

7. Run the test command for `packages/coding-agent/test/judgment-chain.test.ts`
   (before and after) and for `packages/coding-agent/test/moa-engine.test.ts`
   (after; every M1 test MUST still PASS).

Exit condition: the new judgment-chain test passes; moa-engine passes; the
typecheck command exits 0.

Commit: subject `feat(moa): M2 settings, pinned judge candidates, and the host judge seam`.

### Step 4: validation for M2 graphs, bundled presets, summary model

Input state: Step 3 committed.

Actions:

1. Bundled prompt files. Create the following files (Handlebars templates
   compiled with `prompt.compile`; the context is `EnvelopeContext` of
   `moa/envelopes.ts:30`; `{{> moa-parts}}` renders the declared parts).
   Content is the operator-facing wording below, verbatim:

   - `packages/coding-agent/src/prompts/moa/envelopes/disagree.md`:
     ```
     You are {{to.id}} in the mixture "{{mixture.name}}" ({{mixture.member_count}} participants). The previous turn was {{from.id}}.
     The topic is:

     <request>
     {{topic}}
     </request>

     Your role is to disagree with {{from.id}} on the merits. Be concrete.
     {{> moa-parts}}
     ```
   - `packages/coding-agent/src/prompts/moa/envelopes/defend.md`:
     ```
     You are {{to.id}} in the mixture "{{mixture.name}}". {{from.id}} has just spoken (traversal {{edge.traversal}} of edge {{edge.id}}).
     The topic is:

     <request>
     {{topic}}
     </request>

     Rebut {{from.id}} point by point, using the transcript for what was already said.
     {{> moa-parts}}
     ```
   - `packages/coding-agent/src/prompts/moa/envelopes/judge.md`:
     ```
     You are {{to.id}}, the judge of the mixture "{{mixture.name}}". Both sides have argued the topic:

     <request>
     {{topic}}
     </request>

     Weigh the transcript and write the ruling. Return only the ruling.
     {{> moa-parts}}
     ```
   - `packages/coding-agent/src/prompts/moa/envelopes/limit.md`:
     ```
     You are {{to.id}} in the mixture "{{mixture.name}}". The run reached a limit ({{limit.kind}}: {{limit.value}}) and you write the final answer now.
     The topic is:

     <request>
     {{topic}}
     </request>

     Use the transcript below. Return only the final answer.
     {{> moa-parts}}
     ```
   - `packages/coding-agent/src/prompts/moa/roles/prosecution.md`:
     `You argue the strongest case that the proposal is wrong. Be concrete.`
   - `packages/coding-agent/src/prompts/moa/roles/defense.md`:
     `You rebut the prosecution point by point and defend the proposal on the merits. Concede a point only when it is right.`
   - `packages/coding-agent/src/prompts/moa/roles/judge.md`:
     `You weigh both sides and write the ruling. State what was decided, what was left open, and why.`
   - `packages/coding-agent/src/prompts/moa/verdict.md` (template context, every value a string: `{ member: { id, description? }, question: { type, instructions }, answer: { choice?: string; score?: string; noul?: string }, confidence?: string, judge: string, judgeKind: string }`):
     ```
     Verdict of {{member.id}} ({{judge}}, {{judgeKind}}): {{question.instructions}}
     {{#if answer.choice}}Answer: {{answer.choice}}{{/if}}{{#if answer.score}}Score: {{answer.score}}{{/if}}{{#if answer.noul}}Yes with probability {{answer.noul}}{{/if}}
     {{#if confidence}}Confidence: {{confidence}}{{/if}}
     ```
     `renderVerdict` (item 2) formats the numbers to fixed two decimals
     before rendering, so every `{{#if}}` tests presence, never zero.
   - `packages/coding-agent/src/prompts/moa/tool-trace.md` (context: `{ calls: { name: string; summary: string }[] }`):
     ```
     {{#each calls}}
     - {{name}}: {{summary}}
     {{/each}}
     ```
   - `packages/coding-agent/src/prompts/moa/notices/pause.md` (context: `{ mixture, member, reason, hops, usd }`):
     ```
     ⏸ {{mixture}} paused at {{member}} after {{hops}} hops (${{usd}} so far): {{reason}}. Send any message to resume with a fresh window; until steering arrives, the message's text is not forwarded to the members. /mixture reset starts over.
     ```

2. `packages/coding-agent/src/moa/envelopes.ts`:
   - import the four new envelope files, the three role files,
     `verdict.md`, `tool-trace.md`, and `notices/pause.md` with `with { type: "text" }`;
   - add `disagree`, `defend`, `judge`, `limit`, and `verdict` (the
     verdict renderer, looked up by `moa/resolve.ts` under the name
     `"verdict"` at `resolve.ts:135 (lookupPreset(member.render ?? "verdict", …))`)
     to `BUNDLED_ENVELOPES`;
   - export `const BUNDLED_ROLES: Readonly<Record<string, string>> = { prosecution, defense, judge }`;
   - export `const LIMIT_ENVELOPE = "limit"`;
   - extend `EnvelopeContext` with `limit?: { kind: "hops" | "budget" | "wall_clock"; value: string };`
     (spec §3 template context);
   - export `renderPauseNotice(context: { mixture: string; member: string; reason: string; hops: number; usd: string }): string`
     (compile + trim, as `renderLimitNotice`);
   - export `interface VerdictInput { member: { id: string; description?: string }; question: Question; answer: Answer; confidence?: number; judge: string; judgeKind: JudgeKind }`
     (`Question`, `Answer` as types from `@oh-my-pi/pi-ai/judgment`;
     `JudgeKind` as a type from `../judgment`) and
     `renderVerdict(template: string, input: VerdictInput): string`, which
     builds the template context of item 1's `verdict.md` from `input`:
     `answer.choice` → `{ choice: answer.choice }`; `answer.score` →
     `{ score: answer.score.toFixed(2) }`; `answer.noul` →
     `{ noul: answer.noul.toFixed(2) }`; `confidence` →
     `input.confidence?.toFixed(2)`; `question` → `{ type: question.type, instructions: question.instructions }`;
     then compiles and trims. Numbers cross the public boundary as numbers;
     formatting happens only here;
   - export `renderToolTrace(calls: { name: string; summary: string }[]): string`
     (compile `tool-trace.md`, trim; `""` for an empty list).

3. `packages/coding-agent/src/moa/resolve.ts`:
   - the role lookup at `resolve.ts:149 (lookupPreset(member.role, definition.roles, ctx.documentRoles, {}))`
     passes `BUNDLED_ROLES` instead of `{}` (spec §3 resolution order:
     mixture-local → document → bundled);
   - always inline the `limit` envelope beside `entry`: after the
     `entryEnvelope` lines (`resolve.ts:206-207`), look up `LIMIT_ENVELOPE`
     the same way and store it under `envelopes[LIMIT_ENVELOPE]` when
     found;
   - after `judgePlan` is computed (`resolve.ts:238`), when `uses.summary`
     resolve `summaryModel`: `resolveModelRoleValue(cfgMoaSummaryModel.get(ctx.settings), available, { settings: ctx.settings }).model`;
     when it is undefined, a mixture (`isMixtureApi`), or not `isAllowed`,
     push `{ code: "helper.unresolved", path: "summary", message: … }`
     (message names `moa.summary_model`, its value, and the reason:
     `does not resolve`, `is a mixture`, or `is excluded by enabledModels`)
     and leave `summaryModel` undefined; otherwise set it. Include
     `summaryModel` (as `formatModelStringWithRouting`) in the revision
     hash object and in the returned object.

4. `packages/coding-agent/src/moa/validate.ts`:
   - set `IMPLEMENTED_MILESTONE = "M2"`;
   - in `capabilityGate`, delete exactly these gate calls: the verdict
     member gate (`\`verdict member ${member.id}\``), the `route` gate, the
     `terminate` gate, the "more than one outgoing edge" gate, the
     `x.transcript` gate, the `x.tool_trace` gate, the `max_traversals`
     gate, the back-edges gate (`hasCycle` call inside `capabilityGate`),
     and the four `limits.*` gates. Keep the tools (M3), fan-out (M4),
     steering (M3), and `serve` (M6) gates unchanged;
   - add the M2 rules of spec §11 after the existing E17 block, using the
     adjacency maps amendment 6.9 introduced:
     - E11 `route.required` (error, path `members[i]`): a model member with
       more than one outgoing edge and no `route`;
     - E11 `route.options` (error, path `members[i].route`): a model member
       with `route` and zero outgoing edges;
     - E11 `route.fallback` (error, path `members[i].route.fallback`):
       `route.fallback` set and neither `"pause"` nor the id of one of that
       member's outgoing edges;
     - E12 `route.when.missing` (warning, path `edges[j].when`): an outgoing
       edge of a member that has `route` and more than one outgoing edge,
       without `when`;
     - E13 `cycle.unbounded` (warning, path `edges`): compute the strongly
       connected components of the member graph with an iterative Tarjan
       walk over the adjacency map (members are bounded by `MAX_MEMBERS`);
       a component is a cycle when it has more than one member or one
       member with an edge to itself; it is unbounded when no member in it
       has `terminate`, no edge with both endpoints in it has
       `maxTraversals`, and no member in it has `route` together with an
       edge to a member outside it; one warning per unbounded cycle whose
       message lists the member ids;
     - E14 `x.transcript.snapcompact.vision` (error, path
       `edges[j].x.transcript`): `edge.x.transcript` is an object with
       `optimize === "snapcompact"` and the resolved model member `edge.to`
       (a string at M2) has a model whose `input` does not include `"image"`;
     - E15 `limits.target` (error, path `limits.limit_target`): the
       effective `on_limit` (`definition.limits?.onLimit ?? cfgMoaOnLimit.get(ctx.settings)`)
       is `"judge"` and `limits.limit_target` is undefined or is not the id
       of a model member;
     - E18 `verdict.question` (error, path `members[i].question`): a
       verdict member whose `question.type === "choice"` has fewer than two
       keys in `criteria`, or whose `question.type === "score"` has fewer
       than two entries in `criteria`.

5. `packages/coding-agent/test/helpers/moa-setup.ts`:
   - in `createMoaFixture`, register two more fake models:
     `fakeModel("jev")` and `fakeModel("summary")` (both text-only), so the
     provider has `writer`, `editor`, `other`, `jev`, `summary`;
   - export `COURTROOM_TOML`, the fixture of Step 4 item 7.

6. `packages/coding-agent/test/moa-validate.test.ts`:
   - delete `it("refuses route with unsupported.feature naming M2")`;
   - in the `it.each` of `"refuses %s"` delete the rows `"a back-edge"`,
     `"x.transcript"`, and `"a budget limit"`; keep `"tools on the terminal member"`,
     `"serve"`, `"steering"`;
   - replace `it("marks the M2 courtroom fixture unsupported")` with
     `it("accepts the M2 courtroom fixture with no errors")`: parse
     `COURTROOM_TOML` (import from `./helpers/moa-setup`) with `parseDoc`,
     `check(doc.mixtures[0], Settings.isolated({ "moa.summary_model": "fake/plain", modelRoles: { judge: "fake/plain" } }), doc)`
     (this file's registry has `fake/writer`, `fake/editor`, `fake/plain`
     and no `jev`; without a judge role the implicit chain resolves to no
     candidate and the routed fixture would be `helper.unresolved`), and
     assert `errors` is `[]`;
   - change the two assertions `expect(codes(result.errors)).toEqual(["unsupported.feature"])`
     (in `"filters the mixture out of a routed graph's implicit judge fallback"`
     and `"filters a model enabledModels excludes out of a routed graph's implicit judge fallback"`)
     to `expect(result.errors).toEqual([])`;
   - add to the `it.each` of `"reports %s at %s (%s)"` in
     `describe("validateMixture error codes")` one row per new error code,
     each built by mutating `linear()` or `routed()`: `route.required`
     (add a second edge from `writer` to a third member with no `route`),
     `route.options` (route on `editor`, which has no outgoing edge),
     `route.fallback` (`fallback = "nowhere"`), `x.transcript.snapcompact.vision`
     (`edges[0].x = { transcript: { optimize: "snapcompact" } }`; `fake/editor`
     is text-only), `limits.target` (`limits = { onLimit: "judge" }` with no
     target), `verdict.question` (a verdict member with a one-option choice);
   - add to `describe("validateMixture warnings")`:
     `it("warns route.when.missing on a routed member's edge without a rubric")`
     and `it("warns cycle.unbounded on a two-member cycle with no terminate, max_traversals, or exit route, and not when any of the three is present")`
     (four sub-cases in one test: bare cycle → exactly one `cycle.unbounded`
     warning; then add `terminate` → none; instead `maxTraversals` on the
     back edge → none; instead `route` on `writer` plus an edge to a third
     member → none);
   - add to `describe("model allow-list")`:
     `it("resolves moa.summary_model for a compact edge and reports helper.unresolved at summary when it is excluded")`:
     on `linear()` with `edges[0].x = { output: true, transcript: { optimize: "compact" } }`,
     `Settings.isolated({ "moa.summary_model": "fake/plain" })` resolves
     with no errors and `resolved.summaryModel` is `fake/plain`; with
     `enabledModels: ["fake/writer", "fake/editor"]` added, the only error
     is `helper.unresolved` at path `summary` with a message containing
     `excluded by enabledModels`; with `"moa.summary_model": "fake/nope"`
     the only error is `helper.unresolved` at `summary` containing
     `does not resolve`.

   Before Step 4's code changes: the three deleted/replaced gate tests
   PASS (the old text), the new tests FAIL or are absent. After: every
   test in the file PASSES.

7. The fixture. `COURTROOM_TOML` in `moa-setup.ts` is the spec §1.2
   document with fake selectors and the presets the spec elides supplied
   by the bundled files of item 1 (`defend`, `judge` envelopes; `defense`,
   `judge` roles). Verbatim:

   ```toml
   [envelopes]
   disagree = """
   The topic is: {{topic}}
   There are {{mixture.member_count}} participants. The previous turn was {{from.id}}.
   Your role is to disagree with {{from.id}} on the merits.
   {{> moa-parts}}
   """

   [roles]
   prosecution = "You argue the strongest case that the proposal is wrong. Be concrete."

   [[mixtures]]
   name = "courtroom"
   description = "Adversarial review with a judge"
   entry = "prosecution"

   [[mixtures.members]]
   id = "prosecution"
   description = "opens and presses the case against the proposal"
   model = "fake/writer"
   role = "prosecution"
   tools = false
   show = "always"

   [[mixtures.members]]
   id = "defense"
   description = "rebuts the prosecution point by point"
   model = "fake/editor"
   role = "defense"
   tools = false
   [mixtures.members.route]
   instructions = "Has the argument been exhausted, or is there a live point to rebut?"
   state = ["output"]
   min_confidence = 0.6
   fallback = "verdict"
   [mixtures.members.terminate]
   instructions = "Has the defense conceded the central claim?"
   threshold = 0.8

   [[mixtures.members]]
   id = "judge"
   description = "weighs both sides and writes the ruling"
   model = "fake/other"
   role = "judge"
   tools = false
   show = "final"

   [[mixtures.edges]]
   id = "open"
   from = "prosecution"
   to = "defense"
   x = { output = true }
   envelope = "disagree"

   [[mixtures.edges]]
   id = "rebut"
   from = "defense"
   to = "prosecution"
   x = { output = true, transcript = { optimize = "compact" } }
   envelope = "defend"
   when = "there is a specific, unanswered point the prosecution must address"
   max_traversals = 3

   [[mixtures.edges]]
   id = "verdict"
   from = "defense"
   to = "judge"
   x = { transcript = { optimize = "verbatim" } }
   envelope = "judge"
   when = "both sides have made their case and nothing new is being said"

   [mixtures.limits]
   max_hops = 12
   budget_usd = 4
   wall_clock_minutes = 60
   on_limit = "judge"
   limit_target = "judge"
   ```

8. Run the test command for `packages/coding-agent/test/moa-validate.test.ts`
   (before and after) and for `packages/coding-agent/test/moa-config.test.ts`
   (after; MUST still pass: the fixture change adds models only).

Exit condition: every test in `moa-validate.test.ts` passes;
`moa-config.test.ts` passes; the typecheck command exits 0.

Commit: subject `feat(moa): validate M2 graphs, bundle the courtroom presets, resolve the summary model`.

### Step 5: transit context (`x.transcript`, `x.tool_trace`)

Input state: Step 4 committed.

Actions:

1. Create `packages/coding-agent/src/moa/transcript.ts` with these exports:
   - `transcriptHeader(hop: Pick<HopRecord, "index" | "memberId" | "edgeInId">): string`
     returning `` `[hop ${hop.index} · ${hop.memberId} ← ${hop.edgeInId ?? "entry"}]` ``
     (spec §2.1: "a header line `[hop N · <member> ← <edge id | entry | steering | limit>]`");
   - `renderTranscript(hops: readonly HopRecord[]): string`: for every hop
     with `status === "done"`, in order, `transcriptHeader(hop) + "\n" + hop.output`,
     joined by `"\n\n"`; no envelope input is ever included;
   - `transcriptMessages(hops: readonly HopRecord[]): AgentMessage[]`
     (`AgentMessage` from `@oh-my-pi/pi-agent-core`): per done hop, one
     `user` message whose content is the header and one `assistant`
     message whose content is `[{ type: "text", text: hop.output }]`
     (fields required by the type set to the same neutral values the
     engine uses at `moa/engine.ts:516 (envelopeMessage)` and
     `moa/engine.ts:891 (emitted)`);
   - `toolCallSummaries(messages: readonly Message[]): { name: string; summary: string }[]`:
     one entry per `toolCall` block of every assistant message, `summary` =
     the string value of the argument named `i` or `intent` when present,
     else the first 120 characters of `JSON.stringify(arguments)`.
   No other export. The engine renders the tool trace as
   `renderToolTrace(toolCallSummaries(hop.messages))`.

2. `packages/coding-agent/src/moa/budget.ts`:
   - add `transcript?: string;` to `HopParts`;
   - change `PRIORITY` to `[["output"], ["input", "reasoning", "toolTrace"], ["conversation"], ["transcript"]]`
     (spec §4.6 order 2–5);
   - add `attachments?: readonly (TextContent | ImageContent)[]` to
     `FitHopRequest` (doc: `/** Blocks appended after the envelope text (snapcompact frames): irreducible, counted once. */`)
     and count them in `fixed` as
     `tokenizer.countMessages([{ role: "user", content: [...attachments], timestamp: 0 }])`
     when present.

3. `packages/coding-agent/src/moa/member-call.ts`: add
   `export function prepareHelperCall(outer: OuterStreamOptions, run: MixtureRun, model: Model<Api>, purpose: "summary", host: MixtureHost, entry: MixtureRunEntry): SimpleStreamOptions`
   with the same body as `prepareMemberCall` except: `sessionId` is
   `memberSessionId(run, purpose)`, provider state is keyed by `purpose`,
   `reasoning` and `maxTokens` come from `outer` only, and no
   `disableReasoning` override.

4. `packages/coding-agent/src/moa/engine.ts`, transcript part:
   - import `compact`, `getPreservedArchive`, `historyBlocks`,
     `providerFrameBudget`, `FRAME_TOKEN_ESTIMATE` from `@oh-my-pi/snapcompact`,
     and `generateSummary`, `DEFAULT_RESERVE_TOKENS` from
     `@oh-my-pi/pi-agent-core/compaction`;
   - add the field `#deadline: AbortSignal | undefined`, the method
     `#deadlineFired(): boolean` returning
     `this.#deadline?.aborted === true && this.#options.signal?.aborted !== true`,
     and `#callSignal(run, hop?: Pick<HopRecord, "edgeInId">): AbortSignal`.
     The exemption is decided from the **hop record the call is for**, never
     from `run.phase` (by the time `#generate` runs, `#hopReady` has already
     set the phase to `generating`): when `hop?.edgeInId === "limit"` (a
     limit hop, exempt from the deadline per spec §4.7 as amended) set
     `this.#deadline = undefined` and return
     `this.#options.signal ?? new AbortController().signal`; otherwise
     `minutes = run.resolved.definition.limits?.wallClockMinutes ?? cfgMoaWallClockMinutes.get(settings)`;
     `remaining = run.window.startedAt + minutes * 60_000 - Date.now()`;
     `this.#deadline = AbortSignal.timeout(Math.max(1, remaining))`; return
     `this.#options.signal ? AbortSignal.any([this.#options.signal, this.#deadline]) : this.#deadline`
     (spec §4.5 "Abort": "`options.signal` is combined with the run deadline
     into every member call and judgment"). Callers that are not a member
     call (the summary call in this step, the judge calls of Step 6) pass
     no `hop`. This step defines all three; Step 6 and Step 7 call them and
     add nothing to them;
   - add the module-level sentinel `const FINALIZED = new Error("mixture request finalized")`
     and the private helper `#guard(): void` that throws `FINALIZED` when
     `this.#finalized` is true. The guard rule, exhaustively: (a) inside
     `#transcriptPart`, `this.#guard();` is the first statement after every
     `await`; (b) inside `#completeViaHost`, `this.#guard();` follows the
     `prepareContext` await and precedes the `host.stream` call, so no
     stream starts after a finalization, but **no guard** sits between the
     `host.stream` await and the end of the drain loop: a stream that has
     started is always drained and its usage settled (late when finalized,
     spec §4.7 "Late settlements"), and the guard runs once more after the
     settlement; (c) in `#hopReady`, `if (this.#finalized) return;` is the
     first statement after the outer transcript `await` succeeds (a
     verbatim or under-budget transcript awaits nothing inside, so this is
     the only guard on that path), before any run mutation or hop
     allocation. A caller abort finalized during transcript work (spec
     §4.5 "Abort": the continuation after finalization is inert) therefore
     mutates no run state, starts no stream, and allocates no hop;
   - add `async #transcriptPart(run, edge, member, systemPrompt): Promise<{ text: string; blocks: (TextContent | ImageContent)[] }>`
     implementing spec §2.1 exactly:
     1. `spec = edge.x.transcript === true ? {} : edge.x.transcript`;
        `budget = spec.budgetTokens ?? cfgMoaTranscriptBudgetTokens.get(settings)`;
        `tokenizer = new Tokenizer(member.model)`; `done = run.hops.filter(status === "done")`;
     2. `full = renderTranscript(done)`; if `tokenizer.countTokens(full) <= budget`
        return `{ text: full, blocks: [] }`;
     3. `recent = done.slice(-2)`, `fold = done.slice(0, -2)`; when `fold`
        is empty return `{ text: full, blocks: [] }` (nothing to fold; §4.6
        fitting truncates the recent hops); otherwise
        `edgeId = mixtureEdgeId(edge)`, `cursor = run.summaries[edgeId] ?? { throughHop: 0 }`,
        `newFold = fold.filter(hop => hop.index > cursor.throughHop)`,
        `optimize = spec.optimize ?? "verbatim"`;
     4. `verbatim`: text = `` `[… ${fold.length} earlier hops omitted]\n\n${renderTranscript(recent)}` ``, no blocks, `summaries` untouched;
     5. `compact`: `summaryModel = run.resolved.summaryModel` (absent →
        throw `new Error("helper.unresolved: moa.summary_model is not resolved for this run")`;
        the caller in `#hopReady` turns thrown errors into the run error);
        when `newFold.length > 0`:
        `summary = await generateSummary(transcriptMessages(newFold), summaryModel, DEFAULT_RESERVE_TOKENS, apiKey, signal, undefined, cursor.text, { completeImpl })`
        where `apiKey = this.#host.resolver(summaryModel, memberSessionId(run, "summary"), () => {})`
        (when `resolver` returns undefined, throw
        `new Error("helper.unresolved: no credential for the summary model")`),
        `signal = this.#callSignal(run)`, and
        `completeImpl = (model, ctx, options) => this.#completeViaHost(run, model, ctx, options)`;
        then `run.summaries[edgeId] = { text: summary, throughHop: fold.at(-1)!.index }`;
        text = `` `[hops 1–${fold.at(-1)!.index} summarized]\n${run.summaries[edgeId].text}\n\n${renderTranscript(recent)}` ``;
     6. `snapcompact`: `frames = min(providerFrameBudget(member.model.provider), floor(remaining / FRAME_TOKEN_ESTIMATE))`
        where `remaining = max(0, (member.model.contextWindow ?? Number.POSITIVE_INFINITY) - reserveOutput - tokenizer.countTokens([...systemPrompt]) - budget)`
        and `reserveOutput = member.maxTokens ?? Math.min(member.model.maxTokens ?? 16_384, 16_384)`
        (the same formula as `moa/budget.ts:89 (reserveOutput)`); when
        `frames < 1`, log `logger.warn("mixture transcript degraded to compact", { mixture: run.key.mixture, edge: edgeId, reason: "no frame budget" })`
        and take the `compact` path for this traversal; else when
        `newFold.length > 0`:
        `result = await compact({ firstKeptEntryId: \`moa:${run.id}:${edgeId}:${cursor.throughHop}\`, messagesToSummarize: transcriptMessages(newFold), turnPrefixMessages: [], tokensBefore: tokenizer.countMessages(transcriptMessages(fold)), previousPreserveData: cursor.preserveData, fileOps: [] }, { model: member.model, includeThinking: false, maxFrames: frames })`;
        `archive = getPreservedArchive(result.preserveData)`; when
        `archive` is undefined, log the same warning with
        `reason: "no archive"` and take the `compact` path;
        else `run.summaries[edgeId] = { text: result.summary, preserveData: result.preserveData, throughHop: fold.at(-1)!.index }`,
        text = `` `${result.summary}\n\n${renderTranscript(recent)}` ``,
        blocks = `historyBlocks(archive)`; when `newFold.length === 0`
        reuse `cursor.text` and `historyBlocks(getPreservedArchive(cursor.preserveData))`
        (empty when undefined);
   - add `async #completeViaHost(run, model, ctx, options): Promise<AssistantMessage>`:
     `prepared = await this.#host.prepareContext(ctx, model)`; `this.#guard()`;
     `stream = await this.#host.stream(model, prepared, { ...options, ...prepareHelperCall(this.#options, run, model, "summary", this.#host, this.#entry), signal: options.signal })`;
     iterate to the `done` or `error` event with no guard before or inside
     the loop (guard rule (b)); settle
     `{ kind: "summary", hop: undefined, api, provider, model, usage, stopReason, errorMessage, failed }`
     through `#settle(run, undefined, …)` when the message has `usage`;
     then `this.#guard()`; on `error` throw `new Error(errorMessage)`;
     return the message;
   - `#settle` (line 834): change the `hop` parameter to `hop: HopRecord | undefined`
     and skip the hop-usage accumulation when it is undefined;
   - `#hopReady` (line 448): after `envelopeContext` is built and before
     `assemble`, when `edge?.x.transcript` is set:
     ```ts
     let transcript: { text: string; blocks: (TextContent | ImageContent)[] };
     try {
     	transcript = await this.#transcriptPart(run, edge, member, systemPrompt);
     } catch (error) {
     	if (this.#finalized) return;
     	if (this.#deadlineFired()) return this.#onTranscriptDeadline(run);
     	return this.#fail(run, undefined, {
     		kind: "failed",
     		message: `helper.failed: transcript for edge ${mixtureEdgeId(edge)}: ${error instanceof Error ? error.message : String(error)}`,
     	});
     }
     if (this.#finalized) return;
     ```
     where `#onTranscriptDeadline(run)` in this step is
     `this.#fail(run, undefined, { kind: "failed", message: "helper.failed: the run deadline expired while preparing the transcript" })`
     (Step 7 replaces that body with the wall-clock limit action; the phase
     is still `hop_ready`, so the continuation is already normalized and no
     hop exists to mark). Then set `envelopeContext.x.transcript = transcript.text`
     and keep `transcript.blocks`; when `edge?.x.toolTrace` is set and
     `source` exists, `envelopeContext.x.tool_trace = source.toolTrace`;
     pass `transcript` through `assemble` (`x: { …, transcript: parts.transcript }`)
     and `partsOf` (add `transcript: x.transcript`); pass
     `attachments: transcript.blocks` to `fitHopRequest`; build
     `envelopeMessage.content` as `[{ type: "text", text: input }, ...transcript.blocks, ...(entry hop ? topicImages : [])]`.
     The `HopRecord` is created after this block, as at M1, so a transcript
     failure or abort allocates no hop;
   - `#afterGenerate` (line 641): set `hop.toolTrace = renderToolTrace(toolCallSummaries(hop.messages))`
     after `hop.reasoning` (at M2 this is `""` because every member has
     tools off; the seam exists for M3);
   - `#envelopeContext` (line 539): copy `source.toolTrace` into
     `x.tool_trace` when `edge.x.toolTrace` (this is the same assignment as
     the bullet above; implement it once, here).

5. Create `packages/coding-agent/test/moa-transit.test.ts`. Use the
   `FakeMembers`/`createMoaFixture`/`createMoaSession` harness of
   `moa-engine.test.ts` (copy the `beforeEach`/`afterEach` shape and the
   `mixtureSession`-style helper; the file MAY duplicate those private
   helpers, with the model looked up by name: the sessions in this file
   select `mixture/cycle`). A two-member cycle fixture (local constant
   `CYCLE_TOML` in the test file): `name = "cycle"`; `a` (`fake/writer`,
   `system_prompt = "a"`, `tools = false`) → `b` (`fake/editor`,
   `system_prompt = "b"`, `tools = false`) → `a`; `entry = "a"`; edge
   `a->b` with `x = { output = true }`; edge `b->a` with
   `x = { transcript = <the spec under test> }` and `max_traversals = 3`;
   `limits = { max_hops = 8, on_limit = "stop" }`; no `route`, no
   `terminate` (each member has one outgoing edge, so no judge is asked).
   Each test that needs a variant builds it by `String.prototype.replace`
   on `CYCLE_TOML`. The run visits a(1) b(2) a(3) b(4) a(5) b(6) a(7) b(8)
   and stops at the hop limit before a(9); the edge `b->a` is traversed at
   the builds of hops 3, 5, and 7. Every `writer` and `editor` reply in
   these session tests is scripted with `text` = the word `lorem` repeated
   80 times followed by a space and the reply's ordinal (`lorem … lorem 1`),
   so that any two hops exceed a `budget_tokens` of 40. At hop 3 the fold
   is empty (two done hops); at hop 5 the fold is hops 1–2; at hop 7 the
   fold is hops 1–4 and the new fold is hops 3–4. Tests:
   - `it("renders the canonical transcript with one header per completed hop and no envelope inputs")`
     (unit: `renderTranscript` over three hand-built `HopRecord`s, one
     `failed`, asserting the two headers and that `hop.input` text is
     absent);
   - `it("sends the transcript verbatim under budget and replaces the fold with the omission marker over it")`
     (session; `transcript = { budget_tokens = 40 }`; assert the envelope
     of hop 3 contains `[hop 1 · a ← entry]` and `[hop 2 · b ← a->b]` and
     no `omitted` marker; the envelope of hop 5 contains
     `[… 2 earlier hops omitted]`, `[hop 3 · a ← b->a]`, `[hop 4 · b ← a->b]`,
     and not `[hop 1`; the envelope of hop 7 contains `[… 4 earlier hops omitted]`);
   - `it("summarizes only hops after throughHop on the second traversal and settles each summary call")`
     (session; `transcript = { optimize = "compact", budget_tokens = 40 }`,
     `Settings.isolated({ ...SETTINGS, "moa.summary_model": "fake/summary" })`;
     script `summary` with `{ text: "SUMMARY-1", cost: 0.02 }` then
     `{ text: "SUMMARY-2", cost: 0.02 }`; assert: `members.callsTo("summary")`
     has exactly two calls; the first summary call's context text contains
     `lorem … lorem 1` and `lorem … lorem 2` and not `lorem … lorem 3`; the
     second summary call's context text contains `SUMMARY-1`, `lorem … lorem 3`
     and `lorem … lorem 4`, and not `lorem … lorem 1`; the envelope of hop 5
     contains `SUMMARY-1` and the envelope of hop 7 contains `SUMMARY-2`;
     the outer message's `usageBreakdown` has exactly two entries with
     `kind: "summary"`; `session.getSessionStats()` total cost equals the
     sum of every member and summary cost);
   - `it("attaches the snapcompact archive blocks to a vision target and degrades to compact when the frame budget is zero")`
     (session; `transcript = { optimize = "snapcompact", budget_tokens = 40 }`
     on `b->a`, whose target `fake/writer` accepts images;
     `"moa.summary_model": "fake/summary"`; in the first session assert the
     envelope message of hop 5 (the first `user` message of that `writer`
     call's context) has its first block of type `text` and at least one
     later block of type `image`, and `members.callsTo("summary")` is
     empty (`compact` from snapcompact rasterizes; it calls no model);
     then record `const before = members.calls.length` and run a second
     session on a copy of the fixture where member `a` has
     `max_tokens = 60000` (so `remaining < FRAME_TOKEN_ESTIMATE` against
     `fake/writer`'s 64 000 window): the hop-5 envelope message has no
     `image` block, the `summary` calls among `members.calls.slice(before)`
     number exactly two (hop 5's fold and hop 7's new fold, both degraded),
     and a `vi.spyOn(logger, "warn")` spy saw two calls whose first
     argument is `"mixture transcript degraded to compact"` and whose
     second argument has `edge: "b->a"`). This test runs the real
     `@oh-my-pi/snapcompact` package; see §0.3 for the native-addon stop
     condition;
   - `it("fails the run at hop_ready when the summary call fails, keeping the completed hops and the summary's settled usage")`
     (session; `optimize = "compact"`; script `summary` with
     `{ error: { message: "summary down" }, cost: 0.02 }`; assert the outer
     message has `stopReason: "error"` and an `errorMessage` starting with
     `helper.failed: transcript for edge b->a:`, exactly four member calls
     (`writer, editor, writer, editor`) and no fifth, the newest checkpoint
     has `reason: "error"` with `run.phase.kind === "hop_ready"` and
     `run.phase.memberId === "a"` and four `done` hops, and the outer
     message's `usageBreakdown` contains one entry with `kind: "summary"`);
   - `it("settles a summary that lands after a caller abort late, and allocates no hop for it")`
     (session; `optimize = "compact"`; script `summary` with
     `{ text: "S", cost: 0.02, waitForAbort: true, abortedAfter: <a Promise.withResolvers<void>().promise> }`,
     the shape `abortDuringEditor` in `moa-engine.test.ts:137` uses for a
     member; start `session.sendUserMessage("go")`, poll
     `while (members.callsTo("summary").length === 0) await Bun.sleep(5)`,
     `await session.abort()`, await the turn's promise with a caught
     rejection, then resolve the `abortedAfter` resolver and
     `await Bun.sleep(20)` so the late settlement lands; assert the
     persisted abort message has `stopReason: "aborted"`, the abort
     checkpoint's `run.hops.length` is `4` (no fifth hop), the branch has
     exactly one `model_usage` entry with `purpose: "moa"` whose `model` is
     `summary` (the late settlement, spec §4.7), and `members.callsTo("writer")`
     has two calls (hops 1 and 3 only));
   - `it("renders one tool-trace line per tool call with the intent argument or an argument preview")`
     (unit: `renderToolTrace(toolCallSummaries([...]))` over an assistant
     message with two `toolCall` blocks, one with `i: "reading foo"`, one
     with a long `arguments` object; assert both lines and the 120-char
     cut);
   - `it("fits the transcript after the conversation and drops it before the recent parts")`
     (unit: `fitHopRequest` with `parts: { output, conversation, transcript }`
     on a target whose window admits output and conversation but not the
     transcript; assert `parts.transcript` is `""`/absent and `output` is
     intact; then a window that admits everything keeps all three).

   Every test is new; the before run records FAIL for all eight (the file
   does not load until `moa/transcript.ts` exists); after: all PASS.

6. Run the test command for `packages/coding-agent/test/moa-transit.test.ts`.
   If the snapcompact test throws with a native-addon message, STOP (§0.3);
   otherwise all eight MUST PASS. Run `packages/coding-agent/test/moa-engine.test.ts`
   (MUST still pass).

Exit condition: `moa-transit.test.ts` passes; `moa-engine.test.ts` passes;
the typecheck command exits 0.

Commit: subject `feat(moa): transit transcript with verbatim, compact, and snapcompact folds, and the tool trace`.

### Step 6: graph control (terminate, route, verdict, decisions)

Input state: Step 5 committed.

Actions:

1. Create `packages/coding-agent/src/moa/decisions.ts` with the pure state
   builders (spec §5 "Decision states are narrow and typed, never the
   envelope"):
   - `export function decisionState(parts: Record<string, string | undefined>, cap: number, tokenizer: Tokenizer): Record<string, string>`:
     every defined part truncated with `truncateToTokens(text, cap, tokenizer)`
     (`moa/budget.ts:54`); undefined parts omitted;
   - `export function routeQuestion(route: RouteCondition, edges: readonly MixtureEdge[]): ChoiceQuestion`:
     `{ type: "choice", instructions: route.instructions, criteria: Object.fromEntries(edges.map(edge => [mixtureEdgeId(edge), edge.when ?? null])) }`;
   - `export function terminateQuestion(terminate: TerminateCondition): NoulQuestion`:
     `{ type: "noul", instructions: terminate.instructions, criteria: terminate.criteria }`;
   - `export function describeOutcome(decision: Pick<MixtureDecision, "kind" | "answer" | "confidence" | "judgeKind">, extra?: { fallbackTo?: string; floor?: number; failed?: true }): string`
     producing exactly the phrases of amendment 6.11 R10: route →
     `` `fallback → ${fallbackTo} (judgment failed)` `` when `extra.failed`,
     `` `fallback → ${fallbackTo} (${confidence.toFixed(2)} < ${floor.toFixed(2)})` ``
     when `fallbackTo` is set without `failed`,
     `` `→ ${answer.choice} (floor inactive)` `` when `judgeKind !== "native"`,
     else `` `→ ${answer.choice} ${confidence.toFixed(2)}` ``; terminate →
     `` `${noul >= threshold ? "yes" : "no"} ${noul.toFixed(2)}` `` (the
     caller passes the threshold through `extra.floor`); verdict →
     `` `${label} ${confidence.toFixed(2)}` `` where `label` is `answer.choice`
     for a choice, `String(answer.score)` for a score, and `yes`/`no` by
     `noul >= 0.5` for a noul (with `noul.toFixed(2)` as the number).
   - `export function failedChoice(labels: readonly string[]): ChoiceAnswer`:
     `{ type: "choice", choice: "", probabilities: Object.fromEntries(labels.map(label => [label, 0])), confidence: 0 }`,
     the answer a decision records when its judgment threw.

2. `packages/coding-agent/src/moa/engine.ts`, decisions:
   - add `async #judge(run, hop, request: JudgmentRequest): Promise<{ result: JudgmentResult; kind: JudgeKind }>`:
     `plan = run.resolved.judgePlan` (undefined → throw `new Error("no judge plan")`);
     `judge = this.#host.judge(plan, attempt => this.#settle(run, hop, { kind: "judge", hop: hop.index, api: attempt.api, provider: attempt.provider, model: attempt.model, usage: attempt.usage, stopReason: attempt.stopReason, errorMessage: attempt.errorMessage, failed: attempt.stopReason === "error" || attempt.stopReason === "aborted" || undefined }))`;
     `signal = this.#callSignal(run)`; return
     `judge.withCandidate(async (candidate, kind) => ({ result: await candidate.judge(request, { signal }), kind }), { signal })`.
     The engine never adds `result.usage` to any total (spec §5).
   - add `#decisionTokenizer(run): Tokenizer` = `new Tokenizer(run.resolved.judgePlan?.[0]?.model ?? null)`.
   - `#loop` (line 424), case `"decision_pending"`: `await this.#decide(run, phase.hop);`
     (it is synchronous at M1); after the await, `if (this.#finalized) return;`
     before `break`, so an abort finalized during a judgment starts nothing.
   - in `#decide` and `#verdictHop`, immediately after every `await` of
     `#judge` (in both the success path and every `catch`), the first
     statement is `if (this.#finalized) return;`: a caller abort during a
     judgment has already finished the request (`#finalizeAbort`, which
     leaves a `done` hop untouched and keeps `decision_pending` as the
     continuation), and the rejected judgment must produce no decision, no
     pause, and no second response.
   - add `#pause(run, member: string, reason: string): void` (spec §4.7 as
     amended by 6.11 R6; this step is its first consumer, the route
     fallback): `run.status = "paused"` (the phase is unchanged and is the
     continuation);
     `text = renderPauseNotice({ mixture: run.key.mixture, member, reason, hops: run.lifetime.hops, usd: run.lifetime.usd.toFixed(2) })`;
     `this.#writer.appendText(this.#streamedLive ? \`\n\n${text}\` : text)`;
     `pending = { responseId: this.#nextResponseId(run), content: structuredClone(this.#writer.message.content), stopReason: "stop" }`;
     `record = this.#recordResponse(run, pending, "responded")`;
     `this.#checkpoint(run, "pause", record, \`paused at ${member}\`)`;
     `this.#finishWith(run, record, { kind: "done", reason: "stop" })`. No
     `run_end` event. The `#streamedLive` branch matters only from Step 7
     on (a live hop can be deadline-aborted before a pause); it is written
     here once.
   - `#checkpoint` (line 903): emit the `checkpoint` trace (card) when
     `reason === "abort"` **or** `reason === "pause"` (the M1 code emits it
     for `abort` only).
   - **hop publication.** `packages/coding-agent/src/moa/types.ts`,
     `interface HopRecord`: add `published?: true;` with the doc comment
     `/** Its hop_end trace was emitted; a resumed decision never publishes it twice. */`.
     Add `#publishHop(run, hop, member, edgeOutId?): void`: `if (hop.published) return;`
     `hop.published = true;` then emit `hop_end` with
     `this.#hopTrace(run, hop, member, edgeOutId)`. Every `hop_end`
     emission in `#decide` and `#verdictHop` goes through `#publishHop`
     (M1's direct emits at `engine.ts:683` and `:692` become
     `#publishHop` calls). The contract, in addition to spec §4.5 step 5
     (publish after the decision, visibility from the member's `show` and
     the taken edge's `show`): when the decision phase **leaves without
     taking an edge and without ending the run at this hop** (a pause, a
     soft-limit action, or a hard-cap stop taken from `decision_pending`),
     the completed deciding hop is published first, with
     `hop.visible = member.show === "always"` (no edge was taken, so no
     edge `show` applies), so the persisted trace and the panel carry
     every completed hop; when a paused run later resumes at
     `decision_pending` and takes an edge, `#publishHop` is a no-op and the
     card published at the pause stands (its `edgeOutId` is absent; the
     `decision` card that follows carries the route). Add
     `#leaveDecision(run, hop, member): void`:
     `if (hop.visible === undefined) hop.visible = member?.kind !== undefined && member.show === "always"; this.#publishHop(run, hop, member);`
     and call it as the first statement of every such exit: inside
     `#onJudgeFailure` (both kinds), before the route `#pause` in item 4,
     and as the `onFire` callback of the limit checks Step 7 inserts (Step
     7 defines `#checkLimits(run, at, onFire?)` and calls `onFire` before
     acting). `#fail` keeps emitting the failed hop's `hop_end` directly (a
     failed hop is never `published`).
   - rewrite `#decide` (line 667) as `async #decide(run, hopIndex)` with
     this order:
     1. `hop`, `member` as today, then
        `outgoing = run.resolved.definition.edges.filter(edge => edge.from === hop.memberId)`;
        this step writes no limit check here; Step 7 inserts one as the
        next statement;
     2. **limit hop** (`hop.edgeInId === "limit"`): `hop.visible = false`,
        `run.final = { text: hop.output, hop: hop.index }`,
        `run.endReason = \`limit:${run.limitHop!.kind}\``, `phase: finalizing`,
        `#publishHop(run, hop, member)`, checkpoint `decision`, return;
     3. `definitionMember = run.resolved.definition.members.find(id === hop.memberId)`;
        **terminate**: when `definitionMember.kind !== "verdict"` and
        `definitionMember.terminate` is set: `threshold = terminate.threshold ?? 0.5`
        (spec §1.3 default); state = `decisionState({ topic: run.topic, output: hop.output, ...(terminate.state ?? []).map(part → source part of this hop) }, cfgMoaDecisionStateTokens, tokenizer)`;
        `try { { result, kind } = await this.#judge(run, hop, { state, questions: { terminate: terminateQuestion(terminate) } }) } catch (error) { if (this.#finalized) return; return this.#onJudgeFailure(run, hop, member, "terminate", error) }`
        where `#onJudgeFailure(run, hop, member, kind: "terminate" | "route", error)` in
        this step is: `this.#leaveDecision(run, hop, member)` (the hop
        publication above), then
        `this.#pause(run, hop.memberId, \`${kind} judgment at ${hop.memberId} failed: ${message}\`)`
        for `terminate`; it is not reached for `route` in this step (the
        route path below handles its own failure); Step 7 inserts the
        deadline branch into `#onJudgeFailure` after the `#leaveDecision`
        call;
        `answer = result.answers.terminate`; decision =
        `{ kind: "terminate", answer, judge: \`${result.provider}/${result.model}\`, judgeKind: kind, outcome: describeOutcome(…, { floor: threshold }) }`;
        push it, emit `decision` (trace `{ kind: "decision", hop: hop.index, memberId, decision }`);
        when `answer.noul >= threshold`: `hop.visible = false`,
        `run.final = { text: hop.output, hop: hop.index }`,
        `run.endReason = "terminate"`, `phase: finalizing`,
        `#publishHop(run, hop, member)`, checkpoint `decision`, return;
     4. **eligible edges**: `eligible = outgoing.filter(edge.maxTraversals === undefined || (run.traversals[id] ?? 0) < edge.maxTraversals)`;
        this step writes no limit check here; Step 7 inserts one as the
        next statement, taken only when a `terminate` judgment ran in item
        3 and `eligible.length >= 2`;
        zero → terminal exactly as M1's terminal branch (`endReason: "terminal"`);
        one → take it exactly as M1's edge branch (no judge);
        two or more → **route** (validation guarantees `route` exists;
        absent at runtime → `#fail` with `route.required`):
        state = `decisionState({ topic, output, ...route.state extras }, …)`;
        `question = routeQuestion(route, eligible)`; `minConfidence = route.minConfidence ?? cfgMoaJudgeMinConfidence.get(settings)`;
        `try { { result, kind } = await this.#judge(run, hop, { state, questions: { route: question } }) ; answer = result.answers.route; confidence = answer.confidence; chosen = answer.choice; judge = \`${result.provider}/${result.model}\` } catch (error) { if (this.#finalized) return; if (this.#judgeDeadline(error)) return this.#onJudgeFailure(run, hop, member, "route", error); failed = true; confidence = 0; answer = failedChoice(eligible ids); kind = "online"; judge = "failed" }`
        where `#judgeDeadline(error): boolean` in this step returns `false`
        (Step 7 gives it its body: `this.#deadlineFired()`);
        `floorActive = !failed && kind === "native"`;
        `below = failed || (floorActive && confidence < minConfidence)`;
        when `below`: `fallback = route.fallback`; when `fallback` is the
        id of an eligible edge → take that edge, `outcome = describeOutcome(…, { fallbackTo: fallback, floor: minConfidence, failed: failed || undefined })`;
        else → push the decision with `outcome = describeOutcome(…, { fallbackTo: "pause", floor: minConfidence, failed: failed || undefined })`,
        emit `decision`, then `this.#leaveDecision(run, hop, member)`, then `#pause(run, hop.memberId, failed ? \`route judgment at ${hop.memberId} failed and its fallback is pause\` : \`route from ${hop.memberId} fell below its confidence floor (${confidence.toFixed(2)} < ${minConfidence.toFixed(2)}) and its fallback is pause\`)`
        and return (spec §5: "fallback if eligible, else pause, never a
        silent default edge"); when not `below` → take `chosen`,
        `outcome = describeOutcome(…)` (`(floor inactive)` when `kind !== "native"`);
        in every take-edge case push the decision, emit `decision` before
        the hop is published, then the M1 edge branch (traversal count,
        `show`, `hop_ready` for `edge.to`, `#publishHop(run, hop, member, edgeId)`,
        checkpoint `decision`); the terminal (zero eligible) branch likewise
        ends with `#publishHop(run, hop, member)`.
   - **verdict hop.** In `#hopReady` (line 448), first move the two
     declarations `const edge = …` (line 459) and `const source = …`
     (line 462) to directly **above** `const member = run.resolved.members[memberId];`
     (line 455): neither reads `member`, and the dispatch below needs them.
     Then replace the M1 refusal `member ${memberId} cannot run in this build`
     (the `if (member?.kind !== "model")` branch, lines 456–458) with:
     `if (member?.kind === "verdict") return this.#verdictHop(run, member, edge, source);`
     `if (member?.kind !== "model") return this.#fail(run, undefined, { kind: "failed", message: \`member ${memberId} is not defined\` });`
     Everything after (the template, envelope context, tokenizer, fit) is
     unchanged and stays model-only. `#verdictHop`:
     1. the limit checks at the top of `#hopReady` already ran;
     2. create the `HopRecord` as `#hopReady` does (`input: ""`,
        `messages: []`), push it, `lifetime.hops++`, `window.hops++`,
        `activeMemberId`, `phase: { kind: "generating", hop }`, emit
        `hop_start` with `model` = the first judge plan candidate's model
        (the `hop_start` event requires one; the trace's `model` string is
        `"verdict"`);
     3. state: the declared parts of the inbound edge from `source`
        (`output`, `input`, `reasoning`, `toolTrace` as `x` declares; a
        declared `transcript` renders `renderTranscript(done hops)`),
        restricted to `member.state` when set, plus `topic`, each capped
        by `decisionState`;
     4. `try { { result, kind } = await this.#judge(run, hop, { state, questions: { verdict: member.question } }) } catch (error) { if (this.#finalized) return; if (this.#judgeDeadline(error)) return this.#onVerdictDeadline(run, hop); return this.#fail(run, hop, { kind: "failed", message: \`verdict.failed: ${message}\` }) }`;
        then `if (this.#finalized) return;`. `#onVerdictDeadline(run, hop)`
        in this step is the same `#fail` call with the message
        `verdict.failed: the run deadline expired`; Step 7 replaces its
        body. The `#fail` path marks the verdict hop `failed` and
        normalizes the continuation to `hop_ready` for the verdict member
        (spec §4.5), so a retry redoes the verdict;
     5. `answer = result.answers.verdict`; `confidence` = `answer.confidence`
        for choice/score, undefined for noul; decision `{ kind: "verdict", answer, confidence, judge, judgeKind: kind, outcome: describeOutcome(…) }`;
        `hop.output = renderVerdict(member.render, { member: { id: member.id, description: member.description }, question: member.question, answer, confidence, judge, judgeKind: kind })`
        (`VerdictInput` of Step 4; numbers stay numbers here);
        `hop.decisions = [decision]`, `hop.status = "done"`, `hop.elapsedMs`,
        `hop.visible = false`, emit `decision`, `run.final = { text: hop.output, hop: hop.index }`,
        `run.endReason = "verdict"`, `phase: finalizing`,
        `#publishHop(run, hop, member)` (trace `model: "verdict"`),
        checkpoint `decision`.
   - `#finalizeAbort` (line 775) needs no change: a verdict hop in flight
     has `status: "running"` and normalizes to `hop_ready` for the verdict
     member.

3. `packages/coding-agent/src/moa/host.ts`:
   - `MixtureSessionEvent` (line 31): add
     `| { type: "mixture_decision"; details: Extract<MixtureTraceDetails, { kind: "decision" }> }`;
   - `onEvent` (line 116): add `case "decision": persistCard(event.trace); deps.emit({ type: "mixture_decision", details: event.trace }); return;`;
   - `traceSummary` (line 61): a `decision` summary is the card title of
     item 4 without the mixture prefix.

4. `packages/tui/src/chat/mixture-trace.ts`, `mixtureTraceTitle` (line 29),
   `case "decision"`: return
   `` `${details.mixture} · hop ${details.hop} · ${details.decision.kind} ${details.decision.outcome} · ${details.decision.judge} (${details.decision.judgeKind})` ``.

5. `packages/coding-agent/src/modes/controllers/event-controller.ts`, in
   the handler map beside `mixture_limit` (line 313): add
   `mixture_decision: async e => this.#showMixtureTrace(e.details),`.
   Nothing in M2 references a side panel: the side-panel lane's Phase 3
   plan owns the panel's consumption of `mixture_decision` and of
   `/mixture reset` (Step 9), and lands after M2.

6. `packages/coding-agent/test/moa-trace-ui.test.ts`: add
   `it("titles a decision card with its outcome, judge, and kind")`
   rendering a `decision` details object (copy the header shape the file
   already builds) with `decision: { kind: "route", answer: { type: "choice", choice: "rebut", probabilities: { rebut: 0.71, verdict: 0.29 }, confidence: 0.71 }, confidence: 0.71, judge: "fake/jev", judgeKind: "native", outcome: "→ rebut 0.71" }`
   and asserting the rendered first line contains
   `hop 3 · route → rebut 0.71 · fake/jev (native)`.

7. `packages/coding-agent/test/moa-engine.test.ts`. First change the two
   file-local helpers so a test can select any registered mixture:
   `mixtureModel(name = "draft-then-edit")` looks up
   `fixture.registry.find("mixture", name)` and names `name` in its error;
   `mixtureSession(toml = DRAFT_THEN_EDIT_TOML, sessionManager?, settings = Settings.isolated(SETTINGS), name = "draft-then-edit")`
   passes `mixtureModel(name)` to `setModel`. Every existing caller is
   unchanged by the defaults. Add the file-local constant
   `const COURTROOM_SETTINGS = { ...SETTINGS, "moa.summary_model": "fake/summary", modelRoles: { judge: "fake/jev" }, "retry.fallbackChains": { judge: [] } }`
   (the empty fallback chain pins the judge plan to exactly `fake/jev`:
   `resolveRoleChain` at `packages/coding-agent/src/config/model-resolver.ts:1538`
   uses a configured chain, even an empty one, instead of the priority
   defaults) and the helper
   `courtroomSession(toml = COURTROOM_TOML, settings = Settings.isolated(COURTROOM_SETTINGS), sessionManager?: SessionManager)`
   = `mixtureSession(toml, sessionManager, settings, "courtroom")`. Then add
   `describe("graph control in a session", …)` on `courtroomSession()`.
   The chat judge answers through `FakeMembers`: a route reply is the
   chosen edge id as text (`"rebut"` / `"verdict"`), a terminate reply is
   `"no"` / `"yes"` (`packages/ai/src/judgment/text.ts:231 (parseAnswer)`
   parses a single-question reply as the whole completion text). The judge
   is asked once per decision, terminate before route, so the `jev` script
   order for one defense hop is `[terminate reply, route reply]`. Tests:
   - `it("routes on the judge's choice, records the decision card, and counts the traversal")`:
     script `jev`: `"no"`, `"rebut"`, then `"no"`, `"verdict"`; assert
     member call order `writer, editor, writer, editor, other`; the outer
     text is `other`'s reply; `traceCards` contain two `decision` cards
     with `decision.kind === "route"`, the first `outcome` equal to
     `"→ rebut (floor inactive)"`; and the persisted `done` checkpoint's
     `run.traversals.rebut` is `1`;
   - `it("takes the single eligible edge without asking the judge once max_traversals exhausts the other")`:
     `courtroomSession(COURTROOM_TOML.replace("max_traversals = 3", "max_traversals = 1"))`;
     script `jev`: `"no"`, `"rebut"`, `"no"`; assert member call order
     `writer, editor, writer, editor, other`, `members.callsTo("jev")` has
     exactly three calls (the second defense hop asked terminate only), and
     the second `decision` card of kind `route` does not exist (only one
     route decision card in `traceCards`);
   - `it("ends by terminate when the noul answer meets the threshold, before routing")`:
     script `jev`: `"yes"`; assert `callsTo("jev")` has one call, the outer
     text is `editor`'s reply, the `done` checkpoint's `run.endReason` is
     `"terminate"`, and the decision card `outcome` starts with `"yes 1.00"`;
   - `it("ends by verdict with the rendered answer as the outer text, counting the verdict hop")`:
     a local two-member fixture (constant `VERDICT_TOML` in the test file):
     ```toml
     [[mixtures]]
     name = "verdict-test"
     entry = "a"

     [[mixtures.members]]
     id = "a"
     model = "fake/writer"
     system_prompt = "Argue."
     tools = false

     [[mixtures.members]]
     id = "v"
     kind = "verdict"
     [mixtures.members.question]
     type = "choice"
     instructions = "Which side won?"
     [mixtures.members.question.criteria]
     proposal = "the proposal won"
     nobody = "no one won"

     [[mixtures.edges]]
     from = "a"
     to = "v"
     x = { output = true }
     ```
     registered through `mixtureSession(VERDICT_TOML, undefined, Settings.isolated(COURTROOM_SETTINGS), "verdict-test")`;
     script `jev`: `"proposal"`; assert the outer text contains
     `Verdict of v` and `Answer: proposal`, the `done` checkpoint's
     `run.lifetime.hops` is `2`, `run.endReason` is `"verdict"`, and the
     verdict hop's card has `model: "verdict"`;
   - `it("reports the confidence floor inactive and names the fallback model on a chat judge")`:
     as the first test's run; assert every route decision card has
     `judgeKind: "online"`, `judge: "fake/jev"`, and an `outcome` ending
     with `"(floor inactive)"` (spec §14 M2: "the trace names the fallback
     model, and the confidence floor is reported as inactive");
   - `it("pauses on a failed route judgment instead of taking a default edge")`:
     `courtroomSession(COURTROOM_TOML.replace('fallback = "verdict"', 'fallback = "pause"'))`
     (with `fallback = "verdict"` the fixture's eligible fallback would be
     taken instead, which is the specified behaviour, not a pause); script
     `jev`: `"no"`, then `{ error: { message: "judge down" } }` three
     times (unused scripted replies are discarded with the `FakeMembers`
     instance); assert the outer text starts with
     `⏸ courtroom paused at defense after 2 hops`, the newest checkpoint
     has `reason: "pause"` with `run.phase.kind === "decision_pending"`,
     `members.callsTo("writer")` and `members.callsTo("editor")` have one
     call each, `traceCards` has exactly two `hop` cards (hop 1 from its
     route decision, hop 2 published by `#leaveDecision` before the pause,
     with `visible: true` and an output body, since `defense` has the
     default `show = "always"`), the hop-2 `hop` card comes after both
     hop-2 `decision` cards and before the `checkpoint` card with
     `reason: "pause"`, and the second decision card for hop 2 has
     `outcome === "fallback → pause (judgment failed)"` and
     `judge === "failed"`.
   - `describe("confidence floor on a native judge", …)` using the direct
     host pattern of `describe("engine contract through a session host")`
     (`createSessionMixtureHost` + `streamMixture` on `mixture/courtroom`,
     the fixture registered from `COURTROOM_TOML` or its `fallback` variant
     as each test states), overriding `judge` on the host object
     (`{ ...host, judge: () => scriptedJudge }`) with a scripted
     `MixtureJudge` whose `withCandidate(run)` returns
     `run(scripted, "native")`, where `scripted.judge(request)` answers
     every id in `request.questions` by type: a `noul` question →
     `{ type: "noul", noul: 0 }`; a `choice` question →
     `{ type: "choice", choice: <the first key of criteria>, probabilities: <1 for that key, 0 for the others>, confidence: <the test's configured value> }`;
     returns `{ api: "typesafe", provider: "typesafe", model: "jev-latest", answers, usage: zeroUsage() }`
     (`zeroUsage` from `moa/outer-stream.ts`) and calls no `onAttempt`
     (so the run's judge settlements are empty in this describe). The
     first key of the defense member's eligible-edge criteria is `rebut`
     (the `rebut` edge precedes the `verdict` edge in the fixture):
     - `it("falls back to the route fallback below the confidence floor on a native judge, and pauses when the fallback is pause")`:
       on `COURTROOM_TOML` (its `min_confidence = 0.6`, `fallback = "verdict"`)
       with confidence `0.31`: assert the member calls after `editor` are
       `other` (the `verdict` edge was taken) and the `decision` card of
       kind `route` has `outcome === "fallback → verdict (0.31 < 0.60)"`;
       then, on `COURTROOM_TOML.replace('fallback = "verdict"', 'fallback = "pause"')`
       in a fresh fixture with the same scripted judge: the outer text
       starts with `⏸ courtroom paused at defense`, and the route decision
       card has `outcome === "fallback → pause (0.31 < 0.60)"`;
     - `it("takes the judge's choice at or above the floor")`: on
       `COURTROOM_TOML` with confidence `0.60`: the member calls after
       `editor` start with `writer` (the `rebut` edge was taken) and the
       route decision card has `outcome === "→ rebut 0.60"`.

   Before Step 6's code: every listed new test FAILS (the M1 `#decide`
   takes the first outgoing edge without a judge, `#hopReady` refuses a
   verdict member, and `#pause`, `mixture_decision`, and
   `MixtureDecision.outcome` values do not exist); after: every listed test
   PASSES, and every M1 test in the file still PASSES.

8. Run the test commands for `moa-engine.test.ts` and `moa-trace-ui.test.ts`.

Exit condition: both files pass; the typecheck command exits 0.

Commit: subject `feat(moa): route, terminate, and verdict decisions with decision cards`.

### Step 7: limits, `on_limit`, pause and resume

Input state: Step 6 committed.

Actions:

1. `packages/coding-agent/src/moa/engine.ts`, the deadline (reusing
   `#deadline`, `#deadlineFired()`, and `#callSignal(run, hop?)` exactly as Step
   5 defined them; this step adds no new signal helper):
   - `#generate` (line 577): call `prepareMemberCall({ ...this.#options, signal: this.#callSignal(run, hop) }, …)`
     (the hop record, so a limit hop's call carries no deadline: Step 5's
     `#callSignal` decides from `hop.edgeInId`);
     after the stream ends, when `final?.stopReason === "aborted"` and
     `this.#deadlineFired()`, return the new outcome `{ kind: "deadline" }`
     (add it to `MemberOutcome`); when `final?.stopReason === "aborted"`
     and the caller's signal aborted, `#finalizeAbort` already finished the
     request and `#hopReady`'s existing `if (this.#finalized) return;`
     after `#generate` handles it; any other terminal is unchanged;
   - `#generate`, live streaming: add the field `#liveHop: number | undefined`;
     when `live` is true, at the first `text_delta` of the hop set
     `this.#liveHop = hop.index` and, when `this.#streamedLive` was already
     true before this hop (an earlier live hop was deadline-aborted),
     `this.#writer.appendText("\n\n")` before that first delta (spec §4.5
     as amended by 6.11 R15: the wall-clock action's text follows the
     partial text after a blank line);
   - `#afterGenerate` (line 641): when `outcome.kind === "deadline"`:
     `hop.status = "aborted"`, `hop.output = ""`, `hop.elapsedMs`,
     `#normalizeContinuation(run, hop)`, emit `hop_end`, then
     `return this.#onSoftLimit(run, "wall_clock", wallClockValue(run))`
     where `wallClockValue(run)` is `` `${minutes}m` `` for the definition's
     `limits.wallClockMinutes` with the `moa.wall_clock_minutes` default;
   - `#onJudgeFailure(run, hop, member, kind, error)` (Step 6): insert,
     immediately after its `#leaveDecision` call,
     `if (this.#deadlineFired()) return this.#onSoftLimit(run, "wall_clock", wallClockValue(run));`
     (the phase is `decision_pending`, unchanged, so a `pause` resumes by
     deciding the hop again and `judge`/`stop` proceed from the last
     completed hop, which `#leaveDecision` has published);
   - `#judgeDeadline(error)` (Step 6): its body becomes `return this.#deadlineFired();`;
   - `#onVerdictDeadline(run, hop)` (Step 6): its body becomes: mark the
     verdict hop `aborted` (`hop.status = "aborted"`, `hop.output = ""`,
     `hop.elapsedMs`), `#normalizeContinuation(run, hop)`, emit `hop_end`,
     then `return this.#onSoftLimit(run, "wall_clock", wallClockValue(run));`;
   - `#onTranscriptDeadline(run)` (Step 5): its body becomes
     `return this.#onSoftLimit(run, "wall_clock", wallClockValue(run));`
     (the phase is `hop_ready` for the member whose transcript was being
     prepared; no hop exists yet).

2. Limit checks:
   - add `#checkLimits(run, at: "hop_ready" | "decision_pending", onFire?: () => void): boolean`
     implementing spec §4.7 as amended by 6.11 R4, in this order, returning
     `true` as soon as one fires (calling `onFire?.()` first, before the
     action) and `false` otherwise:
     `limitHop = at === "hop_ready" && run.phase.kind === "hop_ready" && run.phase.edgeInId === "limit"`
     (at `hop_ready` the phase is still the continuation, so reading it
     here is correct; at `decision_pending` the caller excludes limit hops
     itself, call site 3);
     (a) `at === "hop_ready"` and `run.lifetime.hops >= cfgMoaHardMaxHops.get(settings)`
     → `#limitStop(run, "hard_cap", \`${cap} hops\`)`; (b)
     `hardBudget = cfgMoaHardBudgetUsd.get(settings)`, `hardBudget > 0 && run.lifetime.usd >= hardBudget`
     → `#limitStop(run, "hard_cap", \`$${hardBudget}\`)`; then, when
     `limitHop`, return `false`; (c) `at === "hop_ready"` and
     `run.window.hops >= maxHops` → `#onSoftLimit(run, "hops", String(maxHops))`;
     (d) `budget > 0 && run.window.usd >= budget` → `#onSoftLimit(run, "budget", \`$${budget}\`)`;
     (e) `Date.now() - run.window.startedAt >= minutes * 60_000` →
     `#onSoftLimit(run, "wall_clock", wallClockValue(run))`. `maxHops`,
     `budget`, `minutes` are the definition's `limits.maxHops`,
     `limits.budgetUsd`, `limits.wallClockMinutes` with the `moa.max_hops`,
     `moa.budget_usd`, `moa.wall_clock_minutes` defaults;
   - the call sites, exhaustively (spec §4.7 as amended: points 1–4):
     1. `#hopReady` (line 448): replace the two M1 checks (lines 450–453,
        `hardCap`/`maxHops`) with `if (this.#checkLimits(run, "hop_ready")) return;`
        as the first statement;
     2. `#hopReady`, immediately after the transcript `try` block of Step
        5 (when it ran): `if (settlementsBefore !== run.settlements.length && this.#checkLimits(run, "hop_ready")) return;`
        where `settlementsBefore = run.settlements.length` was read before
        the block (a summary settled; the phase is still `hop_ready` and no
        hop exists);
     3. `#decide`, item 1 of Step 6 (after `hop`, `member`, `outgoing`):
        `if (hop.edgeInId !== "limit" && outgoing.length > 0 && this.#checkLimits(run, "decision_pending", () => this.#leaveDecision(run, hop, member))) return;`
        (spec §4.7 as amended: a hop with no outgoing edge, a verdict hop,
        and a limit hop have a terminal continuation and get no check; the
        limit hop is excluded by its own `edgeInId`, never by
        `outgoing.length`, because a valid `limit_target` may have ordinary
        outgoing edges);
     4. `#decide`, item 4 of Step 6 (after `eligible`): when a `terminate`
        judgment ran in item 3 and `eligible.length >= 2`:
        `if (this.#checkLimits(run, "decision_pending", () => this.#leaveDecision(run, hop, member))) return;`
        before the route judgment;
     No other call site exists;
   - `#limitStop` (line 696): the `limit` parameter becomes
     `"hops" | "budget" | "wall_clock" | "hard_cap"` and the `value` a
     string; `endReason` = `"hard_cap"` for `hard_cap`, else `\`limit:${limit}\``;
     the notice `reason` is `limitReason(limit, value)`, a module-level
     function returning, by `limit` (exhaustive list): `hops` →
     `` `the ${value}-hop limit was reached` ``; `budget` →
     `` `the ${value} budget limit was reached` ``; `wall_clock` →
     `` `the ${value} wall-clock limit was reached` ``; `hard_cap` →
     `` `the hard cap of ${value} was reached` `` (the `hops` and
     `hard_cap` phrases are the M1 wording the M1 test
     `stops at the $limit limit …` asserts);
   - add `#onSoftLimit(run, kind: "hops" | "budget" | "wall_clock", value: string): void`:
     `action = run.resolved.definition.limits?.onLimit ?? cfgMoaOnLimit.get(settings)`;
     `stop` → `#limitStop(run, kind, value)`; `judge` →
     `target = run.resolved.definition.limits?.limitTarget`;
     `last = run.hops.findLast(hop => hop.status === "done")`; when
     `target` is not the id of a model member in `run.resolved.members`,
     or `last?.memberId === target` → `#limitStop(run, kind, value)`; else
     `run.limitHop = { kind, value }`,
     `run.phase = { kind: "hop_ready", memberId: target, edgeInId: "limit" }`,
     `run.activeMemberId = target`, emit `limit` (`action: "judge"`),
     checkpoint `decision` (spec §4.7 `judge` bullet); `pause` → emit
     `limit` (`action: "pause"`) then
     `#pause(run, run.activeMemberId ?? run.resolved.definition.entry, limitReason(kind, value))`
     (`#pause` is Step 6's; unchanged here);
   - `#finalize` (line 720): replace the two lines
     `const text = this.#streamedLive ? this.#writer.text : final.text;` and
     `if (!this.#streamedLive) this.#writer.appendText(text);` with:
     `const streamedFinal = this.#streamedLive && final.hop === this.#liveHop;`
     `if (!streamedFinal) this.#writer.appendText(this.#streamedLive ? \`\n\n${final.text}\` : final.text);`
     `const text = this.#writer.text;` (spec §4.5 as amended by 6.11 R15:
     `finalizing` emits `run.final.text` only when it is not the text that
     already streamed; the `PendingResponse` carries the writer's whole
     text);
   - the limit hop in `#hopReady`: when `edgeInId === "limit"`:
     `template = run.resolved.envelopes[LIMIT_ENVELOPE]` (undefined →
     `#fail` with `mixture ${run.key.mixture}: limit envelope missing`);
     `source = run.hops.findLast(hop => hop.status === "done")`; `edge`
     undefined; `envelopeContext.from` = `source`'s member entry;
     `envelopeContext.limit = run.limitHop`; `x.transcript` = the
     `verbatim` path of `#transcriptPart` with
     `budget = cfgMoaTranscriptBudgetTokens.get(settings)` (factor the
     verbatim branch into a function both callers use); the limit hop's
     `#callSignal` carries no deadline (Step 5); `hop.visible = false` at
     decision time (Step 6 item 2, the limit-hop branch of `#decide`).

3. Resume in `#classify` (line 290): before the `if (classified.operator)`
   branch, add: `if (existing?.status === "paused" && classified.operator) return this.#resume(existing, request);`
   with `#resume(run, request)`: `run.window = { hops: 0, usd: 0, startedAt: Date.now() }`;
   `run.status = "running"`; `run.lastRequest = request`; emit
   `{ type: "resume", run, note: \`${run.key.mixture} resumed with a fresh window; your message was not forwarded to the members (steering arrives with M3)\` }`;
   `return this.#loop(run)`. The prompt's text and images are not stored.
   Spec §4.5 (amended row): the run "resumes at its checkpointed phase with
   a fresh soft-limit window".

4. `packages/coding-agent/src/moa/host.ts`, `onEvent`: add
   `case "resume": deps.notice("info", event.note); return;` (no card, no
   entry).

5. Tests. In `packages/coding-agent/test/moa-engine.test.ts` add
   `describe("limits, pause, and resume", …)` on `courtroomSession(limitsToml(<lines>))`
   with `COURTROOM_SETTINGS` unless a test adds settings, where
   `limitsToml(lines: string)` returns `COURTROOM_TOML` with everything
   from the line `[mixtures.limits]` to the end replaced by
   `` `[mixtures.limits]\n${lines}\n` ``. Tests:
   - `it("runs the limit hop at limit_target with the verbatim transcript and ends with limit:hops")`:
     `limitsToml('max_hops = 3\non_limit = "judge"\nlimit_target = "judge"')`;
     script `jev`: `"no"`, `"rebut"`; assert member call order
     `writer, editor, writer, other`; the `other` call's envelope contains
     `[hop 1 · prosecution ← entry]` and `The run reached a limit (hops: 3)`;
     the outer text is `other`'s reply; the `done` checkpoint has
     `run.endReason === "limit:hops"` and `run.lifetime.hops === 4`; a
     `limit` card with `action: "judge"` exists;
   - `it("stops at the budget limit with the notice, after the hop that crossed it, without asking the judge")`:
     `limitsToml('budget_usd = 0.015\non_limit = "stop"')`; script `writer`
     `{ cost: 0.005 }` and `editor` `{ text: "rebuttal", cost: 0.02 }`;
     assert exactly two member calls (`writer`, `editor`), no `jev` call,
     the outer text starts with
     `⏹ courtroom stopped after 2 hops: the $0.015 budget limit was reached`
     and contains `rebuttal`; `endReason === "limit:budget"`;
   - `it("stops at the budget when a judge settlement crosses it, before the route judgment")`:
     `limitsToml('budget_usd = 0.04\non_limit = "stop"')`; script `writer`
     `{ cost: 0.01 }`, `editor` `{ cost: 0.01 }`, `jev` `{ text: "no", cost: 0.05 }`;
     assert `members.callsTo("jev")` has exactly one call (terminate; no
     route), the outer text starts with `⏹ courtroom stopped after 2 hops: the $0.04 budget limit was reached`,
     the `terminate` decision card exists, and no `route` decision card
     exists;
   - `it("pauses at the hop limit, resumes on the next prompt with a fresh window without forwarding the text, and the hard cap still stops")`:
     `limitsToml('max_hops = 2\non_limit = "pause"')` with
     `Settings.isolated({ ...COURTROOM_SETTINGS, "moa.hard_max_hops": 3 })`;
     script `jev`: `"no"`, `"rebut"`; first prompt `"go"` → member calls
     `writer, editor`; the outer text starts with
     `⏸ courtroom paused at prosecution after 2 hops`; the `pause`
     checkpoint has `run.status === "paused"` and
     `run.phase.kind === "hop_ready"`; `traceCards` has a `limit` card with
     `action: "pause"` and a `checkpoint` card with `reason: "pause"`;
     `const before = members.calls.length`; second prompt
     `"continue please"` → `members.calls.slice(before)` is one `writer`
     call whose envelope does not contain `continue please`; a `notice`
     session event was emitted whose message contains
     `resumed with a fresh window`; the hard cap (3) then stops: the outer
     text contains `the hard cap of 3 hops was reached` and the `done`
     checkpoint has `run.window.hops === 1` and `run.lifetime.hops === 3`;
   - `it("replays the pause notice on a repeat and does not open a new window")`:
     direct-host pattern (`createSessionMixtureHost` + `streamMixture` on
     `mixture/courtroom`) on `limitsToml('max_hops = 1\non_limit = "pause"')`;
     define `const MESSAGES = [<one user message "go">]`; call
     `streamMixture(<the courtroom model>, { messages: MESSAGES }, {}, host)`
     and drain it, then call it again with `{ messages: MESSAGES }` and
     drain it; assert the second outer message's text equals the first's,
     `members.callsTo("writer")` has one call, and the number of `custom`
     entries with `customType === MIXTURE_RUN_ENTRY_TYPE` in
     `sessionManager.getBranch()` is the same after both calls;
   - `it("treats a mid-call wall-clock deadline as a limit, aborting the hop and applying on_limit")`:
     `limitsToml('wall_clock_minutes = 0.002\non_limit = "stop"')` (120
     ms); script `writer` `{ waitForAbort: true, cost: 0.01 }`; assert the
     outer text contains `the 0.002m wall-clock limit was reached`, the
     hop card for hop 1 has `status: "aborted"`,
     `endReason === "limit:wall_clock"`, and `usageBreakdown` reports the
     aborted attempt's `0.01`;
   - `it("runs the wall-clock limit hop without a deadline after a deadline-aborted member")`:
     `limitsToml('wall_clock_minutes = 0.002\non_limit = "judge"\nlimit_target = "judge"')`;
     script `writer` `{ waitForAbort: true, cost: 0.01 }` and `other`
     `{ text: "ruling" }`; assert member call order `writer, other` (no
     completed hop precedes the limit hop, so its envelope has no
     `from`), the outer text is `ruling`, `endReason === "limit:wall_clock"`,
     the hop card for hop 1 has `status: "aborted"` and the hop card for
     hop 2 has `status: "done"`, and the `other` call's recorded
     `options.signal` satisfies `signal === undefined || signal.aborted === false`
     after the run ended (a non-exempt limit hop would have received the
     already-expired deadline, which is aborted by then);
   - `it("does not soft-limit a limit hop whose target has ordinary outgoing edges")`:
     `limitsToml('budget_usd = 0.015\non_limit = "judge"\nlimit_target = "prosecution"')`;
     script `writer` `{ text: "opening", cost: 0.01 }`, `editor`
     `{ cost: 0.01 }`, then `writer` `{ text: "closing statement", cost: 0.01 }`;
     assert member call order `writer, editor, writer` and
     `members.callsTo("jev")` empty (the budget check at `editor`'s
     `decision_pending` fires before any judgment; `prosecution`, which
     has the outgoing edge `open`, runs the limit hop and its own
     `decision_pending` runs no check), the hop card for hop 2 exists with
     `visible: true` (published by `#leaveDecision` when the check fired),
     exactly one `limit` card (`action: "judge"`), the outer text is
     `closing statement`, `endReason === "limit:budget"`, and the `done`
     checkpoint's `run.lifetime.hops === 3`;
   - `it("appends the stop notice after the partial text when the deadline aborts a live-streamed terminal member")`:
     on `mixtureSession(DRAFT_THEN_EDIT_TOML.replace('entry = "writer"', 'entry = "writer"\nlimits = { wall_clock_minutes = 0.002, on_limit = "stop" }'))`
     (the editor is structurally terminal, so its text streams live);
     script `editor` `{ text: "partial answer", waitForAbort: true, cost: 0.01 }`;
     assert the outer text starts with `partial answer\n\n⏹ draft-then-edit stopped after 2 hops: the 0.002m wall-clock limit was reached`,
     the outer text contains the writer's reply as the last output, and
     the hop card for hop 2 has `status: "aborted"` and no output body;
   - `it("stops at the hard budget regardless of on_limit")`:
     `limitsToml('on_limit = "pause"')` with
     `Settings.isolated({ ...COURTROOM_SETTINGS, "moa.hard_budget_usd": 0.015 })`;
     script `writer` `{ cost: 0.02 }`; assert the outer text contains
     `the hard cap of $0.015 was reached`, `endReason === "hard_cap"`, and
     no `pause` checkpoint exists.
   - `describe("deadline during a judgment", …)` using the scripted
     `MixtureJudge` of Step 6's native-judge describe, with
     `withCandidate(run, options)` changed to: await
     `new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }))`
     then throw `options.signal.reason`:
     - `it("treats a wall-clock deadline during a judgment as the wall-clock limit from decision_pending")`:
       `limitsToml('wall_clock_minutes = 0.002\non_limit = "stop"')`;
       assert the outer text starts with
       `⏹ courtroom stopped after 2 hops: the 0.002m wall-clock limit was reached`,
       contains the editor's reply, no `decision` card exists, and the
       `done` checkpoint has `run.endReason === "limit:wall_clock"`.

   In `packages/coding-agent/test/moa-transit.test.ts` add to the existing
   top-level describe:
   - `it("stops at the budget when a summary settlement crosses it before the member starts")`:
     `CYCLE_TOML` with `optimize = "compact"` and its limits replaced by
     `limits = { max_hops = 8, budget_usd = 0.04, on_limit = "stop" }`;
     script `writer` and `editor` with `{ text: <lorem…>, cost: 0.001 }`
     four times each and `summary` with `{ text: "S", cost: 0.05 }`;
     assert exactly four member calls (`writer, editor, writer, editor`),
     one `summary` call, the outer text starts with
     `⏹ cycle stopped after 4 hops: the $0.04 budget limit was reached`
     (`cycle` is `CYCLE_TOML`'s `name`), and `usageBreakdown` has one
     `summary` entry.

   Also update the M1 `it.each` row `{ limit: "hops", … }` of
   `stops at the $limit limit with the notice and the last member's output`
   (`moa-engine.test.ts:279`): its `toml` becomes
   `'entry = "writer"\nlimits = { max_hops = 1, on_limit = "stop" }'`,
   because the decided default `moa.on_limit` is `pause` (spec §12) and the
   row asserts the stop notice; its other fields are unchanged.

   Before Step 7's code: every listed new test FAILS, and the updated M1
   row PASSES both before and after; after: all PASS and every earlier test
   in both files still PASSES.

6. Run the test commands for `moa-engine.test.ts` and `moa-transit.test.ts`.

Exit condition: `moa-engine.test.ts` and `moa-transit.test.ts` pass; the typecheck command exits 0.

Commit: subject `feat(moa): budget and wall-clock limits, on_limit stop/judge/pause, and resume`.

### Step 8: checkpoint restore

Input state: Step 7 committed.

Actions:

1. `packages/coding-agent/src/moa/restore.ts`: add a third export
   ```ts
   export function restoreMixtureRun(branch: readonly SessionEntry[]): { checkpoint: MixtureCheckpoint; committed: boolean } | undefined
   ```
   implementing spec §4.8 restore steps 1–3 over the branch array:
   1. walk backwards to the last `reset_boundary`, collecting `mixture_run`
      entries; the run id is that of the newest such entry (checkpoint
      `data.run.id`, lifecycle `data.runId`); no entry → `undefined`;
   2. if the newest lifecycle record for that run is `run_reset` →
      `undefined`; if `isMixtureRunComplete(branch, runId)` → `undefined`;
   3. the newest checkpoint of that run that is **committed**: a
      checkpoint without `outerResponseId` is committed; one with it is
      committed iff an assistant `message` entry with that `responseId`
      follows it in the branch; skip uncommitted ones; none → `undefined`;
   4. return `{ checkpoint, committed: checkpoint.outerResponseId !== undefined }`.
   The two Step 2 exports keep their signatures.

2. `packages/coding-agent/src/moa/types.ts` and `packages/coding-agent/src/moa/engine.ts`,
   the checkpoint's entry state (spec §4.8 as amended by 6.11 R14):
   - `interface MixtureCheckpoint` (`types.ts:233`): add
     `entry: { conversation: string; topicImages: ImageContent[] };`
     after `report` (`ImageContent` as a type from `@oh-my-pi/pi-ai`);
     `v` stays `1`; a persisted checkpoint without `entry` is read as
     `{ conversation: "", topicImages: [] }`;
   - `#checkpoint` (`engine.ts:903`): set
     `entry: { conversation: this.#entry.conversation, topicImages: run.phase.kind === "hop_ready" && run.phase.edgeInId === undefined ? this.#entry.topicImages : [] }`
     (images only when the continuation is the entry hop, the one
     continuation that forwards them; the conversation always, because
     `#envelopeContext` reads `this.#entry.conversation` for every hop).

3. `packages/coding-agent/src/moa/host.ts`:
   - `SessionMixtureHost`: add `restoreConversation(): void;` (doc: the
     session loaded or moved to another branch; restore the newest
     resumable run of the active branch per spec §4.8);
   - implement `restoreConversation` in the returned object:
     `found = restoreMixtureRun(sessionManager.getBranch())`; undefined →
     return; `serialized = found.checkpoint.run`; resolve the pinned
     definition: `registered = <the same scope lookup resolveRun uses>(serialized.resolved.definition.name)`
     to obtain document presets (`registered?.presets`; when the mixture is
     no longer registered use `{ envelopes: {}, roles: {} }`);
     `fresh = resolveMixture(serialized.resolved.definition, { registry: modelRegistry, settings, documentEnvelopes: presets.envelopes, documentRoles: presets.roles })`;
     `errors = validateMixture(fresh, { settings, names: [serialized.resolved.definition.name] }).errors`;
     when `errors.length > 0`: `logger.warn("mixture run not restored", { mixture, runId, errors })`,
     `deps.notice("warning", \`${mixture} run ${runId} could not be restored: ${errors.map(issue => issue.code).join(", ")}\`)`,
     return; otherwise
     `sessionId = sessionManager.getSessionId()` and
     `run: MixtureRun = { ...structuredClone(serialized), resolved: fresh, summaries: serialized.summaries ?? {}, key: { ...serialized.key, host: sessionId, conversation: sessionId } }`
     (spec §4.8 as amended by 6.11 R7: the run is rebound to the restoring
     host; the session host derives both key fields from the current
     session id, `host.ts:150 (get id)` and `host.ts:179 (conversationKey)`,
     and a branched session has a new id); restore the watermark: when
     `found.committed`, `commitMixtureResponse(run, found.checkpoint.outerResponseId!)`
     (sets `reportedThrough`, `cursor`, `committed`), and `run.status`
     stays as persisted (`paused`, `error`, or `checkpoint`); when not
     committed, `run.reportedThrough = found.checkpoint.committedThrough`
     and `run.status = "checkpoint"` (spec §4.8 step 2); when
     `run.status === "running"` (a hop-boundary checkpoint persisted while
     running) set `run.status = "checkpoint"`; when
     `run.phase.kind === "generating"` STOP (a checkpoint never persists
     it; this is evidence of a bug); seed the store:
     `lease = runs.acquire(run.key)`; undefined → return (a call is
     executing); `runs.install(lease.entry, run)`;
     `entryState = found.checkpoint.entry ?? { conversation: "", topicImages: [] }`;
     `lease.entry.conversation = entryState.conversation`;
     `lease.entry.topicImages = entryState.topicImages`;
     `lease.release()`;
     `logger.info("mixture run restored", { mixture, runId, phase: run.phase.kind, status: run.status })`;
     `deps.notice("info", \`${mixture} run restored at ${run.phase.kind} (${run.status})\`)`.
   - `resetConversation` is unchanged.

4. `packages/coding-agent/src/session/agent-session.ts`:
   - `attachMixtureHost` (line 2925): the parameter type becomes
     `Pick<SessionMixtureHost, "commitPersisted" | "resetConversation" | "restoreConversation" | "runs">`
     and the `#mixtureHost` field (line 748) the same type;
   - after each of these four `this.#mixtureHost?.resetConversation();`
     statements add `this.#mixtureHost?.restoreConversation();` on the
     next line: `switchSession` (line 10630, after `this.agent.replaceMessages(sessionContext.messages)`),
     `branch` (line 10947), `branchFromBtw` (line 11083), `navigateTree`
     (line 11408, after `this.agent.replaceMessages(displayContext.messages)`).
     Do **not** add it in `resetSessionContext` (line 5529): `/clear`
     appends its `reset_boundary` after that call (`appendResetBoundary`
     at line 5575), so a restore there would find the run being cleared.
     Do **not** add it in `newSession` (line 9040): at that statement the
     session manager still holds the old session (`sessionManager.newSession`
     runs at line 9051), and the new session's branch is empty, so there
     is nothing to restore; `resetConversation` alone is the correct
     behaviour there.
   - add the public method `mixtureRuns(): readonly MixtureRun[]` beside
     `emitMixtureEvent` (line 2917) returning
     `this.#mixtureHost?.runs.runs() ?? []` (`MixtureRun` as a type from
     `../moa/types`).

5. `packages/coding-agent/src/sdk.ts`: immediately after
   `session.attachMixtureHost(sessionMixtureHost);` (line 4504) add
   `sessionMixtureHost.restoreConversation();` (session load).

6. `packages/coding-agent/test/moa-checkpoint.test.ts`: add
   `describe("restore", …)` using the session harness (copy from
   `moa-engine.test.ts`, including `COURTROOM_SETTINGS` and the by-name
   helpers of Step 6 item 7) with `COURTROOM_TOML` selected as `mixture/courtroom`
   and a file-backed `SessionManager` (`SessionManager.create` …
   `SessionManager.open`, the reload pattern of `moa-engine.test.ts`'s
   `retries a first-hop error once … reload` test). Two mechanics used by
   several tests:
   - a **simulated crash**: read the session file, keep every line up to
     and including the line of a chosen `mixture_run` checkpoint entry
     (identified by its `reason` and `run.phase.kind`), drop every later
     line, write the file back, and `SessionManager.open` the file;
   - a **direct-host crash test**: the session never re-sends a request by
     itself, and at M2 a new prompt on a `checkpoint` run starts a new run
     (spec §4.5 table), so the crash tests run **both** requests through
     the engine directly, over a file-backed `SessionManager`: build the
     host exactly as `describe("engine contract through a session host")`
     in `moa-engine.test.ts` builds its host, substituting a
     `SessionManager.create`d manager for its in-memory one; define one
     constant `MESSAGES = [<one user message with text "go">]`; run
     `streamMixture(<the mixture model>, { messages: MESSAGES }, {}, host)`
     and drain it (the original request; the direct host appends no
     assistant entry, which is exactly the state of a crash before
     `message_end`); apply the simulated crash when the test names a
     checkpoint to cut at; build a second host over the reopened manager,
     call `host.restoreConversation()`, run `streamMixture(<the mixture model>, { messages: MESSAGES }, {}, host)`
     again (the identical request) and drain it to its final message.
   Tests:
   - `it("restores a paused run across a session reload and resumes it with a fresh window")`
     (real sessions): `limitsToml('max_hops = 2\non_limit = "pause"')`
     (the helper of Step 7 item 5, copied into this file); script `jev`
     `"no"`, `"rebut"`, `"no"`, `"rebut"`; run `"go"` (calls
     `writer, editor`, then the pause); dispose; reopen the file with a
     new session (`model: null`); `session.mixtureRuns()` has one run with
     `status === "paused"` and `key.host === <the reopened session's id>`;
     `const before = members.calls.length`; send `"more"` →
     `members.calls.slice(before).filter(call => call.model.id !== "jev").map(call => call.model.id)`
     is `["writer", "editor"]` (a fresh window of
     2), the new outer text starts with
     `⏸ courtroom paused at prosecution after 4 hops`, and the newest
     `pause` checkpoint has `run.window.hops === 2` and
     `run.lifetime.hops === 4` (a new run would have started at hop 1);
   - `it("restores the entry conversation and images with a redone entry hop")`
     (direct-host on `DRAFT_THEN_EDIT_TOML`, model `mixture/draft-then-edit`,
     file-backed manager): request 1 with
     `MESSAGES1 = [<user "earlier question">]`, `editor` scripted
     `{ text: "earlier answer" }`; drain to the outer message `A1`;
     `sessionManager.appendMessage(A1)`; `host.commitPersisted(A1)`.
     Request 2 with `MESSAGES2 = [<user "earlier question">, A1, <user with text "go" and one image block>]`
     and `writer` scripted `{ error: { message: "flaky" } }`; drain to the
     outer error message `E2`; `sessionManager.appendMessage(E2)`;
     `host.commitPersisted(E2)`. Assert the newest `mixture_run`
     checkpoint has `reason: "error"`, `run.phase.kind === "hop_ready"`,
     `run.phase.edgeInId === undefined`, `entry.topicImages.length === 1`,
     and `entry.conversation` containing `earlier answer`. Reopen the
     file, build a second host, `host.restoreConversation()`; assert
     `host.runs.runs()` has one run with `status === "error"`. Request 3
     with `MESSAGES2` again (a retry: spec §4.5 step 0a, `outcome: "failed"`)
     and `writer` scripted to succeed; assert the `writer` call recorded
     after the reopen has an envelope message whose content contains one
     `image` block and whose text contains `earlier answer`, and that
     `editor` was then called once;
   - `it("restores into decision_pending from a hop checkpoint after a simulated crash and decides without regenerating")`
     (direct-host crash test on `DRAFT_THEN_EDIT_TOML`, model
     `mixture/draft-then-edit`): cut after the `hop` checkpoint whose
     `run.phase.kind === "decision_pending"` for hop 1; record
     `const before = members.calls.length` after the reopen; after the
     identical request `members.calls.slice(before).map(call => call.model.id)`
     is `["editor"]` (`writer` gained no call; `editor` is called again
     because the original execution's `editor` call is not undone by
     truncating the file), and the second outer message's `usageBreakdown`
     has exactly one `writer` entry and one `editor` entry;
   - `it("restores into hop_ready after a decision checkpoint and runs the next member only")`
     (direct-host crash test): cut after the `decision` checkpoint whose
     `run.phase.kind === "hop_ready"` and `run.phase.memberId === "editor"`;
     after the identical request only `editor` gained a call;
   - `it("skips an uncommitted done checkpoint, restores finalizing, and re-emits the answer with its usage reported once")`
     (direct-host crash test, no cut: the `done` checkpoint is the last
     entry and no assistant entry follows it); after the identical request
     no member gained a call, the second outer text equals the editor's
     reply, and its `usageBreakdown` has one `writer` and one `editor` entry;
   - `it("does not restore a run whose branch carries a run_reset record, nor a complete run")`
     (real sessions): a completed courtroom run (script `jev` `"no"`,
     `"verdict"`) reopened → `session.mixtureRuns()` is `[]` and the next
     prompt calls `writer` first (a new run); a paused run whose branch
     then receives
     `sessionManager.appendCustomEntry(MIXTURE_RUN_ENTRY_TYPE, { kind: "run_reset", runId, at: Date.now() })`
     (Step 9 replaces this with `session.resetMixtureRuns()`) → reopened,
     `session.mixtureRuns()` is `[]` and the next prompt calls `writer`
     first;
   - `it("restores nothing when the pinned definition no longer resolves, and says so")`
     (real sessions): pause a run; `warn = vi.spyOn(logger, "warn")`;
     reopen with `Settings.isolated({ ...COURTROOM_SETTINGS, enabledModels: ["fake/writer", "fake/jev", "fake/summary"] })`
     (the fixture's `editor` and `judge` members become excluded); assert
     `warn` was called with first argument `"mixture run not restored"`
     and `session.mixtureRuns()` is `[]`;
   - `it("keeps the run across a tree move onto its pause response and across a branch from a later prompt, drops it on a branch before it, and holds none in a new session")`
     (real session, file-backed): pause a run with `"go"` (user entry
     `U1`; the pause checkpoint and its assistant entry `A1` follow);
     resume with `"more"` (user entry `U2`) and let it pause again;
     (a) `await session.navigateTree(<id of A1>)` (a non-user target lands
     the leaf on it: `agent-session.ts:11375 (newLeafId = targetId)`) →
     `session.mixtureRuns()` has one run whose `lifetime.hops === 2` (the
     first pause's state); (b) `await session.branch(<id of U2>)` (a user
     entry: `agent-session.ts:10866` rejects every other kind) →
     `session.mixtureRuns()` has one run whose `lifetime.hops === 2` and
     whose `key.host === session.sessionManager.getSessionId()` (the
     branched session's id); (c) `await session.branch(<id of U1>)` →
     `session.mixtureRuns()` is `[]`; (d) after a fresh pause,
     `await session.newSession()` → `session.mixtureRuns()` is `[]` and no
     `notice` event containing `run restored` was emitted by the new
     session.

   Before Step 8's code: every restore test FAILS (no restore exists);
   after: all PASS.


7. Run the test commands for `moa-checkpoint.test.ts` and `moa-engine.test.ts`.

Exit condition: both pass; the typecheck command exits 0.

Commit: subject `feat(moa): restore mixture runs from checkpoints on load, switch, branch, and tree navigation`.

### Step 9: `/mixture reset` and `/mixture status`

Input state: Step 8 committed.

Actions:

1. `packages/coding-agent/src/moa/host.ts`: add
   `resetRuns(): { mixture: string; runId: string }[];` to
   `SessionMixtureHost` (doc: `/mixture reset`; every held run gets a
   `run_reset` record and is dropped, spec §4.8) and implement it in the
   returned object: for every run of `runs.runs()` append
   `sessionManager.appendCustomEntry(MIXTURE_RUN_ENTRY_TYPE, { kind: "run_reset", runId: run.id, at: Date.now() })`
   (`MixtureLifecycleRecord`), collect `{ mixture: run.key.mixture, runId: run.id }`,
   then `runs.clear()` and `credentials.clear()`; return the list.

2. `packages/coding-agent/src/session/agent-session.ts`: extend the
   `attachMixtureHost` parameter type and the `#mixtureHost` field type of
   Step 8 with `| "resetRuns"` in the `Pick`, and add the public method
   `resetMixtureRuns(): { mixture: string; runId: string }[]` beside
   `mixtureRuns()` (Step 8) returning `this.#mixtureHost?.resetRuns() ?? []`.

3. Create `packages/coding-agent/src/moa/status.ts` exporting
   `formatMixtureStatus(runs: readonly MixtureRun[], settings: Settings): string`:
   `no active mixture run` when empty; else one line per run:
   `` `mixture/${key.mixture}: ${status} · phase ${phase.kind} · member ${activeMemberId ?? "-"} · hops ${lifetime.hops} (window ${window.hops}/${maxHops}) · spent $${lifetime.usd.toFixed(2)} (window $${window.usd.toFixed(2)})` ``
   with `maxHops = resolved.definition.limits?.maxHops ?? cfgMoaMaxHops.get(settings)`;
   and `formatMixtureReset(reset: readonly { mixture: string; runId: string }[]): string`:
   `no active mixture run` when empty, else `` `reset ${reset.length} mixture run(s): ${reset.map(r => \`mixture/${r.mixture}\`).join(", ")}` ``.

4. `packages/coding-agent/src/slash-commands/builtin-collaboration.ts`:
   add, immediately after the `chaining` spec object (line 232–275), a spec
   with `name: "mixture"`, `aliases: ["moa"]`, `icon: "advisor"`,
   `description: "Mixture of Agents runs: reset the current run or show its progress"`,
   `acpDescription: "Manage mixture runs"`, `acpInputHint: "[reset|status]"`,
   `subcommands: [{ name: "reset", description: "Drop the current mixture run so the next message starts fresh" }, { name: "status", description: "Show the current mixture run's hop, member, and spend" }]`,
   `allowArgs: true`, and:
   - `handle`: `parseSubcommand(command.args)`; `reset` →
     `runtime.output(formatMixtureReset(runtime.session.resetMixtureRuns()))`;
     `status` or empty → `runtime.output(formatMixtureStatus(runtime.session.mixtureRuns(), settings))`;
     anything else → `usage("Usage: /mixture [reset|status]", runtime)`;
     return `commandConsumed()` on the two handled verbs;
   - `handleTui`: `const { verb } = parseSubcommand(command.args);`
     `runtime.ctx.editor.setText("");` then `reset` →
     `runtime.ctx.showStatus(formatMixtureReset(runtime.ctx.session.resetMixtureRuns()));`
     (the only `runtime.ctx.session.resetMixtureRuns()` statement in the
     file; the non-TUI `handle` above has its own
     `runtime.session.resetMixtureRuns()`. Another lane inserts one line
     immediately after this statement, anchored on the exact substring
     `runtime.ctx.session.resetMixtureRuns()`, so the statement MUST stay a
     single line inside the `reset` branch and `runtime.ctx` MUST stay the
     name of the context there); `status` or
     empty → `runtime.ctx.showStatus(formatMixtureStatus(runtime.ctx.session.mixtureRuns(), settings));`
     anything else → `runtime.ctx.showStatus("Usage: /mixture [reset|status]")`.
   Import `formatMixtureReset`, `formatMixtureStatus` from `../moa/status`
   (`settings` is the module's existing import from `../config/settings`).

5. `packages/coding-agent/test/moa-engine.test.ts`: add
   `describe("/mixture reset and status", …)`:
   - `it("resets the held runs with a run_reset record each, so the next prompt starts a new run and a reload restores nothing")`:
     pause a courtroom run on a file-backed manager
     (`courtroomSession(limitsToml('max_hops = 2\non_limit = "pause"'), …)`
     with the session manager from `SessionManager.create`, script `jev`
     `"no"`, `"rebut"`); `session.resetMixtureRuns()` returns
     `[{ mixture: "courtroom", runId: <the run's id> }]`; the branch has
     exactly one `mixture_run` entry whose `data.kind === "run_reset"`;
     `session.mixtureRuns()` is `[]`; dispose and reopen the file →
     `session.mixtureRuns()` is `[]` and sending `"go"` calls `writer`
     first (a new run);
   - `it("reports the held run's status, hop counts against the limit, and spend")`:
     after the pause (before the reset), `formatMixtureStatus(session.mixtureRuns(), session.settings)`
     contains `mixture/courtroom: paused · phase hop_ready · member prosecution · hops 2 (window 2/2)`
     and matches `/spent \$\d+\.\d\d \(window \$\d+\.\d\d\)/`; after
     `resetMixtureRuns()` it is `no active mixture run`, and
     `formatMixtureReset([])` is `no active mixture run`.
   In `moa-checkpoint.test.ts`, change the Step 8 test
   `does not restore a run whose branch carries a run_reset record, nor a complete run`
   to call `session.resetMixtureRuns()` where it appended the `run_reset`
   record through `sessionManager.appendCustomEntry`; its assertions are
   unchanged.

6. Run the test commands for `moa-engine.test.ts` and `moa-checkpoint.test.ts`.

Exit condition: both pass; the typecheck command exits 0.

Commit: subject `feat(moa): /mixture reset and /mixture status`.

### Step 10: whole-milestone verification and report

Input state: Step 9 committed.

Actions:

1. Run the test command for each of the eight files of §2.4, one at a
   time, in the listed order. Every file MUST exit 0.
2. Run the typecheck command. It MUST exit 0.
3. `cd /home/shayna/source/github/PsychedelicShayna/neopi-moa-m2 && git status --short` MUST print nothing.
4. Write the final report (§1 "Final report") in chat, including the
   acceptance → evidence table of §5 filled with the test names that
   passed and the base commit hash from Step 0.

Exit condition: actions 1–3 hold.

Commit: none (formatting fixes required by `check:ts` MAY be committed as
`chore(moa): formatting for M2` before this step's checks).

## 5. Acceptance → evidence

Every row names the spec acceptance (§14 M2) and the test that proves it.

| Acceptance (spec §14 M2) | Evidence (file · test name) |
|---|---|
| the courtroom fixture runs prosecution ⇄ defense and ends by `terminate` or by `verdict` | `moa-engine.test.ts` · `routes on the judge's choice, records the decision card, and counts the traversal`; `ends by terminate when the noul answer meets the threshold, before routing`; `ends by verdict with the rendered answer as the outer text, counting the verdict hop` |
| with `max_hops = 3` and `on_limit = "judge"` the judge hop runs and the run ends | `moa-engine.test.ts` · `runs the limit hop at limit_target with the verbatim transcript and ends with limit:hops` |
| with `on_limit = "pause"` the next prompt resumes with a fresh window and the hard cap still stops | `moa-engine.test.ts` · `pauses at the hop limit, resumes on the next prompt with a fresh window without forwarding the text, and the hard cap still stops` |
| without `TYPESAFE_API_KEY` the run completes on the chat fallback judge, the trace names the fallback model, and the confidence floor is reported as inactive | `moa-engine.test.ts` · `reports the confidence floor inactive and names the fallback model on a chat judge` |
| confidence floor and fallback eligibility on a native judge | `moa-engine.test.ts` · `falls back to the route fallback below the confidence floor on a native judge, and pauses when the fallback is pause`; `takes the judge's choice at or above the floor` |
| killing and resuming the session while a run is paused restores it | `moa-checkpoint.test.ts` · `restores a paused run across a session reload and resumes it with a fresh window` |
| a simulated crash between an outer-return checkpoint and `message_end` resumes from the last completed hop without double-reporting usage | `moa-checkpoint.test.ts` · `skips an uncommitted done checkpoint, restores finalizing, and re-emits the answer with its usage reported once`; `restores into decision_pending from a hop checkpoint after a simulated crash and decides without regenerating` |
| `moa-transit` passes; the snapcompact case runs the real package | `moa-transit.test.ts` · all nine tests |
| `moa-checkpoint` passes | `moa-checkpoint.test.ts` · all tests |
| the control cases of `moa-engine` pass | `moa-engine.test.ts` · every test |
| M2 validation rules | `moa-validate.test.ts` · `accepts the M2 courtroom fixture with no errors` and the E11–E15/E18 rows |
| `/mixture reset`, `/mixture status` | `moa-engine.test.ts` · the two tests of Step 9 item 5 |
| M2 settings registered | `moa-engine.test.ts` tests that set `moa.summary_model`, `moa.hard_budget_usd`, `moa.hard_max_hops` through `Settings.isolated` |
| limits enforced after helper and judge settlements, and reconciled with live streaming | `moa-engine.test.ts` · `stops at the budget when a judge settlement crosses it, before the route judgment`; `appends the stop notice after the partial text when the deadline aborts a live-streamed terminal member`; `treats a wall-clock deadline during a judgment as the wall-clock limit from decision_pending`; `moa-transit.test.ts` · `stops at the budget when a summary settlement crosses it before the member starts` |
| the limit hop is exempt from the deadline and from the decision-phase check, whatever its target's edges | `moa-engine.test.ts` · `runs the wall-clock limit hop without a deadline after a deadline-aborted member`; `does not soft-limit a limit hop whose target has ordinary outgoing edges` |
| every completed hop reaches the trace, including hops whose decision phase paused or hit a limit | `moa-engine.test.ts` · `pauses on a failed route judgment instead of taking a default edge` (hop-2 card before the pause checkpoint); `does not soft-limit a limit hop whose target has ordinary outgoing edges` (hop-2 card published when the check fired) |
| restore keeps the run through branch and tree moves and never restores into a new session | `moa-checkpoint.test.ts` · `keeps the run across a tree move onto its pause response and across a branch from a later prompt, drops it on a branch before it, and holds none in a new session`; `restores the entry conversation and images with a redone entry hop` |
| typecheck and lint | the typecheck command exits 0 |

## 6. Out of scope

The following are not part of M2 and MUST NOT be implemented, even where a
spec section mentions them: steering hops and the steering picker (M3),
tools on members, `awaiting_tools`/`resume_hop`/`closing` phases, the
closing call (M3), the file-operations summary of the tool trace (M3),
fan-out (M4), the configurator overlay and `/mixture configure|list|use`
(M5), the gateway (M6), the status line, `mixture_run_start` and
`mixture_hop_start` session events, per-scope picker filtering, and a card
for the snapcompact degrade (M7). The side panel is another lane's work:
M2 does not reference it; that lane's plan, which lands after M2, owns
the panel's handling of the `mixture_decision` session event and of
`session.resetMixtureRuns()`. No changelog entry is required; the spec
amendment of Step 1 is the documentation change.

— Fable (anthropic/claude-fable-5-1) via npi

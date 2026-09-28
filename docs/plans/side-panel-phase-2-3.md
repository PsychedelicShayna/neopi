# Implementation plan: side panel Phase 2 and Phase 3

Plan name: `side-panel-phase-2-3`. Questions file:
`docs/plans/QUESTIONS-side-panel-phase-2-3.md`.

Spec: `docs/specs/side-panel.md` (the **spec**). MoA spec:
`docs/specs/mixture-of-agents.md` (the **MoA spec**). Both are in the
worktree at the commit the plan starts from.

## 0. Definitions

These words have exactly one meaning in this plan. The plan MUST NOT be read
with synonyms.

- **worktree**: `/home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23`.
- **branch**: `feat/side-panel-p23`, at `955b7b385f` when the plan starts.
- **panel**: the `SidePanel` component, `packages/tui/src/chrome/side-panel.ts` (class `SidePanel`).
- **controller**: `SidePanelController`, `packages/coding-agent/src/modes/controllers/side-panel-controller.ts` (class `SidePanelController`).
- **section**: an object implementing `SidePanelSection`, `packages/tui/src/chrome/side-panel.ts:17-28 (interface SidePanelSection)`.
- **todo section**: `TodoSection`, `packages/coding-agent/src/modes/side-panel/todo-section.ts:218-243 (class TodoSection)`.
- **trace section**: `MixtureTraceSection`, the class this plan creates in `packages/coding-agent/src/modes/side-panel/trace-section.ts`.
- **card**: a `custom_message` session entry whose `customType === MIXTURE_TRACE_MESSAGE_TYPE` (`"mixture_trace"`, `packages/tui/src/overlays/mixture-types.ts:267 (const MIXTURE_TRACE_MESSAGE_TYPE)`), with `details` of type `MixtureTraceDetails`.
- **trace**: one `MixtureTraceDetails` value, `packages/tui/src/overlays/mixture-types.ts:229-264 (type MixtureTraceDetails)`. A trace has a `kind`. The kinds are exactly: `run_start`, `hop`, `branch`, `decision`, `steering`, `limit`, `checkpoint`, `run_end`.
- **header**: the `MixtureTraceHeader` part of a trace, `packages/tui/src/overlays/mixture-types.ts:208-227 (interface MixtureTraceHeader)`: `runId`, `mixture`, `seq`, `at`, `run.status`, `run.phase`, `run.hops`, `run.usd`, `run.window`, `run.endReason?`, `run.activeMemberId?`.
- **run record**: a `custom` session entry whose `customType === MIXTURE_RUN_ENTRY_TYPE` (`"mixture_run"`, `packages/coding-agent/src/moa/types.ts:250 (const MIXTURE_RUN_ENTRY_TYPE)`). Its `data` is either a `MixtureCheckpoint` (`moa/types.ts:233-242`, discriminated by `reason`) or a `MixtureLifecycleRecord` (`moa/types.ts:245-247`, discriminated by `kind`, values `run_end` | `run_reset`).
- **mixture event**: one of the `AgentSessionEvent` variants in `MixtureSessionEvent`, `packages/coding-agent/src/moa/host.ts:31-35 (type MixtureSessionEvent)`. At `955b7b385f` there are four: `mixture_hop_end`, `mixture_limit`, `mixture_checkpoint`, `mixture_run_end`. MoA M2 (the tree Phase 3 runs on, §1.1) adds a fifth, `mixture_decision`, carrying a `decision`-kind trace. Each carries `details: MixtureTraceDetails`. **No other `mixture_*` event exists in either tree.**
- **branch walk**: the array `sessionManager.getBranch()` (`packages/coding-agent/src/session/session-manager.ts:3110-3112 (getBranch)`) read from its last element toward its first, stopping at (not including) the first entry whose `type === "reset_boundary"` (`packages/coding-agent/src/session/session-entries.ts:164-166 (interface ResetBoundaryEntry)`).
- **projection**: the value returned by `projectMixtureTrace(sessionManager)`, defined in step 6.
- **complete**: the predicate `isMixtureRunComplete(branch, runId)` defined in step 6.
- **hop row**, **decision row**, **steering row**, **checkpoint row**, **limit row**, **totals row**, **banner**: the rows the trace section renders, defined in step 7.
- **heavy command**: any `bun test`, `bun run check:types`, a build, or a CLI smoke run.
- **Types**: the two per-package type checks, run one after the other, exactly as the `Types` template in §4 spells them. `bun run check:ts` at the repo root is NOT used: its `check:tools` prefix runs `oxlint` and `oxfmt --check` (root `package.json`, scripts `check:ts` and `check:tools`), which §1 forbids.
- **polite**: `/home/shayna/.local/share/polite-relay/polite`.

## 1. Closed world

The implementer MAY create or modify only the files in this list. Any other
file MUST NOT be modified. A step that needs an unlisted file MUST STOP per
§3.

Create:

- `docs/plans/QUESTIONS-side-panel-phase-2-3.md` (only per §3)
- `packages/coding-agent/src/modes/side-panel/trace-projection.ts`
- `packages/coding-agent/src/modes/side-panel/trace-section.ts`
- `packages/coding-agent/test/trace-projection.test.ts`
- `packages/coding-agent/test/trace-section.test.ts`

MUST NOT create or modify (owned by the MoA M2 plan, running in another
worktree): `packages/coding-agent/src/moa/restore.ts` and its tests. This
plan **imports** from that file and never defines its contents (§1.1).

Modify:

- `docs/specs/side-panel.md` (step 1 only, exactly the text in §5)
- `packages/tui/README.md` (step 2 only)
- `docs/tui.md` (step 2 only)
- `packages/tui/src/chrome/side-panel-fullscreen.ts` (step 3 only)
- `packages/coding-agent/src/modes/controllers/side-panel-controller.ts` (step 3 only)
- `packages/coding-agent/test/side-panel-controller.test.ts` (step 3 only)
- `packages/tui/src/chrome/side-panel.ts` (step 4 only)
- `packages/coding-agent/src/modes/interactive-mode.ts` (steps 8 and 9 only)
- `packages/coding-agent/src/modes/controllers/event-controller.ts` (step 8 only)
- `packages/coding-agent/src/modes/controllers/command-controller.ts` (step 9 only)
- `packages/coding-agent/src/slash-commands/builtin-collaboration.ts` (step 9 only: the `/mixture reset` handler MoA M2 adds; absent at `955b7b385f`, present after the step-5a gate)
- `packages/coding-agent/src/modes/types.ts` (steps 8 and 9 only: the `InteractiveModeContext` interface, `modes/types.ts:110 (interface InteractiveModeContext)`, which both controllers take as `ctx`)
- `packages/tui/CHANGELOG.md` (step 10 only)
- `packages/coding-agent/CHANGELOG.md` (step 10 only)

Out of scope (MUST NOT be done, even if the spec mentions it):

- Anything in `docs/specs/mixture-of-agents.md`.
- `packages/coding-agent/src/moa/restore.ts` in any form (§1.1).
- Creating or changing `/mixture` slash commands. MoA M2 adds them (`packages/coding-agent/src/slash-commands/builtin-collaboration.ts`); at `955b7b385f` none exist. This plan adds exactly **one line** to M2's `/mixture reset` handler (step 9 action 3) and nothing else there.
- Writing a `run_reset` run record (no writer exists in the tree; `MixtureLifecycleRecord` only types it). The projection MUST still honour a `run_reset` record if one is present.
- `restoreMixtureRun` (MoA §4.8 engine restore; MoA M2 work).
- The events `mixture_run_start` and `mixture_hop_start` named in spec §9 and MoA §7.2: they do not exist in either tree and go to the MoA roadmap; the trace section MUST NOT reference them. The event `mixture_decision` is **emitted** by MoA M2, not by this plan; this plan **forwards** it to the panel (step 8 action 2 adds the `handleMixtureEvent` call to M2's handler-map case) and the trace section renders `decision` traces from whichever path delivers them, because step 7 branches on the trace's `kind`, never on the event type.
- A keyboard-focusable panel (spec §10).
- Persisting collapsed state (spec §7 Phase 2: "No persistence (A7)").
- Changing any `cfgSidebar*` setting's `ui:` block, id, or default (`packages/coding-agent/src/modes/settings.ts:564-667`). They already appear in the settings overlay automatically (`packages/coding-agent/src/config/settings-ui.ts:51-68 (createSettingsHost)`, `packages/tui/src/overlays/settings-defs.ts:47-53 (TAB_GROUPS)` already lists `"Side Panel"`).
- Formatting or linting runs, including `oxlint`, `oxfmt`, and the root `bun run check:ts` (whose `check:tools` prefix runs both). Project-wide test runs. `bun check`.


### 1.1 The restore contract this plan imports (agreed with the MoA M2 lane)

`packages/coding-agent/src/moa/restore.ts` is created by the MoA M2 plan.
M2 cuts its first commit of that file as an early PR titled `feat(moa):
terminal predicate for mixture runs (restore.ts)`; that PR is an earlier
dependency milestone only. **Phase 3 of this plan waits for the full MoA
M2 merge on `origin/neopi`**, because it also consumes three later M2
surfaces (below); the step-5a gate checks all of them and merging the early
PR alone cannot pass it. Its two exports, byte-exact:

```ts
export function completedMixtureRun(branch: readonly SessionEntry[], runId: string): MixtureCheckpoint | undefined;
export function isMixtureRunComplete(branch: readonly SessionEntry[], runId: string): boolean;
```

`SessionEntry` is `packages/coding-agent/src/session/session-entries.ts:300-316 (type SessionEntry)`,
the array `sessionManager.getBranch()` returns (root → leaf);
`MixtureCheckpoint` is `packages/coding-agent/src/moa/types.ts:233-242 (interface MixtureCheckpoint)`.
Neither function touches a session manager. `completedMixtureRun` returns
the `done` checkpoint's data iff the MoA §4.8 predicate holds (indices `c <
a`, no `reset_boundary` at or after `c`, `c` a `custom` entry with
`customType "mixture_run"`, `data.reason === "done"`, `data.run.id ===
runId`, `data.outerResponseId` defined; `a` a `message` entry with role
`assistant` and `responseId === c.data.outerResponseId`; a `run_end` record
never affects it); when several `done` checkpoints satisfy it, the newest.
`isMixtureRunComplete` is `completedMixtureRun(...) !== undefined`. The
checkpoint's `run.endReason` is the projection's `endReason`.
`restoreMixtureRun` lands later in the same file without changing these
two signatures.

The same M2 merge that lands `restore.ts` also lands three surfaces this
plan consumes in step 8 (stated by the M2 plan; the step-5a gate verifies
each is present before Phase 3 starts):

- `mixture_decision` in the `EventController` handler map,
  `packages/coding-agent/src/modes/controllers/event-controller.ts`, written
  by M2 as `mixture_decision: async e => this.#showMixtureTrace(e.details)`
  beside the `mixture_limit` case;
- `MixtureDecision.outcome: string` on the decision trace
  (`packages/tui/src/overlays/mixture-types.ts`, interface
  `MixtureDecision`): the presentation phrase for the decision, in the
  form `→ rebut 0.71`;
- `AgentSession.resetMixtureRuns(): { mixture: string; runId: string }[]`
  (`packages/coding-agent/src/session/agent-session.ts`) and the
  `/mixture reset` handler in
  `packages/coding-agent/src/slash-commands/builtin-collaboration.ts` that
  calls it.
## 2. Precedence

1. The spec, at the section the plan cites, is authoritative over this plan, **except** where §1 "Out of scope" or a step in §6 says the spec names something absent from the tree; there this plan is authoritative and the implementer MUST follow the plan.
2. This plan is authoritative over the implementer's judgment.
3. `AGENTS.md` at the worktree root is authoritative over both for code style and test style.

## 3. Stop conditions

The implementer MUST STOP and ask, and MUST NOT improvise, when any of the
following holds (exhaustive list):

1. The spec and the tree disagree in a way this plan does not already resolve in §1 or §6.
2. A cited symbol or quoted text cannot be found in the file the plan names. Line numbers in this plan are baseline navigation hints from `955b7b385f` (before any step runs); the plan's own edits, and the rebase in step 5a, move later lines, and that movement is NOT a stop condition. Identity is the symbol name, or the quoted text where the plan quotes text; a symbol found at a different line is a match. Only a symbol or quoted text that is absent from the named file, or present more than once where the plan requires uniqueness, stops.
3. A test this plan says MUST FAIL before a change passes before the change.
4. A test this plan says MUST PASS after a change fails after the change, and the implementer has not found the cause within one attempt at reading the failure output.
5. A command this plan lists exits non-zero in a way the plan does not predict.
6. polite exits 75.
7. A step needs a file not in §1.
8. `git verify-commit HEAD` fails.

How to ask: append to `docs/plans/QUESTIONS-side-panel-phase-2-3.md` a
section headed `## Step <N>: <one line>` that quotes the step text, quotes
the evidence (the command and its output, or the file lines), and states the
question. Commit nothing further. Tell the operator in chat. The implementer
cannot reach Fable, Main, or any other agent.

## 4. Standing implementer rules

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

Worktree: `/home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23`.
Branch: `feat/side-panel-p23`.

Command templates used below (exact; substitute only `<file>`):

- Test: `cd /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23 && GIT_CONFIG_GLOBAL=/tmp/test-gitconfig /home/shayna/.local/share/polite-relay/polite --label sp23 -- bun test <file>`
- Types: `cd /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23/packages/tui && /home/shayna/.local/share/polite-relay/polite --mem --label sp23-ts -- bun run check:types && cd /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23/packages/coding-agent && /home/shayna/.local/share/polite-relay/polite --mem --label sp23-ts -- bun run check:types` (each package's `check:types` is `tsgo -p tsconfig.json --noEmit`, `packages/tui/package.json` and `packages/coding-agent/package.json` scripts `check:types`; both MUST exit 0 for `Types` to count as exit 0)
- Verify: `cd /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23 && git verify-commit HEAD`

## 5. Spec amendment 11 (landed in step 1)

The spec §9 was written before MoA M1 merged and names things the tree does
not have. Step 1 applies the following replacements to
`docs/specs/side-panel.md`, verbatim. Line numbers are from `955b7b385f`.

### 5.1 Replace lines 1266-1273 (line 1274, `MoA §7.2 names this panel as the consumer of both.`, stays unchanged)

Replace:

```
the MoA spec is under concurrent revision and line numbers have moved every
round (G2.3, G3.3, G4.2). The session
host emits every hop, decision, limit, checkpoint, and steering as a
`MixtureTraceDetails` in two places: live, as `AgentSessionEvent`s
`mixture_run_start`, `mixture_hop_start`, `mixture_hop_end`,
`mixture_decision`, `mixture_limit`, `mixture_checkpoint`, `mixture_run_end`;
and persisted, as display-only `custom_message` entries with `customType:
"mixture_trace"` that render as cards and are excluded from the LLM context.
```

with:

```
the MoA spec is under concurrent revision and line numbers have moved every
round (G2.3, G3.3, G4.2). As merged in MoA M1 (`955b7b385f`), the session
host emits **four** `AgentSessionEvent`s, typed as `MixtureSessionEvent`
(`packages/coding-agent/src/moa/host.ts`): `mixture_hop_end`,
`mixture_limit`, `mixture_checkpoint`, `mixture_run_end` (MoA M2 adds a
fifth, `mixture_decision`, carrying a `decision` trace), each carrying
`details: MixtureTraceDetails`; and persists `hop`/`branch`, `limit`, and
`checkpoint` traces as display-only `custom_message` entries with
`customType: "mixture_trace"` (`MIXTURE_TRACE_MESSAGE_TYPE`,
`packages/tui/src/overlays/mixture-types.ts`) through
`sessionManager.appendCustomMessageEntry`, excluded from the LLM context.
`run_end` is an event only; the `run_end` lifecycle record is appended to
the `mixture_run` entry after the assistant entry it refers to
(`host.ts` `commitPersisted`). The events `mixture_run_start`,
`mixture_hop_start`, and `mixture_decision` are **not** emitted in M1
(`mixture_decision` arrives with MoA M2; the other two are roadmap); the
section derives run start from the first trace it sees for a `runId`.
```

### 5.2 Replace lines 1286-1287

Replace:

```
  /** Live path: every mixture_* AgentSessionEvent, each carrying MixtureTraceDetails. */
  handleEvent(event: Extract<AgentSessionEvent, { type: `mixture_${string}` }>): void;
```

with:

```
  /** Live path: every MixtureSessionEvent (the four mixture_* events M1 emits), each carrying MixtureTraceDetails. */
  handleEvent(event: MixtureSessionEvent): void;
```

### 5.3 Replace lines 1317-1319

Replace:

```
  it, and (iv) `isMixtureRunComplete(branch, runId)`, exported from
  `packages/coding-agent/src/moa/restore.ts` (MoA §4.8), which the panel
  **calls** rather than re-deriving. Its definition, verbatim from MoA:
```

with:

```
  it, and (iv) `isMixtureRunComplete(branch, runId)` and its companion
  `completedMixtureRun(branch, runId)` (the `done` checkpoint when complete,
  else `undefined`), both exported from
  `packages/coding-agent/src/moa/restore.ts` (MoA §4.8, landed by MoA M2 in
  its own PR before Phase 3 starts), which the panel **calls** rather than
  re-deriving. Its definition, verbatim from MoA:
```

### 5.4 Replace lines 1356-1359

Replace:

```
- Live: `reset()` on `/mixture reset` (the engine appends the `run_reset`
  record in the same command, MoA §10) and when `mixture_run_start` carries
  a `runId` different from the one shown, so after two runs the live view
  holds only the latest; `markEnded` on the `mixture_run_end` event, which
```

with:

```
- Live: `reset()` when a mixture event carries a header `runId` different
  from the one shown, so after two runs the live view holds only the
  latest (`/mixture reset` and the `run_reset` writer are MoA work not in
  M1; when they land, `reset()` is also called from that command);
  `markEnded` on the `mixture_run_end` event, which
```

### 5.6 Replace, in the `MixtureTraceSection` sketch, the `hydrate` line

Replace:

```
  /** Reload path: the projection of §9 "One projection", in entry order. */
  hydrate(details: readonly MixtureTraceDetails[]): void;
```

with:

```
  /** Reload path: the projection of §9 "One projection" (`MixtureTraceProjection`, `modes/side-panel/trace-projection.ts`). */
  hydrate(projection: MixtureTraceProjection): void;
```

### 5.7 Replace the registration bullet

Replace:

```
- Registered **once** at init by `EventController` next to its todo handling
  (`event-controller.ts:1963-1966`), never unregistered on `mixture_run_end`:
```

with:

```
- Registered **once** in the `InteractiveMode` constructor beside the todo
  section (`interactive-mode.ts`, symbol `#traceSection`, next to
  `#todoSection`); `EventController` forwards every `MixtureSessionEvent`
  variant (four in M1, five once M2 adds `mixture_decision`) to it
  through `InteractiveModeContext.handleMixtureEvent`; never unregistered on
  `mixture_run_end`:
```

### 5.8 Replace the projection input sentence

Replace:

```
  its lifecycle record**, and nothing else. `hydrate` input is computed by
  `projectMixtureTrace(sessionManager)`: walk `sessionManager.getBranch()`
```

with:

```
  its lifecycle record**, and nothing else. `hydrate` input is computed by
  `projectMixtureTrace(branch)` over the array `sessionManager.getBranch()`
  returns (`modes/side-panel/trace-projection.ts`); the projection never
  calls the session manager itself. Walk that array
```

### 5.5 Replace lines 1350-1355

Replace:

```
- `hydrate` runs at the same transitions as the run store: session load,
  every leaf change (tree navigation, session/branch switch), and `/clear`.
  The existing per-session reload hook `reloadTodos` (`interactive-mode.ts:7526-7529`)
  is where `InteractiveMode` already re-derives view state from a session;
  `reloadMixtureTrace(source)` is added beside it and called from the same
  sites.
```

with:

```
- `hydrate` runs at the same transitions as the todo HUD: session load
  (`InteractiveMode.init`), and every caller of `reloadTodos`
  (`interactive-mode.ts`, symbol `reloadTodos`: tree navigation, session
  switch, resume, new session, focus attach, handoff, relocate, collab).
  `reloadMixtureTrace(source)` is added beside `reloadTodos` and called from
  `reloadTodos` itself, so every existing site is covered without editing
  each one. `/clear` (`command-controller.ts`, symbol
  `handleResetContextCommand`) is not a `reloadTodos` site; it calls
  `reloadMixtureTrace` directly after `session.resetSessionContext()`, so a
  fresh `reset_boundary` empties the section.
```

## 6. Steps

Every step: input state → actions → exit condition → commit. Steps MUST run
in order. A step's commit MUST exist before the next step starts.

### Step 1: land spec amendment 11

Input state: worktree at `955b7b385f`, clean (`git status --porcelain` prints nothing).

Actions:

1. Apply §5.1–§5.8 to `docs/specs/side-panel.md` exactly, in the order §5.8, §5.7, §5.6, §5.5, §5.4, §5.3, §5.2, §5.1 (bottom of the file first, so no earlier replacement shifts a later one's location). For each: locate the "Replace:" block by searching the file for its **first line** (each first line occurs exactly once in the file at `955b7b385f`); confirm the block matches byte-for-byte from that line; if the first line is absent, occurs more than once, or the block differs, STOP (§3 item 2). The line ranges in the §5 headings are navigation hints only.
2. In the spec's "## Revision log", insert immediately after the line `## Revision log` (and its following blank line) this block, verbatim:

```
**amendment 11** (Phase 3 plan, `docs/plans/side-panel-phase-2-3.md`):
§9 aligned to MoA M1 as merged — four `MixtureSessionEvent`s, cards via
`appendCustomMessageEntry`, `isMixtureRunComplete`/`completedMixtureRun`
imported from `moa/restore.ts` (MoA M2's own PR, the Phase 3 gate), live
reset keyed on a new header `runId`, hydration via
`reloadTodos` plus an explicit `/clear` call. `/mixture reset`, the
`run_reset` writer, `restoreMixtureRun`, `mixture_decision`, and the two
unemitted events stay MoA work.

```

Exit condition: `git diff --stat docs/specs/side-panel.md` shows exactly that file changed; the eight "with:" texts are present (each found by `grep -n` of its first line).

Commit subject: `docs(specs): side-panel amendment 11 — §9 aligned to MoA M1 as merged`

### Step 2: README row and docs/tui.md paragraph (Phase 2)

Input state: step 1 committed.

Actions:

1. In `packages/tui/README.md`, insert after line 87 (the row beginning `| Panels | \`OverlayPanel\``) this row, verbatim:

```
| Side panel | `SidePanel`, `SidePanelSection`, `SidePanelFullscreenComponent` | `/chrome` |
```

2. In `docs/tui.md`, insert immediately before the line `## Mount points and return contracts` (line 106 at `955b7b385f`) this text, verbatim, followed by one blank line:

```
### Side panel sections

`SidePanel` (`@oh-my-pi/pi-tui/chrome`) is the docked column beside the
chat (`docs/specs/side-panel.md`). Consumers register a `SidePanelSection`
(`id`, `title`, `content`, optional `order` and `collapsed`) through
`SidePanelController.register` and update it in place; the panel scrolls
a logical document of all sections and shows a dim placeholder when no
section is visible. A section notifies the panel only when its data
arrives outside a host path that already requests a render (spec §3.2).
Section content is a `Component` or a `(width) => string[]` renderer; only
a `Component` implementing `MouseRoutable` receives body clicks. The
`SidePanelSection` interface is frozen as of Phase 2; new fields require a
spec amendment. Keys: `app.sidebar.toggle` (`alt+t`),
`app.sidebar.scrollUp` (`alt+shift+up`), `app.sidebar.scrollDown`
(`alt+shift+down`).
```

Exit condition: `grep -n "Side panel | \`SidePanel\`" packages/tui/README.md` prints one line; `grep -n "^### Side panel sections" docs/tui.md` prints one line. No test (docs only; spec §8 "Not tested: … the README row").

Commit subject: `docs(tui): document SidePanel in the README composition table and docs/tui.md`

### Step 3: fullscreen footer uses keybinding display strings (Phase 2)

Input state: step 2 committed.

Spec: §7 Phase 2 "keybinding hint in the panel footer". Today
`packages/tui/src/chrome/side-panel-fullscreen.ts:43-50 (render)` interpolates
`toggleKeys[0]` as a raw `KeyId`; the controller passes
`this.#host.keybindings.getKeys("app.sidebar.toggle")` at
`packages/coding-agent/src/modes/controllers/side-panel-controller.ts:81 (toggle)`.

Actions:

1. In `side-panel-fullscreen.ts`, the options type **gains** `toggleHint: string` (the already-formatted display string) and **keeps** `toggleKeys: readonly KeyId[]` exactly as it is. The two options have separate jobs: the footer display reads `toggleHint` only; `handleInput` key matching reads `toggleKeys` only and is not edited. In `render`, replace the two lines computing `toggle`/`close` (`side-panel-fullscreen.ts:46-47`) with: `const close = this.#options.toggleHint === "" ? "esc" : \`esc / ${this.#options.toggleHint}\`;`. Keep the footer text shape `` `${close} close · ↑↓ scroll` `` unchanged.
2. In `side-panel-controller.ts` at the construction site of `SidePanelFullscreenComponent` (inside `toggle`, near line 81), pass `toggleHint: this.#host.keybindings.getDisplayString("app.sidebar.toggle")` (`packages/tui/src/app-keybindings.ts:726-732 (getDisplayString)`) in addition to `toggleKeys`.
3. In `packages/coding-agent/test/side-panel-controller.test.ts`, inside `describe("SidePanelController")`, add a test named exactly `it("shows the toggle key's display string in the fullscreen footer")`: build the narrow (100-column) controller the way `it("toggles the dock when wide and a fullscreen form when narrow")` does, call `toggle()`, settle, and assert the painted footer row contains `keybindings.getDisplayString("app.sidebar.toggle")` and does not contain the raw string `alt+t` unless the display string equals it. The test MUST FAIL before action 1–2 (the footer shows the raw KeyId) and PASS after.

Exit condition: `Test packages/coding-agent/test/side-panel-controller.test.ts` exits 0 with every existing test and the new one passing; `Test packages/coding-agent/test/side-panel-keys.test.ts` exits 0 (the toggle-key matching still works).

Commit subject: `feat(tui): render the side panel toggle hint from the keybinding display string`

### Step 4: freeze the section API (Phase 2)

Input state: step 3 committed.

Actions:

1. In `packages/tui/src/chrome/side-panel.ts`, immediately above `export interface SidePanelSection` (line 17), insert this doc comment, verbatim:

```
/**
 * Frozen as of side-panel Phase 2 (`docs/specs/side-panel.md` §7). Adding,
 * removing, or retyping a field requires a spec amendment; consumers
 * (`TodoSection`, `MixtureTraceSection`) build against exactly this shape.
 */
```

If a doc comment already exists directly above the interface, replace it with this one.

2. No other change. No test (a comment).

Exit condition: `Types` exits 0.

Commit subject: `docs(tui): mark SidePanelSection frozen as of Phase 2`

### Step 5: verify Phase 2 acceptance

Input state: step 4 committed. No actions. Run, in order, and record each result:

1. `Test packages/tui/test/side-panel.test.ts` → exit 0.
2. `Test packages/coding-agent/test/side-panel-controller.test.ts` → exit 0.
3. `Test packages/coding-agent/test/todo-section.test.ts` → exit 0.
4. `Test packages/coding-agent/test/side-panel-keys.test.ts` → exit 0.
5. `Test packages/coding-agent/test/side-panel-teardown.test.ts` → exit 0.
6. `Types` → exit 0.

Exit condition: all six exit 0. No commit. **Phase 2 is complete here**; the
operator MAY push and open a PR for steps 1–4 before Phase 3 starts.

### Step 5a: gate on the restore contract (Phase 3 entry)

Input state: step 5 passed.

Actions:

1. `cd /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23 && git fetch origin neopi`
2. `cd /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23 && git show origin/neopi:packages/coding-agent/src/moa/restore.ts`
3. If action 2 exits non-zero (the file is not on `origin/neopi`), STOP per §3 with the question `Phase 3 gate: moa/restore.ts is not on origin/neopi yet`. Phase 3 MUST NOT start. This gate is an **operator checkpoint**, not an implementer action: the MoA M2 executor never pushes; the operator merges **the full M2 branch** to `origin/neopi` (the early predicate PR `feat(moa): terminal predicate for mixture runs (restore.ts)` is an earlier milestone and does not by itself satisfy actions 4–4a) and then tells this implementer to resume at step 5a. Neither executor pushes or merges (§4).
4. If action 2 exits 0, its output MUST contain both lines `export function isMixtureRunComplete(` and `export function completedMixtureRun(`. If either is missing, STOP per §3 quoting the output.
4a. Verify the three M2 surfaces of §1.1, each by one command; every one MUST print at least one line, else STOP per §3 naming the missing surface: `git show origin/neopi:packages/coding-agent/src/modes/controllers/event-controller.ts | grep -n 'mixture_decision:'`; `git show origin/neopi:packages/tui/src/overlays/mixture-types.ts | grep -n 'outcome: string'`; `git show origin/neopi:packages/coding-agent/src/slash-commands/builtin-collaboration.ts | grep -c 'runtime.ctx.session.resetMixtureRuns()'` (this one MUST print exactly `1`: M2 lands two `resetMixtureRuns()` calls in that file — `runtime.session.resetMixtureRuns()` in the non-TUI `handle` and `runtime.ctx.session.resetMixtureRuns()` in `handleTui` — and only the `runtime.ctx.`-prefixed TUI statement is this plan's anchor).
5. `cd /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23 && git rebase --gpg-sign=/home/shayna/.ssh/id_ed25519_github_signing_agents.pub origin/neopi`. A rebase replays steps 1–4 as new commits on top of the merged restore contract; `--gpg-sign` with the agent key re-signs each replayed commit (a plain `git rebase` would drop the signatures and step 6 could never pass). The branch has no merge commits. If the rebase reports conflicts, run `git rebase --abort` and STOP per §3 quoting `git status --porcelain` from before the abort.
6. `cd /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23 && for c in $(git rev-list origin/neopi..HEAD); do git verify-commit "$c" || exit 1; done` → exit 0: every replayed commit verifies, not only `HEAD`. If it exits non-zero, STOP per §3 item 8 quoting the first failing hash.
7. `Types` → exit 0. If it fails, STOP per §3 quoting the first error.

Exit condition: `ls /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23/packages/coding-agent/src/moa/restore.ts` prints the path; actions 6 and 7 exit 0.

Commit: none (a rebase creates no new commit of its own).

### Step 6: `projectMixtureTrace` over the imported predicate (Phase 3)

Input state: step 5a passed; `restore.ts` present in the worktree.

Create `packages/coding-agent/src/modes/side-panel/trace-projection.ts`
exporting exactly one type and one function. Imports MUST be top-level.
The file MUST NOT define a completeness predicate of its own.

```ts
import type { SessionEntry } from "../../session/session-entries";
import type { MixtureTraceDetails, MixtureEndReason } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import type { MixtureLifecycleRecord } from "../../moa/types";
import { completedMixtureRun } from "../../moa/restore";

/** What the side panel shows for the newest run on the active branch. */
export interface MixtureTraceProjection {
	readonly runId: string | undefined;
	/** Cards for `runId`, in entry order (oldest first). Empty when `reset` is true. */
	readonly traces: readonly MixtureTraceDetails[];
	/** A `run_reset` lifecycle record for `runId` exists on the walk. */
	readonly reset: boolean;
	/** `completedMixtureRun(branch, runId) !== undefined`. */
	readonly complete: boolean;
	/** `run.endReason` of the checkpoint `completedMixtureRun` returned, when `complete`; else undefined. */
	readonly endReason: MixtureEndReason | undefined;
}

export function projectMixtureTrace(branch: readonly SessionEntry[]): MixtureTraceProjection;
```

Semantics (normative; the spec §9 "One projection" bullet is authoritative
where the two agree; completeness is delegated entirely to
`completedMixtureRun` per §1.1):

- The function reads `branch` as given (the caller passes `sessionManager.getBranch()`); it MUST NOT call the session manager.
- **Walk boundary.** Let `start` be the index one past the last entry with `type === "reset_boundary"`, or `0` if none. Only entries at indices `>= start` are considered. (This is the branch walk of §0, expressed forward.)
- **Entry recognition** (exhaustive):
  - a card: `entry.type === "custom_message" && entry.customType === "mixture_trace"`; its trace is `entry.details as MixtureTraceDetails`; its run id is `trace.runId`.
  - a checkpoint: `entry.type === "custom" && entry.customType === "mixture_run"` and `"reason" in entry.data`; its run id is `data.run.id`.
  - a lifecycle record: `entry.type === "custom" && entry.customType === "mixture_run"` and `"kind" in entry.data`; typed `MixtureLifecycleRecord`; its run id is `data.runId`.
- **`projectMixtureTrace(branch)`**:
  1. `runId` = the run id of the entry with the highest index `>= start` that is a card, a checkpoint, or a lifecycle record; `undefined` if there is none. When `undefined`, return `{ runId: undefined, traces: [], reset: false, complete: false, endReason: undefined }`.
  2. `reset` = a lifecycle record with `kind === "run_reset"` and that `runId` exists at an index `>= start`.
  3. If `reset`: return `{ runId, traces: [], reset: true, complete: false, endReason: undefined }`.
  4. `traces` = the traces of every card with that `runId`, indices `>= start`, in increasing index order.
  5. `const done = completedMixtureRun(branch, runId)`; `complete = done !== undefined`; `endReason = done?.run.endReason`.

Test file `packages/coding-agent/test/trace-projection.test.ts`,
`describe("projectMixtureTrace")`, using hand-built `SessionEntry[]` arrays
(no session manager, no `mock.module`, no spy on `completedMixtureRun`: the
real predicate from `restore.ts` runs). Every entry needs `id`, `parentId`,
`timestamp` (`packages/coding-agent/src/session/session-entries.ts:68-73 (interface SessionEntryBase)`).
Tests, exact names (exhaustive list):

1. `it("returns an empty projection for a branch with no mixture entries")`
2. `it("stops at the last reset_boundary and ignores older runs")` — cards for run A, a `reset_boundary`, cards for run B: `runId === "B"`, only B's traces.
3. `it("takes the newest run when two runs follow the boundary")` — cards for A then B, no boundary: `runId === "B"`; then cards for B then a lone checkpoint for C: `runId === "C"` with zero traces.
4. `it("honours a run_reset record with an empty projection")` — cards for B then `{ kind: "run_reset", runId: "B" }`: `reset === true`, `traces.length === 0`, `complete === false`.
5. `it("reports complete with the checkpoint's endReason when the predicate holds")` — a `done` checkpoint for B with `outerResponseId: "r1"` followed by an assistant entry with `responseId: "r1"`: `complete === true` and `endReason` equals that checkpoint's `run.endReason`; the same checkpoint without the assistant entry: `complete === false`, `endReason === undefined`. (The predicate's own branches are tested by the M2 plan in `restore.ts`'s tests; this test proves the projection forwards its answer.)
6. `it("treats a reset_boundary after the done checkpoint as ending the walk")` — `done` checkpoint, assistant entry, then `reset_boundary`: `runId === undefined`.

Before creating `trace-projection.ts`, run the test file: it MUST FAIL (module not found). After: MUST PASS.

Exit condition: `Test packages/coding-agent/test/trace-projection.test.ts` exits 0 with all 6 passing; `Types` exits 0.

Commit subject: `feat(coding-agent): projectMixtureTrace for the side panel over the restore predicate`

### Step 7: `MixtureTraceSection` (Phase 3)

Input state: step 6 committed.

Create `packages/coding-agent/src/modes/side-panel/trace-section.ts`. Public
surface (exact):

```ts
import type { Component } from "@oh-my-pi/pi-tui";
import type { MouseRoutable, SgrMouseEvent } from "@oh-my-pi/pi-tui/mouse";
import type { SidePanelSection } from "@oh-my-pi/pi-tui/chrome";
import type { MixtureTraceDetails, MixtureEndReason } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import type { MixtureSessionEvent } from "../../moa/host";
import type { MixtureTraceProjection } from "./trace-projection";

export class MixtureTraceSection implements SidePanelSection {
	readonly id = "mixture-trace";
	readonly title = "MIXTURE";
	readonly order = 20;
	collapsed?: boolean;
	readonly content: Component & MouseRoutable;
	/** Session events arrive outside any render-requesting host path, so this section notifies (spec §3.2 rule). */
	constructor(onChange: () => void);
	handleEvent(event: MixtureSessionEvent): void;
	hydrate(projection: MixtureTraceProjection): void;
	reset(): void;
	markEnded(endReason: MixtureEndReason): void;
}
```

State (all `#private`): the shown `runId | undefined`; an ordered list of
traces keyed by `seq` (a trace with the same `(runId, seq)` **replaces** the
earlier one, per the header doc "a card with the same (runId, seq) updates,
never duplicates", `mixture-types.ts:212`); `ended: MixtureEndReason |
undefined`; the set of expanded hop numbers.

Behaviour (normative):

- `handleEvent(event)`: let `t = event.details`. If the shown `runId` is defined and `t.runId !== runId`, call `reset()` first. Set `runId = t.runId`. Then: if `t.kind === "run_end"`, insert-or-replace `t` by `seq` and call `markEnded(t.endReason)`; for every other `kind`, insert-or-replace `t` by `seq`. The branch is on `t.kind`, not on `event.type`, so a `MixtureSessionEvent` variant added later (MoA M2 adds one carrying a `decision` trace) is handled without editing this method; the section MUST NOT name any event type other than through the `MixtureSessionEvent` parameter type. Then call `onChange()`.
- `hydrate(projection)`: call `reset()`; if `projection.reset` or `projection.runId === undefined`, call `onChange()` and return; set `runId = projection.runId`; insert every trace of `projection.traces` by `seq` in order; if `projection.complete` and `projection.endReason !== undefined`, `markEnded(projection.endReason)`; call `onChange()`.
- `reset()`: clear every state field. MUST NOT call `onChange()` (callers do).
- `markEnded(endReason)`: set `ended`. MUST NOT call `onChange()`.
- `content` is one `Component` (a private class in the same file) whose `render(width)` returns the rows below and whose `routeMouse(event, line, col)` handles a left click on a hop row by toggling that hop number in the expanded set and calling `onChange()`; other events are ignored. Each rendered row is tagged internally with the hop number it belongs to, or none.

Rows, in this order, from the trace list in `seq` order (spec §9 "Rows"):

- one **hop row** per trace with `kind === "hop"` or `"branch"`: `▸ <hop> <memberId> (<model>) ← <edgeInId ?? "open"> · <tokens> · $<usage.cost.total> · <elapsed>` where `<tokens>` is `usage.input + usage.output` formatted with a `k` suffix past 999, cost with two decimals, elapsed as seconds with `s`; the row of the trace whose `hop === header.run.hops` on the newest trace's header renders through `theme.fg("accent", …)`, every other hop row through `theme.fg("default", …)`; when the hop number is in the expanded set, `output` and then `reasoning` (each when present) follow the hop row: each is model text and MUST first pass through `replaceTabs(sanitizeText(text))` exactly as the transcript card does (`packages/tui/src/chat/mixture-trace.ts:101-104 (TraceBody constructor)`; `sanitizeText` from `@oh-my-pi/pi-utils`, `replaceTabs` from `@oh-my-pi/pi-tui`; AGENTS.md "TUI Sanitization"), then each line through `theme.fg("dim", …)` and wrapped by `new Text(sanitized, 0, 0).render(width - 2)` with a two-space indent. `memberId`, `model`, `edgeInId`, `decision.judge`, `decision.choice`, `targetMemberId`, `limit`, `reason`, and `mixture` are config/model-derived strings and MUST pass through `sanitizeText` before interpolation into any row;
- one **decision row** per trace with `kind === "decision"` (delivered by `hydrate` from cards, or live by M2's `mixture_decision` event; the row renders the same either way): `  <decision.kind> <sanitizeText(decision.outcome)> · <decision.judge>`. `decision.outcome` is the presentation phrase M2 adds to `MixtureDecision` (§1.1), already in the form `→ rebut 0.71`, so the row for the spec §9 example is `route → rebut 0.71 · jev`. The plan MUST NOT re-derive text from `decision.answer` (an `Answer` object, `packages/ai/src/judgment/types.ts:48-74`); interpolating `decision.answer` directly is forbidden because it prints `[object Object]`;
- one **steering row** per trace with `kind === "steering"`: `  ↪ steer → <targetMemberId>`;
- one **checkpoint row** per trace with `kind === "checkpoint"`: `  ⚑ checkpoint · hop <header.run.hops> · <reason>`;
- one **limit row** per trace with `kind === "limit"`: `  ⛔ limit: <limit> → <action>`;
- then the **totals row**: `Σ <header.run.hops> hops · $<header.run.usd, two decimals>` read from the **newest** trace's header only (spec §9: "never sums `usage` across kinds"); when `ended` is set, append ` · ended: <endReason>`;
- then the **banner**, present iff the newest trace's `header.run.status === "paused"` and `ended` is undefined: `⏸ paused: <limit of the newest limit trace with action === "pause", or "run"> · steer to resume` (spec §9, A5.2: "driven by run status, not by the last `limit` card").

Every row is passed through `truncateToWidth(row, width)` (`@oh-my-pi/pi-tui`
`utils`). With no traces, `render` returns `[]` (the panel shows its
placeholder or the todo section alone).

Test file `packages/coding-agent/test/trace-section.test.ts`,
`describe("MixtureTraceSection")`, unit tests over a fabricated
`MixtureSessionEvent` sequence and `MixtureTraceProjection` values (no
`InteractiveMode`, no session). Call `initTheme()` in `beforeAll` as
`packages/tui/test/side-panel.test.ts:32-34` does. Render at width 40. Exact
test names (exhaustive list):

1. `it("renders one hop row per hop trace and reads totals from the newest header")` — two `mixture_hop_end` events with `seq` 1 and 2, `run.usd` 0.04 then 0.09: two hop rows; the totals row shows `$0.09`, not `$0.13`.
2. `it("replaces a trace with the same seq instead of duplicating it")` — the same `seq` twice: one hop row.
3. `it("starts a new run when a trace carries a different runId")` — events for run A then one for run B: only B's row remains.
4. `it("shows the pause banner from run status and drops it on resume")` — a `mixture_limit` with `action: "pause"` and header `run.status: "paused"`: banner present with `hops`; then a `mixture_hop_end` with `run.status: "running"`: banner absent while the limit row remains.
5. `it("marks the run ended on mixture_run_end and on a complete projection")` — live: `mixture_run_end` with `endReason: "terminal"` → totals row ends with `ended: terminal`; hydrated: a projection with `complete: true, endReason: "terminal"` → identical rows.
6. `it("hydrates an empty projection to zero rows")` — `{ runId: "B", traces: [], reset: true, complete: false, endReason: undefined }` after live events → `render` returns `[]`.
7. `it("expands a hop's output on a left click and collapses it on the next")` — a hop trace with `output: "hello"`; `routeMouse` with a left click on the hop row's line → a dim `hello` row follows; click again → gone.
8. `it("notifies on every event and every hydrate, never on reset alone")` — count `onChange` calls: 1 per event, 1 per `hydrate`, 0 for a direct `reset()`.
9. `it("renders a decision card from its outcome phrase, never from the Answer object")` — hydrate two `decision` traces, `{ kind: "route", outcome: "→ rebut 0.71", judge: "jev", answer: { type: "choice", choice: "rebut", probabilities: { rebut: 0.71, yield: 0.29 }, confidence: 0.71 } }` and `{ kind: "verdict", outcome: "→ no 0.80", judge: "jev", answer: { type: "noul", noul: 0.2 } }` (each inside a full trace with a header): the rows contain `route → rebut 0.71 · jev` and `verdict → no 0.80 · jev`, and no row contains `[object`.
10. `it("strips input control sequences from expanded output before painting")` — a hop trace with `output: "ok\u001b[31mred\u001b[0m\tdone"` expanded by click. Two assertions, on two surfaces: (a) **visible text**: strip the renderer's own styling with `Bun.stripANSI` (the same helper `packages/coding-agent/test/todo-section.test.ts` uses through its `plain` helper) from the expanded rows and join them; the result contains `okred` immediately followed by exactly `DEFAULT_TAB_WIDTH` spaces (`@oh-my-pi/pi-utils` `DEFAULT_TAB_WIDTH`, re-exported by `@oh-my-pi/pi-tui`; `replaceTabs` at `packages/tui/src/utils.ts:199-201` replaces each tab with that many spaces) followed by `done`, and does not contain `[31m`; (b) **input escape inert**: the raw (unstripped) expanded rows contain no `\u001b[31m` substring — the input's red SGR never reaches the terminal — while they MAY contain the renderer's own `theme.fg("dim", …)` sequences, which the test MUST NOT forbid. `sanitizeText` (`packages/utils/src/sanitize-text.ts`) removes input ANSI and control sequences but keeps tabs; `replaceTabs` then widens them; theme styling is applied after both.

Before creating `trace-section.ts`, run the test file: MUST FAIL (module not
found). After: MUST PASS.

Exit condition: `Test packages/coding-agent/test/trace-section.test.ts` exits 0 with all 10 passing; `Types` exits 0.

Commit subject: `feat(coding-agent): MixtureTraceSection for the side panel`

### Step 8: register the trace section and feed it live events (Phase 3)

Input state: step 7 committed.

Actions:

1. `packages/coding-agent/src/modes/interactive-mode.ts`:
   - beside `readonly #todoSection = new TodoSection();` (`interactive-mode.ts:1021`), add `readonly #traceSection = new MixtureTraceSection(() => this.ui.requestRender());` with a top-level import of `MixtureTraceSection` from `./side-panel/trace-section`.
   - beside `this.#sidePanelController.register(this.#todoSection);` (`interactive-mode.ts:1496 (constructor)`), add `this.#sidePanelController.register(this.#traceSection);`.
   - add a public method `handleMixtureEvent(event: MixtureSessionEvent): void { this.#traceSection.handleEvent(event); }` next to `reloadTodos` (`interactive-mode.ts:7427-7430 (reloadTodos)`), with a top-level type import of `MixtureSessionEvent` from `../moa/host`.
2. `packages/coding-agent/src/modes/types.ts`, in `interface InteractiveModeContext` (`modes/types.ts:110`), immediately after the line `reloadTodos(source?: AgentSession): Promise<void>;` (`modes/types.ts:406`), add `handleMixtureEvent(event: MixtureSessionEvent): void;` with a top-level type import of `MixtureSessionEvent` from `../moa/host`. Then `packages/coding-agent/src/modes/controllers/event-controller.ts`, in the handler map (symbol: the object literal holding the `mixture_hop_end:` key; at `955b7b385f` lines 312-318, after the step-5a rebase it also holds M2's `mixture_decision:` case): for each of the **five** mixture cases (`mixture_hop_end`, `mixture_limit`, `mixture_checkpoint`, `mixture_decision`, `mixture_run_end`), call `this.ctx.handleMixtureEvent(e)` **first**, then the existing body. (`EventController` takes `ctx: InteractiveModeContext`, `event-controller.ts:253 (constructor)`; `InteractiveMode implements InteractiveModeContext`, `interactive-mode.ts:946`.)
3. Test: in `packages/coding-agent/test/trace-section.test.ts` add `describe("InteractiveMode mixture trace section")` with one test, exact name `it("adds a hop row to the docked panel when a mixture_hop_end event arrives")`: build a real `InteractiveMode` on a started `Composer` exactly as `packages/coding-agent/test/todo-section.test.ts:68-116 (describe "InteractiveMode todo HUD and side panel", beforeEach/afterEach)` does (same `resetSettingsForTest`, `Settings.init({ inMemory: true, cwd })`, `VirtualTerminal(120, 30)`, `new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, undefined, composer)`), dock with `"sidebar.enabled": true`, deliver one `mixture_hop_end` by `await mode.eventController.handleEvent(event)` (`interactive-mode.ts` getter `eventController`, `interactive-mode.ts:1228-1230`; `EventController.handleEvent` is the same dispatch map the live subscription reaches, and the existing MoA UI test drives it this way, `packages/coding-agent/test/moa-trace-ui.test.ts:101-102`). The todo harness never calls `InteractiveMode.init`, so `subscribeToAgent` (`event-controller.ts:635-666`) is not installed and `session.emitMixtureEvent` would reach no listener; the plan therefore does NOT use `emitMixtureEvent` in this test. After the awaited `handleEvent`, render with `composer.renderFrame({ columns: 120, rows: 30 })` as the todo harness's `frame()` helper does (`todo-section.test.ts:107`), and assert the painted panel column contains `MIXTURE` and the member id. Write this test **before** actions 1–2 and run the file: the new test MUST FAIL (the panel paints no `MIXTURE` title because nothing registers the section yet) while the ten step-7 tests still PASS; after actions 1–2 it MUST PASS.
4. One more test in `describe("InteractiveMode mixture trace section")` (CROSS-A1), exact name `it("adds a decision row when a mixture_decision event arrives")` — same harness, deliver `{ type: "mixture_decision", details: <a decision trace with outcome "→ rebut 0.71"> }` through `await mode.eventController.handleEvent(...)`, render, assert the panel column contains `→ rebut 0.71`. MUST FAIL before action 2 and PASS after.

Exit condition: `Test packages/coding-agent/test/trace-section.test.ts` exits 0 (12 tests); `Test packages/coding-agent/test/todo-section.test.ts` exits 0; `Types` exits 0.

Commit subject: `feat(coding-agent): register the mixture trace section and feed it session events`

### Step 9: hydrate on session transitions and `/clear` (Phase 3)

Input state: step 8 committed.

Actions:

1. `packages/coding-agent/src/modes/interactive-mode.ts`: add a public method next to `reloadTodos`:

```ts
reloadMixtureTrace(source: AgentSession = this.session): void {
	this.#traceSection.hydrate(projectMixtureTrace(source.sessionManager.getBranch()));
}
```

with a top-level import of `projectMixtureTrace` from `./side-panel/trace-projection`. Then change `reloadTodos` (`interactive-mode.ts:7427-7430`) so that after `await this.#loadTodoList(source);` and before `this.ui.requestRender();` it calls `this.reloadMixtureTrace(source);`. Then in `init` (`interactive-mode.ts:1842`, the line `await logger.time("InteractiveMode.init:todos", () => this.#loadTodoList());`), add immediately after it: `this.reloadMixtureTrace();`.
2. `packages/coding-agent/src/modes/types.ts`, in `interface InteractiveModeContext`, immediately after the `handleMixtureEvent` line added in step 8, add `reloadMixtureTrace(source?: AgentSession): void;`. Then `packages/coding-agent/src/modes/controllers/command-controller.ts`, in `handleResetContextCommand` (`command-controller.ts:1105-1134`), immediately after the line `const result = await this.ctx.session.resetSessionContext();` (`:1112`), add `this.ctx.reloadMixtureTrace();`. (`CommandController` takes `ctx: InteractiveModeContext`, `command-controller.ts:104 (constructor)`.)
3. `packages/coding-agent/src/slash-commands/builtin-collaboration.ts` (CROSS-A1), in M2's `/mixture reset` TUI handler. The M2 plan (step 9 item 4) lands the `reset` branch of `handleTui` as the single statement `runtime.ctx.showStatus(formatMixtureReset(runtime.ctx.session.resetMixtureRuns()));` with the context name `runtime.ctx`, and a separate non-TUI `handle` branch calling `runtime.session.resetMixtureRuns()` (no `ctx`), which this plan MUST NOT touch. Locate the TUI statement by searching the file for the substring `runtime.ctx.session.resetMixtureRuns()` (exactly one match, else STOP per §3; a bare `resetMixtureRuns()` search finds two and is NOT the anchor), and insert immediately **after** that statement, as its own statement on the next line, verbatim: `runtime.ctx.reloadMixtureTrace();`. Nothing else in the file changes. A `/mixture reset` then empties the panel because `projectMixtureTrace` finds the `run_reset` record M2 appends and returns an empty projection.
4. Test: in `packages/coding-agent/test/trace-section.test.ts` `describe("InteractiveMode mixture trace section")`, add three tests, exact names: `it("hydrates the newest run from the branch on reloadTodos")` — append two cards for run B via `session.sessionManager.appendCustomMessageEntry(MIXTURE_TRACE_MESSAGE_TYPE, "x", true, trace, "agent")` (signature `packages/coding-agent/src/session/session-manager.ts:2977-3003 (appendCustomMessageEntry)`), call `await mode.reloadTodos()`, settle, assert two hop rows painted; `it("empties the section after /clear writes a reset_boundary")` — with rows painted, call `session.resetSessionContext()` then `mode.reloadMixtureTrace()`, settle, assert no `MIXTURE` title in the panel; and `it("empties the panel when /mixture reset runs over a run_reset record")` (CROSS-A1) — the division of proof is: M2's own test (M2 plan step 9, `it("resets the held runs with a run_reset record each, …")`) proves that `/mixture reset` **writes** the `run_reset` record for a run the mixture host holds; this test proves that the **panel empties** when the command runs and that record is on the branch. The todo harness's `AgentSession` has no mixture host attached (`todo-section.test.ts:85-90` never calls `session.attachMixtureHost`, `agent-session.ts:2925 (attachMixtureHost)`), so `resetMixtureRuns()` holds nothing and writes nothing there; the test therefore seeds the record itself. Setup: append two cards for run B (as in the first test), then append the lifecycle record `session.sessionManager.appendCustomEntry(MIXTURE_RUN_ENTRY_TYPE, { kind: "run_reset", runId: "B", at: Date.now() })` (`session-manager.ts:2954-2958 (appendCustomEntry)`; `MIXTURE_RUN_ENTRY_TYPE` from `../src/moa/types`), then paint a hop row live through `mode.eventController.handleEvent` so the panel shows run B. Invoke the real command exactly as `packages/coding-agent/test/slash-commands/collab-list.test.ts:8-11,42-60` does: `import { executeBuiltinSlashCommand, type BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry"` and `await executeBuiltinSlashCommand("/mixture reset", { ctx: mode } as BuiltinSlashCommandRuntime)` — `mode` is the real `InteractiveMode`, which is the `InteractiveModeContext` the TUI branch reads as `runtime.ctx` (it has `session`, `showStatus`, and, after action 1, `reloadMixtureTrace`). Then render with `composer.renderFrame` and assert no `MIXTURE` title and no run-B member id in the panel column. Before action 3 the command runs but never calls `reloadMixtureTrace`, so the live row stays painted and the test FAILS; after action 3 it PASSES. Write all three tests **before** actions 1–3 and run the file: all three MUST FAIL (`reloadMixtureTrace` is not a method yet, so the file fails to type-check or throws at the call) while the earlier tests still PASS; after actions 1–3 all three MUST PASS.

Exit condition: `Test packages/coding-agent/test/trace-section.test.ts` exits 0 (15 tests: ten from step 7, two from step 8, three from step 9); `Test packages/coding-agent/test/todo-section.test.ts` exits 0; `Types` exits 0.

Commit subject: `feat(coding-agent): hydrate the mixture trace section on reload and /clear`

### Step 10: changelogs

Input state: step 9 committed.

Actions (the spec forbids changelog edits unless asked; the operator asks
here, for these entries only):

1. `packages/tui/CHANGELOG.md`: under `## [Unreleased]` (line 3), add a `### Added` heading and this bullet, verbatim: `- Added \`SidePanel\`, \`SidePanelSection\`, and \`SidePanelFullscreenComponent\` (\`/chrome\`): a docked side column beside the chat with a scrolling section document, a fullscreen form for narrow terminals, and keybinding-driven footer hints.`
2. `packages/coding-agent/CHANGELOG.md`: under `## [Unreleased]` → `### Added`, add this bullet, verbatim: `- Added the side panel (\`sidebar.*\` settings, \`alt+t\`) with the todo list and the Mixture of Agents trace as its first sections; the trace hydrates from the active branch on reload and empties on \`/clear\`.`

Exit condition: `git diff --stat` shows exactly the two changelog files.

Commit subject: `docs(changelog): side panel Phase 2–3 entries`

### Step 11: final verification

Input state: step 10 committed. Run, in order (no commit):

1. `Test packages/tui/test/side-panel.test.ts`
2. `Test packages/coding-agent/test/side-panel-controller.test.ts`
3. `Test packages/coding-agent/test/side-panel-keys.test.ts`
4. `Test packages/coding-agent/test/side-panel-teardown.test.ts`
5. `Test packages/coding-agent/test/todo-section.test.ts`
6. `Test packages/coding-agent/test/trace-projection.test.ts`
7. `Test packages/coding-agent/test/trace-section.test.ts`
8. `Test packages/coding-agent/test/moa-trace-ui.test.ts`
9. `Types`
10. `cd /home/shayna/source/github/PsychedelicShayna/neopi-sidepanel-p23 && git fetch origin neopi && git status --porcelain && git log --format='%h %s' --grep='Co-authored-by: GPT-6 Sol' origin/neopi..HEAD`. `git status --porcelain` MUST print nothing. The `git log` lists exactly the commits this plan authored that are not yet on `origin/neopi` (the trailer identifies them; `--grep` matches commit bodies).

Exit condition: 1–9 exit 0; the tree is clean; the step-10 log lists exactly the plan's commits not yet on `origin/neopi`: **nine** in total across both phases (steps 1, 2, 3, 4, 6, 7, 8, 9, 10; steps 5, 5a, and 11 create none), or **five** (steps 6–10) if the operator merged the Phase 2 PR at the step-5 boundary so that steps 1–4 are already on `origin/neopi`. Either count is correct; any other count is a STOP (§3 item 5). Then write the final report per §4.

## 7. Acceptance → evidence

| Acceptance | Evidence |
| --- | --- |
| Spec §9 matches the merged MoA M1 surface | step 1 commit; `grep -n "four" docs/specs/side-panel.md` finds the amended sentence |
| README lists `SidePanel`; `docs/tui.md` describes sections and keys (spec §7 Phase 2) | step 2 `grep` outputs |
| Fullscreen footer shows the keybinding display string (spec §7 Phase 2) | `side-panel-controller.test.ts` `it("shows the toggle key's display string in the fullscreen footer")` PASS; FAIL recorded before step 3 |
| `SidePanelSection` frozen (spec §7 Phase 2) | step 4 comment present; `Types` exit 0 |
| Projection over the imported predicate (spec §9 "One projection", §1.1) | `trace-projection.test.ts` all 6 PASS; FAIL recorded before step 6; step 5a gate output recorded |
| Trace rows, totals from newest header, status-driven banner, click-to-expand, Answer text, sanitized output (spec §9 "Rows") | `trace-section.test.ts` tests 1–10 PASS; FAIL recorded before step 7 |
| Live events reach the docked panel, including M2's `mixture_decision`; `/mixture reset` clears it (CROSS-A1) | `trace-section.test.ts` `it("adds a hop row to the docked panel when a mixture_hop_end event arrives")`, `it("adds a decision row when a mixture_decision event arrives")`, PASS; FAIL before step 8. `it("empties the panel when /mixture reset runs")` PASS; FAIL before step 9 |
| Hydration on reload; empty after `/clear` (spec §9 amended) | the first two step 9 tests PASS; FAIL before step 9 |
| Existing side-panel and MoA UI contracts unchanged | step 11 items 1–5 and 8 exit 0 |
| Type-clean | step 11 item 9 exit 0 |

## 8. Not done by this plan (stated so nothing is implied)

- No `moa/restore.ts` of its own (imported from MoA M2, §1.1), no `/mixture` command of its own (one line added to M2's `reset` handler), no `run_reset` writer (M2's), no `restoreMixtureRun`, no `mixture_run_start`/`hop_start` events; `mixture_decision` is emitted by M2 and only forwarded here (§1).
- No changes to `docs/specs/mixture-of-agents.md`.
- No keyboard focus for the panel (spec §10).
- No persistence of collapsed state.
- No formatter, linter, or project-wide test run; no root `bun run check:ts`.

— Fable (anthropic/claude-fable-5-1) via npi

# Mixture of Agents roadmap after M2

What the next milestone plans of `docs/specs/mixture-of-agents.md` (§14)
will need. Each milestone gets its own plan in this directory when its
turn comes; nothing here is a plan.

## M3: tools and steering (spec §14 "M3")

Spec sections: §4.4 (member call preparation, tool-choice normalization,
the closing call), §4.5 steps 3, 4, and 6 (`generating` with executable
outcomes, `awaiting_tools`, `resume_hop`, `closing`), §6 (steering:
recognition, the boundary probe, checkpoint at the boundary, the steering
hop, Esc as a checkpoint), §8.1 (per-member tools and engine-side
enforcement), §8.2 (single writer), §7 (`tool_trace` in cards).

Needs, in the order a plan would take them:

1. Spec amendment first: the step-0 table rows this M2 plan split
   (amendment 6.11 R1) collapse back into the steer rows (`paused` and
   `checkpoint` prompts become steers; the abort and pause notices drop
   their "not forwarded" sentences); the `resume` event of M2 is replaced
   by the steering hop, so `MixtureEvent` loses `resume` and the session
   host's notice for it.
2. `unwrapSteeringEnvelope` in `packages/coding-agent/src/session/messages.ts`
   (§6.1), `classifyTail` learning steers (`moa/request.ts`), the `@member:`
   prefix, `steering.target` resolution, `moa.steering_target`.
3. The steering probe: `MixtureHost.steeringProbe(options)` reading the
   loop's `hasSteeringMessages` (§6.2); the boundary checkpoint with
   `notices/checkpoint.md`; the steering hop with `envelopes/steering.md`
   and `edgeInId: "steering"`.
4. Tools: `hop.allowedToolNames`, outer tool-call ids `moa_<hop>_<n>`,
   `pendingToolCalls`, `appliedToolResultIds`, the `awaiting_tools` and
   `resume_hop` phases and their checkpoints (`reason: "tools"`), detour
   enforcement against `run.toolRequirement`, the closing call
   (`envelopes/closing.md`, phase `closing`), restore step 4 (synthetic
   tool results for lost calls, §4.8).
5. `tool-trace.md` gains the file-operations summary
   (`extractFileOpsFromMessage` / `upsertFileOperations`, §2 table).
6. Validation: the `tools` capability gate is lifted; `member.tools.unsupported`
   stays a warning; branch tools remain M4.
7. TUI: the Enter-while-streaming `SelectList` picker for an unprefixed
   steer (§6.1, decided: both prefix and picker).
8. Tests named in §13 for `moa-engine` (tool rounds, detours, retransmitted
   tool-call responses, steering during a hop, abort then steer) and
   `moa-checkpoint` (crash in `resume_hop`, lost tool results).
9. The `mixture_run_start` and `mixture_hop_start` session events are not
   needed by M3 either; they stay on the M7 list below.

## M4: fan-out (spec §14 "M4")

Spec sections: §8.3 (read-only MPSC groups: branches, `slices`, `join`,
`join_x`, `join_envelope`, `quorum`, `grace_ms`, `reservedHops`), §4.1
(`FanoutGroup`, phase `group_barrier`), §4.7 (fan-out under limits: a group
counts as one hop, cancellation of siblings on a budget or hard-cap hit),
§2 (`output` of a join = per-branch outputs), §3 (`envelopes/review-slice.md`,
`envelopes/aggregate.md`, `slicer.md`, `roles/reviewer.md`, `roles/worker.md`,
`envelopes/review.md`), §11 E20 and E22, §12 (`moa.read_only_tools`,
`moa.slicer_model`, `moa.fanout_grace_ms`).

Needs:

1. `ResolvedMixture.slicerModel` (`moa.slicer_model`, `uses.slicer`), the
   same allowed-pool and recursion rules as the summary model (amendment
   6.8, §1.4).
2. `FanoutGroup` on `MixtureRun`, the `group_barrier` phase in `#loop`,
   concurrent branch hops (`branchOf`, unique outer ids across a group),
   the join hop with `branches` in the envelope context, quorum and grace
   handling (engine-active time, tool waits excluded).
3. Read-only enforcement for branch tools (`moa.read_only_tools` bound,
   E20 `fanout.branch.tools`), branch `route`/`terminate`/edges ignored
   (E22 already warns).
4. The transcript's group rendering (one header per branch and one for the
   join, §2.1) and `HopRecord.branchOf` in `renderTranscript`.
5. Validation: the fan-out capability gate is lifted; E20 rules
   (`fanout.join`, `fanout.branches`, `fanout.slices`, `fanout.quorum`,
   `fanout.branch.verdict`).
6. Trace: the `branch` card variant; `mixture_hop_end` for branches.
7. Tests named in §13 for fan-out in `moa-engine` (quorum, straggler grace,
   a failed branch, hard-cap admission) and the bundled `review` presets.

## Later (M5–M7), for the record

- M5: the configurator overlay (`packages/tui/src/overlays/mixture-config.ts`),
  `/mixture configure|list|use`, save vs apply (§10), `packages/tui/test/mixture-config.test.ts`.
- M6: the auth-gateway (`gateway.serve`, keyless dispatch, `prepareStreamOptions`,
  the headless host, commit on the encoder's `onComplete`, `moa.run_state_ttl_minutes`),
  `packages/ai/test/auth-gateway-keyless.test.ts`, `packages/coding-agent/test/moa-gateway.test.ts`.
- M7 polish: the status line (§7.2), the `mixture_run_start` and
  `mixture_hop_start` session events the side panel asked for, per-scope
  filtering of mixture models in the picker (amendment 6.10), a card for
  the snapcompact degrade (amendment 6.11 R13), `emitNotice` for limits
  and checkpoints where M2 did not add one.

— Fable (anthropic/claude-fable-5-1) via npi

import type { PromptAsset } from "./types";
import opus5Preset from "./model-families/opus-5.md" with { type: "text" };
import {
	bashPromptContextFixture,
	describePromptContext,
	livePromptContextFixture,
	systemPromptContextFixture,
} from "./contexts";
import asset0 from "./advisor/active-repo-watchdog.md" with { type: "text" };
import asset1 from "./advisor/advise-tool.md" with { type: "text" };
import asset2 from "./advisor/boundary-guidance.md" with { type: "text" };
import asset3 from "./advisor/context-files.md" with { type: "text" };
import asset4 from "./advisor/memory-context.md" with { type: "text" };
import asset5 from "./advisor/system.md" with { type: "text" };
import asset6 from "../../../agent/src/prompts/dsml-tool-call-leak.md" with { type: "text" };
import asset7 from "./agents/claude-parent-context.md" with { type: "text" };
import asset8 from "./agents/frontmatter.md" with { type: "text" };
import asset9 from "./agents/init.md" with { type: "text" };
import asset10 from "./agents/model-mention.md" with { type: "text" };
import asset11 from "./agents/reviewer.md" with { type: "text" };
import asset12 from "./agents/scout.md" with { type: "text" };
import asset13 from "./agents/security-reviewer.md" with { type: "text" };
import asset14 from "./agents/task.md" with { type: "text" };
import asset15 from "../autoresearch/command-resume.md" with { type: "text" };
import asset16 from "../autoresearch/prompt-setup.md" with { type: "text" };
import asset17 from "../autoresearch/prompt.md" with { type: "text" };
import asset18 from "../autoresearch/resume-message.md" with { type: "text" };
import asset19 from "./bench/cache-prefix-chunk.md" with { type: "text" };
import asset20 from "./bench/cache-prefix.md" with { type: "text" };
import asset21 from "./bench/cache-suffix.md" with { type: "text" };
import asset22 from "./bench/chat.md" with { type: "text" };
import asset23 from "./bench/generation.md" with { type: "text" };
import asset24 from "./bench/prefill-instruction.md" with { type: "text" };
import asset25 from "./chains/input-with-context.md" with { type: "text" };
import asset26 from "./chains/system.md" with { type: "text" };
import asset27 from "./chat/advisor.md" with { type: "text" };
import asset28 from "./chat/chat.md" with { type: "text" };
import asset29 from "./chat/compaction.md" with { type: "text" };
import asset30 from "./chat/erp.md" with { type: "text" };
import asset31 from "./chat/system.md" with { type: "text" };
import asset32 from "./chronicler/chronicle-tool.md" with { type: "text" };
import asset33 from "./chronicler/context.md" with { type: "text" };
import asset34 from "./chronicler/entry.md" with { type: "text" };
import asset35 from "./chronicler/finish-tool.md" with { type: "text" };
import asset36 from "./chronicler/read-tool.md" with { type: "text" };
import asset37 from "./chronicler/system.md" with { type: "text" };
import asset38 from "./chronicler/temporal/rank-input.md" with { type: "text" };
import asset39 from "./chronicler/temporal/rank-system.md" with { type: "text" };
import asset40 from "./chronicler/temporal/summary-input.md" with { type: "text" };
import asset41 from "./chronicler/temporal/summary-system.md" with { type: "text" };
import asset42 from "./ci-green-request.md" with { type: "text" };
import asset43 from "../cleanse/prompts/assignment.md" with { type: "text" };
import asset44 from "../cleanse/prompts/discovery.md" with { type: "text" };
import asset45 from "../cleanse/prompts/follow-up.md" with { type: "text" };
import asset46 from "../commit/agentic/prompts/analyze-file.md" with { type: "text" };
import asset47 from "../commit/agentic/prompts/session-user.md" with { type: "text" };
import asset48 from "../commit/agentic/prompts/split-confirm.md" with { type: "text" };
import asset49 from "../commit/agentic/prompts/system.md" with { type: "text" };
import asset50 from "../commit/conventional/prompts/analysis.md" with { type: "text" };
import asset51 from "../commit/conventional/prompts/fast.md" with { type: "text" };
import asset52 from "../commit/conventional/prompts/map.md" with { type: "text" };
import asset53 from "../commit/conventional/prompts/reduce.md" with { type: "text" };
import asset54 from "../commit/conventional/prompts/summary-rewrite.md" with { type: "text" };
import asset55 from "../commit/conventional/prompts/summary.md" with { type: "text" };
import asset56 from "../commit/prompts/changelog-system.md" with { type: "text" };
import asset57 from "../commit/prompts/changelog-user.md" with { type: "text" };
import asset58 from "../commit/prompts/types-description.md" with { type: "text" };
import asset59 from "../../../agent/src/compaction/prompts/anthropic-compaction-instructions.md" with { type: "text" };
import asset60 from "../../../agent/src/compaction/prompts/auto-handoff-threshold-focus.md" with { type: "text" };
import asset61 from "../../../agent/src/compaction/prompts/branch-summary-context.md" with { type: "text" };
import asset62 from "../../../agent/src/compaction/prompts/branch-summary-preamble.md" with { type: "text" };
import asset63 from "../../../agent/src/compaction/prompts/branch-summary.md" with { type: "text" };
import asset64 from "../../../agent/src/compaction/prompts/compaction-short-summary.md" with { type: "text" };
import asset65 from "../../../agent/src/compaction/prompts/compaction-summary-context.md" with { type: "text" };
import asset66 from "../../../agent/src/compaction/prompts/compaction-summary.md" with { type: "text" };
import asset67 from "../../../agent/src/compaction/prompts/compaction-turn-prefix.md" with { type: "text" };
import asset68 from "../../../agent/src/compaction/prompts/compaction-update-summary.md" with { type: "text" };
import asset69 from "../../../agent/src/compaction/prompts/context-window-truncated-output.md" with { type: "text" };
import asset70 from "../../../agent/src/compaction/prompts/file-operations.md" with { type: "text" };
import asset71 from "../../../agent/src/compaction/prompts/handoff-document.md" with { type: "text" };
import asset72 from "../../../agent/src/compaction/prompts/handoff-summary-context.md" with { type: "text" };
import asset73 from "../../../agent/src/compaction/prompts/snapcompact-archive-context.md" with { type: "text" };
import asset74 from "../../../snapcompact/src/prompts/file-operations.md" with { type: "text" };
import asset75 from "../../../snapcompact/src/prompts/snapcompact-summary.md" with { type: "text" };
import asset76 from "../../../agent/src/compaction/prompts/summarization-system.md" with { type: "text" };
import asset77 from "../compress/prompts/request.md" with { type: "text" };
import asset78 from "../compress/prompts/review.md" with { type: "text" };
import asset79 from "../compress/prompts/system.md" with { type: "text" };
import asset80 from "./control-follow-up-warning.md" with { type: "text" };
import asset81 from "../discovery/builtin-rules/go-add-cleanup.md" with { type: "text" };
import asset82 from "../discovery/builtin-rules/go-bench-loop.md" with { type: "text" };
import asset83 from "../discovery/builtin-rules/go-exp-promoted.md" with { type: "text" };
import asset84 from "../discovery/builtin-rules/go-ioutil.md" with { type: "text" };
import asset85 from "../discovery/builtin-rules/go-join-hostport.md" with { type: "text" };
import asset86 from "../discovery/builtin-rules/go-new-expr.md" with { type: "text" };
import asset87 from "../discovery/builtin-rules/go-rand-v2.md" with { type: "text" };
import asset88 from "../discovery/builtin-rules/go-range-int.md" with { type: "text" };
import asset89 from "../discovery/builtin-rules/rs-box-leak.md" with { type: "text" };
import asset90 from "../discovery/builtin-rules/rs-future-prelude.md" with { type: "text" };
import asset91 from "../discovery/builtin-rules/rs-lazylock.md" with { type: "text" };
import asset92 from "../discovery/builtin-rules/rs-match-ergonomics.md" with { type: "text" };
import asset94 from "../discovery/builtin-rules/rs-result-type.md" with { type: "text" };
import asset95 from "../discovery/builtin-rules/ts-bare-catch.md" with { type: "text" };
import asset96 from "../discovery/builtin-rules/ts-import-type.md" with { type: "text" };
import asset97 from "../discovery/builtin-rules/ts-no-any.md" with { type: "text" };
import asset98 from "../discovery/builtin-rules/ts-no-deprecated-leftovers.md" with { type: "text" };
import asset99 from "../discovery/builtin-rules/ts-no-dynamic-import.md" with { type: "text" };
import asset100 from "../discovery/builtin-rules/ts-no-inline-cast-access.md" with { type: "text" };
import asset101 from "../discovery/builtin-rules/ts-no-local-is-record.md" with { type: "text" };
import asset102 from "../discovery/builtin-rules/ts-no-return-type.md" with { type: "text" };
import asset103 from "../discovery/builtin-rules/ts-no-test-timers.md" with { type: "text" };
import asset104 from "../discovery/builtin-rules/ts-no-tiny-functions.md" with { type: "text" };
import asset105 from "../discovery/builtin-rules/ts-promise-with-resolvers.md" with { type: "text" };
import asset106 from "../discovery/builtin-rules/ts-redundant-clear-guard.md" with { type: "text" };
import asset107 from "../discovery/builtin-rules/ts-set-map.md" with { type: "text" };
import asset108 from "./dry-balance-bench.md" with { type: "text" };
import asset109 from "../edit/auto-repair.md" with { type: "text" };
import asset110 from "../edit/hashline-compact.md" with { type: "text" };
import asset111 from "../extensibility/custom-commands/bundled/annotate/prompts/text-review.md" with { type: "text" };
import asset112 from "../extensibility/custom-commands/bundled/annotate/prompts/text-summary.md" with { type: "text" };
import asset113 from "../extensibility/custom-commands/bundled/review/prompts/annotations.md" with { type: "text" };
import asset114 from "./goals/goal-budget-limit.md" with { type: "text" };
import asset115 from "./goals/goal-continuation.md" with { type: "text" };
import asset116 from "./goals/goal-mode-active.md" with { type: "text" };
import asset117 from "./goals/goal-mode-context.md" with { type: "text" };
import asset118 from "./goals/goal-todo-context.md" with { type: "text" };
import asset119 from "./goals/guided-goal-interview.md" with { type: "text" };
import asset120 from "./idea-funnel.md" with { type: "text" };
import asset121 from "../if-bench/prompts/cat-directive.md" with { type: "text" };
import asset122 from "../if-bench/prompts/system.md" with { type: "text" };
import asset123 from "../if-bench/prompts/turn.md" with { type: "text" };
import asset124 from "./internal-urls/agent.md" with { type: "text" };
import asset125 from "./internal-urls/artifact.md" with { type: "text" };
import asset126 from "./internal-urls/cfg.md" with { type: "text" };
import asset127 from "./internal-urls/compaction.md" with { type: "text" };
import internalEnvironment from "./internal-urls/env.md" with { type: "text" };
import asset128 from "./internal-urls/history.md" with { type: "text" };
import asset129 from "./internal-urls/issue.md" with { type: "text" };
import asset130 from "./internal-urls/local.md" with { type: "text" };
import asset131 from "./internal-urls/mcp.md" with { type: "text" };
import asset132 from "./internal-urls/memory.md" with { type: "text" };
import internalModel from "./internal-urls/model.md" with { type: "text" };
import asset133 from "./internal-urls/omp.md" with { type: "text" };
import asset134 from "./internal-urls/proc.md" with { type: "text" };
import asset135 from "./internal-urls/rule.md" with { type: "text" };
import asset136 from "./internal-urls/security.md" with { type: "text" };
import asset137 from "./internal-urls/skill.md" with { type: "text" };
import asset138 from "./internal-urls/ssh.md" with { type: "text" };
import asset139 from "./internal-urls/tool.md" with { type: "text" };
import asset140 from "./internal-urls/vault.md" with { type: "text" };
import asset141 from "../issues/prompts/author-request.md" with { type: "text" };
import asset142 from "../issues/prompts/author-system.md" with { type: "text" };
import asset143 from "../issues/prompts/notice.md" with { type: "text" };
import asset144 from "../issues/prompts/target-request.md" with { type: "text" };
import asset145 from "../issues/prompts/target-system.md" with { type: "text" };
import asset146 from "../issues/prompts/tool-decline.md" with { type: "text" };
import asset147 from "../issues/prompts/tool-existing-owner.md" with { type: "text" };
import asset148 from "../issues/prompts/tool-labels.md" with { type: "text" };
import asset149 from "../issues/prompts/tool-publish.md" with { type: "text" };
import asset150 from "../issues/prompts/tool-samples.md" with { type: "text" };
import asset151 from "../issues/prompts/tool-search.md" with { type: "text" };
import asset152 from "../issues/prompts/tool-target.md" with { type: "text" };
import asset153 from "../issues/prompts/tool-view.md" with { type: "text" };
import asset154 from "./launch-profile.md" with { type: "text" };
import asset155 from "../live/prompts/agent-final-message.md" with { type: "text" };
import asset156 from "../live/prompts/live-client-protocol.md" with { type: "text" };
import asset157 from "../live/prompts/live-instructions.md" with { type: "text" };
import asset158 from "../live/prompts/operator-shared-message.md" with { type: "text" };
import asset159 from "../live/prompts/operator-typed-message.md" with { type: "text" };
import asset160 from "../live/prompts/subagent-importance.md" with { type: "text" };
import asset161 from "../live/prompts/voice-agent-note.md" with { type: "text" };
import livePersonaGenerationSystem from "../live/prompts/generate-persona.md" with { type: "text" };
import livePersonaGenerationUser from "../live/prompts/generate-persona-user.md" with { type: "text" };
import livePrimaryHistory from "../live/prompts/primary-history.md" with { type: "text" };
import liveOperatorSubmittedMessage from "../live/prompts/operator-submitted-message.md" with { type: "text" };
import liveSessionInstructions from "../live/prompts/session-instructions.md" with { type: "text" };
import asset162 from "./memories/consolidation_system.md" with { type: "text" };
import asset163 from "./memories/consolidation.md" with { type: "text" };
import asset164 from "./memories/read-path.md" with { type: "text" };
import asset165 from "./memories/sharpshooter-consolidate-input.md" with { type: "text" };
import asset166 from "./memories/sharpshooter-consolidate-system.md" with { type: "text" };
import asset167 from "./memories/sharpshooter-extract-input.md" with { type: "text" };
import asset168 from "./memories/sharpshooter-extract-system.md" with { type: "text" };
import asset169 from "./memories/stage_one_input.md" with { type: "text" };
import asset170 from "./memories/stage_one_system.md" with { type: "text" };
import asset171 from "./moa/envelopes/defend.md" with { type: "text" };
import asset172 from "./moa/envelopes/disagree.md" with { type: "text" };
import asset173 from "./moa/envelopes/entry.md" with { type: "text" };
import asset174 from "./moa/envelopes/handoff.md" with { type: "text" };
import asset175 from "./moa/envelopes/judge.md" with { type: "text" };
import asset176 from "./moa/envelopes/limit.md" with { type: "text" };
import asset177 from "./moa/envelopes/moa-parts.md" with { type: "text" };
import asset178 from "./moa/notices/limit.md" with { type: "text" };
import asset179 from "./moa/notices/pause.md" with { type: "text" };
import asset180 from "./moa/roles/defense.md" with { type: "text" };
import asset181 from "./moa/roles/judge.md" with { type: "text" };
import asset182 from "./moa/roles/prosecution.md" with { type: "text" };
import asset183 from "./moa/tool-trace.md" with { type: "text" };
import asset184 from "./moa/verdict.md" with { type: "text" };
import asset185 from "./npi-update.md" with { type: "text" };
import asset186 from "./ratchet-kickoff.md" with { type: "text" };
import asset187 from "./review-custom-request.md" with { type: "text" };
import asset188 from "./review-headless-request.md" with { type: "text" };
import asset189 from "./review-request.md" with { type: "text" };
import asset190 from "./security/scan-coordinator.md" with { type: "text" };
import asset191 from "./security/scan-request.md" with { type: "text" };
import asset192 from "./security/validate-request.md" with { type: "text" };
import asset193 from "./session/launch-completion.md" with { type: "text" };
import asset194 from "./session/transfer-arrived.md" with { type: "text" };
import asset195 from "./session/transfer-departed.md" with { type: "text" };
import asset196 from "./session/transfer-stale-fork.md" with { type: "text" };
import asset197 from "./skills/autoload.md" with { type: "text" };
import asset198 from "./skills/compress-description.md" with { type: "text" };
import asset199 from "./skills/user-invocation.md" with { type: "text" };
import asset200 from "./steering/parent-irc.md" with { type: "text" };
import asset201 from "./steering/user-interjection.md" with { type: "text" };
import asset202 from "./system/active-repo-context.md" with { type: "text" };
import asset203 from "./system/agent-creation-architect.md" with { type: "text" };
import asset204 from "./system/agent-creation-user.md" with { type: "text" };
import asset205 from "./system/agent-telemetry.md" with { type: "text" };
import asset206 from "./system/anthropic-usage-wrap-up.md" with { type: "text" };
import asset207 from "./system/auto-continue.md" with { type: "text" };
import asset208 from "./system/auto-thinking-effort-context.md" with { type: "text" };
import asset209 from "./system/auto-thinking-effort-question.md" with { type: "text" };
import asset210 from "./system/auto-thinking-minimal-criterion.md" with { type: "text" };
import asset211 from "./system/autolearn-guidance-learn.md" with { type: "text" };
import asset212 from "./system/autolearn-guidance.md" with { type: "text" };
import asset213 from "./system/autolearn-nudge-autocontinue.md" with { type: "text" };
import asset214 from "./system/background-tan-dispatch.md" with { type: "text" };
import asset215 from "./system/btw-user.md" with { type: "text" };
import asset216 from "./system/checkpoint-active-notice.md" with { type: "text" };
import asset217 from "./system/commit-message-system.md" with { type: "text" };
import asset218 from "./system/composer-prediction-user.md" with { type: "text" };
import asset219 from "./system/computer-use.md" with { type: "text" };
import asset220 from "./system/context-notes.md" with { type: "text" };
import asset221 from "./system/custom-system-prompt.md" with { type: "text" };
import asset222 from "./system/date-cwd-reminder.md" with { type: "text" };
import asset223 from "./system/eager-task.md" with { type: "text" };
import asset224 from "./system/eager-todo.md" with { type: "text" };
import asset225 from "./system/empty-stop-retry.md" with { type: "text" };
import asset226 from "./system/eval-prelude-notice.md" with { type: "text" };
import asset227 from "./system/eval-state-context.md" with { type: "text" };
import asset228 from "./system/experimental-context-notes-reminder.md" with { type: "text" };
import asset229 from "./system/experimental-context-rollover.md" with { type: "text" };
import asset230 from "./system/gemini-tool-call-reminder.md" with { type: "text" };
import asset231 from "./system/hindsight-instructions.md" with { type: "text" };
import asset232 from "./system/image-attachment.md" with { type: "text" };
import asset233 from "./system/interrupted-thinking.md" with { type: "text" };
import asset234 from "./system/irc-incoming.md" with { type: "text" };
import asset235 from "./system/jevify-notice.md" with { type: "text" };
import asset236 from "./system/judgment-local.md" with { type: "text" };
import asset237 from "./system/length-stop-retry.md" with { type: "text" };
import asset238 from "./system/malformed-function-call-retry.md" with { type: "text" };
import asset239 from "./system/manual-continue.md" with { type: "text" };
import asset240 from "./system/mcp-xdev-guidance.md" with { type: "text" };
import asset241 from "./system/memory-consolidation-system.md" with { type: "text" };
import asset242 from "./system/memory-extraction-system.md" with { type: "text" };
import asset243 from "./system/memory-recall-changes.md" with { type: "text" };
import asset244 from "./system/mid-run-todo-nudge.md" with { type: "text" };
import asset245 from "./system/mnemopi-instructions.md" with { type: "text" };
import asset246 from "./system/omfg-user.md" with { type: "text" };
import asset247 from "./system/operator-notice.md" with { type: "text" };
import asset248 from "./system/orchestrate-notice.md" with { type: "text" };
import asset249 from "./system/personalities/default.md" with { type: "text" };
import asset250 from "./system/personalities/friendly.md" with { type: "text" };
import asset251 from "./system/personalities/pragmatic.md" with { type: "text" };
import asset252 from "./system/plan-filename.md" with { type: "text" };
import asset253 from "./system/plan-mode-active.md" with { type: "text" };
import asset254 from "./system/plan-mode-approved.md" with { type: "text" };
import asset255 from "./system/plan-mode-compact-instructions.md" with { type: "text" };
import asset256 from "./system/plan-mode-reference.md" with { type: "text" };
import asset257 from "./system/plan-mode-subagent.md" with { type: "text" };
import asset258 from "./system/plan-mode-tool-decision-reminder.md" with { type: "text" };
import asset259 from "./system/plan-proposal-approved.md" with { type: "text" };
import asset260 from "./system/plan-proposal-refine.md" with { type: "text" };
import asset261 from "./system/plan-yolo-handoff.md" with { type: "text" };
import asset262 from "./system/prewalk-checklist.md" with { type: "text" };
import asset263 from "./system/prewalk-continue.md" with { type: "text" };
import asset264 from "./system/prewalk-handoff.md" with { type: "text" };
import asset265 from "./system/prewalk-plan.md" with { type: "text" };
import asset266 from "./system/project-prompt.md" with { type: "text" };
import asset267 from "./system/recap-user.md" with { type: "text" };
import asset268 from "./system/resolve-device-reminder.md" with { type: "text" };
import asset269 from "./system/rewind-report.md" with { type: "text" };
import asset270 from "./system/session-agent-notice.md" with { type: "text" };
import asset271 from "./system/session-stop-blocked.md" with { type: "text" };
import asset272 from "./system/side-channel-no-tools.md" with { type: "text" };
import asset273 from "./system/skillful-notice.md" with { type: "text" };
import asset274 from "./system/snapcompact-context-frames-note.md" with { type: "text" };
import asset275 from "./system/snapcompact-context-stub.md" with { type: "text" };
import asset276 from "./system/snapcompact-system-frames-note.md" with { type: "text" };
import asset277 from "./system/snapcompact-system-stub.md" with { type: "text" };
import asset278 from "./system/snapcompact-toolresult-note.md" with { type: "text" };
import asset279 from "./system/speech-rewrite.md" with { type: "text" };
import asset280 from "./system/stream-stall-continue.md" with { type: "text" };
import asset281 from "./system/subagent-async-pending.md" with { type: "text" };
import asset282 from "./system/subagent-completion-probe.md" with { type: "text" };
import asset283 from "./system/subagent-system-prompt.md" with { type: "text" };
import asset284 from "./system/subagent-user-prompt.md" with { type: "text" };
import asset285 from "./system/subagent-yield-reminder.md" with { type: "text" };
import asset286 from "./system/system-prompt.md" with { type: "text" };
import asset287 from "./system/tan-context-switch.md" with { type: "text" };
import asset288 from "./system/task-label.md" with { type: "text" };
import asset289 from "./system/thinking-loop-redirect.md" with { type: "text" };
import asset290 from "./system/title-card.md" with { type: "text" };
import asset291 from "./system/title-fork.md" with { type: "text" };
import asset292 from "./system/title-marker-instruction.md" with { type: "text" };
import asset293 from "./system/title-system.md" with { type: "text" };
import asset294 from "./system/tool-call-loop-redirect.md" with { type: "text" };
import asset295 from "./system/tool-roster-notice.md" with { type: "text" };
import asset296 from "./system/ttsr-interrupt.md" with { type: "text" };
import asset297 from "./system/ttsr-tool-reminder.md" with { type: "text" };
import asset298 from "./system/ttsr-warning.md" with { type: "text" };
import asset299 from "./system/ultrathink-notice.md" with { type: "text" };
import asset300 from "./system/unexpected-stop-retry.md" with { type: "text" };
import asset301 from "./system/user-append.md" with { type: "text" };
import asset302 from "./system/vibe-mode-active.md" with { type: "text" };
import asset303 from "./system/video-attachment.md" with { type: "text" };
import asset304 from "./system/web-search.md" with { type: "text" };
import asset305 from "./system/workflow-notice.md" with { type: "text" };
import asset306 from "./system/x-read.md" with { type: "text" };
import asset307 from "./system/xdev-mount-notice.md" with { type: "text" };
import asset308 from "./tools/agent-url-progress.md" with { type: "text" };
import asset309 from "./tools/agent-url-superseded.md" with { type: "text" };
import asset310 from "./tools/approve.md" with { type: "text" };
import asset311 from "./tools/archive.md" with { type: "text" };
import asset312 from "./tools/ask.md" with { type: "text" };
import asset313 from "./tools/ast-edit.md" with { type: "text" };
import asset314 from "./tools/ast-grep.md" with { type: "text" };
import asset315 from "./tools/async-result.md" with { type: "text" };
import asset316 from "./tools/bash.md" with { type: "text" };
import asset317 from "./tools/browser.md" with { type: "text" };
import asset318 from "./tools/cfg-approval-timeout.md" with { type: "text" };
import asset319 from "./tools/cfg-env-shadowed.md" with { type: "text" };
import asset320 from "./tools/cfg-write-result.md" with { type: "text" };
import asset321 from "./tools/checkpoint.md" with { type: "text" };
import asset322 from "./tools/chronicle-recall.md" with { type: "text" };
import asset323 from "./tools/computer-screen-locked-capture.md" with { type: "text" };
import asset324 from "./tools/computer-screen-state.md" with { type: "text" };
import asset325 from "./tools/computer.md" with { type: "text" };
import asset326 from "./tools/context-notes.md" with { type: "text" };
import asset327 from "./tools/ctl.md" with { type: "text" };
import asset328 from "./tools/debug.md" with { type: "text" };
import asset329 from "./tools/eval-agents.md" with { type: "text" };
import asset331 from "./tools/eval-helpers.md" with { type: "text" };
import asset332 from "./tools/eval-judge.md" with { type: "text" };
import asset333 from "./tools/eval.md" with { type: "text" };
import asset334 from "./tools/find.md" with { type: "text" };
import asset335 from "./tools/github.md" with { type: "text" };
import asset336 from "./tools/glob.md" with { type: "text" };
import asset337 from "./tools/goal.md" with { type: "text" };
import asset338 from "./tools/grep.md" with { type: "text" };
import asset339 from "./tools/ida.md" with { type: "text" };
import asset340 from "./tools/image-attachment-describe-system.md" with { type: "text" };
import asset341 from "./tools/image-attachment-describe.md" with { type: "text" };
import asset342 from "./tools/image-gen.md" with { type: "text" };
import asset343 from "./tools/image-question-system.md" with { type: "text" };
import asset344 from "./tools/isolation-error.md" with { type: "text" };
import asset345 from "./tools/isolation-recovery-hint.md" with { type: "text" };
import asset346 from "./tools/isolation-summary.md" with { type: "text" };
import asset347 from "./tools/learn.md" with { type: "text" };
import asset348 from "./tools/lsp-late-diagnostic.md" with { type: "text" };
import asset349 from "./tools/lsp.md" with { type: "text" };
import asset350 from "./tools/manage-skill.md" with { type: "text" };
import asset351 from "./tools/memory-edit.md" with { type: "text" };
import asset352 from "./tools/new-context.md" with { type: "text" };
import asset353 from "./tools/ratchet.md" with { type: "text" };
import asset354 from "./tools/read.md" with { type: "text" };
import asset355 from "./tools/recall.md" with { type: "text" };
import asset356 from "./tools/reflect.md" with { type: "text" };
import asset357 from "./tools/retain.md" with { type: "text" };
import asset358 from "./tools/rewind.md" with { type: "text" };
import asset359 from "./tools/rewrite.md" with { type: "text" };
import asset360 from "./tools/salvaged-child-hint.md" with { type: "text" };
import asset361 from "./tools/security-publish.md" with { type: "text" };
import asset362 from "./tools/security-scan.md" with { type: "text" };
import asset363 from "./tools/task-async-contract.md" with { type: "text" };
import asset364 from "./tools/task-coordination-advisory.md" with { type: "text" };
import asset365 from "./tools/task-follow-up.md" with { type: "text" };
import asset366 from "./tools/task-spawn-feedback.md" with { type: "text" };
import asset367 from "./tools/task-specialization-advisory.md" with { type: "text" };
import asset368 from "./tools/task-summary.md" with { type: "text" };
import asset369 from "./tools/task.md" with { type: "text" };
import asset370 from "./tools/todo.md" with { type: "text" };
import asset371 from "./tools/tts.md" with { type: "text" };
import asset372 from "./tools/vibe-kill.md" with { type: "text" };
import asset373 from "./tools/vibe-list.md" with { type: "text" };
import asset374 from "./tools/vibe-send.md" with { type: "text" };
import asset375 from "./tools/vibe-spawn.md" with { type: "text" };
import asset376 from "./tools/vibe-turn-result.md" with { type: "text" };
import asset377 from "./tools/vibe-wait.md" with { type: "text" };
import asset378 from "./tools/wait.md" with { type: "text" };
import asset379 from "./tools/web-search.md" with { type: "text" };
import asset380 from "./tools/workpool-batch.md" with { type: "text" };
import asset381 from "./tools/workpool-turn-result.md" with { type: "text" };
import asset382 from "./tools/write-device-only.md" with { type: "text" };
import asset383 from "./tools/write.md" with { type: "text" };
import asset384 from "./tools/yield.md" with { type: "text" };
import asset385 from "../work-contracts/block.md" with { type: "text" };
import asset386 from "../work-contracts/tool.md" with { type: "text" };

/** Static embeds are the release source; agents remain inspectable without changing discovery. */
export const promptAssets: readonly PromptAsset[] = [
	{
		id: "model-families/opus-5.md",
		relPath: "model-families/opus-5.md",
		bundled: opus5Preset,
		scope: "model-family",
		group: "core",
		keys: [
			{ path: "modelClass", type: "string", required: true, resolution: "session-dependent" },
			{ path: "modelFamily", type: "string", required: true, resolution: "session-dependent" },
			{ path: "modelRevision", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { modelClass: "anthropic", modelFamily: "opus", modelRevision: "5.0.0" },
		consumerHints: [
			"packages/coding-agent/src/prompts/model-families/opus-5.md",
			"packages/coding-agent/src/prompts/model-presets.ts",
		],
	},
	{
		id: "advisor/active-repo-watchdog.md",
		relPath: "advisor/active-repo-watchdog.md",
		bundled: asset0,
		scope: "advisor:active-repo-watchdog",
		group: "core",
		keys: [{ path: "relativeRepoRoot", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { relativeRepoRoot: "/workspace/example" },
		consumerHints: [
			"packages/coding-agent/src/prompts/advisor/active-repo-watchdog.md",
			"packages/coding-agent/src/advisor/watchdog.ts",
		],
	},
	{
		id: "advisor/advise-tool.md",
		relPath: "advisor/advise-tool.md",
		bundled: asset1,
		scope: "advisor:advise-tool",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/advisor/advise-tool.md",
			"packages/coding-agent/src/advisor/advise-tool.ts",
		],
	},
	{
		id: "advisor/boundary-guidance.md",
		relPath: "advisor/boundary-guidance.md",
		bundled: asset2,
		scope: "advisor:boundary-guidance",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/advisor/boundary-guidance.md",
			"packages/coding-agent/src/session/session-advisors.ts",
		],
	},
	{
		id: "advisor/context-files.md",
		relPath: "advisor/context-files.md",
		bundled: asset3,
		scope: "advisor:context-files",
		group: "core",
		keys: [
			{
				path: "contextFiles",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "path", type: "string" },
					{ path: "content", type: "string" },
				],
			},
		],
		fixture: { contextFiles: [{ path: "/workspace/example", content: "Example content" }] },
		consumerHints: [
			"packages/coding-agent/src/prompts/advisor/context-files.md",
			"packages/coding-agent/src/advisor/watchdog.ts",
		],
	},
	{
		id: "advisor/memory-context.md",
		relPath: "advisor/memory-context.md",
		bundled: asset4,
		scope: "advisor:memory-context",
		group: "core",
		keys: [{ path: "memoryInstructions", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { memoryInstructions: "Example memoryInstructions" },
		consumerHints: [
			"packages/coding-agent/src/prompts/advisor/memory-context.md",
			"packages/coding-agent/src/advisor/watchdog.ts",
		],
	},
	{
		id: "advisor/system.md",
		relPath: "advisor/system.md",
		bundled: asset5,
		scope: "advisor:system",
		group: "core",
		keys: [
			{ path: "max_notes_per_update", type: "number", required: false, resolution: "session-dependent" },
			{ path: "include_thinking", type: "boolean", required: false, resolution: "session-dependent" },
		],
		fixture: { max_notes_per_update: 2, include_thinking: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/advisor/system.md",
			"packages/coding-agent/src/modes/controllers/selector-controller.ts",
			"packages/coding-agent/src/session/session-advisors.ts",
		],
	},
	{
		id: "agent/dsml-tool-call-leak.md",
		relPath: "agent/dsml-tool-call-leak.md",
		bundled: asset6,
		scope: "feature:agent/dsml-tool-call-leak",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/agent/src/prompts/dsml-tool-call-leak.md", "packages/agent/src/agent-loop.ts"],
	},
	{
		id: "agents/claude-parent-context.md",
		relPath: "agents/claude-parent-context.md",
		bundled: asset7,
		scope: "feature:agents/claude-parent-context",
		group: "core",
		keys: [
			{ path: "systemPrompt", type: "string", required: true, resolution: "session-dependent" },
			{ path: "parentSessionId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "inheritedExtensionState", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			systemPrompt: "Example systemPrompt",
			parentSessionId: "example-1",
			inheritedExtensionState: "Example inheritedExtensionState",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/agents/claude-parent-context.md",
			"packages/coding-agent/src/task/external-harness/claude.ts",
		],
	},
	{
		id: "agents/frontmatter.md",
		relPath: "agents/frontmatter.md",
		bundled: asset8,
		scope: "agent-frontmatter",
		group: "core",
		keys: [
			{ path: "body", type: "string", resolution: "session-dependent" },
			{ path: "name", type: "string", resolution: "session-dependent" },
			{ path: "description", type: "string", resolution: "session-dependent" },
			{ path: "spawns", type: "string", resolution: "session-dependent" },
			{ path: "model", type: "string", resolution: "session-dependent" },
			{ path: "harness", type: "string", resolution: "session-dependent" },
			{ path: "thinkingLevel", type: "string", resolution: "session-dependent" },
			{ path: "blocking", type: "string", resolution: "session-dependent" },
			{ path: "prewalk", type: "string", resolution: "session-dependent" },
			{ path: "advisor", type: "string", resolution: "session-dependent" },
			{ path: "autoloadSkills", type: "string", resolution: "session-dependent" },
		],
		fixture: {
			body: "Example body",
			name: "Example name",
			description: "Example description",
			spawns: "Example spawns",
			model: "Example model",
			harness: "Example harness",
			thinkingLevel: "Example thinkingLevel",
			blocking: "Example blocking",
			prewalk: "Example prewalk",
			advisor: "Example advisor",
			autoloadSkills: "Example autoloadSkills",
		},
		inspectionOnly: true,
		consumerHints: [
			"packages/coding-agent/src/prompts/agents/frontmatter.md",
			"packages/coding-agent/src/task/agents.ts",
		],
	},
	{
		id: "agents/init.md",
		relPath: "agents/init.md",
		bundled: asset9,
		scope: "feature:agents/init",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/agents/init.md", "packages/coding-agent/src/task/commands.ts"],
	},
	{
		id: "agents/model-mention.md",
		relPath: "agents/model-mention.md",
		bundled: asset10,
		scope: "feature:agents/model-mention",
		group: "core",
		keys: [
			{ path: "name", type: "string", required: true, resolution: "session-dependent" },
			{ path: "selector", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { name: "Example name", selector: "Example selector" },
		consumerHints: [
			"packages/coding-agent/src/prompts/agents/model-mention.md",
			"packages/coding-agent/src/session/model-mentions.ts",
		],
	},
	{
		id: "agents/reviewer.md",
		relPath: "agents/reviewer.md",
		bundled: asset11,
		scope: "agent-body",
		group: "core",
		keys: [],
		fixture: {},
		inspectionOnly: true,
		consumerHints: [
			"packages/coding-agent/src/prompts/agents/reviewer.md",
			"packages/coding-agent/src/task/agents.ts",
		],
	},
	{
		id: "agents/scout.md",
		relPath: "agents/scout.md",
		bundled: asset12,
		scope: "agent-body",
		group: "core",
		keys: [],
		fixture: {},
		inspectionOnly: true,
		consumerHints: ["packages/coding-agent/src/prompts/agents/scout.md", "packages/coding-agent/src/task/agents.ts"],
	},
	{
		id: "agents/security-reviewer.md",
		relPath: "agents/security-reviewer.md",
		bundled: asset13,
		scope: "agent-body",
		group: "core",
		keys: [],
		fixture: {},
		inspectionOnly: true,
		consumerHints: [
			"packages/coding-agent/src/prompts/agents/security-reviewer.md",
			"packages/coding-agent/src/task/agents.ts",
			"packages/coding-agent/src/security/coordinator.ts",
		],
	},
	{
		id: "agents/task.md",
		relPath: "agents/task.md",
		bundled: asset14,
		scope: "agent-body",
		group: "core",
		keys: [],
		fixture: {},
		inspectionOnly: true,
		consumerHints: ["packages/coding-agent/src/prompts/agents/task.md", "packages/coding-agent/src/task/agents.ts"],
	},
	{
		id: "autoresearch/command-resume.md",
		relPath: "autoresearch/command-resume.md",
		bundled: asset15,
		scope: "feature:autoresearch/command-resume",
		group: "feature",
		keys: [
			{ path: "branch_status_line", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_resume_context", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "resume_context", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			branch_status_line: "Example branch_status_line",
			has_resume_context: true,
			resume_context: "Example resume_context",
		},
		consumerHints: [
			"packages/coding-agent/src/autoresearch/command-resume.md",
			"packages/coding-agent/src/autoresearch/index.ts",
		],
	},
	{
		id: "autoresearch/prompt-setup.md",
		relPath: "autoresearch/prompt-setup.md",
		bundled: asset16,
		scope: "feature:autoresearch/prompt-setup",
		group: "feature",
		keys: [
			{ path: "base_system_prompt", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_goal", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "goal", type: "string", required: true, resolution: "session-dependent" },
			{ path: "working_dir", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_branch", type: "string", required: true, resolution: "session-dependent" },
			{ path: "branch", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_baseline_warning", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "baseline_warning", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			base_system_prompt: "Example base_system_prompt",
			has_goal: true,
			goal: "Example goal",
			working_dir: "/workspace/example",
			has_branch: "Example has_branch",
			branch: "Example branch",
			has_baseline_warning: true,
			baseline_warning: "Example baseline_warning",
		},
		consumerHints: [
			"packages/coding-agent/src/autoresearch/prompt-setup.md",
			"packages/coding-agent/src/autoresearch/index.ts",
		],
	},
	{
		id: "autoresearch/prompt.md",
		relPath: "autoresearch/prompt.md",
		bundled: asset17,
		scope: "feature:autoresearch/prompt",
		group: "feature",
		keys: [
			{ path: "base_system_prompt", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_goal", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "goal", type: "string", required: true, resolution: "session-dependent" },
			{ path: "working_dir", type: "string", required: true, resolution: "session-dependent" },
			{ path: "default_metric_name", type: "unknown", required: true, resolution: "session-dependent" },
			{ path: "metric_name", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_branch", type: "string", required: true, resolution: "session-dependent" },
			{ path: "branch", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_baseline_commit", type: "string", required: true, resolution: "session-dependent" },
			{ path: "baseline_commit", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_notes", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "notes", type: "string", required: true, resolution: "session-dependent" },
			{ path: "current_segment", type: "number", required: true, resolution: "session-dependent" },
			{ path: "current_segment_run_count", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_baseline_metric", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "baseline_metric_display", type: "string", required: true, resolution: "session-dependent" },
			{ path: "baseline_run_number", type: "unknown", required: true, resolution: "session-dependent" },
			{ path: "has_best_result", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "best_metric_display", type: "string", required: true, resolution: "session-dependent" },
			{ path: "best_run_number", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_recent_results", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "recent_results",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "run_number", type: "string" },
					{ path: "status", type: "string" },
					{ path: "metric_display", type: "string" },
					{ path: "description", type: "string" },
					{ path: "has_asi_summary", type: "string" },
					{ path: "asi_summary", type: "string" },
					{ path: "has_deviations", type: "string" },
					{ path: "deviations", type: "string" },
					{ path: "justified", type: "string" },
					{ path: "flagged", type: "string" },
					{ path: "flagged_reason", type: "string" },
				],
			},
			{ path: "has_unjustified_runs", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "unjustified_runs",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "run_number", type: "string", required: true, resolution: "session-dependent" },
					{ path: "paths", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "has_pending_run", type: "string", required: true, resolution: "session-dependent" },
			{ path: "pending_run_number", type: "string", required: true, resolution: "session-dependent" },
			{ path: "pending_run_command", type: "string", required: true, resolution: "session-dependent" },
			{ path: "pending_run_passed", type: "string", required: true, resolution: "session-dependent" },
			{ path: "has_pending_run_metric", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "pending_run_metric_display", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			base_system_prompt: "Example base_system_prompt",
			has_goal: true,
			goal: "Example goal",
			working_dir: "/workspace/example",
			default_metric_name: "Example default_metric_name",
			metric_name: "Example metric_name",
			has_branch: "Example has_branch",
			branch: "Example branch",
			has_baseline_commit: "Example has_baseline_commit",
			baseline_commit: "Example baseline_commit",
			has_notes: true,
			notes: "Example notes",
			current_segment: 2,
			current_segment_run_count: "Example current_segment_run_count",
			has_baseline_metric: true,
			baseline_metric_display: "Example baseline_metric_display",
			baseline_run_number: "Example baseline_run_number",
			has_best_result: true,
			best_metric_display: "Example best_metric_display",
			best_run_number: "Example best_run_number",
			has_recent_results: true,
			recent_results: [
				{
					run_number: "Example run_number",
					status: "Example status",
					metric_display: "Example metric_display",
					description: "Example description",
					has_asi_summary: "Example has_asi_summary",
					asi_summary: "Example asi_summary",
					has_deviations: "Example has_deviations",
					deviations: "Example deviations",
					justified: "Example justified",
					flagged: "Example flagged",
					flagged_reason: "Example flagged_reason",
				},
			],
			has_unjustified_runs: true,
			unjustified_runs: [{ run_number: "Example run_number", paths: "/workspace/example" }],
			has_pending_run: "Example has_pending_run",
			pending_run_number: "Example pending_run_number",
			pending_run_command: "Example pending_run_command",
			pending_run_passed: "Example pending_run_passed",
			has_pending_run_metric: true,
			pending_run_metric_display: "Example pending_run_metric_display",
		},
		consumerHints: [
			"packages/coding-agent/src/autoresearch/prompt.md",
			"packages/coding-agent/src/autoresearch/index.ts",
		],
	},
	{
		id: "autoresearch/resume-message.md",
		relPath: "autoresearch/resume-message.md",
		bundled: asset18,
		scope: "feature:autoresearch/resume-message",
		group: "feature",
		keys: [{ path: "has_pending_run", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { has_pending_run: "Example has_pending_run" },
		consumerHints: [
			"packages/coding-agent/src/autoresearch/resume-message.md",
			"packages/coding-agent/src/autoresearch/index.ts",
		],
	},
	{
		id: "bench/cache-prefix-chunk.md",
		relPath: "bench/cache-prefix-chunk.md",
		bundled: asset19,
		scope: "feature:bench/cache-prefix-chunk",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/bench/cache-prefix-chunk.md",
			"packages/coding-agent/src/cli/bench-cli.ts",
		],
	},
	{
		id: "bench/cache-prefix.md",
		relPath: "bench/cache-prefix.md",
		bundled: asset20,
		scope: "feature:bench/cache-prefix",
		group: "core",
		keys: [
			{ path: "prefix", type: "string", required: true, resolution: "session-dependent" },
			{ path: "namespace", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { prefix: "Example prefix", namespace: "Example namespace" },
		consumerHints: [
			"packages/coding-agent/src/prompts/bench/cache-prefix.md",
			"packages/coding-agent/src/cli/bench-cli.ts",
		],
	},
	{
		id: "bench/cache-suffix.md",
		relPath: "bench/cache-suffix.md",
		bundled: asset21,
		scope: "feature:bench/cache-suffix",
		group: "core",
		keys: [{ path: "variant", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { variant: "Example variant" },
		consumerHints: [
			"packages/coding-agent/src/prompts/bench/cache-suffix.md",
			"packages/coding-agent/src/cli/bench-cli.ts",
		],
	},
	{
		id: "bench/chat.md",
		relPath: "bench/chat.md",
		bundled: asset22,
		scope: "feature:bench/chat",
		group: "core",
		keys: [{ path: "topic", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { topic: "Example topic" },
		consumerHints: ["packages/coding-agent/src/prompts/bench/chat.md", "packages/coding-agent/src/cli/bench-cli.ts"],
	},
	{
		id: "bench/generation.md",
		relPath: "bench/generation.md",
		bundled: asset23,
		scope: "feature:bench/generation",
		group: "core",
		keys: [{ path: "topic", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { topic: "Example topic" },
		consumerHints: [
			"packages/coding-agent/src/prompts/bench/generation.md",
			"packages/coding-agent/src/cli/bench-cli.ts",
		],
	},
	{
		id: "bench/prefill-instruction.md",
		relPath: "bench/prefill-instruction.md",
		bundled: asset24,
		scope: "feature:bench/prefill-instruction",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/bench/prefill-instruction.md",
			"packages/coding-agent/src/cli/bench-cli.ts",
		],
	},
	{
		id: "chains/input-with-context.md",
		relPath: "chains/input-with-context.md",
		bundled: asset25,
		scope: "feature:chains/input-with-context",
		group: "core",
		keys: [
			{ path: "transcript", type: "string", required: true, resolution: "session-dependent" },
			{ path: "draft", type: "string", required: true, resolution: "session-dependent" },
			{ path: "boundary", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { transcript: "Example transcript", draft: "Example draft", boundary: "Example boundary" },
		consumerHints: [
			"packages/coding-agent/src/prompts/chains/input-with-context.md",
			"packages/coding-agent/src/chains/runner.ts",
		],
	},
	{
		id: "chains/system.md",
		relPath: "chains/system.md",
		bundled: asset26,
		scope: "feature:chains/system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/chains/system.md",
			"packages/coding-agent/src/chains/runner.ts",
		],
	},
	{
		id: "chat/advisor.md",
		relPath: "chat/advisor.md",
		bundled: asset27,
		scope: "feature:chat/advisor",
		group: "core",
		keys: [
			{ path: "erp", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "max_notes_per_update", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { erp: true, max_notes_per_update: "Example max_notes_per_update" },
		consumerHints: [
			"packages/coding-agent/src/prompts/chat/advisor.md",
			"packages/coding-agent/src/chat/chat-system-prompt.ts",
		],
	},
	{
		id: "chat/chat.md",
		relPath: "chat/chat.md",
		bundled: asset28,
		scope: "feature:chat/chat",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/chat/chat.md",
			"packages/coding-agent/src/chat/chat-system-prompt.ts",
		],
	},
	{
		id: "chat/compaction.md",
		relPath: "chat/compaction.md",
		bundled: asset29,
		scope: "feature:chat/compaction",
		group: "core",
		keys: [{ path: "erp", type: "boolean", required: true, resolution: "session-dependent" }],
		fixture: { erp: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/chat/compaction.md",
			"packages/coding-agent/src/chat/chat-system-prompt.ts",
		],
	},
	{
		id: "chat/erp.md",
		relPath: "chat/erp.md",
		bundled: asset30,
		scope: "feature:chat/erp",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/chat/erp.md",
			"packages/coding-agent/src/chat/chat-system-prompt.ts",
		],
	},
	{
		id: "chat/system.md",
		relPath: "chat/system.md",
		bundled: asset31,
		scope: "feature:chat/system",
		group: "core",
		keys: [
			{ path: "modePrompt", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "contextFiles",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "path", type: "string", required: true, resolution: "session-dependent" },
					{ path: "content", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "cwd", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "skills",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: true, resolution: "session-dependent" },
					{ path: "filePath", type: "string", required: true, resolution: "session-dependent" },
					{ path: "baseDir", type: "string", required: true, resolution: "session-dependent" },
					{ path: "source", type: "string", required: true, resolution: "session-dependent" },
					{ path: "hide", type: "boolean", required: false, resolution: "session-dependent" },
					{ path: "containRoot", type: "string", required: false, resolution: "session-dependent" },
					{
						path: "_source",
						type: "object",
						required: false,
						resolution: "session-dependent",
						children: [
							{ path: "provider", type: "string", required: true, resolution: "session-dependent" },
							{ path: "providerName", type: "string", required: true, resolution: "session-dependent" },
							{ path: "path", type: "string", required: true, resolution: "session-dependent" },
							{ path: "level", type: "string", required: true, resolution: "session-dependent" },
							{ path: "origin", type: "string", required: false, resolution: "session-dependent" },
							{ path: "pluginName", type: "string", required: false, resolution: "session-dependent" },
						],
					},
				],
			},
			{
				path: "rules",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "path", type: "string", required: true, resolution: "session-dependent" },
					{ path: "content", type: "string", required: true, resolution: "session-dependent" },
					{
						path: "globs",
						type: "object[]",
						required: false,
						resolution: "session-dependent",
						children: [{ path: "this", type: "string", required: true, resolution: "session-dependent" }],
					},
					{
						path: "condition",
						type: "object[]",
						required: false,
						resolution: "session-dependent",
						children: [{ path: "this", type: "string", required: true, resolution: "session-dependent" }],
					},
					{
						path: "astCondition",
						type: "object[]",
						required: false,
						resolution: "session-dependent",
						children: [{ path: "this", type: "string", required: true, resolution: "session-dependent" }],
					},
					{
						path: "scope",
						type: "object[]",
						required: false,
						resolution: "session-dependent",
						children: [{ path: "this", type: "string", required: true, resolution: "session-dependent" }],
					},
					{
						path: "agents",
						type: "object[]",
						required: false,
						resolution: "session-dependent",
						children: [{ path: "this", type: "string", required: true, resolution: "session-dependent" }],
					},
					{ path: "alwaysApply", type: "boolean", required: false, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "question", type: "string", required: false, resolution: "session-dependent" },
					{ path: "interruptMode", type: "string", required: false, resolution: "session-dependent" },
					{
						path: "_source",
						type: "object",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "provider", type: "string", required: true, resolution: "session-dependent" },
							{ path: "providerName", type: "string", required: true, resolution: "session-dependent" },
							{ path: "path", type: "string", required: true, resolution: "session-dependent" },
							{ path: "level", type: "string", required: true, resolution: "session-dependent" },
							{ path: "origin", type: "string", required: false, resolution: "session-dependent" },
							{ path: "pluginName", type: "string", required: false, resolution: "session-dependent" },
						],
					},
				],
			},
			{ path: "appendPrompt", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			modePrompt: "Example modePrompt",
			contextFiles: [{ path: "/workspace/example", content: "Example content" }],
			cwd: "/workspace/example",
			skills: [
				{
					name: "Example name",
					description: "Example description",
					filePath: "/workspace/example",
					baseDir: "/workspace/example",
					source: "Example source",
					hide: true,
					containRoot: "/workspace/example",
					_source: {
						provider: "Example provider",
						providerName: "Example providerName",
						path: "/workspace/example",
						level: "Example level",
						origin: "Example origin",
						pluginName: "Example pluginName",
					},
				},
			],
			rules: [
				{
					name: "Example name",
					path: "/workspace/example",
					content: "Example content",
					globs: [{ this: "Example this" }],
					condition: [{ this: "Example this" }],
					astCondition: [{ this: "Example this" }],
					scope: [{ this: "Example this" }],
					agents: [{ this: "Example this" }],
					alwaysApply: true,
					description: "Example description",
					question: "Example question",
					interruptMode: "Example interruptMode",
					_source: {
						provider: "Example provider",
						providerName: "Example providerName",
						path: "/workspace/example",
						level: "Example level",
						origin: "Example origin",
						pluginName: "Example pluginName",
					},
				},
			],
			appendPrompt: "Example appendPrompt",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/chat/system.md",
			"packages/coding-agent/src/chat/chat-system-prompt.ts",
		],
	},
	{
		id: "chronicler/chronicle-tool.md",
		relPath: "chronicler/chronicle-tool.md",
		bundled: asset32,
		scope: "feature:chronicler/chronicle-tool",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/chronicle-tool.md",
			"packages/coding-agent/src/chronicler/chronicle-tool.ts",
		],
	},
	{
		id: "chronicler/context.md",
		relPath: "chronicler/context.md",
		bundled: asset33,
		scope: "feature:chronicler/context",
		group: "core",
		keys: [
			{ path: "sessionId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "cwd", type: "string", required: true, resolution: "session-dependent" },
			{ path: "beatCount", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "beats",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "title", type: "string", required: true, resolution: "session-dependent" },
					{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
					{ path: "eventTime", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "omitted", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "carry",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "sources", type: "string" },
					{ path: "text", type: "string" },
				],
			},
			{ path: "delta", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			sessionId: "example-1",
			cwd: "/workspace/example",
			beatCount: "Example beatCount",
			beats: [{ id: "example-1", title: "Example title", kind: "Example kind", eventTime: "Example eventTime" }],
			omitted: "Example omitted",
			carry: [{ sources: "Example sources", text: "Example text" }],
			delta: "Example delta",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/context.md",
			"packages/coding-agent/src/chronicler/session-chronicler.ts",
		],
	},
	{
		id: "chronicler/entry.md",
		relPath: "chronicler/entry.md",
		bundled: asset34,
		scope: "feature:chronicler/entry",
		group: "core",
		keys: [
			{ path: "id", type: "string", required: true, resolution: "session-dependent" },
			{ path: "parentId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "timestamp", type: "string", required: true, resolution: "session-dependent" },
			{ path: "transcript", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			id: "example-1",
			parentId: "example-1",
			timestamp: "Example timestamp",
			transcript: "Example transcript",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/entry.md",
			"packages/coding-agent/src/chronicler/render.ts",
		],
	},
	{
		id: "chronicler/finish-tool.md",
		relPath: "chronicler/finish-tool.md",
		bundled: asset35,
		scope: "feature:chronicler/finish-tool",
		group: "core",
		keys: [{ path: "carryChars", type: "number", required: true, resolution: "session-dependent" }],
		fixture: { carryChars: 8_000 },
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/finish-tool.md",
			"packages/coding-agent/src/chronicler/chronicle-tool.ts",
		],
	},
	{
		id: "chronicler/read-tool.md",
		relPath: "chronicler/read-tool.md",
		bundled: asset36,
		scope: "feature:chronicler/read-tool",
		group: "core",
		keys: [
			{ path: "pageSize", type: "number", required: true, resolution: "session-dependent" },
			{ path: "pageMax", type: "number", required: true, resolution: "session-dependent" },
		],
		fixture: { pageSize: 50, pageMax: 100 },
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/read-tool.md",
			"packages/coding-agent/src/chronicler/chronicle-tool.ts",
		],
	},
	{
		id: "chronicler/system.md",
		relPath: "chronicler/system.md",
		bundled: asset37,
		scope: "feature:chronicler/system",
		group: "core",
		keys: [
			{ path: "sessionId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "cwd", type: "string", required: true, resolution: "session-dependent" },
			{ path: "materialCriteria", type: "number", required: true, resolution: "session-dependent" },
			{ path: "minWords", type: "string", required: true, resolution: "session-dependent" },
			{ path: "maxWords", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			sessionId: "example-1",
			cwd: "/workspace/example",
			materialCriteria: 2,
			minWords: "150",
			maxWords: "1,200",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/system.md",
			"packages/coding-agent/src/chronicler/session-chronicler.ts",
		],
	},
	{
		id: "chronicler/temporal/rank-input.md",
		relPath: "chronicler/temporal/rank-input.md",
		bundled: asset38,
		scope: "feature:chronicler/temporal/rank-input",
		group: "core",
		keys: [
			{ path: "query", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "candidates",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "key", type: "string" },
					{ path: "label", type: "string" },
					{ path: "text", type: "string" },
				],
			},
		],
		fixture: {
			query: "Example query",
			candidates: [{ key: "Example key", label: "Example label", text: "Example text" }],
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/temporal/rank-input.md",
			"packages/coding-agent/src/chronicler/temporal/rank.ts",
		],
	},
	{
		id: "chronicler/temporal/rank-system.md",
		relPath: "chronicler/temporal/rank-system.md",
		bundled: asset39,
		scope: "feature:chronicler/temporal/rank-system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/temporal/rank-system.md",
			"packages/coding-agent/src/chronicler/temporal/rank.ts",
		],
	},
	{
		id: "chronicler/temporal/summary-input.md",
		relPath: "chronicler/temporal/summary-input.md",
		bundled: asset40,
		scope: "feature:chronicler/temporal/summary-input",
		group: "core",
		keys: [
			{ path: "...node", type: "spread", resolution: "session-dependent" },
			{ path: "projects", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "children",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "...child", type: "spread", resolution: "session-dependent" },
					{ path: "projects", type: "string", required: true, resolution: "session-dependent" },
					{ path: "key", type: "string" },
					{ path: "label", type: "string" },
					{ path: "localStart", type: "string" },
					{ path: "localEnd", type: "string" },
					{ path: "atomCount", type: "string" },
					{ path: "text", type: "string" },
				],
			},
			{ path: "label", type: "string", resolution: "session-dependent" },
			{ path: "key", type: "string", resolution: "session-dependent" },
			{ path: "level", type: "string", resolution: "session-dependent" },
			{ path: "atomCount", type: "string", resolution: "session-dependent" },
			{ path: "localStart", type: "string", resolution: "session-dependent" },
			{ path: "localEnd", type: "string", resolution: "session-dependent" },
		],
		fixture: {
			"...node": "Example ...node",
			projects: "Example projects",
			children: [
				{
					"...child": "Example ...child",
					projects: "Example projects",
					key: "Example key",
					label: "Example label",
					localStart: "Example localStart",
					localEnd: "Example localEnd",
					atomCount: "Example atomCount",
					text: "Example text",
				},
			],
			label: "Example label",
			key: "Example key",
			level: "Example level",
			atomCount: "Example atomCount",
			localStart: "Example localStart",
			localEnd: "Example localEnd",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/temporal/summary-input.md",
			"packages/coding-agent/src/chronicler/temporal/summarize.ts",
		],
	},
	{
		id: "chronicler/temporal/summary-system.md",
		relPath: "chronicler/temporal/summary-system.md",
		bundled: asset41,
		scope: "feature:chronicler/temporal/summary-system",
		group: "core",
		keys: [
			{ path: "overviewWords", type: "string", required: true, resolution: "session-dependent" },
			{ path: "childWords", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { overviewWords: "Example overviewWords", childWords: "Example childWords" },
		consumerHints: [
			"packages/coding-agent/src/prompts/chronicler/temporal/summary-system.md",
			"packages/coding-agent/src/chronicler/temporal/summarize.ts",
		],
	},
	{
		id: "ci-green-request.md",
		relPath: "ci-green-request.md",
		bundled: asset42,
		scope: "feature:ci-green-request",
		group: "core",
		keys: [
			{ path: "headTag", type: "string", required: true, resolution: "session-dependent" },
			{ path: "branch", type: "string", required: true, resolution: "session-dependent" },
			{ path: "remote", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { headTag: "Example headTag", branch: "Example branch", remote: "Example remote" },
		consumerHints: [
			"packages/coding-agent/src/prompts/ci-green-request.md",
			"packages/coding-agent/src/extensibility/custom-commands/bundled/ci-green/index.ts",
		],
	},
	{
		id: "cleanse/assignment.md",
		relPath: "cleanse/assignment.md",
		bundled: asset43,
		scope: "feature:cleanse/assignment",
		group: "feature",
		keys: [
			{ path: "worker", type: "string", required: true, resolution: "session-dependent" },
			{ path: "write_scope", type: "string", required: true, resolution: "session-dependent" },
			{ path: "diagnostics", type: "string", required: true, resolution: "session-dependent" },
			{ path: "checker_commands", type: "string", required: true, resolution: "session-dependent" },
			{ path: "peer_assignments", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			worker: "Example worker",
			write_scope: "Example write_scope",
			diagnostics: "Example diagnostics",
			checker_commands: "Example checker_commands",
			peer_assignments: "Example peer_assignments",
		},
		consumerHints: [
			"packages/coding-agent/src/cleanse/prompts/assignment.md",
			"packages/coding-agent/src/cleanse/agent.ts",
		],
	},
	{
		id: "cleanse/discovery.md",
		relPath: "cleanse/discovery.md",
		bundled: asset44,
		scope: "feature:cleanse/discovery",
		group: "feature",
		keys: [{ path: "request", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { request: "Example request" },
		consumerHints: [
			"packages/coding-agent/src/cleanse/prompts/discovery.md",
			"packages/coding-agent/src/cleanse/agent.ts",
		],
	},
	{
		id: "cleanse/follow-up.md",
		relPath: "cleanse/follow-up.md",
		bundled: asset45,
		scope: "feature:cleanse/follow-up",
		group: "feature",
		keys: [{ path: "diagnostics", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { diagnostics: "Example diagnostics" },
		consumerHints: [
			"packages/coding-agent/src/cleanse/prompts/follow-up.md",
			"packages/coding-agent/src/cleanse/agent.ts",
		],
	},
	{
		id: "commit/agentic/analyze-file.md",
		relPath: "commit/agentic/analyze-file.md",
		bundled: asset46,
		scope: "feature:commit/agentic/analyze-file",
		group: "feature",
		keys: [
			{ path: "file", type: "string", required: true, resolution: "session-dependent" },
			{ path: "goal", type: "string", required: true, resolution: "session-dependent" },
			{ path: "related_files", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { file: "Example file", goal: "Example goal", related_files: "Example related_files" },
		consumerHints: [
			"packages/coding-agent/src/commit/agentic/prompts/analyze-file.md",
			"packages/coding-agent/src/commit/agentic/tools/analyze-file.ts",
		],
	},
	{
		id: "commit/agentic/session-user.md",
		relPath: "commit/agentic/session-user.md",
		bundled: asset47,
		scope: "feature:commit/agentic/session-user",
		group: "feature",
		keys: [
			{ path: "user_context", type: "string", required: true, resolution: "session-dependent" },
			{ path: "changelog_targets", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "existing_changelog_entries",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "path", type: "string" },
					{
						path: "sections",
						type: "object",
						children: [
							{ path: "name", type: "string" },
							{ path: "items", type: "string" },
						],
					},
				],
			},
		],
		fixture: {
			user_context: "Example user_context",
			changelog_targets: "Example changelog_targets",
			existing_changelog_entries: [
				{ path: "/workspace/example", sections: { name: "Example name", items: "Example items" } },
			],
		},
		consumerHints: [
			"packages/coding-agent/src/commit/agentic/prompts/session-user.md",
			"packages/coding-agent/src/commit/agentic/agent.ts",
		],
	},
	{
		id: "commit/agentic/split-confirm.md",
		relPath: "commit/agentic/split-confirm.md",
		bundled: asset48,
		scope: "feature:commit/agentic/split-confirm",
		group: "feature",
		keys: [{ path: "count", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { count: "Example count" },
		consumerHints: [
			"packages/coding-agent/src/commit/agentic/prompts/split-confirm.md",
			"packages/coding-agent/src/commit/agentic/index.ts",
		],
	},
	{
		id: "commit/agentic/system.md",
		relPath: "commit/agentic/system.md",
		bundled: asset49,
		scope: "feature:commit/agentic/system",
		group: "feature",
		keys: [{ path: "types_description", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { types_description: "Example types_description" },
		consumerHints: [
			"packages/coding-agent/src/commit/agentic/prompts/system.md",
			"packages/coding-agent/src/commit/agentic/agent.ts",
		],
	},
	{
		id: "commit/changelog-system.md",
		relPath: "commit/changelog-system.md",
		bundled: asset56,
		scope: "feature:commit/changelog-system",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/commit/prompts/changelog-system.md",
			"packages/coding-agent/src/commit/changelog/generate.ts",
		],
	},
	{
		id: "commit/changelog-user.md",
		relPath: "commit/changelog-user.md",
		bundled: asset57,
		scope: "feature:commit/changelog-user",
		group: "feature",
		keys: [
			{ path: "changelog_path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "is_package_changelog", type: "string", required: true, resolution: "session-dependent" },
			{ path: "existing_entries", type: "string", required: true, resolution: "session-dependent" },
			{ path: "stat", type: "string", required: true, resolution: "session-dependent" },
			{ path: "diff", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			changelog_path: "/workspace/example",
			is_package_changelog: "Example is_package_changelog",
			existing_entries: "Example existing_entries",
			stat: "Example stat",
			diff: "Example diff",
		},
		consumerHints: [
			"packages/coding-agent/src/commit/prompts/changelog-user.md",
			"packages/coding-agent/src/commit/changelog/generate.ts",
		],
	},
	{
		id: "commit/conventional/analysis.md",
		relPath: "commit/conventional/analysis.md",
		bundled: asset50,
		scope: "feature:commit/conventional/analysis",
		group: "feature",
		keys: [
			{ path: "project_context", type: "string", required: true, resolution: "session-dependent" },
			{ path: "types_description", type: "string", required: true, resolution: "session-dependent" },
			{ path: "stat", type: "string", required: true, resolution: "session-dependent" },
			{ path: "scope_candidates", type: "string", required: true, resolution: "session-dependent" },
			{ path: "common_scopes", type: "string", required: true, resolution: "session-dependent" },
			{ path: "recent_commits", type: "string", required: true, resolution: "session-dependent" },
			{ path: "diff", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			project_context: "Example project_context",
			types_description: "Example types_description",
			stat: "Example stat",
			scope_candidates: "Example scope_candidates",
			common_scopes: "Example common_scopes",
			recent_commits: "Example recent_commits",
			diff: "Example diff",
		},
		consumerHints: [
			"packages/coding-agent/src/commit/conventional/prompts/analysis.md",
			"packages/coding-agent/src/commit/conventional/prompts.ts",
		],
	},
	{
		id: "commit/conventional/fast.md",
		relPath: "commit/conventional/fast.md",
		bundled: asset51,
		scope: "feature:commit/conventional/fast",
		group: "feature",
		keys: [
			{ path: "stat", type: "string", required: true, resolution: "session-dependent" },
			{ path: "diff", type: "string", required: true, resolution: "session-dependent" },
			{ path: "scope_candidates", type: "string", required: true, resolution: "session-dependent" },
			{ path: "user_context", type: "string", required: true, resolution: "session-dependent" },
			{ path: "types_description", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			stat: "Example stat",
			diff: "Example diff",
			scope_candidates: "Example scope_candidates",
			user_context: "Example user_context",
			types_description: "Example types_description",
		},
		consumerHints: [
			"packages/coding-agent/src/commit/conventional/prompts/fast.md",
			"packages/coding-agent/src/commit/conventional/prompts.ts",
		],
	},
	{
		id: "commit/conventional/map.md",
		relPath: "commit/conventional/map.md",
		bundled: asset52,
		scope: "feature:commit/conventional/map",
		group: "feature",
		keys: [
			{
				path: "files",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "path", type: "string", required: true, resolution: "session-dependent" },
					{ path: "diff", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "context_header", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			files: [{ path: "/workspace/example", diff: "Example diff" }],
			context_header: "Example context_header",
		},
		consumerHints: [
			"packages/coding-agent/src/commit/conventional/prompts/map.md",
			"packages/coding-agent/src/commit/conventional/prompts.ts",
		],
	},
	{
		id: "commit/conventional/reduce.md",
		relPath: "commit/conventional/reduce.md",
		bundled: asset53,
		scope: "feature:commit/conventional/reduce",
		group: "feature",
		keys: [
			{ path: "types_description", type: "string", required: true, resolution: "session-dependent" },
			{ path: "observations", type: "string", required: true, resolution: "session-dependent" },
			{ path: "stat", type: "string", required: true, resolution: "session-dependent" },
			{ path: "scope_candidates", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			types_description: "Example types_description",
			observations: "Example observations",
			stat: "Example stat",
			scope_candidates: "Example scope_candidates",
		},
		consumerHints: [
			"packages/coding-agent/src/commit/conventional/prompts/reduce.md",
			"packages/coding-agent/src/commit/conventional/prompts.ts",
		],
	},
	{
		id: "commit/conventional/summary-rewrite.md",
		relPath: "commit/conventional/summary-rewrite.md",
		bundled: asset54,
		scope: "feature:commit/conventional/summary-rewrite",
		group: "feature",
		keys: [
			{ path: "commit_type", type: "string", required: true, resolution: "session-dependent" },
			{ path: "chars", type: "number", required: true, resolution: "session-dependent" },
			{ path: "draft", type: "string", required: true, resolution: "session-dependent" },
			{ path: "rejection", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { commit_type: "Example commit_type", chars: 2, draft: "Example draft", rejection: "Example rejection" },
		consumerHints: [
			"packages/coding-agent/src/commit/conventional/prompts/summary-rewrite.md",
			"packages/coding-agent/src/commit/conventional/prompts.ts",
		],
	},
	{
		id: "commit/conventional/summary.md",
		relPath: "commit/conventional/summary.md",
		bundled: asset55,
		scope: "feature:commit/conventional/summary",
		group: "feature",
		keys: [
			{ path: "commit_type", type: "string", required: true, resolution: "session-dependent" },
			{ path: "scope", type: "string", required: false, resolution: "session-dependent" },
			{ path: "chars", type: "number", required: true, resolution: "session-dependent" },
			{ path: "user_context", type: "string", required: true, resolution: "session-dependent" },
			{ path: "details", type: "string", required: true, resolution: "session-dependent" },
			{ path: "stat", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			commit_type: "Example commit_type",
			scope: "Example scope",
			chars: 2,
			user_context: "Example user_context",
			details: "Example details",
			stat: "Example stat",
		},
		consumerHints: [
			"packages/coding-agent/src/commit/conventional/prompts/summary.md",
			"packages/coding-agent/src/commit/conventional/prompts.ts",
		],
	},
	{
		id: "commit/types-description.md",
		relPath: "commit/types-description.md",
		bundled: asset58,
		scope: "feature:commit/types-description",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/commit/prompts/types-description.md",
			"packages/coding-agent/src/commit/agentic/agent.ts",
		],
	},
	{
		id: "compaction/anthropic-compaction-instructions.md",
		relPath: "compaction/anthropic-compaction-instructions.md",
		bundled: asset59,
		scope: "compaction:anthropic-compaction-instructions",
		group: "compaction",
		keys: [
			{ path: "basePrompt", type: "string", required: true, resolution: "session-dependent" },
			{ path: "customInstructions", type: "string", required: false, resolution: "session-dependent" },
			{ path: "extraContext", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: {
			basePrompt: "Example basePrompt",
			customInstructions: "Example customInstructions",
			extraContext: "Example extraContext",
		},
		consumerHints: [
			"packages/agent/src/compaction/prompts/anthropic-compaction-instructions.md",
			"packages/agent/src/compaction/anthropic.ts",
		],
	},
	{
		id: "compaction/auto-handoff-threshold-focus.md",
		relPath: "compaction/auto-handoff-threshold-focus.md",
		bundled: asset60,
		scope: "compaction:auto-handoff-threshold-focus",
		group: "compaction",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/agent/src/compaction/prompts/auto-handoff-threshold-focus.md",
			"packages/agent/src/compaction/compaction.ts",
		],
	},
	{
		id: "compaction/branch-summary-context.md",
		relPath: "compaction/branch-summary-context.md",
		bundled: asset61,
		scope: "compaction:branch-summary-context",
		group: "compaction",
		keys: [{ path: "summary", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { summary: "Example summary" },
		consumerHints: [
			"packages/agent/src/compaction/prompts/branch-summary-context.md",
			"packages/agent/src/compaction/messages.ts",
		],
	},
	{
		id: "compaction/branch-summary-preamble.md",
		relPath: "compaction/branch-summary-preamble.md",
		bundled: asset62,
		scope: "compaction:branch-summary-preamble",
		group: "compaction",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/agent/src/compaction/prompts/branch-summary-preamble.md",
			"packages/agent/src/compaction/branch-summarization.ts",
		],
	},
	{
		id: "compaction/branch-summary.md",
		relPath: "compaction/branch-summary.md",
		bundled: asset63,
		scope: "compaction:branch-summary",
		group: "compaction",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/agent/src/compaction/prompts/branch-summary.md",
			"packages/agent/src/compaction/branch-summarization.ts",
		],
	},
	{
		id: "compaction/compaction-short-summary.md",
		relPath: "compaction/compaction-short-summary.md",
		bundled: asset64,
		scope: "compaction:compaction-short-summary",
		group: "compaction",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/agent/src/compaction/prompts/compaction-short-summary.md",
			"packages/agent/src/compaction/compaction.ts",
		],
	},
	{
		id: "compaction/compaction-summary-context.md",
		relPath: "compaction/compaction-summary-context.md",
		bundled: asset65,
		scope: "compaction:compaction-summary-context",
		group: "compaction",
		keys: [{ path: "summary", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { summary: "Example summary" },
		consumerHints: [
			"packages/agent/src/compaction/prompts/compaction-summary-context.md",
			"packages/agent/src/compaction/messages.ts",
		],
	},
	{
		id: "compaction/compaction-summary.md",
		relPath: "compaction/compaction-summary.md",
		bundled: asset66,
		scope: "compaction:compaction-summary",
		group: "compaction",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/agent/src/compaction/prompts/compaction-summary.md",
			"packages/agent/src/compaction/compaction.ts",
		],
	},
	{
		id: "compaction/compaction-turn-prefix.md",
		relPath: "compaction/compaction-turn-prefix.md",
		bundled: asset67,
		scope: "compaction:compaction-turn-prefix",
		group: "compaction",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/agent/src/compaction/prompts/compaction-turn-prefix.md",
			"packages/agent/src/compaction/compaction.ts",
		],
	},
	{
		id: "compaction/compaction-update-summary.md",
		relPath: "compaction/compaction-update-summary.md",
		bundled: asset68,
		scope: "compaction:compaction-update-summary",
		group: "compaction",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/agent/src/compaction/prompts/compaction-update-summary.md",
			"packages/agent/src/compaction/compaction.ts",
		],
	},
	{
		id: "compaction/context-window-truncated-output.md",
		relPath: "compaction/context-window-truncated-output.md",
		bundled: asset69,
		scope: "compaction:context-window-truncated-output",
		group: "compaction",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/agent/src/compaction/prompts/context-window-truncated-output.md",
			"packages/agent/src/compaction/openai.ts",
		],
	},
	{
		id: "compaction/file-operations.md",
		relPath: "compaction/file-operations.md",
		bundled: asset70,
		scope: "compaction:file-operations",
		group: "compaction",
		keys: [{ path: "files", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { files: "Example files" },
		consumerHints: [
			"packages/agent/src/compaction/prompts/file-operations.md",
			"packages/agent/src/compaction/utils.ts",
		],
	},
	{
		id: "compaction/handoff-document.md",
		relPath: "compaction/handoff-document.md",
		bundled: asset71,
		scope: "compaction:handoff-document",
		group: "compaction",
		keys: [{ path: "additionalFocus", type: "string", required: false, resolution: "session-dependent" }],
		fixture: { additionalFocus: "Example additionalFocus" },
		consumerHints: [
			"packages/agent/src/compaction/prompts/handoff-document.md",
			"packages/agent/src/compaction/compaction.ts",
		],
	},
	{
		id: "compaction/handoff-summary-context.md",
		relPath: "compaction/handoff-summary-context.md",
		bundled: asset72,
		scope: "compaction:handoff-summary-context",
		group: "compaction",
		keys: [{ path: "summary", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { summary: "Example summary" },
		consumerHints: [
			"packages/agent/src/compaction/prompts/handoff-summary-context.md",
			"packages/agent/src/compaction/messages.ts",
		],
	},
	{
		id: "compaction/snapcompact-archive-context.md",
		relPath: "compaction/snapcompact-archive-context.md",
		bundled: asset73,
		scope: "compaction:snapcompact-archive-context",
		group: "compaction",
		keys: [{ path: "archiveText", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { archiveText: "Example archiveText" },
		consumerHints: [
			"packages/agent/src/compaction/prompts/snapcompact-archive-context.md",
			"packages/agent/src/compaction/compaction.ts",
		],
	},
	{
		id: "compaction/snapcompact/file-operations.md",
		relPath: "compaction/snapcompact/file-operations.md",
		bundled: asset74,
		scope: "compaction:snapcompact/file-operations",
		group: "compaction",
		keys: [{ path: "files", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { files: "Example files" },
		consumerHints: ["packages/snapcompact/src/prompts/file-operations.md", "packages/snapcompact/src/snapcompact.ts"],
	},
	{
		id: "compaction/snapcompact/snapcompact-summary.md",
		relPath: "compaction/snapcompact/snapcompact-summary.md",
		bundled: asset75,
		scope: "compaction:snapcompact/snapcompact-summary",
		group: "compaction",
		keys: [
			{ path: "frameCount", type: "number", required: true, resolution: "session-dependent" },
			{ path: "multipleFrames", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "docColumns", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "cols", type: "string | number", required: true, resolution: "session-dependent" },
			{ path: "rows", type: "number", required: true, resolution: "session-dependent" },
			{ path: "sentenceInk", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "stopwordDimmed", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "lineRepeated", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "truncatedChars", type: "number", required: true, resolution: "session-dependent" },
			{ path: "includedPreviousSummary", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "files", type: "string", required: false, resolution: "session-dependent" },
			{ path: "includeThinking", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: {
			frameCount: 2,
			multipleFrames: true,
			docColumns: true,
			cols: "Example cols",
			rows: 2,
			sentenceInk: true,
			stopwordDimmed: true,
			lineRepeated: true,
			truncatedChars: 2,
			includedPreviousSummary: true,
			files: "Example files",
			includeThinking: true,
		},
		consumerHints: [
			"packages/snapcompact/src/prompts/snapcompact-summary.md",
			"packages/snapcompact/src/snapcompact.ts",
		],
	},
	{
		id: "compaction/summarization-system.md",
		relPath: "compaction/summarization-system.md",
		bundled: asset76,
		scope: "compaction:summarization-system",
		group: "compaction",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/agent/src/compaction/prompts/summarization-system.md",
			"packages/agent/src/compaction/utils.ts",
		],
	},
	{
		id: "compress/request.md",
		relPath: "compress/request.md",
		bundled: asset77,
		scope: "feature:compress/request",
		group: "feature",
		keys: [
			{ path: "path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "source_size", type: "string", required: true, resolution: "session-dependent" },
			{ path: "source", type: "string", required: true, resolution: "session-dependent" },
			{ path: "nonce", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			path: "/workspace/example",
			source_size: "Example source_size",
			source: "Example source",
			nonce: "Example nonce",
		},
		consumerHints: [
			"packages/coding-agent/src/compress/prompts/request.md",
			"packages/coding-agent/src/compress/index.ts",
		],
	},
	{
		id: "compress/review.md",
		relPath: "compress/review.md",
		bundled: asset78,
		scope: "feature:compress/review",
		group: "feature",
		keys: [
			{ path: "round", type: "string", required: true, resolution: "session-dependent" },
			{ path: "metrics", type: "string", required: true, resolution: "session-dependent" },
			{ path: "losses", type: "string", required: true, resolution: "session-dependent" },
			{ path: "draft", type: "string", required: true, resolution: "session-dependent" },
			{ path: "nonce", type: "string", required: true, resolution: "session-dependent" },
			{ path: "closing", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			round: "Example round",
			metrics: "Example metrics",
			losses: "Example losses",
			draft: "Example draft",
			nonce: "Example nonce",
			closing: "Example closing",
		},
		consumerHints: [
			"packages/coding-agent/src/compress/prompts/review.md",
			"packages/coding-agent/src/compress/index.ts",
		],
	},
	{
		id: "compress/system.md",
		relPath: "compress/system.md",
		bundled: asset79,
		scope: "feature:compress/system",
		group: "feature",
		keys: [
			{ path: "var", type: "string", resolution: "session-dependent" },
			{ path: "x", type: "string", resolution: "session-dependent" },
			{ path: "raw", type: "string", resolution: "session-dependent" },
		],
		fixture: { var: "Example var", x: "Example x", raw: "Example raw" },
		consumerHints: [
			"packages/coding-agent/src/compress/prompts/system.md",
			"packages/coding-agent/src/compress/session.ts",
		],
	},
	{
		id: "control-follow-up-warning.md",
		relPath: "control-follow-up-warning.md",
		bundled: asset80,
		scope: "feature:control-follow-up-warning",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/control-follow-up-warning.md",
			"packages/coding-agent/src/control/host.ts",
		],
	},
	{
		id: "discovery/builtin-rules/go-add-cleanup.md",
		relPath: "discovery/builtin-rules/go-add-cleanup.md",
		bundled: asset81,
		scope: "feature:discovery/builtin-rules/go-add-cleanup",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/go-add-cleanup.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/go-bench-loop.md",
		relPath: "discovery/builtin-rules/go-bench-loop.md",
		bundled: asset82,
		scope: "feature:discovery/builtin-rules/go-bench-loop",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/go-bench-loop.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/go-exp-promoted.md",
		relPath: "discovery/builtin-rules/go-exp-promoted.md",
		bundled: asset83,
		scope: "feature:discovery/builtin-rules/go-exp-promoted",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/go-exp-promoted.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/go-ioutil.md",
		relPath: "discovery/builtin-rules/go-ioutil.md",
		bundled: asset84,
		scope: "feature:discovery/builtin-rules/go-ioutil",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/go-ioutil.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/go-join-hostport.md",
		relPath: "discovery/builtin-rules/go-join-hostport.md",
		bundled: asset85,
		scope: "feature:discovery/builtin-rules/go-join-hostport",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/go-join-hostport.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/go-new-expr.md",
		relPath: "discovery/builtin-rules/go-new-expr.md",
		bundled: asset86,
		scope: "feature:discovery/builtin-rules/go-new-expr",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/go-new-expr.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/go-rand-v2.md",
		relPath: "discovery/builtin-rules/go-rand-v2.md",
		bundled: asset87,
		scope: "feature:discovery/builtin-rules/go-rand-v2",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/go-rand-v2.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/go-range-int.md",
		relPath: "discovery/builtin-rules/go-range-int.md",
		bundled: asset88,
		scope: "feature:discovery/builtin-rules/go-range-int",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/go-range-int.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/rs-box-leak.md",
		relPath: "discovery/builtin-rules/rs-box-leak.md",
		bundled: asset89,
		scope: "feature:discovery/builtin-rules/rs-box-leak",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/rs-box-leak.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/rs-future-prelude.md",
		relPath: "discovery/builtin-rules/rs-future-prelude.md",
		bundled: asset90,
		scope: "feature:discovery/builtin-rules/rs-future-prelude",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/rs-future-prelude.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/rs-lazylock.md",
		relPath: "discovery/builtin-rules/rs-lazylock.md",
		bundled: asset91,
		scope: "feature:discovery/builtin-rules/rs-lazylock",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/rs-lazylock.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/rs-match-ergonomics.md",
		relPath: "discovery/builtin-rules/rs-match-ergonomics.md",
		bundled: asset92,
		scope: "feature:discovery/builtin-rules/rs-match-ergonomics",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/rs-match-ergonomics.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/rs-result-type.md",
		relPath: "discovery/builtin-rules/rs-result-type.md",
		bundled: asset94,
		scope: "feature:discovery/builtin-rules/rs-result-type",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/rs-result-type.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-bare-catch.md",
		relPath: "discovery/builtin-rules/ts-bare-catch.md",
		bundled: asset95,
		scope: "feature:discovery/builtin-rules/ts-bare-catch",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-bare-catch.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-import-type.md",
		relPath: "discovery/builtin-rules/ts-import-type.md",
		bundled: asset96,
		scope: "feature:discovery/builtin-rules/ts-import-type",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-import-type.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-no-any.md",
		relPath: "discovery/builtin-rules/ts-no-any.md",
		bundled: asset97,
		scope: "feature:discovery/builtin-rules/ts-no-any",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-no-any.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-no-deprecated-leftovers.md",
		relPath: "discovery/builtin-rules/ts-no-deprecated-leftovers.md",
		bundled: asset98,
		scope: "feature:discovery/builtin-rules/ts-no-deprecated-leftovers",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-no-deprecated-leftovers.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-no-dynamic-import.md",
		relPath: "discovery/builtin-rules/ts-no-dynamic-import.md",
		bundled: asset99,
		scope: "feature:discovery/builtin-rules/ts-no-dynamic-import",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-no-dynamic-import.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-no-inline-cast-access.md",
		relPath: "discovery/builtin-rules/ts-no-inline-cast-access.md",
		bundled: asset100,
		scope: "feature:discovery/builtin-rules/ts-no-inline-cast-access",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-no-inline-cast-access.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-no-local-is-record.md",
		relPath: "discovery/builtin-rules/ts-no-local-is-record.md",
		bundled: asset101,
		scope: "feature:discovery/builtin-rules/ts-no-local-is-record",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-no-local-is-record.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-no-return-type.md",
		relPath: "discovery/builtin-rules/ts-no-return-type.md",
		bundled: asset102,
		scope: "feature:discovery/builtin-rules/ts-no-return-type",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-no-return-type.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-no-test-timers.md",
		relPath: "discovery/builtin-rules/ts-no-test-timers.md",
		bundled: asset103,
		scope: "feature:discovery/builtin-rules/ts-no-test-timers",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-no-test-timers.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-no-tiny-functions.md",
		relPath: "discovery/builtin-rules/ts-no-tiny-functions.md",
		bundled: asset104,
		scope: "feature:discovery/builtin-rules/ts-no-tiny-functions",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-no-tiny-functions.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-promise-with-resolvers.md",
		relPath: "discovery/builtin-rules/ts-promise-with-resolvers.md",
		bundled: asset105,
		scope: "feature:discovery/builtin-rules/ts-promise-with-resolvers",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-promise-with-resolvers.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-redundant-clear-guard.md",
		relPath: "discovery/builtin-rules/ts-redundant-clear-guard.md",
		bundled: asset106,
		scope: "feature:discovery/builtin-rules/ts-redundant-clear-guard",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-redundant-clear-guard.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "discovery/builtin-rules/ts-set-map.md",
		relPath: "discovery/builtin-rules/ts-set-map.md",
		bundled: asset107,
		scope: "feature:discovery/builtin-rules/ts-set-map",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/discovery/builtin-rules/ts-set-map.md",
			"packages/coding-agent/src/discovery/builtin-rules/index.ts",
		],
	},
	{
		id: "dry-balance-bench.md",
		relPath: "dry-balance-bench.md",
		bundled: asset108,
		scope: "feature:dry-balance-bench",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/dry-balance-bench.md",
			"packages/coding-agent/src/cli/dry-balance-cli.ts",
		],
	},
	{
		id: "edit/auto-repair.md",
		relPath: "edit/auto-repair.md",
		bundled: asset109,
		scope: "feature:edit/auto-repair",
		group: "feature",
		keys: [
			{ path: "lang", type: "string", required: true, resolution: "session-dependent" },
			{ path: "before", type: "string", required: true, resolution: "session-dependent" },
			{ path: "after", type: "string", required: true, resolution: "session-dependent" },
			{ path: "previousAttempt", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: {
			lang: "Example lang",
			before: "Example before",
			after: "Example after",
			previousAttempt: "Example previousAttempt",
		},
		consumerHints: ["packages/coding-agent/src/edit/auto-repair.md", "packages/coding-agent/src/edit/auto-repair.ts"],
	},
	{
		id: "edit/hashline-compact.md",
		relPath: "edit/hashline-compact.md",
		bundled: asset110,
		scope: "feature:edit/hashline-compact",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/edit/hashline-compact.md", "packages/coding-agent/src/edit/index.ts"],
	},
	{
		id: "extensibility/custom-commands/bundled/annotate/text-review.md",
		relPath: "extensibility/custom-commands/bundled/annotate/text-review.md",
		bundled: asset111,
		scope: "feature:extensibility/custom-commands/bundled/annotate/text-review",
		group: "feature",
		keys: [
			{ path: "sourceLabel", type: "string", required: true, resolution: "session-dependent" },
			{ path: "includeSource", type: "string", required: true, resolution: "session-dependent" },
			{ path: "sourceFence", type: "string", required: true, resolution: "session-dependent" },
			{ path: "sourceText", type: "string", required: true, resolution: "session-dependent" },
			{ path: "contextSummary", type: "string", required: true, resolution: "session-dependent" },
			{ path: "summaryFence", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "annotations",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "number", type: "string" },
					{ path: "isLine", type: "string" },
					{ path: "quoteIsInline", type: "string" },
					{ path: "quote", type: "string" },
					{ path: "quoteFence", type: "string" },
					{ path: "note", type: "string" },
				],
			},
		],
		fixture: {
			sourceLabel: "Example sourceLabel",
			includeSource: "Example includeSource",
			sourceFence: "Example sourceFence",
			sourceText: "Example sourceText",
			contextSummary: "Example contextSummary",
			summaryFence: "Example summaryFence",
			annotations: [
				{
					number: "Example number",
					isLine: "Example isLine",
					quoteIsInline: "Example quoteIsInline",
					quote: "Example quote",
					quoteFence: "Example quoteFence",
					note: "Example note",
				},
			],
		},
		consumerHints: [
			"packages/coding-agent/src/extensibility/custom-commands/bundled/annotate/prompts/text-review.md",
			"packages/coding-agent/src/extensibility/custom-commands/bundled/annotate/text-review.ts",
		],
	},
	{
		id: "extensibility/custom-commands/bundled/annotate/text-summary.md",
		relPath: "extensibility/custom-commands/bundled/annotate/text-summary.md",
		bundled: asset112,
		scope: "feature:extensibility/custom-commands/bundled/annotate/text-summary",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/extensibility/custom-commands/bundled/annotate/prompts/text-summary.md",
			"packages/coding-agent/src/extensibility/custom-commands/bundled/annotate/text-summary.ts",
		],
	},
	{
		id: "extensibility/custom-commands/bundled/review/annotations.md",
		relPath: "extensibility/custom-commands/bundled/review/annotations.md",
		bundled: asset113,
		scope: "feature:extensibility/custom-commands/bundled/review/annotations",
		group: "feature",
		keys: [
			{ path: "forReviewer", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "annotations",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "...annotation", type: "spread", resolution: "session-dependent" },
					{ path: "pathLabel", type: "string", required: true, resolution: "session-dependent" },
					{ path: "lineLabel", type: "string", required: true, resolution: "session-dependent" },
					{ path: "isLine", type: "string", required: true, resolution: "session-dependent" },
					{ path: "path", type: "string" },
					{ path: "oldPath", type: "string" },
					{ path: "newPath", type: "string" },
					{ path: "occurrence", type: "string" },
					{ path: "hunkHeader", type: "string" },
					{ path: "rawLine", type: "string" },
					{ path: "note", type: "string" },
				],
			},
			{ path: "supplementalInstructions", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			forReviewer: "Example forReviewer",
			annotations: [
				{
					"...annotation": "Example ...annotation",
					pathLabel: "/workspace/example",
					lineLabel: "Example lineLabel",
					isLine: "Example isLine",
					path: "/workspace/example",
					oldPath: "/workspace/example",
					newPath: "/workspace/example",
					occurrence: "Example occurrence",
					hunkHeader: "Example hunkHeader",
					rawLine: "Example rawLine",
					note: "Example note",
				},
			],
			supplementalInstructions: "Example supplementalInstructions",
		},
		consumerHints: [
			"packages/coding-agent/src/extensibility/custom-commands/bundled/review/prompts/annotations.md",
			"packages/coding-agent/src/extensibility/custom-commands/bundled/review/prompt.ts",
		],
	},
	{
		id: "goals/goal-budget-limit.md",
		relPath: "goals/goal-budget-limit.md",
		bundled: asset114,
		scope: "feature:goals/goal-budget-limit",
		group: "core",
		keys: [
			{ path: "objective", type: "string", required: true, resolution: "session-dependent" },
			{ path: "tokensUsed", type: "string", required: true, resolution: "session-dependent" },
			{ path: "tokenBudget", type: "string", required: true, resolution: "session-dependent" },
			{ path: "remainingTokens", type: "string", required: true, resolution: "session-dependent" },
			{ path: "timeUsedSeconds", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			objective: "Example objective",
			tokensUsed: "Example tokensUsed",
			tokenBudget: "Example tokenBudget",
			remainingTokens: "Example remainingTokens",
			timeUsedSeconds: "Example timeUsedSeconds",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/goals/goal-budget-limit.md",
			"packages/coding-agent/src/goals/runtime.ts",
		],
	},
	{
		id: "goals/goal-continuation.md",
		relPath: "goals/goal-continuation.md",
		bundled: asset115,
		scope: "feature:goals/goal-continuation",
		group: "core",
		keys: [
			{ path: "objective", type: "string", required: true, resolution: "session-dependent" },
			{ path: "tokensUsed", type: "string", required: true, resolution: "session-dependent" },
			{ path: "tokenBudget", type: "string", required: true, resolution: "session-dependent" },
			{ path: "remainingTokens", type: "string", required: true, resolution: "session-dependent" },
			{ path: "timeUsedSeconds", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			objective: "Example objective",
			tokensUsed: "Example tokensUsed",
			tokenBudget: "Example tokenBudget",
			remainingTokens: "Example remainingTokens",
			timeUsedSeconds: "Example timeUsedSeconds",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/goals/goal-continuation.md",
			"packages/coding-agent/src/goals/runtime.ts",
		],
	},
	{
		id: "goals/goal-mode-active.md",
		relPath: "goals/goal-mode-active.md",
		bundled: asset116,
		scope: "feature:goals/goal-mode-active",
		group: "core",
		keys: [
			{ path: "objective", type: "string", required: true, resolution: "session-dependent" },
			{ path: "tokensUsed", type: "string", required: true, resolution: "session-dependent" },
			{ path: "tokenBudget", type: "string", required: true, resolution: "session-dependent" },
			{ path: "remainingTokens", type: "string", required: true, resolution: "session-dependent" },
			{ path: "timeUsedSeconds", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			objective: "Example objective",
			tokensUsed: "Example tokensUsed",
			tokenBudget: "Example tokenBudget",
			remainingTokens: "Example remainingTokens",
			timeUsedSeconds: "Example timeUsedSeconds",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/goals/goal-mode-active.md",
			"packages/coding-agent/src/goals/runtime.ts",
		],
	},
	{
		id: "goals/goal-mode-context.md",
		relPath: "goals/goal-mode-context.md",
		bundled: asset117,
		scope: "feature:goals/goal-mode-context",
		group: "core",
		keys: [
			{ path: "goalContext", type: "string", required: true, resolution: "session-dependent" },
			{ path: "todoContext", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { goalContext: "Example goalContext", todoContext: "Example todoContext" },
		consumerHints: [
			"packages/coding-agent/src/prompts/goals/goal-mode-context.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "goals/goal-todo-context.md",
		relPath: "goals/goal-todo-context.md",
		bundled: asset118,
		scope: "feature:goals/goal-todo-context",
		group: "core",
		keys: [
			{ path: "canCallTodoTool", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "closed", type: "string", required: true, resolution: "session-dependent" },
			{ path: "open", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "phases",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{
						path: "tasks",
						type: "unknown[]",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "status", type: "string" },
							{ path: "content", type: "string" },
						],
					},
				],
			},
			{ path: "total", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			canCallTodoTool: true,
			closed: "Example closed",
			open: "Example open",
			phases: [{ name: "Example name", tasks: [{ status: "Example status", content: "Example content" }] }],
			total: "Example total",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/goals/goal-todo-context.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "goals/guided-goal-interview.md",
		relPath: "goals/guided-goal-interview.md",
		bundled: asset119,
		scope: "feature:goals/guided-goal-interview",
		group: "core",
		keys: [{ path: "initial", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { initial: "Example initial" },
		consumerHints: [
			"packages/coding-agent/src/prompts/goals/guided-goal-interview.md",
			"packages/coding-agent/src/modes/interactive-mode.ts",
		],
	},
	{
		id: "idea-funnel.md",
		relPath: "idea-funnel.md",
		bundled: asset120,
		scope: "feature:idea-funnel",
		group: "core",
		keys: [{ path: "idea", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { idea: "Example idea" },
		consumerHints: ["packages/coding-agent/src/prompts/idea-funnel.md", "packages/coding-agent/src/cli/npi-idea.ts"],
	},
	{
		id: "if-bench/cat-directive.md",
		relPath: "if-bench/cat-directive.md",
		bundled: asset121,
		scope: "feature:if-bench/cat-directive",
		group: "feature",
		keys: [{ path: "nyaMax", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { nyaMax: "Example nyaMax" },
		consumerHints: [
			"packages/coding-agent/src/if-bench/prompts/cat-directive.md",
			"packages/coding-agent/src/if-bench/protocol.ts",
		],
	},
	{
		id: "if-bench/system.md",
		relPath: "if-bench/system.md",
		bundled: asset122,
		scope: "feature:if-bench/system",
		group: "feature",
		keys: [{ path: "nyaMax", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { nyaMax: "Example nyaMax" },
		consumerHints: [
			"packages/coding-agent/src/if-bench/prompts/system.md",
			"packages/coding-agent/src/if-bench/protocol.ts",
		],
	},
	{
		id: "if-bench/turn.md",
		relPath: "if-bench/turn.md",
		bundled: asset123,
		scope: "feature:if-bench/turn",
		group: "feature",
		keys: [
			{ path: "catDirective", type: "string", required: true, resolution: "session-dependent" },
			{ path: "catBefore", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "catMiddle", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "catAfter", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "start", type: "string", required: true, resolution: "session-dependent" },
			{ path: "actionsHead", type: "string", required: true, resolution: "session-dependent" },
			{ path: "actionsTail", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			catDirective: "/workspace/example",
			catBefore: true,
			catMiddle: true,
			catAfter: true,
			start: "Example start",
			actionsHead: "Example actionsHead",
			actionsTail: "Example actionsTail",
		},
		consumerHints: [
			"packages/coding-agent/src/if-bench/prompts/turn.md",
			"packages/coding-agent/src/if-bench/protocol.ts",
		],
	},
	{
		id: "internal-urls/agent.md",
		relPath: "internal-urls/agent.md",
		bundled: asset124,
		scope: "feature:internal-urls/agent",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/agent.md",
			"packages/coding-agent/src/internal-urls/agent-protocol.ts",
		],
	},
	{
		id: "internal-urls/artifact.md",
		relPath: "internal-urls/artifact.md",
		bundled: asset125,
		scope: "feature:internal-urls/artifact",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/artifact.md",
			"packages/coding-agent/src/internal-urls/artifact-protocol.ts",
		],
	},
	{
		id: "internal-urls/cfg.md",
		relPath: "internal-urls/cfg.md",
		bundled: asset126,
		scope: "feature:internal-urls/cfg",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/cfg.md",
			"packages/coding-agent/src/internal-urls/cfg-protocol.ts",
		],
	},
	{
		id: "internal-urls/compaction.md",
		relPath: "internal-urls/compaction.md",
		bundled: asset127,
		scope: "feature:internal-urls/compaction",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/compaction.md",
			"packages/coding-agent/src/internal-urls/compaction-protocol.ts",
		],
	},
	{
		id: "internal-urls/env.md",
		relPath: "internal-urls/env.md",
		bundled: internalEnvironment,
		scope: "feature:internal-urls/env",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/env.md",
			"packages/coding-agent/src/internal-urls/env-protocol.ts",
		],
	},
	{
		id: "internal-urls/history.md",
		relPath: "internal-urls/history.md",
		bundled: asset128,
		scope: "feature:internal-urls/history",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/history.md",
			"packages/coding-agent/src/internal-urls/history-protocol.ts",
		],
	},
	{
		id: "internal-urls/issue.md",
		relPath: "internal-urls/issue.md",
		bundled: asset129,
		scope: "feature:internal-urls/issue",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/issue.md",
			"packages/coding-agent/src/internal-urls/issue-pr-protocol.ts",
		],
	},
	{
		id: "internal-urls/local.md",
		relPath: "internal-urls/local.md",
		bundled: asset130,
		scope: "feature:internal-urls/local",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/local.md",
			"packages/coding-agent/src/internal-urls/local-protocol.ts",
		],
	},
	{
		id: "internal-urls/model.md",
		relPath: "internal-urls/model.md",
		bundled: internalModel,
		scope: "feature:internal-urls/model",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/model.md",
			"packages/coding-agent/src/internal-urls/model-protocol.ts",
		],
	},
	{
		id: "internal-urls/mcp.md",
		relPath: "internal-urls/mcp.md",
		bundled: asset131,
		scope: "feature:internal-urls/mcp",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/mcp.md",
			"packages/coding-agent/src/internal-urls/mcp-protocol.ts",
		],
	},
	{
		id: "internal-urls/memory.md",
		relPath: "internal-urls/memory.md",
		bundled: asset132,
		scope: "feature:internal-urls/memory",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/memory.md",
			"packages/coding-agent/src/internal-urls/memory-protocol.ts",
		],
	},
	{
		id: "internal-urls/omp.md",
		relPath: "internal-urls/omp.md",
		bundled: asset133,
		scope: "feature:internal-urls/omp",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/omp.md",
			"packages/coding-agent/src/internal-urls/omp-protocol.ts",
		],
	},
	{
		id: "internal-urls/proc.md",
		relPath: "internal-urls/proc.md",
		bundled: asset134,
		scope: "feature:internal-urls/proc",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/proc.md",
			"packages/coding-agent/src/internal-urls/proc-protocol.ts",
		],
	},
	{
		id: "internal-urls/rule.md",
		relPath: "internal-urls/rule.md",
		bundled: asset135,
		scope: "feature:internal-urls/rule",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/rule.md",
			"packages/coding-agent/src/internal-urls/rule-protocol.ts",
		],
	},
	{
		id: "internal-urls/security.md",
		relPath: "internal-urls/security.md",
		bundled: asset136,
		scope: "feature:internal-urls/security",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/security.md",
			"packages/coding-agent/src/internal-urls/security-protocol.ts",
		],
	},
	{
		id: "internal-urls/skill.md",
		relPath: "internal-urls/skill.md",
		bundled: asset137,
		scope: "feature:internal-urls/skill",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/skill.md",
			"packages/coding-agent/src/internal-urls/skill-protocol.ts",
		],
	},
	{
		id: "internal-urls/ssh.md",
		relPath: "internal-urls/ssh.md",
		bundled: asset138,
		scope: "feature:internal-urls/ssh",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/ssh.md",
			"packages/coding-agent/src/internal-urls/ssh-protocol.ts",
		],
	},
	{
		id: "internal-urls/tool.md",
		relPath: "internal-urls/tool.md",
		bundled: asset139,
		scope: "feature:internal-urls/tool",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/tool.md",
			"packages/coding-agent/src/internal-urls/tool-protocol.ts",
		],
	},
	{
		id: "internal-urls/vault.md",
		relPath: "internal-urls/vault.md",
		bundled: asset140,
		scope: "feature:internal-urls/vault",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/internal-urls/vault.md",
			"packages/coding-agent/src/internal-urls/vault-protocol.ts",
		],
	},
	{
		id: "issues/author-request.md",
		relPath: "issues/author-request.md",
		bundled: asset141,
		scope: "feature:issues/author-request",
		group: "feature",
		keys: [
			{ path: "requestId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "prose", type: "string", required: true, resolution: "session-dependent" },
			{ path: "repo", type: "string", required: true, resolution: "session-dependent" },
			{ path: "checkoutPath", type: "string", required: true, resolution: "session-dependent" },
			{ path: "targetReason", type: "string", required: true, resolution: "session-dependent" },
			{ path: "foregroundCwd", type: "string", required: true, resolution: "session-dependent" },
			{ path: "foregroundRepo", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			requestId: "example-1",
			prose: "Example prose",
			repo: "Example repo",
			checkoutPath: "/workspace/example",
			targetReason: "Example targetReason",
			foregroundCwd: "/workspace/example",
			foregroundRepo: "Example foregroundRepo",
		},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/author-request.md",
			"packages/coding-agent/src/issues/filing.ts",
		],
	},
	{
		id: "issues/author-system.md",
		relPath: "issues/author-system.md",
		bundled: asset142,
		scope: "feature:issues/author-system",
		group: "feature",
		keys: [
			{ path: "repo", type: "string", required: true, resolution: "session-dependent" },
			{ path: "checkoutPath", type: "string", required: true, resolution: "session-dependent" },
			{ path: "modelName", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { repo: "Example repo", checkoutPath: "/workspace/example", modelName: "Example modelName" },
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/author-system.md",
			"packages/coding-agent/src/issues/filing.ts",
		],
	},
	{
		id: "issues/notice.md",
		relPath: "issues/notice.md",
		bundled: asset143,
		scope: "feature:issues/notice",
		group: "feature",
		keys: [
			{ path: "requestId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "prose", type: "string", required: true, resolution: "session-dependent" },
			{ path: "dispatched", type: "string", resolution: "session-dependent" },
			{ path: "agentId", type: "string", resolution: "session-dependent" },
			{ path: "question", type: "string", resolution: "session-dependent" },
			{
				path: "published",
				type: "object",
				children: [
					{ path: "url", type: "string" },
					{ path: "repo", type: "string" },
					{ path: "title", type: "string" },
					{ path: "labels", type: "string" },
					{ path: "body", type: "string" },
				],
				resolution: "session-dependent",
			},
			{
				path: "unread",
				type: "object",
				children: [
					{ path: "url", type: "string" },
					{ path: "repo", type: "string" },
				],
				resolution: "session-dependent",
			},
			{
				path: "uncertain",
				type: "object",
				children: [
					{ path: "repo", type: "string" },
					{ path: "title", type: "string" },
				],
				resolution: "session-dependent",
			},
			{
				path: "owner",
				type: "object",
				children: [
					{ path: "url", type: "string" },
					{ path: "reason", type: "string" },
					{ path: "draft", type: "string" },
				],
				resolution: "session-dependent",
			},
			{ path: "declined", type: "string", resolution: "session-dependent" },
			{ path: "failed", type: "string", resolution: "session-dependent" },
		],
		fixture: {
			requestId: "example-1",
			prose: "Example prose",
			dispatched: "Example dispatched",
			agentId: "example-1",
			question: "Example question",
			published: {
				url: "Example url",
				repo: "Example repo",
				title: "Example title",
				labels: "Example labels",
				body: "Example body",
			},
			unread: { url: "Example url", repo: "Example repo" },
			uncertain: { repo: "Example repo", title: "Example title" },
			owner: { url: "Example url", reason: "Example reason", draft: "Example draft" },
			declined: "Example declined",
			failed: "Example failed",
		},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/notice.md",
			"packages/coding-agent/src/issues/filing.ts",
		],
	},
	{
		id: "issues/target-request.md",
		relPath: "issues/target-request.md",
		bundled: asset144,
		scope: "feature:issues/target-request",
		group: "feature",
		keys: [
			{ path: "requestId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "prose", type: "string", required: true, resolution: "session-dependent" },
			{ path: "foregroundCwd", type: "string", required: true, resolution: "session-dependent" },
			{ path: "foregroundRepo", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "repositories",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "repo", type: "string" },
					{ path: "description", type: "string" },
					{ path: "flags", type: "string" },
					{ path: "checkouts", type: "string" },
				],
			},
			{ path: "warnings", type: "unknown[]", required: true, resolution: "session-dependent" },
		],
		fixture: {
			requestId: "example-1",
			prose: "Example prose",
			foregroundCwd: "/workspace/example",
			foregroundRepo: "Example foregroundRepo",
			repositories: [
				{
					repo: "Example repo",
					description: "Example description",
					flags: "Example flags",
					checkouts: "Example checkouts",
				},
			],
			warnings: ["example"],
		},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/target-request.md",
			"packages/coding-agent/src/issues/filing.ts",
		],
	},
	{
		id: "issues/target-system.md",
		relPath: "issues/target-system.md",
		bundled: asset145,
		scope: "feature:issues/target-system",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/target-system.md",
			"packages/coding-agent/src/issues/filing.ts",
		],
	},
	{
		id: "issues/tool-decline.md",
		relPath: "issues/tool-decline.md",
		bundled: asset146,
		scope: "feature:issues/tool-decline",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/tool-decline.md",
			"packages/coding-agent/src/issues/tools.ts",
		],
	},
	{
		id: "issues/tool-existing-owner.md",
		relPath: "issues/tool-existing-owner.md",
		bundled: asset147,
		scope: "feature:issues/tool-existing-owner",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/tool-existing-owner.md",
			"packages/coding-agent/src/issues/tools.ts",
		],
	},
	{
		id: "issues/tool-labels.md",
		relPath: "issues/tool-labels.md",
		bundled: asset148,
		scope: "feature:issues/tool-labels",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/tool-labels.md",
			"packages/coding-agent/src/issues/tools.ts",
		],
	},
	{
		id: "issues/tool-publish.md",
		relPath: "issues/tool-publish.md",
		bundled: asset149,
		scope: "feature:issues/tool-publish",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/tool-publish.md",
			"packages/coding-agent/src/issues/tools.ts",
		],
	},
	{
		id: "issues/tool-samples.md",
		relPath: "issues/tool-samples.md",
		bundled: asset150,
		scope: "feature:issues/tool-samples",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/tool-samples.md",
			"packages/coding-agent/src/issues/tools.ts",
		],
	},
	{
		id: "issues/tool-search.md",
		relPath: "issues/tool-search.md",
		bundled: asset151,
		scope: "feature:issues/tool-search",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/tool-search.md",
			"packages/coding-agent/src/issues/tools.ts",
		],
	},
	{
		id: "issues/tool-target.md",
		relPath: "issues/tool-target.md",
		bundled: asset152,
		scope: "feature:issues/tool-target",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/tool-target.md",
			"packages/coding-agent/src/issues/tools.ts",
		],
	},
	{
		id: "issues/tool-view.md",
		relPath: "issues/tool-view.md",
		bundled: asset153,
		scope: "feature:issues/tool-view",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/issues/prompts/tool-view.md",
			"packages/coding-agent/src/issues/tools.ts",
		],
	},
	{
		id: "launch-profile.md",
		relPath: "launch-profile.md",
		bundled: asset154,
		scope: "feature:launch-profile",
		group: "core",
		keys: [
			{ path: "name", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "sources",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "path", type: "string" },
					{ path: "content", type: "string" },
				],
			},
		],
		fixture: { name: "Example name", sources: [{ path: "/workspace/example", content: "Example content" }] },
		consumerHints: [
			"packages/coding-agent/src/prompts/launch-profile.md",
			"packages/coding-agent/src/neopi/launch-profile.ts",
		],
	},
	{
		id: "live/agent-final-message.md",
		relPath: "live/agent-final-message.md",
		bundled: asset155,
		scope: "feature:live/agent-final-message",
		group: "feature",
		keys: [{ path: "message", type: "string", resolution: "session-dependent" }],
		fixture: { message: "Example message" },
		consumerHints: [
			"packages/coding-agent/src/live/prompts/agent-final-message.md",
			"packages/coding-agent/src/live/controller.ts",
		],
	},
	{
		id: "live/generate-persona.md",
		relPath: "live/generate-persona.md",
		bundled: livePersonaGenerationSystem,
		scope: "feature:live/generate-persona",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/live/prompts/generate-persona.md",
			"packages/coding-agent/src/live/persona-generation.ts",
		],
	},
	{
		id: "live/generate-persona-user.md",
		relPath: "live/generate-persona-user.md",
		bundled: livePersonaGenerationUser,
		scope: "feature:live/generate-persona-user",
		group: "feature",
		keys: [
			{ path: "description", type: "string", resolution: "session-dependent" },
			{
				path: "references",
				type: "object[]",
				resolution: "session-dependent",
				children: [
					{ path: "label", type: "string", resolution: "session-dependent" },
					{ path: "instructions", type: "string", resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			description: "A patient cartographer.",
			references: [{ label: "Selected persona", instructions: "Speak in short, clear sentences." }],
		},
		consumerHints: [
			"packages/coding-agent/src/live/prompts/generate-persona-user.md",
			"packages/coding-agent/src/live/persona-generation.ts",
		],
	},
	{
		id: "live/live-client-protocol.md",
		relPath: "live/live-client-protocol.md",
		bundled: asset156,
		scope: "feature:live/live-client-protocol",
		group: "feature",
		keys: [{ path: "firstName", type: "string", resolution: "session-dependent" }],
		fixture: { firstName: "Example firstName" },
		consumerHints: [
			"packages/coding-agent/src/live/prompts/live-client-protocol.md",
			"packages/coding-agent/src/modes/controllers/selector-controller.ts",
		],
	},
	{
		id: "live/live-instructions.md",
		relPath: "live/live-instructions.md",
		bundled: asset157,
		scope: "live",
		group: "feature",
		keys: describePromptContext(livePromptContextFixture).map(key => ({
			...key,
			required: true,
			resolution: "runtime-only" as const,
		})),
		fixture: livePromptContextFixture,
		consumerHints: [
			"packages/coding-agent/src/live/prompts/live-instructions.md",
			"packages/coding-agent/src/live/personas.ts",
		],
	},
	{
		id: "live/operator-shared-message.md",
		relPath: "live/operator-shared-message.md",
		bundled: asset158,
		scope: "feature:live/operator-shared-message",
		group: "feature",
		keys: [{ path: "message", type: "string", resolution: "session-dependent" }],
		fixture: { message: "Example message" },
		consumerHints: [
			"packages/coding-agent/src/live/prompts/operator-shared-message.md",
			"packages/coding-agent/src/live/controller.ts",
		],
	},
	{
		id: "live/operator-submitted-message.md",
		relPath: "live/operator-submitted-message.md",
		bundled: liveOperatorSubmittedMessage,
		scope: "feature:live/operator-submitted-message",
		group: "feature",
		keys: [{ path: "message", type: "string", resolution: "session-dependent" }],
		fixture: { message: "Example message" },
		consumerHints: [
			"packages/coding-agent/src/live/prompts/operator-submitted-message.md",
			"packages/coding-agent/src/live/controller.ts",
		],
	},
	{
		id: "live/operator-typed-message.md",
		relPath: "live/operator-typed-message.md",
		bundled: asset159,
		scope: "feature:live/operator-typed-message",
		group: "feature",
		keys: [
			{ path: "message", type: "string", resolution: "session-dependent" },
			{ path: "delegationRejected", type: "boolean", required: false, resolution: "session-dependent" },
		],
		fixture: { message: "Example message", delegationRejected: true },
		consumerHints: [
			"packages/coding-agent/src/live/prompts/operator-typed-message.md",
			"packages/coding-agent/src/live/controller.ts",
		],
	},
	{
		id: "live/primary-history.md",
		relPath: "live/primary-history.md",
		bundled: livePrimaryHistory,
		scope: "feature:live/primary-history",
		group: "feature",
		keys: [{ path: "message", type: "string", resolution: "session-dependent" }],
		fixture: { message: "Operator: Continue the parser repair." },
		consumerHints: [
			"packages/coding-agent/src/live/prompts/primary-history.md",
			"packages/coding-agent/src/live/history-seed.ts",
		],
	},
	{
		id: "live/session-instructions.md",
		relPath: "live/session-instructions.md",
		bundled: liveSessionInstructions,
		scope: "feature:live/session-instructions",
		group: "feature",
		keys: [{ path: "personaInstructions", type: "string", resolution: "session-dependent" }],
		fixture: { personaInstructions: "Example persona instructions" },
		consumerHints: [
			"packages/coding-agent/src/live/prompts/session-instructions.md",
			"packages/coding-agent/src/live/controller.ts",
		],
	},
	{
		id: "live/subagent-importance.md",
		relPath: "live/subagent-importance.md",
		bundled: asset160,
		scope: "feature:live/subagent-importance",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/live/prompts/subagent-importance.md",
			"packages/coding-agent/src/live/ingest-classifier.ts",
		],
	},
	{
		id: "live/voice-agent-note.md",
		relPath: "live/voice-agent-note.md",
		bundled: asset161,
		scope: "feature:live/voice-agent-note",
		group: "feature",
		keys: [{ path: "voice", type: "string", resolution: "session-dependent" }],
		fixture: { voice: "Example voice" },
		consumerHints: [
			"packages/coding-agent/src/live/prompts/voice-agent-note.md",
			"packages/coding-agent/src/live/delegation-note.ts",
		],
	},
	{
		id: "memories/consolidation_system.md",
		relPath: "memories/consolidation_system.md",
		bundled: asset162,
		scope: "feature:memories/consolidation_system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/memories/consolidation_system.md",
			"packages/coding-agent/src/memories/index.ts",
		],
	},
	{
		id: "memories/consolidation.md",
		relPath: "memories/consolidation.md",
		bundled: asset163,
		scope: "feature:memories/consolidation",
		group: "core",
		keys: [
			{ path: "raw_memories", type: "string", required: true, resolution: "session-dependent" },
			{ path: "rollout_summaries", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { raw_memories: "Example raw_memories", rollout_summaries: "Example rollout_summaries" },
		consumerHints: [
			"packages/coding-agent/src/prompts/memories/consolidation.md",
			"packages/coding-agent/src/memories/index.ts",
		],
	},
	{
		id: "memories/read-path.md",
		relPath: "memories/read-path.md",
		bundled: asset164,
		scope: "feature:memories/read-path",
		group: "core",
		keys: [
			{ path: "memory_summary", type: "string", required: true, resolution: "session-dependent" },
			{ path: "learned", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { memory_summary: "Example memory_summary", learned: "Example learned" },
		consumerHints: [
			"packages/coding-agent/src/prompts/memories/read-path.md",
			"packages/coding-agent/src/memories/index.ts",
		],
	},
	{
		id: "memories/sharpshooter-consolidate-input.md",
		relPath: "memories/sharpshooter-consolidate-input.md",
		bundled: asset165,
		scope: "feature:memories/sharpshooter-consolidate-input",
		group: "core",
		keys: [
			{ path: "architecture", type: "string", required: true, resolution: "session-dependent" },
			{ path: "product", type: "string", required: true, resolution: "session-dependent" },
			{ path: "style", type: "string", required: true, resolution: "session-dependent" },
			{ path: "projectDocs", type: "string", required: true, resolution: "session-dependent" },
			{ path: "sessions", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			architecture: "Example architecture",
			product: "Example product",
			style: "Example style",
			projectDocs: "Example projectDocs",
			sessions: "Example sessions",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/memories/sharpshooter-consolidate-input.md",
			"packages/coding-agent/src/sharpshooter/consolidate.ts",
		],
	},
	{
		id: "memories/sharpshooter-consolidate-system.md",
		relPath: "memories/sharpshooter-consolidate-system.md",
		bundled: asset166,
		scope: "feature:memories/sharpshooter-consolidate-system",
		group: "core",
		keys: [{ path: "maxFileLines", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { maxFileLines: "Example maxFileLines" },
		consumerHints: [
			"packages/coding-agent/src/prompts/memories/sharpshooter-consolidate-system.md",
			"packages/coding-agent/src/sharpshooter/consolidate.ts",
		],
	},
	{
		id: "memories/sharpshooter-extract-input.md",
		relPath: "memories/sharpshooter-extract-input.md",
		bundled: asset167,
		scope: "feature:memories/sharpshooter-extract-input",
		group: "core",
		keys: [
			{ path: "...envelope", type: "spread", resolution: "session-dependent" },
			{ path: "previousHuman", type: "string", resolution: "session-dependent" },
			{ path: "assistantContext", type: "string", resolution: "session-dependent" },
			{ path: "prompt", type: "string", resolution: "session-dependent" },
		],
		fixture: {
			"...envelope": "Example ...envelope",
			previousHuman: "Example previousHuman",
			assistantContext: "Example assistantContext",
			prompt: "Example prompt",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/memories/sharpshooter-extract-input.md",
			"packages/coding-agent/src/sharpshooter/extract.ts",
		],
	},
	{
		id: "memories/sharpshooter-extract-system.md",
		relPath: "memories/sharpshooter-extract-system.md",
		bundled: asset168,
		scope: "feature:memories/sharpshooter-extract-system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/memories/sharpshooter-extract-system.md",
			"packages/coding-agent/src/sharpshooter/extract.ts",
		],
	},
	{
		id: "memories/stage_one_input.md",
		relPath: "memories/stage_one_input.md",
		bundled: asset169,
		scope: "feature:memories/stage_one_input",
		group: "core",
		keys: [
			{ path: "thread_id", type: "string", required: true, resolution: "session-dependent" },
			{ path: "response_items_json", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { thread_id: "example-1", response_items_json: "{}" },
		consumerHints: [
			"packages/coding-agent/src/prompts/memories/stage_one_input.md",
			"packages/coding-agent/src/memories/index.ts",
		],
	},
	{
		id: "memories/stage_one_system.md",
		relPath: "memories/stage_one_system.md",
		bundled: asset170,
		scope: "feature:memories/stage_one_system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/memories/stage_one_system.md",
			"packages/coding-agent/src/memories/index.ts",
		],
	},
	{
		id: "moa/envelopes/defend.md",
		relPath: "moa/envelopes/defend.md",
		bundled: asset171,
		scope: "feature:moa/envelopes/defend",
		partials: { "moa-parts": "moa/envelopes/moa-parts.md" },
		group: "core",
		keys: [
			{
				path: "mixture",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "member_count", type: "number", required: true, resolution: "session-dependent" },
					{
						path: "members",
						type: "object[]",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "id", type: "string", required: true, resolution: "session-dependent" },
							{ path: "description", type: "string", required: false, resolution: "session-dependent" },
							{ path: "model", type: "string", required: true, resolution: "session-dependent" },
						],
					},
				],
			},
			{ path: "topic", type: "string", required: true, resolution: "session-dependent" },
			{ path: "conversation", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "from",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "to",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "edge",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "traversal", type: "number", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "hop", type: "number", required: true, resolution: "session-dependent" },
			{
				path: "x",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "output", type: "string", required: false, resolution: "session-dependent" },
					{ path: "input", type: "string", required: false, resolution: "session-dependent" },
					{ path: "reasoning", type: "string", required: false, resolution: "session-dependent" },
					{ path: "tool_trace", type: "string", required: false, resolution: "session-dependent" },
					{ path: "transcript", type: "string", required: false, resolution: "session-dependent" },
				],
			},
			{
				path: "limit",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
					{ path: "value", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			mixture: {
				name: "Example name",
				member_count: 2,
				members: [{ id: "example-1", description: "Example description", model: "Example model" }],
			},
			topic: "Example topic",
			conversation: "Example conversation",
			from: { id: "example-1", description: "Example description", model: "Example model" },
			to: { id: "example-1", description: "Example description", model: "Example model" },
			edge: { id: "example-1", traversal: 2 },
			hop: 2,
			x: {
				output: "Example output",
				input: "Example input",
				reasoning: "Example reasoning",
				tool_trace: "Example tool_trace",
				transcript: "Example transcript",
			},
			limit: { kind: "Example kind", value: "Example value" },
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/envelopes/defend.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/envelopes/disagree.md",
		relPath: "moa/envelopes/disagree.md",
		bundled: asset172,
		scope: "feature:moa/envelopes/disagree",
		partials: { "moa-parts": "moa/envelopes/moa-parts.md" },
		group: "core",
		keys: [
			{
				path: "mixture",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "member_count", type: "number", required: true, resolution: "session-dependent" },
					{
						path: "members",
						type: "object[]",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "id", type: "string", required: true, resolution: "session-dependent" },
							{ path: "description", type: "string", required: false, resolution: "session-dependent" },
							{ path: "model", type: "string", required: true, resolution: "session-dependent" },
						],
					},
				],
			},
			{ path: "topic", type: "string", required: true, resolution: "session-dependent" },
			{ path: "conversation", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "from",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "to",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "edge",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "traversal", type: "number", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "hop", type: "number", required: true, resolution: "session-dependent" },
			{
				path: "x",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "output", type: "string", required: false, resolution: "session-dependent" },
					{ path: "input", type: "string", required: false, resolution: "session-dependent" },
					{ path: "reasoning", type: "string", required: false, resolution: "session-dependent" },
					{ path: "tool_trace", type: "string", required: false, resolution: "session-dependent" },
					{ path: "transcript", type: "string", required: false, resolution: "session-dependent" },
				],
			},
			{
				path: "limit",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
					{ path: "value", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			mixture: {
				name: "Example name",
				member_count: 2,
				members: [{ id: "example-1", description: "Example description", model: "Example model" }],
			},
			topic: "Example topic",
			conversation: "Example conversation",
			from: { id: "example-1", description: "Example description", model: "Example model" },
			to: { id: "example-1", description: "Example description", model: "Example model" },
			edge: { id: "example-1", traversal: 2 },
			hop: 2,
			x: {
				output: "Example output",
				input: "Example input",
				reasoning: "Example reasoning",
				tool_trace: "Example tool_trace",
				transcript: "Example transcript",
			},
			limit: { kind: "Example kind", value: "Example value" },
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/envelopes/disagree.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/envelopes/entry.md",
		relPath: "moa/envelopes/entry.md",
		bundled: asset173,
		scope: "feature:moa/envelopes/entry",
		group: "core",
		keys: [
			{
				path: "mixture",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "member_count", type: "number", required: true, resolution: "session-dependent" },
					{
						path: "members",
						type: "object[]",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "id", type: "string", required: true, resolution: "session-dependent" },
							{ path: "description", type: "string", required: false, resolution: "session-dependent" },
							{ path: "model", type: "string", required: true, resolution: "session-dependent" },
						],
					},
				],
			},
			{ path: "topic", type: "string", required: true, resolution: "session-dependent" },
			{ path: "conversation", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "from",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "to",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "edge",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "traversal", type: "number", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "hop", type: "number", required: true, resolution: "session-dependent" },
			{
				path: "x",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "output", type: "string", required: false, resolution: "session-dependent" },
					{ path: "input", type: "string", required: false, resolution: "session-dependent" },
					{ path: "reasoning", type: "string", required: false, resolution: "session-dependent" },
					{ path: "tool_trace", type: "string", required: false, resolution: "session-dependent" },
					{ path: "transcript", type: "string", required: false, resolution: "session-dependent" },
				],
			},
			{
				path: "limit",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
					{ path: "value", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			mixture: {
				name: "Example name",
				member_count: 2,
				members: [{ id: "example-1", description: "Example description", model: "Example model" }],
			},
			topic: "Example topic",
			conversation: "Example conversation",
			from: { id: "example-1", description: "Example description", model: "Example model" },
			to: { id: "example-1", description: "Example description", model: "Example model" },
			edge: { id: "example-1", traversal: 2 },
			hop: 2,
			x: {
				output: "Example output",
				input: "Example input",
				reasoning: "Example reasoning",
				tool_trace: "Example tool_trace",
				transcript: "Example transcript",
			},
			limit: { kind: "Example kind", value: "Example value" },
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/envelopes/entry.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/envelopes/handoff.md",
		relPath: "moa/envelopes/handoff.md",
		bundled: asset174,
		scope: "feature:moa/envelopes/handoff",
		partials: { "moa-parts": "moa/envelopes/moa-parts.md" },
		group: "core",
		keys: [
			{
				path: "mixture",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "member_count", type: "number", required: true, resolution: "session-dependent" },
					{
						path: "members",
						type: "object[]",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "id", type: "string", required: true, resolution: "session-dependent" },
							{ path: "description", type: "string", required: false, resolution: "session-dependent" },
							{ path: "model", type: "string", required: true, resolution: "session-dependent" },
						],
					},
				],
			},
			{ path: "topic", type: "string", required: true, resolution: "session-dependent" },
			{ path: "conversation", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "from",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "to",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "edge",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "traversal", type: "number", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "hop", type: "number", required: true, resolution: "session-dependent" },
			{
				path: "x",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "output", type: "string", required: false, resolution: "session-dependent" },
					{ path: "input", type: "string", required: false, resolution: "session-dependent" },
					{ path: "reasoning", type: "string", required: false, resolution: "session-dependent" },
					{ path: "tool_trace", type: "string", required: false, resolution: "session-dependent" },
					{ path: "transcript", type: "string", required: false, resolution: "session-dependent" },
				],
			},
			{
				path: "limit",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
					{ path: "value", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			mixture: {
				name: "Example name",
				member_count: 2,
				members: [{ id: "example-1", description: "Example description", model: "Example model" }],
			},
			topic: "Example topic",
			conversation: "Example conversation",
			from: { id: "example-1", description: "Example description", model: "Example model" },
			to: { id: "example-1", description: "Example description", model: "Example model" },
			edge: { id: "example-1", traversal: 2 },
			hop: 2,
			x: {
				output: "Example output",
				input: "Example input",
				reasoning: "Example reasoning",
				tool_trace: "Example tool_trace",
				transcript: "Example transcript",
			},
			limit: { kind: "Example kind", value: "Example value" },
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/envelopes/handoff.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/envelopes/judge.md",
		relPath: "moa/envelopes/judge.md",
		bundled: asset175,
		scope: "feature:moa/envelopes/judge",
		partials: { "moa-parts": "moa/envelopes/moa-parts.md" },
		group: "core",
		keys: [
			{
				path: "mixture",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "member_count", type: "number", required: true, resolution: "session-dependent" },
					{
						path: "members",
						type: "object[]",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "id", type: "string", required: true, resolution: "session-dependent" },
							{ path: "description", type: "string", required: false, resolution: "session-dependent" },
							{ path: "model", type: "string", required: true, resolution: "session-dependent" },
						],
					},
				],
			},
			{ path: "topic", type: "string", required: true, resolution: "session-dependent" },
			{ path: "conversation", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "from",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "to",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "edge",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "traversal", type: "number", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "hop", type: "number", required: true, resolution: "session-dependent" },
			{
				path: "x",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "output", type: "string", required: false, resolution: "session-dependent" },
					{ path: "input", type: "string", required: false, resolution: "session-dependent" },
					{ path: "reasoning", type: "string", required: false, resolution: "session-dependent" },
					{ path: "tool_trace", type: "string", required: false, resolution: "session-dependent" },
					{ path: "transcript", type: "string", required: false, resolution: "session-dependent" },
				],
			},
			{
				path: "limit",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
					{ path: "value", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			mixture: {
				name: "Example name",
				member_count: 2,
				members: [{ id: "example-1", description: "Example description", model: "Example model" }],
			},
			topic: "Example topic",
			conversation: "Example conversation",
			from: { id: "example-1", description: "Example description", model: "Example model" },
			to: { id: "example-1", description: "Example description", model: "Example model" },
			edge: { id: "example-1", traversal: 2 },
			hop: 2,
			x: {
				output: "Example output",
				input: "Example input",
				reasoning: "Example reasoning",
				tool_trace: "Example tool_trace",
				transcript: "Example transcript",
			},
			limit: { kind: "Example kind", value: "Example value" },
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/envelopes/judge.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/envelopes/limit.md",
		relPath: "moa/envelopes/limit.md",
		bundled: asset176,
		scope: "feature:moa/envelopes/limit",
		partials: { "moa-parts": "moa/envelopes/moa-parts.md" },
		group: "core",
		keys: [
			{
				path: "mixture",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "member_count", type: "number", required: true, resolution: "session-dependent" },
					{
						path: "members",
						type: "object[]",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "id", type: "string", required: true, resolution: "session-dependent" },
							{ path: "description", type: "string", required: false, resolution: "session-dependent" },
							{ path: "model", type: "string", required: true, resolution: "session-dependent" },
						],
					},
				],
			},
			{ path: "topic", type: "string", required: true, resolution: "session-dependent" },
			{ path: "conversation", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "from",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "to",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "edge",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "traversal", type: "number", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "hop", type: "number", required: true, resolution: "session-dependent" },
			{
				path: "x",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "output", type: "string", required: false, resolution: "session-dependent" },
					{ path: "input", type: "string", required: false, resolution: "session-dependent" },
					{ path: "reasoning", type: "string", required: false, resolution: "session-dependent" },
					{ path: "tool_trace", type: "string", required: false, resolution: "session-dependent" },
					{ path: "transcript", type: "string", required: false, resolution: "session-dependent" },
				],
			},
			{
				path: "limit",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
					{ path: "value", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			mixture: {
				name: "Example name",
				member_count: 2,
				members: [{ id: "example-1", description: "Example description", model: "Example model" }],
			},
			topic: "Example topic",
			conversation: "Example conversation",
			from: { id: "example-1", description: "Example description", model: "Example model" },
			to: { id: "example-1", description: "Example description", model: "Example model" },
			edge: { id: "example-1", traversal: 2 },
			hop: 2,
			x: {
				output: "Example output",
				input: "Example input",
				reasoning: "Example reasoning",
				tool_trace: "Example tool_trace",
				transcript: "Example transcript",
			},
			limit: { kind: "Example kind", value: "Example value" },
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/envelopes/limit.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/envelopes/moa-parts.md",
		relPath: "moa/envelopes/moa-parts.md",
		bundled: asset177,
		scope: "feature:moa/envelopes/moa-parts",
		group: "core",
		keys: [
			{
				path: "mixture",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "member_count", type: "number", required: true, resolution: "session-dependent" },
					{
						path: "members",
						type: "object[]",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "id", type: "string", required: true, resolution: "session-dependent" },
							{ path: "description", type: "string", required: false, resolution: "session-dependent" },
							{ path: "model", type: "string", required: true, resolution: "session-dependent" },
						],
					},
				],
			},
			{ path: "topic", type: "string", required: true, resolution: "session-dependent" },
			{ path: "conversation", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "from",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "to",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "edge",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "traversal", type: "number", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "hop", type: "number", required: true, resolution: "session-dependent" },
			{
				path: "x",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "output", type: "string", required: false, resolution: "session-dependent" },
					{ path: "input", type: "string", required: false, resolution: "session-dependent" },
					{ path: "reasoning", type: "string", required: false, resolution: "session-dependent" },
					{ path: "tool_trace", type: "string", required: false, resolution: "session-dependent" },
					{ path: "transcript", type: "string", required: false, resolution: "session-dependent" },
				],
			},
			{
				path: "limit",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
					{ path: "value", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			mixture: {
				name: "Example name",
				member_count: 2,
				members: [{ id: "example-1", description: "Example description", model: "Example model" }],
			},
			topic: "Example topic",
			conversation: "Example conversation",
			from: { id: "example-1", description: "Example description", model: "Example model" },
			to: { id: "example-1", description: "Example description", model: "Example model" },
			edge: { id: "example-1", traversal: 2 },
			hop: 2,
			x: {
				output: "Example output",
				input: "Example input",
				reasoning: "Example reasoning",
				tool_trace: "Example tool_trace",
				transcript: "Example transcript",
			},
			limit: { kind: "Example kind", value: "Example value" },
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/envelopes/moa-parts.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/notices/limit.md",
		relPath: "moa/notices/limit.md",
		bundled: asset178,
		scope: "feature:moa/notices/limit",
		group: "core",
		keys: [
			{ path: "mixture", type: "string", resolution: "session-dependent" },
			{ path: "hops", type: "string", resolution: "session-dependent" },
			{ path: "reason", type: "string", resolution: "session-dependent" },
			{ path: "output", type: "string", resolution: "session-dependent" },
			{ path: "member", type: "string", resolution: "session-dependent" },
		],
		fixture: {
			mixture: "Example mixture",
			hops: "Example hops",
			reason: "Example reason",
			output: "Example output",
			member: "Example member",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/notices/limit.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/notices/pause.md",
		relPath: "moa/notices/pause.md",
		bundled: asset179,
		scope: "feature:moa/notices/pause",
		group: "core",
		keys: [
			{ path: "mixture", type: "string", resolution: "session-dependent" },
			{ path: "member", type: "string", resolution: "session-dependent" },
			{ path: "hops", type: "string", resolution: "session-dependent" },
			{ path: "usd", type: "string", resolution: "session-dependent" },
			{ path: "reason", type: "string", resolution: "session-dependent" },
		],
		fixture: {
			mixture: "Example mixture",
			member: "Example member",
			hops: "Example hops",
			usd: "Example usd",
			reason: "Example reason",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/notices/pause.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/roles/defense.md",
		relPath: "moa/roles/defense.md",
		bundled: asset180,
		scope: "feature:moa/roles/defense",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/roles/defense.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/roles/judge.md",
		relPath: "moa/roles/judge.md",
		bundled: asset181,
		scope: "feature:moa/roles/judge",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/roles/judge.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/roles/prosecution.md",
		relPath: "moa/roles/prosecution.md",
		bundled: asset182,
		scope: "feature:moa/roles/prosecution",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/roles/prosecution.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/tool-trace.md",
		relPath: "moa/tool-trace.md",
		bundled: asset183,
		scope: "feature:moa/tool-trace",
		group: "core",
		keys: [
			{
				path: "calls",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string" },
					{ path: "summary", type: "string" },
				],
			},
		],
		fixture: { calls: [{ name: "Example name", summary: "Example summary" }] },
		consumerHints: [
			"packages/coding-agent/src/prompts/moa/tool-trace.md",
			"packages/coding-agent/src/moa/envelopes.ts",
		],
	},
	{
		id: "moa/verdict.md",
		relPath: "moa/verdict.md",
		bundled: asset184,
		scope: "feature:moa/verdict",
		group: "core",
		keys: [
			{
				path: "member",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: false, resolution: "session-dependent" },
				],
			},
			{
				path: "question",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "type", type: "string", required: true, resolution: "session-dependent" },
					{ path: "instructions", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "answer",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "choice", type: "string", required: false, resolution: "session-dependent" },
					{ path: "score", type: "string", required: false, resolution: "session-dependent" },
					{ path: "noul", type: "string", required: false, resolution: "session-dependent" },
				],
			},
			{ path: "confidence", type: "string", required: false, resolution: "session-dependent" },
			{ path: "judge", type: "string", required: true, resolution: "session-dependent" },
			{ path: "judgeKind", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			member: { id: "example-1", description: "Example description" },
			question: { type: "Example type", instructions: "Example instructions" },
			answer: { choice: "Example choice", score: "Example score", noul: "Example noul" },
			confidence: "Example confidence",
			judge: "Example judge",
			judgeKind: "Example judgeKind",
		},
		consumerHints: ["packages/coding-agent/src/prompts/moa/verdict.md", "packages/coding-agent/src/moa/envelopes.ts"],
	},
	{
		id: "npi-update.md",
		relPath: "npi-update.md",
		bundled: asset185,
		scope: "feature:npi-update",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/npi-update.md", "packages/coding-agent/src/cli/npi-update.ts"],
	},
	{
		id: "ratchet-kickoff.md",
		relPath: "ratchet-kickoff.md",
		bundled: asset186,
		scope: "feature:ratchet-kickoff",
		group: "core",
		keys: [
			{ path: "request", type: "string", required: true, resolution: "session-dependent" },
			{ path: "tools", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { request: "Example request", tools: "Example tools" },
		consumerHints: [
			"packages/coding-agent/src/prompts/ratchet-kickoff.md",
			"packages/coding-agent/src/slash-commands/builtin-modes.ts",
		],
	},
	{
		id: "review-custom-request.md",
		relPath: "review-custom-request.md",
		bundled: asset187,
		scope: "feature:review-custom-request",
		group: "core",
		keys: [{ path: "instructions", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { instructions: "Example instructions" },
		consumerHints: [
			"packages/coding-agent/src/prompts/review-custom-request.md",
			"packages/coding-agent/src/extensibility/custom-commands/bundled/review/index.ts",
		],
	},
	{
		id: "review-headless-request.md",
		relPath: "review-headless-request.md",
		bundled: asset188,
		scope: "feature:review-headless-request",
		group: "core",
		keys: [{ path: "focus", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { focus: "Example focus" },
		consumerHints: [
			"packages/coding-agent/src/prompts/review-headless-request.md",
			"packages/coding-agent/src/extensibility/custom-commands/bundled/review/index.ts",
		],
	},
	{
		id: "review-request.md",
		relPath: "review-request.md",
		bundled: asset189,
		scope: "feature:review-request",
		group: "core",
		keys: [
			{ path: "mode", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "files",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "path", type: "string" },
					{ path: "linesAdded", type: "string" },
					{ path: "linesRemoved", type: "string" },
					{ path: "ext", type: "string" },
					{ path: "hunksPreview", type: "string" },
				],
			},
			{
				path: "excluded",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "path", type: "string" },
					{ path: "linesAdded", type: "string" },
					{ path: "linesRemoved", type: "string" },
					{ path: "reason", type: "string" },
				],
			},
			{ path: "totalAdded", type: "string", required: true, resolution: "session-dependent" },
			{ path: "totalRemoved", type: "string", required: true, resolution: "session-dependent" },
			{ path: "agentCount", type: "string", required: true, resolution: "session-dependent" },
			{ path: "multiAgent", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "skipDiff", type: "string", required: true, resolution: "session-dependent" },
			{ path: "linesPerFile", type: "string", required: true, resolution: "session-dependent" },
			{ path: "rawDiff", type: "string", required: true, resolution: "session-dependent" },
			{ path: "diffInstruction", type: "string", required: true, resolution: "session-dependent" },
			{ path: "contextInstruction", type: "string", required: true, resolution: "session-dependent" },
			{ path: "suppliedPatch", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "additionalInstructions", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			mode: "Example mode",
			files: [
				{
					path: "/workspace/example",
					linesAdded: "Example linesAdded",
					linesRemoved: "Example linesRemoved",
					ext: "Example ext",
					hunksPreview: "Example hunksPreview",
				},
			],
			excluded: [
				{
					path: "/workspace/example",
					linesAdded: "Example linesAdded",
					linesRemoved: "Example linesRemoved",
					reason: "Example reason",
				},
			],
			totalAdded: "Example totalAdded",
			totalRemoved: "Example totalRemoved",
			agentCount: "Example agentCount",
			multiAgent: true,
			skipDiff: "Example skipDiff",
			linesPerFile: "Example linesPerFile",
			rawDiff: "Example rawDiff",
			diffInstruction: "Example diffInstruction",
			contextInstruction: "Example contextInstruction",
			suppliedPatch: true,
			additionalInstructions: "Example additionalInstructions",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/review-request.md",
			"packages/coding-agent/src/extensibility/custom-commands/bundled/review/prompt.ts",
		],
	},
	{
		id: "security/scan-coordinator.md",
		relPath: "security/scan-coordinator.md",
		bundled: asset190,
		scope: "feature:security/scan-coordinator",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/security/scan-coordinator.md",
			"packages/coding-agent/src/security/coordinator.ts",
		],
	},
	{
		id: "security/scan-request.md",
		relPath: "security/scan-request.md",
		bundled: asset191,
		scope: "feature:security/scan-request",
		group: "core",
		keys: [
			{ path: "repositoryRoot", type: "string", required: true, resolution: "session-dependent" },
			{ path: "targetKind", type: "string", required: true, resolution: "session-dependent" },
			{ path: "revision", type: "string", required: true, resolution: "session-dependent" },
			{ path: "baseRevision", type: "string", required: true, resolution: "session-dependent" },
			{ path: "headRevision", type: "string", required: true, resolution: "session-dependent" },
			{ path: "includePaths", type: "string", required: true, resolution: "session-dependent" },
			{ path: "excludePaths", type: "string", required: true, resolution: "session-dependent" },
			{ path: "knowledgeBases", type: "string", required: true, resolution: "session-dependent" },
			{ path: "planFingerprint", type: "string", required: true, resolution: "session-dependent" },
			{ path: "diffText", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			repositoryRoot: "/workspace/example",
			targetKind: "Example targetKind",
			revision: "Example revision",
			baseRevision: "Example baseRevision",
			headRevision: "Example headRevision",
			includePaths: "/workspace/example",
			excludePaths: "/workspace/example",
			knowledgeBases: "Example knowledgeBases",
			planFingerprint: "Example planFingerprint",
			diffText: "Example diffText",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/security/scan-request.md",
			"packages/coding-agent/src/security/coordinator.ts",
		],
	},
	{
		id: "security/validate-request.md",
		relPath: "security/validate-request.md",
		bundled: asset192,
		scope: "feature:security/validate-request",
		group: "core",
		keys: [
			{ path: "findingUri", type: "string", required: true, resolution: "session-dependent" },
			{ path: "scanId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "findingId", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { findingUri: "Example findingUri", scanId: "example-1", findingId: "example-1" },
		consumerHints: [
			"packages/coding-agent/src/prompts/security/validate-request.md",
			"packages/coding-agent/src/slash-commands/helpers/security.ts",
		],
	},
	{
		id: "session/launch-completion.md",
		relPath: "session/launch-completion.md",
		bundled: asset193,
		scope: "feature:session/launch-completion",
		group: "core",
		keys: [
			{ path: "name", type: "string", required: true, resolution: "session-dependent" },
			{ path: "state", type: "string", required: true, resolution: "session-dependent" },
			{ path: "exitCode", type: "string", required: true, resolution: "session-dependent" },
			{ path: "hasExitCode", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { name: "Example name", state: "Example state", exitCode: "Example exitCode", hasExitCode: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/session/launch-completion.md",
			"packages/coding-agent/src/session/launch-completion.ts",
		],
	},
	{
		id: "session/transfer-arrived.md",
		relPath: "session/transfer-arrived.md",
		bundled: asset194,
		scope: "feature:session/transfer-arrived",
		group: "core",
		keys: [
			{ path: "fromCwd", type: "string", required: true, resolution: "session-dependent" },
			{ path: "cwd", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { fromCwd: "/workspace/example", cwd: "/workspace/example" },
		consumerHints: [
			"packages/coding-agent/src/prompts/session/transfer-arrived.md",
			"packages/coding-agent/src/session/session-transfer.ts",
		],
	},
	{
		id: "session/transfer-departed.md",
		relPath: "session/transfer-departed.md",
		bundled: asset195,
		scope: "feature:session/transfer-departed",
		group: "core",
		keys: [{ path: "to", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { to: "Example to" },
		consumerHints: [
			"packages/coding-agent/src/prompts/session/transfer-departed.md",
			"packages/coding-agent/src/session/session-transfer.ts",
		],
	},
	{
		id: "session/transfer-stale-fork.md",
		relPath: "session/transfer-stale-fork.md",
		bundled: asset196,
		scope: "feature:session/transfer-stale-fork",
		group: "core",
		keys: [
			{ path: "to", type: "string", required: true, resolution: "session-dependent" },
			{ path: "source", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { to: "Example to", source: "Example source" },
		consumerHints: [
			"packages/coding-agent/src/prompts/session/transfer-stale-fork.md",
			"packages/coding-agent/src/session/session-transfer.ts",
		],
	},
	{
		id: "skills/autoload.md",
		relPath: "skills/autoload.md",
		bundled: asset197,
		scope: "feature:skills/autoload",
		group: "core",
		keys: [
			{ path: "body", type: "string", required: true, resolution: "session-dependent" },
			{ path: "filePath", type: "string", required: true, resolution: "session-dependent" },
			{ path: "userArgs", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { body: "Example body", filePath: "/workspace/example", userArgs: "Example userArgs" },
		consumerHints: [
			"packages/coding-agent/src/prompts/skills/autoload.md",
			"packages/coding-agent/src/extensibility/skills.ts",
		],
	},
	{
		id: "skills/compress-description.md",
		relPath: "skills/compress-description.md",
		bundled: asset198,
		scope: "feature:skills/compress-description",
		group: "core",
		keys: [
			{ path: "name", type: "string", required: true, resolution: "session-dependent" },
			{ path: "description", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { name: "Example name", description: "Example description" },
		consumerHints: [
			"packages/coding-agent/src/prompts/skills/compress-description.md",
			"packages/coding-agent/src/extensibility/skill-descriptions.ts",
		],
	},
	{
		id: "skills/user-invocation.md",
		relPath: "skills/user-invocation.md",
		bundled: asset199,
		scope: "feature:skills/user-invocation",
		group: "core",
		keys: [
			{ path: "name", type: "string", required: true, resolution: "session-dependent" },
			{ path: "body", type: "string", required: true, resolution: "session-dependent" },
			{ path: "baseDir", type: "string", required: true, resolution: "session-dependent" },
			{ path: "userArgs", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			name: "Example name",
			body: "Example body",
			baseDir: "/workspace/example",
			userArgs: "Example userArgs",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/skills/user-invocation.md",
			"packages/coding-agent/src/extensibility/skills.ts",
		],
	},
	{
		id: "steering/parent-irc.md",
		relPath: "steering/parent-irc.md",
		bundled: asset200,
		scope: "feature:steering/parent-irc",
		group: "core",
		keys: [
			{ path: "from", type: "string", required: true, resolution: "session-dependent" },
			{ path: "message", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { from: "Example from", message: "Example message" },
		consumerHints: [
			"packages/coding-agent/src/prompts/steering/parent-irc.md",
			"packages/coding-agent/src/session/irc-bridge.ts",
		],
	},
	{
		id: "steering/user-interjection.md",
		relPath: "steering/user-interjection.md",
		bundled: asset201,
		scope: "feature:steering/user-interjection",
		group: "core",
		keys: [{ path: "message", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { message: "Example message" },
		consumerHints: [
			"packages/coding-agent/src/prompts/steering/user-interjection.md",
			"packages/coding-agent/src/session/messages.ts",
		],
	},
	{
		id: "system/active-repo-context.md",
		relPath: "system/active-repo-context.md",
		bundled: asset202,
		scope: "feature:system/active-repo-context",
		group: "core",
		keys: [{ path: "relativeRepoRoot", type: "string", resolution: "session-dependent" }],
		fixture: { relativeRepoRoot: "/workspace/example" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/active-repo-context.md",
			"packages/coding-agent/src/system-prompt.ts",
		],
	},
	{
		id: "system/agent-creation-architect.md",
		relPath: "system/agent-creation-architect.md",
		bundled: asset203,
		scope: "feature:system/agent-creation-architect",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/agent-creation-architect.md",
			"packages/coding-agent/src/modes/agents-hub-deps.ts",
		],
	},
	{
		id: "system/agent-creation-user.md",
		relPath: "system/agent-creation-user.md",
		bundled: asset204,
		scope: "feature:system/agent-creation-user",
		group: "core",
		keys: [{ path: "request", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { request: "Example request" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/agent-creation-user.md",
			"packages/coding-agent/src/modes/agents-hub-deps.ts",
		],
	},
	{
		id: "system/agent-telemetry.md",
		relPath: "system/agent-telemetry.md",
		bundled: asset205,
		scope: "feature:system/agent-telemetry",
		group: "core",
		keys: [{ path: "json", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { json: "{}" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/agent-telemetry.md",
			"packages/coding-agent/src/session/usage-notices.ts",
			"packages/coding-agent/src/session/agent-telemetry.ts",
		],
	},
	{
		id: "system/anthropic-usage-wrap-up.md",
		relPath: "system/anthropic-usage-wrap-up.md",
		bundled: asset206,
		scope: "feature:system/anthropic-usage-wrap-up",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/anthropic-usage-wrap-up.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/auto-continue.md",
		relPath: "system/auto-continue.md",
		bundled: asset207,
		scope: "feature:system/auto-continue",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/auto-continue.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/auto-thinking-effort-context.md",
		relPath: "system/auto-thinking-effort-context.md",
		bundled: asset208,
		scope: "feature:system/auto-thinking-effort-context",
		group: "core",
		keys: [
			{
				path: "diary",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "title", type: "string", required: false, resolution: "session-dependent" },
					{ path: "body", type: "string", required: true, resolution: "session-dependent" },
					{ path: "carry", type: "boolean", required: false, resolution: "session-dependent" },
				],
			},
			{ path: "history", type: "string", required: true, resolution: "session-dependent" },
			{ path: "request", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			diary: [{ title: "Example title", body: "Example body", carry: true }],
			history: "Example history",
			request: "Example request",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/auto-thinking-effort-context.md",
			"packages/coding-agent/src/auto-thinking/context.ts",
		],
	},
	{
		id: "system/auto-thinking-effort-question.md",
		relPath: "system/auto-thinking-effort-question.md",
		bundled: asset209,
		scope: "feature:system/auto-thinking-effort-question",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/auto-thinking-effort-question.md",
			"packages/coding-agent/src/auto-thinking/classifier.ts",
		],
	},
	{
		id: "system/auto-thinking-minimal-criterion.md",
		relPath: "system/auto-thinking-minimal-criterion.md",
		bundled: asset210,
		scope: "feature:system/auto-thinking-minimal-criterion",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/auto-thinking-minimal-criterion.md",
			"packages/coding-agent/src/auto-thinking/classifier.ts",
		],
	},
	{
		id: "system/autolearn-guidance-learn.md",
		relPath: "system/autolearn-guidance-learn.md",
		bundled: asset211,
		scope: "feature:system/autolearn-guidance-learn",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/autolearn-guidance-learn.md",
			"packages/coding-agent/src/autolearn/controller.ts",
		],
	},
	{
		id: "system/autolearn-guidance.md",
		relPath: "system/autolearn-guidance.md",
		bundled: asset212,
		scope: "feature:system/autolearn-guidance",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/autolearn-guidance.md",
			"packages/coding-agent/src/autolearn/controller.ts",
		],
	},
	{
		id: "system/autolearn-nudge-autocontinue.md",
		relPath: "system/autolearn-nudge-autocontinue.md",
		bundled: asset213,
		scope: "feature:system/autolearn-nudge-autocontinue",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/autolearn-nudge-autocontinue.md",
			"packages/coding-agent/src/autolearn/controller.ts",
		],
	},
	{
		id: "system/background-tan-dispatch.md",
		relPath: "system/background-tan-dispatch.md",
		bundled: asset214,
		scope: "feature:system/background-tan-dispatch",
		group: "core",
		keys: [
			{ path: "jobId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "work", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { jobId: "example-1", work: "Example work" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/background-tan-dispatch.md",
			"packages/coding-agent/src/modes/controllers/tan-command-controller.ts",
		],
	},
	{
		id: "system/btw-user.md",
		relPath: "system/btw-user.md",
		bundled: asset215,
		scope: "feature:system/btw-user",
		group: "core",
		keys: [{ path: "question", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { question: "Example question" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/btw-user.md",
			"packages/coding-agent/src/session/btw-turn.ts",
		],
	},
	{
		id: "system/checkpoint-active-notice.md",
		relPath: "system/checkpoint-active-notice.md",
		bundled: asset216,
		scope: "feature:system/checkpoint-active-notice",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/checkpoint-active-notice.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/commit-message-system.md",
		relPath: "system/commit-message-system.md",
		bundled: asset217,
		scope: "feature:system/commit-message-system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/commit-message-system.md",
			"packages/coding-agent/src/utils/commit-message-generator.ts",
		],
	},
	{
		id: "system/composer-prediction-user.md",
		relPath: "system/composer-prediction-user.md",
		bundled: asset218,
		scope: "feature:system/composer-prediction-user",
		group: "core",
		keys: [{ path: "skip", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { skip: "Example skip" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/composer-prediction-user.md",
			"packages/coding-agent/src/modes/controllers/composer-prediction-controller.ts",
		],
	},
	{
		id: "system/computer-use.md",
		relPath: "system/computer-use.md",
		bundled: asset219,
		scope: "feature:system/computer-use",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/computer-use.md",
			"packages/coding-agent/src/tools/computer.ts",
		],
	},
	{
		id: "system/context-notes.md",
		relPath: "system/context-notes.md",
		bundled: asset220,
		scope: "feature:system/context-notes",
		group: "core",
		keys: [{ path: "notes", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { notes: "Example notes" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/context-notes.md",
			"packages/coding-agent/src/session/context-notes.ts",
		],
	},
	{
		id: "system/custom-system-prompt.md",
		relPath: "system/custom-system-prompt.md",
		bundled: asset221,
		scope: "system",
		group: "core",
		keys: describePromptContext(systemPromptContextFixture),
		fixture: systemPromptContextFixture,
		consumerHints: [
			"packages/coding-agent/src/prompts/system/custom-system-prompt.md",
			"packages/coding-agent/src/system-prompt.ts",
		],
	},
	{
		id: "system/date-cwd-reminder.md",
		relPath: "system/date-cwd-reminder.md",
		bundled: asset222,
		scope: "feature:system/date-cwd-reminder",
		group: "core",
		keys: [
			{ path: "date", type: "string", required: true, resolution: "session-dependent" },
			{ path: "cwd", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { date: "Example date", cwd: "/workspace/example" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/date-cwd-reminder.md",
			"packages/coding-agent/src/session/date-cwd-reminder.ts",
		],
	},
	{
		id: "system/eager-task.md",
		relPath: "system/eager-task.md",
		bundled: asset223,
		scope: "feature:system/eager-task",
		group: "core",
		keys: [
			{
				path: "toolRefs",
				type: "object",
				children: [{ path: "task", type: "string" }],
				resolution: "session-dependent",
			},
			{ path: "taskBatch", type: "string", resolution: "session-dependent" },
		],
		fixture: { toolRefs: { task: "Example task" }, taskBatch: "Example taskBatch" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/eager-task.md",
			"packages/coding-agent/src/session/todo-tracker.ts",
		],
	},
	{
		id: "system/eager-todo.md",
		relPath: "system/eager-todo.md",
		bundled: asset224,
		scope: "feature:system/eager-todo",
		group: "core",
		keys: [
			{ path: "...this.#buildEagerPreludeContext()", type: "spread", resolution: "session-dependent" },
			{ path: "forced", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "toolRefs",
				type: "object",
				children: [{ path: "todo", type: "string" }],
				resolution: "session-dependent",
			},
		],
		fixture: {
			"...this.#buildEagerPreludeContext()": "Example ...this.#buildEagerPreludeContext()",
			forced: true,
			toolRefs: { todo: "Example todo" },
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/eager-todo.md",
			"packages/coding-agent/src/session/todo-tracker.ts",
		],
	},
	{
		id: "system/empty-stop-retry.md",
		relPath: "system/empty-stop-retry.md",
		bundled: asset225,
		scope: "feature:system/empty-stop-retry",
		group: "core",
		keys: [
			{ path: "retryCount", type: "string", required: true, resolution: "session-dependent" },
			{ path: "maxRetries", type: "number", required: true, resolution: "session-dependent" },
		],
		fixture: { retryCount: "Example retryCount", maxRetries: 2 },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/empty-stop-retry.md",
			"packages/coding-agent/src/session/turn-recovery.ts",
		],
	},
	{
		id: "system/eval-prelude-notice.md",
		relPath: "system/eval-prelude-notice.md",
		bundled: asset226,
		scope: "feature:system/eval-prelude-notice",
		group: "core",
		keys: [
			{
				path: "added",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "summary", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "removed", type: "unknown[]", required: true, resolution: "session-dependent" },
			{ path: "canRead", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "sections", type: "unknown[]", required: true, resolution: "session-dependent" },
		],
		fixture: {
			added: [{ name: "Example name", summary: "Example summary" }],
			removed: ["example"],
			canRead: true,
			sections: ["example"],
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/eval-prelude-notice.md",
			"packages/coding-agent/src/session/session-tools.ts",
		],
	},
	{
		id: "system/eval-state-context.md",
		relPath: "system/eval-state-context.md",
		bundled: asset227,
		scope: "feature:system/eval-state-context",
		group: "core",
		keys: [{ path: "stateSummary", type: "string", required: false, resolution: "session-dependent" }],
		fixture: { stateSummary: "Example stateSummary" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/eval-state-context.md",
			"packages/coding-agent/src/eval/state.ts",
		],
	},
	{
		id: "system/experimental-context-notes-reminder.md",
		relPath: "system/experimental-context-notes-reminder.md",
		bundled: asset228,
		scope: "feature:system/experimental-context-notes-reminder",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/experimental-context-notes-reminder.md",
			"packages/coding-agent/src/session/session-maintenance.ts",
		],
	},
	{
		id: "system/experimental-context-rollover.md",
		relPath: "system/experimental-context-rollover.md",
		bundled: asset229,
		scope: "feature:system/experimental-context-rollover",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/experimental-context-rollover.md",
			"packages/coding-agent/src/session/session-maintenance.ts",
		],
	},
	{
		id: "system/gemini-tool-call-reminder.md",
		relPath: "system/gemini-tool-call-reminder.md",
		bundled: asset230,
		scope: "feature:system/gemini-tool-call-reminder",
		group: "core",
		keys: [{ path: "count", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { count: "Example count" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/gemini-tool-call-reminder.md",
			"packages/coding-agent/src/session/stream-guards.ts",
		],
	},
	{
		id: "system/hindsight-instructions.md",
		relPath: "system/hindsight-instructions.md",
		bundled: asset231,
		scope: "feature:system/hindsight-instructions",
		group: "core",
		keys: [
			{
				path: "toolRefs",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "recall", type: "string" },
					{ path: "retain", type: "string" },
					{ path: "reflect", type: "string" },
				],
			},
		],
		fixture: { toolRefs: { recall: "Example recall", retain: "Example retain", reflect: "Example reflect" } },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/hindsight-instructions.md",
			"packages/coding-agent/src/hindsight/backend.ts",
		],
	},
	{
		id: "system/image-attachment.md",
		relPath: "system/image-attachment.md",
		bundled: asset232,
		scope: "feature:system/image-attachment",
		group: "core",
		keys: [
			{ path: "index", type: "string", required: true, resolution: "session-dependent" },
			{ path: "path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "askAnswer", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { index: "Example index", path: "/workspace/example", askAnswer: "Example askAnswer" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/image-attachment.md",
			"packages/coding-agent/src/session/attachment-source-notice.ts",
		],
	},
	{
		id: "system/interrupted-thinking.md",
		relPath: "system/interrupted-thinking.md",
		bundled: asset233,
		scope: "feature:system/interrupted-thinking",
		group: "core",
		keys: [{ path: "reasoning", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { reasoning: "Example reasoning" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/interrupted-thinking.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/irc-incoming.md",
		relPath: "system/irc-incoming.md",
		bundled: asset234,
		scope: "feature:system/irc-incoming",
		group: "core",
		keys: [
			{ path: "from", type: "string", required: true, resolution: "session-dependent" },
			{ path: "message", type: "string", required: true, resolution: "session-dependent" },
			{ path: "replyTo", type: "string", required: true, resolution: "session-dependent" },
			{ path: "interrupting", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "relayOnStop", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			from: "Example from",
			message: "Example message",
			replyTo: "Example replyTo",
			interrupting: true,
			relayOnStop: "Example relayOnStop",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/irc-incoming.md",
			"packages/coding-agent/src/session/irc-bridge.ts",
		],
	},
	{
		id: "system/jevify-notice.md",
		relPath: "system/jevify-notice.md",
		bundled: asset235,
		scope: "feature:system/jevify-notice",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/jevify-notice.md",
			"packages/coding-agent/src/modes/magic-keywords.ts",
		],
	},
	{
		id: "system/judgment-local.md",
		relPath: "system/judgment-local.md",
		bundled: asset236,
		scope: "feature:system/judgment-local",
		group: "core",
		keys: [
			{ path: "system", type: "string", required: true, resolution: "session-dependent" },
			{ path: "state", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { system: "Example system", state: "Example state" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/judgment-local.md",
			"packages/coding-agent/src/judgment/index.ts",
		],
	},
	{
		id: "system/length-stop-retry.md",
		relPath: "system/length-stop-retry.md",
		bundled: asset237,
		scope: "feature:system/length-stop-retry",
		group: "core",
		keys: [
			{ path: "outputTokens", type: "string", required: true, resolution: "session-dependent" },
			{ path: "retryCount", type: "string", required: true, resolution: "session-dependent" },
			{ path: "maxRetries", type: "number", required: true, resolution: "session-dependent" },
		],
		fixture: { outputTokens: "Example outputTokens", retryCount: "Example retryCount", maxRetries: 2 },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/length-stop-retry.md",
			"packages/coding-agent/src/session/session-maintenance.ts",
		],
	},
	{
		id: "system/malformed-function-call-retry.md",
		relPath: "system/malformed-function-call-retry.md",
		bundled: asset238,
		scope: "feature:system/malformed-function-call-retry",
		group: "core",
		keys: [
			{ path: "retryCount", type: "string", required: true, resolution: "session-dependent" },
			{ path: "maxRetries", type: "number", required: true, resolution: "session-dependent" },
		],
		fixture: { retryCount: "Example retryCount", maxRetries: 2 },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/malformed-function-call-retry.md",
			"packages/coding-agent/src/session/turn-recovery.ts",
		],
	},
	{
		id: "system/manual-continue.md",
		relPath: "system/manual-continue.md",
		bundled: asset239,
		scope: "feature:system/manual-continue",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/manual-continue.md",
			"packages/coding-agent/src/modes/controllers/input-controller.ts",
		],
	},
	{
		id: "system/mcp-xdev-guidance.md",
		relPath: "system/mcp-xdev-guidance.md",
		bundled: asset240,
		scope: "feature:system/mcp-xdev-guidance",
		group: "core",
		keys: [
			{
				path: "tools",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "mcpToolName", type: "string", required: true, resolution: "session-dependent" },
					{ path: "path", type: "string", required: true, resolution: "session-dependent" },
					{ path: "summary", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "hasCatalogOnlyTools", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "hasOmittedTools", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			tools: [{ mcpToolName: "Example mcpToolName", path: "/workspace/example", summary: "Example summary" }],
			hasCatalogOnlyTools: true,
			hasOmittedTools: "Example hasOmittedTools",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/mcp-xdev-guidance.md",
			"packages/coding-agent/src/sdk.ts",
		],
	},
	{
		id: "system/memory-consolidation-system.md",
		relPath: "system/memory-consolidation-system.md",
		bundled: asset241,
		scope: "feature:system/memory-consolidation-system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/memory-consolidation-system.md",
			"packages/coding-agent/src/mnemopi/backend.ts",
		],
	},
	{
		id: "system/memory-extraction-system.md",
		relPath: "system/memory-extraction-system.md",
		bundled: asset242,
		scope: "feature:system/memory-extraction-system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/memory-extraction-system.md",
			"packages/coding-agent/src/mnemopi/backend.ts",
		],
	},
	{
		id: "system/memory-recall-changes.md",
		relPath: "system/memory-recall-changes.md",
		bundled: asset243,
		scope: "feature:system/memory-recall-changes",
		group: "core",
		keys: [
			{ path: "removed", type: "unknown[]", required: true, resolution: "session-dependent" },
			{
				path: "updated",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "before", type: "string" },
					{ path: "after", type: "string" },
				],
			},
		],
		fixture: { removed: ["example"], updated: [{ before: "Example before", after: "Example after" }] },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/memory-recall-changes.md",
			"packages/coding-agent/src/mnemopi/state.ts",
		],
	},
	{
		id: "system/mid-run-todo-nudge.md",
		relPath: "system/mid-run-todo-nudge.md",
		bundled: asset244,
		scope: "feature:system/mid-run-todo-nudge",
		group: "core",
		keys: [
			{
				path: "toolRefs",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [{ path: "todo", type: "string" }],
			},
			{ path: "incompleteCount", type: "string", required: true, resolution: "session-dependent" },
			{ path: "plural", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { toolRefs: { todo: "Example todo" }, incompleteCount: "Example incompleteCount", plural: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/mid-run-todo-nudge.md",
			"packages/coding-agent/src/session/todo-tracker.ts",
		],
	},
	{
		id: "system/mnemopi-instructions.md",
		relPath: "system/mnemopi-instructions.md",
		bundled: asset245,
		scope: "feature:system/mnemopi-instructions",
		group: "core",
		keys: [
			{
				path: "toolRefs",
				type: "object",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "recall", type: "string" },
					{ path: "retain", type: "string" },
					{ path: "reflect", type: "string" },
				],
			},
		],
		fixture: { toolRefs: { recall: "Example recall", retain: "Example retain", reflect: "Example reflect" } },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/mnemopi-instructions.md",
			"packages/coding-agent/src/mnemopi/backend.ts",
			"packages/coding-agent/src/mnemopi/state.ts",
		],
	},
	{
		id: "system/omfg-user.md",
		relPath: "system/omfg-user.md",
		bundled: asset246,
		scope: "feature:system/omfg-user",
		group: "core",
		keys: [
			{ path: "complaint", type: "string", required: true, resolution: "session-dependent" },
			{ path: "feedback", type: "string", required: true, resolution: "session-dependent" },
			{ path: "previousRule", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { complaint: "Example complaint", feedback: "Example feedback", previousRule: "Example previousRule" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/omfg-user.md",
			"packages/coding-agent/src/modes/controllers/omfg-controller.ts",
		],
	},
	{
		id: "system/operator-notice.md",
		relPath: "system/operator-notice.md",
		bundled: asset247,
		scope: "feature:system/operator-notice",
		group: "core",
		keys: [{ path: "text", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { text: "Example text" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/operator-notice.md",
			"packages/coding-agent/src/slash-commands/builtin-neopi.ts",
		],
	},
	{
		id: "system/orchestrate-notice.md",
		relPath: "system/orchestrate-notice.md",
		bundled: asset248,
		scope: "feature:system/orchestrate-notice",
		group: "core",
		keys: [{ path: "tools", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { tools: "Example tools" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/orchestrate-notice.md",
			"packages/coding-agent/src/modes/magic-keywords.ts",
		],
	},
	{
		id: "system/personalities/default.md",
		relPath: "system/personalities/default.md",
		bundled: asset249,
		scope: "feature:system/personalities/default",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/personalities/default.md",
			"packages/coding-agent/src/system-prompt.ts",
		],
	},
	{
		id: "system/personalities/friendly.md",
		relPath: "system/personalities/friendly.md",
		bundled: asset250,
		scope: "feature:system/personalities/friendly",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/personalities/friendly.md",
			"packages/coding-agent/src/system-prompt.ts",
		],
	},
	{
		id: "system/personalities/pragmatic.md",
		relPath: "system/personalities/pragmatic.md",
		bundled: asset251,
		scope: "feature:system/personalities/pragmatic",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/personalities/pragmatic.md",
			"packages/coding-agent/src/system-prompt.ts",
		],
	},
	{
		id: "system/plan-filename.md",
		relPath: "system/plan-filename.md",
		bundled: asset252,
		scope: "feature:system/plan-filename",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-filename.md",
			"packages/coding-agent/src/modes/interactive-mode.ts",
		],
	},
	{
		id: "system/plan-mode-active.md",
		relPath: "system/plan-mode-active.md",
		bundled: asset253,
		scope: "feature:system/plan-mode-active",
		group: "core",
		keys: [
			{ path: "planFilePath", type: "string", required: true, resolution: "session-dependent" },
			{ path: "planExists", type: "string", required: true, resolution: "session-dependent" },
			{ path: "askToolName", type: "string", required: true, resolution: "session-dependent" },
			{ path: "writeToolName", type: "string", required: true, resolution: "session-dependent" },
			{ path: "editToolName", type: "string", required: true, resolution: "session-dependent" },
			{ path: "askAvailable", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "taskAvailable", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "isHashlineEditMode", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "reentry", type: "string", required: true, resolution: "session-dependent" },
			{ path: "iterative", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "scoutAvailable", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: {
			planFilePath: "/workspace/example",
			planExists: "Example planExists",
			askToolName: "Example askToolName",
			writeToolName: "Example writeToolName",
			editToolName: "Example editToolName",
			askAvailable: true,
			taskAvailable: true,
			isHashlineEditMode: true,
			reentry: "Example reentry",
			iterative: true,
			scoutAvailable: true,
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-mode-active.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/plan-mode-approved.md",
		relPath: "system/plan-mode-approved.md",
		bundled: asset254,
		scope: "feature:system/plan-mode-approved",
		group: "core",
		keys: [
			{ path: "planFilePath", type: "string", required: true, resolution: "session-dependent" },
			{ path: "planContent", type: "string", required: true, resolution: "session-dependent" },
			{ path: "contextPreserved", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "tools", type: "string", resolution: "session-dependent" },
		],
		fixture: {
			planFilePath: "/workspace/example",
			planContent: "Example planContent",
			contextPreserved: true,
			tools: "Example tools",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-mode-approved.md",
			"packages/coding-agent/src/modes/interactive-mode.ts",
		],
	},
	{
		id: "system/plan-mode-compact-instructions.md",
		relPath: "system/plan-mode-compact-instructions.md",
		bundled: asset255,
		scope: "feature:system/plan-mode-compact-instructions",
		group: "core",
		keys: [{ path: "planFilePath", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { planFilePath: "/workspace/example" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-mode-compact-instructions.md",
			"packages/coding-agent/src/modes/interactive-mode.ts",
		],
	},
	{
		id: "system/plan-mode-reference.md",
		relPath: "system/plan-mode-reference.md",
		bundled: asset256,
		scope: "feature:system/plan-mode-reference",
		group: "core",
		keys: [
			{ path: "planFilePath", type: "string", required: true, resolution: "session-dependent" },
			{ path: "planContent", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { planFilePath: "/workspace/example", planContent: "Example planContent" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-mode-reference.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/plan-mode-subagent.md",
		relPath: "system/plan-mode-subagent.md",
		bundled: asset257,
		scope: "feature:system/plan-mode-subagent",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-mode-subagent.md",
			"packages/coding-agent/src/task/structured-subagent.ts",
		],
	},
	{
		id: "system/plan-mode-tool-decision-reminder.md",
		relPath: "system/plan-mode-tool-decision-reminder.md",
		bundled: asset258,
		scope: "feature:system/plan-mode-tool-decision-reminder",
		group: "core",
		keys: [
			{ path: "askToolName", type: "string", required: true, resolution: "session-dependent" },
			{ path: "writeToolName", type: "string", resolution: "session-dependent" },
		],
		fixture: { askToolName: "Example askToolName", writeToolName: "Example writeToolName" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-mode-tool-decision-reminder.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/plan-proposal-approved.md",
		relPath: "system/plan-proposal-approved.md",
		bundled: asset259,
		scope: "feature:system/plan-proposal-approved",
		group: "core",
		keys: [
			{ path: "planFilePath", type: "string", required: true, resolution: "session-dependent" },
			{ path: "autosaveFailed", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { planFilePath: "/workspace/example", autosaveFailed: "Example autosaveFailed" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-proposal-approved.md",
			"packages/coding-agent/src/plan-mode/session-plan-mode.ts",
		],
	},
	{
		id: "system/plan-proposal-refine.md",
		relPath: "system/plan-proposal-refine.md",
		bundled: asset260,
		scope: "feature:system/plan-proposal-refine",
		group: "core",
		keys: [
			{ path: "title", type: "string", required: true, resolution: "session-dependent" },
			{ path: "feedback", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { title: "Example title", feedback: "Example feedback" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-proposal-refine.md",
			"packages/coding-agent/src/plan-mode/session-plan-mode.ts",
		],
	},
	{
		id: "system/plan-yolo-handoff.md",
		relPath: "system/plan-yolo-handoff.md",
		bundled: asset261,
		scope: "feature:system/plan-yolo-handoff",
		group: "core",
		keys: [
			{ path: "planFilePath", type: "string", required: true, resolution: "session-dependent" },
			{ path: "title", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { planFilePath: "/workspace/example", title: "Example title" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/plan-yolo-handoff.md",
			"packages/coding-agent/src/session/prewalk.ts",
		],
	},
	{
		id: "system/prewalk-checklist.md",
		relPath: "system/prewalk-checklist.md",
		bundled: asset262,
		scope: "feature:system/prewalk-checklist",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/prewalk-checklist.md",
			"packages/coding-agent/src/session/prewalk.ts",
		],
	},
	{
		id: "system/prewalk-continue.md",
		relPath: "system/prewalk-continue.md",
		bundled: asset263,
		scope: "feature:system/prewalk-continue",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/prewalk-continue.md",
			"packages/coding-agent/src/session/prewalk.ts",
		],
	},
	{
		id: "system/prewalk-handoff.md",
		relPath: "system/prewalk-handoff.md",
		bundled: asset264,
		scope: "feature:system/prewalk-handoff",
		group: "core",
		keys: [
			{ path: "plan", type: "string", required: true, resolution: "session-dependent" },
			{ path: "checklist", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { plan: "Example plan", checklist: "Example checklist" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/prewalk-handoff.md",
			"packages/coding-agent/src/session/prewalk.ts",
		],
	},
	{
		id: "system/prewalk-plan.md",
		relPath: "system/prewalk-plan.md",
		bundled: asset265,
		scope: "feature:system/prewalk-plan",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/prewalk-plan.md",
			"packages/coding-agent/src/session/prewalk.ts",
		],
	},
	{
		id: "system/project-prompt.md",
		relPath: "system/project-prompt.md",
		bundled: asset266,
		scope: "system",
		group: "core",
		keys: describePromptContext({
			...systemPromptContextFixture,
			activeRepoContext: "Active repository: /workspace",
		}),
		fixture: { ...systemPromptContextFixture, activeRepoContext: "Active repository: /workspace" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/project-prompt.md",
			"packages/coding-agent/src/system-prompt.ts",
		],
	},
	{
		id: "system/recap-user.md",
		relPath: "system/recap-user.md",
		bundled: asset267,
		scope: "feature:system/recap-user",
		group: "core",
		keys: [
			{ path: "goal", type: "string", required: true, resolution: "session-dependent" },
			{ path: "task", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { goal: "Example goal", task: "Example task" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/recap-user.md",
			"packages/coding-agent/src/modes/controllers/event-controller.ts",
		],
	},
	{
		id: "system/resolve-device-reminder.md",
		relPath: "system/resolve-device-reminder.md",
		bundled: asset268,
		scope: "feature:system/resolve-device-reminder",
		group: "core",
		keys: [{ path: "toolName", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { toolName: "Example toolName" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/resolve-device-reminder.md",
			"packages/coding-agent/src/tools/resolve.ts",
		],
	},
	{
		id: "system/rewind-report.md",
		relPath: "system/rewind-report.md",
		bundled: asset269,
		scope: "feature:system/rewind-report",
		group: "core",
		keys: [{ path: "report", type: "string", required: true, resolution: "session-dependent" }],
		fixture: { report: "Example report" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/rewind-report.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/session-agent-notice.md",
		relPath: "system/session-agent-notice.md",
		bundled: asset270,
		scope: "feature:system/session-agent-notice",
		group: "core",
		keys: [
			{
				path: "added",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "removed", type: "unknown[]", required: true, resolution: "session-dependent" },
		],
		fixture: { added: [{ name: "Example name", description: "Example description" }], removed: ["example"] },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/session-agent-notice.md",
			"packages/coding-agent/src/session/session-tools.ts",
		],
	},
	{
		id: "system/session-stop-blocked.md",
		relPath: "system/session-stop-blocked.md",
		bundled: asset271,
		scope: "feature:system/session-stop-blocked",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/session-stop-blocked.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/side-channel-no-tools.md",
		relPath: "system/side-channel-no-tools.md",
		bundled: asset272,
		scope: "feature:system/side-channel-no-tools",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/side-channel-no-tools.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/skillful-notice.md",
		relPath: "system/skillful-notice.md",
		bundled: asset273,
		scope: "feature:system/skillful-notice",
		group: "core",
		keys: [
			{
				path: "skills",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string" },
					{ path: "description", type: "string" },
				],
			},
		],
		fixture: { skills: [{ name: "Example name", description: "Example description" }] },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/skillful-notice.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/snapcompact-context-frames-note.md",
		relPath: "system/snapcompact-context-frames-note.md",
		bundled: asset274,
		scope: "feature:system/snapcompact-context-frames-note",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/snapcompact-context-frames-note.md",
			"packages/coding-agent/src/session/snapcompact-inline.ts",
		],
	},
	{
		id: "system/snapcompact-context-stub.md",
		relPath: "system/snapcompact-context-stub.md",
		bundled: asset275,
		scope: "feature:system/snapcompact-context-stub",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/snapcompact-context-stub.md",
			"packages/coding-agent/src/session/snapcompact-inline.ts",
		],
	},
	{
		id: "system/snapcompact-system-frames-note.md",
		relPath: "system/snapcompact-system-frames-note.md",
		bundled: asset276,
		scope: "feature:system/snapcompact-system-frames-note",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/snapcompact-system-frames-note.md",
			"packages/coding-agent/src/session/snapcompact-inline.ts",
		],
	},
	{
		id: "system/snapcompact-system-stub.md",
		relPath: "system/snapcompact-system-stub.md",
		bundled: asset277,
		scope: "feature:system/snapcompact-system-stub",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/snapcompact-system-stub.md",
			"packages/coding-agent/src/session/snapcompact-inline.ts",
		],
	},
	{
		id: "system/snapcompact-toolresult-note.md",
		relPath: "system/snapcompact-toolresult-note.md",
		bundled: asset278,
		scope: "feature:system/snapcompact-toolresult-note",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/snapcompact-toolresult-note.md",
			"packages/coding-agent/src/session/snapcompact-inline.ts",
		],
	},
	{
		id: "system/speech-rewrite.md",
		relPath: "system/speech-rewrite.md",
		bundled: asset279,
		scope: "feature:system/speech-rewrite",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/speech-rewrite.md",
			"packages/coding-agent/src/tts/speech-enhancer.ts",
		],
	},
	{
		id: "system/stream-stall-continue.md",
		relPath: "system/stream-stall-continue.md",
		bundled: asset280,
		scope: "feature:system/stream-stall-continue",
		group: "core",
		keys: [
			{ path: "retryCount", type: "string", required: true, resolution: "session-dependent" },
			{ path: "maxRetries", type: "number", required: true, resolution: "session-dependent" },
		],
		fixture: { retryCount: "Example retryCount", maxRetries: 2 },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/stream-stall-continue.md",
			"packages/coding-agent/src/session/turn-recovery.ts",
		],
	},
	{
		id: "system/subagent-async-pending.md",
		relPath: "system/subagent-async-pending.md",
		bundled: asset281,
		scope: "feature:system/subagent-async-pending",
		group: "core",
		keys: [
			{ path: "count", type: "number", required: true, resolution: "session-dependent" },
			{ path: "multiple", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "jobs", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { count: 2, multiple: true, jobs: "Example jobs" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/subagent-async-pending.md",
			"packages/coding-agent/src/task/executor.ts",
		],
	},
	{
		id: "system/subagent-completion-probe.md",
		relPath: "system/subagent-completion-probe.md",
		bundled: asset282,
		scope: "feature:system/subagent-completion-probe",
		group: "core",
		keys: [
			{
				path: "inflight",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "path", type: "string", required: false, resolution: "session-dependent" },
					{ path: "chars", type: "number", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "previous",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "percent", type: "number", required: true, resolution: "session-dependent" },
					{ path: "ago", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			inflight: [{ name: "Example name", path: "/workspace/example", chars: 2 }],
			previous: { percent: 2, ago: "Example ago" },
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/subagent-completion-probe.md",
			"packages/coding-agent/src/task/completion-probe.ts",
		],
	},
	{
		id: "system/subagent-system-prompt.md",
		relPath: "system/subagent-system-prompt.md",
		bundled: asset283,
		scope: "system-subagent",
		group: "core",
		keys: [
			{ path: "agent", type: "string", required: true, resolution: "session-dependent" },
			{ path: "context", type: "string", required: true, resolution: "session-dependent" },
			{ path: "planReference", type: "string", required: true, resolution: "session-dependent" },
			{ path: "planReferencePath", type: "string", required: true, resolution: "session-dependent" },
			{ path: "worktree", type: "string", required: true, resolution: "session-dependent" },
			{ path: "structured", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "outputSchema", type: "unknown", required: false, resolution: "runtime-only" },
			{ path: "outputSchemaOverridesAgent", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "workPoolYieldItems",
				type: "object[]",
				required: false,
				resolution: "runtime-only",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "index", type: "number", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "ircPeers",
				type: "object[]",
				required: false,
				resolution: "runtime-only",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "displayName", type: "string", required: true, resolution: "session-dependent" },
					{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
					{ path: "status", type: "string", required: true, resolution: "session-dependent" },
					{ path: "activity", type: "string", required: false, resolution: "session-dependent" },
					{ path: "resolvedModelIdentity", type: "string", required: false, resolution: "session-dependent" },
					{ path: "resolvedThinkingLevel", type: "string", required: false, resolution: "session-dependent" },
					{ path: "fastModeEnabled", type: "boolean", required: false, resolution: "session-dependent" },
					{ path: "fastModeActive", type: "boolean", required: false, resolution: "session-dependent" },
				],
			},
			{ path: "ircParkedCount", type: "number", required: true, resolution: "session-dependent" },
			{ path: "ircOmittedCount", type: "number", required: true, resolution: "session-dependent" },
			{ path: "ircSelfId", type: "string", required: false, resolution: "runtime-only" },
		],
		fixture: {
			agent: "Example agent",
			context: "Example context",
			planReference: "Example planReference",
			planReferencePath: "/workspace/example",
			worktree: "Example worktree",
			structured: true,
			outputSchema: { type: "object", properties: { answer: { type: "string" } } },
			outputSchemaOverridesAgent: true,
			workPoolYieldItems: [{ id: "example-1", index: 2 }],
			ircPeers: [
				{
					id: "example-1",
					displayName: "Example displayName",
					kind: "Example kind",
					status: "Example status",
					activity: "Example activity",
					resolvedModelIdentity: "openai/example",
					resolvedThinkingLevel: "high",
					fastModeEnabled: true,
					fastModeActive: true,
				},
			],
			ircParkedCount: 2,
			ircOmittedCount: 2,
			ircSelfId: "example-1",
		},
		localHelpers: ["jtdToTypeScript", "renderYieldSchema"],
		consumerHints: [
			"packages/coding-agent/src/prompts/system/subagent-system-prompt.md",
			"packages/coding-agent/src/task/executor.ts",
		],
	},
	{
		id: "system/subagent-user-prompt.md",
		relPath: "system/subagent-user-prompt.md",
		bundled: asset284,
		scope: "feature:system/subagent-user-prompt",
		group: "core",
		keys: [
			{ path: "assignment", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "routing",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "policy", type: "string", required: false, resolution: "session-dependent" },
					{ path: "slot", type: "string", required: false, resolution: "session-dependent" },
					{ path: "model", type: "string | string[]", required: false, resolution: "session-dependent" },
					{ path: "effort", type: "string", required: false, resolution: "session-dependent" },
					{ path: "boundary", type: "string", required: false, resolution: "session-dependent" },
					{ path: "agent", type: "string", required: false, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			assignment: "Example assignment",
			routing: {
				policy: "Example policy",
				slot: "Example slot",
				model: ["example"],
				effort: "Example effort",
				boundary: "Example boundary",
				agent: "Example agent",
			},
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/subagent-user-prompt.md",
			"packages/coding-agent/src/task/index.ts",
			"packages/coding-agent/src/task/structured-subagent.ts",
		],
	},
	{
		id: "system/subagent-yield-reminder.md",
		relPath: "system/subagent-yield-reminder.md",
		bundled: asset285,
		scope: "feature:system/subagent-yield-reminder",
		group: "core",
		keys: [
			{ path: "retryCount", type: "number", required: true, resolution: "session-dependent" },
			{ path: "maxRetries", type: "number", required: true, resolution: "session-dependent" },
			{ path: "budgetStop", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "structured", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { retryCount: 2, maxRetries: 2, budgetStop: true, structured: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/subagent-yield-reminder.md",
			"packages/coding-agent/src/task/executor.ts",
		],
	},
	{
		id: "system/system-prompt.md",
		relPath: "system/system-prompt.md",
		bundled: asset286,
		scope: "system",
		group: "core",
		keys: describePromptContext(systemPromptContextFixture),
		fixture: systemPromptContextFixture,
		consumerHints: [
			"packages/coding-agent/src/prompts/system/system-prompt.md",
			"packages/coding-agent/src/system-prompt.ts",
		],
	},
	{
		id: "system/tan-context-switch.md",
		relPath: "system/tan-context-switch.md",
		bundled: asset287,
		scope: "feature:system/tan-context-switch",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/tan-context-switch.md",
			"packages/coding-agent/src/modes/controllers/tan-command-controller.ts",
		],
	},
	{
		id: "system/task-label.md",
		relPath: "system/task-label.md",
		bundled: asset288,
		scope: "feature:system/task-label",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/task-label.md",
			"packages/coding-agent/src/task/label.ts",
		],
	},
	{
		id: "system/thinking-loop-redirect.md",
		relPath: "system/thinking-loop-redirect.md",
		bundled: asset289,
		scope: "feature:system/thinking-loop-redirect",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/thinking-loop-redirect.md",
			"packages/coding-agent/src/session/turn-recovery.ts",
		],
	},
	{
		id: "system/title-card.md",
		relPath: "system/title-card.md",
		bundled: asset290,
		scope: "feature:system/title-card",
		group: "core",
		keys: [{ path: "nerdFonts", type: "boolean", required: true, resolution: "session-dependent" }],
		fixture: { nerdFonts: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/title-card.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/title-fork.md",
		relPath: "system/title-fork.md",
		bundled: asset291,
		scope: "feature:system/title-fork",
		group: "core",
		keys: [
			{ path: "card", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "nerdFonts", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { card: true, nerdFonts: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/title-fork.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/title-marker-instruction.md",
		relPath: "system/title-marker-instruction.md",
		bundled: asset292,
		scope: "feature:system/title-marker-instruction",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/title-marker-instruction.md",
			"packages/coding-agent/src/utils/title-generator.ts",
		],
	},
	{
		id: "system/title-system.md",
		relPath: "system/title-system.md",
		bundled: asset293,
		scope: "feature:system/title-system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/title-system.md",
			"packages/coding-agent/src/tiny/title-client.ts",
			"packages/coding-agent/src/utils/title-generator.ts",
		],
	},
	{
		id: "system/tool-call-loop-redirect.md",
		relPath: "system/tool-call-loop-redirect.md",
		bundled: asset294,
		scope: "feature:system/tool-call-loop-redirect",
		group: "core",
		keys: [
			{ path: "tool_name", type: "string", required: true, resolution: "session-dependent" },
			{ path: "count", type: "string", required: true, resolution: "session-dependent" },
			{ path: "arguments_summary", type: "string", required: true, resolution: "session-dependent" },
			{ path: "result_summary", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			tool_name: "Example tool_name",
			count: "Example count",
			arguments_summary: "Example arguments_summary",
			result_summary: "Example result_summary",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/tool-call-loop-redirect.md",
			"packages/coding-agent/src/session/tool-call-loop-redirect.ts",
		],
	},
	{
		id: "system/tool-roster-notice.md",
		relPath: "system/tool-roster-notice.md",
		bundled: asset295,
		scope: "feature:system/tool-roster-notice",
		group: "core",
		keys: [
			{ path: "added", type: "string", required: true, resolution: "session-dependent" },
			{ path: "removed", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { added: "Example added", removed: "Example removed" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/tool-roster-notice.md",
			"packages/coding-agent/src/session/session-tools.ts",
		],
	},
	{
		id: "system/ttsr-interrupt.md",
		relPath: "system/ttsr-interrupt.md",
		bundled: asset296,
		scope: "feature:system/ttsr-interrupt",
		group: "core",
		keys: [
			{ path: "name", type: "string", required: true, resolution: "session-dependent" },
			{ path: "path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "content", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { name: "Example name", path: "/workspace/example", content: "Example content" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/ttsr-interrupt.md",
			"packages/coding-agent/src/session/ttsr-coordinator.ts",
		],
	},
	{
		id: "system/ttsr-tool-reminder.md",
		relPath: "system/ttsr-tool-reminder.md",
		bundled: asset297,
		scope: "feature:system/ttsr-tool-reminder",
		group: "core",
		keys: [
			{ path: "name", type: "string", required: true, resolution: "session-dependent" },
			{ path: "path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "content", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { name: "Example name", path: "/workspace/example", content: "Example content" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/ttsr-tool-reminder.md",
			"packages/coding-agent/src/session/ttsr-coordinator.ts",
		],
	},
	{
		id: "system/ttsr-warning.md",
		relPath: "system/ttsr-warning.md",
		bundled: asset298,
		scope: "feature:system/ttsr-warning",
		group: "core",
		keys: [
			{ path: "name", type: "string", required: true, resolution: "session-dependent" },
			{ path: "path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "subject", type: "string", required: true, resolution: "session-dependent" },
			{ path: "content", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			name: "Example name",
			path: "/workspace/example",
			subject: "Example subject",
			content: "Example content",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/ttsr-warning.md",
			"packages/coding-agent/src/session/ttsr-coordinator.ts",
		],
	},
	{
		id: "system/ultrathink-notice.md",
		relPath: "system/ultrathink-notice.md",
		bundled: asset299,
		scope: "feature:system/ultrathink-notice",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/ultrathink-notice.md",
			"packages/coding-agent/src/modes/magic-keywords.ts",
		],
	},
	{
		id: "system/unexpected-stop-retry.md",
		relPath: "system/unexpected-stop-retry.md",
		bundled: asset300,
		scope: "feature:system/unexpected-stop-retry",
		group: "core",
		keys: [
			{ path: "retryCount", type: "string", required: true, resolution: "session-dependent" },
			{ path: "maxRetries", type: "number", required: true, resolution: "session-dependent" },
		],
		fixture: { retryCount: "Example retryCount", maxRetries: 2 },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/unexpected-stop-retry.md",
			"packages/coding-agent/src/session/turn-recovery.ts",
		],
	},
	{
		id: "system/user-append.md",
		relPath: "system/user-append.md",
		bundled: asset301,
		scope: "feature:system/user-append",
		group: "core",
		keys: [
			{ path: "generatedAppend", type: "string", resolution: "session-dependent" },
			{ path: "userAppend", type: "string", resolution: "session-dependent" },
		],
		fixture: { generatedAppend: "Example generatedAppend", userAppend: "Example userAppend" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/user-append.md",
			"packages/coding-agent/src/system-prompt.ts",
		],
	},
	{
		id: "system/vibe-mode-active.md",
		relPath: "system/vibe-mode-active.md",
		bundled: asset302,
		scope: "feature:system/vibe-mode-active",
		group: "core",
		keys: [{ path: "todoAvailable", type: "boolean", required: true, resolution: "session-dependent" }],
		fixture: { todoAvailable: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/vibe-mode-active.md",
			"packages/coding-agent/src/session/agent-session.ts",
		],
	},
	{
		id: "system/video-attachment.md",
		relPath: "system/video-attachment.md",
		bundled: asset303,
		scope: "feature:system/video-attachment",
		group: "core",
		keys: [
			{ path: "index", type: "string", required: true, resolution: "session-dependent" },
			{ path: "path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "askAnswer", type: "unknown", required: true, resolution: "session-dependent" },
		],
		fixture: { index: "Example index", path: "/workspace/example", askAnswer: "Example askAnswer" },
		consumerHints: [
			"packages/coding-agent/src/prompts/system/video-attachment.md",
			"packages/coding-agent/src/session/attachment-source-notice.ts",
		],
	},
	{
		id: "system/web-search.md",
		relPath: "system/web-search.md",
		bundled: asset304,
		scope: "feature:system/web-search",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/web-search.md",
			"packages/coding-agent/src/web/search/index.ts",
		],
	},
	{
		id: "system/workflow-notice.md",
		relPath: "system/workflow-notice.md",
		bundled: asset305,
		scope: "feature:system/workflow-notice",
		group: "core",
		keys: [
			{ path: "taskBatch", type: "unknown", required: true, resolution: "session-dependent" },
			{ path: "scoutAvailable", type: "string", required: true, resolution: "session-dependent" },
			{ path: "evalTools", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			taskBatch: "Example taskBatch",
			scoutAvailable: "Example scoutAvailable",
			evalTools: "Example evalTools",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/workflow-notice.md",
			"packages/coding-agent/src/modes/magic-keywords.ts",
		],
	},
	{
		id: "system/x-read.md",
		relPath: "system/x-read.md",
		bundled: asset306,
		scope: "feature:system/x-read",
		group: "core",
		keys: [
			{ path: "post", type: "string", resolution: "session-dependent" },
			{ path: "id", type: "string", resolution: "session-dependent" },
			{ path: "profile", type: "string", resolution: "session-dependent" },
			{ path: "handle", type: "string", resolution: "session-dependent" },
			{ path: "query", type: "string", resolution: "session-dependent" },
			{ path: "search", type: "string", resolution: "session-dependent" },
			{ path: "mode", type: "string", resolution: "session-dependent" },
			{ path: "users", type: "string", resolution: "session-dependent" },
		],
		fixture: {
			post: "Example post",
			id: "example-1",
			profile: "Example profile",
			handle: "Example handle",
			query: "Example query",
			search: "Example search",
			mode: "Example mode",
			users: "Example users",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/x-read.md",
			"packages/coding-agent/src/web/scrapers/twitter.ts",
		],
	},
	{
		id: "system/xdev-mount-notice.md",
		relPath: "system/xdev-mount-notice.md",
		bundled: asset307,
		scope: "feature:system/xdev-mount-notice",
		group: "core",
		keys: [
			{
				path: "added",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "summary", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{
				path: "removed",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [{ path: "name", type: "string" }],
			},
			{ path: "docs", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			added: [{ name: "Example name", summary: "Example summary" }],
			removed: [{ name: "Example name" }],
			docs: "Example docs",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/system/xdev-mount-notice.md",
			"packages/coding-agent/src/session/session-tools.ts",
		],
	},
	{
		id: "tools/agent-url-progress.md",
		relPath: "tools/agent-url-progress.md",
		bundled: asset308,
		scope: "tool:agent-url-progress",
		group: "core",
		keys: [
			{ path: "id", type: "string", required: true, resolution: "session-dependent" },
			{ path: "status", type: "string", required: true, resolution: "session-dependent" },
			{ path: "lastText", type: "string", required: false, resolution: "session-dependent" },
			{ path: "empty", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "sections",
				type: "object[]",
				children: [
					{ path: "labels", type: "string?", required: true, resolution: "session-dependent" },
					{ path: "data", type: "string", required: true, resolution: "session-dependent" },
				],
				required: true,
				resolution: "session-dependent",
			},
		],
		fixture: {
			id: "example-1",
			status: "Example status",
			lastText: "Example lastText",
			empty: true,
			sections: [{ labels: "Example labels", data: "Example data" }],
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/agent-url-progress.md",
			"packages/coding-agent/src/internal-urls/agent-protocol.ts",
		],
	},
	{
		id: "tools/agent-url-superseded.md",
		relPath: "tools/agent-url-superseded.md",
		bundled: asset309,
		scope: "tool:agent-url-superseded",
		group: "core",
		keys: [
			{ path: "id", type: "string", required: true, resolution: "session-dependent" },
			{ path: "age", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { id: "example-1", age: "Example age" },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/agent-url-superseded.md",
			"packages/coding-agent/src/internal-urls/agent-protocol.ts",
		],
	},
	{
		id: "tools/approve.md",
		relPath: "tools/approve.md",
		bundled: asset310,
		scope: "tool:approve",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/approve.md",
			"packages/coding-agent/src/compress/protocol.ts",
		],
	},
	{
		id: "tools/archive.md",
		relPath: "tools/archive.md",
		bundled: asset311,
		scope: "tool:archive",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/archive.md",
			"packages/coding-agent/src/archive/prelude-definition.ts",
		],
	},
	{
		id: "tools/ask.md",
		relPath: "tools/ask.md",
		bundled: asset312,
		scope: "tool:ask",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/tools/ask.md", "packages/coding-agent/src/tools/ask.ts"],
	},
	{
		id: "tools/ast-edit.md",
		relPath: "tools/ast-edit.md",
		bundled: asset313,
		scope: "tool:ast-edit",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/ast-edit.md",
			"packages/coding-agent/src/tools/ast-edit.ts",
		],
	},
	{
		id: "tools/ast-grep.md",
		relPath: "tools/ast-grep.md",
		bundled: asset314,
		scope: "tool:ast-grep",
		group: "core",
		keys: [
			{ path: "eagerDelegation", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "scoutAvailable", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { eagerDelegation: true, scoutAvailable: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/ast-grep.md",
			"packages/coding-agent/src/tools/ast-grep.ts",
		],
	},
	{
		id: "tools/async-result.md",
		relPath: "tools/async-result.md",
		bundled: asset315,
		scope: "tool:async-result",
		group: "core",
		keys: [
			{ path: "multiple", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "jobs",
				type: "unknown[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "[0]", type: "object", children: [{ path: "jobId", type: "string" }] },
					{ path: "jobId", type: "string" },
					{ path: "label", type: "string" },
					{ path: "result", type: "string" },
					{ path: "schemaStatus", type: "string" },
					{ path: "schemaStatusLabel", type: "string" },
					{ path: "schemaError", type: "string" },
					{ path: "hasStructuredData", type: "string" },
					{ path: "agentUrlId", type: "string" },
					{ path: "schemaValid", type: "string" },
					{ path: "structuredJson", type: "string" },
				],
			},
		],
		fixture: {
			multiple: true,
			jobs: [
				{
					"[0]": { jobId: "example-1" },
					jobId: "example-1",
					label: "Example label",
					result: "Example result",
					schemaStatus: "Example schemaStatus",
					schemaStatusLabel: "Example schemaStatusLabel",
					schemaError: "Example schemaError",
					hasStructuredData: "Example hasStructuredData",
					agentUrlId: "example-1",
					schemaValid: "example-1",
					structuredJson: "{}",
				},
			],
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/async-result.md",
			"packages/coding-agent/src/session/async-job-delivery.ts",
		],
	},
	{
		id: "tools/bash.md",
		relPath: "tools/bash.md",
		bundled: asset316,
		scope: "tool:bash",
		group: "core",
		keys: describePromptContext(bashPromptContextFixture),
		fixture: bashPromptContextFixture,
		consumerHints: ["packages/coding-agent/src/prompts/tools/bash.md", "packages/coding-agent/src/tools/bash.ts"],
	},
	{
		id: "tools/browser.md",
		relPath: "tools/browser.md",
		bundled: asset317,
		scope: "tool:browser",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/browser.md",
			"packages/coding-agent/src/tools/browser/prelude-definition.ts",
		],
	},
	{
		id: "tools/cfg-approval-timeout.md",
		relPath: "tools/cfg-approval-timeout.md",
		bundled: asset318,
		scope: "tool:cfg-approval-timeout",
		group: "core",
		keys: [
			{ path: "path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "previous", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { path: "/workspace/example", previous: "Example previous" },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/cfg-approval-timeout.md",
			"packages/coding-agent/src/internal-urls/cfg-protocol.ts",
		],
	},
	{
		id: "tools/cfg-env-shadowed.md",
		relPath: "tools/cfg-env-shadowed.md",
		bundled: asset319,
		scope: "tool:cfg-env-shadowed",
		group: "core",
		keys: [
			{ path: "path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "effective", type: "string", required: true, resolution: "session-dependent" },
			{ path: "env", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: { path: "/workspace/example", effective: "Example effective", env: "Example env" },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/cfg-env-shadowed.md",
			"packages/coding-agent/src/internal-urls/cfg-protocol.ts",
		],
	},
	{
		id: "tools/cfg-write-result.md",
		relPath: "tools/cfg-write-result.md",
		bundled: asset320,
		scope: "tool:cfg-write-result",
		group: "core",
		keys: [
			{ path: "path", type: "string", required: true, resolution: "session-dependent" },
			{ path: "previous", type: "string", required: true, resolution: "session-dependent" },
			{ path: "value", type: "string", required: true, resolution: "session-dependent" },
			{ path: "url", type: "string", required: true, resolution: "session-dependent" },
			{ path: "saveUrl", type: "string", required: true, resolution: "session-dependent" },
			{ path: "save", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "declined", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "unchanged", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "saved", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "applied", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "shadowedBy", type: "string", required: false, resolution: "session-dependent" },
			{ path: "effective", type: "string", required: false, resolution: "session-dependent" },
			{ path: "provenance", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: {
			path: "/workspace/example",
			previous: "Example previous",
			value: "Example value",
			url: "Example url",
			saveUrl: "Example saveUrl",
			save: true,
			declined: true,
			unchanged: true,
			saved: true,
			applied: true,
			shadowedBy: "Example shadowedBy",
			effective: "Example effective",
			provenance: "Example provenance",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/cfg-write-result.md",
			"packages/coding-agent/src/internal-urls/cfg-protocol.ts",
		],
	},
	{
		id: "tools/checkpoint.md",
		relPath: "tools/checkpoint.md",
		bundled: asset321,
		scope: "tool:checkpoint",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/checkpoint.md",
			"packages/coding-agent/src/tools/checkpoint.ts",
		],
	},
	{
		id: "tools/chronicle-recall.md",
		relPath: "tools/chronicle-recall.md",
		bundled: asset322,
		scope: "tool:chronicle-recall",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/chronicle-recall.md",
			"packages/coding-agent/src/tools/chronicle-recall.ts",
		],
	},
	{
		id: "tools/computer-screen-locked-capture.md",
		relPath: "tools/computer-screen-locked-capture.md",
		bundled: asset323,
		scope: "tool:computer-screen-locked-capture",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/computer-screen-locked-capture.md",
			"packages/coding-agent/src/tools/computer/protocol.ts",
		],
	},
	{
		id: "tools/computer-screen-state.md",
		relPath: "tools/computer-screen-state.md",
		bundled: asset324,
		scope: "tool:computer-screen-state",
		group: "core",
		keys: [
			{ path: "screenLocked", type: "boolean", required: false, resolution: "session-dependent" },
			{ path: "displayAsleep", type: "boolean", required: false, resolution: "session-dependent" },
		],
		fixture: { screenLocked: true, displayAsleep: false },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/computer-screen-state.md",
			"packages/coding-agent/src/tools/computer/protocol.ts",
		],
	},
	{
		id: "tools/computer.md",
		relPath: "tools/computer.md",
		bundled: asset325,
		scope: "tool:computer",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/computer.md",
			"packages/coding-agent/src/tools/computer/prelude-definition.ts",
		],
	},
	{
		id: "tools/context-notes.md",
		relPath: "tools/context-notes.md",
		bundled: asset326,
		scope: "tool:context-notes",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/context-notes.md",
			"packages/coding-agent/src/tools/context-notes.ts",
		],
	},
	{
		id: "tools/ctl.md",
		relPath: "tools/ctl.md",
		bundled: asset327,
		scope: "tool:ctl",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/tools/ctl.md", "packages/coding-agent/src/tools/ctl.ts"],
	},
	{
		id: "tools/debug.md",
		relPath: "tools/debug.md",
		bundled: asset328,
		scope: "tool:debug",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/tools/debug.md", "packages/coding-agent/src/tools/debug.ts"],
	},
	{
		id: "tools/eval-agents.md",
		relPath: "tools/eval-agents.md",
		bundled: asset329,
		scope: "tool:eval-agents",
		group: "core",
		keys: [
			{ path: "py", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "js", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "evalTools", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "eagerDelegation", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "waitTool", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "autoBackgroundEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "spawns", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "autoProvision", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "spawnDefaultAgent", type: "string", required: true, resolution: "session-dependent" },
			{ path: "spawnAllowedAgentsText", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: {
			py: true,
			js: true,
			evalTools: true,
			eagerDelegation: true,
			waitTool: true,
			autoBackgroundEnabled: true,
			spawns: true,
			autoProvision: true,
			spawnDefaultAgent: "Example spawnDefaultAgent",
			spawnAllowedAgentsText: "Example spawnAllowedAgentsText",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/eval-agents.md",
			"packages/coding-agent/src/tools/eval.ts",
		],
	},
	{
		id: "tools/eval-helpers.md",
		relPath: "tools/eval-helpers.md",
		bundled: asset331,
		scope: "tool:eval-helpers",
		group: "core",
		keys: [
			{ path: "py", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "js", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "evalTools", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "eagerDelegation", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "waitTool", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "autoBackgroundEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "spawns", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "autoProvision", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "spawnDefaultAgent", type: "string", required: true, resolution: "session-dependent" },
			{ path: "spawnAllowedAgentsText", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: {
			py: true,
			js: true,
			evalTools: true,
			eagerDelegation: true,
			waitTool: true,
			autoBackgroundEnabled: true,
			spawns: true,
			autoProvision: true,
			spawnDefaultAgent: "Example spawnDefaultAgent",
			spawnAllowedAgentsText: "Example spawnAllowedAgentsText",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/eval-helpers.md",
			"packages/coding-agent/src/tools/eval.ts",
		],
	},
	{
		id: "tools/eval-judge.md",
		relPath: "tools/eval-judge.md",
		bundled: asset332,
		scope: "tool:eval-judge",
		group: "core",
		keys: [
			{ path: "py", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "js", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "evalTools", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "eagerDelegation", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "waitTool", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "autoBackgroundEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "spawns", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "autoProvision", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "spawnDefaultAgent", type: "string", required: true, resolution: "session-dependent" },
			{ path: "spawnAllowedAgentsText", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: {
			py: true,
			js: true,
			evalTools: true,
			eagerDelegation: true,
			waitTool: true,
			autoBackgroundEnabled: true,
			spawns: true,
			autoProvision: true,
			spawnDefaultAgent: "Example spawnDefaultAgent",
			spawnAllowedAgentsText: "Example spawnAllowedAgentsText",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/eval-judge.md",
			"packages/coding-agent/src/tools/eval.ts",
		],
	},
	{
		id: "tools/eval.md",
		relPath: "tools/eval.md",
		bundled: asset333,
		scope: "tool:eval",
		group: "core",
		keys: [
			{ path: "py", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "js", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "evalTools", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "eagerDelegation", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "waitTool", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "autoBackgroundEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "spawns", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "autoProvision", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "spawnDefaultAgent", type: "string", required: true, resolution: "session-dependent" },
			{ path: "spawnAllowedAgentsText", type: "string", required: false, resolution: "session-dependent" },
			{ path: "inlineTopics", type: "string", required: false, resolution: "session-dependent" },
			{
				path: "preludes",
				type: "object[]",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "summary", type: "string", required: true, resolution: "session-dependent" },
				],
				required: true,
				resolution: "session-dependent",
			},
		],
		fixture: {
			py: true,
			js: true,
			evalTools: true,
			eagerDelegation: true,
			waitTool: true,
			autoBackgroundEnabled: true,
			spawns: true,
			autoProvision: true,
			spawnDefaultAgent: "Example spawnDefaultAgent",
			spawnAllowedAgentsText: "Example spawnAllowedAgentsText",
			inlineTopics: "Example inlineTopics",
			preludes: [{ name: "Example name", summary: "Example summary" }],
		},
		consumerHints: ["packages/coding-agent/src/prompts/tools/eval.md", "packages/coding-agent/src/tools/eval.ts"],
	},
	{
		id: "tools/find.md",
		relPath: "tools/find.md",
		bundled: asset334,
		scope: "tool:find",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/find.md",
			"packages/coding-agent/src/tools/jfind/index.ts",
		],
	},
	{
		id: "tools/github.md",
		relPath: "tools/github.md",
		bundled: asset335,
		scope: "tool:github",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/tools/github.md", "packages/coding-agent/src/tools/gh.ts"],
	},
	{
		id: "tools/glob.md",
		relPath: "tools/glob.md",
		bundled: asset336,
		scope: "tool:glob",
		group: "core",
		keys: [
			{ path: "hasFind", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "eagerDelegation", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "scoutAvailable", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { hasFind: true, eagerDelegation: true, scoutAvailable: true },
		consumerHints: ["packages/coding-agent/src/prompts/tools/glob.md", "packages/coding-agent/src/tools/glob.ts"],
	},
	{
		id: "tools/goal.md",
		relPath: "tools/goal.md",
		bundled: asset337,
		scope: "tool:goal",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/goal.md",
			"packages/coding-agent/src/goals/tools/goal-tool.ts",
		],
	},
	{
		id: "tools/grep.md",
		relPath: "tools/grep.md",
		bundled: asset338,
		scope: "tool:grep",
		group: "core",
		keys: [
			{ path: "IS_HL_MODE", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "IS_LINE_NUMBER_MODE", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "hasFind", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "eagerDelegation", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "scoutAvailable", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: {
			IS_HL_MODE: true,
			IS_LINE_NUMBER_MODE: true,
			hasFind: true,
			eagerDelegation: true,
			scoutAvailable: true,
		},
		consumerHints: ["packages/coding-agent/src/prompts/tools/grep.md", "packages/coding-agent/src/tools/grep.ts"],
	},
	{
		id: "tools/ida.md",
		relPath: "tools/ida.md",
		bundled: asset339,
		scope: "tool:ida",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/tools/ida.md", "packages/coding-agent/src/tools/ida.ts"],
	},
	{
		id: "tools/image-attachment-describe-system.md",
		relPath: "tools/image-attachment-describe-system.md",
		bundled: asset340,
		scope: "tool:image-attachment-describe-system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/image-attachment-describe-system.md",
			"packages/coding-agent/src/utils/image-vision-fallback.ts",
		],
	},
	{
		id: "tools/image-attachment-describe.md",
		relPath: "tools/image-attachment-describe.md",
		bundled: asset341,
		scope: "tool:image-attachment-describe",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/image-attachment-describe.md",
			"packages/coding-agent/src/utils/image-vision-fallback.ts",
		],
	},
	{
		id: "tools/image-gen.md",
		relPath: "tools/image-gen.md",
		bundled: asset342,
		scope: "tool:image-gen",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/image-gen.md",
			"packages/coding-agent/src/tools/image-gen.ts",
		],
	},
	{
		id: "tools/image-question-system.md",
		relPath: "tools/image-question-system.md",
		bundled: asset343,
		scope: "tool:image-question-system",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/image-question-system.md",
			"packages/coding-agent/src/utils/image-question.ts",
		],
	},
	{
		id: "tools/isolation-error.md",
		relPath: "tools/isolation-error.md",
		bundled: asset344,
		scope: "tool:isolation-error",
		group: "core",
		keys: [
			{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
			{ path: "message", type: "string", required: true, resolution: "session-dependent" },
			{ path: "captureError", type: "string", required: false, resolution: "session-dependent" },
			{ path: "rescueBranch", type: "string", required: false, resolution: "session-dependent" },
			{ path: "retainedDir", type: "string", required: false, resolution: "session-dependent" },
			{ path: "sidecarMissing", type: "boolean", required: false, resolution: "session-dependent" },
		],
		fixture: {
			kind: "Example kind",
			message: "Example message",
			captureError: "Example captureError",
			rescueBranch: "Example rescueBranch",
			retainedDir: "/workspace/example",
			sidecarMissing: true,
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/isolation-error.md",
			"packages/coding-agent/src/task/isolation-runner.ts",
		],
	},
	{
		id: "tools/isolation-recovery-hint.md",
		relPath: "tools/isolation-recovery-hint.md",
		bundled: asset345,
		scope: "tool:isolation-recovery-hint",
		group: "core",
		keys: [
			{ path: "patchPath", type: "string", required: false, resolution: "session-dependent" },
			{ path: "nestedPatchPaths", type: "string[]", required: true, resolution: "session-dependent" },
			{ path: "nestedFailure", type: "string", required: false, resolution: "session-dependent" },
			{ path: "branchName", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: {
			patchPath: "/workspace/example",
			nestedPatchPaths: ["example"],
			nestedFailure: "Example nestedFailure",
			branchName: "Example branchName",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/isolation-recovery-hint.md",
			"packages/coding-agent/src/task/structured-subagent.ts",
		],
	},
	{
		id: "tools/isolation-summary.md",
		relPath: "tools/isolation-summary.md",
		bundled: asset346,
		scope: "tool:isolation-summary",
		group: "core",
		keys: [
			{ path: "kind", type: "string", required: true, resolution: "session-dependent" },
			{ path: "branchName", type: "string", required: false, resolution: "session-dependent" },
			{ path: "rootPatchPath", type: "string", required: false, resolution: "session-dependent" },
			{ path: "nestedCount", type: "number", required: false, resolution: "session-dependent" },
			{ path: "nestedPatchPaths", type: "string[]", required: false, resolution: "session-dependent" },
			{ path: "error", type: "string", required: false, resolution: "session-dependent" },
			{ path: "conflict", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: {
			kind: "Example kind",
			branchName: "Example branchName",
			rootPatchPath: "/workspace/example",
			nestedCount: 2,
			nestedPatchPaths: ["example"],
			error: "Example error",
			conflict: "Example conflict",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/isolation-summary.md",
			"packages/coding-agent/src/task/isolation-runner.ts",
		],
	},
	{
		id: "tools/learn.md",
		relPath: "tools/learn.md",
		bundled: asset347,
		scope: "tool:learn",
		group: "core",
		keys: [{ path: "globalScope", type: "boolean", required: true, resolution: "session-dependent" }],
		fixture: { globalScope: true },
		consumerHints: ["packages/coding-agent/src/prompts/tools/learn.md", "packages/coding-agent/src/tools/learn.ts"],
	},
	{
		id: "tools/lsp-late-diagnostic.md",
		relPath: "tools/lsp-late-diagnostic.md",
		bundled: asset348,
		scope: "tool:lsp-late-diagnostic",
		group: "core",
		keys: [
			{ path: "multiple", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "files",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "path", type: "string", required: true, resolution: "session-dependent" },
					{ path: "summary", type: "string", required: true, resolution: "session-dependent" },
					{ path: "messages", type: "string", required: true, resolution: "session-dependent" },
					{ path: "errored", type: "unknown", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			multiple: true,
			files: [
				{
					path: "/workspace/example",
					summary: "Example summary",
					messages: "Example messages",
					errored: "Example errored",
				},
			],
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/lsp-late-diagnostic.md",
			"packages/coding-agent/src/sdk.ts",
		],
	},
	{
		id: "tools/lsp.md",
		relPath: "tools/lsp.md",
		bundled: asset349,
		scope: "tool:lsp",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/tools/lsp.md", "packages/coding-agent/src/lsp/tool.ts"],
	},
	{
		id: "tools/manage-skill.md",
		relPath: "tools/manage-skill.md",
		bundled: asset350,
		scope: "tool:manage-skill",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/manage-skill.md",
			"packages/coding-agent/src/tools/manage-skill.ts",
		],
	},
	{
		id: "tools/memory-edit.md",
		relPath: "tools/memory-edit.md",
		bundled: asset351,
		scope: "tool:memory-edit",
		group: "core",
		keys: [
			{
				path: "toolRefs",
				type: "object",
				children: [
					{ path: "retain", type: "string", required: true, resolution: "session-dependent" },
					{ path: "recall", type: "string", required: true, resolution: "session-dependent" },
					{ path: "reflect", type: "string", required: true, resolution: "session-dependent" },
					{ path: "memory_edit", type: "string", required: true, resolution: "session-dependent" },
					{ path: "learn", type: "string", required: true, resolution: "session-dependent" },
				],
				required: true,
				resolution: "session-dependent",
			},
		],
		fixture: {
			toolRefs: {
				retain: "Example retain",
				recall: "Example recall",
				reflect: "Example reflect",
				memory_edit: "Example memory_edit",
				learn: "Example learn",
			},
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/memory-edit.md",
			"packages/coding-agent/src/tools/memory-edit.ts",
		],
	},
	{
		id: "tools/new-context.md",
		relPath: "tools/new-context.md",
		bundled: asset352,
		scope: "tool:new-context",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/new-context.md",
			"packages/coding-agent/src/tools/context-notes.ts",
		],
	},
	{
		id: "tools/ratchet.md",
		relPath: "tools/ratchet.md",
		bundled: asset353,
		scope: "tool:ratchet",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/ratchet.md",
			"packages/coding-agent/src/ratchet/prelude-definition.ts",
		],
	},
	{
		id: "tools/read.md",
		relPath: "tools/read.md",
		bundled: asset354,
		scope: "tool:read",
		group: "core",
		keys: [
			{ path: "IS_HL_MODE", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "BINARY_VIEWS", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { IS_HL_MODE: true, BINARY_VIEWS: true },
		consumerHints: ["packages/coding-agent/src/prompts/tools/read.md", "packages/coding-agent/src/tools/read.ts"],
	},
	{
		id: "tools/recall.md",
		relPath: "tools/recall.md",
		bundled: asset355,
		scope: "tool:recall",
		group: "core",
		keys: [
			{
				path: "toolRefs",
				type: "object",
				children: [
					{ path: "retain", type: "string", required: true, resolution: "session-dependent" },
					{ path: "recall", type: "string", required: true, resolution: "session-dependent" },
					{ path: "reflect", type: "string", required: true, resolution: "session-dependent" },
					{ path: "memory_edit", type: "string", required: true, resolution: "session-dependent" },
					{ path: "learn", type: "string", required: true, resolution: "session-dependent" },
				],
				required: true,
				resolution: "session-dependent",
			},
		],
		fixture: {
			toolRefs: {
				retain: "Example retain",
				recall: "Example recall",
				reflect: "Example reflect",
				memory_edit: "Example memory_edit",
				learn: "Example learn",
			},
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/recall.md",
			"packages/coding-agent/src/tools/memory-recall.ts",
		],
	},
	{
		id: "tools/reflect.md",
		relPath: "tools/reflect.md",
		bundled: asset356,
		scope: "tool:reflect",
		group: "core",
		keys: [
			{
				path: "toolRefs",
				type: "object",
				children: [
					{ path: "retain", type: "string", required: true, resolution: "session-dependent" },
					{ path: "recall", type: "string", required: true, resolution: "session-dependent" },
					{ path: "reflect", type: "string", required: true, resolution: "session-dependent" },
					{ path: "memory_edit", type: "string", required: true, resolution: "session-dependent" },
					{ path: "learn", type: "string", required: true, resolution: "session-dependent" },
				],
				required: true,
				resolution: "session-dependent",
			},
		],
		fixture: {
			toolRefs: {
				retain: "Example retain",
				recall: "Example recall",
				reflect: "Example reflect",
				memory_edit: "Example memory_edit",
				learn: "Example learn",
			},
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/reflect.md",
			"packages/coding-agent/src/tools/memory-reflect.ts",
		],
	},
	{
		id: "tools/retain.md",
		relPath: "tools/retain.md",
		bundled: asset357,
		scope: "tool:retain",
		group: "core",
		keys: [{ path: "globalScope", type: "boolean", required: true, resolution: "session-dependent" }],
		fixture: { globalScope: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/retain.md",
			"packages/coding-agent/src/tools/memory-retain.ts",
		],
	},
	{
		id: "tools/rewind.md",
		relPath: "tools/rewind.md",
		bundled: asset358,
		scope: "tool:rewind",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/rewind.md",
			"packages/coding-agent/src/tools/checkpoint.ts",
		],
	},
	{
		id: "tools/rewrite.md",
		relPath: "tools/rewrite.md",
		bundled: asset359,
		scope: "tool:rewrite",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/rewrite.md",
			"packages/coding-agent/src/compress/protocol.ts",
		],
	},
	{
		id: "tools/salvaged-child-hint.md",
		relPath: "tools/salvaged-child-hint.md",
		bundled: asset360,
		scope: "tool:salvaged-child-hint",
		group: "core",
		keys: [
			{ path: "aborted", type: "boolean", required: false, resolution: "session-dependent" },
			{ path: "abortReason", type: "string", required: false, resolution: "session-dependent" },
			{ path: "exitCode", type: "number", required: true, resolution: "session-dependent" },
			{ path: "error", type: "string", required: false, resolution: "session-dependent" },
			{ path: "id", type: "string", required: true, resolution: "session-dependent" },
			{ path: "outputPath", type: "string", required: false, resolution: "session-dependent" },
		],
		fixture: {
			aborted: true,
			abortReason: "Example abortReason",
			exitCode: 2,
			error: "Example error",
			id: "example-1",
			outputPath: "/workspace/example",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/salvaged-child-hint.md",
			"packages/coding-agent/src/task/structured-subagent.ts",
		],
	},
	{
		id: "tools/security-publish.md",
		relPath: "tools/security-publish.md",
		bundled: asset361,
		scope: "tool:security-publish",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/security-publish.md",
			"packages/coding-agent/src/security/coordinator.ts",
			"packages/coding-agent/src/security/publication.ts",
		],
	},
	{
		id: "tools/security-scan.md",
		relPath: "tools/security-scan.md",
		bundled: asset362,
		scope: "tool:security-scan",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/security-scan.md",
			"packages/coding-agent/src/tools/security-scan.ts",
		],
	},
	{
		id: "tools/task-async-contract.md",
		relPath: "tools/task-async-contract.md",
		bundled: asset363,
		scope: "tool:task-async-contract",
		group: "core",
		keys: [
			{ path: "ircEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "waitTool", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { ircEnabled: true, waitTool: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/task-async-contract.md",
			"packages/coding-agent/src/task/index.ts",
		],
	},
	{
		id: "tools/task-coordination-advisory.md",
		relPath: "tools/task-coordination-advisory.md",
		bundled: asset364,
		scope: "tool:task-coordination-advisory",
		group: "core",
		keys: [{ path: "count", type: "number", required: true, resolution: "session-dependent" }],
		fixture: { count: 2 },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/task-coordination-advisory.md",
			"packages/coding-agent/src/task/index.ts",
		],
	},
	{
		id: "tools/task-follow-up.md",
		relPath: "tools/task-follow-up.md",
		bundled: asset365,
		scope: "tool:task-follow-up",
		group: "core",
		keys: [
			{ path: "agentId", type: "string", required: true, resolution: "session-dependent" },
			{ path: "aborted", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "isolated", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "ircEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "resumable", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "transcriptAvailable", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: {
			agentId: "example-1",
			aborted: true,
			isolated: true,
			ircEnabled: true,
			resumable: true,
			transcriptAvailable: true,
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/task-follow-up.md",
			"packages/coding-agent/src/task/index.ts",
		],
	},
	{
		id: "tools/task-spawn-feedback.md",
		relPath: "tools/task-spawn-feedback.md",
		bundled: asset366,
		scope: "tool:task-spawn-feedback",
		group: "core",
		keys: [
			{ path: "mixed", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "singular", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "singleCall", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "showListing", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "count", type: "number", required: true, resolution: "session-dependent" },
			{ path: "agentId", type: "string", required: false, resolution: "session-dependent" },
			{ path: "jobId", type: "string", required: false, resolution: "session-dependent" },
			{ path: "agentLabel", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "started",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "agentId", type: "string", required: true, resolution: "session-dependent" },
					{ path: "jobId", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "scheduleFailureSummary", type: "string", required: true, resolution: "session-dependent" },
			{ path: "guidance", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			mixed: true,
			singular: true,
			singleCall: true,
			showListing: true,
			count: 2,
			agentId: "example-1",
			jobId: "example-1",
			agentLabel: "Example agentLabel",
			started: [{ agentId: "example-1", jobId: "example-1" }],
			scheduleFailureSummary: "Example scheduleFailureSummary",
			guidance: "Example guidance",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/task-spawn-feedback.md",
			"packages/coding-agent/src/task/index.ts",
		],
	},
	{
		id: "tools/task-specialization-advisory.md",
		relPath: "tools/task-specialization-advisory.md",
		bundled: asset367,
		scope: "tool:task-specialization-advisory",
		group: "core",
		keys: [
			{ path: "count", type: "number", required: true, resolution: "session-dependent" },
			{ path: "agent", type: "string", required: true, resolution: "session-dependent" },
			{ path: "scoutAvailable", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { count: 2, agent: "Example agent", scoutAvailable: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/task-specialization-advisory.md",
			"packages/coding-agent/src/task/index.ts",
		],
	},
	{
		id: "tools/task-summary.md",
		relPath: "tools/task-summary.md",
		bundled: asset368,
		scope: "tool:task-summary",
		group: "core",
		keys: [
			{ path: "agentName", type: "string", required: true, resolution: "session-dependent" },
			{ path: "id", type: "string", required: true, resolution: "session-dependent" },
			{ path: "status", type: "string", required: true, resolution: "session-dependent" },
			{ path: "duration", type: "string", required: true, resolution: "session-dependent" },
			{ path: "abortReason", type: "string", required: false, resolution: "session-dependent" },
			{ path: "error", type: "string", required: false, resolution: "session-dependent" },
			{
				path: "effortPolicy",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
					{ path: "requested", type: "string", required: true, resolution: "session-dependent" },
					{ path: "origin", type: "string", required: true, resolution: "session-dependent" },
					{ path: "supported", type: "string", required: true, resolution: "session-dependent" },
					{ path: "permitted", type: "string", required: true, resolution: "session-dependent" },
					{ path: "rule", type: "string", required: true, resolution: "session-dependent" },
					{ path: "alternatives", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "resumable", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "preview", type: "string", required: true, resolution: "session-dependent" },
			{ path: "truncated", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "meta",
				type: "object",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "lineCount", type: "number", required: true, resolution: "session-dependent" },
					{ path: "charSize", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "mergeSummary", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: {
			agentName: "Example agentName",
			id: "example-1",
			status: "Example status",
			duration: "Example duration",
			abortReason: "Example abortReason",
			error: "Example error",
			effortPolicy: {
				model: "Example model",
				requested: "Example requested",
				origin: "Example origin",
				supported: "Example supported",
				permitted: "Example permitted",
				rule: "Example rule",
				alternatives: "Example alternatives",
			},
			resumable: true,
			preview: "Example preview",
			truncated: true,
			meta: { lineCount: 2, charSize: "Example charSize" },
			mergeSummary: "Example mergeSummary",
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/task-summary.md",
			"packages/coding-agent/src/task/result-summary.ts",
		],
	},
	{
		id: "tools/task.md",
		relPath: "tools/task.md",
		bundled: asset369,
		scope: "tool:task",
		group: "core",
		keys: [
			{
				path: "agents",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "name", type: "string", required: true, resolution: "session-dependent" },
					{ path: "description", type: "string", required: true, resolution: "session-dependent" },
					{ path: "readOnly", type: "boolean", required: true, resolution: "session-dependent" },
					{ path: "blocking", type: "boolean", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "scoutAvailable", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "spawningDisabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "defaultAgent", type: "string", required: true, resolution: "session-dependent" },
			{ path: "isolationEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "applyIsolatedChanges", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "batchEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "effortEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "legacyEffort", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "evalToolsEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "structured", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "asyncEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "hasBlockingAgents", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "hasModelMentions", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "ircEnabled", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "routingPolicies",
				type: "object[]",
				required: false,
				resolution: "session-dependent",
				children: [
					{ path: "selector", type: "string", required: true, resolution: "session-dependent" },
					{ path: "model", type: "string", required: true, resolution: "session-dependent" },
					{ path: "effort", type: "string", required: true, resolution: "session-dependent" },
					{ path: "boundary", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			agents: [{ name: "Example name", description: "Example description", readOnly: true, blocking: true }],
			scoutAvailable: true,
			spawningDisabled: true,
			defaultAgent: "Example defaultAgent",
			isolationEnabled: true,
			applyIsolatedChanges: true,
			batchEnabled: true,
			effortEnabled: true,
			legacyEffort: true,
			evalToolsEnabled: true,
			structured: true,
			asyncEnabled: true,
			hasBlockingAgents: true,
			hasModelMentions: true,
			ircEnabled: true,
			routingPolicies: [
				{
					selector: "Example selector",
					model: "Example model",
					effort: "Example effort",
					boundary: "Example boundary",
				},
			],
		},
		consumerHints: ["packages/coding-agent/src/prompts/tools/task.md", "packages/coding-agent/src/task/index.ts"],
	},
	{
		id: "tools/todo.md",
		relPath: "tools/todo.md",
		bundled: asset370,
		scope: "tool:todo",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/tools/todo.md", "packages/coding-agent/src/tools/todo.ts"],
	},
	{
		id: "tools/tts.md",
		relPath: "tools/tts.md",
		bundled: asset371,
		scope: "tool:tts",
		group: "core",
		keys: [
			{ path: "localVoices", type: "string", required: true, resolution: "session-dependent" },
			{ path: "xaiVoices", type: "string", required: true, resolution: "session-dependent" },
			{ path: "maxLength", type: "string", required: true, resolution: "session-dependent" },
		],
		fixture: { localVoices: "Example localVoices", xaiVoices: "Example xaiVoices", maxLength: "Example maxLength" },
		consumerHints: ["packages/coding-agent/src/prompts/tools/tts.md", "packages/coding-agent/src/tools/tts.ts"],
	},
	{
		id: "tools/vibe-kill.md",
		relPath: "tools/vibe-kill.md",
		bundled: asset372,
		scope: "tool:vibe-kill",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/vibe-kill.md",
			"packages/coding-agent/src/tools/vibe.ts",
		],
	},
	{
		id: "tools/vibe-list.md",
		relPath: "tools/vibe-list.md",
		bundled: asset373,
		scope: "tool:vibe-list",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/vibe-list.md",
			"packages/coding-agent/src/tools/vibe.ts",
		],
	},
	{
		id: "tools/vibe-send.md",
		relPath: "tools/vibe-send.md",
		bundled: asset374,
		scope: "tool:vibe-send",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/vibe-send.md",
			"packages/coding-agent/src/tools/vibe.ts",
		],
	},
	{
		id: "tools/vibe-spawn.md",
		relPath: "tools/vibe-spawn.md",
		bundled: asset375,
		scope: "tool:vibe-spawn",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/vibe-spawn.md",
			"packages/coding-agent/src/tools/vibe.ts",
		],
	},
	{
		id: "tools/vibe-turn-result.md",
		relPath: "tools/vibe-turn-result.md",
		bundled: asset376,
		scope: "tool:vibe-turn-result",
		group: "core",
		keys: [
			{ path: "id", type: "string", required: true, resolution: "session-dependent" },
			{ path: "cli", type: "string", required: true, resolution: "session-dependent" },
			{ path: "turn", type: "number", required: true, resolution: "session-dependent" },
			{ path: "status", type: "string", required: true, resolution: "session-dependent" },
			{ path: "duration", type: "string", required: true, resolution: "session-dependent" },
			{ path: "requests", type: "string", required: true, resolution: "session-dependent" },
			{ path: "toolCount", type: "string", required: true, resolution: "session-dependent" },
			{ path: "model", type: "string", required: true, resolution: "session-dependent" },
			{ path: "trace", type: "unknown[]", required: true, resolution: "session-dependent" },
			{ path: "traceOverflow", type: "string", required: true, resolution: "session-dependent" },
			{ path: "response", type: "string", required: true, resolution: "session-dependent" },
			{ path: "responseTruncated", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "error", type: "string", required: true, resolution: "session-dependent" },
			{ path: "alive", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: {
			id: "example-1",
			cli: "Example cli",
			turn: 2,
			status: "Example status",
			duration: "Example duration",
			requests: "Example requests",
			toolCount: "Example toolCount",
			model: "Example model",
			trace: ["example"],
			traceOverflow: "Example traceOverflow",
			response: "Example response",
			responseTruncated: true,
			error: "Example error",
			alive: true,
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/vibe-turn-result.md",
			"packages/coding-agent/src/vibe/runtime.ts",
		],
	},
	{
		id: "tools/vibe-wait.md",
		relPath: "tools/vibe-wait.md",
		bundled: asset377,
		scope: "tool:vibe-wait",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/vibe-wait.md",
			"packages/coding-agent/src/tools/vibe.ts",
		],
	},
	{
		id: "tools/wait.md",
		relPath: "tools/wait.md",
		bundled: asset378,
		scope: "tool:wait",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/tools/wait.md", "packages/coding-agent/src/tools/wait.ts"],
	},
	{
		id: "tools/web-search.md",
		relPath: "tools/web-search.md",
		bundled: asset379,
		scope: "tool:web-search",
		group: "core",
		keys: [{ path: "xSearch", type: "boolean", required: false, resolution: "session-dependent" }],
		fixture: { xSearch: true },
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/web-search.md",
			"packages/coding-agent/src/web/search/index.ts",
		],
	},
	{
		id: "tools/workpool-batch.md",
		relPath: "tools/workpool-batch.md",
		bundled: asset380,
		scope: "tool:workpool-batch",
		group: "core",
		keys: [
			{ path: "pool", type: "string", required: true, resolution: "session-dependent" },
			{ path: "batch", type: "string", required: true, resolution: "session-dependent" },
			{
				path: "items",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "index", type: "number", required: true, resolution: "session-dependent" },
					{ path: "text", type: "string", required: true, resolution: "session-dependent" },
				],
			},
		],
		fixture: {
			pool: "Example pool",
			batch: "Example batch",
			items: [{ id: "example-1", index: 2, text: "Example text" }],
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/workpool-batch.md",
			"packages/coding-agent/src/task/workpool.ts",
		],
	},
	{
		id: "tools/workpool-turn-result.md",
		relPath: "tools/workpool-turn-result.md",
		bundled: asset381,
		scope: "tool:workpool-turn-result",
		group: "core",
		keys: [
			{ path: "pool", type: "string", required: true, resolution: "session-dependent" },
			{ path: "agent", type: "string", required: true, resolution: "session-dependent" },
			{ path: "batch", type: "string", required: true, resolution: "session-dependent" },
			{ path: "status", type: "string", required: true, resolution: "session-dependent" },
			{ path: "count", type: "number", required: true, resolution: "session-dependent" },
			{ path: "multiple", type: "boolean", required: true, resolution: "session-dependent" },
			{
				path: "items",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "status", type: "string", required: true, resolution: "session-dependent" },
					{ path: "text", type: "string", required: true, resolution: "session-dependent" },
				],
			},
			{ path: "output", type: "string", required: true, resolution: "session-dependent" },
			{ path: "remaining", type: "number", required: true, resolution: "session-dependent" },
		],
		fixture: {
			pool: "Example pool",
			agent: "Example agent",
			batch: "Example batch",
			status: "Example status",
			count: 2,
			multiple: true,
			items: [{ id: "example-1", status: "Example status", text: "Example text" }],
			output: "Example output",
			remaining: 2,
		},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/workpool-turn-result.md",
			"packages/coding-agent/src/task/workpool.ts",
		],
	},
	{
		id: "tools/write-device-only.md",
		relPath: "tools/write-device-only.md",
		bundled: asset382,
		scope: "tool:write-device-only",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/prompts/tools/write-device-only.md",
			"packages/coding-agent/src/tools/write.ts",
		],
	},
	{
		id: "tools/write.md",
		relPath: "tools/write.md",
		bundled: asset383,
		scope: "tool:write",
		group: "core",
		keys: [],
		fixture: {},
		consumerHints: ["packages/coding-agent/src/prompts/tools/write.md", "packages/coding-agent/src/tools/write.ts"],
	},
	{
		id: "tools/yield.md",
		relPath: "tools/yield.md",
		bundled: asset384,
		scope: "tool:yield",
		group: "core",
		keys: [
			{ path: "hasOutputSchema", type: "boolean", required: true, resolution: "session-dependent" },
			{ path: "workPoolItems", type: "boolean", required: true, resolution: "session-dependent" },
		],
		fixture: { hasOutputSchema: true, workPoolItems: true },
		consumerHints: ["packages/coding-agent/src/prompts/tools/yield.md", "packages/coding-agent/src/tools/yield.ts"],
	},
	{
		id: "work-contracts/block.md",
		relPath: "work-contracts/block.md",
		bundled: asset385,
		scope: "feature:work-contracts/block",
		group: "feature",
		keys: [
			{
				path: "clauses",
				type: "object[]",
				required: true,
				resolution: "session-dependent",
				children: [
					{ path: "id", type: "string", required: true, resolution: "session-dependent" },
					{ path: "text", type: "string", required: true, resolution: "session-dependent" },
					{ path: "active", type: "boolean", required: true, resolution: "session-dependent" },
					{
						path: "history",
						type: "object[]",
						required: true,
						resolution: "session-dependent",
						children: [
							{ path: "actor", type: "string", required: true, resolution: "session-dependent" },
							{ path: "at", type: "string", required: true, resolution: "session-dependent" },
							{ path: "turnId", type: "string|null", required: true, resolution: "session-dependent" },
							{ path: "toolCallId", type: "string", required: false, resolution: "session-dependent" },
						],
					},
					{
						path: "promotions",
						type: "object[]",
						required: true,
						resolution: "session-dependent",
						children: [{ path: "this", type: "string", required: true, resolution: "session-dependent" }],
					},
				],
			},
		],
		fixture: {
			clauses: [
				{
					id: "example-1",
					text: "Example text",
					active: true,
					history: [{ actor: "Example actor", at: "Example at", turnId: "example-1", toolCallId: "example-1" }],
					promotions: [{ this: "Example this" }],
				},
			],
		},
		consumerHints: [
			"packages/coding-agent/src/work-contracts/block.md",
			"packages/coding-agent/src/work-contracts/store.ts",
		],
	},
	{
		id: "work-contracts/tool.md",
		relPath: "work-contracts/tool.md",
		bundled: asset386,
		scope: "feature:work-contracts/tool",
		group: "feature",
		keys: [],
		fixture: {},
		consumerHints: [
			"packages/coding-agent/src/work-contracts/tool.md",
			"packages/coding-agent/src/work-contracts/index.ts",
		],
	},
];

const assetsById = new Map(
	promptAssets.flatMap(
		asset =>
			[
				[asset.id, asset],
				[asset.relPath, asset],
			] as const,
	),
);

export function getPromptAsset(id: string): PromptAsset | undefined {
	return assetsById.get(id);
}

/** Non-runtime corpora and provider protocol dialects are not override files in v1. */
export const promptAssetExclusions = [
	{
		path: "packages/ai/src/dialect/**/*.md",
		reason: "Provider wire dialects are deferred; changing them changes protocol serialization.",
	},
	{ path: "python/robomp/**", reason: "Python robotics prompts are outside the coding-agent runtime." },
	{ path: "research/**", reason: "Research corpora are input datasets, not shipped runtime prompt templates." },
	{
		path: "packages/coding-agent/CHANGELOG.md",
		reason: "Embedded release notes are product documentation, not a model prompt asset.",
	},
] as const;

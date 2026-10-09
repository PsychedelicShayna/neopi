/**
 * On-demand Auto effort classification. Replacement mode asks the dedicated
 * @effort role to choose directly among the resolved sparse candidates, using
 * the committed branch-safe diary and uncovered transcript. A singleton never
 * calls an LLM. Legacy mode retains the judge role's coarse local buckets and
 * ceiling/clamping behavior for explicitly opted-in configurations.
 *
 * Replacement mode classifies among the policy-resolved candidates using the
 * committed diary and transcript. A nonblank task `solutionSpace` replaces the
 * request as the sole classifier input. Legacy mode keeps its judge-role
 * question and local buckets. Failures are disclosed to session owners, which
 * select the lowest permitted candidate without expanding the allowed set.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { type ChoiceQuestion, Effort, type Model, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRegistry } from "../config/model-registry";
import { cfgEffortPolicyMode, resolveImplicitEffort } from "../config/effort-policy";
import bucketQuestionInstructions from "../prompts/system/auto-thinking-bucket-question.md" with { type: "text" };
import effortQuestionInstructions from "../prompts/system/auto-thinking-effort-question.md" with { type: "text" };
import levelQuestionTemplate from "../prompts/system/auto-thinking-level-question.md" with { type: "text" };
import solutionSpaceQuestionTemplate from "../prompts/system/auto-thinking-solution-space-question.md" with { type: "text" };
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveEffortJudge, resolveJudge, sharedJudgmentCache } from "../judgment";
import { clampAutoThinkingEffort } from "@oh-my-pi/pi-tui/thinking";
import { preprocessTinyMessage } from "../tiny/message-preproc";
import { readEffortContext, type EffortContextSession } from "./context";
import { prompt } from "@oh-my-pi/pi-utils";
import { cfgProvidersAutoThinkingMaxEffort } from "../session/settings";
type Level = "low" | "medium" | "high" | "xhigh" | "max";
type Bucket = "trivial" | "moderate" | "hard";

const LEVEL_EFFORT: Record<Level, Effort> = {
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

const BUCKET_EFFORT: Record<Bucket, Effort> = {
	trivial: Effort.Low,
	moderate: Effort.High,
	hard: Effort.XHigh,
};

/** Levels by how open-ended the problem is; shared by request and solution-space questions. */
const LEVEL_CRITERIA: Record<Exclude<Level, "max">, string> = {
	low: "One obvious solution, mechanically applied: target, mapping, or fix given.",
	medium: "A few candidates in a localized area, or one small trap: which line breaks a test, one boundary case.",
	high: "Several viable designs or candidate causes: API shape, policy choice, a known cause whose fix needs a design choice.",
	xhigh: "Open cause of flaky, concurrent, or stale behavior; solutions that are easy to get subtly wrong (races, invariants, cross-version compatibility).",
};

/** {@link LEVEL_CRITERIA} coarsened to the on-device buckets. */
const BUCKET_CRITERIA: Record<Bucket, string> = {
	trivial: LEVEL_CRITERIA.low,
	moderate: "A few candidate causes or several viable designs: which line breaks a test, API shape, policy choice.",
	hard: LEVEL_CRITERIA.xhigh,
};

const MAX_CRITERION =
	"Meets xhigh and at least one of: no reproduction to work from, irreversible or data-loss operation, or a live cutover that must stay correct while running. xhigh is required; difficulty alone is insufficient.";

/** Questions for one classification input kind: on-device bucket, full ladder, full ladder with `max`. */
interface QuestionSet {
	bucket: ChoiceQuestion<Bucket>;
	level: ChoiceQuestion<Exclude<Level, "max">>;
	/** Offers `max`; used only when the target model exposes that tier. */
	levelWithMax: ChoiceQuestion<Level>;
}

/**
 * Build the question set for one input kind. Only the instructions differ
 * between kinds; every kind shares {@link LEVEL_CRITERIA} and {@link BUCKET_CRITERIA}.
 */
function buildQuestionSet(levelTemplate: string, bucketInstructions: string): QuestionSet {
	return {
		bucket: { type: "choice", instructions: bucketInstructions, criteria: BUCKET_CRITERIA },
		level: { type: "choice", instructions: prompt.render(levelTemplate), criteria: LEVEL_CRITERIA },
		levelWithMax: {
			type: "choice",
			instructions: prompt.render(levelTemplate, { withMax: true }),
			criteria: { ...LEVEL_CRITERIA, max: MAX_CRITERION },
		},
	};
}

const REQUEST_QUESTIONS = buildQuestionSet(levelQuestionTemplate, bucketQuestionInstructions);
const SOLUTION_SPACE_QUESTIONS = buildQuestionSet(
	solutionSpaceQuestionTemplate,
	prompt.render(solutionSpaceQuestionTemplate),
);

/** The turn to classify. */
export interface DifficultyInput {
	/** The prompt text the agent is about to act on. */
	request: string;
	/**
	 * Delegator's description of how open-ended the subtask is (task `solutionSpace` field).
	 * When non-blank it replaces `request` as the sole classification input.
	 */
	solutionSpace?: string;
}

export interface ClassifyDifficultyDeps {
	settings: Settings;
	registry: ModelRegistry;
	model: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
	/** Policy-resolved sparse candidates for this selection, not an ordinal ceiling. */
	allowedEfforts?: readonly Effort[];
	sessionManager?: EffortContextSession;
	onContextFallback?: (reason: string) => void;
	onEffortDisclosure?: (message: string) => void;
	telemetry?: AgentTelemetryConfig;
}

/** Legacy-only configured ceiling, further limited by the target model. */
function autoEffortCeiling(deps: ClassifyDifficultyDeps): Effort {
	if (cfgProvidersAutoThinkingMaxEffort.get(deps.settings) !== Effort.Max) return Effort.XHigh;
	return getSupportedEfforts(deps.model).includes(Effort.Max) ? Effort.Max : Effort.XHigh;
}

/**
 * Classify `input` among this selection's allowed efforts. Legacy mode may
 * return undefined when the model has no controllable effort surface.
 * @throws when the backend cannot produce a usable classification.
 */
export async function classifyDifficulty(
	input: DifficultyInput,
	deps: ClassifyDifficultyDeps,
): Promise<Effort | undefined> {
	if (cfgEffortPolicyMode.get(deps.settings) === "replacement") {
		const supported = getSupportedEfforts(deps.model);
		const allowed =
			deps.allowedEfforts ?? resolveImplicitEffort(deps.settings, deps.model, { mode: "auto" }).candidates;
		const candidates = THINKING_EFFORTS.filter(effort => supported.includes(effort) && allowed.includes(effort));
		if (!candidates.length) {
			throw new Error(
				`No permitted Auto effort for ${deps.model.provider}/${deps.model.id}; supported: ${supported.join(", ") || "none"}; permitted: ${allowed.join(", ") || "none"}`,
			);
		}
		deps.signal?.throwIfAborted();
		if (candidates.length === 1) return candidates[0];
		const solutionSpace = input.solutionSpace?.trim();
		const state: Record<string, string> = solutionSpace
			? { solution_space: preprocessTinyMessage(solutionSpace) }
			: { request: await readEffortContext(input.request, deps.sessionManager, deps.onContextFallback) };
		deps.signal?.throwIfAborted();
		const criteria = Object.fromEntries(
			candidates.map(effort => [
				effort,
				effort === Effort.Minimal
					? "Simple lookup or mechanical edit requiring the least reasoning."
					: effort === Effort.Max
						? MAX_CRITERION
						: LEVEL_CRITERIA[effort as Exclude<Level, "max">],
			]),
		) as Record<Effort, string>;
		const question: ChoiceQuestion = {
			type: "choice",
			instructions: solutionSpace
				? prompt.render(solutionSpaceQuestionTemplate, { withMax: candidates.includes(Effort.Max) })
				: effortQuestionInstructions,
			criteria,
		};
		const judge = resolveEffortJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionId: deps.sessionId,
			purpose: "auto-thinking",
			metadataResolver: deps.metadataResolver,
			onUsage: deps.onUsage,
			onEffortDisclosure: deps.onEffortDisclosure,
		});
		const { answers } = await judge.judge({ state, questions: { effort: question } }, { signal: deps.signal });
		const chosen = answers.effort.choice as Effort;
		if (!candidates.includes(chosen)) throw new Error(`@effort returned an unpermitted level: ${chosen}`);
		return chosen;
	}
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionModel: deps.model,
		sessionId: deps.sessionId,
		metadataResolver: deps.metadataResolver,
		purpose: "auto-thinking",
		onUsage: deps.onUsage,
		telemetry: deps.telemetry,
		cache: sharedJudgmentCache(),
	});
	const solutionSpace = input.solutionSpace?.trim();
	const state: Record<string, string> = solutionSpace
		? { solution_space: preprocessTinyMessage(solutionSpace) }
		: { request: preprocessTinyMessage(input.request) };
	const questions = solutionSpace ? SOLUTION_SPACE_QUESTIONS : REQUEST_QUESTIONS;
	const options = { signal: deps.signal };
	const classified = await judge.withCandidate(async (candidate, kind) => {
		// The 3-bucket local question cannot select `max`, so its ceiling stays at
		// XHigh whatever the setting says — otherwise a sparse ladder would snap its
		// `hard` bucket up to a tier it never chose.
		if (kind === "local") {
			const { answers } = await candidate.judge({ state, questions: { bucket: questions.bucket } }, options);
			return { effort: BUCKET_EFFORT[answers.bucket.choice], ceiling: Effort.XHigh };
		}
		const ceiling = autoEffortCeiling(deps);
		const level = ceiling === Effort.Max ? questions.levelWithMax : questions.level;
		const { answers } = await candidate.judge({ state, questions: { level } }, options);
		return { effort: LEVEL_EFFORT[answers.level.choice], ceiling };
	}, options);
	// The successful branch's ceiling goes into the clamp itself: capping the
	// request alone is not enough, because a sparse ladder snaps an excluded
	// request back up.
	return clampAutoThinkingEffort(deps.model, classified.effort, classified.ceiling);
}

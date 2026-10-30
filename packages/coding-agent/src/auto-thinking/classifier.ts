import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
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
import { type ChoiceQuestion, Effort, judgeQuestions, type Model, renderQuestion } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts, getSupportedThinkingLevels } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ThinkingEffort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelRegistry } from "../config/model-registry";
import { cfgEffortPolicyMode, resolveImplicitEffort } from "../config/effort-policy";
import bundledEffortQuestionInstructions from "../prompts/system/auto-thinking-effort-question.md" with { type: "text" };
import minimalCriterion from "../prompts/system/auto-thinking-minimal-criterion.md" with { type: "text" };
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveEffortJudge, resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/auto-thinking.json" with { type: "json" };
import { clampAutoThinkingEffort } from "@oh-my-pi/pi-tui/thinking";
import { preprocessTinyMessage } from "../tiny/message-preproc";
import { readEffortContext, type EffortContextSession } from "./context";

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

/**
 * The on-device bucket question, the effort ladder (levels by how open-ended
 * the problem is, `max` last), and the solution-space instructions, which
 * reuse the ladder's levels.
 */
const QUESTIONS = judgeQuestions(questionFile);

/** Questions for one classification input kind: on-device bucket, full ladder, full ladder with `max`. */
interface QuestionSet {
	bucket: ChoiceQuestion<Bucket>;
	level: ChoiceQuestion<Exclude<Level, "max">>;
	/** Offers `max`; used only when the target model exposes that tier. */
	levelWithMax: ChoiceQuestion<Level>;
}

/**
 * Build the question set for one input kind. Only the instructions differ
 * between kinds; every kind shares the ladder's levels and the bucket criteria.
 */
function buildQuestionSet(instructions: string, bucketInstructions: string): QuestionSet {
	const ladder: ChoiceQuestion<Level> = { ...QUESTIONS.level, instructions };
	const { max: _max, ...levels } = ladder.criteria;
	return {
		bucket: { ...QUESTIONS.bucket, instructions: bucketInstructions },
		level: { ...renderQuestion(ladder, {}), criteria: levels },
		levelWithMax: renderQuestion(ladder, { withMax: true }),
	};
}

function isLevel(label: string): label is Level {
	return Object.hasOwn(LEVEL_EFFORT, label);
}

/** The ladder question narrowed to the levels the target model supports. */
interface SupportedLevelQuestion {
	question: ChoiceQuestion;
	levels: Level[];
}

/** Keep the judge's choices aligned with the effort surface the target can use. */
function filterSupportedLevels(
	question: ChoiceQuestion<Level> | ChoiceQuestion<Exclude<Level, "max">>,
	model: Model,
): SupportedLevelQuestion {
	const supported = getSupportedEfforts(model);
	const criteria: Record<string, string | null> = {};
	const levels: Level[] = [];
	for (const [label, rubric] of Object.entries(question.criteria)) {
		if (!isLevel(label) || !supported.includes(LEVEL_EFFORT[label])) continue;
		criteria[label] = rubric;
		levels.push(label);
	}
	return { question: { ...question, criteria }, levels };
}

const REQUEST_QUESTIONS = buildQuestionSet(QUESTIONS.level.instructions, QUESTIONS.bucket.instructions);
const SOLUTION_SPACE_QUESTIONS = buildQuestionSet(
	QUESTIONS.solutionSpace.instructions,
	renderQuestion(QUESTIONS.solutionSpace, {}).instructions,
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
	allowedEfforts?: readonly ThinkingEffort[];
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
): Promise<ThinkingEffort | undefined> {
	if (cfgEffortPolicyMode.get(deps.settings) === "replacement") {
		const supported = getSupportedThinkingLevels(deps.model);
		const allowed =
			deps.allowedEfforts ?? resolveImplicitEffort(deps.settings, deps.model, { mode: "auto" }).candidates;
		const candidates = supported.filter(effort => allowed.includes(effort));
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
				effort === "off"
					? QUESTIONS.off.criteria.off
					: effort === Effort.Minimal
						? resolvePromptAsset("system/auto-thinking-minimal-criterion.md", minimalCriterion, {
								cwd: deps.sessionManager?.getCwd?.(),
							}).text.trim()
						: QUESTIONS.level.criteria[effort as Level],
			]),
		) as Record<ThinkingEffort, string>;
		const question: ChoiceQuestion = {
			type: "choice",
			instructions: solutionSpace
				? renderQuestion(QUESTIONS.solutionSpace, { withMax: candidates.includes(Effort.Max) }).instructions
				: resolvePromptAsset("system/auto-thinking-effort-question.md", bundledEffortQuestionInstructions, {
						cwd: deps.sessionManager?.getCwd?.(),
					}).text,
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
		const chosen = answers.effort.choice as ThinkingEffort;
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
	const ceiling = autoEffortCeiling(deps);
	const level = filterSupportedLevels(ceiling === Effort.Max ? questions.levelWithMax : questions.level, deps.model);
	const [onlyLevel, ...otherLevels] = level.levels;
	// One eligible tier below Max is the answer every candidate reaches (the local
	// bucket clamps into the same pool), so it needs no judge and no judge credential.
	if (onlyLevel !== undefined && otherLevels.length === 0 && onlyLevel !== "max") return LEVEL_EFFORT[onlyLevel];
	// With no online tier, every candidate lands in the same place: the local
	// bucket's XHigh-capped pool, which is empty (`["max"]`) or holds only a
	// sub-Low tier (`["minimal"]`).
	if (onlyLevel === undefined) return clampAutoThinkingEffort(deps.model, Effort.Low, Effort.XHigh);
	const classified = await judge.withCandidate(async (candidate, kind) => {
		// The 3-bucket local question cannot select `max`, so its ceiling stays at
		// XHigh whatever the setting says — otherwise a sparse ladder would snap its
		// `hard` bucket up to a tier it never chose.
		if (kind === "local") {
			const { answers } = await candidate.judge({ state, questions: { bucket: questions.bucket } }, options);
			return { effort: BUCKET_EFFORT[answers.bucket.choice], ceiling: Effort.XHigh };
		}
		if (otherLevels.length === 0) return { effort: LEVEL_EFFORT[onlyLevel], ceiling };
		const { answers } = await candidate.judge({ state, questions: { level: level.question } }, options);
		const chosen = level.levels.find(label => label === answers.level.choice);
		if (chosen === undefined) {
			throw new Error(`auto-thinking: judge chose unsupported level "${answers.level.choice}"`);
		}
		return { effort: LEVEL_EFFORT[chosen], ceiling };
	}, options);
	// Local bucket choices are unfiltered and may fall below every supported tier.
	// Passing the ceiling prevents snapping upward into an excluded tier.
	return clampAutoThinkingEffort(deps.model, classified.effort, classified.ceiling);
}

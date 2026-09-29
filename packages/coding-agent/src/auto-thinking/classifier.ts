/**
 * On-demand Auto effort classification. Replacement mode asks the dedicated
 * @effort role to choose directly among the resolved sparse candidates, using
 * the committed branch-safe diary and uncovered transcript. A singleton never
 * calls an LLM. Legacy mode retains the judge role's coarse local buckets and
 * ceiling/clamping behavior for explicitly opted-in configurations.
 *
 * Throws on failure; session owners disclose it and select the lowest
 * permitted candidate without extending the allowed set.
 */
import { type ChoiceQuestion, Effort, type Model, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRegistry } from "../config/model-registry";
import { cfgEffortPolicyMode, resolveImplicitEffort } from "../config/effort-policy";
import bucketQuestionInstructions from "../prompts/system/auto-thinking-bucket-question.md" with { type: "text" };
import effortQuestionInstructions from "../prompts/system/auto-thinking-effort-question.md" with { type: "text" };
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveEffortJudge, resolveJudge } from "../judgment";
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

const LEVEL_CRITERIA: Record<Exclude<Level, "max">, string> = {
	low: "Trivial or mechanical: rename, typo, one-line edit, formatting tweak, direct factual question, obvious solution.",
	medium:
		"Localized change needing reasoning: small self-contained feature, straightforward one-place bug fix, explain moderate code.",
	high: "Non-trivial: multiple files or callers, real debugging, moderate design decision, refactor with several moving parts.",
	xhigh: "Deep or open-ended: subtle concurrency or algorithmic problem, cross-system reasoning, ambiguous requirements, large or risky refactor, hard root-cause debugging.",
};

const MAX_CRITERION =
	"Meets xhigh and at least one of: no reproduction to work from, irreversible or data-loss operation, or a live cutover that must stay correct while running. xhigh is required; difficulty alone is insufficient.";

/** Full-ladder question up to `xhigh`. */
const LEVEL_QUESTION: ChoiceQuestion<Exclude<Level, "max">> = {
	type: "choice",
	instructions:
		"The state is a user's request to a coding agent. Choose the reasoning effort this turn needs, judging inherent task difficulty rather than phrasing politeness or verbosity. If torn between levels, choose the lower one.",
	criteria: LEVEL_CRITERIA,
};

/** Full-ladder question offering `max`; used only when the target model exposes that tier. */
const LEVEL_QUESTION_WITH_MAX: ChoiceQuestion<Level> = {
	type: "choice",
	instructions:
		"The state is a user's request to a coding agent. Choose the reasoning effort this turn needs, judging inherent task difficulty rather than phrasing politeness or verbosity. If torn between levels, choose the lower one, except between xhigh and max: a request meeting the max conditions takes max.",
	criteria: { ...LEVEL_CRITERIA, max: MAX_CRITERION },
};

/** Coarse 3-bucket question for on-device models. */
const BUCKET_QUESTION: ChoiceQuestion<Bucket> = {
	type: "choice",
	instructions: bucketQuestionInstructions,
	criteria: {
		trivial: "Obvious, mechanical, or a direct question: rename, typo, one-liner, simple lookup.",
		moderate: "A real localized task: small feature, normal bug fix, code explanation.",
		hard: "Deep, multi-file, ambiguous, or tricky debugging or design.",
	},
};

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
}

/** Legacy-only configured ceiling, further limited by the target model. */
function autoEffortCeiling(deps: ClassifyDifficultyDeps): Effort {
	if (cfgProvidersAutoThinkingMaxEffort.get(deps.settings) !== Effort.Max) return Effort.XHigh;
	return getSupportedEfforts(deps.model).includes(Effort.Max) ? Effort.Max : Effort.XHigh;
}

/**
 * Classify `promptText` among this selection's allowed efforts.
 * Legacy mode may return undefined when no controllable level exists.
 * @throws when the backend cannot produce a usable classification.
 */
export async function classifyDifficulty(
	promptText: string,
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
		const state = { request: await readEffortContext(promptText, deps.sessionManager, deps.onContextFallback) };
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
		const question: ChoiceQuestion = { type: "choice", instructions: effortQuestionInstructions, criteria };
		const judge = resolveEffortJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionId: deps.sessionId,
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
		onUsage: deps.onUsage,
	});
	const state = { request: preprocessTinyMessage(promptText) };
	const options = { signal: deps.signal };
	const classified = await judge.withCandidate(async (candidate, kind) => {
		// The 3-bucket local question cannot select `max`, so its ceiling stays at
		// XHigh whatever the setting says — otherwise a sparse ladder would snap its
		// `hard` bucket up to a tier it never chose.
		if (kind === "local") {
			const { answers } = await candidate.judge({ state, questions: { bucket: BUCKET_QUESTION } }, options);
			return { effort: BUCKET_EFFORT[answers.bucket.choice], ceiling: Effort.XHigh };
		}
		const ceiling = autoEffortCeiling(deps);
		const level = ceiling === Effort.Max ? LEVEL_QUESTION_WITH_MAX : LEVEL_QUESTION;
		const { answers } = await candidate.judge({ state, questions: { level } }, options);
		return { effort: LEVEL_EFFORT[answers.level.choice], ceiling };
	}, options);
	// The successful branch's ceiling goes into the clamp itself: capping the
	// request alone is not enough, because a sparse ladder snaps an excluded
	// request back up.
	return clampAutoThinkingEffort(deps.model, classified.effort, classified.ceiling);
}

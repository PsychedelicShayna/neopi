import type { ChoiceAnswer, ChoiceQuestion, NoulQuestion } from "@oh-my-pi/pi-ai/judgment";
import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	mixtureEdgeId,
	type MixtureDecision,
	type MixtureEdge,
	type RouteCondition,
	type TerminateCondition,
} from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { truncateToTokens } from "./budget";

export function decisionState(
	parts: Record<string, string | undefined>,
	cap: number,
	tokenizer: Tokenizer,
): Record<string, string> {
	const state: Record<string, string> = {};
	for (const [name, value] of Object.entries(parts)) {
		if (value !== undefined) state[name] = truncateToTokens(value, cap, tokenizer);
	}
	return state;
}

export function routeQuestion(route: RouteCondition, edges: readonly MixtureEdge[]): ChoiceQuestion {
	return {
		type: "choice",
		instructions: route.instructions,
		criteria: Object.fromEntries(edges.map(edge => [mixtureEdgeId(edge), edge.when ?? null])),
	};
}

export function terminateQuestion(terminate: TerminateCondition): NoulQuestion {
	return { type: "noul", instructions: terminate.instructions, criteria: terminate.criteria };
}

export function describeOutcome(
	decision: Pick<MixtureDecision, "kind" | "answer" | "confidence" | "judgeKind">,
	extra: { fallbackTo?: string; floor?: number; failed?: true } = {},
): string {
	const { answer, confidence = 0, judgeKind } = decision;
	if (decision.kind === "route") {
		if (extra.failed) return `fallback → ${extra.fallbackTo} (judgment failed)`;
		if (extra.fallbackTo)
			return `fallback → ${extra.fallbackTo} (${confidence.toFixed(2)} < ${(extra.floor ?? 0).toFixed(2)})`;
		if (answer.type !== "choice") throw new Error("route judgment did not return a choice");
		return judgeKind === "native"
			? `→ ${answer.choice} ${confidence.toFixed(2)}`
			: `→ ${answer.choice} (floor inactive)`;
	}
	if (decision.kind === "terminate") {
		if (answer.type !== "noul") throw new Error("termination judgment did not return a probability");
		return `${answer.noul >= (extra.floor ?? 0.5) ? "yes" : "no"} ${answer.noul.toFixed(2)}`;
	}
	if (answer.type === "noul") return `${answer.noul >= 0.5 ? "yes" : "no"} ${answer.noul.toFixed(2)}`;
	return `${answer.type === "choice" ? answer.choice : String(answer.score)} ${confidence.toFixed(2)}`;
}

export function failedChoice(labels: readonly string[]): ChoiceAnswer {
	return {
		type: "choice",
		choice: "",
		probabilities: Object.fromEntries(labels.map(label => [label, 0])),
		confidence: 0,
	};
}

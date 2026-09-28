/**
 * The single seam between the caller's stream options and a member's request.
 * What is preserved, recomputed, and dropped is explicit: the caller's loop
 * spreads its whole config into the options, so anything not named here stays
 * with the outer call.
 */
import type { ProviderSessionState, SimpleStreamOptions, ToolChoice } from "@oh-my-pi/pi-ai";
import { resetAccountScopedProviderSessionState } from "@oh-my-pi/pi-ai/provider-session-state";
import type { MixtureRunEntry } from "./run-store";
import type { MixtureHost, MixtureRun, OuterStreamOptions, ResolvedModelMember, ToolRequirement } from "./types";

/** Normalize every `ToolChoice` shape into a requirement on the outer response. */
export function normalizeToolChoice(choice: ToolChoice | undefined): ToolRequirement | { unsupported: string } {
	if (choice === undefined || choice === "auto") return { kind: "optional" };
	if (choice === "none") return { kind: "none" };
	if (choice === "any" || choice === "required") return { kind: "any" };
	if (choice.type === "tool") return { kind: "named", name: choice.name };
	if (choice.type === "function") {
		return { kind: "named", name: "function" in choice ? choice.function.name : choice.name };
	}
	return { unsupported: choice.type };
}

/** The provider-session namespace of one member: conversation, mixture, lineage, member. */
export function memberSessionId(run: MixtureRun, memberId: string): string {
	return `${run.key.conversation}:${run.key.mixture}:${run.key.lineage.join("/")}:${memberId}`;
}

function memberProviderState(entry: MixtureRunEntry, memberId: string): Map<string, ProviderSessionState> {
	let state = entry.providerState.get(memberId);
	if (!state) {
		state = new Map();
		entry.providerState.set(memberId, state);
	}
	return state;
}

export function prepareMemberCall(
	outer: OuterStreamOptions,
	run: MixtureRun,
	member: ResolvedModelMember,
	host: MixtureHost,
	entry: MixtureRunEntry,
): SimpleStreamOptions {
	const sessionId = memberSessionId(run, member.id);
	const providerSessionState = memberProviderState(entry, member.id);
	const options: SimpleStreamOptions = {
		// Preserved from the caller.
		signal: outer.signal,
		fetch: outer.fetch,
		onPayload: outer.onPayload,
		onResponse: outer.onResponse,
		onSseEvent: outer.onSseEvent,
		disableReasoning: outer.disableReasoning,
		forceReasoningOff: outer.forceReasoningOff,
		temperature: outer.temperature,
		topP: outer.topP,
		topK: outer.topK,
		minP: outer.minP,
		presencePenalty: outer.presencePenalty,
		repetitionPenalty: outer.repetitionPenalty,
		frequencyPenalty: outer.frequencyPenalty,
		stopSequences: outer.stopSequences,
		thinkingBudgets: outer.thinkingBudgets,
		hideThinkingSummary: outer.hideThinkingSummary,
		maxRetryDelayMs: outer.maxRetryDelayMs,
		streamFirstEventTimeoutMs: outer.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: outer.streamIdleTimeoutMs,
		cursorExternalToolExecutor: outer.cursorExternalToolExecutor,
		// Recomputed per member.
		apiKey: host.resolver(member.model, sessionId, () =>
			resetAccountScopedProviderSessionState(providerSessionState),
		),
		sessionId,
		promptCacheKey: sessionId,
		providerSessionState,
		metadata: outer.metadataResolver?.(member.model.provider) ?? outer.metadata,
		reasoning: member.effort ?? outer.reasoning,
		maxTokens: member.maxTokens ?? outer.maxTokens,
	};
	if (member.reasoningOff) options.disableReasoning = true;
	return options;
}

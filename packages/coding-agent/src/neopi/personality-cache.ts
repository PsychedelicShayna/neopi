import { getEffectiveTokenCost } from "@oh-my-pi/pi-catalog/models";
import type { AgentSession } from "../session/agent-session";

/** An observed cache can have expired; this is an upper bound, not a billing promise. */
export interface PersonalityCacheImpact {
	tokens?: number;
	apiEquivalentUsd?: number;
}

/** Compare the actual candidate prompt and use only the latest matching response's cache evidence. */
export async function personalityCacheImpact(
	session: AgentSession,
	prompt: string,
): Promise<PersonalityCacheImpact | undefined> {
	const model = session.model;
	if (!model) return undefined;
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (
			message.role !== "assistant" ||
			message.provider !== model.provider ||
			message.model !== model.id ||
			message.stopReason === "error"
		)
			continue;
		const tokens = message.usage.cacheRead + message.usage.cacheWrite;
		const rates = getEffectiveTokenCost(model.cost);
		// Some providers do not report cache creation. A known caching capability
		// or discounted cache rate warrants a warning even when usage is unknown.
		if (tokens <= 0 && !model.promptCache && !(rates.cacheRead > 0 && rates.cacheRead < rates.input))
			return undefined;
		const candidate = await session.previewPersonalityPrompt(prompt);
		const active = session.baseSystemPrompt;
		if (candidate.length === active.length && candidate.every((block, blockIndex) => block === active[blockIndex]))
			return undefined;
		if (tokens <= 0) return {};
		const miss = rates.cacheWrite > 0 ? rates.cacheWrite : rates.input;
		const priced = miss > 0 || rates.cacheRead > 0;
		return {
			tokens,
			apiEquivalentUsd: priced ? (Math.max(0, miss - rates.cacheRead) * tokens) / 1_000_000 : undefined,
		};
	}
	return undefined;
}

export function describePersonalityCacheImpact(impact: PersonalityCacheImpact): string {
	if (impact.tokens === undefined)
		return "Changing the system prompt may invalidate a provider cache. The previous response did not report a cached token count, so the impact and cost are unknown. Continue?";
	const cost =
		impact.apiEquivalentUsd === undefined
			? "API-equivalent cost unavailable"
			: `up to about $${impact.apiEquivalentUsd.toFixed(4)} in API-equivalent rates`;
	return `Changing the system prompt may invalidate up to ${impact.tokens.toLocaleString()} previously cached tokens (${cost}). The cache may already have expired. Continue?`;
}

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { formatModelStringWithRouting } from "../config/model-resolver";
import type { AgentSessionHandle } from "../session/agent-session-handle";

/** Current session configuration, not the request already in flight or its launch settings. */
export interface LiveSubagentFacts {
	resolvedModel?: string;
	resolvedModelIdentity?: string;
	resolvedThinkingLevel?: ThinkingLevel;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
}

export function getLiveSubagentFacts(session: AgentSessionHandle): LiveSubagentFacts | undefined {
	const model = session.model;
	if (!model) return undefined;
	const resolvedModelIdentity = formatModelStringWithRouting(model);
	const resolvedThinkingLevel = session.thinkingLevel;
	return {
		resolvedModelIdentity,
		resolvedModel: resolvedModelIdentity
			? formatModelSelectorValue(resolvedModelIdentity, resolvedThinkingLevel)
			: undefined,
		resolvedThinkingLevel,
		fastModeEnabled: session.isFastModeEnabled(),
		fastModeActive: session.isFastModeActive(),
	};
}

/** Compact model-visible suffix shared by task and agent listings. */
export function describeSubagentFacts(facts: {
	resolvedModel?: string;
	resolvedModelIdentity?: string;
	resolvedThinkingLevel?: string;
	fastModeEnabled?: boolean;
	fastModeActive?: boolean;
}): string {
	const parts: string[] = [];
	const identity = facts.resolvedModelIdentity ?? facts.resolvedModel;
	if (identity) parts.push(`model=${identity}`);
	if (facts.resolvedThinkingLevel !== undefined) parts.push(`effort=${facts.resolvedThinkingLevel}`);
	if (facts.fastModeEnabled !== undefined) parts.push(`fast=${facts.fastModeEnabled ? "on" : "off"}`);
	if (facts.fastModeActive !== undefined) parts.push(`fast-active=${facts.fastModeActive}`);
	return parts.length ? ` [${parts.join(" ")}]` : "";
}

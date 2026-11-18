import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { resolveSessionModelSelector } from "../config/session-model-selector";
import { isLocalAgentSession, type AgentSessionHandle } from "../session/agent-session-handle";
import { FAST_USAGE, runFastCommand } from "../session/fast-command";

export interface SubagentModelSelection {
	selector?: string;
	provider?: string;
	modelId?: string;
}

export type SubagentModelSelectionResult =
	| {
			ok: true;
			data: { provider: string; modelId: string; thinkingLevel: ThinkingLevel | undefined; warning?: string };
	  }
	| { ok: false; message: string };

/** Apply an exact supported selection without silently clamping a captured task effort cap. */
export async function setSubagentThinkingLevel(
	session: AgentSessionHandle,
	level: ThinkingLevel,
): Promise<string | undefined> {
	if (!isLocalAgentSession(session)) return session.setSubagentThinkingLevel(level);
	const selectable = session.getAvailableEffortSelectors();
	const available: ThinkingLevel[] = [
		ThinkingLevel.Off,
		...session.getAvailableThinkingLevels().filter(candidate => selectable.includes(candidate)),
	];
	if (!available.includes(level)) {
		return `Unsupported thinking level ${JSON.stringify(level)}. Available levels: ${available.join(", ")}.`;
	}
	// persist=false skips global defaults, not the session's thinking_level_change journal entry.
	session.setThinkingLevel(level);
	return undefined;
}

export async function cycleSubagentThinkingLevel(
	session: AgentSessionHandle,
): Promise<ConfiguredThinkingLevel | undefined> {
	if (!isLocalAgentSession(session)) return session.cycleSubagentThinkingLevel();
	return session.cycleThinkingLevel();
}

/**
 * Session-only model switch for one subagent, applied from its next request. Like the focused `/switch`,
 * a role-configured `:level` for the model wins over the current level when no level is given.
 */
export async function setSubagentModel(
	session: AgentSessionHandle,
	model: Model,
	thinkingLevel?: ConfiguredThinkingLevel,
): Promise<void> {
	if (!isLocalAgentSession(session)) return session.setSubagentModel(model, thinkingLevel);
	await session.setModelTemporary(model, thinkingLevel ?? session.resolveTemporaryModelThinkingLevel(model));
}

/** Session-only tier mutation; enabled and actually active remain separate session facts. */
export async function setSubagentFast(session: AgentSessionHandle, enabled: boolean): Promise<boolean> {
	if (!isLocalAgentSession(session)) return session.setSubagentFast(enabled);
	return session.setFastMode(enabled);
}

export async function runSubagentFastCommand(session: AgentSessionHandle, args: string): Promise<string> {
	if (!isLocalAgentSession(session)) return session.runSubagentFastCommand(args);
	const result = runFastCommand(args.trim().toLowerCase(), session);
	if (!result) throw new Error(FAST_USAGE);
	if (!result.success) throw new Error(result.message);
	return result.message;
}

/** Resolve and apply against the child's own catalog, role configuration and scope on its home thread. */
export async function selectSubagentModel(
	session: AgentSessionHandle,
	selection: SubagentModelSelection,
): Promise<SubagentModelSelectionResult> {
	if (!isLocalAgentSession(session)) return session.selectSubagentModel(selection);
	const { selector, provider, modelId } = selection;
	let model: Model | undefined;
	let thinkingLevel: ConfiguredThinkingLevel | undefined;
	let warning: string | undefined;
	if (selector === undefined) {
		const find = () =>
			session.getAvailableModels().find(model => model.provider === provider && model.id === modelId);
		model = find();
		if (!model) {
			await session.modelRegistry.awaitBackgroundRefresh();
			model = find();
		}
		if (!model) return { ok: false, message: `Model not found: ${provider}/${modelId}` };
	} else {
		const select = () => resolveSessionModelSelector(selector, session, session.settings);
		let resolved = select();
		if (!resolved.model) {
			await session.modelRegistry.awaitBackgroundRefresh();
			resolved = select();
		}
		if (!resolved.model) return { ok: false, message: resolved.error ?? `Unknown model: ${selector}` };
		model = resolved.model;
		thinkingLevel = resolved.thinkingLevel;
		warning = resolved.warning;
	}
	await setSubagentModel(session, model, thinkingLevel);
	const applied = session.model ?? model;
	return {
		ok: true,
		data: {
			provider: applied.provider,
			modelId: applied.id,
			thinkingLevel: session.thinkingLevel,
			...(warning ? { warning } : {}),
		},
	};
}

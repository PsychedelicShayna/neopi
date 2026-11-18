import type { AgentAdvisor, InlineAgentAdvisor } from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";
import { listNamedAdvisors } from "../advisor/config";
import { type AgentAdvisorSelection, resolveAgentAdvisorRolePattern, resolveAgentAdvisorSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { expandAtImports } from "../discovery/at-imports";

/** Explicit definitions replace catalog discovery for this spawn only; no catalog is written. */
export async function resolveSpawnAdvisorConfig(selection: AgentAdvisorSelection | undefined, cwd: string, agentDir?: string, sessionDir?: string): Promise<InlineAgentAdvisor[] | undefined> {
	const definition = selection?.definition;
	if (!definition) return undefined;
	if ("inline" in definition) return [structuredClone(definition.inline)];
	const advisors = await listNamedAdvisors(cwd, agentDir, sessionDir);
	const match = advisors.findLast(advisor => advisor.name === definition.ref && (!definition.scope || advisor.scope === definition.scope));
	if (!match) throw new Error(`Unknown advisor '${definition.ref}'${definition.scope ? ` in ${definition.scope}` : ""}`);
	const config = structuredClone(match.config);
	config.instructions = config.instructions?.trim()
		? (await expandAtImports(config.instructions, match.sourcePath)).trim() || undefined
		: undefined;
	return [{ ...config, scope: "all" }];
}

export function agentAdvisorDeliveryOverrides(configs: readonly InlineAgentAdvisor[] | undefined): Record<string, "on-yield" | "next-tool-call"> {
	return Object.fromEntries(Object.entries(configs?.[0]?.delivery ?? {}).map(([severity, timing]) => [`advisor.delivery.${severity}`, timing]));
}

export interface AgentAdvisorSpawnConfig {
	advisorConfigs?: readonly InlineAgentAdvisor[];
	settingsOverrides: Readonly<Record<string, unknown>>;
	/** Expanded selection retained by both warm and cold revival. */
	persistedAdvisor?: string;
}

/** Build the advisor portion of a child launch, without creating or registering a session. */
export async function buildAgentAdvisorSpawnConfig(options: {
	advisor?: AgentAdvisor;
	settingsOverride?: string;
	settings: Settings;
	cwd: string;
	agentDir?: string;
	sessionDir?: string;
}): Promise<AgentAdvisorSpawnConfig> {
	const selection = resolveAgentAdvisorSelection({ agentAdvisor: options.advisor, settingsOverride: options.settingsOverride });
	if (!selection) return { settingsOverrides: {} };
	const rolePattern = selection.model ? resolveAgentAdvisorRolePattern(selection.model, options.settings) : undefined;
	const advisorConfigs = await resolveSpawnAdvisorConfig(selection, options.cwd, options.agentDir, options.sessionDir);
	return {
		advisorConfigs,
		persistedAdvisor: rolePattern ?? "on",
		settingsOverrides: {
			"advisor.enabled": true,
			...agentAdvisorDeliveryOverrides(advisorConfigs),
			...(rolePattern ? { modelRoles: { ...options.settings.getModelRoles(), advisor: rolePattern } } : {}),
		},
	};
}

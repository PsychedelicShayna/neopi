import type { AgentAdvisor, InlineAgentAdvisor } from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";
import type { AdvisorConfigScope } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { listNamedAdvisors, parseInlineAdvisorConfig } from "../advisor/config";
import { type AgentAdvisorSelection, resolveAgentAdvisorRolePattern, resolveAgentAdvisorSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { expandAtImports } from "../discovery/at-imports";

export function parseAgentAdvisor(value: unknown): AgentAdvisor | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (["true", "on", "yes"].includes(trimmed.toLowerCase())) return true;
		if (["false", "off", "no"].includes(trimmed.toLowerCase())) return false;
		return trimmed || undefined;
	}
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("Advisor must be a boolean, model selector, named reference or inline definition");
	if ("ref" in value && "inline" in value) throw new Error("Advisor cannot be both a reference and inline");
	if ("ref" in value) {
		if (typeof value.ref !== "string" || !value.ref.trim()) throw new Error("Advisor reference requires a name");
		const scope = "scope" in value ? value.scope : undefined;
		if (scope !== undefined && !["user", "project", "project-omp", "session"].includes(String(scope))) throw new Error("Invalid advisor reference scope");
		return { ref: value.ref.trim(), ...(scope !== undefined ? { scope: scope as AdvisorConfigScope } : {}) };
	}
	if (!("inline" in value) || !value.inline || typeof value.inline !== "object" || Array.isArray(value.inline)) throw new Error("Advisor object requires ref or inline");
	const inline: InlineAgentAdvisor = parseInlineAdvisorConfig({ name: "advisor", ...value.inline });
	if ("delivery" in value.inline && value.inline.delivery !== undefined) {
		const delivery = value.inline.delivery;
		if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) throw new Error("Advisor delivery must map severities to timings");
		inline.delivery = {};
		for (const [severity, timing] of Object.entries(delivery)) {
			if (!["nit", "concern", "blocker"].includes(severity) || !["on-yield", "next-tool-call"].includes(String(timing))) throw new Error(`Invalid advisor delivery: ${severity}`);
			inline.delivery[severity as "nit" | "concern" | "blocker"] = timing as "on-yield" | "next-tool-call";
		}
	}
	return { inline };
}

/** Explicit definitions replace catalog discovery for this spawn only; no catalog is written. */
export async function resolveSpawnAdvisorConfig(selection: AgentAdvisorSelection | undefined, cwd: string, agentDir?: string, sessionDir?: string): Promise<InlineAgentAdvisor[] | undefined> {
	const definition = selection?.definition;
	if (!definition) return undefined;
	if ("inline" in definition) return [structuredClone(definition.inline)];
	const advisors = await listNamedAdvisors(cwd, agentDir, sessionDir);
	const match = advisors.findLast(advisor => advisor.name === definition.ref && (!definition.scope || advisor.scope === definition.scope));
	if (!match) throw new Error(`Unknown advisor '${definition.ref}'${definition.scope ? ` in ${definition.scope}` : ""}`);
	const config = structuredClone(match.config);
	if (config.instructions?.trim()) config.instructions = (await expandAtImports(config.instructions, match.sourcePath)).trim() || undefined;
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

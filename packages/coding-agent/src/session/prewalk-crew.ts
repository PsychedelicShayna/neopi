import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import {
	disabledProviderIds,
	expandRoleAlias,
	getModelMatchPreferences,
	resolveCliModel,
	resolveConfiguredModelPatterns,
} from "../config/model-resolver";
import type { ModelRoleLookup } from "@oh-my-pi/pi-tui/overlays/model-browser";
import type { Settings } from "../config/settings";
import type { Prewalk } from "./agent-session-types";
import {
	cfgPrewalkExecution,
	cfgPrewalkExecutionFallbacks,
	cfgPrewalkPlanner,
	cfgPrewalkPlannerFallbacks,
} from "./settings";

export type PrewalkPhase = "planner" | "execution";

/** Expand every role's fallback chain before advancing to the next selector. */
export function getPrewalkPatterns(
	settings: Settings,
	phase: PrewalkPhase,
	override?: string,
	roleLookup: ModelRoleLookup = settings,
): string[] {
	const primary =
		override ?? (phase === "planner" ? cfgPrewalkPlanner.get(settings) : cfgPrewalkExecution.get(settings));
	const fallbacks =
		phase === "planner" ? cfgPrewalkPlannerFallbacks.get(settings) : cfgPrewalkExecutionFallbacks.get(settings);
	return [primary, ...fallbacks].flatMap(selector => {
		const trimmed = selector.trim();
		if (!trimmed) return [];
		// The historic bare default selector is supported alongside @role aliases.
		const value = trimmed === "default" ? expandRoleAlias(trimmed, roleLookup) : trimmed;
		const patterns = resolveConfiguredModelPatterns(value, roleLookup);
		return patterns.length ? patterns : [value];
	});
}

/** Live settings changes use the already-discovered catalog, never an implicit provider fallback. */
export function resolvePrewalkCrewSelection(
	settings: Settings,
	registry: ModelRegistry,
	phase: PrewalkPhase,
	override?: string,
	availableModels?: Model[],
): Prewalk | undefined {
	const disabled = disabledProviderIds(settings);
	const preferences = getModelMatchPreferences(settings);
	for (const pattern of getPrewalkPatterns(settings, phase, override)) {
		const resolved = resolveCliModel({
			cliModel: pattern,
			modelRegistry: registry,
			availableModels: availableModels?.length ? availableModels : undefined,
			settings,
			preferences,
		});
		if (resolved.model && !disabled.has(resolved.model.provider) && registry.hasConfiguredAuth(resolved.model)) {
			return { target: resolved.model, thinkingLevel: resolved.thinkingLevel };
		}
	}
	return undefined;
}

export function describePrewalkCrew(planner: Prewalk, execution: Prewalk): string {
	const describe = ({ target, thinkingLevel }: Prewalk): string =>
		`${target.provider}/${target.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`;
	return `Prewalk crew: plan ${describe(planner)} → execute ${describe(execution)}.`;
}

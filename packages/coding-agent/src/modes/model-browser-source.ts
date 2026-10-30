import { type Model, resolveModelServiceTier, type ServiceTier, shouldSendServiceTier } from "@oh-my-pi/pi-ai";
import type { ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { findActiveModelPreset, getModelPresetNames } from "../config/model-presets";
import { formatModelStringWithRouting, resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import { buildServiceTierByFamily } from "../config/service-tier";
import type { Settings } from "../config/settings";
import {
	cfgEffortPolicyMode,
	cfgEffortRules,
	cfgFallbackEffortSelections,
	matchEffortRule,
} from "../config/effort-policy";
import { getSupportedThinkingLevels } from "@oh-my-pi/pi-catalog/model-thinking";
import { describeModelCompactionPoint, resolveEffectiveContextWindow } from "../session/model-compaction-threshold";
import { cfgContextRules } from "../config/context-policy";
import { cfgCompactionThresholdTokens } from "../session/context-settings";

import {
	cfgCycleOrder,
	cfgDisabledProviders,
	cfgModelProviderOrder,
	cfgModelRoleStorage,
} from "../config/model-settings";
import {
	cfgDefaultThinkingLevel,
	cfgRetryFallbackChains,
	cfgTierAnthropic,
	cfgTierGoogle,
	cfgTierOpenai,
} from "../session/settings";

/**
 * Supply live model-overlay preferences and runtime resolution from the host.
 * @param settings - Settings backing preferences, roles, and model perf
 * @param sessionServiceTier - The live session's effective tier for a model
 *   (`/fast`, `/fast ultra`, `/slow`, resumed tiers). Omit only where no session
 *   exists; the configured `tier.*` settings stand in then.
 */
export function createModelBrowserSource(
	settings: Settings,
	sessionServiceTier?: (model: Model) => ServiceTier | undefined,
): ModelHubSource {
	return {
		get revision() {
			return settings.revision;
		},
		get defaultThinkingLevel() {
			return cfgDefaultThinkingLevel.get(settings);
		},
		get modelProviderOrder() {
			return cfgModelProviderOrder.get(settings);
		},
		get knownRoleIds() {
			return getKnownRoleIds(settings);
		},
		get mruOrder() {
			return settings.getStorage()?.getModelUsageOrder() ?? [];
		},
		get modelPerf() {
			return settings.getStorage()?.getModelPerf() ?? new Map();
		},
		serviceTierFor: model => {
			const tier = sessionServiceTier
				? sessionServiceTier(model)
				: resolveModelServiceTier(
						buildServiceTierByFamily(
							cfgTierOpenai.get(settings),
							cfgTierAnthropic.get(settings),
							cfgTierGoogle.get(settings),
						),
						model,
					);
			// Label only a tier the request carries as `service_tier`: that is what the
			// provider echoes back as the served tier, which keys the perf row.
			return shouldSendServiceTier(tier, model) ? tier : undefined;
		},
		get disabledProviders() {
			return cfgDisabledProviders.get(settings);
		},
		get fallbackChains() {
			return cfgRetryFallbackChains.get(settings);
		},
		get modelRoleStorage() {
			return cfgModelRoleStorage.get(settings);
		},
		get cycleOrder() {
			return cfgCycleOrder.get(settings);
		},
		get effortRules() {
			return cfgEffortRules.get(settings);
		},
		get contextRules() {
			return cfgContextRules.get(settings);
		},
		effectiveContextWindowFor: model => resolveEffectiveContextWindow(settings, model),
		permittedEfforts: model => {
			const rule =
				cfgEffortPolicyMode.get(settings) === "replacement" ? matchEffortRule(settings, model) : undefined;
			return getSupportedThinkingLevels(model).filter(effort => !rule || rule.allowed.includes(effort));
		},
		getProjectRoleEffortSelection: role => settings.getProjectRoleEffortSelection(role),
		getGlobalRoleEffortSelection: role => settings.getGlobalRoleEffortSelection(role),
		getRoleEffortSelection: role => settings.getRoleEffortSelection(role),
		getRoleTokenBudget: role => settings.getRoleSetting(role, cfgCompactionThresholdTokens),
		getFallbackEffortSelection: (role, selector) => cfgFallbackEffortSelections.get(settings)[role]?.[selector],
		getModelRole: role => settings.getModelRole(role),
		getProjectModelRole: role => settings.getProjectModelRole(role),
		getGlobalModelRole: role => settings.getGlobalModelRole(role),
		getModelRoleSource: role => settings.getModelRoleSource(role),
		formatModelSelector: formatModelStringWithRouting,
		getRoleInfo: role => getRoleInfo(role, settings),
		defaultRoleChain: role => rolePriorityDefaults(role),
		resolveRoleValue: (value, models, roleLookup) => resolveModelRoleValue(value, models, { settings, roleLookup }),
		getModelPresets: () => ({ names: getModelPresetNames(settings), active: findActiveModelPreset(settings) }),
		compactionPointFor: model => describeModelCompactionPoint(settings, model),
	};
}

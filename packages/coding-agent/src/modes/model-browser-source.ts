import type { ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { formatModelStringWithRouting, resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import {
	cfgEffortPolicyMode,
	cfgEffortRules,
	cfgFallbackEffortSelections,
	matchEffortRule,
} from "../config/effort-policy";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";

import {
	cfgCycleOrder,
	cfgDisabledProviders,
	cfgModelProviderOrder,
	cfgModelRoleStorage,
} from "../config/model-settings";
import { cfgDefaultThinkingLevel, cfgRetryFallbackChains } from "../session/settings";

/** Supply live model-overlay preferences and runtime resolution from the host. */
export function createModelBrowserSource(settings: Settings): ModelHubSource {
	return {
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
		permittedEfforts: model => {
			const rule =
				cfgEffortPolicyMode.get(settings) === "replacement" ? matchEffortRule(settings, model) : undefined;
			return getSupportedEfforts(model).filter(effort => !rule || rule.allowed.includes(effort));
		},
		getProjectRoleEffortSelection: role => settings.getProjectRoleEffortSelection(role),
		getGlobalRoleEffortSelection: role => settings.getGlobalRoleEffortSelection(role),
		getRoleEffortSelection: role => settings.getRoleEffortSelection(role),
		getFallbackEffortSelection: (role, selector) => cfgFallbackEffortSelections.get(settings)[role]?.[selector],
		getModelRole: role => settings.getModelRole(role),
		getProjectModelRole: role => settings.getProjectModelRole(role),
		getGlobalModelRole: role => settings.getGlobalModelRole(role),
		getModelRoleSource: role => settings.getModelRoleSource(role),
		formatModelSelector: formatModelStringWithRouting,
		getRoleInfo: role => getRoleInfo(role, settings),
		defaultRoleChain: role => rolePriorityDefaults(role),
		resolveRoleValue: (value, models, roleLookup) => resolveModelRoleValue(value, models, { settings, roleLookup }),
	};
}

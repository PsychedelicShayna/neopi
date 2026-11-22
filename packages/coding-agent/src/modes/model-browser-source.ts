import { type Model, resolveModelServiceTier, type ServiceTier, shouldSendServiceTier } from "@oh-my-pi/pi-ai";
import type { ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { SETTINGS_FILE_SCOPES } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { findActiveModelPreset, getModelPresetNames } from "../config/model-presets";
import { formatModelStringWithRouting, resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import { buildServiceTierByFamily } from "../config/service-tier";
import type { Settings, SettingsScope } from "../config/settings";
import { cfgRoleSettings, type RoleSettings } from "../config/role-settings";
import {
	cfgEffortPolicyMode,
	cfgEffortRules,
	cfgFallbackEffortSelections,
	matchEffortRule,
} from "../config/effort-policy";
import { getSupportedThinkingLevels } from "@oh-my-pi/pi-catalog/model-thinking";
import { describeModelCompactionPoint, resolveEffectiveContextWindow } from "../session/model-compaction-threshold";
import { cfgContextRules } from "../config/context-policy";
import type { ModelRegistry } from "../config/model-registry";
import { cfgModelVariants, MODEL_VARIANT_FIELDS, type ModelVariantDefinition } from "../config/model-variant-settings";
import { cfgCompactionThresholdTokens } from "../session/context-settings";

import {
	cfgCatalogProviderStalenessMinutes,
	cfgCycleOrder,
	cfgDisabledProviders,
	cfgModelFolders,
	cfgModelProviderOrder,
	cfgNewModelTierDays,
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
	initialEditingScope?: SettingsScope,
	variantRegistry?: Pick<ModelRegistry, "find">,
): ModelHubSource {
	let editingScope = initialEditingScope;
	const readVariants = (scope: SettingsScope): ModelVariantDefinition[] =>
		(settings.readScopeValue(cfgModelVariants, scope) as ModelVariantDefinition[] | undefined) ?? [];
	const persistVariants = async (scope: SettingsScope, variants: ModelVariantDefinition[]) => {
		const receipt = await settings.persistWithReceipt(() =>
			settings.writeScopeValue(cfgModelVariants, variants.length > 0 ? variants : undefined, scope),
		);
		if (receipt.status === "conflict") throw new Error(`Model Variants changed concurrently in ${scope} settings`);
	};
	const resolveFolders = () =>
		settings.resolveFileScopeValue(cfgModelFolders, editingScope === "global" ? "global" : "project");
	return {
		get editingScope() {
			return editingScope;
		},
		modelFolders: {
			get entries() {
				return resolveFolders().value as typeof cfgModelFolders.default;
			},
			save(folders) {
				const scope = editingScope === "project" || resolveFolders().source === "project" ? "project" : "global";
				settings.writeScopeValue(cfgModelFolders, folders, scope);
			},
		},
		get newModelTierDays() {
			return cfgNewModelTierDays.get(settings);
		},
		cycleScope: initialEditingScope
			? () => {
					const scopes = SETTINGS_FILE_SCOPES;
					editingScope = scopes[(scopes.indexOf(editingScope ?? initialEditingScope) + 1) % scopes.length];
				}
			: undefined,
		getRoleScopeNote: role => {
			if (editingScope === undefined) return undefined;
			const details = settings.getModelRoleScopeDetails(role, editingScope);
			return details.shadowed
				? `${editingScope} · shadowed by ${details.winner}: ${String(details.effective ?? "inherit")}`
				: `${editingScope} · effective ${details.winner}: ${String(details.effective ?? "inherit")}`;
		},
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
		get providerRefreshStalenessMs() {
			return cfgCatalogProviderStalenessMinutes.get(settings) * 60_000;
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
		get modelVariants() {
			return variantRegistry && editingScope ? readVariants(editingScope) : undefined;
		},
		modelVariantFields: variantRegistry ? MODEL_VARIANT_FIELDS : undefined,
		onSaveModelVariant: variantRegistry
			? async draft => {
					const scope = editingScope;
					if (!scope) throw new Error("Select a scope to save a Model Variant");
					const name = draft.name.trim();
					const baseSelector = draft.baseModel.trim();
					const slash = baseSelector.indexOf("/");
					const base =
						slash > 0
							? variantRegistry.find(baseSelector.slice(0, slash), baseSelector.slice(slash + 1))
							: undefined;
					if (!base || base.variant) throw new Error("Choose an ordinary base model for this Model Variant");
					await settings.reloadFromDisk();
					const scoped = readVariants(scope);
					if (draft.id && !scoped.some(entry => entry.id === draft.id)) {
						throw new Error(`The Model Variant no longer exists in ${scope} settings`);
					}
					if (
						cfgModelVariants
							.get(settings)
							.some(entry => entry.id !== draft.id && entry.name.toLowerCase() === name.toLowerCase())
					) {
						throw new Error(`A Model Variant named ${name} already exists`);
					}
					const next: ModelVariantDefinition = {
						id: draft.id ?? `variant--${crypto.randomUUID()}`,
						name,
						baseModel: `${base.provider}/${base.id}`,
						overrides: draft.overrides,
					};
					await persistVariants(
						scope,
						draft.id ? scoped.map(entry => (entry.id === draft.id ? next : entry)) : [...scoped, next],
					);
				}
			: undefined,
		onDeleteModelVariant: variantRegistry
			? async id => {
					const scope = editingScope;
					if (!scope) throw new Error("Select a scope to delete a Model Variant");
					await settings.reloadFromDisk();
					const scoped = readVariants(scope);
					const next = scoped.filter(entry => entry.id !== id);
					if (next.length !== scoped.length) await persistVariants(scope, next);
				}
			: undefined,
		effectiveContextWindowFor: model => resolveEffectiveContextWindow(settings, model),
		permittedEfforts: model => {
			const rule =
				cfgEffortPolicyMode.get(settings) === "replacement" ? matchEffortRule(settings, model) : undefined;
			return getSupportedThinkingLevels(model).filter(effort => !rule || rule.allowed.includes(effort));
		},
		getProjectRoleEffortSelection: role => settings.getProjectRoleEffortSelection(role),
		getGlobalRoleEffortSelection: role => settings.getGlobalRoleEffortSelection(role),
		getRoleEffortSelection: role =>
			editingScope === "session"
				? settings.getSessionRoleEffortSelection(role)
				: editingScope === "project"
					? settings.getProjectRoleEffortSelection(role)
					: editingScope === "global"
						? settings.getGlobalRoleEffortSelection(role)
						: settings.getRoleEffortSelection(role),
		getRoleTokenBudget: role => {
			if (!editingScope) return settings.getRoleSetting(role, cfgCompactionThresholdTokens);
			const entries = settings.readScopeValue(cfgRoleSettings, editingScope) as RoleSettings | undefined;
			const value = entries?.[role]?.[cfgCompactionThresholdTokens.id];
			return typeof value === "number" ? value : undefined;
		},
		getFallbackEffortSelection: (role, selector) => cfgFallbackEffortSelections.get(settings)[role]?.[selector],
		getModelRole: role =>
			editingScope === "session"
				? settings.getSessionModelRole(role)
				: editingScope === "project"
					? settings.getProjectModelRole(role)
					: editingScope === "global"
						? settings.getGlobalModelRole(role)
						: settings.getModelRole(role),
		getSessionModelRole: role => settings.getSessionModelRole(role),
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

import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { Effort, ThinkingEffort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelIdentity } from "@oh-my-pi/pi-catalog/compat/types";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	AUTO_THINKING,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	type ConfiguredThinkingLevel,
} from "@oh-my-pi/pi-tui/thinking";
import {
	findRetryFallbackCandidates,
	formatRetryFallbackSelector,
	getFallbackEffortSelection,
	getRetryFallbackChains,
	resolveRetryFallbackChainKey,
	type RetryFallbackResolutionContext,
} from "../session/retry-fallback-chains";
import {
	cfgDefaultThinkingLevel,
	cfgProvidersAutoThinkingMaxEffort,
	cfgRetryFallbackChains,
} from "../session/settings";
import type { ToolSession } from "../tools";
import {
	cfgEffortPolicyMode,
	cfgEffortRules,
	cfgFallbackEffortSelections,
	cfgRoleEffortSelections,
	EffortPolicyError,
	resolveImplicitEffort,
	type EffortOrigin,
	type EffortRule,
	type EffortSelection,
} from "./effort-policy";
import type { ModelFactResolution } from "./model-facts";
import type { ModelRegistry } from "./model-registry";
import {
	formatModelString,
	formatModelStringWithRouting,
	extractExplicitThinkingSelector,
	getModelMatchPreferences,
	parseModelPattern,
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	resolveModelRoleValue,
} from "./model-resolver";
import { formatModelRoleAlias, getKnownRoleIds, getRoleInfo } from "./model-roles";
import type { AnySetting } from "./registry";
import { isGlobSelectorPattern, isRegexSelectorPattern } from "./selector-pattern";
import type { SettingProvenance, Settings } from "./settings";

export interface ModelInfoSettingSource {
	setting: string;
	layer: SettingProvenance;
	/** Record settings report the containing setting's layer, not a per-key owner. */
	scope: "setting";
}

export interface ModelInfoEffortDecision {
	candidates: readonly ThinkingEffort[];
	resolvedLevel?: ThinkingLevel;
	rule?: EffortRule;
	disclosure?: string;
	error?: string;
}

export interface ModelInfoEffort {
	/** Declared capability, never filtered by implicit policy. Check supportedStatus before treating it as authoritative. */
	supported: readonly Effort[];
	supportedStatus: "authoritative" | "unverified" | "unavailable";
	supportedProvenance?: ModelFactResolution["provenance"]["efforts"];
	policyMode: "replacement" | "legacy";
	implicit: ModelInfoEffortDecision;
	configured: ModelInfoEffortDecision & {
		level?: ConfiguredThinkingLevel;
		origin: EffortOrigin;
		selection?: EffortSelection;
	};
	explicitOverride: {
		suffix?: ConfiguredThinkingLevel;
		/** Concrete caller/manual suffixes bypass implicit rules, not capability checks. */
		bypassesImplicitRules: boolean;
		requiresSupportedLevel: true;
	};
	provenance: ModelInfoSettingSource[];
}

export type ModelInfoReasoning =
	| { status: "observed"; level: ThinkingLevel }
	| { status: "pending-auto" | "not-observed" | "not-run" };

export interface ModelInfoRole {
	name: string;
	configuredOverrideApplied: boolean;
	configuredSelector?: string;
	projectSelector?: string;
	globalSelector?: string;
	selectorProvenance: SettingProvenance;
	patterns: string[];
	resolvedSelector?: string;
	available: boolean;
	effortSelection?: EffortSelection;
	projectEffortSelection?: EffortSelection;
	globalEffortSelection?: EffortSelection;
	effortSettingProvenance: ModelInfoSettingSource;
}

export interface ModelInfoFallbackAlternative {
	selector: string;
	resolvedSelector?: string;
	available: boolean;
	selection?: EffortSelection;
	effort?: ModelInfoEffort;
	reasoning: { status: "not-run" };
}

export interface ModelInfoFallbacks {
	chainKey?: string;
	configuredSelectors: string[];
	alternatives: ModelInfoFallbackAlternative[];
	provenance: ModelInfoSettingSource[];
}

export interface ModelInfoEntry {
	selector: string;
	provider: string;
	id: string;
	name: string;
	identity: ModelIdentity;
	identityProvenance: { kind: "catalog"; rules: string };
	available: boolean;
	description: { status: "unknown" };
	quality: { status: "unknown" };
	technical: {
		api: Api;
		cost: Model<Api>["cost"] | null;
		contextWindow: number | null;
		maxTokens: number | null;
		input: Model<Api>["input"] | null;
		reasoning: boolean | null;
	};
	facts: {
		status: "resolved" | "unavailable";
		provenance: ModelFactResolution["provenance"];
		issues: readonly string[];
	};
	effort: ModelInfoEffort;
	reasoning: ModelInfoReasoning;
	fallbacks: ModelInfoFallbacks;
	roles: ModelInfoRole[];
}

export interface ModelInfoLookup {
	selector: string;
	kind: "current" | "role" | "model";
	selected: string;
	matchCount: number;
	truncated: boolean;
	limit: number;
	models: ModelInfoEntry[];
	role?: ModelInfoRole;
}

const MODEL_INFO_LIMIT = 25;

function settingSource(settings: Settings, setting: AnySetting): ModelInfoSettingSource {
	return { setting: setting.id, layer: settings.getProvenance(setting), scope: "setting" };
}

function selectionForLevel(level: ConfiguredThinkingLevel | undefined): EffortSelection | undefined {
	if (level === AUTO_THINKING) return { mode: "auto" };
	if (level === ThinkingLevel.Inherit) return { mode: "inherit" };
	return level === undefined ? undefined : { mode: "fixed", level };
}

function effortDecision(
	settings: Settings,
	model: Model,
	selection?: EffortSelection,
	origin: EffortOrigin = "default",
): ModelInfoEffortDecision {
	try {
		const decision = resolveImplicitEffort(settings, model, selection, origin);
		return {
			candidates: decision.candidates,
			resolvedLevel: decision.level,
			rule: decision.rule,
			disclosure: decision.disclosure,
		};
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return { candidates: error instanceof EffortPolicyError ? error.permitted : [], error: error.message };
	}
}

function modelEffort(
	settings: Settings,
	model: Model,
	resolution: ModelFactResolution | undefined,
	level: ConfiguredThinkingLevel | undefined,
	origin: EffortOrigin,
	selection?: EffortSelection,
	suffix?: ConfiguredThinkingLevel,
): ModelInfoEffort {
	const effectiveSelection = selection ?? selectionForLevel(level);
	return {
		supported: !resolution || model.thinking?.unverified ? [] : getSupportedEfforts(model),
		supportedStatus: model.thinking?.unverified
			? "unverified"
			: resolution && (resolution.provenance.efforts !== undefined || (model.thinking?.efforts.length ?? 0) > 0)
				? "authoritative"
				: "unavailable",
		supportedProvenance: resolution?.provenance.efforts,
		policyMode: cfgEffortPolicyMode.get(settings),
		implicit: effortDecision(settings, model),
		configured: {
			...effortDecision(settings, model, effectiveSelection, origin),
			level,
			origin,
			selection: effectiveSelection,
		},
		explicitOverride: {
			suffix,
			bypassesImplicitRules:
				effectiveSelection?.mode === "fixed" &&
				effectiveSelection.level !== ThinkingLevel.Inherit &&
				(origin === "caller" || origin === "manual"),
			requiresSupportedLevel: true,
		},
		provenance: [cfgEffortPolicyMode, cfgEffortRules, cfgDefaultThinkingLevel, cfgProvidersAutoThinkingMaxEffort].map(
			setting => settingSource(settings, setting),
		),
	};
}

function roleInfo(role: string, settings: Settings, available: Model<Api>[]): ModelInfoRole {
	const selector = formatModelRoleAlias(role);
	const resolved = resolveModelRoleValue(selector, available.filter(getRoleInfo(role, settings).accepts), {
		settings,
	});
	return {
		name: role,
		configuredSelector: settings.getModelRole(role),
		projectSelector: settings.getProjectModelRole(role),
		globalSelector: settings.getGlobalModelRole(role),
		configuredOverrideApplied: settings.getModelRole(role) !== undefined && resolved.model !== undefined,
		selectorProvenance: settings.getModelRoleProvenance(role),
		patterns: resolveConfiguredModelPatterns(selector, settings),
		resolvedSelector: resolved.model ? formatModelStringWithRouting(resolved.model) : undefined,
		available: resolved.model !== undefined,
		effortSelection: settings.getRoleEffortSelection(role),
		projectEffortSelection: settings.getProjectRoleEffortSelection(role),
		globalEffortSelection: settings.getGlobalRoleEffortSelection(role),
		effortSettingProvenance: settingSource(settings, cfgRoleEffortSelections),
	};
}

function fallbackInfo(
	model: Model<Api>,
	level: ConfiguredThinkingLevel | undefined,
	role: string | undefined,
	settings: Settings,
	registry: ModelRegistry,
	available: Model<Api>[],
): ModelInfoFallbacks {
	const context: RetryFallbackResolutionContext = {
		chains: getRetryFallbackChains(settings),
		getModelRole: name => settings.getModelRole(name),
		// Resolution must not make a credential-ineligible model look runnable.
		modelLookup: {
			find: (provider, id) => registry.find(provider, id),
			hasProvider: provider => registry.hasProvider(provider),
			getAll: () => available,
		},
	};
	const selector = formatRetryFallbackSelector(model, concreteThinkingLevel(level));
	const chainKey = resolveRetryFallbackChainKey(context, selector, model, role);
	const alternatives =
		chainKey === undefined
			? []
			: findRetryFallbackCandidates(context, chainKey, selector, model, { allowMissingPrimary: true });
	return {
		chainKey,
		configuredSelectors: chainKey === undefined ? [] : (context.chains[chainKey] ?? []),
		alternatives: alternatives.map(candidate => {
			const row = registry.find(candidate.provider, candidate.id);
			const resolution = row ? registry.getModelFactResolution(row.provider, row.id) : undefined;
			const resolved = resolution?.model ?? row;
			const selection =
				chainKey === undefined ? undefined : getFallbackEffortSelection(settings, chainKey, candidate);
			const suffix = resolved ? parseModelPattern(candidate.raw, [resolved]).thinkingLevel : candidate.thinkingLevel;
			const level =
				selection?.mode === "auto"
					? AUTO_THINKING
					: selection?.mode === "fixed"
						? selection.level
						: selection?.mode === "inherit"
							? ThinkingLevel.Inherit
							: suffix;
			return {
				selector: candidate.raw,
				resolvedSelector: resolved ? formatModelStringWithRouting(resolved) : undefined,
				available: available.some(model => model.provider === candidate.provider && model.id === candidate.id),
				selection,
				effort: resolved
					? modelEffort(settings, resolved, resolution, level, "fallback", selection, suffix)
					: undefined,
				reasoning: { status: "not-run" as const },
			};
		}),
		provenance: [
			settingSource(settings, cfgRetryFallbackChains),
			settingSource(settings, cfgFallbackEffortSelections),
		],
	};
}

/** Read the live registry and settings without discovering providers or changing selections. */
export async function lookupModelInfo(selector: string, session: ToolSession): Promise<ModelInfoLookup> {
	const registry = session.modelRegistry;
	if (!registry) throw new Error("Model information is unavailable: this session has no model registry.");
	await registry.awaitBackgroundRefresh();
	const settings = session.settings;
	const available = registry.getAvailable("all");
	const normalized = selector.trim();
	const current = normalized === "" || normalized === "current";
	const role = current || normalized === "*" ? undefined : resolveExplicitModelRole(normalized, settings);
	if (!current && normalized.startsWith("@") && !role) throw new Error(`Unknown model role: ${normalized}`);
	const roleMetadata = role ? roleInfo(role, settings, available) : undefined;
	const pool = role ? available.filter(getRoleInfo(role, settings).accepts) : available;
	const preferences = getModelMatchPreferences(settings);
	const active = current ? session.getActiveModel?.() : undefined;
	const requested = current ? (session.getActiveModelString?.() ?? session.getModelString?.()) : normalized;
	const roleResolution = role
		? resolveModelRoleValue(normalized, pool, { settings, matchPreferences: preferences })
		: undefined;
	const resolved = roleResolution ?? (requested ? parseModelPattern(requested, pool, preferences) : undefined);
	const selected = active ?? resolved?.model;
	if (!selected) {
		throw new Error(
			current ? "No active session model is available." : `No available model matches selector: ${normalized}`,
		);
	}
	if (resolved?.warning) throw new Error(resolved.warning);
	const patterns = current ? [] : role ? resolveConfiguredModelPatterns(normalized, settings) : [normalized];
	const pattern = patterns[roleResolution?.matchedPatternIndex ?? 0];
	const parsed = pattern
		? parseModelPattern(pattern, pool, preferences, { allowInvalidThinkingSelectorFallback: false })
		: undefined;
	let matches: Model<Api>[] = [selected];
	if (!current && !role) {
		const glob = isGlobSelectorPattern(normalized);
		if (glob || isRegexSelectorPattern(normalized)) {
			matches = pool.filter(row => {
				const match = parseModelPattern(normalized, [row], preferences);
				return (
					match.model !== undefined && (!glob || match.explicitThinkingLevel === resolved?.explicitThinkingLevel)
				);
			});
		} else if (!/[/:@]/.test(normalized)) {
			const query = normalized.toLowerCase();
			if (selected.id.toLowerCase() !== query && !(selected.variant && selected.name.toLowerCase() === query)) {
				const candidates = pool.filter(
					row => row.id.toLowerCase().includes(query) || row.name.toLowerCase().includes(query),
				);
				// Aliases that resolve without a substring match are still single-model lookups.
				if (candidates.includes(selected)) matches = candidates;
			}
		}
		matches.sort((a, b) => {
			const left = formatModelString(a);
			const right = formatModelString(b);
			return left < right ? -1 : left > right ? 1 : 0;
		});
	}
	const matchCount = matches.length;
	const roles = getKnownRoleIds(settings).map(name => roleInfo(name, settings, available));
	const liveEffort = current ? session.getActiveEffort?.() : undefined;
	const actual = current ? session.getActualThinkingLevel?.() : undefined;
	const callerSuffix = !current && role ? extractExplicitThinkingSelector(normalized) : undefined;
	const models = matches.slice(0, MODEL_INFO_LIMIT).map(row => {
		const resolution = registry.getModelFactResolution(row.provider, row.id);
		const model = resolution?.model ?? row;
		const raw = pattern
			? parseModelPattern(pattern, [row], preferences, { allowInvalidThinkingSelectorFallback: false })
			: undefined;
		const suffix = raw?.explicitThinkingLevel
			? raw.thinkingLevel
			: parsed?.explicitThinkingLevel
				? parsed.thinkingLevel
				: undefined;
		const selection =
			liveEffort?.selection ??
			(role && callerSuffix === undefined ? settings.getRoleEffortSelection(role) : undefined);
		const level = liveEffort
			? liveEffort.level
			: (callerSuffix ??
				(selection?.mode === "auto"
					? AUTO_THINKING
					: selection?.mode === "fixed"
						? selection.level
						: selection?.mode === "inherit"
							? ThinkingLevel.Inherit
							: (suffix ?? parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings)))));
		const origin: EffortOrigin =
			liveEffort?.origin ??
			(callerSuffix !== undefined ? "caller" : role ? "role" : suffix !== undefined ? "caller" : "default");
		const reasoning: ModelInfoReasoning = !current
			? { status: "not-run" }
			: actual !== undefined && actual !== ThinkingLevel.Inherit
				? { status: "observed", level: actual }
				: level === AUTO_THINKING
					? { status: "pending-auto" }
					: { status: "not-observed" };
		return {
			selector: formatModelStringWithRouting(row),
			provider: model.provider,
			id: model.id,
			name: model.name,
			identity: model.identity,
			identityProvenance: { kind: "catalog" as const, rules: "packages/catalog/src/compat/rules/" },
			available: available.some(candidate => candidate.provider === row.provider && candidate.id === row.id),
			description: { status: "unknown" as const },
			quality: { status: "unknown" as const },
			technical: {
				api: model.api,
				cost: resolution?.provenance.cost ? model.cost : null,
				contextWindow: resolution?.provenance.contextWindow ? model.contextWindow : null,
				maxTokens: resolution?.provenance.maxTokens ? model.maxTokens : null,
				input: resolution?.provenance.input ? model.input : null,
				reasoning: resolution?.provenance.reasoning ? model.reasoning : null,
			},
			facts: {
				status: resolution ? ("resolved" as const) : ("unavailable" as const),
				provenance: resolution?.provenance ?? {},
				issues: resolution?.issues ?? [],
			},
			effort: modelEffort(settings, model, resolution, level, origin, selection, callerSuffix ?? suffix),
			reasoning,
			fallbacks: fallbackInfo(
				row,
				current && actual !== undefined ? actual : level,
				role,
				settings,
				registry,
				available,
			),
			roles: roles.filter(info => info.resolvedSelector === formatModelStringWithRouting(row)),
		};
	});
	return {
		selector: normalized || "current",
		kind: current ? "current" : role ? "role" : "model",
		selected: formatModelStringWithRouting(selected),
		matchCount,
		truncated: matchCount > MODEL_INFO_LIMIT,
		limit: MODEL_INFO_LIMIT,
		models,
		role: roleMetadata,
	};
}

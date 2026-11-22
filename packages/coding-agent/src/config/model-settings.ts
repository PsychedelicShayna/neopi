/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, effect, operatorValue, type SettingValueOf } from "./registry";
import type { AuthAccountPolicies } from "@oh-my-pi/pi-ai/auth-storage";
import { setUnpausedProviders } from "@oh-my-pi/pi-ai/oauth";
import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import type { cfgDefaultThinkingLevel } from "../session/settings";
import type { HubModelFolder } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { validateModelFolderRules } from "@oh-my-pi/pi-tui/overlays/model-folder-rules";

/** Display metadata for one model tag. */
export interface ModelTagDef {
	name: string;
	description?: string;
	color?: string;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

/** Model tags keyed by tag id (`modelTags`). */
export type ModelTagsSettings = Record<string, ModelTagDef>;

/**
 * One saved model preset (`modelPresets.<name>`): the role assignments and default thinking level
 * captured by `/modelpreset save` or the model hub, re-applied as a whole by `/modelpreset switch`.
 */
export interface ModelPreset {
	modelRoles: Record<string, string>;
	/** `defaultThinkingLevel` at save time; absent in hand-written presets that leave it alone. */
	defaultThinkingLevel?: SettingValueOf<typeof cfgDefaultThinkingLevel>;
}

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_STRING_RECORD: Record<string, string> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const EMPTY_MODEL_PRESETS_RECORD: Record<string, ModelPreset> = {};
const EMPTY_AUTH_ACCOUNT_POLICIES: AuthAccountPolicies = [];

// Auth broker — credentials proxied through a remote `npi auth-broker serve`
// host. Hidden from the UI; populate via env vars or hand-edited config.yml. Env takes
// precedence so per-machine overrides remain trivial. The connection itself is resolved by
// `@oh-my-pi/pi-ai/auth-broker/discover` from env + global config.yml only (project layers
// never redirect credentials); these definitions own validation, CLI, and `cfg://` display.
export const cfgAuthBrokerUrl = register({
	id: "auth.broker.url",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_URL",
});

export const cfgAuthBrokerToken = register({
	id: "auth.broker.token",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_TOKEN",
	credential: true,
});

export const cfgAuthAccountPolicies = register({
	id: "auth.accountPolicies",
	type: "array",
	default: EMPTY_AUTH_ACCOUNT_POLICIES,
});

/** Providers the auth rules pause (`disabled "<reason>"`), offered as opt-back-in choices. */
const PAUSED_PROVIDER_CHOICES = authProviders()
	.filter(provider => provider.disabled !== undefined)
	.map(provider => ({ value: provider.id, label: provider.name, description: provider.disabled }));

/**
 * Paused providers the user turns back on, accepting the risk their pause reason names. Read
 * through {@link cfgOperatorUnpausedProviders}: a project layer never turns a paused provider on.
 */
export const cfgAuthUnpausedProviders = register({
	id: "auth.unpausedProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Unpaused Providers",
		description:
			"Turn providers we paused back on: login, token refresh and stored credentials work again. Each pause names the account risk you accept. Project settings cannot set this",
		options: PAUSED_PROVIDER_CHOICES,
		// The editor writes the global layer; hide it while a project layer supplies a (disregarded) list.
		condition: "unpausedProvidersNotProject",
	},
});

/** `auth.unpausedProviders` from operator layers only; the value the process applies. */
export const cfgOperatorUnpausedProviders = operatorValue(cfgAuthUnpausedProviders);
effect(cfgOperatorUnpausedProviders, setUnpausedProviders);

export const cfgEnabledModels = register({
	id: "enabledModels",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "models" },
});

export const cfgEnabledProviders = register({
	id: "enabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

export const cfgDisabledProviders = register({
	id: "disabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

export const cfgModelRoleStorage = register({
	id: "modelRoleStorage",
	type: "enum",
	values: ["global", "project"] as const,
	default: "global",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Model Role Storage",
		description: "Where model selector role assignments are saved",
		options: [
			{
				value: "global",
				label: "Global",
				description: "Save role models in the active profile config (current behavior)",
			},
			{
				value: "project",
				label: "Per-project",
				description: "Save project role models in .omp/config.yml; missing project roles use global defaults",
			},
		],
	},
});

export const cfgModelsDefaultScope = register({
	id: "models.defaultScope",
	type: "enum",
	values: ["session", "project", "global"] as const,
	default: "session",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Roles default scope",
		description: "Scope edited by /roles without an explicit session, project, or global argument",
		options: [
			{ value: "session", label: "Session", description: "Only this conversation" },
			{ value: "project", label: "Project", description: "This project's configuration" },
			{ value: "global", label: "Global", description: "The active profile's defaults" },
		],
	},
});

export const cfgSessionModelPicker = register({
	id: "models.sessionPicker",
	type: "enum",
	values: ["big", "small"] as const,
	default: "big",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Session model picker",
		description: "Picker opened by /model and Alt+P for this conversation",
		options: [
			{ value: "big", label: "Big Pickle", description: "Fullscreen provider-sidebar model browser" },
			{ value: "small", label: "Small picker", description: "Compact picker over the transcript" },
		],
	},
});

// The runtime timer limit is a signed 32-bit delay in milliseconds.
const MAX_CATALOG_TIMER_MINUTES = Math.floor(2_147_483_647 / 60_000);

function validateCatalogTimerMinutes(raw: unknown): void {
	if (raw === undefined) return;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_CATALOG_TIMER_MINUTES) {
		throw new Error(`Expected whole minutes from 1 through ${MAX_CATALOG_TIMER_MINUTES}.`);
	}
}

export const cfgCatalogRefreshCycleMinutes = register({
	id: "models.catalogRefreshCycleMinutes",
	type: "number",
	default: 120,
	validate: validateCatalogTimerMinutes,
	ui: {
		tab: "model",
		group: "Model Catalog",
		label: "Catalog refresh cycle (minutes)",
		description: "Time between background model catalog refresh cycles",
		options: [{ value: "120", label: "120 minutes (default)" }],
		customInput: true,
	},
});

export const cfgCatalogProviderStalenessMinutes = register({
	id: "models.catalogProviderStalenessMinutes",
	type: "number",
	default: 240,
	validate: validateCatalogTimerMinutes,
	ui: {
		tab: "model",
		group: "Model Catalog",
		label: "Provider catalog staleness (minutes)",
		description: "Age after which entering a provider triggers a catalog refresh",
		options: [{ value: "240", label: "240 minutes (default)" }],
		customInput: true,
	},
});

export const cfgNewModelTierDays = register({
	id: "models.newModelTierDays",
	type: "number",
	default: 14,
	validate: raw => {
		if (raw !== undefined && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1)) {
			throw new Error("Expected a positive whole number of days.");
		}
	},
	ui: {
		tab: "model",
		group: "Model Catalog",
		label: "New models tier (days)",
		description: "Days per gold, silver, and bronze discovery tier",
		options: [{ value: "14", label: "14 days (default)" }],
		customInput: true,
	},
});

export const cfgModelRoles = register({ id: "modelRoles", type: "record", default: EMPTY_STRING_RECORD });

/** Total provider budget for one native judge candidate, including setup and retries. */
export const cfgJudgmentAttemptTimeoutMs = register({
	id: "judgment.attemptTimeoutMs",
	type: "number",
	default: 3_000,
	validate: raw => {
		if (raw === undefined || raw === null) return;
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
			throw new Error("judgment.attemptTimeoutMs must be a positive safe integer");
		}
	},
});

/** Named model presets; no settings-panel UI — managed by `/modelpreset` and the model hub. */
export const cfgModelPresets = register({
	id: "modelPresets",
	type: "record",
	default: EMPTY_MODEL_PRESETS_RECORD,
});

/** Named browsing collections shared by the fullscreen model picker and Roles. */
export const cfgModelFolders = register({
	id: "modelFolders",
	type: "array",
	default: [] as readonly HubModelFolder[],
	validate(raw) {
		if (raw === undefined) return;
		if (!Array.isArray(raw)) throw new Error("Model folders must be a list");
		const names = new Set<string>();
		for (const folder of raw) {
			if (
				!folder ||
				typeof folder.name !== "string" ||
				!folder.name ||
				folder.name !== folder.name.trim() ||
				/[\p{Cc}\p{Zl}\p{Zp}]/u.test(folder.name) ||
				!Array.isArray(folder.models) ||
				folder.models.some((model: unknown) => typeof model !== "string" || !/^[^/]+\/.+$/u.test(model))
			) {
				throw new Error("Each model folder needs a single-line name and a list of provider/model IDs");
			}
			if (names.has(folder.name)) throw new Error(`Duplicate model folder "${folder.name}"`);
			names.add(folder.name);
			if (folder.rules !== undefined) validateModelFolderRules(folder.rules);
		}
	},
});

export const cfgModelTags = register({ id: "modelTags", type: "record", default: EMPTY_MODEL_TAGS_RECORD });

export const cfgModelProviderOrder = register({ id: "modelProviderOrder", type: "array", default: EMPTY_STRING_ARRAY });

export const cfgCycleOrder = register({ id: "cycleOrder", type: "array", default: DEFAULT_CYCLE_ORDER });

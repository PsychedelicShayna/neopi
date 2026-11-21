import { serviceTierFamily } from "@oh-my-pi/pi-ai/types";
import { THINKING_CHOICES, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import type { Model, ModelVariantRequestOverrides } from "@oh-my-pi/pi-catalog/types";
import type { HubModelVariantField } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	cfgCompactionThresholdPercent,
	cfgCompactionThresholdTokens,
	cfgExtendedContext,
} from "../session/context-settings";
import * as session from "../session/settings";
import { type AnySetting, register, type ScopeLike, type Setting } from "./registry";

export interface ModelVariantDefinition {
	readonly id: string;
	readonly name: string;
	readonly baseModel: string;
	readonly overrides: Readonly<Record<string, unknown>>;
}

// Use the same registered types, labels and enum domains as /settings. Policy,
// credentials and global routing/eligibility controls do not travel with a model.
const SETTINGS: readonly AnySetting[] = [
	session.cfgProvidersAutoThinkingMaxEffort,
	session.cfgOmitThinking,
	session.cfgExternalThinking,
	session.cfgThinkingBudgetsMinimal,
	session.cfgThinkingBudgetsLow,
	session.cfgThinkingBudgetsMedium,
	session.cfgThinkingBudgetsHigh,
	session.cfgThinkingBudgetsXhigh,
	session.cfgThinkingBudgetsMax,
	cfgExtendedContext,
	cfgCompactionThresholdTokens,
	cfgCompactionThresholdPercent,
	session.cfgTemperature,
	session.cfgTopP,
	session.cfgTopK,
	session.cfgMinP,
	session.cfgPresencePenalty,
	session.cfgRepetitionPenalty,
	session.cfgTextVerbosity,
	session.cfgTierOpenai,
	session.cfgTierAnthropic,
	session.cfgTierGoogle,
	session.cfgProvidersFireworksTier,
	session.cfgProviderAppendOnlyContext,
	session.cfgProvidersCacheRetention,
	session.cfgProvidersOpenrouterVariant,
	session.cfgProvidersKimiApiFormat,
	session.cfgProvidersAntigravityEndpoint,
	session.cfgProvidersOpenaiWebsockets,
	session.cfgProvidersOpenaiResponsesWebsockets,
	session.cfgProvidersOpenaiLiveSteering,
	session.cfgProvidersMuseCodeStoreResponses,
	session.cfgProvidersOpenaiCodexDaybreak,
	session.cfgProvidersAnthropicServerSideFallback,
	session.cfgProvidersAnthropicSlowMode,
	session.cfgProvidersStreamFirstEventTimeoutSeconds,
	session.cfgProvidersStreamIdleTimeoutSeconds,
	session.cfgRetryMaxDelayMs,
	session.cfgModelLoopGuardEnabled,
	session.cfgModelLoopGuardCheckAssistantContent,
	session.cfgModelLoopGuardToolCallReminder,
];

function validationError(validate: (value: unknown) => void, value: unknown): string | undefined {
	try {
		validate(value);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function registeredField(setting: AnySetting): HubModelVariantField {
	const { id: key, definition } = setting;
	const label = definition.ui?.label ?? key.replace("thinkingBudgets.", "Thinking token budget — ");
	const meta = {
		key,
		label,
		validate: (value: unknown) => validationError(input => setting.assertRoleWritable(input), value),
	};
	switch (definition.type) {
		case "number":
			return { ...meta, kind: "number", ...(key.startsWith("thinkingBudgets.") ? { integer: true, min: 0 } : {}) };
		case "boolean":
			return { ...meta, kind: "boolean" };
		case "enum":
			return { ...meta, kind: "choice", choices: definition.values };
		case "string":
			return { ...meta, kind: "string" };
		default:
			throw new Error(`No Model Variant field for ${key}`);
	}
}

export const MODEL_VARIANT_FIELDS: readonly HubModelVariantField[] = [
	{ key: "contextWindow", label: "Context Window", kind: "number", min: 1, integer: true },
	{ key: "maxTokens", label: "Maximum Output Tokens", kind: "number", min: 1, integer: true },
	{
		key: session.cfgDefaultThinkingLevel.id,
		label: "Thinking Level",
		kind: "choice",
		choices: [...THINKING_CHOICES, "auto"],
	},
	{
		key: "effort.allowed",
		label: "Allowed Implicit Efforts",
		kind: "string-list",
		validate: value =>
			Array.isArray(value) &&
			value.length > 0 &&
			value.every(entry => THINKING_CHOICES.includes(entry)) &&
			new Set(value).size === value.length
				? undefined
				: `Choose unique efforts from ${THINKING_CHOICES.join(", ")}`,
	},
	...SETTINGS.map(registeredField),
];

const fieldsByKey = new Map(MODEL_VARIANT_FIELDS.map(field => [field.key, field]));

function assertVariantOverride(key: string, value: unknown): void {
	const field = fieldsByKey.get(key);
	if (!field) throw new Error(`Setting ${key} cannot be overridden by a Model Variant`);
	if (field.kind === "choice" && (typeof value !== "string" || !field.choices.includes(value))) {
		throw new Error(`Invalid value for ${field.label}: choose ${field.choices.join(", ")}`);
	}
	if (field.kind === "number") {
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			(field.integer && !Number.isSafeInteger(value)) ||
			(field.min !== undefined && value < field.min) ||
			(field.max !== undefined && value > field.max)
		) {
			throw new Error(`Invalid number for ${field.label}`);
		}
	}
	const reason = field.validate?.(value);
	if (reason) throw new Error(reason);
}

/** A generated id is stable through rename and rebasing onto a different provider. */
export function isModelVariantId(id: string): boolean {
	return /^variant--[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
}

function validateModelVariants(raw: unknown, merged = false): void {
	if (raw === undefined) return;
	if (!Array.isArray(raw)) throw new Error("Model Variants must be an ordered list");
	const seenIds = merged ? undefined : new Set<string>();
	for (const value of raw) {
		if (!isRecord(value) || typeof value.id !== "string" || !isModelVariantId(value.id) || seenIds?.has(value.id))
			throw new Error("Every Model Variant must have a unique variant ID");
		seenIds?.add(value.id);
		if (typeof value.name !== "string" || !value.name.trim() || /[\p{Cc}]/u.test(value.name))
			throw new Error("Every Model Variant must have a printable name");
		if (typeof value.baseModel !== "string" || !/^[^/\s]+\/\S+$/.test(value.baseModel))
			throw new Error(`Model Variant ${value.name} must name a base model as provider/model-id`);
		if (isModelVariantId(value.baseModel.slice(value.baseModel.indexOf("/") + 1)))
			throw new Error(`Model Variant ${value.name} must have an ordinary base model`);
		if (!isRecord(value.overrides)) throw new Error(`Model Variant ${value.name} must provide an overrides map`);
		for (const [key, override] of Object.entries(value.overrides)) assertVariantOverride(key, override);
	}
}

export const cfgModelVariants = register({
	id: "modelVariants",
	type: "array",
	merge: "prepend",
	default: [] as ModelVariantDefinition[],
	validate: validateModelVariants,
	// When layers are combined, the first (highest-precedence) entry owns the id.
	validateConfigured: raw => validateModelVariants(raw, true),
});

export function modelVariantSetting<T>(model: Model | null | undefined, setting: Setting<T>, scope: ScopeLike): T {
	return (model?.variant?.settings[setting.id] as T | undefined) ?? setting.get(scope);
}

export function modelVariantRequestOverrides(
	base: Model,
	overrides: Readonly<Record<string, unknown>>,
): ModelVariantRequestOverrides {
	const read = <T>(setting: Setting<T>) => overrides[setting.id] as T | undefined;
	const family = serviceTierFamily(base);
	let thinkingBudgets: ModelVariantRequestOverrides["thinkingBudgets"];
	for (const effort of THINKING_EFFORTS) {
		const value = overrides[`thinkingBudgets.${effort}`];
		if (typeof value === "number") (thinkingBudgets ??= {})[effort] = value;
	}
	return {
		temperature: read(session.cfgTemperature),
		topP: read(session.cfgTopP),
		topK: read(session.cfgTopK),
		minP: read(session.cfgMinP),
		presencePenalty: read(session.cfgPresencePenalty),
		repetitionPenalty: read(session.cfgRepetitionPenalty),
		hideThinkingSummary: read(session.cfgOmitThinking),
		textVerbosity: read(session.cfgTextVerbosity),
		serviceTier:
			family === "openai"
				? read(session.cfgTierOpenai)
				: family === "anthropic"
					? read(session.cfgTierAnthropic)
					: family === "google"
						? read(session.cfgTierGoogle)
						: undefined,
		thinkingBudgets,
		thinkingLevel: overrides[session.cfgDefaultThinkingLevel.id] as ModelVariantRequestOverrides["thinkingLevel"],
		cacheRetention: read(session.cfgProvidersCacheRetention),
	};
}

import { entryProvenance } from "./entry-provenance";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { APP_NAME, PRODUCT_NAME } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import {
	SETTING_TABS,
	SETTINGS_FILE_SCOPES,
	type SettingsDisplayEntry,
	type SettingsHost,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { isSettingsInitialized, Settings, settings, type SettingsScope } from "./settings";
import { orderedSettings } from "./all-settings";
import { type AnySetting, lookup } from "./registry";

import { cfgPlanAutosave, cfgPlanEnabled } from "../plan-mode/settings";
import {
	cfgRetryUsageAwareFallback,
	cfgDefaultThinkingLevel,
	normalizeProviderMaxInFlightRequests,
	validateProviderMaxInFlightRequests,
} from "../session/settings";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { CHAT_INCLUDES } from "../chat/chat-mode";
import { MAX_WEB_SEARCH_TIMEOUT_SECONDS } from "../web/search/types";
import { cfgComposerPredictions, cfgTuiVimMode } from "../modes/settings";
import { cfgAdvisorEnabled } from "../advisor/settings";
import { cfgEffortPolicyMode } from "./effort-policy";
import { cfgTaskPerCallModelAllow } from "../task/settings";
import { cfgAuthUnpausedProviders } from "./model-settings";

/** A condition follows its panel's settings owner; an uninitialized default proxy stays hidden. */
function whenSettings(test: (settings: Settings) => boolean): (scope: Settings) => boolean {
	return scope => (scope !== settings || isSettingsInitialized()) && test(scope);
}

const CONDITIONS: Record<string, (scope: Settings) => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	nativeRendering: () => isNativeRendering(),
	advisorEnabled: whenSettings(s => cfgAdvisorEnabled.get(s) === true),
	vimModeEnabled: whenSettings(s => cfgTuiVimMode.get(s) === true),
	composerPredictionsEnabled: whenSettings(s => cfgComposerPredictions.get(s) === true),
	hindsightActive: whenSettings(s => cfgMemoryBackend.get(s) === "hindsight"),
	mnemopiActive: whenSettings(s => cfgMemoryBackend.get(s) === "mnemopi"),
	autolearnActive: whenSettings(s => cfgAutolearnEnabled.get(s) === true),
	autoThinkingActive: whenSettings(s => cfgDefaultThinkingLevel.get(s) === "auto"),
	legacyEffortPolicy: whenSettings(s => cfgEffortPolicyMode.get(s) === "legacy"),
	usageAwareFallbackEnabled: whenSettings(s => cfgRetryUsageAwareFallback.get(s) === true),
	planModeEnabled: whenSettings(s => cfgPlanEnabled.get(s)),
	planAutosaveEnabled: whenSettings(s => cfgPlanEnabled.get(s) && cfgPlanAutosave.get(s)),
	perCallModelAllowNotProject: whenSettings(s => cfgTaskPerCallModelAllow.provenance(s) !== "project"),
	unpausedProvidersNotProject: whenSettings(s => cfgAuthUnpausedProviders.provenance(s) !== "project"),
};

const DESCRIPTION_VALUES = {
	app_name: APP_NAME,
	product_name: PRODUCT_NAME,
	get escape_key() {
		return formatKeyHint("escape");
	},
	get chat_includes() {
		return CHAT_INCLUDES.join(", ");
	},
	max_web_search_timeout_seconds: MAX_WEB_SEARCH_TIMEOUT_SECONDS,
};

/** Description suffix telling the panel user that an environment variable is in play. */
function envNote(setting: AnySetting): (() => string) | undefined {
	const envName = setting.envName;
	if (!envName || setting.envValue() === undefined) return undefined;
	const key = setting.envFallback ? "settings.host.env_fallback" : "settings.host.env_override";
	return () => t(key, { env_name: envName });
}

/**
 * Adapt the application schema and settings store to the terminal overlay. The panel shows
 * the value across files through the selected scope, never an environment-supplied one (so an env credential
 * is never pre-filled or written to config); descriptions note an active environment variable.
 */
export function createSettingsHost(scope: Settings = settings, initialScope: SettingsScope = "global"): SettingsHost {
	let editingScope = initialScope;
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const setting of orderedSettings()) {
			const ui = setting.ui;
			if (ui?.tab !== tab) continue;
			const envSuffix = envNote(setting);
			const condition = ui.condition ? CONDITIONS[ui.condition] : undefined;
			entries.push({
				path: setting.id,
				type: setting.allowsAsk ? "enum" : setting.type,
				defaultValue: setting.allowsAsk ? String(setting.default) : setting.default,
				ui: {
					...ui,
					...(setting.allowsAsk
						? {
								options: [
									{
										value: "true",
										get label() {
											return t("settings.selector.boolean.on");
										},
									},
									{
										value: "false",
										get label() {
											return t("settings.selector.boolean.off");
										},
									},
									{
										value: "ask",
										get label() {
											return t("settings.selector.boolean.ask");
										},
									},
								],
							}
						: {}),
					provenance: entryProvenance("settings", setting.id),
					get description() {
						return ui.description;
					},
				},
				descriptionValues: DESCRIPTION_VALUES,
				descriptionSuffix: envSuffix,
				enumValues: setting.enumValues,
				credential: setting.isCredential,
				condition: condition ? () => condition(scope) : undefined,
			});
		}
	}
	const requireSetting = (path: string): AnySetting => {
		const setting = lookup(path);
		if (!setting) throw new Error(t("settings.host.unknown_setting", { path }));
		return setting;
	};
	const resolve = (path: string) => scope.resolveFileScopeValue(requireSetting(path), editingScope);
	return {
		entries,
		onReload: listener => scope.onPersistedLayersChange(listener),
		get scope() {
			return editingScope;
		},
		cycleScope: () => {
			const scopes = SETTINGS_FILE_SCOPES;
			editingScope = scopes[(scopes.indexOf(editingScope) + 1) % scopes.length];
		},
		get: path => {
			const value = resolve(path).value;
			return requireSetting(path).allowsAsk ? String(value) : value;
		},
		resolve,
		own: path => scope.readScopeValue(requireSetting(path), editingScope),
		details: path => {
			const setting = requireSetting(path);
			const details = scope.getScopeDetails(setting, editingScope);
			const format = (value: unknown) =>
				setting.isCredential
					? value === undefined
						? t("settings.host.inherit")
						: t("settings.host.redacted")
					: (JSON.stringify(value) ?? t("settings.host.inherit"));
			const effective = format(details.effective);
			const winner = t(`settings.value.${details.winner}`);
			return {
				shadowed: details.shadowed,
				description:
					(details.shadowed ? t("settings.host.shadowed", { winner, effective }) : "") +
					t("settings.host.scope_details", {
						global: format(details.global),
						project: format(details.project),
						session: format(details.session),
						effective,
						winner,
					}),
			};
		},
		set: (path, value) => {
			const setting = requireSetting(path);
			const configured = setting.allowsAsk && value !== "ask" ? setting.parse(String(value)) : value;
			scope.writeScopeValue(setting, configured, editingScope);
		},
		unset: path => scope.writeScopeValue(requireSetting(path), undefined, editingScope),
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}

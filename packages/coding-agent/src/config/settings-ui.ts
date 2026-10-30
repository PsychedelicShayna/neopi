import { TERMINAL } from "@oh-my-pi/pi-tui";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { SETTING_TABS, type SettingsDisplayEntry, type SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { isSettingsInitialized, Settings, settings } from "./settings";
import { orderedSettings } from "./all-settings";
import { type AnySetting, lookup } from "./registry";
import { getKnownRoleIds } from "./model-roles";
import { cfgRoleSettings } from "./role-settings";

import { cfgPlanAutosave, cfgPlanEnabled } from "../plan-mode/settings";
import {
	cfgRetryUsageAwareFallback,
	cfgDefaultThinkingLevel,
	normalizeProviderMaxInFlightRequests,
	validateProviderMaxInFlightRequests,
} from "../session/settings";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgTuiVimMode } from "../modes/settings";
import { cfgAdvisorEnabled } from "../advisor/settings";
import { cfgEffortPolicyMode } from "./effort-policy";
import { cfgContextFilesExtra, cfgCompactionThresholdTokens } from "../session/context-settings";
import { cfgToolsRestrictedFolders } from "../tools/settings";

/** Condition over the global settings; hidden (false) until they are initialized. */
function whenSettings(test: (settings: Settings) => boolean): () => boolean {
	return () => isSettingsInitialized() && test(Settings.instance);
}

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	nativeRendering: () => isNativeRendering(),
	advisorEnabled: whenSettings(s => cfgAdvisorEnabled.get(s) === true),
	vimModeEnabled: whenSettings(s => cfgTuiVimMode.get(s) === true),
	hindsightActive: whenSettings(s => cfgMemoryBackend.get(s) === "hindsight"),
	mnemopiActive: whenSettings(s => cfgMemoryBackend.get(s) === "mnemopi"),
	autolearnActive: whenSettings(s => cfgAutolearnEnabled.get(s) === true),
	autoThinkingActive: whenSettings(s => cfgDefaultThinkingLevel.get(s) === "auto"),
	legacyEffortPolicy: whenSettings(s => cfgEffortPolicyMode.get(s) === "legacy"),
	usageAwareFallbackEnabled: whenSettings(s => cfgRetryUsageAwareFallback.get(s) === true),
	planModeEnabled: whenSettings(s => cfgPlanEnabled.get(s)),
	planAutosaveEnabled: whenSettings(s => cfgPlanEnabled.get(s) && cfgPlanAutosave.get(s)),
	// These editors write the global layer; hide them so a project-supplied list is never promoted to global.
	contextFilesExtraNotProject: whenSettings(s => cfgContextFilesExtra.provenance(s) !== "project"),
	restrictedFoldersNotProject: whenSettings(s => cfgToolsRestrictedFolders.provenance(s) !== "project"),
};

/** Description suffix telling the panel user that an environment variable is in play. */
function envNote(setting: AnySetting): string {
	if (!setting.envName || setting.envValue() === undefined) return "";
	return setting.envFallback
		? ` Unset, it falls back to $${setting.envName}.`
		: ` $${setting.envName} overrides this setting while it is set.`;
}

/**
 * Adapt the application schema and settings store to the terminal overlay. The panel shows and
 * edits the value of the settings layers, never an environment-supplied one (so an env credential
 * is never pre-filled or written to config); descriptions note an active environment variable.
 */
export function createSettingsHost(scope: Settings = settings): SettingsHost {
	// Global rows edit the ordinary layers, not whichever role happens to be active.
	const globalView = scope.overlay();
	globalView.setActiveRole(undefined);
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const setting of orderedSettings()) {
			const ui = setting.ui;
			if (ui?.tab !== tab) continue;
			const note = envNote(setting);
			entries.push({
				path: setting.id,
				type: setting.type,
				defaultValue: setting.default,
				ui: note ? { ...ui, description: `${ui.description}${note}` } : ui,
				enumValues: setting.enumValues,
				credential: setting.isCredential,
				condition: ui.condition ? CONDITIONS[ui.condition] : undefined,
			});
		}
	}
	const rolePaths = new Map<string, string>();
	for (const role of new Set([...getKnownRoleIds(scope), ...Object.keys(cfgRoleSettings.get(scope))])) {
		const path = `roleSettings.${encodeURIComponent(role)}.compaction.thresholdTokens`;
		rolePaths.set(path, role);
		const ui = cfgCompactionThresholdTokens.ui!;
		const options = Array.isArray(ui.options) ? ui.options : [];
		entries.push({
			path,
			type: "number",
			defaultValue: -1,
			ui: {
				...ui,
				label: `${role} token budget`,
				description: `Absolute context budget while role "${role}" is active. Clear to inherit the global token limit.`,
				options: options.map(option =>
					option.value === "default"
						? { value: "default", label: "Inherit", description: "Use the global token limit" }
						: option,
				),
			},
		});
	}
	const resolve = (path: string): AnySetting => {
		const setting = lookup(path);
		if (!setting) throw new Error(`Unknown setting: ${path}`);
		return setting;
	};
	return {
		entries,
		get: path => {
			const role = rolePaths.get(path);
			return role === undefined
				? lookup(path)?.layered(globalView)
				: (scope.getRoleSetting(role, cfgCompactionThresholdTokens) ?? -1);
		},
		set: (path, value) => {
			const role = rolePaths.get(path);
			if (role === undefined) resolve(path).set(scope, value);
			else {
				if (typeof value !== "number") throw new Error("Role token budget must be a number");
				scope.setRoleSetting(role, cfgCompactionThresholdTokens, value === -1 ? undefined : value);
			}
		},
		unset: path => {
			const role = rolePaths.get(path);
			if (role === undefined) resolve(path).unset(scope);
			else scope.setRoleSetting(role, cfgCompactionThresholdTokens, undefined);
		},
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}

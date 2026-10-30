import type { Settings, SettingsScope } from "../config/settings";
import { cfgCustomPersonalities, cfgPersonality } from "../session/settings";
import {
	BUILTIN_PERSONALITIES,
	isBuiltinPersonality,
	resolvePersonalityRecords,
	type ScopedPersonality,
	type PersonalityDefinition,
	validatePersonalityDefinition,
} from "./personalities";

/** Read each layer separately so the picker can show the source of a definition. */
export function listCustomPersonalities(settings: Settings): ScopedPersonality[] {
	const read = (scope: SettingsScope): Record<string, string> => {
		const value = settings.readScopeValue(cfgCustomPersonalities, scope);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
	};
	return resolvePersonalityRecords({ global: read("global"), project: read("project"), session: read("session") });
}

/** Names offered by the slash command, with built-ins followed by custom entries. */
export function listPersonalityNames(settings: Settings): string[] {
	return [...BUILTIN_PERSONALITIES, ...listCustomPersonalities(settings).map(item => item.name)];
}

/** Show the selected layer's definition when present, including shadowed definitions. */
export function listCustomPersonalitiesForScope(settings: Settings, scope: SettingsScope): ScopedPersonality[] {
	const value = settings.readScopeValue(cfgCustomPersonalities, scope);
	const own = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
	return listCustomPersonalities(settings).map(entry =>
		Object.hasOwn(own, entry.name) ? { name: entry.name, prompt: own[entry.name]!, scope } : entry,
	);
}

export function currentPersonalityName(settings: Settings): string {
	return cfgPersonality.get(settings);
}

export function currentPersonalitySelectionScope(settings: Settings): string {
	return settings.getProvenance(cfgPersonality);
}

/** Resolve the inherited definition without mutating the settings layers. */
export function personalityAfterDelete(settings: Settings, scope: SettingsScope, name: string): string | undefined {
	const layers: Partial<Record<SettingsScope, Record<string, string>>> = {};
	for (const layer of ["global", "project", "session"] as const) {
		const value = settings.readScopeValue(cfgCustomPersonalities, layer);
		layers[layer] =
			value && typeof value === "object" && !Array.isArray(value) ? ({ ...value } as Record<string, string>) : {};
	}
	delete layers[scope]?.[name];
	return resolvePersonalityRecords(layers).find(entry => entry.name === name)?.prompt;
}

/** Store only the selected layer; do not copy inherited entries into it. */
export function saveCustomPersonality(settings: Settings, scope: SettingsScope, name: string, prompt: string): void {
	const value = settings.readScopeValue(cfgCustomPersonalities, scope);
	const own = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
	settings.writeScopeValue(cfgCustomPersonalities, { ...own, [name]: prompt }, scope);
}

/** Delete only the definition at the selected scope, revealing any inherited one. */
export function deleteCustomPersonality(settings: Settings, scope: SettingsScope, name: string): void {
	const value = settings.readScopeValue(cfgCustomPersonalities, scope);
	if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, name)) return;
	const remaining = { ...value } as Record<string, string>;
	delete remaining[name];
	settings.writeScopeValue(cfgCustomPersonalities, Object.keys(remaining).length ? remaining : undefined, scope);
}

/** Select a built-in or effective custom definition in exactly one settings scope. */
export function selectPersonality(settings: Settings, scope: SettingsScope, name: string): void {
	if (
		!isBuiltinPersonality(name) &&
		!listCustomPersonalities(settings).some(personality => personality.name === name)
	) {
		throw new Error(`Unknown personality: ${name}`);
	}
	settings.writeScopeValue(cfgPersonality, name, scope);
}

/** Replace a scope's edited definitions in one validated update, preserving inherited entries. */
export function savePersonalityDefinitions(
	settings: Settings,
	scope: SettingsScope,
	definitions: readonly PersonalityDefinition[],
): void {
	const existing = new Map(listCustomPersonalitiesForScope(settings, scope).map(entry => [entry.name, entry]));
	const own: Record<string, string> = {};
	const names = new Set<string>();
	for (const definition of definitions) {
		const error = validatePersonalityDefinition(definition);
		if (error) throw new Error(error);
		if (names.has(definition.name)) throw new Error(`Duplicate personality: ${definition.name}`);
		names.add(definition.name);
		const previous = existing.get(definition.name);
		if (!previous || previous.scope === scope || previous.prompt !== definition.prompt)
			Object.defineProperty(own, definition.name, {
				value: definition.prompt,
				enumerable: true,
				configurable: true,
				writable: true,
			});
	}
	settings.writeScopeValue(cfgCustomPersonalities, Object.keys(own).length ? own : undefined, scope);
}

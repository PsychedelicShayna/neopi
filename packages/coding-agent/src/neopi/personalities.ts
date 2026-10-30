/** A named personality's prompt, stored independently in each settings scope. */
export interface PersonalityDefinition {
	name: string;
	prompt: string;
}

export type PersonalityScope = "global" | "project" | "session";

export function personalityScopeRank(scope: string): number {
	const rank: Record<string, number> = {
		default: -1,
		global: 0,
		project: 1,
		overlay: 2,
		session: 3,
		role: 3,
		runtime: 4,
		env: 5,
	};
	return rank[scope] ?? -1;
}

export interface ScopedPersonality extends PersonalityDefinition {
	scope: PersonalityScope;
}

/** Convert stored settings records into entries with their effective source. */
export function resolvePersonalityRecords(
	layers: Partial<Record<PersonalityScope, Readonly<Record<string, string>>>>,
): ScopedPersonality[] {
	const entries: Partial<Record<PersonalityScope, PersonalityDefinition[]>> = {};
	for (const scope of ["global", "project", "session"] as const) {
		entries[scope] = Object.entries(layers[scope] ?? {}).map(([name, prompt]) => ({ name, prompt }));
	}
	return resolvePersonalities(entries);
}

/** Built-in names are reserved so custom entries cannot replace immutable presets. */
export const BUILTIN_PERSONALITIES = ["default", "friendly", "pragmatic", "none"] as const;

export function isBuiltinPersonality(name: string): name is (typeof BUILTIN_PERSONALITIES)[number] {
	return BUILTIN_PERSONALITIES.some(builtin => builtin === name);
}

/** Completion is case-insensitive while preserving the actual name for selection. */
export function completePersonalityNames(names: readonly string[], prefix: string): string[] {
	const query = prefix.toLocaleLowerCase();
	return names.filter(name => name.toLocaleLowerCase().startsWith(query));
}

export function validatePersonalityDefinition(definition: PersonalityDefinition): string | undefined {
	const name = definition.name.trim();
	if (!name || name !== definition.name) return "Name must not be empty or have surrounding whitespace";
	if (/[\x00-\x1f\x7f]/.test(name)) return "Name must not contain control characters";
	if (BUILTIN_PERSONALITIES.some(builtin => builtin === name.toLowerCase())) return "Built-in names are reserved";
	if (!definition.prompt.trim()) return "Personality prompt must not be empty";
	return undefined;
}

/** Merge definitions using the same precedence as settings: session, project, global. */
export function resolvePersonalities(
	layers: Partial<Record<PersonalityScope, readonly PersonalityDefinition[]>>,
): ScopedPersonality[] {
	const effective = new Map<string, ScopedPersonality>();
	for (const scope of ["global", "project", "session"] as const) {
		for (const definition of layers[scope] ?? []) {
			effective.set(definition.name, { ...definition, scope });
		}
	}
	return [...effective.values()].sort((a, b) => a.name.localeCompare(b.name));
}

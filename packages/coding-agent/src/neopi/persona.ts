/**
 * Session-scoped system-prompt personas (`/persona`).
 *
 * State lives in `<agentDir>/neopi-persona.json` (legacy `omomp-persona.json`
 * is read until the first write). A persona is selected per session id; the
 * session applies it in {@link PersonaFeature.apply} while preparing each
 * agent turn, before extension `before_agent_start` handlers see the prompt.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { isRecord, isStringRecord, JsonStateStore } from "./json-state";

export type PersonaMode = "replace" | "prepend" | "append" | "literal-substitute";
export const PERSONA_MODES: readonly PersonaMode[] = ["replace", "prepend", "append", "literal-substitute"];
export type PersonaSource = { kind: "inline"; content: string } | { kind: "file"; path: string };
export interface PersonaDefinition {
	mode: PersonaMode;
	source: PersonaSource;
	literal?: string;
	inheritToTasks?: boolean;
}
export interface PersonaState {
	schemaVersion: 1;
	personas: Record<string, PersonaDefinition>;
	sessionPersonas: Record<string, string>;
}

export const emptyPersonaState = (): PersonaState => ({ schemaVersion: 1, personas: {}, sessionPersonas: {} });

const isPersona = (v: unknown): v is PersonaDefinition =>
	isRecord(v) &&
	PERSONA_MODES.includes(v.mode as PersonaMode) &&
	isRecord(v.source) &&
	((v.source.kind === "inline" && typeof v.source.content === "string") ||
		(v.source.kind === "file" && typeof v.source.path === "string")) &&
	(v.literal === undefined || typeof v.literal === "string") &&
	(v.inheritToTasks === undefined || typeof v.inheritToTasks === "boolean");

export function validatePersonaState(v: unknown): PersonaState {
	if (
		!isRecord(v) ||
		v.schemaVersion !== 1 ||
		!isRecord(v.personas) ||
		!Object.values(v.personas).every(isPersona) ||
		!isStringRecord(v.sessionPersonas)
	)
		throw new Error("Invalid schema-v1 neopi-persona.json");
	return v as unknown as PersonaState;
}

export const defaultPersonaStatePath = (): string => nodePath.join(getAgentDir(), "neopi-persona.json");

export class PersonaStore extends JsonStateStore<PersonaState> {
	constructor(path: string | (() => string) = defaultPersonaStatePath) {
		super(path, "omomp-persona.json", validatePersonaState, emptyPersonaState);
	}
}

/** Footer/widget key shared by every persona surface. */
export const PERSONA_STATUS_KEY = "neopi-persona";

/** UI surface a persona operation may update; absent in headless modes. */
export interface PersonaUi {
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, lines: string[]): void;
}

/** Session capabilities a persona command needs. */
export interface PersonaHost {
	sessionId: string;
	ui?: PersonaUi;
	invalidatePromptCache(): void;
	appendEntry(customType: string, data: unknown): void;
}

export interface PersonaData {
	items: Array<{ name: string; definition: PersonaDefinition; active: boolean }>;
	active?: string;
	warning?: string;
}

export interface PersonaFeature {
	data(sessionId: string): Promise<PersonaData>;
	list(sessionId: string): Promise<string>;
	show(name: string): Promise<string>;
	status(sessionId: string): Promise<string>;
	use(name: string, host: PersonaHost): Promise<string>;
	off(host: PersonaHost): Promise<string>;
	delete(name: string, host: PersonaHost): Promise<string>;
	create(name: string, definition: PersonaDefinition): Promise<string>;
	edit(name: string, definition: PersonaDefinition): Promise<string>;
	clone(source: string, name: string): Promise<string>;
	/**
	 * Replace every persona definition at once (the configuration menu's save).
	 * `renames` maps on-disk names to their new names so other sessions keep
	 * their selection; selections of removed personas are dropped. `active`
	 * becomes this session's selection.
	 */
	saveAll(
		personas: Record<string, PersonaDefinition>,
		renames: ReadonlyMap<string, string>,
		active: string | undefined,
		host: PersonaHost,
	): Promise<string>;
	/**
	 * Return the persona-adjusted system prompt for this session's next turn, or
	 * `undefined` when no persona is selected or it cannot be applied (the
	 * failure is recorded as a warning and the base prompt stays in effect).
	 */
	apply(systemPrompt: string[], host: PersonaHost): Promise<string[] | undefined>;
}

function ordered(state: Record<string, PersonaDefinition>) {
	return Object.entries(state).sort(([a], [b]) => a.localeCompare(b));
}

function setUi(ui: PersonaUi | undefined, active?: string, warning?: string) {
	ui?.setStatus(PERSONA_STATUS_KEY, active ? `persona: ${active}${warning ? " (warning)" : ""}` : undefined);
	ui?.setWidget(PERSONA_STATUS_KEY, warning ? [`Persona warning: ${warning}`] : []);
}

function validName(name: string) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
		throw new Error("Persona name must contain only letters, numbers, '.', '_' or '-'");
}

export function createPersonaFeature(
	store: PersonaStore = new PersonaStore(),
	agentRoot: () => string = getAgentDir,
): PersonaFeature {
	const warnings = new Map<string, string>();
	const annotated = new Set<string>();

	async function source(definition: PersonaDefinition): Promise<string> {
		if (definition.source.kind === "inline") {
			if (!definition.source.content.trim()) throw new Error("persona content is empty");
			return definition.source.content;
		}
		const root = await fs.realpath(agentRoot());
		const candidate = await fs.realpath(nodePath.resolve(root, definition.source.path));
		const rel = nodePath.relative(root, candidate);
		if (rel === "" || rel.startsWith("..") || nodePath.isAbsolute(rel))
			throw new Error("persona file escapes profile agent root");
		const content = await Bun.file(candidate).text();
		if (!content.trim()) throw new Error("persona file is empty");
		return content;
	}

	async function data(id: string): Promise<PersonaData> {
		const state = await store.read();
		const active = state.sessionPersonas[id];
		return {
			items: ordered(state.personas).map(([name, definition]) => ({ name, definition, active: name === active })),
			active,
			warning: warnings.get(id),
		};
	}

	function clearAnnotations(id: string) {
		for (const key of annotated) if (key.startsWith(`${id}\0`)) annotated.delete(key);
	}

	return {
		data,
		async list(id) {
			const d = await data(id);
			return d.items.length ? d.items.map(x => `${x.active ? "*" : "-"} ${x.name}`).join("\n") : "No personas.";
		},
		async show(name) {
			const definition = (await store.read()).personas[name];
			if (!definition) throw new Error(`Unknown persona: ${name}`);
			return JSON.stringify(definition, null, 2);
		},
		async status(id) {
			const d = await data(id);
			return d.active ? `Persona: ${d.active}${d.warning ? ` (warning: ${d.warning})` : ""}` : "Persona: off";
		},
		async use(name, host) {
			const id = host.sessionId;
			const state = await store.read();
			const definition = state.personas[name];
			if (!definition) throw new Error(`Unknown persona: ${name}`);
			await source(definition);
			state.sessionPersonas[id] = name;
			await store.write(state);
			warnings.delete(id);
			clearAnnotations(id);
			host.appendEntry("neopi_persona", {
				name,
				sessionId: id,
				metadata: definition.inheritToTasks ? { inheritToTasks: true } : {},
			});
			host.invalidatePromptCache();
			setUi(host.ui, name);
			return `Persona '${name}' active for this session.`;
		},
		async off(host) {
			const id = host.sessionId;
			const state = await store.read();
			delete state.sessionPersonas[id];
			await store.write(state);
			warnings.delete(id);
			host.invalidatePromptCache();
			setUi(host.ui);
			return "Persona off.";
		},
		async delete(name, host) {
			const currentId = host.sessionId;
			const state = await store.read();
			if (!state.personas[name]) throw new Error(`Unknown persona: ${name}`);
			const currentSelection = state.sessionPersonas[currentId];
			delete state.personas[name];
			for (const [id, selected] of Object.entries(state.sessionPersonas)) {
				if (selected === name) delete state.sessionPersonas[id];
			}
			await store.write(state);
			if (currentSelection === name) {
				warnings.delete(currentId);
				host.invalidatePromptCache();
				setUi(host.ui);
			} else {
				setUi(host.ui, currentSelection, warnings.get(currentId));
			}
			return `Deleted persona '${name}'.`;
		},
		async create(name, definition) {
			validName(name);
			const state = await store.read();
			if (state.personas[name]) throw new Error(`Persona already exists: ${name}`);
			await source(definition);
			state.personas[name] = definition;
			await store.write(state);
			return `Created persona '${name}'.`;
		},
		async edit(name, definition) {
			validName(name);
			const state = await store.read();
			if (!state.personas[name]) throw new Error(`Unknown persona: ${name}`);
			await source(definition);
			state.personas[name] = definition;
			await store.write(state);
			return `Updated persona '${name}'.`;
		},
		async clone(from, name) {
			validName(name);
			const state = await store.read();
			const definition = state.personas[from];
			if (!definition) throw new Error(`Unknown persona: ${from}`);
			if (state.personas[name]) throw new Error(`Persona already exists: ${name}`);
			state.personas[name] = structuredClone(definition);
			await store.write(state);
			return `Cloned persona '${from}' to '${name}'.`;
		},
		async saveAll(personas, renames, active, host) {
			for (const [name, definition] of Object.entries(personas)) {
				validName(name);
				try {
					await source(definition);
				} catch (error) {
					throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (active !== undefined && !personas[active]) throw new Error(`Unknown persona: ${active}`);
			const id = host.sessionId;
			const state = await store.read();
			const previousName = state.sessionPersonas[id];
			const previous = previousName ? state.personas[previousName] : undefined;
			const sessionPersonas: Record<string, string> = {};
			for (const [sessionId, selected] of Object.entries(state.sessionPersonas)) {
				const renamed = renames.get(selected) ?? selected;
				if (personas[renamed]) sessionPersonas[sessionId] = renamed;
			}
			if (active === undefined) delete sessionPersonas[id];
			else sessionPersonas[id] = active;
			state.personas = personas;
			state.sessionPersonas = sessionPersonas;
			await store.write(state);
			const next = active ? personas[active] : undefined;
			const promptChanged = JSON.stringify(previous) !== JSON.stringify(next);
			if (promptChanged) {
				warnings.delete(id);
				clearAnnotations(id);
				host.invalidatePromptCache();
				if (active && next) {
					host.appendEntry("neopi_persona", {
						name: active,
						sessionId: id,
						metadata: next.inheritToTasks ? { inheritToTasks: true } : {},
					});
				}
			}
			setUi(host.ui, active, promptChanged ? undefined : warnings.get(id));
			const count = Object.keys(personas).length;
			return `Saved ${count} persona${count === 1 ? "" : "s"} · active: ${active ?? "off"}.`;
		},
		async apply(systemPrompt, host) {
			const id = host.sessionId;
			const state = await store.read();
			const name = state.sessionPersonas[id];
			if (!name) return undefined;
			const definition = state.personas[name];
			try {
				if (!definition) throw new Error("selected persona no longer exists");
				const text = await source(definition);
				let result: string[];
				switch (definition.mode) {
					case "replace":
						result = [text];
						break;
					case "prepend":
						result = [text, ...systemPrompt];
						break;
					case "append":
						result = [...systemPrompt, text];
						break;
					case "literal-substitute": {
						const literal = definition.literal;
						if (!literal) throw new Error("literal substitute requires a non-empty literal");
						if (!systemPrompt.some(segment => segment.includes(literal)))
							throw new Error("literal not found in system prompt");
						result = systemPrompt.map(segment => segment.replaceAll(literal, text));
						break;
					}
				}
				warnings.delete(id);
				setUi(host.ui, name);
				return result;
			} catch (error) {
				const warning = error instanceof Error ? error.message : String(error);
				warnings.set(id, warning);
				setUi(host.ui, name, warning);
				const key = `${id}\0${name}\0${warning}`;
				if (!annotated.has(key)) {
					annotated.add(key);
					host.appendEntry("neopi_persona_warning", { command: `/persona use ${name}`, name, warning });
				}
				return undefined;
			}
		},
	};
}

export function parsePersonaDefinition(
	mode: string,
	sourceKind: string,
	value: string,
	literal?: string,
	inheritToTasks = false,
): PersonaDefinition {
	if (!PERSONA_MODES.includes(mode as PersonaMode)) throw new Error("Invalid persona mode");
	if (sourceKind !== "inline" && sourceKind !== "file") throw new Error("Invalid persona source kind");
	return {
		mode: mode as PersonaMode,
		source: sourceKind === "inline" ? { kind: "inline", content: value } : { kind: "file", path: value },
		...(literal ? { literal } : {}),
		...(inheritToTasks ? { inheritToTasks: true } : {}),
	};
}

let sharedPersonas: PersonaFeature | undefined;

/** Process-wide persona feature bound to the active profile's agent dir. */
export function personaFeature(): PersonaFeature {
	sharedPersonas ??= createPersonaFeature();
	return sharedPersonas;
}

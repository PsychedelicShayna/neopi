/**
 * Live personas: named instruction sets for the live voice model.
 *
 * Shares the NeoPi persona conventions: schema-v1 JSON state in the agent dir
 * written atomically through {@link JsonStateStore}, a named-persona record,
 * and loud errors on invalid mutations. The "default" persona is the bundled prompts/live-instructions.md
 * template: it is never stored, cannot be edited, deleted, or replaced (clone
 * it instead), and is what the resolver falls back to whenever the store is
 * missing, corrupt, or the selection dangles.
 *
 * Integration seam: {@link resolveLiveInstructions} returns the active
 * persona's raw instruction text with {{firstName}}/{{username}} template
 * variables intact, so the live controller can pass it through `prompt.render`
 * exactly as it renders the bundled template today.
 */
import * as nodePath from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { isRecord, JsonStateStore } from "../neopi/json-state";
import { normalizeLiveIngestSettings, type LiveIngestPersonaSettings } from "./ingest-settings";
import liveInstructionsTemplate from "./prompts/live-instructions.md" with { type: "text" };

/** Reserved name of the immutable bundled persona. */
export const DEFAULT_LIVE_PERSONA = "default";

/** Bundled default instruction template (raw, template variables intact). */
export const defaultLiveInstructions: string = liveInstructionsTemplate;

export interface LivePersonaDefinition {
	/** Raw live-model instructions; may reference {{firstName}}/{{username}} for prompt.render. */
	instructions: string;
	ingest?: LiveIngestPersonaSettings;
}

export interface LivePersonaState {
	schemaVersion: 1;
	/** Custom personas by name; the bundled "default" is never stored. */
	personas: Record<string, LivePersonaDefinition>;
	/** Resolved settings for the bundled default, whose instruction text remains immutable. */
	defaultIngest?: LiveIngestPersonaSettings;
	/** Selected persona name; absent means the bundled default. */
	active?: string;
}

export const emptyLivePersonaState = (): LivePersonaState => ({ schemaVersion: 1, personas: {} });

const isDefinition = (v: unknown): v is LivePersonaDefinition => isRecord(v) && typeof v.instructions === "string";

export function validateLivePersonaState(v: unknown): LivePersonaState {
	if (
		!isRecord(v) ||
		v.schemaVersion !== 1 ||
		!isRecord(v.personas) ||
		!Object.values(v.personas).every(isDefinition) ||
		(v.active !== undefined && typeof v.active !== "string")
	) {
		throw new Error("Invalid schema-v1 neopi-live-personas.json");
	}
	const state = v as unknown as LivePersonaState;
	const validateIngest = (value: unknown, field: string): void => {
		if (value === undefined) return;
		try {
			normalizeLiveIngestSettings(value);
		} catch (error) {
			throw new Error(
				`Invalid schema-v1 neopi-live-personas.json: ${field} ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	validateIngest(state.defaultIngest, "defaultIngest");
	for (const [name, persona] of Object.entries(state.personas))
		validateIngest(persona.ingest, `personas.${name}.ingest`);
	return v as unknown as LivePersonaState;
}

/** State file beside neopi-persona.json: profile, XDG, and PI_CODING_AGENT_DIR aware. */
export const defaultLivePersonaStatePath = (): string => nodePath.join(getAgentDir(), "neopi-live-personas.json");

/** Atomic schema-v1 store for live personas; see {@link JsonStateStore}. */
export class LivePersonaStore extends JsonStateStore<LivePersonaState> {
	constructor(path: string | (() => string) = defaultLivePersonaStatePath) {
		super(path, "omomp-live-personas.json", validateLivePersonaState, emptyLivePersonaState);
	}
}

export interface LivePersonaItem {
	name: string;
	instructions: string;
	active: boolean;
	/** True only for the immutable bundled default. */
	builtin: boolean;
	ingest: LiveIngestPersonaSettings;
}

export interface LivePersonaData {
	items: LivePersonaItem[];
	active: string;
}

export interface LivePersonaFeature {
	data(): Promise<LivePersonaData>;
	list(): Promise<string>;
	show(name: string): Promise<string>;
	status(): Promise<string>;
	use(name: string): Promise<string>;
	clone(source: string, name: string): Promise<string>;
	edit(name: string, instructions: string): Promise<string>;
	delete(name: string): Promise<string>;
	/**
	 * Replace every custom live persona at once (the configuration menu's save).
	 * `active` undefined selects the bundled default.
	 */
	saveAll(
		personas: Record<string, LivePersonaDefinition>,
		active: string | undefined,
		defaultIngest?: LiveIngestPersonaSettings,
	): Promise<string>;
}

const stateListeners = new Set<() => void>();

export function onLivePersonaStateChanged(listener: () => void): () => void {
	stateListeners.add(listener);
	return () => {
		stateListeners.delete(listener);
	};
}

function notifyLivePersonaStateChanged(): void {
	for (const listener of stateListeners) {
		try {
			listener();
		} catch (error) {
			logger.debug("live persona state listener failed", { error: String(error) });
		}
	}
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validName(name: string): void {
	if (!NAME_PATTERN.test(name)) {
		throw new Error("Live persona name must contain only letters, numbers, '.', '_' or '-'");
	}
}

/** The bundled default may be cloned but never edited, deleted, or shadowed. */
function assertMutable(name: string): void {
	if (name.toLowerCase() === DEFAULT_LIVE_PERSONA) {
		throw new Error(
			`Live persona '${DEFAULT_LIVE_PERSONA}' is immutable: it cannot be edited, deleted, or replaced. Clone it instead.`,
		);
	}
}

export function createLivePersonaFeature(store: LivePersonaStore = new LivePersonaStore()): LivePersonaFeature {
	function instructionsOf(state: LivePersonaState, name: string): string {
		if (name === DEFAULT_LIVE_PERSONA) return liveInstructionsTemplate;
		const definition = state.personas[name];
		if (!definition) throw new Error(`Unknown live persona: ${name}`);
		return definition.instructions;
	}
	async function data(): Promise<LivePersonaData> {
		const state = await store.read();
		const active = state.active && state.personas[state.active] ? state.active : DEFAULT_LIVE_PERSONA;
		const customs = Object.entries(state.personas)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, definition]) => ({
				name,
				instructions: definition.instructions,
				active: name === active,
				builtin: false,
				ingest: normalizeLiveIngestSettings(definition.ingest),
			}));
		return {
			active,
			items: [
				{
					name: DEFAULT_LIVE_PERSONA,
					instructions: liveInstructionsTemplate,
					active: active === DEFAULT_LIVE_PERSONA,
					builtin: true,
					ingest: normalizeLiveIngestSettings(state.defaultIngest),
				},
				...customs,
			],
		};
	}
	return {
		data,
		async list() {
			const d = await data();
			return d.items.map(x => `${x.active ? "*" : "-"} ${x.name}${x.builtin ? " (built-in)" : ""}`).join("\n");
		},
		async show(name) {
			return instructionsOf(await store.read(), name);
		},
		async status() {
			return `Live persona: ${(await data()).active}`;
		},
		async use(name) {
			const state = await store.read();
			instructionsOf(state, name);
			if (name === DEFAULT_LIVE_PERSONA) delete state.active;
			else state.active = name;
			await store.write(state);
			notifyLivePersonaStateChanged();
			return `Live persona '${name}' will be used for the next live session.`;
		},
		async clone(source, name) {
			validName(name);
			assertMutable(name);
			const state = await store.read();
			if (state.personas[name]) throw new Error(`Live persona already exists: ${name}`);
			state.personas[name] = {
				instructions: instructionsOf(state, source),
				ingest:
					source === DEFAULT_LIVE_PERSONA
						? state.defaultIngest && normalizeLiveIngestSettings(state.defaultIngest)
						: state.personas[source]?.ingest && normalizeLiveIngestSettings(state.personas[source]?.ingest),
			};
			await store.write(state);
			notifyLivePersonaStateChanged();
			return `Cloned live persona '${source}' into '${name}'.`;
		},
		async edit(name, instructions) {
			validName(name);
			assertMutable(name);
			const state = await store.read();
			if (!state.personas[name]) throw new Error(`Unknown live persona: ${name}`);
			if (!instructions.trim()) throw new Error("live persona instructions are empty");
			state.personas[name] = { ...state.personas[name], instructions };
			await store.write(state);
			notifyLivePersonaStateChanged();
			return `Updated live persona '${name}'.`;
		},
		async delete(name) {
			assertMutable(name);
			const state = await store.read();
			if (!state.personas[name]) throw new Error(`Unknown live persona: ${name}`);
			delete state.personas[name];
			if (state.active === name) delete state.active;
			await store.write(state);
			notifyLivePersonaStateChanged();
			return `Deleted live persona '${name}'.`;
		},
		async saveAll(personas, active, defaultIngest) {
			for (const [name, definition] of Object.entries(personas)) {
				validName(name);
				assertMutable(name);
				if (!definition.instructions.trim()) throw new Error(`${name}: live persona instructions are empty`);
			}
			const selected = active === DEFAULT_LIVE_PERSONA ? undefined : active;
			if (selected !== undefined && !personas[selected]) throw new Error(`Unknown live persona: ${selected}`);
			const state = await store.read();
			state.personas = personas;
			if (selected === undefined) delete state.active;
			else state.active = selected;
			if (defaultIngest === undefined) delete state.defaultIngest;
			else state.defaultIngest = normalizeLiveIngestSettings(defaultIngest);
			await store.write(state);
			notifyLivePersonaStateChanged();
			const count = Object.keys(personas).length;
			return `Saved ${count} live persona${count === 1 ? "" : "s"} · next live session uses '${selected ?? DEFAULT_LIVE_PERSONA}'.`;
		},
	};
}

/**
 * Resolve the instruction template for the next live session.
 *
 * Returns the active persona's raw instruction text, or the bundled
 * live-instructions.md template when no custom persona is selected. Never
 * throws: a missing, corrupt, or dangling store degrades to the default with a
 * logged warning, so live call start cannot be broken by persona state.
 *
 * Template variables ({{firstName}}, {{username}}) are preserved verbatim for
 * the controller's existing `prompt.render(instructions, user)` call.
 */
export async function resolveLiveInstructions(statePath?: string): Promise<string> {
	const store = new LivePersonaStore(statePath);
	let state: LivePersonaState;
	try {
		state = await store.read();
	} catch (error) {
		logger.warn("Live persona state unreadable; using default live instructions", {
			path: store.path,
			error: error instanceof Error ? error.message : String(error),
		});
		return liveInstructionsTemplate;
	}
	const active = state.active;
	if (!active || active === DEFAULT_LIVE_PERSONA) return liveInstructionsTemplate;
	const definition = state.personas[active];
	if (!definition?.instructions.trim()) {
		logger.warn("Active live persona missing or empty; using default live instructions", {
			path: store.path,
			active,
		});
		return liveInstructionsTemplate;
	}
	return definition.instructions;
}

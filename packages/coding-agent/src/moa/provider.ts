/**
 * The keyless `mixture` provider. Every valid mixture definition is a model
 * `mixture/<name>` of the custom API `mixture`, registered per `ModelRegistry`
 * (the unit sessions share: a subagent borrows its parent's registry).
 *
 * Sessions never run a mixture through this API: the primary agent's stream
 * wrapper branches to the engine with the session's own host before any
 * provider dispatch. The process-wide dispatcher registered here therefore
 * only answers stray calls (a side request, a completeSimple on the live
 * model) with a loud error; headless hosts arrive with the gateway (M6).
 */
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@oh-my-pi/pi-ai";
import { getCustomApi, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry, ProviderConfigInput } from "../config/model-registry";
import { mixtureScopeKey } from "./config";
import type { ResolvedMixture } from "./types";

export const MIXTURE_PROVIDER = "mixture";
export const MIXTURE_API = "mixture";

/** Whether a model is a mixture: a structured fact of its API, never its provider name. */
export function isMixtureModel(model: Pick<Model<Api>, "api">): boolean {
	return model.api === MIXTURE_API;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Answer a mixture call that reached provider dispatch: only a session or a gateway can run one. */
function streamUnhostedMixture(
	model: Model<Api>,
	_context: Context,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "error",
		errorMessage: `${model.provider}/${model.id} can only run inside a session or a gateway`,
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "error", reason: "error", error: message });
	return stream;
}

/**
 * Register the mixture API once per process, beside `registerLocalInferenceApi`.
 * No source id: extension source cleanup must never remove it.
 */
export function registerMixtureApi(): void {
	if (getCustomApi(MIXTURE_API)) return;
	registerCustomApi(MIXTURE_API, streamUnhostedMixture);
}

const catalogs = new WeakMap<ModelRegistry, MixtureCatalog>();

/** One workspace scope's roster inside a catalog: what its sessions may run. */
export interface MixtureScope {
	/** The serialized `MIXTURES.toml` search path of the workspace ({@link mixtureScopeKey}). */
	readonly key: string;
	/** Whether this scope has a roster since its last owner released it; an empty roster counts. */
	readonly hasRoster: boolean;
	/** Serialize discovery and retain this owner's resolved metadata until it releases. */
	initializeRoster(
		owner: string,
		load: () => Promise<readonly ResolvedMixture[]>,
		restoredRoster?: readonly ResolvedMixture[],
	): Promise<void>;
	/** A session or gateway holds this scope. */
	retain(owner: string): void;
	/** The last owner drops this scope's roster and the provider re-registers the rest. */
	release(owner: string): void;
	/**
	 * Set this scope's definitions. A name another live scope registered with a different
	 * revision is refused here (`name.scope_conflict`, logged) and left out of the roster.
	 */
	setRoster(mixtures: readonly ResolvedMixture[]): void;
	/** This scope's registered definitions only. */
	roster(): readonly ResolvedMixture[];
	/** This scope's definition of a name; the session host resolves only through it. */
	find(name: string): ResolvedMixture | undefined;
	/** The owner's resolved definitions, kept separately from the scope's first-writer roster. */
	resolution(owner: string): readonly ResolvedMixture[] | undefined;
	/** Notify a live owner when a provider registration changes the shared model metadata. */
	observe(owner: string, listener: () => void): void;
}

interface ScopeState {
	owners: Set<string>;
	roster: ResolvedMixture[] | undefined;
	/** Resolution variants supplied by live owners, including shared names with different model roles. */
	resolutions: Map<string, readonly ResolvedMixture[]>;
	listeners: Map<string, () => void>;
	initialization?: Promise<void>;
	/** An explicit edit supersedes file discovery until the last owner releases the scope. */
	saved?: boolean;
}

/**
 * One catalog per `ModelRegistry`, with one roster per workspace scope. The provider
 * registers the union over live scopes, exactly one definition per name, so the
 * registered model never describes a definition other than the one a session runs.
 */
export class MixtureCatalog {
	readonly id: string;
	readonly baseUrl: string;
	readonly #registry: ModelRegistry;
	/** In registration order: the first scope to register a name holds it. */
	readonly #scopes = new Map<string, ScopeState>();
	#registered = false;
	#registeredModels: MixtureModelDefinition[] = [];

	private constructor(registry: ModelRegistry) {
		this.#registry = registry;
		this.id = Bun.randomUUIDv7();
		this.baseUrl = `mixture://catalog/${this.id}`;
	}

	static for(registry: ModelRegistry): MixtureCatalog {
		let catalog = catalogs.get(registry);
		if (!catalog) {
			catalog = new MixtureCatalog(registry);
			catalogs.set(registry, catalog);
		}
		return catalog;
	}

	/** The scope of a workspace: sessions whose `MIXTURES.toml` search path is the same share it. */
	scope(cwd: string, agentDir?: string): MixtureScope {
		const key = mixtureScopeKey(cwd, agentDir);
		const scopes = this.#scopes;
		const register = (): void => this.#register();
		const setRoster = (mixtures: readonly ResolvedMixture[]): void => this.#setScopeRoster(key, mixtures, true);
		const installDiscovered = (mixtures: readonly ResolvedMixture[]): void => this.#setScopeRoster(key, mixtures);
		return {
			key,
			get hasRoster() {
				return scopes.get(key)?.roster !== undefined;
			},
			async initializeRoster(owner, load, restoredRoster) {
				const state = scopes.get(key);
				if (!state?.owners.has(owner)) throw new Error(`Mixture scope ${key} must be retained before discovery`);
				if (state.saved) return;
				const previous = state.initialization;
				const initialization = (async () => {
					if (previous) await previous;
					if (scopes.get(key) !== state || state.saved) return;
					const before = state.roster;
					const discovered = await load();
					// A retired scope or explicit save must not be overwritten by stale discovery.
					if (scopes.get(key) !== state || !state.owners.has(owner) || state.roster !== before || state.saved)
						return;
					const merged = [...(before ?? restoredRoster ?? [])];
					const names = new Set(merged.map(mixture => mixture.definition.name));
					for (const mixture of discovered) {
						if (names.has(mixture.definition.name)) continue;
						names.add(mixture.definition.name);
						merged.push(mixture);
					}
					state.resolutions.set(owner, discovered);
					if (before === undefined || merged.length !== before.length) installDiscovered(merged);
					else register();
				})().finally(() => {
					if (state.initialization === initialization) state.initialization = undefined;
				});
				state.initialization = initialization;
				await initialization;
			},
			retain(owner) {
				let state = scopes.get(key);
				if (!state) {
					state = { owners: new Set(), roster: undefined, resolutions: new Map(), listeners: new Map() };
					scopes.set(key, state);
				}
				state.owners.add(owner);
			},
			release(owner) {
				const state = scopes.get(key);
				if (!state?.owners.delete(owner)) return;
				state.listeners.delete(owner);
				if (state.resolutions.delete(owner) && state.owners.size > 0 && !state.saved) register();
				if (state.owners.size > 0) return;
				scopes.delete(key);
				register();
			},
			setRoster,
			roster() {
				return scopes.get(key)?.roster ?? [];
			},
			find(name) {
				return scopes.get(key)?.roster?.find(mixture => mixture.definition.name === name);
			},
			resolution(owner) {
				return scopes.get(key)?.resolutions.get(owner);
			},
			observe(owner, listener) {
				const state = scopes.get(key);
				if (!state?.owners.has(owner)) throw new Error(`Mixture scope ${key} must be retained before observing`);
				state.listeners.set(owner, listener);
			},
		};
	}

	/** Every registered definition across live scopes, one per name. */
	roster(): readonly ResolvedMixture[] {
		const byName = new Map<string, ResolvedMixture>();
		for (const state of this.#scopes.values()) {
			for (const mixture of state.roster ?? []) {
				if (!byName.has(mixture.definition.name)) byName.set(mixture.definition.name, mixture);
			}
		}
		return [...byName.values()];
	}

	#setScopeRoster(key: string, mixtures: readonly ResolvedMixture[], saved = false): void {
		let state = this.#scopes.get(key);
		if (!state) {
			state = { owners: new Set(), roster: undefined, resolutions: new Map(), listeners: new Map() };
			this.#scopes.set(key, state);
		}
		if (saved) {
			state.saved = true;
			state.resolutions.clear();
		}
		// What the other live scopes registered: a differing definition of one of those names conflicts.
		const held = new Map<string, { scope: string; mixture: ResolvedMixture }>();
		for (const [scope, other] of this.#scopes) {
			if (scope === key) continue;
			for (const mixture of other.roster ?? []) {
				if (!held.has(mixture.definition.name)) held.set(mixture.definition.name, { scope, mixture });
			}
		}
		state.roster = mixtures.filter(mixture => {
			const holder = held.get(mixture.definition.name);
			if (!holder || holder.mixture.revision === mixture.revision) return true;
			logger.warn("Mixture refused at registration", {
				mixture: mixture.definition.name,
				code: "name.scope_conflict",
				message: `another workspace on this registry already registered mixture/${mixture.definition.name} with a different definition`,
				scope: key,
				holder: holder.scope,
			});
			return false;
		});
		this.#register();
	}

	/** Register the union over live scopes, conservatively bounded by every live owner's resolution. */
	#register(): void {
		const models = new Map<string, MixtureModelDefinition>();
		for (const state of this.#scopes.values()) {
			const accepted = new Set<string>();
			for (const mixture of state.roster ?? []) {
				const name = mixture.definition.name;
				accepted.add(name);
				if (!models.has(name)) models.set(name, mixtureModelDefinition(mixture));
			}
			if (state.saved) continue;
			for (const resolutions of state.resolutions.values()) {
				for (const mixture of resolutions) {
					const name = mixture.definition.name;
					if (!accepted.has(name)) continue;
					const current = models.get(name)!;
					const variant = mixtureModelDefinition(mixture);
					models.set(name, {
						...current,
						input: current.input!.filter(modality => variant.input?.includes(modality)),
						supportsTools: current.supportsTools && variant.supportsTools,
						contextWindow: Math.min(current.contextWindow!, variant.contextWindow!),
						maxTokens: Math.min(current.maxTokens!, variant.maxTokens!),
					});
				}
			}
		}
		const roster = [...models.values()];
		if (roster.length === 0) {
			// registerProvider only replaces models when the list is non-empty.
			if (this.#registered) this.#registry.unregisterProvider(MIXTURE_PROVIDER);
			this.#registered = false;
			this.#registeredModels = [];
			return;
		}
		const previous = this.#registeredModels;
		if (
			this.#registered &&
			previous.length === roster.length &&
			previous.every((model, index) => {
				const next = roster[index]!;
				return (
					model.id === next.id &&
					model.name === next.name &&
					model.supportsTools === next.supportsTools &&
					model.contextWindow === next.contextWindow &&
					model.maxTokens === next.maxTokens &&
					model.input?.length === next.input?.length &&
					model.input?.every((modality, i) => modality === next.input?.[i])
				);
			})
		)
			return;
		// A registration can mutate provider state before throwing. Invalidate
		// the metadata cache before the call so cleanup cannot mistake a partial
		// registration for the previous successful one.
		this.#registered = true;
		this.#registeredModels = [];
		this.#registry.registerProvider(MIXTURE_PROVIDER, {
			baseUrl: this.baseUrl,
			api: MIXTURE_API,
			auth: "none",
			models: roster,
		});
		this.#registeredModels = roster;
		for (const state of this.#scopes.values()) {
			for (const listener of state.listeners.values()) {
				try {
					listener();
				} catch (error) {
					logger.warn("Mixture catalog listener failed after registration", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	}
}

type MixtureModelDefinition = NonNullable<ProviderConfigInput["models"]>[number];

function mixtureModelDefinition(mixture: ResolvedMixture): MixtureModelDefinition {
	const definition = mixture.definition;
	const models = Object.values(mixture.members).flatMap(member => (member.kind === "model" ? [member] : []));
	const entry = mixture.members[definition.entry];
	const entryModel = entry?.kind === "model" ? entry.model : models[0]?.model;
	return {
		id: definition.name,
		name: definition.description ?? definition.name,
		reasoning: true,
		input: entryModel ? [...entryModel.input] : ["text"],
		supportsTools: models.some(member => member.toolPolicy !== false),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entryModel?.contextWindow ?? 0,
		maxTokens: Math.max(0, ...models.map(member => member.maxTokens ?? member.model.maxTokens ?? 0)),
	};
}

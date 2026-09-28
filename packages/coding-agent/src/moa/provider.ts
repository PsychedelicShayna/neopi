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
}

interface ScopeState {
	owners: Set<string>;
	roster: ResolvedMixture[] | undefined;
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
		const setRoster = (mixtures: readonly ResolvedMixture[]): void => this.#setScopeRoster(key, mixtures);
		return {
			key,
			get hasRoster() {
				return scopes.get(key)?.roster !== undefined;
			},
			retain(owner) {
				let state = scopes.get(key);
				if (!state) {
					state = { owners: new Set(), roster: undefined };
					scopes.set(key, state);
				}
				state.owners.add(owner);
			},
			release(owner) {
				const state = scopes.get(key);
				if (!state?.owners.delete(owner) || state.owners.size > 0) return;
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

	#setScopeRoster(key: string, mixtures: readonly ResolvedMixture[]): void {
		let state = this.#scopes.get(key);
		if (!state) {
			state = { owners: new Set(), roster: undefined };
			this.#scopes.set(key, state);
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

	/** Register the union over live scopes; an empty union unregisters the provider. */
	#register(): void {
		const roster = this.roster();
		if (roster.length === 0) {
			// registerProvider only replaces models when the list is non-empty.
			if (this.#registered) this.#registry.unregisterProvider(MIXTURE_PROVIDER);
			this.#registered = false;
			return;
		}
		this.#registry.registerProvider(MIXTURE_PROVIDER, {
			baseUrl: this.baseUrl,
			api: MIXTURE_API,
			auth: "none",
			models: roster.map(mixtureModelDefinition),
		});
		this.#registered = true;
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

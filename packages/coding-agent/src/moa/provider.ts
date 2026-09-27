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
import type { ModelRegistry, ProviderConfigInput } from "../config/model-registry";
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

/** One catalog per `ModelRegistry`: owners retain it, the roster decides what is registered. */
export class MixtureCatalog {
	readonly id: string;
	readonly baseUrl: string;
	readonly #registry: ModelRegistry;
	readonly #owners = new Set<string>();
	#roster: ResolvedMixture[] = [];
	#hasRoster = false;
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

	/** Whether a roster was ever set since the catalog was last released; an empty roster counts. */
	get hasRoster(): boolean {
		return this.#hasRoster;
	}

	/** A session or gateway holds the catalog. */
	retain(owner: string): void {
		this.#owners.add(owner);
	}

	/** The last release unregisters the provider. Releasing twice is harmless. */
	release(owner: string): void {
		if (!this.#owners.delete(owner) || this.#owners.size > 0) return;
		this.setRoster([]);
		this.#hasRoster = false;
	}

	/** Replace the registered mixtures; an empty roster unregisters the provider. */
	setRoster(mixtures: readonly ResolvedMixture[]): void {
		this.#roster = [...mixtures];
		this.#hasRoster = true;
		if (this.#roster.length === 0) {
			// registerProvider only replaces models when the list is non-empty.
			if (this.#registered) this.#registry.unregisterProvider(MIXTURE_PROVIDER);
			this.#registered = false;
			return;
		}
		this.#registry.registerProvider(MIXTURE_PROVIDER, {
			baseUrl: this.baseUrl,
			api: MIXTURE_API,
			auth: "none",
			models: this.#roster.map(mixtureModelDefinition),
		});
		this.#registered = true;
	}

	roster(): readonly ResolvedMixture[] {
		return this.#roster;
	}

	/** The registered resolution for a mixture name. */
	find(name: string): ResolvedMixture | undefined {
		return this.#roster.find(mixture => mixture.definition.name === name);
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

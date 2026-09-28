import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { modelKind, type Api, type Model, type ModelKind, type ModelSpec, type ThinkingConfig } from "@oh-my-pi/pi-catalog/types";
import { SwitchError } from "./error";
import type { KindProtocol, ModelRow, ProviderConfig } from "./config/types";

/** Prepared models belong only to the current Generation, never the shared ModelRegistry. */
export interface PreparedModel {
	model: Model<Api>;
	provider: ProviderConfig;
	hidden: boolean;
	aliases: readonly string[];
	/** Missing prices must not be presented as known zero-cost usage. */
	unpriced: boolean;
}

const KIND_APIS: Readonly<Record<KindProtocol, Api>> = {
	"openai-embeddings": "openai-embeddings",
	"openrouter-rerank": "openrouter-rerank",
	"openai-images": "openai-images",
	"openai-speech": "openai-speech",
	"openai-transcriptions": "openai-transcriptions",
	"openrouter-video": "openrouter-video",
};

function modelApi(provider: ProviderConfig, kind: ModelKind): Api {
	if (kind === "chat" || kind === "judge") {
		switch (provider.protocol) {
			case "openai-chat": return "openai-completions";
			case "openai-responses": return "openai-responses";
			case "anthropic-messages": return "anthropic-messages";
		}
	} else {
		const selected = provider.protocols[kind as keyof ProviderConfig["protocols"]];
		if (selected) return KIND_APIS[selected];
	}
	throw new SwitchError(422, "model_protocol_missing", `Provider ${provider.id} does not configure a transport for ${kind}`);
}

function thinking(row: ModelRow, api: Api, previous?: ThinkingConfig): ThinkingConfig | undefined {
	if (row.reasoning === false) return undefined;
	if (row.efforts === undefined && row.effortMap === undefined && row.reasoning === undefined) return previous;
	const mode = previous?.mode ?? (api === "anthropic-messages" ? "budget" : "effort");
	return { mode, efforts: row.efforts ?? previous?.efforts ?? THINKING_EFFORTS, ...(row.effortMap ?? previous?.effortMap ? { effortMap: row.effortMap ?? previous?.effortMap } : {}) };
}

/** Merge row-declared fields, not decoder defaults, over a discovered/catalog row. */
function merge(provider: ProviderConfig, row: ModelRow, discovered?: Model<Api>, defaultApi?: Api): PreparedModel {
	const has = (name: string): boolean => row.declaredFields.includes(name);
	const api = discovered?.api ?? defaultApi ?? modelApi(provider, row.kind);
	if (!discovered && provider.kind === "http" && (row.contextWindow === undefined || row.maxOutput === undefined)) {
		throw new SwitchError(422, "model_incomplete", `Added model ${provider.id}/${row.id} needs context_window and max_output`);
	}
	const price = row.cost;
	const cost = price ? { input: price.input, output: price.output, cacheRead: price.input, cacheWrite: price.input } : discovered?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const prior: ModelSpec<Api> | undefined = discovered && (() => {
		const {
			compat, compatConfig, identity, requiresGlyphTokenization, requiresCursorToolSchemaProjection,
			requiresToolResultImageHoisting, supportsAssistantPrefill, supportsComputerUseConfig, ...authored
		} = discovered;
		return { ...authored, ...(compatConfig ? { compat: compatConfig } : {}) };
	})();
	const spec: ModelSpec<Api> = {
		...prior,
		id: row.id,
		name: has("name") ? row.name! : prior?.name ?? row.name ?? row.id,
		api,
		provider: provider.id,
		...(provider.catalog ? { providerType: provider.catalog } : {}),
		baseUrl: provider.baseUrl ?? prior?.baseUrl ?? "",
		reasoning: has("reasoning") ? row.reasoning! : prior?.reasoning ?? false,
		input: has("input") ? row.input! : prior?.input ?? ["text"],
		cost,
		contextWindow: has("context_window") ? row.contextWindow! : prior?.contextWindow ?? null,
		maxTokens: has("max_output") ? row.maxOutput! : prior?.maxTokens ?? null,
		...(has("upstream_id") || !discovered ? { requestModelId: row.upstreamId } : {}),
		...(has("supports_tools") ? { supportsTools: row.supportsTools } : {}),
		...(has("kind") || !discovered ? { kind: row.kind } : {}),
		thinking: thinking({ ...row, reasoning: has("reasoning") ? row.reasoning : undefined, efforts: has("efforts") ? row.efforts : undefined, effortMap: has("effort_map") ? row.effortMap : undefined }, api, prior?.thinking),
		headers: { ...prior?.headers, ...provider.headers },
	};
	return { model: buildModel(spec), provider, hidden: row.hidden, aliases: row.aliases, unpriced: !price && provider.kind === "http" && (!discovered || Object.values(discovered.cost).every(value => typeof value === "number" && value === 0)) };
}

/**
 * Materialize one provider's discovered rows plus its exact-id config overrides.
 * Discovery itself runs before this call; no secret or selected credential is ever stored in a Model.
 */
export function prepareProviderModels(provider: ProviderConfig, discovered: readonly Model<Api>[]): PreparedModel[] {
	if (!provider.enabled) return [];
	const source = new Map(discovered.filter(model => model.provider === (provider.catalog ?? provider.id)).map(model => [model.id, model]));
	const rows = new Map(provider.models.map(row => [row.id, row]));
	if (rows.size !== provider.models.length) throw new SwitchError(422, "model_duplicate", `Provider ${provider.id} declares a duplicate model id`);
	const result: PreparedModel[] = [];
	const catalogApi = provider.kind === "catalog" && source.size && new Set([...source.values()].map(model => model.api)).size === 1
		? source.values().next().value?.api : undefined;
	for (const model of source.values()) {
		const row = rows.get(model.id);
		if (row) { result.push(merge(provider, row, model)); rows.delete(model.id); }
		else result.push(merge(provider, { id: model.id, upstreamId: model.requestModelId ?? model.id, kind: modelKind(model), hidden: false, aliases: [], declaredFields: [] }, model));
	}
	for (const row of rows.values()) result.push(merge(provider, row, undefined, catalogApi));
	const ids = new Set<string>();
	for (const entry of result) {
		const kind = modelKind(entry.model);
		if (!entry.model.api || !entry.model.id || !entry.model.provider || (provider.kind === "http" && !provider.protocol && kind === "chat")) throw new SwitchError(422, "model_incomplete", `Model ${provider.id}/${entry.model.id} cannot be dispatched`);
		for (const id of [entry.model.id, ...entry.aliases]) {
			if (ids.has(id)) throw new SwitchError(422, "model_duplicate", `Provider ${provider.id} repeats model id or alias ${id}`);
			ids.add(id);
		}
	}
	return result;
}

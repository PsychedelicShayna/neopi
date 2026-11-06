import type { HubModelConfigEntry } from "@oh-my-pi/pi-tui/overlays/model-overrides";
import type { ModelConfigFieldSchema } from "@oh-my-pi/pi-tui/overlays/model-config-fields";
import { getModelsConfigSchemaBundle } from "./models-config-schema-bundle";
import type { ConfigFile } from "./config-file";
import type { ModelsConfig } from "./models-config-schema";

/** Edit native models.toml through ConfigFile's comment-preserving, stale-safe saves. */
export class ModelConfigEditor {
	#snapshot: ModelsConfig | null | undefined;
	constructor(readonly file: ConfigFile<ModelsConfig>) {}

	#load(): ModelsConfig | null {
		this.file.invalidate();
		const result = this.file.tryLoad(true);
		if (result.status === "error") throw result.error;
		return structuredClone(result.value ?? null);
	}

	list(): HubModelConfigEntry[] {
		this.#snapshot = this.#load();
		return Object.entries(this.#snapshot?.providers ?? {}).flatMap(([provider, config]) => [
			...Object.entries(config.modelOverrides ?? {}).map(([id, fields]) => ({
				provider,
				id,
				kind: "override" as const,
				fields: structuredClone(fields) as Record<string, unknown>,
			})),
			...(config.models ?? []).map((model, index) => {
				const { id, ...fields } = model;
				return {
					provider,
					id,
					kind: "custom" as const,
					index,
					fields: structuredClone(fields) as Record<string, unknown>,
				};
			}),
		]);
	}

	schema(kind: HubModelConfigEntry["kind"]): ModelConfigFieldSchema {
		const bundle = getModelsConfigSchemaBundle();
		const schema = (kind === "custom" ? bundle.ModelDefinitionSchema : bundle.ModelOverrideSchema).toJsonSchema({
			io: "input",
		}) as ModelConfigFieldSchema;
		if (kind === "custom" && schema.properties) delete schema.properties.id;
		return schema;
	}

	#edit(): ModelsConfig {
		if (this.#snapshot === undefined) this.list();
		return structuredClone(this.#snapshot ?? {});
	}

	async save(entry: HubModelConfigEntry, original?: HubModelConfigEntry): Promise<void> {
		if (!entry.provider.trim() || !entry.id.trim()) throw new Error("Provider and model ID are required.");
		if (original && (entry.provider !== original.provider || entry.kind !== original.kind))
			throw new Error("Provider and entry type cannot change while editing an existing entry.");
		const config = this.#edit();
		const providers = (config.providers ??= {});
		const provider = Object.hasOwn(providers, entry.provider) ? providers[entry.provider] : {};
		Object.defineProperty(providers, entry.provider, {
			value: provider,
			enumerable: true,
			writable: true,
			configurable: true,
		});
		if (entry.kind === "override") {
			const overrides = (provider.modelOverrides ??= {});
			if ((!original || original.id !== entry.id) && Object.hasOwn(overrides, entry.id))
				throw new Error("This override already exists.");
			if (original && original.id !== entry.id) delete overrides[original.id];
			Object.defineProperty(overrides, entry.id, {
				value: structuredClone(entry.fields),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		} else {
			const models = (provider.models ??= []);
			if (models.some((model, index) => model.id === entry.id && index !== original?.index))
				throw new Error("This custom model already exists.");
			const model = { ...entry.fields, id: entry.id };
			if (original?.index !== undefined) {
				if (models[original.index]?.id !== original.id) throw new Error("Model changed on disk. Reopen the entry.");
				models[original.index] = model;
			} else models.push(model);
		}
		await this.file.save(config, this.#snapshot ?? null);
	}

	async remove(entry: HubModelConfigEntry): Promise<void> {
		const config = this.#edit();
		const provider = config.providers?.[entry.provider];
		if (!provider) throw new Error("Provider no longer exists.");
		if (entry.kind === "override") {
			delete provider.modelOverrides?.[entry.id];
			if (Object.keys(provider.modelOverrides ?? {}).length === 0) delete provider.modelOverrides;
		} else {
			if (entry.index === undefined || provider.models?.[entry.index]?.id !== entry.id)
				throw new Error("Model changed on disk. Reopen the entry.");
			provider.models.splice(entry.index, 1);
			if (provider.models.length === 0) delete provider.models;
		}
		if (Object.keys(provider).length === 0) delete config.providers?.[entry.provider];
		await this.file.save(config, this.#snapshot ?? null);
	}
}

import * as fs from "node:fs";
import * as path from "node:path";
import { OmpErrors, type Type } from "@oh-my-pi/omptype";
import { getAgentDir, isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import {
	importLegacyYaml,
	patchSettingsToml,
	readTomlConfigSync,
	type TomlConfigSource,
} from "@oh-my-pi/pi-utils/settings-toml";
import { JSONC } from "bun";
import { writeFileAtomically } from "../utils/atomic-file";

/** Minimal subset of the AJV ConfigSchemaError shape this module actually relies on. */
interface ConfigSchemaError {
	instancePath: string;
	message: string | undefined;
}

export type ConfigSchemaSource =
	| { readonly kind: "eager"; readonly schema: Type }
	| { readonly kind: "deferred"; readonly resolve: () => Type };

export interface IConfigFile<T> {
	readonly id: string;
	readonly schema: Type;
	path?(): string;
	load(): T | null;
	invalidate?(): void;
}

export class ConfigError extends Error {
	readonly #message: string;
	constructor(
		public readonly id: string,
		public readonly schemaErrors: ConfigSchemaError[] | null | undefined,
		public readonly other?: { err: unknown; stage: string },
	) {
		let messages: string[] | undefined;
		let cause: Error | undefined;
		let klass: string;

		if (schemaErrors) {
			klass = "Schema";
			messages = schemaErrors.map(e => `${e.instancePath || "root"}: ${e.message}`);
		} else if (other) {
			klass = other.stage;
			if (other.err instanceof Error) {
				messages = [other.err.message];
				cause = other.err;
			} else {
				messages = [String(other.err)];
			}
		} else {
			klass = "Unknown";
		}

		const title = `Failed to load config file ${id}, ${klass} error:`;
		let message: string;
		switch (messages?.length ?? 0) {
			case 0:
				message = title.slice(0, -1);
				break;
			case 1:
				message = `${title} ${messages![0]}`;
				break;
			default:
				message = `${title}\n${messages!.map(m => `  - ${m}`).join("\n")}`;
		}

		super(message, { cause });
		this.name = "LoadError";
		this.#message = message;
	}

	override get message(): string {
		return this.#message;
	}

	override toString(): string {
		return this.message;
	}
}

export type LoadStatus = "ok" | "error" | "not-found";

export type LoadResult<T> =
	| { value?: null; error: ConfigError; status: "error" }
	| { value: T; error?: undefined; status: "ok" }
	| { value?: null; error?: unknown; status: "not-found" };

/** Three-way merge: preserve disjoint disk edits, reject conflicting replacements. */
function mergeConfigEdit(current: unknown, expected: unknown, next: unknown, keyPath = "root"): unknown {
	if (Bun.deepEquals(expected, next)) return current;
	if (Bun.deepEquals(current, expected) || Bun.deepEquals(current, next)) return next;
	if (isRecord(current) && isRecord(next) && (expected === undefined || isRecord(expected))) {
		const merged = { ...current };
		for (const key of new Set([...Object.keys(expected ?? {}), ...Object.keys(next)])) {
			const value = mergeConfigEdit(current[key], expected?.[key], next[key], `${keyPath}.${key}`);
			if (value === undefined) delete merged[key];
			else Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
		}
		return merged;
	}
	throw new Error(`Configuration changed on disk at ${keyPath}. Reopen the entry before saving.`);
}

export class ConfigFile<T> implements IConfigFile<T> {
	readonly #basePath: string;
	readonly #legacyPaths: readonly string[];
	readonly #schemaSource: ConfigSchemaSource;
	#resolvedSchema?: Type;
	#cache?: LoadResult<T>;
	#auxValidate?: (value: T) => void;

	constructor(
		readonly id: string,
		schema: Type | ConfigSchemaSource,
		configPath: string = path.join(getAgentDir(), `${id}.toml`),
	) {
		this.#schemaSource = typeof schema === "function" ? { kind: "eager", schema } : schema;
		if (!/\.(?:toml|yml|yaml|json|jsonc)$/.test(configPath)) {
			throw new Error(`Invalid config file path: ${configPath}`);
		}
		const stem = configPath.replace(/\.(?:toml|yml|yaml|json|jsonc)$/, "");
		this.#basePath = `${stem}.toml`;
		this.#legacyPaths = [".yml", ".yaml", ".json", ".jsonc"].map(extension => `${stem}${extension}`);
	}

	get schema(): Type {
		if (this.#schemaSource.kind === "eager") return this.#schemaSource.schema;
		if (!this.#resolvedSchema) this.#resolvedSchema = this.#schemaSource.resolve();
		return this.#resolvedSchema;
	}

	/** Legacy formats are read only by the one-time, non-destructive import. */
	#readConfig(): TomlConfigSource | undefined {
		return readTomlConfigSync(this.#basePath, {
			legacyPaths: this.#legacyPaths,
			parseLegacy: (content, filePath) => {
				if (filePath.endsWith(".yml") || filePath.endsWith(".yaml")) return importLegacyYaml(content, filePath);
				const value: unknown = JSONC.parse(content);
				if (!isRecord(value)) throw new Error(`Configuration must contain a mapping: ${filePath}`);
				return value;
			},
		});
	}

	relocate(configPath?: string): ConfigFile<T> {
		if (!configPath || configPath === this.#basePath) return this;
		const result = new ConfigFile<T>(this.id, this.#schemaSource, configPath);
		result.#auxValidate = this.#auxValidate;
		result.#resolvedSchema = this.#resolvedSchema;
		return result;
	}

	getMtimeMs(): number | null {
		for (const filePath of [this.#basePath, ...this.#legacyPaths]) {
			try {
				return fs.statSync(filePath).mtimeMs;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		return null;
	}

	withValidation(name: string, validate: (value: T) => void): this {
		const prev = this.#auxValidate;
		this.#auxValidate = (value: T) => {
			prev?.(value);
			try {
				validate(value);
			} catch (error) {
				throw new ConfigError(this.id, undefined, { err: error, stage: `Validate(${name})` });
			}
		};
		return this;
	}

	createDefault(): T {
		const parsed = this.schema({});
		if (!(parsed instanceof Error)) return parsed as T;
		const fallback = this.schema(undefined);
		if (!(fallback instanceof Error)) return fallback as T;
		throw new ConfigError(this.id, undefined, {
			err: new Error("Schema produced no default value"),
			stage: "createDefault",
		});
	}

	#storeCache(result: LoadResult<T>): LoadResult<T> {
		this.#cache = result;
		return result;
	}

	#validateContent(parsed: unknown, preserveInput = false): LoadResult<T> {
		try {
			const checked = this.schema(parsed);
			if (checked instanceof OmpErrors) {
				const schemaErrors: ConfigSchemaError[] = checked.map(error => ({
					instancePath: error.path.length === 0 ? "root" : error.path.join("."),
					message: error.problem,
				}));
				const error = new ConfigError(this.id, schemaErrors);
				logger.warn("Failed to parse config file", { path: this.#basePath, error });
				return { error, status: "error" };
			}
			const value = checked as T;
			try {
				this.#auxValidate?.(value);
			} catch (error) {
				const wrapped =
					error instanceof ConfigError
						? error
						: new ConfigError(this.id, undefined, { err: error, stage: "AuxValidate" });
				return { error: wrapped, status: "error" };
			}
			return { value: preserveInput ? (parsed as T) : value, status: "ok" };
		} catch (error) {
			logger.warn("Failed to parse config file", { path: this.#basePath, error });
			return {
				error: new ConfigError(this.id, undefined, { err: error, stage: "Unexpected" }),
				status: "error",
			};
		}
	}

	/** Editors request validated input, before schema morphs normalize or remove fields. */
	tryLoad(preserveInput = false): LoadResult<T> {
		if (!preserveInput && this.#cache) return this.#cache;

		let source: TomlConfigSource | undefined;
		try {
			source = this.#readConfig();
			if (!source) return this.#storeCache({ status: "not-found" });
		} catch (error) {
			logger.warn("Failed to read config file", { path: this.#basePath });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Read" }),
				status: "error",
			});
		}
		const result = this.#validateContent(source.data, preserveInput);
		return preserveInput ? result : this.#storeCache(result);
	}

	load(): T | null {
		return this.tryLoad().value ?? null;
	}

	loadOrDefault(): T {
		return this.tryLoad().value ?? this.createDefault();
	}

	path(): string {
		if (!fs.existsSync(this.#basePath)) this.#readConfig();
		return this.#basePath;
	}

	/** Validate and save under the same lock as Settings, preserving disjoint external edits. */
	async save(value: T, expected: T | null): Promise<void> {
		await withFileLock(this.path(), async () => {
			this.invalidate();
			const result = this.tryLoad(true);
			if (result.status === "error") throw result.error;
			const merged = mergeConfigEdit(result.value ?? null, expected, value) as T;
			const checked = this.schema(merged);
			if (checked instanceof OmpErrors)
				throw new ConfigError(
					this.id,
					checked.map(error => ({
						instancePath: error.path.join("."),
						message: error.problem,
					})),
				);
			this.#auxValidate?.(checked as T);
			const filePath = this.path();
			let source = "";
			try {
				source = await Bun.file(filePath).text();
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			const content = patchSettingsToml(source, merged as Record<string, unknown>);
			await writeFileAtomically(filePath, content);
			this.invalidate();
		});
	}

	invalidate() {
		this.#cache = undefined;
	}
}

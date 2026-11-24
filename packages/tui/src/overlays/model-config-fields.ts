import { t } from "@oh-my-pi/pi-utils/i18n";
import { Input } from "../components/input";
import type { SelectItem } from "../components/select-list";
import { sanitizeDisplayWarning } from "../render/render-utils";

/** JSON Schema's structural subset emitted by the native models-config schema. */
export interface ModelConfigFieldSchema {
	type?: string;
	properties?: Record<string, ModelConfigFieldSchema>;
	additionalProperties?: ModelConfigFieldSchema | boolean;
	items?: ModelConfigFieldSchema;
	anyOf?: ModelConfigFieldSchema[];
	allOf?: ModelConfigFieldSchema[];
	oneOf?: ModelConfigFieldSchema[];
	enum?: unknown[];
	const?: unknown;
	$ref?: string;
	$defs?: Record<string, ModelConfigFieldSchema>;
}

type Path = (string | number)[];
interface Level {
	path: Path;
	schema: ModelConfigFieldSchema;
}
const FREE_TYPES: ModelConfigFieldSchema[] = [
	{ type: "string" },
	{ type: "number" },
	{ type: "boolean" },
	{ type: "object", additionalProperties: {} },
	{ type: "array", items: {} },
	{ type: "null" },
];

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function typeOf(value: unknown): string {
	return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}
function defaultValue(schema: ModelConfigFieldSchema): unknown {
	if ("const" in schema) return schema.const;
	if (schema.enum) return schema.enum[0];
	switch (schema.type) {
		case "object":
			return {};
		case "array":
			return [];
		case "boolean":
			return false;
		case "number":
		case "integer":
			return 0;
		case "null":
			return null;
		default:
			return "";
	}
}
function label(schema: ModelConfigFieldSchema): string {
	return schema.enum
		? schema.enum.map(String).join(" / ")
		: "const" in schema
			? String(schema.const)
			: displayType(schema.type);
}

function displayType(type: string | undefined): string {
	switch (type) {
		case "string":
			return t("overlaysModel.modelConfigFields.type.string");
		case "number":
			return t("overlaysModel.modelConfigFields.type.number");
		case "integer":
			return t("overlaysModel.modelConfigFields.type.integer");
		case "boolean":
			return t("overlaysModel.modelConfigFields.type.boolean");
		case "object":
			return t("overlaysModel.modelConfigFields.type.object");
		case "array":
			return t("overlaysModel.modelConfigFields.type.array");
		case "null":
			return t("overlaysModel.modelConfigFields.type.null");
		default:
			return type ?? t("overlaysModel.modelConfigFields.value");
	}
}

/** Navigates known objects, records, arrays and union branches without editing YAML/JSON text. */
export class ModelConfigFields {
	readonly #levels: Level[];
	#choices?: { path: Path; schemas: ModelConfigFieldSchema[] };
	input?: { label: string; input: Input; accept(value: string): void };

	constructor(
		readonly fields: Record<string, unknown>,
		readonly schema: ModelConfigFieldSchema,
	) {
		this.#levels = [{ path: [], schema }];
	}

	get heading(): string {
		return this.#levels.at(-1)?.path.join(".") || t("overlaysModel.modelConfigFields.heading");
	}
	get atRoot(): boolean {
		return this.#levels.length === 1 && !this.#choices;
	}
	back(): boolean {
		if (this.input) {
			this.input = undefined;
			return true;
		}
		if (this.#choices) {
			this.#choices = undefined;
			return true;
		}
		if (this.#levels.length > 1) {
			this.#levels.pop();
			return true;
		}
		return false;
	}

	#resolve(schema: ModelConfigFieldSchema): ModelConfigFieldSchema {
		if (schema.$ref) return this.#resolve(this.schema.$defs?.[schema.$ref.slice("#/$defs/".length)] ?? {});
		if (!schema.allOf) return schema;
		const branches = schema.allOf.map(branch => this.#resolve(branch));
		return {
			...schema,
			allOf: undefined,
			type: branches.find(branch => branch.type)?.type,
			properties: Object.assign({}, ...branches.map(branch => branch.properties ?? {})),
			additionalProperties: branches.find(branch => branch.additionalProperties !== undefined)?.additionalProperties,
		};
	}
	#value(path: Path): unknown {
		let value: unknown = this.fields;
		for (const key of path)
			value = Array.isArray(value) ? value[Number(key)] : object(value) ? value[String(key)] : undefined;
		return value;
	}
	#set(path: Path, value: unknown): void {
		const parent = this.#value(path.slice(0, -1));
		const key = path.at(-1)!;
		if (Array.isArray(parent)) parent[Number(key)] = value;
		else if (object(parent))
			Object.defineProperty(parent, String(key), { value, enumerable: true, writable: true, configurable: true });
	}
	#child(key: string): { path: Path; schema?: ModelConfigFieldSchema } {
		const level = this.#levels.at(-1)!;
		const schema = this.#resolve(level.schema);
		return {
			path: [...level.path, schema.type === "array" ? Number(key) : key],
			schema:
				schema.type === "array"
					? schema.items
					: ((Object.hasOwn(schema.properties ?? {}, key) ? schema.properties?.[key] : undefined) ??
						(object(schema.additionalProperties) ? schema.additionalProperties : undefined)),
		};
	}

	items(): SelectItem[] {
		if (this.#choices)
			return this.#choices.schemas.map((schema, index) => ({ value: `choice:${index}`, label: label(schema) }));
		const level = this.#levels.at(-1)!;
		const schema = this.#resolve(level.schema);
		const value = this.#value(level.path);
		const keys =
			schema.type === "array" && Array.isArray(value)
				? value.map((_, index) => String(index))
				: [...new Set([...Object.keys(schema.properties ?? {}), ...Object.keys(object(value) ? value : {})])];
		const items = keys.map(key => {
			const child = this.#child(key);
			const entry = this.#value(child.path);
			return {
				value: `field:${key}`,
				label: key,
				description: sanitizeDisplayWarning(
					`${entry === undefined ? t("overlaysModel.modelConfigFields.unset") : JSON.stringify(entry)}${child.schema ? "" : t("overlaysModel.modelConfigFields.readOnlySuffix")}`,
				),
			};
		});
		if (schema.type === "array")
			items.push({ value: "append", label: t("overlaysModel.modelConfigFields.addItem"), description: "" });
		else if (object(schema.additionalProperties))
			items.push({ value: "append", label: t("overlaysModel.modelConfigFields.addKey"), description: "" });
		if (level.path.length)
			items.push({ value: "back", label: t("overlaysModel.modelConfigFields.back"), description: "" });
		return items;
	}

	activate(value: string): void {
		if (value === "back") {
			this.back();
			return;
		}
		if (this.#choices) {
			const choice = this.#choices.schemas[Number(value.slice(7))];
			if (!choice) return;
			const path = this.#choices.path;
			this.#choices = undefined;
			if ("const" in choice) {
				this.#set(path, choice.const);
				return;
			}
			if (typeOf(this.#value(path)) !== choice.type) this.#set(path, defaultValue(choice));
			this.#open(path, choice);
			return;
		}
		if (value === "append") {
			const level = this.#levels.at(-1)!;
			const schema = this.#resolve(level.schema);
			const current = this.#value(level.path);
			if (schema.type === "array" && Array.isArray(current)) {
				const path = [...level.path, current.length];
				current.push(undefined);
				this.#open(path, schema.items ?? {});
			} else
				this.#textInput(t("overlaysModel.modelConfigFields.newKey"), "", name => {
					if (!name) throw new Error(t("overlaysModel.modelConfigFields.requiredKey"));
					if (object(current) && Object.hasOwn(current, name))
						throw new Error(t("overlaysModel.modelConfigFields.duplicateKey"));
					const path = [...level.path, name];
					this.input = undefined;
					this.#open(path, object(schema.additionalProperties) ? schema.additionalProperties : {});
				});
			return;
		}
		if (!value.startsWith("field:")) return;
		const child = this.#child(value.slice(6));
		if (child.schema) this.#open(child.path, child.schema);
	}

	#open(path: Path, raw: ModelConfigFieldSchema): void {
		const schema = this.#resolve(raw);
		const value = this.#value(path);
		const branches = schema.anyOf ?? schema.oneOf;
		if (branches) {
			// Existing structured values open directly. "Change type" remains available below.
			const matching = branches.map(branch => this.#resolve(branch)).find(branch => branch.type === typeOf(value));
			if (matching && (matching.type === "object" || matching.type === "array")) {
				this.#open(path, matching);
				return;
			}
			this.#choices = { path, schemas: branches.map(branch => this.#resolve(branch)) };
			return;
		}
		if (schema.enum || "const" in schema || schema.type === "boolean") {
			const values = schema.enum ?? ("const" in schema ? [schema.const] : [true, false]);
			this.#choices = { path, schemas: values.map(value => ({ const: value, type: typeOf(value) })) };
			return;
		}
		if (!schema.type) {
			const current = FREE_TYPES.find(branch => branch.type === typeOf(value));
			if (current) {
				this.#open(path, current);
				return;
			}
			this.#choices = { path, schemas: FREE_TYPES };
			return;
		}
		if (schema.type === "object" || schema.type === "array") {
			if (value === undefined) this.#set(path, defaultValue(schema));
			this.#levels.push({ path, schema });
			return;
		}
		if (schema.type === "null") {
			this.#set(path, null);
			return;
		}
		this.#textInput(path.join("."), value === undefined ? "" : String(value), text => {
			let next: unknown = text;
			if (schema.type === "number" || schema.type === "integer") {
				if (
					!text.trim() ||
					!Number.isFinite(Number(text)) ||
					(schema.type === "integer" && !Number.isInteger(Number(text)))
				)
					throw new Error(t("overlaysModel.modelConfigFields.finiteNumber"));
				next = Number(text);
			}
			this.#set(path, next);
		});
	}

	#textInput(label: string, value: string, accept: (value: string) => void): void {
		const input = new Input();
		input.setValue(value);
		input.focused = true;
		this.input = { label, input, accept };
	}

	acceptInput(): void {
		const pending = this.input;
		if (!pending) return;
		this.input = undefined;
		try {
			pending.accept(pending.input.getValue());
		} catch (error) {
			this.input = pending;
			throw error;
		}
	}

	remove(value: string): void {
		if (!value.startsWith("field:")) return;
		const { path, schema } = this.#child(value.slice(6));
		if (!schema) return;
		const parent = this.#value(path.slice(0, -1));
		if (Array.isArray(parent)) parent.splice(Number(path.at(-1)), 1);
		else if (object(parent)) delete parent[String(path.at(-1))];
	}

	changeType(value: string): void {
		if (!value.startsWith("field:")) return;
		const child = this.#child(value.slice(6));
		if (!child.schema) return;
		const schema = this.#resolve(child.schema);
		const branches = schema.anyOf ?? schema.oneOf ?? (!schema.type ? FREE_TYPES : undefined);
		if (branches) this.#choices = { path: child.path, schemas: branches.map(branch => this.#resolve(branch)) };
	}
}

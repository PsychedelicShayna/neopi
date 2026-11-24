import { areJsonValuesEqual, dereferenceJsonSchema, isJsonObject as isObject } from "@oh-my-pi/pi-ai";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { parseCommandArgs } from "../utils/command-args";

type ObjectValue = Record<string, unknown>;

/** JSON.parse validates syntax; this token walk also rejects ambiguous duplicate object keys. */
function parseJson(text: string): unknown {
	const value: unknown = JSON.parse(text);
	const stack: Array<{ keys: Set<string> | null; keyExpected: boolean }> = [];
	for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)) {
		const token = match[0];
		const frame = stack.at(-1);
		if (token === "{" || token === "[") {
			stack.push({ keys: token === "{" ? new Set() : null, keyExpected: token === "{" });
		} else if (token === "}" || token === "]") {
			stack.pop();
		} else if (token === "," && frame?.keys) {
			frame.keyExpected = true;
		} else if (token === ":" && frame) {
			frame.keyExpected = false;
		} else if (token.startsWith('"') && frame?.keys && frame.keyExpected) {
			const key: string = JSON.parse(token);
			if (frame.keys.has(key)) throw new Error(t("commands.toolArguments.duplicateKey", { key }));
			frame.keys.add(key);
		}
	}
	return value;
}

interface Segment {
	text: string;
	start: number;
}

/** Keep quoted and structured values intact, including incomplete values during typing. */
function splitArguments(text: string, json: boolean): Segment[] {
	const segments: Segment[] = [];
	let start = 0;
	let quote = "";
	let escaped = false;
	const brackets: string[] = [];
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\" && quote === '"') escaped = true;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "{" || char === "[") brackets.push(char);
		else if (char === "}" || char === "]") brackets.pop();
		else if (brackets.length === 0 && (json ? char === "," : /\s/.test(char))) {
			if (json || index > start) segments.push({ text: text.slice(start, index), start });
			start = index + 1;
		}
	}
	segments.push({ text: text.slice(start), start });
	return segments;
}

function parseValue(text: string): unknown {
	if (!text) throw new Error(t("commands.toolArguments.missingValue"));
	if (text.startsWith("'")) {
		if (!text.endsWith("'") || text.length < 2 || text.slice(1, -1).includes("'")) {
			throw new Error(t("commands.toolArguments.invalidQuote"));
		}
		return parseCommandArgs(text, { strict: true })[0]!;
	}
	if (/^[\[{\"]/.test(text)) return parseJson(text);
	if (/\s/.test(text)) throw new Error(t("commands.toolArguments.quoteSpaces"));
	try {
		return parseJson(text);
	} catch {
		return text;
	}
}

/** Parse an object or key=value arguments. Quoted scalars stay strings; bare paths stay intact. */
export function parseHumanToolArguments(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error(t("commands.toolArguments.expectedArguments"));
	if (trimmed.startsWith("{")) {
		const value = parseJson(trimmed);
		if (!isObject(value)) throw new Error(t("commands.toolArguments.expectedObject"));
		return value;
	}
	const args: ObjectValue = {};
	for (const segment of splitArguments(trimmed, false)) {
		if (!segment.text) continue;
		const separator = segment.text.indexOf("=");
		if (separator <= 0) throw new Error(t("commands.toolArguments.expectedPairs"));
		const key = segment.text.slice(0, separator);
		if (/\s|[\[\]{}'\"]/.test(key)) throw new Error(t("commands.toolArguments.invalidKey", { key }));
		if (Object.hasOwn(args, key)) throw new Error(t("commands.toolArguments.duplicateKey", { key }));
		Object.defineProperty(args, key, {
			value: parseValue(segment.text.slice(separator + 1)),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return args;
}

/** Keep case-sensitive names and internal colons intact. */
export function parseHumanToolCommand(args: string): { name: string; argumentsText: string } {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
	return { name: match?.[1] ?? "", argumentsText: match?.[2] ?? "" };
}

interface Shape {
	properties: Map<string, unknown[]>;
	required: Set<string>;
}

function mergeShapes(left: Shape, right: Shape): Shape {
	const properties = new Map(left.properties);
	for (const [name, constraints] of right.properties) {
		properties.set(name, [...(properties.get(name) ?? []), ...constraints]);
	}
	return { properties, required: new Set([...left.required, ...right.required]) };
}

/** Unknown references and non-object branches do not provide trustworthy field suggestions. */
function objectShapes(schema: unknown, depth = 0): Shape[] {
	if (depth > 24 || !isObject(schema) || schema.$ref !== undefined) return [];
	if (schema.type !== undefined && schema.type !== "object") return [];
	let shapes: Shape[] = [{ properties: new Map(), required: new Set() }];
	const own = shapes[0]!;
	if (isObject(schema.properties)) {
		for (const [name, value] of Object.entries(schema.properties)) {
			own.properties.set(name, [value]);
		}
	}
	if (Array.isArray(schema.required)) {
		for (const name of schema.required) if (typeof name === "string") own.required.add(name);
	}
	for (const keyword of ["allOf", "oneOf", "anyOf"]) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		if (keyword === "allOf") {
			for (const branch of branches) {
				const options = objectShapes(branch, depth + 1);
				if (shapes.length * options.length > 128) return [];
				shapes = shapes.flatMap(shape => options.map(option => mergeShapes(shape, option)));
			}
		} else {
			const options = branches.flatMap(branch => objectShapes(branch, depth + 1));
			if (shapes.length * options.length > 128) return [];
			shapes = shapes.flatMap(shape => options.map(option => mergeShapes(shape, option)));
		}
	}
	return shapes;
}

function acceptsValue(schema: unknown, value: unknown, depth = 0): boolean {
	if (schema === false) return false;
	if (depth > 24 || !isObject(schema)) return true;
	if (Object.hasOwn(schema, "const") && !areJsonValuesEqual(schema.const, value)) return false;
	if (Array.isArray(schema.enum) && !schema.enum.some(item => areJsonValuesEqual(item, value))) return false;
	if (Array.isArray(schema.allOf) && !schema.allOf.every(item => acceptsValue(item, value, depth + 1))) return false;
	for (const keyword of ["oneOf", "anyOf"]) {
		if (Array.isArray(schema[keyword]) && !schema[keyword].some(item => acceptsValue(item, value, depth + 1)))
			return false;
	}
	return true;
}

function finiteValues(schema: unknown, depth = 0): unknown[] {
	if (depth > 24 || !isObject(schema) || schema.$ref !== undefined) return [];
	if (Object.hasOwn(schema, "const")) return [schema.const];
	if (Array.isArray(schema.enum)) return schema.enum;
	for (const keyword of ["oneOf", "anyOf", "allOf"]) {
		if (Array.isArray(schema[keyword])) {
			return schema[keyword]
				.flatMap(item => finiteValues(item, depth + 1))
				.filter(value => acceptsValue(schema, value));
		}
	}
	return schema.type === "boolean" ? [true, false] : schema.type === "null" ? [null] : [];
}

interface CompletionState {
	args: ObjectValue;
	json: boolean;
	before: string;
	key: string;
	valuePrefix: string | null;
}

function completionState(text: string): CompletionState | null {
	const json = text.trimStart().startsWith("{");
	if (json && text.trimEnd().endsWith("}")) {
		try {
			return { args: parseHumanToolArguments(text), json, before: text, key: "", valuePrefix: null };
		} catch {
			/* A nested object may have closed while the outer object is still being typed. */
		}
	}
	const offset = json ? text.indexOf("{") + 1 : 0;
	const segments = splitArguments(text.slice(offset), json);
	const current = segments.at(-1)!;
	const previous = text.slice(offset, offset + current.start).replace(/,\s*$/, "");
	let args: ObjectValue;
	try {
		args = previous.trim() ? parseHumanToolArguments(json ? `{${previous}}` : previous) : {};
	} catch {
		return null;
	}
	const whitespace = current.text.match(/^\s*/)?.[0] ?? "";
	const token = current.text.slice(whitespace.length);
	const before = text.slice(0, offset + current.start) + whitespace;
	if (json) {
		const pair = /^"((?:\\.|[^"\\])*)"\s*:\s*([\s\S]*)$/.exec(token);
		if (pair) {
			try {
				return { args, json, before, key: JSON.parse(`"${pair[1]}"`), valuePrefix: pair[2]! };
			} catch {
				return null;
			}
		}
		if (!/^"?[^"\\:]*$/.test(token)) return null;
		return { args, json, before, key: token.replace(/^"/, ""), valuePrefix: null };
	}
	const separator = token.indexOf("=");
	return {
		args,
		json,
		before,
		key: separator < 0 ? token : token.slice(0, separator),
		valuePrefix: separator < 0 ? null : token.slice(separator + 1),
	};
}

function matchingShapes(schema: unknown, args: ObjectValue): Shape[] {
	return objectShapes(dereferenceJsonSchema(schema)).filter(shape =>
		Object.entries(args).every(([key, value]) =>
			(shape.properties.get(key) ?? []).every(item => acceptsValue(item, value)),
		),
	);
}

function displayType(constraints: unknown[]): string {
	const values = constraints
		.flatMap(schema => finiteValues(schema))
		.filter(value => constraints.every(schema => acceptsValue(schema, value)));
	if (values.length) return [...new Set(values.map(value => JSON.stringify(value)))].join("|");
	for (const schema of constraints) if (isObject(schema) && typeof schema.type === "string") return schema.type;
	return "value";
}

function fieldTypeHint(shapes: Shape[], key: string): string {
	const alternatives = shapes.flatMap(shape => {
		const constraints = shape.properties.get(key);
		return constraints ? [displayType(constraints)] : [];
	});
	return [...new Set(alternatives)].join("|") || "value";
}

/** Completion values replace the entire slash-command argument prefix, as required by SlashCommand. */
export function getToolArgumentCompletions(schema: unknown, text: string): AutocompleteItem[] | null {
	const state = completionState(text);
	if (!state || (state.json && state.before === text && text.trimEnd().endsWith("}"))) return null;
	const shapes = matchingShapes(schema, state.args);
	const items = new Map<string, AutocompleteItem>();
	for (const shape of shapes) {
		if (state.valuePrefix !== null) {
			const constraints = shape.properties.get(state.key);
			if (!constraints) continue;
			for (const value of constraints.flatMap(item => finiteValues(item))) {
				if (!constraints.every(item => acceptsValue(item, value))) continue;
				const encoded = JSON.stringify(value);
				if (encoded === undefined) continue;
				const prefix = state.valuePrefix;
				const bare =
					!state.json && typeof value === "string" && /^[^\s"'{}\[\]]+$/.test(value) && parseValue(value) === value
						? value
						: encoded;
				const singleQuoted =
					!state.json && typeof value === "string" && !value.includes("'") ? `'${value}'` : encoded;
				const replacement = bare.startsWith(prefix)
					? bare
					: encoded.startsWith(prefix)
						? encoded
						: singleQuoted.startsWith(prefix)
							? singleQuoted
							: null;
				if (replacement === null) continue;
				const full = `${state.before}${state.json ? `${JSON.stringify(state.key)}: ` : `${state.key}=`}${replacement}`;
				items.set(full, {
					value: full,
					label: encoded,
					hint: full.startsWith(text) ? full.slice(text.length) || undefined : undefined,
				});
			}
		} else {
			for (const [key, constraints] of shape.properties) {
				if (Object.hasOwn(state.args, key) || !key.startsWith(state.key)) continue;
				const value = `${state.before}${state.json ? `${JSON.stringify(key)}: ` : `${key}=`}`;
				const description = constraints.find(item => isObject(item) && typeof item.description === "string");
				items.set(value, {
					value,
					label: state.json ? JSON.stringify(key) : `${key}=`,
					description: isObject(description) ? String(description.description) : undefined,
					hint: `${value.startsWith(text) ? value.slice(text.length) : ""}<${fieldTypeHint(shapes, key)}>`,
				});
			}
		}
	}
	return items.size ? [...items.values()] : null;
}

/** Missing required fields stay visible even when the dropdown is closed. */
export function getToolArgumentInlineHint(schema: unknown, text: string): string | null {
	const state = completionState(text);
	if (!state) return null;
	let args = state.args;
	if (state.valuePrefix !== null) {
		const completionHint = getToolArgumentCompletions(schema, text)?.[0]?.hint;
		try {
			args = { ...args, [state.key]: parseValue(state.valuePrefix) };
		} catch {
			if (completionHint) return completionHint;
			const shapes = matchingShapes(schema, args);
			return state.valuePrefix === "" && shapes.some(shape => shape.properties.has(state.key))
				? `<${fieldTypeHint(shapes, state.key)}>`
				: null;
		}
		if (completionHint && !matchingShapes(schema, args).length) return completionHint;
	} else if (state.key) {
		return getToolArgumentCompletions(schema, text)?.[0]?.hint ?? null;
	}
	const shapes = matchingShapes(schema, args);
	if (!shapes.length) return null;
	// Only promise fields required by every remaining branch until a discriminator selects one.
	const required = [...shapes[0]!.required].filter(
		key => shapes.every(shape => shape.required.has(key)) && !Object.hasOwn(args, key),
	);
	const hints = required.flatMap(key => {
		return shapes.some(shape => shape.properties.has(key))
			? [`${state.json ? `${JSON.stringify(key)}: ` : `${key}=`}<${fieldTypeHint(shapes, key)}>`]
			: [];
	});
	if (!hints.length || (state.json && text.trimEnd().endsWith("}"))) return null;
	return `${text && !/\s$/.test(text) && !text.endsWith("{") ? (state.json ? ", " : " ") : ""}${hints.join(state.json ? ", " : " ")}`;
}

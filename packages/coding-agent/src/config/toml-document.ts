import { isDeepStrictEqual } from "node:util";
import { parseSettingsToml, plainSettingsTomlTable as plainTable } from "@oh-my-pi/pi-utils/settings-toml";
function pointerSegment(key: string): string {
	return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

function tomlString(value: string, multiline = true): string {
	// Bun currently swaps the \t and \f escapes. A literal tab is valid TOML
	// and avoids changing user text. It also retains a leading multiline LF
	// instead of trimming it, so never emit the optional opening newline.
	const quote = (text: string) =>
		`"${text
			.split("\t")
			.map(part => JSON.stringify(part).slice(1, -1))
			.join("\t")}"`;
	if (multiline && value.includes("\n") && !value.startsWith("\n")) {
		return `"""${value
			.split("\n")
			.map(line => quote(line).slice(1, -1))
			.join("\n")}"""`;
	}
	return quote(value);
}

export function tomlValue(value: unknown, multiline = false): string {
	if (typeof value === "string") return tomlString(value, multiline);
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "nan";
		if (value === Infinity) return "inf";
		if (value === -Infinity) return "-inf";
		if (Object.is(value, -0)) return "-0.0";
		return String(value);
	}
	if (Array.isArray(value)) return `[${value.map(entry => tomlValue(entry)).join(", ")}]`;
	if (plainTable(value)) {
		return `{ ${Object.entries(value)
			.map(([key, entry]) => `${tomlString(key, false)} = ${tomlValue(entry)}`)
			.join(", ")} }`;
	}
	throw new Error("Cannot represent value in TOML");
}

/** Encode the complete user mapping, including unknown keys and explicit nulls. */
export function stringifySettingsToml(settings: Record<string, unknown>): string {
	if (!plainTable(settings)) throw new Error("Settings must contain a mapping at the document root");
	if (Object.hasOwn(settings, "__npi"))
		throw new Error("/__npi: reserved TOML metadata key conflicts with user configuration");
	const nullPaths: string[] = [];
	const ancestors = new Set<object>();
	function encode(value: unknown, pointer: string): unknown {
		if (value === null) {
			nullPaths.push(pointer);
			return "";
		}
		if (typeof value === "string") {
			if (/[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(value)) {
				throw new Error(
					`${pointer}: string contains control characters or unpaired surrogates the TOML reader cannot recover`,
				);
			}
			return value;
		}
		if (typeof value === "boolean") return value;
		if (typeof value === "number") {
			if (Number.isInteger(value) && !Number.isSafeInteger(value))
				throw new Error(`${pointer}: integer is outside the exact reader range`);
			return value;
		}
		if (!Array.isArray(value) && !plainTable(value)) {
			throw new Error(`${pointer || "/"}: unsupported ${value instanceof Date ? "date/time" : typeof value} value`);
		}
		if (ancestors.has(value)) throw new Error(`${pointer}: cyclic YAML aliases cannot be represented`);
		ancestors.add(value);
		try {
			if (Array.isArray(value)) return value.map((entry, index) => encode(entry, `${pointer}/${index}`));
			return Object.fromEntries(
				Object.entries(value).flatMap(([key, entry]) => {
					encode(key, `${pointer}/${pointerSegment(key)}`);
					const encoded = encode(entry, `${pointer}/${pointerSegment(key)}`);
					return entry === null ? [] : [[key, encoded]];
				}),
			);
		} finally {
			ancestors.delete(value);
		}
	}
	const encoded = encode(settings, "") as Record<string, unknown>;
	if (nullPaths.length) encoded.__npi = { version: 1, null_paths: nullPaths };
	const lines: string[] = [];
	function table(value: Record<string, unknown>, keys: string[], header?: string): void {
		if (header) {
			if (lines.length) lines.push("");
			lines.push(header);
		}
		const entries = Object.entries(value);
		const isTableArray = (entry: unknown): entry is Record<string, unknown>[] =>
			Array.isArray(entry) && entry.length > 0 && entry.every(plainTable);
		for (const [key, entry] of entries) {
			if (!plainTable(entry) && !isTableArray(entry))
				lines.push(`${tomlString(key, false)} = ${tomlValue(entry, true)}`);
		}
		for (const [key, entry] of entries) {
			const child = [...keys, key];
			const name = child.map(segment => tomlString(segment, false)).join(".");
			if (plainTable(entry)) table(entry, child, `[${name}]`);
			else if (isTableArray(entry)) for (const item of entry) table(item, child, `[[${name}]]`);
		}
	}
	table(encoded, []);
	const content = `${lines.join("\n")}\n`;
	if (!isDeepStrictEqual(parseSettingsToml(content), settings)) {
		throw new Error("TOML reader cannot recover the complete configuration exactly; no file was written");
	}
	return content;
}

/**
 * Replace changed top-level keys only. Untouched statements keep their original
 * bytes; edited tables become inline tables and lose their internal formatting.
 */
export function patchSettingsToml(source: string, settings: Record<string, unknown>): string {
	const previous = parseSettingsToml(source);
	const changed = new Set(
		[...new Set([...Object.keys(previous), ...Object.keys(settings)])].filter(
			key => !isDeepStrictEqual(previous[key], settings[key]),
		),
	);
	if (changed.size === 0) return source;
	// Reuse the encoder, including its explicit-clear metadata and fidelity check.
	const encoded = Bun.TOML.parse(stringifySettingsToml(settings));
	changed.add("__npi");
	const replacement = Object.entries(encoded)
		.filter(([key]) => changed.has(key))
		.map(([key, value]) => `${tomlString(key, false)} = ${tomlValue(value)}\n`)
		.join("");
	let retained = "";
	let tableKey: string | undefined;
	for (const statement of tomlStatements(source)) {
		const trimmed = statement.trimStart();
		if (!trimmed || trimmed.startsWith("#")) {
			retained += statement;
			continue;
		}
		let key = tableKey;
		if (trimmed.startsWith("[")) {
			key = Object.keys(Bun.TOML.parse(statement))[0];
			tableKey = key;
		} else if (key === undefined) {
			key = Object.keys(Bun.TOML.parse(statement))[0];
		}
		if (key === undefined || !changed.has(key)) retained += statement;
	}
	const content = replacement + retained;
	if (!isDeepStrictEqual(parseSettingsToml(content), settings)) {
		throw new Error("TOML edit cannot preserve the complete configuration; no file was written");
	}
	return content;
}

/** Statement boundaries outside strings, comments, arrays and inline tables. */
function* tomlStatements(source: string): Generator<string> {
	let start = 0;
	let quote = "";
	let triple = false;
	let comment = false;
	let depth = 0;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (comment) {
			if (char !== "\n") continue;
			comment = false;
		} else if (quote) {
			if (quote === '"' && char === "\\") {
				i++;
				continue;
			}
			if (char === quote) {
				if (!triple) quote = "";
				else if (source.slice(i, i + 3) === quote.repeat(3)) {
					// Four/five closing quotes include one/two literal quotes.
					while (source[i + 3] === quote) i++;
					i += 2;
					quote = "";
				}
			}
			continue;
		} else if (char === '"' || char === "'") {
			quote = char;
			triple = source.slice(i, i + 3) === char.repeat(3);
			if (triple) i += 2;
			continue;
		} else if (char === "#") {
			comment = true;
			continue;
		} else if (char === "[" || char === "{") depth++;
		else if (char === "]" || char === "}") depth--;
		if (char === "\n" && depth === 0) {
			yield source.slice(start, i + 1);
			start = i + 1;
		}
	}
	if (start < source.length) yield source.slice(start);
}

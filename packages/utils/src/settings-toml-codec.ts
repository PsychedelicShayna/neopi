import { isRecord } from "./type-guards";

export function plainSettingsTomlTable(value: unknown): value is Record<string, unknown> {
	return (
		isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	);
}
/** Restore versioned JSON Pointer explicit clears in an owned TOML document. */
export function decodeSettingsToml(input: Record<string, unknown>): Record<string, unknown> {
	if (!Object.hasOwn(input, "__npi")) return input;
	const metadata = input.__npi;
	if (
		!plainSettingsTomlTable(metadata) ||
		metadata.version !== 1 ||
		!Array.isArray(metadata.null_paths) ||
		!metadata.null_paths.every(entry => typeof entry === "string") ||
		Object.keys(metadata).some(key => key !== "version" && key !== "null_paths")
	)
		throw new Error("Invalid reserved __npi metadata. Expected version = 1 and null_paths = [JSON Pointers].");
	const decoded = structuredClone(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "__npi")));
	const seen = new Set<string>();
	for (const pointer of metadata.null_paths as string[]) {
		if (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer) || seen.has(pointer)) {
			throw new Error(`Invalid or duplicate null path: ${JSON.stringify(pointer)}`);
		}
		seen.add(pointer);
		const segments = pointer
			.slice(1)
			.split("/")
			.map(segment => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
		if (segments[0] === "__npi") throw new Error("Null paths cannot target reserved __npi metadata");
		let parent: unknown = decoded;
		for (const [index, segment] of segments.entries()) {
			const last = index === segments.length - 1;
			if (Array.isArray(parent)) {
				if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= parent.length) {
					throw new Error(`Null path has an invalid array index: ${JSON.stringify(pointer)}`);
				}
				if (last) {
					if (parent[Number(segment)] !== "")
						throw new Error(`Null array placeholder must be an empty string: ${JSON.stringify(pointer)}`);
					parent[Number(segment)] = null;
				} else parent = parent[Number(segment)];
			} else if (plainSettingsTomlTable(parent)) {
				if (last) {
					if (Object.hasOwn(parent, segment))
						throw new Error(`Null path conflicts with a value: ${JSON.stringify(pointer)}`);
					Object.defineProperty(parent, segment, {
						value: null,
						enumerable: true,
						writable: true,
						configurable: true,
					});
				} else {
					if (!Object.hasOwn(parent, segment))
						throw new Error(`Null path has a missing parent: ${JSON.stringify(pointer)}`);
					parent = parent[segment];
				}
			} else throw new Error(`Null path has a non-table parent: ${JSON.stringify(pointer)}`);
		}
	}
	return decoded;
}

function equalTomlValues(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right))
		return left.length === right.length && left.every((entry, index) => equalTomlValues(entry, right[index]));
	if (!plainSettingsTomlTable(left) || !plainSettingsTomlTable(right)) return false;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every(key => Object.hasOwn(right, key) && equalTomlValues(left[key], right[key]))
	);
}

export interface SettingsTomlCodec {
	parseSettingsToml(content: string, filePath?: string): Record<string, unknown>;
	stringifySettingsToml(settings: object): string;
	patchSettingsToml(source: string, settings: object): string;
	stringifyTomlValue(value: unknown): string;
}

/** Bind the owned-document codec to the host TOML reader (Bun or a browser parser). */
export function createSettingsTomlCodec(parseToml: (content: string) => Record<string, unknown>): SettingsTomlCodec {
	const plainTable = plainSettingsTomlTable;
	function parseSettingsToml(content: string, filePath?: string): Record<string, unknown> {
		try {
			const parsed: unknown = parseToml(content);
			if (!isRecord(parsed)) throw new Error("Expected a settings table");
			return decodeSettingsToml(parsed);
		} catch {
			throw new Error(`Settings config is invalid${filePath ? `: ${filePath}` : ""}`);
		}
	}

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

	function tomlValue(value: unknown, multiline = false): string {
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

	/** Format a non-null TOML value, for generated reference documents. */
	function stringifyTomlValue(value: unknown): string {
		return tomlValue(value);
	}

	/** Encode the complete user mapping, including unknown keys and explicit nulls. */
	function stringifySettingsToml(settings: object): string {
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
				throw new Error(
					`${pointer || "/"}: unsupported ${value instanceof Date ? "date/time" : typeof value} value`,
				);
			}
			if (ancestors.has(value)) throw new Error(`${pointer}: cyclic values cannot be represented`);
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
		if (!equalTomlValues(parseSettingsToml(content), settings)) {
			throw new Error("TOML reader cannot recover the complete configuration exactly; no file was written");
		}
		return content;
	}

	/** Statement boundaries outside strings, comments, arrays and inline tables. */
	/**
	 * Edit individual assignments in their original table, retaining comments and
	 * untouched bytes even when another property in the same table changes.
	 */
	function patchSettingsToml(source: string, settings: object): string {
		const previous = parseSettingsToml(source);
		if (equalTomlValues(previous, settings)) return source;
		const desired = parseToml(stringifySettingsToml(settings)) as Record<string, unknown>;
		type Segment = string | number;
		type Section = { path: Segment[]; header: string; statements: string[]; active: boolean };
		const sections: Section[] = [{ path: [], header: "", statements: [], active: true }];
		const consumed = new Set<string>();
		const arrays = new Map<string, number>();
		const at = (root: unknown, keys: readonly Segment[]): unknown => {
			let value: unknown = root;
			for (const key of keys) {
				if (!Array.isArray(value) && !plainTable(value)) return undefined;
				if (!Object.hasOwn(value, key)) return undefined;
				value = (value as Record<string | number, unknown>)[key];
			}
			return value;
		};
		const valueAt = (keys: readonly Segment[]) => at(desired, keys);
		// Stable item identifiers keep comments attached to their item rather than
		// to its old array index when an editor removes or reorders rows.
		const mappedPath = (keys: Segment[]): Segment[] => {
			const mapped: Segment[] = [];
			for (const [index, key] of keys.entries()) {
				if (typeof key !== "number") {
					mapped.push(key);
					continue;
				}
				const oldArray = at(previous, keys.slice(0, index));
				const newArray = valueAt(mapped);
				const oldItem = Array.isArray(oldArray) ? oldArray[key] : undefined;
				const identity = plainTable(oldItem)
					? ["id", "name"].find(
							field =>
								typeof oldItem[field] === "string" &&
								Array.isArray(oldArray) &&
								oldArray.filter(item => plainTable(item) && item[field] === oldItem[field]).length === 1,
						)
					: undefined;
				if (identity && plainTable(oldItem) && Array.isArray(newArray)) {
					const matches = newArray.flatMap((item, position) =>
						plainTable(item) && item[identity] === oldItem[identity] ? [position] : [],
					);
					mapped.push(matches.length === 1 ? matches[0]! : matches.length === 0 ? -1 : key);
				} else mapped.push(key);
			}
			return mapped;
		};
		const keysOf = (key: string): string[] => {
			let value: unknown = parseToml(`${key} = 0`);
			const keys: string[] = [];
			while (plainTable(value)) {
				const [entry] = Object.entries(value);
				if (!entry) break;
				keys.push(entry[0]);
				value = entry[1];
			}
			return keys;
		};
		const resolveHeader = (keys: string[], array: boolean): Segment[] => {
			const result: Segment[] = [];
			for (const [index, key] of keys.entries()) {
				result.push(key);
				const identity = JSON.stringify(result);
				if (array && index === keys.length - 1) {
					const next = (arrays.get(identity) ?? -1) + 1;
					arrays.set(identity, next);
					result.push(next);
				} else if (arrays.has(identity)) result.push(arrays.get(identity)!);
			}
			return result;
		};
		let section = sections[0]!;
		for (const statement of tomlStatements(source)) {
			const trimmed = statement.trimStart();
			if (!trimmed || trimmed.startsWith("#")) {
				section.statements.push(statement);
				continue;
			}
			if (trimmed.startsWith("[")) {
				const array = trimmed.startsWith("[[");
				const closing = array ? "]]" : "]";
				// The header's closing brackets may occur in quoted keys. Parse
				// candidate prefixes instead of treating those bytes as delimiters.
				let keys: string[] | undefined;
				for (let end = trimmed.indexOf(closing); end >= 0; end = trimmed.indexOf(closing, end + 1)) {
					try {
						keys = keysOf(trimmed.slice(array ? 2 : 1, end));
						break;
					} catch {
						/* A delimiter inside a quoted key is not the end. */
					}
				}
				if (!keys) throw new Error("Cannot locate TOML table header");
				const keysPath = mappedPath(resolveHeader(keys, array));
				let header = statement;
				if (section.path.length) {
					const leading: string[] = [];
					while (
						section.statements.length &&
						/^(?:\s|#)/.test(section.statements.at(-1)!) &&
						(!section.statements.at(-1)!.trim() || section.statements.at(-1)!.trimStart().startsWith("#"))
					) {
						leading.unshift(section.statements.pop()!);
					}
					header = leading.join("") + header;
				}
				section = { path: keysPath, header, statements: [], active: plainTable(valueAt(keysPath)) };
				sections.push(section);
				continue;
			}
			let equals = -1;
			let keys: string[] | undefined;
			for (let index = statement.indexOf("="); index >= 0; index = statement.indexOf("=", index + 1)) {
				try {
					keys = keysOf(statement.slice(0, index));
					equals = index;
					break;
				} catch {
					/* Equals signs can also occur inside quoted keys. */
				}
			}
			if (!keys) throw new Error("Cannot locate TOML assignment");
			const keysPath = [...section.path, ...keys];
			const value = valueAt(keysPath);
			if (value === undefined) {
				const { suffix, leading } = tomlAssignmentComments(statement.slice(equals + 1));
				if (leading) section.statements.push(leading);
				if (suffix.trimStart().startsWith("#")) section.statements.push(suffix.trimStart());
				continue;
			}
			consumed.add(JSON.stringify(keysPath));
			const original = parseToml(statement) as Record<string, unknown>;
			let originalValue: unknown = original;
			for (const key of keys) originalValue = (originalValue as Record<string, unknown>)[key];
			if (equalTomlValues(originalValue, value)) section.statements.push(statement);
			else {
				const { suffix, leading } = tomlAssignmentComments(statement.slice(equals + 1));
				section.statements.push(`${leading}${statement.slice(0, equals + 1)} ${tomlValue(value, true)}${suffix}`);
			}
		}
		const additions: { path: Segment[]; value: unknown }[] = [];
		const collect = (value: unknown, keys: Segment[]): void => {
			if (consumed.has(JSON.stringify(keys))) return;
			const matching = sections.some(candidate => candidate.active && equalTomlValues(candidate.path, keys));
			if (plainTable(value)) {
				const entries = Object.entries(value);
				if (entries.length === 0 && !matching && keys.length) additions.push({ path: keys, value });
				else for (const [key, entry] of entries) collect(entry, [...keys, key]);
			} else if (
				Array.isArray(value) &&
				value.length > 0 &&
				value.every(plainTable) &&
				sections.some(
					candidate =>
						candidate.path.length > keys.length &&
						equalTomlValues(candidate.path.slice(0, keys.length), keys) &&
						typeof candidate.path[keys.length] === "number",
				)
			) {
				for (const [index, entry] of value.entries()) collect(entry, [...keys, index]);
			} else additions.push({ path: keys, value });
		};
		collect(desired, []);
		for (const addition of additions) {
			const candidates = sections.filter(
				candidate =>
					candidate.active &&
					candidate.path.length < addition.path.length &&
					equalTomlValues(candidate.path, addition.path.slice(0, candidate.path.length)),
			);
			const destination = candidates.sort((a, b) => b.path.length - a.path.length)[0];
			if (!destination || addition.path.slice(destination.path.length).some(key => typeof key !== "string")) {
				// A newly added array-table element needs its own header.
				const numberIndex = addition.path.findLastIndex(key => typeof key === "number");
				if (numberIndex < 0) throw new Error("Cannot place TOML assignment");
				const parentPath = addition.path.slice(0, numberIndex + 1);
				let newSection = sections.find(candidate => equalTomlValues(candidate.path, parentPath));
				if (!newSection) {
					const name = parentPath
						.filter(key => typeof key === "string")
						.map(key => tomlString(String(key), false))
						.join(".");
					newSection = { path: parentPath, header: `\n[[${name}]]\n`, statements: [], active: true };
					sections.push(newSection);
				}
				if (addition.path.length > parentPath.length) {
					newSection.statements.push(
						`${addition.path
							.slice(parentPath.length)
							.map(key => tomlString(String(key), false))
							.join(".")} = ${tomlValue(addition.value, true)}\n`,
					);
				}
			} else {
				destination.statements.push(
					`${addition.path
						.slice(destination.path.length)
						.map(key => tomlString(String(key), false))
						.join(".")} = ${tomlValue(addition.value, true)}\n`,
				);
			}
		}
		// A section and its descendants form one array item. Sort those groups by
		// the requested index while retaining the order of unrelated table names.
		const tableOrder = new Map<string, number>();
		for (const [index, candidate] of sections.entries()) {
			const identity = JSON.stringify(candidate.path.filter(key => typeof key === "string"));
			if (!tableOrder.has(identity)) tableOrder.set(identity, index);
		}
		sections.sort((left, right) => {
			for (let index = 0; index < Math.min(left.path.length, right.path.length); index++) {
				const a = left.path[index]!;
				const b = right.path[index]!;
				if (a === b) continue;
				if (typeof a === "number" && typeof b === "number") return a - b;
				const aOrder =
					tableOrder.get(JSON.stringify(left.path.slice(0, index + 1).filter(key => typeof key === "string"))) ??
					sections.length;
				const bOrder =
					tableOrder.get(JSON.stringify(right.path.slice(0, index + 1).filter(key => typeof key === "string"))) ??
					sections.length;
				return aOrder - bOrder;
			}
			return left.path.length - right.path.length;
		});
		const content = sections
			.map(candidate => {
				if (!candidate.active) {
					const headerComments = [...tomlStatements(candidate.header)]
						.map(statement => {
							if (statement.trimStart().startsWith("#")) return statement;
							const { suffix } = tomlAssignmentComments(statement);
							return suffix.trimStart().startsWith("#") ? suffix.trimStart() : "";
						})
						.join("");
					return (
						headerComments +
						candidate.statements.filter(statement => statement.trimStart().startsWith("#")).join("")
					);
				}
				const header =
					candidate.header && candidate.statements.length && !candidate.header.endsWith("\n")
						? `${candidate.header}\n`
						: candidate.header;
				return (
					header +
					candidate.statements
						.map((statement, index, list) =>
							index < list.length - 1 && !statement.endsWith("\n") ? `${statement}\n` : statement,
						)
						.join("")
				);
			})
			.join("");
		if (!equalTomlValues(parseSettingsToml(content), settings)) {
			throw new Error("TOML edit cannot preserve the complete configuration; no file was written");
		}
		return content;
	}

	/** Retain comments inside replaced containers as well as the trailing comment. */
	function tomlAssignmentComments(value: string): { suffix: string; leading: string } {
		let quote = "";
		let triple = false;
		let depth = 0;
		let leading = "";
		for (let index = 0; index < value.length; index++) {
			const char = value[index];
			if (quote) {
				if (quote === '"' && char === "\\") {
					index++;
					continue;
				}
				if (char === quote) {
					if (!triple) quote = "";
					else if (value.slice(index, index + 3) === quote.repeat(3)) {
						while (value[index + 3] === quote) index++;
						index += 2;
						quote = "";
					}
				}
			} else if (char === '"' || char === "'") {
				quote = char;
				triple = value.slice(index, index + 3) === char.repeat(3);
				if (triple) index += 2;
			} else if (char === "[" || char === "{") depth++;
			else if (char === "]" || char === "}") depth--;
			else if (char === "#") {
				if (depth === 0) return { suffix: ` ${value.slice(index)}`, leading };
				const newline = value.indexOf("\n", index);
				if (newline < 0) break;
				leading += `${value.slice(index, newline).trimEnd()}\n`;
				index = newline;
			}
		}
		return { suffix: value.endsWith("\r\n") ? "\r\n" : value.endsWith("\n") ? "\n" : "", leading };
	}

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

	return { parseSettingsToml, stringifySettingsToml, patchSettingsToml, stringifyTomlValue };
}

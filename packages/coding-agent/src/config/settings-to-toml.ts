import { preserveLegacyYamlComments } from "@oh-my-pi/pi-utils/legacy-yaml-import";
import * as path from "node:path";
import { getAgentDir, getProjectAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { isAlias, isMap, isNode, isScalar, isSeq, parseAllDocuments } from "yaml";
import {
	importLegacyYaml,
	publishTomlImport,
	readTomlConfig,
	stringifySettingsToml,
} from "@oh-my-pi/pi-utils/settings-toml";

export interface TomlConversionDiagnostic {
	path: string;
	message: string;
}

export interface TomlConversion {
	content: string;
	diagnostics: TomlConversionDiagnostic[];
}

/** Convert the original YAML document, never a registry or normalized settings projection. */
export function convertSettingsYamlToToml(source: string): TomlConversion {
	const diagnostics: TomlConversionDiagnostic[] = [];
	const documents = parseAllDocuments(source);
	if (documents.length > 1) throw new Error("/: multiple YAML documents cannot be converted to one settings table");
	const document = documents[0];
	if (!document) return { content: stringifySettingsToml({}), diagnostics };
	if (document.errors.length) {
		// yaml error messages can quote source lines containing credentials.
		throw new Error(`/: invalid YAML (${document.errors.map(error => error.code).join(", ")}); no TOML was written`);
	}
	const report = (pointer: string, message: string) => diagnostics.push({ path: pointer || "/", message });
	const ancestors = new Set<unknown>();
	if (document.commentBefore || document.comment)
		report("/", "YAML comments retained in TOML preamble; original field associations are not retained");
	function inspect(node: unknown, pointer: string): void {
		if (!isNode(node)) return;
		if (node.commentBefore || node.comment)
			report(pointer, "YAML comments retained in TOML preamble; original field associations are not retained");
		if (isAlias(node)) {
			if (ancestors.has(node.resolve(document)))
				throw new Error(`${pointer}: cyclic YAML aliases cannot be represented`);
			report(pointer, "YAML alias expanded; shared reference identity is not carried over");
			return;
		}
		if (
			node.tag &&
			![
				"tag:yaml.org,2002:str",
				"tag:yaml.org,2002:int",
				"tag:yaml.org,2002:float",
				"tag:yaml.org,2002:bool",
				"tag:yaml.org,2002:null",
				"tag:yaml.org,2002:map",
				"tag:yaml.org,2002:seq",
			].includes(node.tag)
		) {
			throw new Error(`${pointer || "/"}: YAML custom tags and date/time tags cannot be represented exactly`);
		}
		if ((isScalar(node) || isMap(node) || isSeq(node)) && node.anchor)
			report(pointer, "YAML anchor syntax is not carried over");
		if (isScalar(node) && node.value === null) report(pointer, "Explicit null encoded with NeoPi null-path metadata");
		ancestors.add(node);
		if (isMap(node)) {
			for (const pair of node.items) {
				if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
					throw new Error(`${pointer || "/"}: non-string YAML mapping keys cannot be represented as TOML keys`);
				}
				const child = `${pointer}/${pair.key.value.replaceAll("~", "~0").replaceAll("/", "~1")}`;
				inspect(pair.key, child);
				inspect(pair.value, child);
			}
		} else if (isSeq(node)) node.items.forEach((entry, index) => inspect(entry, `${pointer}/${index}`));
		ancestors.delete(node);
	}
	inspect(document.contents, "");
	if (document.warnings.length)
		throw new Error("/: YAML has unsupported or ambiguous constructs; no TOML was written");
	if (document.contents !== null && !isMap(document.contents))
		throw new Error("/: settings YAML must contain a mapping at the document root");
	// The AST reports source-level losses; Bun owns the effective settings
	// values, including merge-key expansion, exactly as in Settings.
	let parsed: unknown;
	try {
		parsed = importLegacyYaml(source);
	} catch {
		throw new Error("/: the settings YAML reader rejected this document; no TOML was written");
	}
	const content = preserveLegacyYamlComments(source, stringifySettingsToml((parsed ?? {}) as Record<string, unknown>));
	return { content, diagnostics };
}

export interface SettingsTomlConversionResult {
	sourcePath: string;
	targetPath: string;
	diagnostics: TomlConversionDiagnostic[];
}

/** Explicit import is also non-destructive: an existing canonical document always wins. */
export async function convertSettingsFileToToml(filePath: string): Promise<SettingsTomlConversionResult> {
	const sourcePath = path.resolve(filePath);
	if (!/\.ya?ml$/i.test(sourcePath)) throw new Error("Pass a legacy .yml or .yaml settings file");
	const targetPath = sourcePath.replace(/\.ya?ml$/i, ".toml");
	const existing = await readTomlConfig(targetPath);
	if (existing) {
		await readTomlConfig(targetPath, { legacyPaths: [sourcePath] });
		return { sourcePath, targetPath, diagnostics: [] };
	}
	const converted = convertSettingsYamlToToml(await Bun.file(sourcePath).text());
	await publishTomlImport(targetPath, converted.content, sourcePath);
	return { sourcePath, targetPath, diagnostics: converted.diagnostics };
}

/** No file argument converts the selected user YAML and the current native project YAML, when present. */
export async function convertMainSettingsToToml(
	options: {
		file?: string;
		agentDir?: string;
		cwd?: string;
	} = {},
): Promise<SettingsTomlConversionResult[]> {
	if (options.file) return [await convertSettingsFileToToml(options.file)];
	const sources: string[] = [];
	for (const directory of [options.agentDir ?? getAgentDir(), getProjectAgentDir(options.cwd ?? process.cwd())]) {
		for (const filename of ["config.yml", "config.yaml"]) {
			const sourcePath = path.resolve(directory, filename);
			try {
				await Bun.file(sourcePath).text();
				if (!sources.includes(sourcePath)) sources.push(sourcePath);
				break;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	}
	if (!sources.length)
		throw new Error("No user or project main settings YAML found. Pass a config.yml or config.yaml path explicitly.");
	const results: SettingsTomlConversionResult[] = [];
	for (const source of sources) {
		try {
			results.push(await convertSettingsFileToToml(source));
		} catch (error) {
			if (!results.length) throw error;
			const published = results.flatMap(result => [
				`Already converted ${result.sourcePath} -> ${result.targetPath}`,
				...result.diagnostics.map(diagnostic => `${result.sourcePath} ${diagnostic.path}: ${diagnostic.message}`),
			]);
			throw new Error([error instanceof Error ? error.message : "TOML conversion failed", ...published].join("\n"));
		}
	}
	return results;
}

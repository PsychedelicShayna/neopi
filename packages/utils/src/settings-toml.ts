import * as fs from "node:fs";
import * as path from "node:path";
import { isEexist, isEnoent } from "./fs-error";
import { preserveLegacyYamlComments } from "./legacy-yaml-import";
import * as logger from "./logger";
import { createSettingsTomlCodec, plainSettingsTomlTable as plainTable } from "./settings-toml-codec";
export * from "./settings-toml-codec";
export const { parseSettingsToml, stringifySettingsToml, patchSettingsToml, stringifyTomlValue } =
	createSettingsTomlCodec(content => Bun.TOML.parse(content));
export const SETTINGS_TOML = "settings.toml";
export const CONFIG_TOML = "config.toml";

export interface TomlConfigSource {
	filePath: string;
	content: string;
	data: Record<string, unknown>;
}

export interface TomlConfigReadOptions {
	legacyPaths?: readonly string[];
	parseLegacy?: (content: string, filePath: string) => Record<string, unknown>;
	/** Read inherited legacy configuration without modifying its directory. */
	migrate?: boolean;
}

/** Legacy parsing is confined to the import seam; parser errors never disclose values. */
export function importLegacyYamlValue(content: string, filePath?: string): unknown {
	try {
		return Bun.YAML.parse(content);
	} catch {
		throw new Error(`Invalid legacy YAML configuration${filePath ? `: ${filePath}` : ""}`);
	}
}

export function importLegacyYaml(content: string, filePath?: string): Record<string, unknown> {
	const value = importLegacyYamlValue(content, filePath) ?? {};
	if (!plainTable(value))
		throw new Error(`Legacy configuration must contain a mapping${filePath ? `: ${filePath}` : ""}`);
	return value;
}

async function publishContent(filePath: string, content: string, mode: number, noReplace: boolean): Promise<void> {
	const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	try {
		const handle = await fs.promises.open(temporary, "wx", mode);
		try {
			await handle.writeFile(content, "utf8");
			await handle.chmod(mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (noReplace) await fs.promises.link(temporary, filePath);
		else await fs.promises.rename(temporary, filePath);
	} finally {
		await fs.promises.rm(temporary, { force: true });
	}
}

function publishContentSync(filePath: string, content: string, mode: number, noReplace: boolean): void {
	const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	try {
		const fd = fs.openSync(temporary, "wx", mode);
		try {
			fs.writeFileSync(fd, content, "utf8");
			fs.fchmodSync(fd, mode);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		if (noReplace) fs.linkSync(temporary, filePath);
		else fs.renameSync(temporary, filePath);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

/** Publish a complete imported sibling without ever modifying the legacy file. */
export async function publishTomlImport(filePath: string, content: string, legacyPath: string): Promise<void> {
	try {
		await publishContent(filePath, content, (await fs.promises.stat(legacyPath)).mode & 0o7777, true);
		logger.info("Imported legacy configuration", { sourcePath: legacyPath, targetPath: filePath });
	} catch (error) {
		if (!isEexist(error)) throw error;
		logger.warn("Ignoring legacy configuration in favor of TOML", { sourcePath: legacyPath, targetPath: filePath });
	}
}

export function publishTomlImportSync(filePath: string, content: string, legacyPath: string): void {
	try {
		publishContentSync(filePath, content, fs.statSync(legacyPath).mode & 0o7777, true);
		logger.info("Imported legacy configuration", { sourcePath: legacyPath, targetPath: filePath });
	} catch (error) {
		if (!isEexist(error)) throw error;
		logger.warn("Ignoring legacy configuration in favor of TOML", { sourcePath: legacyPath, targetPath: filePath });
	}
}

function parseLegacyConfig(content: string, filePath: string, options: TomlConfigReadOptions): Record<string, unknown> {
	try {
		const data = (options.parseLegacy ?? importLegacyYaml)(content, filePath);
		if (!plainTable(data)) throw new Error("Expected a mapping");
		return data;
	} catch {
		throw new Error(`Failed to import legacy configuration: ${filePath}`);
	}
}

function encodeLegacyConfig(
	content: string,
	sourcePath: string,
	targetPath: string,
	data: object,
	options: TomlConfigReadOptions,
): string {
	if (sourcePath.endsWith(".toml")) return patchSettingsToml(content, data);
	const toml = stringifySettingsToml(data);
	if (!/\.ya?ml$/i.test(sourcePath) && options.parseLegacy) return toml;
	const retained = preserveLegacyYamlComments(content, toml);
	if (retained !== toml) {
		logger.warn("Imported YAML comments as a TOML preamble; original field associations are not retained", {
			sourcePath,
			targetPath,
		});
	}
	return retained;
}

export async function readTomlConfig(
	filePath: string,
	options: TomlConfigReadOptions = {},
): Promise<TomlConfigSource | undefined> {
	let content: string | undefined;
	try {
		content = await fs.promises.readFile(filePath, "utf8");
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	for (const legacyPath of options.legacyPaths ?? []) {
		if (legacyPath === filePath) continue;
		if (content !== undefined) {
			try {
				await fs.promises.lstat(legacyPath);
				logger.warn("Ignoring legacy configuration in favor of TOML", {
					sourcePath: legacyPath,
					targetPath: filePath,
				});
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			continue;
		}
		let legacy: string;
		try {
			legacy = await fs.promises.readFile(legacyPath, "utf8");
		} catch (error) {
			if (!isEnoent(error)) throw error;
			continue;
		}
		const data = parseLegacyConfig(legacy, legacyPath, options);
		if (options.migrate === false) return { filePath: legacyPath, content: legacy, data };
		await publishTomlImport(filePath, encodeLegacyConfig(legacy, legacyPath, filePath, data, options), legacyPath);
		content = await fs.promises.readFile(filePath, "utf8");
	}
	return content === undefined ? undefined : { filePath, content, data: parseSettingsToml(content, filePath) };
}

export function readTomlConfigSync(
	filePath: string,
	options: TomlConfigReadOptions = {},
): TomlConfigSource | undefined {
	let content: string | undefined;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	for (const legacyPath of options.legacyPaths ?? []) {
		if (legacyPath === filePath) continue;
		if (content !== undefined) {
			try {
				fs.lstatSync(legacyPath);
				logger.warn("Ignoring legacy configuration in favor of TOML", {
					sourcePath: legacyPath,
					targetPath: filePath,
				});
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			continue;
		}
		let legacy: string;
		try {
			legacy = fs.readFileSync(legacyPath, "utf8");
		} catch (error) {
			if (!isEnoent(error)) throw error;
			continue;
		}
		const data = parseLegacyConfig(legacy, legacyPath, options);
		if (options.migrate === false) return { filePath: legacyPath, content: legacy, data };
		publishTomlImportSync(filePath, encodeLegacyConfig(legacy, legacyPath, filePath, data, options), legacyPath);
		content = fs.readFileSync(filePath, "utf8");
	}
	return content === undefined ? undefined : { filePath, content, data: parseSettingsToml(content, filePath) };
}

export async function writeTomlConfig(filePath: string, data: object, source?: string): Promise<void> {
	const content = source === undefined ? stringifySettingsToml(data) : patchSettingsToml(source, data);
	if (content === source) return;
	const target = await fs.promises.realpath(filePath).catch(error => {
		if (!isEnoent(error)) throw error;
		return filePath;
	});
	const mode = await fs.promises
		.stat(target)
		.then(stat => stat.mode & 0o7777)
		.catch(error => {
			if (!isEnoent(error)) throw error;
			return 0o600;
		});
	await publishContent(target, content, mode, false);
}

export function writeTomlConfigSync(filePath: string, data: object, source?: string): void {
	const content = source === undefined ? stringifySettingsToml(data) : patchSettingsToml(source, data);
	if (content === source) return;
	let target = filePath;
	let mode = 0o600;
	try {
		target = fs.realpathSync(filePath);
		mode = fs.statSync(target).mode & 0o7777;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	publishContentSync(target, content, mode, false);
}

export async function settingsTomlSource(directory: string): Promise<TomlConfigSource | undefined> {
	return readTomlConfig(path.join(directory, CONFIG_TOML), {
		legacyPaths: [SETTINGS_TOML, "config.yml", "config.yaml"].map(filename => path.join(directory, filename)),
		parseLegacy: (content, filePath) =>
			filePath.endsWith(".toml") ? parseSettingsToml(content, filePath) : importLegacyYaml(content, filePath),
	});
}

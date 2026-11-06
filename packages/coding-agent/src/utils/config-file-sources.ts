import * as os from "node:os";
import * as path from "node:path";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { importLegacyYaml, readTomlConfigSync } from "@oh-my-pi/pi-utils/settings-toml";
import { getConfigDirPaths } from "../config";
import { type ClaudePluginRoot, getPreloadedPluginRoots } from "../discovery/helpers";

/** Turns raw file content (from `filePath`) into a config, or `null` to skip the file. */
export type ConfigFileAdapter<T> = (content: string, filePath: string) => T | null;

/** One entry of a config stack; `read` yields `null` for unreadable or rejected files. */
export interface ConfigFileSource<T> {
	read(): T | null;
}

/** Read canonical TOML, importing a legacy sibling once without modifying it. */
export function readConfigFile<T>(filePath: string, adapt: ConfigFileAdapter<T>): T | null {
	const target = filePath.replace(/\.(?:json|yaml|yml)$/, ".toml");
	const base = target.slice(0, -".toml".length);
	try {
		const loaded = readTomlConfigSync(target, {
			legacyPaths: [`${base}.json`, `${base}.yaml`, `${base}.yml`],
			parseLegacy(content, legacyPath) {
				if (!legacyPath.endsWith(".json")) return importLegacyYaml(content, legacyPath);
				const parsed: unknown = JSON.parse(content);
				if (!isRecord(parsed)) throw new Error("Expected a configuration mapping");
				return parsed;
			},
		});
		return loaded ? adapt(loaded.content, target) : null;
	} catch {
		logger.warn("Failed to load TOML configuration", { path: target });
		return null;
	}
}

export interface ConfigFileSourcesOptions<T> {
	/** Extra source emitted right after each plugin root's config files (e.g. its marketplace catalog). */
	pluginRootSource?: (root: ClaudePluginRoot) => ConfigFileSource<T>;
}

/**
 * TOML config sources for `base` (`lsp.toml` / `.lsp.toml`) in priority order:
 * cwd files, project config dirs, user config dirs, plugin roots, then home.
 * JSON/YAML siblings are considered only for one-time import. Lowest priority
 * comes last, so callers merge over a reversed list.
 */
export function configFileSources<T>(
	base: string,
	cwd: string,
	adapt: ConfigFileAdapter<T>,
	options: ConfigFileSourcesOptions<T> = {},
): ConfigFileSource<T>[] {
	const filenames = [`${base}.toml`, `.${base}.toml`];
	const sources: ConfigFileSource<T>[] = [];
	const addDir = (dir: string): void => {
		for (const filename of filenames) {
			sources.push({ read: () => readConfigFile(path.join(dir, filename), adapt) });
		}
	};

	addDir(cwd);

	for (const dir of getConfigDirPaths("", { user: false, project: true, cwd })) addDir(dir);

	for (const dir of getConfigDirPaths("", { user: true, project: false })) addDir(dir);

	for (const root of getPreloadedPluginRoots()) {
		addDir(root.path);
		const extra = options.pluginRootSource?.(root);
		if (extra) sources.push(extra);
	}

	addDir(os.homedir());

	return sources;
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, VERSION } from "@oh-my-pi/pi-utils/dirs";
import {
	CONFIG_TOML,
	overlaySettingsToml,
	parseSettingsToml,
	plainSettingsTomlTable,
	SETTINGS_TOML,
	settingsTomlSource,
} from "@oh-my-pi/pi-utils/settings-toml";
import { YAML } from "bun";
import { patchSettingsToml } from "../config/toml-document";
import { patchYamlDocument } from "../config/yaml-document";
import type { UpdateChannel, UpdateMode } from "./neopi-updater";

/** Set by release compilation; ordinary source builds follow nightly. */
export function defaultUpdateChannel(): UpdateChannel {
	return process.env.PI_UPDATE_CHANNEL === "stable" ? "stable" : "nightly";
}

export interface UpdatePreferences {
	channel: UpdateChannel;
	mode: UpdateMode;
	warning?: string;
}

interface ConfigSource {
	logicalPath: string;
	path: string;
	source: string;
	exists: boolean;
}
interface ConfigSources {
	yaml: ConfigSource;
	toml?: ConfigSource;
}

async function readSource(logicalPath: string): Promise<ConfigSource | undefined> {
	try {
		return {
			logicalPath,
			path: await fs.realpath(logicalPath),
			source: await fs.readFile(logicalPath, "utf8"),
			exists: true,
		};
	} catch (error) {
		const entry = await fs.lstat(logicalPath).catch(missing => {
			if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
			return undefined;
		});
		if (entry || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

async function configSources(agentDir: string): Promise<ConfigSources> {
	let yaml: ConfigSource | undefined;
	for (const name of ["config.yml", "config.yaml"]) {
		yaml = await readSource(path.join(agentDir, name));
		if (yaml) break;
	}
	// Use the same sibling selection/conflict contract as global Settings. Also
	// reject dangling symlinks instead of silently falling back to stale YAML.
	const selected = await settingsTomlSource(agentDir);
	for (const name of [CONFIG_TOML, SETTINGS_TOML]) {
		if (path.join(agentDir, name) !== selected?.filePath && (await readSource(path.join(agentDir, name))))
			throw new Error("Settings TOML sources changed while reading; retry the command.");
	}
	const toml = selected ? await readSource(selected.filePath) : undefined;
	if (selected && (!toml || toml.source !== selected.content))
		throw new Error("Settings TOML source changed while reading; retry the command.");
	const fallback = path.join(agentDir, "config.yml");
	return { yaml: yaml ?? { logicalPath: fallback, path: fallback, source: "", exists: false }, toml };
}

function effectiveSettings(sources: ConfigSources): {
	settings: Record<string, unknown>;
	toml: Record<string, unknown>;
} {
	const yaml: unknown = YAML.parse(sources.yaml.source) ?? {};
	if (!plainSettingsTomlTable(yaml)) throw new Error("Settings must contain a mapping at the document root");
	// Settings migrates these legacy YAML values before TOML replaces whole
	// tables. In TOML, true/canary instead fall back to notify/the build channel.
	if (plainSettingsTomlTable(yaml.update)) {
		if (yaml.update.channel === "canary") yaml.update.channel = "nightly";
		if (typeof yaml.update.auto === "boolean") yaml.update.auto = yaml.update.auto ? "auto" : "off";
	}
	const toml = sources.toml ? parseSettingsToml(sources.toml.source, sources.toml.logicalPath) : {};
	return { settings: overlaySettingsToml(yaml, toml), toml };
}

/** Raw preferences only: no database, settings migration, project overlay or dotenv. */
export async function readUpdatePreferences(agentDir = getAgentDir()): Promise<UpdatePreferences> {
	try {
		const { settings } = effectiveSettings(await configSources(agentDir));
		const update = plainSettingsTomlTable(settings.update) ? settings.update : undefined;
		const channel = update?.channel;
		const auto = update?.auto;
		return {
			channel: channel === "stable" ? "stable" : channel === "nightly" ? "nightly" : defaultUpdateChannel(),
			// A TOML false remains conservatively Off, even though Settings falls
			// back to Notify; TOML true must never authorize automatic replacement.
			mode: auto === "auto" ? "auto" : auto === "off" || auto === false ? "off" : "notify",
		};
	} catch (error) {
		return {
			channel: defaultUpdateChannel(),
			mode: "notify",
			warning: `Cannot read update preferences: ${String(error)}`,
		};
	}
}

function sameSource(left: ConfigSource | undefined, right: ConfigSource | undefined): boolean {
	return (
		left?.logicalPath === right?.logicalPath &&
		left?.path === right?.path &&
		left?.source === right?.source &&
		left?.exists === right?.exists
	);
}

/** Preserve unrelated keys/comments and symlink targets; never load the full settings graph. */
export async function persistUpdateChannel(
	channel: UpdateChannel,
	agentDir = getAgentDir(),
	commit?: () => Promise<void>,
): Promise<void> {
	const sources = await configSources(agentDir);
	const target = sources.toml ?? sources.yaml;
	const { settings, toml } = effectiveSettings(sources);
	const update = plainSettingsTomlTable(settings.update) ? settings.update : {};
	const next = sources.toml
		? patchSettingsToml(sources.toml.source, {
				...toml,
				update: { ...update, channel },
			})
		: patchYamlDocument(target.source, [{ path: ["update", "channel"], operation: "set", value: channel }]);
	await fs.mkdir(path.dirname(target.path), { recursive: true });
	const temporary = `${target.path}.update-${process.pid}-${crypto.randomUUID()}`;
	const mode = await fs.stat(target.path).then(
		value => value.mode & 0o777,
		error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return 0o600;
		},
	);
	try {
		await fs.writeFile(temporary, next, { flag: "wx", mode });
		await fs.chmod(temporary, mode);
		const latest = await configSources(agentDir);
		if (!sameSource(sources.yaml, latest.yaml) || !sameSource(sources.toml, latest.toml))
			throw new Error("Update channel was not saved: config changed concurrently; retry the command.");
		await fs.rename(temporary, target.path);
		if (commit) {
			try {
				await commit();
			} catch (error) {
				// Only undo this transaction's bytes, never another writer's edit or
				// a retargeted logical symlink, after updater-state commit failure.
				const current = await readSource(target.logicalPath);
				if (!current || current.path !== target.path || current.source !== next) {
					throw new Error(
						"Updater state failed and config changed concurrently; refusing to overwrite the external edit.",
						{ cause: error },
					);
				}
				if (target.exists) {
					await fs.writeFile(temporary, target.source, { flag: "wx", mode });
					await fs.chmod(temporary, mode);
					await fs.rename(temporary, target.path);
				} else await fs.unlink(target.path);
				throw error;
			}
		}
	} finally {
		await fs.unlink(temporary).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}

export { getAgentDir, VERSION };

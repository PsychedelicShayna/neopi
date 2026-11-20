import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, VERSION } from "@oh-my-pi/pi-utils/dirs";
import { YAML } from "bun";
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

async function configSource(agentDir: string): Promise<{ path: string; source: string }> {
	for (const name of ["config.yml", "config.yaml"]) {
		const path = join(agentDir, name);
		try {
			return { path: await realpath(path), source: await readFile(path, "utf8") };
		} catch (error) {
			const entry = await lstat(path).catch(missing => {
				if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
				return undefined;
			});
			if (entry) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return { path: join(agentDir, "config.yml"), source: "" };
}

/** Raw preferences only: no database, settings migration, project overlay or dotenv. */
export async function readUpdatePreferences(agentDir = getAgentDir()): Promise<UpdatePreferences> {
	try {
		const { source } = await configSource(agentDir);
		const raw = YAML.parse(source) as { update?: { channel?: unknown; auto?: unknown } } | null;
		const channel = raw?.update?.channel;
		const auto = raw?.update?.auto;
		return {
			channel:
				channel === "stable"
					? "stable"
					: channel === "nightly" || channel === "canary"
						? "nightly"
						: defaultUpdateChannel(),
			mode: auto === "auto" || auto === true ? "auto" : auto === "off" || auto === false ? "off" : "notify",
		};
	} catch (error) {
		return {
			channel: defaultUpdateChannel(),
			mode: "notify",
			warning: `Cannot read update preferences: ${String(error)}`,
		};
	}
}

/** Preserve unrelated keys/comments and symlink targets; never load the full settings graph. */
export async function persistUpdateChannel(
	channel: UpdateChannel,
	agentDir = getAgentDir(),
	commit?: () => Promise<void>,
): Promise<void> {
	const { path, source } = await configSource(agentDir);
	const next = patchYamlDocument(source, [{ path: ["update", "channel"], operation: "set", value: channel }]);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.update-${process.pid}-${crypto.randomUUID()}`;
	const mode = await stat(path).then(
		value => value.mode & 0o777,
		error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return 0o600;
		},
	);
	try {
		await writeFile(temporary, next, { flag: "wx", mode });
		const latest = await readFile(path, "utf8").catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return "";
		});
		if (latest !== source)
			throw new Error("Update channel was not saved: config changed concurrently; retry the command.");
		await rename(temporary, path);
		if (commit) {
			try {
				await commit();
			} catch (error) {
				// A failed updater-state commit must not leave a switched channel
				// undoing an existing rollback hold after the binary is restored.
				if ((await readFile(path, "utf8")) !== next) {
					throw new Error(
						"Updater state failed and config changed concurrently; refusing to overwrite the external edit.",
						{ cause: error },
					);
				}
				await writeFile(temporary, source, { flag: "wx", mode });
				await rename(temporary, path);
				throw error;
			}
		}
	} finally {
		await unlink(temporary).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}

export { getAgentDir, VERSION };

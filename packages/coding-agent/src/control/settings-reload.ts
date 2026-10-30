import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectAgentDir } from "@oh-my-pi/pi-utils";
import { ControlClient } from "./client";
import { readControlEntries } from "./registry";

export type SettingsReloadScope = "global" | "project" | "session";
export interface SettingsReloadResult {
	notified: number;
	failed: number;
	unsupported: number;
}

/** Resolve the native settings directory using the loader's cwd-local scope rule. */
export async function settingsProjectPath(projectDir: string): Promise<string> {
	const absolute = path.resolve(getProjectAgentDir(projectDir));
	try {
		return await fs.realpath(absolute);
	} catch {
		try {
			return path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
		} catch {
			return absolute;
		}
	}
}

/** Re-read durable settings in every other live host; session edits never leave this process. */
export async function broadcastSettingsReload(
	scope: SettingsReloadScope,
	projectDir?: string,
): Promise<SettingsReloadResult> {
	if (scope === "session") return { notified: 0, failed: 0, unsupported: 0 };
	if (scope !== "global" && scope !== "project") throw new Error("Unknown settings reload scope");
	if (scope === "project" && !projectDir) throw new Error("Project settings reload requires a project directory");
	const project = scope === "project" ? await settingsProjectPath(projectDir!) : undefined;
	const entries = await readControlEntries();
	const outcomes = await Promise.all(
		entries.map(async ({ meta }) => {
			if (meta.pid === process.pid) return undefined;
			if (project && (await settingsProjectPath(meta.cwd)) !== project) return undefined;
			const client = new ControlClient({ metadata: meta, label: "settings-apply", timeoutMs: 750 });
			try {
				await client.connect();
				const response = await client.request({ type: "reload_settings", scope, projectDir });
				if (
					!response.success &&
					(response.code === "unknown_command" ||
						response.code === "unsupported_command" ||
						response.error === "Unknown command: reload_settings")
				)
					return "unsupported";
				return response.success && (response.data as { applied?: boolean } | undefined)?.applied === true;
			} catch {
				return false;
			} finally {
				client.close();
			}
		}),
	);
	return {
		notified: outcomes.filter(result => result === true).length,
		failed: outcomes.filter(result => result === false).length,
		unsupported: outcomes.filter(result => result === "unsupported").length,
	};
}

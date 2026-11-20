import * as path from "node:path";
import type { SettingsFileScope } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { resolveSettingsTomlPath } from "./settings-toml";

export type ConfigViewTarget =
	| { kind: "settings"; scope?: SettingsFileScope }
	| { kind: "models"; section: "roles" | "effort" | "context" | "overrides"; scope?: "global" | "project" }
	| { kind: "advisor" | "agent"; filePath?: string };

export interface ConfigViewFiles {
	settings: {
		getConfigFile(scope?: "global" | "project"): string;
		mirrorState(): { readonly sessionSettingsPath: string | undefined };
	};
	models: { getConfigFile(): string };
}

/** Map each view to files its current loader actually reads. */
export async function resolveConfigViewFile(
	target: ConfigViewTarget,
	files: ConfigViewFiles,
): Promise<string | undefined> {
	let filePath: string | undefined;
	let settingsFile = false;
	switch (target.kind) {
		case "settings":
			// The bound sidecar opens even before its first save; only a session without a file has none.
			if (target.scope === "session") return files.settings.mirrorState().sessionSettingsPath;
			filePath = files.settings.getConfigFile(target.scope);
			settingsFile = true;
			break;
		case "models":
			settingsFile = target.section !== "overrides";
			filePath = settingsFile ? files.settings.getConfigFile(target.scope) : files.models.getConfigFile();
			break;
		case "advisor":
		case "agent":
			filePath = target.filePath;
			break;
	}
	if (!filePath) return undefined;
	if (settingsFile) {
		const overlay = await resolveSettingsTomlPath(path.dirname(filePath));
		if (overlay) return overlay;
	}
	return filePath;
}

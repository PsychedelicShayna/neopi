export type ConfigViewTarget =
	| { kind: "settings"; scope?: "global" | "project" }
	| { kind: "models"; section: "roles" | "effort" | "context" | "overrides"; scope?: "global" | "project" }
	| { kind: "advisor" | "agent"; filePath?: string };

export interface ConfigViewFiles {
	settings: { getConfigFile(scope?: "global" | "project"): string };
	models: { getConfigFile(): string };
}

/** Map each view to files its current loader actually reads. */
export async function resolveConfigViewFile(
	target: ConfigViewTarget,
	files: ConfigViewFiles,
): Promise<string | undefined> {
	let filePath: string | undefined;
	switch (target.kind) {
		case "settings":
			filePath = files.settings.getConfigFile(target.scope);
			break;
		case "models":
			filePath =
				target.section !== "overrides" ? files.settings.getConfigFile(target.scope) : files.models.getConfigFile();
			break;
		case "advisor":
		case "agent":
			filePath = target.filePath;
			break;
	}
	return filePath;
}

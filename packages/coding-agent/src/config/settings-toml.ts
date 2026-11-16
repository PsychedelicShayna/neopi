import { orderedSettings } from "./all-settings";
import { tomlValue } from "./toml-document";

export * from "@oh-my-pi/pi-utils/settings-toml";
export * from "./toml-document";

/** Registry defaults only: never export user values, environment overrides, or credentials. */
export function dumpSettingsToml(): string {
	const lines = [
		"# NeoPi settings defaults. Regenerate with: npi config dump-toml",
		"# Save as config.toml beside config.yml to opt in; settings.toml is the legacy filename.",
		"# Each top-level TOML key replaces the whole YAML key, including nested tables.",
		"# Unset defaults stay commented because TOML has no null or undefined value.",
		"",
	];
	for (const setting of orderedSettings()) {
		lines.push(`# ${setting.id} (${setting.type})`);
		if (setting.ui?.description) lines.push(...setting.ui.description.split("\n").map(line => `# ${line}`));
		const key = setting.segments.map(segment => JSON.stringify(segment)).join(".");
		const value = setting.default;
		lines.push(
			value === undefined || value === null ? `# ${key} is unset by default` : `${key} = ${tomlValue(value)}`,
			"",
		);
	}
	return `${lines.join("\n")}\n`;
}

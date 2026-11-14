import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfigViewFile, type ConfigViewFiles } from "../src/config/config-view-file";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createSettingsHost } from "../src/config/settings-ui";
import { createPluginSettingsHost } from "../src/extensibility/plugins/settings-host";

const root = path.join(os.homedir(), ".cache/npi-canary/config-view-tests");
const directories: string[] = [];
async function fixture(): Promise<{ dir: string; files: ConfigViewFiles }> {
	await fs.mkdir(root, { recursive: true });
	const dir = await fs.mkdtemp(path.join(root, "resolver-"));
	directories.push(dir);
	return {
		dir,
		files: {
			settings: { getConfigFile: scope => path.join(dir, scope === "project" ? "project" : "user", "config.yaml") },
			models: { getConfigFile: () => path.join(dir, "custom-models.yml") },
		},
	};
}

afterEach(async () => {
	resetSettingsForTest();
	for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

beforeAll(async () => {
	await initTheme(false);
});

describe("configuration view file mapping", () => {
	test("maps global/project settings and model sections to their real storage files", async () => {
		const { dir, files } = await fixture();
		expect(await resolveConfigViewFile({ kind: "settings" }, files)).toBe(path.join(dir, "user/config.yaml"));
		expect(await resolveConfigViewFile({ kind: "settings", scope: "project" }, files)).toBe(
			path.join(dir, "project/config.yaml"),
		);
		for (const section of ["roles", "effort", "context"] as const) {
			expect(await resolveConfigViewFile({ kind: "models", section, scope: "project" }, files)).toBe(
				path.join(dir, "project/config.yaml"),
			);
		}
		expect(await resolveConfigViewFile({ kind: "models", section: "overrides" }, files)).toBe(
			path.join(dir, "custom-models.yml"),
		);
	});

	test("selects canonical or legacy main settings TOML and ignores unsupported TOML families", async () => {
		const { dir, files } = await fixture();
		await Bun.write(path.join(dir, "user/settings.toml"), "");
		expect(await resolveConfigViewFile({ kind: "settings" }, files)).toBe(path.join(dir, "user/settings.toml"));
		await fs.rm(path.join(dir, "user/settings.toml"));
		await Bun.write(path.join(dir, "user/config.toml"), "");
		expect(await resolveConfigViewFile({ kind: "models", section: "roles" }, files)).toBe(
			path.join(dir, "user/config.toml"),
		);
		await Bun.write(path.join(dir, "custom-models.toml"), "");
		expect(await resolveConfigViewFile({ kind: "models", section: "overrides" }, files)).toBe(
			path.join(dir, "custom-models.yml"),
		);
		const watchdog = path.join(dir, "WATCHDOG.yaml");
		await Bun.write(path.join(dir, "WATCHDOG.toml"), "");
		expect(await resolveConfigViewFile({ kind: "advisor", filePath: watchdog }, files)).toBe(watchdog);
	});

	test("rejects simultaneous canonical and legacy main settings TOML", async () => {
		const { dir, files } = await fixture();
		await Bun.write(path.join(dir, "user/settings.toml"), "");
		await Bun.write(path.join(dir, "user/config.toml"), "");
		await expect(resolveConfigViewFile({ kind: "settings" }, files)).rejects.toThrow("Conflicting settings files");
	});

	test("preserves selected agent definitions and handles bundled agents without a source", async () => {
		const { dir, files } = await fixture();
		const agent = path.join(dir, "agents/reviewer.md");
		expect(await resolveConfigViewFile({ kind: "agent", filePath: agent }, files)).toBe(agent);
		expect(await resolveConfigViewFile({ kind: "agent" }, files)).toBeUndefined();
		expect(await Bun.file(agent).exists()).toBe(false);
	});

	test("real Settings.init works without any external-editor configuration", async () => {
		const { dir, files } = await fixture();
		const settings = await Settings.init({ agentDir: path.join(dir, "agent"), cwd: dir });
		expect(await resolveConfigViewFile({ kind: "settings" }, { ...files, settings })).toBe(settings.getConfigFile());
		expect(await Bun.file(path.join(dir, "agent/config.toml")).exists()).toBe(false);
	});
});

for (const scope of ["global", "project"] as const) {
	for (const toml of [undefined, "settings.toml", "config.toml"] as const) {
		test(`Ctrl-G edits the loaded ${scope} ${toml ?? "YAML file"} and refreshes the view`, async () => {
			const { dir, files } = await fixture();
			const agentDir = path.join(dir, "agent");
			const cwd = path.join(dir, "project");
			await fs.mkdir(cwd, { recursive: true });
			const configDir = scope === "global" ? agentDir : path.join(cwd, ".omp");
			const yamlPath = path.join(configDir, "config.yml");
			const tomlPath = path.join(configDir, toml ?? "config.toml");
			await Bun.write(yamlPath, "colorBlindMode: false\n");
			if (toml) await Bun.write(tomlPath, "colorBlindMode = false\n");
			const settings = await Settings.loadIsolated({ cwd, agentDir });
			const rendered = Promise.withResolvers<void>();
			let selectedPath: string | undefined;
			const view = new SettingsSelectorComponent(
				{
					settings: createSettingsHost(settings, scope),
					plugins: createPluginSettingsHost(cwd),
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["dark"],
					providers: [],
					requestRender: () => rendered.resolve(),
				},
				{
					onChange: () => {},
					onCancel: () => {},
					onOpenConfigFile: async () => {
						selectedPath = await resolveConfigViewFile({ kind: "settings", scope }, { ...files, settings });
						if (!selectedPath) throw new Error("Missing settings file");
						await Bun.write(
							selectedPath,
							selectedPath.endsWith(".toml") ? "colorBlindMode = true\n" : "colorBlindMode: true\n",
						);
						await settings.reloadFromDisk();
					},
				},
			);
			const displayedSwitch = () => {
				const props = view.describe({
					cols: 120,
					dark: true,
					reduceMotion: false,
					supports: () => true,
					feature: () => true,
				}).p as TspPrefsProps;
				return props.sections.flatMap(section => section.rows).find(row => row.id === "colorBlindMode")?.control;
			};
			expect(displayedSwitch()).toMatchObject({ k: "switch", on: false });
			view.handleInput("\x07");
			await rendered.promise;
			expect(selectedPath).toBe(toml ? tomlPath : yamlPath);
			expect(displayedSwitch()).toMatchObject({ k: "switch", on: true });
		});
	}
}

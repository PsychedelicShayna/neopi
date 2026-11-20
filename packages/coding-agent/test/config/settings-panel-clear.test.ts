import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { parseSettingsToml } from "@oh-my-pi/pi-coding-agent/config/settings-toml";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

import { cfgTaskPerCallModelAllow } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgSearxngEndpoint } from "@oh-my-pi/pi-coding-agent/web/settings";

let state: SettingsTestState | undefined;
let tempDir: TempDir;
let agentDir: string;
let projectDir: string;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	state = beginSettingsTest();
	tempDir = TempDir.createSync("@pi-settings-panel-clear-");
	agentDir = tempDir.join("agent");
	projectDir = tempDir.join("project");
	for (const dir of [agentDir, projectDir]) fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	restoreSettingsTestState(state);
	state = undefined;
	AgentStorage.close();
	tempDir.removeSync();
});

it.each(["yaml", "toml"])(
	"clearing a settings-panel text field persists in %s so its env fallback applies again",
	async format => {
		Bun.env.SEARXNG_ENDPOINT = "https://env.example";
		Bun.env.HINDSIGHT_API_TOKEN = "env-secret";
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, YAML.stringify({ searxng: { endpoint: "https://cfg.example" }, temperature: 0.4 }));
		const yaml = await Bun.file(configPath).text();
		const tomlPath = path.join(agentDir, "config.toml");
		if (format === "toml") await Bun.write(tomlPath, "# user preferences\n");
		await Settings.init({ cwd: projectDir, agentDir });
		const host = createSettingsHost();
		// The panel edits the configured layers: env values are never shown or pre-filled.
		expect(host.get("hindsight.apiToken")).toBeUndefined();

		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				providers: [],
				settings: host,
				plugins: createPluginSettingsHost(projectDir),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);

		selector.handleInput("/");
		for (const ch of "searxng endpoint") selector.handleInput(ch);
		selector.handleInput("\n"); // confirm search
		selector.handleInput("\n"); // open the text field
		selector.handleInput("\x15"); // clear it
		selector.handleInput("\n"); // submit

		expect(cfgSearxngEndpoint.get(settings)).toBe("https://env.example");
		await settings.flush();
		if (format === "yaml") expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ temperature: 0.4 });
		else {
			expect(await Bun.file(configPath).text()).toBe(yaml);
			expect(parseSettingsToml(await Bun.file(tomlPath).text()).searxng).toBeNull();
		}
		await settings.reloadFromDisk();
		expect(cfgSearxngEndpoint.get(settings)).toBe("https://env.example");
	},
);

it("hides a scoped project's per-call allowlist editor even when the global singleton belongs to another project", async () => {
	const projectConfig = path.join(getProjectAgentDir(projectDir), "settings.json");
	fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
	await Bun.write(projectConfig, JSON.stringify({ task: { perCallModelAllow: ["mock/target"] } }));
	await Settings.init({ cwd: tempDir.join("other-project"), agentDir });
	const scope = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
	expect(cfgTaskPerCallModelAllow.provenance(scope)).toBe("project");
	expect(cfgTaskPerCallModelAllow.provenance(Settings.instance)).not.toBe("project");
	const entry = createSettingsHost(scope).entries.find(candidate => candidate.path === "task.perCallModelAllow");
	expect(entry?.condition?.()).toBe(false);
});

it("keeps the per-call allowlist editor when only the global layer supplies it", async () => {
	await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ task: { perCallModelAllow: ["mock/target"] } }));
	const scope = await Settings.init({ cwd: projectDir, agentDir });
	const entry = createSettingsHost(scope).entries.find(candidate => candidate.path === "task.perCallModelAllow");
	expect(entry?.condition?.()).toBe(true);
});

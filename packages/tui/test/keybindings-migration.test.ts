import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { matchesAppFollowUp } from "@oh-my-pi/pi-tui/keybinding-matchers";
import { type KeybindingsConfig, setKeybindings } from "@oh-my-pi/pi-tui";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getProfileRootDir,
	removeWithRetries,
	setProfile,
} from "@oh-my-pi/pi-utils";
import { parseSettingsToml, stringifySettingsToml } from "@oh-my-pi/pi-utils/settings-toml";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}

async function writeKeybindingsToml(agentDir: string, config: KeybindingsConfig): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(agentDir, "keybindings.toml"), stringifySettingsToml(config));
}

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}
describe("KeybindingsManager.create", () => {
	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("migrates legacy keybinding JSON to TOML during create", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const jsonPath = path.join(agentDir, "keybindings.json");
		const tomlPath = path.join(agentDir, "keybindings.toml");

		await Bun.write(
			jsonPath,
			`${JSON.stringify(
				{
					fork: "ctrl+f",
					selectConfirm: "enter",
					cursorUp: "ctrl+p",
					selectModelTemporary: "alt+y",
				},
				null,
				2,
			)}\n`,
		);

		try {
			const manager = KeybindingsManager.create(agentDir);
			const writtenConfig = parseSettingsToml(await Bun.file(tomlPath).text());

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.select.confirm")).toEqual(["enter"]);
			expect(manager.getKeys("tui.editor.cursorUp")).toEqual(["ctrl+p"]);
			expect(manager.getKeys("app.model.selectTemporary")).toEqual(["alt+y"]);
			expect(writtenConfig).toEqual({
				"app.model.selectTemporary": "alt+y",
				"app.session.fork": "ctrl+f",
				"tui.editor.cursorUp": "ctrl+p",
				"tui.select.confirm": "enter",
			});
			expect(writtenConfig).not.toHaveProperty("selectModelTemporary");
			expect(await Bun.file(jsonPath).exists()).toBe(true);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("migrates legacy keybinding JSON with comments to TOML during create", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const jsonPath = path.join(agentDir, "keybindings.json");
		const tomlPath = path.join(agentDir, "keybindings.toml");

		await Bun.write(
			jsonPath,
			`{
	// Legacy config files may contain comments from hand-edited examples.
	"fork": "ctrl+f",
	"selectConfirm": "enter",
	"cursorUp": "ctrl+p",
	"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"]
}
`,
		);

		try {
			const manager = KeybindingsManager.create(agentDir);
			const writtenConfig = parseSettingsToml(await Bun.file(tomlPath).text());

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.select.confirm")).toEqual(["enter"]);
			expect(manager.getKeys("tui.editor.cursorUp")).toEqual(["ctrl+p"]);
			expect(manager.getKeys("app.clipboard.copyPrompt")).toEqual(["alt+c", "ctrl+shift+c"]);
			expect(writtenConfig).toEqual({
				"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"],
				"app.session.fork": "ctrl+f",
				"tui.editor.cursorUp": "ctrl+p",
				"tui.select.confirm": "enter",
			});
			expect(await Bun.file(jsonPath).exists()).toBe(true);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("loads keybindings.toml directly", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const configPath = path.join(agentDir, "keybindings.toml");

		await Bun.write(
			configPath,
			stringifySettingsToml({
				"app.session.fork": "ctrl+f",
				"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"],
			}),
		);

		try {
			const manager = KeybindingsManager.create(agentDir);

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("app.clipboard.copyPrompt")).toEqual(["alt+c", "ctrl+shift+c"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("imports keybindings.yaml once without changing the legacy source", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const yamlPath = path.join(agentDir, "keybindings.yaml");
		const canonicalPath = path.join(agentDir, "keybindings.toml");

		const legacySource = '"app.plan.toggle": alt+shift+p\n';
		await Bun.write(yamlPath, legacySource);

		try {
			const manager = KeybindingsManager.create(agentDir);

			expect(manager.getKeys("app.plan.toggle")).toEqual(["alt+shift+p"]);
			expect(parseSettingsToml(await Bun.file(canonicalPath).text())).toEqual({
				"app.plan.toggle": "alt+shift+p",
			});
			expect(await Bun.file(yamlPath).text()).toBe(legacySource);
			await Bun.write(yamlPath, '"app.plan.toggle": ctrl+p\n');
			expect(KeybindingsManager.create(agentDir).getKeys("app.plan.toggle")).toEqual(["alt+shift+p"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("preserves native comments and persists only profile overrides", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-save-"));
		const defaultAgentDir = path.join(rootDir, "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");
		const profilePath = path.join(profileAgentDir, "keybindings.toml");
		await writeKeybindingsToml(defaultAgentDir, {
			"app.session.new": "ctrl+n",
			"app.session.fork": "ctrl+f",
		});
		await Bun.write(profilePath, '# profile notes\n"app.session.fork" = "alt+f" # keep this\n');

		try {
			const manager = KeybindingsManager.create(profileAgentDir, { inheritedAgentDir: defaultAgentDir });
			expect(manager.setPersisted("app.clipboard.copyLine", ["alt+l"])).toBe(true);
			const source = await Bun.file(profilePath).text();
			expect(source).toContain('# profile notes\n"app.session.fork" = "alt+f" # keep this\n');
			expect(parseSettingsToml(source)).toEqual({
				"app.session.fork": "alt+f",
				"app.clipboard.copyLine": ["alt+l"],
			});
			expect(manager.getKeys("app.session.new")).toEqual(["ctrl+n"]);
			expect(manager.getKeys("app.clipboard.copyLine")).toEqual(["alt+l"]);
		} finally {
			await removeWithRetries(rootDir);
		}
	});

	it("inherits default user keybindings for a named profile without a profile keybindings file (#4867)", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		await writeKeybindingsToml(defaultAgentDir, {
			"app.session.fork": "ctrl+f",
			"tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
		});

		try {
			const manager = KeybindingsManager.create(profileAgentDir, { inheritedAgentDir: defaultAgentDir });

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.editor.deleteCharBackward")).toEqual(["backspace", "ctrl+h"]);
		} finally {
			await removeWithRetries(rootDir);
		}
	});

	it("merges default user keybindings with profile overrides for a named profile (#4867)", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		await writeKeybindingsToml(defaultAgentDir, {
			"app.session.fork": "ctrl+f",
			"app.session.new": "ctrl+n",
		});
		await writeKeybindingsToml(profileAgentDir, {
			"app.session.fork": "alt+f",
			"app.clipboard.copyLine": "alt+l",
		});

		try {
			const manager = KeybindingsManager.create(profileAgentDir, { inheritedAgentDir: defaultAgentDir });

			expect(manager.getKeys("app.session.new")).toEqual(["ctrl+n"]);
			expect(manager.getKeys("app.session.fork")).toEqual(["alt+f"]);
			expect(manager.getKeys("app.clipboard.copyLine")).toEqual(["alt+l"]);
		} finally {
			await removeWithRetries(rootDir);
		}
	});

	it("never writes migration output into the inherited default agent dir (#4867)", async () => {
		const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-profile-"));
		const defaultAgentDir = path.join(rootDir, "default", "agent");
		const profileAgentDir = path.join(rootDir, "profiles", "work", "agent");

		// Legacy JSON in the default dir: loading it with a write-back path would
		// materialize keybindings.toml there. The inherited load must stay read-only.
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await Bun.write(
			path.join(defaultAgentDir, "keybindings.json"),
			JSON.stringify({ "app.session.fork": "ctrl+f" }, null, 2),
		);

		try {
			const manager = KeybindingsManager.create(profileAgentDir, { inheritedAgentDir: defaultAgentDir });

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(await Bun.file(path.join(defaultAgentDir, "keybindings.toml")).exists()).toBe(false);
		} finally {
			await removeWithRetries(rootDir);
		}
	});

	it("merges default user keybindings when create uses the active profile with no arguments (#4867)", async () => {
		const originalConfigDir = process.env.PI_CONFIG_DIR;
		const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		const originalOmpProfile = process.env.OMP_PROFILE;
		const originalPiProfile = process.env.PI_PROFILE;
		const configRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-active-profile-"));

		try {
			process.env.PI_CONFIG_DIR = path.relative(os.homedir(), configRootDir);
			restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
			restoreEnvValue("OMP_PROFILE", originalOmpProfile);
			restoreEnvValue("PI_PROFILE", originalPiProfile);
			__resetDirsFromEnvForTests();

			const defaultAgentDir = path.join(getProfileRootDir(undefined), "agent");
			const profileAgentDir = path.join(getProfileRootDir("work"), "agent");
			await writeKeybindingsToml(defaultAgentDir, {
				"app.session.fork": "ctrl+f",
				"app.session.new": "ctrl+n",
			});
			await writeKeybindingsToml(profileAgentDir, {
				"app.session.fork": "alt+f",
				"app.clipboard.copyLine": "alt+l",
			});

			setProfile("work");

			expect(getAgentDir()).toBe(profileAgentDir);
			const manager = KeybindingsManager.create();

			expect(manager.getKeys("app.session.new")).toEqual(["ctrl+n"]);
			expect(manager.getKeys("app.session.fork")).toEqual(["alt+f"]);
			expect(manager.getKeys("app.clipboard.copyLine")).toEqual(["alt+l"]);
		} finally {
			restoreEnvValue("PI_CONFIG_DIR", originalConfigDir);
			restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
			restoreEnvValue("OMP_PROFILE", originalOmpProfile);
			restoreEnvValue("PI_PROFILE", originalPiProfile);
			__resetDirsFromEnvForTests();
			await removeWithRetries(configRootDir);
		}
	});

	it("keeps the Ctrl+L live toggle default when an old model remap still claims Ctrl+L", () => {
		const manager = KeybindingsManager.inMemory({
			"app.model.select": "ctrl+l",
		});

		expect(manager.getKeys("app.model.select")).toEqual(["ctrl+l"]);
		expect(manager.getKeys("app.live.toggle")).toEqual(["ctrl+l"]);
		expect(manager.getEffectiveConfig()["app.live.toggle"]).toBe("ctrl+l");
	});

	it("keeps Ctrl+L when the user explicitly assigns it to display reset", () => {
		const manager = KeybindingsManager.inMemory({
			"app.display.reset": "ctrl+l",
		});

		expect(manager.getKeys("app.display.reset")).toEqual(["ctrl+l"]);
	});

	it("removes the Ctrl+Q follow-up default when a user remap already claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"app.plan.toggle": "ctrl+q",
		});
		setKeybindings(manager);

		expect(manager.getKeys("app.plan.toggle")).toEqual(["ctrl+q"]);
		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+enter"]);
		expect(manager.getEffectiveConfig()["app.message.followUp"]).toBe("ctrl+enter");
		expect(matchesAppFollowUp(ctrl("q"))).toBe(false);
		expect(matchesAppFollowUp("\x1b[13;5u")).toBe(true);
	});

	it("keeps the Ctrl+Q follow-up default when only an unknown config key claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"unknown.action": "ctrl+q",
		});

		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q", "ctrl+enter"]);
	});

	it("keeps Ctrl+Q when the user explicitly assigns it to follow-up (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"app.message.followUp": "ctrl+q",
		});

		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q"]);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { createSettingsHost } from "../src/config/settings-ui";
import { cfgSettingsDefaultScope, cfgAutoResume } from "../src/modes/settings";
import { cfgModelRoles } from "../src/config/model-settings";
import { SESSION_SETTINGS_QUIT_CHOICES, settleSessionSettingsOnQuit } from "../src/config/session-settings-quit";

let root: string;
beforeEach(async () => {
	root = `/mnt/alias/m2/agents/scratch/scoped-settings/test-${crypto.randomUUID()}`;
	await fs.mkdir(root, { recursive: true });
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function sessionSettings(cwd = path.join(root, "project")): Promise<Settings> {
	await fs.mkdir(cwd, { recursive: true });
	const settings = await Settings.loadReadOnly({ cwd, agentDir: path.join(root, "profile") });
	await settings.attachSessionFile(path.join(root, "sessions", "conversation.jsonl"));
	return settings;
}

describe("settings scopes", () => {
	it("session wins project and global and clear reveals the next scope", async () => {
		const settings = Settings.isolated();
		settings.writeScopeValue(cfgSettingsDefaultScope, "global", "global");
		settings.writeScopeValue(cfgSettingsDefaultScope, "project", "project");
		settings.writeScopeValue(cfgSettingsDefaultScope, "session", "session");
		expect(cfgSettingsDefaultScope.get(settings)).toBe("session");
		await settings.clearScope("session");
		expect(cfgSettingsDefaultScope.get(settings)).toBe("project");
		await settings.clearScope("project");
		expect(cfgSettingsDefaultScope.get(settings)).toBe("global");
	});

	it("keeps session overrides while reloading another working directory", async () => {
		const settings = Settings.isolated();
		settings.writeScopeValue(cfgAutoResume, true, "session");
		await settings.reloadForCwd(path.join(root, "elsewhere"));
		expect(cfgAutoResume.get(settings)).toBe(true);
		expect(cfgAutoResume.provenance(settings)).toBe("session");
	});

	it("persists beside the session and resumes from a different cwd", async () => {
		const first = await sessionSettings();
		first.writeScopeValue(cfgAutoResume, true, "session");
		await first.saveSessionSettings();
		const resumed = await sessionSettings(path.join(root, "elsewhere"));
		expect(cfgAutoResume.get(resumed)).toBe(true);
		expect(cfgAutoResume.provenance(resumed)).toBe("session");
		await resumed.clearScope("session");
		const cleared = await sessionSettings();
		expect(cfgAutoResume.get(cleared)).toBe(false);
	});

	it("edits the selected layer while shadow details retain all three values", () => {
		const settings = Settings.isolated();
		settings.writeScopeValue(cfgSettingsDefaultScope, "project", "project");
		settings.writeScopeValue(cfgSettingsDefaultScope, "session", "session");
		const host = createSettingsHost(settings, "global");
		host.set("settings.defaultScope", "global");
		expect(cfgSettingsDefaultScope.get(settings)).toBe("session");
		expect(settings.getScopeDetails(cfgSettingsDefaultScope, "global")).toEqual({
			global: "global",
			project: "project",
			session: "session",
			effective: "session",
			winner: "session",
			shadowed: true,
		});
		expect(host.details?.("settings.defaultScope").description).toContain("Shadowed by session");
		host.cycleScope?.();
		expect(host.scope).toBe("project");
		host.cycleScope?.();
		expect(host.scope).toBe("session");
		host.cycleScope?.();
		expect(host.scope).toBe("global");
	});

	it("model role writes to lower scopes do not override a session selection", () => {
		const settings = Settings.isolated();
		settings.setRoleModelAndEffort("default", "openai/session", undefined, "session");
		settings.setRoleModelAndEffort("default", "openai/project", undefined, "project");
		settings.setRoleModelAndEffort("default", "openai/global", undefined, "global");
		expect(settings.getModelRole("default")).toBe("openai/session");
		expect(settings.getModelRoleProvenance("default")).toBe("session");
		expect(settings.readScopeValue(cfgModelRoles, "project")).toEqual({ default: "openai/project" });
	});
});

describe("session settings quit prompt", () => {
	it("Escape keeps session settings and permits quitting; cancel leaves them dirty", async () => {
		const settings = await sessionSettings();
		settings.writeScopeValue(cfgAutoResume, true, "session");
		let choices: readonly string[] = [];
		let ensured = false;
		expect(
			await settleSessionSettingsOnQuit(
				settings,
				async options => {
					choices = options;
					return undefined;
				},
				async () => {
					ensured = true;
				},
			),
		).toBe(true);
		expect(choices).toEqual(SESSION_SETTINGS_QUIT_CHOICES);
		expect(ensured).toBe(true);
		expect(cfgAutoResume.get(await sessionSettings())).toBe(true);
		settings.writeScopeValue(cfgAutoResume, false, "session");
		expect(
			await settleSessionSettingsOnQuit(
				settings,
				async () => SESSION_SETTINGS_QUIT_CHOICES[3],
				async () => {},
			),
		).toBe(false);
		expect(settings.hasUnsavedSessionSettings).toBe(true);
	});

	it("project saves to the current project and discard removes session overrides", async () => {
		const settings = await sessionSettings();
		settings.writeScopeValue(cfgAutoResume, true, "session");
		expect(
			await settleSessionSettingsOnQuit(
				settings,
				async () => SESSION_SETTINGS_QUIT_CHOICES[1],
				async () => {},
			),
		).toBe(true);
		expect(settings.readScopeValue(cfgAutoResume, "project")).toBe(true);
		expect(settings.readScopeValue(cfgAutoResume, "session")).toBeUndefined();
		settings.writeScopeValue(cfgAutoResume, false, "session");
		expect(
			await settleSessionSettingsOnQuit(
				settings,
				async () => SESSION_SETTINGS_QUIT_CHOICES[2],
				async () => {},
			),
		).toBe(true);
		expect(settings.readScopeValue(cfgAutoResume, "session")).toBeUndefined();
	});
});

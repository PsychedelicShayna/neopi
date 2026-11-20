import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectAgentDir, logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { createSettingsHost } from "../src/config/settings-ui";
import { cfgAutoResume, cfgColorBlindMode, cfgSettingsDefaultScope } from "../src/modes/settings";
import { cfgModelRoles } from "../src/config/model-settings";
import { SESSION_SETTINGS_QUIT_CHOICES, settleSessionSettingsOnQuit } from "../src/config/session-settings-quit";
import { cfgHindsightApiToken } from "../src/hindsight/settings";
import { cfgProvidersMaxInFlightRequests } from "../src/session/settings";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "npi-scoped-settings-"));
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
	it("loads a settings file created after the session was attached, even when runtime shadows it", async () => {
		const settings = await sessionSettings();
		cfgColorBlindMode.override(settings, false);
		await Bun.write(path.join(root, "sessions", "conversation", "settings.yml"), "colorBlindMode: true\n");

		await settings.recheckSettingsFiles();

		expect(settings.resolveFileScopeValue(cfgColorBlindMode, "session")).toEqual({ value: true, source: "session" });
	});

	it("keeps an external edit when saving a dirty session with an unset setting", async () => {
		const sidecar = path.join(root, "sessions", "conversation", "settings.yml");
		await Bun.write(sidecar, "autoResume: true\ncolorBlindMode: false\n");
		const settings = await sessionSettings();
		settings.writeScopeValue(cfgAutoResume, undefined, "session");
		await Bun.write(sidecar, "autoResume: true\ncolorBlindMode: true\n");

		const warnings = spyOn(logger, "warn");
		try {
			await settings.recheckSettingsFiles();
			await settings.recheckSettingsFiles();
			expect(warnings.mock.calls.filter(([message]) => message.includes("session file changed"))).toHaveLength(1);
			expect(settings.hasUnsavedSessionSettings).toBe(true);
			expect(settings.readScopeValue(cfgAutoResume, "session")).toBeUndefined();
			expect(settings.readScopeValue(cfgColorBlindMode, "session")).toBe(false);
			expect(await Bun.file(sidecar).text()).toBe("autoResume: true\ncolorBlindMode: true\n");
		} finally {
			warnings.mockRestore();
		}
		await settings.saveSessionSettings();

		const resumed = await sessionSettings();
		expect(resumed.readScopeValue(cfgAutoResume, "session")).toBeUndefined();
		expect(resumed.resolveFileScopeValue(cfgColorBlindMode, "session")).toEqual({ value: true, source: "session" });
	});

	it("refuses to overwrite a session setting edited differently on disk and in memory", async () => {
		const sidecar = path.join(root, "sessions", "conversation", "settings.yml");
		await Bun.write(sidecar, "settings:\n  defaultScope: global\n");
		const settings = await sessionSettings();
		settings.writeScopeValue(cfgSettingsDefaultScope, "session", "session");
		const external = "settings:\n  defaultScope: project\n";
		await Bun.write(sidecar, external);

		await expect(settings.saveSessionSettings()).rejects.toThrow("changed both on disk and in memory");
		expect(settings.hasUnsavedSessionSettings).toBe(true);
		expect(settings.readScopeValue(cfgSettingsDefaultScope, "session")).toBe("session");
		expect(await Bun.file(sidecar).text()).toBe(external);
	});

	it("applies external session edits and inherits after the sidecar is deleted", async () => {
		const sidecar = path.join(root, "sessions", "conversation", "settings.yml");
		await Bun.write(sidecar, "colorBlindMode: false\n");
		const settings = await sessionSettings();
		const changes: boolean[] = [];
		const stop = settings.onEffectiveChange([cfgColorBlindMode], () => changes.push(cfgColorBlindMode.get(settings)));
		try {
			await Bun.write(sidecar, "colorBlindMode: true\n");
			await settings.recheckSettingsFiles();
			expect(settings.resolveFileScopeValue(cfgColorBlindMode, "session")).toEqual({
				value: true,
				source: "session",
			});

			await fs.rm(sidecar);
			await settings.recheckSettingsFiles();
			expect(settings.resolveFileScopeValue(cfgColorBlindMode, "session")).toEqual({
				value: false,
				source: undefined,
			});
			expect(changes).toEqual([true, false]);
		} finally {
			stop();
		}
	});

	it("does not open unchanged settings files for another content read", async () => {
		const cwd = path.join(root, "project");
		await Bun.write(path.join(root, "profile", "config.yml"), "colorBlindMode: false\n");
		await Bun.write(path.join(getProjectAgentDir(cwd), "config.yml"), "autoResume: true\n");
		await Bun.write(path.join(root, "sessions", "conversation", "settings.yml"), "colorBlindMode: true\n");
		const settings = await sessionSettings(cwd);
		const open = spyOn(Bun, "file");
		const read = spyOn(fs, "readFile");
		try {
			await settings.recheckSettingsFiles();
			expect(open).not.toHaveBeenCalled();
			expect(read).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
			read.mockRestore();
		}
	});

	it("applies external global edits and project creation and deletion", async () => {
		const cwd = path.join(root, "project");
		const config = path.join(root, "profile", "config.yml");
		const project = path.join(getProjectAgentDir(cwd), "config.yml");
		await Bun.write(config, "colorBlindMode: false\n");
		const settings = await sessionSettings(cwd);

		await Bun.write(config, "colorBlindMode: true\n");
		await settings.recheckSettingsFiles();
		expect(settings.resolveFileScopeValue(cfgColorBlindMode, "global")).toEqual({ value: true, source: "global" });

		await Bun.write(project, "colorBlindMode: false\n");
		await settings.recheckSettingsFiles();
		expect(settings.resolveFileScopeValue(cfgColorBlindMode, "project")).toEqual({ value: false, source: "project" });

		await fs.rm(project);
		await settings.recheckSettingsFiles();
		expect(settings.resolveFileScopeValue(cfgColorBlindMode, "project")).toEqual({ value: true, source: "global" });
	});

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

	it("keeps external sidecar changes and flushed session edits across a later save", async () => {
		const settings = await sessionSettings();
		const sidecar = path.join(root, "sessions", "conversation", "settings.yml");
		settings.writeScopeValue(cfgAutoResume, true, "session");
		expect(settings.hasUnsavedSessionSettings).toBe(true);
		await settings.saveSessionSettings();

		const persisted = await Bun.file(sidecar).text();
		await Bun.write(sidecar, `${persisted.trimEnd()}\ncolorBlindMode: true\n`);
		const changes: boolean[] = [];
		const stop = settings.onEffectiveChange([cfgColorBlindMode], () => changes.push(cfgColorBlindMode.get(settings)));
		try {
			await settings.reloadSessionSettings();
			expect(settings.resolveFileScopeValue(cfgAutoResume, "session")).toEqual({ value: true, source: "session" });
			expect(settings.resolveFileScopeValue(cfgColorBlindMode, "session")).toEqual({
				value: true,
				source: "session",
			});
			expect(changes).toEqual([true]);
			expect(settings.hasUnsavedSessionSettings).toBe(false);
		} finally {
			stop();
		}

		settings.writeScopeValue(cfgSettingsDefaultScope, "project", "session");
		await settings.saveSessionSettings();
		const resumed = await sessionSettings();
		expect(resumed.resolveFileScopeValue(cfgAutoResume, "session")).toEqual({ value: true, source: "session" });
		expect(resumed.resolveFileScopeValue(cfgColorBlindMode, "session")).toEqual({ value: true, source: "session" });
	});

	it("leaves the session layer unchanged when an external sidecar edit fails validation", async () => {
		const settings = await sessionSettings();
		const sidecar = path.join(root, "sessions", "conversation", "settings.yml");
		settings.writeScopeValue(cfgAutoResume, true, "session");
		await settings.saveSessionSettings();
		await Bun.write(sidecar, "autoResume: false\nnotASetting: true\n");

		await expect(settings.reloadSessionSettings()).rejects.toThrow('Unknown setting "notASetting"');
		expect(settings.resolveFileScopeValue(cfgAutoResume, "session")).toEqual({ value: true, source: "session" });
		expect(settings.hasUnsavedSessionSettings).toBe(false);
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

	it("resolves file values only through the selected scope, even when a runtime value wins", () => {
		const setting = cfgSettingsDefaultScope;
		const settings = Settings.isolated();
		const view = settings.overlay({ [setting.id]: "project" });
		const host = createSettingsHost(view, "project");
		expect(setting.get(view)).toBe("project");
		expect(host.resolve?.(setting.id)).toEqual({ value: "session", source: undefined });

		settings.writeScopeValue(setting, "global", "global");
		settings.writeScopeValue(setting, "session", "session");
		expect(host.resolve?.(setting.id)).toEqual({ value: "global", source: "global" });
		expect(host.get(setting.id)).toBe("global");

		host.cycleScope?.();
		expect(host.resolve?.(setting.id)).toEqual({ value: "session", source: "session" });
		expect(host.get(setting.id)).toBe("session");
	});

	it("never resolves a credential from its environment variable", () => {
		const previous = Bun.env.HINDSIGHT_API_TOKEN;
		try {
			Bun.env.HINDSIGHT_API_TOKEN = "env-only-test-token";
			const settings = Settings.isolated();
			const host = createSettingsHost(settings, "session");
			expect(cfgHindsightApiToken.get(settings)).toBe("env-only-test-token");
			expect(host.resolve?.(cfgHindsightApiToken.id)).toEqual({ value: undefined, source: undefined });
			expect(host.get(cfgHindsightApiToken.id)).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.HINDSIGHT_API_TOKEN;
			else Bun.env.HINDSIGHT_API_TOKEN = previous;
		}
	});

	it("ignores explicit config overlays when resolving a file scope", async () => {
		const setting = cfgSettingsDefaultScope;
		const cwd = path.join(root, "project");
		const overlay = path.join(root, "overlay.yml");
		await fs.mkdir(cwd);
		await Bun.write(overlay, "settings:\n  defaultScope: project\n");
		const settings = await Settings.loadReadOnly({
			cwd,
			agentDir: path.join(root, "profile"),
			configFiles: [overlay],
		});
		settings.writeScopeValue(setting, "global", "global");
		const host = createSettingsHost(settings, "session");
		expect(setting.provenance(settings)).toBe("overlay");
		expect(host.resolve?.(setting.id)).toEqual({ value: "global", source: "global" });
	});

	it("merges provider limits while exposing only the project map for edits", () => {
		const setting = cfgProvidersMaxInFlightRequests;
		const settings = Settings.isolated();
		settings.writeScopeValue(setting, { a: 2 }, "global");
		settings.writeScopeValue(setting, { b: 3 }, "project");
		const host = createSettingsHost(settings, "project");
		expect(host.resolve?.(setting.id)).toEqual({ value: { a: 2, b: 3 }, source: "project" });
		expect(host.own?.(setting.id)).toEqual({ b: 3 });

		host.set(setting.id, { b: 4 });
		settings.writeScopeValue(setting, { a: 5 }, "global");
		expect(host.own?.(setting.id)).toEqual({ b: 4 });
		expect(host.resolve?.(setting.id)).toEqual({ value: { a: 5, b: 4 }, source: "project" });

		host.unset(setting.id);
		expect(host.own?.(setting.id)).toBeUndefined();
		expect(host.resolve?.(setting.id)).toEqual({ value: { a: 5 }, source: "global" });
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

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import {
	cfgAdvisorActivation,
	cfgAdvisorActivationSet,
	cfgAdvisorEnabled,
} from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgRoleSettings } from "@oh-my-pi/pi-coding-agent/config/role-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const roster: AdvisorConfig[] = [
	{ id: "shared-id", name: "Shared", sourceScope: "user" },
	{ id: "old-id", name: "Old", sourceScope: "user" },
	{ id: "new-id", name: "New", sourceScope: "user", enabled: false },
	{ id: "project-id", name: "Project", sourceScope: "project" },
];

describe("role-bound advisor activation", () => {
	let state: SettingsTestState;
	let directory: string;
	let auth: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-activation-"));
		await fs.mkdir(path.join(directory, ".git"));
		await fs.mkdir(path.join(directory, "agent"));
		setAgentDir(path.join(directory, "agent"));
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		auth.close();
		restoreSettingsTestState(state);
		await fs.rm(directory, { recursive: true, force: true });
	});

	function start(settings: Settings, configs: AdvisorConfig[] | undefined = roster): AgentSession {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled advisor fixture model");
		settings.setModelRole("advisor", "openai/gpt-4o-mini");
		const manager = SessionManager.inMemory(directory);
		const role = settings.activeRole;
		if (role !== undefined) {
			settings.setModelRole(role, "openai/gpt-4o-mini");
			manager.appendModelChange("openai/gpt-4o-mini", role);
		}
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			settings,
			sessionManager: manager,
			modelRegistry: new ModelRegistry(auth, path.join(directory, "models.yml")),
			advisorConfigs: configs,
			advisorTools: [],
		});
		return session;
	}

	it("keeps shared runtimes while stopping old-only and starting disabled new-only advisors", async () => {
		const settings = Settings.isolated({ "advisor.enabled": true });
		settings.setRoleSetting("before", cfgAdvisorActivationSet, ["shared-id", "old-id"]);
		settings.setRoleSetting("after", cfgAdvisorActivationSet, ["shared-id", "new-id"]);
		settings.setActiveRole("before");
		const active = start(settings);
		const [shared, old] = active.liveAdvisors();
		const sharedAbort = vi.spyOn(shared.agent, "abort");
		const oldAbort = vi.spyOn(old.agent, "abort");

		await active.applyRoleModel({ role: "after", model: active.model!, explicitThinkingLevel: false });
		await Promise.resolve();
		expect(active.liveAdvisors().map(advisor => advisor.name)).toEqual(["Shared", "New"]);
		expect(active.liveAdvisors()[0].agent).toBe(shared.agent);
		expect(sharedAbort).not.toHaveBeenCalled();
		expect(oldAbort).toHaveBeenCalledWith("advisor disposed");
		expect(active.formatAdvisorStatus()).toContain('Role "after": user-scoped activation set replaces enabled flags');
		expect(active.formatAdvisorHistoryAsText()).toContain(
			"global switch > role activation set > per-advisor enabled flags",
		);
		expect(active.formatAdvisorStatus()).not.toContain("new-id");
	});

	it("uses legacy enabled flags without a set, and restores them when leaving an explicit set", async () => {
		const settings = Settings.isolated({ "advisor.enabled": true });
		const active = start(settings);
		expect(active.liveAdvisors().map(advisor => advisor.name)).toEqual(["Shared", "Old", "Project"]);
		settings.setRoleSetting("quiet", cfgAdvisorActivationSet, []);
		settings.setActiveRole("quiet");
		await Promise.resolve();
		expect(active.isAdvisorActive()).toBe(false);
		settings.setActiveRole("legacy");
		await Promise.resolve();
		expect(active.liveAdvisors().map(advisor => advisor.name)).toEqual(["Shared", "Old", "Project"]);
		expect(active.formatAdvisorStatus()).toContain("no activation set, using per-advisor enabled flags");
	});

	it("does not create a default advisor for an explicitly empty set without a roster", async () => {
		const settings = Settings.isolated({ "advisor.enabled": true });
		settings.setRoleSetting("quiet", cfgAdvisorActivationSet, []);
		settings.setActiveRole("quiet");
		const active = start(settings, []);
		// No files means the legacy default is available after clearing the role set.
		active.applyAdvisorConfigs(undefined, undefined);
		expect(active.isAdvisorActive()).toBe(false);
		expect(active.getAdvisorStatusOverview().advisors).toEqual([]);
		expect(active.formatAdvisorStatus()).toContain("Selected advisors: none");
		settings.setRoleSetting("quiet", cfgAdvisorActivationSet, null);
		await Promise.resolve();
		expect(active.isAdvisorActive()).toBe(true);
		expect(active.liveAdvisors().map(advisor => advisor.name)).toEqual(["default"]);
	});

	it("warns and skips dangling and out-of-scope references without showing IDs", async () => {
		const settings = Settings.isolated({ "advisor.enabled": true });
		const active = start(settings);
		const notice = vi.spyOn(active, "emitNotice");
		settings.setRoleSetting("restricted", cfgAdvisorActivationSet, ["shared-id", "project-id", "missing-secret-id"]);
		settings.setActiveRole("restricted");
		await Promise.resolve();
		expect(active.liveAdvisors().map(advisor => advisor.name)).toEqual(["Shared"]);
		expect(notice).toHaveBeenCalledWith(
			"warning",
			expect.stringContaining("skipped 2 missing or out-of-scope references"),
			undefined,
		);
		const warnings = notice.mock.calls.map(([, message]) => message).join("\n");
		expect(warnings).not.toContain("project-id");
		expect(warnings).not.toContain("missing-secret-id");
		expect(active.formatAdvisorStatus()).not.toContain("missing-secret-id");
	});

	it("applies project-visible sets and reconciles scope changes even with identical ID lists", async () => {
		const settings = Settings.isolated({ "advisor.enabled": true });
		settings.setRoleSetting("user", cfgAdvisorActivationSet, ["shared-id", "project-id"]);
		settings.writeProjectValue(cfgRoleSettings, {
			project: { "advisor.activationSet": ["shared-id", "project-id"] },
		});
		settings.setActiveRole("user");
		const active = start(settings);
		const shared = active.liveAdvisors()[0].agent;
		expect(active.liveAdvisors().map(advisor => advisor.name)).toEqual(["Shared"]);
		settings.setActiveRole("project");
		await Promise.resolve();
		expect(active.liveAdvisors().map(advisor => advisor.name)).toEqual(["Shared", "Project"]);
		expect(active.liveAdvisors()[0].agent).toBe(shared);
		settings.setActiveRole("user");
		await Promise.resolve();
		expect(active.liveAdvisors().map(advisor => advisor.name)).toEqual(["Shared"]);
		expect(active.liveAdvisors()[0].agent).toBe(shared);
	});

	it("keeps global off authoritative across role switches and settings changes", async () => {
		const settings = Settings.isolated({ "advisor.enabled": false });
		settings.setRoleSetting("selected", cfgAdvisorActivationSet, ["new-id"]);
		settings.setActiveRole("selected");
		const active = start(settings);
		expect(active.isAdvisorActive()).toBe(false);
		settings.setRoleSetting("selected", cfgAdvisorActivationSet, ["shared-id"]);
		await Promise.resolve();
		expect(active.isAdvisorActive()).toBe(false);
		expect(active.formatAdvisorStatus()).toContain("global advisor switch is off, so no advisors run");
		cfgAdvisorEnabled.override(settings, true);
		await Promise.resolve();
		expect(active.liveAdvisors().map(advisor => advisor.name)).toEqual(["Shared"]);
		cfgAdvisorEnabled.override(settings, false);
		await Promise.resolve();
		expect(active.isAdvisorActive()).toBe(false);
	});

	it("loads existing settings without the feature and persists nullable activation sets in their source layers", async () => {
		const agentDir = path.join(directory, "agent");
		await Bun.write(path.join(agentDir, "config.yml"), "advisor:\n  enabled: true\n");
		const settings = await Settings.init({ cwd: directory, agentDir });
		expect(cfgAdvisorActivationSet.get(settings)).toBeNull();
		expect(cfgAdvisorEnabled.get(settings)).toBe(true);
		expect(cfgAdvisorActivationSet.parse("null")).toBeNull();
		expect(cfgAdvisorActivationSet.parse("[]")).toEqual([]);
		expect(() => settings.setRoleSetting("invalid", cfgAdvisorActivationSet, [1] as unknown as string[])).toThrow(
			"list of advisor IDs",
		);
		settings.setRoleSetting("saved", cfgAdvisorActivationSet, ["shared-id"]);
		settings.writeProjectValue(cfgRoleSettings, { saved: { "advisor.activationSet": [] } });
		await settings.flush();
		const reloaded = await settings.cloneForCwd(directory);
		reloaded.setActiveRole("saved");
		expect(reloaded.getRoleSetting("saved", cfgAdvisorActivationSet)).toEqual([]);
		expect(reloaded.getRoleSettingSourceScope("saved", cfgAdvisorActivationSet)).toBe("project");
		expect(cfgAdvisorActivation.get(reloaded)).toMatchObject({ ids: [], role: "saved", scope: "project" });
		reloaded.writeProjectValue(cfgRoleSettings, { saved: { "advisor.activationSet": null } });
		expect(cfgAdvisorActivationSet.get(reloaded)).toBeNull();
		expect(reloaded.getRoleSettingSourceScope("saved", cfgAdvisorActivationSet)).toBeUndefined();
		reloaded.writeProjectValue(cfgRoleSettings, {});
		expect(reloaded.getRoleSetting("saved", cfgAdvisorActivationSet)).toEqual(["shared-id"]);
		expect(reloaded.overlay().getRoleSettingSourceScope("saved", cfgAdvisorActivationSet)).toBe("user");
	});
});

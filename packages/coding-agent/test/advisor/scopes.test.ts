import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	advisorRosterForRuntime,
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	saveWatchdogConfigFile,
	serializeWatchdogConfig,
} from "../../src/advisor/config";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { AgentStorage } from "../../src/session/agent-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let root: string;
let agentDir: string;
let cwd: string;
let state: SettingsTestState | undefined;

beforeEach(async () => {
	state = beginSettingsTest();
	const scratch = path.join(os.homedir(), ".cache", "npi-canary");
	await fs.mkdir(scratch, { recursive: true });
	root = await fs.mkdtemp(path.join(scratch, "advisor-scope-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "project", "nested");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(path.join(root, "project", ".git"));
});

afterEach(async () => {
	restoreSettingsTestState(state);
	state = undefined;
	AgentStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

describe("persisted advisor file scopes", () => {
	it("initializes real settings with advisor configuration absent and discovers no files", async () => {
		await Settings.init({ cwd, agentDir });
		const result = await discoverAdvisorConfigs(cwd, agentDir);
		expect(result.files).toEqual([]);
		expect(result.advisors).toEqual([]);
		expect(result.unsafeToReconcile).toBe(false);
		expect(advisorRosterForRuntime(result)).toBeUndefined();
	});

	it("keeps every file in load order while a disabled file contributes neither advisors nor shared configuration", async () => {
		const user = path.join(agentDir, "WATCHDOG.yaml");
		const project = path.join(root, "project", "WATCHDOG.yml");
		const nested = path.join(cwd, "WATCHDOG.yml");
		await Bun.write(user, "advisors:\n  - name: User\n");
		await Bun.write(
			project,
			"enabled: false\ninstructions: Hidden baseline\nmaxNotesPerUpdate: 7\nadvisors:\n  - name: Root\n",
		);
		await Bun.write(nested, "advisors:\n  - name: Nested\n");
		const result = await discoverAdvisorConfigs(cwd, agentDir);
		expect(result.files).toEqual([
			{ path: user, scope: "user" },
			{ path: project, scope: "project", enabled: false },
			{ path: nested, scope: "project" },
		]);
		expect(result.advisors.map(advisor => advisor.name)).toEqual(["User", "Nested"]);
		expect(result.sharedInstructions).toBeUndefined();
		expect(result.sharedMaxNotesPerUpdate).toBeUndefined();
		expect((await loadWatchdogConfigFile(project)).advisors.map(advisor => advisor.name)).toEqual(["Root"]);
	});

	it("keeps the implicit default for instructions-only files but not an all-disabled configuration", async () => {
		const file = path.join(cwd, "WATCHDOG.yml");
		await Bun.write(file, "instructions: Shared guidance\n");
		expect(advisorRosterForRuntime(await discoverAdvisorConfigs(cwd, agentDir))).toBeUndefined();
		await Bun.write(file, "enabled: false\ninstructions: Shared guidance\n");
		expect(advisorRosterForRuntime(await discoverAdvisorConfigs(cwd, agentDir))).toEqual([]);
	});

	it("persists whole-file toggles without losing comments, extensions, or each advisor's own disabled state", async () => {
		const file = path.join(cwd, "WATCHDOG.yml");
		await Bun.write(
			file,
			"# Keep this comment\nfuture: keep\nadvisors:\n  - name: Active\n  - name: Paused\n    enabled: false\n",
		);
		let doc = await loadWatchdogConfigFile(file);
		doc.enabled = false;
		await saveWatchdogConfigFile(file, doc);
		expect(await Bun.file(file).text()).toContain("# Keep this comment");
		expect(await Bun.file(file).text()).toContain("future: keep");
		expect((await discoverAdvisorConfigs(cwd, agentDir)).advisors).toEqual([]);
		doc = await loadWatchdogConfigFile(file);
		expect(doc.enabled).toBe(false);
		expect(doc.advisors.map(advisor => advisor.enabled)).toEqual([undefined, false]);
		delete doc.enabled;
		await saveWatchdogConfigFile(file, doc);
		expect(
			(await discoverAdvisorConfigs(cwd, agentDir)).advisors.map(advisor => [advisor.name, advisor.enabled]),
		).toEqual([
			["Active", undefined],
			["Paused", false],
		]);
		expect(serializeWatchdogConfig({ advisors: [], enabled: false })).toBe("enabled: false\n");
	});

	it("stops the final file's live advisors on apply and restores them after re-enabling", async () => {
		const file = path.join(cwd, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Reviewer\n");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing bundled model");
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("anthropic", "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		const initial = await discoverAdvisorConfigs(cwd, agentDir);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(cwd, root),
			settings,
			modelRegistry: new ModelRegistry(auth),
			advisorTools: [],
			advisorConfigs: initial.advisors,
		});
		try {
			session.setAdvisorEnabled(true);
			expect(session.getAdvisorStats().advisors.map(advisor => advisor.name)).toEqual(["Reviewer"]);
			const doc = await loadWatchdogConfigFile(file);
			doc.enabled = false;
			await saveWatchdogConfigFile(file, doc);
			const disabled = await discoverAdvisorConfigs(cwd, agentDir);
			expect(session.applyAdvisorConfigs(disabled.advisors, disabled.sharedInstructions)).toBe(0);
			expect(session.getAdvisorStats().advisors).toEqual([]);
			doc.enabled = undefined;
			await saveWatchdogConfigFile(file, doc);
			const enabled = await discoverAdvisorConfigs(cwd, agentDir);
			expect(session.applyAdvisorConfigs(enabled.advisors, enabled.sharedInstructions)).toBe(1);
			expect(session.getAdvisorStats().advisors.map(advisor => advisor.name)).toEqual(["Reviewer"]);
		} finally {
			await session.dispose();
			auth.close();
		}
	});
});

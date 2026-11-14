import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { AdvisorConfigDeps } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { AdvisorScopeOverlayComponent } from "@oh-my-pi/pi-tui/overlays/advisor-scopes";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { createAdvisorActivationSetSource } from "../../src/advisor/activation-config";
import { discoverAdvisorConfigs, loadWatchdogConfigFile, saveWatchdogConfigFile } from "../../src/advisor/config";
import { cfgAdvisorActivation, cfgAdvisorActivationSet } from "../../src/advisor/settings";
import { cfgRoleSettings } from "../../src/config/role-settings";
import { Settings } from "../../src/config/settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const deps: AdvisorConfigDeps = {
	getDefaultSystemPrompt: () => "Test",
	getAvailableModels: () => [],
	defaultToolNames: new Set(),
	scopedModels: [],
	availableToolNames: [],
	browserSource: {
		revision: 0,
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: [],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: () => undefined,
		getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
	},
};
beforeAll(async () => {
	setThemeInstance((await getThemeByName("dark"))!);
});
describe("advisor role activation editor", () => {
	let state: SettingsTestState;
	let root: string;
	let agentDir: string;
	let sessionDir: string;
	let settings: Settings;
	beforeEach(async () => {
		state = beginSettingsTest();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-set-editor-"));
		agentDir = path.join(root, "agent");
		sessionDir = path.join(root, "sessions", "fixture");
		await fs.mkdir(path.join(root, ".git"));
		await Bun.write(
			path.join(agentDir, "config.yml"),
			"advisor:\n  enabled: true\nroleSettings:\n  orphan:\n    advisor.activationSet: [u, p, missing]\n",
		);
		await Bun.write(
			path.join(root, ".omp", "config.yml"),
			"roleSettings:\n  project-only:\n    advisor.activationSet: [p]\n",
		);
		await Bun.write(
			path.join(agentDir, "WATCHDOG.yml"),
			"# preserve\nenabled: true\nadvisors:\n  - id: u\n    name: User\n    enabled: false\n  - name: Legacy\n    instructions: keep\n  - broken: retain\n",
		);
		await Bun.write(path.join(root, "WATCHDOG.yml"), "advisors:\n  - id: p\n    name: Root\n");
		await Bun.write(path.join(root, ".omp", "WATCHDOG.yml"), "advisors:\n  - id: n\n    name: Native\n");
		await Bun.write(path.join(sessionDir, "WATCHDOG.yml"), "advisors:\n  - id: s\n    name: Session\n");
		settings = await Settings.init({ cwd: root, agentDir });
		await settings.attachSessionFile(path.join(root, "sessions", "fixture.jsonl"));
	});
	afterEach(async () => {
		await settings?.flush();
		restoreSettingsTestState(state);
		await fs.rm(root, { recursive: true, force: true });
	});

	async function fixture() {
		const source = createAdvisorActivationSetSource(settings, { cwd: root, agentDir, sessionDir });
		const discovered = await discoverAdvisorConfigs(root, agentDir, sessionDir);
		const files = await Promise.all(
			discovered.files.map(async file => ({ ...file, doc: await loadWatchdogConfigFile(file.path) })),
		);
		let applies = 0;
		let renderSignal = Promise.withResolvers<void>();
		const overlay = new AdvisorScopeOverlayComponent({} as TUI, deps, files, {
			activationSets: source,
			loadFile: loadWatchdogConfigFile,
			saveFile: saveWatchdogConfigFile,
			apply: async () => {
				applies++;
			},
			close: () => {},
			notify: () => {},
			requestRender: () => {
				const previous = renderSignal;
				renderSignal = Promise.withResolvers<void>();
				previous.resolve();
			},
		});
		const waitForIdle = async () => {
			while (overlay.blocksMenuHistory) await renderSignal.promise;
		};
		const activate = async (item: string) => {
			overlay.handleNativeEvent({ type: "activate", key: "", item });
			await waitForIdle();
		};
		const action = async (act: string, value?: string) => {
			overlay.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });
			if (value === "activationSet") {
				while (!overlay.navigationSnapshot().activationEditor) await renderSignal.promise;
			}
			await waitForIdle();
		};
		return { overlay, source, files, activate, action, applies: () => applies };
	}

	it("exposes orphan roles and removes missing/out-of-scope IDs without touching other layers or file gates", async () => {
		const f = await fixture();
		expect(f.source.getRoles().map(role => role.id)).toContain("orphan");
		expect(f.source.getRoles().map(role => role.id)).toContain("project-only");
		const projectBefore = await Bun.file(settings.getConfigFile("project")).text();
		const userBefore = await Bun.file(path.join(agentDir, "WATCHDOG.yml")).text();
		await f.activate("role:orphan");
		const loaded = await f.source.load("orphan", "user");
		const outside = loaded.entries.find(entry => entry.advisor.id === "p")!;
		expect(outside.visible).toBe(false);
		await f.activate(`entry:${outside.key}`);
		await f.activate("missing:missing");
		await f.action("save");
		expect(YAML.parse(await Bun.file(settings.getConfigFile("global")).text())).toMatchObject({
			roleSettings: { orphan: { "advisor.activationSet": ["u"] } },
		});
		expect(await Bun.file(settings.getConfigFile("project")).text()).toBe(projectBefore);
		expect(await Bun.file(path.join(agentDir, "WATCHDOG.yml")).text()).toBe(userBefore);
		expect(f.applies()).toBe(0);
	});

	it("assigns legacy IDs only on Save, preserves nested drafts, and keeps WATCHDOG application explicit", async () => {
		settings.setRoleSetting("orphan", cfgAdvisorActivationSet, []);
		settings.setActiveRole("orphan");
		await settings.flush();
		const f = await fixture();
		await f.activate(path.join(agentDir, "WATCHDOG.yml"));
		await f.action("page", "advisor:1");
		f.overlay.handleNativeEvent({ type: "change", key: "", item: "name", value: "Draft rename" });
		await f.action("edit", "activationSet");
		const legacy = (await f.source.load("orphan", "user")).entries.find(entry => entry.advisor.name === "Legacy")!;
		await f.activate(`entry:${legacy.key}`);
		expect((await loadWatchdogConfigFile(legacy.path)).advisors[1].id).toBeUndefined();
		await f.action("save");
		const saved = await loadWatchdogConfigFile(legacy.path);
		const id = saved.advisors[1].id;
		expect((await f.source.load("orphan", "user")).ids).toEqual([id!]);
		expect(YAML.parse(await Bun.file(legacy.path).text())).toMatchObject({
			enabled: true,
			advisors: [
				{ id: "u", name: "User", enabled: false },
				{ id, name: "Legacy", instructions: "keep" },
				{ broken: "retain" },
			],
		});
		expect(f.applies()).toBe(0);
		await f.action("close");
		expect(f.overlay.navigationSnapshot().content).toMatchObject({
			dirty: true,
			pendingApply: true,
			doc: { advisors: [{ id: "u" }, { id, name: "Draft rename", instructions: "keep" }] },
		});
		await f.action("save");
		expect((await loadWatchdogConfigFile(legacy.path)).advisors[1]).toMatchObject({ id, name: "Draft rename" });
		expect(f.applies()).toBe(1);
	});

	it("saves session sets separately, resolves their scope, and masks inherited role sets on clear", async () => {
		const source = createAdvisorActivationSetSource(settings, { cwd: root, agentDir, sessionDir });
		const userBefore = await Bun.file(settings.getConfigFile("global")).text();
		const projectBefore = await Bun.file(settings.getConfigFile("project")).text();
		expect((await source.load("orphan", "session")).ids).toEqual(["u", "p", "missing"]);
		await source.save("orphan", "session", { ids: ["p", "s"], legacy: [] });
		settings.setActiveRole("orphan");
		expect(cfgAdvisorActivation.get(settings)).toEqual({ role: "orphan", ids: ["p", "s"], scope: "session" });
		expect(YAML.parse(await Bun.file(path.join(sessionDir, "settings.yml")).text())).toMatchObject({
			roleSettings: { orphan: { "advisor.activationSet": ["p", "s"] } },
		});
		const resumed = await Settings.init({ cwd: root, agentDir });
		await resumed.attachSessionFile(path.join(root, "sessions", "fixture.jsonl"));
		resumed.setActiveRole("orphan");
		expect(cfgAdvisorActivation.get(resumed)).toEqual({ role: "orphan", ids: ["p", "s"], scope: "session" });
		await source.save("orphan", "session", { ids: null, legacy: [] });
		expect(cfgAdvisorActivationSet.get(settings)).toBeNull();
		expect((await source.load("orphan", "session")).ids).toBeNull();
		expect(await Bun.file(settings.getConfigFile("global")).text()).toBe(userBefore);
		expect(await Bun.file(settings.getConfigFile("project")).text()).toBe(projectBefore);
	});

	it("does not adopt ordinary activation IDs into an absent or cleared role set", async () => {
		settings.writeScopeValue(cfgAdvisorActivationSet, ["u"], "global");
		const source = createAdvisorActivationSetSource(settings, { cwd: root, agentDir, sessionDir });
		expect((await source.load("default", "user")).ids).toBeNull();
		await source.save("default", "user", { ids: null, legacy: [] });
		expect(settings.readScopeValue(cfgRoleSettings, "global")).toMatchObject({
			default: { "advisor.activationSet": null },
		});
		expect((await source.load("default", "user")).ids).toBeNull();
		expect(settings.readScopeValue(cfgAdvisorActivationSet, "global")).toEqual(["u"]);
	});
});

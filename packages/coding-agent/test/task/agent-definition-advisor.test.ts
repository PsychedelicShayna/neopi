import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildAgentAdvisorSpawnConfig } from "@oh-my-pi/pi-coding-agent/task/agent-advisor";
import { parseAgentDefinitionDocument, serializeAgentDefinitionDocument } from "@oh-my-pi/pi-coding-agent/task/agent-definition-document";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { cfgAdvisorEnabled, cfgAdvisorDeliveryConcern } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { SessionManager, extractSessionInit } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentDefinitionDraft } from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";

let dir: string;
let project: string;
let agentDir: string;
beforeEach(async () => {
	const scratch = path.join(os.homedir(), ".cache/npi-canary");
	await fs.mkdir(scratch, { recursive: true });
	dir = await fs.mkdtemp(path.join(scratch, "agent-editor-advisor-"));
	project = path.join(dir, "project"); agentDir = path.join(dir, "profile");
	await fs.mkdir(path.join(project, ".git"), { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const base: AgentDefinitionDraft = { name: "reviewer-test", description: "Review a change", systemPrompt: "Read the whole change." };

describe("agent advisor frontmatter and spawn configuration", () => {
	test("loads a scoped named reference and passes only the selected advisor into the child launch", async () => {
		await Bun.write(path.join(project, "WATCHDOG.yml"), "advisors:\n  - name: velvet\n    instructions: Root version\n  - name: unrelated\n    instructions: Not selected\n");
		await Bun.write(path.join(project, ".omp", "WATCHDOG.yml"), "advisors:\n  - name: velvet\n    model: '@advisor'\n    tools: [read, grep]\n    instructions: Scoped velvet instructions\n");
		const definition = parseAgentDefinitionDocument(serializeAgentDefinitionDocument({ ...base, advisor: { ref: "velvet", scope: "project-omp" } }));
		expect(definition.advisor).toEqual({ ref: "velvet", scope: "project-omp" });
		const parent = Settings.isolated({ modelRoles: { advisor: "test/reviewer:high" } });
		const launch = await buildAgentAdvisorSpawnConfig({ advisor: definition.advisor, settings: parent, cwd: project, agentDir });
		const child = createSubagentSettings(parent, launch.settingsOverrides);
		expect(cfgAdvisorEnabled.get(child)).toBe(true);
		expect(launch.advisorConfigs).toEqual([{ name: "velvet", model: "@advisor", tools: ["read", "grep"], instructions: "Scoped velvet instructions", scope: "all" }]);
		expect(launch.persistedAdvisor).toBe("on");
	});

	test("private inline model, prompt, cadence and delivery survive load and child settings without catalog writes", async () => {
		const inline = { name: "private-review", model: "test/private:high", instructions: "Only this definition", systemPrompt: "Custom base prompt", tools: ["read"], includeThinking: false, maxNotesPerUpdate: 3, reviewMode: "agent-end" as const, reviewInterval: 2, syncBacklog: "strict" as const, delivery: { concern: "on-yield" as const, blocker: "next-tool-call" as const } };
		const raw = serializeAgentDefinitionDocument({ ...base, advisor: { inline } });
		const definition = parseAgentDefinitionDocument(raw);
		expect(definition.advisor).toEqual({ inline });
		const parent = Settings.isolated({ "advisor.enabled": false });
		const launch = await buildAgentAdvisorSpawnConfig({ advisor: definition.advisor, settings: parent, cwd: project, agentDir });
		const child = createSubagentSettings(parent, launch.settingsOverrides);
		expect(launch.advisorConfigs).toEqual([inline]);
		expect(cfgAdvisorEnabled.get(child)).toBe(true);
		expect(cfgAdvisorDeliveryConcern.get(child)).toBe("on-yield");
		expect(cfgAdvisorEnabled.get(parent)).toBe(false);
		expect(await fs.readdir(agentDir)).toEqual([]);
		expect(await fs.readdir(project)).toEqual([".git"]);
	});

	test("default advisor role and explicit disable retain their existing behavior", async () => {
		const settings = Settings.isolated({ modelRoles: { advisor: "test/default:high" } });
		const defaults = await buildAgentAdvisorSpawnConfig({ advisor: true, settings, cwd: project, agentDir });
		expect(defaults.advisorConfigs).toBeUndefined();
		expect(defaults.persistedAdvisor).toBe("on");
		expect(cfgAdvisorEnabled.get(createSubagentSettings(settings, defaults.settingsOverrides))).toBe(true);
		const disabled = await buildAgentAdvisorSpawnConfig({ advisor: { inline: { name: "private" } }, settingsOverride: "off", settings, cwd: project, agentDir });
		expect(disabled).toEqual({ settingsOverrides: {} });
		expect(cfgAdvisorEnabled.get(createSubagentSettings(settings, disabled.settingsOverrides))).toBe(false);
		const model = await buildAgentAdvisorSpawnConfig({ advisor: "@advisor", settings, cwd: project, agentDir });
		expect(model.persistedAdvisor).toBe("test/default:high");
		expect(createSubagentSettings(settings, model.settingsOverrides).getModelRole("advisor")).toBe("test/default:high");
	});

	test("unresolved references and malformed inline policies fail instead of silently enabling a different advisor", async () => {
		const settings = Settings.isolated();
		await expect(buildAgentAdvisorSpawnConfig({ advisor: { ref: "missing" }, settings, cwd: project, agentDir })).rejects.toThrow("Unknown advisor 'missing'");
		expect(() => parseAgentDefinitionDocument("---\nname: agent\ndescription: x\nadvisor:\n  ref: velvet\n  inline: {}\n---\nInstructions\n")).toThrow("both a reference and inline");
		expect(() => parseAgentDefinitionDocument("---\nname: agent\ndescription: x\nadvisor:\n  inline:\n    delivery:\n      concern: interrupt\n---\nInstructions\n")).toThrow("Invalid advisor delivery");
	});

	test("the persisted child launch contract retains the resolved private roster for cold revival", async () => {
		const settings = Settings.isolated();
		const launch = await buildAgentAdvisorSpawnConfig({ advisor: { inline: { name: "private", instructions: "Persist me", delivery: { nit: "next-tool-call" } } }, settings, cwd: project, agentDir });
		const manager = SessionManager.inMemory(project);
		manager.appendSessionInit({ systemPrompt: ["Instructions"], task: "Assignment", tools: [], advisor: launch.persistedAdvisor, advisorConfigs: launch.advisorConfigs });
		const restored = extractSessionInit(manager.getEntries());
		expect(restored?.advisorConfigs).toEqual(launch.advisorConfigs);
		expect(restored?.advisor).toBe("on");
	});
});

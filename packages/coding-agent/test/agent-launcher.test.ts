import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../src/config/settings";
import { resolveModelRoleValue } from "../src/config/model-resolver";
import { AsyncJobManager } from "../src/async/job-manager";
import { runAgentLauncher, launcherEfforts, resolveLauncherModel } from "../src/neopi/agent-launcher";
import type { AgentSession } from "../src/session/agent-session";
import * as discovery from "../src/task/discovery";
import * as executor from "../src/task/executor";
import { reserveStructuredSubagentId } from "../src/task/structured-subagent";
import type { ToolSession } from "../src/tools";
import type { ExtensionUIContext } from "../src/extensibility/extensions/types";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as sdk from "../src/sdk";
import { ModelRegistry } from "../src/config/model-registry";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { SessionManager } from "../src/session/session-manager";

const model = getBundledModel("openai", "gpt-4o-mini")!;
const reasoning = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const dirs: string[] = [];
const managers: AsyncJobManager[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function fixture(
	answers = ["subagent", "off", "independent"],
	inputs = ["openai/gpt-4o-mini", "Spark", "read", "Inspect the source."],
	confirmed = false,
) {
	const cacheDir = `${process.env.HOME}/.cache/npi-canary`;
	await fs.mkdir(cacheDir, { recursive: true });
	const cwd = await fs.mkdtemp(`${cacheDir}/agent-launcher-`);
	dirs.push(cwd);
	const settings = Settings.isolated({
		"task.isolation.enabled": false,
		"task.enableLsp": false,
		modelRoles: { smol: "openai/gpt-4o-mini" },
	});
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ name: "task", description: "Worker", systemPrompt: "Test worker", source: "bundled" }],
		projectAgentsDir: null,
	});
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	managers.push(manager);
	const toolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => `${cwd}/root.jsonl`,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		getArtifactsDir: () => cwd,
		asyncJobManager: manager,
	} as unknown as ToolSession;
	const launchAdvisor = vi.fn();
	const session = {
		settings,
		modelRegistry: { getAvailable: () => [model, reasoning] },
		getAgentLauncherSession: () => toolSession,
		getEnabledToolNames: () => ["read", "write", "task"],
		hasBuiltInTool: () => true,
		getAdvisorAvailableToolNames: () => ["read", "grep"],
		launchAdvisor,
	} as unknown as AgentSession;
	const select = vi.fn(async (_title: string, _options: unknown) => answers.shift());
	const input = vi.fn(async () => inputs.shift());
	const confirm = vi.fn(async () => confirmed);
	const ui = { select, input, confirm } as unknown as Pick<ExtensionUIContext, "select" | "input" | "confirm">;
	return { cwd, session, settings, toolSession, ui, select, confirm, launchAdvisor, manager };
}

it("offers only the resolved model's valid efforts and rejects an injected invalid selection before launch", async () => {
	const f = await fixture(["subagent", "xhigh"]);
	const run = vi.spyOn(executor, "runSubprocess");
	await expect(runAgentLauncher(f.session, f.ui)).rejects.toThrow("supported by the selected model");
	expect(f.select.mock.calls[1]?.[1]).toEqual(["off"]);
	expect(f.confirm).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
	expect(launcherEfforts(reasoning)).toEqual(reasoning.thinking!.efforts);
});

it("rejects fuzzy model input instead of silently selecting a different model", async () => {
	const f = await fixture();
	expect(() => resolveLauncherModel("gpt-4o", [model], f.settings)).toThrow("exact provider/model");
});

it("shows the canonical role resolution and costs but starts nothing when confirmation is declined", async () => {
	const f = await fixture(undefined, ["@smol", "Spark", "read", "Inspect source."]);
	const run = vi.spyOn(executor, "runSubprocess");
	expect(await runAgentLauncher(f.session, f.ui)).toBeUndefined();
	const resolved = resolveModelRoleValue("@smol", [model], { settings: f.settings });
	const preview = f.confirm.mock.calls[0] as unknown as [string, string];
	expect(preview[1]).toContain(`Resolved: ${resolved.model!.provider}/${resolved.model!.id}:off`);
	expect(preview[1]).toContain("Fixed after creation");
	expect(preview[1]).toContain("A prior IndependentFable idle init cost about $0.39");
	expect(run).not.toHaveBeenCalled();
	expect(f.manager.getJob("Spark")).toBeUndefined();
});

it("forwards model, built-in tool restrictions and orchestration to the shared spawn primitive", async () => {
	const f = await fixture(undefined, undefined, true);
	const run = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => ({
		index: 0,
		id: options.id!,
		agent: "task",
		agentSource: "bundled",
		task: options.task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
	}));
	expect(await runAgentLauncher(f.session, f.ui)).toContain("Launched Spark as openai/gpt-4o-mini:off");
	await f.manager.getJob("Spark")!.promise;
	const options = run.mock.calls[0]![0];
	expect(options.modelOverride).toEqual(["openai/gpt-4o-mini:off"]);
	expect(options.agent.tools).toEqual(["read"]);
	expect(options.agent.spawns).toEqual([]);
	expect(options.restrictToolNames).toBe(true);
	expect(options.enableMCP).toBe(false);
	expect(options.keepAlive).toBe(true);
});

it("adds an advisor only after confirmation with its exact model, tools and review cadence", async () => {
	const f = await fixture(["advisor", "off", "agent-end"], undefined, true);
	await runAgentLauncher(f.session, f.ui);
	expect(f.launchAdvisor).toHaveBeenCalledWith({
		name: "Spark",
		model: "openai/gpt-4o-mini:off",
		tools: ["read"],
		instructions: "Inspect the source.",
		reviewMode: "agent-end",
	});
	expect(f.manager.getJob("Spark")).toBeUndefined();
});

it("refuses to launch into a session that changed during confirmation", async () => {
	const f = await fixture(undefined, undefined, true);
	f.confirm.mockImplementation(async () => {
		f.toolSession.getSessionFile = () => "changed.jsonl";
		return true;
	});
	await expect(runAgentLauncher(f.session, f.ui)).rejects.toThrow("owning session changed");
	expect(f.manager.getJob("Spark")).toBeUndefined();
});

it("requires a second confirmation before using a suffixed duplicate name", async () => {
	const f = await fixture(undefined, undefined, true);
	await reserveStructuredSubagentId(f.toolSession, { label: "Spark" });
	f.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
	expect(await runAgentLauncher(f.session, f.ui)).toBeUndefined();
	expect(f.confirm.mock.calls[1] as unknown as [string, string]).toEqual([
		"Confirm reserved identity",
		"The name Spark was already reserved. Launch as Spark-2? Names are fixed after creation.",
	]);
	expect(f.manager.getJob("Spark-2")).toBeUndefined();
});

it("registers the human-selected name in the real Hub registry and retains it after the worker settles", async () => {
	const f = await fixture(undefined, undefined, true);
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("openai", "test-key");
	const registry = new ModelRegistry(auth, `${f.cwd}/models.toml`, { settings: f.settings });
	f.toolSession.authStorage = auth;
	f.toolSession.modelRegistry = registry;
	const root = SessionManager.create(f.cwd, f.cwd);
	await root.ensureOnDisk();
	f.toolSession.getSessionFile = () => root.getSessionFile() ?? null;
	const original = sdk.createAgentSession;
	const children: AgentSession[] = [];
	vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
		const result = await original({
			...options,
			agentDir: `${f.cwd}/agent`,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
		});
		result.session.agent.streamFn = createMockModel({ handler: { content: ["finished"] } }).stream;
		result.session.agent.getApiKey = () => "test-key";
		children.push(result.session);
		return result;
	});
	try {
		await runAgentLauncher(f.session, f.ui);
		await f.manager.getJob("Spark")!.promise;
		expect(f.manager.getJob("Spark")!.status).toBe("completed");
		expect(AgentRegistry.global().get("Spark")?.id).toBe("Spark");
		expect(AgentRegistry.global().get("Spark")?.status).toBe("idle");
	} finally {
		for (const child of children) await child.dispose();
		await root.close();
		await auth.close();
	}
});

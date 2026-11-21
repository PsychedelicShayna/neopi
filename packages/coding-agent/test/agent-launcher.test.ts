import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { buildAsyncResultBlock } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AsyncJobManager } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	type AgentLauncher,
	createAgentLauncher,
	parseSpawnArguments,
	type SpawnDraft,
} from "../src/neopi/agent-launcher";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { AgentRegistry } from "../src/registry/agent-registry";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { SPAWN_COMMAND } from "../src/slash-commands/builtin-agent-launcher";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "../src/slash-commands/types";
import type { ToolSession } from "../src/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createMcpManagerStub } from "./helpers/interactive-mode-context";

const plain = getBundledModel("openai", "gpt-4o-mini")!;
const reasoning = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const opus = getBundledModel("anthropic", "claude-opus-5-5")!;
// This selector is grammatical catalog input, not a credentialed network destination.
const astra = {
	...reasoning,
	provider: "openai-codex",
	id: "gpt-6.2-astra-fast-900k",
	thinking: { ...reasoning.thinking!, efforts: ["low", "medium", "high", "xhigh"] as const },
};
const localSelector = "spawn-fixture/local";
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

interface CompletionRequest {
	model: string;
	reasoning_effort?: string;
	messages: { role: string; content: unknown }[];
	tools?: { function: { name: string } }[];
}

async function fixture(serveCompletion = false, firstToolCall?: { name: string; arguments: string }) {
	// Agent discovery stops at HOME; keep the fixture in its own directory beneath it.
	const cwd = await fs.mkdtemp(path.join(os.homedir(), ".spawn-test-"));
	cleanup.push(async () => fs.rm(cwd, { recursive: true, force: true }));
	await Bun.write(
		path.join(cwd, ".omp", "agents", "scout.md"),
		'---\nname: scout\ndescription: Search the project.\nmodel: "@smol"\nthinking-level: medium\ntools: read\n---\nReport your findings.',
	);
	await Bun.write(
		path.join(cwd, ".omp", "agents", "task.md"),
		'---\nname: task\ndescription: Perform the assignment.\nmodel: "@task"\nthinking-level: medium\ntools: read, write, task\n---\nComplete the assignment.',
	);
	const settings = Settings.isolated({
		"task.isolation.enabled": false,
		"task.enableLsp": false,
		"task.structured": false,
		"task.agentIdleTtlMs": 0,
		"advisor.enabled": false,
		"compaction.enabled": false,
		modelRoles: {
			smol: serveCompletion ? localSelector : "anthropic/claude-sonnet-4-5:medium",
			slow: "anthropic/claude-sonnet-4-5:high",
			task: "anthropic/claude-sonnet-4-5:medium",
			advisor: "openai/gpt-4o-mini",
		},
	});
	const auth = createInMemoryAuthStorage();
	cleanup.push(async () => {
		await auth.close();
	});
	const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), { settings });
	const requests: CompletionRequest[] = [];
	if (serveCompletion) {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname !== "/v1/chat/completions") {
					return new Response(null, { status: 404 });
				}
				const completion = (await request.json()) as CompletionRequest;
				const toolCall =
					completion.model === "selected" && !requests.some(r => r.model === "selected")
						? firstToolCall
						: undefined;
				requests.push(completion);
				const chunk = (delta: object, finishReason: string | null = null) =>
					`data: ${JSON.stringify({ id: "spawn-test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
				const content = completion.model === "selected" ? "73" : "finished";
				return new Response(
					(toolCall
						? chunk({
								role: "assistant",
								tool_calls: [{ index: 0, id: "call_write", type: "function", function: toolCall }],
							}) + chunk({}, "tool_calls")
						: chunk({ role: "assistant", content }) + chunk({}, "stop")) + "data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		cleanup.push(async () => {
			await server.stop(true);
		});
		const baseUrl = `${server.url.origin}/v1`;
		registry.registerProvider("spawn-fixture", {
			api: "openai-completions",
			apiKey: "fixture-key",
			baseUrl,
			models: ["local", "selected", "execution", "reviewer"].map(id => ({
				...plain,
				id,
				name: `Spawn fixture ${id}`,
				api: "openai-completions" as const,
				baseUrl,
				contextWindow: 128_000,
				maxTokens: 16_384,
				...(id === "local"
					? {}
					: {
							reasoning: true,
							thinking: { mode: "effort" as const, efforts: [Effort.Low, Effort.Medium, Effort.High] },
							compat: { supportsReasoningParams: true, supportsReasoningEffort: true },
						}),
			})),
		});
	}
	const root = SessionManager.create(cwd, cwd);
	await root.ensureOnDisk();
	cleanup.push(async () => root.close());
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	cleanup.push(async () => {
		const ids = manager.getAllJobs().map(job => job.id);
		await manager.dispose();
		for (const id of ids) await AgentLifecycleManager.global().release(id);
	});
	const getMcpTools = vi.fn(() => []);
	const toolSession = {
		cwd,
		hasUI: false,
		settings,
		authStorage: auth,
		modelRegistry: registry,
		getSessionFile: () => root.getSessionFile() ?? null,
		getSessionSpawns: () => "*" as const,
		getAgentId: () => "Main",
		getArtifactsDir: () => cwd,
		asyncJobManager: manager,
		mcpManager: createMcpManagerStub({ getTools: getMcpTools }),
	} as unknown as ToolSession;
	const launchAdvisor = vi.fn();
	const session = {
		settings,
		modelRegistry: serveCompletion ? registry : { getAvailable: () => [plain, reasoning, opus, astra] },
		getAgentLauncherSession: () => toolSession,
		getEnabledToolNames: () => ["read", "write", "task", "mcp__fixture_external"],
		hasBuiltInTool: (name: string) => name !== "mcp__fixture_external",
		getAdvisorAvailableToolNames: () => ["read", "grep", "advise"],
		launchAdvisor,
	} as unknown as AgentSession;

	const showSpawn = vi.fn(async (_launcher: AgentLauncher): Promise<SpawnDraft | undefined> => undefined);
	const showSpawnAssignment = vi.fn(async (): Promise<string | undefined> => undefined);
	const showStatus = vi.fn((_message: string) => {});
	const showError = vi.fn((_message: string) => {});
	const setText = vi.fn();
	const runtime = {
		ctx: {
			session,
			sessionManager: root,
			showSpawn,
			showSpawnAssignment,
			showStatus,
			showError,
			editor: { setText },
		},
	} as unknown as TuiSlashCommandRuntime;
	const submit = (args: string, owner = session) =>
		SPAWN_COMMAND.handleTui!(
			{ name: "spawn", args, text: `/spawn ${args}` },
			{
				...runtime,
				ctx: { ...runtime.ctx, session: owner },
			},
		);
	return {
		auth,
		cwd,
		registry,
		root,
		manager,
		toolSession,
		session,
		runtime,
		launchAdvisor,
		requests,
		getMcpTools,
		showSpawn,
		showSpawnAssignment,
		showStatus,
		showError,
		submit,
	};
}

it.each([
	["", undefined],
	[" \t\n ", undefined],
	["agent task@task", { spec: "task@task", assignment: "" }],
	["task@task", { spec: "task@task", assignment: "" }],
	["scout", { spec: "scout", assignment: "" }],
	[" \tscout   Inspect the source.", { spec: "scout", assignment: "Inspect the source." }],
	[
		"task:low First line\n  Keep indentation; literal @role[100k]",
		{ spec: "task:low", assignment: "First line\n  Keep indentation; literal @role[100k]" },
	],
])("splits the first spec token from unparsed assignment text (%j)", (input, expected) => {
	expect(parseSpawnArguments(input)).toEqual(expected);
});

it("resolves valid spawn specs without replacing a definition's defaults or explicit effort", async () => {
	const f = await fixture();
	const launcher = await createAgentLauncher(f.session);
	for (const [spec, expected] of [
		["scout", { type: "scout", model: "anthropic/claude-sonnet-4-5:medium", tools: ["read"] }],
		["scout@slow:low", { type: "scout", model: "anthropic/claude-sonnet-4-5:low" }],
		["scout@anthropic/claude-opus-5-5:high", { type: "scout", model: "anthropic/claude-opus-5-5:high" }],
		["task:low", { type: "task", model: "anthropic/claude-sonnet-4-5:low" }],
		["@scout[100k]", { type: "scout", context: 100_000 }],
		[
			"task@task:high;pre=@smol[200k]:low;advisor=openai-codex/gpt-6.2-astra-fast-900k:xhigh",
			{
				type: "task",
				model: "anthropic/claude-sonnet-4-5:high",
				prewalk: "@smol[200k]:low",
				advisor: "openai-codex/gpt-6.2-astra-fast-900k:xhigh",
			},
		],
	] as const) {
		expect(launcher.resolveSpec(spec)).toMatchObject(expected);
	}
	for (const effort of reasoning.thinking!.efforts) {
		const selector = `anthropic/claude-sonnet-4-5:${effort}`;
		expect(launcher.resolveSpec(`scout@${selector}`).model).toBe(selector);
	}
	expect(launcher.resolveSpec("scout").name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/i);
});

it("completes discovered types while keeping bare Enter and removing the /agent command", async () => {
	const f = await fixture();
	const command = lookupBuiltinSlashCommand("spawn");
	expect(lookupBuiltinSlashCommand("agent")).toBeUndefined();
	expect(await command?.getTuiArgumentCompletions?.("sco", f.runtime)).toEqual([
		expect.objectContaining({ value: "scout" }),
	]);
	expect(await command?.getTuiArgumentCompletions?.("", f.runtime)).toContainEqual(
		expect.objectContaining({ value: "scout", preserveInputOnSubmit: true }),
	);
	expect(await command?.getTuiArgumentCompletions?.("scout Inspect", f.runtime)).toBeNull();
});

it.each([
	["not-a-spawn-type", /not-a-spawn-type/],
	["scout@openai/gpt-4o", /gpt-4o|exact/i],
	["scout@openai/gpt-4o-mini:xhigh", /unsupported effort.*supported efforts: off/i],
	["scout@slow:bogus", /bogus|effort/i],
	["scout[wat]", /context|cap/i],
	["scout[0]", /context|cap/i],
	["scout;unknown=value", /unknown|modifier/i],
	["scout;pre=", /pre/i],
])("rejects an invalid spawn spec before dispatch (%s)", async (spec, error) => {
	const f = await fixture();
	await f.submit(`${spec} Inspect the source.`);
	expect(f.showError).toHaveBeenCalledTimes(1);
	expect(f.showError.mock.calls[0]?.[0]).toMatch(error);
	expect(f.showSpawn).not.toHaveBeenCalled();
	expect(f.showSpawnAssignment).not.toHaveBeenCalled();
	expect(f.manager.getAllJobs()).toEqual([]);
});

it("launches /spawn scout with inline text, definition defaults and no dialog", async () => {
	const f = await fixture(true);
	await f.submit("scout Inspect the source.");
	expect(f.showError).not.toHaveBeenCalled();
	expect(f.showSpawn).not.toHaveBeenCalled();
	expect(f.showSpawnAssignment).not.toHaveBeenCalled();
	const jobs = f.manager.getAllJobs();
	expect(jobs).toHaveLength(1);
	const [job] = jobs;
	expect(job).toMatchObject({ type: "task", ownerId: "Main", agentId: job!.id });
	expect(f.showStatus.mock.calls[0]?.[0]).toContain(job!.id);
	await job!.promise;
	expect(job!.resultText).toContain("finished");
	expect(job!.status).toBe("completed");
	const request = f.requests.find(request => request.tools?.length);
	expect(request?.model).toBe("local");
	expect(JSON.stringify(request?.messages)).toContain("Inspect the source.");
	expect(JSON.stringify(request?.messages)).toContain("Report your findings.");
	expect(request?.tools?.map(tool => tool.function.name)).toEqual(["read"]);
}, 20_000);

it("applies inline thinking, prewalk and advisor overrides in the launched worker", async () => {
	const f = await fixture(true, { name: "write", arguments: '{"path":"fixture.txt","content":"done"}' });
	await f.submit(
		"task@spawn-fixture/selected:low;pre=spawn-fixture/execution:low;advisor=spawn-fixture/reviewer:high Write the fixture.",
	);
	expect(f.showError.mock.calls).toEqual([]);
	const jobs = f.manager.getAllJobs();
	expect(jobs).toHaveLength(1);
	const [job] = jobs;
	await job!.promise;
	expect(job!.status).toBe("completed");
	const child = AgentRegistry.global().get(job!.id);
	expect(child).toMatchObject({ id: job!.id, status: "idle", sessionFile: expect.any(String) });
	const journal = (child!.session as AgentSession).sessionManager.getEntries();
	expect({
		start: f.requests.find(request => request.model === "selected")?.reasoning_effort,
		execution: f.requests.find(request => request.model === "execution")?.reasoning_effort,
		advisor: journal.find(entry => entry.type === "session_init")?.advisor,
	}).toEqual({ start: "low", execution: "low", advisor: "spawn-fixture/reviewer:high" });
}, 20_000);

it("delivers a spawned worker's reply into the launching session without opening Hub", async () => {
	const f = await fixture(true);
	const { session: owner } = await createAgentSession({
		cwd: f.cwd,
		agentDir: path.join(f.cwd, ".omp", "agent"),
		agentId: "SpawnResultOwner",
		sessionManager: f.root,
		settings: f.session.settings,
		authStorage: f.auth,
		modelRegistry: f.registry,
		model: f.registry.getAvailable().find(model => model.provider === "spawn-fixture" && model.id === "local")!,
		enableMCP: false,
	});
	cleanup.push(async () => {
		await owner.cancelRootWork();
		await owner.dispose();
	});
	await f.submit("agent scout@spawn-fixture/selected:low Return the number.", owner);
	expect(f.showError.mock.calls).toEqual([]);
	await owner.settleAsyncWork();

	const result = f.root
		.buildSessionContext()
		.messages.find(message => message.role === "custom" && message.customType === "async-result");
	expect(result).toMatchObject({ display: true, content: expect.stringMatching(/^73$/m) });
	if (result?.role !== "custom") throw new Error("Expected a delivered async-result");
	await initTheme(false, undefined, undefined, "dark", "light");
	const rendered = buildAsyncResultBlock(result)
		.render(100)
		.map(line => Bun.stripANSI(line).trim());
	expect(rendered).toContain("73");
}, 20_000);

it("opens only the assignment editor for /spawn scout and launches after it returns multiline text", async () => {
	const f = await fixture(true);
	const opened = Promise.withResolvers<void>();
	const assignment = Promise.withResolvers<string>();
	f.showSpawnAssignment.mockImplementationOnce(() => {
		opened.resolve();
		return assignment.promise;
	});
	const command = f.submit("scout");
	await Promise.race([opened.promise, command]);
	try {
		expect(f.showSpawnAssignment).toHaveBeenCalledTimes(1);
		expect(f.showSpawn).not.toHaveBeenCalled();
		expect(f.manager.getAllJobs()).toEqual([]);
	} finally {
		assignment.resolve("Inspect the source.\n  Preserve indentation.");
		await command;
	}
	expect(f.showError).not.toHaveBeenCalled();
	const jobs = f.manager.getAllJobs();
	expect(jobs).toHaveLength(1);
	await jobs[0]!.promise;
	expect(jobs[0]!.status).toBe("completed");
	const request = f.requests.find(request => request.tools?.length);
	expect(JSON.stringify(request?.messages)).toContain("Inspect the source.\\n  Preserve indentation.");
}, 20_000);

it.each(["", "scout"])("creates no agent or job when the %j dialog is cancelled", async args => {
	const f = await fixture();
	await f.submit(args);
	expect(f.showSpawn).toHaveBeenCalledTimes(args ? 0 : 1);
	expect(f.showSpawnAssignment).toHaveBeenCalledTimes(args ? 1 : 0);
	expect(f.showStatus).not.toHaveBeenCalled();
	expect(f.showError).not.toHaveBeenCalled();
	expect(f.launchAdvisor).not.toHaveBeenCalled();
	expect(f.manager.getAllJobs()).toEqual([]);
});

it("rejects an assignment captured for a session that changed while the editor was open", async () => {
	const f = await fixture();
	f.showSpawnAssignment.mockImplementationOnce(async () => {
		f.toolSession.getSessionFile = () => "changed.jsonl";
		return "Inspect the source.";
	});
	await f.submit("scout");
	expect(f.showError).toHaveBeenCalledWith(expect.stringMatching(/owning session changed/i));
	expect(f.manager.getAllJobs()).toEqual([]);
});

it("launches the selected advisor model and tools with turn review and no worker job", async () => {
	const f = await fixture();
	const launcher = await createAgentLauncher(f.session);
	expect(launcher.presets.find(preset => preset.type === "advisor")?.tools.map(tool => tool.value)).toContain(
		"advise",
	);
	f.showSpawn.mockImplementationOnce(async active => ({
		...active.resolveSpec("advisor@openai/gpt-4o-mini:off"),
		name: "SparkAdvisor",
		tools: ["read"],
		assignment: "Review the source.",
	}));
	await f.submit("");
	expect(f.showError).not.toHaveBeenCalled();
	expect(f.launchAdvisor).toHaveBeenCalledWith({
		name: "SparkAdvisor",
		model: "openai/gpt-4o-mini:off",
		tools: ["read"],
		instructions: "Review the source.",
		reviewMode: "turn",
	});
	expect(f.manager.getAllJobs()).toEqual([]);
});

it("rejects tools outside the worker's built-in allowlist before launch", async () => {
	const f = await fixture();
	const launcher = await createAgentLauncher(f.session);
	const draft = { ...launcher.resolveSpec("scout"), assignment: "Inspect the source." };
	await expect(launcher.launch({ ...draft, tools: ["mcp__fixture_external"] })).rejects.toThrow(
		/mcp__fixture_external/,
	);
	expect(f.manager.getAllJobs()).toEqual([]);
});

it("registers the allocated name in Hub, preserves restrictions, and retains the worker when parked", async () => {
	const f = await fixture(true);
	f.showSpawn.mockImplementation(async launcher => ({
		...launcher.resolveSpec("scout"),
		name: "Spark",
		model: "spawn-fixture/selected:off",
		assignment: "Inspect the source.",
		context: 100_000,
		tools: ["read"],
		delegation: "*",
	}));
	await f.submit("");
	expect(f.showStatus.mock.calls[0]?.[0]).toContain("Launched Spark as spawn-fixture/selected:off");
	const originalJob = f.manager.getJob("Spark");
	expect(originalJob).toMatchObject({ agentId: "Spark", ownerId: "Main" });
	await originalJob!.promise;
	expect(originalJob!.status).toBe("completed");
	const hub = AgentRegistry.global();
	const originalRef = hub.get("Spark");
	expect(originalRef).toMatchObject({ id: "Spark", status: "idle" });

	await f.submit("");
	expect(f.showError).not.toHaveBeenCalled();
	expect(f.showStatus.mock.calls[1]?.[0]).toContain("Launched Spark-2 as spawn-fixture/selected:off");
	expect(f.showStatus.mock.calls[1]?.[0]).toContain("/hub Spark-2");
	expect(f.manager.getJob("Spark")).toBe(originalJob);
	expect(hub.get("Spark")).toBe(originalRef);
	const job = f.manager.getJob("Spark-2");
	expect(job).toMatchObject({ agentId: "Spark-2", ownerId: "Main" });
	await job!.promise;
	expect(job!.status).toBe("completed");
	expect(f.requests.at(-1)?.model).toBe("selected");
	expect(f.requests.at(-1)?.tools?.map(tool => tool.function.name)).toEqual(["read"]);
	expect(f.getMcpTools).not.toHaveBeenCalled();
	const ref = hub.get("Spark-2");
	expect(ref).toMatchObject({ id: "Spark-2", status: "idle", sessionFile: expect.any(String) });
	const transcript = ref!.sessionFile;
	const session = ref!.session as AgentSession;
	expect(session.model?.contextWindow).toBe(100_000);
	const init = session.sessionManager.getEntries().find(entry => entry.type === "session_init");
	expect(init).toMatchObject({ tools: ["read"], spawns: "", restrictToolNames: true, contextCap: 100_000 });
	await AgentLifecycleManager.global().park("Spark-2");
	const parked = hub.get("Spark-2");
	expect(parked?.id).toBe("Spark-2");
	expect(parked?.status).toBe("parked");
	expect(parked?.session).toBeNull();
	expect(parked?.sessionFile).toBe(transcript);
}, 20_000);

/**
 * `omp --restore` end to end for a subagent: a transcript a crash cut off mid tool
 * call is revived from disk, its cut-off call runs again, the agent answers, and the
 * parent receives the answer as the subagent's job.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { Effort } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "Restored";
const MOCK_API_SOURCE = "test/restore-revive";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restore-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

const SPAWN_MODEL = "mock-model";
const HANDOFF_MODEL = "mock-handoff";

/** The mock carries no effort ladder; without one every configured effort clamps away. */
const thinking = { mode: "effort", efforts: [Effort.Medium, Effort.High] } as const;

/**
 * Writes a main session whose subagent died inside its `read` call (no tool result, no
 * exit record), restores the session, and returns the answer the parent received with
 * the `read` results and efforts each model saw when the cut-off call ran again.
 * `handoff` records a prewalk handoff to `high` effort before the cut-off call;
 * `fallback` follows that handoff with a retry fallback hop back to the spawn model.
 */
async function restoreInterruptedChild(options: { transcript?: "handoff" | "fallback" } = {}) {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const notes = path.join(cwd, "notes.txt");
	await Bun.write(notes, "the answer is 42\n");

	const main = SessionManager.create(cwd, path.join(root, "sessions"));
	main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
	const mainFile = main.getSessionFile();
	if (!mainFile) throw new Error("Expected a persisted session file");
	await main.close();
	const child = await SessionManager.open(
		path.join(mainFile.slice(0, -6), `${AGENT_ID}.jsonl`),
		undefined,
		undefined,
		{
			initialCwd: cwd,
			parentSession: mainFile,
			suppressBreadcrumb: true,
		},
	);
	child.appendSessionInit({
		systemPrompt: ["test"],
		task: "report what notes.txt says",
		tools: ["read"],
		agent: "task",
		resolvedModel: `mock/${SPAWN_MODEL}`,
	});
	child.appendMessage({ role: "user", content: "report what notes.txt says", timestamp: Date.now() });
	if (options.transcript) {
		child.appendModelChange(`mock/${HANDOFF_MODEL}`, "prewalk");
		child.appendThinkingLevelChange(Effort.High, Effort.High);
	}
	if (options.transcript === "fallback") child.appendModelChange(`mock/${SPAWN_MODEL}`, "fallback");
	const servingModel = options.transcript === "handoff" ? HANDOFF_MODEL : SPAWN_MODEL;
	child.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: notes } }],
		api: "mock",
		provider: "mock",
		model: servingModel,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	await child.close();

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const readResults: Record<string, string[]> = { [SPAWN_MODEL]: [], [HANDOFF_MODEL]: [] };
	const readEfforts: Record<string, (string | undefined)[]> = { [SPAWN_MODEL]: [], [HANDOFF_MODEL]: [] };
	const mocks = [SPAWN_MODEL, HANDOFF_MODEL].map(id =>
		Object.assign(
			createMockModel({
				id,
				reasoning: true,
				handler: (context, streamOptions) => {
					const last = context.messages.at(-1);
					if (last?.role !== "toolResult" || last.toolName !== "read") return { content: ["label"] };
					readResults[id]!.push(JSON.stringify(last.content));
					readEfforts[id]!.push(streamOptions?.reasoning);
					return { content: [`restored: 42 (${id})`] };
				},
			}),
			{ thinking },
		),
	);
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [...mocks, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: `mock/${SPAWN_MODEL}` },
		defaultThinkingLevel: Effort.Medium,
	});
	const session = {
		sessionManager: {
			getSessionFile: () => mainFile,
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		asyncJobManager: manager,
		settings,
		effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
		preparedExtensions: undefined,
		restoreInterruptedTurn: async () => false,
	} as unknown as AgentSession;
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({ session, authStorage, modelRegistry, settings, enableLsp: false }),
		() => 0,
	);
	const delivered = Promise.withResolvers<string>();
	manager.registerDeliverySink(MAIN_AGENT_ID, (_jobId, text) => {
		delivered.resolve(text);
	});

	try {
		const outcome = await restoreSession(session);
		expect(outcome.subagents).toEqual([AGENT_ID]);
		return { delivered: await delivered.promise, readResults, readEfforts };
	} finally {
		authStorage.close();
	}
}

it("revives a subagent a crash cut off mid tool call, runs the call again, and delivers its answer to the parent", async () => {
	const { delivered, readResults } = await restoreInterruptedChild();

	expect(delivered).toContain(`restored: 42 (${SPAWN_MODEL})`);
	expect(readResults[SPAWN_MODEL]).toHaveLength(1);
	expect(readResults[SPAWN_MODEL]![0]).toContain("the answer is 42");
}, 20_000);

it("revives a subagent on the model and effort a prewalk handoff switched it to, not its spawn model", async () => {
	const { delivered, readResults, readEfforts } = await restoreInterruptedChild({ transcript: "handoff" });

	expect(delivered).toContain(`restored: 42 (${HANDOFF_MODEL})`);
	expect(readResults[HANDOFF_MODEL]).toHaveLength(1);
	expect(readResults[SPAWN_MODEL]).toEqual([]);
	expect(readEfforts[HANDOFF_MODEL]).toEqual([Effort.High]);
}, 20_000);

it("revives a subagent whose handoff target failed over on the spawn model, not the failed target", async () => {
	const { delivered, readResults } = await restoreInterruptedChild({ transcript: "fallback" });

	expect(delivered).toContain(`restored: 42 (${SPAWN_MODEL})`);
	expect(readResults[SPAWN_MODEL]).toHaveLength(1);
	expect(readResults[HANDOFF_MODEL]).toEqual([]);
}, 20_000);

async function thinkingFixture() {
	const cwd = path.join(root, "home", "thinking-work");
	await fs.mkdir(cwd, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("openai", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = Object.assign(
		createMockModel({ provider: "openai", reasoning: true, handler: { content: ["continued with saved thinking"] } }),
		{ thinking: { mode: "effort" as const, efforts: [ThinkingLevel.Low, ThinkingLevel.Medium, ThinkingLevel.High] } },
	);
	const catalogAvailable = modelRegistry.getAvailableForProviders.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailableForProviders").mockImplementation((providers, kind) => [
		...(providers.has(mock.provider) ? [mock] : []),
		...catalogAvailable(providers, kind),
	]);
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([mock]);
	const catalogFind = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
		provider === mock.provider && id === mock.id ? mock : catalogFind(provider, id),
	);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "openai/mock-model" },
	});
	const parent = new AgentSession({
		agent: new Agent({ initialState: { model: mock, thinkingLevel: ThinkingLevel.Low } }),
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		modelRegistry,
		thinkingLevel: ThinkingLevel.Low,
		thinkingOrigin: "caller",
	});
	return { cwd, authStorage, modelRegistry, mock, settings, parent };
}

for (const level of [ThinkingLevel.High, ThinkingLevel.Off]) {
	it(`restores a cold subagent's ${level} thinking edit and fast mode over its original :low spawn selector`, async () => {
		const { cwd, authStorage, modelRegistry, mock, settings, parent } = await thinkingFixture();
		const main = SessionManager.create(cwd, path.join(root, "sessions"));
		main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted parent");
		await main.close();
		const child = await SessionManager.open(
			path.join(mainFile.slice(0, -6), `${AGENT_ID}.jsonl`),
			undefined,
			undefined,
			{ initialCwd: cwd, parentSession: mainFile, suppressBreadcrumb: true },
		);
		child.appendSessionInit({
			systemPrompt: ["test"],
			task: "continue the interrupted request",
			tools: [],
			restrictToolNames: true,
			agent: "task",
			resolvedModel: "openai/mock-model:low",
		});
		child.appendModelChange("openai/mock-model:low");
		child.appendThinkingLevelChange(ThinkingLevel.Low, ThinkingLevel.Low, "caller");
		const original = new AgentSession({
			agent: new Agent({ initialState: { model: mock, thinkingLevel: ThinkingLevel.Low } }),
			sessionManager: child,
			settings,
			modelRegistry,
			thinkingLevel: ThinkingLevel.Low,
			thinkingOrigin: "caller",
		});
		// A control edit occurs while a user turn is pending, before the process disappears.
		child.appendMessage({ role: "user", content: "continue the interrupted request", timestamp: Date.now() });
		original.setThinkingLevel(level);
		expect(original.setFastMode(true)).toBe(true);
		expect(parent.isFastModeEnabled()).toBe(false);
		await original.dispose();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();

		const owner = {
			sessionManager: {
				getSessionFile: () => mainFile,
				getCwd: () => cwd,
				getArtifactManager: () => undefined,
			},
			asyncJobManager: manager,
			settings,
			effectiveExtensionRoots: { explicit: [], mode: "explicit-only", configured: [], configuredLevel: "user" },
			preparedExtensions: undefined,
			restoreInterruptedTurn: async () => false,
		} as unknown as AgentSession;
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: owner,
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
			}),
			() => 0,
		);
		const delivered = Promise.withResolvers<string>();
		manager.registerDeliverySink(MAIN_AGENT_ID, (_jobId, text) => delivered.resolve(text));
		try {
			expect((await restoreSession(owner)).subagents).toEqual([AGENT_ID]);
			expect(await delivered.promise).toContain("continued with saved thinking");
			const revived = AgentRegistry.global().get(AGENT_ID)?.session;
			expect(revived?.configuredThinkingLevel()).toBe(level);
			expect(revived?.effortOrigin).toBe("manual");
			expect(revived?.model?.id).toBe(mock.id);
			expect(revived?.isFastModeEnabled()).toBe(true);
			expect(parent.isFastModeEnabled()).toBe(false);
			const request = mock.calls.at(-1);
			expect(request).toBeDefined();
			expect(request?.options?.reasoning).toBe(level === ThinkingLevel.Off ? undefined : ThinkingLevel.High);
			expect(request?.options?.disableReasoning).toBe(level === ThinkingLevel.Off);
			expect(request?.options?.serviceTier).toBe("priority");
		} finally {
			await AgentLifecycleManager.global().dispose();
			await parent.dispose();
			authStorage.close();
		}
	}, 20_000);

	it(`keeps a warm subagent's ${level} thinking edit and fast mode after parking and repeated revival`, async () => {
		const { cwd, authStorage, modelRegistry, mock, settings, parent } = await thinkingFixture();
		try {
			const result = await runSubprocess({
				cwd,
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled", tools: [] },
				task: "initial request",
				index: 0,
				id: AGENT_ID,
				authStorage,
				modelRegistry,
				settings,
				modelOverride: "openai/mock-model:low",
				callerModelSelector: "openai/mock-model:low",
				structured: false,
				restrictToolNames: true,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
				keepAlive: true,
				artifactsDir: cwd,
			});
			expect(result.exitCode).toBe(0);
			const original = AgentRegistry.global().get(AGENT_ID)?.session;
			if (!original) throw new Error("Expected a live subagent");
			original.setThinkingLevel(level);
			expect(original.setFastMode(true)).toBe(true);
			expect(parent.isFastModeEnabled()).toBe(false);
			for (let revive = 0; revive < 2; revive++) {
				await AgentLifecycleManager.global().park(AGENT_ID);
				const session = await AgentLifecycleManager.global().ensureLive(AGENT_ID);
				expect(session.configuredThinkingLevel()).toBe(level);
				expect(session.effortOrigin).toBe("manual");
				expect(session.isFastModeEnabled()).toBe(true);
				expect(parent.isFastModeEnabled()).toBe(false);
				await session.prompt("follow up with saved thinking");
				await session.waitForIdle();
				expect(mock.calls.at(-1)?.options?.reasoning).toBe(
					level === ThinkingLevel.Off ? undefined : ThinkingLevel.High,
				);
				expect(mock.calls.at(-1)?.options?.disableReasoning).toBe(level === ThinkingLevel.Off);
				expect(mock.calls.at(-1)?.options?.serviceTier).toBe("priority");
			}
		} finally {
			await AgentLifecycleManager.global().dispose();
			await parent.dispose();
			authStorage.close();
		}
	}, 20_000);
}

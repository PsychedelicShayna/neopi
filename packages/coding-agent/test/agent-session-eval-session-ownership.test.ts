import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { ExecutorBackendResult } from "../src/eval/backend";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AgentSession } from "../src/session/agent-session";
import type { AuthStorage } from "../src/session/auth-storage";
import { EventBus } from "../src/utils/event-bus";
import { SessionManager } from "../src/session/session-manager";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const result: ExecutorBackendResult = {
	output: "origin-only-output",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	artifactId: undefined,
	displayOutputs: [],
	totalLines: 1,
	totalBytes: 18,
	outputLines: 1,
	outputBytes: 18,
};
const code = "origin-only-code";

describe("AgentSession eval transcript ownership", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let managers: SessionManager[];
	let contexts: string[];

	beforeEach(async () => {
		resetSettingsForTest();
		temp = TempDir.createSync("@pi-eval-transcript-owner-");
		await Settings.init({ inMemory: true, cwd: temp.path() });
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("anthropic", "test-key");
		managers = [];
		contexts = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		await Promise.all(managers.map(manager => manager.close()));
		auth.close();
		temp.removeSync();
		resetSettingsForTest();
	});

	async function seededManager(): Promise<SessionManager> {
		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		manager.appendModelChange("anthropic/claude-sonnet-4-5");
		manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("seed reply"));
		await manager.ensureOnDisk();
		managers.push(manager);
		return manager;
	}

	async function setup(options?: { hook?: boolean; inMemory?: boolean }) {
		const manager = options?.inMemory ? SessionManager.inMemory(temp.path()) : await seededManager();
		const started = Promise.withResolvers<void>();
		const completion = Promise.withResolvers<ExecutorBackendResult>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerEvalBackend({
					id: "custom",
					aliases: ["customalias"],
					label: "Custom",
					highlightLang: "text",
					modelVisible: true,
					isAvailable: () => true,
					execute: async () => {
						started.resolve();
						return await completion.promise;
					},
				});
				pi.registerEvalBackend({
					id: "independent",
					aliases: [],
					label: "Independent",
					highlightLang: "text",
					modelVisible: true,
					isAvailable: () => true,
					execute: async () => ({ ...result, output: "independent-output" }),
				});
				if (options?.hook) {
					pi.on("user_eval", async () => {
						started.resolve();
						return { result: await completion.promise };
					});
				}
			},
			temp.path(),
			new EventBus(),
			runtime,
		);
		const registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
		const runner = new ExtensionRunner([extension], runtime, temp.path(), manager, registry);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const mock = createMockModel({
			handler: context => {
				contexts.push(JSON.stringify(context.messages));
				return { content: ["Done"] };
			},
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"chronicler.enabled": false,
				"advisor.enabled": false,
			}),
			modelRegistry: registry,
			extensionRunner: runner,
		});
		return { started, completion, originFile: manager.getSessionFile() };
	}

	async function switchTarget(): Promise<string> {
		const manager = await seededManager();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted target");
		await manager.close();
		return file;
	}

	async function open(file: string): Promise<SessionManager> {
		const manager = await SessionManager.open(file, temp.join("sessions"), undefined, {
			initialCwd: temp.path(),
			suppressBreadcrumb: true,
		});
		managers.push(manager);
		return manager;
	}

	function evalMessages(manager: SessionManager) {
		return manager
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "evalExecution" ? [entry.message] : []));
	}

	for (const transition of ["new", "resume"] as const) {
		it.each([false, true])(
			`keeps a late result in its originating session after ${transition} (cancelled=%s)`,
			async cancelled => {
				const { started, completion, originFile } = await setup();
				const onRecorded = vi.fn();
				const running = session.executeEval("customalias", code, undefined, { onRecorded });
				await started.promise;
				if (transition === "new") await session.newSession();
				else await session.switchSession(await switchTarget());
				completion.resolve({ ...result, cancelled });
				await running;

				expect(session.messages.filter(message => message.role === "evalExecution")).toEqual([]);
				expect(evalMessages(session.sessionManager)).toEqual([]);
				expect(onRecorded).toHaveBeenCalledTimes(1);
				expect(onRecorded.mock.calls[0]?.[0]).toMatchObject({ code, output: result.output, cancelled });
				if (!originFile) throw new Error("Expected origin file");
				expect(evalMessages(await open(originFile))).toEqual([
					expect.objectContaining({ code, output: result.output, cancelled }),
				]);

				await session.prompt("replacement session prompt");
				await session.waitForIdle();
				expect(contexts.length).toBeGreaterThan(0);
				expect(contexts.join()).not.toContain(code);
				expect(contexts.join()).not.toContain(result.output);
				await session.sessionManager.flush();
				const replacementFile = session.sessionFile;
				if (!replacementFile) throw new Error("Expected persisted replacement");
				expect(evalMessages(await open(replacementFile))).toEqual([]);
			},
		);
	}

	it("keeps an asynchronous user_eval replacement in its original transcript", async () => {
		const { started, completion, originFile } = await setup({ hook: true });
		const onRecorded = vi.fn();
		const running = session.executeEval("custom", code, undefined, { onRecorded });
		await started.promise;
		await session.newSession();
		completion.resolve(result);
		await running;
		expect(session.messages.filter(message => message.role === "evalExecution")).toEqual([]);
		expect(onRecorded).toHaveBeenCalledTimes(1);
		if (!originFile) throw new Error("Expected origin file");
		expect(evalMessages(await open(originFile))).toEqual([expect.objectContaining({ code })]);
	});

	it("does not flush a streaming result into the next session", async () => {
		const { started, completion, originFile } = await setup();
		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const onRecorded = vi.fn();
		const running = session.executeEval("custom", code, undefined, { onRecorded });
		await started.promise;
		completion.resolve(result);
		await running;
		expect(session.hasPendingPythonMessages).toBe(true);
		expect(onRecorded).toHaveBeenCalledTimes(1);
		streaming = false;
		await session.newSession();
		await session.prompt("flush in replacement");
		await session.waitForIdle();
		expect(session.hasPendingPythonMessages).toBe(false);
		expect(evalMessages(session.sessionManager)).toEqual([]);
		expect(contexts.join()).not.toContain(code);
		if (!originFile) throw new Error("Expected origin file");
		expect(evalMessages(await open(originFile))).toEqual([expect.objectContaining({ code })]);
		expect(onRecorded).toHaveBeenCalledTimes(1);
	});

	it("waits for an in-progress session replacement before recording a completion", async () => {
		const { started, completion, originFile } = await setup();
		const onRecorded = vi.fn();
		const running = session.executeEval("custom", code, undefined, { onRecorded });
		await started.promise;
		const entered = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const manager = session.sessionManager;
		const originalNew = manager.newSession.bind(manager);
		vi.spyOn(manager, "newSession").mockImplementationOnce(async options => {
			entered.resolve();
			await proceed.promise;
			return await originalNew(options);
		});
		const switching = session.newSession();
		await entered.promise;
		try {
			completion.resolve(result);
			// Drain ready promise continuations without a wall-clock delay.
			await yieldToEventLoop();
			expect(onRecorded).not.toHaveBeenCalled();
			expect(session.messages.filter(message => message.role === "evalExecution")).toEqual([]);
		} finally {
			proceed.resolve();
			await switching;
		}
		await running;
		expect(evalMessages(manager)).toEqual([]);
		if (!originFile) throw new Error("Expected origin file");
		expect(evalMessages(await open(originFile))).toEqual([expect.objectContaining({ code })]);
		expect(onRecorded).toHaveBeenCalledTimes(1);
	});

	it("records into the restored origin after a failed switch rolls back", async () => {
		const { started, completion, originFile } = await setup();
		const targetFile = await switchTarget();
		const onRecorded = vi.fn();
		const running = session.executeEval("custom", code, undefined, { onRecorded });
		await started.promise;
		const entered = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		vi.spyOn(session.settings, "attachSessionFile").mockImplementationOnce(async () => {
			entered.resolve();
			await proceed.promise;
			throw new Error("synthetic settings failure");
		});
		const switching = session.switchSession(targetFile);
		try {
			await Promise.race([
				entered.promise,
				switching.then(() => {
					throw new Error("Switch completed before the settings failure gate");
				}),
			]);
			completion.resolve({ ...result, cancelled: true });
			proceed.resolve();
			await expect(switching).rejects.toThrow("synthetic settings failure");
		} finally {
			completion.resolve({ ...result, cancelled: true });
			proceed.resolve();
			await Promise.allSettled([switching, running]);
		}
		expect(session.sessionFile).toBe(originFile);
		expect(session.messages.filter(message => message.role === "evalExecution")).toEqual([
			expect.objectContaining({ code, cancelled: true }),
		]);
		await session.sessionManager.flush();
		if (!originFile) throw new Error("Expected origin file");
		expect(evalMessages(await open(originFile))).toHaveLength(1);
		expect(evalMessages(await open(targetFile))).toEqual([]);
		expect(onRecorded).toHaveBeenCalledTimes(1);
	});

	it("keeps same-session cancellation and new-session executions recordable", async () => {
		const { started, completion } = await setup();
		const onRecorded = vi.fn();
		const running = session.executeEval("custom", code, undefined, { onRecorded });
		await started.promise;
		session.abortEval();
		completion.resolve({ ...result, cancelled: true });
		await running;
		expect(evalMessages(session.sessionManager)).toEqual([expect.objectContaining({ code, cancelled: true })]);
		expect(onRecorded).toHaveBeenCalledTimes(1);
		await session.newSession();
		await session.executeEval("custom", "replacement-only-code");
		expect(evalMessages(session.sessionManager)).toEqual([
			expect.objectContaining({ code: "replacement-only-code" }),
		]);
	});

	it("does not leak a late in-memory result into a replacement transcript", async () => {
		const { started, completion } = await setup({ inMemory: true });
		const onRecorded = vi.fn();
		const running = session.executeEval("custom", code, undefined, { onRecorded });
		await started.promise;
		await session.newSession();
		completion.resolve(result);
		await running;
		expect(evalMessages(session.sessionManager)).toEqual([]);
		expect(session.messages.filter(message => message.role === "evalExecution")).toEqual([]);
		expect(onRecorded).toHaveBeenCalledTimes(1);
	});

	it("keeps a late result on its original branch after tree navigation", async () => {
		const { started, completion } = await setup();
		const manager = session.sessionManager;
		const originalLeaf = manager.getLeafId();
		const userEntry = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Expected user entry");
		const running = session.executeEval("custom", code);
		await started.promise;
		await session.navigateTree(userEntry.id);
		completion.resolve(result);
		await running;
		const entry = manager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "evalExecution");
		expect(entry?.parentId).toBe(originalLeaf);
		expect(manager.getLeafId()).toBe(userEntry.parentId);
		expect(session.messages.filter(message => message.role === "evalExecution")).toEqual([]);
	});

	it("does not recreate a dropped origin for a late eval result", async () => {
		const { started, completion, originFile } = await setup();
		if (!originFile) throw new Error("Expected origin file");
		const running = session.executeEval("custom", code);
		await started.promise;
		await session.newSession({ drop: true });
		expect(await Bun.file(originFile).exists()).toBe(false);
		completion.resolve(result);
		await running;
		expect(await Bun.file(originFile).exists()).toBe(false);
		expect(evalMessages(session.sessionManager)).toEqual([]);
	});

	it("keeps independent backends runnable while an origin's eval is still settling", async () => {
		const { started, completion, originFile } = await setup();
		const running = session.executeEval("custom", code);
		await started.promise;
		await session.newSession();
		await session.executeEval("independent", "replacement-independent-code");
		expect(session.isEvalLanguageRunning("custom")).toBe(true);
		expect(evalMessages(session.sessionManager)).toEqual([
			expect.objectContaining({ code: "replacement-independent-code", output: "independent-output" }),
		]);
		completion.resolve(result);
		await running;
		expect(evalMessages(session.sessionManager)).toHaveLength(1);
		if (!originFile) throw new Error("Expected origin file");
		expect(evalMessages(await open(originFile))).toEqual([expect.objectContaining({ code })]);
	});

	it("releases the detached transcript after flushing a queued result during disposal", async () => {
		const { started, completion } = await setup();
		const manager = session.sessionManager;
		const clone = manager.cloneCurrentSession.bind(manager);
		let detached: SessionManager | undefined;
		let closeDetached: (() => Promise<void>) | undefined;
		const closed = vi.fn();
		vi.spyOn(manager, "cloneCurrentSession").mockImplementationOnce(options => {
			detached = clone(options);
			closeDetached = detached.close.bind(detached);
			vi.spyOn(detached, "close").mockImplementationOnce(async () => {
				await closeDetached?.();
				closed();
			});
			return detached;
		});
		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const onRecorded = vi.fn();
		const running = session.executeEval("custom", code, undefined, { onRecorded });
		await started.promise;
		completion.resolve(result);
		await running;
		streaming = false;
		await session.newSession();
		expect(closed).not.toHaveBeenCalled();
		await session.dispose();
		expect(closed).toHaveBeenCalledTimes(1);
		expect(detached && evalMessages(detached)).toEqual([expect.objectContaining({ code })]);
		expect(session.hasPendingPythonMessages).toBe(false);
		expect(onRecorded).toHaveBeenCalledTimes(1);
	});
});

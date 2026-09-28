import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AsyncJobManager ownership across concurrent top-level roots", () => {
	const tempDirs: string[] = [];
	// Building a ModelRegistry per session is the dominant cost here: createAgentSession
	// otherwise runs discoverAuthStorage (a fresh AuthStorage DB create+reload) and a
	// background online model refresh for every spawn (~450ms each). Job-domain
	// ownership is independent of model resolution, so every session shares one
	// network-free registry built once (~10ms/session instead).
	let sharedTempDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-async-roots-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedTempDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedTempDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedTempDir);
	});

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	async function spawnTopLevelSession(options: {
		agentId?: string;
		settings?: Record<string, unknown>;
		extensions?: ExtensionFactory[];
	}) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-roots-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			agentId: options.agentId,
			settings: Settings.isolated({ "bash.autoBackground.enabled": true, ...options.settings }),
			disableExtensionDiscovery: true,
			extensions: options.extensions ?? [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: sharedModelRegistry,
		});
		return session;
	}

	function registerGatedJob(manager: AsyncJobManager, ownerId: string) {
		const release = Promise.withResolvers<void>();
		const jobId = manager.register(
			"bash",
			"gated",
			async ({ signal }) => {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await Promise.race([release.promise, aborted.promise]);
				return signal.aborted ? "aborted" : "completed";
			},
			{ ownerId },
		);
		return { jobId, release: () => release.resolve() };
	}

	it("keeps a root's running jobs and its manager usable after another root disposes", async () => {
		const primaryId = `RootA-${Snowflake.next()}`;
		const primary = await spawnTopLevelSession({ agentId: primaryId });
		try {
			const primaryManager = primary.asyncJobManager;
			expect(primaryManager).toBeDefined();
			const gated = registerGatedJob(primaryManager!, primaryId);

			const secondary = await spawnTopLevelSession({ agentId: `RootB-${Snowflake.next()}` });
			try {
				expect(secondary.asyncJobManager).toBeDefined();
				expect(secondary.asyncJobManager).not.toBe(primaryManager);
				expect(secondary.getAsyncJobSnapshot()?.running).toEqual([]);
			} finally {
				await secondary.dispose();
			}

			expect(primaryManager!.getJob(gated.jobId)?.status).toBe("running");
			expect(primary.getAsyncJobSnapshot()?.running.map(job => job.id)).toEqual([gated.jobId]);
			gated.release();
			await primaryManager!.waitForAll();
			expect(primaryManager!.getJob(gated.jobId)?.status).toBe("completed");

			// Another root's disposal must not have torn down this root's manager.
			const next = registerGatedJob(primaryManager!, primaryId);
			next.release();
			await primaryManager!.waitForAll();
			expect(primaryManager!.getJob(next.jobId)?.status).toBe("completed");
		} finally {
			await primary.dispose();
		}
	}, 60000);

	it("exposes the owning root's jobs through a production extension context", async () => {
		let observedSnapshot: AsyncJobSnapshot | null | undefined;
		const snapshotExtension: ExtensionFactory = pi => {
			pi.registerTool({
				name: "capture_async_job_snapshot",
				label: "Capture async job snapshot",
				description: "Capture the session-owned async job snapshot for this test.",
				parameters: type({}),
				approval: "read",
				async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
					observedSnapshot = ctx.getAsyncJobSnapshot();
					return { content: [{ type: "text", text: "captured" }] };
				},
			});
		};
		const session = await spawnTopLevelSession({ extensions: [snapshotExtension] });
		const manager = session.asyncJobManager;
		expect(manager).toBeDefined();
		const gated = registerGatedJob(manager!, MAIN_AGENT_ID);

		try {
			const snapshotTool = session.getToolByName("capture_async_job_snapshot");
			expect(snapshotTool).toBeDefined();
			await snapshotTool!.execute("call-snapshot", {});

			expect(observedSnapshot?.running.some(job => job.id === gated.jobId)).toBe(true);
		} finally {
			gated.release();
			await manager!.waitForAll();
			await session.dispose();
		}
	}, 60000);

	it("runs async bash from each root in that root's own job domain", async () => {
		const primary = await spawnTopLevelSession({
			agentId: `RootA-${Snowflake.next()}`,
			settings: { "async.enabled": true },
		});
		const secondary = await spawnTopLevelSession({
			agentId: `RootB-${Snowflake.next()}`,
			settings: { "async.enabled": true },
		});
		try {
			const primaryManager = primary.asyncJobManager!;
			const secondaryManager = secondary.asyncJobManager!;
			const primaryResult = await primary
				.getToolByName("bash")!
				.execute("call-a", { command: "echo a", async: true });
			const secondaryResult = await secondary
				.getToolByName("bash")!
				.execute("call-b", { command: "echo b", async: true });
			const primaryJobId = (primaryResult.details as { async?: { jobId?: string } }).async?.jobId;
			const secondaryJobId = (secondaryResult.details as { async?: { jobId?: string } }).async?.jobId;
			expect(primaryJobId).toBeDefined();
			expect(secondaryJobId).toBeDefined();

			await Promise.all([primaryManager.waitForAll(), secondaryManager.waitForAll()]);
			expect(primaryManager.getAllJobs().map(job => job.ownerId)).toEqual([primary.getAgentId()]);
			expect(secondaryManager.getAllJobs().map(job => job.ownerId)).toEqual([secondary.getAgentId()]);
			expect(primaryManager.getJob(primaryJobId!)?.resultText).toContain("a");
			expect(secondaryManager.getJob(secondaryJobId!)?.resultText).toContain("b");
		} finally {
			await secondary.dispose();
			await primary.dispose();
		}
	}, 60000);

	it("releases the default root id when top-level startup fails", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-async-startup-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: sharedModelRegistry,
				systemPrompt: () => {
					throw new Error("forced startup failure");
				},
			}),
		).rejects.toThrow("forced startup failure");

		expect(AgentRegistry.global().get(MAIN_AGENT_ID)).toBeUndefined();

		const replacement = await spawnTopLevelSession({});
		try {
			expect(replacement.getAgentId()).toBe(MAIN_AGENT_ID);
			expect(replacement.getAsyncJobSnapshot()).not.toBeNull();
		} finally {
			await replacement.dispose();
		}
	}, 60000);
});

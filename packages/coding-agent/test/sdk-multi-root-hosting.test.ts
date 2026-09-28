import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, Context, ToolCall } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentIdConflictError, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Issue #121 acceptance: two simultaneous top-level roots hosted in one
// process. A scripted local provider drives real createAgentSession roots and
// real task subagents; no paid model is involved.
const API = "multi-root-scripted";
const API_SOURCE = "multi-root-hosting-test";
const PROVIDER = "multi-root";
const MODEL_ID = "scripted";

/** Assignment markers the scripted model reacts to. */
const NEST = "SPAWN-NESTED";
const HOLD = "HOLD:";

const gates = new Map<string, PromiseWithResolvers<void>>();
function gate(key: string): PromiseWithResolvers<void> {
	let entry = gates.get(key);
	if (!entry) {
		entry = Promise.withResolvers<void>();
		gates.set(key, entry);
	}
	return entry;
}

function textOf(message: Context["messages"][number]): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(part => (part.type === "text" ? part.text : "")).join("");
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: `call-${name}-${Bun.nanoseconds()}`, name, arguments: args };
}

/** Roots answer plain text; subagents optionally spawn one nested `Research`, then yield. */
function reply(context: Context): AssistantMessage {
	const yieldTool = (context.tools ?? []).find(tool => tool.name === "yield");
	const message = createAssistantMessage(yieldTool ? "" : "ack");
	message.api = API;
	message.provider = PROVIDER;
	message.model = MODEL_ID;
	if (!yieldTool) return message;
	const assignment = context.messages
		.filter(m => m.role === "user")
		.map(textOf)
		.join("\n");
	const spawned = context.messages.some(m => m.role === "toolResult" && m.toolName === "task");
	const keySchema = (yieldTool.parameters as { properties?: { key?: { enum?: number[] } } }).properties?.key;
	message.content = [
		assignment.includes(NEST) && !spawned
			? toolCall("task", { name: "Research", agent: "task", task: "LEAF work" })
			: toolCall(
					"yield",
					keySchema?.enum ? { key: keySchema.enum[0], data: { report: "pooled" } } : { data: { report: "done" } },
				),
	];
	message.stopReason = "toolUse";
	return message;
}

function holdKey(context: Context): string | undefined {
	if (context.messages.some(m => m.role === "assistant")) return undefined;
	const assignment = context.messages
		.filter(m => m.role === "user")
		.map(textOf)
		.join("\n");
	const match = assignment.match(/HOLD:(\w+)/);
	return match?.[1];
}

interface Root {
	session: AgentSession;
	cwd: string;
	lifecycleIds: Set<string>;
}

describe("two simultaneous top-level roots (issue #121)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const live: AgentSession[] = [];

	beforeEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		gates.clear();
		tempDir = TempDir.createSync("@pi-multi-root-");
		registerCustomApi(
			API,
			(_model, context, options) => {
				const stream = new AssistantMessageEventStream();
				void (async () => {
					const key = holdKey(context);
					if (key) {
						const signal = options?.signal;
						const aborted = Promise.withResolvers<void>();
						signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
						await Promise.race([gate(key).promise, aborted.promise]);
						if (signal?.aborted) {
							const error = createAssistantMessage("");
							error.stopReason = "aborted";
							stream.push({ type: "error", reason: "aborted", error });
							return;
						}
					}
					const message = reply(context);
					const call = message.content.find(part => part.type === "toolCall");
					if (call) {
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
						stream.push({ type: "done", reason: "toolUse", message });
					} else {
						stream.push({ type: "done", reason: "stop", message });
					}
				})();
				return stream;
			},
			API_SOURCE,
		);
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
		modelRegistry.registerProvider(PROVIDER, {
			baseUrl: "http://127.0.0.1:9",
			apiKey: "test-key",
			api: API,
			models: [
				{
					id: MODEL_ID,
					name: "Scripted",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	});

	afterEach(async () => {
		for (const entry of gates.values()) entry.resolve();
		for (const session of live.splice(0).reverse()) await session.dispose();
		unregisterCustomApis(API_SOURCE);
		authStorage.close();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir.removeSync();
	});

	async function createRoot(agentId: string | undefined, options: { sessionFile?: string } = {}): Promise<Root> {
		const label = agentId ?? MAIN_AGENT_ID;
		const cwd = tempDir.join(`ws-${label}`);
		fs.mkdirSync(cwd, { recursive: true });
		const sessionManager = options.sessionFile
			? await SessionManager.open(options.sessionFile)
			: SessionManager.create(cwd, tempDir.join(`sessions-${label}`));
		const created = await createAgentSession({
			cwd,
			agentDir: tempDir.join(`agent-${label}`),
			agentId,
			sessionManager,
			authStorage,
			modelRegistry,
			model: modelRegistry.find(PROVIDER, MODEL_ID),
			// Each workspace gets its own effective settings.
			settings: Settings.isolated({
				"async.enabled": true,
				"compaction.enabled": false,
				"task.isolation.mode": "none",
				"task.enableLsp": false,
				modelRoles: { default: `${PROVIDER}/${MODEL_ID}` },
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["task", "bash", "read", "eval"],
		});
		live.push(created.session);
		const lifecycleIds = new Set<string>();
		created.subagentEventBus?.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
			lifecycleIds.add((payload as { id: string }).id);
		});
		return { session: created.session, cwd, lifecycleIds };
	}

	async function spawn(root: Root, task: string): Promise<string> {
		const result = await root.session
			.getToolByName("task")!
			.execute(`call-${Bun.nanoseconds()}`, { name: "Research", agent: "task", task });
		const jobId = (result.details as { async?: { jobId?: string } } | undefined)?.async?.jobId;
		if (!jobId) throw new Error(`task did not start async: ${JSON.stringify(result.content)}`);
		return jobId;
	}

	async function asyncBash(root: Root, command: string): Promise<string> {
		const result = await root.session
			.getToolByName("bash")!
			.execute(`call-${Bun.nanoseconds()}`, { command, async: true });
		const jobId = (result.details as { async?: { jobId?: string } } | undefined)?.async?.jobId;
		if (!jobId) throw new Error(`bash did not start async: ${JSON.stringify(result.content)}`);
		return jobId;
	}

	async function settle(root: Root): Promise<void> {
		await root.session.asyncJobManager!.waitForAll();
		while (root.session.hasPendingAsyncWork()) await root.session.settleAsyncWork();
		await root.session.waitForIdle();
	}

	function transcript(root: Root): string {
		return JSON.stringify(root.session.agent.state.messages);
	}

	function artifacts(root: Root): string[] {
		const dir = root.session.sessionManager.getArtifactsDir();
		return dir ? (fs.readdirSync(dir, { recursive: true }) as string[]).map(entry => entry.toString()) : [];
	}

	it("1: keeps two live roots registered and runs async bash/workpool/task in each, including racing construction", async () => {
		const a = await createRoot("DeckA");
		const b = await createRoot("DeckB");
		const registry = AgentRegistry.global();
		expect(registry.get("DeckA")?.session).toBe(a.session);
		expect(registry.get("DeckB")?.session).toBe(b.session);
		expect(a.session.asyncJobManager).toBeDefined();
		expect(a.session.asyncJobManager).not.toBe(b.session.asyncJobManager);

		const pool = 'const pool = await workpool("task", { name: "pool" }); return await pool.push("POOL item");';
		const [bashA, bashB, taskA, taskB] = await Promise.all([
			asyncBash(a, "echo from-a"),
			asyncBash(b, "echo from-b"),
			spawn(a, "plain work"),
			spawn(b, "plain work"),
			a.session.getToolByName("eval")!.execute("eval-a", { language: "js", code: pool }),
			b.session.getToolByName("eval")!.execute("eval-b", { language: "js", code: pool }),
		]);
		await Promise.all([settle(a), settle(b)]);
		const jobsA = a.session.asyncJobManager!.getAllJobs();
		const jobsB = b.session.asyncJobManager!.getAllJobs();
		expect(jobsA.find(job => job.id === bashA)?.status).toBe("completed");
		expect(jobsB.find(job => job.id === bashB)?.status).toBe("completed");
		expect(jobsA.find(job => job.id === taskA)?.status).toBe("completed");
		expect(jobsB.find(job => job.id === taskB)?.status).toBe("completed");
		expect(jobsA.some(job => job.id === "pool")).toBe(true);
		expect(jobsB.some(job => job.id === "pool")).toBe(true);
		expect(jobsA.every(job => job.ownerId?.startsWith("DeckA"))).toBe(true);
		expect(jobsB.every(job => job.ownerId?.startsWith("DeckB"))).toBe(true);

		// Overlapping construction: distinct ids both succeed with their own domains.
		const [c, d] = await Promise.all([createRoot("DeckC"), createRoot("DeckD")]);
		expect(c.session.asyncJobManager).not.toBe(d.session.asyncJobManager);
		expect(registry.get("DeckC")?.session).toBe(c.session);
		expect(registry.get("DeckD")?.session).toBe(d.session);
		// Overlapping construction of one id: exactly one generation wins.
		const race = await Promise.allSettled([createRoot("DeckRace"), createRoot("DeckRace")]);
		const winners = race.filter(r => r.status === "fulfilled");
		const losers = race.filter(r => r.status === "rejected");
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(AgentIdConflictError);
		expect(registry.get("DeckRace")?.session).toBe((winners[0] as PromiseFulfilledResult<Root>).value.session);
	}, 60000);

	it("2+3: scopes same-label children per root and keeps events, jobs, transcripts, and artifacts owned", async () => {
		const a = await createRoot("DeckA");
		const b = await createRoot("DeckB");
		await Promise.all([spawn(a, `${NEST} ${HOLD}a`), spawn(b, `${NEST} ${HOLD}b`)]);
		// Interleave: B's child completes first, then A's.
		gate("b").resolve();
		await settle(b);
		gate("a").resolve();
		await settle(a);

		const registry = AgentRegistry.global();
		for (const [root, id] of [
			[a, "DeckA"],
			[b, "DeckB"],
		] as const) {
			const child = registry.get(`${id}.Research`);
			const nested = registry.get(`${id}.Research.Research`);
			expect(child?.parentId).toBe(id);
			expect(nested?.parentId).toBe(`${id}.Research`);
			expect(registry.rootOf(`${id}.Research.Research`)).toBe(registry.get(id));
			expect([...root.lifecycleIds].sort()).toEqual([`${id}.Research`, `${id}.Research.Research`]);
			const jobIds = root.session
				.asyncJobManager!.getAllJobs()
				.map(job => job.id)
				.sort();
			expect(jobIds).toEqual([`${id}.Research`, `${id}.Research.Research`]);
			const files = artifacts(root);
			expect(files).toContain(`${id}.Research.jsonl`);
			expect(files.some(file => file.endsWith(`${id}.Research.Research.jsonl`))).toBe(true);
			const text = transcript(root);
			// Exactly one delivery of the root's own child result, none of the other root's.
			expect(text.split(JSON.stringify(`<task-result id="${id}.Research"`).slice(1, -1)).length - 1).toBe(1);
			const other = id === "DeckA" ? "DeckB" : "DeckA";
			expect(text).not.toContain(other);
			expect(files.some(file => file.includes(other))).toBe(false);
		}
	}, 60000);

	it("4: aborting A's child and disposing A leave B's same-label work and async domain running", async () => {
		const a = await createRoot("DeckA");
		const b = await createRoot("DeckB");
		const childA = await spawn(a, `${HOLD}a`);
		const childB = await spawn(b, `${HOLD}b`);
		const release = tempDir.join("release-b");
		const bashB = await asyncBash(b, `while [ ! -f '${release}' ]; do sleep 0.02; done; echo b-finished`);

		expect(a.session.asyncJobManager!.cancel(childA)).toBe(true);
		await a.session.asyncJobManager!.waitForAll();
		expect(a.session.asyncJobManager!.getJob(childA)?.status).toBe("cancelled");
		expect(b.session.asyncJobManager!.getJob(childB)?.status).toBe("running");

		await a.session.dispose();
		expect(AgentRegistry.global().get("DeckA")).toBeUndefined();
		expect(b.session.asyncJobManager!.getJob(bashB)?.status).toBe("running");

		fs.writeFileSync(release, "");
		gate("b").resolve();
		await settle(b);
		expect(b.session.asyncJobManager!.getJob(bashB)?.status).toBe("completed");
		expect(b.session.asyncJobManager!.getJob(childB)?.status).toBe("completed");
		const next = await asyncBash(b, "echo again");
		await settle(b);
		expect(b.session.asyncJobManager!.getJob(next)?.resultText).toContain("again");
	}, 60000);

	it("5: recreates and resumes A without stale generations touching the new one or B", async () => {
		const b = await createRoot("DeckB");
		const bRef = AgentRegistry.global().get("DeckB");
		const first = await createRoot("DeckA");
		await spawn(first, "first generation");
		await settle(first);
		const sessionFile = first.session.sessionManager.getSessionFile()!;
		const artifactsDir = first.session.sessionManager.getArtifactsDir()!;
		const priorArtifact = path.join(artifactsDir, "DeckA.Research.jsonl");
		const staleRef = AgentRegistry.global().get("DeckA")!;
		await first.session.dispose();
		// Snapshot after teardown: disposing the child appends its own exit record.
		const priorContent = fs.readFileSync(priorArtifact, "utf8");

		const second = await createRoot("DeckA", { sessionFile });
		const registry = AgentRegistry.global();
		const freshRef = registry.get("DeckA")!;
		expect(freshRef).not.toBe(staleRef);
		const resumedChild = await spawn(second, "second generation");
		await settle(second);
		// Resume reserved the prior id: the new child never overwrites the old artifact.
		expect(resumedChild).toBe("DeckA.Research-2");
		expect(fs.readFileSync(priorArtifact, "utf8")).toBe(priorContent);
		expect(fs.existsSync(path.join(artifactsDir, "DeckA.Research-2.jsonl"))).toBe(true);

		// Stale-generation disposal and cancellation are no-ops for the new generation.
		await first.session.dispose();
		expect(registry.unregister("DeckA", staleRef)).toBe(false);
		expect(registry.setStatus("DeckA", "aborted", staleRef)).toBe(false);
		await AgentLifecycleManager.global().disposeRoot(staleRef);
		expect(registry.get("DeckA")).toBe(freshRef);
		expect(registry.get("DeckA.Research-2")?.session).not.toBeNull();
		expect(registry.get("DeckB")).toBe(bRef);
		const bJob = await asyncBash(b, "echo b-untouched");
		await settle(b);
		expect(b.session.asyncJobManager!.getJob(bJob)?.status).toBe("completed");
	}, 60000);

	it("6: rejects a second default-id root and an explicit duplicate, keeping the originals operational", async () => {
		const main = await createRoot(undefined);
		const registry = AgentRegistry.global();
		const mainRef = registry.get(MAIN_AGENT_ID);
		expect(mainRef?.session).toBe(main.session);
		const before = registry.list().length;
		await expect(createRoot(undefined)).rejects.toBeInstanceOf(AgentIdConflictError);
		expect(registry.get(MAIN_AGENT_ID)).toBe(mainRef);
		expect(registry.list()).toHaveLength(before);
		const mainJob = await asyncBash(main, "echo main-ok");
		await settle(main);
		expect(main.session.asyncJobManager!.getJob(mainJob)?.status).toBe("completed");

		const deck = await createRoot("DeckA");
		const deckRef = registry.get("DeckA");
		await expect(createRoot("DeckA")).rejects.toBeInstanceOf(AgentIdConflictError);
		expect(registry.get("DeckA")).toBe(deckRef);
		const deckJob = await asyncBash(deck, "echo deck-ok");
		await settle(deck);
		expect(deck.session.asyncJobManager!.getJob(deckJob)?.status).toBe("completed");
	}, 60000);

	it("7: drains and disposes both roots without leaking processes, jobs, refs, or overwriting artifacts", async () => {
		const a = await createRoot("DeckA");
		const b = await createRoot("DeckB");
		await Promise.all([spawn(a, "kept alive"), spawn(b, "kept alive")]);
		await Promise.all([settle(a), settle(b)]);
		const artifactA = path.join(a.session.sessionManager.getArtifactsDir()!, "DeckA.Research.jsonl");
		const pids: Record<string, string> = {};
		for (const [root, id] of [
			[a, "a"],
			[b, "b"],
		] as const) {
			pids[id] = tempDir.join(`pid-${id}`);
			await asyncBash(root, `sh -c 'echo $$ > "${pids[id]}"; while true; do sleep 0.02; done'`);
			await spawn(root, `${HOLD}never`);
		}
		const registry = AgentRegistry.global();
		expect(registry.get("DeckA.Research")?.status).toBe("idle");
		while (!fs.existsSync(pids.a!) || !fs.existsSync(pids.b!)) await Bun.sleep(10);

		const drained = await a.session.cancelRootWork({ timeoutMs: 5_000 });
		expect(drained.settled).toBe(true);
		expect(a.session.asyncJobManager!.getRunningJobs()).toEqual([]);
		expect(registry.list().filter(ref => ref.id.startsWith("DeckA."))).toEqual([]);
		// Snapshot after the drain released A's child (its teardown appends an exit record).
		const artifactContent = fs.readFileSync(artifactA, "utf8");
		// B is untouched by A's drain.
		expect(b.session.asyncJobManager!.getRunningJobs().length).toBe(2);
		expect(registry.get("DeckB.Research")?.status).toBe("idle");
		// A stays usable after the drain.
		const again = await asyncBash(a, "echo after-drain");
		await settle(a);
		expect(a.session.asyncJobManager!.getJob(again)?.status).toBe("completed");

		const managerB = b.session.asyncJobManager!;
		await a.session.dispose();
		await b.session.dispose();
		live.length = 0;
		expect(managerB.getAllJobs()).toEqual([]);
		expect(registry.list()).toEqual([]);
		expect(AgentLifecycleManager.global().has("DeckB.Research")).toBe(false);
		for (const file of Object.values(pids)) {
			const pid = Number(fs.readFileSync(file, "utf8").trim());
			expect(() => process.kill(pid, 0)).toThrow();
		}
		expect(fs.readFileSync(artifactA, "utf8")).toBe(artifactContent);
	}, 60000);
});

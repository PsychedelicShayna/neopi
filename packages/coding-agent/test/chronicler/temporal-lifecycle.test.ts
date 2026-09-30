/**
 * End-to-end: real AgentSessions in two projects capture atoms through their
 * own Chronicler lifecycle (mock provider only), the temporal view is built,
 * deleted and rebuilt, and explicit recall finds the atoms with transcript
 * provenance — while nothing is injected into a new session and the recall
 * capability stays off unless granted.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { cfgChroniclerRecallEnabled } from "../../src/chronicler/settings";
import { indexChronicle } from "../../src/chronicler/temporal/indexer";
import { createModelRanker } from "../../src/chronicler/temporal/rank";
import { recallChronicle } from "../../src/chronicler/temporal/recall";
import { createSummarizer } from "../../src/chronicler/temporal/summarize";
import type { IndexConfig } from "../../src/chronicler/temporal/tree";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { resolveBuiltinToolPlan, type ToolSession } from "../../src/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createFakeChronicleModel, type FakeChronicleModel } from "./temporal-fixture";

const CONFIG: IndexConfig = {
	timeZone: "UTC",
	summaryTokens: 500,
	hopTokens: 1000,
	terminalAtoms: 8,
	leadTokens: 120,
	shortNames: false,
};

/** Substantive turns carry the time the capture model reports as the beat's event time. */
const SUBSTANTIVE = /^DECISION \[(?<at>[^\]]+)\]: (?<title>[^.]+)\. (?<body>.+)$/s;

function messageText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/** The pass request being answered: the last user message (earlier passes may linger in context). */
function requestText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index]!;
		if (message.role === "user") return JSON.stringify(message.content);
	}
	return "";
}

describe("chronicle lifecycle: capture → index → recall", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let sessionsDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let primary: MockModel;
	let capture: MockModel;
	let fake: FakeChronicleModel;
	const managers: SessionManager[] = [];
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@chronicle-lifecycle-");
		agentDir = tempDir.path();
		sessionsDir = path.join(agentDir, "sessions");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		fake = createFakeChronicleModel();
		primary = createMockModel({
			id: "primary-mock",
			provider: "mock",
			handler: () => ({ content: ["Noted."], stopReason: "stop" }),
		});
		capture = createMockModel({
			id: "chronicler-capture",
			provider: "mock",
			contextWindow: 200_000,
			handler: captureTurn,
		});
		const available: Model<Api>[] = [primary, capture];
		spyOn(modelRegistry, "getAvailable").mockImplementation(() => [...available]);
		managers.length = 0;
		sessions.length = 0;
	});

	afterEach(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		await tempDir.remove();
	});

	/**
	 * The capture provider behaves like a capture model: among the persisted
	 * entries (read through the public SessionManager API) whose ids occur in
	 * the request, it stages one beat per substantive decision and skips chatter.
	 */
	function captureTurn(context: Context): MockResponse {
		const last = context.messages[context.messages.length - 1];
		if (last?.role === "toolResult") {
			if (last.toolName === "chronicle") {
				return { content: [{ type: "toolCall", name: "finish_chronicle", arguments: { carry: null } }] };
			}
			return { content: ["Capture pass complete."], stopReason: "stop" };
		}
		const request = requestText(context);
		const calls = managers.flatMap(manager =>
			manager.getEntries().flatMap(entry => {
				if (entry.type !== "message" || entry.message.role !== "user" || !request.includes(entry.id)) return [];
				const match = SUBSTANTIVE.exec(messageText(entry.message));
				if (!match?.groups) return [];
				return [
					{
						type: "toolCall" as const,
						name: "chronicle",
						arguments: {
							title: match.groups.title!,
							kind: "decision",
							body: match.groups.body!,
							topics: [],
							sources: [entry.id],
							event_time: match.groups.at!,
						},
					},
				];
			}),
		);
		if (calls.length === 0) {
			return { content: [{ type: "toolCall", name: "finish_chronicle", arguments: { carry: null } }] };
		}
		return { content: calls };
	}

	async function openSession(
		cwd: string,
		manager: SessionManager,
		overrides: Record<string, unknown> = {},
	): Promise<AgentSession> {
		const settings = Settings.isolated({
			"async.enabled": false,
			"advisor.enabled": false,
			"compaction.enabled": false,
			"memory.backend": "off",
			"chronicler.enabled": true,
			...overrides,
		});
		settings.setModelRole("chronicler", "mock/chronicler-capture");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: manager,
			agentRegistry: new AgentRegistry(),
			authStorage,
			modelRegistry,
			settings,
			model: primary,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		sessions.push(session);
		return session;
	}

	async function captureProject(
		name: string,
		turns: string[],
	): Promise<{ file: string; cwd: string; substantiveIds: string[]; chatterIds: string[] }> {
		const cwd = path.join(agentDir, "projects", name);
		await fs.mkdir(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, path.join(sessionsDir, `-projects-${name}`));
		managers.push(manager);
		const session = await openSession(cwd, manager);
		for (const turn of turns) await session.prompt(turn);
		const users = manager
			.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "user")
			.map(entry => ({ id: entry.id, text: entry.type === "message" ? messageText(entry.message) : "" }));
		await session.dispose();
		return {
			file: manager.getSessionFile()!,
			cwd,
			substantiveIds: users.filter(user => SUBSTANTIVE.test(user.text)).map(user => user.id),
			chatterIds: users.filter(user => !SUBSTANTIVE.test(user.text)).map(user => user.id),
		};
	}

	async function batches(file: string): Promise<string[]> {
		try {
			return await fs.readdir(path.join(file.slice(0, -".jsonl".length), "chronicler", "beats"));
		} catch {
			return [];
		}
	}

	it("captures without a retain call, indexes across projects, rebuilds, recalls with provenance, and injects nothing", async () => {
		const alpha = await captureProject("alpha", [
			"DECISION [2026-09-02T10:00:00.000Z]: OAuth token refresh looped until patched. The token refresh looped until the handler was patched to cache the token.",
			"ok thanks",
		]);
		const beta = await captureProject("beta", [
			"sounds good",
			"DECISION [2026-09-16T14:00:00.000Z]: Postgres schema migration for billing. The postgres migration added billing tables and schema locks were checked.",
		]);

		// Capture covered every turn, chatter included, before the sessions closed.
		for (const project of [alpha, beta]) {
			const covered = new Set<string>();
			const beatsDir = path.join(project.file.slice(0, -".jsonl".length), "chronicler", "beats");
			for (const batch of await batches(project.file)) {
				const commit = (await Bun.file(path.join(beatsDir, batch, "COMMIT.json")).json()) as {
					entries: { id: string }[];
				};
				for (const entry of commit.entries) covered.add(entry.id);
			}
			for (const id of [...project.substantiveIds, ...project.chatterIds]) expect(covered.has(id)).toBe(true);
		}

		// Restart: reopening each session re-runs its Chronicler backlog walk, which finds nothing new.
		const committed = [...(await batches(alpha.file)), ...(await batches(beta.file))];
		expect(committed.length).toBeGreaterThan(0);
		for (const { file, cwd } of [alpha, beta]) {
			const reopened = await SessionManager.open(file, path.dirname(file));
			const session = await openSession(cwd, reopened);
			expect(session.getEnabledToolNames()).not.toContain("retain");
			await session.dispose();
		}
		expect([...(await batches(alpha.file)), ...(await batches(beta.file))].sort()).toEqual(committed.sort());

		const root = path.join(agentDir, "chronicle");
		const build = () =>
			indexChronicle({ agentDir, root, config: CONFIG, summarizer: createSummarizer(fake.client), sessionsDir });
		const report = await build();
		expect(report.atoms).toBe(2);
		expect(report.projects).toBe(2);
		expect(report.canonical).toEqual([]);

		const ranker = createModelRanker(fake.client);
		const ask = (query: string) =>
			recallChronicle({ root, query, budget: 1, beam: 2, neighborhoodMinutes: 90, ranker });
		const auth = await ask("signin redirect cycle repaired");
		const storage = await ask("database changes for invoices");
		expect(auth.results[0]).toMatchObject({
			title: "OAuth token refresh looped until patched",
			eventTime: "2026-09-02T10:00:00.000Z",
			project: alpha.cwd,
			transcript: { path: alpha.file, entryIds: alpha.substantiveIds },
		});
		expect(storage.results[0]).toMatchObject({
			title: "Postgres schema migration for billing",
			project: beta.cwd,
			transcript: { path: beta.file, entryIds: beta.substantiveIds },
		});
		// Chatter turns were seen by capture but became no atom.
		const cited = [...auth.results, ...storage.results].flatMap(result => result.transcript.entryIds);
		for (const id of [...alpha.chatterIds, ...beta.chatterIds]) expect(cited).not.toContain(id);

		await fs.rm(root, { recursive: true });
		await build();
		expect((await ask("signin redirect cycle repaired")).results.map(result => result.id)).toEqual(
			auth.results.map(result => result.id),
		);

		// A new session with recall granted: no atom text reaches its prompt or its first request.
		const cwd = path.join(agentDir, "projects", "gamma");
		await fs.mkdir(cwd, { recursive: true });
		const fresh = await openSession(cwd, SessionManager.create(cwd, path.join(sessionsDir, "-projects-gamma")), {
			"chronicler.recall.enabled": true,
		});
		expect(fresh.getEnabledToolNames()).toContain("chronicle_recall");
		const callsBefore = primary.calls.length;
		await fresh.prompt("hello");
		const firstRequest = JSON.stringify(primary.calls[callsBefore]!.context.messages);
		const systemPrompt = fresh.agent.state.systemPrompt.join("\n");
		for (const text of ["OAuth token refresh", "Postgres schema migration", "billing tables"]) {
			expect(systemPrompt).not.toContain(text);
			expect(firstRequest).not.toContain(text);
		}
	});
});

describe("chronicle_recall capability", () => {
	function toolSession(settings: Record<string, unknown>, extra: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: "/tmp/test",
			hasUI: false,
			skipPythonPreflight: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(settings),
			...extra,
		};
	}

	const names = async (settings: Record<string, unknown>, extra?: Partial<ToolSession>, list?: string[]) =>
		(await resolveBuiltinToolPlan(toolSession(settings, extra), list)).names;

	it("is off by default, on when granted, and independent of the memory backend", async () => {
		expect(await names({})).not.toContain("chronicle_recall");
		expect(await names({ "chronicler.recall.enabled": true, "memory.backend": "off" })).toContain("chronicle_recall");
		const withMnemopi = await names({
			"chronicler.recall.enabled": true,
			"memory.backend": "mnemopi",
			"mnemopi.noEmbeddings": true,
		});
		expect(withMnemopi).toContain("chronicle_recall");
		expect(withMnemopi).toContain("recall");
	});

	it("reaches a subagent only through its explicit tool list and never widens a restricted list", async () => {
		const granted = { "chronicler.recall.enabled": true };
		expect(await names(granted, { taskDepth: 1 })).not.toContain("chronicle_recall");
		expect(await names(granted, { taskDepth: 1 }, ["read"])).not.toContain("chronicle_recall");
		expect(await names(granted, { taskDepth: 1 }, ["read", "chronicle_recall"])).toContain("chronicle_recall");
		expect(await names(granted, {}, ["read"])).not.toContain("chronicle_recall");
	});

	describe("in live sessions", () => {
		let tempDir: TempDir;
		let authStorage: AuthStorage;
		let session: AgentSession | undefined;

		beforeEach(() => {
			tempDir = TempDir.createSync("@chronicle-capability-");
			authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("mock", "test-key");
		});

		afterEach(async () => {
			await session?.dispose();
			session = undefined;
			authStorage.close();
			await tempDir.remove();
		});

		async function open(watchdog?: string): Promise<AgentSession> {
			const cwd = tempDir.path();
			if (watchdog) await Bun.write(path.join(cwd, "WATCHDOG.yml"), watchdog);
			const model = createMockModel({ id: "primary-mock", provider: "mock" });
			const registry = new ModelRegistry(authStorage);
			spyOn(registry, "getAvailable").mockImplementation(() => [model]);
			const settings = Settings.isolated({
				"async.enabled": false,
				"advisor.enabled": true,
				"compaction.enabled": false,
				"memory.backend": "off",
			});
			cfgChroniclerRecallEnabled.set(settings, true);
			settings.setModelRole("advisor", "mock/primary-mock");
			await settings.reloadForCwd(cwd);
			const result = await createAgentSession({
				cwd,
				agentDir: cwd,
				sessionManager: SessionManager.create(cwd, cwd),
				agentRegistry: new AgentRegistry(),
				authStorage,
				modelRegistry: registry,
				settings,
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;
			return session;
		}

		it("does not ride the advisor default roster but is available to an advisor that names it", async () => {
			const primaryOnly = await open();
			expect(primaryOnly.getEnabledToolNames()).toContain("chronicle_recall");
			const defaultAdvisor = primaryOnly.getAdvisorAgent();
			if (!defaultAdvisor) throw new Error("expected the default advisor");
			expect(defaultAdvisor.state.tools.map(tool => tool.name)).not.toContain("chronicle_recall");
			await primaryOnly.dispose();
			session = undefined;

			const granted = await open(
				["advisors:", "  - name: Historian", "    tools: [read, chronicle_recall]"].join("\n"),
			);
			const historian = granted.getAdvisorAgent();
			if (!historian) throw new Error("expected the configured advisor");
			expect(historian.state.tools.map(tool => tool.name)).toContain("chronicle_recall");
		});

		it("is removed live when the grant is revoked", async () => {
			const live = await open();
			expect(live.getEnabledToolNames()).toContain("chronicle_recall");
			cfgChroniclerRecallEnabled.set(live.settings, false);
			await live.reconcileBuiltinTools();
			expect(live.getEnabledToolNames()).not.toContain("chronicle_recall");
		});
	});
});

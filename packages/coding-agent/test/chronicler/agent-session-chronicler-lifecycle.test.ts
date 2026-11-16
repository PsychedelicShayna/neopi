import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as nativeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentPromptOptions } from "@oh-my-pi/pi-agent-core";
import type { Context, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runHeadlessBackfill } from "../../src/chronicler/backfill";
import { readCommittedChroniclerBatches } from "../../src/chronicler/store";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { FileSessionStorage } from "../../src/session/session-storage";

const originalPrompt = Agent.prototype.prompt;
const ROLE_ID = "lifecycle-capture";

function receivedSources(context: Context): string[] {
	const user = context.messages.findLast(message => message.role === "user");
	return [...JSON.stringify(user).matchAll(/### Source entry `([^`]+)`/g)].map(match => match[1]!);
}

async function scriptedPrompt(
	this: Agent,
	input: string | AgentMessage | AgentMessage[],
	imagesOrOptions?: ImageContent[] | AgentPromptOptions,
	options?: AgentPromptOptions,
	onCapture?: (context: Context) => void,
): Promise<void> {
	if (this.state.tools.some(tool => tool.name === "finish_chronicle")) {
		const mock = createMockModel({
			responses: [
				context => {
					onCapture?.(context);
					return {
						content: [
							{
								type: "toolCall",
								name: "chronicle",
								arguments: {
									title: "Transition capture",
									kind: "decision",
									body: "The requested decision survived the session transition.",
									topics: ["lifecycle"],
									sources: receivedSources(context),
								},
							},
						],
					};
				},
				{ content: [{ type: "toolCall", name: "finish_chronicle", arguments: { carry: null } }] },
				{ content: ["Capture complete."], stopReason: "stop" },
			],
			handler: () => ({ content: ["Capture complete."], stopReason: "stop" }),
		});
		this.streamFn = mock.stream;
	}
	if (typeof input === "string")
		return originalPrompt.call(this, input, imagesOrOptions as ImageContent[] | undefined, options);
	const promptMessages: (input: AgentMessage | AgentMessage[], options?: AgentPromptOptions) => Promise<void> =
		originalPrompt;
	return promptMessages.call(this, input, imagesOrOptions as AgentPromptOptions | undefined);
}

describe("AgentSession Chronicler identity boundaries", () => {
	let temporary: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let primaryModel: Model;
	let session: AgentSession | undefined;
	let storage: FileSessionStorage;
	let manager: SessionManager;
	let inherited: string[];
	let captureConversations: string[];

	beforeEach(async () => {
		temporary = TempDir.createSync("@pi-chronicler-lifecycle-");
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("mock", "test-key");
		auth.keys.setRuntime("anthropic", "test-key");
		registry = new ModelRegistry(auth);
		const capture = createMockModel({ id: ROLE_ID, provider: "mock", contextWindow: 200_000 });
		spyOn(registry, "getAvailable").mockReturnValue([capture]);
		captureConversations = [];
		spyOn(Agent.prototype, "prompt").mockImplementation(function (
			this: Agent,
			input: string | AgentMessage | AgentMessage[],
			imagesOrOptions?: ImageContent[] | AgentPromptOptions,
			options?: AgentPromptOptions,
		) {
			return scriptedPrompt.call(this, input, imagesOrOptions, options, context => {
				captureConversations.push(JSON.stringify(context.messages));
			});
		});
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("expected bundled primary model");
		primaryModel = bundled;
		storage = new FileSessionStorage();
		manager = SessionManager.create(temporary.path(), path.join(temporary.path(), "sessions"), storage);
		inherited = appendDecision(manager, "initial decision");
		await manager.ensureOnDisk();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"chronicler.enabled": true,
			"chronicler.notices": false,
		});
		settings.setModelRole("chronicler", `mock/${ROLE_ID}`);
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: primaryModel, systemPrompt: ["Primary"], tools: [], messages: [] },
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
		});
		await waitForCoverage(inherited);
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			vi.restoreAllMocks();
			auth.close();
			await temporary.remove();
			session = undefined;
		}
	});

	function appendDecision(target: SessionManager, text: string): string[] {
		return [
			target.appendMessage({ role: "user", content: text, timestamp: Date.now() }),
			target.appendMessage({
				...createAssistantMessage(`Decided: ${text}`),
				provider: primaryModel.provider,
				model: primaryModel.id,
				api: primaryModel.api,
			}),
		];
	}

	function root(): string {
		const artifacts = manager.getArtifactsDir();
		if (!artifacts) throw new Error("expected session artifacts");
		return path.join(artifacts, "chronicler");
	}

	async function coveredAt(directory: string): Promise<string[]> {
		try {
			return (await readCommittedChroniclerBatches(directory)).flatMap(batch =>
				batch.checkpoint.entries.map(entry => entry.id),
			);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
	}

	async function waitForCoverage(ids: string[]): Promise<string[]> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const coverage = await coveredAt(root());
			if (ids.every(id => coverage.includes(id))) return coverage;
			if (Date.now() >= deadline)
				throw new Error(`capture did not catch up: ${JSON.stringify(session?.chroniclerHealth)}`);
			await Bun.sleep(20);
		}
	}

	function expectUnique(coverage: string[], ids: string[]): void {
		for (const id of ids) expect(coverage.filter(value => value === id)).toHaveLength(1);
	}

	it("fork carries committed beats and captures pending source entries without another primary turn", async () => {
		const previousRoot = root();
		const previousId = manager.getSessionId();
		const pending = appendDecision(manager, "fork backlog");
		expect(await session!.fork()).toBe(true);
		expect(manager.getSessionId()).not.toBe(previousId);
		const coverage = await waitForCoverage([...inherited, ...pending]);
		expectUnique(coverage, [...inherited, ...pending]);
		expect(await coveredAt(previousRoot)).toEqual(inherited);
		expect(session!.chroniclerHealth.sessionFile).toBe(manager.getSessionFile());
	});

	for (const code of ["EACCES", "EIO"]) {
		for (const route of ["startup", "full", "entry"]) {
			it(`aborts ${route} fork before publishing or capturing private backlog on source ${code}`, async () => {
				const originalFile = manager.getSessionFile()!;
				const originalId = manager.getSessionId();
				const sourceArtifacts = manager.getArtifactsDir()!;
				const sentinel = `PRIVATE_FORK_${route}_${code}`;
				expect(await session!.chroniclerControl("blind")).toBe(true);
				const privateIds = appendDecision(manager, sentinel);
				await manager.flush();
				const filesBefore = await fs.readdir(path.dirname(originalFile));
				const readFileSync = nativeFs.readFileSync;
				const cp = nativeFs.promises.cp;
				// The journal and destination stay healthy; only the source artifact
				// tree is unavailable before its privacy file can be transferred.
				const readFault = spyOn(nativeFs, "readFileSync").mockImplementation(((
					file: nativeFs.PathOrFileDescriptor,
					options?: unknown,
				) => {
					if (String(file) === path.join(sourceArtifacts, "chronicler", "blind.json")) {
						throw Object.assign(new Error(`source privacy ${code}`), { code });
					}
					return (readFileSync as (target: nativeFs.PathOrFileDescriptor, opts?: unknown) => string | Buffer)(
						file,
						options,
					);
				}) as typeof nativeFs.readFileSync);
				const copyFault = spyOn(nativeFs.promises, "cp").mockImplementation(
					async (source, destination, options) => {
						if (String(source) === sourceArtifacts) {
							throw Object.assign(new Error(`source artifacts ${code}`), { code });
						}
						return cp(source, destination, options);
					},
				);
				let failure: unknown;
				try {
					if (route === "startup") {
						const forked = await SessionManager.forkFrom(
							originalFile,
							temporary.path(),
							path.dirname(originalFile),
							storage,
							{
								sessionFile: path.join(path.dirname(originalFile), "startup-fork.jsonl"),
								suppressBreadcrumb: true,
							},
						);
						const forkFile = forked.getSessionFile()!;
						await forked.close();
						await session!.switchSession(forkFile);
						manager = session!.sessionManager;
					} else {
						await session!.fork(route === "entry" ? privateIds.at(-1) : undefined);
					}
				} catch (error) {
					failure = error;
				} finally {
					readFault.mockRestore();
					copyFault.mockRestore();
				}
				if (!failure) await waitForCoverage(privateIds);
				expect(captureConversations.join("\n")).not.toContain(sentinel);
				expect(failure).toMatchObject({ code });
				expect(manager.getSessionFile()).toBe(originalFile);
				expect(manager.getSessionId()).toBe(originalId);
				expect((await fs.readdir(path.dirname(originalFile))).filter(file => file.endsWith(".jsonl"))).toEqual(
					filesBefore.filter(file => file.endsWith(".jsonl")),
				);
				// No child exists for restart/backfill to discover. The held source's
				// durable fence also remains authoritative for explicit backfill.
				await session!.dispose();
				session = undefined;
				await manager.close();
				const result = await runHeadlessBackfill({
					sessionFile: originalFile,
					settings: Settings.isolated({ "chronicler.enabled": true }),
					modelRegistry: registry,
					obfuscator: undefined,
					timeoutMs: 5_000,
					drainMs: 1_000,
					pollMs: 10,
				});
				expect(result.outcome).toBe("complete");
				expect(captureConversations.join("\n")).not.toContain(sentinel);
			});
		}
	}

	for (const route of ["startup", "full", "entry"]) {
		it(`preserves closed private spans through ${route} fork, restart and backfill despite optional copy failure`, async () => {
			const sourceFile = manager.getSessionFile()!;
			expect(await session!.chroniclerControl("blind")).toBe(true);
			const sentinel = `CLOSED_PRIVATE_FORK_${route}`;
			const privateIds = appendDecision(manager, sentinel);
			await manager.flush();
			expect(await session!.chroniclerControl("unblind")).toBe(true);
			const publicIds = appendDecision(manager, "public fork catch-up");
			await manager.flush();
			const copyFault = spyOn(nativeFs.promises, "cp").mockRejectedValueOnce(
				Object.assign(new Error("optional artifact copy failed"), { code: "EIO" }),
			);
			try {
				if (route === "startup") {
					const forked = await SessionManager.forkFrom(
						sourceFile,
						temporary.path(),
						path.dirname(sourceFile),
						storage,
						{
							sessionFile: path.join(path.dirname(sourceFile), "closed-fork.jsonl"),
							suppressBreadcrumb: true,
						},
					);
					const file = forked.getSessionFile()!;
					await forked.close();
					expect(await session!.switchSession(file)).toBe(true);
					manager = session!.sessionManager;
				} else {
					expect(await session!.fork(route === "entry" ? publicIds.at(-1) : undefined)).toBe(true);
				}
			} finally {
				copyFault.mockRestore();
			}
			const coverage = await waitForCoverage([...inherited, ...publicIds]);
			for (const id of privateIds) expect(coverage).not.toContain(id);
			expect(captureConversations.join("\n")).not.toContain(sentinel);
			const childFile = manager.getSessionFile()!;
			// Reopening the published child must use its own durable fence.
			expect(await session!.switchSession(sourceFile)).toBe(true);
			expect(await session!.switchSession(childFile)).toBe(true);
			expect(captureConversations.join("\n")).not.toContain(sentinel);
			await session!.dispose();
			session = undefined;
			await manager.close();
			const result = await runHeadlessBackfill({
				sessionFile: childFile,
				settings: Settings.isolated({ "chronicler.enabled": true }),
				modelRegistry: registry,
				obfuscator: undefined,
				timeoutMs: 5_000,
				drainMs: 1_000,
				pollMs: 10,
			});
			expect(result.outcome).toBe("complete");
			expect(result.before.totalEntries).toBe(inherited.length + publicIds.length);
			expect(captureConversations.join("\n")).not.toContain(sentinel);
		});
	}

	it("branch captures child-owned retained sources without another primary turn or changing parent history", async () => {
		const parentRoot = root();
		const parentBatches = await readCommittedChroniclerBatches(parentRoot);
		const pending = appendDecision(manager, "retained branch backlog");
		const discarded = manager.appendMessage({ role: "user", content: "rewrite this request", timestamp: Date.now() });
		const result = await session!.branch(discarded);
		expect(result.cancelled).toBe(false);
		const coverage = await waitForCoverage([...inherited, ...pending]);
		expectUnique(coverage, [...inherited, ...pending]);
		expect(coverage).not.toContain(discarded);
		expect(manager.getBranch().map(entry => entry.id)).not.toContain(discarded);
		const childEntries = new Set(manager.getBranch().map(entry => entry.id));
		for (const batch of await readCommittedChroniclerBatches(root())) {
			expect(batch.checkpoint.sessionId).toBe(manager.getSessionId());
			for (const source of batch.checkpoint.entries) expect(childEntries.has(source.id)).toBe(true);
		}
		expect(await readCommittedChroniclerBatches(parentRoot)).toEqual(parentBatches);
	});

	it("cwd artifact rename and merge each catch up against their new root while preserving user artifacts", async () => {
		const originalFile = manager.getSessionFile()!;
		const originalArtifacts = manager.getArtifactsDir()!;
		const renamed = appendDecision(manager, "rename backlog");
		await session!.moveSession(temporary.path(), path.join(temporary.path(), "moved"));
		expect(await Bun.file(originalFile).exists()).toBe(false);
		expectUnique(await waitForCoverage([...inherited, ...renamed]), [...inherited, ...renamed]);
		await Bun.write(path.join(originalArtifacts, "unrelated.txt"), "user-owned destination artifact");
		const merged = appendDecision(manager, "merge backlog");
		await session!.moveSession(temporary.path(), path.join(temporary.path(), "sessions"));
		expectUnique(await waitForCoverage([...inherited, ...renamed, ...merged]), [...inherited, ...renamed, ...merged]);
		expect(await Bun.file(path.join(manager.getArtifactsDir()!, "unrelated.txt")).text()).toBe(
			"user-owned destination artifact",
		);
		expect(session!.chroniclerHealth.artifactsDir).toBe(originalArtifacts);
	});

	it("failed fork publication keeps entries appended during publication and Chronicler resumes against the held identity", async () => {
		const originalId = manager.getSessionId();
		const pending = appendDecision(manager, "failed fork backlog");
		await manager.flush();
		let concurrent: string[] = [];
		spyOn(storage, "writeTextAtomic").mockImplementationOnce(async () => {
			// A primary turn completing while the fork publishes appends to the live manager.
			concurrent = appendDecision(manager, "completed during fork publication");
			throw new Error("fork publish failed");
		});
		await expect(session!.fork()).rejects.toThrow("fork publish failed");
		const heldEntries = manager.getEntries().map(entry => entry.id);
		for (const id of [...pending, ...concurrent]) expect(heldEntries).toContain(id);
		expect(manager.getSessionId()).not.toBe(originalId);
		expect(session!.chroniclerHealth.sessionFile).toBe(manager.getSessionFile());
		// The manager keeps the unpublished identity and its sticky durability failure, so
		// Chronicler resumes bound to that identity and reports the failure instead of
		// staying suspended or capturing against the abandoned one.
		const deadline = Date.now() + 5_000;
		while (session!.chroniclerHealth.status === "suspended" || session!.chroniclerHealth.status === "off") {
			if (Date.now() >= deadline)
				throw new Error(`Chronicler never resumed: ${JSON.stringify(session?.chroniclerHealth)}`);
			await Bun.sleep(20);
		}
		expect(session!.chroniclerHealth.error).toContain("fork publish failed");
		expect(session!.chroniclerHealth.sessionFile).toBe(manager.getSessionFile());
	});

	it("failed branch publication restores the original branch before Chronicler catches up", async () => {
		const originalFile = manager.getSessionFile();
		const originalId = manager.getSessionId();
		const pending = appendDecision(manager, "failed branch backlog");
		const selected = manager.appendMessage({ role: "user", content: "branch draft", timestamp: Date.now() });
		const terminal = manager.appendMessage(createAssistantMessage("uncommitted branch decision"));
		await manager.flush();
		spyOn(storage, "writeTextSync").mockImplementationOnce(() => {
			throw new Error("branch publish failed");
		});
		await expect(session!.branch(selected)).rejects.toThrow("branch publish failed");
		expect(manager.getSessionId()).toBe(originalId);
		expect(manager.getLeafId()).toBe(terminal);
		expect(session!.chroniclerHealth.sessionFile).toBe(originalFile);
		expectUnique(await waitForCoverage([...inherited, ...pending, selected, terminal]), [
			...inherited,
			...pending,
			selected,
			terminal,
		]);
	});

	it("resume binds to the target and catches up its persisted backlog without waking the old transcript", async () => {
		const previousRoot = root();
		const target = SessionManager.create(temporary.path(), path.join(temporary.path(), "targets"));
		let targetFile: string;
		let pending: string[];
		try {
			pending = appendDecision(target, "resumed backlog");
			await target.ensureOnDisk();
			targetFile = target.getSessionFile()!;
		} finally {
			await target.close();
		}
		expect(await session!.switchSession(targetFile)).toBe(true);
		expectUnique(await waitForCoverage(pending), pending);
		expect(await coveredAt(previousRoot)).toEqual(inherited);
		expect(session!.chroniclerHealth.sessionFile).toBe(targetFile);
	});

	it("a rejected cross-cwd resume rolls back identity and still catches up the original backlog", async () => {
		const originalFile = manager.getSessionFile();
		const originalId = manager.getSessionId();
		const pending = appendDecision(manager, "rollback backlog");
		const targetCwd = path.join(temporary.path(), "other-project");
		await fs.mkdir(targetCwd);
		const target = SessionManager.create(targetCwd, path.join(temporary.path(), "other-sessions"));
		let targetFile: string;
		try {
			appendDecision(target, "not adopted");
			await target.ensureOnDisk();
			targetFile = target.getSessionFile()!;
		} finally {
			await target.close();
		}
		expect(await session!.switchSession(targetFile, { onCwdChange: async () => false })).toBe(false);
		expect(manager.getSessionId()).toBe(originalId);
		expect(session!.chroniclerHealth.sessionFile).toBe(originalFile);
		expectUnique(await waitForCoverage([...inherited, ...pending]), [...inherited, ...pending]);
		const targetRoot = path.join(targetFile.slice(0, -".jsonl".length), "chronicler");
		expect(await coveredAt(targetRoot)).toEqual([]);
	});

	it("a nested transition cannot resume Chronicler while the outer transition is pending", async () => {
		const pending = appendDecision(manager, "nested backlog");
		const targetCwd = path.join(temporary.path(), "nested-project");
		await fs.mkdir(targetCwd);
		const target = SessionManager.create(targetCwd, path.join(temporary.path(), "nested-sessions"));
		let targetFile: string;
		try {
			appendDecision(target, "unadopted nested target");
			await target.ensureOnDisk();
			targetFile = target.getSessionFile()!;
		} finally {
			await target.close();
		}
		const targetRoot = path.join(targetFile.slice(0, -".jsonl".length), "chronicler");
		const reached = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<boolean>();
		const switching = session!.switchSession(targetFile, {
			onCwdChange: async () => {
				await session!.moveSession(targetCwd, path.dirname(targetFile));
				reached.resolve();
				return finish.promise;
			},
		});
		await reached.promise;
		// Give a premature resume ample opportunity to bind and capture the target.
		await Bun.sleep(300);
		expect(session!.isSessionTransitioning).toBe(true);
		expect(session!.chroniclerHealth.status).toBe("suspended");
		expect(await coveredAt(targetRoot)).toEqual([]);
		finish.resolve(false);
		expect(await switching).toBe(false);
		expect(await coveredAt(targetRoot)).toEqual([]);
		expectUnique(await waitForCoverage([...inherited, ...pending]), [...inherited, ...pending]);
	});
});

/**
 * `npi chronicle backfill` driven through its command implementation with a
 * temp session store and a scripted capture model. The real SessionChronicler,
 * capture tools, and ChroniclerStore run unmodified; only the provider is
 * replaced, by binding a per-pass `createMockModel` to whichever Agent owns the
 * `finish_chronicle` tool through a restored `Agent.prototype.prompt` spy.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentPromptOptions } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Context, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { artifactsDirectoryFor, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { acquireFileLock, TempDir } from "@oh-my-pi/pi-utils";
import { type ChronicleBackfillFlags, runChronicleBackfill } from "../../src/cli/chronicle-backfill-cli";
import { readCommittedChroniclerBatches } from "../../src/chronicler/store";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const FINISH_TOOL = "finish_chronicle";
const CAPTURE_MODEL_ID = "chronicler-mock";
const SOURCE_MARKER_RE = /### Source entry `([^`]+)`/g;

describe("npi chronicle backfill", () => {
	const originalPrompt = Agent.prototype.prompt;
	let promptSpy: ReturnType<typeof spyOn<Agent, "prompt">> | undefined;

	let tempDir: TempDir;
	let projectCwd: string;
	let sessionsRoot: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let availableModels: Model<Api>[];
	let capturePrompts: number;
	/** Capture prompt index (0-based) whose provider never answers. */
	let hangAtPrompt: number | undefined;
	let registryOpens: number;
	let stdout: string[];
	let stderr: string[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-chronicle-backfill-");
		projectCwd = path.join(tempDir.path(), "project");
		sessionsRoot = path.join(tempDir.path(), "sessions");
		await fs.mkdir(projectCwd, { recursive: true });
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		availableModels = [createMockModel({ id: CAPTURE_MODEL_ID, provider: "mock", contextWindow: 200_000 })];
		spyOn(modelRegistry, "getAvailable").mockImplementation(() => [...availableModels]);
		capturePrompts = 0;
		hangAtPrompt = undefined;
		registryOpens = 0;
		stdout = [];
		stderr = [];
		promptSpy = spyOn(Agent.prototype, "prompt");
		promptSpy.mockImplementation(interceptPrompt as typeof Agent.prototype.prompt);
	});

	afterEach(async () => {
		promptSpy?.mockRestore();
		promptSpy = undefined;
		authStorage.close();
		await tempDir.remove().catch(() => {});
	});

	/** Every capture pass stages one beat over the sources it really received, then finishes. */
	async function interceptPrompt(
		this: Agent,
		input: string | AgentMessage | AgentMessage[],
		imagesOrOptions?: ImageContent[] | AgentPromptOptions,
		options?: AgentPromptOptions,
	): Promise<void> {
		if (this.state.tools.some(tool => tool.name === FINISH_TOOL)) {
			const index = capturePrompts++;
			if (index === hangAtPrompt) return Promise.withResolvers<void>().promise;
			this.streamFn = createMockModel({ responses: beatPass() }).stream;
		}
		if (typeof input === "string") {
			return originalPrompt.call(this, input, imagesOrOptions as ImageContent[] | undefined, options);
		}
		const promptMessages: (input: AgentMessage | AgentMessage[], options?: AgentPromptOptions) => Promise<void> =
			originalPrompt;
		return promptMessages.call(this, input, imagesOrOptions as AgentPromptOptions | undefined);
	}

	function receivedSourceIds(context: Context): string[] {
		for (let index = context.messages.length - 1; index >= 0; index--) {
			const message = context.messages[index]!;
			if (message.role === "user") {
				return [...JSON.stringify(message).matchAll(SOURCE_MARKER_RE)].map(match => match[1]!);
			}
		}
		return [];
	}

	function beatPass(): MockHandler[] {
		const stop: MockResponse = { content: ["Capture pass complete."], stopReason: "stop" };
		return [
			context => ({
				content: [
					{
						type: "toolCall",
						name: "chronicle",
						arguments: {
							title: "Backfilled beat",
							kind: "decision",
							body: "The stored session recorded a decision worth preserving.",
							topics: ["backfill"],
							sources: receivedSourceIds(context),
						},
					},
				],
			}),
			() => ({ content: [{ type: "toolCall", name: FINISH_TOOL, arguments: { carry: null } }] }),
			stop,
		];
	}

	function settingsFor(overrides: Readonly<Record<string, unknown>> | undefined, enabled: boolean): Settings {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"chronicler.enabled": enabled,
			...overrides,
		});
		settings.setModelRole("chronicler", `mock/${CAPTURE_MODEL_ID}`);
		return settings;
	}

	async function backfill(
		flags: Partial<ChronicleBackfillFlags>,
		options: { enabled?: boolean } = {},
	): Promise<number> {
		return runChronicleBackfill(
			{ sessions: [], all: false, dryRun: false, concurrency: 2, force: false, ...flags },
			{
				cwd: projectCwd,
				sessionsRoot,
				stdout: line => stdout.push(line),
				stderr: line => stderr.push(line),
				loadSettings: async (_cwd, overrides) => settingsFor(overrides, options.enabled ?? true),
				openModelRegistry: async () => {
					registryOpens++;
					return modelRegistry;
				},
				buildObfuscator: async () => undefined,
			},
		);
	}

	function assistantMessage(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	/** A closed, never-chronicled transcript with `turns` user/assistant pairs. */
	async function storedSession(turns: number): Promise<{ file: string; ids: string[] }> {
		const manager = SessionManager.create(projectCwd, path.join(sessionsRoot, "-project"));
		const ids: string[] = [];
		for (let turn = 0; turn < turns; turn++) {
			ids.push(manager.appendMessage({ role: "user", content: `Question ${turn}`, timestamp: Date.now() }));
			ids.push(manager.appendMessage(assistantMessage(`Answer ${turn}`)));
		}
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		await manager.close();
		return { file, ids };
	}

	function chroniclerRoot(sessionFile: string): string {
		return path.join(artifactsDirectoryFor(sessionFile)!, "chronicler");
	}

	it("captures an uncaptured session to full coverage without changing the transcript", async () => {
		const { file, ids } = await storedSession(40);
		const bytesBefore = await fs.readFile(file);

		expect(await backfill({ sessions: [file] })).toBe(0);

		expect(Buffer.compare(await fs.readFile(file), bytesBefore)).toBe(0);
		const batches = await readCommittedChroniclerBatches(chroniclerRoot(file));
		const covered = batches.flatMap(batch => batch.checkpoint.entries.map(entry => entry.id));
		expect(covered.toSorted()).toEqual(ids.toSorted());
		// 80 entries exceed one 60-entry pass, so the walk continued past the first batch.
		expect(batches.length).toBeGreaterThan(1);
		expect(stdout.at(-1)).toContain("complete 1");
	});

	it("resumes an interrupted backfill without recapturing committed entries", async () => {
		const { file, ids } = await storedSession(70);
		hangAtPrompt = 1;
		expect(await backfill({ sessions: [file], timeout: "1s", drain: "100ms" })).toBe(0);
		const interrupted = await readCommittedChroniclerBatches(chroniclerRoot(file));
		expect(interrupted).toHaveLength(1);
		expect(stdout.some(line => line.includes("incomplete"))).toBe(true);

		hangAtPrompt = undefined;
		expect(await backfill({ sessions: [file] })).toBe(0);
		const resumed = await readCommittedChroniclerBatches(chroniclerRoot(file));
		const covered = resumed.flatMap(batch => batch.checkpoint.entries.map(entry => entry.id));
		expect(covered).toHaveLength(ids.length);
		expect(new Set(covered).size).toBe(ids.length);
		// The first run's batch survives as-is and every later beat cites only new entries.
		expect(resumed[0]!.checkpoint.batchId).toBe(interrupted[0]!.checkpoint.batchId);
		const firstSources = new Set(interrupted[0]!.checkpoint.entries.map(entry => entry.id));
		for (const batch of resumed.slice(1)) {
			for (const beat of batch.beats) expect(beat.sources.some(id => firstSources.has(id))).toBe(false);
		}
	});

	it("skips a session whose Chronicler lease another process holds", async () => {
		const { file } = await storedSession(3);
		const lease = await acquireFileLock(chroniclerRoot(file), { retries: 1 });
		try {
			expect(await backfill({ sessions: [file] })).toBe(0);
		} finally {
			lease.release();
		}
		expect(capturePrompts).toBe(0);
		expect(await readCommittedChroniclerBatches(chroniclerRoot(file))).toHaveLength(0);
		expect(stdout.some(line => line.includes("lease"))).toBe(true);
	});

	it("lists uncovered sessions on --dry-run without resolving or calling a model", async () => {
		const { file } = await storedSession(4);
		const bytesBefore = await fs.readFile(file);

		expect(await backfill({ all: true, dryRun: true })).toBe(0);

		expect(registryOpens).toBe(0);
		expect(capturePrompts).toBe(0);
		expect(stdout.some(line => line.includes("8 of 8 entries uncovered"))).toBe(true);
		expect(Buffer.compare(await fs.readFile(file), bytesBefore)).toBe(0);
		expect(await fs.stat(chroniclerRoot(file)).catch(() => null)).toBeNull();
	});

	it("refuses when chronicler.enabled is false unless --force", async () => {
		const { file, ids } = await storedSession(2);

		expect(await backfill({ sessions: [file] }, { enabled: false })).toBe(2);
		expect(capturePrompts).toBe(0);
		expect(await readCommittedChroniclerBatches(chroniclerRoot(file))).toHaveLength(0);

		expect(await backfill({ sessions: [file], force: true }, { enabled: false })).toBe(0);
		const batches = await readCommittedChroniclerBatches(chroniclerRoot(file));
		expect(batches.flatMap(batch => batch.checkpoint.entries.map(entry => entry.id)).toSorted()).toEqual(
			ids.toSorted(),
		);
	});

	it("exits non-zero when capture halts", async () => {
		// Too small a window for even one entry: capture halts rather than truncating.
		availableModels = [createMockModel({ id: CAPTURE_MODEL_ID, provider: "mock", contextWindow: 64 })];
		const { file } = await storedSession(2);

		expect(await backfill({ sessions: [file] })).toBe(1);
		expect(stdout.some(line => line.includes("halted"))).toBe(true);
	});
});

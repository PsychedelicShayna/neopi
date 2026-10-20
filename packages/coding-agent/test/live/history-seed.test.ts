import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { LiveSessionController } from "../../src/live/controller";
import { buildLiveHistorySeed } from "../../src/live/history-seed";
import { normalizeLiveIngestSettings } from "../../src/live/ingest-settings";
import { LivePersonaStore, type LivePersonaState } from "../../src/live/personas";
import { CONTEXT_CHUNK_BYTES, type LiveClientMessage } from "../../src/live/protocol";
import type { AgentSession } from "../../src/session/agent-session";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "../../src/session/messages";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const tokenizer = new Tokenizer();
const count = (chunks: string[]) => chunks.reduce((sum, chunk) => sum + tokenizer.countTokens(chunk, "strict"), 0);

afterEach(() => vi.restoreAllMocks());

describe("bounded live history", () => {
	it("resolves and reloads the history template from the live session project", async () => {
		using temp = TempDir.createSync("@omp-live-history-override-");
		const cwd = temp.path();
		const file = path.join(cwd, ".omp/builtin-prompts/live/primary-history.md");
		await Bun.write(file, "Custom silent history: {{message}}");
		expect(buildLiveHistorySeed([user("ongoing work")], 1000, cwd).join("\n")).toContain("Custom silent history:");
		await Bun.write(file, "Updated history: {{message}}");
		expect(buildLiveHistorySeed([user("ongoing work")], 1000, cwd).join("\n")).toContain("Updated history:");
		await Bun.write(file, "{{unknownHistoryHelper message}}");
		expect(buildLiveHistorySeed([user("ongoing work")], 1000, cwd).join("\n")).toStartWith(
			"Primary transcript history.",
		);
	});

	it("keeps recent authored prose in order without tool output or private reasoning", () => {
		const messages: AgentMessage[] = [
			user("the prior question"),
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private secret" },
					{ type: "text", text: "the prior answer" },
				],
			} as AgentMessage,
			{ role: "toolResult", content: [{ type: "text", text: "tool secret" }] } as AgentMessage,
			user("the latest question"),
		];
		const chunks = buildLiveHistorySeed(messages, 1000);
		const text = chunks.join("\n");
		expect(text.indexOf("the prior question")).toBeLessThan(text.indexOf("the prior answer"));
		expect(text.indexOf("the prior answer")).toBeLessThan(text.indexOf("the latest question"));
		expect(text).toContain("Operator:");
		expect(text).toContain("Non-operator assistant:");
		expect(text).not.toContain("private secret");
		expect(text).not.toContain("tool secret");
		expect(count(chunks)).toBeLessThanOrEqual(1000);
	});

	it("keeps the operator and voice note in their original order within a historical delegation", () => {
		const message: AgentMessage = {
			role: "custom",
			customType: LIVE_DELEGATION_MESSAGE_TYPE,
			content: "combined legacy text",
			display: true,
			timestamp: 1,
			details: { operator: "operator request", voice: "voice clarification" },
		};
		const text = buildLiveHistorySeed([message], 1000).join("\n");
		expect(text).toContain("Operator (live): operator request");
		expect(text).toContain("Voice agent: voice clarification");
		expect(text.indexOf("operator request")).toBeLessThan(text.indexOf("voice clarification"));
		expect(text).not.toContain("combined legacy text");
	});

	it("drops older blocks before recent ones and labels every UTF-8-safe chunk", () => {
		const latest = user("latest subject 🛸 ".repeat(30));
		const budget = count(buildLiveHistorySeed([latest], 8000));
		const chunks = buildLiveHistorySeed([user("old unrelated subject"), latest], budget);
		expect(chunks.join("\n")).not.toContain("old unrelated subject");
		expect(chunks.join("\n")).toContain("latest subject");
		for (const chunk of chunks) {
			expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(CONTEXT_CHUNK_BYTES);
			expect(chunk).toStartWith("Primary transcript history.");
			expect(chunk).toContain("NEVER speak or delegate");
			expect(chunk).not.toContain("�");
		}
		expect(count(chunks)).toBeLessThanOrEqual(budget);
	});

	it("fits an oversized latest turn and counts framing against the budget", () => {
		const chunks = buildLiveHistorySeed([user(`start ${"長い本文🛸".repeat(2000)} end`)], 128);
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.join("\n")).toContain("truncated");
		expect(count(chunks)).toBeLessThanOrEqual(128);
		expect(buildLiveHistorySeed([], 1000)).toEqual([]);
		expect(buildLiveHistorySeed([user("hello")], 1)).toEqual([]);
	});

	it("preserves supplementary characters at oversized history truncation boundaries", () => {
		const chunks = buildLiveHistorySeed([user(`HEAD ${"🛸".repeat(10_000)} TAIL`)], 8000);
		const text = chunks.join("\n");
		expect(text.isWellFormed()).toBe(true);
		expect(text).toContain("HEAD");
		expect(text).toContain("TAIL");
		expect(text).toContain("truncated");
		expect(count(chunks)).toBeLessThanOrEqual(8000);
		for (const chunk of chunks) {
			expect(chunk.isWellFormed()).toBe(true);
			expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(CONTEXT_CHUNK_BYTES);
		}
	});
});

function harness(
	state: LivePersonaState,
	messages = [user("ongoing primary work")],
	send?: (message: LiveClientMessage) => Promise<void>,
) {
	vi.spyOn(LivePersonaStore.prototype, "read").mockResolvedValue(state);
	const sent: LiveClientMessage[] = [];
	const delegate = vi.fn();
	const recorder = vi.fn(() => ({ stop() {} }));
	const controller = new LiveSessionController({
		session: {
			messages,
			modelRegistry: { authStorage: {} },
			sessionId: "history-seed-test",
			sessionManager: { getCwd: () => process.cwd() },
			subscribe: () => () => {},
			sendCustomMessageWithReceipt: delegate,
		} as unknown as AgentSession,
		callbacks: { onPhase() {}, onLevels() {}, onTranscript() {}, onTerminal() {} },
		extractAssistantText: () => "",
		createRecorder: recorder,
		createTransport: () => ({
			async connect() {},
			async send(message) {
				sent.push(message);
				await send?.(message);
			},
			async close() {},
			async setMuted() {},
			pushAudio() {
				return true;
			},
		}),
	});
	return { controller, sent, delegate, recorder };
}

describe("live startup history delivery", () => {
	it("starts with real Settings.init and absent seed configuration without sending history", async () => {
		const state = beginSettingsTest();
		const dir = await fs.mkdtemp(path.join(process.env.HOME!, ".cache/npi-canary/live-seed-settings-"));
		try {
			const settings = await Settings.init({ cwd: dir, agentDir: dir });
			expect(settings).toBeDefined();
			const h = harness({ schemaVersion: 1, personas: {} });
			try {
				await h.controller.start();
				expect(h.sent).toEqual([]);
				expect(h.recorder).toHaveBeenCalledTimes(1);
			} finally {
				await h.controller.stop();
			}
		} finally {
			restoreSettingsTestState(state);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps an empty primary session empty even when the built-in persona enables seeding", async () => {
		const h = harness(
			{
				schemaVersion: 1,
				personas: {},
				defaultIngest: normalizeLiveIngestSettings({ seedHistory: true }),
			},
			[],
		);
		try {
			await h.controller.start();
			expect(h.sent).toEqual([]);
			expect(h.delegate).not.toHaveBeenCalled();
		} finally {
			await h.controller.stop();
		}
	});

	it("stops cleanly while history is being sent without starting capture or delivering queued input", async () => {
		const firstSend = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const h = harness(
			{
				schemaVersion: 1,
				personas: {},
				defaultIngest: normalizeLiveIngestSettings({ seedHistory: true }),
			},
			[user("primary history ".repeat(100))],
			async message => {
				if (message.type === "session.context.append") {
					firstSend.resolve();
					await release.promise;
				}
			},
		);
		const starting = h.controller.start();
		const rejected = starting.then(
			() => undefined,
			(error: unknown) => error,
		);
		await firstSend.promise;
		const typed = h.controller.sendOperatorText("do not deliver", "voice");
		const stopping = h.controller.stop();
		expect(await typed).toBe(false);
		release.resolve();
		await stopping;
		expect(await rejected).toBeInstanceOf(Error);
		expect(String(await rejected)).toContain("stopped");
		expect(h.recorder).not.toHaveBeenCalled();
		expect(h.delegate).not.toHaveBeenCalled();
		expect(h.sent.filter(message => message.type === "session.context.append")).toHaveLength(1);
	});

	it("seeds the selected persona before queued typed input and microphone capture without delegation", async () => {
		const firstSend = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let held = false;
		const h = harness(
			{
				schemaVersion: 1,
				active: "iris",
				defaultIngest: normalizeLiveIngestSettings({ seedHistory: false }),
				personas: {
					iris: {
						instructions: "custom voice",
						ingest: normalizeLiveIngestSettings({ seedHistory: true, seedHistoryTokens: 1000 }),
					},
				},
			},
			[user("ongoing primary work ".repeat(70))],
			async message => {
				if (message.type === "session.context.append" && !held) {
					held = true;
					firstSend.resolve();
					await release.promise;
				}
			},
		);
		try {
			const starting = h.controller.start();
			await firstSend.promise;
			expect(h.recorder).not.toHaveBeenCalled();
			const typed = h.controller.sendOperatorText("new typed request", "voice");
			expect(h.sent).toHaveLength(1);
			release.resolve();
			await starting;
			expect(await typed).toBe(true);
			const contexts = h.sent.filter(message => message.type === "session.context.append");
			expect(contexts.length).toBeGreaterThan(2);
			for (const message of contexts.slice(0, -1)) {
				expect(message.channel).toBe("commentary");
				expect(message.content[0].text).toStartWith("Primary transcript history.");
			}
			expect(contexts.at(-1)?.content[0].text).toContain("new typed request");
			expect(h.delegate).not.toHaveBeenCalled();
			expect(h.recorder).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve();
			await h.controller.stop();
		}
	});
});

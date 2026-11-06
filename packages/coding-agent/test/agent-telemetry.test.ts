import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { AgentContextTelemetry } from "@oh-my-pi/pi-coding-agent/session/agent-telemetry";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const sessions: AgentSession[] = [];
const authStores: AuthStorage[] = [];
const tempDirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const auth of authStores.splice(0)) auth.close();
	for (const temp of tempDirs.splice(0)) await temp.remove();
});

function completedRequest(): AssistantMessage {
	return {
		...createAssistantMessage("prior result"),
		usage: {
			input: 12_000,
			output: 600,
			reasoningTokens: 200,
			cacheRead: 3_000,
			cacheWrite: 1_000,
			totalTokens: 16_600,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		},
		duration: 2_000,
		ttft: 100,
	};
}

function fixture(settings = Settings.isolated()) {
	const auth = createInMemoryAuthStorage();
	authStores.push(auth);
	const mock = createMockModel({ contextWindow: 100_000, reasoning: true, handler: { content: ["done"] } });
	const manager = SessionManager.inMemory();
	const previous = completedRequest();
	manager.appendMessage(previous);
	const registry = new AgentRegistry();
	const toolSession: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		settings,
		agentRegistry: registry,
		getAgentId: () => "Root",
	};
	const agent = new Agent({
		initialState: {
			model: mock.model,
			thinkingLevel: ThinkingLevel.Medium,
			messages: [previous],
			systemPrompt: ["test"],
			tools: [],
		},
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(auth),
		thinkingLevel: ThinkingLevel.Medium,
		toolSession,
	});
	sessions.push(session);
	registry.register({ id: "Root", displayName: "Root", kind: "main", session, status: "running" });
	registry.register({
		id: "Child",
		displayName: "Child",
		kind: "sub",
		session: null,
		parentId: "Root",
		status: "idle",
	});
	registry.register({
		id: "Parked",
		displayName: "Parked",
		kind: "sub",
		session: null,
		parentId: "Root",
		status: "parked",
	});
	registry.register({ id: "Other", displayName: "Other", kind: "main", session: null, status: "running" });
	registry.register({ id: "Operator", displayName: "Operator", kind: "operator", session: null, status: "running" });
	return { session, manager, previous, toolSession, registry, mock };
}

function telemetryFrom(messages: AgentMessage[]): AgentContextTelemetry {
	const notices = messages.filter(
		message => message.role === "custom" && message.customType === "agent-runtime-telemetry",
	);
	expect(notices).toHaveLength(1);
	const notice = notices[0]!;
	if (notice.role !== "custom") throw new Error("Expected custom notice");
	if (typeof notice.content !== "string") throw new Error("Expected text notice");
	const line = notice.content.split("\n").find(value => value.startsWith("{"));
	if (!line) throw new Error("Missing structured telemetry");
	return JSON.parse(line) as AgentContextTelemetry;
}

function modelText(message: Message): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

describe("agent-visible runtime telemetry", () => {
	it("keeps off projections byte-identical and does not read local counters", () => {
		const { session } = fixture();
		const messages: AgentMessage[] = [{ role: "user", content: "keep every byte\n\tunchanged", timestamp: 123 }];
		const before = JSON.stringify(convertToLlm(messages));
		const readContext = vi.spyOn(session, "getContextUsage").mockImplementation(() => {
			throw new Error("off read counters");
		});
		const projected = session.prepareAgentTelemetry(messages);
		expect(projected).toBe(messages);
		expect(JSON.stringify(convertToLlm(projected))).toBe(before);
		expect(readContext).not.toHaveBeenCalled();
	});

	it("injects exactly one minimal record matching the local inspect snapshot", () => {
		const { session, toolSession, previous } = fixture(Settings.isolated({ "telemetry.agent_context": "minimal" }));
		session.setCheckpointState({
			checkpointEntryId: null,
			checkpointMessageCount: 1,
			startedAt: "2026-10-19T00:00:00Z",
		});
		const messages: AgentMessage[] = [previous, { role: "user", content: "continue", timestamp: 123 }];
		const record = telemetryFrom(session.prepareAgentTelemetry(messages));
		const snapshot = toolSession.getAgentTelemetry?.();
		if (!snapshot) throw new Error("Expected local telemetry snapshot");
		expect(record).toEqual(snapshot);
		expect(record.model).toEqual({ provider: session.model!.provider, id: session.model!.id, effort: null });
		expect(record.context).toEqual({
			usedTokens: session.getContextUsage()!.tokens,
			limitTokens: 100_000,
			percent: Math.round(session.getContextUsage()!.percent * 10) / 10,
			estimated: true,
		});
		expect(record.compaction.thresholdTokens).toBeGreaterThan(0);
		expect(record.compaction.state).toBe("idle");
		expect(record.checkpoint.active).toBe(true);
		expect(record.previousTurn).toMatchObject({
			input: 12_000,
			output: 600,
			reasoning: 200,
			total: 16_600,
			requests: 1,
			last: { durationMs: 2_000, ttftMs: 100, outputTokensPerSecond: 300 },
		});
		expect(record.fleet).toEqual({ running: 1, idle: 1, parked: 1, aborted: 0 });
		expect(record.full).toBeUndefined();
		expect(session.messages).toEqual([previous]);
	});

	it("emits optional structured threshold notices with estimated headroom and checkpoint state", () => {
		const { session } = fixture(
			Settings.isolated({
				"telemetry.threshold_events": true,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdPercent": 85,
			}),
		);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 80_000, contextWindow: 100_000, percent: 80 });
		const snapshot = session.getAgentTelemetry()!;
		expect(snapshot.events).toEqual([
			{ type: "approaching_compaction", headroomTokens: 5_000, estimated: true, checkpointAvailable: false },
		]);
		const projected = session.prepareAgentTelemetry([{ role: "user", content: "continue", timestamp: 1 }]);
		const notice = projected.at(-1)!;
		expect(notice.role).toBe("custom");
		expect(JSON.stringify(notice)).toContain("agent_threshold_events");
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 10_000, contextWindow: 100_000, percent: 10 });
		expect(session.getAgentTelemetry()!.events).toBeUndefined();
	});

	it("suppresses threshold notices when disabled, including inside the lead band", () => {
		const { session } = fixture(Settings.isolated({ "telemetry.agent_context": "minimal" }));
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 84_000, contextWindow: 100_000, percent: 84 });
		expect(telemetryFrom(session.prepareAgentTelemetry([])).events).toBeUndefined();
	});

	it("counts the latest retained user turn, not repeated provider input usage", () => {
		const { session, previous } = fixture(Settings.isolated({ "telemetry.agent_context": "minimal" }));
		const user: AgentMessage = { role: "user", content: "inspect the branch", timestamp: 1 };
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "large intermediate output ".repeat(500) }],
			isError: false,
			timestamp: 2,
		};
		session.agent.replaceMessages([previous, user, completedRequest(), result]);
		const record = telemetryFrom(session.prepareAgentTelemetry(session.messages));
		expect(record.recentTurnFootprint).toMatchObject({
			scope: "latest_user_turn",
			messages: 3,
			estimated: true,
		});
		const footprint = record.recentTurnFootprint!.tokens;
		expect(footprint).toBeGreaterThan(1_000);
		expect(footprint).toBeLessThan(record.previousTurn!.input);
		// Rewind retains the report, not the intermediate tool output.
		session.agent.replaceMessages([previous, user, createAssistantMessage("retained report")]);
		expect(session.getAgentTelemetry()!.recentTurnFootprint!.tokens).toBeLessThan(footprint);
		session.agent.replaceMessages([previous]);
		expect(session.getAgentTelemetry()!.recentTurnFootprint).toBeNull();
	});

	it("reports checkpoint availability from the enabled pair, including discoverable tools", () => {
		const { session } = fixture(Settings.isolated({ "telemetry.agent_context": "minimal" }));
		const names = vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["write", "checkpoint", "rewind"]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.getAgentTelemetry()!.checkpoint).toEqual({ active: false, available: true });
		session.setCheckpointState({ checkpointEntryId: null, checkpointMessageCount: 1, startedAt: "now" });
		expect(session.getAgentTelemetry()!.checkpoint).toEqual({ active: true, available: false });
		session.setCheckpointState(undefined);
		names.mockReturnValue(["write", "checkpoint"]);
		expect(session.getAgentTelemetry()!.checkpoint.available).toBe(false);
		names.mockReturnValue([]);
		expect(session.getAgentTelemetry()!.checkpoint.available).toBe(false);
	});

	it.each([
		{ "compaction.enabled": false },
		{ "compaction.asyncEnabled": false },
		{ "compaction.methodOrder": ["shake"] },
	])("does not advertise nonexistent speculative boundaries for %j", overrides => {
		const { session } = fixture(Settings.isolated({ "telemetry.agent_context": "minimal", ...overrides }));
		const record = telemetryFrom(session.prepareAgentTelemetry([]));
		expect(record.compaction.speculationStartsAtTokens).toBeNull();
		if (overrides["compaction.enabled"] === false) {
			expect(record.compaction.enabled).toBe(false);
			expect(record.compaction.thresholdTokens).toBeNull();
		} else {
			expect(record.compaction.thresholdTokens).toBeGreaterThan(0);
		}
	});

	it("announces available checkpoints before starting one, never while one is active", () => {
		const { session } = fixture(
			Settings.isolated({
				"telemetry.threshold_events": true,
				"compaction.thresholdPercent": 85,
				"compaction.methodOrder": ["soft"],
			}),
		);
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["checkpoint", "rewind"]);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 84_000, contextWindow: 100_000, percent: 84 });
		expect(session.getAgentTelemetry()!.events?.[0]?.checkpointAvailable).toBe(true);
		session.setCheckpointState({ checkpointEntryId: null, checkpointMessageCount: 1, startedAt: "now" });
		expect(session.getAgentTelemetry()!.events?.[0]?.checkpointAvailable).toBe(false);
	});

	it("adds full shared usage, cache share, cost splits and root-scoped occupancy only when requested", () => {
		const { session } = fixture(Settings.isolated({ "telemetry.agent_context": "full" }));
		const record = telemetryFrom(session.prepareAgentTelemetry([]));
		expect(record.full!.usage).toEqual(record.previousTurn!);
		expect(record.full!.cacheReadPercent).toBe(18.8);
		expect(record.full!.cost).toEqual({ main: 0.3, advisors: 0 });
		expect(record.full!.agents.map(agent => agent.id)).toEqual(["Root", "Child", "Parked"]);
		expect(record.full!.agents[0]!.context!.contextWindow).toBe(100_000);
	});

	it.each(["summary", "full"] as const)(
		"keeps independent %s tool telemetry transient and preserves pairing",
		mode => {
			const { session, manager, previous } = fixture(Settings.isolated({ "telemetry.tool_results": mode }));
			manager.appendCustomEntry("tool_execution_start", {
				toolCallId: "call-1",
				toolName: "read",
				startedAt: "2026-10-19T00:00:00.000Z",
			});
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "original output" }],
				isError: false,
				timestamp: Date.parse("2026-10-19T00:00:00.125Z"),
				details: { original: true },
			};
			const projected = session.prepareAgentTelemetry([previous, result]);
			expect(projected).toHaveLength(2);
			const annotated = projected[1] as ToolResultMessage;
			expect(annotated.toolCallId).toBe("call-1");
			expect(annotated.details).toBe(result.details);
			expect(annotated.content[0]).toBe(result.content[0]!);
			expect(modelText(annotated)).toContain('"durationMs":125');
			if (mode === "summary") expect(modelText(annotated)).not.toContain('"runtime"');
			else expect(modelText(annotated)).toContain('"runtime":{"type":"agent_context"');
			expect(result.content).toHaveLength(1);
		},
	);

	it("injects one fresh record on every real SDK model boundary without accumulating it in history", async () => {
		const temp = await TempDir.create("@agent-telemetry-sdk-");
		tempDirs.push(temp);
		const auth = createInMemoryAuthStorage();
		authStores.push(auth);
		const mock = createMockModel({
			handler: { content: ["done"], usage: { input: 100, output: 10, totalTokens: 110 } },
		});
		const settings = Settings.isolated({
			"telemetry.agent_context": "minimal",
			"telemetry.threshold_events": true,
			"usageNotices.enabled": true,
			"compaction.enabled": false,
			"checkpoint.enabled": true,
			"tools.xdev": true,
		});
		const modelRegistry = new ModelRegistry(auth, path.join(temp.path(), "models.toml"));
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const { session } = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			authStorage: auth,
			modelRegistry,
			model: mock.model,
			settings,
			sessionManager: SessionManager.inMemory(temp.path()),
			agentRegistry: new AgentRegistry(),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			preloadedCustomToolPaths: [],
		});
		sessions.push(session);
		expect(session.getActiveToolNames()).not.toContain("checkpoint");
		expect(session.getEnabledToolNames()).toContain("checkpoint");
		expect(session.getAgentTelemetry()!.checkpoint).toEqual({ active: false, available: true });
		session.agent.streamFn = mock.stream;
		session.agent.getApiKey = () => "test-key";
		const usageRead = vi.spyOn(session, "fetchUsageReports").mockResolvedValue([
			{
				provider: mock.model.provider,
				fetchedAt: Date.now() - 10_000,
				limits: [
					{
						id: "5h",
						label: "5 hours",
						scope: { provider: mock.model.provider },
						amount: { usedFraction: 0.95, unit: "percent" },
					},
				],
			},
		]);
		const humanNotices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "usage") humanNotices.push(event.message);
		});
		await session.prompt("first");
		await session.prompt("second");
		expect(mock.calls).toHaveLength(2);
		for (const call of mock.calls) {
			expect(
				call.context.messages.filter(message => modelText(message).includes('"type":"agent_context"')),
			).toHaveLength(1);
		}
		expect(modelText(mock.calls[1]!.context.messages.at(-1)!)).toContain('"output":10');
		expect(usageRead).toHaveBeenCalledTimes(1);
		expect(humanNotices).toHaveLength(1);
		expect(modelText(mock.calls[0]!.context.messages.at(-1)!)).toContain('"type":"usage_threshold_events"');
		expect(
			mock.calls[1]!.context.messages.some(message =>
				modelText(message).includes('"type":"usage_threshold_events"'),
			),
		).toBe(false);
		expect(
			session.messages.some(message => message.role === "custom" && message.customType === "agent-usage-notices"),
		).toBe(false);
		expect(
			session.messages.some(
				message => message.role === "custom" && message.customType === "agent-runtime-telemetry",
			),
		).toBe(false);
	}, 30_000);
});

/**
 * Issue #667: `get_state` reports the hostname, accumulated active processing time and running job count
 * the TUI status line shows.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildRpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { countBackgroundJobsOutsideBadge } from "@oh-my-pi/pi-tui/overlays/running-subagent-badge";
import { ActiveTimeMeter } from "@oh-my-pi/pi-tui/status-line/active-time-meter";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("ActiveTimeMeter", () => {
	test("sums windows, counts the open one, and ignores a second start", () => {
		const meter = new ActiveTimeMeter();
		expect(meter.start(1000)).toBe(true);
		expect(meter.start(1500)).toBe(false);
		expect(meter.total(2000)).toBe(1000);
		meter.end(3000);
		expect(meter.end(9000)).toBe(false);
		meter.start(10_000);
		expect(meter.total(10_500)).toBe(2500);
		expect(meter.windowElapsed(10_500)).toBe(500);
	});

	test("a real-to-real session file change is a new conversation; the first save is not", () => {
		const meter = new ActiveTimeMeter();
		expect(meter.follows("/a.jsonl")).toBe(true);
		expect(meter.follows("/a.jsonl")).toBe(true);
		expect(meter.follows("/b.jsonl")).toBe(false);
		expect(new ActiveTimeMeter(undefined).follows("/first-save.jsonl")).toBe(true);
	});

	test("reset and dropWindow discard without crediting", () => {
		const meter = new ActiveTimeMeter();
		meter.start(0);
		meter.dropWindow();
		expect(meter.total(5000)).toBe(0);
		meter.start(0);
		meter.end(100);
		expect(meter.reset()).toBe(true);
		expect(meter.total(5000)).toBe(0);
		expect(meter.reset()).toBe(false);
	});
});

describe("running job count", () => {
	test("a task job stops counting once its subagent is running; bash and eval always count", () => {
		const jobs = [
			{ type: "bash" },
			{ type: "eval", agentId: "Ghost" },
			{ type: "task", agentId: "Live" },
			{ type: "task", agentId: "Queued" },
			{ type: "task" },
		];
		expect(countBackgroundJobsOutsideBadge(jobs, new Set(["Live"]))).toBe(4);
	});
});

describe("get_state status facts", () => {
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
	});

	function create(delayMs: number): AgentSession {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const mock = createMockModel({
			responses: [
				async () => {
					await Bun.sleep(delayMs);
					return { content: ["done"] };
				},
			],
		});
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, thinkingLevel: ThinkingLevel.Low, systemPrompt: ["Test"], tools: [] },
				getApiKey: () => "test-key",
				convertToLlm,
				streamFn: (requested, context, options) => mock.stream(requested, context, options),
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(os.tmpdir(), "status-facts-models.toml")),
			thinkingLevel: ThinkingLevel.Low,
		});
		return session;
	}

	test("reports the short hostname and no running jobs on a fresh session", () => {
		const state = buildRpcSessionState(create(0), { includeDump: false });
		expect(state.hostname).toBe(os.hostname().split(".")[0]);
		expect(state.activeTimeMs).toBe(0);
		expect(state.runningJobCount).toBe(0);
	});

	test("active time grows while a turn runs, freezes when it settles, and starts over for a new session", async () => {
		const live = create(120);
		const turn = live.prompt("hello");
		while (live.runStartedAt === undefined) await Bun.sleep(5);
		await Bun.sleep(20);
		const during = buildRpcSessionState(live, { includeDump: false }).activeTimeMs;
		expect(during).toBeGreaterThan(0);
		await turn;
		await live.waitForIdle();
		const settled = live.getActiveTimeMs();
		expect(settled).toBeGreaterThanOrEqual(during);
		expect(settled).toBeGreaterThanOrEqual(100);
		await Bun.sleep(30);
		expect(live.getActiveTimeMs()).toBe(settled);
		await live.newSession();
		expect(live.getActiveTimeMs()).toBe(0);
	});
});

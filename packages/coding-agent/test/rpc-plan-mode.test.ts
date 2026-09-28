/**
 * Issue #103: RPC plan mode. `set_mode` enters/leaves plan mode with the
 * interactive tool adjustments, `mode_changed` reports every transition, and
 * an `xd://propose` submission round-trips through
 * `plan_proposal_request`/`plan_proposal_response` (a control frame).
 *
 * The propose write needs a model turn, so these tests dispatch the device
 * directly against a real session in plan mode and capture the RPC output.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { dispatchRpcControlFrame, type RpcInputFrameDeps } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { setRpcChatMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-chat-mode";
import { RpcPlanModeController, RpcSetModeError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-plan-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { dispatchResolutionDevice } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type Frame = Record<string, unknown>;

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(block => block.text ?? "").join("\n");
}

describe("RPC plan mode", () => {
	let authDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let controller: RpcPlanModeController | undefined;

	beforeAll(async () => {
		authDir = TempDir.createSync("@pi-rpc-plan-auth-");
		authStorage = await AuthStorage.create(authDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, authDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		authDir.removeSync();
	});

	beforeEach(() => {
		session = undefined;
		controller = undefined;
	});

	afterEach(async () => {
		controller?.close();
		await session?.dispose();
	});

	function setup(options?: {
		settings?: Record<string, unknown>;
		responses?: MockResponse[];
		/** Persist sessions under this directory instead of in memory. */
		sessionDir?: string;
	}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const readTool = makeTool("read");
		// Stands in for the built-in write tool's `xd://propose` route, forwarding
		// the tool call's abort signal like `XdProtocolHandler.write` does.
		const writeTool: AgentTool = {
			...makeTool("write"),
			parameters: type({ path: "string", content: "string" }),
			async execute(_toolCallId, params, signal) {
				const { path, content } = params as { path: string; content: string };
				if (path !== "xd://propose") return { content: [{ type: "text" as const, text: "ok" }] };
				return (await dispatchResolutionDevice(created as unknown as ToolSession, "propose", content, signal))
					.result;
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [readTool], messages: [] },
			streamFn: createMockModel({ responses: options?.responses ?? [] }).stream,
		});
		const created = new AgentSession({
			agent,
			sessionManager: options?.sessionDir
				? SessionManager.create(options.sessionDir, options.sessionDir)
				: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, ...options?.settings }),
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>([
				["read", readTool],
				["write", writeTool],
			]),
			builtInToolNames: ["read", "write"],
			advisorTools: [],
		});
		const frames: Frame[] = [];
		const planMode = new RpcPlanModeController(created, frame => frames.push(frame as Frame));
		session = created;
		controller = planMode;
		const deps: RpcInputFrameDeps = {
			handleCommand: async () => {
				throw new Error("commands are not dispatched in this test");
			},
			output: frame => frames.push(frame as Frame),
			errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
			pendingExtensionRequests: new Map(),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onHostUriResult: () => {},
			onPlanProposalResponse: frame => planMode.handleProposalResponse(frame),
			onToolApprovalResponse: () => {},
		};
		const writePlan = async (slug: string, markdown: string) => {
			const planPath = resolveLocalUrlToPath(`local://${slug}-plan.md`, {
				getArtifactsDir: () => created.sessionManager.getArtifactsDir(),
				getSessionId: () => created.sessionManager.getSessionId(),
			});
			await Bun.write(planPath, markdown);
		};
		/** Submit a plan the way a `write xd://propose` does. */
		const propose = (title: string, signal?: AbortSignal) =>
			dispatchResolutionDevice(created as unknown as ToolSession, "propose", title, signal).then(
				dispatched => dispatched.result,
			);
		const modeEntries = () =>
			created.sessionManager
				.getEntries()
				.filter(entry => entry.type === "mode_change")
				.map(entry => (entry.type === "mode_change" ? entry.mode : undefined));
		const waitForRequest = async (): Promise<Frame> => {
			for (let attempt = 0; attempt < 200; attempt++) {
				const request = frames.find(frame => frame.type === "plan_proposal_request");
				if (request) return request;
				await Bun.sleep(5);
			}
			throw new Error("plan_proposal_request was not emitted");
		};
		return { session: created, planMode, frames, deps, writePlan, propose, modeEntries, waitForRequest };
	}

	it("enters plan mode with the plan tools and leaves it restoring the previous tools", async () => {
		const { session, planMode, frames, modeEntries } = setup();

		const entered = await planMode.setMode("plan", undefined);
		expect(entered).toEqual({ mode: "plan", planFilePath: "local://PLAN.md" });
		expect(planMode.state).toEqual({
			mode: "plan",
			planMode: { planFilePath: "local://PLAN.md", workflow: "parallel" },
		});
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		expect(session.peekPlanProposalHandler()).toBeDefined();

		const left = await planMode.setMode("default", undefined);
		expect(left).toEqual({ mode: "default" });
		expect(planMode.state).toEqual({ mode: "default" });
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.peekPlanProposalHandler()).toBeUndefined();

		expect(frames).toEqual([
			{ type: "mode_changed", mode: "plan", planFilePath: "local://PLAN.md" },
			{ type: "mode_changed", mode: "default" },
		]);
		expect(modeEntries()).toEqual(["plan", "none"]);
	});

	it("keeps host tools inactive during chat and restores replacements when chat ends", async () => {
		const { session } = setup();
		await session.refreshRpcHostTools([makeTool("old_host")]);
		expect(session.getEnabledToolNames()).toContain("old_host");
		await session.setChatMode({ mode: "chat" });
		await session.refreshRpcHostTools([makeTool("new_host")]);
		expect(session.getEnabledToolNames()).toEqual([]);
		await session.setChatMode({ mode: "off" });
		expect(session.getEnabledToolNames()).toContain("new_host");
		expect(session.getEnabledToolNames()).not.toContain("old_host");
	});

	it("retains host tools changed during plan mode on exit", async () => {
		const { session, planMode } = setup();
		await session.refreshRpcHostTools([makeTool("old_host")]);
		await planMode.setMode("plan", undefined);
		await session.refreshRpcHostTools([makeTool("new_host")]);
		expect(session.getEnabledToolNames()).toContain("new_host");
		await planMode.setMode("default", undefined);
		expect(session.getEnabledToolNames()).toContain("new_host");
		expect(session.getEnabledToolNames()).not.toContain("old_host");
	});

	it("a failed pre-plan model restore leaves plan mode fully intact, and a retry completes the exit", async () => {
		const { session, planMode, frames, modeEntries } = setup();
		cfgModelRoles.override(session.settings, { plan: "anthropic/claude-sonnet-4-6" });
		const originalModelId = session.model?.id;
		await planMode.setMode("plan", undefined);
		expect(session.model?.id).toBe("claude-sonnet-4-6");

		const setModel = spyOn(session, "setModelTemporary").mockRejectedValueOnce(new Error("credential removed"));
		const failure = await planMode.setMode("default", undefined).catch(error => error);
		setModel.mockRestore();

		expect(failure).toBeInstanceOf(Error);
		expect(failure.message).toBe("credential removed");
		expect(planMode.state.mode).toBe("plan");
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		expect(session.model?.id).toBe("claude-sonnet-4-6");
		expect(session.peekPlanProposalHandler()).toBeDefined();
		expect(frames.filter(frame => frame.mode === "default")).toEqual([]);

		expect(await planMode.setMode("default", undefined)).toEqual({ mode: "default" });
		expect(planMode.state).toEqual({ mode: "default" });
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.model?.id).toBe(originalModelId);
		expect(modeEntries()).toEqual(["plan", "none"]);
	});

	it("a failed pre-plan tool restore returns to the plan model and tools, and a retry completes the exit", async () => {
		const { session, planMode, modeEntries } = setup();
		cfgModelRoles.override(session.settings, { plan: "anthropic/claude-sonnet-4-6" });
		const originalModelId = session.model?.id;
		await planMode.setMode("plan", undefined);

		const restoreTools = spyOn(session, "restoreNonMCPToolPresentation").mockRejectedValueOnce(
			new Error("rebuild failed"),
		);
		const failure = await planMode.setMode("default", undefined).catch(error => error);
		restoreTools.mockRestore();

		expect(failure.message).toBe("rebuild failed");
		expect(planMode.state.mode).toBe("plan");
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		expect(session.model?.id).toBe("claude-sonnet-4-6");
		expect(session.peekPlanProposalHandler()).toBeDefined();

		expect(await planMode.setMode("default", undefined)).toEqual({ mode: "default" });
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.model?.id).toBe(originalModelId);
		expect(modeEntries()).toEqual(["plan", "none"]);
	});

	it("chat mode cannot start while plan mode is on, so leaving plan mode never reactivates tools under chat", async () => {
		const { session, planMode } = setup();
		await planMode.setMode("plan", undefined);

		expect(await setRpcChatMode(session, { mode: "chat" })).toEqual({ ok: false, message: "Exit plan mode first." });
		expect(session.chatMode).toBeUndefined();

		await planMode.setMode("default", undefined);
		expect(session.chatMode).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("plan mode cannot start while chat mode is on, and chat stays tool-free", async () => {
		const { session, planMode, frames } = setup();
		expect(await setRpcChatMode(session, { mode: "chat" })).toMatchObject({ ok: true });
		expect(session.getActiveToolNames()).toEqual([]);

		const blocked = await planMode.setMode("plan", undefined).catch(error => error);
		expect(blocked).toBeInstanceOf(RpcSetModeError);
		expect(blocked.code).toBe("mode_blocked");
		expect(session.getActiveToolNames()).toEqual([]);
		expect(planMode.state).toEqual({ mode: "default" });
		expect(frames).toEqual([]);
	});

	it("new_session ends plan mode and restores the pre-plan tools and model in the new session", async () => {
		const dir = TempDir.createSync("@pi-rpc-plan-new-");
		try {
			const { session, planMode, frames } = setup({ sessionDir: dir.path() });
			cfgModelRoles.override(session.settings, { plan: "anthropic/claude-sonnet-4-6" });
			await planMode.setMode("plan", undefined);
			const planSessionId = session.sessionId;

			expect(await session.newSession()).toBe(true);
			await planMode.settled();

			expect(session.sessionId).not.toBe(planSessionId);
			expect(planMode.state).toEqual({ mode: "default" });
			expect(frames.at(-1)).toEqual({ type: "mode_changed", mode: "default" });
			expect(session.peekPlanProposalHandler()).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
			expect(session.model?.id).toBe("claude-sonnet-4-5");
		} finally {
			controller?.close();
			await session?.dispose();
			session = undefined;
			await dir.remove();
		}
	});

	it("switch_session ends plan mode without applying the plan snapshot's model to the target session", async () => {
		const dir = TempDir.createSync("@pi-rpc-plan-switch-");
		try {
			const target = SessionManager.create(dir.path(), dir.path());
			target.appendModelChange("anthropic/claude-haiku-4-5");
			target.appendMessage({ role: "user", content: "target", timestamp: 1 });
			target.appendMessage(createAssistantMessage("target reply"));
			await target.flush();
			const targetFile = target.getSessionFile();
			await target.close();
			if (!targetFile) throw new Error("target session was not persisted");

			const { session, planMode, frames } = setup({ sessionDir: dir.path() });
			cfgModelRoles.override(session.settings, { plan: "anthropic/claude-sonnet-4-6" });
			await planMode.setMode("plan", undefined);

			expect(await session.switchSession(targetFile)).toBe(true);
			await planMode.settled();

			expect(planMode.state).toEqual({ mode: "default" });
			expect(frames.at(-1)).toEqual({ type: "mode_changed", mode: "default" });
			expect(session.getActiveToolNames()).toEqual(["read"]);
			expect(session.model?.id).toBe("claude-haiku-4-5");

			expect(await planMode.setMode("default", undefined)).toEqual({ mode: "default" });
			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			controller?.close();
			await session?.dispose();
			session = undefined;
			await dir.remove();
		}
	});

	it("switch_session keeps a target's own plan-matching model and does not write a model change", async () => {
		const dir = TempDir.createSync("@pi-rpc-plan-matching-switch-");
		try {
			const { session, planMode } = setup({ sessionDir: dir.path() });
			cfgModelRoles.override(session.settings, { plan: "anthropic/claude-sonnet-4-6" });
			session.setThinkingLevel(ThinkingLevel.High);
			const target = SessionManager.create(dir.path(), dir.path());
			target.appendModelChange("anthropic/claude-sonnet-4-6");
			target.appendThinkingLevelChange(session.thinkingLevel, session.configuredThinkingLevel());
			target.appendMessage({ role: "user", content: "target", timestamp: 1 });
			target.appendMessage(createAssistantMessage("target reply"));
			await target.flush();
			const targetFile = target.getSessionFile();
			await target.close();
			if (!targetFile) throw new Error("target session was not persisted");

			await planMode.setMode("plan", undefined);
			const planThinkingLevel = session.configuredThinkingLevel();
			expect(session.model?.id).toBe("claude-sonnet-4-6");

			expect(await session.switchSession(targetFile)).toBe(true);
			await planMode.settled();

			expect(planMode.state).toEqual({ mode: "default" });
			expect(session.model?.id).toBe("claude-sonnet-4-6");
			expect(session.configuredThinkingLevel()).toBe(planThinkingLevel);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "model_change")).toHaveLength(1);
		} finally {
			controller?.close();
			await session?.dispose();
			session = undefined;
			await dir.remove();
		}
	});

	it("keeps a model the host chose while planning when plan mode ends", async () => {
		const { session, planMode } = setup();
		cfgModelRoles.override(session.settings, { plan: "anthropic/claude-sonnet-4-6" });
		await planMode.setMode("plan", undefined);
		const chosen = modelRegistry.find("anthropic", "claude-opus-4-1");
		if (!chosen) throw new Error("Expected claude-opus-4-1 in the registry");
		await session.setModel(chosen);

		await planMode.setMode("default", undefined);

		expect(session.model?.id).toBe("claude-opus-4-1");
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("keeps a thinking level the host chose while planning when plan mode ends", async () => {
		const { session, planMode } = setup();
		cfgModelRoles.override(session.settings, { plan: "anthropic/claude-sonnet-4-6" });
		await planMode.setMode("plan", undefined);
		session.setThinkingLevel(ThinkingLevel.High);

		await planMode.setMode("default", undefined);

		expect(session.model?.id).toBe("claude-sonnet-4-6");
		expect(session.configuredThinkingLevel()).toBe(ThinkingLevel.High);
	});

	it("honors a host-supplied plan file path", async () => {
		const { planMode, frames } = setup();

		expect(await planMode.setMode("plan", "local://auth-plan.md")).toEqual({
			mode: "plan",
			planFilePath: "local://auth-plan.md",
		});
		expect(frames).toEqual([{ type: "mode_changed", mode: "plan", planFilePath: "local://auth-plan.md" }]);
	});

	it("rejects plan mode with plan_disabled, mode_blocked, or session_busy without changing state", async () => {
		const disabled = setup({ settings: { "plan.enabled": false } });
		const disabledError = await disabled.planMode.setMode("plan", undefined).catch(error => error);
		expect(disabledError).toBeInstanceOf(RpcSetModeError);
		expect(disabledError.code).toBe("plan_disabled");
		expect(disabled.planMode.state).toEqual({ mode: "default" });
		expect(disabled.frames).toEqual([]);
		controller?.close();
		await session?.dispose();

		const blocked = setup();
		blocked.session.setVibeModeState({ enabled: true });
		const blockedError = await blocked.planMode.setMode("plan", undefined).catch(error => error);
		expect(blockedError.code).toBe("mode_blocked");
		expect(blocked.planMode.state).toEqual({ mode: "default" });
		controller?.close();
		await session?.dispose();

		const busy = setup({ responses: [{ content: ["slow"], delayMs: 60_000 }] });
		const turn = busy.session.prompt("hello");
		await Bun.sleep(20);
		expect(busy.session.isStreaming).toBe(true);
		const busyError = await busy.planMode.setMode("plan", undefined).catch(error => error);
		expect(busyError.code).toBe("session_busy");
		expect(busy.planMode.state).toEqual({ mode: "default" });
		expect(busy.frames).toEqual([]);
		await busy.session.abort();
		await turn.catch(() => {});
	});

	it("approve: one proposal request with the plan markdown, then plan mode clears", async () => {
		const { session, planMode, frames, deps, writePlan, propose, modeEntries, waitForRequest } = setup();
		await planMode.setMode("plan", undefined);
		await writePlan("demo", "# Demo plan\n\n1. Do it.\n");

		const submission = propose("demo");
		const request = await waitForRequest();
		expect(request).toEqual({
			type: "plan_proposal_request",
			id: expect.any(String),
			title: "demo",
			planFilePath: "local://demo-plan.md",
			planMarkdown: "# Demo plan\n\n1. Do it.\n",
		});

		expect(
			dispatchRpcControlFrame({ type: "plan_proposal_response", id: request.id, decision: "approve" }, deps),
		).toBe(true);
		const result = await submission;

		expect(resultText(result)).toContain("Plan approved at local://demo-plan.md");
		expect(planMode.state).toEqual({ mode: "default" });
		expect(session.getPlanReferencePath()).toBe("local://demo-plan.md");
		expect(session.peekPlanProposalHandler()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(frames.filter(frame => frame.type === "plan_proposal_request")).toHaveLength(1);
		expect(frames.at(-1)).toEqual({ type: "mode_changed", mode: "default" });
		expect(modeEntries()).toEqual(["plan", "none"]);
	});

	it("restores host tools changed while planning after a proposal is approved", async () => {
		const { session, planMode, deps, writePlan, propose, waitForRequest } = setup();
		await session.refreshRpcHostTools([makeTool("old_host")]);
		await planMode.setMode("plan", undefined);
		await session.refreshRpcHostTools([makeTool("new_host")]);
		await writePlan("updated-host-tools", "# Updated host tools\n");
		const submission = propose("updated-host-tools");
		const request = await waitForRequest();
		expect(
			dispatchRpcControlFrame({ type: "plan_proposal_response", id: request.id, decision: "approve" }, deps),
		).toBe(true);
		await submission;
		expect(session.getEnabledToolNames()).toContain("new_host");
		expect(session.getEnabledToolNames()).not.toContain("old_host");
	});

	it("refine: feedback reaches the tool result and plan mode stays on", async () => {
		const { planMode, frames, deps, writePlan, propose, waitForRequest } = setup();
		await planMode.setMode("plan", undefined);
		await writePlan("demo", "# Demo plan\n");

		const submission = propose("demo");
		const request = await waitForRequest();
		dispatchRpcControlFrame(
			{
				type: "plan_proposal_response",
				id: request.id,
				decision: "refine",
				feedback: "Split step 2 into tests first.",
			},
			deps,
		);
		const result = await submission;

		expect(resultText(result)).toContain("Plan refinement requested");
		expect(resultText(result)).toContain("Split step 2 into tests first.");
		// The reviewed plan becomes the plan-mode target.
		expect(planMode.state).toEqual({
			mode: "plan",
			planMode: { planFilePath: "local://demo-plan.md", workflow: "parallel" },
		});
		expect(frames.some(frame => frame.type === "mode_changed" && frame.mode === "default")).toBe(false);
	});

	it("abort during the proposing turn resolves the proposal as refine; a late answer cannot approve it", async () => {
		const { session, planMode, deps, writePlan, waitForRequest } = setup({
			responses: [
				{ content: [{ type: "toolCall", name: "write", arguments: { path: "xd://propose", content: "demo" } }] },
				{ content: ["done"] },
			],
		});
		await planMode.setMode("plan", undefined);
		await writePlan("demo", "# Demo plan\n");

		const turn = session.prompt("make a plan");
		const request = await waitForRequest();
		await session.abort();
		await turn.catch(() => {});

		const toolResults = session.messages.filter(message => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(JSON.stringify(toolResults[0])).toContain("Plan refinement requested");
		dispatchRpcControlFrame({ type: "plan_proposal_response", id: request.id, decision: "approve" }, deps);
		expect(planMode.state.mode).toBe("plan");
		expect(session.peekPlanProposalHandler()).toBeDefined();
	});

	it("set_mode default while a proposal is pending refines it first and leaves plan mode", async () => {
		const { planMode, frames, writePlan, propose, waitForRequest, modeEntries } = setup();
		await planMode.setMode("plan", undefined);
		await writePlan("demo", "# Demo plan\n");

		const submission = propose("demo");
		await waitForRequest();
		expect(await planMode.setMode("default", undefined)).toEqual({ mode: "default" });
		const result = await submission;

		expect(resultText(result)).toContain("Plan refinement requested");
		expect(planMode.state).toEqual({ mode: "default" });
		expect(frames.at(-1)).toEqual({ type: "mode_changed", mode: "default" });
		expect(modeEntries()).toEqual(["plan", "none"]);
	});

	it("EOF resolves a pending proposal as refine", async () => {
		const { planMode, writePlan, propose, waitForRequest } = setup();
		await planMode.setMode("plan", undefined);
		await writePlan("demo", "# Demo plan\n");

		const submission = propose("demo");
		await waitForRequest();
		planMode.close();

		expect(resultText(await submission)).toContain("Plan refinement requested");
	});

	it("without set_mode, reports plan transitions from other paths but installs no proposal handler", async () => {
		const { session, planMode, frames, propose } = setup();

		session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md", workflow: "iterative" });

		expect(frames).toEqual([{ type: "mode_changed", mode: "plan", planFilePath: "local://PLAN.md" }]);
		expect(planMode.state).toEqual({
			mode: "plan",
			planMode: { planFilePath: "local://PLAN.md", workflow: "iterative" },
		});
		expect(session.peekPlanProposalHandler()).toBeUndefined();
		await expect(propose("demo")).rejects.toThrow("No plan is awaiting approval");
		expect(frames.some(frame => frame.type === "plan_proposal_request")).toBe(false);
	});
});

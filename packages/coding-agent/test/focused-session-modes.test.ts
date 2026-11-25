import { afterEach, expect, test } from "bun:test";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runFocusedAgentCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/focused-agent-command";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

let dir: TempDir | undefined;
let authStorage: AuthStorage | undefined;
let worker: AgentSession | undefined;

afterEach(async () => {
	try {
		await worker?.dispose();
	} finally {
		authStorage?.close();
		dir?.removeSync();
		worker = undefined;
		authStorage = undefined;
		dir = undefined;
	}
});

async function setup(responses: MockResponse[] = [], options?: { continuation?: boolean; restricted?: boolean }) {
	dir = TempDir.createSync("@pi-focused-mode-");
	const cwd = dir.path();
	authStorage = await AuthStorage.create(dir.join("auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		taskDepth: 1,
		agentId: `FocusedMode-${Bun.randomUUIDv7()}`,
		sessionManager: SessionManager.create(cwd, cwd),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, dir.join("models.yml")),
		settings: Settings.isolated({
			"goal.continuationModes": options?.continuation === false ? [] : ["interactive"],
			"compaction.enabled": false,
			"retry.enabled": false,
		}),
		model: getBundledModel("anthropic", "claude-sonnet-4-5"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames: options?.restricted ? ["read"] : ["read", "write", "goal"],
		restrictToolNames: true,
	});
	worker = session;
	session.agent.streamFn = createMockModel({
		handler: () => responses.shift() ?? { content: ["What should I do next?"] },
	}).stream;
	return session;
}

function idle(session: AgentSession): Promise<void> {
	return withTimeout(session.waitForIdle(), 5_000, "Worker mode turn did not settle");
}

test("a focused goal kicks off at home and its continuation completes before worker idle", async () => {
	const session = await setup([
		{ content: [{ type: "toolCall", id: "inspect", name: "goal", arguments: { op: "get" } }] },
		{ content: ["Made progress."] },
		{ content: [{ type: "toolCall", id: "finish", name: "goal", arguments: { op: "complete" } }] },
		{ content: ["Done."] },
	]);
	const previousTools = session.getEnabledToolNames();
	const { result } = await runFocusedAgentCommand(session, "/goal set Finish the worker objective");
	expect(result).toEqual({ consumed: true, agentInvoked: true });
	await idle(session);
	expect(
		session.messages.some(message => message.role === "custom" && message.customType === "goal-continuation"),
	).toBe(true);
	expect(session.sessionManager.getEntries()).toContainEqual(
		expect.objectContaining({
			type: "custom",
			customType: "goal-completed",
			data: expect.objectContaining({ objective: "Finish the worker objective" }),
		}),
	);
	expect(session.getGoalModeState()).toBeUndefined();
	expect(session.getEnabledToolNames()).toEqual(previousTools);
});

test("focused goal verbs persist objective replacement, budget, pause, resume, and drop on the worker", async () => {
	const session = await setup([], { continuation: false });
	const run = (text: string) => runFocusedAgentCommand(session, text);
	await run("/goal Initial objective");
	await idle(session);
	await run("/goal set Revised objective");
	await idle(session);
	await run("/goal budget 4096");
	expect((await run("/goal show")).output.join("\n")).toContain("Revised objective");
	expect(session.getGoalModeState()?.goal.tokenBudget).toBe(4096);
	await run("/goal pause");
	expect(session.sessionManager.buildSessionContext().mode).toBe("goal_paused");
	expect(session.getEnabledToolNames()).not.toContain("goal");
	await run("/goal resume");
	expect(session.getEnabledToolNames()).toContain("goal");
	await run("/goal budget off");
	expect(session.getGoalModeState()?.goal.tokenBudget).toBeUndefined();
	await run("/goal drop");
	expect(session.sessionManager.buildSessionContext().mode).toBe("none");
	expect(session.getEnabledToolNames()).not.toContain("goal");
});

test("guided goal submits the interview privately and keeps its tool available for the worker's next turn", async () => {
	const session = await setup([], { continuation: false });
	await runFocusedAgentCommand(session, "/guided-goal Decide the acceptance criteria");
	await idle(session);
	expect(session.getGoalModeState()).toBeUndefined();
	expect(session.getEnabledToolNames()).toContain("goal");
	expect(session.messages).toContainEqual(
		expect.objectContaining({
			role: "custom",
			customType: "guided-goal-interview",
			display: false,
			content: expect.stringContaining("Decide the acceptance criteria"),
		}),
	);
	await runFocusedAgentCommand(session, "/goal drop");
	expect(session.getEnabledToolNames()).not.toContain("goal");
});

test("the focused plan review reveals and adjudicates only that worker's actual pending proposal", async () => {
	const session = await setup();
	const run = (text: string) => runFocusedAgentCommand(session, text);
	const before = session.getEnabledToolNames();
	expect((await run("/plan outline the rollout")).result).toEqual({ prompt: "outline the rollout" });
	const planUrl = session.getPlanModeState()?.planFilePath;
	if (!planUrl) throw new Error("Worker plan mode did not install a plan path");
	const planPath = resolveLocalUrlToPath(planUrl, {
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		getSessionId: () => session.sessionManager.getSessionId(),
	});
	await Bun.write(planPath, "# Worker rollout\n\nRun the worker acceptance checks.");
	const proposal = session.peekPlanProposalHandler();
	if (!proposal) throw new Error("No worker proposal handler");
	const proposed = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "notice" && event.source === "plan-mode") proposed.resolve();
	});
	const result = proposal("Worker rollout");
	try {
		await withTimeout(proposed.promise, 5_000, "Worker proposal never reached review");
		const review = (await run("/plan-review")).output.join("\n");
		expect(review).toContain("Run the worker acceptance checks.");
		const approve = /\/plan-review approve (\S+)/.exec(review)?.[1];
		if (!approve) throw new Error("Review omitted its approval id");
		const invalid = await run("/plan-review approve other-worker-id");
		expect(invalid.result).toEqual({ consumed: true, failed: true });
		await run(`/plan-review approve ${approve}`);
		await result;
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).toEqual(before);
		expect((await run(`/plan-review approve ${approve}`)).result).toEqual({ consumed: true, failed: true });
	} finally {
		unsubscribe();
	}
});

test("focused modes cannot widen a restricted worker's tool grants", async () => {
	const session = await setup([], { restricted: true });
	const before = session.getEnabledToolNames();
	await expect(runFocusedAgentCommand(session, "/goal Set a forbidden goal")).rejects.toThrow("tool policy");
	await expect(runFocusedAgentCommand(session, "/guided-goal")).rejects.toThrow("tool policy");
	await expect(runFocusedAgentCommand(session, "/plan")).rejects.toThrow("tool policy");
	expect(session.getEnabledToolNames()).toEqual(before);
	expect(session.getGoalModeState()).toBeUndefined();
	expect(session.getPlanModeState()).toBeUndefined();
});

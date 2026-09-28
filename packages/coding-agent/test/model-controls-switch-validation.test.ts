import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("model switch effort preflight", () => {
	const source = getBundledModel("anthropic", "claude-opus-4-6");
	const target = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!source || !target) throw new Error("Bundled models for switch validation are missing");

	let dir: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let storage: AgentStorage;

	beforeAll(async () => {
		dir = TempDir.createSync("@pi-model-switch-validation-");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		auth.keys.setRuntime("anthropic", "test-key");
		registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
		storage = await AgentStorage.open(path.join(dir.path(), "agent.db"));
	});

	afterAll(() => {
		vi.restoreAllMocks();
		AgentStorage.close();
		auth.close();
		dir.removeSync();
	});

	async function createSession(): Promise<AgentSession> {
		const agent = new Agent({
			initialState: {
				model: source,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Max,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}, { storage }),
			modelRegistry: registry,
		});
		session.setThinkingLevel(Effort.Max);
		return session;
	}

	async function expectRejectedSwitchPreservesState(session: AgentSession, switchModel: () => Promise<unknown>) {
		const previousModel = session.model;
		const previousEffort = session.thinkingLevel;
		const previousEntries = session.sessionManager.getEntries();
		const previousUsage = storage.getModelUsageOrder();

		await expect(switchModel()).rejects.toThrow(/not supported/);
		expect(session.model).toBe(previousModel);
		expect(session.thinkingLevel).toBe(previousEffort);
		expect(session.sessionManager.getEntries()).toEqual(previousEntries);
		expect(storage.getModelUsageOrder()).toEqual(previousUsage);
	}

	it("rejects an unscoped cycle carrying a manual max effort before switching", async () => {
		const session = await createSession();
		vi.spyOn(registry, "getAvailable").mockReturnValue([source, target]);
		try {
			await expectRejectedSwitchPreservesState(session, () => session.cycleModel());
		} finally {
			vi.restoreAllMocks();
			await session.dispose();
		}
	});

	it("rejects a temporary model with an unsupported explicit effort before switching", async () => {
		const session = await createSession();
		try {
			await expectRejectedSwitchPreservesState(session, () => session.setModelTemporary(target, Effort.Max));
		} finally {
			await session.dispose();
		}
	});
});

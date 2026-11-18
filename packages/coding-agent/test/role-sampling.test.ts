import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { streamSimple, type Api, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import {
	cfgMinP,
	cfgOmitThinking,
	cfgPresencePenalty,
	cfgRepetitionPenalty,
	cfgSampling,
	cfgTemperature,
	cfgTextVerbosity,
	cfgTierAnthropic,
	cfgTierGoogle,
	cfgTierOpenai,
	cfgTopK,
	cfgTopP,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const numericSettings = [cfgTemperature, cfgTopP, cfgTopK, cfgMinP, cfgPresencePenalty, cfgRepetitionPenalty];
const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

function requiredModel(provider: "openai" | "anthropic", id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing fixture model ${provider}/${id}`);
	return model;
}

async function requestPayload(
	model: Model<Api>,
	settings: Settings,
	settingsAware = false,
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const options: SimpleStreamOptions = {
		...cfgSampling.get(settings),
		apiKey: "test-key",
		maxTokens: 16,
		fetch: async () => new Response(new Uint8Array(), { status: 200 }),
		onPayload: payload => {
			body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
		},
	};
	const stream = settingsAware ? createSettingsAwareStreamFn(settings) : streamSimple;
	await (await stream(model, context, options)).result();
	if (!body) throw new Error("Provider did not build a request payload");
	return body;
}

describe("role-scoped sampling and request settings", () => {
	let temp: TempDir;
	let state: SettingsTestState;
	let session: AgentSession | undefined;
	let auth: AuthStorage;
	let modelRegistry: ModelRegistry;
	let fixture: TempDir;

	beforeAll(async () => {
		fixture = TempDir.createSync("@role-sampling-auth-");
		auth = await AuthStorage.create(fixture.join("auth.db"));
		auth.keys.setRuntime("openai", "test-key");
		auth.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(auth, fixture.join("models.yml"));
	});

	beforeEach(() => {
		state = beginSettingsTest();
		temp = TempDir.createSync("@role-sampling-");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		restoreSettingsTestState(state);
		temp.removeSync();
	});

	afterAll(() => {
		auth.close();
		fixture.removeSync();
	});

	it.each(numericSettings)("keeps inherit, explicit value, and provider default distinct for $id", setting => {
		const settings = Settings.isolated();
		setting.set(settings, 0.9);
		settings.setRoleSetting("precise", setting, 0);
		settings.setRoleSetting("provider", setting, -1);

		settings.setActiveRole("precise");
		expect(setting.get(settings)).toBe(0);
		settings.setActiveRole("provider");
		expect(setting.get(settings)).toBe(-1);
		expect(cfgSampling.get(settings)).toHaveProperty(setting.id, undefined);
		settings.setActiveRole("inherited");
		expect(setting.get(settings)).toBe(0.9);
		setting.set(settings, 0.7);
		expect(setting.get(settings)).toBe(0.7);
		settings.setActiveRole("precise");
		settings.setRoleSetting("precise", setting, undefined);
		expect(settings.getRoleSetting("precise", setting)).toBeUndefined();
		expect(setting.get(settings)).toBe(0.7);
	});

	it("applies sampling and general settings on the picker role-switch path without leaking them", async () => {
		const model = requiredModel("openai", "gpt-4o-mini");
		const settings = Settings.isolated();
		cfgTemperature.set(settings, 0.9);
		cfgTierOpenai.set(settings, "priority");
		settings.setModelRole("default", "openai/gpt-4o-mini");
		settings.setModelRole("precise", "openai/gpt-4o-mini");
		settings.setRoleSetting("precise", cfgTemperature, -1);
		settings.setRoleSetting("precise", cfgTopP, 0.25);
		settings.setRoleSetting("precise", cfgTopK, 20);
		settings.setRoleSetting("precise", cfgMinP, 0.05);
		settings.setRoleSetting("precise", cfgPresencePenalty, 0.5);
		settings.setRoleSetting("precise", cfgRepetitionPenalty, 1.1);
		settings.setRoleSetting("precise", cfgOmitThinking, true);
		settings.setRoleSetting("precise", cfgTierOpenai, "none");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			settings,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
		});

		await session.applyRoleModel({ role: "precise", model, explicitThinkingLevel: false });
		expect(session.agent.temperature).toBeUndefined();
		expect(session.agent.topP).toBe(0.25);
		expect(session.agent.topK).toBe(20);
		expect(session.agent.minP).toBe(0.05);
		expect(session.agent.presencePenalty).toBe(0.5);
		expect(session.agent.repetitionPenalty).toBe(1.1);
		expect(session.agent.hideThinkingSummary).toBe(true);
		expect(session.serviceTierByFamily.openai).toBeUndefined();

		await session.applyRoleModel({ role: "default", model, explicitThinkingLevel: false });
		expect(session.agent.temperature).toBe(0.9);
		expect(session.agent.topP).toBeUndefined();
		expect(session.agent.hideThinkingSummary).toBe(false);
		expect(session.serviceTierByFamily.openai).toBe("priority");

		await session.applyRoleModel({ role: "precise", model, explicitThinkingLevel: false });
		await session.setModelTemporary(model);
		expect(session.agent.temperature).toBe(0.9);
		expect(cfgTemperature.get(settings)).toBe(0.9);
	});

	it("restores role request settings when constructing a resumed session", async () => {
		const model = requiredModel("openai", "gpt-4o-mini");
		const settings = Settings.isolated();
		cfgTemperature.set(settings, 0.9);
		cfgTierOpenai.set(settings, "priority");
		settings.setModelRole("precise", "openai/gpt-4o-mini");
		settings.setRoleSetting("precise", cfgTemperature, -1);
		settings.setRoleSetting("precise", cfgTierOpenai, "none");
		const sessionManager = SessionManager.create(process.cwd(), temp.path());
		sessionManager.appendModelChange("openai/gpt-4o-mini", "precise");
		session = new AgentSession({
			agent: new Agent({
				temperature: 0.9,
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			settings,
			sessionManager,
			modelRegistry,
			serviceTierByFamily: { openai: "priority" },
		});
		await Promise.resolve();
		expect(session.agent.temperature).toBeUndefined();
		expect(session.serviceTierByFamily.openai).toBeUndefined();

		sessionManager.appendMessage(createAssistantMessage("done"));
		session.setServiceTierFamily("openai", "priority");
		session.agent.temperature = 0.8;
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted role session");
		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.agent.temperature).toBeUndefined();
		expect(session.serviceTierByFamily.openai).toBeUndefined();
	});

	it("sends role values only when the provider and model accept the corresponding parameter", async () => {
		const settings = Settings.isolated();
		for (const setting of numericSettings) settings.setRoleSetting("sample", setting, setting === cfgTopK ? 40 : 0.5);
		settings.setActiveRole("sample");
		const supported = await requestPayload(requiredModel("openai", "gpt-4o-mini"), settings);
		expect(supported.temperature).toBe(0.5);
		expect(supported.top_p).toBe(0.5);
		for (const key of ["top_k", "min_p", "presence_penalty", "repetition_penalty"]) {
			expect(supported).not.toHaveProperty(key);
		}
		const unsupported = await requestPayload(requiredModel("openai", "gpt-5"), settings);
		for (const key of ["temperature", "top_p", "top_k", "min_p", "presence_penalty", "repetition_penalty"]) {
			expect(unsupported).not.toHaveProperty(key);
		}
		const anthropic = await requestPayload(requiredModel("anthropic", "claude-sonnet-4-5"), settings);
		expect(anthropic.temperature).toBe(0.5);
		for (const key of ["min_p", "presence_penalty", "repetition_penalty"]) expect(anthropic).not.toHaveProperty(key);
	});

	it("omits an explicit role provider-default rather than sending the global temperature", async () => {
		const settings = Settings.isolated();
		cfgTemperature.set(settings, 0.9);
		settings.setRoleSetting("provider", cfgTemperature, -1);
		settings.setActiveRole("provider");
		expect(await requestPayload(requiredModel("openai", "gpt-4o-mini"), settings)).not.toHaveProperty("temperature");
		settings.setActiveRole(undefined);
		expect((await requestPayload(requiredModel("openai", "gpt-4o-mini"), settings)).temperature).toBe(0.9);
	});

	it("resolves non-sampling request controls per role with the existing value types", async () => {
		const settings = Settings.isolated();
		settings.setRoleSetting("detailed", cfgTextVerbosity, "high");
		settings.setRoleSetting("detailed", cfgOmitThinking, true);
		settings.setRoleSetting("detailed", cfgTierAnthropic, "priority");
		settings.setRoleSetting("detailed", cfgTierGoogle, "flex");
		settings.setActiveRole("detailed");
		expect(cfgTextVerbosity.isConfigured(settings)).toBe(true);
		expect(cfgOmitThinking.get(settings)).toBe(true);
		expect(cfgTierAnthropic.get(settings)).toBe("priority");
		expect(cfgTierGoogle.get(settings)).toBe("flex");
		const payload = await requestPayload(requiredModel("openai", "gpt-4o-mini"), settings, true);
		expect(payload.text).toMatchObject({ verbosity: "high" });
		settings.setActiveRole(undefined);
		expect(cfgTextVerbosity.isConfigured(settings)).toBe(false);
		expect(cfgOmitThinking.get(settings)).toBe(false);
		expect(cfgTierAnthropic.get(settings)).toBe("none");
		expect(cfgTierGoogle.get(settings)).toBe("none");
	});

	it("loads unchanged global config with no role overrides, and persists overrides without baking in activation", async () => {
		const agentDir = temp.join("agent");
		const cwd = temp.join("project");
		await fs.mkdir(cwd, { recursive: true });
		const configPath = path.join(agentDir, "config.yml");
		await Bun.write(configPath, "temperature: 0.9\ntextVerbosity: low\n");
		const settings = await Settings.init({ cwd, agentDir });
		expect(cfgTemperature.get(settings)).toBe(0.9);
		expect(cfgTextVerbosity.get(settings)).toBe("low");
		settings.setRoleSetting("precise", cfgTemperature, -1);
		settings.setRoleSetting("precise", cfgTextVerbosity, "high");
		settings.setModelRole("precise", "openai/gpt-4o-mini");
		settings.setActiveRole("precise");
		settings.setModelRole("precise", "anthropic/claude-sonnet-4-5");
		expect(settings.getRoleSetting("precise", cfgTemperature)).toBe(-1);
		await settings.flush();

		const reloaded = await settings.cloneForCwd(cwd);
		reloaded.setActiveRole(undefined);
		expect(cfgTemperature.get(reloaded)).toBe(0.9);
		expect(reloaded.getRoleSetting("precise", cfgTemperature)).toBe(-1);
		expect(reloaded.getRoleSetting("precise", cfgTextVerbosity)).toBe("high");
		expect(reloaded.getModelRole("precise")).toBe("anthropic/claude-sonnet-4-5");
	});
});

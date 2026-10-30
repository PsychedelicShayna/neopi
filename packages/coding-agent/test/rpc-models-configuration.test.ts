import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgCycleOrder, cfgModelRoleStorage, cfgModelTags } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgEffortRules } from "@oh-my-pi/pi-coding-agent/config/effort-policy";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcModelsConfiguration } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-models-configuration";
import { RpcModelsCommands } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-models-commands";
import { RpcPendingExtensionRequests } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgCompactionEnabled, cfgCompactionThresholdTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

describe("native model configuration", () => {
	let auth: AuthStorage;
	let session: AgentSession;
	let settings: Settings;
	let configuration: RpcModelsConfiguration;
	beforeEach(() => {
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("anthropic", "fixture-key-never-returned");
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing native test model");
		vi.spyOn(registry, "getAll").mockReturnValue([{ ...model, description: "Native catalog description" }]);
		vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
		settings = Settings.isolated({ modelRoles: { default: `${model.provider}/${model.id}` } });
		cfgModelRoleStorage.set(settings, "project");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		configuration = new RpcModelsConfiguration(session);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		auth.close();
	});

	test("scoped regex assignment uses native resolution, not the current model, and preserves the global role", async () => {
		const before = session.model;
		await configuration.setRole({
			role: "reviewer",
			scope: "global",
			selector: "anthropic/claude-sonnet-4-5",
			expected: { selector: null, effort: null },
		});
		await configuration.setRole({
			role: "reviewer",
			scope: "project",
			selector: "re:^anthropic/claude-sonnet-4-5$",
			effort: { mode: "auto", allowed: ["off", ThinkingLevel.Low] },
			expected: { selector: null, effort: null },
		});
		const role = (await configuration.read()).roles.find(role => role.id === "reviewer");
		expect(role).toMatchObject({
			provenance: "project",
			global: { selector: "anthropic/claude-sonnet-4-5" },
			project: { selector: "re:^anthropic/claude-sonnet-4-5$", effort: { mode: "auto", allowed: ["off", "low"] } },
			resolved: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		});
		expect(session.model).toBe(before);
		await configuration.setRole({ role: "reviewer", scope: "project", expected: role!.project });
		expect(settings.getModelRole("reviewer")).toBe("anthropic/claude-sonnet-4-5");
	});

	test("a stale scoped role fails without replacing the newer value or effort", async () => {
		await configuration.setRole({
			role: "reviewer",
			scope: "global",
			selector: "anthropic/claude-sonnet-4-5",
			effort: { mode: "inherit" },
			expected: { selector: null, effort: null },
		});
		await expect(
			configuration.setRole({
				role: "reviewer",
				scope: "global",
				selector: "anthropic/*",
				expected: { selector: null, effort: null },
			}),
		).rejects.toMatchObject({ code: "configuration_conflict" });
		expect(settings.getGlobalRoleEffortSelection("reviewer")).toEqual({ mode: "inherit" });
		expect(settings.getGlobalModelRole("reviewer")).toBe("anthropic/claude-sonnet-4-5");
	});

	test("effort rules preserve off and scoped inheritance, and reject stale and invalid writes", async () => {
		const rules = [{ selector: "anthropic/*", allowed: ["off" as const, ThinkingLevel.Low] }];
		await configuration.setEffortRules({ scope: "global", rules, expected: null });
		await configuration.setEffortRules({
			scope: "project",
			rules: [{ selector: "re:^anthropic/", allowed: ["off"] }],
			expected: null,
		});
		expect(cfgEffortRules.get(settings)).toEqual([{ selector: "re:^anthropic/", allowed: ["off"] }]);
		await expect(configuration.setEffortRules({ scope: "project", rules: [], expected: null })).rejects.toMatchObject(
			{ code: "configuration_conflict" },
		);
		await expect(
			configuration.setEffortRules({
				scope: "global",
				rules: [{ selector: "anthropic/*", allowed: [] }],
				expected: rules,
			}),
		).rejects.toThrow();
		await configuration.setEffortRules({
			scope: "project",
			expected: [{ selector: "re:^anthropic/", allowed: ["off"] }],
		});
		expect(cfgEffortRules.get(settings)).toEqual(rules);
	});

	test("catalog projects native providers and facts without credential bytes", async () => {
		const result = await configuration.read();
		expect(result.models[0]).toMatchObject({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			description: "Native catalog description",
			available: true,
		});
		expect(result.providers.find(provider => provider.id === "anthropic")).toMatchObject({
			authenticated: true,
			mark: { icon: "provider:anthropic" },
			acceptsKeys: true,
		});
		expect(JSON.stringify(result)).not.toContain("fixture-key-never-returned");
	});

	test("an unconfigured session can read native setup metadata while prompts still require a model", async () => {
		auth.keys.removeRuntime("anthropic");
		await session.dispose();
		session = new AgentSession({
			agent: new Agent({ initialState: { model: undefined, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: session.modelRegistry,
		});
		vi.spyOn(session.modelRegistry, "getAll").mockReturnValue([]);
		vi.spyOn(session.modelRegistry, "getAvailable").mockReturnValue([]);
		const commands = new RpcModelsCommands({
			session,
			output: () => {},
			pending: new RpcPendingExtensionRequests(),
			input: async () => undefined,
		});
		const response = await commands.handle({ type: "get_models_configuration", id: "fresh-configuration" });
		expect(response).toMatchObject({ success: true, data: { models: [] } });
		const providers = await commands.handle({ type: "get_login_providers", id: "fresh-providers" });
		expect(providers).toMatchObject({ success: true });
		expect(auth.credentials.list("anthropic")).toEqual([]);
		await expect(session.prompt("A model call must not start before setup")).rejects.toThrow("No model selected.");
	});

	test("catalog reports the native effective budget separately from model capability", async () => {
		cfgCompactionEnabled.override(settings, true);
		cfgCompactionThresholdTokens.override(settings, 50000);
		const model = session.model;
		if (!model) throw new Error("Missing session model");
		const result = await configuration.read();
		expect(result.models[0]?.effectiveContextWindow).toBe(50000);
		expect(result.models[0]?.contextWindow).toBe(model.contextWindow);
	});

	test("role storage can be changed through its owner without dropping either saved scope", async () => {
		await configuration.setRole({
			role: "reviewer",
			scope: "global",
			selector: "anthropic/claude-sonnet-4-5",
			expected: { selector: null, effort: null },
		});
		await configuration.setRole({
			role: "reviewer",
			scope: "project",
			selector: "re:^anthropic/",
			expected: { selector: null, effort: null },
		});
		await configuration.setRoleStorage({ value: "global", expected: "project" });
		expect(cfgModelRoleStorage.get(settings)).toBe("global");
		expect(settings.getGlobalModelRole("reviewer")).toBe("anthropic/claude-sonnet-4-5");
		expect(settings.getProjectModelRole("reviewer")).toBe("re:^anthropic/");
		await expect(configuration.setRoleStorage({ value: "project", expected: "project" })).rejects.toMatchObject({
			code: "configuration_conflict",
		});
	});

	test("explicit project assignment works with global storage and never changes that preference", async () => {
		cfgModelRoleStorage.set(settings, "global");
		const commands = new RpcModelsCommands({
			session,
			output: () => {},
			pending: new RpcPendingExtensionRequests(),
			input: async () => undefined,
		});
		expect(
			await commands.handle({
				type: "set_model_role_configuration",
				role: "reviewer",
				scope: "project",
				selector: "anthropic/claude-sonnet-4-5",
				expected: { selector: null, effort: null },
			}),
		).toMatchObject({ success: true });
		const result = await configuration.read();
		expect(result.roleStorage).toBe("global");
		expect(result.roles.find(role => role.id === "reviewer")).toMatchObject({
			source: "configured",
			provenance: "project",
			project: { selector: "anthropic/claude-sonnet-4-5" },
			global: { selector: null, effort: null },
		});
		expect(result.roles.find(role => role.id === "default")?.source).toBe("builtin");
	});

	test("global editing resolution does not borrow the project's model or aliases", async () => {
		const first = session.model;
		if (!first) throw new Error("Missing native fixture model");
		const second = { ...first, id: "project-only-model", name: "Project model" };
		vi.spyOn(session.modelRegistry, "getAll").mockReturnValue([first, second]);
		vi.spyOn(session.modelRegistry, "getAvailable").mockReturnValue([first, second]);
		const globalSelector = `${first.provider}/${first.id}`;
		const projectSelector = `${second.provider}/${second.id}`;
		await configuration.setRole({
			role: "target",
			scope: "global",
			selector: globalSelector,
			expected: { selector: null, effort: null },
		});
		await configuration.setRole({
			role: "target",
			scope: "project",
			selector: projectSelector,
			expected: { selector: null, effort: null },
		});
		await configuration.setRole({
			role: "reviewer",
			scope: "global",
			selector: "@target",
			expected: { selector: null, effort: null },
		});
		const role = (await configuration.read()).roles.find(role => role.id === "reviewer");
		expect(role).toMatchObject({
			source: "configured",
			section: "chat",
			resolved: { provider: second.provider, modelId: second.id },
			scopedResolutions: {
				global: { provider: first.provider, modelId: first.id },
				project: { provider: second.provider, modelId: second.id },
			},
		});
		expect(role?.patterns).toContain(projectSelector);
	});

	test("malformed authored regexes fail visibly without saving role, fallback or effort-rule state", async () => {
		const commands = new RpcModelsCommands({
			session,
			output: () => {},
			pending: new RpcPendingExtensionRequests(),
			input: async () => undefined,
		});
		const before = await configuration.read();
		expect(
			await commands.handle({
				type: "set_model_role_configuration",
				role: "invalid-role",
				scope: "global",
				selector: "re:[",
				expected: { selector: null, effort: null },
			}),
		).toMatchObject({ success: false, code: "invalid_value", error: "Invalid model selector regex: re:[" });
		expect(
			await commands.handle({
				type: "set_model_role_fallbacks",
				role: "default",
				scope: "global",
				chain: ["re:["],
				efforts: {},
				expected: { chain: [], efforts: {} },
			}),
		).toMatchObject({ success: false, code: "invalid_value", error: "Invalid model selector regex: re:[" });
		expect(
			await commands.handle({
				type: "set_effort_rules",
				scope: "global",
				rules: [{ selector: "re:[", allowed: [ThinkingLevel.Low] }],
				expected: null,
			}),
		).toMatchObject({ success: false, code: "invalid_value", error: "Invalid model selector regex: re:[" });
		const after = await configuration.read();
		expect(after.roles.some(role => role.id === "invalid-role")).toBe(false);
		expect(after.roles.find(role => role.id === "default")?.fallbacks).toEqual(
			before.roles.find(role => role.id === "default")?.fallbacks,
		);
		expect(after.effortRuleScopes).toEqual(before.effortRuleScopes);
	});

	test("fallback commands round-trip native order and effort, refuse stale writes and wrong scopes", async () => {
		const commands = new RpcModelsCommands({
			session,
			output: () => {},
			pending: new RpcPendingExtensionRequests(),
			input: async () => undefined,
		});
		const fallback = {
			chain: ["anthropic/claude-sonnet-4-5:low", "anthropic/*"],
			efforts: { "anthropic/*": { mode: "inherit" as const } },
		};
		expect(
			await commands.handle({
				type: "set_model_role_fallbacks",
				role: "default",
				scope: "global",
				...fallback,
				expected: { chain: [], efforts: {} },
			}),
		).toMatchObject({ success: true });
		const role = (await configuration.read()).roles.find(role => role.id === "default");
		expect(role).toMatchObject({ fallbacks: fallback, fallbacksGlobal: fallback });
		expect(
			await commands.handle({
				type: "set_model_role_fallbacks",
				role: "default",
				scope: "global",
				chain: [],
				efforts: {},
				expected: { chain: [], efforts: {} },
			}),
		).toMatchObject({ success: false, code: "configuration_conflict" });
		expect(
			await commands.handle({
				type: "set_model_role_fallbacks",
				role: "default",
				scope: "project",
				chain: [],
				efforts: {},
				expected: fallback,
			}),
		).toMatchObject({ success: false, code: "scope_mismatch" });
		expect(
			await commands.handle({
				type: "set_model_role_fallbacks",
				role: "default",
				scope: "global",
				chain: ["anthropic/*"],
				efforts: { "other/*": { mode: "inherit" } },
				expected: fallback,
			}),
		).toMatchObject({ success: false, code: "invalid_value" });
		expect(
			await commands.handle({
				type: "set_model_role_fallbacks",
				role: "default",
				scope: "global",
				chain: [],
				efforts: {},
				expected: fallback,
			}),
		).toMatchObject({ success: true });
		expect((await configuration.read()).roles.find(role => role.id === "default")?.fallbacks).toEqual({
			chain: [],
			efforts: {},
		});
	});

	test("description writes preserve role metadata and reject stale or unknown role edits", async () => {
		cfgModelTags.setEntry(settings, "reviewer", { name: "Reviewer", color: "warning", hidden: true });
		const commands = new RpcModelsCommands({
			session,
			output: () => {},
			pending: new RpcPendingExtensionRequests(),
			input: async () => undefined,
		});
		expect(
			await commands.handle({
				type: "set_model_role_description",
				role: "reviewer",
				scope: "global",
				description: "Reviews changes",
				expected: null,
			}),
		).toMatchObject({ success: true });
		expect((await configuration.read()).roles.find(role => role.id === "reviewer")).toMatchObject({
			name: "Reviewer",
			hidden: true,
			description: "Reviews changes",
			source: "configured",
		});
		expect(cfgModelTags.get(settings).reviewer?.color).toBe("warning");
		expect(
			await commands.handle({
				type: "set_model_role_description",
				role: "reviewer",
				scope: "global",
				description: "Old edit",
				expected: null,
			}),
		).toMatchObject({ success: false, code: "configuration_conflict" });
		expect(
			await commands.handle({
				type: "set_model_role_description",
				role: "missing-role",
				scope: "global",
				description: "No",
				expected: null,
			}),
		).toMatchObject({ success: false, code: "unknown_role" });
		expect(
			await commands.handle({
				type: "set_model_role_fallbacks",
				role: "missing-role",
				scope: "global",
				chain: [],
				efforts: {},
				expected: { chain: [], efforts: {} },
			}),
		).toMatchObject({ success: false, code: "unknown_role" });
		expect(
			await commands.handle({
				type: "set_model_role_description",
				role: "reviewer",
				scope: "project",
				description: "No",
				expected: "Reviews changes",
			}),
		).toMatchObject({ success: false, code: "scope_mismatch" });
	});

	test("custom role deletion removes its native definition but refuses built-ins, unknown roles and mismatched scopes", async () => {
		await configuration.setRole({
			role: "reviewer",
			scope: "global",
			selector: "anthropic/*",
			effort: { mode: "inherit" },
			expected: { selector: null, effort: null },
		});
		cfgModelTags.setEntry(settings, "reviewer", { name: "Reviewer", description: "Temporary" });
		cfgCycleOrder.set(settings, ["default", "reviewer"]);
		settings.setFallbackChainAndEfforts("reviewer", ["anthropic/*"], {});
		const commands = new RpcModelsCommands({
			session,
			output: () => {},
			pending: new RpcPendingExtensionRequests(),
			input: async () => undefined,
		});
		expect(
			await commands.handle({
				type: "delete_model_role",
				role: "reviewer",
				scope: "project",
				expected: { selector: null, effort: null },
			}),
		).toMatchObject({ success: false, code: "scope_mismatch" });
		expect(
			await commands.handle({
				type: "delete_model_role",
				role: "default",
				scope: "global",
				expected: { selector: null, effort: null },
			}),
		).toMatchObject({ success: false, code: "builtin_role" });
		expect(
			await commands.handle({
				type: "delete_model_role",
				role: "missing-role",
				scope: "global",
				expected: { selector: null, effort: null },
			}),
		).toMatchObject({ success: false, code: "unknown_role" });
		expect(
			await commands.handle({
				type: "delete_model_role",
				role: "reviewer",
				scope: "global",
				expected: { selector: null, effort: null },
			}),
		).toMatchObject({ success: false, code: "configuration_conflict" });
		expect(
			await commands.handle({
				type: "delete_model_role",
				role: "reviewer",
				scope: "global",
				expected: { selector: "anthropic/*", effort: { mode: "inherit" } },
			}),
		).toMatchObject({ success: true });
		expect((await configuration.read()).roles.some(role => role.id === "reviewer")).toBe(false);
		expect(cfgRetryFallbackChains.get(settings).reviewer).toBeUndefined();
		expect(cfgCycleOrder.get(settings)).toEqual(["default"]);
	});

	test("deleting a project custom role preserves the inherited global definition", async () => {
		await configuration.setRole({
			role: "reviewer",
			scope: "global",
			selector: "anthropic/*",
			expected: { selector: null, effort: null },
		});
		await configuration.setRole({
			role: "reviewer",
			scope: "project",
			selector: "anthropic/claude-sonnet-4-5",
			expected: { selector: null, effort: null },
		});
		const commands = new RpcModelsCommands({
			session,
			output: () => {},
			pending: new RpcPendingExtensionRequests(),
			input: async () => undefined,
		});
		expect(
			await commands.handle({
				type: "delete_model_role",
				role: "reviewer",
				scope: "project",
				expected: { selector: "anthropic/claude-sonnet-4-5", effort: null },
			}),
		).toMatchObject({ success: true });
		expect((await configuration.read()).roles.find(role => role.id === "reviewer")).toMatchObject({
			global: { selector: "anthropic/*" },
			project: { selector: null, effort: null },
			provenance: "global",
		});
	});

	test("login cancellation is connection-owned and disconnect aborts the remaining flow", async () => {
		const started = Promise.withResolvers<void>();
		const signals: AbortSignal[] = [];
		vi.spyOn(auth.oauth, "login").mockImplementation(async (_provider, ctrl) => {
			if (!ctrl.signal) throw new Error("Missing cancellation signal");
			signals.push(ctrl.signal);
			started.resolve();
			const pendingLogin = Promise.withResolvers<void>();
			ctrl.signal.addEventListener("abort", () => pendingLogin.reject(new Error("aborted")), { once: true });
			await pendingLogin.promise;
			return { type: "api_key" };
		});
		const pending = new RpcPendingExtensionRequests();
		const options = { session, output: () => {}, pending, input: async () => undefined };
		const first = new RpcModelsCommands(options);
		const second = new RpcModelsCommands({ ...options, pending: new RpcPendingExtensionRequests() });
		const login = first.handle({ type: "login", providerId: "anthropic", id: "login-fixture" });
		await started.promise;
		expect(await second.handle({ type: "cancel_login", loginId: "login-fixture" })).toMatchObject({ success: false });
		expect(signals[0]?.aborted).toBe(false);
		pending.rejectAll("connection closed");
		expect(await login).toMatchObject({ success: false, code: "login_cancelled" });
		expect(signals[0]?.aborted).toBe(true);
	});
});

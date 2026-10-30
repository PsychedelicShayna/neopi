import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { EffortSelection } from "@oh-my-pi/pi-coding-agent/config/effort-policy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type RawSettings, Settings, type SettingsScope } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { cfgRoleSettings } from "@oh-my-pi/pi-coding-agent/config/role-settings";
import { cfgCompactionThresholdTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import * as factEditorModule from "@oh-my-pi/pi-coding-agent/modes/components/model-fact-editor";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as modelHubModule from "@oh-my-pi/pi-tui/overlays/model-hub";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

const model = (id: string) => getBundledModel("anthropic", id) as Model;

// Settings writes made through the model hub, driven through the controller's real hub callbacks.
describe("SelectorController model hub writes", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-selector-model-writes-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		restoreSettingsTestState(state);
		state = undefined;
		await session?.dispose();
		session = undefined;
		authStorage.close();
		AgentStorage.close();
		// SQLite keeps agent.db open until GC finalizes its statements; Windows cannot delete an open file.
		Bun.gc(true);
		tempDir.removeSync();
	});

	function start(settings: Settings, initial: Model): { controller: SelectorController; showError: () => unknown } {
		const live = new AgentSession({
			agent: new Agent({ initialState: { model: initial, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, undefined, { settings }),
			obfuscator: new SecretObfuscator([]),
		});
		session = live;
		const showError = vi.fn();
		const controller = new SelectorController(
			createInteractiveModeContext({
				session: live,
				settings,
				ui: { showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => false }) },
				keybindings: { getKeys: () => [], getDisplayString: () => "" },
				showError,
			}),
		);
		return { controller, showError };
	}

	function openModelHub(controller: SelectorController, scope?: SettingsScope): modelHubModule.ModelHubCallbacks {
		let callbacks: modelHubModule.ModelHubCallbacks | undefined;
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (...args: unknown[]) {
			callbacks = args[4] as modelHubModule.ModelHubCallbacks;
			return { refreshAfterExternalMutation: () => {}, dispose: () => {} };
		} as never);
		controller.showModelSelector({ scope });
		if (!callbacks) throw new Error("model hub was not opened");
		return callbacks;
	}

	it.each(["global", "project", "session"] as const)("keeps %s default assignments below higher scopes", async scope => {
		const settings = Settings.isolated();
		for (const layer of ["global", "project", "session"] as const) {
			settings.setRoleModelAndEffort("default", "anthropic/claude-opus-4-5", undefined, layer);
		}
		const { controller, showError } = start(settings, model("claude-opus-4-5"));
		const hub = openModelHub(controller, scope);
		expect(await hub.onAssign(
			model("claude-sonnet-4-5"), "default", undefined, "anthropic/claude-sonnet-4-5", scope,
		)).toBe(true);
		expect(showError).not.toHaveBeenCalled();
		expect(settings.getModelRoleScopeDetails("default", scope)[scope]).toBe("anthropic/claude-sonnet-4-5");
		expect(settings.getModelRoleProvenance("default")).toBe("session");
		expect(session?.model?.id).toBe(scope === "session" ? "claude-sonnet-4-5" : "claude-opus-4-5");
	});

	it.each(["global", "project", "session"] as const)("edits and clears only the %s role token budget", scope => {
		const settings = Settings.isolated();
		for (const layer of ["global", "project", "session"] as const) {
			settings.writeScopeValue(cfgRoleSettings, { default: { "compaction.thresholdTokens": 120000 } }, layer);
		}
		const { controller, showError } = start(settings, model("claude-opus-4-5"));
		const hub = openModelHub(controller, scope);
		expect(hub.onRoleTokenBudgetChange?.("default", 64000)).toBe(true);
		for (const layer of ["global", "project", "session"] as const) {
			expect(settings.readScopeValue(cfgRoleSettings, layer)).toEqual({
				default: { "compaction.thresholdTokens": layer === scope ? 64000 : 120000 },
			});
		}
		expect(settings.getRoleSetting("default", cfgCompactionThresholdTokens)).toBe(scope === "session" ? 64000 : 120000);
		expect(hub.onRoleTokenBudgetChange?.("default", undefined)).toBe(true);
		expect(settings.readScopeValue(cfgRoleSettings, scope)).toEqual({ default: { "compaction.thresholdTokens": null } });
		expect(showError).not.toHaveBeenCalled();
	});

	it("rich session-only selection changes the live model without changing saved defaults or roles", async () => {
		const agentDir = tempDir.join("agent");
		const configPath = path.join(agentDir, "config.yml");
		const original = YAML.stringify({
			modelRoles: { default: "anthropic/claude-opus-4-5", smol: "anthropic/claude-sonnet-4-5" },
		});
		await Bun.write(configPath, original);
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-opus-4-5"));
		let callbacks: modelHubModule.ModelHubCallbacks | undefined;
		let options: modelHubModule.ModelHubOptions | undefined;
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (...args: unknown[]) {
			callbacks = args[4] as modelHubModule.ModelHubCallbacks;
			options = args[5] as modelHubModule.ModelHubOptions;
			return { refreshAfterExternalMutation: () => {}, dispose: () => {} };
		} as never);
		controller.showModelSelector({ sessionOnly: true });
		expect(options?.sessionOnly).toBe(true);
		expect(options?.pinnedProviders).toEqual([]);
		expect(callbacks?.onEditFacts).toBeUndefined();
		expect(await callbacks?.onPick?.(model("claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5")).toBe(true);
		await settings.flush();
		expect(showError).not.toHaveBeenCalled();
		expect(session?.model?.id).toBe("claude-sonnet-4-5");
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");
		expect(settings.getModelRole("smol")).toBe("anthropic/claude-sonnet-4-5");
		expect(await Bun.file(configPath).text()).toBe(original);
	});

	it("opens the fact editor from full models and saves facts without changing role assignments", async () => {
		const agentDir = tempDir.join("agent");
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		const initial = model("claude-sonnet-4-5");
		settings.setModelRole("default", `anthropic/${initial.id}`);
		const { controller } = start(settings, initial);
		let options: factEditorModule.ModelFactEditorOptions | undefined;
		vi.spyOn(factEditorModule, "ModelFactEditorComponent").mockImplementation(function (
			value: factEditorModule.ModelFactEditorOptions,
		) {
			options = value;
			return { dispose: () => {} };
		} as never);
		if (!session) throw new Error("session missing");
		const refresh = vi.spyOn(session, "refreshModelFacts").mockResolvedValue();
		openModelHub(controller).onEditFacts?.("anthropic", initial);
		if (!options) throw new Error("fact editor was not opened");
		expect(options.provider).toBe("anthropic");
		expect(options.modelId).toBe(initial.id);
		await options.onSave({
			enabled: true,
			sources: ["extension-only"],
			overrides: { [`anthropic/${initial.id}`]: { contextWindow: 96_000 } },
		});
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(settings.getModelRole("default")).toBe(`anthropic/${initial.id}`);
		const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as RawSettings;
		expect(saved.modelFacts).toEqual({
			enabled: true,
			sources: ["extension-only"],
			overrides: { [`anthropic/${initial.id}`]: { contextWindow: 96_000 } },
		});
		options.onClose();
	});
	it("saves only the edited fallback chain, never the chains a --config overlay supplies", async () => {
		const agentDir = tempDir.join("agent");
		const overlayPath = tempDir.join("overlay.yml");
		await Bun.write(
			overlayPath,
			YAML.stringify({
				retry: {
					fallbackChains: { smol: ["overlay/cheap"] },
					fallbackEffortSelections: {
						smol: { "overlay/cheap": { mode: "inherit" } },
						slow: { "user/slow-fallback": { mode: "inherit" } },
					},
				},
			}),
		);
		// The global instance, as in the app: the hub's status text reads the global settings.
		const settings = await Settings.init({ agentDir, cwd: tempDir.path(), configFiles: [overlayPath] });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));

		openModelHub(controller).onFallbackChainChange?.("slow", ["user/slow-fallback"]);
		await settings.flush();

		expect(showError).not.toHaveBeenCalled();
		const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as RawSettings;
		expect(saved).toEqual({ retry: { fallbackChains: { slow: ["user/slow-fallback"] } } });
	});

	it("preserves other persisted chains and drops emptied effort selections when editing a chain", async () => {
		const agentDir = tempDir.join("agent");
		await mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				retry: {
					fallbackChains: { default: ["user/default"], slow: ["user/old"] },
					fallbackEffortSelections: {
						default: { "user/default": { mode: "inherit" } },
						slow: { "user/old": { mode: "inherit" } },
					},
				},
			}),
		);
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));

		const hub = openModelHub(controller);
		hub.onFallbackChainChange?.("slow", ["user/new"]);
		await settings.flush();

		expect(showError).not.toHaveBeenCalled();
		const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as RawSettings;
		expect(saved).toEqual({
			retry: {
				fallbackChains: { default: ["user/default"], slow: ["user/new"] },
				fallbackEffortSelections: { default: { "user/default": { mode: "inherit" } } },
			},
		});

		// The hub is still open (the mock never closes it); a second showModelSelector
		// refocuses the registered menu instead of mounting a new one.
		hub.onFallbackChainChange?.("slow", []);
		await settings.flush();
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({
			retry: {
				fallbackChains: { default: ["user/default"] },
				fallbackEffortSelections: { default: { "user/default": { mode: "inherit" } } },
			},
		});
	});

	it("renames a pattern chain and persists its effort metadata without changing other chains", async () => {
		const agentDir = tempDir.join("agent");
		const oldKey = "re:primary";
		const key = "anthropic/*";
		const fallback = "anthropic/claude-sonnet-4-5";
		const policy: EffortSelection = { mode: "auto", allowed: [Effort.Low, Effort.High] };
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				retry: {
					fallbackChains: { [oldKey]: [fallback], default: ["anthropic/claude-opus-4-5"] },
					fallbackEffortSelections: { [oldKey]: { [fallback]: policy } },
				},
			}),
		);
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		const hub = openModelHub(controller);
		expect(hub.onFallbackChainKeyChange?.(oldKey, key)).toBe(true);
		await settings.flush();
		expect(showError).not.toHaveBeenCalled();
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({
			retry: {
				fallbackChains: { [key]: [fallback], default: ["anthropic/claude-opus-4-5"] },
				fallbackEffortSelections: { [key]: { [fallback]: policy } },
			},
		});
		expect(hub.onFallbackChainKeyChange?.(key, "default")).toBe(false);
		await settings.flush();
		expect(showError).toHaveBeenCalledWith("Fallback chain already exists: default");
		expect(settings.getGlobalFallbackEffortSelections(key)).toEqual({ [fallback]: policy });
	});

	it("initializes real settings when no fallback chains are configured", async () => {
		const settings = await Settings.init({ agentDir: tempDir.join("agent"), cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		expect(openModelHub(controller).onFallbackChainKeyChange?.("re:missing", "anthropic/*")).toBe(false);
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not copy an overlay-only chain when its defining key cannot be renamed", async () => {
		const agentDir = tempDir.join("agent");
		const overlayPath = tempDir.join("overlay.yml");
		await Bun.write(overlayPath, YAML.stringify({ retry: { fallbackChains: { "re:primary": ["user/backup"] } } }));
		const settings = await Settings.init({ agentDir, cwd: tempDir.path(), configFiles: [overlayPath] });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		expect(openModelHub(controller).onFallbackChainKeyChange?.("re:primary", "anthropic/*")).toBe(false);
		await settings.flush();
		expect(showError).toHaveBeenCalledWith("Rename this fallback chain in the config file that defines it");
		expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(false);
	});

	it.each(["default", "smol"])(
		"saves an unscoped %s assignment globally without touching project roles",
		async role => {
			const agentDir = tempDir.join("agent");
			const projectPath = tempDir.join(".omp", "config.yml");
			const project = { modelRoles: { [role]: "anthropic/claude-opus-4-5" } };
			await Bun.write(projectPath, YAML.stringify(project));
			await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ modelRoleStorage: "project" }));
			const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
			const { controller, showError } = start(settings, model("claude-opus-4-5"));

			await openModelHub(controller).onAssign(
				model("claude-sonnet-4-5"),
				role,
				undefined,
				"anthropic/claude-sonnet-4-5",
			);
			await settings.flush();

			expect(showError).not.toHaveBeenCalled();
			const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as RawSettings;
			expect(saved).toEqual({
				modelRoleStorage: "project",
				modelRoles: { [role]: "anthropic/claude-sonnet-4-5" },
			});
			expect(YAML.parse(await Bun.file(projectPath).text())).toEqual(project);
			expect(session?.model?.id).toBe("claude-opus-4-5");
		},
	);

	it("writes an explicitly project-scoped assignment only to the project layer", async () => {
		const agentDir = tempDir.join("agent");
		const globalPath = path.join(agentDir, "config.yml");
		const global = { modelRoleStorage: "project", modelRoles: { smol: "anthropic/claude-opus-4-5" } };
		await Bun.write(globalPath, YAML.stringify(global));
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-opus-4-5"));

		await openModelHub(controller).onAssign(
			model("claude-sonnet-4-5"),
			"smol",
			undefined,
			"anthropic/claude-sonnet-4-5",
			"project",
		);
		await settings.flush();

		expect(showError).not.toHaveBeenCalled();
		expect(YAML.parse(await Bun.file(globalPath).text())).toEqual(global);
		const project = YAML.parse(await Bun.file(tempDir.join(".omp", "config.yml")).text()) as RawSettings;
		expect(project).toEqual({ modelRoles: { smol: "anthropic/claude-sonnet-4-5" } });
	});

	it("switches the session to the project default when its already-assigned chip is picked", async () => {
		const agentDir = tempDir.join("agent");
		await Bun.write(
			tempDir.join(".omp", "config.yml"),
			YAML.stringify({ modelRoles: { default: "anthropic/claude-opus-4-5" } }),
		);
		const settings = await Settings.init({ agentDir, cwd: tempDir.path() });
		// The session moved off the configured default earlier (an in-session pick).
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));

		// The hub shows the project default as assigned, so picking it sends unassign.
		await openModelHub(controller).onUnassign("default");

		expect(showError).not.toHaveBeenCalled();
		expect(session?.model?.id).toBe("claude-opus-4-5");
	});

	it("refreshes the open hub once a confirmed compaction point has moved the model to its extended window", async () => {
		const settings = await Settings.init({ agentDir: tempDir.join("agent"), cwd: tempDir.path() });
		const { controller, showError } = start(settings, model("claude-sonnet-4-5"));
		const registry = session!.modelRegistry;
		const terra = registry.find("openai", "gpt-5.6-terra");
		if (!terra) throw new Error("Expected bundled gpt-5.6-terra");
		const refreshed = Promise.withResolvers<number | null | undefined>();
		vi.spyOn(modelHubModule, "ModelHubComponent").mockImplementation(function (...args: unknown[]) {
			const callbacks = args[4] as modelHubModule.ModelHubCallbacks;
			queueMicrotask(() => {
				expect(callbacks.onCompactionPointChange?.(terra, "400k", true)).toBeUndefined();
			});
			return {
				// The window the hub would re-read when it refreshes.
				refreshAfterExternalMutation: () =>
					refreshed.resolve(registry.find("openai", "gpt-5.6-terra")?.contextWindow),
				dispose: () => {},
			};
		} as never);
		controller.showModelSelector();

		expect(await refreshed.promise).toBe(1_050_000);
		expect(showError).not.toHaveBeenCalled();
	});
});

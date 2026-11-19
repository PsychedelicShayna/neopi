/**
 * Per-agent prewalk resolution in `runSubprocess`: configured planner/execution
 * crews, frontmatter and settings execution overrides, authenticated fallback
 * selection, progress attribution, and disabled/noop compatibility.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	cfgPrewalkExecution,
	cfgPrewalkExecutionFallbacks,
	cfgPrewalkPlanner,
	cfgPrewalkPlannerFallbacks,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

import { cfgTaskAgentPrewalk, cfgTaskPrewalk } from "@oh-my-pi/pi-coding-agent/task/settings";

function yieldEmittingSession(
	initialTools: string[] = ["read", "yield"],
	modelSwitch?: { from: Model; to: Model },
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let activeTools = initialTools;
	// `servingModel` mirrors the real session: attribution names the model that
	// produced output, so a prewalk hand-off moves it along with `model`.
	const serving = (model: Model | undefined): { selector: string; isFallback: boolean } | undefined =>
		model ? { selector: `${model.provider}/${model.id}`, isFallback: false } : undefined;
	const session = {
		...createSessionDefaults(event => {
			for (const listener of listeners) listener(event);
		}),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: modelSwitch?.from,
		servingModel: serving(modelSwitch?.from),
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => activeTools,
		getEnabledToolNames: () => activeTools,
		getAllToolNames: () => activeTools,
		setActiveToolsByName: async (toolNames: string[]) => {
			activeTools = toolNames;
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			if (modelSwitch) {
				session.model = modelSwitch.to;
				session.servingModel = serving(modelSwitch.to);
				for (const listener of listeners) {
					listener({ type: "notice", level: "info", message: "Prewalk switched", source: "prewalk" });
				}
			}
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-prewalk",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
			return true;
		},
	};
	return session as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

function modelOrThrow(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model ${id}`);
	return model;
}

function createModelRegistry(models: Model[]): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		awaitBackgroundRefresh: async () => {},
		getAvailable: () => models,
		getAll: () => models,
		getApiKey: async () => "test-key",
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("runSubprocess per-agent prewalk", () => {
	const primary = modelOrThrow("claude-sonnet-4-5");
	const target = modelOrThrow("claude-sonnet-4-6");

	function baseOptions(id: string, settings: Settings) {
		return {
			cwd: "/tmp",
			task: "do work",
			index: 0,
			id,
			settings,
			modelRegistry: createModelRegistry([primary, target]),
			enableLsp: false,
		};
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves a frontmatter prewalk pattern to a target for the spawned session", async () => {
		const settings = Settings.isolated();
		cfgPrewalkExecution.set(settings, `${primary.provider}/${primary.id}`);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-frontmatter", settings),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.prewalk?.target.id).toBe(target.id);
		expect(forwarded?.prewalk?.target.provider).toBe(target.provider);
	});

	it("waits for background discovery before resolving a configured prewalk target", async () => {
		const models = [primary];
		const registry = createModelRegistry(models);
		const refreshGate = Promise.withResolvers<void>();
		vi.spyOn(registry, "awaitBackgroundRefresh").mockImplementation(async () => {
			await refreshGate.promise;
			models.push(target);
		});
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const run = runSubprocess({
			...baseOptions("subagent-prewalk-discovery", Settings.isolated()),
			modelRegistry: registry,
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
		});
		expect(spy).not.toHaveBeenCalled();

		refreshGate.resolve();
		expect((await run).exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(target.id);
	});

	it("reports the prewalk target as the active model after handoff", async () => {
		const progressModels: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(yieldEmittingSession(["read", "yield"], { from: primary, to: target })),
		);

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-progress-model", Settings.isolated()),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
			onProgress: progress => {
				if (progress.resolvedModel) progressModels.push(progress.resolvedModel);
			},
		});

		expect(result.exitCode).toBe(0);
		expect(progressModels.at(-1)).toBe(`${target.provider}/${target.id}`);
	});

	it("resolves prewalk: true through the smol role default target", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${target.provider}/${target.id}`);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-default-target", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`], prewalk: true },
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.prewalk?.target.id).toBe(target.id);
	});

	it.each(["frontmatter", "agent-setting", "task-setting"] as const)(
		"uses configured execution for boolean enablement through %s",
		async enablement => {
			const settings = Settings.isolated();
			cfgPrewalkExecution.set(settings, `${target.provider}/${target.id}:low`);
			if (enablement === "agent-setting") cfgTaskAgentPrewalk.set(settings, { task: "on" });
			if (enablement === "task-setting") cfgTaskPrewalk.set(settings, true);
			const spy = vi
				.spyOn(sdkModule, "createAgentSession")
				.mockResolvedValue(createSessionResult(yieldEmittingSession()));

			const result = await runSubprocess({
				...baseOptions(`subagent-prewalk-configured-${enablement}`, settings),
				agent: {
					...baseAgent,
					model: [`${primary.provider}/${primary.id}`],
					prewalk: enablement === "frontmatter" ? true : undefined,
				},
			});

			expect(result.exitCode).toBe(0);
			const forwarded = spy.mock.calls[0]?.[0];
			expect(forwarded?.model?.id).toBe(primary.id);
			expect(forwarded?.prewalk?.target.id).toBe(target.id);
			expect(forwarded?.prewalk?.thinkingLevel).toBe(Effort.Low);
		},
	);

	it("starts on the configured planner and publishes both crew selections", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("plan-crew", `${target.provider}/${target.id}:high`);
		cfgPrewalkPlanner.set(settings, "@plan-crew");
		cfgPrewalkExecution.set(settings, `${primary.provider}/${primary.id}:low`);
		const progressModels: string[] = [];
		const progressRoutes: string[] = [];
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-independent-crew", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}:low`], prewalk: true },
			onProgress: progress => {
				if (progress.resolvedModel) progressModels.push(progress.resolvedModel);
				if (progress.resolvedModelRoute) progressRoutes.push(progress.resolvedModelRoute);
			},
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.model?.id).toBe(target.id);
		expect(forwarded?.thinkingLevel).toBe(Effort.High);
		expect(forwarded?.prewalk?.target.id).toBe(primary.id);
		expect(forwarded?.prewalk?.thinkingLevel).toBe(Effort.Low);
		expect(progressModels).toContain(`${target.provider}/${target.id}:high`);
		expect(progressRoutes.some(route => route.includes(`${primary.provider}/${primary.id}:low`))).toBe(true);
	});

	it("lets a settings string override both frontmatter and the configured execution selector", async () => {
		const settings = Settings.isolated();
		cfgPrewalkExecution.set(settings, "missing/configured-executor");
		cfgTaskAgentPrewalk.set(settings, { task: `${target.provider}/${target.id}:low` });
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-explicit-settings-target", settings),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${primary.provider}/${primary.id}`,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(target.id);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.thinkingLevel).toBe(Effort.Low);
	});

	it("uses execution fallbacks after an unavailable explicit frontmatter target", async () => {
		const settings = Settings.isolated();
		cfgPrewalkExecution.set(settings, `${primary.provider}/${primary.id}`);
		cfgPrewalkExecutionFallbacks.set(settings, [`${target.provider}/${target.id}:low`]);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-explicit-fallback", settings),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: "missing/explicit-executor",
			},
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(target.id);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.thinkingLevel).toBe(Effort.Low);
	});

	it.each(["planner", "execution"] as const)(
		"skips missing, unauthenticated and disabled %s candidates before using its fallback",
		async phase => {
			const settings = Settings.isolated();
			const unavailable = { ...target, id: "unauthenticated-crew" };
			const disabled = { ...target, provider: "disabled-crew-provider", id: "disabled-crew" };
			const registry = createModelRegistry([primary, target, unavailable, disabled]);
			vi.spyOn(registry, "hasConfiguredAuth").mockImplementation(model => model.id !== unavailable.id);
			cfgDisabledProviders.set(settings, [disabled.provider]);
			settings.setModelRole("crew-fallback", `${target.provider}/${target.id}:high`);
			const selectors = ["missing/crew", `${disabled.provider}/${disabled.id}`, "@crew-fallback"];
			if (phase === "planner") {
				cfgPrewalkPlanner.set(settings, `${unavailable.provider}/${unavailable.id}`);
				cfgPrewalkPlannerFallbacks.set(settings, selectors);
				cfgPrewalkExecution.set(settings, `${primary.provider}/${primary.id}:low`);
			} else {
				cfgPrewalkExecution.set(settings, `${unavailable.provider}/${unavailable.id}`);
				cfgPrewalkExecutionFallbacks.set(settings, selectors);
			}
			const spy = vi
				.spyOn(sdkModule, "createAgentSession")
				.mockResolvedValue(createSessionResult(yieldEmittingSession()));

			const result = await runSubprocess({
				...baseOptions(`subagent-prewalk-${phase}-fallback`, settings),
				modelRegistry: registry,
				agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}:low`], prewalk: true },
			});

			expect(result.exitCode).toBe(0);
			const forwarded = spy.mock.calls[0]?.[0];
			expect(forwarded?.model?.id).toBe(phase === "planner" ? target.id : primary.id);
			expect(forwarded?.thinkingLevel).toBe(phase === "planner" ? Effort.High : Effort.Low);
			expect(forwarded?.prewalk?.target.id).toBe(phase === "execution" ? target.id : primary.id);
			expect(forwarded?.prewalk?.thinkingLevel).toBe(phase === "execution" ? Effort.High : Effort.Low);
		},
	);

	it.each(["planner", "execution"] as const)(
		"retains the ordinary task model when the configured %s has no authenticated candidate",
		async phase => {
			const settings = Settings.isolated();
			cfgPrewalkPlanner.set(settings, `${target.provider}/${target.id}:high`);
			cfgPrewalkExecution.set(settings, `${primary.provider}/${primary.id}:low`);
			const unavailable = { ...target, id: "unauthenticated-crew" };
			const registry = createModelRegistry([primary, target, unavailable]);
			vi.spyOn(registry, "hasConfiguredAuth").mockImplementation(model => model.id !== unavailable.id);
			if (phase === "planner") {
				cfgPrewalkPlanner.set(settings, "missing/planner");
				cfgPrewalkPlannerFallbacks.set(settings, [`${unavailable.provider}/${unavailable.id}`]);
			} else {
				cfgPrewalkExecution.set(settings, "missing/executor");
				cfgPrewalkExecutionFallbacks.set(settings, [`${unavailable.provider}/${unavailable.id}`]);
			}
			const spy = vi
				.spyOn(sdkModule, "createAgentSession")
				.mockResolvedValue(createSessionResult(yieldEmittingSession()));

			const result = await runSubprocess({
				...baseOptions(`subagent-prewalk-${phase}-unavailable`, settings),
				modelRegistry: registry,
				agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}:low`], prewalk: true },
			});

			expect(result.exitCode).toBe(0);
			const forwarded = spy.mock.calls[0]?.[0];
			expect(forwarded?.model?.id).toBe(primary.id);
			expect(forwarded?.thinkingLevel).toBe(Effort.Low);
			expect(forwarded?.prewalk).toBeUndefined();
		},
	);

	it("task.agentPrewalk 'off' disables a frontmatter-enabled prewalk", async () => {
		const settings = Settings.isolated();
		cfgPrewalkPlanner.set(settings, `${target.provider}/${target.id}:high`);
		cfgTaskAgentPrewalk.set(settings, { task: "off" });
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-off", settings),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk).toBeUndefined();
		expect(spy.mock.calls[0]?.[0]?.model?.id).toBe(primary.id);
	});

	it("task.agentPrewalk 'on' enables prewalk for an agent without frontmatter", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${target.provider}/${target.id}`);
		cfgTaskAgentPrewalk.set(settings, { task: "on" });
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-on", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(target.id);
	});

	it("task.prewalk arms the bundled generic task agent without frontmatter", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${target.provider}/${target.id}`);
		cfgTaskPrewalk.set(settings, true);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-setting-on", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(target.id);
	});

	it("task.prewalk defaults off and leaves other bundled agents alone when on", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${target.provider}/${target.id}`);
		cfgPrewalkPlanner.set(settings, `${target.provider}/${target.id}:high`);
		cfgPrewalkExecution.set(settings, `${primary.provider}/${primary.id}:low`);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const offByDefault = await runSubprocess({
			...baseOptions("subagent-prewalk-setting-default", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});
		expect(offByDefault.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk).toBeUndefined();

		expect(spy.mock.calls[0]?.[0]?.model?.id).toBe(primary.id);
		cfgTaskPrewalk.set(settings, true);
		const otherAgent = await runSubprocess({
			...baseOptions("subagent-prewalk-setting-other-agent", settings),
			agent: { ...baseAgent, name: "sonic", model: [`${primary.provider}/${primary.id}`] },
		});
		expect(otherAgent.exitCode).toBe(0);
		expect(spy.mock.calls[1]?.[0]?.prewalk).toBeUndefined();
		expect(spy.mock.calls[1]?.[0]?.model?.id).toBe(primary.id);
	});

	it("skips prewalk when the target resolves to the starting model", async () => {
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-same-model", Settings.isolated()),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${primary.provider}/${primary.id}`,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.prewalk).toBeUndefined();
	});

	it("arms an effort-only execution handoff on the same model", async () => {
		const settings = Settings.isolated();
		cfgPrewalkExecution.set(settings, `${primary.provider}/${primary.id}:low`);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-effort-only", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}:high`], prewalk: true },
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(Effort.High);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.target.id).toBe(primary.id);
		expect(spy.mock.calls[0]?.[0]?.prewalk?.thinkingLevel).toBe(Effort.Low);
	});

	it("skips identical planner and execution selections without discarding the planner", async () => {
		const settings = Settings.isolated();
		cfgPrewalkPlanner.set(settings, `${target.provider}/${target.id}:high`);
		cfgPrewalkExecution.set(settings, `${target.provider}/${target.id}:high`);
		const spy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue(createSessionResult(yieldEmittingSession()));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-identical-crew", settings),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}:low`], prewalk: true },
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.model?.id).toBe(target.id);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(Effort.High);
		expect(spy.mock.calls[0]?.[0]?.prewalk).toBeUndefined();
	});

	it("keeps the todo tool active for a prewalk-armed subagent (the todo gate needs it)", async () => {
		const session = yieldEmittingSession(["read", "todo", "yield"]);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions("subagent-prewalk-todo-kept", Settings.isolated()),
			agent: {
				...baseAgent,
				model: [`${primary.provider}/${primary.id}`],
				prewalk: `${target.provider}/${target.id}`,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(session.getActiveToolNames()).toContain("todo");
	});

	it("strips the parent-owned todo tool from non-prewalk subagents", async () => {
		const session = yieldEmittingSession(["read", "todo", "yield"]);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions("subagent-no-prewalk-todo-stripped", Settings.isolated()),
			agent: { ...baseAgent, model: [`${primary.provider}/${primary.id}`] },
		});

		expect(result.exitCode).toBe(0);
		expect(session.getActiveToolNames()).not.toContain("todo");
		expect(session.getActiveToolNames()).toContain("read");
	});
});
// Plan-mode spawns are read-only exploration: the task tool must strip a
// prewalk-enabled agent definition before spawning so the hidden
// plan/implement nudges never reach an agent without edit tools.
describe("task tool plan-mode prewalk guard", () => {
	const prewalkAgent: AgentDefinition = {
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
		prewalk: true,
	};

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function toolSession(planMode: boolean): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.enabled": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getPlanModeState: () => (planMode ? { enabled: true, planFilePath: "local://PLAN.md" } : undefined),
		} as unknown as ToolSession;
	}

	async function spawnedAgentPrewalk(planMode: boolean): Promise<boolean | string | undefined> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [prewalkAgent],
			projectAgentsDir: null,
		});
		let forwarded: AgentDefinition | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (options): Promise<SingleResult> => {
			forwarded = options.agent;
			return {
				index: options.index ?? 0,
				id: options.id ?? "X",
				agent: "task",
				agentSource: "bundled",
				task: "t",
				assignment: "do the thing",
				exitCode: 0,
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			};
		});
		const tool = await TaskTool.create(toolSession(planMode));
		await tool.execute("tc", { task: "explore the thing" });
		expect(forwarded).toBeDefined();
		return forwarded?.prewalk;
	}

	it("strips prewalk from the agent definition while plan mode is active", async () => {
		expect(await spawnedAgentPrewalk(true)).toBeUndefined();
	});

	it("keeps the agent definition's prewalk outside plan mode", async () => {
		expect(await spawnedAgentPrewalk(false)).toBe(true);
	});
});

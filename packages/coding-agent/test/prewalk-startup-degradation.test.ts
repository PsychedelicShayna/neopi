import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import { cfgPrewalkEnabled, cfgPrewalkExecution } from "@oh-my-pi/pi-coding-agent/session/settings";

// Regression for #6064: prewalk is an optional, off-by-default optimization.
// A missing key (or unresolvable target) for the prewalk hand-off model must
// leave prewalk unarmed with a warning, never abort startup and lock the user
// out of the app.
describe("prewalk startup degradation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-prewalk-repro-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("leaves prewalk unarmed instead of crashing when the target has no configured auth", async () => {
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", "cerebras/zai-glm-4.7");
		// Force the no-auth condition: hasAuth() also consults $HOME/.env via
		// getEnvApiKey (packages/utils/src/env.ts), so a CEREBRAS_API_KEY in the
		// runner's home .env would otherwise legitimately arm prewalk and make
		// this test environment-dependent.
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(false);

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk).toBeUndefined();
	});

	test("arms prewalk when the target resolves and has configured auth", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.keys.setRuntime(model.provider, "test-key");

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk?.target.provider).toBe(model.provider);
		expect(options.prewalk?.target.id).toBe(model.id);
	});

	test("arms the configured prewalk.execution target instead of @smol", async () => {
		const smol = getBundledModel("anthropic", "claude-sonnet-4-5");
		const into = getBundledModel("openai", "gpt-4o");
		if (!smol || !into) throw new Error("expected claude-sonnet-4-5 and gpt-4o to be bundled");
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		cfgPrewalkExecution.set(settings, `${into.provider}/${into.id}`);
		settings.setModelRole("smol", `${smol.provider}/${smol.id}`);
		authStorage.keys.setRuntime(smol.provider, "test-key");
		authStorage.keys.setRuntime(into.provider, "test-key");

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk?.target.provider).toBe(into.provider);
		expect(options.prewalk?.target.id).toBe(into.id);
	});

	test("configured execution @default follows --model while an explicit target keeps the original role", async () => {
		const configured = getBundledModel("anthropic", "claude-sonnet-4-5");
		const active = getBundledModel("anthropic", "claude-opus-4-6");
		if (!configured || !active) throw new Error("expected bundled models");
		authStorage.keys.setRuntime("anthropic", "test-key");
		for (const explicit of [false, true]) {
			const settings = Settings.isolated({
				"prewalk.enabled": true,
				"prewalk.execution": "@default",
			});
			settings.setModelRole("default", `${configured.provider}/${configured.id}:low`);
			const options = await buildSessionOptions(
				parseArgs([
					"--model",
					`${active.provider}/${active.id}:high`,
					...(explicit ? ["--prewalk-into", "@default"] : []),
				]),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				settings,
			);
			expect(options.model?.id).toBe(active.id);
			expect(options.prewalk?.target.id).toBe(explicit ? configured.id : active.id);
			expect(options.prewalk?.thinkingLevel).toBe(explicit ? Effort.Low : Effort.High);
		}
	});

	test("skips a disabled provider and arms the next enabled prewalk candidate", async () => {
		const disabled = getBundledModel("anthropic", "claude-sonnet-4-5");
		const enabled = getBundledModel("openai", "gpt-4o");
		if (!disabled || !enabled) throw new Error("expected claude-sonnet-4-5 and gpt-4o to be bundled");
		const settings = Settings.isolated({ disabledProviders: [disabled.provider] });
		authStorage.keys.setRuntime(disabled.provider, "test-key");
		authStorage.keys.setRuntime(enabled.provider, "test-key");

		const options = await buildSessionOptions(
			parseArgs(["--prewalk-into", `${disabled.provider}/${disabled.id},${enabled.provider}/${enabled.id}`]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.prewalk?.target.provider).toBe(enabled.provider);
		expect(options.prewalk?.target.id).toBe(enabled.id);
	});

	test("does not implicitly re-arm configured prewalk while restoring a session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		cfgPrewalkEnabled.set(settings, true);
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.keys.setRuntime(model.provider, "test-key");

		for (const args of [parseArgs(["--continue"]), parseArgs(["--resume=session.jsonl"])]) {
			const options = await buildSessionOptions(args, [], SessionManager.inMemory(), modelRegistry, settings);
			expect(options.prewalk).toBeUndefined();
		}
	});

	test("honors an explicit prewalk flag while restoring a session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.keys.setRuntime(model.provider, "test-key");

		const options = await buildSessionOptions(
			parseArgs(["--continue", "--prewalk"]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.prewalk?.target.provider).toBe(model.provider);
		expect(options.prewalk?.target.id).toBe(model.id);
	});

	test("resolves independent crews and discloses them before the first prompt", async () => {
		const planner = getBundledModel("anthropic", "claude-opus-4-6");
		const execution = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!planner || !execution) throw new Error("expected bundled crew models");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const settings = Settings.isolated({
			"prewalk.enabled": true,
			"prewalk.planner": "anthropic/not-a-model",
			"prewalk.plannerFallbacks": ["@slow:high"],
			"prewalk.execution": "anthropic/not-a-model",
			"prewalk.executionFallbacks": [`${execution.provider}/${execution.id}:low`],
		});
		settings.setModelRole("slow", `${planner.provider}/${planner.id}`);
		const options = await buildSessionOptions(
			parseArgs([]),
			[],
			SessionManager.inMemory(tempDir),
			modelRegistry,
			settings,
		);
		const notices: string[] = [];
		const { session } = await createAgentSession({
			...options,
			agentId: `Prewalk-${Snowflake.next()}`,
			cwd: tempDir,
			agentDir: tempDir,
			model: execution,
			settings,
			authStorage,
			modelRegistry,
			disableExtensionDiscovery: true,
			bindProcessState: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onPrewalkCrew: message => notices.push(message),
		});
		try {
			expect(session.model?.id).toBe(planner.id);
			expect(session.configuredThinkingLevel()).toBe(Effort.High);
			expect(session.getPrewalkState()?.target.id).toBe(execution.id);
			expect(session.getPrewalkState()?.thinkingLevel).toBe(Effort.Low);
			expect(notices).toEqual([
				`Prewalk crew: plan anthropic/${planner.id}:high → execute anthropic/${execution.id}:low.`,
			]);
		} finally {
			await session.dispose();
		}
	});

	test("--prewalk-into overrides execution without changing planner settings or global roles", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const settings = Settings.isolated({
			"prewalk.planner": "anthropic/claude-opus-4-6:high",
			"prewalk.execution": "anthropic/not-a-model",
		});
		const before = settings.getModelRoles();
		const options = await buildSessionOptions(
			parseArgs(["--prewalk-into", `${model.provider}/${model.id}:low`]),
			[],
			SessionManager.inMemory(tempDir),
			modelRegistry,
			settings,
		);
		expect(options.prewalk?.target.id).toBe(model.id);
		expect(options.prewalk?.thinkingLevel).toBe(Effort.Low);
		expect(options.prewalkPlannerPatterns).toEqual(["anthropic/claude-opus-4-6:high"]);
		expect(cfgPrewalkExecution.get(settings)).toBe("anthropic/not-a-model");
		expect(settings.getModelRoles()).toEqual(before);
	});

	test("configured crews remain inactive by default and under --no-prewalk", async () => {
		const settings = Settings.isolated({
			"prewalk.planner": "anthropic/claude-opus-4-6:high",
			"prewalk.execution": "anthropic/claude-sonnet-4-5:low",
		});
		for (const args of [[], ["--no-prewalk"]]) {
			const options = await buildSessionOptions(
				parseArgs(args),
				[],
				SessionManager.inMemory(tempDir),
				modelRegistry,
				settings,
			);
			expect(options.prewalk).toBeUndefined();
			expect(options.prewalkPlannerPatterns).toBeUndefined();
		}
	});
});

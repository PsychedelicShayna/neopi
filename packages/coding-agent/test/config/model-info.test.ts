import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, type Api, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	cfgEffortPolicyMode,
	cfgEffortRules,
	cfgFallbackEffortSelections,
	cfgRoleEffortSelections,
} from "@oh-my-pi/pi-coding-agent/config/effort-policy";
import { resolveModelFacts } from "@oh-my-pi/pi-coding-agent/config/model-facts";
import { lookupModelInfo } from "@oh-my-pi/pi-coding-agent/config/model-info";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

function model(id: string, provider = "lookup"): Model<Api> {
	return {
		...buildModel({
			id,
			name: id,
			provider,
			api: "openai-completions",
			baseUrl: "https://private.example/secret-endpoint",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 100_000,
			maxTokens: 10_000,
		}),
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		headers: { Authorization: "secret-header" },
	};
}

describe("live model information", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let settings: Settings;
	let session: ToolSession;
	let rows: Model<Api>[];
	let available: Model<Api>[];

	beforeEach(async () => {
		vi.restoreAllMocks();
		const scratch = path.join(os.homedir(), ".cache", "npi-canary");
		await fs.mkdir(scratch, { recursive: true });
		temp = await TempDir.create(path.join(scratch, "model-info-test-"));
		auth = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(auth, temp.join("models.yml"));
		settings = Settings.isolated();
		rows = [model("alpha"), model("beta")];
		available = rows;
		spyOn(registry, "awaitBackgroundRefresh").mockResolvedValue(undefined);
		spyOn(registry, "getAvailable").mockImplementation(() => available);
		spyOn(registry, "find").mockImplementation((provider, id) =>
			rows.find(row => row.provider === provider && row.id === id),
		);
		spyOn(registry, "hasProvider").mockImplementation(provider => rows.some(row => row.provider === provider));
		spyOn(registry, "getModelFactResolution").mockImplementation((provider, id) => {
			const row = rows.find(row => row.provider === provider && row.id === id);
			return row ? resolveModelFacts(row, []) : undefined;
		});
		session = {
			cwd: temp.path(),
			hasUI: false,
			settings,
			modelRegistry: registry,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getActiveModel: () => rows[0],
			getActiveModelString: () => "lookup/alpha",
		};
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		auth?.close();
		await temp?.remove();
	});

	it("reports resolved technical facts with provenance and no invented descriptions or secrets", async () => {
		const refresh = spyOn(registry, "refresh");
		const result = await lookupModelInfo("lookup/alpha", session);
		const entry = result.models[0];
		expect(result.selected).toBe("lookup/alpha");
		expect(entry?.technical).toMatchObject({ contextWindow: 100_000, maxTokens: 10_000, input: ["text", "image"] });
		expect(entry?.identity).toEqual(rows[0]?.identity);
		expect(entry?.identityProvenance).toEqual({ kind: "catalog", rules: "packages/catalog/src/compat/rules/" });
		expect(entry?.facts.provenance.contextWindow).toEqual({ kind: "provider", provider: "lookup", model: "alpha" });
		expect(entry?.description).toEqual({ status: "unknown" });
		expect(entry?.quality).toEqual({ status: "unknown" });
		expect(entry?.reasoning).toEqual({ status: "not-run" });
		expect(JSON.stringify(result)).not.toContain("private.example");
		expect(JSON.stringify(result)).not.toContain("secret-header");
		expect(JSON.stringify(result)).not.toContain("Authorization");
		expect(refresh).not.toHaveBeenCalled();
		expect(registry.awaitBackgroundRefresh).toHaveBeenCalledTimes(1);
		expect(registry.getModelFactResolution).toHaveBeenCalledWith("lookup", "alpha");
	});

	it("reads changed registry facts rather than retaining an earlier lookup", async () => {
		expect((await lookupModelInfo("lookup/alpha", session)).models[0]?.technical.contextWindow).toBe(100_000);
		rows[0] = { ...rows[0]!, contextWindow: 200_000 };
		expect((await lookupModelInfo("lookup/alpha", session)).models[0]?.technical.contextWindow).toBe(200_000);
	});

	it("does not turn discovery placeholders into known model characteristics", async () => {
		rows[0] = {
			...rows[0]!,
			discoveryMissingContextWindow: true,
			discoveryMissingMaxTokens: true,
			discoveryMissingInput: true,
			input: ["text"],
			reasoning: false,
			thinking: undefined,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const entry = (await lookupModelInfo("lookup/alpha", session)).models[0];
		expect(entry?.technical).toEqual({
			api: "openai-completions",
			cost: null,
			contextWindow: null,
			maxTokens: null,
			input: null,
			reasoning: null,
		});
		expect(entry?.effort.supported).toEqual([]);
		expect(entry?.effort.supportedStatus).toBe("unavailable");
	});

	it("bounds broad patterns with a deterministic order and explicit counts", async () => {
		rows = Array.from({ length: 30 }, (_, index) => model(`model-${String(29 - index).padStart(2, "0")}`));
		available = rows;
		const result = await lookupModelInfo("lookup/*", session);
		expect(result.matchCount).toBe(30);
		expect(result.truncated).toBe(true);
		expect(result.models).toHaveLength(result.limit);
		expect(result.models[0]?.id).toBe("model-00");
		expect(result.models.at(-1)?.id).toBe("model-24");
		const partial = await lookupModelInfo("model-", session);
		expect(partial.matchCount).toBe(30);
		expect(partial.truncated).toBe(true);
		expect(partial.models.map(entry => entry.id)).toEqual(result.models.map(entry => entry.id));
		const regex = await lookupModelInfo("re:^lookup/model-0[12]$", session);
		expect(regex.models.map(entry => entry.id)).toEqual(["model-01", "model-02"]);
	});

	it("expands bare and brace globs through the shared selector rules", async () => {
		expect((await lookupModelInfo("*", session)).models.map(entry => entry.id)).toEqual(["alpha", "beta"]);
		expect((await lookupModelInfo("lookup/{alpha,beta}", session)).matchCount).toBe(2);
	});

	it("lists base models and variants for a bare partial slug while keeping the best match", async () => {
		const base = model("gpt-6.2-astra");
		const variant = {
			...model("gpt-6.2-astra-ultra-900k"),
			variant: { baseModelId: base.id, settings: {}, request: {} },
		};
		rows = [base, model("gpt-6.2-astra-fast"), variant, model("gpt-6.2-sol")];
		available = rows;

		const result = await lookupModelInfo("AsTrA", session);

		expect(result.selected).toBe("lookup/gpt-6.2-astra");
		expect(result.matchCount).toBe(3);
		expect(result.models.map(entry => entry.id)).toEqual([
			"gpt-6.2-astra",
			"gpt-6.2-astra-fast",
			"gpt-6.2-astra-ultra-900k",
		]);

		const exact = await lookupModelInfo("gpt-6.2-astra", session);
		expect(exact.selected).toBe("lookup/gpt-6.2-astra");
		expect(exact.matchCount).toBe(1);
		expect(exact.models.map(entry => entry.id)).toEqual(["gpt-6.2-astra"]);

		const exactVariant = await lookupModelInfo("lookup/gpt-6.2-astra-ultra-900k", session);
		expect(exactVariant.models.map(entry => entry.id)).toEqual(["gpt-6.2-astra-ultra-900k"]);
	});

	it("uses the registry's resolved fact values and marks unverified effort metadata", async () => {
		const row = rows[0]!;
		const resolution = resolveModelFacts(row, [], {
			"lookup/alpha": { contextWindow: 250_000, efforts: [Effort.High] },
		});
		spyOn(registry, "getModelFactResolution").mockReturnValue(resolution);
		const resolved = (await lookupModelInfo("lookup/alpha", session)).models[0];
		expect(resolved?.technical.contextWindow).toBe(250_000);
		expect(resolved?.effort.supported).toEqual([Effort.High]);
		expect(resolved?.effort.supportedProvenance?.kind).toBe("override");
		expect(resolved?.effort.supportedStatus).toBe("authoritative");
		spyOn(registry, "getModelFactResolution").mockReturnValue({
			...resolution,
			model: { ...row, thinking: { mode: "effort", efforts: [Effort.High], unverified: true } },
		});
		expect((await lookupModelInfo("lookup/alpha", session)).models[0]?.effort.supportedStatus).toBe("unverified");
		expect((await lookupModelInfo("lookup/alpha", session)).models[0]?.effort.supported).toEqual([]);
	});

	it("uses a global role when there is no project override", async () => {
		await Bun.write(temp.join("agent", "config.yml"), "modelRoles:\n  smol: lookup/alpha\n");
		await fs.mkdir(temp.join("project"), { recursive: true });
		session.settings = await Settings.loadReadOnly({ cwd: temp.join("project"), agentDir: temp.join("agent") });
		const result = await lookupModelInfo("@smol", session);
		expect(result.selected).toBe("lookup/alpha");
		expect(result.role).toMatchObject({ selectorProvenance: "global", configuredOverrideApplied: true });
		expect(result.role?.projectSelector).toBeUndefined();
	});

	it("resolves role patterns and saved Auto choices from current settings", async () => {
		cfgModelRoles.override(settings, { researcher: "lookup/b*" });
		cfgRoleEffortSelections.override(settings, { researcher: { mode: "auto", allowed: [Effort.Low, Effort.High] } });
		const result = await lookupModelInfo("@researcher", session);
		expect(result.kind).toBe("role");
		expect(result.selected).toBe("lookup/beta");
		expect(result.role).toMatchObject({
			configuredOverrideApplied: true,
			configuredSelector: "lookup/b*",
			selectorProvenance: "runtime",
			resolvedSelector: "lookup/beta",
			available: true,
		});
		expect(result.models[0]?.effort.configured).toMatchObject({
			level: "auto",
			origin: "role",
			candidates: [Effort.Low, Effort.High],
		});
		expect(result.models[0]?.reasoning).toEqual({ status: "not-run" });
		cfgModelRoles.override(settings, { researcher: "lookup/alpha" });
		cfgRoleEffortSelections.override(settings, { researcher: { mode: "fixed", level: ThinkingLevel.Medium } });
		const changed = await lookupModelInfo("@researcher", session);
		expect(changed.selected).toBe("lookup/alpha");
		expect(changed.models[0]?.effort.configured.resolvedLevel).toBe(ThinkingLevel.Medium);
	});

	it("exposes project-over-global role and effort precedence without altering files", async () => {
		await Bun.write(
			temp.join("agent", "config.yml"),
			"modelRoles:\n  smol: lookup/alpha\nroleEffortSelections:\n  smol:\n    mode: fixed\n    level: low\n",
		);
		const projectConfig =
			"modelRoles:\n  smol: lookup/beta\nroleEffortSelections:\n  smol:\n    mode: auto\n    allowed: [medium, high]\n";
		await Bun.write(temp.join("project", ".omp", "config.yml"), projectConfig);
		session.settings = await Settings.loadReadOnly({ cwd: temp.join("project"), agentDir: temp.join("agent") });
		const result = await lookupModelInfo("@smol", session);
		expect(result.role).toMatchObject({
			configuredOverrideApplied: true,
			projectSelector: "lookup/beta",
			globalSelector: "lookup/alpha",
			selectorProvenance: "project",
			effortSelection: { mode: "auto", allowed: ["medium", "high"] },
			globalEffortSelection: { mode: "fixed", level: "low" },
		});
		expect(result.models[0]?.effort.configured.candidates).toEqual([Effort.Medium, Effort.High]);
		expect(await Bun.file(temp.join("project", ".omp", "config.yml")).text()).toBe(projectConfig);
	});

	it("separates capability, implicit policy and a deliberate concrete override", async () => {
		cfgEffortPolicyMode.override(settings, "replacement");
		cfgEffortRules.override(settings, [{ selector: "lookup/*", allowed: [Effort.High] }]);
		const result = await lookupModelInfo("lookup/alpha:low", session);
		const effort = result.models[0]?.effort;
		expect(effort?.supported).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(effort?.supportedProvenance?.kind).toBe("provider");
		expect(effort?.implicit.candidates).toEqual([Effort.High]);
		expect(effort?.implicit.rule?.selector).toBe("lookup/*");
		expect(effort?.configured).toMatchObject({ level: "low", origin: "caller", resolvedLevel: "low" });
		expect(effort?.explicitOverride).toMatchObject({
			suffix: "low",
			bypassesImplicitRules: true,
			requiresSupportedLevel: true,
		});
		expect(effort?.provenance).toContainEqual({ setting: "effort.rules", layer: "runtime", scope: "setting" });
		const unsupported = await lookupModelInfo("lookup/alpha:xhigh", session);
		expect(unsupported.models[0]?.effort.configured.error).toContain("not supported");
		expect(unsupported.models[0]?.effort.supported).not.toContain(Effort.XHigh);
	});

	it("treats saved role suffixes as implicit but a suffix on the role query as a caller override", async () => {
		cfgEffortPolicyMode.override(settings, "replacement");
		cfgEffortRules.override(settings, [{ selector: "lookup/*", allowed: [Effort.High] }]);
		cfgModelRoles.override(settings, { researcher: "lookup/alpha:low" });
		const saved = await lookupModelInfo("@researcher", session);
		expect(saved.models[0]?.effort.configured).toMatchObject({ origin: "role", resolvedLevel: "high" });
		expect(saved.models[0]?.effort.explicitOverride.bypassesImplicitRules).toBe(false);
		cfgRoleEffortSelections.override(settings, { researcher: { mode: "auto", allowed: [Effort.High] } });
		const explicit = await lookupModelInfo("@researcher:low", session);
		expect(explicit.models[0]?.effort.configured).toMatchObject({
			origin: "caller",
			level: "low",
			resolvedLevel: "low",
		});
		expect(explicit.models[0]?.effort.explicitOverride.bypassesImplicitRules).toBe(true);
		const different = await lookupModelInfo("@researcher:medium", session);
		expect(different.models[0]?.effort.explicitOverride.suffix).toBe(ThinkingLevel.Medium);
		expect(different.models[0]?.effort.configured.resolvedLevel).toBe(ThinkingLevel.Medium);
	});

	it("reports applicable fallback selectors, availability and saved effort metadata", async () => {
		rows.push(model("alpha", "backup"));
		available = rows.filter(row => row.id !== "beta");
		cfgRetryFallbackChains.override(settings, { "lookup/alpha": ["backup/*", "lookup/beta:high"] });
		cfgFallbackEffortSelections.override(settings, {
			"lookup/alpha": { "backup/*": { mode: "auto", allowed: [Effort.Medium] } },
		});
		const result = await lookupModelInfo("lookup/alpha", session);
		const fallbacks = result.models[0]?.fallbacks;
		expect(fallbacks?.chainKey).toBe("lookup/alpha");
		expect(fallbacks?.configuredSelectors).toEqual(["backup/*", "lookup/beta:high"]);
		expect(fallbacks?.alternatives[0]).toMatchObject({
			selector: "backup/alpha",
			available: true,
			selection: { mode: "auto", allowed: ["medium"] },
			effort: { configured: { level: "auto", origin: "fallback", candidates: ["medium"] } },
			reasoning: { status: "not-run" },
		});
		expect(fallbacks?.alternatives[1]).toMatchObject({
			selector: "lookup/beta:high",
			available: false,
			effort: { configured: { level: "high" } },
		});
	});

	it("distinguishes pending Auto, a supplied concrete observation and an unrun lookup", async () => {
		session.getActiveEffort = () => ({
			level: "auto",
			origin: "manual",
			selection: { mode: "auto", allowed: [Effort.Low, Effort.High] },
		});
		expect((await lookupModelInfo("", session)).models[0]?.reasoning).toEqual({ status: "pending-auto" });
		session.getActualThinkingLevel = () => ThinkingLevel.High;
		cfgRetryFallbackChains.override(settings, { "lookup/alpha:high": ["lookup/beta"] });
		const observed = await lookupModelInfo("current", session);
		expect(observed.models[0]?.reasoning).toEqual({ status: "observed", level: ThinkingLevel.High });
		expect(observed.models[0]?.effort.configured.level).toBe("auto");
		expect(observed.models[0]?.fallbacks.chainKey).toBe("lookup/alpha:high");
		expect(observed.models[0]?.fallbacks.configuredSelectors).toEqual(["lookup/beta"]);
		expect((await lookupModelInfo("lookup/alpha", session)).models[0]?.reasoning).toEqual({ status: "not-run" });
	});

	it("does not invent actual fixed reasoning without the optional getter", async () => {
		session.getActiveEffort = () => ({ level: ThinkingLevel.Low, origin: "manual" });
		expect((await lookupModelInfo("current", session)).models[0]?.reasoning).toEqual({ status: "not-observed" });
		session.getActualThinkingLevel = () => ThinkingLevel.Low;
		expect((await lookupModelInfo("current", session)).models[0]?.reasoning).toEqual({
			status: "observed",
			level: ThinkingLevel.Low,
		});
	});

	it("rejects unknown or unavailable selectors and unknown roles", async () => {
		await expect(lookupModelInfo("missing/no-model", session)).rejects.toThrow("No available model matches");
		await expect(lookupModelInfo("@unknown-role", session)).rejects.toThrow("Unknown model role");
		available = [rows[1]!];
		await expect(lookupModelInfo("lookup/alpha", session)).rejects.toThrow("No available model matches");
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { classifyDifficulty } from "../src/auto-thinking/classifier";
import { readEffortContext, renderEffortContext } from "../src/auto-thinking/context";
import {
	ChroniclerStore,
	readCommittedChroniclerBatches,
	type CommittedChroniclerBatch,
} from "../src/chronicler/store";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	EffortPolicyError,
	cfgEffortRules,
	cfgFallbackEffortSelections,
	matchEffortRule,
	resolveImplicitEffort,
	type EffortSelection,
} from "../src/config/effort-policy";
import { cfgModelRoleStorage } from "../src/config/model-settings";
import { cfgRetryFallbackChains } from "../src/session/settings";
import { resolveJudge } from "../src/judgment";
import type { SessionEntry } from "../src/session/session-entries";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const timestamp = "2026-09-28T10:00:00.000Z";
const model = buildModel({
	id: "classifier",
	name: "classifier",
	api: "openai-completions",
	provider: "mock",
	baseUrl: "https://example.com",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
});

function registry(models: Model[] = [model]): ModelRegistry {
	const storage = createInMemoryAuthStorage();
	storage.keys.setRuntime("mock", "test-key");
	const result = new ModelRegistry(storage, "/nonexistent/effort-models.yml");
	vi.spyOn(result, "getAvailable").mockReturnValue(models);
	return result;
}

function transcript(id: string, text: string) {
	return { id, message: { role: "user" as const, content: text, timestamp: Date.parse(timestamp) } };
}

function batch(
	entries: string[],
	beats: { title: string; body: string; sources: string[] }[],
	carry: { text: string; sources: string[] } | null = null,
): CommittedChroniclerBatch {
	return {
		checkpoint: {
			version: 1,
			batchId: "committed",
			sessionId: "session-a",
			committedAt: timestamp,
			entries: entries.map(id => ({ id, parentId: null, timestamp })),
			beats: [],
			carry,
		},
		beats: beats.map((beat, index) => ({
			id: String(index),
			path: "beat.md",
			sessionId: "session-a",
			capturedAt: timestamp,
			model: "mock/classifier",
			kind: "decision" as const,
			topics: [],
			eventTime: timestamp,
			related: [],
			...beat,
		})),
	};
}

describe("on-demand effort classification", () => {
	afterEach(() => vi.restoreAllMocks());

	it("offers only sparse allowed levels and sends the candidate's fixed reasoning effort to the provider", async () => {
		const settings = Settings.isolated({
			modelRoles: { effort: "mock/classifier:xhigh", judge: "mock/unavailable" },
		});
		const call = vi.spyOn(ai, "completeSimple").mockImplementation(
			async (_model, context, options) =>
				({
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					content: [{ type: "text", text: "high" }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}) as never,
		);
		const effort = await classifyDifficulty(
			{ request: "solve the bug" },
			{
				settings,
				registry: registry(),
				model,
				allowedEfforts: [Effort.Low, Effort.High],
			},
		);
		expect(effort).toBe(Effort.High);
		expect(call).toHaveBeenCalledTimes(1);
		expect(call.mock.calls[0]?.[0].id).toBe("classifier");
		expect(call.mock.calls[0]?.[2]?.reasoning).toBe(Effort.XHigh);
		expect(call.mock.calls[0]?.[2]?.disableReasoning).not.toBe(true);
		const system = call.mock.calls[0]?.[1].systemPrompt?.join("\n") ?? "";
		expect(system).toContain("low");
		expect(system).toContain("high");
		expect(system).not.toContain("medium:");
	});

	it("returns a singleton without contacting the classifier", async () => {
		const call = vi.spyOn(ai, "completeSimple");
		const effort = await classifyDifficulty(
			{ request: "anything" },
			{
				settings: Settings.isolated({}),
				registry: registry(),
				model,
				allowedEfforts: [Effort.High],
			},
		);
		expect(effort).toBe(Effort.High);
		expect(call).not.toHaveBeenCalled();
	});

	it("rejects an Auto classifier role rather than recursively classifying", async () => {
		const settings = Settings.isolated({ modelRoles: { effort: "mock/classifier:auto" } });
		const call = vi.spyOn(ai, "completeSimple");
		await expect(
			classifyDifficulty(
				{ request: "anything" },
				{
					settings,
					registry: registry(),
					model,
					allowedEfforts: [Effort.Low, Effort.High],
				},
			),
		).rejects.toThrow("Auto");
		expect(call).not.toHaveBeenCalled();
	});
	it("applies global policy to a direct judgment's fixed implicit effort on the wire", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: "mock/classifier:xhigh" },
			"effort.rules": [{ selector: "mock/classifier", allowed: [Effort.Low, Effort.High] }],
		});
		const requests = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			content: [{ type: "text", text: "high" }],
		} as never);
		const notices: string[] = [];
		const judge = resolveJudge({
			purpose: "direct-judgment-test",
			settings,
			registry: registry(),
			onEffortDisclosure: notice => notices.push(notice),
		});
		await judge.judge({
			state: "classify",
			questions: {
				level: { type: "choice", instructions: "Pick a level", criteria: { low: "easy", high: "hard" } },
			},
		});
		expect(requests.mock.calls[0]?.[2]?.reasoning).toBe(Effort.High);
		expect(requests.mock.calls[0]?.[2]?.disableReasoning).not.toBe(true);
		expect(notices.join(" ")).toContain("adjusted to high");
	});

	it("inherits the preceding requested effort through fallback and resolves it against the fallback model", async () => {
		const backup = buildModel({
			id: "backup",
			name: "backup",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		const settings = Settings.isolated({
			modelRoles: { judge: "mock/classifier:high" },
			"retry.fallbackChains": { judge: ["mock/backup"] },
			"retry.fallbackEffortSelections": { judge: { "mock/backup": { mode: "inherit" } } },
			"effort.rules": [{ selector: "mock/backup", allowed: [Effort.Low] }],
		});
		const requests = vi
			.spyOn(ai, "completeSimple")
			.mockRejectedValueOnce(new Error("primary unavailable"))
			.mockResolvedValue({
				api: backup.api,
				provider: backup.provider,
				model: backup.id,
				stopReason: "stop",
				content: [{ type: "text", text: "low" }],
			} as never);
		const notices: string[] = [];
		const judge = resolveJudge({
			purpose: "direct-judgment-test",
			settings,
			registry: registry([model, backup]),
			onEffortDisclosure: notice => notices.push(notice),
		});
		await judge.judge({
			state: "classify",
			questions: {
				level: { type: "choice", instructions: "Pick a level", criteria: { low: "easy", high: "hard" } },
			},
		});
		expect(requests.mock.calls[0]?.[0].id).toBe("classifier");
		expect(requests.mock.calls[0]?.[2]?.reasoning).toBe(Effort.High);
		expect(requests.mock.calls[1]?.[0].id).toBe("backup");
		expect(requests.mock.calls[1]?.[2]?.reasoning).toBe(Effort.Low);
		expect(requests.mock.calls[1]?.[2]?.disableReasoning).not.toBe(true);
		expect(notices.join(" ")).toContain("Implicit effort high adjusted to low");
	});

	it("direct judgment Auto classifies on demand, then sends only the allowed chosen effort", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: "mock/classifier:auto", effort: "mock/classifier:xhigh" },
			"effort.rules": [{ selector: "mock/classifier", allowed: [Effort.Low, Effort.High] }],
		});
		const calls = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			content: [{ type: "text", text: "high" }],
		} as never);
		const judge = resolveJudge({ settings, registry: registry(), purpose: "direct-judgment-test" });
		await judge.judge({
			state: "a hard debugging request",
			questions: {
				level: { type: "choice", instructions: "Pick a level", criteria: { low: "easy", high: "hard" } },
			},
		});
		expect(calls).toHaveBeenCalledTimes(2);
		expect(calls.mock.calls[0]?.[2]?.reasoning).toBe(Effort.High);
		expect(calls.mock.calls[1]?.[2]?.reasoning).toBe(Effort.High);
	});

	it("discloses failed direct judgment Auto classification and uses its lowest permitted level", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: "mock/classifier:auto", effort: "mock/classifier:xhigh" },
			"effort.rules": [{ selector: "mock/classifier", allowed: [Effort.Low, Effort.High] }],
		});
		const calls = vi
			.spyOn(ai, "completeSimple")
			.mockRejectedValueOnce(new Error("classifier offline"))
			.mockResolvedValue({
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				content: [{ type: "text", text: "low" }],
			} as never);
		const notices: string[] = [];
		const judge = resolveJudge({
			purpose: "direct-judgment-test",
			settings,
			registry: registry(),
			onEffortDisclosure: notice => notices.push(notice),
		});
		const result = await judge.judge({
			state: "classify",
			questions: {
				level: { type: "choice", instructions: "Pick a level", criteria: { low: "easy", high: "hard" } },
			},
		});
		expect(result.answers.level.choice).toBe("low");
		expect(calls.mock.calls[1]?.[2]?.reasoning).toBe(Effort.Low);
		expect(notices.join(" ")).toContain("classifier offline");
		expect(notices.join(" ")).toContain("lowest permitted effort low");
	});
});

describe("committed branch-safe effort context", () => {
	it("excludes mixed/off-branch beats but retains their active sources; carries only cover their own sources", () => {
		const entries = [
			transcript("active", "active source"),
			transcript("other", "other active source"),
			transcript("pending", "pending request"),
		];
		const snapshots = [
			batch(
				["active", "fork", "other"],
				[
					{ title: "mixed", body: "off-branch secret", sources: ["active", "fork"] },
					{ title: "safe", body: "safe diary content", sources: ["other"] },
				],
				{ text: "carry context", sources: ["other"] },
			),
		];
		const context = renderEffortContext("pending request", entries, snapshots);
		expect(context).toContain("safe diary content");
		expect(context).toContain("carry context");
		expect(context).toContain("active source");
		expect(context).not.toContain("off-branch secret");
		expect(context.split("pending request")).toHaveLength(2);
		expect(context).not.toContain("other active source");
	});

	it("preserves source transcript for committed no-beat and unadmitted carry-only batches", () => {
		const context = renderEffortContext(
			"current",
			[transcript("source", "retained history")],
			[batch(["source"], [], { sources: ["source", "fork"], text: "off-branch carry" }), batch(["source"], [])],
		);
		expect(context).toContain("retained history");
		expect(context).not.toContain("off-branch carry");
	});

	it("admits a carry-only batch while retaining unrelated sources in the transcript", () => {
		const context = renderEffortContext(
			"current",
			[transcript("covered", "historical detail"), transcript("uncovered", "fresh detail")],
			[batch(["covered", "uncovered"], [], { sources: ["covered"], text: "admitted carry" })],
		);
		expect(context).toContain("admitted carry");
		expect(context).toContain("fresh detail");
		expect(context).not.toContain("historical detail");
	});

	it("reads immutable committed data without creating directories or repairing caches; corrupt diary falls back to transcript", async () => {
		const temp = TempDir.createSync("@pi-effort-context-");
		try {
			const artifacts = path.join(temp.path(), "artifacts");
			const root = path.join(artifacts, "chronicler");
			const manager = {
				getBranch: (): SessionEntry[] => [
					{
						type: "message",
						id: "source",
						parentId: null,
						timestamp,
						message: { role: "user", content: "full transcript", timestamp: Date.parse(timestamp) },
					},
				],
				getArtifactsDir: () => artifacts,
			};
			const fallbackNotices: string[] = [];
			expect(await readEffortContext("current", manager, message => fallbackNotices.push(message))).toContain(
				"full transcript",
			);
			await expect(fs.stat(root)).rejects.toThrow();
			const store = new ChroniclerStore(root, {
				sessionId: "session-a",
				project: temp.path(),
				model: "mock/classifier",
			});
			await store.open();
			const capture = store.beginBatch([{ id: "source", parentId: null, timestamp }]);
			store.stageBeat(capture, {
				title: "Committed",
				kind: "decision",
				body: "persisted story",
				topics: [],
				eventTime: timestamp,
				sources: ["source"],
				related: [],
			});
			capture.finalized = true;
			await store.commitBatch(capture);
			await fs.rm(path.join(root, "INDEX.md"));
			const snapshot = await readCommittedChroniclerBatches(root);
			expect(snapshot[0]?.beats[0]?.body).toBe("persisted story");
			const later = store.beginBatch([{ id: "later", parentId: "source", timestamp }]);
			store.stageBeat(later, {
				title: "Later",
				kind: "decision",
				body: "newer story",
				topics: [],
				eventTime: timestamp,
				sources: ["later"],
				related: [],
			});
			later.finalized = true;
			await store.commitBatch(later);
			await fs.rm(path.join(root, "INDEX.md"));
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]?.beats[0]?.body).toBe("persisted story");
			expect(await readCommittedChroniclerBatches(root)).toHaveLength(2);
			expect(await readEffortContext("current", manager)).toContain("persisted story");
			await expect(fs.stat(path.join(root, "INDEX.md"))).rejects.toThrow();
			const manifest = path.join(root, "beats", capture.id, "COMMIT.json");
			await fs.writeFile(manifest, "broken JSON");
			const fallback = await readEffortContext("current", manager, message => fallbackNotices.push(message));
			expect(fallback).toContain("full transcript");
			expect(fallback).not.toContain("persisted story");
			expect(await Bun.file(manifest).text()).toBe("broken JSON");
			expect(fallbackNotices).toEqual([
				"No committed Chronicler diary; classifying from the active-branch transcript.",
				"Chronicler diary is unreadable; classifying from the active-branch transcript.",
			]);
		} finally {
			await temp.remove();
		}
	});
});

describe("implicit effort policy resolution", () => {
	it("prefers an exact rule over ordered patterns while retaining sparse Auto candidates", () => {
		const settings = Settings.isolated({
			"effort.rules": [
				{ selector: "mock/*", allowed: [Effort.Low, Effort.XHigh] },
				{ selector: "mock/classifier", allowed: [Effort.Medium, Effort.High] },
			],
		});
		expect(
			resolveImplicitEffort(settings, model, { mode: "auto", allowed: [Effort.Low, Effort.High] }, "role")
				.candidates,
		).toEqual([Effort.High]);
		const fixed = resolveImplicitEffort(settings, model, { mode: "fixed", level: Effort.XHigh }, "role");
		expect(fixed.level).toBe(Effort.High);
		expect(fixed.disclosure).toContain("mock/classifier");
	});

	it("prioritizes exact over regex over glob and uses the first matching regex", () => {
		const settings = Settings.isolated({
			"effort.rules": [
				{ selector: "mock/*", allowed: [Effort.Low] },
				{ selector: "re:^mock/class", allowed: [Effort.Medium] },
				{ selector: "re:^mock/classifier$", allowed: [Effort.High] },
				{ selector: "mock/classifier", allowed: [Effort.XHigh] },
			],
		});
		expect(matchEffortRule(settings, model)?.allowed).toEqual([Effort.XHigh]);
		const regexSettings = Settings.isolated({
			"effort.rules": [
				{ selector: "mock/*", allowed: [Effort.Low] },
				{ selector: "re:^mock/class", allowed: [Effort.Medium] },
				{ selector: "re:^mock/classifier$", allowed: [Effort.High] },
			],
		});
		expect(matchEffortRule(regexSettings, model)?.allowed).toEqual([Effort.Medium]);
		expect(resolveImplicitEffort(regexSettings, model, { mode: "auto" }, "role").candidates).toEqual([Effort.Medium]);
	});

	it("retains case-insensitive Bun glob matching and skips invalid regex before glob fallback", () => {
		const settings = Settings.isolated({
			"effort.rules": [
				{ selector: "re:[", allowed: [Effort.XHigh] },
				{ selector: "MOCK/{CLASSIFIER,OTHER}", allowed: [Effort.Low] },
			],
		});
		expect(matchEffortRule(settings, model)?.allowed).toEqual([Effort.Low]);
		expect(resolveImplicitEffort(settings, model, { mode: "auto", selector: "MOCK/CLASS*" }, "role").candidates).toEqual([
			Effort.Low,
		]);
		expect(resolveImplicitEffort(settings, model, { mode: "auto", selector: "re:^mock/classifier$" }, "role").candidates).toEqual([
			Effort.Low,
		]);
		expect(
			resolveImplicitEffort(
				settings,
				model,
				{ mode: "auto", selector: "re:^mock/other$", allowed: [Effort.High] },
				"role",
			).candidates,
		).toEqual([Effort.Low]);
	});

	it("does not promote a saved role default to an explicit override, even when both request the same level", () => {
		const settings = Settings.isolated({
			"effort.rules": [{ selector: "mock/classifier", allowed: [Effort.Low, Effort.High] }],
		});
		const requested = { mode: "fixed" as const, level: Effort.XHigh };
		expect(resolveImplicitEffort(settings, model, requested, "role").level).toBe(Effort.High);
		expect(resolveImplicitEffort(settings, model, requested, "caller").level).toBe(Effort.XHigh);
		expect(resolveImplicitEffort(settings, model, requested, "manual").level).toBe(Effort.XHigh);
	});

	it("constrains caller and manual Auto to the global set while preserving an explicit fixed bypass", () => {
		const settings = Settings.isolated({
			"effort.rules": [{ selector: "mock/classifier", allowed: [Effort.Low] }],
		});
		const auto = { mode: "auto" as const, allowed: [Effort.Low, Effort.XHigh] };
		expect(resolveImplicitEffort(settings, model, auto, "caller").candidates).toEqual([Effort.Low]);
		expect(resolveImplicitEffort(settings, model, auto, "manual").candidates).toEqual([Effort.Low]);
		expect(() => resolveImplicitEffort(settings, model, { mode: "auto", allowed: [Effort.XHigh] }, "role")).toThrow(
			EffortPolicyError,
		);
		expect(() => resolveImplicitEffort(settings, model, { mode: "auto", allowed: [Effort.XHigh] }, "caller")).toThrow(
			EffortPolicyError,
		);
	});
	it("rejects impossible implicit defaults and fallback Inherit without a permitted effort", () => {
		const highOnly = { ...model, thinking: { ...model.thinking!, efforts: [Effort.High] } };
		const settings = Settings.isolated({
			"effort.rules": [{ selector: "mock/classifier", allowed: [Effort.Low] }],
		});
		expect(() => resolveImplicitEffort(settings, highOnly, undefined, "default")).toThrow(EffortPolicyError);
		expect(() => resolveImplicitEffort(settings, highOnly, { mode: "inherit" }, "fallback")).toThrow(
			EffortPolicyError,
		);
		expect(() => resolveImplicitEffort(settings, highOnly, { mode: "fixed", level: "inherit" }, "inherited")).toThrow(
			EffortPolicyError,
		);
	});

	it("leaves implicit effort inert for a model without controllable reasoning instead of blocking the session", () => {
		const plain = { ...model, id: "plain", reasoning: false };
		const settings = Settings.isolated({});
		expect(resolveImplicitEffort(settings, plain, { mode: "auto" }, "default").candidates).toEqual([]);
		expect(resolveImplicitEffort(settings, plain, { mode: "fixed", level: Effort.High }, "role")).toMatchObject({
			level: undefined,
			candidates: [],
		});
		expect(resolveImplicitEffort(settings, plain, { mode: "inherit" }, "fallback").candidates).toEqual([]);
	});
});

describe("atomic role and fallback effort settings", () => {
	it("validates a role selector and effort before changing either global or project storage", () => {
		const settings = Settings.isolated({});
		settings.setRoleModelAndEffort("reviewer", "mock/classifier", { mode: "auto", allowed: [Effort.Low] }, "global");
		expect(settings.getModelRole("reviewer")).toBe("mock/classifier");
		expect(settings.getRoleEffortSelection("reviewer")).toEqual({ mode: "auto", allowed: [Effort.Low] });
		const invalid = { mode: "auto", allowed: ["unknown"] } as unknown as EffortSelection;
		expect(() => settings.setRoleModelAndEffort("reviewer", "mock/other", invalid, "global")).toThrow();
		expect(settings.getModelRole("reviewer")).toBe("mock/classifier");
		expect(settings.getRoleEffortSelection("reviewer")).toEqual({ mode: "auto", allowed: [Effort.Low] });

		cfgModelRoleStorage.set(settings, "project");
		settings.setRoleModelAndEffort("reviewer", "mock/project", { mode: "fixed", level: Effort.High }, "project");
		expect(settings.getModelRole("reviewer")).toBe("mock/project");
		expect(settings.getRoleEffortSelection("reviewer")).toEqual({ mode: "fixed", level: Effort.High });
		expect(() => settings.setRoleModelAndEffort("reviewer", "mock/other", invalid, "project")).toThrow();
		expect(settings.getModelRole("reviewer")).toBe("mock/project");
		settings.setRoleModelAndEffort("reviewer", undefined, undefined, "project");
		expect(settings.getModelRole("reviewer")).toBe("mock/classifier");
		expect(settings.getRoleEffortSelection("reviewer")).toEqual({ mode: "auto", allowed: [Effort.Low] });
	});

	it("keeps the previous fallback chain and effort metadata if either draft is invalid", () => {
		const settings = Settings.isolated({});
		settings.setFallbackChainAndEfforts("default", ["mock/classifier"], {
			"mock/classifier": { mode: "auto", allowed: [Effort.High] },
		});
		expect(() =>
			settings.setFallbackChainAndEfforts("default", ["mock/other"], {
				"mock/other": { mode: "auto", allowed: ["unknown"] } as unknown as EffortSelection,
			}),
		).toThrow();
		expect(cfgRetryFallbackChains.get(settings).default).toEqual(["mock/classifier"]);
		expect(cfgFallbackEffortSelections.get(settings).default).toEqual({
			"mock/classifier": { mode: "auto", allowed: [Effort.High] },
		});
	});
});

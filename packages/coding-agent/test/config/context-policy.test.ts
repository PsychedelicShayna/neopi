import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { logger } from "@oh-my-pi/pi-utils";
import { stringifySettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { cfgContextRules, matchContextRule } from "../../src/config/context-policy";
import { cfgEffortRules, cfgRoleEffortSelections, resolveImplicitEffort } from "../../src/config/effort-policy";
import { Settings, resetSettingsForTest } from "../../src/config/settings";
import { cfgCompactionModelThresholds, cfgCompactionThresholdTokens } from "../../src/session/context-settings";
import {
	describeModelCompactionPoint,
	planModelCompactionPoint,
	resolveEffectiveContextWindow,
	resolveModelCompactionSettings,
} from "../../src/session/model-compaction-threshold";
import { runCompactionControl } from "../../src/session/compaction-controls";
import { compactionThresholdSettings, createSubagentSettings } from "../../src/task/executor";
import { createModelBrowserSource } from "../../src/modes/model-browser-source";
import { ModelBrowser, buildBrowserItems } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { stripVTControlCharacters } from "node:util";

const model = buildModel({
	provider: "test",
	id: "reasoner",
	name: "Reasoner",
	api: "ollama-chat",
	baseUrl: "https://example.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4096,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
});
const scratch: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	for (const dir of scratch.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function directory(): Promise<string> {
	const root = path.join(process.env.HOME!, ".cache/npi-canary");
	await fs.mkdir(root, { recursive: true });
	const dir = await fs.mkdtemp(path.join(root, "context-policy-"));
	scratch.push(dir);
	return dir;
}

describe("context rules", () => {
	test("starts real Settings.init with context rules absent", async () => {
		const dir = await directory();
		const settings = await Settings.init({ cwd: dir, agentDir: dir, inMemory: true });
		expect(cfgContextRules.get(settings)).toEqual([]);
		expect(resolveEffectiveContextWindow(settings, model)).toBe(200_000);
	});

	test("loads unknown effort names without widening rules or blocking unrelated models", async () => {
		const dir = await directory();
		await Bun.write(
			path.join(dir, "config.toml"),
			stringifySettingsToml({
				effort: {
					rules: [
						{ selector: "test/broken", allowed: ["future-effort"] },
						{ selector: "test/reasoner", allowed: ["future-effort", "low"] },
					],
				},
				context: { rules: [{ selector: "test/broken", limit: "invalid" }] },
				roleEffortSelections: { smol: { mode: "auto", allowed: ["future-effort", "low"] } },
			}),
		);
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = await Settings.loadReadOnly({ cwd: dir, agentDir: dir });
		expect(resolveImplicitEffort(settings, model).candidates).toEqual([Effort.Low]);
		expect(resolveImplicitEffort(settings, model).candidates).toEqual([Effort.Low]);
		expect(warning).toHaveBeenCalledTimes(1);
		expect(warning.mock.calls[0]?.[0]).toContain("test/reasoner");
		const broken = { ...model, id: "broken" };
		expect(() => resolveImplicitEffort(settings, broken)).toThrow("Effort rule test/broken");
		expect(() => resolveEffectiveContextWindow(settings, broken)).toThrow(
			"Invalid context rule limit for test/broken",
		);
		expect(resolveEffectiveContextWindow(settings, model)).toBe(200_000);
		const unrelated = { ...model, provider: "other" };
		expect(resolveImplicitEffort(settings, unrelated).candidates).toContain(Effort.High);
		expect(resolveImplicitEffort(settings, model, settings.getRoleEffortSelection("smol")).candidates).toEqual([
			Effort.Low,
		]);
		expect(() =>
			cfgRoleEffortSelections.assertWritable({
				smol: { mode: "auto", allowed: ["future-effort"] },
			}),
		).toThrow("supported thinking effort names");
	});

	test("rejects unknown efforts on UI writes and blocks invalid matching patterns despite an exact rule", async () => {
		const dir = await directory();
		await Bun.write(
			path.join(dir, "config.toml"),
			stringifySettingsToml({
				effort: {
					rules: [
						{ selector: "test/reasoner", allowed: ["high"] },
						{ selector: "test/*", allowed: ["future-effort"] },
					],
				},
			}),
		);
		const settings = await Settings.loadReadOnly({ cwd: dir, agentDir: dir });
		expect(() => resolveImplicitEffort(settings, model)).toThrow("Effort rule test/*");
		expect(() =>
			cfgEffortRules.assertWritable([{ selector: "test/reasoner", allowed: ["low", "future-effort"] }]),
		).toThrow("supported thinking effort names");
		expect(() => cfgContextRules.assertWritable([{ selector: "test/reasoner", limit: "invalid" }])).toThrow(
			"Invalid context rule limit",
		);
	});

	test("uses exact over regex over glob, retaining order within a tier", () => {
		const settings = Settings.isolated({
			"context.rules": [
				{ selector: "test/*", limit: 100_000 },
				{ selector: "re:^test/", limit: 90_000 },
				{ selector: "re:reasoner$", limit: 80_000 },
				{ selector: "TEST/REASONER", limit: 70_000 },
			],
		});
		expect(matchContextRule(settings, model)?.limit).toBe(70_000);
		cfgContextRules.override(settings, cfgContextRules.get(settings).slice(0, 3));
		expect(matchContextRule(settings, model)?.limit).toBe(90_000);
		cfgContextRules.override(settings, [
			{ selector: "TEST/*", limit: 60_000 },
			{ selector: "test/r*", limit: 50_000 },
		]);
		expect(matchContextRule(settings, model)?.limit).toBe(60_000);
		expect(matchContextRule(settings, { provider: "other", id: model.id })).toBeUndefined();
		cfgContextRules.override(settings, [{ selector: "re:^TEST/", limit: 40_000 }]);
		expect(matchContextRule(settings, model)).toBeUndefined();
	});

	test("skips invalid regexes and rejects invalid limits and duplicate selectors", () => {
		const settings = Settings.isolated();
		cfgContextRules.override(settings, [
			{ selector: "re:[", limit: 50_000 },
			{ selector: "test/*", limit: 40_000 },
		]);
		expect(matchContextRule(settings, model)?.limit).toBe(40_000);
		for (const limit of [0, -1, "100k", "101%", "f0"])
			expect(() => cfgContextRules.set(settings, [{ selector: "test/*", limit }])).toThrow(
				"Invalid context rule limit",
			);
		expect(() =>
			cfgContextRules.set(settings, [
				{ selector: "test/*", limit: 5 },
				{ selector: "TEST/*", limit: 10 },
			]),
		).toThrow("Duplicate context rule");
	});

	test("loads rule arrays with the same overlay scope replacement as effort rules", async () => {
		const dir = await directory();
		const agentDir = path.join(dir, "agent");
		await Bun.write(
			path.join(agentDir, "config.toml"),
			stringifySettingsToml({
				context: { rules: [{ selector: "test/*", limit: 100_000 }] },
				effort: { rules: [{ selector: "test/*", allowed: ["low"] }] },
			}),
		);
		const overlay = path.join(dir, "overlay.toml");
		await Bun.write(
			overlay,
			stringifySettingsToml({
				context: { rules: [{ selector: "test/reasoner", limit: 50_000 }] },
				effort: { rules: [{ selector: "test/reasoner", allowed: ["high"] }] },
			}),
		);
		const settings = await Settings.loadReadOnly({ cwd: dir, agentDir, configFiles: [overlay] });
		expect(cfgContextRules.get(settings)).toEqual([{ selector: "test/reasoner", limit: 50_000 }]);
		expect(cfgEffortRules.get(settings)).toEqual([{ selector: "test/reasoner", allowed: [Effort.High] }]);
	});

	test("applies N limits over rules, and session/role/agent budgets over both", async () => {
		const settings = Settings.isolated({ "context.rules": [{ selector: "test/*", limit: 100_000 }] });
		expect(resolveEffectiveContextWindow(settings, model)).toBe(100_000);
		expect(resolveModelCompactionSettings(settings, model)).toBe(resolveModelCompactionSettings(settings, model));
		expect(describeModelCompactionPoint(settings, model).source).toBe("context rule test/*");
		cfgCompactionModelThresholds.override(settings, { "test/reasoner": 80_000 });
		expect(resolveEffectiveContextWindow(settings, model)).toBe(80_000);
		settings.setRoleSetting("slow", cfgCompactionThresholdTokens, 70_000);
		settings.setActiveRole("slow");
		expect(resolveEffectiveContextWindow(settings, model)).toBe(70_000);
		await runCompactionControl(settings, { action: "set", values: { thresholdTokens: 60_000 } });
		expect(resolveEffectiveContextWindow(settings, model)).toBe(60_000);
		const agent = createSubagentSettings(
			Settings.isolated({ "context.rules": [{ selector: "test/*", limit: 100_000 }] }),
			compactionThresholdSettings({ thresholdPercent: -1, thresholdTokens: 50_000 }),
		);
		expect(resolveEffectiveContextWindow(agent, model)).toBe(50_000);
		expect(resolveEffectiveContextWindow(createSubagentSettings(agent), model)).toBe(100_000);
	});

	test("resolves token bases, fixed triggers and percentages without changing catalog capacity", () => {
		const settings = Settings.isolated();
		for (const [limit, effective, trigger] of [
			[100_000, 100_000, 83_616],
			["f90000", 90_000, 90_000],
			["50%", 100_000, 100_000],
			[900_000, 200_000, 170_000],
		] as const) {
			cfgContextRules.override(settings, [{ selector: "test/*", limit }]);
			expect(resolveEffectiveContextWindow(settings, model)).toBe(effective);
			expect(resolveThresholdTokens(model.contextWindow!, resolveModelCompactionSettings(settings, model))).toBe(
				trigger,
			);
		}
		expect(model.contextWindow).toBe(200_000);
		cfgCompactionModelThresholds.override(settings, { "test/reasoner": 80_000 });
		expect(planModelCompactionPoint(settings, model, "", undefined)?.trigger?.tokens).toBe(170_000);
	});

	test("effort rules constrain saved fixed defaults and implicit subagents but not explicit caller efforts", () => {
		const settings = Settings.isolated({
			"effort.rules": [{ selector: "test/*", allowed: [Effort.Low] }],
			"context.rules": [{ selector: "test/*", limit: 80_000 }],
		});
		expect(resolveImplicitEffort(settings, model, { mode: "auto" }).candidates).toEqual([Effort.Low]);
		expect(resolveImplicitEffort(settings, model, { mode: "fixed", level: ThinkingLevel.High }, "role").level).toBe(
			ThinkingLevel.Low,
		);
		expect(resolveImplicitEffort(settings, model, { mode: "fixed", level: ThinkingLevel.High }, "caller").level).toBe(
			ThinkingLevel.High,
		);
		expect(resolveImplicitEffort(settings, model, { mode: "fixed", level: ThinkingLevel.High }, "manual").level).toBe(
			ThinkingLevel.High,
		);
		expect(resolveEffectiveContextWindow(createSubagentSettings(settings), model)).toBe(80_000);
	});
});

test("disabled compaction retains capacity and context rules never open an extended window", () => {
	const settings = Settings.isolated({ "context.rules": [{ selector: "test/*", limit: 900_000 }] });
	expect(planModelCompactionPoint(settings, model, "", { standard: 200_000, extended: 1_000_000 })?.window).toBe(
		200_000,
	);
	const disabled = Settings.isolated({
		"compaction.enabled": false,
		"context.rules": [{ selector: "test/*", limit: 80_000 }],
	});
	expect(resolveEffectiveContextWindow(disabled, model)).toBe(200_000);
	expect(resolveEffectiveContextWindow(settings, { ...model, contextWindow: 0 })).toBe(0);
});

test("renders an effective context column apart from catalog capacity and refreshes it after edits", async () => {
	await initTheme(false);
	const settings = Settings.isolated({ "context.rules": [{ selector: "test/*", limit: 100_000 }] });
	const browser = new ModelBrowser(createModelBrowserSource(settings));
	const items = buildBrowserItems([model]);
	browser.setItems(items);
	browser.setMaxVisible(5);
	expect(stripVTControlCharacters(browser.render(220).join("\n"))).toContain("100k*");
	expect(browser.pickerItems(items).items[0]?.facts?.ctx).toBe("100k*");
	const preview = JSON.stringify(browser.modelPreview(items[0]!, "full", undefined));
	expect(preview).toContain("200,000");
	expect(preview).toContain("Effective context *");
	cfgCompactionModelThresholds.override(settings, { "test/reasoner": 80_000 });
	expect(stripVTControlCharacters(browser.render(220).join("\n"))).toContain("80k*");
	const update = browser.pickerItems(items);
	expect((update.itemsAdd ?? update.items)[0]?.facts?.ctx).toBe("80k*");
});

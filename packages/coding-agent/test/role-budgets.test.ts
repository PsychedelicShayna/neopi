import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSettingsToml, stringifySettingsToml } from "@oh-my-pi/pi-utils";
import type { Model } from "@oh-my-pi/pi-ai";
import { cfgRoleSettings } from "../src/config/role-settings";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { createSettingsHost } from "../src/config/settings-ui";
import { cfgCompaction, cfgCompactionThresholdTokens } from "../src/session/context-settings";
import {
	describeModelCompactionPoint,
	resolveModelCompactionSettings,
} from "../src/session/model-compaction-threshold";

const roots: string[] = [];
afterEach(async () => {
	resetSettingsForTest();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const base = path.join(os.homedir(), ".cache/npi-canary");
	await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "role-budgets-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd);
	await Bun.write(
		path.join(agentDir, "config.toml"),
		stringifySettingsToml({ compaction: { thresholdTokens: 100000 } }),
	);
	return { agentDir, cwd };
}

describe("role context budgets", () => {
	it("loads real settings without role overrides and leaves global budgets unchanged", async () => {
		const settings = await Settings.init(await fixture());
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(100000);
		settings.setActiveRole("slow");
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(100000);
		expect(settings.getRoleSetting("slow", cfgCompactionThresholdTokens)).toBeUndefined();
		cfgCompactionThresholdTokens.set(settings, 0);
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(0);
	});

	it("initializes an empty config with no role settings or token limit", async () => {
		const options = await fixture();
		await Bun.write(path.join(options.agentDir, "config.toml"), stringifySettingsToml({}));
		const settings = await Settings.init(options);
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(-1);
	});

	it("edits global and role budgets with the same numeric settings control", () => {
		const settings = Settings.isolated();
		const host = createSettingsHost(settings);
		const path = "roleSettings.slow.compaction.thresholdTokens";
		expect(host.entries.find(entry => entry.path === path)?.ui).toMatchObject({ customInput: true });
		host.set("compaction.thresholdTokens", 100000);
		host.set(path, 120000);
		settings.setActiveRole("slow");
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(120000);
		expect(host.get("compaction.thresholdTokens")).toBe(100000);
		host.set(path, -1);
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(100000);
		host.set(path, 130000);
		host.unset(path);
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(100000);
		expect(() => host.set(path, 12.5)).toThrow("positive safe integer");
	});

	it("persists 120000 across model reassignment without baking activation into global settings", async () => {
		const options = await fixture();
		const settings = await Settings.init(options);
		settings.setRoleSetting("slow", cfgCompactionThresholdTokens, 120000);
		settings.setModelRole("slow", "provider/first");
		settings.setActiveRole("slow");
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(120000);
		expect(cfgCompactionThresholdTokens.provenance(settings)).toBe("role");
		settings.setModelRole("slow", "provider/second");
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(120000);
		await settings.flush();
		const saved = parseSettingsToml(await Bun.file(path.join(options.agentDir, "config.toml")).text());
		expect(saved).toMatchObject({
			compaction: { thresholdTokens: 100000 },
			roleSettings: { slow: { "compaction.thresholdTokens": 120000 } },
		});
		resetSettingsForTest();
		const reloaded = await Settings.init(options);
		expect(reloaded.activeRole).toBeUndefined();
		expect(cfgCompaction.get(reloaded).thresholdTokens).toBe(100000);
		reloaded.setActiveRole("slow");
		expect(cfgCompaction.get(reloaded).thresholdTokens).toBe(120000);
		reloaded.setActiveRole("default");
		expect(cfgCompaction.get(reloaded).thresholdTokens).toBe(100000);
	});

	it("keeps session overrides above role defaults and observes edits of the active role", async () => {
		const settings = Settings.isolated();
		cfgCompactionThresholdTokens.set(settings, 100000);
		settings.setRoleSetting("slow", cfgCompactionThresholdTokens, 120000);
		const seen: number[] = [];
		const stop = cfgCompactionThresholdTokens.listen(settings, value => {
			seen.push(value);
		});
		settings.setActiveRole("slow");
		await Bun.sleep(0);
		expect(seen.at(-1)).toBe(120000);
		cfgCompactionThresholdTokens.override(settings, 90000);
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(90000);
		expect(cfgCompactionThresholdTokens.provenance(settings)).toBe("runtime");
		cfgCompactionThresholdTokens.clearOverride(settings);
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(120000);
		settings.setRoleSetting("slow", cfgCompactionThresholdTokens, 130000);
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(130000);
		settings.setRoleSetting("slow", cfgCompactionThresholdTokens, undefined);
		expect(cfgCompaction.get(settings).thresholdTokens).toBe(100000);
		await Bun.sleep(0);
		expect(seen).toEqual([120000, 100000]);
		stop();
	});

	it("rejects invalid budgets and settings not declared role-scoped", () => {
		const settings = Settings.isolated();
		for (const value of [0, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
			expect(() => settings.setRoleSetting("slow", cfgCompactionThresholdTokens, value)).toThrow();
		expect(() => cfgRoleSettings.set(settings, { slow: { "unknown.setting": 1 } })).toThrow("role overrides");
	});

	it("uses the role's absolute trigger ahead of a model-specific compaction base", () => {
		const settings = Settings.isolated({
			"compaction.modelThresholds": { "test/model": 180000 },
		});
		settings.setRoleSetting("slow", cfgCompactionThresholdTokens, 120000);
		settings.setActiveRole("slow");
		const model = { provider: "test", id: "model", contextWindow: 200000 } as Model;
		expect(resolveModelCompactionSettings(settings, model).thresholdTokens).toBe(120000);
		expect(describeModelCompactionPoint(settings, model)).toMatchObject({ tokens: 120000, source: "role" });
		settings.setActiveRole(undefined);
		expect(resolveModelCompactionSettings(settings, model).baseWindowTokens).toBe(180000);
	});
});

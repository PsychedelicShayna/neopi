import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { all } from "../../src/config/registry";
import { Settings } from "../../src/config/settings";
import { AgentStorage } from "../../src/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { cfgChroniclerBackfillConcurrency, cfgChroniclerBackfillPollMs } from "../../src/chronicler/backfill-settings";

describe("Chronicler settings", () => {
	let state: SettingsTestState | undefined;
	let temp: TempDir;
	beforeEach(() => {
		state = beginSettingsTest();
		temp = TempDir.createSync("@pi-chronicler-settings-");
	});
	afterEach(async () => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		await temp.remove();
	});

	it("initializes real settings without any Chronicler configuration", async () => {
		const agentDir = temp.join("agent");
		const cwd = temp.join("project");
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(`${agentDir}/config.yml`, "compaction:\n  enabled: false\n");
		const settings = await Settings.init({ cwd, agentDir });
		const chronicler = all().filter(setting => setting.id.startsWith("chronicler."));
		expect(chronicler.length).toBeGreaterThan(10);
		for (const setting of chronicler) {
			expect(setting.get(settings)).toEqual(setting.default);
			expect(setting.ui?.tab).toBe("memory");
			expect(setting.ui?.group).toBe("Chronicler");
			expect(setting.ui?.description.length).toBeGreaterThan(0);
			if (setting.definition.type === "number") {
				expect(setting.definition.ui?.options?.length).toBeGreaterThan(0);
				expect(setting.definition.ui?.customInput).toBe(true);
			}
		}
	});

	it("rejects unsafe backfill concurrency and polling intervals without losing defaults", () => {
		const settings = Settings.isolated();
		expect(() => cfgChroniclerBackfillConcurrency.set(settings, 0)).toThrow("positive integer");
		expect(() => cfgChroniclerBackfillPollMs.set(settings, 0)).toThrow("at least 1 millisecond");
		expect(cfgChroniclerBackfillConcurrency.get(settings)).toBe(4);
		expect(cfgChroniclerBackfillPollMs.get(settings)).toBe(5_000);
	});
});

import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { cfgChroniclerBackfillConcurrency, cfgChroniclerBackfillPollMs } from "../../src/chronicler/backfill-settings";

describe("Chronicler settings", () => {
	it("rejects unsafe backfill concurrency and polling intervals without losing defaults", () => {
		const settings = Settings.isolated();
		expect(() => cfgChroniclerBackfillConcurrency.set(settings, 0)).toThrow("positive integer");
		expect(() => cfgChroniclerBackfillPollMs.set(settings, 0)).toThrow("at least 1 millisecond");
		expect(cfgChroniclerBackfillConcurrency.get(settings)).toBe(4);
		expect(cfgChroniclerBackfillPollMs.get(settings)).toBe(5_000);
	});
});

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import {
	cfgLiveBlockDelegateKeyword,
	cfgLiveForceDelegateKeyword,
	cfgLiveSubmitKeyword,
	cfgLiveSubmitSilenceMs,
} from "../src/live/settings";
import { stripLiveKeyword } from "../src/live/keywords";

describe("live keyword normalization", () => {
	it("persists configured phrases and their shared silence timeout", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-keyword-settings-"));
		try {
			const configured = await Settings.loadIsolated({ cwd: dir, agentDir: dir });
			cfgLiveForceDelegateKeyword.set(configured, "send it now");
			cfgLiveBlockDelegateKeyword.set(configured, "iris only");
			cfgLiveSubmitKeyword.set(configured, "send off");
			cfgLiveSubmitSilenceMs.set(configured, 2500);
			await configured.flush();
			const reloaded = await Settings.loadIsolated({ cwd: dir, agentDir: dir });
			expect(cfgLiveForceDelegateKeyword.get(reloaded)).toBe("send it now");
			expect(cfgLiveBlockDelegateKeyword.get(reloaded)).toBe("iris only");
			expect(cfgLiveSubmitKeyword.get(reloaded)).toBe("send off");
			expect(cfgLiveSubmitSilenceMs.get(reloaded)).toBe(2500);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("matches punctuation and collapsed or missing whitespace, stripping exactly the spoken keyword", () => {
		expect(stripLiveKeyword("please Send... it, now — thanks", "send it now")).toEqual({
			matched: true,
			text: "please thanks",
		});
		expect(stripLiveKeyword("please sendit now thanks", "SEND IT NOW")).toEqual({
			matched: true,
			text: "please thanks",
		});
		expect(stripLiveKeyword("Iris—only tell me a joke", "iris only")).toEqual({
			matched: true,
			text: "tell me a joke",
		});
		expect(stripLiveKeyword("Stay here.", "")).toEqual({ matched: false, text: "Stay here." });
		expect(stripLiveKeyword("don't send it", "send it now")).toEqual({
			matched: false,
			text: "don't send it",
		});
	});
	it("ignores embedded keywords and keeps formatting outside the matched span", () => {
		expect(stripLiveKeyword("sender", "send")).toEqual({ matched: false, text: "sender" });
		expect(stripLiveKeyword("run git log -- send it now", "send it now")).toEqual({
			matched: true,
			text: "run git log --",
		});
		expect(stripLiveKeyword("first\n\nsecond send off", "send off", true)).toEqual({
			matched: true,
			text: "first\n\nsecond",
		});
		expect(stripLiveKeyword("𐐀 please submit", "submit", true)).toEqual({
			matched: true,
			text: "𐐀 please",
		});
	});

	it("requires a keyword at the end of composer text, with punctuation and whitespace variants", () => {
		expect(stripLiveKeyword("send off was mentioned earlier", "send off", true)).toEqual({
			matched: false,
			text: "send off was mentioned earlier",
		});
		expect(stripLiveKeyword("sendoffthen", "send off", true)).toEqual({
			matched: false,
			text: "sendoffthen",
		});
		expect(stripLiveKeyword("please send... off!", "send off", true)).toEqual({
			matched: true,
			text: "please",
		});
		expect(stripLiveKeyword("please sendoff", "send off", true)).toEqual({
			matched: true,
			text: "please",
		});
	});
});

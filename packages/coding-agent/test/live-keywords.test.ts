import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../src/config/settings";
import { cfgLiveBlockDelegateKeyword, cfgLiveForceDelegateKeyword, cfgLiveSubmitKeyword } from "../src/live/settings";
import { stripLiveKeyword } from "../src/live/keywords";

describe("live keyword normalization", () => {
	it("persists both configured phrases when settings are reloaded", async () => {
		const dir = await mkdtemp(join(tmpdir(), "live-keyword-settings-"));
		try {
			const configured = await Settings.loadIsolated({ cwd: dir, agentDir: dir });
			cfgLiveForceDelegateKeyword.set(configured, "send it now");
			cfgLiveBlockDelegateKeyword.set(configured, "iris only");
			cfgLiveSubmitKeyword.set(configured, "send off");
			await configured.flush();
			const reloaded = await Settings.loadIsolated({ cwd: dir, agentDir: dir });
			expect(cfgLiveForceDelegateKeyword.get(reloaded)).toBe("send it now");
			expect(cfgLiveBlockDelegateKeyword.get(reloaded)).toBe("iris only");
			expect(cfgLiveSubmitKeyword.get(reloaded)).toBe("send off");
		} finally {
			await rm(dir, { recursive: true, force: true });
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
	it("requires submit at the end of a final turn, with punctuation and whitespace variants", () => {
		expect(stripLiveKeyword("send off was mentioned earlier", "send off", true)).toEqual({
			matched: false, text: "send off was mentioned earlier",
		});
		expect(stripLiveKeyword("sendoffthen", "send off", true)).toEqual({
			matched: false, text: "sendoffthen",
		});
		expect(stripLiveKeyword("please send... off!", "send off", true)).toEqual({
			matched: true, text: "please",
		});
		expect(stripLiveKeyword("please sendoff", "send off", true)).toEqual({
			matched: true, text: "please",
		});
	});
});

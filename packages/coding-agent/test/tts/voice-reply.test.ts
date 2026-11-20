import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as speech from "@oh-my-pi/pi-ai/speech";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AuthStorage } from "../../src/session/auth-storage";
import { encodePcm16Wav } from "../../src/stt/wav";
import { ttsClient } from "../../src/tts/tts-client";
import { Vocalizer } from "../../src/tts/vocalizer";

let auth: AuthStorage | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	auth?.close();
	auth = undefined;
});
const player = () => ({ start() {}, write(_pcm: Float32Array) {}, setGain() {}, async end() {}, stop() {} });

test("explicit voice reply preserves markup and bypasses disabled/enhanced streaming preferences", async () => {
	auth = await AuthStorage.create(":memory:");
	// Local speech runs on Phonon's streaming worker now that paced Kokoro is gone.
	const settings = Settings.isolated({
		"speech.enabled": false,
		"speech.enhanced": true,
		"tts.pacing": false,
		modelRoles: { speech: "local/phonon-31m" },
	});
	const registry = new ModelRegistry(auth, undefined, { settings });
	const pending = Promise.withResolvers<void>();
	const pushed: string[] = [];
	const stream = spyOn(ttsClient, "synthesizeStream").mockImplementation(() => ({
		push(segment) {
			pushed.push(segment);
		},
		end() {},
		chunks: (async function* () {
			await pending.promise;
			yield { index: 0, text: pushed.join(" "), pcm: new Float32Array([0.2]), sampleRate: 24000 };
		})(),
	}));
	const vocalizer = new Vocalizer(player);
	const text = "Read **this** and `that`.";
	const speaking = vocalizer.speakReply(
		text,
		{ settings, registry, sessionId: "voice" },
		new AbortController().signal,
	);
	expect(vocalizer.isSpeaking()).toBe(true);
	pending.resolve();
	await speaking;
	expect(pushed.join(" ")).toBe(text);
	expect(stream.mock.calls[0]![0]).toBe("phonon-31m");
	expect(vocalizer.isSpeaking()).toBe(false);
});

test("voice reply honors the cloud speech role instead of choosing local Kokoro", async () => {
	auth = await AuthStorage.create(":memory:");
	await auth.credentials.set("xai", [{ type: "api_key", key: "test-key" }]);
	const settings = Settings.isolated({ modelRoles: { speech: "xai/grok-tts" } });
	const registry = new ModelRegistry(auth, undefined, { settings });
	const local = spyOn(ttsClient, "synthesizeStream");
	const cloud = spyOn(speech, "synthesizeSpeech").mockResolvedValue({
		audio: encodePcm16Wav([new Float32Array([0.25])], 24000),
		mimeType: "audio/wav",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const output = player();
	const write = spyOn(output, "write");
	const vocalizer = new Vocalizer(() => output);
	await vocalizer.speakReply("Cloud reply.", { settings, registry, sessionId: "voice" }, new AbortController().signal);
	expect(local).not.toHaveBeenCalled();
	expect(cloud.mock.calls[0]![0].api).toBe("xai-tts");
	expect(cloud.mock.calls[0]![1].text).toBe("Cloud reply.");
	expect(write).toHaveBeenCalledTimes(1);
});

import { afterEach, expect, spyOn, test, vi } from "bun:test";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AuthStorage } from "../../src/session/auth-storage";
import { ttsClient } from "../../src/tts/tts-client";
import { Vocalizer } from "../../src/tts/vocalizer";
let auth: AuthStorage | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	auth?.close();
	auth = undefined;
});

test("original Kokoro retains the existing streaming worker path", async () => {
	auth = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "speech.enabled": true, modelRoles: { speech: "local/kokoro" } });
	const registry = new ModelRegistry(auth, undefined, { settings });
	const synth = spyOn(ttsClient, "synthesize");
	const pushed: string[] = [];
	const old = spyOn(ttsClient, "synthesizeStream").mockImplementation(() => ({
		push(text) {
			pushed.push(text);
		},
		end() {},
		chunks: (async function* () {})(),
	}));
	const vocalizer = new Vocalizer(() => ({ start() {}, write() {}, setGain() {}, async end() {}, stop() {} }));
	vocalizer.setModelSource({ settings, registry });
	vocalizer.speak("The ship is ready. The crew is waiting.");
	await vocalizer.idle();
	expect(old).toHaveBeenCalledTimes(1);
	expect(synth).not.toHaveBeenCalled();
	expect(pushed).toEqual(["The ship is ready.", "The crew is waiting."]);
});

test("wake interruption drops later streaming deltas until the next turn", async () => {
	auth = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({ "speech.enabled": true, modelRoles: { speech: "local/kokoro" } });
	const registry = new ModelRegistry(auth, undefined, { settings });
	const pushed: string[] = [];
	const old = spyOn(ttsClient, "synthesizeStream").mockImplementation(() => ({
		push(text) {
			pushed.push(text);
		},
		end() {},
		chunks: (async function* () {})(),
	}));
	const vocalizer = new Vocalizer(() => ({ start() {}, write() {}, setGain() {}, async end() {}, stop() {} }));
	vocalizer.setModelSource({ settings, registry });
	vocalizer.pushDelta("Before interruption. ");
	vocalizer.interruptTurn();
	vocalizer.pushDelta("This must stay silent. ");
	vocalizer.flush();
	await vocalizer.idle();
	expect(old).toHaveBeenCalledTimes(1);
	expect(pushed).toEqual(["Before interruption."]);
	vocalizer.beginTurn();
	vocalizer.pushDelta("The new turn can speak. ");
	vocalizer.flush();
	await vocalizer.idle();
	expect(old).toHaveBeenCalledTimes(2);
	expect(pushed).toEqual(["Before interruption.", "The new turn can speak."]);
});

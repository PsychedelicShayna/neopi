import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as runtimeDirs from "@oh-my-pi/pi-utils/dirs";
import { Settings } from "../src/config/settings";
import { LocalVoiceMode } from "../src/stt/local-voice";
import { cfgWakeEnabled } from "../src/stt/settings";
import type { AudioSink } from "../src/stt/shared-audio-capture";
import { STTController } from "../src/stt/stt-controller";
import { decodePcm16Wav } from "../src/stt/wav";
import { cfgSpeechEnabled, cfgVoiceEnabled } from "../src/tts/settings";
import * as player from "../src/tts/streaming-player";
import { vocalizer } from "../src/tts/vocalizer";

const settle = async () => {
	for (let i = 0; i < 32; i++) await Promise.resolve();
};
const silence = (ms: number) => new Float32Array(ms * 16);
const fixture = async (name: string) =>
	decodePcm16Wav(new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/wake-word/${name}.wav`).arrayBuffer()))
		.samples;

describe("session local voice", () => {
	let directory: string;
	const modes: LocalVoiceMode[] = [];
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "local-voice-test-"));
		vi.spyOn(runtimeDirs, "getGlobalDaemonRuntimeDir").mockReturnValue(directory);
		vi.spyOn(player.StreamingAudioPlayer.prototype, "start").mockImplementation(() => {});
		vi.spyOn(player.StreamingAudioPlayer.prototype, "write").mockImplementation(() => {});
		vi.spyOn(player.StreamingAudioPlayer.prototype, "end").mockResolvedValue();
		vi.spyOn(player.StreamingAudioPlayer.prototype, "stop").mockImplementation(() => {});
	});
	afterEach(async () => {
		for (const mode of modes.splice(0)) mode.disable();
		vocalizer.beginTurn();
		vi.restoreAllMocks();
		await fs.rm(directory, { recursive: true, force: true });
	});

	function setup(settings = Settings.isolated()) {
		let sink: AudioSink | undefined;
		let playing = false;
		const controller = new STTController();
		const transcribe = vi.spyOn(controller, "transcribeRecording").mockResolvedValue("Computer, tell me the answer");
		const detect = vi.fn(async () => ({ matched: true, trailingSpeech: false }));
		const capture = vi.fn((_rate: number, callback: AudioSink) => {
			sink = callback;
			return {
				stop() {
					sink = undefined;
				},
			};
		});
		const request = vi.fn(async (_text: string) => "The **whole** reply. Computer, still here.");
		const speak = vi.fn(async (_text: string, _signal: AbortSignal) => {});
		const postprocess = vi.fn(
			async (_text: string, _instruction: string, _signal: AbortSignal) => "A shorter reply.",
		);
		const warning = vi.fn();
		const clearSpeech = vi.fn();
		const mode = new LocalVoiceMode({
			settings,
			controller,
			capture,
			detector: { detect },
			prepare: async () => {},
			request,
			speak,
			postprocess,
			isSpeechPlaying: () => playing,
			clearSpeech,
			status() {},
			warning,
		});
		modes.push(mode);
		const push = (audio: Float32Array) => sink?.(null, audio);
		const wake = async () => {
			push(await fixture("computer"));
			push(silence(1000));
			await settle();
		};
		const utterance = async () => {
			await wake();
			push(await fixture("request"));
			push(silence(3000));
			await settle();
		};
		return {
			mode,
			capture,
			transcribe,
			request,
			speak,
			postprocess,
			detect,
			warning,
			clearSpeech,
			push,
			wake,
			utterance,
			setPlaying: (value: boolean) => {
				playing = value;
			},
		};
	}

	it("off by default opens nothing and never changes shared profile bytes", async () => {
		const config = "stt:\n  wake:\n    enabled: false\nspeech:\n  enabled: false\n";
		await Bun.write(path.join(directory, "config.yml"), config);
		await Bun.write(path.join(directory, "config.toml"), "# saved preferences\n");
		const profile = await Settings.loadReadOnly({ agentDir: directory, cwd: directory });
		const first = setup(profile);
		const second = setup(profile);
		expect(first.mode.enabled).toBe(false);
		expect(first.capture).not.toHaveBeenCalled();
		expect(await first.mode.enable()).toBe(true);
		expect(second.mode.enabled).toBe(false);
		expect(second.capture).not.toHaveBeenCalled();
		expect(cfgVoiceEnabled.get(profile)).toBe(false);
		expect(cfgWakeEnabled.get(profile)).toBe(false);
		expect(cfgSpeechEnabled.get(profile)).toBe(false);
		expect(await second.mode.enable()).toBe(false);
		expect(second.warning).toHaveBeenCalledWith("Microphone is already owned by another session");
		expect(second.capture).not.toHaveBeenCalled();
		first.mode.disable();
		expect(await second.mode.enable()).toBe(true);
		second.mode.disable();
		expect(await Bun.file(path.join(directory, "config.yml")).text()).toBe(config);
		expect(await Bun.file(path.join(directory, "config.toml")).text()).toBe("# saved preferences\n");
	});

	it.each(["verbatim", "processed", "failure"])(
		"submits fixture recording to this session and speaks %s",
		async variant => {
			const flow = setup(Settings.isolated({ "voice.postprocess": variant === "verbatim" ? "" : "Summarize it" }));
			if (variant === "failure") flow.postprocess.mockRejectedValue(new Error("offline"));
			expect(await flow.mode.enable()).toBe(true);
			await flow.utterance();
			expect(flow.transcribe).toHaveBeenCalledTimes(1);
			expect(flow.transcribe.mock.calls[0]![0].length).toBeGreaterThan((await fixture("request")).length);
			expect(flow.request).toHaveBeenCalledWith("tell me the answer");
			expect(flow.speak).toHaveBeenCalledTimes(1);
			expect(flow.speak.mock.calls[0]![0]).toBe(
				variant === "processed" ? "A shorter reply." : "The **whole** reply. Computer, still here.",
			);
			expect(flow.postprocess.mock.calls.length).toBe(variant === "verbatim" ? 0 : 1);
		},
	);

	it("suppresses wake detection through the agent turn, speech and echo tail", async () => {
		const flow = setup();
		const playback = Promise.withResolvers<void>();
		flow.speak.mockImplementation(async () => {
			flow.setPlaying(true);
			await playback.promise;
			flow.setPlaying(false);
		});
		await flow.mode.enable();
		await flow.utterance();
		expect(flow.speak).toHaveBeenCalledTimes(1);
		const detections = flow.detect.mock.calls.length;
		await flow.wake();
		expect(flow.detect).toHaveBeenCalledTimes(detections);
		playback.resolve();
		await settle();
		flow.push((await fixture("computer")).subarray(0, 4800));
		await settle();
		expect(flow.detect).toHaveBeenCalledTimes(detections);
		flow.push(silence(2000));
		await flow.utterance();
		expect(flow.request).toHaveBeenCalledTimes(2);
	});

	it.each(["generation", "postprocess", "playback"])(
		"rearms and interrupts pending %s on a second wake",
		async phase => {
			const flow = setup(
				Settings.isolated({
					"stt.wake.suppressWhileSpeaking": false,
					"voice.postprocess": phase === "postprocess" ? "Shorten" : "",
				}),
			);
			const reply = Promise.withResolvers<string>();
			const playback = Promise.withResolvers<void>();
			let firstSignal: AbortSignal | undefined;
			if (phase === "generation") flow.request.mockImplementationOnce(() => reply.promise);
			if (phase === "postprocess") {
				flow.postprocess.mockImplementationOnce((_text, _instruction, signal) => {
					firstSignal = signal;
					return reply.promise;
				});
			}
			if (phase === "playback") {
				flow.speak.mockImplementationOnce(async (_text, signal) => {
					firstSignal = signal;
					flow.setPlaying(true);
					await playback.promise;
				});
			}
			await flow.mode.enable();
			await flow.utterance();
			expect(flow.request).toHaveBeenCalledTimes(1);
			const clears = flow.clearSpeech.mock.calls.length;
			await flow.wake();
			expect(flow.clearSpeech.mock.calls.length).toBeGreaterThan(clears);
			if (firstSignal) expect(firstSignal.aborted).toBe(true);
			flow.setPlaying(false);
			flow.push(await fixture("request"));
			flow.push(silence(3000));
			await settle();
			expect(flow.request).toHaveBeenCalledTimes(2);
			reply.resolve("obsolete reply");
			playback.resolve();
			await settle();
			expect(flow.speak).toHaveBeenCalledTimes(phase === "playback" ? 2 : 1);
			expect(flow.warning).not.toHaveBeenCalled();
		},
	);

	it("turning off during postprocessing discards late speech", async () => {
		const flow = setup(Settings.isolated({ "voice.postprocess": "Translate" }));
		const pending = Promise.withResolvers<string>();
		flow.postprocess.mockImplementation(() => pending.promise);
		await flow.mode.enable();
		await flow.utterance();
		expect(flow.postprocess).toHaveBeenCalledTimes(1);
		flow.mode.disable();
		pending.resolve("late reply");
		await settle();
		expect(flow.speak).not.toHaveBeenCalled();
	});
});

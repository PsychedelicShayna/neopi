import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { Settings, settings } from "../src/config/settings";
import { XaiSTTController, type XaiSTTControllerDependencies } from "../src/stt/xai-stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("independent xAI whole-recording input", () => {
	let savedSettings: SettingsTestState | undefined;
	let tmp = "";
	let controller: XaiSTTController | undefined;
	let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;

	beforeEach(async () => {
		savedSettings = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.enabled", false);
		settings.set("stt.submitTrigger", "never");
		settings.setModelRole("dictation", "local-inference/parakeet-tdt-0.6b-v3");
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "neopi-xai-recording-"));
		setAgentDir(tmp);
		onAudio = undefined;
	});

	afterEach(async () => {
		controller?.dispose();
		controller = undefined;
		restoreSettingsTestState(savedSettings);
		vi.restoreAllMocks();
		await fs.rm(tmp, { recursive: true, force: true });
	});

	function setup(transcribe: XaiSTTControllerDependencies["transcribe"]) {
		let text = "Existing draft. ";
		const editor = {
			get text() {
				return text;
			},
			insertText(chunk: string) {
				text += chunk;
			},
			submit: vi.fn(),
		};
		const options = { showWarning: vi.fn(), showStatus: vi.fn(), onStateChange: vi.fn() };
		controller = new XaiSTTController({
			settings,
			transcribe,
			createCapture(callback) {
				onAudio = callback;
				return { stop() {} };
			},
		});
		return { editor, options, controller };
	}

	it("keeps speech and long pauses in one WAV until the second toggle, regardless of configured dictation", async () => {
		let recording: ArrayBuffer | undefined;
		const transcribe = vi.fn(async (audio: Blob) => {
			recording = await audio.arrayBuffer();
			return "One complete thought.";
		});
		const { editor, options, controller } = setup(transcribe);
		await controller.toggle(editor, options);
		onAudio!(null, new Float32Array([0.25, -0.25]));
		const pause = new Float32Array(16_000 * 5);
		onAudio!(null, pause);
		onAudio!(null, new Float32Array([0.5]));

		expect(controller.state).toBe("recording");
		expect(transcribe).not.toHaveBeenCalled();
		expect(editor.text).toBe("Existing draft. ");
		await controller.toggle(editor, options);

		expect(transcribe).toHaveBeenCalledTimes(1);
		const wav = new DataView(recording!);
		expect(wav.byteLength).toBe(44 + (pause.length + 3) * 2);
		expect(wav.getUint32(40, true)).toBe((pause.length + 3) * 2);
		expect(wav.getInt16(44, true)).toBe(8192);
		expect(wav.getInt16(46, true)).toBe(-8192);
		expect(new Int16Array(recording!, 48, pause.length).every(sample => sample === 0)).toBe(true);
		expect(wav.getInt16(wav.byteLength - 2, true)).toBe(16384);
		expect(editor.text).toBe("Existing draft. One complete thought.");
		expect(editor.submit).not.toHaveBeenCalled();
		expect(controller.state).toBe("idle");
	});

	it("finishes an empty capture without transcription or editor submission", async () => {
		const transcribe = vi.fn(async () => "must not be requested");
		const { editor, options, controller } = setup(transcribe);
		await controller.toggle(editor, options);
		await controller.toggle(editor, options);
		expect(transcribe).not.toHaveBeenCalled();
		expect(controller.state).toBe("idle");
		expect(editor.text).toBe("Existing draft. ");
		expect(editor.submit).not.toHaveBeenCalled();
	});

	it("returns to idle without inserting or submitting when xAI detects no speech", async () => {
		const transcribe = vi.fn(async () => "");
		const { editor, options, controller } = setup(transcribe);
		await controller.toggle(editor, options);
		onAudio!(null, new Float32Array(16_000));
		await controller.toggle(editor, options);
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(controller.state).toBe("idle");
		expect(editor.text).toBe("Existing draft. ");
		expect(editor.submit).not.toHaveBeenCalled();
		expect(options.showWarning).not.toHaveBeenCalled();
	});

	it("preserves the complete audio and reports its recovery path after a provider failure", async () => {
		const { editor, options, controller } = setup(async () => {
			throw new Error("Provider unavailable");
		});
		await controller.toggle(editor, options);
		onAudio!(null, new Float32Array([0.5]));
		await controller.toggle(editor, options);
		const recordingDir = path.join(tmp, "stt-recordings");
		const files = await fs.readdir(recordingDir);
		expect(files).toHaveLength(1);
		const retainedPath = path.join(recordingDir, files[0]!);
		const retained = new DataView(await Bun.file(retainedPath).arrayBuffer());
		expect(retained.getInt16(44, true)).toBe(16384);
		expect(options.showWarning).toHaveBeenCalledWith(expect.stringContaining(retainedPath));
		expect(editor.text).toBe("Existing draft. ");
		expect(controller.state).toBe("idle");
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as transcription from "@oh-my-pi/pi-ai/transcription";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { STTController, type STTControllerDependencies } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function xaiSttModel(): Model<"xai-stt"> {
	return buildModel({
		id: "grok-stt",
		name: "Grok STT",
		api: "xai-stt",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind: "stt",
	} satisfies ModelSpec<"xai-stt">);
}

function registryFor(model: Model): STTControllerDependencies["registry"] {
	return {
		getError: () => undefined,
		getAvailable: () => [model],
		getAll: () => [model],
		resolver: () => () => "test-key",
		getProviderBaseUrl: () => undefined,
		find: (provider, modelId) => (provider === model.provider && modelId === model.id ? model : undefined),
		resolveModelHeaders: async () => undefined,
		getProviderHeaders: async () => undefined,
	};
}

/** The space-hold push-to-talk gesture and the `app.stt.toggle` chord drive the same controller.
 *  The gesture has explicit start and release edges, so it must own the capture it starts and keep
 *  its hands off one it did not: a hold recognized a beat after the chord started dictation used to
 *  finalize that dictation early and hand its audio to the wrong route. */
describe("STTController push-to-talk hold ownership", () => {
	let state: SettingsTestState | undefined;
	let tmp = "";
	let controller: STTController | undefined;
	let onAudio: ((error: Error | null, samples: Float32Array) => void) | undefined;
	const stopCapture = vi.fn();
	const model = xaiSttModel();

	function makeEditor() {
		return {
			insertText: vi.fn(),
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			submit: vi.fn(),
			deleteBeforeCursor: vi.fn(),
		};
	}

	function makeOptions() {
		return {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
			requestRender: vi.fn(),
		};
	}

	function makeController(): STTController {
		controller = new STTController(
			callback => {
				onAudio = callback;
				return { stop: stopCapture };
			},
			{ settings, registry: registryFor(model) },
		);
		return controller;
	}

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.setModelRole("dictation", "xai/grok-stt");
		settings.set("stt.language", "en");
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stt-hold-test-"));
		setAgentDir(tmp);
		onAudio = undefined;
		stopCapture.mockReset();
	});

	afterEach(async () => {
		controller?.dispose();
		controller = undefined;
		restoreSettingsTestState(state);
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("leaves a chord-started recording alone across a full hold gesture", async () => {
		const transcribe = vi
			.spyOn(transcription, "transcribeAudio")
			.mockResolvedValue({ text: "chord dictation", usage: ZERO_USAGE });
		const stt = makeController();
		const editor = makeEditor();
		const options = makeOptions();

		await stt.toggle(editor, options);
		expect(stt.state).toBe("recording");
		onAudio?.(null, new Float32Array([0, 0.25, -0.25]));

		// Space bar held while the chord's capture is live: both edges are inert.
		await stt.holdStart(editor, options);
		expect(stt.state).toBe("recording");
		await stt.holdEnd(editor, options);
		expect(stt.state).toBe("recording");
		expect(stopCapture).not.toHaveBeenCalled();
		expect(transcribe).not.toHaveBeenCalled();

		// The chord still finalizes its own capture, exactly once.
		await stt.toggle(editor, options);
		expect(stt.state).toBe("idle");
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(editor.commitVolatileText).toHaveBeenCalledWith("chord dictation");
	});

	it("records and transcribes a hold it started itself", async () => {
		const transcribe = vi
			.spyOn(transcription, "transcribeAudio")
			.mockResolvedValue({ text: "held dictation", usage: ZERO_USAGE });
		const stt = makeController();
		const editor = makeEditor();
		const options = makeOptions();

		await stt.holdStart(editor, options);
		expect(stt.state).toBe("recording");
		onAudio?.(null, new Float32Array([0, 0.5, -0.5]));

		await stt.holdEnd(editor, options);
		expect(stt.state).toBe("idle");
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(editor.commitVolatileText).toHaveBeenCalledWith("held dictation");
	});

	it("ignores a release after the chord already stopped the held capture", async () => {
		const transcribe = vi
			.spyOn(transcription, "transcribeAudio")
			.mockResolvedValue({ text: "held dictation", usage: ZERO_USAGE });
		const stt = makeController();
		const editor = makeEditor();
		const options = makeOptions();

		await stt.holdStart(editor, options);
		onAudio?.(null, new Float32Array([0, 0.5, -0.5]));
		await stt.toggle(editor, options);
		expect(stt.state).toBe("idle");

		await stt.holdEnd(editor, options);
		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
	});

	it("stays inert when a transcription is still settling", async () => {
		const result = Promise.withResolvers<transcription.TranscriptionResult>();
		const transcribe = vi.spyOn(transcription, "transcribeAudio").mockReturnValue(result.promise);
		const stt = makeController();
		const editor = makeEditor();
		const options = makeOptions();

		await stt.holdStart(editor, options);
		onAudio?.(null, new Float32Array([0, 0.5, -0.5]));
		const pending = stt.holdEnd(editor, options);
		expect(stt.state).toBe("transcribing");

		await stt.holdStart(editor, options);
		expect(stt.state).toBe("transcribing");

		result.resolve({ text: "held dictation", usage: ZERO_USAGE });
		await pending;
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(stt.state).toBe("idle");
	});
});

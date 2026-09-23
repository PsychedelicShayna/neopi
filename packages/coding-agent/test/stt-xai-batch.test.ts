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

async function readAudioBytes(audio: Uint8Array | Blob): Promise<Uint8Array> {
	return audio instanceof Uint8Array ? audio : new Uint8Array(await audio.arrayBuffer());
}

describe("STTController xAI batch mode", () => {
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
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-xai-stt-test-"));
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

	it("records until the second toggle, then commits only the final transcript", async () => {
		const transcribe = vi.spyOn(transcription, "transcribeAudio").mockImplementation(async (_model, request) => {
			const bytes = await readAudioBytes(request.audio);
			expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
			expect(bytes.byteLength).toBeGreaterThan(44);
			return { text: "the final transcript", usage: ZERO_USAGE };
		});
		const stt = makeController();
		const editor = makeEditor();
		const options = makeOptions();

		await stt.toggle(editor, options);
		expect(stt.state).toBe("recording");
		onAudio?.(null, new Float32Array([0, 0.5, -0.5]));
		expect(editor.setVolatileText).not.toHaveBeenCalled();
		expect(editor.commitVolatileText).not.toHaveBeenCalled();

		await stt.toggle(editor, options);

		expect(stopCapture).toHaveBeenCalledTimes(1);
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(transcribe.mock.calls[0]?.[1]).toMatchObject({ fileName: "dictation.wav", language: "en" });
		expect(editor.commitVolatileText).toHaveBeenCalledWith("the final transcript");
		expect(editor.submit).not.toHaveBeenCalled();
		expect(stt.state).toBe("idle");
	});

	it("retains a failed recording and reports its durable path", async () => {
		vi.spyOn(transcription, "transcribeAudio").mockRejectedValue(new Error("upstream unavailable"));
		const stt = makeController();
		const options = makeOptions();

		await stt.toggle(makeEditor(), options);
		onAudio?.(null, new Float32Array([0.25, -0.25]));
		await stt.toggle(makeEditor(), options);

		const warning = options.showWarning.mock.calls[0]?.[0] as string;
		expect(warning).toContain("upstream unavailable");
		const retainedPath = warning.match(/Recording retained at (.+)$/)?.[1];
		expect(retainedPath).toBeDefined();
		expect(await fs.stat(retainedPath!)).toBeDefined();
	});

	it("keeps only the five most recent recordings", async () => {
		vi.spyOn(transcription, "transcribeAudio").mockResolvedValue({ text: "ok", usage: ZERO_USAGE });
		const stt = makeController();
		const editor = makeEditor();

		for (let i = 0; i < 6; i += 1) {
			await stt.toggle(editor, makeOptions());
			onAudio?.(null, new Float32Array([i / 10]));
			await stt.toggle(editor, makeOptions());
		}

		const files = await fs.readdir(path.join(tmp, "stt-recordings"));
		expect(files).toHaveLength(5);
	});
});

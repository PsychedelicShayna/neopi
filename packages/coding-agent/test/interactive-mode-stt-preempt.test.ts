import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as transcription from "@oh-my-pi/pi-ai/transcription";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings, settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import type { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import * as capture from "../src/stt/shared-audio-capture";
import * as asr from "../src/stt/asr-client";
import * as downloader from "../src/stt/downloader";
import { STTController } from "../src/stt/stt-controller";
import { Input, type TUI } from "@oh-my-pi/pi-tui";
import { cfgSttEnabled } from "../src/stt/settings";
import * as xai from "../src/stt/xai-stt";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("fork-owned Ctrl+Space: xAI preempts configured dictation", () => {
	let saved: SettingsTestState;
	let directory: string;
	let auth: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let audio: capture.AudioSink[];
	let closed: number[];
	let toggles: Promise<void>[];
	let listeners: Parameters<TUI["addInputListener"]>[0][];
	let throwOnStop: boolean;

	async function pressXai(): Promise<void> {
		const count = toggles.length;
		mode.editor.handleInput("\x00");
		expect(toggles).toHaveLength(count + 1);
		await toggles[count];
	}

	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(async () => {
		saved = beginSettingsTest();
		const root = os.tmpdir();
		await fs.mkdir(root, { recursive: true });
		directory = await fs.mkdtemp(path.join(root, "regression-"));
		setAgentDir(directory);
		await Settings.init({ inMemory: true, cwd: directory });
		cfgSttEnabled.set(settings, true);
		settings.setModelRole("dictation", "openai/whisper-1");
		auth = createInMemoryAuthStorage();
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5")!;
		const dictation = registry.find("openai", "whisper-1")!;
		vi.spyOn(registry, "getAvailable").mockReturnValue([model, dictation, registry.find("local", "whisper-base")!]);
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(directory, directory),
			settings,
			modelRegistry: registry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.spyOn(mode, "showWarning").mockImplementation(() => {});
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		toggles = [];
		listeners = [];
		throwOnStop = false;
		vi.spyOn(mode.ui, "addInputListener").mockImplementation(listener => {
			listeners.push(listener);
			return () => {};
		});
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue(undefined);
		const toggle = mode.handleSTTToggle.bind(mode);
		vi.spyOn(mode, "handleSTTToggle").mockImplementation(() => {
			const pending = toggle();
			toggles.push(pending);
			return pending;
		});
		mode.setEditorComponent(undefined);
		audio = [];
		closed = [];
		vi.spyOn(capture, "sharedAudioCapture").mockImplementation((_rate, callback) => {
			const id = audio.length;
			audio.push(callback);
			return {
				stop: () => {
					closed.push(id);
					if (throwOnStop) throw new Error("stuck native recorder");
				},
			};
		});
		vi.spyOn(xai, "transcribeXaiAudio").mockResolvedValue("xAI words");
		mode.editor.setText("Existing draft: ");
	});
	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		auth?.close();
		restoreSettingsTestState(saved);
		await fs.rm(directory, { recursive: true, force: true });
	});

	it.each(["recording", "transcribing"] as const)(
		"preempts %s, preserves draft, and ignores late native results",
		async phase => {
			const result = Promise.withResolvers<transcription.TranscriptionResult>();
			const native = vi.spyOn(transcription, "transcribeAudio").mockReturnValue(result.promise);
			await mode.handleDictationToggle();
			expect(audio).toHaveLength(1);
			audio[0]!(null, new Float32Array([0.25]));
			const pending = phase === "transcribing" ? mode.handleDictationToggle() : Promise.resolve();
			if (phase === "transcribing") expect(native).toHaveBeenCalledTimes(1);

			await pressXai();
			expect(mode.showWarning).not.toHaveBeenCalled();
			expect(closed).toContain(0);
			expect(audio).toHaveLength(2);
			expect(mode.editor.getText()).toBe("Existing draft: ");
			if (phase === "transcribing") expect(native.mock.calls[0]![2].signal?.aborted).toBe(true);
			// A retired provider and microphone are deliberately uncooperative after abort.
			result.resolve({ text: "WRONG native words", usage });
			await pending;
			audio[0]!(new Error("late retired mic error"), new Float32Array());
			expect(mode.editor.getText()).toBe("Existing draft: ");
			expect(mode.sttIdle).toBe(false);
			audio[1]!(null, new Float32Array([0.5]));
			await pressXai();
			expect(mode.editor.getText()).toBe("Existing draft: xAI words");
			expect(mode.sttIdle).toBe(true);
			expect(mode.showWarning).not.toHaveBeenCalled();
			// Taking over does not disable the selected configured provider.
			await mode.handleDictationToggle();
			expect(audio).toHaveLength(3);
			expect(mode.sttIdle).toBe(false);
		},
	);
	it.each(["resolve", "reject"] as const)(
		"retires configured startup before dependency setup can %s",
		async outcome => {
			settings.setModelRole("dictation", "local/whisper-base");
			const cached = Promise.withResolvers<boolean>();
			vi.spyOn(downloader, "isSttModelCached").mockReturnValue(cached.promise);
			vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
			const startStream = vi.spyOn(asr.sttClient, "startStream").mockReturnValue({
				pushAudio() {},
				stop: async () => "",
				cancel() {},
			});
			const pending = mode.handleDictationToggle();
			expect(audio).toHaveLength(0);
			await pressXai();
			expect(audio).toHaveLength(1);
			if (outcome === "resolve") cached.resolve(true);
			else cached.reject(new Error("retired dependency failure"));
			await pending;
			expect(startStream).not.toHaveBeenCalled();
			expect(audio).toHaveLength(1);
			expect(mode.showWarning).not.toHaveBeenCalled();
			expect(mode.editor.getText()).toBe("Existing draft: ");
			expect(mode.sttIdle).toBe(false);
		},
	);

	it.each(["recording", "transcribing"] as const)(
		"retires streaming %s even if provider cancellation throws",
		async phase => {
			settings.setModelRole("dictation", "local/whisper-base");
			vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
			vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
			const stopped = Promise.withResolvers<string>();
			let partial: ((text: string) => void) | undefined;
			let segment: ((text: string, ...indices: number[]) => void) | undefined;
			vi.spyOn(asr.sttClient, "startStream").mockImplementation((_key, options) => {
				partial = options?.onPartial;
				segment = options?.onSegment;
				return {
					pushAudio() {},
					stop: () => stopped.promise,
					cancel() {
						throw new Error("provider stuck");
					},
				};
			});
			await mode.handleDictationToggle();
			segment?.("committed");
			const draft = mode.editor.getText();
			partial?.("volatile");
			const pending = phase === "transcribing" ? mode.handleDictationToggle() : Promise.resolve();
			throwOnStop = true;
			await pressXai();
			throwOnStop = false;
			expect(audio).toHaveLength(2);
			expect(closed).toContain(0);
			expect(mode.editor.getText()).toBe(draft);
			partial?.("late partial");
			segment?.("late segment");
			stopped.resolve("late final");
			await pending;
			expect(mode.editor.getText()).toBe(draft);
			expect(mode.sttIdle).toBe(false);
			expect(mode.showWarning).not.toHaveBeenCalled();
		},
	);

	it.each(["failed", "disposed"] as const)("reaches xAI with a %s configured controller", async state => {
		let configured: STTController | undefined;
		const original = STTController.prototype.start;
		vi.spyOn(STTController.prototype, "start").mockImplementation(function (this: STTController, editor, callbacks) {
			configured = this;
			return original.call(this, editor, callbacks);
		});
		await mode.handleDictationToggle();
		if (state === "disposed") configured!.dispose();
		else audio[0]!(new Error("microphone failed"), new Float32Array());
		vi.spyOn(mode, "showWarning").mockClear();
		await pressXai();
		expect(audio).toHaveLength(2);
		expect(mode.sttIdle).toBe(false);
		expect(mode.showWarning).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"takes over an actual Space hold (latched=%s) and ignores its retired release",
		async latched => {
			vi.useFakeTimers();
			try {
				for (let i = 0; i < 4; i++) {
					vi.advanceTimersByTime(40);
					mode.editor.handleInput(" ");
				}
				await Promise.resolve();
				expect(audio).toHaveLength(1);
				if (latched) mode.editor.handleInput("\x7f");
				await pressXai();
				expect(audio).toHaveLength(2);
				vi.advanceTimersByTime(1000);
				expect(mode.sttIdle).toBe(false);
				expect(closed).toEqual([0]);
				expect(mode.editor.getText()).toBe("Existing draft: ");
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("keeps xAI on the main composer while a modal owns keyboard focus", async () => {
		const filter = new Input();
		filter.setValue("overlay filter");
		const overlay = mode.ui.showOverlay(filter);
		const pressGlobal = async () => {
			const count = toggles.length;
			for (const listener of listeners) {
				if (listener("\x00")?.consume) break;
			}
			expect(toggles).toHaveLength(count + 1);
			await toggles[count];
		};
		try {
			await pressGlobal();
			expect(audio).toHaveLength(1);
			audio[0]!(null, new Float32Array([0.5]));
			await pressGlobal();
			expect(mode.editor.getText()).toBe("Existing draft: xAI words");
			expect(filter.getValue()).toBe("overlay filter");
		} finally {
			overlay.hide();
		}
	});

	it("reaches the xAI toggle with a locked composer chain", async () => {
		mode.editor.setChainLock({ onSkip() {}, onCancel() {} });
		await pressXai();
		expect(audio).toHaveLength(1);
		mode.editor.setChainLock(undefined);
	});

	it("does not let failed configured cleanup block the reserved xAI toggle", async () => {
		await mode.handleDictationToggle();
		vi.spyOn(mode.editor, "clearVolatileText").mockImplementationOnce(() => {
			throw new Error("retired target already disposed");
		});
		await pressXai();
		expect(audio).toHaveLength(2);
		expect(closed).toContain(0);
		expect(mode.showWarning).not.toHaveBeenCalled();
	});

	it("releases a configured latch in another prompt without stopping the new xAI capture", async () => {
		const input = new Input();
		input.setValue("Follow-up");
		input.spaceHold.handler = mode.dictationSpaceHold(input);
		vi.useFakeTimers();
		try {
			for (let i = 0; i < 4; i++) {
				vi.advanceTimersByTime(40);
				input.handleInput(" ");
			}
			await Promise.resolve();
			input.handleInput("\x7f");
			expect(audio).toHaveLength(1);
			await pressXai();
			vi.advanceTimersByTime(1000);
			input.handleInput(" ");
			expect(input.getValue()).toBe("Follow-up ");
			expect(mode.sttIdle).toBe(false);
			expect(closed).toEqual([0]);
		} finally {
			vi.useRealTimers();
		}
	});
});

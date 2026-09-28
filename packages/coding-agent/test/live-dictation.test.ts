import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../src/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { Settings, settings } from "../src/config/settings";
import { LiveSessionController } from "../src/live/controller";
import { createSharedAudioCapture } from "../src/stt/shared-audio-capture";
import { XaiSTTController } from "../src/stt/xai-stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let savedSettings: SettingsTestState | undefined;
const temporaryDirs: string[] = [];
afterEach(async () => {
	for (const path of temporaryDirs.splice(0)) await rm(path, { recursive: true, force: true });
	restoreSettingsTestState(savedSettings);
	savedSettings = undefined;
	vi.restoreAllMocks();
});

describe("dictation during a live call", () => {
	it("records and inserts xAI text from the same mic without interrupting live audio", async () => {
		const dir = mkdtempSync(join(tmpdir(), "neopi-live-dictation-"));
		temporaryDirs.push(dir);
		savedSettings = beginSettingsTest();
		await Settings.init({ inMemory: true });
		setAgentDir(dir);
		let receive: ((error: Error | null, samples: Float32Array) => void) | undefined;
		let opens = 0;
		let closes = 0;
		const capture = createSharedAudioCapture((_rate, callback) => {
			opens++;
			if (opens - closes !== 1) throw new Error("Microphone already open");
			receive = callback;
			return { stop: () => { closes++; } };
		});
		const liveAudio: Float32Array[] = [];
		const session = {
			modelRegistry: { authStorage: {} },
			sessionId: "concurrent-input-test",
			subscribe: () => () => {},
		} as unknown as AgentSession;
		const live = new LiveSessionController({
			session,
			callbacks: { onPhase() {}, onLevels() {}, onTranscript() {}, onTerminal() {} },
			extractAssistantText: () => "",
			createTransport: () => ({
				connect: async () => {}, send: async () => {}, close: async () => {},
				setMuted: async () => {}, pushAudio: samples => { liveAudio.push(samples); },
			}),
			createRecorder: capture,
		});
		let text = "Draft: ";
		const editor = { insertText: (value: string) => { text += value; }, submit: vi.fn() };
		const warning = vi.fn();
		const dictation = new XaiSTTController({
			settings,
			transcribe: async audio => {
				const wav = new DataView(await audio.arrayBuffer());
				expect(wav.getInt16(44, true)).toBe(16384);
				return "dictated words";
			},
			createCapture: callback => capture(16_000, callback),
		});
		try {
			await live.start();
			await dictation.toggle(editor, { showWarning: warning, showStatus() {}, onStateChange() {} });
			expect(dictation.state).toBe("recording");
			expect(opens).toBe(1);
			const samples = new Float32Array([0.5, -0.5]);
			receive!(null, samples);
			await dictation.toggle(editor, { showWarning: warning, showStatus() {}, onStateChange() {} });
			expect(text).toBe("Draft: dictated words");
			expect(warning).not.toHaveBeenCalled();
			expect(liveAudio).toEqual([samples]);
			expect(closes).toBe(0);
			receive!(null, samples);
			expect(liveAudio).toEqual([samples, samples]);
		} finally {
			dictation.dispose();
			await live.stop();
		}
		expect(closes).toBe(1);
	});
});

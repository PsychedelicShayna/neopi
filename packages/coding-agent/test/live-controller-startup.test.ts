import { afterEach, describe, expect, it, vi } from "bun:test";
import { LiveSessionController } from "../src/live/controller";
import { LivePersonaStore, type LivePersonaState } from "../src/live/personas";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";

afterEach(() => vi.restoreAllMocks());

describe("live startup cancellation", () => {
	for (const [window, pausedRead] of [
		["persona instructions", 1],
		["ingest settings", 2],
	] as const) {
		it(`closes a late transport without connecting after stop completes during ${window} loading`, async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<LivePersonaState>();
			const state: LivePersonaState = { schemaVersion: 1, personas: {} };
			let reads = 0;
			vi.spyOn(LivePersonaStore.prototype, "read").mockImplementation(async () => {
				if (++reads === pausedRead) {
					entered.resolve();
					return release.promise;
				}
				return state;
			});
			const connect = vi.fn(async () => {});
			const close = vi.fn(async () => {});
			const recorder = vi.fn(() => ({ stop() {} }));
			const terminal = vi.fn();
			const controller = new LiveSessionController({
				session: {
					messages: [],
					modelRegistry: { authStorage: {} },
					settings: Settings.isolated(),
					sessionId: "startup-cancellation-test",
					sessionManager: { getCwd: () => process.cwd() },
					subscribe: () => () => {},
				} as unknown as AgentSession,
				callbacks: { onPhase() {}, onLevels() {}, onTranscript() {}, onTerminal: terminal },
				extractAssistantText: () => "",
				createRecorder: recorder,
				createTransport: () => ({
					connect,
					close,
					async send() {},
					async setMuted() {},
					pushAudio: () => true,
				}),
			});
			const starting = controller.start();
			const rejected = starting.catch((error: unknown) => error);
			try {
				await entered.promise;
				await controller.stop();
				expect(terminal).toHaveBeenCalledTimes(1);
				expect(connect).not.toHaveBeenCalled();
				expect(close).not.toHaveBeenCalled();
				release.resolve(state);
				const error = await rejected;
				expect(error).toBeInstanceOf(Error);
				expect(String(error)).toContain("stopped");
				expect(connect).not.toHaveBeenCalled();
				expect(close).toHaveBeenCalledTimes(1);
				expect(recorder).not.toHaveBeenCalled();
				await controller.stop();
				expect(close).toHaveBeenCalledTimes(1);
				expect(terminal).toHaveBeenCalledTimes(1);
			} finally {
				release.resolve(state);
				await rejected;
				await controller.stop();
			}
		});
	}
});

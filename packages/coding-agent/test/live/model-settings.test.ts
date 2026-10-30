import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import * as attestation from "../../src/live/attestation";
import { LiveSessionController, type LiveSessionControllerOptions } from "../../src/live/controller";
import { buildLiveSessionPayload } from "../../src/live/protocol";
import { cfgLiveModel, cfgLiveVoice } from "../../src/live/settings";
import { LIVE_VOICE_VALUES } from "../../src/live/voices";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let root: string | undefined;
let state: SettingsTestState | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	restoreSettingsTestState(state);
	state = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

it("round-trips live.model through config YAML and builds the configured session", async () => {
	state = beginSettingsTest();
	const cacheDir = path.join(process.env.HOME!, ".cache/npi-canary");
	await fs.mkdir(cacheDir, { recursive: true });
	root = await fs.mkdtemp(path.join(cacheDir, "live-model-test-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd);
	await Bun.write(path.join(agentDir, "config.yml"), "setupVersion: 999999\n");
	const settings = await Settings.init({ cwd, agentDir });
	expect(cfgLiveModel.get(settings)).toBe("gpt-live-1-codex");
	expect(cfgLiveVoice.get(settings)).toBe("sol");
	cfgLiveModel.set(settings, "custom-live-model");
	await settings.flush();
	const loaded = await Settings.loadReadOnly({ cwd, agentDir });
	expect(cfgLiveModel.get(loaded)).toBe("custom-live-model");
	expect(buildLiveSessionPayload("", "sol", cfgLiveModel.get(loaded)).model).toBe("custom-live-model");
	for (const voice of LIVE_VOICE_VALUES) {
		cfgLiveVoice.set(settings, voice);
		await settings.flush();
		const voiceSettings = await Settings.loadReadOnly({ cwd, agentDir });
		expect(cfgLiveVoice.get(voiceSettings)).toBe(voice);
		expect(buildLiveSessionPayload("", cfgLiveVoice.get(voiceSettings), cfgLiveModel.get(voiceSettings))).toMatchObject({
			model: "custom-live-model",
			audio: { output: { voice } },
		});
	}
});

it("sends a non-default live.model through the real controller and transport signaling payload", async () => {
	state = beginSettingsTest();
	const settings = Settings.isolated({ "live.model": "configured-live-model-wire", "live.voice": "sol" });
	const authStorage = createInMemoryAuthStorage();
	vi.spyOn(authStorage.oauth, "access").mockResolvedValue({
		accessToken: "offline-test-token",
		accountId: "offline-test-account",
	});
	vi.spyOn(attestation, "generateCodexAttestation").mockResolvedValue(undefined);
	let signaling: unknown;
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				expect(String(input)).toContain("/codex/realtime/calls");
				if (typeof init?.body !== "string") throw new Error("Expected JSON signaling body");
				signaling = JSON.parse(init.body);
				return new Response("offline signaling fixture", { status: 418 });
			},
			{
				preconnect: () => {
					throw new Error("Signaling fixture must not preconnect to the network");
				},
			},
		),
	);
	const controller = new LiveSessionController({
		session: {
			settings,
			modelRegistry: { authStorage },
			sessionId: "configured-live-model-wire",
			messages: [],
			sessionManager: { getCwd: () => process.cwd() },
		} as unknown as LiveSessionControllerOptions["session"],
		extractAssistantText: () => "",
		model: cfgLiveModel.get(settings),
		voice: cfgLiveVoice.get(settings),
		sdpOffer: "v=0 offline caller offer",
		createRecorder: () => {
			throw new Error("Caller-owned media must not open a recorder");
		},
		callbacks: {
			onPhase: () => {},
			onLevels: () => {},
			onTranscript: () => {},
			onTerminal: () => {},
		},
	});
	try {
		await expect(controller.start()).rejects.toThrow("offline signaling fixture");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(signaling).toMatchObject({
			sdp: "v=0 offline caller offer",
			session: { model: "configured-live-model-wire", audio: { output: { voice: "sol" } } },
		});
	} finally {
		try {
			await controller.stop();
		} finally {
			authStorage.close();
		}
	}
});

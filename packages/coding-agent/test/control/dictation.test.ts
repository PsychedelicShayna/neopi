/**
 * Dictation over the control socket: a terminal-owned session records with its own microphone for the
 * connection that asks, draft-only, one capture at a time, never on top of the terminal's own speech-to-text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import "../../src/modes/rpc/rpc-mode";
import { Settings } from "../../src/config/settings";
import { ControlClient } from "../../src/control/client";
import { ControlHost } from "../../src/control/host";
import type { ControlPresenter } from "../../src/control/presenter";
import type { RpcDictationController } from "../../src/modes/rpc/rpc-dictation";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import type { SttCallbacks, SttState, SttTarget } from "../../src/stt";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

class FakeController implements RpcDictationController {
	state: SttState = "idle";
	target!: SttTarget;
	callbacks!: SttCallbacks;
	disposed = false;

	async start(target: SttTarget, callbacks: SttCallbacks): Promise<void> {
		this.target = target;
		this.callbacks = callbacks;
		this.state = "recording";
		callbacks.onStateChange("recording");
	}

	async stop(): Promise<void> {
		if (this.state !== "recording") return;
		this.state = "transcribing";
		this.callbacks.onStateChange("transcribing");
		this.state = "idle";
		this.callbacks.onStateChange("idle");
	}

	dispose(): void {
		this.disposed = true;
		this.state = "idle";
	}
}

function presenter(busy: () => boolean): ControlPresenter {
	return {
		submit: async () => ({ delivery: "started" }),
		action: async () => ({ handled: true }),
		inject: () => {},
		esc: async () => ({ handled: true }),
		screen: () => ({ lines: [] }),
		dialogs: () => [],
		answerDialog: async () => ({ settled: false }),
		draft: () => ({ text: "", images: [] }),
		setDraft: () => {},
		insertDraft: () => {},
		rewind: async () => ({ status: "rewound" }),
		notify: () => {},
		dictationBusy: busy,
		draftRevision: () => 0,
		focusRevision: () => 0,
		dialogRevision: () => 0,
	};
}

describe("control dictation", () => {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const cleanup: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const fn of cleanup.splice(0).reverse()) await fn();
	});

	async function setup(options: { tui?: boolean; stt?: boolean; terminalBusy?: () => boolean } = {}) {
		const model = createMockModel({ provider: "anthropic", responses: [] });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: [], tools: [] },
				streamFn: model.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"stt.enabled": options.stt ?? true,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		const controllers: FakeController[] = [];
		const host = new ControlHost({
			session,
			role: options.tui === false ? "rpc" : "tui",
			dir: mkdtempSync(join(tmpdir(), "omp-ctl-dict-")),
			tmuxPane: null,
			createDictationController: () => {
				const controller = new FakeController();
				controllers.push(controller);
				return controller;
			},
		});
		if (options.tui !== false) host.presenter = presenter(options.terminalBusy ?? (() => false));
		await host.start();
		cleanup.push(async () => {
			await host.close();
			await session.dispose();
		});
		const connect = async (label: string) => {
			const frames: Record<string, unknown>[] = [];
			const client = new ControlClient({
				metadata: host.publication!.metadata(),
				label,
				kind: "cli",
				onFrame: frame => void frames.push(frame),
			});
			const hello = await client.connect();
			cleanup.push(() => client.close());
			return { client, frames, hello };
		};
		return { host, session, controllers, connect };
	}

	const dictationFrames = (frames: Record<string, unknown>[]) =>
		frames.filter(frame => typeof frame.type === "string" && frame.type.startsWith("dictation_"));

	test("a terminal session advertises dictation and reports whether speech-to-text is enabled; a headless one does not", async () => {
		const tui = await setup();
		const { frames, hello } = await tui.connect("a");
		expect(frames.find(frame => frame.type === "ready")?.capabilities).toContain("dictation");
		expect(hello.session?.dictationEnabled).toBe(true);
		const off = await setup({ stt: false });
		expect((await off.connect("b")).hello.session?.dictationEnabled).toBe(false);
		const headless = await setup({ tui: false });
		const { frames: headlessFrames } = await headless.connect("c");
		expect(headlessFrames.find(frame => frame.type === "ready")?.capabilities).not.toContain("dictation");
	});

	test("records for the asking connection only: state, preview and end frames, and a draft-only result", async () => {
		const { host, controllers, connect } = await setup();
		const owner = await connect("owner");
		const observer = await connect("observer");
		const started = await owner.client.request({ type: "dictation_start", captureId: "cap-1" });
		expect(started.success).toBe(true);
		expect(host.dictationActive).toBe(true);
		controllers[0].target.commitVolatileText("hello world");
		const stopped = await owner.client.request({ type: "dictation_stop" });
		expect(stopped).toMatchObject({ success: true, data: { text: "hello world" } });
		expect(host.dictationActive).toBe(false);
		await Bun.sleep(20);
		expect(dictationFrames(owner.frames)).toEqual([
			{ type: "dictation_state", captureId: "cap-1", state: "starting" },
			{ type: "dictation_state", captureId: "cap-1", state: "recording" },
			{ type: "dictation_transcript", captureId: "cap-1", text: "hello world" },
			{ type: "dictation_state", captureId: "cap-1", state: "transcribing" },
			{ type: "dictation_end", captureId: "cap-1", text: "hello world" },
		]);
		expect(dictationFrames(observer.frames)).toEqual([]);
		expect(controllers[0].disposed).toBe(true);
	});

	test("refuses while speech-to-text is disabled, the terminal is recording, or another capture is active", async () => {
		let terminalBusy = false;
		const { host, connect } = await setup({ terminalBusy: () => terminalBusy });
		const first = await connect("first");
		const second = await connect("second");
		terminalBusy = true;
		expect(await first.client.request({ type: "dictation_start", captureId: "t" })).toMatchObject({
			success: false,
			error: "The terminal's own dictation is active",
		});
		expect(host.dictationActive).toBe(false);
		terminalBusy = false;
		expect((await first.client.request({ type: "dictation_start", captureId: "a" })).success).toBe(true);
		expect(await second.client.request({ type: "dictation_start", captureId: "b" })).toMatchObject({
			success: false,
			error: "Dictation is already active on another control connection",
		});
		expect(await first.client.request({ type: "dictation_start", captureId: "c" })).toMatchObject({
			success: false,
			error: "A dictation capture is already active",
		});
		// Only the owner can stop it; another connection stopping gets an empty result and leaves it running.
		expect(await second.client.request({ type: "dictation_stop" })).toMatchObject({
			success: true,
			data: { text: "" },
		});
		expect(host.dictationActive).toBe(true);
		await first.client.request({ type: "dictation_stop" });

		const off = await setup({ stt: false });
		expect(
			await (await off.connect("off")).client.request({ type: "dictation_start", captureId: "x" }),
		).toMatchObject({
			success: false,
			error: expect.stringContaining("stt.enabled"),
		});
	});

	test("a headless control session answers that dictation is unavailable", async () => {
		const { connect } = await setup({ tui: false });
		const { client } = await connect("h");
		expect(await client.request({ type: "dictation_start", captureId: "x" })).toMatchObject({
			success: false,
			error: "Dictation is unavailable on this transport",
		});
	});

	test("closing the controlling connection ends the capture and frees the microphone", async () => {
		const { host, controllers, connect } = await setup();
		const owner = await connect("owner");
		expect((await owner.client.request({ type: "dictation_start", captureId: "gone" })).success).toBe(true);
		owner.client.close();
		const deadline = Date.now() + 2000;
		while (host.dictationActive && Date.now() < deadline) await Bun.sleep(10);
		expect(host.dictationActive).toBe(false);
		expect(controllers[0].disposed).toBe(true);
		const next = await connect("next");
		expect((await next.client.request({ type: "dictation_start", captureId: "again" })).success).toBe(true);
	});
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { runWithDetachedDraft } from "@oh-my-pi/pi-tui/draft-scope";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import * as chainConfig from "../src/chains/config";
import * as chainRunner from "../src/chains/runner";
import { cfgChainingActive } from "../src/chains/settings";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings, settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import type { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import * as capture from "../src/stt/shared-audio-capture";
import { cfgSttSubmitTrigger } from "../src/stt/settings";
import * as xai from "../src/stt/xai-stt";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("xAI main-composer destination ownership", () => {
	let saved: SettingsTestState;
	let directory: string;
	let auth: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let audio: capture.AudioSink[];

	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(async () => {
		saved = beginSettingsTest();
		const root = os.tmpdir();
		await fs.mkdir(root, { recursive: true });
		directory = await fs.mkdtemp(path.join(root, "stt-destination-"));
		setAgentDir(directory);
		await Settings.init({ inMemory: true, cwd: directory });
		cfgSttSubmitTrigger.set(settings, "never");
		cfgChainingActive.set(settings, "rewrite");
		auth = createInMemoryAuthStorage();
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5")!;
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
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue(undefined);
		mode.setEditorComponent(undefined);
		mode.editor.disableSubmit = false;
		audio = [];
		vi.spyOn(capture, "sharedAudioCapture").mockImplementation((_rate, callback) => {
			audio.push(callback);
			return { stop() {} };
		});
		vi.spyOn(xai, "transcribeXaiAudio").mockResolvedValue("NEW SPEECH");
	});
	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		auth?.close();
		vi.restoreAllMocks();
		restoreSettingsTestState(saved);
		await fs.rm(directory, { recursive: true, force: true });
	});

	it("retains speech as the next draft after the chain sends only its original rewrite", async () => {
		const started = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<string>();
		const sent = Promise.withResolvers<void>();
		vi.spyOn(chainConfig, "discoverChains").mockResolvedValue({
			chains: [{ name: "rewrite", steps: [{ name: "rewrite", prompt: "rewrite", enabled: true }] }],
			warnings: [],
		});
		vi.spyOn(chainRunner, "runChain").mockImplementation(async () => {
			started.resolve();
			return await finished.promise;
		});
		const prompt = vi.spyOn(session, "prompt").mockImplementation(async () => {
			sent.resolve();
			return true;
		});
		mode.editor.setText("Original draft");
		mode.editor.handleInput("\x1b\x03");
		await started.promise;
		await mode.handleSTTToggle();
		audio[0]!(null, new Float32Array([0.5]));
		await mode.handleSTTToggle();
		expect(mode.editor.chainLocked).toBe(true);
		expect(mode.editor.getText()).toBe("Original draft");
		finished.resolve("Rewritten original");
		await sent.promise;
		await Promise.resolve();
		expect(prompt.mock.calls[0]![0]).toBe("Rewritten original");
		expect(mode.editor.getText()).toBe("NEW SPEECH");
	});

	it.each(["success", "skip", "abort", "error"] as const)(
		"keeps multiple late transcripts separate from the chain's %s terminal draft",
		async outcome => {
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const completed = Promise.withResolvers<void>();
			const step = { name: "rewrite", prompt: "rewrite", enabled: true };
			vi.spyOn(chainConfig, "discoverChains").mockResolvedValue({
				chains: [{ name: "rewrite", steps: [step] }],
				warnings: [],
			});
			vi.spyOn(chainRunner, "runChain").mockImplementation(async (_chain, original, options) => {
				const signal = options.control!.beginStep();
				options.onStep?.(step, 0, 1);
				started.resolve();
				await finish.promise;
				if (outcome === "abort" || outcome === "error") throw new Error("chain stopped");
				if (outcome === "skip") {
					expect(signal.aborted).toBe(true);
					options.onStepSkipped?.(step, 0);
					return original;
				}
				options.onStepDone?.(step, 0, "Rewritten original");
				return "Rewritten original";
			});
			const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
			const submit = mode.editor.onSubmit!;
			mode.editor.onSubmit = async text => {
				try {
					await submit(text);
				} finally {
					completed.resolve();
				}
			};
			mode.editor.setText("Original draft");
			mode.editor.handleInput("\x1b\x03");
			await started.promise;
			expect(
				mode.progressHudContainer
					.render(100)
					.map(line => Bun.stripANSI(line))
					.join(" "),
			).toContain('Chain rewrite · step 1/1 "rewrite"');
			for (const words of ["FIRST", "SECOND"]) {
				vi.spyOn(xai, "transcribeXaiAudio").mockResolvedValue(words);
				await mode.handleSTTToggle();
				audio.at(-1)!(null, new Float32Array([0.5]));
				await mode.handleSTTToggle();
			}
			expect(mode.editor.getText()).toBe("Original draft");
			if (outcome === "abort") mode.editor.handleInput("\x03");
			if (outcome === "skip") {
				mode.editor.handleInput("\x1b\x13");
				mode.editor.handleInput("\x1b\x13");
			}
			finish.resolve();
			await completed.promise;
			expect(mode.editor.chainLocked).toBe(false);
			expect(mode.progressHudContainer.render(100)).toHaveLength(0);
			if (outcome === "error") {
				expect(mode.showWarning).toHaveBeenCalledWith(expect.stringContaining('failed at step "rewrite"'));
			}
			expect(mode.editor.getText()).toBe("FIRSTSECOND");
			if (outcome === "abort" || outcome === "error") {
				expect(prompt).not.toHaveBeenCalled();
				mode.editor.clearDraft();
				mode.editor.handleInput("\x1b[A");
				expect(mode.editor.getText()).toBe("Original draft");
			} else {
				expect(prompt.mock.calls[0]![0]).toBe(outcome === "skip" ? "Original draft" : "Rewritten original");
			}
		},
	);

	it.each(["send", "cancel"] as const)("installs speech after the chain picker chooses %s", async choice => {
		const opened = Promise.withResolvers<void>();
		const picked = Promise.withResolvers<string | undefined>();
		const completed = Promise.withResolvers<void>();
		cfgChainingActive.set(settings, "");
		vi.spyOn(chainConfig, "discoverChains").mockResolvedValue({
			chains: [{ name: "rewrite", steps: [{ name: "rewrite", prompt: "rewrite", enabled: true }] }],
			warnings: [],
		});
		vi.spyOn(mode, "showHookSelector").mockImplementation(async () => {
			opened.resolve();
			return await picked.promise;
		});
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
		const submit = mode.editor.onSubmit!;
		mode.editor.onSubmit = async text => {
			try {
				await submit(text);
			} finally {
				completed.resolve();
			}
		};
		mode.editor.setText("Original draft");
		mode.editor.handleInput("\x1b\x03");
		await opened.promise;
		await mode.handleSTTToggle();
		audio[0]!(null, new Float32Array([0.5]));
		await mode.handleSTTToggle();
		picked.resolve(choice === "send" ? "Send without a chain" : undefined);
		await completed.promise;
		expect(mode.editor.getText()).toBe("NEW SPEECH");
		if (choice === "send") expect(prompt.mock.calls[0]![0]).toBe("Original draft");
		else expect(prompt).not.toHaveBeenCalled();
	});

	it("defers speech submit intent until the original chain has dispatched", async () => {
		cfgSttSubmitTrigger.set(settings, "release");
		const started = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<string>();
		const speechSent = Promise.withResolvers<void>();
		vi.spyOn(chainConfig, "discoverChains").mockResolvedValue({
			chains: [{ name: "rewrite", steps: [{ name: "rewrite", prompt: "rewrite", enabled: true }] }],
			warnings: [],
		});
		vi.spyOn(chainRunner, "runChain").mockImplementation(async () => {
			started.resolve();
			return await finished.promise;
		});
		const prompt = vi.spyOn(session, "prompt").mockImplementation(async text => {
			if (text === "NEW SPEECH") speechSent.resolve();
			return true;
		});
		mode.editor.setText("Original draft");
		mode.editor.handleInput("\x1b\x03");
		await started.promise;
		await mode.handleSTTToggle();
		audio[0]!(null, new Float32Array([0.5]));
		await mode.handleSTTToggle();
		expect(prompt).not.toHaveBeenCalled();
		finished.resolve("Rewritten original");
		await speechSent.promise;
		expect(prompt.mock.calls.map(call => call[0])).toEqual(["Rewritten original", "NEW SPEECH"]);
	});

	it.each([false, true])("preserves next speech when chain dispatch rejects with streaming=%s", async streaming => {
		const started = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<string>();
		const dispatched = Promise.withResolvers<void>();
		const rejected = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		session.agent.state.isStreaming = streaming;
		vi.spyOn(chainConfig, "discoverChains").mockResolvedValue({
			chains: [{ name: "rewrite", steps: [{ name: "rewrite", prompt: "rewrite", enabled: true }] }],
			warnings: [],
		});
		vi.spyOn(chainRunner, "runChain").mockImplementation(async () => {
			started.resolve();
			return await finished.promise;
		});
		vi.spyOn(session, "prompt").mockImplementation(async () => {
			dispatched.resolve();
			await rejected.promise;
			throw new Error("dispatch rejected");
		});
		vi.spyOn(mode, "showError").mockImplementation(() => {});
		const submit = mode.editor.onSubmit!;
		mode.editor.onSubmit = async text => {
			try {
				await submit(text);
			} finally {
				completed.resolve();
			}
		};
		mode.editor.setText("Original draft");
		mode.editor.handleInput("\x1b\x03");
		await started.promise;
		await mode.handleSTTToggle();
		audio[0]!(null, new Float32Array([0.5]));
		await mode.handleSTTToggle();
		finished.resolve("Rewritten original");
		await dispatched.promise;
		expect(mode.editor.getText()).toBe("NEW SPEECH");
		expect(mode.editor.chainLocked).toBe(false);
		rejected.resolve();
		await completed.promise;
		expect(mode.editor.getText()).toBe("NEW SPEECH");
		mode.editor.clearDraft();
		mode.editor.handleInput("\x1b[A");
		if (!streaming) {
			expect(mode.editor.getText()).toBe("Original draft");
			mode.editor.handleInput("\x1b[A");
		}
		expect(mode.editor.getText()).toBe("Rewritten original");
	});

	it("delivers speech to the human composer outside inherited deferred draft scope", async () => {
		mode.editor.setText("Human draft: ");
		await runWithDetachedDraft(async () => {
			mode.editor.setText("Deferred control draft");
			await mode.handleSTTToggle();
			audio[0]!(null, new Float32Array([0.5]));
			await mode.handleSTTToggle();
			expect(mode.editor.getText()).toBe("Deferred control draft");
		}, "defer");
		expect(mode.editor.getText()).toBe("Human draft: NEW SPEECH");
	});

	it.each(["recording", "transcribing"] as const)("resolves the replacement composer during %s", async phase => {
		const result = Promise.withResolvers<string>();
		vi.spyOn(xai, "transcribeXaiAudio").mockReturnValue(result.promise);
		mode.editor.setText("Existing draft: ");
		const detached = mode.editor;
		await mode.handleSTTToggle();
		audio[0]!(null, new Float32Array([0.5]));
		const stopped = phase === "transcribing" ? mode.handleSTTToggle() : undefined;
		mode.setEditorComponent(undefined);
		const replacement = mode.editor;
		expect(detached.cursorOverride).toBeUndefined();
		expect(replacement.cursorOverride).toBeDefined();
		result.resolve("NEW SPEECH");
		await (stopped ?? mode.handleSTTToggle());
		expect(replacement.getText()).toBe("Existing draft: NEW SPEECH");
		expect(detached.getText()).toBe("Existing draft: ");
		expect(replacement.cursorOverride).toBeUndefined();
	});
});

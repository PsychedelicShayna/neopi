import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionLiveStartOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type LiveSessionCallbacks,
	LiveSessionController,
	type LiveSessionControllerOptions,
} from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme";
import {
	cfgLiveBlockDelegateKeyword,
	cfgLiveModel,
	cfgLiveForceDelegateKeyword,
	cfgLiveForceUtteranceKeyword,
	cfgLiveSuppressDelegateKeyword,
	cfgLiveHoldMode,
	cfgLiveQuietFloorMs,
	cfgLiveSubmitKeyword,
	cfgLiveSubmitSilenceMs,
} from "@oh-my-pi/pi-coding-agent/live/settings";
import { Container, type Component } from "@oh-my-pi/pi-tui/tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { __resetDirsFromEnvForTests } from "@oh-my-pi/pi-utils";
import type { LiveClientMessage, LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";

interface Harness {
	ctx: InteractiveModeContext;
	editor: CustomEditor;
	controller: LiveCommandController;
	/** Callbacks the controller handed to the live session. */
	callbacks(): LiveSessionCallbacks;
	voice(): string | undefined;
	delegationKeywords(): { suppress: string; force: string } | undefined;
	projectComposer(excludedTurns: readonly number[]): string | undefined;
	/** Components mounted into or focused away from the composer slot. */
	layoutChanges: unknown[];
	/** Latest status-line live state, `null` when hidden. */
	liveStatus(): unknown;
	/** Composer text handed to the voice model, with its audience. */
	sentToVoice: Array<[string, string]>;
	/** Keyword submissions released for Iris to answer or route. */
	submitted: string[];
	/** Components presented into the transcript. */
	presented: unknown[];
}

function createHarness(factory?: (options: LiveSessionControllerOptions) => LiveSessionController): Harness {
	const editor = new CustomEditor(getEditorTheme());
	const layoutChanges: unknown[] = [];
	let liveStatus: unknown = null;
	const sentToVoice: Array<[string, string]> = [];
	const submitted: string[] = [];
	const presented: unknown[] = [];
	const settings = Settings.isolated({ "live.voice": "vale" });
	const chatContainer = new TranscriptContainer();
	const liveTranscriptContainer = new Container();
	const primarySession = {
		isStreaming: false,
		settings,
		messages: [],
		subscribe: () => () => {},
	};
	const ctx = {
		settings,
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		session: primarySession,
		viewSession: {},
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
		assistantImagesVisible: false,
		hideToolActivity: false,
		toolOutputExpanded: false,
		extractAssistantText: vi.fn(() => ""),
		editor,
		editorContainer: {
			clear: vi.fn(() => layoutChanges.push("clear")),
			addChild: vi.fn((component: unknown) => layoutChanges.push(component)),
		},
		ui: {
			setFocus: vi.fn((component: unknown) => layoutChanges.push(component)),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		showError: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		chatContainer,
		liveTranscriptContainer,
		present: vi.fn((component: Component) => {
			presented.push(component);
			chatContainer.addChild(component);
		}),
		presentCommandOutput: vi.fn((component: Component) => {
			if (!primarySession.isStreaming) {
				presented.push(component);
				chatContainer.addChild(component);
			}
		}),
		statusLine: {
			setLiveStatus: vi.fn((status: unknown) => {
				liveStatus = status;
			}),
		},
	} as unknown as InteractiveModeContext;
	let options: LiveSessionControllerOptions | undefined;
	const controller = new LiveCommandController(ctx, created => {
		options = created;
		if (factory) return factory(created);
		const session = new LiveSessionController(created);
		vi.spyOn(session, "start").mockResolvedValue();
		vi.spyOn(session, "stop");
		vi.spyOn(session, "sendOperatorText").mockImplementation(async (text, audience) => {
			sentToVoice.push([text, audience]);
			return true;
		});
		vi.spyOn(session, "submitComposer").mockImplementation(text => {
			submitted.push(text);
			created.callbacks.onSpeechSent?.(text);
			return true;
		});
		return session;
	});
	editor.onChange = () => controller.noteComposerActivity();
	return {
		ctx,
		editor,
		controller,
		callbacks: () => {
			if (!options) throw new Error("live session was not created");
			return options.callbacks;
		},
		voice: () => options?.voice,
		delegationKeywords: () => options?.delegationKeywords?.(),
		projectComposer: turns => options?.captureComposerExcludingTurns?.(turns).text,
		layoutChanges,
		liveStatus: () => liveStatus,
		sentToVoice,
		submitted,
		presented,
	};
}
/** Exercise composer capture through real live routing and primary acceptance. */
function createHandoffHarness(acceptance?: Promise<void>, voiceDelivery?: Promise<void>) {
	const prompts: string[] = [];
	const sent: LiveClientMessage[] = [];
	let fire: ((event: LiveServerEvent) => void) | undefined;
	const h = createHarness(options => new LiveSessionController({
		...options,
		createTransport: transportOptions => {
			fire = transportOptions.callbacks.onEvent;
			return {
				async connect() {},
				async send(message: LiveClientMessage) { sent.push(message); await voiceDelivery; },
				async close() {},
				async setMuted() {},
				setOutputSuppressed() {},
				pushAudio: () => true,
			};
		},
		createRecorder: () => ({ stop() {} }),
	}));
	Object.assign(h.ctx.session, {
		sessionId: "composer-attachment-handoff",
		modelRegistry: { authStorage: {} },
		sessionManager: { getCwd: () => process.cwd(), allocateArtifactPath: async () => ({}) },
		agent: { peekFollowUpQueue: () => [] },
		sendCustomMessageWithReceipt(message: { content: string }) {
			prompts.push(message.content);
			return { accepted: acceptance ?? Promise.resolve(), completed: Promise.resolve(true), cancel: () => false };
		},
	});
	cfgLiveForceDelegateKeyword.set(h.ctx.settings, "send it now");
	cfgLiveSubmitKeyword.set(h.ctx.settings, "thanks");
	cfgLiveBlockDelegateKeyword.set(h.ctx.settings, "do not relate");
	cfgLiveForceUtteranceKeyword.set(h.ctx.settings, "relay");
	cfgLiveSubmitSilenceMs.set(h.ctx.settings, 5);
	return {
		...h, prompts, sent,
		speech: (text: string) => fire?.({ type: "turn.done", turn: { role: "user", transcript: text } }),
		delegate: () => fire?.({
			type: "delegation.created",
			item: { type: "delegation", target: "client", id: crypto.randomUUID(), content: [] },
		}),
		answer: () => {
			fire?.({ type: "output_transcript.added", item: { text: "Answered" } });
			fire?.({ type: "turn.done", turn: { role: "assistant", transcript: "Answered" } });
		},
	};
}


function speak(h: Harness, turn: number, text: string, final: boolean): void {
	h.callbacks().onUserSpeech?.({ role: "user", turn, text, final });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("routes the complete edited composer once after three spoken keyword fragments", async () => {
		const prompts: string[] = [];
		const sent: LiveClientMessage[] = [];
		let fire: ((event: LiveServerEvent) => void) | undefined;
		const h = createHarness(options => new LiveSessionController({
			...options,
			createTransport: transportOptions => {
				fire = transportOptions.callbacks.onEvent;
				return {
					async connect() {},
					async send(message: LiveClientMessage) { sent.push(message); },
					async close() {},
					async setMuted() {},
					setOutputSuppressed() {},
					pushAudio: () => true,
				};
			},
			createRecorder: () => ({ stop() {} }),
		}));
		cfgLiveHoldMode.set(h.ctx.settings, true);
		cfgLiveSubmitKeyword.set(h.ctx.settings, "over");
		cfgLiveSubmitSilenceMs.set(h.ctx.settings, 50);
		Object.assign(h.ctx.session, {
			sessionId: "three-keyword-fragments",
			modelRegistry: { authStorage: {} },
			sessionManager: { getCwd: () => process.cwd(), allocateArtifactPath: async () => ({}) },
			agent: { peekFollowUpQueue: () => [] },
			sendCustomMessageWithReceipt(message: { content: string }) {
				prompts.push(message.content);
				return { accepted: Promise.resolve(), completed: Promise.resolve(true), cancel: () => false };
			},
		});
		await h.controller.handleCommand();
		try {
			const route = (id: string): LiveServerEvent => ({
				type: "delegation.created", item: { type: "delegation", target: "client", id, content: [] },
			});
			fire?.({ type: "turn.done", turn: { role: "user", transcript: "first part over" } });
			fire?.(route("premature-first"));
			fire?.({ type: "turn.done", turn: { role: "user", transcript: "second part over" } });
			fire?.(route("premature-second"));
			fire?.({ type: "input_transcript.added", item: { text: "third part over" } });
			await Bun.sleep(80);
			expect(prompts).toEqual([]);
			h.editor.insertText(" with a typed correction");
			fire?.({ type: "turn.done", turn: { role: "user", transcript: "third part over and the rest over" } });
			await Bun.sleep(80);
			expect(prompts).toEqual([]);
			const submitted = sent.filter(message => message.type === "session.context.append")
				.flatMap(message => message.content.map(item => item.text)).join("\n");
			expect(submitted).toContain("first part over");
			expect(submitted).toContain("second part over");
			expect(submitted).toContain("typed correction");
			expect(submitted).toContain("and the rest");
			fire?.(route("one-final-route"));
			for (let index = 0; index < 80; index++) await Promise.resolve();
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toContain("first part over");
			expect(prompts[0]).toContain("second part over");
			expect(prompts[0]).toContain("third part");
			expect(prompts[0]).toContain("typed correction");
			expect(prompts[0]).toContain("and the rest");
			expect(h.editor.getText().trim()).toBe("");
		} finally {
			await h.controller.stop();
		}
	});

	for (const mode of ["edited address", "typed request"] as const) {
		it(`submits an authoritative ${mode} even without an ordinary speech-ledger turn`, async () => {
			const prompts: string[] = [];
			const sent: LiveClientMessage[] = [];
			let live: LiveSessionController | undefined;
			let fire: ((event: LiveServerEvent) => void) | undefined;
			const h = createHarness(options => {
				live = new LiveSessionController({
					...options,
					createTransport: transportOptions => {
						fire = transportOptions.callbacks.onEvent;
						return {
							async connect() {},
							async send(message: LiveClientMessage) {
								sent.push(message);
							},
							async close() {},
							async setMuted() {},
							setOutputSuppressed() {},
							pushAudio: () => true,
						};
					},
					createRecorder: () => ({ stop() {} }),
				});
				return live;
			});
			cfgLiveHoldMode.set(h.ctx.settings, true);
			Object.assign(h.ctx.session, {
				sessionId: `authoritative-composer-${mode}`,
				modelRegistry: { authStorage: {} },
				sessionManager: { getCwd: () => process.cwd(), allocateArtifactPath: async () => ({}) },
				agent: { peekFollowUpQueue: () => [] },
				sendCustomMessageWithReceipt(message: { content: string }) {
					prompts.push(message.content);
					return { accepted: Promise.resolve(), completed: Promise.resolve(true), cancel: () => false };
				},
			});
			await h.controller.handleCommand();
			try {
				const original = mode === "edited address" ? "Iris, fix the parser" : "Iris, tell me a joke";
				fire?.({ type: "turn.done", turn: { role: "user", transcript: original } });
				h.editor.setText(mode === "edited address" ? "fix the parser" : `${h.editor.getText()}\n\nfix the parser`);
				expect(live?.forceDelegateComposer(h.editor.getText())).toBe(true);
				for (let i = 0; i < 80; i++) await Promise.resolve();
				expect(prompts).toEqual(["fix the parser"]);
				expect(h.editor.getText().trim()).toBe("");
				if (mode === "edited address") {
					expect(
						sent
							.filter(message => "content" in message)
							.flatMap(message => message.content.map(item => item.text))
							.join("\n"),
					).not.toContain(original);
				}
				expect(live?.pendingUserTurnCount()).toBe(0);
			} finally {
				await h.controller.stop();
			}
		});
	}

	it("forwards configurable per-utterance keywords without restarting the call", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		try {
			expect(h.delegationKeywords()).toEqual({ suppress: "Iris", force: "relay" });
			cfgLiveSuppressDelegateKeyword.set(h.ctx.settings, "Nova");
			cfgLiveForceUtteranceKeyword.set(h.ctx.settings, "pass along");
			expect(h.delegationKeywords()).toEqual({ suppress: "Nova", force: "pass along" });
			cfgLiveSuppressDelegateKeyword.set(h.ctx.settings, "");
			cfgLiveForceUtteranceKeyword.set(h.ctx.settings, "");
			expect(h.delegationKeywords()).toEqual({ suppress: "", force: "" });
		} finally {
			await h.controller.stop();
		}
	});

	it("retires accepted edited dictation while a blocked voice delivery is still pending", async () => {
		const voiceSend = Promise.withResolvers<void>();
		const prompts: string[] = [];
		let live: LiveSessionController | undefined;
		let fire: ((event: { type: "turn.done"; turn: { role: "user"; transcript: string } }) => void) | undefined;
		const h = createHarness(options => {
			live = new LiveSessionController({
				...options,
				createTransport: transportOptions => {
					fire = transportOptions.callbacks.onEvent;
					return {
						async connect() {},
						async send() {
							await voiceSend.promise;
						},
						async close() {},
						async setMuted() {},
						setOutputSuppressed() {},
						pushAudio: () => true,
					};
				},
				createRecorder: () => ({ stop() {} }),
			});
			return live;
		});
		cfgLiveHoldMode.set(h.ctx.settings, true);
		cfgLiveBlockDelegateKeyword.set(h.ctx.settings, "iris only");
		Object.assign(h.ctx.session, {
			sessionId: "accepted-edited-composer",
			modelRegistry: { authStorage: {} },
			sessionManager: { getCwd: () => process.cwd(), allocateArtifactPath: async () => ({}) },
			agent: { peekFollowUpQueue: () => [] },
			sendCustomMessageWithReceipt(message: { content: string }) {
				prompts.push(message.content);
				return { accepted: Promise.resolve(), completed: Promise.resolve(true), cancel: () => false };
			},
		});
		await h.controller.handleCommand();
		try {
			fire?.({ type: "turn.done", turn: { role: "user", transcript: "fix the cache" } });
			h.editor.setText("fix the parser");
			fire?.({ type: "turn.done", turn: { role: "user", transcript: "tell me a joke iris only" } });
			expect(live?.forceDelegateComposer(h.editor.getText())).toBe(true);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(prompts).toEqual(["fix the parser"]);
			voiceSend.resolve();
			for (let i = 0; i < 40; i++) await Promise.resolve();
			expect(h.editor.getText().trim()).toBe("");
			fire?.({ type: "turn.done", turn: { role: "user", transcript: "and include tests" } });
			expect(live?.forceDelegateComposer(h.editor.getText())).toBe(true);
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(prompts).toEqual(["fix the parser", "and include tests"]);
		} finally {
			voiceSend.resolve();
			await h.controller.stop();
		}
	});
	it("projects a mixed held draft without blocked speech while preserving typed context and the original editor", async () => {
		const h = createHarness();
		cfgLiveSubmitKeyword.set(h.ctx.settings, "thanks");
		await h.controller.handleCommand();
		try {
			h.editor.insertText("typed context:");
			speak(h, 1, "fix the cache", true);
			speak(h, 2, "tell me a joke thanks", true);
			const before = h.editor.getText();
			expect(h.projectComposer([2])?.trim()).toBe("typed context: fix the cache");
			expect(h.editor.getText()).toBe(before);
		} finally {
			await h.controller.stop();
		}
	});
	it("releases a hold-mode submit to Iris after both silence and quiet floor regardless of destination", async () => {
		const h = createHarness();
		const forced = vi.spyOn(LiveSessionController.prototype, "forceDelegateComposer").mockReturnValue(true);
		cfgLiveHoldMode.set(h.ctx.settings, true);
		cfgLiveSubmitKeyword.set(h.ctx.settings, "thanks");
		cfgLiveSubmitSilenceMs.set(h.ctx.settings, 10);
		cfgLiveQuietFloorMs.set(h.ctx.settings, 60);
		await h.controller.handleCommand();
		try {
			h.controller.cycleDestination();
			speak(h, 1, "fix the cache. THANKS!", true);
			await Bun.sleep(25);
			expect(forced).not.toHaveBeenCalled();
			expect(h.submitted).toEqual([]);
			await Bun.sleep(55);
			expect(forced).not.toHaveBeenCalled();
			expect(h.submitted).toEqual(["fix the cache."]);
			expect(h.sentToVoice).toEqual([]);
		} finally {
			await h.controller.stop();
		}
	});

	it("validates quiet floor durations independently of keyword silence", () => {
		const h = createHarness();
		expect(() => cfgLiveQuietFloorMs.set(h.ctx.settings, -1)).toThrow("must not be negative");
		expect(cfgLiveQuietFloorMs.get(h.ctx.settings)).toBe(0);
	});
	it("forwards the selected voice across the live-session boundary", async () => {
		const h = createHarness();
		try {
			await h.controller.handleCommand();
			expect(h.voice()).toBe("vale");
		} finally {
			await h.controller.stop();
		}
	});

	it("forwards the configured model through the controller to the transport", async () => {
		let model: string | undefined;
		const h = createHarness(
			options =>
				new LiveSessionController({
					...options,
					session: {
						...options.session,
						modelRegistry: { authStorage: {} },
						sessionId: "configured-live-model",
						sessionManager: { getCwd: () => process.cwd() },
					} as unknown as LiveSessionControllerOptions["session"],
					createTransport: options => {
						model = options.model;
						return {
							async connect() {},
							async send() {},
							async close() {},
							async setMuted() {},
							pushAudio: () => true,
						};
					},
					createRecorder: () => ({ stop() {} }),
				}),
		);
		cfgLiveModel.set(h.ctx.settings, "custom-live-model");
		try {
			await h.controller.handleCommand();
			expect(model).toBe("custom-live-model");
			cfgLiveModel.set(h.ctx.settings, "next-live-model");
			expect(model).toBe("custom-live-model");
		} finally {
			await h.controller.stop();
		}
	});

	it("keeps the composer in place and types speech into it, one utterance after another", async () => {
		const h = createHarness();
		h.editor.insertText("context:");
		await h.controller.handleCommand();
		expect(h.layoutChanges).toEqual([]);

		speak(h, 1, "hello wor", false);
		expect(h.editor.getText()).toBe("context: hello wor");
		speak(h, 1, "hello world", true);
		expect(h.editor.getText()).toBe("context: hello world");
		speak(h, 2, "and more", true);
		expect(h.editor.getText()).toBe("context: hello world and more");

		await h.controller.stop();
		for (let i = 0; h.controller.active && i < 20; i++) await Promise.resolve();
		expect(h.controller.active).toBe(false);
		expect(h.layoutChanges).toEqual([]);
	});

	it("never deletes text the operator types while a preview is showing", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		speak(h, 1, "hello wor", false);
		h.editor.insertText("!");
		speak(h, 1, "hello world", false);
		expect(h.editor.getText()).toBe("hello wor!ld");
		speak(h, 1, "hello world", true);
		expect(h.editor.getText()).toBe("hello wor!ld");
		await h.controller.stop();
	});

	it("retires speech a running chain keeps out of the composer", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		const retire = vi.spyOn(LiveSessionController.prototype, "retireComposerSpeech");
		h.editor.setText("draft");
		h.editor.setChainLock({ onEscape: vi.fn(), onClear: vi.fn() });
		speak(h, 1, "fix the parser", true);
		expect(h.editor.getText()).toBe("draft");
		expect(retire).toHaveBeenCalled();
		h.editor.setChainLock(undefined);
		await h.controller.stop();
	});

	it("clears a preview the recognizer withdrew", async () => {
		const h = createHarness();
		h.editor.insertText("note");
		await h.controller.handleCommand();
		speak(h, 1, "uh", false);
		expect(h.editor.getText()).toBe("note uh");
		speak(h, 1, "", true);
		expect(h.editor.getText()).toBe("note");
		await h.controller.stop();
	});

	it("drops the rest of an utterance whose preview the operator cleared", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		speak(h, 1, "hello wor", false);
		h.editor.setText("");
		speak(h, 1, "hello world", true);
		expect(h.editor.getText()).toBe("");
		speak(h, 2, "fresh start", true);
		expect(h.editor.getText()).toBe("fresh start");
		await h.controller.stop();
	});

	it("spaces speech by the characters around the cursor, not the end of the draft", async () => {
		const h = createHarness();
		h.editor.insertText("tail");
		h.editor.handleInput("\x1b[H");
		await h.controller.handleCommand();
		speak(h, 1, "head", true);
		expect(h.editor.getText()).toBe("head tail");
		await h.controller.stop();
	});

	it("clears the entire sent draft and recalls the final corrected speech with Up", async () => {
		const h = createHarness();
		h.editor.insertText("first segment ");
		await h.controller.handleCommand();
		speak(h, 1, "raw preview", true);
		expect(h.editor.getText()).toBe("first segment raw preview");
		h.callbacks().onSpeechSent?.("first segment corrected transcript");
		expect(h.editor.getText()).toBe("");
		h.editor.handleInput("\x1b[A");
		expect(h.editor.getText()).toBe("first segment corrected transcript");
		await h.controller.stop();
	});

	it("keeps newer typed and partial speech when a delayed receipt retires an older utterance", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		speak(h, 1, "older delivered speech", true);
		h.editor.insertText(" new typed draft");
		speak(h, 2, "newer speech", false);
		h.callbacks().onSpeechSent?.("older delivered speech", [1]);
		expect(h.editor.getText().trim()).toBe("new typed draft newer speech");
		speak(h, 2, "newer speech finalized", true);
		expect(h.editor.getText().trim()).toBe("new typed draft newer speech finalized");
		await h.controller.stop();
	});

	it("retires only the older repeated utterance and preserves newer finalized speech", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		speak(h, 1, "repeat this", true);
		speak(h, 2, "repeat this", true);
		h.callbacks().onSpeechSent?.("repeat this", [1]);
		expect(h.editor.getText()).toBe("repeat this");
		h.callbacks().onSpeechSent?.("repeat this", [2]);
		expect(h.editor.getText()).toBe("");
		await h.controller.stop();
	});

	it("keeps an operator rewrite when an older speech receipt arrives", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		speak(h, 1, "original speech", true);
		h.editor.setText("corrected speech and new work");
		h.callbacks().onSpeechSent?.("original speech", [1]);
		expect(h.editor.getText()).toBe("corrected speech and new work");
		await h.controller.stop();
	});

	it("preserves attachments and a newer keyword submit through scoped speech retirement", async () => {
		const h = createHarness();
		cfgLiveSubmitKeyword.set(h.ctx.settings, "send off");
		cfgLiveSubmitSilenceMs.set(h.ctx.settings, 20);
		await h.controller.handleCommand();
		try {
			h.editor.pendingImages = [{ type: "image", data: "img", mimeType: "image/png" }];
			h.editor.pendingImageLinks = ["file:///tmp/future.png"];
			h.editor.insertText("[Image #1]");
			speak(h, 1, "delivered speech", true);
			speak(h, 2, "next request send off", true);
			h.callbacks().onSpeechSent?.("delivered speech", [1]);
			expect(h.editor.pendingImages).toHaveLength(1);
			expect(h.editor.pendingImageLinks).toEqual(["file:///tmp/future.png"]);
			await Bun.sleep(50);
			expect(h.submitted).toEqual(["[Image #1] next request"]);
		} finally {
			await h.controller.stop();
		}
	});

	it("keeps unsent image and text attachments when speech is handed off", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		h.editor.pendingImages = [{ type: "image", data: "img", mimeType: "image/png" }];
		h.editor.pendingImageLinks = ["file:///tmp/future.png"];
		h.editor.insertText("[Image #1] ");
		h.editor.insertTextAttachment("keep me");
		speak(h, 1, "ship this", true);
		h.callbacks().onSpeechSent?.("ship this");
		expect(h.editor.getText()).toContain(h.editor.pendingTexts[0]!.label);
		expect(h.editor.composerChips().map(chip => chip.kind)).toEqual(["image", "paste"]);
		expect(h.editor.pendingImages).toEqual([{ type: "image", data: "img", mimeType: "image/png" }]);
		expect(h.editor.pendingImageLinks).toEqual(["file:///tmp/future.png"]);
		expect(h.editor.pendingTexts[0]?.content).toBe("keep me");
		await h.controller.stop();
	});

	for (const destination of ["primary", "voice", "both"] as const) {
		it(`lets Iris route a keyword submission independently of Enter's ${destination} destination`, async () => {
			const h = createHarness();
			cfgLiveSubmitKeyword.set(h.ctx.settings, "send off");
			cfgLiveSubmitSilenceMs.set(h.ctx.settings, 20);
			await h.controller.handleCommand();
			if (destination !== "primary") h.controller.cycleDestination();
			if (destination === "both") h.controller.cycleDestination();
			speak(h, 1, "ship the corrected code SEND OFF", true);
			await Bun.sleep(50);
			expect(h.editor.getText()).toBe("");
			expect(h.submitted).toEqual(["ship the corrected code"]);
			expect(h.sentToVoice).toEqual([]);
			h.editor.handleInput("\x1b[A");
			expect(h.editor.getText()).toBe("ship the corrected code");
			await h.controller.stop();
		});
	}

	it("releases the visible composer through the session submission boundary", async () => {
		const h = createHarness();
		cfgLiveSubmitKeyword.set(h.ctx.settings, "send off");
		cfgLiveSubmitSilenceMs.set(h.ctx.settings, 20);
		await h.controller.handleCommand();
		try {
			speak(h, 1, "Ship this, SEND... OFF!", true);
			await Bun.sleep(50);
			expect(h.submitted).toEqual(["Ship this,"]);
			expect(h.editor.getText()).toBe("");
			h.editor.handleInput("\x1b[A");
			expect(h.editor.getText()).toBe("Ship this,");
		} finally {
			await h.controller.stop();
		}
	});

	it("rejects negative silence intervals before a keyword timer can run", () => {
		const h = createHarness();
		expect(() => cfgLiveSubmitSilenceMs.set(h.ctx.settings, -1)).toThrow("must not be negative");
		expect(cfgLiveSubmitSilenceMs.get(h.ctx.settings)).toBe(2000);
	});

	it("restarts silence on new text and cancels a corrected or mid-text keyword", async () => {
		const h = createHarness();
		cfgLiveSubmitKeyword.set(h.ctx.settings, "send off");
		cfgLiveSubmitSilenceMs.set(h.ctx.settings, 35);
		await h.controller.handleCommand();
		try {
			speak(h, 1, "send off", false);
			await Bun.sleep(20);
			speak(h, 1, "send off tomorrow", false);
			await Bun.sleep(45);
			expect(h.submitted).toEqual([]);
			speak(h, 1, "fix it send off", false);
			await Bun.sleep(15);
			speak(h, 1, "fix it, not yet", true);
			await Bun.sleep(45);
			expect(h.submitted).toEqual([]);
			expect(h.editor.getText()).toBe("fix it, not yet");
		} finally {
			await h.controller.stop();
		}
	});

	it("uses the current keyword and timeout settings without restarting the call", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		try {
			cfgLiveSubmitKeyword.set(h.ctx.settings, "send off");
			cfgLiveSubmitSilenceMs.set(h.ctx.settings, 20);
			speak(h, 1, "review this sendoff", true);
			await Bun.sleep(50);
			expect(h.submitted).toEqual(["review this"]);
			cfgLiveSubmitKeyword.set(h.ctx.settings, "");
			speak(h, 2, "review again SHIP IT", true);
			await Bun.sleep(30);
			expect(h.submitted).toEqual(["review this"]);
			expect(h.editor.getText()).toBe("review again SHIP IT");
			cfgLiveSubmitKeyword.set(h.ctx.settings, "ship it");
			await Bun.sleep(50);
			expect(h.submitted).toEqual(["review this", "review again"]);
		} finally {
			await h.controller.stop();
		}
	});

	it("does not force-delegate a composer containing only the configured force phrase", async () => {
		const h = createHarness();
		const forced = vi.spyOn(LiveSessionController.prototype, "forceDelegateComposer").mockReturnValue(true);
		cfgLiveForceDelegateKeyword.set(h.ctx.settings, "send it now");
		cfgLiveSubmitSilenceMs.set(h.ctx.settings, 0);
		await h.controller.handleCommand();
		try {
			speak(h, 1, "SEND... IT, NOW!", true);
			await Bun.sleep(20);
			expect(forced).not.toHaveBeenCalled();
		} finally {
			await h.controller.stop();
		}
	});

	it("force-delegates only a trailing composer keyword after the same silence interval", async () => {
		const h = createHarness();
		const forced = vi.spyOn(LiveSessionController.prototype, "forceDelegateComposer").mockReturnValue(true);
		cfgLiveForceDelegateKeyword.set(h.ctx.settings, "send it now");
		cfgLiveSubmitSilenceMs.set(h.ctx.settings, 35);
		await h.controller.handleCommand();
		try {
			speak(h, 1, "send it now is not the ending", false);
			await Bun.sleep(45);
			expect(forced).not.toHaveBeenCalled();
			speak(h, 1, "fix the cache send it now", false);
			await Bun.sleep(20);
			speak(h, 1, "fix the cache send it now later", false);
			await Bun.sleep(45);
			expect(forced).not.toHaveBeenCalled();
			speak(h, 1, "fix the cache SEND... IT, NOW!", true);
			await Bun.sleep(50);
			expect(forced).toHaveBeenCalledTimes(1);
			expect(forced).toHaveBeenCalledWith("fix the cache");
		} finally {
			await h.controller.stop();
		}
	});

	for (const hold of [false, true]) {
		for (const attachment of ["collapsed paste", "text chip"] as const) {
			for (const content of [
				"code says do not relate exactly",
				"Iris, this is quoted document content",
				"const value = 1;\n\n// send it now\n// thanks",
				"the quoted force-utterance word is relay",
			]) {
				it(`delivers ${attachment} contents verbatim without hidden routing (${hold ? "hold-submit" : "force-keyword"}): ${content}`, async () => {
					const h = createHandoffHarness();
					cfgLiveHoldMode.set(h.ctx.settings, hold);
					await h.controller.handleCommand();
					try {
						if (attachment === "collapsed paste") h.editor.insertPaste(content);
						else h.editor.insertTextAttachment(content);
						await Bun.sleep(20);
						expect(h.prompts).toEqual([]);
						h.editor.insertText(hold ? "\nTHANKS!" : "\nSEND... IT, NOW!");
						await Bun.sleep(40);
						if (hold) {
							expect(h.prompts).toEqual([]);
							const submitted = h.sent.filter(message => message.type === "session.context.append")
								.flatMap(message => message.content.map(item => item.text));
							expect(submitted).toContain(`"Operator Submitted Message":\n\n${content}`);
							h.delegate();
							for (let index = 0; index < 80; index++) await Promise.resolve();
						}
						expect(h.prompts).toEqual([content]);
					} finally {
						await h.controller.stop();
					}
				});
			}
		}
	}

	for (const attachment of ["collapsed paste", "text chip"] as const) {
		it(`expands a protected-turn capture's ${attachment} without changing its receipt coordinates`, async () => {
			const voiceDelivery = Promise.withResolvers<void>();
			const h = createHandoffHarness(undefined, voiceDelivery.promise);
			cfgLiveHoldMode.set(h.ctx.settings, true);
			await h.controller.handleCommand();
			try {
				h.editor.insertText("Review: ");
				if (attachment === "collapsed paste") h.editor.insertPaste("full attachment payload");
				else h.editor.insertTextAttachment("full attachment payload");
				h.speech("Iris, tell me a joke");
				h.editor.insertText(" send it now");
				await Bun.sleep(40);
				expect(h.prompts).toEqual(["Review: full attachment payload"]);
				expect(h.editor.getExpandedText().trim()).toBe("Iris, tell me a joke");
			} finally {
				voiceDelivery.resolve();
				await h.controller.stop();
			}
		});
	}

	it("retires an accepted text attachment before the next forced handoff", async () => {
		const h = createHandoffHarness();
		await h.controller.handleCommand();
		try {
			h.editor.insertText("Review: ");
			h.editor.insertTextAttachment("full attachment payload");
			h.editor.insertText(" send it now");
			await Bun.sleep(40);
			expect(h.prompts).toEqual(["Review: full attachment payload"]);
			h.editor.insertText("Second task send it now");
			await Bun.sleep(40);
			expect(h.prompts).toEqual(["Review: full attachment payload", "Second task"]);
		} finally {
			await h.controller.stop();
		}
	});

	it("retires only Iris's answered attachment while preserving a newer submitted draft", async () => {
		const h = createHandoffHarness();
		cfgLiveHoldMode.set(h.ctx.settings, true);
		await h.controller.handleCommand();
		try {
			h.editor.insertTextAttachment("first attachment for Iris");
			h.editor.insertText(" thanks");
			await Bun.sleep(40);
			expect(h.prompts).toEqual([]);
			h.editor.insertText("\nNext: ");
			h.editor.insertTextAttachment("second attachment for primary");
			h.answer();
			for (let index = 0; index < 80; index++) await Promise.resolve();
			expect(h.editor.getExpandedText()).not.toContain("first attachment for Iris");
			expect(h.editor.getExpandedText()).toContain("Next: second attachment for primary");
			h.editor.insertText(" thanks");
			await Bun.sleep(40);
			expect(h.prompts).toEqual([]);
			h.delegate();
			for (let index = 0; index < 80; index++) await Promise.resolve();
			expect(h.prompts).toEqual(["Next: second attachment for primary"]);
			expect(h.editor.composerChips()).toEqual([]);
		} finally {
			await h.controller.stop();
		}
	});

	it("preserves new attachments and unsent image chips while retiring an accepted draft", async () => {
		const accepted = Promise.withResolvers<void>();
		const h = createHandoffHarness(accepted.promise);
		await h.controller.handleCommand();
		try {
			h.editor.pendingImages = [{ type: "image", data: "img", mimeType: "image/png" }];
			h.editor.insertText("[Image #1] Review: ");
			h.editor.insertTextAttachment("delivered attachment");
			h.editor.insertText(" send it now");
			await Bun.sleep(40);
			h.editor.insertText("\nNew draft: ");
			h.editor.insertTextAttachment("unsent attachment");
			accepted.resolve();
			await Bun.sleep(20);
			expect(h.editor.getExpandedText()).not.toContain("delivered attachment");
			expect(h.editor.getExpandedText()).toContain("New draft: unsent attachment");
			expect(h.editor.composerChips().map(chip => chip.kind)).toEqual(["image", "paste"]);
			expect(h.editor.pendingImages).toEqual([{ type: "image", data: "img", mimeType: "image/png" }]);
		} finally {
			accepted.resolve();
			await h.controller.stop();
		}
	});

	for (const hold of [false, true]) {
		for (const attachment of ["collapsed paste", "text chip"] as const) {
			it(`expands a ${attachment} for ${hold ? "hold-submit" : "force-keyword"} without routing attachment text`, async () => {
				const h = createHarness();
				const forced = vi.spyOn(LiveSessionController.prototype, "forceDelegateComposer").mockReturnValue(true);
				cfgLiveHoldMode.set(h.ctx.settings, hold);
				cfgLiveForceDelegateKeyword.set(h.ctx.settings, "send it now");
				cfgLiveSubmitKeyword.set(h.ctx.settings, "thanks");
				cfgLiveSubmitSilenceMs.set(h.ctx.settings, 10);
				await h.controller.handleCommand();
				try {
					const content = "const value = 1;\n\n// send it now\n// thanks";
					h.editor.insertText("Review:\n");
					if (attachment === "collapsed paste") h.editor.insertPaste(content);
					else h.editor.insertTextAttachment(content);
					await Bun.sleep(30);
					expect(forced).not.toHaveBeenCalled();
					expect(h.submitted).toEqual([]);
					h.editor.insertText(hold ? "\nTHANKS!" : "\nSEND... IT, NOW!");
					await Bun.sleep(30);
					if (hold) {
						expect(h.submitted).toEqual([`Review:\n${content}`]);
						expect(forced).not.toHaveBeenCalled();
					} else {
						expect(forced).toHaveBeenCalledTimes(1);
						expect(forced).toHaveBeenCalledWith(`Review:\n${content}`);
					}
				} finally {
					await h.controller.stop();
				}
			});
		}
	}
	it("keeps an unfinished utterance as draft text when the call ends", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		speak(h, 1, "half a thou", false);
		await h.controller.stop();
		expect(h.editor.getText()).toBe("half a thou");
	});

	it("mirrors the call phase into the status line and leaves it disconnected after a failure", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		expect(h.liveStatus()).toEqual({ phase: "connecting", destination: "primary" });
		h.callbacks().onPhase("muted");
		expect(h.liveStatus()).toEqual({ phase: "muted", destination: "primary" });
		h.callbacks().onTerminal(new Error("socket closed"));
		expect(h.liveStatus()).toEqual({ phase: "disconnected", destination: "primary" });

		await h.controller.handleCommand();
		expect(h.liveStatus()).toEqual({ phase: "connecting", destination: "primary" });
		await h.controller.stop();
		expect(h.liveStatus()).toBeNull();
	});

	it("keeps an in-flight primary block visible while many voice turns finish mid-turn", async () => {
		const h = createHarness();
		(h.ctx.session as { isStreaming: boolean }).isStreaming = true;
		const primary = {
			render: () => ["PRIMARY STREAM"],
			isTranscriptBlockFinalized: () => false,
		};
		h.ctx.chatContainer.addChild(primary);
		await h.controller.handleCommand();
		try {
			for (let turn = 1; turn <= 12; turn++) {
				h.callbacks().onTranscript?.({ role: "assistant", turn, text: `Voice turn ${turn}`, final: false });
				h.callbacks().onTranscript?.({ role: "assistant", turn, text: `Voice turn ${turn} final`, final: true });
			}
			const rows = h.ctx.chatContainer.renderViewport(80, 6, { tick: 1, now: 1 });
			expect(rows).toContain("PRIMARY STREAM");
			expect(h.ctx.liveTranscriptContainer.render(80).join(" ")).toContain("Voice turn 12 final");
			expect(h.ctx.chatContainer.render(80)).toEqual(["PRIMARY STREAM"]);
		} finally {
			await h.controller.stop();
		}
	});

	it("keeps one safe voice caption row while streaming and archives the full reply when idle", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		try {
			h.callbacks().onTranscript?.({
				role: "assistant",
				turn: 1,
				text: "A\tlong reply\nwith enough words to exceed the short terminal and keep growing",
				final: false,
			});
			const caption = h.ctx.liveTranscriptContainer.render(24);
			expect(caption).toHaveLength(1);
			expect(Bun.stringWidth(caption[0]!, { countAnsiEscapeCodes: false })).toBeLessThanOrEqual(24);
			expect(caption[0]).toContain("Voice:");
			expect(h.ctx.chatContainer.render(80)).toEqual([]);

			h.callbacks().onTranscript?.({ role: "assistant", turn: 1, text: "Voice completed", final: true });
			expect(h.ctx.liveTranscriptContainer.render(24)).toEqual([]);
			expect(Bun.stripANSI(h.ctx.chatContainer.render(80).join(" "))).toContain("Voice completed");
		} finally {
			await h.controller.stop();
		}
	});

	it("routes Enter by destination: primary untouched, voice consumed, both shared, images to primary", async () => {
		const h = createHarness();
		const noImages = { hasImages: false };
		expect(h.controller.routeSubmit("no call running", noImages)).toBe("primary");
		await h.controller.handleCommand();

		expect(h.controller.routeSubmit("for the main agent", noImages)).toBe("primary");
		expect(h.sentToVoice).toEqual([]);

		expect(h.controller.cycleDestination()).toBe("voice");
		expect(h.liveStatus()).toEqual({ phase: "connecting", destination: "voice" });
		expect(h.controller.routeSubmit("iris, what did it say", noImages)).toBe("voice");
		expect(h.sentToVoice).toEqual([["iris, what did it say", "voice"]]);
		expect(h.presented).toHaveLength(1);
		expect(h.controller.routeSubmit("look at this", { hasImages: true })).toBe("primary");
		expect(h.sentToVoice).toHaveLength(1);

		expect(h.controller.cycleDestination()).toBe("both");
		expect(h.controller.routeSubmit("ship it", noImages)).toBe("primary");
		expect(h.sentToVoice).toHaveLength(1);
		h.controller.shareSubmit("ship it, rewritten by a hook");
		expect(h.sentToVoice.at(-1)).toEqual(["ship it, rewritten by a hook", "both"]);

		expect(h.controller.cycleDestination()).toBe("primary");
		await h.controller.stop();
		expect(h.controller.cycleDestination()).toBeUndefined();
	});

	it("notices each active custom persona without protocol lines once per process", async () => {
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-protocol-notice-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		__resetDirsFromEnvForTests();
		const statePath = path.join(dir, "neopi-live-personas.json");
		const h = createHarness();
		try {
			await Bun.write(
				statePath,
				JSON.stringify({
					schemaVersion: 1,
					personas: { alpha: { instructions: "No protocol yet." } },
					active: "alpha",
				}),
			);
			await h.controller.handleCommand();
			expect(h.ctx.showStatus).toHaveBeenCalledWith(
				'Live persona "alpha" lacks the client protocol lines; open /persona live → alpha → "Append client protocol lines".',
			);
			await h.controller.stop();
			await h.controller.handleCommand();
			expect(h.ctx.showStatus).toHaveBeenCalledTimes(1);
			await h.controller.stop();

			await Bun.write(
				statePath,
				JSON.stringify({
					schemaVersion: 1,
					personas: { beta: { instructions: "Still missing." } },
					active: "beta",
				}),
			);
			await h.controller.handleCommand();
			expect(h.ctx.showStatus).toHaveBeenLastCalledWith(
				'Live persona "beta" lacks the client protocol lines; open /persona live → beta → "Append client protocol lines".',
			);
			expect(h.ctx.showStatus).toHaveBeenCalledTimes(2);
			await h.controller.stop();
		} finally {
			await h.controller.stop();
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			__resetDirsFromEnvForTests();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("skips the protocol notice for present markers and unreadable persona state", async () => {
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-protocol-present-"));
		process.env.PI_CODING_AGENT_DIR = dir;
		__resetDirsFromEnvForTests();
		const statePath = path.join(dir, "neopi-live-personas.json");
		const h = createHarness();
		try {
			await Bun.write(
				statePath,
				JSON.stringify({
					schemaVersion: 1,
					personas: { alpha: { instructions: "<client-protocol>present</client-protocol>" } },
					active: "alpha",
				}),
			);
			await h.controller.handleCommand();
			expect(h.ctx.showStatus).not.toHaveBeenCalled();
			await h.controller.stop();
			await Bun.write(statePath, "{ corrupt");
			await h.controller.handleCommand();
			expect(h.controller.active).toBe(true);
			expect(h.ctx.showStatus).not.toHaveBeenCalled();
			await h.controller.stop();
		} finally {
			await h.controller.stop();
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			__resetDirsFromEnvForTests();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("gives an extension session its SDP answer, its events, and one end when `/live` stops it", async () => {
		const { ctx } = createHarness();
		let receivedOffer: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedOffer = options.sdpOffer;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockImplementation(async () => {
				options.callbacks.onPhase("listening");
				options.callbacks.onTranscript({ role: "user", turn: 1, text: "list files", final: true });
			});
			Object.defineProperty(session, "sdpAnswer", { value: "v=0 answer" });
			// Like the real controller: the terminal callback fires once, however often stop() runs.
			let ended = false;
			vi.spyOn(session, "stop").mockImplementation(async () => {
				if (ended) return;
				ended = true;
				options.callbacks.onTerminal();
			});
			return session;
		});
		const phases: string[] = [];
		const transcripts: string[] = [];
		const ends: (Error | undefined)[] = [];

		const live = await controller.startRemote({
			sdpOffer: "v=0 offer",
			onPhase: phase => {
				phases.push(phase);
				throw new Error("observer bug");
			},
			onTranscript: transcript => transcripts.push(transcript.text),
			onEnd: error => ends.push(error),
		});

		expect(receivedOffer).toBe("v=0 offer");
		expect(live).toMatchObject({ sdpAnswer: "v=0 answer", voice: "vale" });
		expect(phases).toEqual(["listening"]);
		expect(transcripts).toEqual(["list files"]);
		// A throwing observer must not end the call.
		expect(controller.active).toBe(true);
		await expect(controller.startRemote({ sdpOffer: "v=0 again" })).rejects.toThrow("already active");

		await controller.handleCommand();
		await live.stop();
		expect(ends).toEqual([undefined]);
	});

	it("lets exactly one of two starts queued behind a closing session win", async () => {
		const { ctx } = createHarness();
		const cleanup = Promise.withResolvers<void>();
		const created: { session: LiveSessionController; options: LiveSessionControllerOptions }[] = [];
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			Object.defineProperty(session, "sdpAnswer", { value: `answer ${created.length}` });
			vi.spyOn(session, "start").mockResolvedValue();
			// The first session's teardown stays pending, so later starts wait on its cleanup.
			const isFirst = created.length === 0;
			vi.spyOn(session, "stop").mockImplementation(() => (isFirst ? cleanup.promise : Promise.resolve()));
			created.push({ session, options });
			return session;
		});

		await controller.startRemote({ sdpOffer: "first" });
		// The call drops on its own: the slot frees at once, its cleanup does not.
		created[0]!.options.callbacks.onTerminal(new Error("sideband closed"));
		const a = controller.startRemote({ sdpOffer: "a" });
		const b = controller.startRemote({ sdpOffer: "b" });
		cleanup.resolve();
		const results = await Promise.allSettled([a, b]);

		expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(results.find(result => result.status === "rejected")).toMatchObject({
			reason: expect.objectContaining({ message: expect.stringContaining("already active") }),
		});
		expect(created).toHaveLength(2);
		expect(controller.active).toBe(true);
		await controller.stop();
	});

	it("rejects an extension start without an SDP offer before creating a session", async () => {
		const { ctx, layoutChanges } = createHarness();
		const factory = vi.fn((options: LiveSessionControllerOptions) => new LiveSessionController(options));
		const controller = new LiveCommandController(ctx, factory);
		const untyped = { sdpOffer: undefined } as unknown as ExtensionLiveStartOptions;

		await expect(controller.startRemote(untyped)).rejects.toThrow("non-empty sdpOffer");
		await expect(controller.startRemote({ sdpOffer: "  " })).rejects.toThrow("non-empty sdpOffer");
		expect(factory).not.toHaveBeenCalled();
		expect(layoutChanges).toEqual([]);
		expect(controller.active).toBe(false);
	});

	it("surfaces a session factory failure from `/live` without disturbing the composer", async () => {
		const { ctx, editor, layoutChanges, liveStatus } = createHarness();
		editor.setText("Keep this draft");
		const controller = new LiveCommandController(ctx, () => {
			throw new Error("factory broke");
		});
		await expect(controller.handleCommand()).rejects.toThrow("factory broke");
		expect(editor.getExpandedText()).toBe("Keep this draft");
		expect(layoutChanges).toEqual([]);
		expect(liveStatus()).toBeNull();
		expect(controller.active).toBe(false);
	});
});

describe("LiveSessionController with a caller-owned peer", () => {
	it("mutes by phase only and reports no levels", () => {
		const phases: string[] = [];
		const levels: number[][] = [];
		const session = new LiveSessionController({
			session: {} as unknown as LiveSessionControllerOptions["session"],
			extractAssistantText: () => "",
			sdpOffer: "v=0 offer",
			callbacks: {
				onPhase: phase => phases.push(phase),
				onLevels: (input, output) => levels.push([input, output]),
				onTranscript: () => {},
				onTerminal: () => {},
			},
		});
		session.toggleMute();
		expect(phases.at(-1)).toBe("muted");
		expect(session.muted).toBe(true);
		expect(levels).toEqual([]);
	});

	it("keeps a muted call muted when the server starts the session or delegates work", async () => {
		let onEvent: ((event: LiveServerEvent) => void) | undefined;
		const delegated: string[] = [];
		const phases: string[] = [];
		const agentSession = {
			modelRegistry: { authStorage: {} },
			sessionId: "s1",
			messages: [],
			sessionManager: { getCwd: () => process.cwd(), allocateArtifactPath: async () => ({}) },
			subscribe: () => () => {},
			sendCustomMessageWithReceipt(message: { content: string }) {
				delegated.push(message.content);
				return { accepted: Promise.resolve(), completed: Promise.resolve(true), cancel: () => false };
			},
		} as unknown as LiveSessionControllerOptions["session"];
		const session = new LiveSessionController({
			session: agentSession,
			extractAssistantText: () => "",
			sdpOffer: "v=0 offer",
			includeVoiceNote: () => false,
			delegationDelivery: () => "interrupt",
			createTransport: options => {
				onEvent = options.callbacks.onEvent;
				return {
					connect: async () => {},
					setMuted: async () => {},
					send: async () => {},
					close: async () => {},
					pushAudio: () => false,
					sdpAnswer: "v=0 answer",
				};
			},
			callbacks: {
				onPhase: phase => phases.push(phase),
				onLevels: () => {},
				onTranscript: () => {},
				onTerminal: () => {},
			},
		});
		await session.start();
		session.toggleMute();
		onEvent!({ type: "session.started", session: { id: "rtc_1" } });
		onEvent!({ type: "turn.done", turn: { role: "user", transcript: "list files" } });
		onEvent!({
			type: "delegation.created",
			item: {
				type: "delegation",
				target: "client",
				id: "d1",
				content: [],
			},
		});
		await Promise.resolve();

		expect(delegated).toEqual(["list files"]);
		// A remote peer re-enables its microphone on any phase but `muted`.
		expect(phases.slice(phases.indexOf("muted"))).toEqual(["muted"]);
		session.toggleMute();
		expect(phases.at(-1)).toBe("working");
		await session.stop();
	});
});

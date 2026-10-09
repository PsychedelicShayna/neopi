import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
	cfgLiveForceDelegateKeyword,
	cfgLiveSubmitKeyword,
	cfgLiveSubmitSilenceMs,
} from "@oh-my-pi/pi-coding-agent/live/settings";
import { Container, type Component } from "@oh-my-pi/pi-tui/tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { __resetDirsFromEnvForTests } from "@oh-my-pi/pi-utils";

interface Harness {
	ctx: InteractiveModeContext;
	editor: CustomEditor;
	controller: LiveCommandController;
	/** Callbacks the controller handed to the live session. */
	callbacks(): LiveSessionCallbacks;
	voice(): string | undefined;
	/** Components mounted into or focused away from the composer slot. */
	layoutChanges: unknown[];
	/** Latest status-line live state, `null` when hidden. */
	liveStatus(): unknown;
	/** Composer text handed to the voice model, with its audience. */
	sentToVoice: Array<[string, string]>;
	/** Components presented into the transcript. */
	presented: unknown[];
}

function createHarness(): Harness {
	const editor = new CustomEditor(getEditorTheme());
	const layoutChanges: unknown[] = [];
	let liveStatus: unknown = null;
	const sentToVoice: Array<[string, string]> = [];
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
		const session = new LiveSessionController(created);
		vi.spyOn(session, "start").mockResolvedValue();
		vi.spyOn(session, "stop").mockResolvedValue();
		vi.spyOn(session, "sendOperatorText").mockImplementation(async (text, audience) => {
			sentToVoice.push([text, audience]);
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
		layoutChanges,
		liveStatus: () => liveStatus,
		sentToVoice,
		presented,
	};
}

function speak(h: Harness, turn: number, text: string, final: boolean): void {
	h.callbacks().onUserSpeech?.({ role: "user", turn, text, final });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("forwards the selected voice across the live-session boundary", async () => {
		const h = createHarness();
		try {
			await h.controller.handleCommand();
			expect(h.voice()).toBe("vale");
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
		it(`submits a composer keyword to the selected ${destination} destination and recalls the sent text`, async () => {
			const h = createHarness();
			cfgLiveSubmitKeyword.set(h.ctx.settings, "send off");
			cfgLiveSubmitSilenceMs.set(h.ctx.settings, 20);
			await h.controller.handleCommand();
			if (destination !== "primary") h.controller.cycleDestination();
			if (destination === "both") h.controller.cycleDestination();
			const sentToMain: string[] = [];
			h.editor.onSubmit = text => {
				const route = h.controller.routeSubmit(text, { hasImages: false });
				if (route === "primary") {
					sentToMain.push(text);
					h.controller.shareSubmit(text);
				}
				h.editor.addToHistory(text);
			};
			speak(h, 1, "ship the corrected code SEND OFF", false);
			await Bun.sleep(50);
			expect(h.editor.getText()).toBe("");
			expect(sentToMain).toEqual(destination === "voice" ? [] : ["ship the corrected code"]);
			expect(h.sentToVoice).toEqual(destination === "primary" ? [] : [["ship the corrected code", destination]]);
			h.editor.handleInput("\x1b[A");
			expect(h.editor.getText()).toBe("ship the corrected code");
			await h.controller.stop();
		});
	}

	it("submits trailing speech after composer silence, not a provider-finalized turn", async () => {
		const h = createHarness();
		const sent: string[] = [];
		h.editor.onSubmit = text => {
			sent.push(text);
			h.editor.addToHistory(text);
		};
		cfgLiveSubmitKeyword.set(h.ctx.settings, "send off");
		cfgLiveSubmitSilenceMs.set(h.ctx.settings, 20);
		await h.controller.handleCommand();
		try {
			speak(h, 1, "Ship this, SEND... OFF!", false);
			await Bun.sleep(50);
			expect(sent).toEqual(["Ship this,"]);
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
		const sent: string[] = [];
		h.editor.onSubmit = text => {
			sent.push(text);
		};
		cfgLiveSubmitKeyword.set(h.ctx.settings, "send off");
		cfgLiveSubmitSilenceMs.set(h.ctx.settings, 35);
		await h.controller.handleCommand();
		try {
			speak(h, 1, "send off", false);
			await Bun.sleep(20);
			speak(h, 1, "send off tomorrow", false);
			await Bun.sleep(45);
			expect(sent).toEqual([]);
			speak(h, 1, "fix it send off", false);
			await Bun.sleep(15);
			speak(h, 1, "fix it, not yet", true);
			await Bun.sleep(45);
			expect(sent).toEqual([]);
			expect(h.editor.getText()).toBe("fix it, not yet");
		} finally {
			await h.controller.stop();
		}
	});

	it("uses the current keyword and timeout settings without restarting the call", async () => {
		const h = createHarness();
		const sent: string[] = [];
		h.editor.onSubmit = text => {
			sent.push(text);
		};
		await h.controller.handleCommand();
		try {
			cfgLiveSubmitKeyword.set(h.ctx.settings, "send off");
			cfgLiveSubmitSilenceMs.set(h.ctx.settings, 20);
			speak(h, 1, "review this sendoff", false);
			await Bun.sleep(50);
			expect(sent).toEqual(["review this"]);
			cfgLiveSubmitKeyword.set(h.ctx.settings, "");
			speak(h, 2, "review again SHIP IT", false);
			await Bun.sleep(30);
			expect(sent).toEqual(["review this"]);
			cfgLiveSubmitKeyword.set(h.ctx.settings, "ship it");
			await Bun.sleep(50);
			expect(sent).toEqual(["review this", "review again"]);
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
			speak(h, 1, "fix the cache SEND... IT, NOW!", false);
			await Bun.sleep(50);
			expect(forced).toHaveBeenCalledTimes(1);
			expect(forced).toHaveBeenCalledWith("fix the cache");
		} finally {
			await h.controller.stop();
		}
	});

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
});

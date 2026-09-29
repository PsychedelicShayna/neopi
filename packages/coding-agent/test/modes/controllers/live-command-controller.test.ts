import { afterEach, describe, expect, it, vi } from "bun:test";
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
	const ctx = {
		settings: Settings.isolated({ "live.voice": "vale" }),
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		session: {},
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
		chatContainer: { children: [] },
		present: vi.fn((component: unknown) => presented.push(component)),
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
		it(`submits the trailing keyword to the selected ${destination} destination and recalls the sent text`, async () => {
			const h = createHarness();
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
			speak(h, 1, "ship the corrected code", true);
			h.callbacks().onSubmitKeyword?.("ship the corrected code");
			expect(h.editor.getText()).toBe("");
			expect(sentToMain).toEqual(destination === "voice" ? [] : ["ship the corrected code"]);
			expect(h.sentToVoice).toEqual(
				destination === "primary" ? [] : [["ship the corrected code", destination]],
			);
			h.editor.handleInput("\x1b[A");
			expect(h.editor.getText()).toBe("ship the corrected code");
			await h.controller.stop();
		});
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
});

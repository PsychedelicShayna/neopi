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

const UNDO = "\x1b[45;5u";

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
		vi.spyOn(session, "sendOperatorText").mockImplementation((text, audience) => {
			sentToVoice.push([text, audience]);
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
	h.callbacks().onTranscript({ role: "user", turn, text, final });
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
		expect(h.editor.hasVolatileText).toBe(true);
		speak(h, 1, "hello world", true);
		expect(h.editor.getText()).toBe("context: hello world");
		expect(h.editor.hasVolatileText).toBe(false);
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
		expect(h.editor.getText()).toBe("hello wor!");
		speak(h, 1, "hello world", true);
		expect(h.editor.getText()).toBe("hello wor!ld");
		await h.controller.stop();
	});

	it("removes delegated speech from the draft as one undoable edit", async () => {
		const h = createHarness();
		h.editor.insertText("note:");
		await h.controller.handleCommand();
		speak(h, 1, "repair the cache", true);
		expect(h.editor.getText()).toBe("note: repair the cache");

		h.callbacks().onDelegated?.(["repair the cache"]);
		expect(h.editor.getText()).toBe("note:");
		h.editor.handleInput(UNDO);
		expect(h.editor.getText()).toBe("note: repair the cache");
		await h.controller.stop();
	});

	it("keeps an unfinished utterance as draft text when the call ends", async () => {
		const h = createHarness();
		await h.controller.handleCommand();
		speak(h, 1, "half a thou", false);
		await h.controller.stop();
		expect(h.editor.getText()).toBe("half a thou");
		expect(h.editor.hasVolatileText).toBe(false);
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
		expect(h.controller.routeSubmit("no call running", noImages)).toBe(false);
		await h.controller.handleCommand();

		expect(h.controller.routeSubmit("for the main agent", noImages)).toBe(false);
		expect(h.sentToVoice).toEqual([]);

		expect(h.controller.cycleDestination()).toBe("voice");
		expect(h.liveStatus()).toEqual({ phase: "connecting", destination: "voice" });
		expect(h.controller.routeSubmit("iris, what did it say", noImages)).toBe(true);
		expect(h.sentToVoice).toEqual([["iris, what did it say", "voice"]]);
		expect(h.presented).toHaveLength(1);
		expect(h.controller.routeSubmit("look at this", { hasImages: true })).toBe(false);
		expect(h.sentToVoice).toHaveLength(1);

		expect(h.controller.cycleDestination()).toBe("both");
		expect(h.controller.routeSubmit("ship it", noImages)).toBe(false);
		expect(h.sentToVoice.at(-1)).toEqual(["ship it", "both"]);

		expect(h.controller.cycleDestination()).toBe("primary");
		await h.controller.stop();
		expect(h.controller.cycleDestination()).toBeUndefined();
	});
});

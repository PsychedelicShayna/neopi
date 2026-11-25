/** Focused commands must target the right session; dismissing a warning must do nothing. */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { setSubagentFast } from "@oh-my-pi/pi-coding-agent/registry/subagent-controls";
import { HookSelectorComponent, type HookSelectorOptionInput } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";

function createSessionControls() {
	let thinkingLevel: ThinkingLevel = ThinkingLevel.Low;
	let fast = false;
	let ultra = false;
	const setFastMode = vi.fn((enabled: boolean) => {
		fast = enabled;
		ultra = false;
		return true;
	});
	return {
		get thinkingLevel(): ThinkingLevel {
			return thinkingLevel;
		},
		cycleThinkingLevel: vi.fn<() => ThinkingLevel | undefined>(() => {
			thinkingLevel = ThinkingLevel.High;
			return thinkingLevel;
		}),
		setFastMode,
		toggleFastMode: vi.fn(() => {
			setFastMode(!fast);
			return fast;
		}),
		setUltrafastMode: vi.fn((enabled: boolean) => {
			fast = enabled;
			ultra = enabled;
			return true;
		}),
		forcedOpenAITier: vi.fn(() => undefined),
		setForcedOpenAITier: vi.fn(() => false),
		isFastModeEnabled: vi.fn(() => fast),
		isFastModeActive: vi.fn(() => false),
		isUltrafastModeEnabled: vi.fn(() => ultra),
	};
}

function createFocusedContext() {
	let editorText = "";
	const editor = {
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		setCollapsedText(text: string) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory: vi.fn(),
		imageLinks: undefined as (string | undefined)[] | undefined,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		clearDraft: vi.fn(),
		clearSubmittedDraft: vi.fn(),
		restoreSubmittedDraft: vi.fn(() => false),
	};
	const prompt = vi.fn(async () => {});
	const mainControls = createSessionControls();
	const childControls = createSessionControls();
	const siblingControls = createSessionControls();
	const resume = vi.fn(async () => {});
	const childSession = Object.assign(childControls, {
		isStreaming: false,
		queuedMessageCount: 0,
		prompt,
		resume,
		abort: vi.fn(async () => {}),
	});
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		showHookSelector: vi.fn<(title: string, options: HookSelectorOptionInput[]) => Promise<string | undefined>>(),
		showModelSelector: vi.fn(),
		session: Object.assign(mainControls, {
			isStreaming: false,
			prompt: vi.fn(async () => {}),
			isCompacting: false,
			captureSubmissionGuard: () => () => true,
			extensionRunner: undefined,
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
		}),
		get viewSession() {
			return this.focusedAgentId ? childSession : this.session;
		},
		focusedAgentId: "Worker" as string | undefined,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { set: vi.fn() },
		isKnownSlashCommand: vi.fn(() => true),
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		collabGuest: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		handleUsageCommand: vi.fn(async () => {}),
		handleExportCommand: vi.fn(async () => {}),
		handleBtwCommand: vi.fn(async () => {}),
		handleJobsCommand: vi.fn(async () => {}),
		showResetUsageSelector: vi.fn(async () => {}),
		withLocalSubmission: vi.fn(async <T>(_text: string, fn: () => Promise<T>) => fn()),
	};
	return {
		ctx: ctx as unknown as InteractiveModeContext,
		raw: ctx,
		editor,
		prompt,
		resume,
		mainControls,
		childControls,
		siblingControls,
	};
}

async function submit(text: string) {
	const focused = createFocusedContext();
	const controller = new InputController(focused.ctx);
	controller.setupEditorSubmitHandler();
	focused.editor.setText(text);
	await focused.ctx.editor.onSubmit?.(text);
	return focused;
}

function submitWithWarning(
	ctx: InteractiveModeContext,
	showHookSelector: { mockImplementation: (fn: InteractiveModeContext["showHookSelector"]) => unknown },
	text: string,
) {
	let selector: HookSelectorComponent | undefined;
	showHookSelector.mockImplementation((title, options) => {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		selector = new HookSelectorComponent(title, options, resolve, () => resolve(undefined));
		return promise;
	});
	new InputController(ctx).setupEditorSubmitHandler();
	// The real editor detaches submitted text before the handler runs.
	const done = ctx.editor.onSubmit?.(text);
	if (!selector) throw new Error(`Expected a confirmation for ${text}`);
	return { done, selector };
}

describe("focused subagent view slash commands", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("routes ordinary chat to the focused session", async () => {
		const { prompt, resume, raw } = await submit("Keep the parser simple");
		expect(prompt).toHaveBeenCalledWith("Keep the parser simple", {
			streamingBehavior: "steer",
			images: undefined,
		});
		expect(resume).not.toHaveBeenCalled();
		expect(raw.withLocalSubmission).toHaveBeenCalledTimes(1);
	});

	it("resumes the focused session for . and c", async () => {
		for (const shortcut of [".", "c"]) {
			const { prompt, resume, editor, raw } = await submit(shortcut);
			expect(resume).toHaveBeenCalledTimes(1);
			expect(prompt).not.toHaveBeenCalled();
			expect(editor.clearDraft).toHaveBeenCalledWith(shortcut);
			expect(raw.withLocalSubmission).not.toHaveBeenCalled();
		}
	});

	it("runs /usage from the focused view", async () => {
		const { raw, prompt } = await submit("/usage");
		expect(raw.handleUsageCommand).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("runs /jobs from the focused view", async () => {
		for (const [text, full] of [
			["/jobs", false],
			["/jobs full", true],
		] as const) {
			const { raw, prompt } = await submit(text);
			expect(raw.handleJobsCommand).toHaveBeenCalledTimes(1);
			expect(raw.handleJobsCommand).toHaveBeenCalledWith({ full });
			expect(prompt).not.toHaveBeenCalled();
		}
	});

	it("runs /export with its arguments from the focused view", async () => {
		const { raw, prompt } = await submit("/export out.html");
		expect(raw.handleExportCommand).toHaveBeenCalledWith("/export out.html");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("runs /btw with its question from the focused view instead of steering the agent", async () => {
		const { raw, prompt } = await submit("/btw what is it doing?");
		expect(raw.handleBtwCommand).toHaveBeenCalledWith("what is it doing?", undefined);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("cycles only the focused child's effort and refreshes the focused display", async () => {
		const { ctx, raw, childControls, mainControls, siblingControls } = createFocusedContext();

		await new InputController(ctx).cycleThinkingLevel();

		expect(childControls.cycleThinkingLevel).toHaveBeenCalledTimes(1);
		expect(childControls.thinkingLevel).toBe(ThinkingLevel.High);
		expect(ctx.viewSession.thinkingLevel).toBe(ThinkingLevel.High);
		expect(mainControls.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(siblingControls.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(mainControls.cycleThinkingLevel).not.toHaveBeenCalled();
		expect(raw.statusLine.invalidate).toHaveBeenCalledTimes(1);
		expect(raw.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(raw.settings.set).not.toHaveBeenCalled();
	});

	it("keeps effort cycling on the main session outside a focused view", async () => {
		const { ctx, raw, mainControls, childControls } = createFocusedContext();
		raw.focusedAgentId = undefined;

		await new InputController(ctx).cycleThinkingLevel();

		expect(mainControls.cycleThinkingLevel).toHaveBeenCalledTimes(1);
		expect(childControls.cycleThinkingLevel).not.toHaveBeenCalled();
		expect(raw.statusLine.invalidate).toHaveBeenCalledTimes(1);
		expect(raw.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("reports unsupported focused effort without changing the main session", async () => {
		const { ctx, raw, mainControls } = createFocusedContext();
		raw.viewSession.cycleThinkingLevel = vi.fn(() => undefined);

		await new InputController(ctx).cycleThinkingLevel();

		expect(raw.showStatus).toHaveBeenCalledWith("Current model does not support thinking");
		expect(mainControls.cycleThinkingLevel).not.toHaveBeenCalled();
		expect(raw.statusLine.invalidate).not.toHaveBeenCalled();
	});

	it("routes every /fast form to the child without changing parent, sibling, or settings", async () => {
		for (const [command, enabled, ultra, message] of [
			["/fast", true, false, "Fast mode enabled."],
			["/fast toggle", true, false, "Fast mode enabled."],
			["/fast ON", true, false, "Fast mode enabled."],
			["/fast ultra", true, true, "Ultrafast mode enabled."],
			["/fast ultrafast", true, true, "Ultrafast mode enabled."],
			["/fast off", false, false, "Fast mode disabled."],
			["/fast status", false, false, "Fast mode is off."],
		] as const) {
			const { ctx, raw, editor, childControls, mainControls, siblingControls, prompt } = createFocusedContext();
			new InputController(ctx).setupEditorSubmitHandler();
			editor.setText(command);

			await ctx.editor.onSubmit?.(command);

			expect(childControls.isFastModeEnabled()).toBe(enabled);
			expect(childControls.isUltrafastModeEnabled()).toBe(ultra);
			expect(ctx.viewSession.isFastModeEnabled()).toBe(enabled);
			expect(mainControls.isFastModeEnabled()).toBe(false);
			expect(siblingControls.isFastModeEnabled()).toBe(false);
			expect(mainControls.setFastMode).not.toHaveBeenCalled();
			expect(mainControls.toggleFastMode).not.toHaveBeenCalled();
			expect(mainControls.setUltrafastMode).not.toHaveBeenCalled();
			expect(raw.settings.set).not.toHaveBeenCalled();
			expect(raw.showStatus).toHaveBeenCalledWith(message);
			expect(editor.clearDraft).toHaveBeenCalled();
			expect(raw.statusLine.invalidate).toHaveBeenCalledTimes(1);
			expect(raw.updateEditorBorderColor).toHaveBeenCalledTimes(1);
			expect(prompt).not.toHaveBeenCalled();
		}
	});

	it("reads shared-control changes in focused status without claiming priority is active", async () => {
		const { ctx, raw, editor, childControls, mainControls, siblingControls } = createFocusedContext();
		expect(await setSubagentFast(ctx.viewSession, true)).toBe(true);
		new InputController(ctx).setupEditorSubmitHandler();
		editor.setText("/fast status");

		await ctx.editor.onSubmit?.("/fast status");

		expect(raw.showStatus).toHaveBeenCalledWith("Fast mode is on.");
		expect(childControls.isFastModeActive()).toBe(false);
		expect(childControls.setFastMode).toHaveBeenCalledTimes(1);
		expect(mainControls.isFastModeEnabled()).toBe(false);
		expect(siblingControls.isFastModeEnabled()).toBe(false);
	});

	it("preserves new text or image-only input arriving while focused /fast awaits its worker", async () => {
		for (const replaceText of [true, false]) {
			const { ctx, raw, editor } = createFocusedContext();
			editor.clearDraft.mockImplementation(() => {
				editor.setText("");
				editor.pendingImages = [];
				editor.pendingImageLinks = [];
				editor.imageLinks = undefined;
			});
			const started = Promise.withResolvers<void>();
			const finished = Promise.withResolvers<string>();
			Object.assign(raw.viewSession, {
				instanceKey: "remote-worker:focused-fast",
				runSubagentFastCommand: () => {
					started.resolve();
					return finished.promise;
				},
			});
			new InputController(ctx).setupEditorSubmitHandler();
			editor.setText("/fast on");
			const submitting = ctx.editor.onSubmit?.("/fast on");
			await started.promise;

			if (replaceText) editor.setText("next question");
			const image: ImageContent = { type: "image", data: "later-image", mimeType: "image/png" };
			editor.pendingImages.push(image);
			editor.pendingImageLinks.push("later.png");
			editor.imageLinks = editor.pendingImageLinks;
			finished.resolve("Fast mode is on.");
			await submitting;

			expect(editor.getText()).toBe(replaceText ? "next question" : "");
			expect(editor.pendingImages).toEqual([image]);
			expect(editor.pendingImageLinks).toEqual(["later.png"]);
			expect(editor.imageLinks).toEqual(["later.png"]);
		}
	});

	it("preserves failed /fast drafts and reports invalid arguments or unavailable service", async () => {
		for (const [command, failure] of [
			["/fast wrong", "Usage: /fast"],
			["/fast on", "Fast mode is unavailable"],
			["/fast ultra", "Ultrafast is unavailable"],
		] as const) {
			const { ctx, raw, editor, mainControls, prompt } = createFocusedContext();
			raw.viewSession.setFastMode = vi.fn(() => false);
			raw.viewSession.setUltrafastMode = vi.fn(() => false);
			new InputController(ctx).setupEditorSubmitHandler();
			editor.setText(command);

			await ctx.editor.onSubmit?.(command);

			expect(raw.showError).toHaveBeenCalledWith(expect.stringContaining(failure));
			expect(editor.getText()).toBe(command);
			expect(editor.clearDraft).not.toHaveBeenCalled();
			expect(mainControls.setFastMode).not.toHaveBeenCalled();
			expect(mainControls.setUltrafastMode).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
		}
	});

	it("keeps /fast on the main builtin route when no child is focused", async () => {
		const { ctx, raw, editor, childControls, mainControls } = createFocusedContext();
		raw.focusedAgentId = undefined;
		new InputController(ctx).setupEditorSubmitHandler();
		editor.setText("/fast on");

		await ctx.editor.onSubmit?.("/fast on");

		expect(mainControls.setFastMode).toHaveBeenCalledWith(true);
		expect(childControls.setFastMode).not.toHaveBeenCalled();
		expect(raw.showStatus).toHaveBeenCalledWith("Fast mode enabled.");
	});

	it("copies the focused agent's last code block with /copy code instead of steering the agent", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const codeMessage = (code: string) =>
			({
				role: "assistant",
				content: [{ type: "text", text: `\`\`\`ts\n${code}\n\`\`\`` }],
			}) as unknown as AgentMessage;
		const focused = createFocusedContext();
		Object.assign(focused.raw.session, { messages: [codeMessage("const main = 1;")] });
		Object.assign(focused.raw.viewSession, { messages: [codeMessage("const worker = 1;")] });
		const controller = new InputController(focused.ctx);
		controller.setupEditorSubmitHandler();
		focused.editor.setText("/copy code");
		await focused.ctx.editor.onSubmit?.("/copy code");

		expect(copySpy).toHaveBeenCalledWith("const worker = 1;");
		expect(focused.prompt).not.toHaveBeenCalled();
	});

	it("answers a side file command from the focused view and releases its draft", async () => {
		const focused = createFocusedContext();
		Object.assign(focused.raw, { fileSlashCommands: new Set(["sitrep"]) });
		Object.assign(focused.raw.session, {
			slashCommands: [
				{
					name: "sitrep",
					description: "",
					content: "Report. Focus: $ARGUMENTS",
					side: true,
					source: "via OMP User",
				},
			],
		});
		const controller = new InputController(focused.ctx);
		controller.setupEditorSubmitHandler();
		focused.editor.setText("/sitrep the migration");
		await focused.ctx.editor.onSubmit?.("/sitrep the migration");
		expect(focused.raw.handleBtwCommand).toHaveBeenCalledWith(
			"Report. Focus: the migration",
			undefined,
			"/sitrep the migration",
		);
		expect(focused.editor.clearDraft).toHaveBeenCalledTimes(1);
		expect(focused.prompt).not.toHaveBeenCalled();
	});

	it("warns for the builtin /clear instead of running a side file command with the same name", async () => {
		const focused = createFocusedContext();
		Object.assign(focused.raw, { fileSlashCommands: new Set(["clear"]) });
		Object.assign(focused.raw.session, {
			slashCommands: [{ name: "clear", description: "", content: "Side", side: true, source: "via OMP User" }],
		});
		const { done, selector } = submitWithWarning(focused.ctx, focused.raw.showHookSelector, "/clear");
		selector.handleInput("\r");
		await done;
		expect(focused.raw.showHookSelector).toHaveBeenCalledWith(
			expect.stringContaining("focused agent's transcript"),
			expect.any(Array),
		);
		expect(focused.raw.handleBtwCommand).not.toHaveBeenCalled();
		expect(focused.raw.session.prompt).not.toHaveBeenCalled();
		expect(focused.prompt).not.toHaveBeenCalled();
		expect(focused.editor.getText()).toBe("/clear");
	});

	it("sets the focused agent's thinking level with /effort, leaving the main session alone", async () => {
		const focused = createFocusedContext();
		const setFocusedThinking = vi.fn();
		const setMainThinking = vi.fn();
		Object.assign(focused.raw.viewSession, {
			model: { provider: "anthropic", id: "claude-sonnet", reasoning: true },
			getAvailableEffortSelectors: () => ["off", "auto", "low", "medium", "high"],
			setThinkingLevel: setFocusedThinking,
		});
		Object.assign(focused.raw.session, { setThinkingLevel: setMainThinking });
		const controller = new InputController(focused.ctx);
		controller.setupEditorSubmitHandler();
		focused.editor.setText("/effort high");
		await focused.ctx.editor.onSubmit?.("/effort high");

		expect(setFocusedThinking).toHaveBeenCalledWith("high");
		expect(setMainThinking).not.toHaveBeenCalled();
		expect(focused.prompt).not.toHaveBeenCalled();
	});

	it("sends /notice only to the focused transcript without confirmation", async () => {
		const text = "/notice keep this wording :)";
		const { raw, prompt } = await submit(text);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith(
			expect.stringContaining("keep this wording :)"),
			expect.objectContaining({ synthetic: true, userInitiated: true }),
		);
		expect(raw.session.prompt).not.toHaveBeenCalled();
		expect(raw.showHookSelector).not.toHaveBeenCalled();
	});

	it("queues behind the focused agent's active turn without prompting Main", async () => {
		const focused = createFocusedContext();
		const controller = new InputController(focused.ctx);
		focused.ctx.handleQueueCommand = message => controller.handleQueueCommand(message);
		Object.assign(focused.raw.viewSession, { isStreaming: true });
		controller.setupEditorSubmitHandler();
		await focused.ctx.editor.onSubmit?.("/queue wait for my next instruction");
		expect(focused.prompt).toHaveBeenCalledWith(
			"wait for my next instruction",
			expect.objectContaining({ streamingBehavior: "followUp" }),
		);
		expect(focused.raw.session.prompt).not.toHaveBeenCalled();
		expect(focused.raw.showHookSelector).not.toHaveBeenCalled();
	});

	it("opens the focused model picker with /model, /models, or /switch without confirmation", async () => {
		for (const text of ["/model", "/models", "/switch", "/models session"]) {
			const { raw, prompt } = await submit(text);
			expect(raw.showModelSelector).toHaveBeenCalledTimes(1);
			expect(raw.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
			expect(raw.showHookSelector).not.toHaveBeenCalled();
			expect(raw.session.prompt).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
		}
	});

	it("selects a model on the focused agent without touching the parent or confirming", async () => {
		const focused = createFocusedContext();
		const childSelect = vi.fn(async () => ({ ok: true, data: { provider: "openai", modelId: "gpt-5" } }));
		const mainSelect = vi.fn();
		Object.assign(focused.raw.viewSession, { selectSubagentModel: childSelect });
		Object.assign(focused.raw.session, { selectSubagentModel: mainSelect });
		new InputController(focused.ctx).setupEditorSubmitHandler();
		await focused.ctx.editor.onSubmit?.("/model openai/gpt-5");
		expect(childSelect).toHaveBeenCalledTimes(1);
		expect(childSelect).toHaveBeenCalledWith({ selector: "openai/gpt-5" });
		expect(mainSelect).not.toHaveBeenCalled();
		expect(focused.raw.showHookSelector).not.toHaveBeenCalled();
		expect(focused.raw.session.prompt).not.toHaveBeenCalled();
		expect(focused.prompt).not.toHaveBeenCalled();
	});

	it("keeps non-slash shell execution gated to the main session, draft intact", async () => {
		const text = "!echo unsafe";
		const { raw, editor, prompt } = await submit(text);
		expect(editor.getText()).toBe(text);
		expect(raw.showStatus).toHaveBeenCalledWith(expect.stringContaining("main session"));
		expect(prompt).not.toHaveBeenCalled();
	});

	it("Enter selects Cancel and leaves the draft and both sessions untouched", async () => {
		for (const text of [
			"/compact",
			"/slow on",
			"/usage reset",
			"/usage reset anthropic/active",
			"/jobs kill all",
			"/jobs kill job-1",
		]) {
			const focused = createFocusedContext();
			const cancelAsyncJob = vi.fn();
			const runFocusedAgentCommand = vi.fn();
			Object.assign(focused.raw.session, { cancelAsyncJob });
			Object.assign(focused.raw.viewSession, { cancelAsyncJob, runFocusedAgentCommand });
			const { done, selector } = submitWithWarning(focused.ctx, focused.raw.showHookSelector, text);
			selector.handleInput("\r");
			await done;
			expect(focused.editor.getText()).toBe(text);
			expect(focused.editor.clearDraft).not.toHaveBeenCalled();
			expect(focused.raw.showResetUsageSelector).not.toHaveBeenCalled();
			expect(focused.raw.handleUsageCommand).not.toHaveBeenCalled();
			expect(focused.raw.handleJobsCommand).not.toHaveBeenCalled();
			expect(focused.raw.session.prompt).not.toHaveBeenCalled();
			expect(focused.prompt).not.toHaveBeenCalled();
			expect(cancelAsyncJob).not.toHaveBeenCalled();
			expect(runFocusedAgentCommand).not.toHaveBeenCalled();
		}
	});

	it("only stops the focused agent's job after explicitly confirming", async () => {
		const focused = createFocusedContext();
		const childCancel = vi.fn(() => true);
		const mainCancel = vi.fn(() => true);
		const snapshot = { running: [{ id: "job-1" }] };
		Object.assign(focused.raw.viewSession, { getAsyncJobSnapshot: () => snapshot, cancelAsyncJob: childCancel });
		Object.assign(focused.raw.session, { getAsyncJobSnapshot: () => snapshot, cancelAsyncJob: mainCancel });
		const { done, selector } = submitWithWarning(focused.ctx, focused.raw.showHookSelector, "/jobs kill job-1");
		expect(childCancel).not.toHaveBeenCalled();
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		await done;
		expect(childCancel).toHaveBeenCalledTimes(1);
		expect(childCancel).toHaveBeenCalledWith("job-1");
		expect(mainCancel).not.toHaveBeenCalled();
		expect(focused.editor.getText()).toBe("");
	});

	it("exports the viewed (focused) session rather than the main session", async () => {
		const mainExport = vi.fn(async () => "main.html");
		const viewExport = vi.fn(async () => "worker.html");
		const showStatus = vi.fn();
		const ctx = {
			session: { exportToHtml: mainExport },
			viewSession: { exportToHtml: viewExport },
			showStatus,
			showError: vi.fn(),
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		vi.spyOn(controller, "openInBrowser").mockImplementation(() => {});

		await controller.handleExportCommand("/export");

		expect(viewExport).toHaveBeenCalledTimes(1);
		expect(mainExport).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session exported to: worker.html");
	});
});

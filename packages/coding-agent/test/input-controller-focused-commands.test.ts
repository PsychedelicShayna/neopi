/**
 * Focused subagent views allow chat, viewer-scoped /btw, /export, /jobs and /usage,
 * effort controls, and session-only /fast. Model changes and other mutations,
 * including /usage reset and /jobs kill, still require returning to main.
 *
 * Failure mode if this regresses: allowed commands silently do nothing (or steer
 * the agent), exports use the main transcript, or focused effort/fast controls
 * change the main session instead of the viewed agent.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AgentBusyError, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { setSubagentFast } from "@oh-my-pi/pi-coding-agent/registry/subagent-controls";

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
		imageLinks: undefined,
		pendingImages: [],
		pendingImageLinks: [],
		clearDraft: vi.fn(),
	};
	const prompt = vi.fn(async () => {});
	const mainControls = createSessionControls();
	const childControls = createSessionControls();
	const siblingControls = createSessionControls();
	const resume = vi.fn(async () => {});
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		session: Object.assign(mainControls, {
			isStreaming: false,
			isCompacting: false,
			extensionRunner: undefined,
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
		}),
		viewSession: Object.assign(childControls, {
			isStreaming: false,
			queuedMessageCount: 0,
			prompt,
			resume,
			abort: vi.fn(async () => {}),
		}),
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

	it("restores a focused continue shortcut when the target is busy", async () => {
		const { ctx, raw, editor, resume } = createFocusedContext();
		resume.mockRejectedValueOnce(new AgentBusyError());
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		await ctx.editor.onSubmit?.(".");

		expect(editor.getText()).toBe(".");
		expect(raw.showError).toHaveBeenCalledTimes(1);
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

	it("cycles only the focused child's effort and refreshes the focused display", () => {
		const { ctx, raw, childControls, mainControls, siblingControls } = createFocusedContext();

		new InputController(ctx).cycleThinkingLevel();

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

	it("keeps effort cycling on the main session outside a focused view", () => {
		const { ctx, raw, mainControls, childControls } = createFocusedContext();
		raw.focusedAgentId = undefined;

		new InputController(ctx).cycleThinkingLevel();

		expect(mainControls.cycleThinkingLevel).toHaveBeenCalledTimes(1);
		expect(childControls.cycleThinkingLevel).not.toHaveBeenCalled();
		expect(raw.statusLine.invalidate).toHaveBeenCalledTimes(1);
		expect(raw.updateEditorBorderColor).toHaveBeenCalledTimes(1);
	});

	it("reports unsupported focused effort without changing the main session", () => {
		const { ctx, raw, mainControls } = createFocusedContext();
		raw.viewSession.cycleThinkingLevel = vi.fn(() => undefined);

		new InputController(ctx).cycleThinkingLevel();

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
		expect(setSubagentFast(ctx.viewSession, true)).toBe(true);
		new InputController(ctx).setupEditorSubmitHandler();
		editor.setText("/fast status");

		await ctx.editor.onSubmit?.("/fast status");

		expect(raw.showStatus).toHaveBeenCalledWith("Fast mode is on.");
		expect(childControls.isFastModeActive()).toBe(false);
		expect(childControls.setFastMode).toHaveBeenCalledTimes(1);
		expect(mainControls.isFastModeEnabled()).toBe(false);
		expect(siblingControls.isFastModeEnabled()).toBe(false);
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

	it("keeps focused model cycling blocked", async () => {
		const { ctx, raw, mainControls, childControls } = createFocusedContext();

		await new InputController(ctx).cycleRoleModel();

		expect(raw.showStatus).toHaveBeenCalledWith(expect.stringContaining("main session"));
		expect(mainControls.cycleThinkingLevel).not.toHaveBeenCalled();
		expect(childControls.cycleThinkingLevel).not.toHaveBeenCalled();
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

	it("keeps a builtin gated to the main session when a side file command shares its name", async () => {
		const focused = createFocusedContext();
		Object.assign(focused.raw, { fileSlashCommands: new Set(["clear"]) });
		Object.assign(focused.raw.session, {
			slashCommands: [{ name: "clear", description: "", content: "Side", side: true, source: "via OMP User" }],
		});
		const controller = new InputController(focused.ctx);
		controller.setupEditorSubmitHandler();
		focused.editor.setText("/clear");
		await focused.ctx.editor.onSubmit?.("/clear");
		expect(focused.raw.handleBtwCommand).not.toHaveBeenCalled();
		expect(focused.raw.showStatus).toHaveBeenCalledTimes(1);
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

	it("keeps other commands gated to the main session, draft intact", async () => {
		for (const text of ["/compact", "/model", "/models", "/model openai/gpt-5", "/switch", "/slow on", "!echo unsafe"]) {
			const { raw, editor, prompt } = await submit(text);
			expect(editor.getText()).toBe(text);
			expect(raw.showStatus).toHaveBeenCalledWith(expect.stringContaining("main session"));
			expect(prompt).not.toHaveBeenCalled();
		}
	});

	it("keeps the mutating /usage reset form gated to the main session", async () => {
		for (const text of ["/usage reset", "/usage reset anthropic/active"]) {
			const { raw, editor } = await submit(text);
			expect(raw.showResetUsageSelector).not.toHaveBeenCalled();
			expect(raw.handleUsageCommand).not.toHaveBeenCalled();
			expect(editor.getText()).toBe(text);
		}
	});

	it("keeps the mutating /jobs kill form gated to the main session", async () => {
		for (const text of ["/jobs kill all", "/jobs kill job-1"]) {
			const { raw, editor } = await submit(text);
			expect(raw.handleJobsCommand).not.toHaveBeenCalled();
			expect(raw.showStatus).toHaveBeenCalled();
			expect(editor.getText()).toBe(text);
		}
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

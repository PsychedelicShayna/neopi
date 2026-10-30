import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { cfgBareSlashCommands } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { parseDeferredInput } from "@oh-my-pi/pi-coding-agent/neopi/defer";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function harness() {
	const temp = TempDir.createSync("@pi-defer-");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const mock = createMockModel({ handler: { content: ["Acknowledged"] } });
	const manager = SessionManager.inMemory(temp.path());
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	cleanups.push(async () => {
		await session.dispose();
		auth.close();
		temp.removeSync();
	});
	const editor = new CustomEditor(getEditorTheme());
	const ctx = createInteractiveModeContext({
		session,
		sessionManager: manager,
		settings: session.settings,
		editor,
		onInputCallback: undefined,
		handleTanCommand: vi.fn(async () => true),
		flushPendingBashComponents: vi.fn(),
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>): Promise<T> => await fn(),
		isKnownSlashCommand: text => lookupBuiltinSlashCommand(text.slice(1).split(/\s|:/, 1)[0] ?? "") !== undefined,
		slashCommandNames: new Set(["defer", "tan"]),
		skillCommands: new Map(),
		fileSlashCommands: new Set(),
		locallySubmittedUserSignatures: new Set(),
		compactionQueuedMessages: [],
	});
	new InputController(ctx).setupEditorSubmitHandler();
	return { ctx, editor, session, mock, submit: async (text: string) => await editor.onSubmit?.(text) };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + 20_000;
	while (!predicate() && performance.now() < deadline) await Bun.sleep(5);
	expect(predicate()).toBe(true);
}

describe("/defer", () => {
	it("accepts all units, fractional numbers and case-sensitive months and years", () => {
		for (const [duration, delayMs] of [
			["2ms", 2],
			[".5s", 500],
			["1m", 60_000],
			["1h", 3_600_000],
			["1d", 86_400_000],
			["1w", 604_800_000],
			["1M", 2_592_000_000],
			["1Y", 31_536_000_000],
		] as const)
			expect(parseDeferredInput(`${duration} hi\nthere`)).toEqual({ delayMs, input: "hi\nthere" });
		for (const input of ["10 hi", "1S hi", "1m", "1m   ", "1e999s hi"])
			expect(parseDeferredInput(input)).toBeUndefined();
	});

	it("delivers plain input through the normal composer path without consuming a newer draft or its images", async () => {
		const h = harness();
		await h.submit("/defer 5ms delayed prose");
		h.editor.setText("new draft");
		const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
		h.editor.pendingImages = [image];
		await waitUntil(() => h.mock.calls.length === 1);
		expect(h.session.messages).toContainEqual(
			expect.objectContaining({
				role: "user",
				content: [{ type: "text", text: "delayed prose" }],
			}),
		);
		expect(h.editor.getText()).toBe("new draft");
		expect(h.editor.pendingImages).toEqual([image]);
	});

	it("executes deferred slash commands through the same interpreter", async () => {
		const h = harness();
		const tan = vi.spyOn(h.ctx, "handleTanCommand").mockResolvedValue(true);
		await h.submit("/defer 5ms /tan finish the task");
		await waitUntil(() => tan.mock.calls.length === 1);
		expect(tan).toHaveBeenCalledWith("finish the task");
		expect(h.mock.calls).toHaveLength(0);
	});

	for (const payload of ["plain delayed text", "/tan delayed command"]) {
		it(`does not retire live speech or restore a live submitted snapshot for ${payload}`, async () => {
			const h = harness();
			const prompt = vi.spyOn(h.session, "prompt").mockResolvedValue(true);
			const onSubmit = h.editor.onSubmit;
			h.editor.onSubmit = () => {};
			h.editor.setText("previous spoken submission");
			h.editor.submit();
			h.editor.onSubmit = onSubmit;
			await h.submit(`/defer 5ms ${payload}`);
			h.editor.setText("current operator draft");
			const speech = ["unclaimed operator speech", "accepted pending handoff"];
			const retire = vi.fn(() => {
				speech.length = 0;
				return false;
			});
			const route = vi.fn(() => {
				speech.length = 0;
				return "held" as const;
			});
			Object.assign(h.ctx, {
				liveCallActive: true,
				discardLiveSpeech: retire,
				routeLiveSubmit: route,
				shareLiveSubmit: vi.fn(),
			});
			await Bun.sleep(30);
			expect(retire).not.toHaveBeenCalled();
			expect(route).not.toHaveBeenCalled();
			expect(speech).toEqual(["unclaimed operator speech", "accepted pending handoff"]);
			expect(h.editor.getText()).toBe("current operator draft");
			if (payload.startsWith("/tan")) expect(h.ctx.handleTanCommand).toHaveBeenCalledWith("delayed command");
			else expect(prompt).toHaveBeenCalledWith(payload, expect.objectContaining({ streamingBehavior: "steer" }));
		});
	}

	it("returns an unconfirmed slash command beside the current draft without restoring an older snapshot", async () => {
		const h = harness();
		const onSubmit = h.editor.onSubmit;
		h.editor.onSubmit = () => {};
		h.editor.setText("previous submission");
		h.editor.submit();
		h.editor.onSubmit = onSubmit;
		await h.submit("/defer 5ms /unknown-deferred-command");
		h.editor.setText("current operator draft");
		await Bun.sleep(30);
		expect(h.editor.getExpandedText()).toContain("/unknown-deferred-command");
		expect(h.editor.getExpandedText()).toContain("current operator draft");
		expect(h.editor.getExpandedText()).not.toContain("previous submission");
		expect(h.mock.calls).toHaveLength(0);
	});

	it("returns a nested deferred refusal to the real composer rather than an expired parent scope", async () => {
		const h = harness();
		await h.submit("/defer 5ms /defer 5ms /unknown-nested-command");
		h.editor.setText("current operator draft");
		await waitUntil(() => h.editor.getExpandedText().includes("/unknown-nested-command"));
		expect(h.editor.getExpandedText()).toContain("/unknown-nested-command");
		expect(h.editor.getExpandedText()).toContain("current operator draft");
		expect(h.mock.calls).toHaveLength(0);
	});

	it("returns a bare-command confirmation beside the operator draft", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cleanups.push(async () => resetSettingsForTest());
		cfgBareSlashCommands.set(Settings.instance, true);
		const h = harness();
		h.session.agent.appendMessage({ role: "user", content: "earlier turn", timestamp: Date.now() });
		await h.submit("/defer 5ms tan");
		h.editor.setText("current operator draft");
		await Bun.sleep(30);
		expect(h.editor.getExpandedText()).toContain("tan");
		expect(h.editor.getExpandedText()).toContain("current operator draft");
		expect(h.ctx.handleTanCommand).not.toHaveBeenCalled();
	});

	it("returns a read-only collab refusal and a busy kernel submission instead of losing deferred text", async () => {
		for (const payload of ["delayed collab text", "$p print(42)"]) {
			const h = harness();
			await h.submit(`/defer 5ms ${payload}`);
			if (payload.startsWith("$")) vi.spyOn(h.session, "isEvalLanguageRunning").mockReturnValue(true);
			else Object.assign(h.ctx, { collabGuest: { readOnly: true } });
			h.editor.setText("current operator draft");
			await Bun.sleep(30);
			expect(h.editor.getExpandedText()).toContain(payload);
			expect(h.editor.getExpandedText()).toContain("current operator draft");
			expect(h.mock.calls).toHaveLength(0);
		}
	});

	it("owns scheduled images until delivery and leaves newer image links untouched", async () => {
		const h = harness();
		const prompt = vi.spyOn(h.session, "prompt").mockResolvedValue(true);
		const deferredImage = { type: "image" as const, data: "b2xk", mimeType: "image/png" };
		const newerImage = { type: "image" as const, data: "bmV3", mimeType: "image/png" };
		h.editor.pendingImages = [deferredImage];
		h.editor.pendingImageLinks = ["deferred.png"];
		h.editor.imageLinks = h.editor.pendingImageLinks;
		await h.submit("/defer 5ms inspect [Image #1]");
		expect(h.editor.pendingImages).toEqual([]);
		h.editor.setText("current draft [Image #1]");
		h.editor.pendingImages = [newerImage];
		h.editor.pendingImageLinks = ["newer.png"];
		h.editor.imageLinks = h.editor.pendingImageLinks;
		await waitUntil(() => prompt.mock.calls.length === 1);
		expect(prompt).toHaveBeenCalledWith("inspect [Image #1]", {
			streamingBehavior: "steer",
			images: [deferredImage],
		});
		expect(h.editor.getExpandedText()).toBe("current draft [Image #1]");
		expect(h.editor.pendingImages).toEqual([newerImage]);
		expect(h.editor.pendingImageLinks).toEqual(["newer.png"]);
		expect(h.editor.imageLinks).toEqual(["newer.png"]);
	});

	it("preserves a deferred literal command's whitespace and unexpanded payload", async () => {
		const h = harness();
		const prompt = vi.spyOn(h.session, "prompt").mockResolvedValue(true);
		const payload = "  hi :) {{literal}}\nlast  ";
		await h.submit(`/defer 5ms /notice ${payload}`);
		await waitUntil(() => prompt.mock.calls.length === 1);
		expect(prompt.mock.calls[0]?.[0]).toBe(`<system-notice>\n${payload}\n</system-notice>`);
	});

	it("uses AgentSession's existing busy-message queue", async () => {
		const h = harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		h.mock.fallback = async () => {
			entered.resolve();
			await release.promise;
			return { content: ["Acknowledged"] };
		};
		const running = h.session.prompt("hold this turn");
		await entered.promise;
		try {
			await h.submit("/defer 5ms queued prose");
			await waitUntil(() => h.session.getQueuedMessages().steering.includes("queued prose"));
		} finally {
			release.resolve();
			await running;
		}
	});

	for (const payload of ["focused prose [Image #1]", "/tan main command"]) {
		it(`keeps ${payload} on its scheduling session when a subagent gains focus`, async () => {
			const h = harness();
			const focused = harness();
			const mainPrompt = vi.spyOn(h.session, "prompt").mockResolvedValue(true);
			const focusedPrompt = vi.spyOn(focused.session, "prompt").mockResolvedValue(true);
			const tan = vi.spyOn(h.ctx, "handleTanCommand");
			const image = { type: "image" as const, mimeType: "image/png", data: "Y2FwdHVyZWQ=" };
			if (!payload.startsWith("/")) h.editor.pendingImages = [image];
			await h.submit(`/defer 10ms ${payload}`);
			Object.defineProperty(h.ctx, "viewSession", { configurable: true, value: focused.session });
			Object.defineProperty(h.ctx, "focusedAgentId", { configurable: true, value: "focused-task" });
			if (payload.startsWith("/")) {
				await waitUntil(() => tan.mock.calls.length === 1);
			} else {
				await waitUntil(() => mainPrompt.mock.calls.length === 1 || focusedPrompt.mock.calls.length === 1);
				expect(mainPrompt).toHaveBeenCalledWith(payload, expect.objectContaining({ images: [image] }));
			}
			expect(focusedPrompt).not.toHaveBeenCalled();
		});
	}

	for (const transition of ["newSession", "cancel", "dispose"] as const) {
		it(`drops deferred input whose async hook outlives ${transition}`, async () => {
			const h = harness();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const finished = Promise.withResolvers<void>();
			let delivery: Promise<void> | undefined;
			const onSubmit = h.editor.onSubmit;
			h.editor.onSubmit = text => {
				const pending = Promise.resolve(onSubmit?.(text));
				if (text === "old conversation payload") delivery = pending;
				return pending;
			};
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("input", async () => {
						entered.resolve();
						await release.promise;
						finished.resolve();
						return {};
					});
				},
				h.session.sessionManager.getCwd(),
				new EventBus(),
				runtime,
				"defer-session-owner",
			);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				h.session.sessionManager.getCwd(),
				h.session.sessionManager,
				h.session.modelRegistry,
			);
			Object.defineProperty(h.session, "extensionRunner", { configurable: true, value: runner });
			await h.submit("/defer 5ms old conversation payload");
			await entered.promise;
			if (transition === "newSession") await h.session.newSession();
			else if (transition === "cancel") await h.submit("/defer cancel all");
			else h.session.beginDispose();
			h.editor.setText("new conversation draft");
			release.resolve();
			await finished.promise;
			await delivery;
			await Bun.sleep(0);
			expect(h.mock.calls).toHaveLength(0);
			expect(h.session.getQueuedMessages().steering).toEqual([]);
			expect(h.editor.getExpandedText()).toBe("new conversation draft");
		});
	}

	for (const admission of ["prompt", "steer", "followUp", "custom", "subagent"] as const) {
		it(`rejects ${admission} from a deferred slash handler resumed in a new session`, async () => {
			const h = harness();
			const child = admission === "subagent" ? harness() : undefined;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const finished = Promise.withResolvers<void>();
			const oldImage = { type: "image" as const, mimeType: "image/png", data: "b2xk" };
			const newImage = { type: "image" as const, mimeType: "image/png", data: "bmV3" };
			h.editor.pendingImages = [oldImage];
			h.editor.pendingImageLinks = ["old.png"];
			vi.spyOn(h.ctx, "handleTanCommand").mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				try {
					if (admission === "prompt") await h.session.prompt("stale handler payload");
					else if (admission === "steer") await h.session.steer("stale handler payload");
					else if (admission === "followUp") await h.session.followUp("stale handler payload");
					else if (child) await child.session.prompt("stale handler payload");
					else
						await h.session.promptCustomMessage({
							customType: "defer-owner-test",
							content: "stale handler payload",
							display: false,
							attribution: "user",
						});
				} finally {
					finished.resolve();
				}
				return true;
			});
			await h.submit("/defer 5ms /tan old command [Image #1]");
			await entered.promise;
			await h.session.newSession();
			h.editor.setText("new conversation draft");
			h.editor.pendingImages = [newImage];
			h.editor.pendingImageLinks = ["new.png"];
			h.editor.imageLinks = h.editor.pendingImageLinks;
			release.resolve();
			await finished.promise;
			await Bun.sleep(25);
			expect(h.mock.calls).toHaveLength(0);
			expect(child?.mock.calls ?? []).toHaveLength(0);
			expect(h.editor.pendingImages).toEqual([newImage]);
			expect(h.editor.pendingImageLinks).toEqual(["new.png"]);
			expect(h.editor.imageLinks).toEqual(["new.png"]);
			expect(h.session.getQueuedMessages()).toEqual(expect.objectContaining({ steering: [], followUp: [] }));
			expect(h.editor.getExpandedText()).toBe("new conversation draft");
		});
	}

	it("allows an active deferred command to delegate intentionally to another session", async () => {
		const h = harness();
		const child = harness();
		const finished = Promise.withResolvers<void>();
		vi.spyOn(h.ctx, "handleTanCommand").mockImplementation(async () => {
			await child.session.prompt("intentional child task");
			finished.resolve();
			return true;
		});
		await h.submit("/defer 5ms /tan launch child");
		await finished.promise;
		expect(h.mock.calls).toHaveLength(0);
		expect(child.mock.calls).toHaveLength(1);
	});

	for (const transition of ["newSession", "cancel"] as const) {
		it(`keeps ownership across the main-loop input handoff during ${transition}`, async () => {
			const h = harness();
			const received = Promise.withResolvers<SubmittedUserInput>();
			h.ctx.startPendingSubmission = input => ({ ...input, cancelled: false, started: false });
			h.ctx.onInputCallback = input => received.resolve(input);
			const mode = {
				markPendingSubmissionStarted: vi.fn(() => true),
				finishPendingSubmission: vi.fn(),
				showError: vi.fn(),
				checkShutdownRequested: vi.fn(async () => {}),
				skillCommands: new Map(),
				optimisticSkillMessagePending: false,
				renderOptimisticSkillMessage: vi.fn(),
				clearOptimisticSkillMessage: vi.fn(),
			};
			await h.submit("/defer 5ms old handed-off payload");
			const input = await received.promise;
			if (transition === "newSession") await h.session.newSession();
			else await h.submit("/defer cancel all");
			h.editor.setText("new conversation draft");
			await submitInteractiveInput(mode, h.session, input);
			expect(h.mock.calls).toHaveLength(0);
			expect(h.editor.getExpandedText()).toBe("new conversation draft");
			expect(mode.finishPendingSubmission).toHaveBeenCalledWith(input);
		});
	}

	it("drops custom-command prompt transformations resumed after a conversation switch", async () => {
		const h = harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		vi.spyOn(h.session, "executeCustomCommand").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			finished.resolve();
			return "old transformed payload";
		});
		h.ctx.isKnownSlashCommand = text => text === "/custom";
		await h.submit("/defer 5ms /custom");
		await entered.promise;
		await h.session.newSession();
		h.editor.setText("new conversation draft");
		release.resolve();
		await finished.promise;
		await Bun.sleep(25);
		expect(h.mock.calls).toHaveLength(0);
		expect(h.editor.getExpandedText()).toBe("new conversation draft");
	});

	it("cancels individual and all timers, including delays beyond the platform timer limit", async () => {
		const h = harness();
		await h.submit("/defer 1Y /tan too soon");
		await h.submit("/defer 10ms /tan cancelled");
		await h.submit("/defer cancel 2");
		await Bun.sleep(30);
		expect(h.ctx.handleTanCommand).not.toHaveBeenCalled();
		await h.submit("/defer cancel all");
	});

	it("cancels pending submissions at disposal and conversation changes", async () => {
		for (const end of ["dispose", "newSession"] as const) {
			const h = harness();
			await h.submit("/defer 30ms /tan stale");
			if (end === "dispose") h.session.beginDispose();
			else await h.session.newSession();
			await Bun.sleep(60);
			expect(h.ctx.handleTanCommand).not.toHaveBeenCalled();
		}
	});
});

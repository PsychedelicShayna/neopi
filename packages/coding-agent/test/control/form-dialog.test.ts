import { expect, test, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { HtmlFormDialog } from "@oh-my-pi/pi-tui/html-form/dialog";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Container } from "@oh-my-pi/pi-tui/tui";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ControlClient } from "../../src/control/client";
import { ControlHost } from "../../src/control/host";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type { ExtensionContext, ExtensionFormDialogResult } from "../../src/extensibility/extensions/types";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { makeAssistantMessage } from "../session-manager/helpers";

const queuedPrompt = "Open the queued author's form";
const html = `<form><fieldset><legend>Name</legend>
  <label><input type="radio" name="name" value="Default" checked> Default</label>
  <label><input type="radio" name="name" value="Draft"> Draft</label>
  <label><input type="radio" name="name" value="Ada"> Ada</label>
</fieldset></form>`;

test.each([
	["tool_call", "follow_up", false, "reply"],
	["tool_call", "follow_up", true, "reply"],
	["before_agent_start", "follow_up", false, "reply"],
	["before_agent_start", "follow_up", true, "reply"],
	["before_agent_start", "steer", true, "reply"],
	["before_agent_start after pane input", "follow_up", true, "reply"],
	["before_agent_start after pane input", "follow_up", false, "reply"],
	["historical error recovery", "prompt", true, "reply"],
	["tool_call", "follow_up", true, "guest wins with an edited pane"],
	["tool_call", "follow_up", true, "caller aborts with an edited pane"],
] as const)("%s Form after %s (author opted in: %p): %s", async (boundary, type, optedIn, action) => {
	const historical = boundary === "historical error recovery";
	const mirror = optedIn && !historical;
	const dir = TempDir.createSync("@pi-control-form-");
	const auth = createInMemoryAuthStorage();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const opened = Promise.withResolvers<void>();
	const result = Promise.withResolvers<ExtensionFormDialogResult | undefined>();
	const caller = new AbortController();
	const onAbandon = vi.fn();
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			const openForm = async (ctx: ExtensionContext) => {
				const answer = ctx.ui.formDialog?.(html, { signal: caller.signal, onAbandon });
				opened.resolve();
				result.resolve(await answer);
			};
			if (boundary === "historical error recovery") {
				pi.on("session_before_compact", async (event, ctx) => {
					await openForm(ctx);
					return {
						compaction: {
							summary: "Recovered the old turn.",
							shortSummary: undefined,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			} else if (boundary.startsWith("before_agent_start")) {
				pi.on("before_agent_start", async (event, ctx) => {
					if (event.prompt === queuedPrompt) await openForm(ctx);
				});
			} else {
				pi.on("tool_call", (_event, ctx) => openForm(ctx));
			}
		},
		dir.path(),
		new EventBus(),
		runtime,
		"form-dialog-test",
	);
	const modelRegistry = new ModelRegistry(auth, dir.join("models.yml"));
	const manager = SessionManager.inMemory(dir.path());
	const extensionRunner = new ExtensionRunner([extension], runtime, dir.path(), manager, modelRegistry);
	const model = createMockModel({ provider: "anthropic", responses: [] });
	if (historical) {
		const olderAnswer = { ...makeAssistantMessage(), api: model.api, model: model.id };
		manager.appendMessage({
			role: "user",
			content: `Earlier turn.${" history".repeat(1_000)}`,
			timestamp: Date.now(),
		});
		manager.appendMessage(olderAnswer);
		manager.appendMessage({ role: "user", content: "The failed turn", timestamp: Date.now() });
		manager.appendMessage({
			...olderAnswer,
			content: [],
			stopReason: "error",
			errorMessage: "prompt is too long: 300000 tokens > 200000 maximum",
			usage: { ...olderAnswer.usage, input: 300_000 },
		});
	} else {
		model.push(async () => {
			entered.resolve();
			await release.promise;
			return { content: ["First turn finished."] };
		});
	}
	if (boundary === "tool_call") {
		model.push({ content: [{ type: "toolCall", id: "open-form", name: "test_trigger", arguments: {} }] });
	}
	model.push({ content: ["Done."] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, messages: manager.buildSessionContext({ transcript: historical }).messages },
		streamFn: model.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		modelRegistry,
		extensionRunner,
		settings: Settings.isolated({
			"compaction.enabled": historical,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdTokens": 20_000,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"retry.enabled": false,
		}),
	});
	const host = new ControlHost({ session, role: "tui", dir: dir.path(), tmuxPane: null });
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	const askContainer = new Container();
	editorContainer.addChild(editor);
	let focused: Component = editor;
	const ui = new ExtensionUiController({
		session,
		sessionManager: manager,
		editor,
		editorContainer,
		askContainer,
		ui: {
			getFocused: () => focused,
			setFocus: (component: Component) => {
				focused = component;
			},
			requestRender: () => {},
		},
		setToolUIContext: () => {},
		syncComposerShape: () => {},
		syncExtensionLinks: () => {},
		showExtensionError: () => {},
		closeLinkBrowser: () => {},
		statusLine: { setAwaitingAnswer: () => {} },
	} as unknown as InteractiveModeContext);
	const clients: ControlClient[] = [];
	try {
		auth.keys.setRuntime("anthropic", "test-key");
		await ui.initHooksAndCustomTools();
		agent.setTools([
			{
				name: "test_trigger",
				label: "Test extension hook",
				description: "Trigger the extension's tool-call hook",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [], details: undefined }),
			},
		]);
		await host.start();
		const metadata = host.publication!.metadata();
		const a = new ControlClient({ metadata, label: "first author", kind: "cli" });
		const b = new ControlClient({ metadata, label: "queued author", kind: "cli" });
		clients.push(a, b);
		await Promise.all(clients.map(client => client.connect()));
		const frames = clients.map(client => {
			const seen: Record<string, unknown>[] = [];
			client.onEvent(frame => {
				if (frame.type === "extension_ui_request" && frame.method === "form") seen.push(frame);
			});
			return seen;
		});
		expect((await a.request({ type: "set_form_dialog", enabled: true })).success).toBe(true);
		if (optedIn) expect((await b.request({ type: "set_form_dialog", enabled: true })).success).toBe(true);
		if (!historical) {
			expect((await a.request({ type: "prompt", message: "Start the run" })).success).toBe(true);
			await withTimeout(entered.promise, 2_000, "The first provider request did not start");
		}
		if (boundary === "before_agent_start after pane input") host.bumpHuman();
		const submission = b.request({ type, message: queuedPrompt });
		void submission.catch(() => {});
		if (!historical) expect((await submission).success).toBe(true);
		release.resolve();
		await withTimeout(opened.promise, 2_000, "The extension did not open its form");

		await Promise.all(clients.map(client => client.request({ type: "state" })));
		expect(frames.map(seen => seen.length)).toEqual([0, mirror ? 1 : 0]);
		expect(askContainer.children).toHaveLength(1);
		if (historical) expect(model.calls).toHaveLength(0);
		if (action !== "reply") {
			expect(ui.focusAsk()).toBe(true);
			const dialog = askContainer.children[0];
			if (!(dialog instanceof HtmlFormDialog)) throw new Error("Expected the pane form");
			dialog.handleInput("\x1b[B");
			dialog.handleInput(" ");
			expect(dialog.data()).toEqual({ name: "Draft" });
		}
		if (action === "caller aborts with an edited pane") {
			caller.abort();
			expect(await result.promise).toBeUndefined();
			expect(onAbandon).toHaveBeenCalledTimes(1);
			expect(onAbandon).toHaveBeenCalledWith({ data: { name: "Draft" }, notes: [] });
		} else if (mirror) {
			const { id } = frames[1][0];
			await a.request({ type: "extension_ui_response", id, cancelled: true });
			expect(askContainer.children).toHaveLength(1);
			await b.request({ type: "extension_ui_response", id, data: { name: "Ada" } });
			expect(await result.promise).toEqual({ data: { name: "Ada" } });
			expect(onAbandon).not.toHaveBeenCalled();
		} else {
			expect(ui.cancelAsk()).toBe(true);
			expect(await result.promise).toBeUndefined();
		}
		if (historical) expect((await submission).success).toBe(true);
		await session.waitForIdle();
		if (!historical) {
			expect(model.calls[1]?.context.messages).toContainEqual(
				expect.objectContaining({
					role: "user",
					content: [expect.objectContaining({ type: "text", text: queuedPrompt })],
				}),
			);
		}
		expect(askContainer.children).toHaveLength(0);
	} finally {
		release.resolve();
		ui.cancelAsk();
		for (const client of clients) client.close();
		await host.close();
		await session.dispose();
		auth.close();
		await dir.remove();
	}
});

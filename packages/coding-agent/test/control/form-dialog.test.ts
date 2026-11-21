import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
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
import type { ExtensionFormDialogResult } from "../../src/extensibility/extensions/types";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

test.each([false, true])("routes extension Form to the queued author (opted in: %p)", async optedIn => {
	const dir = TempDir.createSync("@pi-control-form-");
	const auth = createInMemoryAuthStorage();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const opened = Promise.withResolvers<void>();
	const result = Promise.withResolvers<ExtensionFormDialogResult | undefined>();
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.on("tool_call", async (_event, ctx) => {
				const answer = ctx.ui.formDialog?.(`<form><input name="name" required></form>`);
				opened.resolve();
				result.resolve(await answer);
			});
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
	model.push(async () => {
		entered.resolve();
		await release.promise;
		return { content: ["First turn finished."] };
	});
	model.push({ content: [{ type: "toolCall", id: "open-form", name: "test_trigger", arguments: {} }] });
	model.push({ content: ["Done."] });
	const agent = new Agent({ getApiKey: () => "test-key", initialState: { model }, streamFn: model.stream });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		modelRegistry,
		extensionRunner,
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
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
		expect((await a.request({ type: "prompt", message: "Start the run" })).success).toBe(true);
		await withTimeout(entered.promise, 2_000, "The first provider request did not start");
		expect((await b.request({ type: "follow_up", message: "Open the queued author's form" })).success).toBe(true);
		release.resolve();
		await withTimeout(opened.promise, 2_000, "The extension did not open its form");
		expect(model.calls[1]?.context.messages).toContainEqual(
			expect.objectContaining({
				role: "user",
				content: [expect.objectContaining({ type: "text", text: "Open the queued author's form" })],
			}),
		);
		await Promise.all(clients.map(client => client.request({ type: "state" })));
		expect(frames.map(seen => seen.length)).toEqual([0, optedIn ? 1 : 0]);
		expect(askContainer.children).toHaveLength(1);
		if (optedIn) {
			const { id } = frames[1][0];
			await a.request({ type: "extension_ui_response", id, cancelled: true });
			expect(askContainer.children).toHaveLength(1);
			await b.request({ type: "extension_ui_response", id, data: { name: "Ada" } });
			expect(await result.promise).toEqual({ data: { name: "Ada" } });
		} else {
			expect(ui.cancelAsk()).toBe(true);
			expect(await result.promise).toBeUndefined();
		}
		await session.waitForIdle();
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

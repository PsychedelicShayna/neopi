import { expect, test, vi } from "bun:test";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
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
import type {
	ExtensionAskDialogResult,
	ExtensionContext,
	ExtensionUIContext,
} from "../../src/extensibility/extensions/types";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentSession } from "../../src/session/agent-session";
import { cfgCompactionEnabled } from "../../src/session/context-settings";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const queuedPrompt = "Open the queued author's Ask";
const questions = [{ id: "pick", question: "Which one?", options: [{ label: "One" }, { label: "Two" }] }];
const answers = [{ id: "pick", selectedOptions: ["Two"] }];

function includesQueuedPrompt(messages: readonly AgentMessage[]): boolean {
	return messages.some(
		message =>
			message.role === "user" &&
			(typeof message.content === "string"
				? message.content === queuedPrompt
				: message.content.some(block => block.type === "text" && block.text === queuedPrompt)),
	);
}

const noopTool: AgentTool = {
	name: "test_continue",
	label: "Continue",
	description: "Keep the turn going past its maintenance boundary",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [], details: undefined }),
};

test.each([
	["before_agent_start", "follow_up", "opted in", "author"],
	["before_agent_start", "follow_up", "opted out", "pane"],
	["before_agent_start", "steer", "opted in", "author"],
	["before_agent_start", "follow_up", "disconnected", "pane"],
	["before_agent_start", "follow_up", "mixed origins", "pane"],
	["before_agent_start", "follow_up", "missing origin", "pane"],
	["idle queue drain", "steer", "opted in", "author"],
	["context", "follow_up", "opted in", "author"],
	["context", "follow_up", "mixed origins", "pane"],
	["context", "steer", "opted out", "pane"],
	["live context", "steer", "opted in", "author"],
	["context sync", "follow_up", "opted in", "author"],
	["before dequeue", "steer", "opted in", "pane"],
	["model gate", "follow_up", "opted in", "author"],
	["turn_start", "follow_up", "opted in", "pane"],
	["turn_end", "follow_up", "opted in", "pane"],
	["mid-run compaction", "follow_up", "opted in", "author"],
	["mid-run compaction completion", "follow_up", "opted in", "author"],
	["post-error compaction", "follow_up", "opted in", "pane"],
	["compaction before continuation", "steer", "opted in", "pane"],
	["automatic retry with no new input", "no queue", "opted in", "pane"],
	["automatic retry with new steering", "steer", "opted in", "author"],
] as const)("%s opens Ask on the %s path (%s): %s", async (boundary, type, opt, target) => {
	const retry = boundary.startsWith("automatic retry");
	const preContinue = boundary === "compaction before continuation";
	const midRun = boundary.startsWith("mid-run compaction");
	const compact = midRun || boundary === "post-error compaction";
	const primary = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const fallback = getBundledModel("openai", "gpt-4o-mini")!;
	const opensForAuthor = target === "author";
	const config = {
		...(preContinue ? {} : { "compaction.enabled": compact }),
		"compaction.methodOrder": ["soft"],
		"compaction.thresholdTokens": 20_000,
		"compaction.keepRecentTokens": 1,
		"compaction.midTurnEnabled": midRun,
		"compaction.autoContinue": false,
		"retry.enabled": retry || preContinue,
		"retry.baseDelayMs": 1,
		"retry.maxRetries": 1,
		"retry.modelFallback": preContinue,
		...(preContinue
			? {
					"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
					"retry.fallbackRevertPolicy": "cooldown-expiry",
				}
			: {}),
		"features.unexpectedStopDetection": "none",
	};
	const dir = TempDir.createSync("@pi-control-ask-provenance-");
	const auth = createInMemoryAuthStorage();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const opened = Promise.withResolvers<void>();
	const result = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
	const runtime = new ExtensionRuntime();
	let opening = false;
	async function ask(open: NonNullable<ExtensionUIContext["askDialog"]>) {
		if (opening) return;
		opening = true;
		const answer = open(questions);
		opened.resolve();
		result.resolve(await answer);
	}
	const extension = await loadExtensionFromFactory(
		pi => {
			if (boundary === "before_agent_start" || boundary === "idle queue drain") {
				pi.on("before_agent_start", async (event, ctx) => {
					if (event.prompt.includes(queuedPrompt) && ctx.ui.askDialog) await ask(ctx.ui.askDialog);
				});
			}
			if (boundary === "context" || boundary === "live context" || retry) {
				pi.on("context", async (event, ctx) => {
					const match =
						boundary === "automatic retry with no new input"
							? model.calls.length === 1
							: includesQueuedPrompt(event.messages) &&
								(boundary !== "live context" || event.messages.length === 1);
					if (match && ctx.ui.askDialog) await ask(ctx.ui.askDialog);
				});
			}
			if (boundary === "turn_start" || boundary === "turn_end") {
				let turns = 0;
				const onTurn = async (_event: unknown, ctx: ExtensionContext) => {
					if (++turns === 2 && ctx.ui.askDialog) await ask(ctx.ui.askDialog);
				};
				if (boundary === "turn_start") pi.on("turn_start", onTurn);
				else pi.on("turn_end", onTurn);
			}
			if (compact || preContinue) {
				pi.on("session_before_compact", async (event, ctx) => {
					if (boundary !== "mid-run compaction completion" && ctx.ui.askDialog) await ask(ctx.ui.askDialog);
					return {
						compaction: {
							summary: "Compacted in the extension.",
							shortSummary: undefined,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
				if (boundary === "mid-run compaction completion") {
					pi.on("session_compact", async (_event, ctx) => {
						if (ctx.ui.askDialog) await ask(ctx.ui.askDialog);
					});
				}
			}
		},
		dir.path(),
		new EventBus(),
		runtime,
		"ask-provenance-test",
	);
	const modelRegistry = new ModelRegistry(auth, dir.join("models.yml"));
	const manager = SessionManager.inMemory(dir.path());
	const extensionRunner = new ExtensionRunner([extension], runtime, dir.path(), manager, modelRegistry);
	const model = createMockModel({ provider: "anthropic", responses: [] });
	if (preContinue) model.push({ content: ["Completed older turn."] });
	model.push(async () => {
		entered.resolve();
		await release.promise;
		if (preContinue) return { throw: "rate limit exceeded retry-after-ms=200" };
		if (retry) return { throw: "503 service unavailable: overloaded_error" };
		return { content: ["First turn finished."] };
	});
	if (preContinue) {
		model.push({ content: ["Recovered on the fallback."], usage: { input: 30_000 } });
	} else if (midRun) {
		model.push({
			content: [{ type: "toolCall", id: "maintenance", name: noopTool.name, arguments: {} }],
			usage: { input: 30_000 },
		});
	} else if (boundary === "post-error compaction") {
		model.push({ stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" });
	}
	model.push({ content: ["Done."] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: preContinue ? primary : model },
		transformContext: (messages, signal) => extensionRunner.emitContext(messages, signal),
		streamFn: async (requestedModel, context, options) => {
			if (preContinue && model.calls.length === 3 && !opening) {
				opened.reject(new Error(`Skipped compaction before sampling ${requestedModel.id}`));
			}
			if ((boundary === "live context" || boundary === "before dequeue") && !opening) {
				const live = options?.liveSteering;
				const signal = options?.signal;
				if (!live || !signal) throw new Error("Provider did not offer live steering");
				entered.resolve();
				await live.wait(signal);
				(await live.claim(signal))?.accept();
			}
			return model.stream(requestedModel, context, options);
		},
	});
	const settings = Settings.isolated(config);
	if (preContinue) cfgCompactionEnabled.set(settings, false);
	if (preContinue) settings.setModelRole("default", `${primary.provider}/${primary.id}`);
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		modelRegistry,
		extensionRunner,
		settings,
		toolRegistry: new Map([[noopTool.name, noopTool]]),
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
	let now = Date.now();
	const clock = preContinue ? vi.spyOn(Date, "now").mockImplementation(() => now) : undefined;
	try {
		auth.keys.setRuntime("anthropic", "test-key");
		if (preContinue) auth.keys.setRuntime("openai", "test-key");
		await ui.initHooksAndCustomTools();
		if (boundary === "before dequeue") {
			agent.addBeforeQueuedMessageDequeueHook(() => ask(questions => ui.showAskDialog(questions)));
		}
		if (boundary === "context sync") {
			agent.addBeforeModelCallHook(async (_signal, context) => {
				if (includesQueuedPrompt(context.messages)) await ask(questions => ui.showAskDialog(questions));
			});
		}
		if (boundary === "model gate") {
			agent.setBeforeModelCall(async context => {
				if (includesQueuedPrompt(context.messages)) await ask(questions => ui.showAskDialog(questions));
			});
		}
		await host.start();
		const metadata = host.publication!.metadata();
		const a = new ControlClient({ metadata, label: "starter", kind: "cli" });
		const b = new ControlClient({ metadata, label: "queued author", kind: "cli" });
		clients.push(a, b);
		await Promise.all(clients.map(client => client.connect()));
		const frames = clients.map(client => {
			const seen: Record<string, unknown>[] = [];
			client.onEvent(frame => {
				if (frame.type === "extension_ui_request" && frame.method === "ask") seen.push(frame);
			});
			return seen;
		});
		expect((await a.request({ type: "set_ask_dialog", enabled: true })).success).toBe(true);
		if (opt !== "opted out") expect((await b.request({ type: "set_ask_dialog", enabled: true })).success).toBe(true);
		if (preContinue) {
			await session.prompt(`Seed an earlier turn.${" historical".repeat(24_000)}`);
			expect(model.calls).toHaveLength(1);
		}
		if (boundary !== "idle queue drain") {
			expect(await a.request({ type: "prompt", message: "Start the run" })).toMatchObject({ success: true });
			await withTimeout(entered.promise, 2_000, "The first provider call did not start");
		}
		if (preContinue) {
			release.resolve();
			await session.waitForIdle();
			expect(session.model?.id).toBe(fallback.id);
			now += 31 * 60_000;
			cfgCompactionEnabled.set(settings, true);
			expect(cfgCompactionEnabled.get(settings)).toBe(true);
		}
		if (opt === "mixed origins" || opt === "missing origin") session.setFollowUpMode("all", false);
		if (type !== "no queue") expect((await b.request({ type, message: queuedPrompt })).success).toBe(true);
		if (opt === "mixed origins") {
			expect((await a.request({ type: "follow_up", message: "Also include input from A" })).success).toBe(true);
		} else if (opt === "missing origin") {
			await session.followUp("Also include input from the pane");
		} else if (opt === "disconnected") {
			await expect(b.request({ type: "bye" }, 1_000)).rejects.toThrow("closed");
		}
		release.resolve();
		await withTimeout(opened.promise, 3_000, "The extension did not open its Ask");
		if (preContinue) {
			expect(session.model?.id).toBe(primary.id);
			expect(model.calls).toHaveLength(3);
		}
		const active = opt === "disconnected" ? [a] : clients;
		await Promise.all(active.map(client => client.request({ type: "state" })));
		expect(frames.map(seen => seen.length)).toEqual([0, opensForAuthor ? 1 : 0]);
		expect(askContainer.children).toHaveLength(1);
		if (opensForAuthor) {
			expect((await b.request({ type: "extension_ui_response", id: frames[1][0].id, answers })).success).toBe(true);
			expect(await result.promise).toMatchObject({ kind: "submit", results: answers });
		} else {
			expect(ui.cancelAsk()).toBe(true);
			await result.promise;
		}
		await session.waitForIdle();
	} finally {
		clock?.mockRestore();
		release.resolve();
		ui.cancelAsk();
		for (const client of clients) client.close();
		await host.close();
		await session.dispose();
		auth.close();
		await dir.remove();
	}
});

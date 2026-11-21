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
import { ControlHost, currentControlCaller } from "../../src/control/host";
import { callerConnectionToken } from "../../src/control/registry";
import { authenticateHello } from "../../src/control/server";
import { attachTuiPresenter } from "../../src/control/tui-presenter";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type {
	ExtensionAskDialogResult,
	ExtensionContext,
	ExtensionFormDialogResult,
	ExtensionUIContext,
} from "../../src/extensibility/extensions/types";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import { InputController } from "../../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentSession } from "../../src/session/agent-session";
import { cfgCompactionEnabled } from "../../src/session/context-settings";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { makeAssistantMessage } from "../session-manager/helpers";

const queuedPrompt = "Open the queued author's Ask";
const questions = [{ id: "pick", question: "Which one?", options: [{ label: "One" }, { label: "Two" }] }];
const formHtml = '<form><label>Which one? <input name="pick"></label><button>Submit</button></form>';
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

const cases = [
	["before_agent_start", "follow_up", "opted in", "author"],
	["before_agent_start", "follow_up", "opted out", "pane"],
	["before_agent_start", "steer", "opted in", "author"],
	["before_agent_start after pane input", "follow_up", "opted in", "author"],
	["before_agent_start after pane input", "follow_up", "opted out", "pane"],
	["before_agent_start before pane input", "follow_up", "opted in", "back off"],
	["delivered caller ancestry", "follow_up", "opted in", "author"],
	["delivered caller ancestry", "follow_up", "disconnected", "pane"],
	["historical error recovery", "prompt", "opted in", "pane"],
	["direct prompt preparation", "prompt", "opted in", "author"],
	["direct prompt compaction", "prompt", "opted in", "author"],
	["unscoped input hook", "prompt", "opted in", "pane"],
	["direct command", "prompt", "opted in", "author"],
	["detached prompt preparation", "prompt", "opted in", "pane", "ask"],
	["detached prompt preparation", "prompt", "opted in", "pane", "form"],
	["detached pre-prompt compaction", "prompt", "opted in", "pane", "ask"],
	["detached pre-prompt compaction", "prompt", "opted in", "pane", "form"],
	["consumed terminal slash", "slash", "opted in", "pane", "ask"],
	["consumed terminal slash", "slash", "opted in", "pane", "form"],
	["terminal extension command", "slash", "opted in", "author", "ask"],
	["terminal extension command", "slash", "opted in", "author", "form"],
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
] as const;
const dialogCases = cases.map(
	([boundary, type, opt, target, dialog = "ask"]) => [boundary, dialog, type, opt, target] as const,
);

test.each(dialogCases)("%s opens %s on the %s path (%s): %s", async (boundary, dialog, type, opt, target) => {
	const retry = boundary.startsWith("automatic retry");
	const preContinue = boundary === "compaction before continuation";
	const midRun = boundary.startsWith("mid-run compaction");
	const compact = midRun || boundary === "post-error compaction";
	const historical = boundary === "historical error recovery";
	const detachedPreparation = boundary.startsWith("detached ");
	const directCompaction = boundary === "direct prompt compaction" || boundary === "detached pre-prompt compaction";
	const unscoped = boundary === "unscoped input hook";
	const checkAncestry = boundary === "delivered caller ancestry";
	const direct = type === "prompt";
	const terminalSlash = type === "slash";
	const consumedSlash = boundary === "consumed terminal slash";
	const command = "/ask-test";
	const primary = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const fallback = getBundledModel("openai", "gpt-4o-mini")!;
	const opensForAuthor = target === "author";
	const config = {
		...(preContinue ? {} : { "compaction.enabled": compact || historical || directCompaction }),
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
	const firstModelCall = Promise.withResolvers<void>();
	const opened = Promise.withResolvers<void>();
	const result = Promise.withResolvers<ExtensionAskDialogResult | ExtensionFormDialogResult | undefined>();
	const runtime = new ExtensionRuntime();
	let commandCalls = 0;
	let opening = false;
	async function ask(open: NonNullable<ExtensionUIContext["askDialog"]>) {
		if (opening) return;
		opening = true;
		const answer = open(questions);
		opened.resolve();
		result.resolve(await answer);
	}
	async function openDialog(ui: ExtensionUIContext) {
		if (dialog === "ask") {
			if (ui.askDialog) await ask(ui.askDialog);
		} else if (!opening && ui.formDialog) {
			opening = true;
			const answer = ui.formDialog(formHtml);
			opened.resolve();
			result.resolve(await answer);
		}
	}
	let callerChain: string[] | undefined;
	let ancestorRejection: string | undefined;
	const extension = await loadExtensionFromFactory(
		pi => {
			if (
				boundary.startsWith("before_agent_start") ||
				boundary === "idle queue drain" ||
				boundary === "direct prompt preparation"
			) {
				pi.on("before_agent_start", async (event, ctx) => {
					if (event.prompt.includes(queuedPrompt) && ctx.ui.askDialog) await ask(ctx.ui.askDialog);
				});
			}
			if (boundary === "detached prompt preparation") {
				pi.on("before_agent_start", (event, ctx) => {
					if (event.prompt === queuedPrompt) {
						void entered.promise.then(() => openDialog(ctx.ui)).catch(opened.reject);
					}
				});
			}
			if (unscoped) {
				pi.on("input", (event, ctx) => {
					if (event.text !== queuedPrompt) return;
					const open = ctx.ui.askDialog;
					if (open) void entered.promise.then(() => ask(open)).catch(opened.reject);
				});
			}
			if (consumedSlash) {
				pi.on("input", async (event, ctx) => {
					if (event.text !== command) return;
					await openDialog(ctx.ui);
					return { handled: true };
				});
			}
			if (boundary === "direct command" || terminalSlash) {
				pi.registerCommand(command.slice(1), {
					description: "Open an Ask directly",
					handler: async (_args, ctx) => {
						commandCalls++;
						await openDialog(ctx.ui);
					},
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
			if (compact || preContinue || historical || directCompaction) {
				pi.on("session_before_compact", async (event, ctx) => {
					if (boundary === "detached pre-prompt compaction") {
						void entered.promise.then(() => openDialog(ctx.ui)).catch(opened.reject);
					} else if (boundary !== "mid-run compaction completion" && ctx.ui.askDialog) {
						await ask(ctx.ui.askDialog);
					}
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
	if (detachedPreparation) {
		model.push(() => {
			firstModelCall.resolve();
			return { content: ["B finished successfully."] };
		});
	}
	if ((!direct && !terminalSlash) || unscoped || detachedPreparation) {
		model.push(async () => {
			entered.resolve();
			await release.promise;
			if (preContinue) return { throw: "rate limit exceeded retry-after-ms=200" };
			if (retry) return { throw: "503 service unavailable: overloaded_error" };
			return { content: ["First turn finished."] };
		});
	}
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
	if (historical || directCompaction) {
		const olderAnswer = { ...makeAssistantMessage(), api: model.api, model: model.id };
		manager.appendMessage({
			role: "user",
			content: `Earlier turn.${" history".repeat(directCompaction ? 24_000 : 1_000)}`,
			timestamp: Date.now(),
		});
		manager.appendMessage(olderAnswer);
	}
	if (historical) {
		const olderAnswer = { ...makeAssistantMessage(), api: model.api, model: model.id };
		manager.appendMessage({ role: "user", content: "The failed turn", timestamp: Date.now() });
		manager.appendMessage({
			...olderAnswer,
			content: [],
			stopReason: "error",
			errorMessage: "prompt is too long: 300000 tokens > 200000 maximum",
			usage: { ...olderAnswer.usage, input: 300_000 },
		});
	}
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: preContinue ? primary : model,
			messages: manager.buildSessionContext({ transcript: historical }).messages,
		},
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
	const ctx = {
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
		isKnownSlashCommand: (text: string) => text === command,
		skillCommands: new Map(),
		fileSlashCommands: new Set(),
		showExtensionError: () => {},
		showStatus: () => {},
		closeLinkBrowser: () => {},
		statusLine: { setAwaitingAnswer: () => {} },
	} as unknown as InteractiveModeContext;
	const ui = new ExtensionUiController(ctx);
	if (terminalSlash) {
		new InputController(ctx).setupEditorSubmitHandler();
		attachTuiPresenter(host, {
			session,
			editor,
			ui: {
				injectInput: () => {},
				getDebugDocument: () => [],
				overlayStack: [],
				hasOverlay: () => false,
			},
			runAction: () => false,
			rewind: async () => ({ status: "unchanged" }),
			notify: () => {},
			dictationBusy: () => false,
			viewTarget: () => undefined,
		});
	}
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
		if (checkAncestry) {
			agent.setBeforeModelCall(async context => {
				if (!includesQueuedPrompt(context.messages)) return;
				const caller = currentControlCaller();
				callerChain = caller?.controlChain;
				if (caller && opt === "disconnected") {
					const failure = await authenticateHello(
						{
							token: "test-ancestor-token",
							client: {
								label: "nested ctl",
								kind: "tool",
								callerInstanceId: caller.instanceId,
								callerConnectionToken: callerConnectionToken(caller.token, "author-ancestor", caller.instanceId),
								controlChain: caller.controlChain,
							},
							override: { allowNested: true },
						},
						{ instanceId: "author-ancestor", token: "test-ancestor-token", registryDir: dir.path() },
						{ pid: process.pid, uid: process.getuid!(), gid: process.getgid!() },
					);
					ancestorRejection = failure?.code;
				}
				await ask(questions => ui.showAskDialog(questions));
			});
		}
		await host.start();
		const metadata = host.publication!.metadata();
		const a = new ControlClient({
			metadata,
			label: "starter",
			kind: "cli",
			allowNested: true,
			controlChain: ["starter-ancestor"],
		});
		const b = new ControlClient({
			metadata,
			label: "queued author",
			kind: "cli",
			allowNested: true,
			controlChain: ["author-ancestor"],
		});
		clients.push(a, b);
		await Promise.all(clients.map(client => client.connect()));
		const frames = clients.map(client => {
			const seen: Record<string, unknown>[] = [];
			client.onEvent(frame => {
				if (frame.type === "extension_ui_request" && frame.method === dialog) seen.push(frame);
			});
			return seen;
		});
		const optIn = { type: dialog === "ask" ? "set_ask_dialog" : "set_form_dialog", enabled: true } as const;
		expect((await a.request(optIn)).success).toBe(true);
		if (opt !== "opted out" && !(checkAncestry && opt === "disconnected")) {
			expect((await b.request(optIn)).success).toBe(true);
		}
		if (preContinue) {
			await session.prompt(`Seed an earlier turn.${" historical".repeat(24_000)}`);
			expect(model.calls).toHaveLength(1);
		}
		if (!direct && !terminalSlash && boundary !== "idle queue drain") {
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
		if (boundary === "before_agent_start after pane input") host.bumpHuman();
		if (detachedPreparation) {
			expect((await b.request({ type: "prompt", message: queuedPrompt })).success).toBe(true);
			await withTimeout(firstModelCall.promise, 2_000, "B's provider call did not start");
			await session.waitForIdle();
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "B finished successfully." }],
			});
			expect((await a.request({ type: "prompt", message: "Start A's turn" })).success).toBe(true);
			await withTimeout(entered.promise, 2_000, "A's provider call did not start");
		}
		const submission = terminalSlash
			? b.request({ type: "slash", text: command })
			: direct && !detachedPreparation
				? b.request({ type: "prompt", message: boundary === "direct command" ? command : queuedPrompt })
				: undefined;
		void submission?.catch(() => {});
		if (!direct && !terminalSlash && type !== "no queue") {
			expect((await b.request({ type, message: queuedPrompt })).success).toBe(true);
		}
		if (boundary === "before_agent_start before pane input") host.bumpHuman();
		if (opt === "mixed origins") {
			expect((await a.request({ type: "follow_up", message: "Also include input from A" })).success).toBe(true);
		} else if (opt === "missing origin") {
			await session.followUp("Also include input from the pane");
		} else if (opt === "disconnected") {
			await expect(b.request({ type: "bye" }, 1_000)).rejects.toThrow("closed");
		}
		if (!unscoped && !detachedPreparation) release.resolve();
		await withTimeout(opened.promise, 3_000, `The extension did not open its ${dialog} dialog`);
		if (preContinue) {
			expect(session.model?.id).toBe(primary.id);
			expect(model.calls).toHaveLength(3);
		}
		const active = opt === "disconnected" ? [a] : clients;
		await Promise.all(active.map(client => client.request({ type: "state" })));
		expect(frames.map(seen => seen.length)).toEqual([0, opensForAuthor ? 1 : 0]);
		if (checkAncestry) {
			if (opt === "disconnected") expect(ancestorRejection).toBe("cycle");
			expect(callerChain).toEqual(["author-ancestor"]);
		}
		if (target === "back off") {
			expect(await withTimeout(result.promise, 1_000, "A stale dialog did not back off")).toBeUndefined();
			expect(askContainer.children).toHaveLength(0);
			await session.waitForIdle();
			return;
		}
		expect(askContainer.children).toHaveLength(1);
		if (opensForAuthor) {
			const response = dialog === "form" ? { data: { pick: "Two" } } : { answers };
			const reply = await b.request({ type: "extension_ui_response", id: frames[1][0].id, ...response });
			expect(reply.success).toBe(true);
			const expected = dialog === "form" ? response : { kind: "submit", results: answers };
			expect(await result.promise).toMatchObject(expected);
		} else {
			expect(ui.cancelAsk()).toBe(true);
			await result.promise;
		}
		release.resolve();
		if (submission) expect((await submission).success).toBe(true);
		if (terminalSlash) expect(commandCalls).toBe(consumedSlash ? 0 : 1);
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

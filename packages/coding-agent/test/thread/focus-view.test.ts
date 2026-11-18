/**
 * The TUI's focused-agent view over a session homed on a subagent worker: the
 * real focus controller, composer submit path, and status line drive the main
 * thread's `RemoteAgentSession` mirror of a real worker-homed `AgentSession`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type AgentMessage, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { isRecord } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { EventController } from "../../src/modes/controllers/event-controller";
import { InputController } from "../../src/modes/controllers/input-controller";
import { SessionFocusController } from "../../src/modes/controllers/session-focus-controller";
import { statusLineHost } from "../../src/modes/status-line-host";
import type { InteractiveModeContext } from "../../src/modes/types";
import { buildRpcSessionState } from "../../src/modes/rpc/rpc-session-state";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionEvent } from "../../src/session/agent-session-events";
import type { AgentViewSession } from "../../src/session/agent-session-handle";
import { AuthStorage } from "../../src/session/auth-storage";
import type { RestoredQueuedMessage } from "../../src/session/agent-session-types";
import type { SessionEntriesDelta, SessionRestorableQueue } from "../../src/thread/session-mirror";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { authService } from "../../src/thread/services/auth";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import { cfgTasksTodoClearDelay, cfgToolsApprovalMode } from "../../src/tools/settings";
import { TODO_HUD_STATE_CUSTOM_TYPE } from "../../src/tools/todo";
import * as runStatus from "../../src/utils/run-status";
import type { FocusProbe, FocusProbeGlobals } from "../fixtures/focus-view-worker";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const cleanups: Array<() => unknown> = [];
let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

/** Main registry the worker sessions are built over (their worker registry mirrors it). */
async function mainRegistry(): Promise<ModelRegistry> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-focus-view-"));
	const modelsPath = path.join(dir, "models.json");
	await Bun.write(modelsPath, JSON.stringify({ providers: {} }));
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	cleanups.push(async () => {
		authStorage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return new ModelRegistry(authStorage, modelsPath, { cacheDbPath: path.join(dir, "models.db") });
}

async function startWorker(): Promise<FocusProbe> {
	const probe = Promise.withResolvers<FocusProbe>();
	const probeService: ThreadService = {
		name: "focus-probe",
		globals: (): FocusProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/focus-view-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, authService, asyncJobsThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return probe.promise;
}

/**
 * Wait for a condition fed by another thread (mirror patches, worker-side
 * state). No in-process clock reaches a real worker; this waits on the
 * condition itself, never a guessed duration.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function mirrorOf(id: string): RemoteAgentSession {
	const session = AgentRegistry.global().get(id)?.session;
	if (!(session instanceof RemoteAgentSession)) throw new Error(`expected a worker session mirror for ${id}`);
	return session;
}

function textOf(message: AgentMessage | null | undefined): string {
	if (!message || !("content" in message)) return "";
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
	}
	return text;
}

interface FocusHarness {
	controller: SessionFocusController;
	events: AgentSessionEvent[];
	/** Mirror `isStreaming` as each `agent_start` reached the view (the state patch must precede the event). */
	streamingAtAgentStart: boolean[];
	transcripts: Array<Array<{ role: string; text: string }>>;
	statusSessions: AgentViewSession[];
	todoSources: AgentViewSession[];
}

/** The focus controller over a minimal interactive context that records what the view received. */
function focusHarness(): FocusHarness {
	const events: AgentSessionEvent[] = [];
	const streamingAtAgentStart: boolean[] = [];
	const transcripts: Array<Array<{ role: string; text: string }>> = [];
	const statusSessions: AgentViewSession[] = [];
	const todoSources: AgentViewSession[] = [];
	const main = {
		isStreaming: false,
		agent: { state: { streamMessage: null } },
		subscribe: () => () => {},
		settleInFlightMessagePersistence: async () => {},
		activeToolExecutionUpdates: () => [],
	};
	const focus: { controller?: SessionFocusController } = {};
	const ctx = {
		session: main,
		get viewSession() {
			return focus.controller?.target ?? main;
		},
		unsubscribe: undefined,
		eventController: {
			handleEvent: async (event: AgentSessionEvent) => {
				if (event.type === "agent_start")
					streamingAtAgentStart.push(focus.controller?.target?.isStreaming === true);
				events.push(event);
			},
			resetTranscriptAnchors() {},
			restorePendingToolResults() {},
			runSerialized: (run: () => Promise<void>) => run(),
			markViewIdle() {},
		},
		statusLine: {
			setSession: (session: AgentViewSession) => {
				statusSessions.push(session);
			},
			invalidate() {},
		},
		clearTransientSessionUi() {},
		renderInitialMessages: async () => {
			const view = focus.controller?.target;
			if (!view) return;
			transcripts.push(
				view.buildTranscriptSessionContext().messages.map(message => ({
					role: message.role,
					text: textOf(message),
				})),
			);
		},
		reloadTodos: async (source: AgentViewSession) => {
			todoSources.push(source);
		},
		updatePendingMessagesDisplay() {},
		updateEditorBorderColor() {},
		syncIdleMaintenanceView() {},
		ui: { requestRender() {}, requestComponentRender() {} },
		showStatus() {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
	const controller = new SessionFocusController(ctx, AgentRegistry.global(), () => AgentLifecycleManager.global());
	focus.controller = controller;
	cleanups.push(() => controller.dispose());
	return { controller, events, streamingAtAgentStart, transcripts, statusSessions, todoSources };
}

/** The composer's submit path with `view` focused, as `InputController` dispatches it. */
function composerFor(view: AgentViewSession, focusedAgentId: string) {
	let editorText = "";
	const showError = vi.fn();
	const editor = {
		setText(text: string) {
			editorText = text;
		},
		getText: () => editorText,
		setCollapsedText(text: string) {
			editorText = text;
		},
		composerChips: () => [],
		addToHistory: vi.fn(),
		imageLinks: undefined as (string | undefined)[] | undefined,
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		clearDraft() {
			editorText = "";
		},
		onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
	};
	const ctx = {
		editor,
		ui: { requestRender() {} },
		session: { isStreaming: false, isCompacting: false, extensionRunner: undefined, queuedMessageCount: 0 },
		viewSession: view,
		focusedAgentId,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		showError,
		updatePendingMessagesDisplay() {},
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	return {
		showError,
		async submit(text: string): Promise<void> {
			editor.setText(text);
			await editor.onSubmit?.(text);
		},
	};
}

describe("focused view of a worker-homed agent session", () => {
	it("attaches, rebuilds the transcript, streams deltas in order, and steers from the composer", async () => {
		const probe = await startWorker();
		await probe.open("W1", await mainRegistry(), {});
		await probe.prompt("W1", "first question");
		const remote = mirrorOf("W1");
		const view = focusHarness();

		await view.controller.focusAgent("W1");
		expect(view.controller.target).toBe(remote);
		expect(view.statusSessions).toEqual([remote]);
		expect(view.todoSources).toEqual([remote]);
		expect(view.transcripts).toEqual([
			[
				{ role: "user", text: "first question" },
				{ role: "assistant", text: "ok" },
			],
		]);

		const running = probe.prompt("W1", "[hold] stream please");
		await waitFor(() =>
			view.events.some(event => event.type === "message_update" && textOf(event.message) === "Hel"),
		);
		expect(view.streamingAtAgentStart).toEqual([true]);
		expect(remote.isStreaming).toBe(true);
		expect(textOf(remote.agent.state.streamMessage)).toBe("Hel");

		const composer = composerFor(remote, "W1");
		await composer.submit("steer from the composer");
		expect(composer.showError).not.toHaveBeenCalled();
		expect((await probe.report("W1")).steering).toEqual(["steer from the composer"]);
		await waitFor(() => remote.getQueuedMessages().steering.includes("steer from the composer"));

		await probe.release();
		await running;
		await waitFor(() => !remote.isStreaming);
		const updates = view.events.flatMap(event => (event.type === "message_update" ? [textOf(event.message)] : []));
		expect(updates.indexOf("Hel")).toBeLessThan(updates.indexOf("Hello"));
		const types = view.events.map(event => event.type);
		expect(types.indexOf("message_start")).toBeLessThan(types.indexOf("message_update"));
		expect(types.lastIndexOf("message_end")).toBeLessThan(types.lastIndexOf("agent_end"));
		expect((await probe.report("W1")).userTexts).toContain("steer from the composer");
		await waitFor(() => remote.getQueuedMessages().steering.length === 0);
		const transcript = remote.buildTranscriptSessionContext().messages.map(message => textOf(message));
		expect(transcript).toContain("Hello");
		expect(transcript).toContain("steer from the composer");
	});

	it("keeps non-streaming admission busy until its cancelled loader releases", async () => {
		const probe = await startWorker();
		await probe.open("W1", await mainRegistry(), {});
		const remote = mirrorOf("W1");
		const events: string[] = [];
		cleanups.push(remote.subscribe(event => events.push(event.type)));
		await waitFor(() => remote.controlState !== undefined);
		expect(buildRpcSessionState(remote, { includeDump: false }).isSettled).toBe(true);

		await probe.holdAdmission("W1");
		const running = probe.prompt("W1", "cancel this before delivery");
		try {
			await waitFor(async () => (await probe.report("W1")).hasAdmittedSubmission);
			expect((await probe.report("W1")).isStreaming).toBe(false);
			await waitFor(() => remote.controlState?.isSettled === false);
			const held = buildRpcSessionState(remote, { includeDump: false });
			expect(held.isStreaming).toBe(false);
			expect(held.isSettled).toBe(false);

			await probe.abort("W1");
			expect((await probe.report("W1")).hasAdmittedSubmission).toBe(true);
			expect(buildRpcSessionState(remote, { includeDump: false }).isSettled).toBe(false);
		} finally {
			await probe.releaseAdmission("W1");
			await running;
		}

		await waitFor(() => remote.controlState?.isSettled === true);
		expect((await probe.report("W1")).userTexts).toEqual([]);
		expect(events).not.toContain("agent_start");

		await probe.prompt("W1", "retry after cancellation");
		expect((await probe.report("W1")).userTexts).toEqual(["retry after cancellation"]);
		expect(events.filter(type => type === "agent_start")).toEqual(["agent_start"]);
	});

	it("requires a first watch, keeps child flags distinct, and reads native flushed active time", async () => {
		const probe = await startWorker();
		const registry = await mainRegistry();
		await probe.open("W1", registry, { "stt.enabled": false });
		await probe.open("W2", registry, { "stt.enabled": true });
		const first = mirrorOf("W1");
		const second = mirrorOf("W2");
		expect(first.controlState).toBeUndefined();
		expect(second.controlState).toBeUndefined();
		expect(() => buildRpcSessionState(first, { includeDump: false })).toThrow(Error);
		const unsubscribeFirst = first.subscribe(() => {});
		const unsubscribeSecond = second.subscribe(() => {});
		cleanups.push(unsubscribeFirst, unsubscribeSecond);
		await waitFor(() => first.controlState !== undefined && second.controlState !== undefined);
		expect(buildRpcSessionState(first, { includeDump: false }).dictationEnabled).toBe(false);
		expect(buildRpcSessionState(second, { includeDump: false }).dictationEnabled).toBe(true);

		const running = probe.prompt("W1", "[hold] native active time");
		try {
			await waitFor(() => textOf(first.agent.state.streamMessage) === "Hel");
			const flushed = first.getActiveTimeMs();
			await Bun.sleep(30);
			expect(first.getActiveTimeMs()).toBe(flushed);
			expect((await probe.report("W1")).activeTimeMs).toBeGreaterThan(flushed);
			expect(second.getActiveTimeMs()).toBe(0);
		} finally {
			await probe.release();
			await running;
		}
		const stopped = await probe.report("W1");
		await waitFor(() => first.getActiveTimeMs() === stopped.activeTimeMs);
		expect(buildRpcSessionState(first, { includeDump: false }).activeTimeMs).toBe(stopped.activeTimeMs);
	});

	it("publishes idle owned job transitions without progress floods or sibling leakage", async () => {
		const registry = await mainRegistry();
		const probe = await startWorker();
		const jobs = new AsyncJobManager({});
		cleanups.push(() => jobs.dispose({ timeoutMs: 100 }));
		await probe.open("W1", registry, {}, jobs);
		await probe.open("W2", registry, {}, jobs);
		const remote = mirrorOf("W1");
		const apply = remote.applyViewPatch.bind(remote);
		let viewPatches = 0;
		const observer = vi.spyOn(remote, "applyViewPatch").mockImplementation(patch => {
			viewPatches++;
			apply(patch);
		});
		cleanups.push(() => observer.mockRestore());
		const unsubscribe = remote.subscribe(() => {});
		cleanups.push(unsubscribe);
		await waitFor(() => remote.controlState?.isSettled === true);
		const siblingJob = await probe.startIdleJob("W2");
		await probe.report("W1");
		expect(buildRpcSessionState(remote, { includeDump: false }).runningJobCount).toBe(0);
		const ownJob = await probe.startIdleJob("W1");
		await waitFor(() => remote.controlState?.runningJobCount === 1);
		const working = buildRpcSessionState(remote, { includeDump: false });
		expect(working.isStreaming).toBe(false);
		expect(working.hasPendingAsyncWork).toBe(true);
		expect(working.isSettled).toBe(false);
		expect(jobs.cancel(ownJob, { ownerId: "W2" })).toBe(false);
		viewPatches = 0;
		await probe.progressIdleJob(ownJob, "progress one");
		await probe.progressIdleJob(ownJob, "progress two");
		await probe.report("W1");
		expect(viewPatches).toBe(0);
		expect(jobs.cancel(ownJob, { ownerId: "W1" }, "idle-job-stop")).toBe(true);
		await jobs.getJob(ownJob)?.promise;
		await waitFor(() => remote.controlState?.runningJobCount === 0 && remote.controlState.isSettled);
		expect((await probe.report("W1")).jobAborts).toEqual([{ jobId: ownJob, reason: "idle-job-stop" }]);
		expect(jobs.getJob(siblingJob)?.status).toBe("running");
		unsubscribe();
		await probe.report("W1");
		viewPatches = 0;
		const unwatchedJob = await probe.startIdleJob("W1");
		await probe.progressIdleJob(unwatchedJob, "unwatched progress");
		expect(jobs.cancel(unwatchedJob, { ownerId: "W1" })).toBe(true);
		await jobs.getJob(unwatchedJob)?.promise;
		await probe.report("W1");
		expect(viewPatches).toBe(0);
	});

	it("refocuses with the entries the worker appended while unwatched, without re-sending the earlier ones", async () => {
		const probe = await startWorker();
		await probe.open("W1", await mainRegistry(), {});
		await probe.prompt("W1", "first question");
		const remote = mirrorOf("W1");
		const applyView = remote.applyView.bind(remote);
		const snapshots: Array<SessionEntriesDelta | undefined> = [];
		const onView = vi.spyOn(remote, "applyView").mockImplementation((state, entries) => {
			snapshots.push(entries);
			applyView(state, entries);
		});
		cleanups.push(() => onView.mockRestore());
		const view = focusHarness();

		await view.controller.focusAgent("W1");
		await view.controller.unfocus();
		await probe.prompt("W1", "second question");
		await view.controller.focusAgent("W1");

		expect(view.transcripts.at(-1)).toEqual([
			{ role: "user", text: "first question" },
			{ role: "assistant", text: "ok" },
			{ role: "user", text: "second question" },
			{ role: "assistant", text: "ok" },
		]);
		const refocus = snapshots.at(-1);
		expect(refocus?.kind).toBe("append");
		const shipped = refocus?.entries.flatMap(entry => (entry.type === "message" ? [textOf(entry.message)] : []));
		expect(shipped).toEqual(["second question", "ok"]);
	});

	it("cycles the thinking level on both sides and redraws the status line from the mirror", async () => {
		const probe = await startWorker();
		await probe.open("W1", await mainRegistry(), {});
		const remote = mirrorOf("W1");
		const view = focusHarness();
		await view.controller.focusAgent("W1");
		expect(remote.getAvailableEffortSelectors()).toContain(ThinkingLevel.Low);
		remote.setThinkingLevel(ThinkingLevel.Low);
		await waitFor(() => remote.state.thinkingLevel === ThinkingLevel.Low);

		const statusLine = new StatusLineComponent(remote, statusLineHost);
		cleanups.push(() => statusLine.dispose());
		statusLine.updateSettings({
			preset: "custom",
			leftSegments: ["model"],
			rightSegments: [],
			separator: "none",
			transparent: true,
		});
		const render = (): string => stripVTControlCharacters(statusLine.getTopBorder(160).content);
		const before = render();
		expect(before).toContain("Sonnet");
		const selectors = remote.getAvailableEffortSelectors();
		const expected = selectors[selectors.indexOf(ThinkingLevel.Low) + 1];
		const next = remote.cycleThinkingLevel();
		expect(next).toBe(expected);
		expect(remote.configuredThinkingLevel()).toBe(next);
		await waitFor(async () => (await probe.report("W1")).configuredThinkingLevel === next);
		await waitFor(() => remote.state.thinkingLevel === next);
		expect(view.events.some(event => event.type === "thinking_level_changed")).toBe(true);
		statusLine.invalidate();
		expect(render()).not.toBe(before);
	});

	it("persists todo HUD writes into the worker session and serves the child's settings on main", async () => {
		const probe = await startWorker();
		await probe.open("W1", await mainRegistry(), { "tasks.todoClearDelay": 7 });
		const remote = mirrorOf("W1");
		const view = focusHarness();
		await view.controller.focusAgent("W1");
		expect(cfgTasksTodoClearDelay.get(remote.settings)).toBe(7);

		const phases: TodoPhase[] = [{ name: "Plan", tasks: [{ content: "write test", status: "completed" }] }];
		remote.setTodoPhases(phases);
		expect(remote.getTodoPhases()).toEqual(phases);
		const data = { phases, visibility: "dismissed" };
		remote.sessionManager.appendCustomEntry(TODO_HUD_STATE_CUSTOM_TYPE, data);
		const optimistic = remote.sessionManager.getBranch().at(-1);
		expect(optimistic?.type === "custom" ? optimistic.customType : undefined).toBe(TODO_HUD_STATE_CUSTOM_TYPE);
		await remote.sessionManager.flush();

		const report = await probe.report("W1");
		expect(report.customEntries).toEqual([{ customType: TODO_HUD_STATE_CUSTOM_TYPE, data }]);
		expect(report.todoPhases).toEqual(phases);
		const mirrored = remote.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === TODO_HUD_STATE_CUSTOM_TYPE);
		expect(mirrored).toHaveLength(1);
		expect(mirrored[0]?.id.startsWith("pending:")).toBe(false);
		expect(remote.sessionManager.getLeafId()).toBe(mirrored[0]?.id ?? null);
	});
});

describe("queued messages of a focused worker-homed session", () => {
	/** W1 running a held turn with `text` queued behind it as a follow-up, as the watched mirror shows it. */
	async function followUpBehindHeldTurn(text: string) {
		const probe = await startWorker();
		await probe.open("W1", await mainRegistry(), {});
		const remote = mirrorOf("W1");
		cleanups.push(remote.subscribe(() => {}));
		// Every view patch passes through `onViewPatch`; tests may intercept it and call `applyViewPatch`.
		const applyViewPatch = remote.applyViewPatch.bind(remote);
		let published: SessionRestorableQueue | undefined;
		const onViewPatch = vi.spyOn(remote, "applyViewPatch").mockImplementation(patch => {
			if (patch.restorableQueue) published = patch.restorableQueue;
			applyViewPatch(patch);
		});
		cleanups.push(() => onViewPatch.mockRestore());
		const running = probe.prompt("W1", "[hold] working");
		await waitFor(() => textOf(remote.agent.state.streamMessage) === "Hel");
		await remote.prompt(text, { streamingBehavior: "followUp" });
		await waitFor(() => remote.getQueuedMessages().followUp.includes(text));
		if (!published) throw new Error("the follow-up never reached the mirror");
		return { probe, remote, running, applyViewPatch, onViewPatch, published };
	}

	it("restores a follow-up popped as the held turn ends, and the worker never delivers it", async () => {
		const { probe, remote, running } = await followUpBehindHeldTurn("take this back");

		// The release reaches the worker first: its turn ends and its loop reaches for the
		// follow-up while main, in the same tick, restores it from a mirror still listing it.
		const released = probe.release();
		expect(remote.popLastQueuedMessage()?.text).toBe("take this back");
		await released;
		await running;

		const report = await probe.report("W1");
		expect(report.userTexts).toEqual(["[hold] working"]);
		expect(report.followUp).toEqual([]);
		await waitFor(() => !remote.isStreaming && remote.getQueuedMessages().followUp.length === 0);
		expect(remote.popLastQueuedMessage()).toBeUndefined();
	});

	it("does not restore a follow-up the worker claimed before the mirror caught up", async () => {
		const { probe, remote, running, applyViewPatch, onViewPatch } = await followUpBehindHeldTurn("deliver this");
		const popped: Array<RestoredQueuedMessage | undefined> = [];
		onViewPatch.mockImplementation(patch => {
			// The first queue change after the release: the worker has taken the follow-up for
			// delivery, and the mirror, until this patch lands, still lists it.
			if (popped.length === 0 && patch.restorableQueue) popped.push(remote.popLastQueuedMessage());
			applyViewPatch(patch);
		});

		await probe.release();
		await running;

		expect(popped).toEqual([undefined]);
		const report = await probe.report("W1");
		expect(report.userTexts).toEqual(["[hold] working", "deliver this"]);
		expect(report.followUp).toEqual([]);
	});

	it("keeps a restored follow-up unrestorable when a stale queue brings it back as the worker drops it", async () => {
		const { probe, remote, running, applyViewPatch, published } = await followUpBehindHeldTurn("restore me once");
		const restored: Array<string | undefined> = [];
		const claimQueued = remote.claimQueued.bind(remote);
		const onClaim = vi.spyOn(remote, "claimQueued").mockImplementation(ids => {
			if (restored.length === 0) {
				// Alt+Up lands just before the worker's claim; then a queue the worker published
				// before it learned of the restore brings the entry back into the mirror.
				restored.push(remote.popLastQueuedMessage()?.text);
				applyViewPatch({ restorableQueue: published });
			}
			const vetoed = claimQueued(ids);
			// Alt+Up again, before the worker's queue without the dropped entry arrives.
			if (restored.length === 1) restored.push(remote.popLastQueuedMessage()?.text);
			return vetoed;
		});
		cleanups.push(() => onClaim.mockRestore());

		await probe.release();
		await running;

		expect(restored).toEqual(["restore me once", undefined]);
		const report = await probe.report("W1");
		expect(report.userTexts).toEqual(["[hold] working"]);
		expect(report.followUp).toEqual([]);
	});

	it("forgets a restored follow-up the worker had already dropped for good", async () => {
		const { probe, remote, running, published } = await followUpBehindHeldTurn("dropped meanwhile");
		const id = published.followUp.at(-1)?.id;
		if (id === undefined) throw new Error("the follow-up was published without an id");

		// The worker drops the follow-up for good while main restores it from a mirror still listing it.
		const dropped = probe.dropFollowUps("W1");
		expect(remote.popLastQueuedMessage()?.text).toBe("dropped meanwhile");
		await dropped;
		// The worker answered the restore before this report.
		await probe.report("W1");

		// Nothing stays armed against the retired entry: were its id ever claimed, it would pass.
		expect(remote.claimQueued([id])).toEqual([]);
		await probe.release();
		await running;
		expect((await probe.report("W1")).userTexts).toEqual(["[hold] working"]);
	});
});

describe("run status of a focused worker-homed session", () => {
	function toolStart(toolCallId: string, args: Record<string, unknown>): AgentSessionEvent {
		return { type: "tool_execution_start", toolCallId, toolName: "bash", args } as unknown as AgentSessionEvent;
	}

	it("reads approval prompts from the child's settings and the approvals its runner holds", async () => {
		const probe = await startWorker();
		await probe.open("W1", await mainRegistry(), { "tools.approvalMode": "always-ask" });
		const remote = mirrorOf("W1");
		cleanups.push(remote.subscribe(() => {}));
		await waitFor(() => cfgToolsApprovalMode.get(remote.settings) === "always-ask");
		// No main ancestor holds the child's tools here; serve an exec-tier tool for the lookup.
		const bash = { name: "bash", label: "Bash" } as unknown as AgentTool;
		const getTool = vi.spyOn(remote, "getToolByName").mockReturnValue(bash);
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		cleanups.push(
			() => getTool.mockRestore(),
			() => report.mockRestore(),
		);
		const controller = new EventController(
			createInteractiveModeContext({ viewSession: remote as unknown as AgentSession }),
		);

		// Main runs yolo; the child asks before exec-tier calls.
		await controller.handleEvent({ type: "agent_start" } as AgentSessionEvent);
		await controller.handleEvent(toolStart("bash-1", { command: "make" }));
		expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "blocked", kind: "permission" }));

		// The user approved bash for the rest of the child's session: the child's wrapper no longer asks.
		await probe.grantSessionApproval("W1", "bash\0exec");
		await probe.prompt("W1", "carry on");
		await waitFor(() => remote.hasSessionApproval("bash\0exec"));
		report.mockClear();
		await controller.handleEvent(toolStart("bash-2", { command: "make" }));
		expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ state: "blocked" }));

		// The child's conversation tier of `always-ask-cached` grants is served from the mirror too.
		const grant = "read\0/tmp/focus-view-grant";
		expect(remote.getApprovalGrants().present([grant]).has(grant)).toBe(false);
		await probe.recordSessionGrant("W1", grant);
		await probe.prompt("W1", "once more");
		await waitFor(() => remote.getApprovalGrants().present([grant]).has(grant));
	});
});

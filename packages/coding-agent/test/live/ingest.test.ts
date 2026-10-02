import { describe, expect, test, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import type { AgentSession } from "../../src/session/agent-session";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { EventBus, emitSubagentFrame } from "../../src/utils/event-bus";
import {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
} from "../../src/task/types";
import {
	LIVE_INGEST_DEFAULTS,
	type LiveIngestPersonaSettings,
	type LiveIngestSettingsSource,
} from "../../src/live/ingest-settings";
import { LiveIngest } from "../../src/live/ingest";
import type { ClassifierInput, ClassifierResult, ClassifierSelection } from "../../src/live/ingest-classifier";
import type { CatalogIo } from "../../src/live/model-catalog";

const catalog = (recommendation: "never" | "avoid" | "ok" | null = "never") =>
	JSON.stringify({
		schemaVersion: 1,
		effortLevels: ["low", "medium", "high", "xhigh", "max"],
		metrics: Object.fromEntries(
			["economy", "performance", "stability", "speed"].map(key => [key, { scale: "0-5", meaning: "operator" }]),
		),
		models: {
			"openai-codex/gpt-6-astra": {
				family: "GPT-6",
				behavior: "",
				notes: "",
				efforts: {
					max: { economy: null, performance: null, stability: null, speed: null, recommendation, reason: "" },
				},
			},
		},
	});
const flush = async () => {
	for (let index = 0; index < 8; index++) await Promise.resolve();
};

function harness(
	overrides: Partial<LiveIngestPersonaSettings> = {},
	classify?: (
		input: ClassifierInput,
		options: { signal: AbortSignal; selection: ClassifierSelection; onPromptStart: () => void },
	) => Promise<ClassifierResult>,
	catalogIo?: CatalogIo,
	classifierRuntime?: { settings?: Settings; models?: ClassifierSelection["model"][] },
) {
	let now = 10_000;
	const timers = new Map<number, { when: number; fn: () => void }>();
	let nextTimer = 0;
	const advance = async (ms: number) => {
		const end = now + ms;
		for (;;) {
			const due = [...timers].filter(([, t]) => t.when <= end).sort((a, b) => a[1].when - b[1].when)[0];
			if (!due) break;
			now = due[1].when;
			timers.delete(due[0]);
			due[1].fn();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		}
		now = end;
	};
	let current = {
		...LIVE_INGEST_DEFAULTS,
		rescoreIntervalMs: 0,
		effortAlerts: false,
		...overrides,
	} as LiveIngestPersonaSettings;
	const listeners = new Set<(next: LiveIngestPersonaSettings, previous: LiveIngestPersonaSettings) => void>();
	const settings = {
		get: () => current,
		listen: (fn: (next: LiveIngestPersonaSettings, previous: LiveIngestPersonaSettings) => void) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	} as unknown as LiveIngestSettingsSource;
	const change = (patch: Partial<LiveIngestPersonaSettings>) => {
		const previous = current;
		current = { ...current, ...patch };
		for (const fn of listeners) fn(current, previous);
	};
	const sessionListeners = new Set<(event: any) => void>();
	const haiku = getBundledModel("anthropic", "claude-haiku-4-5")!;
	const classifierSettings =
		classifierRuntime?.settings ?? Settings.isolated({ modelRoles: { classifier: "anthropic/claude-haiku-4-5" } });
	const models = classifierRuntime?.models ?? [haiku];
	const session = {
		subscribe: (fn: (event: any) => void) => {
			sessionListeners.add(fn);
			return () => sessionListeners.delete(fn);
		},
		messages: [],
		settings: classifierSettings,
		modelRegistry: { getAvailable: () => models, standardContextWindow: () => 200000 },
	} as unknown as AgentSession;
	const registry = new AgentRegistry();
	registry.register({ id: "main", displayName: "main", kind: "main", session, status: "running" });
	const bus = new EventBus();
	const spoken: Array<{ text: string; kind: string; guard: () => boolean; settle?: () => void }> = [];
	const commentary: string[] = [];
	const overflow: Array<{
		render: () => { text: string; receiptId: number };
		guard: () => boolean;
		receipt: (id: number, ok: boolean) => void;
	}> = [];
	const sink = {
		appendSpeakableContext: (text: string, kind = "report", guard = () => true, settle?: () => void) => {
			spoken.push({ text, kind, guard, settle });
			return true;
		},
		appendCommentaryContext: (text: string) => {
			commentary.push(text);
		},
		appendOverflowAlertContext: (
			render: () => { text: string; receiptId: number },
			guard: () => boolean,
			receipt: (id: number, ok: boolean) => void,
		) => {
			overflow.push({ render, guard, receipt });
			return true;
		},
	};
	const ingest = new LiveIngest({
		session,
		registry,
		subagentEventBus: bus,
		settings,
		sink: sink as any,
		catalogIo,
		extractAssistantText: m =>
			m.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join(""),
		now: () => now,
		setTimer: (fn, ms) => {
			const id = ++nextTimer;
			timers.set(id, { fn, when: now + ms });
			return () => {
				timers.delete(id);
			};
		},
		classify: classify && ((input, options) => classify(input, options)),
	});
	const child = (id: string, parentId = "main", kind: "sub" | "advisor" = "sub") =>
		registry.register({ id, displayName: id, kind, parentId, session: null, status: "running" });
	const start = (
		token: string,
		id = token,
		depth = 1,
		model?: string,
		effort?: string,
		runKind: "spawn" | "wake" | "followUp" = "spawn",
	) => {
		const frame = {
			id,
			runToken: token,
			depth,
			runKind,
			agent: id,
			agentSource: "bundled",
			index: 0,
			status: "started",
			runEffectiveModelIdentity: model,
			runEffectiveThinkingLevel: effort,
		} satisfies SubagentLifecyclePayload;
		emitSubagentFrame(bus, bus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, frame);
		return frame;
	};
	const terminal = (
		frame: SubagentLifecyclePayload,
		status: "completed" | "failed" | "aborted" = "completed",
		outcomeExcerpt = "done",
	) => emitSubagentFrame(bus, bus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, { ...frame, status, outcomeExcerpt });
	const progress = (token: string, id = token, model?: string, effort?: string, owned = true) =>
		emitSubagentFrame(bus, bus, TASK_SUBAGENT_PROGRESS_CHANNEL, {
			runToken: token,
			owned,
			agent: id,
			agentSource: "task",
			index: 0,
			task: "test",
			progress: { recentOutput: ["new output"], resolvedModel: "historical-max", resolvedThinkingLevel: "max" },
			runEffectiveModelIdentity: model,
			runEffectiveThinkingLevel: effort,
		});
	const message = (
		token: string,
		type: "message_update" | "message_end",
		thinking: string,
		text = "",
		owned = true,
		stopReason?: string,
	) =>
		bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id: token,
			runToken: token,
			owned,
			event: {
				type,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking },
						{ type: "text", text },
					],
					stopReason,
				},
			},
		});
	return {
		ingest,
		bus,
		registry,
		session,
		spoken,
		commentary,
		overflow,
		settings,
		change,
		child,
		start,
		terminal,
		progress,
		message,
		advance,
		timers,
		now: () => now,
		emit: (event: any) => {
			for (const fn of sessionListeners) fn(event);
		},
	};
}

describe("live ingest", () => {
	test("IRC source windows, labels and independent toggles", async () => {
		const h = harness();
		h.ingest.attach();
		const incoming = { customType: "irc:incoming" } as any,
			relay = { customType: "irc:relay" } as any;
		for (let i = 0; i < 10; i++) expect(h.ingest.ircRelayTransform(incoming, `message ${i}`)).toBe(`message ${i}`);
		expect(h.ingest.ircRelayTransform(incoming, "blocked")).toBeUndefined();
		expect(h.ingest.ircRelayTransform(relay, "peer")).toBe("peer");
		await h.advance(60_001);
		expect(h.ingest.ircRelayTransform(incoming, "next")).toBe("(1 earlier updates skipped) next");
		h.change({ ircPeers: false });
		expect(h.ingest.ircRelayTransform(relay, "hidden")).toBeUndefined();
		h.ingest.detach();
		expect(h.ingest.ircRelayTransform(relay, "identity")).toBe("identity");
	});
	test("batched starts, depth policy, all-run tracking, guarded reports and ceiling", async () => {
		const h = harness({ voicedSlotsByDepth: [2, 1], subagentMaxDepth: 2, subagentClassifier: false });
		h.ingest.attach();
		h.child("parent");
		h.child("grandchild", "parent");
		h.child("too-deep", "grandchild");
		const a = h.start("a", "parent"),
			b = h.start("b", "grandchild", 2),
			c = h.start("c", "too-deep", 3);
		await h.advance(5_000);
		expect(h.spoken.filter(s => s.text.includes("Subagents started"))).toHaveLength(1);
		expect(h.spoken[0].text).toContain("parent");
		expect(h.spoken[0].text).toContain("grandchild");
		expect(h.spoken[0].text).not.toContain("too-deep");
		h.terminal(b, "failed", "actual failure");
		h.terminal(a, "aborted");
		h.terminal(c);
		expect(h.spoken.some(s => s.text.includes("(failed) actual failure"))).toBe(true);
		expect(h.spoken.some(s => s.text.includes("was aborted"))).toBe(true);
		expect(h.spoken.some(s => s.text.includes("too-deep") && s.text.includes("report"))).toBe(false);
		h.ingest.detach();
		expect(h.timers.size).toBe(0);
	});
	test("owned current attribution alone authorizes class and owned reasoning/progress", async () => {
		const h = harness({ subagentClassifier: false });
		h.ingest.attach();
		h.child("worker");
		const frame = h.start("one", "worker", 1, undefined, undefined);
		h.progress("one", "worker", undefined, undefined, false);
		h.progress("one", "worker");
		await h.advance(5_000);
		expect(h.spoken[0].text).not.toContain("class X");
		h.progress("one", "worker", "openai-codex/gpt-6-sol", "high");
		h.message("one", "message_update", "reason ".repeat(45) + "First sentence. " + "reason ".repeat(15), "", false);
		expect(h.spoken.filter(s => s.kind === "thinking")).toHaveLength(0);
		h.message("one", "message_update", "reason ".repeat(45) + "First sentence. " + "reason ".repeat(15));
		expect(h.spoken.filter(s => s.kind === "thinking")).toHaveLength(1);
		h.message("one", "message_end", "", "working", true, "toolUse");
		expect(h.commentary.some(s => s.includes("Subagent worker progress: working"))).toBe(true);
		h.terminal(frame);
		h.ingest.detach();
	});
	test("score batches capture whole roster and reject stale same-token attribution", async () => {
		const requests: ClassifierInput[] = [];
		let release!: (result: ClassifierResult) => void;
		const h = harness({ classifierQuietMs: 100, voicedSlotsByDepth: [1] }, input => {
			requests.push(input);
			return new Promise(resolve => {
				release = resolve;
			});
		});
		h.ingest.attach();
		h.child("one");
		h.child("two");
		h.start("A", "one", 1, "sol", "high");
		await h.advance(100);
		expect(requests).toHaveLength(1);
		h.start("B", "two", 1, "sol", "high");
		h.progress("A", "one", "sol", "max");
		release({ scores: new Map([["A", 1]]) });
		await Promise.resolve();
		await Promise.resolve();
		await h.advance(100);
		expect(requests).toHaveLength(2);
		expect(requests[1].agents.map(r => r.token)).toEqual(["A", "B"]);
		release({
			scores: new Map([
				["A", 0.1],
				["B", 0.9],
			]),
		});
		await Promise.resolve();
		await Promise.resolve();
		h.ingest.detach();
	});
	test("periodic rescore and voiced-change cue use the captured roster without a new spawn", async () => {
		const inputs: ClassifierInput[] = [];
		let index = 0;
		const h = harness(
			{ classifierQuietMs: 0, rescoreIntervalMs: 60_000, voicedSlotsByDepth: [1], startAnnounceQuietMs: 1 },
			async input => {
				inputs.push(input);
				index++;
				return {
					scores: new Map(
						index === 1
							? [
									["A", 0.9],
									["B", 0.1],
								]
							: [
									["A", 0.1],
									["B", 0.9],
								],
					),
				};
			},
		);
		h.ingest.attach();
		h.child("a");
		h.child("b");
		h.start("A", "a");
		h.start("B", "b");
		await h.advance(0);
		await h.advance(5_000);
		expect(inputs).toHaveLength(1);
		await h.advance(60_000);
		await h.advance(5_000);
		expect(inputs.length).toBeGreaterThanOrEqual(2);
		expect(inputs.at(-1)!.agents.map(r => r.token)).toEqual(["A", "B"]);
		expect(h.spoken.some(s => s.text.includes("Now tracking b") && s.text.includes("released a"))).toBe(true);
		h.ingest.detach();
	});
	test("scores all ten runs before choosing the eight voiced reports", async () => {
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const requests: ClassifierInput[] = [];
		const h = harness(
			{ classifierQuietMs: 100, voicedSlotsByDepth: [8], startAnnounceQuietMs: 10_000 },
			async input => {
				requests.push(input);
				return { scores: new Map(input.agents.map((agent, index) => [agent.token, (index + 1) / 10])) };
			},
		);
		h.ingest.attach();
		const frames: SubagentLifecyclePayload[] = [];
		for (let index = 0; index < 10; index++) {
			const id = `worker-${index}`;
			h.child(id);
			frames.push(h.start(`T${index}`, id, 1, "openai-codex/gpt-6-sol", "high"));
		}
		await h.advance(100);
		expect(requests).toHaveLength(1);
		expect(requests[0].agents.map(agent => agent.token)).toEqual(frames.map(frame => frame.runToken));
		expect(debug).toHaveBeenCalledWith("live ingest: classified 10 subagents");
		h.terminal(frames[0], "completed", "low zero");
		h.terminal(frames[1], "completed", "low one");
		expect(h.spoken.some(item => item.text.includes("low zero") || item.text.includes("low one"))).toBe(false);
		for (const frame of frames.slice(2)) h.terminal(frame, "completed", `accepted ${frame.runToken}`);
		const reports = h.spoken.filter(item => item.text.startsWith("Subagent report"));
		expect(reports).toHaveLength(8);
		expect(reports.map(item => item.text)).toEqual(
			expect.arrayContaining(frames.slice(2).map(frame => expect.stringContaining(`accepted ${frame.runToken}`))),
		);
		debug.mockRestore();
		h.ingest.detach();
	});
	test("snapshots active runs and starts a fresh epoch after an aborted classifier drains", async () => {
		const first = Promise.withResolvers<ClassifierResult>();
		const calls: Array<{ input: ClassifierInput; signal: AbortSignal }> = [];
		const h = harness({ classifierQuietMs: 100 }, async (input, options) => {
			calls.push({ input, signal: options.signal });
			if (calls.length === 1) return first.promise;
			return { scores: new Map(input.agents.map(agent => [agent.token, 0.7])) };
		});
		h.child("one");
		h.start("A", "one", 1, "openai-codex/gpt-6-sol", "high");
		h.ingest.attach();
		await h.advance(100);
		expect(calls).toHaveLength(1);
		expect(calls[0].input.agents.map(agent => agent.token)).toEqual(["A"]);
		h.change({ subagents: false });
		expect(calls[0].signal.aborted).toBe(true);
		h.child("two");
		h.start("B", "two", 1, "openai-codex/gpt-6-sol", "high");
		h.change({ subagents: true });
		await h.advance(100);
		expect(calls).toHaveLength(1);
		first.resolve({ scores: new Map([["A", 1]]) });
		await flush();
		await h.advance(0);
		expect(calls).toHaveLength(2);
		expect(calls[1].signal.aborted).toBe(false);
		expect(calls[1].input.agents.map(agent => agent.token)).toEqual(["A", "B"]);
		h.ingest.detach();
	});
	test("recency activity promotes an older high-score run at the trailing boundary", async () => {
		const h = harness({ subagentClassifier: false, classifierQuietMs: 0, voicedSlotsByDepth: [1] }, async input => ({
			scores: new Map(input.agents.map(agent => [agent.token, agent.token === "A" ? 0.9 : 0.8])),
		}));
		h.ingest.attach();
		h.child("older");
		const a = h.start("A", "older", 1, "openai-codex/gpt-6-sol", "high");
		await h.advance(1_200_000);
		h.child("fresh");
		const b = h.start("B", "fresh", 1, "openai-codex/gpt-6-sol", "high");
		h.change({ subagentClassifier: true });
		await h.advance(0);
		h.progress("A", "older", "openai-codex/gpt-6-sol", "high");
		await h.advance(5_000);
		h.terminal(a, "completed", "promoted by activity");
		expect(h.spoken.some(item => item.text.includes("promoted by activity"))).toBe(true);
		h.terminal(b);
		h.ingest.detach();
	});
	test("periodic rescore receives only the retained 512-row journal delta after rollover", async () => {
		const calls: ClassifierInput[] = [];
		const h = harness({ classifierQuietMs: 0, rescoreIntervalMs: 60_000 }, async input => {
			calls.push(input);
			return { scores: new Map(input.agents.map(agent => [agent.token, 0.5])) };
		});
		h.ingest.attach();
		for (let index = 0; index < 520; index++) h.child(`journal-a-${index}`);
		h.child("tracked");
		h.start("T", "tracked", 1, "openai-codex/gpt-6-sol", "high");
		await h.advance(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].journal).toHaveLength(512);
		expect(calls[0].journal.some(row => row.id === "journal-a-0")).toBe(false);
		expect(calls[0].journal.some(row => row.id === "journal-a-519")).toBe(true);
		for (let index = 0; index < 513; index++) h.child(`journal-b-${index}`);
		await h.advance(60_000);
		expect(calls).toHaveLength(2);
		expect(calls[1].journal).toHaveLength(512);
		expect(calls[1].journal.some(row => row.id === "journal-b-0")).toBe(false);
		expect(calls[1].journal.at(-1)?.id).toBe("journal-b-512");
		h.ingest.detach();
	});
	test("retries three times per classifier model and authorizes on the fallback", async () => {
		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({
			modelRoles: { classifier: "anthropic/claude-haiku-4-5" },
			"retry.fallbackChains": { classifier: ["anthropic/claude-sonnet-4-5"] },
		});
		const attempted: string[] = [];
		const io = { stat: async () => ({ mtimeMs: 1, size: 5 }), readFile: async () => catalog() };
		const h = harness(
			{ subagentClassifier: false, effortAlerts: true },
			async (input, options) => {
				attempted.push(options.selection.model.id);
				const authorized = options.selection.model.id === sonnet.id;
				return {
					scores: new Map(),
					alerts: authorized
						? new Map([
								[input.alertCandidates[0].token, { authorized: true, reason: "explicit operator approval" }],
							])
						: new Map(),
				};
			},
			io,
			{ settings, models: [getBundledModel("anthropic", "claude-haiku-4-5")!, sonnet] },
		);
		h.ingest.attach();
		await flush();
		h.child("worker");
		h.start("T", "worker", 1, "openai-codex/gpt-6-astra", "max");
		await h.advance(5_000);
		expect(attempted).toEqual(["claude-haiku-4-5", "claude-haiku-4-5", "claude-haiku-4-5", "claude-sonnet-4-5"]);
		expect(h.spoken.some(item => item.text.startsWith("Red alert:"))).toBe(false);
		h.ingest.detach();
	});
	test("source-off stops output and source-on snapshots only active ledger runs", async () => {
		const h = harness({ subagentClassifier: false });
		h.ingest.attach();
		h.child("worker");
		const a = h.start("A", "worker");
		h.change({ subagents: false });
		h.terminal(a);
		h.start("B", "worker");
		h.change({ subagents: true });
		await h.advance(5_000);
		expect(h.spoken.some(s => s.text.includes("Subagents started"))).toBe(false);
		h.terminal({ ...a, runToken: "B" }, "completed", "snapshot output");
		expect(h.spoken.some(s => s.text.includes("snapshot output"))).toBe(true);
		h.ingest.detach();
	});
	test("journal captures own root and rejects foreign removed refs", async () => {
		const requests: ClassifierInput[] = [];
		const h = harness({ classifierQuietMs: 0 }, async input => {
			requests.push(input);
			return { scores: new Map() };
		});
		h.ingest.attach();
		h.child("child");
		h.start("A", "child");
		const foreign = h.registry.register({ id: "foreign", displayName: "foreign", kind: "main", session: null });
		h.registry.register({
			id: "outsider",
			displayName: "outsider",
			kind: "sub",
			parentId: foreign.id,
			session: null,
		});
		h.registry.unregister("outsider");
		h.registry.setStatus("child", "idle");
		await h.advance(0);
		expect(requests[0].journal.some(row => row.id === "outsider")).toBe(false);
		expect(requests[0].journal.some(row => row.id === "child" && row.state === "idle")).toBe(true);
		h.ingest.detach();
	});
	test("advisor notes per severity and finalized thinking are gated independently", () => {
		const h = harness({
			advisorNotes: { nit: true, concern: false, blocker: true },
			advisorThinking: true,
			subagents: false,
		});
		h.ingest.attach();
		h.emit({
			type: "message_end",
			message: {
				role: "custom",
				customType: "advisor",
				details: {
					notes: [
						{ advisor: "reviewer", severity: "nit", note: "detail" },
						{ severity: "concern", note: "hidden" },
						{ severity: "blocker", note: "stop now" },
					],
				},
			},
		});
		h.emit({
			type: "advisor_message",
			advisor: "reviewer",
			message: { role: "assistant", content: [{ type: "thinking", thinking: "reason ".repeat(200) }] },
		});
		expect(h.spoken.map(s => s.text)).toEqual([
			"Advisor note from reviewer (nit): detail",
			"Advisor note from advisor (blocker): stop now",
			expect.stringContaining("Advisor reviewer reasoning (finalized): …"),
		]);
		expect(h.spoken[2].kind).toBe("thinking");
		expect(Buffer.byteLength(h.spoken[2].text)).toBeLessThanOrEqual(500);
		expect(h.spoken[1].guard()).toBe(true);
		h.change({ advisorNotes: { nit: true, concern: false, blocker: false }, advisorThinking: false });
		expect(h.spoken[1].guard()).toBe(false);
		expect(h.spoken[2].guard()).toBe(false);
		h.ingest.detach();
	});
	test("four starts with two voiced do not double-count unvoiced emphasis; tracking ceiling releases on terminal", async () => {
		const h = harness({ subagentClassifier: false, voicedSlotsByDepth: [2], startAnnounceQuietMs: 10 });
		h.ingest.attach();
		h.child("worker");
		const frames = Array.from({ length: 65 }, (_, i) => h.start(`T${i}`, "worker"));
		expect(h.commentary.filter(s => s.includes("tracking ceiling"))).toHaveLength(1);
		await h.advance(10);
		expect(h.spoken[0].text).toStartWith("High priority: Subagents started:");
		h.terminal(frames[0]);
		h.start("T65", "worker");
		await h.advance(10);
		expect(h.commentary.filter(s => s.includes("tracking ceiling"))).toHaveLength(1);
		h.ingest.detach();
		const small = harness({ subagentClassifier: false, voicedSlotsByDepth: [2], startAnnounceQuietMs: 10 });
		small.ingest.attach();
		small.child("worker");
		for (let i = 0; i < 4; i++) small.start(`T${i}`, "worker");
		await small.advance(10);
		expect(small.spoken[0].text).toStartWith("Subagents started:");
		expect(small.spoken[0].text).toContain("plus 2 more");
		small.ingest.detach();
	});
	test("confirmed never candidate authorizes independently of importance, at a fixed alert deadline", async () => {
		const calls: ClassifierInput[] = [];
		const io = { stat: async () => ({ mtimeMs: 1, size: 5 }), readFile: async () => catalog() };
		const h = harness(
			{ subagentClassifier: false, effortAlerts: true, classifierQuietMs: 10000 },
			async input => {
				calls.push(input);
				return {
					scores: new Map(),
					alerts: new Map([[input.alertCandidates[0].token, { authorized: false, reason: "not approved" }]]),
				};
			},
			io,
		);
		h.ingest.attach();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		h.child("worker");
		h.start("T", "worker", 1, "openai-codex/gpt-6-astra", "max");
		for (let i = 0; i < 10; i++) {
			await h.advance(150);
			h.progress("T", "worker", "openai-codex/gpt-6-astra", "max");
		}
		expect(calls).toHaveLength(0);
		await h.advance(500);
		expect(calls).toHaveLength(1);
		expect(calls[0].alertCandidates.map(r => r.token)).toEqual(["T"]);
		await Promise.resolve();
		await Promise.resolve();
		expect(h.spoken.some(s => s.text.includes("I found no authorization"))).toBe(true);
		h.ingest.detach();
	});
	test("catalog backlog over 64 retains a protected counted unchecked alert with receipt", async () => {
		const io = { stat: async () => ({ mtimeMs: 1, size: 5 }), readFile: async () => catalog() };
		const h = harness({ subagentClassifier: false, effortAlerts: true }, async () => ({ scores: new Map() }), io);
		h.ingest.attach();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		h.child("worker");
		for (let i = 0; i < 66; i++) h.start(`T${i}`, "worker", 1, "openai-codex/gpt-6-astra", "max");
		expect(h.overflow).toHaveLength(1);
		expect(h.overflow[0].guard()).toBe(true);
		const receipt = h.overflow[0].render();
		expect(receipt.text).toContain("authorization not checked");
		expect(receipt.text).toContain("2 deployments");
		h.overflow[0].receipt(receipt.receiptId, true);
		h.change({ effortAlerts: false });
		expect(h.overflow[0].guard()).toBe(false);
		h.ingest.detach();
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AssistantMessage,
	clearCustomApis,
	getCustomApi,
	type ImageContent,
	type Message,
	registerCustomApi,
	type ToolChoice,
} from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { streamMixture } from "@oh-my-pi/pi-coding-agent/moa/engine";
import { createSessionMixtureHost, type SessionMixtureHost } from "@oh-my-pi/pi-coding-agent/moa/host";
import { MIXTURE_API, MixtureCatalog, registerMixtureApi } from "@oh-my-pi/pi-coding-agent/moa/provider";
import { discoverRegistrableMixtures, retainMixtureCatalog } from "@oh-my-pi/pi-coding-agent/moa/registration";
import { findAnchor } from "@oh-my-pi/pi-coding-agent/moa/request";
import { MIXTURE_RUN_ENTRY_TYPE, type MixtureCheckpoint, type MixtureRun } from "@oh-my-pi/pi-coding-agent/moa/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MIXTURE_TRACE_MESSAGE_TYPE, type MixtureTraceDetails } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createMoaFixture,
	createMoaSession,
	DRAFT_THEN_EDIT_TOML,
	FakeMembers,
	type MoaFixture,
} from "./helpers/moa-setup";

let tempDir: TempDir;
let fixture: MoaFixture;
let fixtureReady = false;
let members: FakeMembers;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	tempDir = TempDir.createSync("@moa-engine-");
	members = new FakeMembers();
	registerMixtureApi();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	if (fixtureReady) fixture.authStorage.close();
	fixtureReady = false;
	clearCustomApis();
	tempDir.removeSync();
});

const SETTINGS = { "compaction.enabled": false, "retry.baseDelayMs": 1 };

async function ensureFixture(toml = DRAFT_THEN_EDIT_TOML): Promise<MoaFixture> {
	if (!fixtureReady) {
		fixture = await createMoaFixture(tempDir, toml);
		fixtureReady = true;
	}
	return fixture;
}

function mixtureModel() {
	const model = fixture.registry.find("mixture", "draft-then-edit");
	if (!model) throw new Error("mixture/draft-then-edit was not registered");
	return model;
}

async function mixtureSession(
	toml = DRAFT_THEN_EDIT_TOML,
	sessionManager?: SessionManager,
	settings: Settings = Settings.isolated(SETTINGS),
): Promise<AgentSession> {
	await ensureFixture(toml);
	const session = await createMoaSession(fixture, { sessionManager, settings });
	sessions.push(session);
	await session.setModel(mixtureModel());
	return session;
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.findLast(candidate => candidate.role === "assistant");
	if (message?.role !== "assistant") throw new Error("no assistant message");
	return message;
}

function userText(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The operator request a member's envelope carries. */
function envelopeRequest(message: Message | undefined): string {
	return /<request>\n([\s\S]*?)\n<\/request>/.exec(userText(message))?.[1] ?? "";
}

function traceCards(session: AgentSession): MixtureTraceDetails[] {
	return session.sessionManager
		.getBranch()
		.flatMap(entry =>
			entry.type === "custom_message" && entry.customType === MIXTURE_TRACE_MESSAGE_TYPE
				? [entry.details as MixtureTraceDetails]
				: [],
		);
}

function checkpoints(session: AgentSession): MixtureCheckpoint[] {
	return session.sessionManager
		.getBranch()
		.flatMap(entry =>
			entry.type === "custom" && entry.customType === MIXTURE_RUN_ENTRY_TYPE && "reason" in (entry.data as object)
				? [entry.data as MixtureCheckpoint]
				: [],
		);
}

function events(session: AgentSession): AgentSessionEvent[] {
	const seen: AgentSessionEvent[] = [];
	session.subscribe(event => {
		seen.push(event);
	});
	return seen;
}

describe("linear mixture in a session", () => {
	it("answers with the editor's text only, hands on the writer's output without its reasoning, and persists cards above the answer", async () => {
		const session = await mixtureSession();
		const seen = events(session);
		members.script("writer", { text: "DRAFT: the answer is 42", thinking: "SECRET WRITER REASONING", cost: 0.01 });
		members.script("editor", { text: "The answer is 42.", thinking: "editor thoughts", cost: 0.02 });
		await session.sendUserMessage("What is the answer?");

		const outer = lastAssistant(session);
		expect(outer.api).toBe("mixture");
		expect(outer.content).toEqual([{ type: "text", text: "The answer is 42." }]);
		expect(outer.usage.cost.total).toBeCloseTo(0.03, 10);
		expect(outer.usageBreakdown?.map(entry => `${entry.provider}/${entry.model}`)).toEqual([
			"fake/writer",
			"fake/editor",
		]);

		const editorEnvelope = userText(members.callsTo("editor")[0]?.context.messages[0]);
		expect(editorEnvelope).toContain("DRAFT: the answer is 42");
		expect(editorEnvelope).not.toContain("SECRET WRITER REASONING");
		expect(envelopeRequest(members.callsTo("writer")[0]?.context.messages[0])).toBe("What is the answer?");

		const cards = traceCards(session);
		expect(cards.map(card => card.kind === "hop" && [card.memberId, card.visible, card.output])).toEqual([
			["writer", true, "DRAFT: the answer is 42"],
			["editor", false, undefined],
		]);
		expect(cards.at(-1)?.run.usd).toBeCloseTo(0.03, 10);
		// Live: each hop card event arrives before the outer message ends, then the run ends.
		const order = seen.flatMap(event =>
			event.type === "mixture_hop_end"
				? [`hop:${event.details.kind === "hop" ? event.details.memberId : ""}`]
				: event.type === "message_end" && event.message.role === "assistant"
					? ["answer"]
					: event.type === "mixture_run_end"
						? ["run_end"]
						: [],
		);
		expect(order.slice(0, 2)).toEqual(["hop:writer", "hop:editor"]);
		expect(order).toContain("answer");
		// Branch order: cards, then the answer, then the run_end record.
		const kinds = session.sessionManager
			.getBranch()
			.map(entry =>
				entry.type === "custom_message"
					? "card"
					: entry.type === "message" && entry.message.role === "assistant"
						? "answer"
						: entry.type === "custom" && (entry.data as { kind?: string }).kind === "run_end"
							? "run_end"
							: undefined,
			)
			.filter(Boolean);
		expect(kinds).toEqual(["card", "card", "answer", "run_end"]);
		// Cards never reach the LLM context.
		const reloaded = session.sessionManager.buildSessionContext().messages;
		expect(convertToLlm(reloaded).some(message => userText(message).includes("DRAFT"))).toBe(false);
	});

	it("lets a later model replay the mixture turn: the outer assistant message is text only", async () => {
		const session = await mixtureSession();
		await session.sendUserMessage("first");
		await session.setModel(fixture.registry.find("fake", "other")!);
		await session.sendUserMessage("second");
		const replayed = members.callsTo("other")[0]!.context.messages.filter(message => message.role === "assistant");
		expect(replayed).toHaveLength(1);
		expect(replayed[0]!.role === "assistant" && replayed[0]!.content.map(block => block.type)).toEqual(["text"]);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("publishes a card without the output body for show = never, and an edge-level show wins", async () => {
		const hidden = DRAFT_THEN_EDIT_TOML.replace(
			'system_prompt = "Draft a complete answer."',
			'system_prompt = "Draft a complete answer."\nshow = "never"',
		);
		const session = await mixtureSession(hidden);
		members.script("writer", { text: "hidden draft" });
		await session.sendUserMessage("go");
		const writerCard = traceCards(session)[0]!;
		expect(writerCard.kind === "hop" && [writerCard.visible, writerCard.output]).toEqual([false, undefined]);
		expect(userText(members.callsTo("editor")[0]?.context.messages[0])).toContain("hidden draft");

		await Bun.write(
			`${fixture.agentDir}/MIXTURES.toml`,
			hidden.replace("x = { output = true }", 'x = { output = true }\nshow = "always"'),
		);
		const overridden = await createMoaSession(fixture, { settings: Settings.isolated(SETTINGS) });
		sessions.push(overridden);
		MixtureCatalog.for(fixture.registry).setRoster(
			await discoverRegistrableMixtures({
				cwd: fixture.cwd,
				agentDir: fixture.agentDir,
				registry: fixture.registry,
				settings: Settings.isolated(),
			}),
		);
		await overridden.setModel(mixtureModel());
		members.script("writer", { text: "shown draft" });
		await overridden.sendUserMessage("go");
		const shown = traceCards(overridden)[0]!;
		expect(shown.kind === "hop" && [shown.visible, shown.output]).toEqual([true, "shown draft"]);
	});

	it("keeps a persisted mixture default selected across a restart and a resume, with no judge candidate", async () => {
		const sessionDir = tempDir.join("sessions");
		const settings = Settings.isolated(SETTINGS);
		const manager = SessionManager.create(tempDir.join("project"), sessionDir);
		await ensureFixture();
		const session = await createMoaSession(fixture, { sessionManager: manager, settings });
		sessions.push(session);
		await session.setModel(mixtureModel(), "default", { persist: true });
		await session.sendUserMessage("remember me");
		const file = manager.getSessionFile()!;
		await session.dispose();
		sessions.splice(0);

		const resumed = await createMoaSession(fixture, {
			sessionManager: await SessionManager.open(file, sessionDir),
			settings,
			model: null,
		});
		sessions.push(resumed);
		expect(resumed.model && `${resumed.model.provider}/${resumed.model.id}`).toBe("mixture/draft-then-edit");
		await resumed.sendUserMessage("still here?");
		expect(lastAssistant(resumed).stopReason).toBe("stop");

		const fresh = await createMoaSession(fixture, { settings, model: null });
		sessions.push(fresh);
		expect(fresh.model && `${fresh.model.provider}/${fresh.model.id}`).toBe("mixture/draft-then-edit");
	});

	it.each([
		{ limit: "hops", toml: 'entry = "writer"\nlimits = { max_hops = 1 }', settings: {}, reason: "the 1-hop limit" },
		{
			limit: "hard_cap",
			toml: 'entry = "writer"',
			settings: { "moa.hard_max_hops": 1 },
			reason: "the hard cap of 1 hops",
		},
	])(
		"stops at the $limit limit with the notice and the last member's output",
		async ({ limit, toml, settings, reason }) => {
			const session = await mixtureSession(
				DRAFT_THEN_EDIT_TOML.replace('entry = "writer"', toml),
				undefined,
				Settings.isolated({ ...SETTINGS, ...settings }),
			);
			members.script("writer", { text: "only a draft" });
			await session.sendUserMessage("go");

			const outer = lastAssistant(session);
			expect(outer.stopReason).toBe("stop");
			const answer = outer.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
			expect(answer).toContain(`stopped after 1 hops: ${reason} was reached`);
			expect(answer).toContain("only a draft");
			expect(members.callsTo("editor")).toHaveLength(0);
			expect(traceCards(session).some(card => card.kind === "limit" && card.limit === limit)).toBe(true);
		},
	);

	it("runs in a subagent session sharing the registry, and the subagent's exit leaves the parent's mixture", async () => {
		const parent = await mixtureSession();
		const child = await createMoaSession(fixture, { settings: Settings.isolated(SETTINGS) });
		await child.setModel(mixtureModel());
		members.script("editor", { text: "child answer" });
		await child.sendUserMessage("child task");
		expect(lastAssistant(child).content).toEqual([{ type: "text", text: "child answer" }]);
		await child.dispose();

		expect(fixture.registry.find("mixture", "draft-then-edit")).toBeDefined();
		members.script("editor", { text: "parent answer" });
		await parent.sendUserMessage("parent task");
		expect(lastAssistant(parent).content).toEqual([{ type: "text", text: "parent answer" }]);
	});
});

describe("side paths never run the mixture", () => {
	/** Mixture ids that reached the process-wide dispatcher (the backstop behind the side-stream guard). */
	let dispatched: string[];

	beforeEach(() => {
		dispatched = [];
		const unhosted = getCustomApi(MIXTURE_API)!.streamSimple;
		registerCustomApi(MIXTURE_API, (model, context, options) => {
			dispatched.push(model.id);
			return unhosted(model, context, options);
		});
	});

	it("fails a side request on the mixture loudly", async () => {
		const session = await mixtureSession();
		await expect(session.runEphemeralTurn({ promptText: "quick question" })).rejects.toThrow(
			"mixture models cannot serve side requests",
		);
		expect(dispatched).toEqual([]);
	});

	// The session's default role is the mixture, as after `/model` with persist; `smol`
	// pins the native fallback so no side path can reach a credentialed real model.
	const SIDE_ROLES = { default: "mixture/draft-then-edit", smol: "fake/other" };

	it("auto-compacts a mixture session with a native model", async () => {
		const session = await mixtureSession(
			DRAFT_THEN_EDIT_TOML,
			undefined,
			Settings.isolated({
				...SETTINGS,
				modelRoles: SIDE_ROLES,
				"compaction.enabled": true,
				"compaction.asyncEnabled": false,
				"compaction.autoContinue": false,
				"compaction.thresholdTokens": 40,
				"compaction.keepRecentTokens": 1,
				"compaction.methodOrder": ["soft"],
			}),
		);
		const seen = events(session);
		const long = "a long answer that fills the context window ".repeat(8);
		members.script("editor", { text: long }, { text: long });
		await session.sendUserMessage("first question");
		await session.sendUserMessage("second question");
		await session.waitForIdle();

		const compacted = seen.filter(event => event.type === "auto_compaction_end" && event.result !== undefined);
		expect(compacted.length).toBeGreaterThan(0);
		expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
		expect(members.callsTo("other").length).toBeGreaterThan(0);
		expect(dispatched).toEqual([]);
		expect(session.model?.api).toBe("mixture");
	});

	it("titles a mixture session with a native model even when the tiny role points at the mixture", async () => {
		const session = await mixtureSession(
			DRAFT_THEN_EDIT_TOML,
			undefined,
			Settings.isolated({ ...SETTINGS, modelRoles: { ...SIDE_ROLES, tiny: "mixture/draft-then-edit" } }),
		);
		members.script("other", { text: "Retry accounting for mixtures" });
		const title = await session.generateTitle("Explain how retries account for mixture member usage");
		expect(title).toBe("Retry accounting for mixtures");
		expect(members.calls.map(call => call.model.id)).toEqual(["other"]);
		expect(dispatched).toEqual([]);
	});
});

describe("member error, retry, and usage accounting", () => {
	it("retries a first-hop error once, reports each attempt once, and keeps totals through retry cleanup and reload", async () => {
		const sessionDir = tempDir.join("sessions");
		const manager = SessionManager.create(tempDir.join("project"), sessionDir);
		const session = await mixtureSession(DRAFT_THEN_EDIT_TOML, manager);
		const observe = vi.spyOn(fixture.authStorage.usage, "observe");
		members.script("writer", { error: { message: "503 Service Unavailable", status: 503 }, cost: 0.004 });
		members.script("writer", { text: "draft", cost: 0.01 });
		members.script("editor", { text: "final", cost: 0.02 });

		await session.sendUserMessage("question");

		expect(members.callsTo("writer")).toHaveLength(2);
		expect(members.callsTo("editor")).toHaveLength(1);
		const outer = lastAssistant(session);
		expect(outer.content).toEqual([{ type: "text", text: "final" }]);
		// The retried response reports only the settlements after the committed error response.
		expect(outer.usage.cost.total).toBeCloseTo(0.03, 10);
		expect(
			session.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(session.getSessionStats().cost).toBeCloseTo(0.034, 10);
		// The broker ledger: one observation per billed member attempt, none for the outer messages.
		expect(observe.mock.calls.map(([record]) => [record.model, record.costUsd])).toEqual([
			["writer", 0.004],
			["writer", 0.01],
			["editor", 0.02],
		]);
		const errorEntry = manager
			.getBranch()
			.find(
				entry =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
			);
		expect(
			errorEntry?.type === "message" && errorEntry.message.role === "assistant" && errorEntry.message.errorStatus,
		).toBe(503);

		const file = manager.getSessionFile()!;
		await session.dispose();
		sessions.splice(0);
		const reopened = await createMoaSession(fixture, {
			sessionManager: await SessionManager.open(file, sessionDir),
			settings: Settings.isolated(SETTINGS),
		});
		sessions.push(reopened);
		expect(
			reopened.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(reopened.getSessionStats().cost).toBeCloseTo(0.034, 10);
	});

	it("keeps premium requests and credits of every member attempt, live and after reload", async () => {
		const sessionDir = tempDir.join("sessions");
		const manager = SessionManager.create(tempDir.join("project"), sessionDir);
		const session = await mixtureSession(DRAFT_THEN_EDIT_TOML, manager);
		members.script("writer", {
			text: "draft",
			meters: { premiumRequests: 1, credits: { cost: 2, committedCost: 2 } },
		});
		members.script("editor", { text: "final", meters: { premiumRequests: 3, credits: { cost: 5, acuCost: 0.5 } } });
		await session.sendUserMessage("question");

		const outer = lastAssistant(session);
		expect(outer.usage.premiumRequests).toBe(4);
		expect(outer.usage.credits).toEqual({ cost: 7, committedCost: 2, acuCost: 0.5 });
		const live = session.getSessionStats();
		expect([live.premiumRequests, live.credits]).toEqual([4, { cost: 7, committedCost: 2, acuCost: 0.5 }]);

		const file = manager.getSessionFile()!;
		await session.dispose();
		sessions.splice(0);
		const reopened = await createMoaSession(fixture, {
			sessionManager: await SessionManager.open(file, sessionDir),
			settings: Settings.isolated(SETTINGS),
		});
		sessions.push(reopened);
		const reloaded = reopened.getSessionStats();
		expect([reloaded.premiumRequests, reloaded.credits]).toEqual([4, { cost: 7, committedCost: 2, acuCost: 0.5 }]);
	});

	it("leaves a meter absent when no member attempt reports it", async () => {
		const session = await mixtureSession();
		await session.sendUserMessage("question");
		const usage = lastAssistant(session).usage;
		expect(["premiumRequests", "credits", "server", "cttl", "orchestration"].filter(key => key in usage)).toEqual([]);
	});
});

describe("caller abort", () => {
	it("checkpoints the run, says the next message starts a new run, and starts one", async () => {
		const session = await mixtureSession();
		const seen = events(session);
		members.script("writer", { waitForAbort: true, cost: 0.003 });
		const turn = session.sendUserMessage("long task");
		while (members.callsTo("writer").length === 0) await Bun.sleep(5);
		await session.abort();
		await turn.catch(() => {});

		expect(lastAssistant(session).stopReason).toBe("aborted");
		const abort = checkpoints(session).findLast(checkpoint => checkpoint.reason === "abort")!;
		expect(abort.run.status).toBe("checkpoint");
		expect(abort.run.phase).toEqual({ kind: "hop_ready", memberId: "writer" });
		expect(traceCards(session).some(card => card.kind === "checkpoint" && card.reason === "abort")).toBe(true);
		const notice = seen.find(event => event.type === "notice" && event.source === "mixture");
		expect(notice?.type === "notice" && notice.message).toContain("your next message starts a new run");

		await session.sendUserMessage("different task");
		expect(envelopeRequest(members.callsTo("writer")[1]?.context.messages[0])).toBe("different task");
		expect(lastAssistant(session).stopReason).toBe("stop");
		const runIds = new Set(checkpoints(session).map(checkpoint => checkpoint.run.id));
		expect(runIds.size).toBe(2);
	});
});

describe("provider context for members", () => {
	it("delivers more than five operator images to an entry member whose provider allows them", async () => {
		const vision = DRAFT_THEN_EDIT_TOML.replace('model = "fake/writer"', 'model = "openrouter/vision"');
		await ensureFixture(vision);
		fixture.registry.registerProvider("openrouter", {
			baseUrl: "http://127.0.0.1:1/v1",
			apiKey: "k",
			api: "moa-fake",
			models: [
				{
					id: "vision",
					name: "vision",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 4_000,
				},
			],
		});
		const session = await mixtureSession(vision);
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
		const images: ImageContent[] = Array.from({ length: 7 }, () => ({
			type: "image",
			data: png,
			mimeType: "image/png",
		}));
		await session.prompt("describe these", { images });
		const delivered = members
			.callsTo("vision")[0]!
			.context.messages.flatMap(message =>
				typeof message.content === "string" ? [] : message.content.filter(block => block.type === "image"),
			);
		expect(delivered).toHaveLength(7);
	});
});

describe("engine contract through a session host", () => {
	let host: SessionMixtureHost;
	let manager: SessionManager;

	beforeEach(async () => {
		await ensureFixture();
		manager = SessionManager.inMemory(fixture.cwd);
		await retainMixtureCatalog("engine", {
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			registry: fixture.registry,
			settings: Settings.isolated(),
		});
		host = createSessionMixtureHost({
			sessionManager: manager,
			modelRegistry: fixture.registry,
			settings: Settings.isolated(),
			stream: streamSimple,
			prepareContext: async context => context,
			emit: () => {},
			notice: () => {},
		});
	});

	function user(text: string): Message {
		return { role: "user", content: text, timestamp: 0 };
	}

	function stripped(message: AssistantMessage): AssistantMessage {
		return { ...message, responseId: undefined };
	}

	function currentRun(): MixtureRun {
		const run = host.runs.runs()[0];
		if (!run) throw new Error("no mixture run");
		return run;
	}

	async function call(messages: Message[], toolChoice?: ToolChoice): Promise<AssistantMessage> {
		return streamMixture(mixtureModel(), { systemPrompt: ["outer"], messages }, { toolChoice }, host).result();
	}

	it.each<[ToolChoice, string]>([
		["required", "toolchoice.unsatisfiable"],
		["any", "toolchoice.unsatisfiable"],
		[{ type: "function", name: "yield" }, "toolchoice.unsatisfiable"],
		[{ type: "function", function: { name: "yield" } }, "toolchoice.unsatisfiable"],
		[{ type: "computer" }, "toolchoice.unsupported"],
	])("ends a tools-off graph with toolChoice %j as %s before any member runs", async (toolChoice, code) => {
		const result = await call([user("go")], toolChoice);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage?.startsWith(code)).toBe(true);
		expect(members.calls).toHaveLength(0);
	});

	it.each<ToolChoice | undefined>([undefined, "auto", "none"])(
		"runs a tools-off graph with toolChoice %j",
		async toolChoice => {
			const result = await call([user("go")], toolChoice);
			expect(result.stopReason).toBe("stop");
			expect(members.calls.map(entry => entry.model.id)).toEqual(["writer", "editor"]);
		},
	);

	const REQUIRED_CHOICES: ToolChoice[] = ["required", "any", { type: "function", name: "yield" }];

	it.each(REQUIRED_CHOICES)(
		"rejects toolChoice %j on a repeat of a completed request, then still replays for auto",
		async toolChoice => {
			const first = await call([user("Q")], "auto");
			for (const committed of [false, true]) {
				if (committed) host.commitPersisted(first);
				const forced = await call([user("Q")], toolChoice);
				expect(forced.stopReason).toBe("error");
				expect(forced.errorMessage?.startsWith("toolchoice.unsatisfiable")).toBe(true);
			}
			const replay = await call([user("Q")], "auto");
			expect(replay.responseId).toBe(first.responseId);
			expect(members.calls).toHaveLength(2);
		},
	);

	it.each(REQUIRED_CHOICES)(
		"rejects toolChoice %j on a retry of a failed request before any member reruns",
		async toolChoice => {
			members.script("editor", { error: { message: "overloaded", status: 529 } });
			const failed = await call([user("Q")], "auto");
			expect(failed.stopReason).toBe("error");
			const forced = await call([user("Q")], toolChoice);
			expect(forced.errorMessage?.startsWith("toolchoice.unsatisfiable")).toBe(true);
			expect(members.calls).toHaveLength(2);
		},
	);

	it("reports usage from the committed watermark: a response issued before commit reports from the same start", async () => {
		const first = await call([user("one")]);
		expect(first.usage.cost.total).toBeCloseTo(0.02, 10);
		// Not committed: a repeat replays the same response and range without regenerating.
		const replay = await call([user("one")]);
		expect(replay.responseId).toBe(first.responseId);
		expect(replay.usage.cost.total).toBeCloseTo(0.02, 10);
		expect(members.calls).toHaveLength(2);
		host.commitPersisted(first);
		const second = await call([user("one"), first, user("two")]);
		expect(second.usage.cost.total).toBeCloseTo(0.02, 10);
		expect(second.usage.contextTokens).toBeGreaterThan(0);
	});

	it("ends a failed hop with the member's status, and an identical request re-runs only the failed member", async () => {
		const settled: string[] = [];
		host.onSettlement = (_run, settlement) => {
			settled.push(`${settlement.model}:${settlement.usage.cost.total}`);
		};
		members.script("writer", { text: "draft", cost: 0.01 });
		members.script("editor", { error: { message: "overloaded", status: 529 }, cost: 0.004 });
		const failed = await call([user("q")]);
		expect(failed.stopReason).toBe("error");
		expect(failed.errorStatus).toBe(529);
		expect(failed.errorMessage).toBe("overloaded");
		expect(failed.content).toEqual([]);

		// Uncommitted, so the retry's response reports from the same watermark as the failed one.
		members.script("editor", { text: "edited", cost: 0.02 });
		const retried = await call([user("q")]);
		expect(retried.stopReason).toBe("stop");
		expect(retried.content).toEqual([{ type: "text", text: "edited" }]);
		expect(members.callsTo("writer")).toHaveLength(1);
		expect(members.callsTo("editor")).toHaveLength(2);
		expect(retried.usage.cost.total).toBeCloseTo(0.034, 10);
		expect(retried.usageBreakdown?.map(entry => `${entry.provider}/${entry.model}`)).toEqual([
			"fake/writer",
			"fake/editor",
			"fake/editor",
		]);
		expect(settled).toEqual(["writer:0.01", "editor:0.004", "editor:0.02"]);
	});

	it("anchors successive operator prompts by responseId, the committed cursor, the newest text, or not at all", async () => {
		const writerRequest = () => envelopeRequest(members.callsTo("writer").at(-1)?.context.messages[0]);
		const r1 = await call([user("one")]);
		host.commitPersisted(r1);

		const byId = [user("one"), r1, user("two")];
		expect(findAnchor(currentRun(), byId)).toEqual({ index: 1, kind: "responseId" });
		const r2 = await call(byId);
		host.commitPersisted(r2);
		expect(writerRequest()).toBe("two");

		// Response ids stripped by the wire: the committed cursor still matches the prefix.
		const byCursor = [user("one"), stripped(r1), user("two"), stripped(r2), user("three")];
		expect(findAnchor(currentRun(), byCursor)).toEqual({ index: 2, kind: "cursor" });
		const r3 = await call(byCursor);
		host.commitPersisted(r3);
		expect(writerRequest()).toBe("three");

		// History rewritten before the cursor: the newest response's text anchors.
		const byText = [
			user("one, edited"),
			stripped(r1),
			user("two"),
			stripped(r2),
			user("three"),
			stripped(r3),
			user("four"),
		];
		expect(findAnchor(currentRun(), byText)).toEqual({ index: 5, kind: "text" });
		const r4 = await call(byText);
		host.commitPersisted(r4);
		expect(writerRequest()).toBe("four");

		// Nothing matches: the whole list is the tail, and its user messages fold into the prompt.
		const unanchored = [user("unrelated"), user("five")];
		expect(findAnchor(currentRun(), unanchored)).toEqual({ index: -1, kind: "none" });
		const r5 = await call(unanchored);
		host.commitPersisted(r5);
		expect(writerRequest()).toBe("unrelated\n\nfive");

		// An assistant message the run never produced does not restart the prompt: every
		// operator message in an unanchored tail folds in order.
		const foreign: AssistantMessage = { ...stripped(r4), content: [{ type: "text", text: "from elsewhere" }] };
		const withAssistant = [user("six"), foreign, user("seven")];
		expect(findAnchor(currentRun(), withAssistant)).toEqual({ index: -1, kind: "none" });
		await call(withAssistant);
		expect(writerRequest()).toBe("six\n\nseven");
	});

	it("gives a follow-up run the operator-facing conversation before its prompt", async () => {
		const first = await call([user("one")]);
		host.commitPersisted(first);
		await call([user("one"), first, user("two")]);
		const envelope = userText(members.callsTo("writer")[1]?.context.messages[0]);
		expect(envelopeRequest(members.callsTo("writer")[1]?.context.messages[0])).toBe("two");
		expect(envelope).toContain("User: one");
		expect(envelope).toContain("Assistant: editor reply");
	});
});

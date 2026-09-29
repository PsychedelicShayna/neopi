import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { clearCustomApis, type Message } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { streamMixture } from "@oh-my-pi/pi-coding-agent/moa/engine";
import { createSessionMixtureHost, type SessionMixtureHost } from "@oh-my-pi/pi-coding-agent/moa/host";
import { zeroUsage } from "@oh-my-pi/pi-coding-agent/moa/outer-stream";
import { registerMixtureApi } from "@oh-my-pi/pi-coding-agent/moa/provider";
import { MixtureWorkspace } from "@oh-my-pi/pi-coding-agent/moa/registration";
import { completedMixtureRun, isMixtureRunComplete, restoreMixtureRun } from "@oh-my-pi/pi-coding-agent/moa/restore";
import { formatMixtureReset, formatMixtureStatus } from "@oh-my-pi/pi-coding-agent/moa/status";
import { MIXTURE_RUN_ENTRY_TYPE, type MixtureCheckpoint } from "@oh-my-pi/pi-coding-agent/moa/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import {
	COURTROOM_TOML,
	createMoaFixture,
	createMoaSession,
	DRAFT_THEN_EDIT_TOML,
	FakeMembers,
	type MoaFixture,
} from "./helpers/moa-setup";

const base = { id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };

function checkpoint(runId: string, responseId: string): SessionEntry {
	return {
		...base,
		type: "custom",
		customType: MIXTURE_RUN_ENTRY_TYPE,
		data: { v: 1, reason: "done", run: { id: runId }, committedThrough: 0, outerResponseId: responseId },
	};
}

function assistant(responseId: string): SessionEntry {
	return {
		...base,
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "finished" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
			responseId,
		},
	};
}

const reset: SessionEntry = { ...base, type: "reset_boundary" };

function lifecycle(runId: string): SessionEntry {
	return { ...base, type: "custom", customType: MIXTURE_RUN_ENTRY_TYPE, data: { kind: "run_end", runId } };
}

describe("mixture run completion on a persisted branch", () => {
	it("matches a done checkpoint only to a later assistant response with its own id", () => {
		const done = checkpoint("a", "r1");
		expect(completedMixtureRun([done, assistant("r1")], "a")?.outerResponseId).toBe("r1");
		expect(isMixtureRunComplete([done], "a")).toBe(false);
		expect(isMixtureRunComplete([assistant("r1"), done], "a")).toBe(false);
		expect(isMixtureRunComplete([done, assistant("r2")], "a")).toBe(false);
		expect(isMixtureRunComplete([done, assistant("r1")], "b")).toBe(false);
	});

	it("ignores lifecycle entries but refuses completion across a reset boundary", () => {
		const done = checkpoint("a", "r1");
		expect(isMixtureRunComplete([done, assistant("r1"), lifecycle("a")], "a")).toBe(true);
		expect(isMixtureRunComplete([lifecycle("a")], "a")).toBe(false);
		expect(isMixtureRunComplete([done, reset, assistant("r1")], "a")).toBe(false);
		expect(isMixtureRunComplete([done, assistant("r1"), reset], "a")).toBe(false);
	});

	it("returns the newest checkpoint when a done response was replayed", () => {
		const first = checkpoint("a", "r1");
		const second = checkpoint("a", "r2");
		expect(completedMixtureRun([first, assistant("r1"), second, assistant("r2")], "a")?.outerResponseId).toBe("r2");
	});
});

describe("checkpoint selection across branch boundaries", () => {
	const pending: SessionEntry = {
		...base,
		type: "custom",
		customType: MIXTURE_RUN_ENTRY_TYPE,
		data: { v: 1, reason: "pause", run: { id: "a" }, committedThrough: 0, outerResponseId: "r1" },
	};
	const prior: SessionEntry = {
		...base,
		type: "custom",
		customType: MIXTURE_RUN_ENTRY_TYPE,
		data: { v: 1, reason: "decision", run: { id: "a" }, committedThrough: 0 },
	};
	it("falls back to a durable continuation when the newest response was never appended", () => {
		const restored = restoreMixtureRun([prior, pending]);
		expect(restored?.checkpoint.reason).toBe("decision");
		expect(restored?.committed).toBe(false);
		expect(restoreMixtureRun([prior, pending, assistant("r1")])?.checkpoint.reason).toBe("pause");
		expect(restoreMixtureRun([prior, pending, assistant("r1")])?.committed).toBe(true);
	});
	it("never reaches past a newer run, reset lifecycle, or reset boundary", () => {
		const resetRun: SessionEntry = {
			...base,
			type: "custom",
			customType: MIXTURE_RUN_ENTRY_TYPE,
			data: { kind: "run_reset", runId: "a", at: 1 },
		};
		expect(restoreMixtureRun([prior, resetRun])).toBeUndefined();
		expect(restoreMixtureRun([prior, checkpoint("b", "missing")])).toBeUndefined();
		expect(restoreMixtureRun([prior, reset])).toBeUndefined();
		expect(restoreMixtureRun([checkpoint("a", "r1"), assistant("r1")])).toBeUndefined();
	});
});

describe("restoring a persisted mixture session", () => {
	let temp: TempDir;
	let fixture: MoaFixture;
	let members: FakeMembers;
	const sessions: AgentSession[] = [];
	const workspaces: MixtureWorkspace[] = [];
	const settings = () =>
		Settings.isolated({
			"compaction.enabled": false,
			"moa.summary_model": "fake/summary",
			modelRoles: { judge: "fake/jev" },
			"retry.fallbackChains": { judge: [] },
		});
	const limitsToml = (lines: string) =>
		COURTROOM_TOML.replace(/\[mixtures\.limits\][\s\S]*$/, `[mixtures.limits]\n${lines}\n`);

	beforeEach(() => {
		temp = TempDir.createSync("@moa-restore-");
		members = new FakeMembers();
		registerMixtureApi();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const workspace of workspaces.splice(0)) workspace.release();
		fixture?.authStorage.close();
		clearCustomApis();
		temp.removeSync();
	});

	async function makeSession(manager: SessionManager, config = settings()): Promise<AgentSession> {
		const session = await createMoaSession(fixture, { sessionManager: manager, settings: config });
		sessions.push(session);
		const model = fixture.registry.find("mixture", "courtroom");
		if (!model) throw new Error("courtroom model missing");
		await session.setModel(model);
		return session;
	}

	async function directHost(
		manager: SessionManager,
		config = settings(),
		notices?: string[],
	): Promise<SessionMixtureHost> {
		const workspace = await MixtureWorkspace.retain(`restore-${workspaces.length}`, {
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			registry: fixture.registry,
			settings: config,
		});
		workspaces.push(workspace);
		return createSessionMixtureHost({
			sessionManager: manager,
			modelRegistry: fixture.registry,
			workspace,
			settings: config,
			stream: streamSimple,
			prepareContext: async context => context,
			emit: () => {},
			notice: (_level, message) => {
				notices?.push(message);
			},
		});
	}

	it("restores a paused courtroom after reload and resumes with a fresh two-hop window", async () => {
		fixture = await createMoaFixture(temp, limitsToml('max_hops = 2\non_limit = "pause"'));
		const sessionDir = temp.join("sessions");
		const manager = SessionManager.create(fixture.cwd, sessionDir);
		const first = await makeSession(manager);
		members.script("jev", { text: "no" }, { text: "rebut" }, { text: "no" }, { text: "rebut" });
		await first.sendUserMessage("go");
		expect(members.callsTo("writer")).toHaveLength(1);
		const file = manager.getSessionFile()!;
		await first.dispose();
		sessions.splice(0);
		const reopened = await makeSession(await SessionManager.open(file, sessionDir));
		expect(reopened.mixtureRuns().map(run => [run.status, run.key.host])).toEqual([
			["paused", reopened.sessionManager.getSessionId()],
		]);
		await reopened.sendUserMessage("more");
		expect(members.callsTo("writer")).toHaveLength(2);
		expect(members.callsTo("editor")).toHaveLength(2);
		const paused = reopened.mixtureRuns()[0]!;
		expect([paused.lifetime.hops, paused.window.hops, paused.status]).toEqual([4, 2, "paused"]);
		expect(reopened.agent.state.messages.findLast(message => message.role === "assistant")?.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("paused at prosecution after 4 hops"),
		});
	});

	it("restores the branch's pause checkpoint, but not an ancestor before it or a new session", async () => {
		fixture = await createMoaFixture(temp, limitsToml('max_hops = 2\non_limit = "pause"'));
		const manager = SessionManager.create(fixture.cwd, temp.join("sessions"));
		const session = await makeSession(manager);
		members.script("jev", { text: "no" }, { text: "rebut" }, { text: "no" }, { text: "rebut" });
		await session.sendUserMessage("go");
		const firstBranch = manager.getBranch();
		const firstUser = firstBranch.find(entry => entry.type === "message" && entry.message.role === "user");
		const firstAnswer = firstBranch.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
		if (!firstUser || !firstAnswer) throw new Error("first turn missing");
		await session.sendUserMessage("more");
		const secondUser = manager
			.getBranch()
			.findLast(entry => entry.type === "message" && entry.message.role === "user");
		if (!secondUser) throw new Error("second prompt missing");
		expect(session.mixtureRuns()[0]?.lifetime.hops).toBe(4);
		await session.navigateTree(firstAnswer.id);
		expect(session.mixtureRuns()[0]?.lifetime.hops).toBe(2);
		await session.branch(secondUser.id);
		expect(session.mixtureRuns().map(run => [run.lifetime.hops, run.key.host])).toEqual([
			[2, session.sessionManager.getSessionId()],
		]);
		await session.branch(firstUser.id);
		expect(session.mixtureRuns()).toEqual([]);
		await session.newSession();
		expect(session.mixtureRuns()).toEqual([]);
	});

	it("persists reset lifecycle and shows live hop and spend before dropping the run", async () => {
		fixture = await createMoaFixture(temp, limitsToml('max_hops = 2\non_limit = "pause"'));
		const sessionDir = temp.join("sessions");
		const manager = SessionManager.create(fixture.cwd, sessionDir);
		const session = await makeSession(manager);
		members.script("jev", { text: "no" }, { text: "rebut" });
		await session.sendUserMessage("go");
		const runId = session.mixtureRuns()[0]?.id;
		if (!runId) throw new Error("paused run missing");
		expect(formatMixtureStatus(session.mixtureRuns(), session.settings)).toContain(
			"mixture/courtroom: paused · phase hop_ready · member prosecution · hops 2 (window 2/2)",
		);
		expect(formatMixtureStatus(session.mixtureRuns(), session.settings)).toMatch(
			/spent \$\d+\.\d\d \(window \$\d+\.\d\d\)/,
		);
		const reset = session.resetMixtureRuns();
		expect(reset).toEqual([{ mixture: "courtroom", runId }]);
		expect(formatMixtureReset(reset)).toContain("reset 1 mixture run(s): mixture/courtroom");
		expect(
			manager
				.getBranch()
				.filter(
					entry =>
						entry.type === "custom" &&
						entry.customType === MIXTURE_RUN_ENTRY_TYPE &&
						(entry.data as { kind?: string }).kind === "run_reset",
				),
		).toHaveLength(1);
		expect(formatMixtureStatus(session.mixtureRuns(), session.settings)).toBe("no active mixture run");
		expect(formatMixtureReset(session.resetMixtureRuns())).toBe("no active mixture run");
		const file = manager.getSessionFile()!;
		await session.dispose();
		sessions.splice(0);
		const reopened = await makeSession(await SessionManager.open(file, sessionDir));
		expect(reopened.mixtureRuns()).toEqual([]);
		await reopened.sendUserMessage("go");
		expect(members.callsTo("writer")).toHaveLength(2);
	});

	it("does not restore a completed run on session reload", async () => {
		fixture = await createMoaFixture(temp, COURTROOM_TOML);
		const sessionDir = temp.join("sessions");
		const manager = SessionManager.create(fixture.cwd, sessionDir);
		const session = await makeSession(manager);
		members.script("jev", { text: "no" }, { text: "verdict" });
		await session.sendUserMessage("go");
		expect(session.mixtureRuns()[0]?.status).toBe("done");
		const file = manager.getSessionFile()!;
		await session.dispose();
		sessions.splice(0);
		const reopened = await makeSession(await SessionManager.open(file, sessionDir));
		expect(reopened.mixtureRuns()).toEqual([]);
		await reopened.sendUserMessage("again");
		expect(members.callsTo("writer")).toHaveLength(2);
	});
	it("refuses a paused run whose pinned members no longer resolve and reports why", async () => {
		fixture = await createMoaFixture(temp, limitsToml('max_hops = 2\non_limit = "pause"'));
		const sessionDir = temp.join("sessions");
		const manager = SessionManager.create(fixture.cwd, sessionDir);
		const session = await makeSession(manager);
		members.script("jev", { text: "no" }, { text: "rebut" });
		await session.sendUserMessage("go");
		const file = manager.getSessionFile()!;
		await session.dispose();
		sessions.splice(0);
		const warn = vi.spyOn(logger, "warn");
		const notices: string[] = [];
		const reopened = await SessionManager.open(file, sessionDir);
		const host = await directHost(
			reopened,
			Settings.isolated({
				"compaction.enabled": false,
				"moa.summary_model": "fake/summary",
				modelRoles: { judge: "fake/jev" },
				"retry.fallbackChains": { judge: [] },
				enabledModels: ["fake/writer", "fake/jev", "fake/summary"],
			}),
			notices,
		);
		host.restoreConversation();
		expect(host.runs.runs()).toEqual([]);
		expect(warn.mock.calls.some(([message]) => message === "mixture run not restored")).toBe(true);
		expect(notices.some(message => message.includes("could not be restored"))).toBe(true);
		warn.mockRestore();
	});
	it("recovers a hop checkpoint without regenerating the settled member", async () => {
		fixture = await createMoaFixture(temp, DRAFT_THEN_EDIT_TOML);
		const sessionDir = temp.join("sessions");
		const manager = SessionManager.create(fixture.cwd, sessionDir);
		const first = await directHost(manager);
		const model = fixture.registry.find("mixture", "draft-then-edit");
		if (!model) throw new Error("mixture model missing");
		const request = { messages: [{ role: "user" as const, content: "go", timestamp: 0 }] };
		members.script("writer", { text: "draft", cost: 0.01 });
		members.script("editor", { text: "answer", cost: 0.02 });
		manager.appendMessage(await streamMixture(model, request, {}, first).result());
		await manager.flush();
		const file = manager.getSessionFile()!;
		const lines = (await Bun.file(file).text()).trimEnd().split("\n");
		const checkpointIndex = lines.findIndex(line => {
			const entry = JSON.parse(line) as SessionEntry;
			return (
				entry.type === "custom" &&
				entry.customType === MIXTURE_RUN_ENTRY_TYPE &&
				(entry.data as MixtureCheckpoint).reason === "hop" &&
				(entry.data as MixtureCheckpoint).run.phase.kind === "decision_pending"
			);
		});
		expect(checkpointIndex).toBeGreaterThan(0);
		await Bun.write(file, `${lines.slice(0, checkpointIndex + 1).join("\n")}\n`);
		const reopened = await SessionManager.open(file, sessionDir);
		const second = await directHost(reopened);
		second.restoreConversation();
		expect(second.runs.runs()[0]?.phase.kind).toBe("decision_pending");
		members.script("editor", { text: "answer after crash", cost: 0.03 });
		const answer = await streamMixture(model, request, {}, second).result();
		expect(members.calls.map(call => call.model.id)).toEqual(["writer", "editor", "editor"]);
		expect(answer.content).toEqual([{ type: "text", text: "answer after crash" }]);
		expect(answer.usageBreakdown?.map(entry => [entry.model, entry.usage.cost.total])).toEqual([
			["writer", 0.01],
			["editor", 0.03],
		]);
	});
	for (const scenario of [
		{ name: "a decision checkpoint", reason: "decision", phase: "hop_ready", calls: ["editor"], answer: "recovered" },
		{ name: "an uncommitted done checkpoint", reason: "done", phase: "finalizing", calls: [], answer: "original" },
	] as const) {
		it(`recovers ${scenario.name} without replaying settled calls`, async () => {
			fixture = await createMoaFixture(temp, DRAFT_THEN_EDIT_TOML);
			const sessionDir = temp.join("sessions");
			const manager = SessionManager.create(fixture.cwd, sessionDir);
			const first = await directHost(manager);
			const model = fixture.registry.find("mixture", "draft-then-edit");
			if (!model) throw new Error("mixture model missing");
			const request = { messages: [{ role: "user" as const, content: "go", timestamp: 0 }] };
			members.script("writer", { text: "draft", cost: 0.01 });
			members.script("editor", { text: "original", cost: 0.02 });
			const original = await streamMixture(model, request, {}, first).result();
			manager.appendMessage(original);
			await manager.flush();
			const file = manager.getSessionFile()!;
			const lines = (await Bun.file(file).text()).trimEnd().split("\n");
			const index = lines.findIndex(line => {
				const entry = JSON.parse(line) as SessionEntry;
				if (entry.type !== "custom" || entry.customType !== MIXTURE_RUN_ENTRY_TYPE) return false;
				const checkpoint = entry.data as MixtureCheckpoint;
				return (
					checkpoint.reason === scenario.reason &&
					checkpoint.run.phase.kind === (scenario.reason === "done" ? "ended" : scenario.phase)
				);
			});
			expect(index).toBeGreaterThan(0);
			await Bun.write(file, `${lines.slice(0, index + 1).join("\n")}\n`);
			const reopened = await SessionManager.open(file, sessionDir);
			const second = await directHost(reopened);
			second.restoreConversation();
			expect(second.runs.runs()[0]?.phase.kind).toBe(scenario.phase);
			const before = members.calls.length;
			members.script("editor", { text: "recovered", cost: 0.03 });
			const answer = await streamMixture(model, request, {}, second).result();
			expect(members.calls.slice(before).map(call => call.model.id)).toEqual([...scenario.calls]);
			expect(answer.content).toEqual([{ type: "text", text: scenario.answer }]);
			expect(answer.usageBreakdown?.map(entry => entry.model)).toEqual(["writer", "editor"]);
		});
	}
	it("rehydrates the conversation and entry image when an errored first hop is retried", async () => {
		fixture = await createMoaFixture(temp, DRAFT_THEN_EDIT_TOML);
		const sessionDir = temp.join("sessions");
		const manager = SessionManager.create(fixture.cwd, sessionDir);
		const first = await directHost(manager);
		const model = fixture.registry.find("mixture", "draft-then-edit");
		if (!model) throw new Error("mixture model missing");
		const earlier: Message = { role: "user", content: "earlier question", timestamp: 0 };
		members.script("editor", { text: "earlier answer" });
		const a1 = await streamMixture(model, { messages: [earlier] }, {}, first).result();
		manager.appendMessage(a1);
		first.commitPersisted(a1);
		const request: Message[] = [
			earlier,
			a1,
			{
				role: "user",
				timestamp: 1,
				content: [
					{ type: "text", text: "go" },
					{
						type: "image",
						mimeType: "image/png",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",
					},
				],
			},
		];
		members.script("writer", { error: { message: "flaky" } });
		const error = await streamMixture(model, { messages: request }, {}, first).result();
		manager.appendMessage(error);
		first.commitPersisted(error);
		const saved = manager
			.getBranch()
			.findLast(
				entry =>
					entry.type === "custom" &&
					entry.customType === MIXTURE_RUN_ENTRY_TYPE &&
					(entry.data as MixtureCheckpoint).reason === "error",
			);
		const checkpoint = saved?.type === "custom" ? (saved.data as MixtureCheckpoint) : undefined;
		expect(checkpoint?.entry?.topicImages).toHaveLength(1);
		expect(checkpoint?.entry?.conversation).toContain("earlier answer");
		await manager.flush();
		const reopened = await SessionManager.open(manager.getSessionFile()!, sessionDir);
		const second = await directHost(reopened);
		second.restoreConversation();
		expect(second.runs.runs()[0]?.status).toBe("error");
		members.script("writer", { text: "draft after reload" });
		await streamMixture(model, { messages: request }, {}, second).result();
		const replay = members.callsTo("writer").at(-1)?.context.messages[0];
		const blocks = replay?.role === "user" && Array.isArray(replay.content) ? replay.content : [];
		expect(blocks.some(block => block.type === "image")).toBe(true);
		expect(blocks.some(block => block.type === "text" && block.text.includes("earlier answer"))).toBe(true);
		expect(members.callsTo("editor")).toHaveLength(2);
	});
});

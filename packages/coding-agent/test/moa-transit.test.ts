import { afterEach, beforeEach, expect, it } from "bun:test";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { clearCustomApis } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { fitHopRequest, type HopParts } from "@oh-my-pi/pi-coding-agent/moa/budget";
import { renderToolTrace } from "@oh-my-pi/pi-coding-agent/moa/envelopes";
import { registerMixtureApi } from "@oh-my-pi/pi-coding-agent/moa/provider";
import { renderTranscript, toolCallSummaries } from "@oh-my-pi/pi-coding-agent/moa/transcript";
import type { HopRecord, MixtureCheckpoint } from "@oh-my-pi/pi-coding-agent/moa/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createMoaFixture, createMoaSession, FakeMembers, type MoaFixture } from "./helpers/moa-setup";

const CYCLE_TOML = `
[[mixtures]]
name = "cycle"
entry = "a"
[[mixtures.members]]
id = "a"
model = "fake/writer"
system_prompt = "Write the case."
tools = false
[[mixtures.members]]
id = "b"
model = "fake/editor"
system_prompt = "Review the case."
tools = false
[[mixtures.edges]]
from = "a"
to = "b"
x = { output = true }
[[mixtures.edges]]
from = "b"
to = "a"
x = { transcript = { budget_tokens = 40 } }
max_traversals = 3
[mixtures.limits]
max_hops = 8
on_limit = "stop"
`;

let temp: TempDir;
let fixture: MoaFixture;
let members: FakeMembers;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	temp = TempDir.createSync("@moa-transit-");
	members = new FakeMembers();
	registerMixtureApi();
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	fixture?.authStorage.close();
	clearCustomApis();
	temp.removeSync();
});

async function cycle(
	toml = CYCLE_TOML,
	settings = Settings.isolated({ "compaction.enabled": false }),
	wordsPerHop = 80,
): Promise<AgentSession> {
	fixture = await createMoaFixture(temp, toml);
	const session = await createMoaSession(fixture, { settings });
	sessions.push(session);
	const model = fixture.registry.find("mixture", "cycle");
	if (!model) throw new Error("cycle was not registered");
	await session.setModel(model);
	for (let n = 1; n <= 8; n++)
		members.script(n % 2 ? "writer" : "editor", { text: `${"lorem ".repeat(wordsPerHop)}${n}` });
	return session;
}

function userText(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
}

function callEnvelope(model: "writer" | "editor", index: number): string {
	return userText(members.callsTo(model)[index]?.context.messages[0]);
}

it("transcript contains only completed outputs with hop identities, never input envelopes", () => {
	const hop = (index: number, status: HopRecord["status"]): HopRecord => ({
		index,
		memberId: `m${index}`,
		edgeInId: index === 1 ? undefined : `e${index}`,
		input: `PRIVATE INPUT ${index}`,
		messages: [],
		output: `OUTPUT ${index}`,
		reasoning: "",
		toolTrace: "",
		decisions: [],
		status,
		startedAt: 0,
	});
	const text = renderTranscript([hop(1, "done"), hop(2, "failed"), hop(3, "done")]);
	expect(text).toContain("[hop 1 · m1 ← entry]\nOUTPUT 1");
	expect(text).toContain("[hop 3 · m3 ← e3]\nOUTPUT 3");
	expect(text).not.toContain("PRIVATE INPUT");
	expect(text).not.toContain("OUTPUT 2");
});

it("retains recent hops and omits older outputs on an over-budget verbatim edge", async () => {
	const session = await cycle();
	await session.sendUserMessage("debate");
	const third = callEnvelope("writer", 1);
	expect(third).toContain("[hop 1 · a ← entry]");
	expect(third).toContain("[hop 2 · b ← a->b]");
	const fifth = callEnvelope("writer", 2);
	expect(fifth).toContain("[… 2 earlier hops omitted]");
	expect(fifth).toContain("[hop 3 · a ← b->a]");
	expect(fifth).toContain("[hop 4 · b ← a->b]");
	expect(fifth).not.toContain("[hop 1");
	expect(callEnvelope("writer", 3)).toContain("[… 4 earlier hops omitted]");
});

it("compacts only the new fold and reports every helper attempt in the outer usage", async () => {
	const session = await cycle(
		CYCLE_TOML.replace("budget_tokens = 40", 'optimize = "compact", budget_tokens = 40'),
		Settings.isolated({ "compaction.enabled": false, "moa.summary_model": "fake/summary" }),
	);
	members.script("summary", { text: "SUMMARY-1", cost: 0.02 }, { text: "SUMMARY-2", cost: 0.02 });
	await session.sendUserMessage("debate");
	expect(members.callsTo("summary")).toHaveLength(2);
	const first = members.callsTo("summary")[0]!.context.messages.map(userText).join(" ");
	expect(first).toContain("lorem");
	expect(callEnvelope("writer", 2)).toContain("SUMMARY-1");
	expect(callEnvelope("writer", 3)).toContain("SUMMARY-2");
	const outer = session.agent.state.messages.findLast(message => message.role === "assistant");
	expect(outer?.role === "assistant" && outer.usageBreakdown?.filter(entry => entry.kind === "summary")).toHaveLength(
		2,
	);
});

it("attaches snapcompact archive images to a vision member instead of invoking a text summary", async () => {
	const session = await cycle(
		CYCLE_TOML.replace("budget_tokens = 40", 'optimize = "snapcompact", budget_tokens = 40'),
		Settings.isolated({ "compaction.enabled": false, "moa.summary_model": "fake/summary" }),
		8_000,
	);
	await session.sendUserMessage("debate");
	const fifth = members.callsTo("writer")[2]?.context.messages[0];
	expect(fifth?.role).toBe("user");
	if (fifth?.role !== "user" || typeof fifth.content === "string") return;
	expect(fifth.content[0]?.type).toBe("text");
	expect(fifth.content.some(block => block.type === "image")).toBe(true);
	expect(members.callsTo("summary")).toHaveLength(0);
});

it("falls back to a billed text summary when no snapcompact frame fits", async () => {
	const toml = CYCLE_TOML.replace(
		'system_prompt = "Write the case."',
		'system_prompt = "Write the case."\nmax_tokens = 60000',
	).replace("budget_tokens = 40", 'optimize = "snapcompact", budget_tokens = 40');
	const session = await cycle(
		toml,
		Settings.isolated({ "compaction.enabled": false, "moa.summary_model": "fake/summary" }),
	);
	members.script("summary", { text: "fold one" }, { text: "fold two" });
	await session.sendUserMessage("debate");
	expect(members.callsTo("summary")).toHaveLength(2);
	expect(callEnvelope("writer", 2)).toContain("fold one");
	const fifth = members.callsTo("writer")[2]?.context.messages[0];
	if (fifth?.role !== "user" || typeof fifth.content === "string") throw new Error("no fifth-hop input");
	expect(fifth.content.some(block => block.type === "image")).toBe(false);
});

it("settles a summary after a caller abort without allocating its next hop", async () => {
	const session = await cycle(
		CYCLE_TOML.replace("budget_tokens = 40", 'optimize = "compact", budget_tokens = 40'),
		Settings.isolated({ "compaction.enabled": false, "moa.summary_model": "fake/summary" }),
	);
	const release = Promise.withResolvers<void>();
	members.script("summary", { waitForAbort: true, abortedAfter: release.promise, cost: 0.02 });
	const turn = session.sendUserMessage("debate");
	while (members.callsTo("summary").length === 0) await Bun.sleep(5);
	await session.abort();
	await turn.catch(() => {});
	release.resolve();
	await Bun.sleep(20);
	expect(members.callsTo("writer")).toHaveLength(2);
	const abort = session.sessionManager
		.getBranch()
		.findLast(
			entry =>
				entry.type === "custom" &&
				entry.customType === "mixture_run" &&
				typeof entry.data === "object" &&
				entry.data !== null &&
				"reason" in entry.data &&
				entry.data.reason === "abort",
		);
	expect(abort?.type === "custom" ? (abort.data as MixtureCheckpoint).run.hops.length : undefined).toBe(4);
	const late = session.sessionManager.getBranch().filter(entry => entry.type === "model_usage");
	expect(late.some(entry => entry.type === "model_usage" && entry.model === "summary")).toBe(true);
});

it("fails at the hop-ready continuation when summary generation fails and bills that attempt", async () => {
	const session = await cycle(
		CYCLE_TOML.replace("budget_tokens = 40", 'optimize = "compact", budget_tokens = 40'),
		Settings.isolated({ "compaction.enabled": false, "moa.summary_model": "fake/summary" }),
	);
	members.script("summary", { error: { message: "summary down" }, cost: 0.02 });
	await session.sendUserMessage("debate").catch(() => {});
	expect(members.callsTo("writer")).toHaveLength(2);
	expect(members.callsTo("editor")).toHaveLength(2);
	const outer = session.agent.state.messages.findLast(message => message.role === "assistant");
	expect(outer?.role === "assistant" && outer.errorMessage).toContain("helper.failed: transcript for edge b->a:");
	expect(outer?.role === "assistant" && outer.usageBreakdown?.filter(entry => entry.kind === "summary")).toHaveLength(
		1,
	);
});

it("tool trace preserves intent and bounds opaque argument previews", () => {
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "one", name: "read", arguments: { i: "reading foo", path: "foo" } },
			{ type: "toolCall", id: "two", name: "search", arguments: { payload: "x".repeat(500) } },
		],
		api: "fake-api",
		provider: "fake",
		model: "writer",
		timestamp: 0,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const lines = renderToolTrace(toolCallSummaries([message])).split("\n");
	expect(lines[0]).toBe("- read: reading foo");
	expect(lines[1]?.startsWith('- search: {"payload":"xxxx')).toBe(true);
	expect(lines[1]?.length).toBe(10 + 120);
});

it("fits transcript after the conversation without discarding higher-priority output", async () => {
	await cycle();
	const base = fixture.registry.find("fake", "writer");
	if (!base) throw new Error("writer not registered");
	const model = { ...base, contextWindow: 4500, maxTokens: 4000 };
	const parts = { output: "DRAFT ".repeat(35), conversation: "CHAT ".repeat(35), transcript: "HISTORY ".repeat(300) };
	const request = {
		target: model,
		systemPrompt: ["role"],
		hopMessages: [],
		partBudgetTokens: 4000,
		parts,
		assemble: (value: HopParts) => `${value.output ?? ""}\n${value.conversation ?? ""}\n${value.transcript ?? ""}`,
	};
	const fit = fitHopRequest(request);
	expect(fit.ok).toBe(true);
	if (!fit.ok) return;
	expect(fit.parts.output).toBe(parts.output);
	expect(fit.parts.conversation).toBe(parts.conversation);
	expect(fit.parts.transcript).not.toBe(parts.transcript);
});

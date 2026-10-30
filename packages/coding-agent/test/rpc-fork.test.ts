import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { parseSessionEntries, type SessionHeader } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import type { TreeNavigationExpected } from "@oh-my-pi/pi-coding-agent/session/tree-navigation";
import { rejectionOf } from "./helpers/rejection";

async function readSessionFile(sessionFile: string): Promise<{ header: SessionHeader; messageIds: string[] }> {
	const entries = parseSessionEntries(await Bun.file(sessionFile).text());
	return {
		header: entries[0] as SessionHeader,
		messageIds: entries.flatMap(entry => (entry.type === "message" ? [entry.id] : [])),
	};
}

describe("RPC fork and tree navigation", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-fork-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "fork-rpc-agent.ts"), directory],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		// Bind this test's resources before awaiting: a stop that outlives the
		// hook timeout resumes after the next beforeEach has reassigned both.
		const ownClient = client;
		const ownDirectory = directory;
		await ownClient?.stop();
		await removeWithRetries(ownDirectory);
	});

	/** Starts the agent and runs two finished turns; returns the [user, assistant, user, assistant] message entry ids. */
	async function seedTwoTurns(): Promise<string[]> {
		await client.start();
		await client.promptAndWait("first");
		await client.promptAndWait("second");
		const { entries } = await client.getEntries();
		const messageIds = entries.flatMap(entry => (entry.type === "message" ? [entry.id] : []));
		expect(messageIds).toHaveLength(4);
		return messageIds;
	}

	async function navigationIdentity(): Promise<TreeNavigationExpected> {
		const state = await client.getState();
		const { leafId } = await client.getTree();
		return {
			expectedSessionId: state.sessionId,
			expectedSessionFile: state.sessionFile ?? null,
			expectedLeafId: leafId,
		};
	}

	test("forks at an assistant entry: keeps it, drops later turns, leaves the source intact", async () => {
		const [firstUser, firstReply, ...later] = await seedTwoTurns();
		const source = await client.getState();

		expect(await client.fork(firstReply)).toEqual({ cancelled: false });

		const forked = await client.getState();
		expect(forked.sessionFile).not.toBe(source.sessionFile);
		expect(forked.sessionId).not.toBe(source.sessionId);
		// The live process continues from the cut, not just the new file.
		expect(forked.messageCount).toBe(2);
		const fork = await readSessionFile(forked.sessionFile!);
		expect(fork.messageIds).toEqual([firstUser, firstReply]);
		expect(fork.header.parentSession).toBe(source.sessionFile);
		expect((await readSessionFile(source.sessionFile!)).messageIds).toEqual([firstUser, firstReply, ...later]);
	}, 30_000);

	test("forks at a user entry and keeps that prompt as the last entry", async () => {
		const [firstUser, firstReply, secondUser] = await seedTwoTurns();

		expect(await client.fork(secondUser)).toEqual({ cancelled: false });

		const forked = await client.getState();
		expect(forked.messageCount).toBe(3);
		expect((await readSessionFile(forked.sessionFile!)).messageIds).toEqual([firstUser, firstReply, secondUser]);
	}, 30_000);

	test("without entryId forks the whole session", async () => {
		const messageIds = await seedTwoTurns();
		const source = await client.getState();

		expect(await client.fork()).toEqual({ cancelled: false });

		const forked = await client.getState();
		expect(forked.sessionFile).not.toBe(source.sessionFile);
		expect(forked.messageCount).toBe(4);
		const fork = await readSessionFile(forked.sessionFile!);
		expect(fork.messageIds).toEqual(messageIds);
		// Whole-session forks record the parent by session id (SessionManager.fork()).
		expect(fork.header.parentSession).toBe(source.sessionId);
	}, 30_000);

	test("rejects ids that are not transcript messages without switching sessions", async () => {
		await seedTwoTurns();
		await client.setThinkingLevel(ThinkingLevel.High);
		const source = await client.getState();
		const { entries } = await client.getEntries();
		const nonMessage = entries.find(entry => entry.type === "thinking_level_change");
		expect(nonMessage).toBeDefined();

		expect(await rejectionOf(client.fork("no-such-entry"))).toMatchObject({
			message: expect.stringMatching(/Invalid entry ID for forking/),
		});
		expect(await rejectionOf(client.fork(nonMessage!.id))).toMatchObject({
			message: expect.stringMatching(/Invalid entry ID for forking/),
		});
		expect((await client.getState()).sessionFile).toBe(source.sessionFile);
	}, 30_000);

	/** Resolves on the first session event `match` accepts; register before the action that causes it. */
	function nextEvent(match: (type: string) => boolean): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = client.onSessionEvent(event => {
			if (!match(event.type)) return;
			unsubscribe();
			resolve();
		});
		return promise;
	}

	/** Prompts the fixture's "slow" turn and resolves once its model call is in flight; it streams until aborted. */
	async function startStreamingTurn(): Promise<void> {
		const streaming = nextEvent(type => type === "notice");
		await client.prompt("slow");
		await withTimeout(streaming, 10_000, "Slow turn never reached the model");
	}

	test("refuses while a turn is streaming", async () => {
		const [, firstReply] = await seedTwoTurns();
		const source = await client.getState();
		const idle = nextEvent(type => type === "agent_end");
		await startStreamingTurn();
		expect((await client.getState()).isStreaming).toBe(true);

		expect(await rejectionOf(client.fork(firstReply))).toMatchObject({ command: "fork", code: "session_busy" });

		await client.abort();
		await withTimeout(idle, 10_000, "Streaming turn did not finish");
		expect((await client.getState()).sessionFile).toBe(source.sessionFile);
	}, 30_000);

	test("navigate_tree moves the leaf within the same session file", async () => {
		const [firstUser, firstReply, secondUser] = await seedTwoTurns();
		const source = await client.getState();

		expect(await client.navigateTree({ targetId: firstReply!, ...(await navigationIdentity()) })).toMatchObject({
			cancelled: false,
			outcome: "navigated",
			sessionId: source.sessionId,
			sessionFile: source.sessionFile,
			leafId: firstReply,
		});
		const navigated = await client.getState();
		expect(navigated.sessionFile).toBe(source.sessionFile);
		expect(navigated.sessionId).toBe(source.sessionId);
		expect((await client.getMessages()).map(message => message.role)).toEqual(["user", "assistant"]);

		// A user message rewinds past itself and hands its text back for the editor.
		expect(await client.navigateTree({ targetId: secondUser!, ...(await navigationIdentity()) })).toMatchObject({
			cancelled: false,
			outcome: "unchanged",
			editorText: "second",
			leafId: firstReply,
		});
		expect((await client.getState()).messageCount).toBe(2);
		expect((await readSessionFile(source.sessionFile!)).messageIds.slice(0, 2)).toEqual([firstUser, firstReply]);
	}, 30_000);

	test("navigate_tree with summarize lands a branch summary at the target", async () => {
		const [, firstReply] = await seedTwoTurns();

		expect(
			await client.navigateTree({ targetId: firstReply!, ...(await navigationIdentity()), summarize: true }),
		).toMatchObject({ cancelled: false, outcome: "navigated", summaryEntry: { type: "branch_summary" } });
		expect((await client.getMessages()).map(message => message.role)).toEqual(["user", "assistant", "branchSummary"]);
	}, 30_000);

	test("abort_branch_summary stops a running summary and nothing moves", async () => {
		const [, firstReply] = await seedTwoTurns();
		const started = nextEvent(type => type === "notice");

		const identity = await navigationIdentity();
		const navigated = client.navigateTree({
			targetId: firstReply!,
			...identity,
			summarize: true,
			customInstructions: "hang-summary",
		});
		await withTimeout(started, 10_000, "Branch summary never started");
		await client.abortBranchSummary();

		expect(await navigated).toMatchObject({
			cancelled: true,
			aborted: true,
			outcome: "cancelled",
			leafId: identity.expectedLeafId,
		});
		expect((await client.getState()).messageCount).toBe(4);
	}, 30_000);

	test("navigate_tree refuses while a turn is streaming", async () => {
		const [, firstReply] = await seedTwoTurns();
		const idle = nextEvent(type => type === "agent_end");
		await startStreamingTurn();

		expect(
			await rejectionOf(client.navigateTree({ targetId: firstReply!, ...(await navigationIdentity()) })),
		).toMatchObject({
			command: "navigate_tree",
			code: "session_busy",
		});
		await client.abort();
		await withTimeout(idle, 10_000, "Streaming turn did not finish");
		expect((await client.getState()).messageCount).toBe(6);
	}, 30_000);

	test("navigate_tree reserves admission while summarizing and refuses concurrent bash work", async () => {
		const [, firstReply] = await seedTwoTurns();
		const started = nextEvent(type => type === "notice");
		const identity = await navigationIdentity();
		const navigated = client.navigateTree({
			targetId: firstReply!,
			...identity,
			summarize: true,
			customInstructions: "hang-summary",
		});
		await withTimeout(started, 10_000, "Branch summary never started");
		// `bash` bypasses the serial queue but cannot bypass the native tree admission.
		expect(await rejectionOf(client.bash("sleep 60"))).toMatchObject({
			command: "bash",
			code: "session_busy",
		});
		await client.abortBranchSummary();
		expect(await navigated).toMatchObject({
			cancelled: true,
			aborted: true,
			outcome: "cancelled",
			leafId: identity.expectedLeafId,
		});
		expect((await client.getMessages()).map(message => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	}, 30_000);

	test("navigate_tree rejects an unknown or malformed entry id", async () => {
		await seedTwoTurns();

		expect(
			await rejectionOf(client.navigateTree({ targetId: "no-such-entry", ...(await navigationIdentity()) })),
		).toMatchObject({
			command: "navigate_tree",
			code: "invalid_target",
		});
		expect(
			await rejectionOf(client.navigateTree({ targetId: 42 as never, ...(await navigationIdentity()) })),
		).toMatchObject({
			command: "navigate_tree",
			code: "invalid_request",
		});
		expect((await client.getState()).messageCount).toBe(4);
	}, 30_000);

	test("navigate_tree probes a reopenable ask without moving, and lands on an unusable ask", async () => {
		await client.start();
		await client.promptAndWait("seed-ask");
		await client.promptAndWait("seed-bad-ask");
		const { entries } = await client.getEntries();
		const askResults = entries.flatMap(entry =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ask"
				? [entry.id]
				: [],
		);
		expect(askResults).toHaveLength(2);
		const [reopenable, unusable] = askResults;

		const identity = await navigationIdentity();
		expect(
			await client.navigateTree({ targetId: reopenable!, ...identity, allowAskReopen: true }),
		).toMatchObject({
			cancelled: false,
			outcome: "ask_reopen",
			leafId: identity.expectedLeafId,
			reopenAsk: { questions: [{ id: "target", question: "Where?" }] },
		});
		expect((await client.getState()).messageCount).toBe(8);

		expect(
			await client.navigateTree({ targetId: unusable!, ...(await navigationIdentity()), allowAskReopen: true }),
		).toMatchObject({ cancelled: false, outcome: "navigated", leafId: unusable });
		expect((await client.getMessages()).at(-1)).toMatchObject({ role: "toolResult", toolName: "ask" });
	}, 30_000);

	test("holds a waiting goal continuation through the navigation, then runs it in the new branch", async () => {
		const [, firstReply] = await seedTwoTurns();
		// The fixture holds this goal's first continuation until the branch summary starts: decided, not started.
		await client.goal("create", { objective: "keep going" });
		const continued = nextEvent(type => type === "agent_end");

		// A refused navigation leaves the waiting continuation alone: it neither starts nor is dropped.
		expect(
			await rejectionOf(client.navigateTree({ targetId: "no-such-entry", ...(await navigationIdentity()) })),
		).toMatchObject({ code: "invalid_target" });
		expect(
			await client.navigateTree({ targetId: firstReply!, ...(await navigationIdentity()), summarize: true }),
		).toMatchObject({ cancelled: false, outcome: "navigated", summaryEntry: { type: "branch_summary" } });
		await withTimeout(continued, 10_000, "Goal continuation never ran");
		const kinds = (await client.getMessages()).map(message =>
			message.role === "custom" ? message.customType : message.role,
		);
		// Run mid-navigation, the continuation would have landed in the branch the leaf left.
		expect(kinds.slice(0, 3)).toEqual(["user", "assistant", "branchSummary"]);
		expect(kinds).toContain("goal-continuation");
	}, 30_000);

	test("set_label sets and clears an entry's label, and rejects bad input", async () => {
		const [firstUser] = await seedTwoTurns();

		await client.setLabel(firstUser!, "start");
		expect((await client.getEntries()).entries.at(-1)).toMatchObject({
			type: "label",
			targetId: firstUser,
			label: "start",
		});
		await client.setLabel(firstUser!, undefined);
		const cleared = (await client.getEntries()).entries.at(-1);
		expect(cleared).toMatchObject({ type: "label", targetId: firstUser });
		expect(cleared).not.toHaveProperty("label");

		expect(await rejectionOf(client.setLabel("no-such-entry", "x"))).toMatchObject({
			command: "set_label",
			message: expect.stringContaining("not found"),
		});
		expect(await rejectionOf(client.setLabel(firstUser!, 123 as never))).toMatchObject({
			message: expect.stringContaining("label must be a string"),
		});
	}, 30_000);
});

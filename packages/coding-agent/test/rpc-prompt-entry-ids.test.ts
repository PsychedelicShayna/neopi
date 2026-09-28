/**
 * Issue #117: `prompt`, `steer` and `follow_up` responses carry the id of the
 * session entry their message is written as (`data.userEntryId`), and every
 * `get_messages_page` message carries the `entryId` of the entry it came from.
 * A local fake Anthropic endpoint scripts the model; a prompt containing
 * `HOLD` stalls its model response until the test releases it, which keeps the
 * run streaming while steer/follow-up commands are queued.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { type RpcFrame, RpcChild } from "./helpers/rpc-child";

type SseEvent = Record<string, unknown> & { type: string };

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function textReply(id: string, text: string): SseEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id,
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage,
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage },
		{ type: "message_stop" },
	];
}

function textOf(message: unknown): string {
	if (!isRecord(message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isRecord)
		.filter(block => block.type === "text")
		.map(block => String(block.text))
		.join("\n");
}

let server: Bun.Server<undefined>;
let replies = 0;
/** Armed by a test: the next request whose last message mentions HOLD waits on `release`. */
let hold: { received: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (!new URL(request.url).pathname.endsWith("/messages")) return new Response("not found", { status: 404 });
			const body = (await request.json()) as { messages?: unknown[] };
			const pending = hold;
			if (pending && textOf(body.messages?.at(-1)).includes("HOLD")) {
				hold = undefined;
				pending.received.resolve();
				await pending.release.promise;
			}
			const sse = textReply(`msg_${++replies}`, "done")
				.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
				.join("");
			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		},
	});
});

afterAll(() => {
	server.stop(true);
});

const children: RpcChild[] = [];
const roots: TempDir[] = [];

afterEach(async () => {
	hold?.release.resolve();
	hold = undefined;
	await Promise.all(children.splice(0).map(child => child.dispose()));
	await Promise.all(roots.splice(0).map(root => root.remove()));
});

/** Spawn an RPC child; `configYaml` becomes its agent `config.yml` before startup. */
async function spawnChild(configYaml?: string): Promise<RpcChild> {
	let root: string | undefined;
	if (configYaml) {
		const dir = await TempDir.create("@rpc-prompt-entry-ids-");
		roots.push(dir);
		root = dir.path();
		await Bun.write(path.join(root, "agent", "config.yml"), configYaml);
	}
	const child = await RpcChild.spawn({
		root,
		args: ["--model", "anthropic/claude-sonnet-4-5"],
		env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` },
	});
	children.push(child);
	await child.waitFor(frame => frame.type === "ready", 30_000);
	return child;
}

function dataOf(response: RpcFrame): Record<string, unknown> {
	expect(response.success).toBe(true);
	return isRecord(response.data) ? response.data : {};
}

/** Sends a prompt, returns its `userEntryId`, and waits for its `prompt_result`. */
async function promptAndSettle(child: RpcChild, id: string, message: string): Promise<string> {
	const settled = child.waitFor(frame => frame.type === "prompt_result" && frame.id === id, 30_000);
	const userEntryId = dataOf(await child.request({ id, type: "prompt", message })).userEntryId;
	expect(typeof userEntryId).toBe("string");
	expect(await settled).toMatchObject({ agentInvoked: true, status: "completed" });
	return userEntryId as string;
}

async function entriesById(child: RpcChild): Promise<Map<string, Record<string, unknown>>> {
	const entries = dataOf(await child.request({ type: "get_entries" })).entries;
	expect(Array.isArray(entries)).toBe(true);
	return new Map((entries as unknown[]).filter(isRecord).map(entry => [String(entry.id), entry]));
}

/** Pages every message; retries while the session is still busy finishing the run. */
async function pagedMessages(child: RpcChild): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + 20_000;
	while (true) {
		const response = await child.request({ type: "get_messages_page", limit: 256 });
		if (response.success === true) {
			const messages = dataOf(response).messages;
			expect(Array.isArray(messages)).toBe(true);
			return (messages as unknown[]).filter(isRecord);
		}
		if (response.code !== "session_busy" || Date.now() > deadline) throw new Error(JSON.stringify(response));
		await Bun.sleep(50);
	}
}

/** The written message behind a `message` or `custom_message` entry. */
function entryMessageText(entry: Record<string, unknown> | undefined): string {
	if (!entry) return "";
	return entry.type === "message" ? textOf(entry.message) : textOf(entry);
}

describe("RPC prompt entry ids (#117)", () => {
	test("advertises prompt_entry_ids", async () => {
		const child = await spawnChild();
		const ready = child.frames.find(frame => frame.type === "ready");
		expect(ready?.capabilities).toContain("prompt_entry_ids");
	});

	test("a prompt's userEntryId is the user entry it wrote, and paged messages carry their entry ids", async () => {
		const child = await spawnChild();
		const first = await promptAndSettle(child, "p1", "first question");
		// A magic keyword adds a hidden custom_message entry to the turn.
		const second = await promptAndSettle(child, "p2", "ultrathink second question");

		const entries = await entriesById(child);
		expect(entries.get(first)).toMatchObject({ type: "message", message: { role: "user" } });
		expect(entryMessageText(entries.get(first))).toBe("first question");
		expect(entries.get(second)).toMatchObject({ type: "message", message: { role: "user" } });
		expect(entryMessageText(entries.get(second))).toBe("ultrathink second question");

		const messages = await pagedMessages(child);
		expect(messages.length).toBeGreaterThanOrEqual(4);
		for (const message of messages) {
			expect(typeof message.entryId).toBe("string");
			const entry = entries.get(message.entryId as string);
			expect(entry).toBeDefined();
			expect(entryMessageText(entry)).toBe(textOf(message));
		}
		expect(messages.find(message => message.entryId === first)).toMatchObject({ role: "user" });
		expect(messages.find(message => message.entryId === second)).toMatchObject({ role: "user" });
		const custom = messages.find(message => message.role === "custom");
		expect(custom).toBeDefined();
		expect(entries.get(custom?.entryId as string)?.type).toBe("custom_message");
	});

	test("steer and follow_up answer with the ids of the entries they write", async () => {
		const child = await spawnChild();
		hold = { received: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		const { received, release } = hold;
		const settled = child.waitFor(frame => frame.type === "prompt_result" && frame.id === "held", 30_000);
		const promptId = dataOf(
			await child.request({ id: "held", type: "prompt", message: "HOLD the first turn" }),
		).userEntryId;
		await received.promise;

		const steerId = dataOf(await child.request({ type: "steer", message: "steer this turn" })).userEntryId;
		const followUpId = dataOf(
			await child.request({ type: "follow_up", message: "follow up afterwards" }),
		).userEntryId;
		expect(typeof steerId).toBe("string");
		expect(typeof followUpId).toBe("string");
		expect(new Set([promptId, steerId, followUpId]).size).toBe(3);

		release.resolve();
		await settled;
		const messages = await pagedMessages(child);
		const entries = await entriesById(child);

		const expected = new Map([
			[promptId as string, "HOLD the first turn"],
			[steerId as string, "steer this turn"],
			[followUpId as string, "follow up afterwards"],
		]);
		for (const [entryId, text] of expected) {
			expect(entries.get(entryId)).toMatchObject({ type: "message", message: { role: "user" } });
			expect(entryMessageText(entries.get(entryId))).toBe(text);
			const message = messages.find(candidate => candidate.entryId === entryId);
			expect(message).toMatchObject({ role: "user" });
			expect(textOf(message)).toBe(text);
		}
		// Written in delivery order: prompt, then the steer, then the follow-up.
		const order = messages.map(message => message.entryId).filter(entryId => expected.has(entryId as string));
		expect(order).toEqual([promptId, steerId, followUpId]);
	});

	test("prompt with streamingBehavior answers with the entry id of the queued message", async () => {
		const child = await spawnChild();
		hold = { received: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		const { received, release } = hold;
		const settled = child.waitFor(frame => frame.type === "prompt_result" && frame.id === "held", 30_000);
		await child.request({ id: "held", type: "prompt", message: "HOLD the first turn" });
		await received.promise;

		const queuedId = dataOf(
			await child.request({ type: "prompt", message: "queued behind the turn", streamingBehavior: "followUp" }),
		).userEntryId;
		release.resolve();
		await settled;
		const messages = await pagedMessages(child);
		const entries = await entriesById(child);
		expect(typeof queuedId).toBe("string");
		expect(entryMessageText(entries.get(queuedId as string))).toBe("queued behind the turn");
		expect(textOf(messages.find(message => message.entryId === queuedId))).toBe("queued behind the turn");
	});

	test("after compaction the summary message carries the compaction entry id", async () => {
		// Keep almost nothing verbatim so two short turns are enough to compact.
		const child = await spawnChild("compaction:\n  keepRecentTokens: 1\n");
		await promptAndSettle(child, "p1", "first question");
		await promptAndSettle(child, "p2", "second question");
		expect(await child.request({ type: "compact" }, 30_000)).toMatchObject({ success: true });

		const entries = await entriesById(child);
		const messages = await pagedMessages(child);
		const summary = messages.find(message => message.role === "compactionSummary");
		expect(summary).toBeDefined();
		expect(entries.get(summary?.entryId as string)?.type).toBe("compaction");
		for (const message of messages) expect(entries.has(message.entryId as string)).toBe(true);
	});

	test("branch with a prompt's userEntryId removes exactly that turn", async () => {
		const child = await spawnChild();
		await promptAndSettle(child, "p1", "keep this turn");
		const dropped = await promptAndSettle(child, "p2", "drop this turn");

		const branched = dataOf(await child.request({ type: "branch", entryId: dropped }));
		expect(branched).toEqual({ text: "drop this turn", cancelled: false });

		const messages = await pagedMessages(child);
		expect(messages.map(message => [message.role, textOf(message)])).toEqual([
			["user", "keep this turn"],
			["assistant", "done"],
		]);
	});
});

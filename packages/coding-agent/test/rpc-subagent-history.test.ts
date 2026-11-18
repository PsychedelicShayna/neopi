/**
 * `get_subagent_history` lists the root session's whole child tree, hydrated like the Agent Hub, and
 * `get_subagent_messages` reads persisted children, so the roster survives a restart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createRpcCommandHandler, type RpcCommandHandlerContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function line(entry: object): string {
	return `${JSON.stringify(entry)}\n`;
}

function transcript(text: string, cost: number): string {
	return (
		line({ type: "session", id: "s0", parentId: null, timestamp: "2026-08-07T10:00:00.000Z" }) +
		line({
			type: "message",
			id: "u1",
			parentId: "s0",
			timestamp: "2026-08-07T10:00:01.000Z",
			message: { role: "user", content: text, timestamp: 1 },
		}) +
		line({
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-08-07T10:00:05.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `done ${text}` }],
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: { input: 10, output: 20, totalTokens: 30, cost: { total: cost } },
			},
		})
	);
}

describe("subagent roster history", () => {
	let dir: string;
	let rootFile: string;
	let handle: (command: RpcCommand) => Promise<RpcResponse>;

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-roster-"));
		rootFile = path.join(dir, "root.jsonl");
		await Bun.write(rootFile, "");
		await Bun.write(path.join(dir, "root", "Worker.jsonl"), transcript("worker task", 0.25));
		await Bun.write(path.join(dir, "root", "Worker", "Child.jsonl"), transcript("child task", 0.5));
		await Bun.write(path.join(dir, "root", "Killed.jsonl"), transcript("killed task", 0.1));
		await Bun.write(getAgentTombstonePath(path.join(dir, "root", "Killed.jsonl")), "");
		await Bun.write(path.join(dir, "root", "__advisor.jsonl"), transcript("advice", 0.01));
		await Bun.write(path.join(dir, "other.jsonl"), "");
		await Bun.write(path.join(dir, "other", "Stranger.jsonl"), transcript("stranger", 1));
		const session = { sessionFile: rootFile, getAgentId: () => "Main" } as unknown as AgentSession;
		const context: Partial<RpcCommandHandlerContext> = {
			session,
			success: (id, command, data) =>
				({ id, type: "response", command, success: true, ...(data !== undefined ? { data } : {}) }) as RpcResponse,
			error: (id, command, error, code) =>
				({ id, type: "response", command, success: false, error, ...(code ? { code } : {}) }) as RpcResponse,
		};
		handle = createRpcCommandHandler(context as RpcCommandHandlerContext);
	});

	afterEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function history(includeAdvisors?: boolean) {
		const response = await handle({ id: "h", type: "get_subagent_history", includeAdvisors });
		if (!response.success || response.command !== "get_subagent_history") throw new Error(JSON.stringify(response));
		return response.data;
	}

	test("lists persisted children with status, parentage, timestamps, model and final usage", async () => {
		// Another root registered first must not leak into this root's roster.
		await handle({ id: "x", type: "get_subagent_history" });
		const result = await history();
		expect(result.rootSessionFile).toBe(rootFile);
		expect(result.rootAgentId).toBe("Main");
		const byId = Object.fromEntries(result.subagents.map(entry => [entry.id, entry]));
		expect(Object.keys(byId).sort()).toEqual(["Child", "Killed", "Worker"]);
		expect(byId.Worker).toMatchObject({
			kind: "sub",
			parentId: "Main",
			status: "parked",
			live: false,
			sessionFile: path.join(dir, "root", "Worker.jsonl"),
			resolvedModel: expect.stringContaining("claude-sonnet-4-5"),
		});
		expect(byId.Worker.createdAt).toBeGreaterThan(0);
		expect(byId.Worker.lastActivity).toBeGreaterThanOrEqual(byId.Worker.createdAt);
		expect(byId.Worker.metrics).toMatchObject({ requests: 1, cost: 0.25 });
		expect(byId.Child).toMatchObject({ parentId: "Worker", status: "parked", metrics: { cost: 0.5 } });
		expect(byId.Killed.status).toBe("aborted");
		const ordered = result.subagents.map(entry => entry.createdAt);
		expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
	});

	test("advisor transcripts appear only on request", async () => {
		expect((await history()).subagents.some(entry => entry.kind === "advisor")).toBe(false);
		const withAdvisors = await history(true);
		expect(withAdvisors.subagents.find(entry => entry.kind === "advisor")).toMatchObject({ status: "parked" });
	});

	test("a session with no transcript file has an empty roster", async () => {
		const bare = createRpcCommandHandler({
			session: { sessionFile: undefined, getAgentId: () => "Main" } as unknown as AgentSession,
			success: (id: string | undefined, command: string, data?: object | null) =>
				({ id, type: "response", command, success: true, data }) as RpcResponse,
			error: (id: string | undefined, command: string, error: string) =>
				({ id, type: "response", command, success: false, error }) as RpcResponse,
		} as unknown as RpcCommandHandlerContext);
		expect(await bare({ id: "b", type: "get_subagent_history" })).toMatchObject({
			success: true,
			data: { subagents: [] },
		});
	});

	test("rejects a non-boolean includeAdvisors", async () => {
		const response = await handle({
			id: "h",
			type: "get_subagent_history",
			includeAdvisors: "yes",
		} as unknown as RpcCommand);
		expect(response.success).toBe(false);
	});

	describe("get_subagent_messages", () => {
		async function messages(selection: Record<string, unknown>) {
			return handle({ id: "m", type: "get_subagent_messages", ...selection } as RpcCommand);
		}

		test("reads a persisted child by id and pages incrementally", async () => {
			const first = await messages({ subagentId: "Worker" });
			if (!first.success || first.command !== "get_subagent_messages") throw new Error(JSON.stringify(first));
			expect(first.data.sessionFile).toBe(path.join(dir, "root", "Worker.jsonl"));
			expect(first.data.messages.map(message => message.role)).toEqual(["user", "assistant"]);
			const next = await messages({ subagentId: "Worker", fromByte: first.data.nextByte });
			expect(next).toMatchObject({ success: true, data: { messages: [], reset: false } });
		});

		test("reads a nested child by session file inside the tree", async () => {
			const file = path.join(dir, "root", "Worker", "Child.jsonl");
			const response = await messages({ sessionFile: file });
			expect(response).toMatchObject({ success: true, data: { sessionFile: file } });
		});

		test("refuses transcripts outside the root's tree, the root transcript itself, and unknown ids", async () => {
			expect((await messages({ sessionFile: path.join(dir, "other", "Stranger.jsonl") })).success).toBe(false);
			expect((await messages({ sessionFile: rootFile })).success).toBe(false);
			expect((await messages({ subagentId: "Stranger" })).success).toBe(false);
			expect((await messages({ subagentId: "Nobody" })).success).toBe(false);
			expect(
				(await messages({ sessionFile: path.join(dir, "root", "..", "other", "Stranger.jsonl") })).success,
			).toBe(false);
		});
	});
});

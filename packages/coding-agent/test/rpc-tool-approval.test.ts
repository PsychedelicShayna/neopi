/**
 * Issue #102: `set_approval_handler { handler: "host" }` replaces the
 * `Allow tool:` select dialog with typed `tool_approval_request` /
 * `tool_approval_response` frames. A local fake Anthropic endpoint scripts the
 * model: a user message `CALL <tool> <json>` answers with that tool call, a tool
 * result answers with plain text.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { type RpcFrame, RpcChild } from "./helpers/rpc-child";

type SseEvent = Record<string, unknown> & { type: string };

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function messageStart(id: string): SseEvent {
	return {
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
	};
}

function toolUseReply(id: string, name: string, input: unknown): SseEvent[] {
	return [
		messageStart(`msg_${id}`),
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage },
		{ type: "message_stop" },
	];
}

function textReply(id: string, text: string): SseEvent[] {
	return [
		messageStart(id),
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage },
		{ type: "message_stop" },
	];
}

function blocksOf(message: unknown): Array<Record<string, unknown>> {
	if (!isRecord(message)) return [];
	const { content } = message;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.filter(isRecord) : [];
}

let server: Bun.Server<undefined>;
let nextToolUse = 0;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (!new URL(request.url).pathname.endsWith("/messages")) return new Response("not found", { status: 404 });
			const body = (await request.json()) as { messages?: unknown[] };
			const blocks = blocksOf(body.messages?.at(-1));
			const text = blocks
				.filter(block => block.type === "text")
				.map(block => String(block.text))
				.join("\n");
			const call = blocks.some(block => block.type === "tool_result") ? null : /CALL (\w+) (\{.*\})/.exec(text);
			const events = call
				? toolUseReply(`toolu_${++nextToolUse}`, call[1]!, JSON.parse(call[2]!))
				: textReply(`msg_text_${++nextToolUse}`, "done");
			const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
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
	await Promise.all(children.splice(0).map(child => child.dispose()));
	await Promise.all(roots.splice(0).map(root => root.remove()));
});

async function spawnChild(options: {
	mode: "rpc" | "rpc-ui";
	approvalMode: string;
	config?: string;
	extension?: string;
}): Promise<RpcChild> {
	const root = await TempDir.create("@rpc-tool-approval-");
	roots.push(root);
	const agentDir = path.join(root.path(), "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	if (options.config) fs.writeFileSync(path.join(agentDir, "config.yml"), options.config);
	const child = await RpcChild.spawn({
		root: root.path(),
		mode: options.mode,
		args: [
			"--approval-mode",
			options.approvalMode,
			"--model",
			"anthropic/claude-sonnet-4-5",
			...(options.extension ? ["--extension", path.join(import.meta.dir, "fixtures", options.extension)] : []),
		],
		env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}` },
	});
	children.push(child);
	await child.waitFor(frame => frame.type === "ready", 30_000);
	return child;
}

let promptCount = 0;

/** Sends a scripted tool call; resolves with its `tool_execution_start` frame and the prompt's settlement. */
async function promptToolCall(
	child: RpcChild,
	tool: string,
	input: unknown,
): Promise<{ start: RpcFrame; settled: Promise<RpcFrame> }> {
	const id = `prompt-${++promptCount}`;
	const seen = child.frames.length;
	const response = await child.request({ id, type: "prompt", message: `CALL ${tool} ${JSON.stringify(input)}` });
	expect(response.success).toBe(true);
	const start = await child.waitFor(
		frame => frame.type === "tool_execution_start" && frame.toolName === tool && child.frames.indexOf(frame) >= seen,
	);
	const settled = child.waitFor(frame => frame.type === "prompt_result" && frame.id === id);
	return { start, settled };
}

function toolEnd(child: RpcChild, toolCallId: unknown): Promise<RpcFrame> {
	return child.waitFor(frame => frame.type === "tool_execution_end" && frame.toolCallId === toolCallId);
}

function approvalRequest(child: RpcChild, toolCallId: unknown): Promise<RpcFrame> {
	return child.waitFor(frame => frame.type === "tool_approval_request" && frame.toolCallId === toolCallId);
}

function resultText(frame: RpcFrame): string {
	const result = frame.result;
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	return result.content
		.filter(isRecord)
		.map(item => (typeof item.text === "string" ? item.text : ""))
		.join("\n");
}

describe("RPC structured tool approval", () => {
	test("host handler answers approvals with typed frames", async () => {
		const child = await spawnChild({
			mode: "rpc",
			approvalMode: "always-ask",
			extension: "approval-observer-extension.ts",
		});
		const ready = child.frames.find(frame => frame.type === "ready");
		expect(ready?.capabilities).toContain("tool_approval_request");

		const invalid = await child.request({ type: "set_approval_handler", handler: "modal" });
		expect(invalid.success).toBe(false);
		const opted = await child.request({ type: "set_approval_handler", handler: "host" });
		expect(opted).toMatchObject({ success: true, data: { handler: "host" } });

		// allow_once: the request follows tool_execution_start and the tool runs.
		const once = await promptToolCall(child, "bash", { command: "echo approved-once" });
		const request = await approvalRequest(child, once.start.toolCallId);
		expect(child.frames.indexOf(request)).toBeGreaterThan(child.frames.indexOf(once.start));
		expect(request).toMatchObject({
			toolName: "bash",
			args: { command: "echo approved-once" },
			tier: "exec",
			approvalMode: "always-ask",
			details: ["Command: echo approved-once"],
			timeout: 600_000,
		});
		expect(request.safetyChecks).toBeUndefined();
		child.send({ type: "tool_approval_response", id: request.id, decision: "allow_once" });
		const allowed = await toolEnd(child, once.start.toolCallId);
		expect(allowed.isError).toBe(false);
		expect(resultText(allowed)).toContain("approved-once");
		await once.settled;
		const notices = child.frames.filter(frame => frame.method === "notify").map(frame => frame.message);
		expect(notices).toContain(`approval-requested:${once.start.toolCallId}`);
		expect(notices).toContain(`approval-resolved:${once.start.toolCallId}:true`);

		// A tool_call handler revised the input: the host approves what actually runs.
		const revised = await promptToolCall(child, "bash", { command: "echo original" });
		const revisedRequest = await approvalRequest(child, revised.start.toolCallId);
		expect(revisedRequest.args).toEqual({ command: "echo revised" });
		child.send({ type: "tool_approval_response", id: revisedRequest.id, decision: "allow_once" });
		expect(resultText(await toolEnd(child, revised.start.toolCallId))).toContain("revised");
		await revised.settled;

		// deny with a reason: the tool fails with the host's reason.
		const deny = await promptToolCall(child, "bash", { command: "echo never-runs" });
		const denyRequest = await approvalRequest(child, deny.start.toolCallId);
		child.send({ type: "tool_approval_response", id: denyRequest.id, decision: "deny", reason: "not on my watch" });
		const denied = await toolEnd(child, deny.start.toolCallId);
		expect(denied.isError).toBe(true);
		expect(resultText(denied)).toContain("not on my watch");
		await deny.settled;

		// abort while pending: the request is cancelled and the tool is denied.
		const abort = await promptToolCall(child, "bash", { command: "echo aborted-call" });
		const abortRequest = await approvalRequest(child, abort.start.toolCallId);
		await child.request({ type: "abort" });
		const cancel = await child.waitFor(frame => frame.type === "tool_approval_cancel");
		expect(cancel.targetId).toBe(abortRequest.id);
		const aborted = await toolEnd(child, abort.start.toolCallId);
		expect(aborted.isError).toBe(true);
		await abort.settled;
		// A late answer to the cancelled request changes nothing.
		child.send({ type: "tool_approval_response", id: abortRequest.id, decision: "allow_once" });

		// allow_session: later calls to the same tool skip the prompt; nothing is persisted.
		const first = await promptToolCall(child, "bash", { command: "echo session-one" });
		const sessionRequest = await approvalRequest(child, first.start.toolCallId);
		child.send({ type: "tool_approval_response", id: sessionRequest.id, decision: "allow_session" });
		expect((await toolEnd(child, first.start.toolCallId)).isError).toBe(false);
		await first.settled;
		const repeat = await promptToolCall(child, "bash", { command: "echo session-two" });
		const repeated = await toolEnd(child, repeat.start.toolCallId);
		expect(repeated.isError).toBe(false);
		expect(resultText(repeated)).toContain("session-two");
		await repeat.settled;
		expect(
			child.frames.some(
				frame => frame.type === "tool_approval_request" && frame.toolCallId === repeat.start.toolCallId,
			),
		).toBe(false);
		expect(fs.existsSync(path.join(child.agentDir, "config.yml"))).toBe(false);

		// No approval in this process went through the select dialog.
		expect(child.frames.some(frame => frame.type === "extension_ui_request" && frame.method === "select")).toBe(
			false,
		);

		// EOF with a request pending: the tool is denied and the process exits.
		const eof = await promptToolCall(child, "write", { path: "eof.txt", content: "never written" });
		await approvalRequest(child, eof.start.toolCallId);
		child.process.stdin.end();
		expect((await toolEnd(child, eof.start.toolCallId)).isError).toBe(true);
		await child.closed;
	}, 120_000);

	test("ui default keeps the select dialog; policies still apply under the host handler", async () => {
		const child = await spawnChild({
			mode: "rpc-ui",
			approvalMode: "yolo",
			config: "tools:\n  approval:\n    bash: prompt\n    write: deny\n",
		});

		// Default handler: the same select dialog as before.
		const ui = await promptToolCall(child, "bash", { command: "echo rm -rf /" });
		const dialog = await child.waitFor(frame => frame.type === "extension_ui_request" && frame.method === "select");
		expect(dialog.title).toBe("Allow tool: bash\nCommand: echo rm -rf /");
		expect(dialog.options).toEqual(["Approve", "Deny"]);
		child.send({ type: "extension_ui_response", id: dialog.id, value: "Deny" });
		const uiDenied = await toolEnd(child, ui.start.toolCallId);
		expect(uiDenied.isError).toBe(true);
		expect(resultText(uiDenied)).toContain("Tool call denied by user: bash");
		await ui.settled;

		const opted = await child.request({ type: "set_approval_handler", handler: "host" });
		expect(opted).toMatchObject({ success: true, data: { handler: "host" } });

		// A configured deny still denies without asking the host.
		const write = await promptToolCall(child, "write", { path: "denied.txt", content: "no" });
		expect((await toolEnd(child, write.start.toolCallId)).isError).toBe(true);
		await write.settled;
		expect(child.frames.some(frame => frame.type === "tool_approval_request")).toBe(false);

		// A prompt override under yolo still prompts, now through the host frame.
		const host = await promptToolCall(child, "bash", { command: "echo rm -rf /" });
		const request = await approvalRequest(child, host.start.toolCallId);
		expect(request).toMatchObject({ toolName: "bash", tier: "exec", approvalMode: "yolo" });
		child.send({ type: "tool_approval_response", id: request.id, cancelled: true });
		expect((await toolEnd(child, host.start.toolCallId)).isError).toBe(true);
		await host.settled;
		expect(
			child.frames.filter(frame => frame.type === "extension_ui_request" && frame.method === "select"),
		).toHaveLength(1);
	}, 120_000);
});

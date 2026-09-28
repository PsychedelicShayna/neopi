/**
 * Codex review of PR #115, client side: an RpcClient caller must be able to
 * opt in to host tool approvals (issue #102), see each `tool_approval_request`
 * and `tool_approval_cancel`, and answer with `respondToToolApproval`;
 * otherwise the tool call waits for the ten-minute timeout. It must also be
 * able to call `get_usage` through the typed client.
 */
import { describe, expect, test } from "bun:test";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcToolApprovalCancel, RpcToolApprovalRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const approvalRequest: RpcToolApprovalRequest = {
	type: "tool_approval_request",
	id: "approval-1",
	toolCallId: "toolu_1",
	toolName: "bash",
	args: { command: "rm -rf build" },
	tier: "exec",
	approvalMode: "always-ask",
	reason: "Critical pattern detected",
	details: ["Command: rm -rf build"],
	timeout: 600_000,
};

const approvalCancel: RpcToolApprovalCancel = { type: "tool_approval_cancel", id: "cancel-1", targetId: "approval-0" };

const usageReport = {
	provider: "anthropic",
	fetchedAt: 1_700_000_000_000,
	limits: [],
};

/**
 * In-memory RPC server: answers `set_approval_handler host` like RPC mode, then
 * cancels one earlier request and asks for one approval, recording the host's
 * answer. `get_usage` records each command and returns one report.
 */
function fakeServer(): {
	spawn: () => RpcAgentProcess;
	answer: Promise<Record<string, unknown>>;
	usageCommands: Record<string, unknown>[];
} {
	const encoder = new TextEncoder();
	const answer = Promise.withResolvers<Record<string, unknown>>();
	const exited = Promise.withResolvers<number>();
	const usageCommands: Record<string, unknown>[] = [];
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const emit = (frame: object) => controller?.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
	const handle = (frame: Record<string, unknown>) => {
		if (frame.type === "set_approval_handler") {
			emit({
				id: frame.id,
				type: "response",
				command: "set_approval_handler",
				success: true,
				data: { handler: frame.handler },
			});
			if (frame.handler === "host") {
				emit(approvalCancel);
				emit(approvalRequest);
			}
		} else if (frame.type === "tool_approval_response") {
			answer.resolve(frame);
		} else if (frame.type === "get_usage") {
			usageCommands.push(frame);
			emit({
				id: frame.id,
				type: "response",
				command: "get_usage",
				success: true,
				data: { generatedAt: 1_700_000_000_001, reports: [usageReport] },
			});
		}
	};
	const spawn = (): RpcAgentProcess => ({
		stdin: {
			write(data) {
				const text = typeof data === "string" ? data : new TextDecoder().decode(data);
				for (const line of text.split("\n")) {
					if (line.trim()) handle(JSON.parse(line) as Record<string, unknown>);
				}
			},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
				emit({
					type: "ready",
					protocolVersion: 1,
					supportedProtocolVersions: [1],
					capabilities: ["tool_approval_request", "get_usage"],
				});
			},
		}),
		peekStderr: () => "",
		kill() {
			controller?.close();
			exited.resolve(0);
		},
		exited: exited.promise,
	});
	return { spawn, answer: answer.promise, usageCommands };
}

describe("RpcClient tool approvals and usage", () => {
	test("delivers tool_approval_request and tool_approval_cancel so the caller can answer", async () => {
		const server = fakeServer();
		const client = new RpcClient({ spawn: server.spawn });
		const requests: RpcToolApprovalRequest[] = [];
		const cancels: RpcToolApprovalCancel[] = [];
		client.onToolApprovalCancel(cancel => cancels.push(cancel));
		client.onToolApprovalRequest(request => {
			requests.push(request);
			client.respondToToolApproval(request.id, "deny", "not on my watch");
		});

		try {
			await client.start();
			expect(await client.setApprovalHandler("host")).toBe("host");

			expect(await server.answer).toEqual({
				type: "tool_approval_response",
				id: "approval-1",
				decision: "deny",
				reason: "not on my watch",
			});
			expect(requests).toEqual([approvalRequest]);
			expect(cancels).toEqual([approvalCancel]);
		} finally {
			await client.stop();
		}
	});

	test("getUsage sends get_usage with its options and returns the reports", async () => {
		const server = fakeServer();
		const client = new RpcClient({ spawn: server.spawn });

		try {
			await client.start();
			expect(await client.getUsage()).toEqual({ generatedAt: 1_700_000_000_001, reports: [usageReport] });
			await client.getUsage({ provider: "anthropic", refresh: true, redact: true });

			expect(server.usageCommands.map(({ id: _id, ...command }) => command)).toEqual([
				{ type: "get_usage" },
				{ type: "get_usage", provider: "anthropic", refresh: true, redact: true },
			]);
		} finally {
			await client.stop();
		}
	});
});

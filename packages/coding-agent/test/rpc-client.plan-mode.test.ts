/**
 * Issue #103, client side: an RpcClient caller that enters plan mode must be
 * able to see the agent's `plan_proposal_request` (and its id) and answer it
 * with `respondToPlanProposal`; otherwise the proposing tool call waits forever.
 */
import { describe, expect, test } from "bun:test";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcModeChangedFrame, RpcPlanProposalRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

/**
 * In-memory RPC server: answers `set_mode plan` like RPC mode (mode_changed,
 * then the response), then submits a plan proposal and records the host's answer.
 */
function fakePlanServer(): { spawn: () => RpcAgentProcess; answer: Promise<Record<string, unknown>> } {
	const encoder = new TextEncoder();
	const answer = Promise.withResolvers<Record<string, unknown>>();
	const exited = Promise.withResolvers<number>();
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const emit = (frame: object) => controller?.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
	const handle = (frame: Record<string, unknown>) => {
		if (frame.type === "set_mode") {
			emit({ type: "mode_changed", mode: "plan", planFilePath: "local://PLAN.md" });
			emit({
				id: frame.id,
				type: "response",
				command: "set_mode",
				success: true,
				data: { mode: "plan", planFilePath: "local://PLAN.md" },
			});
			emit({
				type: "plan_proposal_request",
				id: "proposal-1",
				title: "auth-refactor",
				planFilePath: "local://auth-refactor-plan.md",
				planMarkdown: "# Auth refactor\n",
			});
		} else if (frame.type === "plan_proposal_response") {
			answer.resolve(frame);
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
				emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1], capabilities: ["set_mode"] });
			},
		}),
		peekStderr: () => "",
		kill() {
			controller?.close();
			exited.resolve(0);
		},
		exited: exited.promise,
	});
	return { spawn, answer: answer.promise };
}

describe("RpcClient plan mode", () => {
	test("delivers plan_proposal_request and mode_changed so the caller can answer the proposal", async () => {
		const server = fakePlanServer();
		const client = new RpcClient({ spawn: server.spawn });
		const modes: RpcModeChangedFrame[] = [];
		const requests: RpcPlanProposalRequest[] = [];
		client.onModeChanged(frame => modes.push(frame));
		client.onPlanProposalRequest(request => {
			requests.push(request);
			client.respondToPlanProposal(request.id, "refine", "Add a rollback step.");
		});

		try {
			await client.start();
			expect(await client.setMode("plan")).toEqual({ mode: "plan", planFilePath: "local://PLAN.md" });

			expect(await server.answer).toEqual({
				type: "plan_proposal_response",
				id: "proposal-1",
				decision: "refine",
				feedback: "Add a rollback step.",
			});
			expect(requests).toEqual([
				{
					type: "plan_proposal_request",
					id: "proposal-1",
					title: "auth-refactor",
					planFilePath: "local://auth-refactor-plan.md",
					planMarkdown: "# Auth refactor\n",
				},
			]);
			expect(modes).toEqual([{ type: "mode_changed", mode: "plan", planFilePath: "local://PLAN.md" }]);
		} finally {
			await client.stop();
		}
	});
});

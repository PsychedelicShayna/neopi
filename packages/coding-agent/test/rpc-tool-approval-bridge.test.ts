import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolApprovalRequest } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/tool-approval-requester";
import { RpcToolApprovalBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-tool-approval";
import type { RpcToolApprovalRequest, RpcToolApprovalResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { cfgToolsApproval } from "@oh-my-pi/pi-coding-agent/tools/settings";

const request: ToolApprovalRequest = {
	toolCallId: "call-1",
	toolName: "bash",
	args: { command: "echo hi" },
	tier: "exec",
	approvalMode: "always-ask",
	details: ["Command: echo hi"],
	safetyChecks: [],
};

function createBridge(options: { timeoutMs?: number; settings?: Settings } = {}) {
	const frames: object[] = [];
	const bridge = new RpcToolApprovalBridge({
		output: frame => frames.push(frame),
		runner: undefined,
		settings: options.settings ?? Settings.isolated(),
		timeoutMs: options.timeoutMs,
	});
	const lastRequest = () => frames.at(-1) as RpcToolApprovalRequest;
	return { bridge, frames, lastRequest };
}

describe("RpcToolApprovalBridge", () => {
	test("an unanswered request resolves as a denial after its advertised timeout", async () => {
		const { bridge, lastRequest } = createBridge({ timeoutMs: 20 });
		const verdict = bridge.request(request);
		expect(lastRequest().timeout).toBe(20);
		expect(await verdict).toMatchObject({ approved: false });
	});

	test("host cancellation and unknown decisions fail closed", async () => {
		const { bridge, lastRequest } = createBridge();
		const cancelled = bridge.request(request);
		bridge.handleResponse({ type: "tool_approval_response", id: lastRequest().id, cancelled: true });
		expect(await cancelled).toMatchObject({ approved: false });

		const unknown = bridge.request(request);
		bridge.handleResponse({
			type: "tool_approval_response",
			id: lastRequest().id,
			decision: "allow_forever" as "allow_once",
		});
		expect(await unknown).toMatchObject({ approved: false });
	});

	test("a cancelled frame cannot grant allow_session even when it carries an approval decision", async () => {
		const settings = Settings.isolated();
		const { bridge, lastRequest } = createBridge({ settings });
		const result = bridge.request(request);
		bridge.handleResponse({
			type: "tool_approval_response",
			id: lastRequest().id,
			decision: "allow_session",
			cancelled: true,
		} as RpcToolApprovalResponse);
		expect(await result).toMatchObject({ approved: false });
		expect(cfgToolsApproval.get(settings)).not.toHaveProperty("bash", "allow");
	});

	test("provider safety checks are forwarded only when pending; disconnect rejects pending requests", async () => {
		const { bridge, lastRequest } = createBridge();
		const plain = bridge.request(request);
		expect("safetyChecks" in lastRequest()).toBe(false);
		const checked = bridge.request({
			...request,
			safetyChecks: [{ id: "sc-1", code: "malicious_instructions", message: null }],
		});
		expect(lastRequest().safetyChecks).toEqual([{ id: "sc-1", code: "malicious_instructions" }]);
		bridge.close("RPC client disconnected");
		await expect(plain).rejects.toThrow("RPC client disconnected");
		await expect(checked).rejects.toThrow("RPC client disconnected");
	});

	test("allow_session adds a runtime allow on top of existing runtime policies", async () => {
		const settings = Settings.isolated();
		cfgToolsApproval.override(settings, { edit: "deny" });
		const { bridge, lastRequest } = createBridge({ settings });

		const bash = bridge.request(request);
		bridge.handleResponse({ type: "tool_approval_response", id: lastRequest().id, decision: "allow_session" });
		expect(await bash).toEqual({ approved: true });
		const write = bridge.request({ ...request, toolName: "write" });
		bridge.handleResponse({ type: "tool_approval_response", id: lastRequest().id, decision: "allow_session" });
		await write;

		expect(cfgToolsApproval.get(settings)).toEqual({ edit: "deny", bash: "allow", write: "allow" });
		expect(settings.getProvenance(cfgToolsApproval)).toBe("runtime");
	});
});

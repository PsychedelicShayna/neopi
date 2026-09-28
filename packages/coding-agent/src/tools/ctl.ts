/**
 * Native `ctl` tool so an agent, including a live-mode orchestrator, drives
 * other running sessions without tmux send-keys (issue #171).
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import ctlDescription from "../prompts/tools/ctl.md" with { type: "text" };
import { ctlList, ctlRpc, ctlSend, ctlState, withCtlIo } from "../cli/ctl-cli";

const ctlSchema = type({
	op: type("'list' | 'state' | 'send' | 'steer' | 'follow_up' | 'abort' | 'slash' | 'rpc'"),
	"target?": "string",
	"text?": "string",
	"rpcType?": "string",
});

export class CtlTool implements AgentTool<typeof ctlSchema> {
	readonly name = "ctl";
	readonly label = "Control";
	readonly description = prompt.render(ctlDescription);
	readonly parameters = ctlSchema;

	async execute(_toolCallId: string, raw: typeof ctlSchema.infer): Promise<AgentToolResult<undefined>> {
		const params = raw as unknown as { op: string; target?: string; text?: string; rpcType?: string };
		const sendMode = params.op === "slash" || params.op === "steer" || params.op === "follow_up" ? params.op : "prompt";
		const chunks: string[] = [];
		await withCtlIo(
			{
				stdout: text => chunks.push(text),
				stderr: text => chunks.push(text),
			},
			async () => {
				if (params.op === "list") await ctlList(true);
				else if (!params.target) chunks.push("target is required\n");
				else if (params.op === "state") await ctlState(params.target, true);
				else if (params.op === "abort") await ctlRpc(params.target, "abort", {}, true);
				else if (params.op === "rpc") await ctlRpc(params.target, params.rpcType ?? "get_state", {}, true);
				else await ctlSend(params.target, params.text ?? "", sendMode, true);
			},
		);
		return { content: [{ type: "text", text: chunks.join("") || "(no output)" }] };
	}
}

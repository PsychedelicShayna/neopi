import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

/**
 * Reports tool approval extension events as notify frames and revises one bash
 * command in `tool_call`, so hosts can see which input is approved (issue #102).
 */
export default function approvalObserverExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", event => {
		if (event.toolName !== "bash" || event.input.command !== "echo original") return undefined;
		return { input: { ...event.input, command: "echo revised" } };
	});
	pi.on("tool_approval_requested", (event, ctx) => {
		ctx.ui.notify(`approval-requested:${event.toolCallId}`);
	});
	pi.on("tool_approval_resolved", (event, ctx) => {
		ctx.ui.notify(`approval-resolved:${event.toolCallId}:${event.approved}`);
	});
}

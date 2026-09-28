/**
 * Host tool-approval seam. A mode whose host renders its own approval UI (RPC
 * `set_approval_handler { handler: "host" }`) registers a requester on the
 * {@link ExtensionRunner}; `ExtensionToolWrapper` and eval prelude host calls
 * then route every approval that would open the UI select dialog to the
 * requester instead. Policy resolution is unchanged: the requester only sees
 * calls that already resolved to "prompt" (or carry provider safety checks).
 */
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import type { ComputerSafetyCheck } from "@oh-my-pi/pi-ai";
import type { ApprovalMode } from "../../tools/approval";

export interface ToolApprovalRequest {
	/**
	 * The agent tool call id, or the synthetic id of a call made from inside an
	 * eval cell (`prelude-<name>-<uuid>`, `js-<tool>-<uuid>`).
	 */
	toolCallId: string;
	toolName: string;
	/** The exact input that runs when approved (after any `tool_call` handler revision). */
	args: unknown;
	tier: ToolTier;
	approvalMode: ApprovalMode;
	reason?: string;
	/** The tool's `formatApprovalDetails` lines, without the prompt header. */
	details: string[];
	/** Pending provider safety checks; empty when the call carries none. */
	safetyChecks: readonly ComputerSafetyCheck[];
	/** Aborts with the tool call; the requester must settle as a denial. */
	signal?: AbortSignal;
}

export type ToolApprovalVerdict = { approved: true } | { approved: false; reason?: string };

/**
 * Resolves one approval. A cancelled, timed-out or aborted request settles as
 * `{ approved: false }`; a transport that can no longer answer (host
 * disconnected) rejects.
 */
export type ToolApprovalRequester = (request: ToolApprovalRequest) => Promise<ToolApprovalVerdict>;

/**
 * Structured tool approval transport for RPC hosts (issue #102).
 *
 * With `set_approval_handler { handler: "host" }` the bridge registers itself on
 * the extension runner as the tool approval requester, so every approval that
 * would open the `Allow tool:` select dialog is emitted as a typed
 * `tool_approval_request` and answered by `tool_approval_response`. The `ui`
 * default leaves the runner untouched.
 */
import { isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { ExtensionRunner } from "../../extensibility/extensions/runner";
import type { ToolApprovalRequest, ToolApprovalVerdict } from "../../extensibility/extensions/tool-approval-requester";
import { cfgToolsApproval } from "../../tools/settings";
import type {
	RpcApprovalHandler,
	RpcToolApprovalCancel,
	RpcToolApprovalRequest,
	RpcToolApprovalResponse,
	RpcToolApprovalSafetyCheck,
} from "./rpc-types";

/** How long a host has to answer before the request resolves as `deny` (same budget as RPC login input). */
export const RPC_TOOL_APPROVAL_TIMEOUT_MS = 600_000;

export function isRpcApprovalHandler(value: unknown): value is RpcApprovalHandler {
	return value === "host" || value === "ui";
}

/** Structural guard for an inbound `tool_approval_response`; the payload is validated when it resolves. */
export function isRpcToolApprovalResponse(value: unknown): value is RpcToolApprovalResponse {
	return isRecord(value) && value.type === "tool_approval_response" && typeof value.id === "string";
}

function toVerdict(frame: RpcToolApprovalResponse): ToolApprovalVerdict {
	if ("cancelled" in frame && frame.cancelled === true)
		return { approved: false, reason: "approval cancelled by host" };
	const decision: unknown = "decision" in frame ? frame.decision : undefined;
	if (decision === "allow_once" || decision === "allow_session") return { approved: true };
	if (decision === "deny") {
		const reason = "reason" in frame && typeof frame.reason === "string" ? frame.reason.trim() : "";
		return reason ? { approved: false, reason } : { approved: false };
	}
	// A missing or unknown decision fails closed.
	return { approved: false, reason: `unrecognized approval decision: ${String(decision)}` };
}

function toSafetyChecks(request: ToolApprovalRequest): RpcToolApprovalSafetyCheck[] | undefined {
	if (request.safetyChecks.length === 0) return undefined;
	return request.safetyChecks.map(check => ({
		id: check.id,
		...(check.code ? { code: check.code } : {}),
		...(check.message ? { message: check.message } : {}),
	}));
}

type PendingApproval = {
	resolve: (frame: RpcToolApprovalResponse) => void;
	reject: (error: Error) => void;
};

export interface RpcToolApprovalBridgeOptions {
	output: (frame: RpcToolApprovalRequest | RpcToolApprovalCancel) => void;
	/** Runner that gates tool execution; absent runners leave `host` without effect. */
	runner: ExtensionRunner | undefined;
	/** Session settings; `allow_session` lands on their runtime (never persisted) layer. */
	settings: Settings;
	timeoutMs?: number;
}

export class RpcToolApprovalBridge {
	readonly #output: RpcToolApprovalBridgeOptions["output"];
	readonly #runner: ExtensionRunner | undefined;
	readonly #settings: Settings;
	readonly #timeoutMs: number;
	#handler: RpcApprovalHandler = "ui";
	#detach: (() => void) | undefined;
	#pending = new Map<string, PendingApproval>();
	#closedError: Error | undefined;
	/** Tool names allowed for the rest of the session. */
	#sessionAllowed = new Set<string>();
	/** `tools.approval` runtime override that predates the first `allow_session`, kept underneath ours. */
	#baseOverride: Record<string, unknown> | undefined;

	constructor(options: RpcToolApprovalBridgeOptions) {
		this.#output = options.output;
		this.#runner = options.runner;
		this.#settings = options.settings;
		this.#timeoutMs = options.timeoutMs ?? RPC_TOOL_APPROVAL_TIMEOUT_MS;
	}

	/** Switch between the select dialog (`ui`) and typed approval frames (`host`). */
	setHandler(handler: RpcApprovalHandler): RpcApprovalHandler {
		if (handler === this.#handler) return handler;
		this.#handler = handler;
		this.#detach?.();
		this.#detach = undefined;
		const runner = this.#runner;
		if (handler === "host" && runner) {
			this.#detach = runner.setToolApprovalRequester(request => this.request(request));
		}
		return handler;
	}

	/** Emit a `tool_approval_request` and resolve with the host's verdict. */
	request(request: ToolApprovalRequest): Promise<ToolApprovalVerdict> {
		const { signal } = request;
		if (signal?.aborted) return Promise.resolve({ approved: false, reason: "tool call aborted" });
		if (this.#closedError) return Promise.reject(this.#closedError);

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<ToolApprovalVerdict>();
		const cleanup = () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		};
		const onAbort = () => {
			this.#output({ type: "tool_approval_cancel", id: Snowflake.next() as string, targetId: id });
			cleanup();
			resolve({ approved: false, reason: "tool call aborted" });
		};
		const timeoutId = setTimeout(() => {
			cleanup();
			resolve({ approved: false, reason: "approval timed out" });
		}, this.#timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });

		this.#pending.set(id, {
			resolve: frame => {
				cleanup();
				const verdict = toVerdict(frame);
				if (verdict.approved && "decision" in frame && frame.decision === "allow_session")
					this.#allowForSession(request.toolName);
				resolve(verdict);
			},
			reject: error => {
				cleanup();
				reject(error);
			},
		});

		const safetyChecks = toSafetyChecks(request);
		this.#output({
			type: "tool_approval_request",
			id,
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			args: request.args,
			tier: request.tier,
			approvalMode: request.approvalMode,
			...(request.reason ? { reason: request.reason } : {}),
			details: request.details,
			...(safetyChecks ? { safetyChecks } : {}),
			timeout: this.#timeoutMs,
		});
		return promise;
	}

	/** Route an inbound `tool_approval_response`; unknown ids are ignored. */
	handleResponse(frame: RpcToolApprovalResponse): void {
		this.#pending.get(frame.id)?.resolve(frame);
	}

	/** Reject active and future requests after the RPC client disconnects. */
	close(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		for (const request of pending) request.reject(this.#closedError);
	}

	/**
	 * `allow_session`: an in-memory `tools.approval.<toolName>: allow` on the runtime
	 * override layer, which settings never write to config files.
	 */
	#allowForSession(toolName: string): void {
		if (this.#sessionAllowed.size === 0) {
			this.#baseOverride =
				this.#settings.getProvenance(cfgToolsApproval) === "runtime"
					? { ...cfgToolsApproval.get(this.#settings) }
					: undefined;
		}
		this.#sessionAllowed.add(toolName);
		const next: Record<string, unknown> = { ...this.#baseOverride };
		for (const name of this.#sessionAllowed) next[name] = "allow";
		cfgToolsApproval.override(this.#settings, next);
	}
}

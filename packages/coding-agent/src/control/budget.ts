/**
 * Resource budget shared by every control connection of one host (plan §3.1).
 *
 * Three work classes: *ordinary* (bounded per connection and per host, rejected
 * on admission with `rate_limited`), *retained* (`wait`, `subscribe`, `serve`,
 * `agents{op:"wait"}`, open prompt records; same shape, tighter bounds), and
 * the *reply lane* (abort, answers, side-channel results), which is exempt from
 * every bound and always serviced. Inbound reassembly reserves its full
 * declared size at the first chunk against a host-wide budget.
 */

export const MAX_CONNECTIONS = 32;
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Ordinary unfinished requests. */
export const ORDINARY_PER_CONNECTION = 256;
export const ORDINARY_PER_HOST = 1024;
/** Retained open work. */
export const RETAINED_PER_CONNECTION = 64;
export const RETAINED_PER_HOST = 256;
/** Open prompt-family ledger records per session. */
export const OPEN_LEDGER_PER_SESSION = 1024;
/** Outbound spool ceilings. */
export const SPOOL_PER_CONNECTION_BYTES = 16 * 1024 * 1024;
export const SPOOL_PER_HOST_BYTES = 64 * 1024 * 1024;
/** Inbound reassembly reservation budget. */
export const INBOUND_BUDGET_BYTES = 128 * 1024 * 1024;
/** Soft admission rate before `rate_limited`. */
export const ADMISSIONS_PER_SECOND = 100;
/** `keys` payload ceiling. */
export const MAX_KEYS_BYTES = 4 * 1024;

/** Commands that settle outstanding work and must never be queued behind it. */
export const REPLY_LANE_TYPES: ReadonlySet<string> = new Set([
	"abort",
	"abort_bash",
	"abort_retry",
	"esc",
	"bye",
	"dialog_answer",
	"extension_ui_response",
	"host_tool_update",
	"host_tool_result",
	"host_uri_result",
	"tool_approval_response",
	"plan_proposal_response",
]);

/** Commands whose work stays open after the reply. */
export const RETAINED_TYPES: ReadonlySet<string> = new Set(["wait", "subscribe", "serve"]);

export type WorkClass = "ordinary" | "retained" | "reply";

export function workClass(type: string, frame: Record<string, unknown>): WorkClass {
	if (REPLY_LANE_TYPES.has(type)) return "reply";
	if (type === "agents" && frame.op === "wait") return "retained";
	if (RETAINED_TYPES.has(type)) return "retained";
	return "ordinary";
}

/** One connection's share of the host budget. */
export class ConnectionBudget {
	ordinary = 0;
	retained = 0;
	spoolBytes = 0;

	constructor(readonly host: HostBudget) {}

	/** Admit one request, or return the class that is saturated. */
	admit(kind: WorkClass): WorkClass | undefined {
		if (kind === "reply") return undefined;
		if (kind === "retained") {
			if (this.retained >= RETAINED_PER_CONNECTION || this.host.retained >= RETAINED_PER_HOST) return "retained";
			this.retained++;
			this.host.retained++;
			return undefined;
		}
		if (this.ordinary >= ORDINARY_PER_CONNECTION || this.host.ordinary >= ORDINARY_PER_HOST) return "ordinary";
		this.ordinary++;
		this.host.ordinary++;
		return undefined;
	}

	release(kind: WorkClass): void {
		if (kind === "retained" && this.retained > 0) {
			this.retained--;
			this.host.retained--;
		} else if (kind === "ordinary" && this.ordinary > 0) {
			this.ordinary--;
			this.host.ordinary--;
		}
	}

	/** Reserve outbound spool bytes, or false when a ceiling is hit. */
	reserveSpool(bytes: number): boolean {
		if (this.spoolBytes + bytes > SPOOL_PER_CONNECTION_BYTES) return false;
		if (this.host.spoolBytes + bytes > SPOOL_PER_HOST_BYTES) return false;
		this.spoolBytes += bytes;
		this.host.spoolBytes += bytes;
		return true;
	}

	releaseSpool(bytes: number): void {
		this.spoolBytes = Math.max(0, this.spoolBytes - bytes);
		this.host.spoolBytes = Math.max(0, this.host.spoolBytes - bytes);
	}

	/** Drop every reservation this connection still holds. */
	releaseAll(): void {
		this.host.ordinary = Math.max(0, this.host.ordinary - this.ordinary);
		this.host.retained = Math.max(0, this.host.retained - this.retained);
		this.host.spoolBytes = Math.max(0, this.host.spoolBytes - this.spoolBytes);
		this.ordinary = 0;
		this.retained = 0;
		this.spoolBytes = 0;
	}
}

/** Host-wide counters. */
export class HostBudget {
	ordinary = 0;
	retained = 0;
	spoolBytes = 0;
	inboundBytes = 0;

	/** Reserve reassembly space for one inbound frame, or false over budget. */
	reserveInbound(bytes: number): boolean {
		if (this.inboundBytes + bytes > INBOUND_BUDGET_BYTES) return false;
		this.inboundBytes += bytes;
		return true;
	}

	releaseInbound(bytes: number): void {
		this.inboundBytes = Math.max(0, this.inboundBytes - bytes);
	}

	connection(): ConnectionBudget {
		return new ConnectionBudget(this);
	}
}

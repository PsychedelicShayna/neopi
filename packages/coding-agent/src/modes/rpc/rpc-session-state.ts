/**
 * One builder for {@link RpcSessionState}, shared by RPC `get_state` and the
 * control socket's `hello` / `get_status` / `state` snapshots.
 */
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { AgentSession } from "../../session/agent-session";
import { isSessionSettled } from "../../session/session-settle";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { MAX_RPC_FRAME_BYTES } from "./rpc-frame";
import { serializeRpcModel } from "./rpc-model";
import { rpcPlanModeState } from "./rpc-plan-mode";
import type { RpcScheduledTurnProbe } from "./rpc-session-settle";
import type { RpcSessionState } from "./rpc-types";
import { rpcSessionTelemetry } from "./rpc-session-telemetry";

export interface RpcSessionStateOptions {
	/** Role the current model was selected through; omit for sessions without RPC roles. */
	activeRole?: string;
	/** True while a goal continuation is scheduled, so the session is not settled. */
	scheduledTurn?: RpcScheduledTurnProbe;
	/**
	 * Include the dump fields (`systemPrompt`, `dumpTools`). They dominate the
	 * state's size, so control snapshots, which must fit one frame, leave them out.
	 */
	includeDump: boolean;
	/** Cap the queue copy; control snapshots pass {@link CONTROL_QUEUE_LIMIT}. RPC `get_state` copies it whole. */
	queueLimit?: QueueLimit;
}

export interface QueueLimit {
	/** Entries kept per queue, oldest first. */
	entries: number;
	/** Total characters kept per queue; entries are never split or rewritten. */
	chars: number;
}

/**
 * The queue's share of a control frame: snapshots and forwarded
 * `queue_update` events. Protocol-v1 frames are limited to 1 MiB, including
 * JSON escaping and the rest of the snapshot. Oversized replies lose `hello`
 * and queue state until the queue drains. Each queue keeps an exact oldest
 * prefix within its text budget, so returned chips remain valid queue-command
 * arguments. Counts stay exact, and `dequeue` returns the full message.
 */
// Two queues × six JSON bytes per UTF-16 code unit use at most half a v1 frame.
export const CONTROL_QUEUE_LIMIT: QueueLimit = {
	entries: 256,
	chars: Math.floor(MAX_RPC_FRAME_BYTES / 24),
};

/** Copy of `entries`, capped by `limit` when given. */
export function copyQueue(entries: readonly string[], limit: QueueLimit | undefined): string[] {
	if (!limit) return [...entries];
	const copy: string[] = [];
	let chars = 0;
	for (const entry of entries) {
		if (copy.length === limit.entries || entry.length > limit.chars - chars) break;
		copy.push(entry);
		chars += entry.length;
	}
	return copy;
}

export function buildRpcSessionState(session: AgentSession, options: RpcSessionStateOptions): RpcSessionState {
	const queuedMessages = session.getQueuedMessages();
	const model = session.model;
	return {
		model: model ? serializeRpcModel(model) : undefined,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		...rpcSessionTelemetry(session),
		chronicler: session.chroniclerHealth,
		autoCompactionEnabled: session.autoCompactionEnabled,
		queuedMessageCount: session.queuedMessageCount,
		queuedMessages: {
			steering: copyQueue(queuedMessages.steering, options.queueLimit),
			followUp: copyQueue(queuedMessages.followUp, options.queueLimit),
			liveSteered: queuedMessages.liveSteered,
		},
		hasPendingAsyncWork: session.hasPendingAsyncWork(),
		isSettled: isSessionSettled(session, options.scheduledTurn),
		todoPhases: session.getTodoPhases(),
		fastModeEnabled: session.isFastModeEnabled(),
		tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
		fastModeActive: session.isFastModeActive(),
		slowModeSupported: session.isSlowModeSupported(),
		slowModeEnabled: session.isSlowModeEnabled(),
		slowModeScope: session.getSlowModeScope(),
		usageLimit: session.getUsageLimitState(),
		messageCount: session.messages.length,
		...(options.includeDump
			? {
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: toolWireSchema(tool),
						examples: tool.examples,
					})),
				}
			: {}),
		contextUsage: session.getContextUsage(),
		activeRole: options.activeRole,
		chatMode: session.chatMode?.mode ?? "off",
		...rpcPlanModeState(session),
		goal: session.getGoalModeState() ?? null,
	};
}

/**
 * One builder for {@link RpcSessionState}, shared by RPC `get_state` and the
 * control socket's `hello` / `get_status` / `state` snapshots.
 */
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { truncate } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { rpcPlanModeState } from "./rpc-plan-mode";
import { isRpcSessionSettled, type RpcScheduledTurnProbe } from "./rpc-session-settle";
import type { RpcSessionState } from "./rpc-types";

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
	/** Characters kept per entry, ellipsis included. */
	chars: number;
}

/**
 * The queue's share of a control frame: snapshots and forwarded
 * `queue_update` events. Queued prompts are unbounded, and a frame over the
 * 64 MiB limit is replaced by an error, so `hello` would fail and subscribers
 * would lose queue state until it drained. Two queues at this cap stay a few
 * MiB. `queuedMessageCount` stays exact, and `dequeue` returns the full message.
 */
export const CONTROL_QUEUE_LIMIT: QueueLimit = { entries: 256, chars: 4096 };

/** Copy of `entries`, capped by `limit` when given. */
export function copyQueue(entries: readonly string[], limit: QueueLimit | undefined): string[] {
	if (!limit) return [...entries];
	return entries.slice(0, limit.entries).map(entry => truncate(entry, limit.chars));
}

export function buildRpcSessionState(session: AgentSession, options: RpcSessionStateOptions): RpcSessionState {
	const queuedMessages = session.getQueuedMessages();
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		chronicler: session.chroniclerHealth,
		autoCompactionEnabled: session.autoCompactionEnabled,
		queuedMessageCount: session.queuedMessageCount,
		queuedMessages: {
			steering: copyQueue(queuedMessages.steering, options.queueLimit),
			followUp: copyQueue(queuedMessages.followUp, options.queueLimit),
			liveSteered: queuedMessages.liveSteered,
		},
		hasPendingAsyncWork: session.hasPendingAsyncWork(),
		isSettled: isRpcSessionSettled(session, options.scheduledTurn),
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

/**
 * Prompt completion reporting for RPC mode and the control socket.
 *
 * Every accepted `prompt`/`abort_and_prompt` that is not answered synchronously
 * with `data.agentInvoked: false` gets exactly one `prompt_result` frame, emitted
 * once all work the prompt caused has settled: immediately for local-only slash
 * commands and failures, or after the terminal `agent_end` of the run that
 * carried the prompt's work. Hosts correlate on the command `id` instead of
 * inferring ownership of an `agent_end` that carries no prompt identity.
 *
 * Ownership is explicit (issue #171), never inferred from run counts:
 * - **entry-bound** tickets carry the reserved session entry id of the message
 *   the prompt wrote, and settle with the run that consumed that entry (its
 *   `message_start`);
 * - **owner-bound** tickets carry the request handle under which the prompt's
 *   work was scheduled, and settle with the run whose enriched
 *   `agent_start.runOwners` (or `run_owners_joined`) lists it;
 * - a ticket with neither settles with the first run that starts after it was
 *   accepted, which is what stdio's serial admission guarantees.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { stripRawHttpRequestDiagnostics } from "@oh-my-pi/pi-ai/utils/http-inspector";
import type { AgentSessionEvent } from "../../session/agent-session";
import { getMessageEntryId } from "../../session/message-entry-ids";
import { isRpcSessionSettled, type RpcSettleSession } from "./rpc-session-settle";
import type { RpcPromptError, RpcPromptResultFrame, RpcPromptStatus } from "./rpc-types";

/** A prompt accepted by RPC mode whose `prompt_result` is still owed; see {@link RpcPromptResults.begin}. */
export interface RpcPromptTicket {
	readonly id: string | undefined;
	/** Control-socket request handle (#171); echoed on the receipt and used as the run owner. */
	requestHandle?: string;
	/**
	 * Transport that owns this ticket. With several hosts per session (stdio plus
	 * control connections) the session's single correlator routes the receipt here
	 * instead of to every host.
	 */
	route?: (frame: RpcPromptResultFrame) => void;
}

interface RunOutcome {
	status: RpcPromptStatus;
	error?: RpcPromptError;
	reason?: string;
}

interface OpenPrompt {
	/** Session entry id the prompt reserved, once known. */
	entryId?: string;
	/** Run owner (request handle) the prompt scheduled its work under, once known. */
	owner?: string;
	/** `agentStarts` of the run that carries this prompt's work, once identified. */
	run?: number;
	/** `agentStarts` count when the ticket was accepted (unbound tickets only). */
	startsAtBegin: number;
	/** Terminal ends observed since acceptance (unbound tickets only). */
	endsSinceBegin: number;
	/** Outcome of that run, once the agent yielded it. */
	ownOutcome?: RunOutcome;
	/** Settled while its run was live: reported at the next yield that settles it. */
	waiting: boolean;
}

/** How a ticket is bound to the run that carries its work. */
export interface RpcPromptBinding {
	/** Reserved session entry id of the message the prompt wrote. */
	entryId?: string;
	/** Request handle the prompt scheduled its work under (its run owner). */
	owner?: string;
}

/**
 * Correlates accepted prompts with the run that carries their work and emits
 * their `prompt_result`. Fed every session event through {@link observe}.
 *
 * A prompt reports when the agent **yields** its work (`agent_end` with
 * `yielded`), not when the session is done: background jobs may still wake the
 * session later (see {@link RpcSessionSettleWatcher}), which `sessionSettled`
 * on the frame reports.
 *
 * A prompt dispatched as a fresh turn owns the first run that starts after it
 * was accepted, so a late `agent_end` from an earlier run never settles it. A
 * prompt queued into a live run (steer/follow-up) resolves while that run
 * streams and reports at the first yield after its message left the queue.
 */
export class RpcPromptResults {
	#agentStarts = 0;
	/** True between a run's start and its terminal end (unbound ticket binding). */
	#runLive = false;
	#open = new Map<RpcPromptTicket, OpenPrompt>();
	readonly #session: RpcSettleSession;
	readonly #output: (frame: RpcPromptResultFrame) => void;

	/** @param session read for queue state and, at report time, the `sessionSettled` predicate. */
	constructor(session: RpcSettleSession, output: (frame: RpcPromptResultFrame) => void) {
		this.#session = session;
		this.#output = output;
	}

	/** Open a ticket before the prompt starts any work. Close it with exactly one report or {@link discard}. */
	begin(id: string | undefined, binding?: RpcPromptBinding): RpcPromptTicket {
		const ticket: RpcPromptTicket = { id };
		this.#open.set(ticket, {
			entryId: binding?.entryId,
			owner: binding?.owner,
			startsAtBegin: this.#agentStarts,
			endsSinceBegin: 0,
			waiting: false,
		});
		return ticket;
	}

	/** Bind a ticket to its reserved entry id once the arm reserved one. */
	bindEntry(ticket: RpcPromptTicket, entryId: string): void {
		const open = this.#open.get(ticket);
		if (open) open.entryId = entryId;
	}

	/** Bind a ticket to the run owner its work was scheduled under. */
	bindOwner(ticket: RpcPromptTicket, owner: string): void {
		const open = this.#open.get(ticket);
		if (open) open.owner = owner;
	}

	/** Drop a ticket whose command was rejected before it was accepted (no `prompt_result` is owed). */
	discard(ticket: RpcPromptTicket): void {
		this.#open.delete(ticket);
	}

	/**
	 * The prompt's work reached the agent (dispatched or queued). Reports now if
	 * its own run already settled, otherwise at the next terminal `agent_end`.
	 */
	settle(ticket: RpcPromptTicket): void {
		const open = this.#open.get(ticket);
		if (!open) return;
		if (open.ownOutcome) {
			this.#report(ticket, true, open.ownOutcome);
		} else if (
			this.#session.isStreaming ||
			this.#session.queuedMessageCount > 0 ||
			open.run !== undefined ||
			this.#agentStarts > open.startsAtBegin
		) {
			// Queued into a live run, or its own run paused for agent-owned follow-up work (e.g. a retry).
			open.waiting = true;
		} else {
			// Idle with no run since acceptance: an abort won the race before dispatch.
			this.#report(ticket, true, { status: "aborted" });
		}
	}

	/** The prompt was handled locally without an agent turn. */
	completeLocal(ticket: RpcPromptTicket): void {
		this.#report(ticket, false, { status: "completed" });
	}

	/** The prompt failed before reaching the agent. */
	fail(ticket: RpcPromptTicket, message: string): void {
		this.#report(ticket, false, { status: "error", error: { message, retryable: false } });
	}

	/**
	 * Mark every open prompt aborted after a session transition. Transitions
	 * detach the agent before aborting it, so the interrupted run never
	 * publishes a terminal `agent_end` for them.
	 */
	abortOpen(): void {
		for (const [ticket, open] of this.#open) {
			if (open.waiting) this.#report(ticket, true, { status: "aborted" });
			else open.ownOutcome ??= { status: "aborted" };
		}
	}

	/** Track run boundaries; call after the event has been written so `prompt_result` follows its `agent_end`. */
	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.#runLive = true;
			this.#agentStarts = event.agentStarts ?? this.#agentStarts + 1;
			for (const open of this.#open.values()) {
				if (open.run !== undefined) continue;
				if (open.owner && event.runOwners?.includes(open.owner)) open.run = this.#agentStarts;
				// An unbound ticket (stdio, no reserved entry) settles with the
				// first run that starts after it was accepted.
				else if (!open.entryId && !open.owner && this.#agentStarts > open.startsAtBegin)
					open.run = this.#agentStarts;
			}
			return;
		}
		if (event.type === "run_owners_joined") {
			for (const open of this.#open.values()) {
				if (open.run === undefined && open.owner && event.owners.includes(open.owner)) open.run = event.agentStarts;
			}
			return;
		}
		if (event.type === "run_owners_skipped") {
			const outcome: RunOutcome = { status: "aborted", reason: event.reason };
			for (const [ticket, open] of this.#open) {
				if (!open.owner || open.run !== undefined || !event.owners.includes(open.owner)) continue;
				if (open.waiting) this.#report(ticket, true, outcome);
				else open.ownOutcome ??= outcome;
			}
			return;
		}
		if (event.type === "message_start") {
			const entryId = getMessageEntryId(event.message);
			if (entryId) {
				for (const open of this.#open.values()) {
					if (open.run === undefined && open.entryId === entryId) open.run = this.#agentStarts;
				}
			}
			return;
		}
		if (event.type !== "agent_end" || this.#open.size === 0) return;
		// Older sessions omit `yielded`; only their terminal ends were yields.
		if (!(event.yielded ?? event.isTerminal !== false)) return;
		// An unbound ticket accepted while a run was live settles with that
		// run, including runs that paused and continued (the continuation's
		// terminal end is what reports).
		for (const open of this.#open.values()) {
			if (
				open.run === undefined &&
				!open.entryId &&
				!open.owner &&
				this.#runLive &&
				this.#agentStarts > open.startsAtBegin
			)
				open.run = this.#agentStarts;
			else if (open.waiting && open.run === undefined && !open.entryId && !open.owner && open.endsSinceBegin === 0)
				open.run = this.#agentStarts;
			if (!open.entryId && !open.owner) open.endsSinceBegin++;
		}
		if (event.isTerminal !== false) this.#runLive = false;
		// Older sessions omit `yielded`; only their terminal ends were yields.
		if (!(event.yielded ?? event.isTerminal !== false)) return;
		const outcome = runOutcome(event.messages);
		// A still-queued steer/follow-up has not been read by the agent yet.
		const queueDrained = this.#session.queuedMessageCount === 0;
		for (const [ticket, open] of this.#open) {
			if (open.run !== undefined && open.run <= this.#agentStarts) {
				open.ownOutcome ??= outcome;
				if (open.waiting) this.#report(ticket, true, outcome);
			} else if (open.waiting && open.run === undefined && open.entryId && queueDrained) {
				// Its queued entry was dropped or restored instead of consumed.
				this.#report(ticket, true, { status: "aborted" });
			}
		}
	}

	#report(ticket: RpcPromptTicket, agentInvoked: boolean, outcome: RunOutcome): void {
		if (!this.#open.delete(ticket)) return;
		// A prompt command's response is written after the handler's remaining
		// microtasks; deferring to the next macrotask keeps every prompt_result
		// behind the response for the same id and lets queue drains land before
		// `sessionSettled` is read.
		setImmediate(() => {
			const frame: RpcPromptResultFrame = {
				type: "prompt_result",
				id: ticket.id,
				agentInvoked,
				status: outcome.status,
				sessionSettled: isRpcSessionSettled(this.#session),
			};
			if (ticket.requestHandle) frame.requestHandle = ticket.requestHandle;
			if (outcome.error) frame.error = outcome.error;
			if (outcome.reason) frame.reason = outcome.reason;
			const output = ticket.route ?? this.#output;
			output(frame);
		});
	}
}

/** Outcome of a run, read from its final assistant message. */
function runOutcome(messages: readonly AgentMessage[]): RunOutcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return { status: "error", error: promptError(message) };
		if (message.stopReason === "aborted") return { status: "aborted" };
		return { status: "completed" };
	}
	return { status: "completed" };
}

function promptError(message: AssistantMessage): RpcPromptError {
	const errorId = AIError.classifyMessage({
		api: message.api,
		provider: message.provider,
		model: message.model,
		errorId: message.errorId,
		errorMessage: message.errorMessage,
		errorClassificationMessage: message.errorClassificationMessage,
		errorStatus: message.errorStatus,
	});
	const error: RpcPromptError = {
		message: message.errorMessage ? stripRawHttpRequestDiagnostics(message.errorMessage) : "Provider request failed",
		provider: message.provider,
		model: message.model,
		retryable: AIError.is(errorId, AIError.Flag.Transient),
	};
	if (message.errorStatus !== undefined) error.httpStatus = message.errorStatus;
	return error;
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt's result must wait for the agent work.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

/**
 * Route a started prompt's resolution into its `prompt_result`: `false` without
 * extension-scheduled agent work completes locally, agent work settles through
 * the run, and a rejection is reported via `onError` and as a failed result.
 */
export function reportPromptResult(input: {
	ticket: RpcPromptTicket;
	prompt: Promise<boolean>;
	results: RpcPromptResults;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
	releaseReservation?: () => void;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (!agentInvoked) {
				input.releaseReservation?.();
				await input.waitForExtensionAgentMessageTasks?.();
			}
			if (agentInvoked || input.hasExtensionAgentMessageTask?.()) input.results.settle(input.ticket);
			else input.results.completeLocal(input.ticket);
		})
		.catch(cause => {
			input.releaseReservation?.();
			const error = cause instanceof Error ? cause : new Error(String(cause));
			input.onError(error);
			input.results.fail(input.ticket, error.message);
		});
}

/** Start a prompt under extension-message tracking and report its `prompt_result`. */
export function watchAndReportPromptResult(input: {
	ticket: RpcPromptTicket;
	startPrompt: () => Promise<boolean>;
	results: RpcPromptResults;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
	releaseReservation?: () => void;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportPromptResult({
		ticket: input.ticket,
		prompt: trackedPrompt.prompt,
		results: input.results,
		releaseReservation: input.releaseReservation,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}

/**
 * RPC plan mode (issue #103): the `set_mode` command, the `mode`/`planMode`
 * fields of `get_state`, the `mode_changed` event, and the
 * `plan_proposal_request`/`plan_proposal_response` round trip, whose pending
 * proposals end in `plan_proposal_cancel` when they resolve without the host
 * (issue #118).
 *
 * Entering plan mode mirrors ACP `session/set_mode` for the session state and
 * the interactive `/plan` for the tool/model adjustments; an `xd://propose`
 * submission is answered through the shared approve/refine branches. The
 * proposal handler is installed only by `set_mode`, so a host that never sends
 * it keeps the pre-existing behavior.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord, logger, Snowflake } from "@oh-my-pi/pi-utils";
import {
	type PlanPreviousModel,
	resolvePlanModelRestore,
	resolvePlanModelTransition,
} from "../../plan-mode/model-transition";
import {
	approvedPlanProposalResult,
	approvePlanProposal,
	type PlanProposal,
	type PlanToolPresentation,
	planModeEntryState,
	planModeToolSet,
	promoteReviewedPlanPath,
	refinedPlanProposalResult,
	resolvePlanProposal,
} from "../../plan-mode/session-plan-mode";
import { cfgPlanEnabled } from "../../plan-mode/settings";
import type { PlanModeState } from "../../plan-mode/state";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type {
	RpcMode,
	RpcModeChangedFrame,
	RpcPlanModeInfo,
	RpcPlanProposalCancel,
	RpcPlanProposalCancelReason,
	RpcPlanProposalRequest,
	RpcPlanProposalResponse,
	RpcResponse,
	RpcSetModeResult,
} from "./rpc-types";

/** Machine-readable `set_mode` failure reasons. */
export type RpcSetModeErrorCode = "plan_disabled" | "mode_blocked" | "session_busy";

/** A rejected `set_mode`; the session state is unchanged. */
export class RpcSetModeError extends Error {
	readonly code: RpcSetModeErrorCode | undefined;

	constructor(message: string, code?: RpcSetModeErrorCode) {
		super(message);
		this.name = "RpcSetModeError";
		this.code = code;
	}
}

/** Structural guard for an inbound `plan_proposal_response` control frame. */
export function isRpcPlanProposalResponse(value: unknown): value is RpcPlanProposalResponse {
	return isRecord(value) && value.type === "plan_proposal_response" && typeof value.id === "string";
}

type PlanDecision = { decision: "approve" } | { decision: "refine"; feedback?: string };

/** Cancel, EOF, abort, and unrecognized answers never approve. */
const REFINE_WITHOUT_FEEDBACK: PlanDecision = { decision: "refine" };

/** `code` of the error answering a `plan_proposal_response` for a cancelled proposal. */
export const RPC_PLAN_PROPOSAL_CANCELLED_CODE = "proposal_cancelled";

interface ModeSnapshot {
	mode: RpcMode;
	planFilePath?: string;
}

function snapshotMode(state: PlanModeState | undefined): ModeSnapshot {
	return state?.enabled ? { mode: "plan", planFilePath: state.planFilePath } : { mode: "default" };
}

/** Owns plan mode for one RPC session. */
export class RpcPlanModeController {
	readonly #session: AgentSession;
	readonly #output: (frame: object) => void;
	/** Pending proposal settlers by request id. */
	readonly #pending = new Map<string, (decision: PlanDecision) => void>();
	/** Proposals resolved without a host answer, by request id; a late answer to one fails. */
	readonly #cancelled = new Map<string, RpcPlanProposalCancelReason>();
	readonly #unsubscribe: () => void;
	/** Tool presentation captured when `set_mode` entered plan mode. */
	#previousTools: PlanToolPresentation | undefined;
	/** Model captured when `set_mode` switched to the `plan` role model. */
	#previousModel: PlanPreviousModel | undefined;
	/** Pre-plan model whose restore waits for the current turn to end. */
	#deferredModelRestore: PlanPreviousModel | undefined;
	#modelRestore: Promise<void> | undefined;
	#emitted: ModeSnapshot;
	#emitHold = 0;
	#closed = false;

	constructor(session: AgentSession, output: (frame: object) => void) {
		this.#session = session;
		this.#output = output;
		this.#emitted = snapshotMode(session.getPlanModeState());
		this.#unsubscribe = session.subscribePlanModeChanged(() => {
			if (this.#emitHold === 0) this.#emitModeIfChanged();
		});
	}

	/** `get_state` fields: the session mode and, in plan mode, its details. */
	get state(): { mode: RpcMode; planMode?: RpcPlanModeInfo } {
		const state = this.#session.getPlanModeState();
		if (!state?.enabled) return { mode: "default" };
		return { mode: "plan", planMode: { planFilePath: state.planFilePath, workflow: state.workflow ?? "parallel" } };
	}

	/**
	 * Apply a `set_mode` command.
	 *
	 * @throws RpcSetModeError for invalid input, a disabled or blocked plan
	 *   mode, or a busy session; the session state is unchanged.
	 */
	async setMode(mode: unknown, planFilePath: unknown): Promise<RpcSetModeResult> {
		if (mode !== "default" && mode !== "plan") {
			throw new RpcSetModeError(`Unsupported mode: ${String(mode)}. Expected "default" or "plan".`);
		}
		if (planFilePath !== undefined && (typeof planFilePath !== "string" || planFilePath.trim() === "")) {
			throw new RpcSetModeError("planFilePath must be a non-empty string");
		}
		this.#emitHold++;
		try {
			return mode === "plan" ? await this.#enterPlan(planFilePath) : await this.#exitPlan();
		} finally {
			this.#emitHold--;
			this.#emitModeIfChanged();
		}
	}

	/**
	 * Route a host decision to its pending proposal. An answer to a cancelled
	 * proposal gets an error response; other unknown ids are ignored.
	 */
	handleProposalResponse(frame: RpcPlanProposalResponse): void {
		const settle = this.#pending.get(frame.id);
		if (!settle) {
			const reason = this.#cancelled.get(frame.id);
			if (reason) {
				const response: RpcResponse = {
					id: frame.id,
					type: "response",
					command: "plan_proposal_response",
					success: false,
					error: `Plan proposal ${frame.id} was cancelled (${reason})`,
					code: RPC_PLAN_PROPOSAL_CANCELLED_CODE,
				};
				this.#output(response);
			}
			return;
		}
		if (frame.decision === "approve") {
			settle({ decision: "approve" });
			return;
		}
		settle({ decision: "refine", feedback: typeof frame.feedback === "string" ? frame.feedback : undefined });
	}

	/**
	 * Cancel a proposal the finished run left pending, and flush a pre-plan
	 * model restore deferred by an approval mid-turn.
	 */
	observe(event: AgentSessionEvent): void {
		if (event.type !== "agent_end" || this.#session.isStreaming) return;
		this.#cancelAllPending("agent_end");
		const previous = this.#deferredModelRestore;
		if (!previous) return;
		this.#deferredModelRestore = undefined;
		this.#modelRestore = this.#restoreModel(previous)
			.catch(error => logger.warn("Failed to restore the pre-plan model", { error: String(error) }))
			.finally(() => {
				this.#modelRestore = undefined;
			});
	}

	/** The RPC client is gone: cancel pending proposals and refuse new ones. */
	close(): void {
		this.#closed = true;
		this.#cancelAllPending("shutdown");
		this.#unsubscribe();
	}

	async #enterPlan(planFilePath: string | undefined): Promise<RpcSetModeResult> {
		const session = this.#session;
		if (!cfgPlanEnabled.get(session.settings)) {
			throw new RpcSetModeError("Plan mode is disabled. Enable it in settings (plan.enabled).", "plan_disabled");
		}
		const goal = session.getGoalModeState();
		if (goal?.enabled || goal?.goal.status === "paused") {
			throw new RpcSetModeError("Exit goal mode first.", "mode_blocked");
		}
		if (session.getVibeModeState()?.enabled) {
			throw new RpcSetModeError("Exit vibe mode first.", "mode_blocked");
		}
		if (session.isStreaming || session.isCompacting) {
			throw new RpcSetModeError("Cannot change mode while a response or compaction is in progress", "session_busy");
		}
		await this.#modelRestore;

		const previous = session.getPlanModeState();
		if (previous?.enabled) {
			// Already planning: keep the captured tools/model; only retarget the plan file.
			if (planFilePath !== undefined && planFilePath !== previous.planFilePath) {
				session.setPlanModeState(planModeEntryState(previous, planFilePath));
				session.sessionManager.appendModeChange("plan", { planFilePath });
			}
			session.setPlanProposalHandler(this.#proposalHandler);
			return { mode: "plan", planFilePath: session.getPlanModeState()?.planFilePath ?? previous.planFilePath };
		}

		const state = planModeEntryState(previous, planFilePath);
		const { previous: previousTools, planTools } = planModeToolSet(session);
		// Plan state lands before the tool partition: under Code Mode the direct
		// surface keeps `write` only while a transport needs it (see #enterPlanMode).
		session.setPlanModeState(state);
		try {
			await session.setActiveToolsByName(planTools);
		} catch (error) {
			session.setPlanModeState(previous);
			throw error;
		}
		this.#previousTools = previousTools;
		session.setPlanProposalHandler(this.#proposalHandler);
		await this.#applyPlanModel();
		session.sessionManager.appendModeChange("plan", { planFilePath: state.planFilePath });
		return { mode: "plan", planFilePath: state.planFilePath };
	}

	async #exitPlan(): Promise<RpcSetModeResult> {
		const session = this.#session;
		// A pending proposal means the proposing turn is still streaming; leaving
		// plan mode is how the host withdraws from it, so it is not "busy".
		if (this.#pending.size === 0 && (session.isStreaming || session.isCompacting)) {
			throw new RpcSetModeError("Cannot change mode while a response or compaction is in progress", "session_busy");
		}
		this.#cancelAllPending("mode_change");
		const state = session.getPlanModeState();
		if (!state?.enabled) {
			session.setPlanProposalHandler(null);
			return { mode: "default" };
		}
		await this.#leavePlanMode(state);
		session.sessionManager.appendModeChange("none");
		return { mode: "default" };
	}

	/**
	 * Leave plan mode all-or-nothing. The pre-plan model is restored first,
	 * while plan mode still holds; then plan state clears and the pre-plan
	 * tools return. A failure at either step leaves the session in plan mode
	 * with the plan tools, the plan model, the proposal handler, and both
	 * snapshots, so the state `get_state` reports matches the session and a
	 * retry can still restore the original model and tools.
	 */
	async #leavePlanMode(state: PlanModeState): Promise<void> {
		const session = this.#session;
		const planModel = session.model
			? { model: session.model, thinkingLevel: session.configuredThinkingLevel() }
			: undefined;
		const planTools = session.getEnabledToolNames();
		const planMounted = session.getMountedXdevToolNames();
		const previousModel = this.#previousModel;
		if (previousModel) await this.#restoreModel(previousModel);

		const previousTools = this.#previousTools;
		session.setPlanProposalHandler(null);
		// Plan state clears before the tool partition, mirroring entry: under
		// Code Mode the direct surface keeps `write` only while plan mode needs it.
		session.setPlanModeState(undefined);
		try {
			if (previousTools) {
				await session.restoreNonMCPToolPresentation(previousTools.enabled, previousTools.mounted);
			}
		} catch (error) {
			session.setPlanModeState(state);
			session.setPlanProposalHandler(this.#proposalHandler);
			await this.#rollBackToPlan(planModel, planTools, planMounted);
			throw error;
		}
		this.#previousTools = undefined;
		this.#previousModel = undefined;
	}

	/** Best-effort return to the plan model and tools after a failed exit. */
	async #rollBackToPlan(planModel: PlanPreviousModel | undefined, tools: string[], mounted: string[]): Promise<void> {
		const session = this.#session;
		this.#deferredModelRestore = undefined;
		if (planModel) {
			try {
				await this.#restoreModel(planModel);
			} catch (error) {
				logger.warn("Failed to restore the plan model after a failed plan exit", { error: String(error) });
			}
		}
		const enabled = session.getEnabledToolNames();
		const current = session.getMountedXdevToolNames();
		if (
			enabled.length === tools.length &&
			enabled.every((name, index) => name === tools[index]) &&
			current.length === mounted.length &&
			current.every((name, index) => name === mounted[index])
		) {
			return;
		}
		try {
			await session.setActiveToolPresentation(tools, mounted);
		} catch (error) {
			logger.warn("Failed to restore the plan tools after a failed plan exit", { error: String(error) });
		}
	}

	/** Switch to the `plan` role model, remembering the model to restore on exit. */
	async #applyPlanModel(): Promise<void> {
		const session = this.#session;
		const resolved = session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;
		const current = session.model;
		this.#previousModel = current ? { model: current, thinkingLevel: session.configuredThinkingLevel() } : undefined;
		// `set_mode` only enters plan mode between turns, so the switch is never deferred.
		const transition = resolvePlanModelTransition(current, resolved, false);
		if (transition.kind === "thinking") {
			session.setThinkingLevel(transition.thinkingLevel);
		} else if (transition.kind === "apply") {
			try {
				await session.setModelTemporary(transition.model, transition.thinkingLevel);
			} catch (error) {
				session.emitNotice(
					"warning",
					`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
					"plan-mode",
				);
			}
		}
	}

	/**
	 * Best-effort undo of the `set_mode` tool and model adjustments after an
	 * approval, which has already left plan mode. Failures are logged; the
	 * approval stands.
	 */
	async #restoreAfterApproval(): Promise<void> {
		const tools = this.#previousTools;
		this.#previousTools = undefined;
		const model = this.#previousModel;
		this.#previousModel = undefined;
		try {
			if (tools) await this.#session.restoreNonMCPToolPresentation(tools.enabled, tools.mounted);
		} catch (error) {
			logger.warn("Failed to restore pre-plan tools after plan approval", { error: String(error) });
		}
		try {
			if (model) await this.#restoreModel(model);
		} catch (error) {
			logger.warn("Failed to restore the pre-plan model after plan approval", { error: String(error) });
		}
	}

	async #restoreModel(previous: PlanPreviousModel): Promise<void> {
		const session = this.#session;
		const restore = resolvePlanModelRestore(session.model, previous, session.isStreaming);
		if (restore.kind === "thinking") {
			session.setThinkingLevel(restore.thinkingLevel);
		} else if (restore.deferred) {
			this.#deferredModelRestore = previous;
		} else {
			await session.setModelTemporary(restore.model, restore.thinkingLevel);
		}
	}

	readonly #proposalHandler = (title: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> =>
		this.#handleProposal(title, signal);

	async #handleProposal(title: string, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>> {
		const session = this.#session;
		const proposal = await resolvePlanProposal(session, title);
		const decision = await this.#requestDecision(proposal, signal);
		if (decision.decision === "refine") {
			// `set_mode default` settles a pending proposal before leaving plan
			// mode; never re-enter plan mode by promoting the reviewed path then.
			if (session.getPlanModeState()?.enabled) promoteReviewedPlanPath(session, proposal);
			return refinedPlanProposalResult(proposal, decision.feedback);
		}
		const { autosaveFailed } = await approvePlanProposal(session, proposal);
		await this.#restoreAfterApproval();
		session.sessionManager.appendModeChange("none");
		return approvedPlanProposalResult(proposal, autosaveFailed);
	}

	#requestDecision(proposal: PlanProposal, signal: AbortSignal | undefined): Promise<PlanDecision> {
		if (this.#closed || signal?.aborted) return Promise.resolve(REFINE_WITHOUT_FEEDBACK);
		const id = Snowflake.next() as string;
		const { promise, resolve } = Promise.withResolvers<PlanDecision>();
		const onAbort = (): void => this.#cancel(id, "abort");
		const settle = (decision: PlanDecision): void => {
			if (!this.#pending.delete(id)) return;
			signal?.removeEventListener("abort", onAbort);
			resolve(decision);
		};
		this.#pending.set(id, settle);
		signal?.addEventListener("abort", onAbort, { once: true });
		const request: RpcPlanProposalRequest = {
			type: "plan_proposal_request",
			id,
			title: proposal.title,
			planFilePath: proposal.planFilePath,
			planMarkdown: proposal.planContent,
		};
		this.#output(request);
		return promise;
	}

	/** Resolve a pending proposal as `refine` without feedback and tell the host. */
	#cancel(id: string, reason: RpcPlanProposalCancelReason): void {
		const settle = this.#pending.get(id);
		if (!settle) return;
		this.#cancelled.set(id, reason);
		const frame: RpcPlanProposalCancel = { type: "plan_proposal_cancel", id, reason };
		this.#output(frame);
		settle(REFINE_WITHOUT_FEEDBACK);
	}

	#cancelAllPending(reason: RpcPlanProposalCancelReason): void {
		for (const id of this.#pending.keys()) this.#cancel(id, reason);
	}

	#emitModeIfChanged(): void {
		const next = snapshotMode(this.#session.getPlanModeState());
		if (next.mode === this.#emitted.mode && next.planFilePath === this.#emitted.planFilePath) return;
		this.#emitted = next;
		const frame: RpcModeChangedFrame = { type: "mode_changed", ...next };
		this.#output(frame);
	}
}

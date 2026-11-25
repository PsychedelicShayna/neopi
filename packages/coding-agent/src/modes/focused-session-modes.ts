import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isRecord, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { controlOperationActor } from "../control/actor";
import { cfgGoalEnabled } from "../goals/settings";
import { cfgPlanEnabled } from "../plan-mode/settings";
import type { AgentSession } from "../session/agent-session";
import { RpcGoalController } from "./rpc/rpc-goal";
import { RpcPlanModeController } from "./rpc/rpc-plan-mode";
import type { RpcPlanProposalRequest } from "./rpc/rpc-types";

const modes = new WeakMap<AgentSession, FocusedSessionModes>();

/** Native subagents own their mode state, tools, and background work on their home thread. */
export function focusedSessionModes(session: AgentSession): FocusedSessionModes {
	let owner = modes.get(session);
	if (!owner) {
		owner = new FocusedSessionModes(session);
		modes.set(session, owner);
	}
	return owner;
}

class FocusedSessionModes {
	readonly goal: RpcGoalController;
	readonly #review = new Map<string, RpcPlanProposalRequest>();
	#plan: RpcPlanModeController | undefined;
	#goalReconcile: Promise<void> | undefined;
	#commands: Promise<void> = Promise.resolve();
	#goalKickoffPending = false;

	constructor(readonly session: AgentSession) {
		this.goal = new RpcGoalController(session, undefined, {
			continuationMode: "interactive",
			holdContinuation: () => session.holdFocusedModeWake(),
			waitForIdle: () => session.waitForIdle({ ignoreFocusedModeWakes: true }),
			canContinue: () => !this.#goalKickoffPending,
		});
		const unobserve = session.subscribe(event => {
			this.goal.observe(event);
			this.#plan?.observe(event);
		});
		const unregister = session.registerSessionChangeCallback(() => {
			this.goal.stopForHostAbort();
			this.#goalReconcile = session
				.waitForSessionTransition()
				.then(() => this.restoreGoal())
				.catch(error => logger.warn("Focused goal restore failed", { error: String(error) }));
		});
		session.addDisposer(() => {
			unobserve();
			this.goal.stopForHostAbort();
			unregister();
			this.#plan?.close();
		});
	}

	async restoreGoal(): Promise<void> {
		if (!this.session.isDisposed && this.session.hasBuiltInTool("goal")) await this.goal.reconcile();
	}

	run<T>(command: () => Promise<T>): Promise<T> {
		const run = this.#commands.then(async () => {
			await this.session.waitForSessionTransition();
			await this.#goalReconcile;
			if (this.session.isDisposed) throw new Error("The focused agent is no longer live.");
			return command();
		});
		this.#commands = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	async assertGoalAvailable(): Promise<void> {
		const session = this.session;
		if (!cfgGoalEnabled.get(session.settings)) throw new Error("Goal mode is disabled (goal.enabled).");
		if (session.getPlanModeState()?.enabled) throw new Error("Exit this agent's plan mode first.");
		if (session.getVibeModeState()?.enabled) throw new Error("Exit this agent's vibe mode first.");
		if (session.chatMode) throw new Error("Exit this agent's chat mode first.");
		if (!(await session.ensureGoalTool())) {
			throw new Error("This agent's tool policy does not grant the built-in goal tool.");
		}
	}

	async setGoal(objective: string, replace: boolean, images?: ImageContent[]): Promise<void> {
		await this.assertGoalAvailable();
		this.#goalKickoffPending = true;
		try {
			if (replace) await this.goal.replace(objective);
			else await this.goal.handle({ op: "create", objective }, { hasKickoffPrompt: true });
			await this.#untilAdmitted(
				admit =>
					this.session.prompt(objective, {
						streamingBehavior: "steer",
						runCommands: false,
						throwOnDrop: true,
						images,
						onPromptAdmitted: admit,
						commandActor: controlOperationActor(undefined),
					}),
				"goal",
			);
		} finally {
			this.#goalKickoffPending = false;
		}
	}

	async startGuidedGoal(initial: string, images?: readonly ImageContent[]): Promise<void> {
		await this.assertGoalAvailable();
		await this.#untilAdmitted(admit => this.goal.guided(initial, images, admit), "guided-goal");
	}

	/** A submitted worker turn must not hold the slash-command queue through its model response. */
	async #untilAdmitted(dispatch: (onPromptAdmitted: () => void) => Promise<unknown>, source: string): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const release = this.session.holdFocusedModeWake();
		let admitted = false;
		void dispatch(() => {
			admitted = true;
			resolve();
		}).then(
			() => {
				release();
				resolve();
			},
			error => {
				release();
				if (admitted) this.session.emitNotice("error", String(error), source);
				else reject(error);
			},
		);
		return promise;
	}

	async setPlan(enabled: boolean, planFilePath?: string, restore = false): Promise<void> {
		if (enabled && !this.#hasPlanTransport()) {
			throw new Error("This agent's tool policy does not grant the built-in write tool required for planning.");
		}
		if (enabled && this.goal.guidedInterviewActive) {
			throw new Error("Drop this agent's guided goal interview before entering plan mode.");
		}
		if (!this.#plan?.ownsPlan && this.session.getPlanModeState()?.enabled) {
			throw new Error("This agent's plan mode belongs to another operation, such as prewalk.");
		}
		await this.#planController().setMode(enabled ? "plan" : "default", planFilePath, { restore });
	}

	async restorePlan(modeData: unknown): Promise<void> {
		if (!this.#hasPlanTransport() || !cfgPlanEnabled.get(this.session.settings)) return;
		const planFilePath = isRecord(modeData) ? modeData.planFilePath : undefined;
		await this.setPlan(true, typeof planFilePath === "string" ? planFilePath : undefined, true);
	}

	pendingPlans(): Iterable<RpcPlanProposalRequest> {
		return this.#review.values();
	}

	answerPlan(id: string, decision: "approve" | "refine", feedback?: string): boolean {
		if (!this.#plan || !this.#review.delete(id)) return false;
		this.#plan.handleProposalResponse({ type: "plan_proposal_response", id, decision, feedback });
		return true;
	}

	#hasPlanTransport(): boolean {
		return this.session.hasBuiltInTool("write") && this.session.getEnabledToolNames().includes("write");
	}

	#planController(): RpcPlanModeController {
		return (this.#plan ??= new RpcPlanModeController(this.session, frame => {
			if (frame.type === "plan_proposal_request") {
				this.#review.set(frame.id, frame);
				this.session.emitNotice(
					"info",
					`Plan “${sanitizeText(frame.title)}” is ready. Use /plan-review while focused on this agent.`,
					"plan-mode",
				);
			} else if (frame.type === "plan_proposal_cancel") {
				this.#review.delete(frame.id);
			}
		}));
	}
}

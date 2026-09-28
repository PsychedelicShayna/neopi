/**
 * Plan-mode model transition policy.
 *
 * Plan mode drives the active session model from the `plan` role: it switches
 * to the plan model on entry and restores the pre-plan model on exit. The same
 * policy also runs when the `plan` role is reassigned mid-planning, so a
 * correction to the wrong plan model takes effect at the next turn boundary
 * (issue #5657).
 *
 * This module holds only the pure decision — what transition a given
 * (current model, resolved role, streaming) triple implies — so the branching
 * is testable without a live session or TUI. The interactive mode performs the
 * resulting side effect.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ResolvedModelRoleValue } from "../config/model-resolver";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

/** The action implied by resolving the `plan` role against the active model. */
export type PlanModelTransition =
	/** Already on the plan model with no thinking-level change to apply. */
	| { kind: "none" }
	/** Same model; only the plan role's explicit thinking level differs. */
	| { kind: "thinking"; thinkingLevel: ConfiguredThinkingLevel }
	/**
	 * Switch to `model`. `deferred` is set when the session is mid-stream: the
	 * switch must wait for the current turn to end (a live `setModelTemporary`
	 * resets the provider session), so the caller queues it instead.
	 */
	| { kind: "apply"; model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined; deferred: boolean };

/**
 * Decide how to reconcile the active model with the resolved `plan` role.
 *
 * @param currentModel - The session's active model, or `undefined` before one is set.
 * @param resolved - The `plan` role resolved against the available models.
 * @param isStreaming - Whether the session is mid-turn (forces a deferred switch).
 */
export function resolvePlanModelTransition(
	currentModel: Model | undefined,
	resolved: ResolvedModelRoleValue,
	isStreaming: boolean,
): PlanModelTransition {
	if (!resolved.model) return { kind: "none" };
	const planThinkingLevel = resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined;
	if (modelsAreEqual(currentModel, resolved.model)) {
		return planThinkingLevel ? { kind: "thinking", thinkingLevel: planThinkingLevel } : { kind: "none" };
	}
	return { kind: "apply", model: resolved.model, thinkingLevel: planThinkingLevel, deferred: isStreaming };
}

/** The model and thinking level a session ran before plan mode switched it. */
export interface PlanPreviousModel {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** The action that restores the pre-plan model when plan mode exits. */
export type PlanModelRestore =
	/** Same model: only reapply its thinking level (a model switch would reset provider-side sessions). */
	| { kind: "thinking"; thinkingLevel: ConfiguredThinkingLevel | undefined }
	/** Switch back to `model`; `deferred` while mid-stream, like {@link PlanModelTransition}. */
	| { kind: "apply"; model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined; deferred: boolean };

/** Decide how to restore the pre-plan model captured on plan entry. */
export function resolvePlanModelRestore(
	currentModel: Model | undefined,
	previous: PlanPreviousModel,
	isStreaming: boolean,
): PlanModelRestore {
	if (modelsAreEqual(currentModel, previous.model)) {
		return { kind: "thinking", thinkingLevel: previous.thinkingLevel };
	}
	return { kind: "apply", model: previous.model, thinkingLevel: previous.thinkingLevel, deferred: isStreaming };
}

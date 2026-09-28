/**
 * Session-level plan-mode transitions shared by the headless hosts (ACP, RPC)
 * and the interactive mode: the plan state a host enters, the tool set plan
 * mode runs with, and the approve/refine outcomes of an `xd://propose`
 * submission. Hosts own the approval UI; everything the agent observes is
 * built here so every host answers a proposal the same way.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import planProposalApprovedPrompt from "../prompts/system/plan-proposal-approved.md" with { type: "text" };
import planProposalRefinePrompt from "../prompts/system/plan-proposal-refine.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { isMCPToolName } from "../tools/builtin-names";
import { normalizePlanTitle, type PlanApprovalDetails, resolveApprovedPlan } from "./approved-plan";
import { autosaveApprovedPlan } from "./plan-autosave";
import { listPlanFiles, readPlanFile } from "./plan-files";
import type { PlanModeState } from "./state";

/** Plan file a host-entered plan mode targets when neither the host nor a previous state names one. */
export const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";

/**
 * Plan state for a host-driven entry into plan mode. An explicit `planFilePath`
 * wins, then the previous state's path, then {@link DEFAULT_PLAN_FILE_URL};
 * the workflow carries over and any previous state marks the entry a reentry.
 */
export function planModeEntryState(previous: PlanModeState | undefined, planFilePath?: string): PlanModeState {
	return {
		enabled: true,
		planFilePath: planFilePath ?? previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,
		workflow: previous?.workflow ?? "parallel",
		reentry: previous !== undefined,
	};
}

/** Non-MCP tool presentation captured on plan entry and restored on exit. */
export interface PlanToolPresentation {
	enabled: string[];
	mounted: string[];
}

/**
 * The tool set plan mode activates, plus the presentation to restore on exit.
 *
 * `plan-mode-active.md` tells the agent to draft the plan with `write` and
 * refine it with `edit`, and approval itself is a `write` to `xd://propose`, so
 * plan mode adds `write` — but only when the registry entry is the built-in
 * write tool (issue #3165): a shadowing extension `write` must stay inactive
 * because plan mode's read-only guarantee relies on the built-in write guard.
 */
export function planModeToolSet(
	session: Pick<AgentSession, "getEnabledToolNames" | "getMountedXdevToolNames" | "hasBuiltInTool">,
): { previous: PlanToolPresentation; planTools: string[] } {
	const enabled = session.getEnabledToolNames();
	const mounted = session.getMountedXdevToolNames();
	const augmentations = session.hasBuiltInTool("write") ? ["write"] : [];
	return {
		previous: {
			enabled: enabled.filter(name => !isMCPToolName(name)),
			mounted: mounted.filter(name => !isMCPToolName(name)),
		},
		planTools: [...new Set([...enabled, ...augmentations])],
	};
}

/** A validated `xd://propose` submission awaiting the host's approve/refine decision. */
export interface PlanProposal {
	/** Plan-mode state at submission time. */
	state: PlanModeState;
	planFilePath: string;
	planContent: string;
	title: string;
	details: PlanApprovalDetails;
}

/**
 * Validate an `xd://propose` submission against the session's plan state:
 * locate the plan file the agent wrote and finalize its title.
 *
 * @throws ToolError when plan mode is inactive or no plan file exists.
 */
export async function resolvePlanProposal(
	session: Pick<AgentSession, "getPlanModeState" | "sessionManager">,
	title: string,
): Promise<PlanProposal> {
	const state = session.getPlanModeState();
	if (!state?.enabled) {
		throw new ToolError("Plan mode is not active.");
	}
	const localProtocolOptions = {
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		getSessionId: () => session.sessionManager.getSessionId(),
	};
	const cwd = session.sessionManager.getCwd();
	const resolved = await resolveApprovedPlan({
		suppliedTitle: title,
		statePlanFilePath: state.planFilePath,
		readPlan: url => readPlanFile(url, { localProtocolOptions, cwd }),
		listPlanFiles: () => listPlanFiles({ localProtocolOptions }),
	});
	return {
		state,
		planFilePath: resolved.planFilePath,
		planContent: resolved.planContent,
		title: resolved.title,
		details: { planFilePath: resolved.planFilePath, title: resolved.title, planExists: true },
	};
}

/**
 * Rejection branch, state half: plan mode stays active for another planning
 * turn, and the reviewed path is promoted into plan-mode state so the next
 * plan-mode message targets the plan just reviewed, not a stale state path.
 */
export function promoteReviewedPlanPath(session: Pick<AgentSession, "setPlanModeState">, proposal: PlanProposal): void {
	if (proposal.state.planFilePath !== proposal.planFilePath) {
		session.setPlanModeState({ ...proposal.state, planFilePath: proposal.planFilePath });
	}
}

/**
 * Rejection branch, result half: asks the agent to revise and resubmit.
 * Reviewer `feedback`, when given, is appended so the agent sees it.
 */
export function refinedPlanProposalResult(
	proposal: PlanProposal,
	feedback?: string,
): AgentToolResult<PlanApprovalDetails> {
	const text = prompt.render(planProposalRefinePrompt, {
		title: normalizePlanTitle(proposal.title).title,
		feedback: feedback?.trim() || undefined,
	});
	return { content: [{ type: "text", text }], details: proposal.details };
}

/**
 * Approval branch: point the next turn's plan reference at the approved file
 * (kept under its agent-chosen name — no rename), leave plan mode, and
 * autosave the plan when enabled. An autosave failure is logged and reported
 * in the result, never fatal.
 */
export async function approvePlanProposal(
	session: Pick<
		AgentSession,
		| "setPlanReferencePath"
		| "setPlanProposalHandler"
		| "setPlanModeState"
		| "settings"
		| "sessionManager"
		| "sessionId"
	>,
	proposal: PlanProposal,
): Promise<{ autosaveFailed: boolean }> {
	session.setPlanReferencePath(proposal.planFilePath);
	session.setPlanProposalHandler(null);
	session.setPlanModeState(undefined);
	try {
		await autosaveApprovedPlan({
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			title: proposal.title,
			planContent: proposal.planContent,
		});
		return { autosaveFailed: false };
	} catch (error) {
		logger.warn("Failed to autosave approved plan", { sessionId: session.sessionId, error });
		return { autosaveFailed: true };
	}
}

/** Tool result the agent receives once {@link approvePlanProposal} ran. */
export function approvedPlanProposalResult(
	proposal: PlanProposal,
	autosaveFailed: boolean,
): AgentToolResult<PlanApprovalDetails> {
	const text = prompt.render(planProposalApprovedPrompt, { planFilePath: proposal.planFilePath, autosaveFailed });
	return { content: [{ type: "text", text }], details: proposal.details };
}

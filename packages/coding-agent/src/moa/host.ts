/**
 * The session host: how a mixture runs inside an `AgentSession`. One per
 * session, held by the primary agent's stream wrapper and never registered
 * anywhere, so session identity stays out of the shared registry. Member calls
 * go through the session's settings-aware stream function; each member request
 * gets the session's full provider-context pipeline against its own model.
 * Checkpoints and trace cards are appended to the session directly; the host
 * commits an outer response when the session has persisted it.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { MIXTURE_TRACE_MESSAGE_TYPE, type MixtureTraceDetails } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { resolveJudge } from "../judgment";
import type { SessionManager } from "../session/session-manager";
import { commitMixtureResponse } from "./engine";
import { isMixtureModel } from "./provider";
import type { MixtureWorkspace } from "./registration";
import { resolveMixture } from "./resolve";
import { MixtureRunStore } from "./run-store";
import {
	MIXTURE_RUN_ENTRY_TYPE,
	MIXTURE_USAGE_PURPOSE,
	type MixtureEvent,
	type MixtureHost,
	type MixtureLifecycleRecord,
	type ResolvedMixture,
} from "./types";
import { validateMixture } from "./validate";

/** Session events a mixture run raises; each carries the trace variant a consumer renders. */
export type MixtureSessionEvent =
	| { type: "mixture_hop_end"; details: Extract<MixtureTraceDetails, { kind: "hop" | "branch" }> }
	| { type: "mixture_decision"; details: Extract<MixtureTraceDetails, { kind: "decision" }> }
	| { type: "mixture_limit"; details: Extract<MixtureTraceDetails, { kind: "limit" }> }
	| { type: "mixture_checkpoint"; details: Extract<MixtureTraceDetails, { kind: "checkpoint" }> }
	| { type: "mixture_run_end"; details: Extract<MixtureTraceDetails, { kind: "run_end" }> };

export interface SessionMixtureHostDeps {
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	/** The session's hold on its workspace's catalog scope: the only definitions it may run. */
	workspace: MixtureWorkspace;
	settings: Settings;
	/** The session's settings-aware stream function. */
	stream: StreamFn;
	/** The session's full provider-context pipeline, applied with a member model. */
	prepareContext(context: Context, model: Model<Api>): Promise<Context>;
	/** Forward a mixture event to the session's listeners. */
	emit(event: MixtureSessionEvent): void;
	notice(level: "info" | "warning" | "error", message: string): void;
}

export interface SessionMixtureHost extends MixtureHost {
	/** Called after the session appended an assistant entry: commits it when it is a mixture response. */
	commitPersisted(message: AssistantMessage): void;
	/**
	 * The session replaced its conversation (`/clear`, a new or switched session, a
	 * branch, tree navigation): drop every run so nothing replays or resumes across the
	 * boundary. A run still finishing afterwards persists nothing.
	 */
	resetConversation(): void;
	/**
	 * Rebind to `cwd`'s mixtures. A move can defer dropping source runs until
	 * its other cwd-derived state commits; a rollback to the source keeps them.
	 */
	rebindWorkspace(cwd: string, deferReset?: boolean): Promise<void>;
	/** Drop source runs only after a workspace move has committed. */
	commitWorkspaceMove(): void;
	/** Observe registry metadata updates for this session's current workspace. */
	observeCatalog(listener: () => void): void;
	/** Config root from this session's workspace, including SDK-supplied agent directories. */
	configAgentDir(): string | undefined;
}

function traceSummary(details: MixtureTraceDetails): string {
	switch (details.kind) {
		case "hop":
		case "branch":
			return `◆ ${details.mixture} · hop ${details.hop} · ${details.memberId} (${details.model})`;
		case "decision":
			return `◆ ${details.mixture} · hop ${details.hop} · ${details.decision.kind} ${details.decision.outcome} · ${details.decision.judge} (${details.decision.judgeKind})`;
		case "limit":
			return `◆ ${details.mixture} · ${details.limit} limit (${details.value}) · ${details.action}`;
		case "checkpoint":
			return `⏸ ${details.mixture} · checkpoint (${details.reason})${details.note ? `: ${details.note}` : ""}`;
		default:
			return `◆ ${details.mixture}`;
	}
}

/**
 * Wrap a rotation-capable resolver so a switch to another credential row resets
 * account-scoped state. `credentials` is keyed by the member's provider session
 * and outlives the call, so a retried member call that lands on another row is
 * a switch too.
 */
function watchAccount(
	resolver: ApiKey,
	credentials: Map<string, number>,
	sessionId: string,
	onAccount: () => void,
): ApiKey {
	if (typeof resolver !== "function") return resolver;
	return async context => {
		const resolved = await resolver(context);
		const credential = typeof resolved === "object" ? resolved?.credentialId : undefined;
		if (credential !== undefined) {
			const last = credentials.get(sessionId);
			if (last !== undefined && credential !== last) onAccount();
			credentials.set(sessionId, credential);
		}
		return resolved;
	};
}

export function createSessionMixtureHost(deps: SessionMixtureHostDeps): SessionMixtureHost {
	const { sessionManager, modelRegistry, settings } = deps;
	const runs = new MixtureRunStore();
	/** Last credential row per member provider session; forgotten with the conversation. */
	const credentials = new Map<string, number>();
	let runsWorkspaceKey = deps.workspace.scope.key;

	const persistCard = (details: MixtureTraceDetails): void => {
		sessionManager.appendCustomMessageEntry(
			MIXTURE_TRACE_MESSAGE_TYPE,
			traceSummary(details),
			true,
			details,
			"agent",
		);
	};

	const onEvent = (event: MixtureEvent): void => {
		// A run dropped by a conversation reset must not write into the replacement transcript.
		if (!runs.holds(event.run)) return;
		switch (event.type) {
			case "hop_end":
				persistCard(event.trace);
				deps.emit({ type: "mixture_hop_end", details: event.trace });
				return;
			case "decision":
				persistCard(event.trace);
				deps.emit({ type: "mixture_decision", details: event.trace });
				return;
			case "limit":
				persistCard(event.trace);
				deps.emit({ type: "mixture_limit", details: event.trace });
				return;
			case "checkpoint":
				sessionManager.appendCustomEntry(MIXTURE_RUN_ENTRY_TYPE, event.checkpoint);
				if (event.trace) {
					persistCard(event.trace);
					deps.emit({ type: "mixture_checkpoint", details: event.trace });
				}
				if (event.reason === "abort") {
					deps.notice(
						"info",
						`${event.run.key.mixture} checkpointed after the abort; steering into a checkpointed run arrives with M3, so your next message starts a new run`,
					);
				}
				return;
			case "run_end":
				deps.emit({ type: "mixture_run_end", details: event.trace });
				return;
			default:
				return;
		}
	};

	return {
		get id() {
			return sessionManager.getSessionId();
		},
		runs,
		settings,
		observeCatalog(listener) {
			deps.workspace.observeCatalog(listener);
		},
		configAgentDir: () => deps.workspace.agentDir,
		stream: deps.stream,
		resolveRun(name: string): ResolvedMixture | string {
			// Only this workspace's definitions: a same-named mixture another workspace
			// registered on the shared registry never runs here.
			const registered = deps.workspace.scope.find(name);
			if (!registered) return `mixture/${name} is not defined in this workspace`;
			const fresh = resolveMixture(registered.definition, {
				registry: modelRegistry,
				settings,
				preparedPresets: registered.presets,
			});
			const { errors } = validateMixture(fresh, {
				settings,
				names: deps.workspace.scope.roster().map(mixture => mixture.definition.name),
			});
			if (errors.length > 0) {
				return `mixture/${name} no longer validates: ${errors.map(issue => `${issue.code} (${issue.message})`).join("; ")}`;
			}
			return fresh;
		},
		resolver(model, sessionId, onAccount) {
			return watchAccount(modelRegistry.resolver(model, sessionId), credentials, sessionId, onAccount);
		},
		prepareContext: deps.prepareContext,
		conversationKey: () => sessionManager.getSessionId(),
		judge(plan, onAttempt) {
			return resolveJudge({
				settings,
				registry: modelRegistry,
				sessionId: sessionManager.getSessionId(),
				candidates: plan,
				onUsage: onAttempt,
			});
		},
		onSettlement(_run, settlement) {
			// Each billed member attempt is observed once, here; the session skips the
			// per-message observation for mixture responses.
			modelRegistry.authStorage.usage.observe({
				provider: settlement.provider,
				model: settlement.model,
				at: Date.now(),
				usage: {
					input: settlement.usage.input,
					output: settlement.usage.output,
					cacheRead: settlement.usage.cacheRead,
					cacheWrite: settlement.usage.cacheWrite,
				},
				costUsd: settlement.usage.cost.total,
			});
		},
		onLateSettlement(run, settlement) {
			// No outer response will report this attempt, so it enters session totals as
			// its own ledger entry, but only while the run still belongs to this
			// conversation: a run dropped by /clear must not bill the replacement.
			const sessionId = sessionManager.getSessionId();
			if (!runs.owns(run) || run.key.host !== sessionId) return;
			sessionManager.appendModelUsage(
				{
					purpose: MIXTURE_USAGE_PURPOSE,
					api: settlement.api,
					provider: settlement.provider,
					model: settlement.model,
					usage: settlement.usage,
					stopReason: settlement.stopReason,
					errorMessage: settlement.errorMessage,
				},
				{ sessionId, parentId: sessionManager.getLeafId() },
			);
		},
		onEvent,
		resetConversation(): void {
			runs.clear();
			credentials.clear();
		},
		async rebindWorkspace(cwd: string, deferReset = false): Promise<void> {
			if (!(await deps.workspace.rebind(cwd))) return;
			if (!deferReset) this.commitWorkspaceMove();
		},
		commitWorkspaceMove(): void {
			const currentKey = deps.workspace.scope.key;
			if (currentKey === runsWorkspaceKey) return;
			// A run belongs to the workspace whose definition it pinned: none crosses a committed move.
			const held = runs.runs().length;
			runs.clear();
			credentials.clear();
			runsWorkspaceKey = currentKey;
			if (held > 0) {
				deps.notice(
					"warning",
					`${held} mixture run${held === 1 ? "" : "s"} from the previous workspace ${held === 1 ? "was" : "were"} reset; the next message starts a new run`,
				);
			}
		},
		commitPersisted(message: AssistantMessage): void {
			if (!isMixtureModel(message) || !message.responseId) return;
			const run = runs.findByResponseId(message.responseId);
			if (!run) return;
			const record = commitMixtureResponse(run, message.responseId);
			if (!record || run.status !== "done" || run.lastRequest.responseId !== record.responseId) return;
			// The lifecycle record follows the assistant entry it refers to.
			const runEnd: MixtureLifecycleRecord = {
				kind: "run_end",
				runId: run.id,
				endReason: run.endReason ?? "terminal",
				at: Date.now(),
				responseId: record.responseId,
			};
			sessionManager.appendCustomEntry(MIXTURE_RUN_ENTRY_TYPE, runEnd);
		},
	};
}

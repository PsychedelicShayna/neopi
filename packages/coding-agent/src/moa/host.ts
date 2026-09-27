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
import type { SessionManager } from "../session/session-manager";
import { commitMixtureResponse } from "./engine";
import { isMixtureModel, MixtureCatalog } from "./provider";
import { resolveMixture } from "./resolve";
import { MixtureRunStore } from "./run-store";
import {
	MIXTURE_RUN_ENTRY_TYPE,
	type MixtureEvent,
	type MixtureHost,
	type MixtureLifecycleRecord,
	type ResolvedMixture,
} from "./types";
import { validateMixture } from "./validate";

/** Session events a mixture run raises; each carries the trace variant a consumer renders. */
export type MixtureSessionEvent =
	| { type: "mixture_hop_end"; details: Extract<MixtureTraceDetails, { kind: "hop" | "branch" }> }
	| { type: "mixture_limit"; details: Extract<MixtureTraceDetails, { kind: "limit" }> }
	| { type: "mixture_checkpoint"; details: Extract<MixtureTraceDetails, { kind: "checkpoint" }> }
	| { type: "mixture_run_end"; details: Extract<MixtureTraceDetails, { kind: "run_end" }> };

export interface SessionMixtureHostDeps {
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
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
}

function traceSummary(details: MixtureTraceDetails): string {
	switch (details.kind) {
		case "hop":
		case "branch":
			return `◆ ${details.mixture} · hop ${details.hop} · ${details.memberId} (${details.model})`;
		case "limit":
			return `◆ ${details.mixture} · ${details.limit} limit (${details.value}) · ${details.action}`;
		case "checkpoint":
			return `⏸ ${details.mixture} · checkpoint (${details.reason})${details.note ? `: ${details.note}` : ""}`;
		default:
			return `◆ ${details.mixture}`;
	}
}

/** Wrap a rotation-capable resolver so a switch to another credential row resets account-scoped state. */
function watchAccount(resolver: ApiKey, onAccount: () => void): ApiKey {
	if (typeof resolver !== "function") return resolver;
	let lastCredential: number | undefined;
	return async context => {
		const resolved = await resolver(context);
		const credential = typeof resolved === "object" ? resolved?.credentialId : undefined;
		if (credential !== undefined) {
			if (lastCredential !== undefined && credential !== lastCredential) onAccount();
			lastCredential = credential;
		}
		return resolved;
	};
}

export function createSessionMixtureHost(deps: SessionMixtureHostDeps): SessionMixtureHost {
	const { sessionManager, modelRegistry, settings } = deps;
	const runs = new MixtureRunStore();

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
		switch (event.type) {
			case "hop_end":
				persistCard(event.trace);
				deps.emit({ type: "mixture_hop_end", details: event.trace });
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
		stream: deps.stream,
		resolveRun(name: string): ResolvedMixture | string {
			const catalog = MixtureCatalog.for(modelRegistry);
			const registered = catalog.find(name);
			if (!registered) return `mixture/${name} is not registered`;
			const fresh = resolveMixture(registered.definition, {
				registry: modelRegistry,
				settings,
				documentEnvelopes: registered.presets.envelopes,
				documentRoles: registered.presets.roles,
			});
			const { errors } = validateMixture(fresh, { names: catalog.roster().map(mixture => mixture.definition.name) });
			if (errors.length > 0) {
				return `mixture/${name} no longer validates: ${errors.map(issue => `${issue.code} (${issue.message})`).join("; ")}`;
			}
			return fresh;
		},
		resolver(model, sessionId, onAccount) {
			return watchAccount(modelRegistry.resolver(model, sessionId), onAccount);
		},
		prepareContext: deps.prepareContext,
		conversationKey: () => sessionManager.getSessionId(),
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
		onEvent,
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

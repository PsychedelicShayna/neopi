/**
 * Host-side handler for the eval `completion()` helper.
 *
 * Both eval runtimes (JS worker + Python kernel) route helper→host calls
 * through {@link callSessionTool}. Reserving the synthetic tool name
 * {@link EVAL_COMPLETION_BRIDGE_NAME} lets a single host handler serve both
 * transports without registering an agent-visible tool: cell code calls
 * `completion(prompt, opts)`, the prelude forwards `{ prompt, model, system?, schema? }`
 * through the bridge, and this module performs one stateless completion.
 *
 * The call is oneshot and toolless from the model's perspective — pure text
 * in, text (or, with `schema`, a structured object) out.
 */

import { type } from "@oh-my-pi/omptype";
import { instrumentedCompleteSimple, resolveTelemetry, type ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, Effort, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { classifyDifficulty } from "../auto-thinking/classifier";
import { cfgEffortPolicyMode, EffortPolicyError, resolveImplicitEffort, type EffortOrigin, type EffortSelection } from "../config/effort-policy";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";

import type { ModelRegistry } from "../config/model-registry";
import {
	expandRoleAlias,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveModelFromString,
	resolveModelOverride,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { Semaphore } from "../task/parallel";
import type { ToolSession } from "../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	findRetryFallbackCandidates,
	getFallbackEffortSelection,
	getRetryFallbackChains,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "../session/retry-fallback-chains";
import { AUTO_THINKING, concreteThinkingLevel, shouldDisableReasoning, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import type { JsStatusEvent } from "./js/shared/types";

import { cfgDisabledProviders } from "../config/model-settings";
import { cfgRetry } from "../session/settings";

/** Synthetic bridge name reserved for the `completion()` helper across both runtimes. */
export const EVAL_COMPLETION_BRIDGE_NAME = "__completion__";

/** Synthetic tool the model is forced to call when a `schema` is supplied. */
const STRUCTURED_TOOL_NAME = "respond";

type CompletionTier = "smol" | "default" | "slow";

const TIER_TO_PATTERN: Record<CompletionTier, string> = {
	smol: "@smol",
	default: "@default",
	slow: "@slow",
};

const completionArgsSchema = type({
	prompt: "string>0",
	"model?": "'smol'|'default'|'slow'",
	"system?": "string",
	"schema?": { "[string]": "unknown" },
});

export interface EvalCompletionBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

/** Terminal payload of a retained handle. */
export interface EvalCompletionResult {
	text: string;
	/** Structured payload; when present the cell receives it in place of `text`. */
	data?: unknown;
	details: { model: string; tier?: CompletionTier; structured: boolean; notices?: string[] };
}

/** Handle returned immediately after an eval completion starts. */
export interface EvalCompletionHandleResult {
	id: string;
}

/** Process-local state retained for one eval completion handle. */
export interface CompletionHandleEntry {
	ownerId: string;
	controller: AbortController;
	promise: Promise<void>;
	settled: boolean;
	result?: EvalCompletionResult;
	error?: string;
	evictionTimer?: NodeJS.Timeout;
}

const COMPLETION_HANDLE_RETENTION_MS = 30 * 60 * 1000;
const completionHandles = new Map<string, CompletionHandleEntry>();

/**
 * Process-wide ceiling on eval model requests executing at once, shared by
 * `completion()` handles, `judge()`, and `judge_batch()` items. A cell that
 * fans out hundreds of calls otherwise opens every request simultaneously and,
 * once the primary candidate rejects, floods each fallback in the role chain
 * (including self-hosted models that serve requests serially). Queued handles
 * report `running` until admitted.
 */
export const EVAL_HANDLE_CONCURRENCY = 32;
export const evalRequestSlots = new Semaphore(EVAL_HANDLE_CONCURRENCY);

/** Resolve a retained completion handle by id. */
export function getCompletionHandle(id: string): CompletionHandleEntry | undefined {
	return completionHandles.get(id);
}

/** Cancel and remove every completion handle owned by an agent session. */
export function releaseCompletionHandles(ownerId: string): void {
	for (const [id, entry] of completionHandles) {
		if (entry.ownerId !== ownerId) continue;
		entry.controller.abort(new ToolError("Completion handle owner released"));
		clearTimeout(entry.evictionTimer);
		completionHandles.delete(id);
	}
}

interface CompletionCandidate {
	/** Raw fallback-chain selector this candidate was resolved from. */
	selector: string;
	model: Model<Api>;
	reasoning: Effort | undefined;
	disableReasoning: boolean;
	selection?: EffortSelection;
	origin: EffortOrigin;
	parent?: CompletionCandidate;
	inheritsReasoning?: boolean;
}

function reasoningForCandidate(
	tier: CompletionTier,
	model: Model<Api>,
	level?: ThinkingLevel,
	parent?: Pick<CompletionCandidate, "reasoning" | "disableReasoning">,
): Pick<CompletionCandidate, "reasoning" | "disableReasoning"> {
	if (shouldDisableReasoning(level)) return { reasoning: undefined, disableReasoning: true };
	const explicit = toReasoningEffort(level);
	if (explicit !== undefined) return { reasoning: explicit, disableReasoning: false };
	// Bare nested entries inherit the failed candidate's effective effort
	// instead of recomputing the tier default for a different model.
	if (parent) {
		if (parent.disableReasoning) return { reasoning: undefined, disableReasoning: true };
		return { reasoning: clampThinkingLevelForModel(model, parent.reasoning), disableReasoning: false };
	}
	const requested = reasoningForTier(tier, model);
	return {
		reasoning: clampThinkingLevelForModel(model, requested),
		disableReasoning: false,
	};
}

/**
 * Identity used to dedupe fallback candidates. A chain may retry the same model
 * at a different effort (`slow: ["provider/model:low"]`), so the key folds in
 * the effective reasoning settings — matching the shared resolver, which treats
 * differently suffixed selectors as distinct.
 */
function candidateIdentity(
	model: Model<Api>,
	reasoning: Pick<CompletionCandidate, "reasoning" | "disableReasoning">,
): string {
	const effort = reasoning.disableReasoning ? "off" : (reasoning.reasoning ?? "inherit");
	return `${formatModelStringWithRouting(model)}|${effort}`;
}

interface FallbackExpansion {
	context: RetryFallbackResolutionContext;
	modelRegistry: ModelRegistry;
	settings: Settings;
	tier: CompletionTier;
	disabledProviders: Set<string>;
}

/**
 * Append the fallback chain applicable to `selector`, then depth-first walk
 * each appended candidate's own chain so a model-oriented chain (B → C)
 * applies when its owner fails. `seen` dedupes by model plus effective
 * reasoning; `expanded` bounds the walk to one visit per raw selector and
 * inherited effort, so the same model reached at another effort still walks
 * its own descendants. `allowMissingPrimary` lets the concrete primary
 * stand in when a role assignment is too unqualified to parse as a chain
 * primary. `roleHint` is the tier, valid only for the root expansion:
 * nested candidates resolve their own exact/wildcard/role chain so a leaf
 * cannot jump back into the root tier chain and reorder its siblings.
 */
function appendFallbackCandidates(
	deps: FallbackExpansion,
	selector: string,
	model: Model<Api>,
	parent: CompletionCandidate | undefined,
	roleHint: string | undefined,
	seen: Set<string>,
	expanded: Set<string>,
	out: CompletionCandidate[],
): void {
	// The expansion outcome follows the inherited effort for bare entries,
	// so qualify the visit: the root call has no parent and keeps the bare
	// selector key, while nested calls fold in the inherited effort.
	const visit = parent ? `${selector}|${parent.disableReasoning ? "off" : (parent.reasoning ?? "inherit")}` : selector;
	if (expanded.has(visit)) return;
	expanded.add(visit);
	const chainKey = resolveRetryFallbackChainKey(deps.context, selector, model, roleHint);
	if (!chainKey) return;
	for (const entry of findRetryFallbackCandidates(deps.context, chainKey, selector, model, {
		allowMissingPrimary: true,
	})) {
		const resolved = resolveModelOverride([entry.raw], deps.modelRegistry, deps.settings);
		const candidate = resolved.model;
		if (!candidate || deps.disabledProviders.has(candidate.provider)) continue;
		const selection = getFallbackEffortSelection(deps.settings, chainKey, entry);
		const configuredLevel = selection?.mode === "fixed" ? selection.level : entry.thinkingLevel ?? resolved.thinkingLevel;
		const reasoning = reasoningForCandidate(deps.tier, candidate, concreteThinkingLevel(configuredLevel), parent);
		const effectiveSelection = selection ?? (configuredLevel === AUTO_THINKING
			? { mode: "auto" as const }
			: configuredLevel !== undefined ? { mode: "fixed" as const, level: configuredLevel } : undefined);
		const identity = `${candidateIdentity(candidate, reasoning)}|${effectiveSelection?.mode ?? "inherit"}`;
		if (seen.has(identity)) continue;
		seen.add(identity);
		const next = {
			selector: entry.raw, model: candidate, ...reasoning, selection: effectiveSelection,
			origin: effectiveSelection && effectiveSelection.mode !== "inherit" ? "fallback" as const : parent?.origin ?? "inherited" as const,
			parent, inheritsReasoning: !effectiveSelection || effectiveSelection.mode === "inherit",
		};
		out.push(next);
		appendFallbackCandidates(deps, entry.raw, candidate, next, undefined, seen, expanded, out);
	}
}

/**
 * Resolve a tier to its primary model and configured retry-fallback candidates.
 * `default` prefers the session's active model before the `@default` role.
 */
function resolveTierCandidates(tier: CompletionTier, session: ToolSession): CompletionCandidate[] {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) return [];
	const available = modelRegistry.getAvailable();
	if (available.length === 0 && !session.getActiveModel?.()) return [];

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolve = (pattern: string | undefined): { model: Model<Api>; selector: string; level?: ThinkingLevel | typeof AUTO_THINKING } | undefined => {
		if (!pattern) return undefined;
		const selector = expandRoleAlias(pattern, session.settings);
		const model = resolveModelFromString(selector, available, matchPreferences);
		if (!model) return undefined;
		const parsed = resolveModelOverride([selector], modelRegistry, session.settings);
		return { model, selector, level: parsed.model?.provider === model.provider && parsed.model.id === model.id
			? parsed.thinkingLevel : undefined };
	};
	const activeModel = tier === "default" ? session.getActiveModel?.() : undefined;
	const activeEffort = activeModel ? session.getActiveEffort?.() : undefined;
	const primary = activeModel
		? { model: activeModel, selector: session.getActiveModelString?.() ?? formatModelStringWithRouting(activeModel) }
		: tier === "default"
			? (resolve(session.getActiveModelString?.() ?? session.getModelString?.()) ?? resolve(TIER_TO_PATTERN.default))
			: resolve(TIER_TO_PATTERN[tier]);
	if (!primary) return [];
	const level = activeEffort?.level ?? ("level" in primary ? primary.level : undefined);
	const selection = activeEffort
		? level === AUTO_THINKING ? activeEffort.selection ?? { mode: "auto" as const } :
			level !== undefined ? { mode: "fixed" as const, level } : undefined
		: session.settings.getRoleEffortSelection(tier) ??
			(level === AUTO_THINKING ? { mode: "auto" as const } :
				level !== undefined ? { mode: "fixed" as const, level } : undefined);
	const candidates: CompletionCandidate[] = [{
		selector: primary.selector, model: primary.model,
		...reasoningForCandidate(tier, primary.model, concreteThinkingLevel(level)),
		selection, origin: activeEffort?.origin ?? "role",
	}];
	const retry = cfgRetry.get(session.settings);
	if (!retry.enabled || !retry.modelFallback) return candidates;

	appendFallbackCandidates(
		{
			context: {
				chains: getRetryFallbackChains(session.settings),
				getModelRole: (role: string) => session.settings.getModelRole(role),
				modelLookup: modelRegistry,
			},
			modelRegistry,
			settings: session.settings,
			tier,
			disabledProviders: new Set(cfgDisabledProviders.get(session.settings)),
		},
		primary.selector,
		primary.model,
		candidates[0],
		tier,
		new Set([`${candidateIdentity(primary.model, candidates[0])}|${candidates[0].selection?.mode ?? "inherit"}`]),
		new Set(),
		candidates,
	);
	return candidates;
}

/**
 * Choose the reasoning effort for a tier. Only `slow` opts into thinking, and
 * only on reasoning-capable models — guarding against `requireSupportedEffort`
 * throwing downstream on models that cannot reason. Clamps to the highest
 * supported effort so a reasoning model without `high` does not 400.
 */
function reasoningForTier(tier: CompletionTier, model: Model<Api>): Effort | undefined {
	if (tier !== "slow" || !model.reasoning) return undefined;
	const efforts = getSupportedEfforts(model);
	if (efforts.length === 0) return undefined;
	return efforts.includes(Effort.High) ? Effort.High : efforts[efforts.length - 1];
}

async function executeCompletion(
	prompt: string,
	finalTier: CompletionTier,
	system: string | undefined,
	schema: Record<string, unknown> | undefined,
	candidates: CompletionCandidate[],
	session: ToolSession,
	signal: AbortSignal,
): Promise<EvalCompletionResult> {
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("completion() has no model registry.");

	const tools: Tool[] | undefined = schema
		? [
				{
					name: STRUCTURED_TOOL_NAME,
					description: "Return your answer by calling this tool with the requested structured fields.",
					parameters: schema,
					strict: false,
				},
			]
		: undefined;
	const telemetry = resolveTelemetry(session.getTelemetry?.(), session.getSessionId?.() ?? undefined);
	const systemPrompt = system ? [system] : ["You are a helpful assistant."];
	// Each fallback that issues a model request consumes one retry attempt,
	// mirroring session recovery. Keyless candidates are skipped without
	// consuming budget so a usable later fallback is still attempted.
	const maxRetries = Math.max(0, cfgRetry.get(session.settings).maxRetries);
	let response: AssistantMessage | undefined;
	let model: Model<Api> | undefined;
	let lastError: unknown;
	let retriesUsed = 0;
	let completed = false;
	const notices: string[] = [];
	const disclose = (message: string): void => {
		notices.push(message);
		session.onEffortDisclosure?.(message);
	};
	const effective = new Map<CompletionCandidate, { reasoning: Effort | undefined; disableReasoning: boolean; selection?: EffortSelection; origin: EffortOrigin }>();
	for (const [index, candidate] of candidates.entries()) {
		if (index > 0 && retriesUsed >= maxRetries) break;
		model = candidate.model;
		try {
			const inherited = candidate.parent ? effective.get(candidate.parent) : undefined;
			let reasoning = candidate.inheritsReasoning && inherited ? inherited.reasoning : candidate.reasoning;
			let disableReasoning = candidate.inheritsReasoning && inherited ? inherited.disableReasoning : candidate.disableReasoning;
			const selection = candidate.inheritsReasoning
				? inherited?.selection?.mode === "auto" ? inherited.selection :
					reasoning !== undefined ? { mode: "fixed" as const, level: reasoning } :
					disableReasoning ? { mode: "fixed" as const, level: "off" as ThinkingLevel } : undefined
				: candidate.selection ?? (reasoning !== undefined ? { mode: "fixed" as const, level: reasoning } : undefined);
			const origin = candidate.inheritsReasoning ? inherited?.origin ?? candidate.origin : candidate.origin;
			if (cfgEffortPolicyMode.get(session.settings) === "replacement" && !disableReasoning && model.reasoning) {
				const decision = resolveImplicitEffort(session.settings, model, selection, origin);
				if (decision.disclosure) disclose(decision.disclosure);
				if (selection?.mode === "auto") {
					try {
						reasoning = await classifyDifficulty(prompt, {
							settings: session.settings,
							registry,
							model,
							sessionId: session.getSessionId?.() ?? undefined,
							signal,
							allowedEfforts: decision.candidates,
							sessionManager: session.sessionManager,
							onContextFallback: disclose,
							onEffortDisclosure: disclose,
						});
					} catch (error) {
						if (signal.aborted) throw error;
						reasoning = undefined;
					}
					if (!reasoning || !decision.candidates.includes(reasoning)) {
						reasoning = decision.candidates[0];
						disclose(`Effort classification failed; using lowest permitted effort ${reasoning}.`);
					}
				} else {
					reasoning = toReasoningEffort(decision.level);
					disableReasoning = shouldDisableReasoning(decision.level);
				}
			} else if (!disableReasoning) {
				reasoning = clampThinkingLevelForModel(model, reasoning);
			}
			effective.set(candidate, { reasoning, disableReasoning, selection, origin });
			// Forward the session id so session-sticky OAuth credentials
			// resolve (see #5325); without it a usable fallback looks keyless.
			const apiKey = await registry.getApiKey(model, session.getSessionId?.() ?? undefined, { signal });
			if (!apiKey) {
				lastError = new ToolError(
					`completion() has no API key for ${formatModelString(model)}. Configure credentials for this provider or choose another tier.`,
				);
				continue;
			}
			if (index > 0) retriesUsed += 1;
			response = await instrumentedCompleteSimple(
				model,
				{
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
					tools,
				},
				{
					apiKey: registry.resolver(model, session.getSessionId?.() ?? undefined),
					signal,
					reasoning,
					disableReasoning,
					toolChoice: schema ? { type: "tool", name: STRUCTURED_TOOL_NAME } : undefined,
				},
				{ telemetry, oneshotKind: "eval_completion" },
			);
		} catch (error) {
			lastError = error;
			if (error instanceof EffortPolicyError) disclose(`Skipped completion candidate ${candidate.selector}: ${error.message}`);
			if (signal.aborted || index === candidates.length - 1) throw error;
			continue;
		}
		if (response.stopReason === "aborted") {
			throw new ToolError("completion() request aborted.");
		}
		if (response.stopReason === "error") {
			lastError = new ToolError(response.errorMessage ?? "completion() request failed.");
			if (!signal.aborted && index < candidates.length - 1) continue;
			throw lastError;
		}
		completed = true;
		break;
	}
	if (!completed || !response || !model) {
		if (lastError instanceof Error) throw lastError;
		throw new ToolError("completion() request failed.");
	}

	let resultText: string;
	if (schema) {
		const call = extractToolCall(response, STRUCTURED_TOOL_NAME);
		let value: unknown;
		if (call) {
			value = call.arguments;
		} else {
			const text = extractTextContent(response);
			if (!text) throw new ToolError("completion() returned no structured response.");
			try {
				value = parseJsonPayload(text);
			} catch {
				throw new ToolError("completion() did not return a structured response matching the schema.");
			}
		}
		resultText = JSON.stringify(value);
	} else {
		resultText = extractTextContent(response);
		if (!resultText) throw new ToolError("completion() returned no text output.");
	}

	return {
		text: resultText,
		details: { model: formatModelString(model), tier: finalTier, structured: Boolean(schema), ...(notices.length ? { notices } : {}) },
	};
}

/** Start a stateless completion and return its process-local handle immediately. */
export async function runEvalCompletion(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalCompletionHandleResult> {
	const parsed = completionArgsSchema(args);
	if (parsed instanceof type.errors) {
		throw new ToolError(`completion() received invalid arguments: ${parsed.summary}`);
	}
	const { prompt, model: modelTier, system, schema } = parsed;
	const finalTier: CompletionTier = modelTier ?? "default";
	const candidates = resolveTierCandidates(finalTier, options.session);
	if (candidates.length === 0) {
		throw new ToolError(
			`completion() could not resolve a model for the "${finalTier}" tier. Configure modelRoles.${finalTier === "default" ? "default" : finalTier} or ensure a provider is available.`,
		);
	}

	return retainCompletionHandle("cmp", options, signal =>
		executeCompletion(prompt, finalTier, system, schema, candidates, options.session, signal),
	);
}

/**
 * Run `execute` in the background under a session-owned, cancellable handle
 * and return its id immediately; `wait()`/`status()`/`cancel()` resolve it
 * through {@link getCompletionHandle}. Settled entries are evicted after
 * {@link COMPLETION_HANDLE_RETENTION_MS}.
 */
export function retainCompletionHandle(
	prefix: string,
	options: EvalCompletionBridgeOptions,
	execute: (signal: AbortSignal) => Promise<EvalCompletionResult>,
): EvalCompletionHandleResult {
	const id = `${prefix}-${Snowflake.next()}`;
	const ownerId = options.session.getAgentId?.() ?? MAIN_AGENT_ID;
	const controller = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const entry: CompletionHandleEntry = {
		ownerId,
		controller,
		promise: Promise.resolve(),
		settled: false,
	};
	completionHandles.set(id, entry);
	const run = async (): Promise<EvalCompletionResult> => {
		await evalRequestSlots.acquire(signal);
		try {
			return await execute(signal);
		} finally {
			evalRequestSlots.release();
		}
	};
	entry.promise = run()
		.then(
			result => {
				entry.result = result;
			},
			error => {
				entry.error = error instanceof Error ? error.message : String(error);
			},
		)
		.finally(() => {
			entry.settled = true;
			const timer = setTimeout(() => {
				if (completionHandles.get(id) === entry) completionHandles.delete(id);
			}, COMPLETION_HANDLE_RETENTION_MS);
			timer.unref?.();
			entry.evictionTimer = timer;
		});
	return { id };
}

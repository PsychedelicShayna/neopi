import { Agent, type AgentMessage, type AgentOptions, ThinkingLevel, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	getSimpleStreamMaxTokens,
	streamSimple,
	type Api,
	type Model,
	type ProviderSessionState,
} from "@oh-my-pi/pi-ai";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "@oh-my-pi/pi-tui/thinking";
import type { Settings } from "../config/settings";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleChain } from "../config/model-resolver";
import { LIVE_DELEGATION_MESSAGE_TYPE } from "../session/messages";
import systemPrompt from "./prompts/subagent-importance.md" with { type: "text" };

export const LIVE_INGEST_FALLBACK_WINDOW_TOKENS = 128_000;
const FRAMING_RESERVE = 2_048;
const ATTEMPT_TIMEOUT_MS = 60_000;

export interface RosterJournalEntry {
	seq: number;
	at: number;
	id: string;
	token?: string;
	depth?: number;
	parentId?: string;
	state: "started" | "completed" | "failed" | "aborted" | "running" | "idle" | "parked" | "removed";
}

export interface ClassifierAgent {
	token: string;
	id: string;
	name: string;
	model: string;
	thinkingLevel: string;
	depth: number;
	state: "running";
	parentId?: string;
	runKind: "spawn" | "wake" | "followUp";
	startedAt: number;
	lastActivityAt: number;
	idleMs: number;
	description?: string;
	excerpt?: string;
}

export interface ClassifierAlertCandidate {
	token: string;
	id: string;
	agent: string;
	slug: string;
	effort: string;
	depth?: number;
	parentId?: string;
	observedAt: number;
	endedAt?: number;
}

export interface ClassifierInput {
	seed?: string;
	authorizationHistory?: string;
	authorizationHistoryComplete?: boolean;
	recentProse?: string;
	subject?: string;
	alertCandidates: ClassifierAlertCandidate[];
	agents: ClassifierAgent[];
	journal: RosterJournalEntry[];
	previous: Array<{ id: string; importance: number; lastScoredAt: number }>;
	/** Captured once per batch; whole authored blocks in newest-first order. */
	proseBlocks?: readonly string[];
	proseMode?: "seed" | "authorizationHistory" | "recentProse";
	/** False if a summary, legacy delegation, or lost provenance prevents a negative judgment. */
	historyComplete?: boolean;
}

export interface ClassifierSelection {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	tokenizer: Tokenizer;
	window: number;
	effectiveOutputAllowance: number | undefined;
}

export interface ClassifierResult {
	scores: Map<string, number>;
	depthWeights?: Map<number, number>;
	alerts?: Map<string, { authorized: boolean; reason: string }>;
}

export interface ClassifierProse {
	blocks: string[];
	subject?: string;
	historyComplete: boolean;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (!block || typeof block !== "object") return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "image") return "[image]";
			return typeof block.type === "string" ? `[${block.type}]` : "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Render the captured primary conversation without promoting assistant/agent prose to operator evidence. */
export function renderClassifierProse(messages: readonly AgentMessage[]): ClassifierProse {
	const blocks: string[] = [];
	let subject: string | undefined;
	let historyComplete = true;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		let authored: Array<{ label: string; text: string; operator: boolean }> = [];
		if (message.role === "toolResult" || message.role === "bashExecution") continue;
		if (
			message.role === "branchSummary" ||
			message.role === "compactionSummary" ||
			(message.role === "user" && message.providerPayload?.type === "anthropicCompaction")
		) {
			historyComplete = false;
			authored = [
				{
					label: "Summary (not operator speech)",
					text: "summary" in message ? message.summary : textOf(message.content),
					operator: false,
				},
			];
		} else if (message.role === "custom" && message.customType === LIVE_DELEGATION_MESSAGE_TYPE) {
			const details = message.details;
			if (details && typeof details === "object" && "operator" in details && typeof details.operator === "string") {
				authored = [
					{ label: "Operator (live)", text: details.operator, operator: true },
					...("voice" in details && typeof details.voice === "string"
						? [{ label: "Voice agent", text: details.voice, operator: false }]
						: []),
				];
			} else {
				historyComplete = false;
				authored = [
					{ label: "Legacy live delegation (authorship unknown)", text: textOf(message.content), operator: false },
				];
			}
		} else if (message.role === "user") {
			const operator = message.synthetic !== true && message.attribution !== "agent";
			authored = [{ label: operator ? "Operator" : "Agent-context user", text: textOf(message.content), operator }];
		} else if (message.role === "assistant") {
			authored = [
				{
					label: "Non-operator assistant",
					text: textOf(message.content.filter(block => block.type === "text")),
					operator: false,
				},
			];
		} else if ("content" in message) {
			authored = [{ label: `Non-operator ${message.role}`, text: textOf(message.content), operator: false }];
		}
		for (const { label, text, operator } of authored) {
			if (!text) continue;
			if (operator && subject === undefined) subject = text.slice(0, 300);
			blocks.push(`[-${blocks.length + 1}] ${label}: ${text}`);
		}
	}
	return { blocks, subject, historyComplete };
}

export function resolveClassifierSelections(settings: Settings, registry: ModelRegistry): ClassifierSelection[] {
	return resolveRoleChain("classifier", settings, registry.getAvailable()).map(candidate => {
		const requested = concreteThinkingLevel(candidate.thinkingLevel) ?? ThinkingLevel.Medium;
		const thinkingLevel = resolveThinkingLevelForModel(candidate.model, requested) ?? ThinkingLevel.Inherit;
		const options = {
			reasoning: toReasoningEffort(thinkingLevel),
			disableReasoning: shouldDisableReasoning(thinkingLevel),
		};
		return {
			model: candidate.model,
			thinkingLevel,
			tokenizer: new Tokenizer(candidate.model),
			window: registry.standardContextWindow(candidate.model, LIVE_INGEST_FALLBACK_WINDOW_TOKENS),
			effectiveOutputAllowance: getSimpleStreamMaxTokens(candidate.model, options),
		};
	});
}

/** Exact serialized-input check against the selected model's standard, not extended, context. */
export function budgetClassifierInput(
	input: ClassifierInput,
	selection: ClassifierSelection,
	systemText = systemPrompt,
): string | undefined {
	const { effectiveOutputAllowance: output, window, tokenizer } = selection;
	if (
		!Number.isSafeInteger(output) ||
		output === undefined ||
		output <= 0 ||
		!Number.isSafeInteger(window) ||
		window <= 0
	)
		return undefined;
	const count = (text: string): number =>
		tokenizer.encoding === null ? Buffer.byteLength(text) : tokenizer.countTokens(text, "strict");
	const remaining = window - output - FRAMING_RESERVE - count(systemText);
	if (remaining < 0) return undefined;
	const { proseBlocks, proseMode, historyComplete, ...base } = input;
	const payload: ClassifierInput = {
		...base,
		agents: input.agents.map(agent => ({
			...agent,
			excerpt: agent.excerpt?.slice(-800),
			description: agent.description?.slice(0, 600),
		})),
	};
	delete payload.seed;
	delete payload.authorizationHistory;
	delete payload.recentProse;
	if (input.alertCandidates.length > 0)
		payload.authorizationHistoryComplete = Boolean(historyComplete ?? input.authorizationHistoryComplete);
	else delete payload.authorizationHistoryComplete;
	const measure = (): number => count(JSON.stringify(payload));
	if (measure() > remaining) {
		for (const agent of payload.agents) delete agent.excerpt;
	}
	if (measure() > remaining) {
		for (const agent of payload.agents) delete agent.description;
	}
	if (measure() > remaining) return undefined;
	const mode =
		proseMode ??
		(input.seed !== undefined
			? "seed"
			: input.authorizationHistory !== undefined
				? "authorizationHistory"
				: input.recentProse !== undefined
					? "recentProse"
					: undefined);
	const blocks = proseBlocks ?? (mode && typeof input[mode] === "string" ? [input[mode]] : []);
	if (mode && blocks.length > 0) {
		const original = measure();
		const cap = Math.floor(window / (mode === "recentProse" ? 4 : 2));
		const chosen: string[] = [];
		for (const block of blocks) {
			chosen.push(block);
			payload[mode] = chosen.join("\n");
			const size = measure();
			if (size > remaining || size - original > cap) {
				chosen.pop();
				if (chosen.length) payload[mode] = chosen.join("\n");
				else delete payload[mode];
				if (input.alertCandidates.length) payload.authorizationHistoryComplete = false;
				break;
			}
		}
	}
	return JSON.stringify(payload);
}

/** Independently parse each captured score, depth and authorization decision. */
export function parseClassifierReply(
	text: string,
	input: ClassifierInput,
	historyComplete = input.authorizationHistoryComplete === true,
): ClassifierResult | undefined {
	const json = text
		.trim()
		.replace(/^```(?:json)?\s*\n?/i, "")
		.replace(/\n?```\s*$/, "");
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const object = data as Record<string, unknown>;
	const scores = new Map<string, number>();
	const tokens = new Set(input.agents.map(agent => agent.token));
	if (object.scores && typeof object.scores === "object" && !Array.isArray(object.scores)) {
		for (const [token, value] of Object.entries(object.scores)) {
			if (tokens.has(token) && typeof value === "number" && Number.isFinite(value))
				scores.set(token, Math.max(0, Math.min(1, value)));
		}
	}
	const depths = new Set(input.agents.map(agent => agent.depth));
	const depthWeights = new Map<number, number>();
	if (object.depthWeights && typeof object.depthWeights === "object" && !Array.isArray(object.depthWeights)) {
		for (const [depth, value] of Object.entries(object.depthWeights)) {
			const numeric = Number(depth);
			if (depths.has(numeric) && typeof value === "number" && Number.isFinite(value))
				depthWeights.set(numeric, Math.max(0.05, Math.min(1, value)));
		}
	}
	const alerts = new Map<string, { authorized: boolean; reason: string }>();
	const candidates = new Set(input.alertCandidates.map(candidate => candidate.token));
	if (object.alerts && typeof object.alerts === "object" && !Array.isArray(object.alerts)) {
		for (const [token, value] of Object.entries(object.alerts)) {
			if (!candidates.has(token) || !value || typeof value !== "object" || Array.isArray(value)) continue;
			const decision = value as Record<string, unknown>;
			if (
				typeof decision.authorized === "boolean" &&
				typeof decision.reason === "string" &&
				(decision.authorized || historyComplete)
			) {
				alerts.set(token, { authorized: decision.authorized, reason: decision.reason });
			}
		}
	}
	return { scores, depthWeights, alerts };
}

export interface ClassifierDependencies {
	settings: Settings;
	modelRegistry: ModelRegistry;
	providerSessionState?: Map<string, ProviderSessionState>;
	preferWebsockets?: boolean;
	signal: AbortSignal;
	selection: ClassifierSelection;
	/** Called just before the first actual Agent.prompt, not on no-fit candidates. */
	onPromptStart?: () => void;
	/** Test seam; production always uses the plain streamSimple function. */
	streamFn?: AgentOptions["streamFn"];
	/** Per-attempt deadline; production defaults to 60 seconds. */
	attemptTimeoutMs?: number;
	/** Deterministic timer seam. */
	setAttemptTimer?: (fn: () => void, ms: number) => () => void;
}

/** One settled attempt; the caller owns the retry chain and its single-flight slot. */
export async function classifySubagentImportance(
	input: ClassifierInput,
	deps: ClassifierDependencies,
): Promise<ClassifierResult> {
	const result: ClassifierResult = { scores: new Map() };
	const finalJson = budgetClassifierInput(input, deps.selection);
	if (!finalJson || deps.signal.aborted) return result;
	const sessionId = Bun.randomUUIDv7();
	const agent = new Agent({
		initialState: {
			systemPrompt: [systemPrompt],
			model: deps.selection.model,
			thinkingLevel: toReasoningEffort(deps.selection.thinkingLevel),
			tools: [],
		},
		sessionId,
		promptCacheKey: Bun.randomUUIDv7(),
		providerSessionState: deps.providerSessionState,
		preferWebsockets: deps.preferWebsockets,
		getApiKey: model => deps.modelRegistry.resolver(model, sessionId),
		streamFn: deps.streamFn ?? streamSimple,
		intentTracing: false,
	});
	agent.setDisableReasoning(shouldDisableReasoning(deps.selection.thinkingLevel));
	let timedOut = false;
	const abort = () => agent.abort(deps.signal.reason);
	deps.signal.addEventListener("abort", abort, { once: true });
	const cancelTimeout = deps.setAttemptTimer
		? deps.setAttemptTimer(() => {
				timedOut = true;
				agent.abort("classifier attempt timed out");
			}, deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS)
		: (() => {
				const timeout = setTimeout(() => {
					timedOut = true;
					agent.abort("classifier attempt timed out");
				}, deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
				return () => clearTimeout(timeout);
			})();
	try {
		if (deps.signal.aborted) return result;
		deps.onPromptStart?.();
		await agent.prompt([{ role: "user", content: [{ type: "text", text: finalJson }], timestamp: Date.now() }]);
		if (deps.signal.aborted || timedOut || agent.state.error) return result;
		const reply = [...agent.state.messages].reverse().find(message => message.role === "assistant");
		if (!reply || reply.role !== "assistant" || reply.stopReason === "aborted" || reply.stopReason === "error")
			return result;
		return (
			parseClassifierReply(
				textOf(reply.content.filter(block => block.type === "text")),
				input,
				JSON.parse(finalJson).authorizationHistoryComplete === true,
			) ?? result
		);
	} catch {
		return result;
	} finally {
		cancelTimeout();
		deps.signal.removeEventListener("abort", abort);
		agent.abort("classifier attempt settled");
	}
}

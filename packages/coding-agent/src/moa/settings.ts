/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain. Each Mixture of
 * Agents milestone registers only the keys it reads.
 */
import { register } from "../config/registry";

export const cfgMoaMaxHops = register({
	id: "moa.max_hops",
	type: "number",
	default: 24,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Max Hops",
		description: "Default hop limit per mixture run when a definition sets no limits.max_hops",
	},
});

export const cfgMoaHardMaxHops = register({
	id: "moa.hard_max_hops",
	type: "number",
	default: 200,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Hard Hop Cap",
		description: "Lifetime hop cap per mixture run; always stops the run",
	},
});

export const cfgMoaShowTraceCards = register({
	id: "moa.show_trace_cards",
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Show Mixture Trace Cards",
		description: "Render a collapsible card per mixture hop above the answer",
	},
});

export const cfgMoaPartBudgetTokens = register({
	id: "moa.part_budget_tokens",
	type: "number",
	default: 16_000,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Transit Part Budget",
		description: "Token cap per transit part (output, input, reasoning) a member hands to the next",
	},
});

export const cfgMoaConversationBudgetTokens = register({
	id: "moa.conversation_budget_tokens",
	type: "number",
	default: 8_000,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Conversation Budget",
		description: "Token budget for the earlier conversation shown to the entry member",
	},
});

export const cfgMoaBudgetUsd = register({
	id: "moa.budget_usd",
	type: "number",
	default: 0,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Budget (USD)",
		description: "Default spend limit per run window; zero disables this limit",
	},
});

export const cfgMoaHardBudgetUsd = register({
	id: "moa.hard_budget_usd",
	type: "number",
	default: 0,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Hard Budget (USD)",
		description: "Lifetime spend cap; zero disables this cap",
	},
});

export const cfgMoaWallClockMinutes = register({
	id: "moa.wall_clock_minutes",
	type: "number",
	default: 240,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Time Limit",
		description: "Default wall-clock minutes per run window",
	},
});

export const cfgMoaOnLimit = register({
	id: "moa.on_limit",
	type: "enum",
	values: ["stop", "pause", "judge"] as const,
	default: "pause",
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Limit Action",
		description: "Stop, pause, or ask a final member when a soft limit is reached",
	},
});

export const cfgMoaJudgeMinConfidence = register({
	id: "moa.judge_min_confidence",
	type: "number",
	default: 0.55,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Route Confidence Floor",
		description: "Default minimum confidence for a native route judgment",
	},
});

export const cfgMoaDecisionStateTokens = register({
	id: "moa.decision_state_tokens",
	type: "number",
	default: 4_000,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Decision State Budget",
		description: "Token cap per state part supplied to a route, termination, or verdict judgment",
	},
});

export const cfgMoaTranscriptBudgetTokens = register({
	id: "moa.transcript_budget_tokens",
	type: "number",
	default: 24_000,
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Transcript Budget",
		description: "Default token budget for transcript transit",
	},
});

export const cfgMoaSummaryModel = register({
	id: "moa.summary_model",
	type: "string",
	default: "@smol",
	ui: {
		tab: "model",
		group: "Mixture of Agents",
		label: "Mixture Summary Model",
		description: "Model role used when compacting transit transcripts",
	},
});

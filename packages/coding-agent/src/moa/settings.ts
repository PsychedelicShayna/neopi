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

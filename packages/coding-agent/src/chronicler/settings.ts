/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgChroniclerEnabled = register({
	id: "chronicler.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "General",
		label: "Chronicler capture",
		description:
			"Continuously capture semantic beats from this session into its session artifacts directory using the @chronicler role. Independent of Memory Backend; both may be on.",
	},
});

export const cfgChroniclerRecallEnabled = register({
	id: "chronicler.recall.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "General",
		label: "Chronicler recall tool",
		description:
			"Grant top-level sessions the chronicle_recall tool over the derived temporal view built by `npi chronicle index`. Subagents and advisors receive it only when their explicit tool list names it. Nothing is injected at session start.",
	},
});

/** Derived temporal view root; empty resolves to `<agentDir>/chronicle`. */
export const cfgChroniclerIndexDir = register({ id: "chronicler.index.dir", type: "string", default: undefined });

/** IANA timezone for calendar buckets; empty uses the system timezone. */
export const cfgChroniclerIndexTimezone = register({
	id: "chronicler.index.timezone",
	type: "string",
	default: undefined,
});

/** Target size of one generated summary node. */
export const cfgChroniclerIndexSummaryTokens = register({
	id: "chronicler.index.summaryTokens",
	type: "number",
	default: 500,
});

/** Ceiling for one traversal hop: a node's routing text or a terminal enumeration. */
export const cfgChroniclerIndexHopTokens = register({
	id: "chronicler.index.hopTokens",
	type: "number",
	default: 1000,
});

/** Atom budget of one terminal bucket before adaptive sub-hour subdivision. */
export const cfgChroniclerIndexTerminalAtoms = register({
	id: "chronicler.index.terminalAtoms",
	type: "number",
	default: 8,
});

/** Size of the leading-paragraph description each atom contributes to a terminal enumeration. */
export const cfgChroniclerIndexLeadTokens = register({
	id: "chronicler.index.leadTokens",
	type: "number",
	default: 120,
});

/** Name atom stubs `<time>-<id>.md` instead of `<time>-<slug>-<id>.md` on restrictive filesystems. */
export const cfgChroniclerIndexShortNames = register({
	id: "chronicler.index.shortNames",
	type: "boolean",
	default: false,
});

/** Runner-up branches kept per expansion during recall descent (including the best). */
export const cfgChroniclerRecallBeam = register({ id: "chronicler.recall.beam", type: "number", default: 2 });

/** Maximum atoms one recall returns. */
export const cfgChroniclerRecallResults = register({ id: "chronicler.recall.results", type: "number", default: 5 });

/** Sibling ranking: the chronicler-summary model, or free deterministic lexical coverage. */
export const cfgChroniclerRecallRanker = register({
	id: "chronicler.recall.ranker",
	type: "enum",
	values: ["model", "lexical"] as const,
	default: "model",
});

/** Temporal window around an anchor or confident atom for adjacency and neighborhood inspection. */
export const cfgChroniclerRecallNeighborhoodMinutes = register({
	id: "chronicler.recall.neighborhoodMinutes",
	type: "number",
	default: 90,
});

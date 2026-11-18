import type { NodeLevel } from "./temporal/tree";

/** Initial judge routing floors; configurable independently from confident atom matches. */
export const DEFAULT_RECALL_BRANCH_FLOORS: Readonly<Record<NodeLevel, number>> = {
	root: 0.2,
	year: 0.2,
	month: 0.2,
	week: 0.2,
	day: 0.2,
	hour: 0.2,
	span: 0.2,
	page: 0.2,
	group: 0.2,
};

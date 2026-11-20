import { resolveMaxContextWindow } from "./compat/context-window";
import type { Api, Model, ModelAccountAccess } from "./types";

export interface VariantContextWindows {
	standard: number;
	extended: number;
}

type CodexVariantTier = "default" | "priority" | "ultrafast";

/** Keep the existing credential resolver restricted to accounts advertising the selected tier. */
function tierAccounts(model: Model, tier: CodexVariantTier): Model["accountAccess"] {
	if (!model.accountAccess || tier === "default") return model.accountAccess;
	const accounts: Record<string, ModelAccountAccess> = {};
	for (const [account, access] of Object.entries(model.accountAccess)) {
		const eligible =
			tier === "ultrafast"
				? access.serviceTiers?.includes(tier) === true
				: !access.serviceTiers?.length || access.serviceTiers.includes(tier);
		if (eligible) accounts[account] = access;
	}
	return accounts;
}

/**
 * Project ordinary selectable Codex slugs after capability discovery and policy resolution.
 * Keep the resolved base identity/compat/thinking: these are serving profiles, not new wire SKUs.
 * `900k` names the extended (~1M) profile; contextWindow retains the exact supported input limit.
 */
export function expandCodexVariants<TApi extends Api>(
	models: Model<TApi>[],
	contextWindows?: (model: Model<TApi>) => VariantContextWindows | undefined,
): Model<TApi>[] {
	let expanded: Model<TApi>[] | undefined;
	let occupied: Set<string> | undefined;
	for (const model of models) {
		if (model.api !== "openai-codex-responses" || model.codexVariant || (model.kind && model.kind !== "chat")) {
			continue;
		}
		const windows = contextWindows?.(model);
		const standard = windows?.standard ?? model.contextWindow;
		if (standard === null) continue;
		const extended = windows?.extended ?? resolveMaxContextWindow(model) ?? standard;
		for (const tier of ["default", "priority", "ultrafast"] as const) {
			const accountAccess = tierAccounts(model, tier);
			if (accountAccess) {
				if (Object.keys(accountAccess).length === 0) continue;
			} else if (
				tier === "ultrafast"
					? !model.serviceTiers?.includes(tier)
					: tier === "priority" && model.serviceTiers?.length && !model.serviceTiers.includes(tier)
			) {
				continue;
			}
			for (const large of [false, true]) {
				if ((!large && tier === "default") || (large && extended <= standard)) continue;
				const suffix = `${tier === "priority" ? "-fast" : tier === "ultrafast" ? "-ultra" : ""}${large ? "-900k" : ""}`;
				const id = `${model.id}${suffix}`;
				occupied ??= new Set(models.map(row => `${row.provider}/${row.id}`));
				const key = `${model.provider}/${id}`;
				if (occupied.has(key)) continue;
				occupied.add(key);
				expanded ??= [...models];
				const contextWindow = large ? extended : standard;
				expanded.push({
					...model,
					id,
					name: `${model.name}${tier === "priority" ? " Fast" : tier === "ultrafast" ? " Ultra" : ""}${large ? " 900k" : ""}`,
					requestModelId: model.requestModelId ?? model.id,
					contextWindow,
					contextWindowAuthoritative: true,
					accountAccess,
					// A union's first row may omit a tier another account supports.
					serviceTiers: tier === "default" ? model.serviceTiers : [tier],
					codexVariant: { baseModelId: model.id, serviceTier: tier, contextWindow },
				});
			}
		}
	}
	return expanded ?? models;
}

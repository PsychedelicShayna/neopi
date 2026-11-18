import type { Model } from "../types";

/**
 * Merge per-account discovery catalogs into one list, deduped by model id.
 *
 * The first catalog to list an id supplies its spec; {@link Model.accountAccess}
 * and advertised service tiers are unioned from every catalog listing that id,
 * so credential selection can route account-gated models to eligible accounts. Used by
 * multi-account discovery for Codex and Antigravity, and per-key discovery for
 * NeoProxy, whose rosters differ per account or key.
 */
export function unionAccountCatalogs<TModel extends Pick<Model, "id" | "accountAccess" | "serviceTiers">>(
	catalogs: readonly (readonly TModel[])[],
): TModel[] {
	const byId = new Map<string, TModel>();
	for (const catalog of catalogs) {
		for (const model of catalog) {
			const existing = byId.get(model.id);
			if (!existing) {
				byId.set(model.id, model);
			} else if (model.accountAccess) {
				byId.set(model.id, {
					...existing,
					accountAccess: { ...existing.accountAccess, ...model.accountAccess },
					...(existing.serviceTiers !== undefined || model.serviceTiers !== undefined
						? { serviceTiers: [...new Set([...(existing.serviceTiers ?? []), ...(model.serviceTiers ?? [])])] }
						: {}),
				});
			}
		}
	}
	return [...byId.values()];
}

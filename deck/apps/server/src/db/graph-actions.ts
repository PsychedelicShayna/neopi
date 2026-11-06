import type { GraphEffect, GraphValue } from "@npi-deck/protocol";
import { getDb, nowIso } from "./index.ts";
import { redactCredentialField } from "./trigger-payload.ts";
import { cardFrontmatter, withCardProperties } from "../card-properties.ts";

/** Credential-key privacy also follows card properties serialized into leading TOML. */
export function redactGraphActionField(key: string, value: unknown): unknown {
	const redacted = redactCredentialField(key, value);
	if (key !== "body" || typeof redacted !== "string" || !redacted.startsWith("+++")) return redacted;
	try {
		const parsed = cardFrontmatter(redacted);
		const original = JSON.stringify(parsed.properties);
		const safe = JSON.stringify(parsed.properties, redactCredentialField);
		return original === safe ? redacted : withCardProperties(parsed.content, JSON.parse(safe) as Record<string, unknown>);
	} catch { return redacted; } // Invalid user TOML is not reinterpreted by the trace serializer.
}

export class GraphActionConflictError extends Error {
	constructor() { super("Logical action identity already has a different request or destination; use a new operationId for an intentional new write"); }
}

/** Canonical request identity, independent of object insertion order. */
export function canonicalGraphValue(value: GraphValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalGraphValue).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalGraphValue(value[key]!)}`).join(",")}}`;
	return JSON.stringify(value);
}
export function graphDigest(value: GraphValue): string {
	return new Bun.CryptoHasher("sha256").update(canonicalGraphValue(value)).digest("hex");
}
export function getGraphEffect(key: string): GraphEffect | undefined {
	const row = getDb().query<{ effect_json: string }, [string]>("SELECT effect_json FROM graph_actions WHERE logical_key = ?").get(key);
	return row ? JSON.parse(row.effect_json) as GraphEffect : undefined;
}
/** The reservation is committed synchronously before control reaches any remote transport. */
export function reserveGraphEffect(effect: GraphEffect, fingerprint: string): { owned: boolean; effect: GraphEffect } {
	return getDb().transaction(() => {
		const inserted = getDb().query("INSERT OR IGNORE INTO graph_actions (logical_key, fingerprint, effect_json, updated_at) VALUES (?, ?, ?, ?)")
			.run(effect.logicalKey, fingerprint, JSON.stringify(effect, redactGraphActionField), nowIso());
		const row = getDb().query<{ fingerprint: string; effect_json: string }, [string]>("SELECT fingerprint, effect_json FROM graph_actions WHERE logical_key = ?").get(effect.logicalKey)!;
		if (row.fingerprint !== fingerprint) throw new GraphActionConflictError();
		return { owned: inserted.changes === 1, effect: JSON.parse(row.effect_json) as GraphEffect };
	}).immediate();
}
export function storeGraphEffect(effect: GraphEffect): void {
	getDb().query("UPDATE graph_actions SET effect_json = ?, updated_at = ? WHERE logical_key = ?")
		.run(JSON.stringify(effect, redactGraphActionField), nowIso(), effect.logicalKey);
}

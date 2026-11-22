import type { Database } from "bun:sqlite";

export interface ModelSighting {
	readonly provider: string;
	readonly id: string;
}

export interface BundledSightings {
	readonly fingerprint: string;
	readonly models: Iterable<ModelSighting>;
}

/** Keep identity history separate from the cache's replaceable, versioned payload rows. */
export function recordSightings(
	db: Database,
	models: readonly ModelSighting[],
	now: number,
	bundled?: BundledSightings,
): void {
	const findHistory = db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'model_first_seen'");
	const findBundle = "SELECT 1 FROM model_first_seen_catalog WHERE fingerprint = ?";
	if (
		models.length === 0 &&
		findHistory.get() &&
		(!bundled || db.query<unknown, [string]>(findBundle).get(bundled.fingerprint))
	)
		return;
	db.transaction(() => {
		// Recheck after acquiring the write lock: another process may have seeded it.
		const initialized = findHistory.get();
		if (!initialized) {
			db.run(`CREATE TABLE model_first_seen (
				provider TEXT NOT NULL,
				id TEXT NOT NULL,
				first_seen INTEGER,
				PRIMARY KEY (provider, id)
			) WITHOUT ROWID`);
			db.run("CREATE INDEX model_first_seen_date ON model_first_seen(first_seen) WHERE first_seen IS NOT NULL");
			db.run("CREATE TABLE model_first_seen_catalog (fingerprint TEXT PRIMARY KEY) WITHOUT ROWID");
			// Baseline even stale and foreign-policy snapshots; only their identities matter.
			db.run(`INSERT OR IGNORE INTO model_first_seen (provider, id)
				SELECT model.value ->> '$.provider', model.value ->> '$.id'
				FROM model_cache, json_each(CASE WHEN json_valid(models) THEN models ELSE '[]' END) AS model
				WHERE model.type = 'object'
				AND json_type(model.value, '$.provider') = 'text' AND json_type(model.value, '$.id') = 'text'`);
		}
		using insert = db.prepare<never, [string, string, number | null]>(
			"INSERT OR IGNORE INTO model_first_seen (provider, id, first_seen) VALUES (?, ?, ?)",
		);
		const firstSeen = initialized ? now : null;
		for (const { provider, id } of models) insert.run(provider, id, firstSeen);
		if (bundled && !db.query<unknown, [string]>(findBundle).get(bundled.fingerprint)) {
			for (const { provider, id } of bundled.models) insert.run(provider, id, firstSeen);
			db.run("INSERT INTO model_first_seen_catalog (fingerprint) VALUES (?)", [bundled.fingerprint]);
		}
	}).immediate();
}

export function readSightings(db: Database, newerThan: number): ReadonlyMap<string, number> {
	if (!db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'model_first_seen'").get()) {
		return new Map();
	}
	const rows = db
		.query<{ provider: string; id: string; first_seen: number }, [number]>(
			"SELECT provider, id, first_seen FROM model_first_seen WHERE first_seen > ?",
		)
		.all(newerThan);
	return new Map(rows.map(({ provider, id, first_seen }) => [`${provider}/${id}`, first_seen]));
}

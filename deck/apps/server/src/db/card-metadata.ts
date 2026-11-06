import type { Database } from "bun:sqlite";
import { importLegacyCardBody, withCardProperties } from "../card-properties.ts";
import { logger } from "../log.ts";

const log = logger("card-metadata");

/** Must run inside the same transaction that publishes the canonical card body. */
export function canonicalCardBody(db: Database, taskId: string, body: string, properties?: Record<string, unknown>): string {
	if (/^---\r?\n/.test(body)) {
		db.query("INSERT OR IGNORE INTO card_legacy_originals (task_id, body, imported_at) VALUES (?, ?, ?)")
			.run(taskId, body, new Date().toISOString());
	}
	const canonical = importLegacyCardBody(body, `tasks/${taskId}`);
	return withCardProperties(canonical, properties);
}

/** Restart-safe one-way migration, before any task readers or execution start. */
export function importLegacyCardMetadata(db: Database): void {
	const rows = db.query<{ id: string; body: string }, []>("SELECT id, body FROM tasks WHERE body LIKE '---%'").all();
	const update = db.query("UPDATE tasks SET body = ? WHERE id = ?");
	db.transaction(() => {
		for (const row of rows) {
			// A malformed original remains available for repair; never guess at its data.
			try {
				const canonical = canonicalCardBody(db, row.id, row.body);
				if (canonical !== row.body) update.run(canonical, row.id);
			} catch {
				log.warn(`could not import legacy card metadata: tasks/${row.id}`);
			}
		}
	})();
}

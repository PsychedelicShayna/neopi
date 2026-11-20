import { Snowflake } from "@oh-my-pi/pi-utils";
import { type CompactionEntry, CURRENT_SESSION_VERSION, type FileEntry, type SessionHeader } from "./session-entries";

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = crypto.randomUUID().slice(-8);
		if (!byId.has(id)) return id;
	}
	return Snowflake.next(); // fallback to full snowflake id
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		ids.add(entry.id);
		entry.parentId = prevId;
		prevId = entry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		if (entry.type === "message") {
			const msg = entry.message as { role?: string };
			if (msg.role === "hookMessage") {
				(entry.message as { role: string }).role = "custom";
			}
		}
	}
}

/** Normalize the legacy Python-only record into the canonical generic eval message. */
function migratePythonExecutionMessages(entries: FileEntry[]): boolean {
	let migrated = false;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; language?: string };
		if (message.role !== "pythonExecution") continue;
		message.role = "evalExecution";
		message.language = "py";
		migrated = true;
	}
	return migrated;
}

/** Whether every non-header entry lacks a persisted tree ID. Check before migration assigns any. */
export function hasUnindexedSessionEntries(entries: readonly FileEntry[]): boolean {
	return (
		entries.some(entry => entry.type !== "session") &&
		entries.every(entry => entry.type === "session" || typeof entry.id !== "string" || entry.id.length === 0)
	);
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
export function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find(e => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;
	const migrated = migratePythonExecutionMessages(entries);
	const unindexed = hasUnindexedSessionEntries(entries);

	if (version >= CURRENT_SESSION_VERSION && !unindexed) return migrated;

	if (version < 2 || unindexed) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	else if (header) header.version = CURRENT_SESSION_VERSION;
	return true;
}

/** Exported for testing */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

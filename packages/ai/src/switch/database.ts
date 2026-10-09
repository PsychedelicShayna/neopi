import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock, type FileLockHandle, openSqliteDatabase } from "@oh-my-pi/pi-utils";
import type {
	AttemptRecord,
	DebitRecord,
	InstanceRecord,
	JobRecord,
	KeyRecord,
	KeyTokenRecord,
	MeterRecord,
	UsageRecord,
} from "./internal";
import type { AuditView, ChangeEventName, ChangeFrame, Decision, SwitchEvent } from "./wire";

interface TableRows {
	keys: KeyRecord;
	key_tokens: KeyTokenRecord;
	instances: InstanceRecord;
	meter_snapshots: MeterRecord;
	meter_debits: DebitRecord;
	attempts: AttemptRecord;
	usage_buckets: UsageRecord;
	jobs: JobRecord;
	decisions: Decision;
	events: SwitchEvent;
	audit: AuditView;
}
type Table = keyof TableRows;
const TABLES: readonly Table[] = [
	"keys",
	"key_tokens",
	"instances",
	"meter_snapshots",
	"meter_debits",
	"attempts",
	"usage_buckets",
	"jobs",
	"decisions",
	"events",
	"audit",
];
interface PayloadRow {
	payload: string;
}
export interface StoredChange {
	seq: number;
	kind: ChangeEventName;
	frame: ChangeFrame;
}
export interface RecordFilter {
	field: "at" | "key" | "plan" | "status" | "kind";
	value: string | number;
	comparison?: "=" | ">=";
}

/** Single serving-process connection. Clients never open this database. */
export class SwitchDatabase {
	readonly #db: Database;
	readonly #lease: FileLockHandle;
	readonly file: string;

	private constructor(db: Database, file: string, lease: FileLockHandle) {
		this.#db = db;
		this.#lease = lease;
		this.file = file;
		const schema = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
		if (schema > 1) throw new Error("Unsupported switch Store schema");
		db.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
		if (schema === 0)
			db.transaction(() => {
				db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
				for (const table of TABLES) {
					const jobLink =
						table === "jobs"
							? ", origin_attempt_id TEXT GENERATED ALWAYS AS (json_extract(payload, '$.originAttemptId')) STORED UNIQUE NOT NULL REFERENCES attempts(id)"
							: table === "meter_debits" || table === "usage_buckets"
								? ", attempt_id TEXT GENERATED ALWAYS AS (json_extract(payload, '$.attemptId')) STORED NOT NULL REFERENCES attempts(id)"
								: "";
					db.run(
						`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))${jobLink});`,
					);
				}
				db.run(`
			CREATE INDEX IF NOT EXISTS attempts_unfinished ON attempts(json_extract(payload,'$.upstreamCalled')) WHERE json_extract(payload,'$.settled')=0;
			CREATE INDEX IF NOT EXISTS jobs_created ON jobs(json_extract(payload,'$.createdAt'));
			CREATE INDEX IF NOT EXISTS usage_owner_time ON usage_buckets(json_extract(payload,'$.principal.kind'),json_extract(payload,'$.principal.id'),json_extract(payload,'$.at'));
			CREATE INDEX IF NOT EXISTS debits_meter_instance ON meter_debits(json_extract(payload,'$.plan'),json_extract(payload,'$.meter'),json_extract(payload,'$.instance'));
			CREATE INDEX IF NOT EXISTS debits_owner_time ON meter_debits(json_extract(payload,'$.principal.kind'),json_extract(payload,'$.principal.id'),json_extract(payload,'$.plan'),json_extract(payload,'$.meter'),json_extract(payload,'$.settledAt'));
			CREATE INDEX IF NOT EXISTS attempts_decision ON attempts(json_extract(payload,'$.decisionId'));
			CREATE INDEX IF NOT EXISTS meter_latest ON meter_snapshots(json_extract(payload,'$.plan'),json_extract(payload,'$.meter'),json_extract(payload,'$.binding.provider'),json_extract(payload,'$.binding.credentialId'),json_extract(payload,'$.binding.fingerprint'),json_extract(payload,'$.fetchedAt') DESC);
			CREATE INDEX IF NOT EXISTS decisions_at ON decisions(json_extract(payload,'$.at') DESC,id DESC);
			CREATE INDEX IF NOT EXISTS events_at ON events(json_extract(payload,'$.at') DESC,id DESC);
			CREATE INDEX IF NOT EXISTS audit_at ON audit(json_extract(payload,'$.at') DESC,id DESC);
			CREATE TABLE IF NOT EXISTS change_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
			CREATE VIEW IF NOT EXISTS key_plans AS SELECT keys.id AS key, entry.key AS position, entry.value AS payload FROM keys,json_each(keys.payload,'$.plans') AS entry;
			CREATE VIEW IF NOT EXISTS budgets AS SELECT keys.id AS key,json_extract(entry.value,'$.id') AS id,entry.value AS payload FROM keys,json_each(keys.payload,'$.budgets') AS entry;
			CREATE VIEW IF NOT EXISTS grants AS SELECT keys.id AS key,json_extract(entry.value,'$.id') AS id,entry.value AS payload FROM keys,json_each(keys.payload,'$.grants') AS entry;
			CREATE VIEW IF NOT EXISTS transfer_groups AS SELECT json_extract(payload,'$.transferGroup') AS id,group_concat(json_extract(payload,'$.id')) AS grant_ids FROM grants WHERE json_extract(payload,'$.transferGroup') IS NOT NULL GROUP BY json_extract(payload,'$.transferGroup');
			CREATE VIEW IF NOT EXISTS attributions AS SELECT id,json_extract(payload,'$.principal') AS principal,json_extract(payload,'$.plan') AS plan,json_extract(payload,'$.meter') AS meter,json_extract(payload,'$.instance') AS instance,json_extract(payload,'$.confirmedPct') AS confirmedPct,json_extract(payload,'$.provisionalRemainingPct') AS provisionalRemainingPct FROM meter_debits;
		`);
				db.run("PRAGMA user_version=1");
			}).immediate();
	}

	static async open(stateDir: string): Promise<SwitchDatabase> {
		await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
		await fs.chmod(stateDir, 0o700);
		const file = path.join(await fs.realpath(stateDir), "switch.db");
		const lease = await acquireFileLock(file, { retries: 1 });
		let store: SwitchDatabase | undefined;
		try {
			// Corruption must fail startup, not recreate a fresh allowance pool.
			store = await openSqliteDatabase(file, db => new SwitchDatabase(db, file, lease), {
				recoverCorruption: false,
			});
			await fs.chmod(file, 0o600);
			for (const suffix of ["-wal", "-shm"]) {
				try {
					await fs.chmod(`${file}${suffix}`, 0o600);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			return store;
		} catch (error) {
			if (store) store.close();
			else lease.release();
			throw error;
		}
	}

	transaction<T>(work: () => T): T {
		return this.#db.transaction(work).immediate();
	}

	meta<T>(key: string): T | undefined {
		const row = this.#db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key);
		return row ? (JSON.parse(row.value) as T) : undefined;
	}

	setMeta(key: string, value: unknown): void {
		this.#db
			.query("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
			.run(key, JSON.stringify(value));
	}

	get<T extends Table>(table: T, id: string): TableRows[T] | undefined {
		const row = this.#db.query<PayloadRow, [string]>(`SELECT payload FROM ${table} WHERE id=?`).get(id);
		return row ? (JSON.parse(row.payload) as TableRows[T]) : undefined;
	}

	entries<T extends Table>(table: T): [string, TableRows[T]][] {
		return this.#db
			.query<{ id: string; payload: string }, []>(`SELECT id,payload FROM ${table} ORDER BY id`)
			.all()
			.map<[string, TableRows[T]]>(row => [row.id, JSON.parse(row.payload) as TableRows[T]]);
	}

	all<T extends Table>(table: T): TableRows[T][] {
		return this.#db
			.query<PayloadRow, []>(`SELECT payload FROM ${table} ORDER BY id`)
			.all()
			.map(row => JSON.parse(row.payload) as TableRows[T]);
	}

	put<T extends Table>(table: T, id: string, value: TableRows[T]): void {
		this.#db
			.query(`INSERT INTO ${table}(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`)
			.run(id, JSON.stringify(value));
	}

	remove(table: Table, id: string): void {
		this.#db.query(`DELETE FROM ${table} WHERE id=?`).run(id);
	}

	unfinished(): AttemptRecord[] {
		return this.#db
			.query<PayloadRow, []>("SELECT payload FROM attempts WHERE json_extract(payload,'$.settled')=0 ORDER BY id")
			.all()
			.map(row => JSON.parse(row.payload) as AttemptRecord);
	}

	jobForAttempt(attemptId: string): JobRecord | undefined {
		const row = this.#db
			.query<PayloadRow, [string]>("SELECT payload FROM jobs WHERE origin_attempt_id=?")
			.get(attemptId);
		return row ? (JSON.parse(row.payload) as JobRecord) : undefined;
	}

	usage(kind: "key" | "anonymous", id: string, from: number, to: number): UsageRecord[] {
		return this.#db
			.query<PayloadRow, [string, string, number, number]>(
				"SELECT payload FROM usage_buckets WHERE json_extract(payload,'$.principal.kind')=? AND json_extract(payload,'$.principal.id')=? AND json_extract(payload,'$.at')>=? AND json_extract(payload,'$.at')<? ORDER BY json_extract(payload,'$.at'),id",
			)
			.all(kind, id, from, to)
			.map(row => JSON.parse(row.payload) as UsageRecord);
	}

	debitUsage(
		key: string,
		plan: string,
		meter: string,
		from: number,
		to: number,
		instance?: string,
	): { debit: DebitRecord; provider: string; model: string }[] {
		const sql =
			"SELECT d.payload AS payload,json_extract(a.payload,'$.provider') AS provider,json_extract(a.payload,'$.model') AS model FROM meter_debits AS d JOIN attempts AS a ON a.id=json_extract(d.payload,'$.attemptId') WHERE json_extract(d.payload,'$.principal.kind')='key' AND json_extract(d.payload,'$.principal.id')=? AND json_extract(d.payload,'$.plan')=? AND json_extract(d.payload,'$.meter')=? AND json_extract(d.payload,'$.settledAt')>=? AND json_extract(d.payload,'$.settledAt')<? AND (? IS NULL OR json_extract(d.payload,'$.instance')=?) ORDER BY d.id";
		return this.#db
			.query<
				{ payload: string; provider: string; model: string },
				[string, string, string, number, number, string | null, string | null]
			>(sql)
			.all(key, plan, meter, from, to, instance ?? null, instance ?? null)
			.map(row => ({ debit: JSON.parse(row.payload) as DebitRecord, provider: row.provider, model: row.model }));
	}

	debits(plan: string, meter: string, instance: string): DebitRecord[] {
		return this.#db
			.query<PayloadRow, [string, string, string]>(
				"SELECT payload FROM meter_debits WHERE json_extract(payload,'$.plan')=? AND json_extract(payload,'$.meter')=? AND json_extract(payload,'$.instance')=? ORDER BY id",
			)
			.all(plan, meter, instance)
			.map(row => JSON.parse(row.payload) as DebitRecord);
	}

	currentMeters(): MeterRecord[] {
		const sql =
			"SELECT payload FROM (SELECT payload,row_number() OVER (PARTITION BY json_extract(payload,'$.plan'),json_extract(payload,'$.meter'),json_extract(payload,'$.binding.provider'),json_extract(payload,'$.binding.credentialId'),json_extract(payload,'$.binding.fingerprint') ORDER BY json_extract(payload,'$.fetchedAt') DESC,json_extract(payload,'$.version') DESC) AS position FROM meter_snapshots) WHERE position=1";
		return this.#db
			.query<PayloadRow, []>(sql)
			.all()
			.map(row => JSON.parse(row.payload) as MeterRecord);
	}

	budgetInstances(): [string, InstanceRecord][] {
		return this.#db
			.query<{ id: string; payload: string }, []>(
				"SELECT id,payload FROM instances WHERE id NOT LIKE 'meter:%' ORDER BY id",
			)
			.all()
			.map<[string, InstanceRecord]>(row => [row.id, JSON.parse(row.payload) as InstanceRecord]);
	}

	attemptsForDecision(id: string): AttemptRecord[] {
		return this.#db
			.query<PayloadRow, [string]>(
				"SELECT payload FROM attempts WHERE json_extract(payload,'$.decisionId')=? ORDER BY json_extract(payload,'$.startedAt'),id",
			)
			.all(id)
			.map(row => JSON.parse(row.payload) as AttemptRecord);
	}

	runningDecisions(): Decision[] {
		return this.#db
			.query<PayloadRow, []>(
				"SELECT payload FROM decisions WHERE json_extract(payload,'$.state')='running' ORDER BY id",
			)
			.all()
			.map(row => JSON.parse(row.payload) as Decision);
	}

	denials(from: number, to: number): number {
		return this.#db
			.query<{ count: number }, [number, number]>(
				"SELECT count(*) AS count FROM decisions WHERE json_extract(payload,'$.outcome')='denied' AND json_extract(payload,'$.state')<>'running' AND json_extract(payload,'$.at')>=? AND json_extract(payload,'$.at')<?",
			)
			.get(from, to)!.count;
	}

	keyDebits(key: string, from: number, to: number): DebitRecord[] {
		return this.#db
			.query<PayloadRow, [string, number, number]>(
				"SELECT payload FROM meter_debits WHERE json_extract(payload,'$.principal.kind')='key' AND json_extract(payload,'$.principal.id')=? AND json_extract(payload,'$.settledAt')>=? AND json_extract(payload,'$.settledAt')<? ORDER BY id",
			)
			.all(key, from, to)
			.map(row => JSON.parse(row.payload) as DebitRecord);
	}

	page<T extends "decisions" | "events" | "audit">(
		table: T,
		filters: RecordFilter[],
		limit: number,
		boundary?: { at: number; id: string },
	): TableRows[T][] {
		const clauses: string[] = [];
		const parameters: (string | number)[] = [];
		for (const filter of filters) {
			clauses.push(
				table === "audit" && filter.field === "key"
					? "EXISTS (SELECT 1 FROM json_each(payload,'$.targets') WHERE value='key:' || ?)"
					: table === "decisions" && filter.field === "plan"
						? "EXISTS (SELECT 1 FROM json_each(payload,'$.plans') WHERE json_extract(value,'$.plan')=?)"
						: `json_extract(payload,'$.${filter.field}') ${filter.comparison ?? "="} ?`,
			);
			parameters.push(filter.value);
		}
		if (boundary) {
			clauses.push("(json_extract(payload,'$.at')<? OR (json_extract(payload,'$.at')=? AND id<?))");
			parameters.push(boundary.at, boundary.at, boundary.id);
		}
		parameters.push(limit);
		const sql = `SELECT payload FROM ${table}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY json_extract(payload,'$.at') DESC,id DESC LIMIT ?`;
		return this.#db
			.query<PayloadRow, (string | number)[]>(sql)
			.all(...parameters)
			.map(row => JSON.parse(row.payload) as TableRows[T]);
	}

	changeSequence(): number {
		return (
			this.meta<number>("changeSequence") ??
			this.#db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM change_log").get()?.seq ??
			0
		);
	}

	oldestChange(): number {
		return this.#db.query<{ seq: number | null }, []>("SELECT min(seq) AS seq FROM change_log").get()?.seq ?? 0;
	}

	appendChange(kind: ChangeEventName, frame: ChangeFrame): StoredChange {
		const insertion = this.#db
			.query("INSERT INTO change_log(kind,payload) VALUES (?,?)")
			.run(kind, JSON.stringify(frame));
		const seq = Number(insertion.lastInsertRowid);
		const boot = frame.cursor.slice(0, frame.cursor.lastIndexOf(":"));
		frame.cursor = `${boot}:${seq}`;
		this.#db.query("UPDATE change_log SET payload=? WHERE seq=?").run(JSON.stringify(frame), seq);
		this.setMeta("changeSequence", seq);
		return { seq, kind, frame };
	}

	changes(after: number, through: number, limit: number): StoredChange[] {
		return this.#db
			.query<{ seq: number; kind: ChangeEventName; payload: string }, [number, number, number]>(
				"SELECT seq,kind,payload FROM change_log WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?",
			)
			.all(after, through, limit)
			.map(row => ({ seq: row.seq, kind: row.kind, frame: JSON.parse(row.payload) as ChangeFrame }));
	}

	prune(now: number, historyCutoff: number, usageCutoff: number): void {
		this.transaction(() => {
			this.#db.query("DELETE FROM usage_buckets WHERE json_extract(payload,'$.at')<?").run(usageCutoff);
			this.#db
				.query(
					"DELETE FROM meter_debits WHERE json_extract(payload,'$.settledAt')<? AND EXISTS (SELECT 1 FROM instances AS i WHERE i.id='meter:' || json_extract(meter_debits.payload,'$.instance') AND json_extract(i.payload,'$.closedAt')<?)",
				)
				.run(usageCutoff, now - 7 * 86_400_000);
			this.#db
				.query(
					"DELETE FROM jobs WHERE json_extract(payload,'$.createdAt')<? AND EXISTS (SELECT 1 FROM attempts AS a WHERE a.id=jobs.origin_attempt_id AND json_extract(a.payload,'$.settled')=1 AND json_extract(a.payload,'$.settledAt')<?) AND NOT EXISTS (SELECT 1 FROM usage_buckets WHERE attempt_id=jobs.origin_attempt_id) AND NOT EXISTS (SELECT 1 FROM meter_debits WHERE attempt_id=jobs.origin_attempt_id)",
				)
				.run(now - 86_400_000, historyCutoff);
			this.#db
				.query(
					"DELETE FROM attempts WHERE json_extract(payload,'$.settled')=1 AND json_extract(payload,'$.settledAt')<? AND NOT EXISTS (SELECT 1 FROM jobs WHERE origin_attempt_id=attempts.id) AND NOT EXISTS (SELECT 1 FROM usage_buckets WHERE attempt_id=attempts.id) AND NOT EXISTS (SELECT 1 FROM meter_debits WHERE attempt_id=attempts.id)",
				)
				.run(historyCutoff);
			this.#db
				.query(
					"DELETE FROM decisions WHERE json_extract(payload,'$.at')<? AND json_extract(payload,'$.state')<>'running' AND NOT EXISTS (SELECT 1 FROM attempts AS a WHERE json_extract(a.payload,'$.decisionId')=decisions.id AND json_extract(a.payload,'$.settled')=0)",
				)
				.run(historyCutoff);
			this.#db.query("DELETE FROM events WHERE json_extract(payload,'$.at')<?").run(historyCutoff);
			this.#db
				.query(
					"DELETE FROM change_log WHERE seq<coalesce((SELECT min(seq) FROM change_log WHERE json_extract(payload,'$.at')>=?),(SELECT max(seq) FROM change_log))",
				)
				.run(historyCutoff);
			this.#db
				.query(
					"DELETE FROM meter_snapshots WHERE json_extract(payload,'$.fetchedAt')<? AND EXISTS (SELECT 1 FROM instances AS i WHERE i.id='meter:' || json_extract(meter_snapshots.payload,'$.instance.id') AND json_extract(i.payload,'$.closedAt')<?) AND NOT EXISTS (SELECT 1 FROM meter_debits AS d WHERE json_extract(d.payload,'$.instance')=json_extract(meter_snapshots.payload,'$.instance.id'))",
				)
				.run(now - 48 * 3_600_000, usageCutoff);
		});
	}

	backup(destination: string): void {
		this.#db.query("VACUUM INTO ?").run(destination);
	}

	close(): void {
		try {
			this.#db.run("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			try {
				this.#db.close();
			} finally {
				this.#lease.release();
			}
		}
	}
}

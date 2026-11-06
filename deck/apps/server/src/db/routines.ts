/**
 * Routines + routine_runs queries.
 *
 * `next_run_at` is recomputed whenever a routine is created/updated or fires,
 * driven by the in-process runner. We persist it so a server restart can
 * rebuild the schedule without re-evaluating every cron expression up front.
 */

import type {
	Routine,
	RoutineActionKind,
	RoutineBudget,
	RoutineConcurrency,
	RoutineRun,
	RoutineGraph,
	GraphRunRecord,
	ValidationResult,
} from "@npi-deck/protocol";

import { getDb, id, nowIso } from "./index.ts";
import { importLegacyRoutineYaml } from "../routines/legacy-yaml.ts";
import { logger } from "../log.ts";
import { encodeTriggerPayload } from "./trigger-payload.ts";
import { finalizeRun } from "./routine-step-runs.ts";
import { getGraphEffect, redactGraphActionField } from "./graph-actions.ts";

export const DEFAULT_INBOX_TICKET_ROUTINE_ID = "r_default_inbox_tickets";
interface RoutineRow {
	id: string;
	name: string;
	description: string;
	cron: string;
	action_kind: string;
	action_body: string;
	action_cwd: string | null;
	enabled: number;
	created_at: string;
	updated_at: string;
	last_run_at: string | null;
	next_run_at: string | null;
	// V1 columns (003-routines-v1)
	spec_yaml: string | null;
	spec_toml: string | null;
	concurrency: string;
	budget_json: string | null;
	tags: string | null;
	timezone: string | null;
	spec_version: number;
	graph_json: string | null;
}

interface RunRow {
	id: string;
	routine_id: string;
	started_at: string;
	ended_at: string | null;
	exit_code: number | null;
	stdout_excerpt: string;
	stderr_excerpt: string;
	error: string | null;
	trigger: string;
	// V1 columns (003-routines-v1)
	trigger_payload: string | null;
	total_llm_tokens: number;
	total_llm_cost_micros: number;
	aborted_at: string | null;
	abort_reason: string | null;
	step_count_total: number;
	step_count_failed: number;
	backend_path: string | null;
	backend_commit: string | null;
	backend_version: string | null;
}

function routineToml(row: RoutineRow): string | undefined {
	if (row.spec_toml !== null) return row.spec_toml;
	if (row.spec_yaml === null) return undefined;
	let toml: string;
	try {
		toml = importLegacyRoutineYaml(row.spec_yaml);
	} catch {
		return undefined;
	}
	getDb().query("UPDATE routines SET spec_toml = ? WHERE id = ? AND spec_toml IS NULL").run(toml, row.id);
	logger("routine-toml-import").info(`Imported legacy routine ${row.id} to spec_toml; spec_yaml preserved`);
	return toml;
}

function rowToRoutine(r: RoutineRow): Routine {
	const specVersion = r.spec_version === 2 ? 2 : r.spec_version === 1 ? 1 : 0;
	const out: Routine = {
		id: r.id,
		name: r.name,
		description: r.description,
		cron: r.cron,
		actionKind: r.action_kind as RoutineActionKind,
		actionBody: r.action_body,
		enabled: r.enabled === 1,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		specVersion,
		concurrency: r.concurrency as RoutineConcurrency,
	};
	if (r.id === DEFAULT_INBOX_TICKET_ROUTINE_ID) out.protectedDefault = true;
	if (r.action_cwd !== null) out.actionCwd = r.action_cwd;
	if (r.last_run_at !== null) out.lastRunAt = r.last_run_at;
	if (r.next_run_at !== null) out.nextRunAt = r.next_run_at;
	if (specVersion === 1) {
		out.specToml = routineToml(r);
		if (out.specToml === undefined && r.spec_yaml !== null) {
			out.specImportError = `Legacy routine ${r.id} cannot be imported losslessly; original spec_yaml is unchanged. Replace its source with valid TOML to repair it.`;
		}
	}
	if (r.graph_json !== null) out.graph = JSON.parse(r.graph_json) as RoutineGraph;
	if (r.timezone !== null) out.timezone = r.timezone;
	if (r.budget_json !== null) {
		try {
			out.budget = JSON.parse(r.budget_json) as RoutineBudget;
		} catch {
			/* malformed JSON in budget_json — silently drop; preserves row visibility */
		}
	}
	if (r.tags !== null && r.tags.length > 0) {
		out.tags = r.tags
			.split(",")
			.map(t => t.trim())
			.filter(t => t.length > 0);
	}
	return out;
}

function rowToRun(r: RunRow): RoutineRun {
	const out: RoutineRun = {
		id: r.id,
		routineId: r.routine_id,
		startedAt: r.started_at,
		stdoutExcerpt: r.stdout_excerpt,
		stderrExcerpt: r.stderr_excerpt,
		trigger: r.trigger as RoutineRun["trigger"],
		totalLlmTokens: r.total_llm_tokens,
		totalLlmCostMicros: r.total_llm_cost_micros,
		stepCountTotal: r.step_count_total,
		stepCountFailed: r.step_count_failed,
	};
	if (r.ended_at !== null) out.endedAt = r.ended_at;
	if (r.exit_code !== null) out.exitCode = r.exit_code;
	if (r.error !== null) out.error = r.error;
	if (r.trigger_payload !== null) out.triggerPayload = r.trigger_payload;
	if (r.aborted_at !== null) out.abortedAt = r.aborted_at;
	if (r.abort_reason !== null) out.abortReason = r.abort_reason;
	if (r.backend_path !== null)
		out.backend = { path: r.backend_path, commit: r.backend_commit, version: r.backend_version };
	return out;
}

export function listRoutines(): Routine[] {
	const rows = getDb()
		.query<RoutineRow, []>(
			`SELECT id, name, description, cron, action_kind, action_body, action_cwd, enabled,
			        created_at, updated_at, last_run_at, next_run_at,
			        spec_yaml, spec_toml, concurrency, budget_json, tags, timezone, spec_version, graph_json
			 FROM routines ORDER BY name ASC`,
		)
		.all() as RoutineRow[];
	return rows.map(rowToRoutine);
}

export function getRoutine(routineId: string): Routine | undefined {
	const row = getDb()
		.query<RoutineRow, [string]>(
			`SELECT id, name, description, cron, action_kind, action_body, action_cwd, enabled,
			        created_at, updated_at, last_run_at, next_run_at,
			        spec_yaml, spec_toml, concurrency, budget_json, tags, timezone, spec_version, graph_json
			 FROM routines WHERE id = ?`,
		)
		.get(routineId) as RoutineRow | null;
	return row ? rowToRoutine(row) : undefined;
}

export function createRoutine(input: {
	name: string;
	description?: string;
	cron: string;
	actionKind: RoutineActionKind;
	actionBody: string;
	actionCwd?: string;
	enabled?: boolean;
}): Routine {
	const routineId = `r_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	getDb()
		.query<unknown, [string, string, string, string, string, string, string | null, number, string, string]>(
			`INSERT INTO routines
			   (id, name, description, cron, action_kind, action_body, action_cwd, enabled, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			routineId,
			input.name,
			input.description ?? "",
			input.cron,
			input.actionKind,
			input.actionBody,
			input.actionCwd ?? null,
			input.enabled === false ? 0 : 1,
			now,
			now,
		);
	const out = getRoutine(routineId);
	if (!out) throw new Error("createRoutine failed");
	return out;
}

/**
 * Create a V1 (multi-step) routine. Stores spec_toml as the source of truth;
 * derives `cron` from the first cron trigger (for V0-style queries that look
 * at the column directly), and stuffs concurrency/budget/timezone/tags into
 * their dedicated columns.
 */
export function createV1Routine(input: {
	name: string;
	description?: string;
	specToml: string;
	spec: import("@npi-deck/protocol").RoutineSpec;
	enabled?: boolean;
}): Routine {
	const routineId = `r_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	const firstCron = input.spec.trigger.find(t => "cron" in t) as { cron: string } | undefined;
	const cron = firstCron?.cron ?? "";
	const concurrency = input.spec.concurrency ?? "skip";
	const budgetJson = input.spec.budget ? JSON.stringify(input.spec.budget) : null;
	const tags = input.spec.tags?.join(",") ?? null;
	const timezone = input.spec.timezone ?? null;
	getDb()
		.query<
			unknown,
			[
				string,
				string,
				string,
				string,
				string,
				string,
				number,
				string,
				string,
				string,
				string,
				string | null,
				string | null,
				string | null,
				number,
			]
		>(
			`INSERT INTO routines
			   (id, name, description, cron, action_kind, action_body, enabled, created_at, updated_at,
			    spec_toml, concurrency, budget_json, tags, timezone, spec_version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			routineId,
			input.name,
			input.description ?? "",
			cron,
			// Sentinel V0 fields — never read for spec_version=1 routines, but
			// must satisfy the NOT NULL + CHECK constraints from 001-init.sql.
			"script",
			"",
			input.enabled === false ? 0 : 1,
			now,
			now,
			input.specToml,
			concurrency,
			budgetJson,
			tags,
			timezone,
			1,
		);
	const out = getRoutine(routineId);
	if (!out) throw new Error("createV1Routine failed");
	return out;
}

/**
 * Update a V1 (multi-step) routine. Replaces spec_toml + derived columns
 * (cron mirror, concurrency, budget_json, tags, timezone) atomically. The
 * `enabled` flag may be patched independently of the spec.
 */
export function updateV1Routine(
	routineId: string,
	patch: {
		name?: string;
		description?: string;
		specToml?: string;
		spec?: import("@npi-deck/protocol").RoutineSpec;
		enabled?: boolean;
	},
): Routine | undefined {
	const existing = getRoutine(routineId);
	if (!existing) return undefined;
	if (existing.specVersion !== 1) return undefined;
	const now = nowIso();
	if (patch.specToml !== undefined && patch.spec !== undefined) {
		const spec = patch.spec;
		const firstCron = spec.trigger.find(t => "cron" in t) as { cron: string } | undefined;
		const cron = firstCron?.cron ?? "";
		const concurrency = spec.concurrency ?? "skip";
		const budgetJson = spec.budget ? JSON.stringify(spec.budget) : null;
		const tags = spec.tags && spec.tags.length > 0 ? spec.tags.join(",") : null;
		const timezone = spec.timezone ?? null;
		const name = patch.name ?? spec.name ?? existing.name;
		const description = patch.description ?? spec.description ?? existing.description;
		const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
		getDb()
			.query<
				unknown,
				[
					string,
					string,
					string,
					string,
					string,
					string | null,
					string | null,
					string | null,
					number,
					string,
					string,
				]
			>(
				`UPDATE routines SET name = ?, description = ?, cron = ?, spec_toml = ?, concurrency = ?,
				        budget_json = ?, tags = ?, timezone = ?, enabled = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				name,
				description,
				cron,
				patch.specToml,
				concurrency,
				budgetJson,
				tags,
				timezone,
				enabled ? 1 : 0,
				now,
				routineId,
			);
	} else if (patch.enabled !== undefined || patch.name !== undefined || patch.description !== undefined) {
		const name = patch.name ?? existing.name;
		const description = patch.description ?? existing.description;
		const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
		getDb()
			.query<unknown, [string, string, number, string, string]>(
				`UPDATE routines SET name = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?`,
			)
			.run(name, description, enabled ? 1 : 0, now, routineId);
	}
	return getRoutine(routineId);
}

/** Native graphs are validated against the runner's registered node catalogue. */
export interface GraphRoutineValidator {
	validate(graph: unknown): ValidationResult;
}

function assertValidGraph(graph: RoutineGraph, registry: GraphRoutineValidator): void {
	const result = registry.validate(graph);
	if (!result.valid) throw new Error(`invalid graph: ${JSON.stringify(result.errors)}`);
}

function graphCron(graph: RoutineGraph): string {
	const source = graph.nodes.find(node => node.type === "event.source" && typeof node.config.cron === "string");
	return source ? (source.config.cron as string) : "";
}

export function createGraphRoutine(
	input: {
		/** Reserved identity used only when installing a bundled native default. */
		id?: string;
		name: string;
		description?: string;
		graph: RoutineGraph;
		enabled?: boolean;
	},
	registry: GraphRoutineValidator,
): Routine {
	assertValidGraph(input.graph, registry);
	const routineId = input.id ?? `r_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	const graph = input.graph;
	getDb()
		.query(
			`INSERT INTO routines
		 (id, name, description, cron, action_kind, action_body, enabled, created_at, updated_at,
		  concurrency, budget_json, tags, timezone, spec_version, graph_json)
		 VALUES (?, ?, ?, ?, 'script', '', ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
		)
		.run(
			routineId,
			input.name,
			input.description ?? "",
			graphCron(graph),
			input.enabled === false ? 0 : 1,
			now,
			now,
			graph.concurrency ?? "skip",
			graph.budget ? JSON.stringify(graph.budget) : null,
			graph.tags?.join(",") ?? null,
			graph.timezone ?? null,
			JSON.stringify(graph),
		);
	const routine = getRoutine(routineId);
	if (!routine) throw new Error("createGraphRoutine failed");
	return routine;
}

export function updateGraphRoutine(
	routineId: string,
	patch: {
		name?: string;
		description?: string;
		graph?: RoutineGraph;
		enabled?: boolean;
	},
	registry: GraphRoutineValidator,
): Routine | undefined {
	const existing = getRoutine(routineId);
	if (!existing || existing.specVersion !== 2) return undefined;
	const graph = patch.graph ?? existing.graph;
	if (!graph) throw new Error(`graph routine ${routineId} has no graph`);
	assertValidGraph(graph, registry);
	getDb()
		.query(
			`UPDATE routines SET name = ?, description = ?, enabled = ?, cron = ?, concurrency = ?,
		 budget_json = ?, tags = ?, timezone = ?, graph_json = ?, updated_at = ? WHERE id = ?`,
		)
		.run(
			patch.name ?? existing.name,
			patch.description ?? existing.description,
			(patch.enabled ?? existing.enabled) ? 1 : 0,
			graphCron(graph),
			graph.concurrency ?? "skip",
			graph.budget ? JSON.stringify(graph.budget) : null,
			graph.tags?.join(",") ?? null,
			graph.timezone ?? null,
			JSON.stringify(graph),
			nowIso(),
			routineId,
		);
	return getRoutine(routineId);
}

export function updateRoutine(
	routineId: string,
	patch: Partial<{
		name: string;
		description: string;
		cron: string;
		actionKind: RoutineActionKind;
		actionBody: string;
		actionCwd: string | null;
		enabled: boolean;
	}>,
): Routine | undefined {
	const existing = getRoutine(routineId);
	if (!existing) return undefined;
	const next = { ...existing, ...patch };
	getDb()
		.query<unknown, [string, string, string, string, string, string | null, number, string, string]>(
			`UPDATE routines SET name = ?, description = ?, cron = ?, action_kind = ?, action_body = ?,
			        action_cwd = ?, enabled = ?, updated_at = ?
			 WHERE id = ?`,
		)
		.run(
			next.name,
			next.description,
			next.cron,
			next.actionKind,
			next.actionBody,
			(patch.actionCwd === null ? null : (next.actionCwd ?? null)) as string | null,
			next.enabled ? 1 : 0,
			nowIso(),
			routineId,
		);
	return getRoutine(routineId);
}

export function deleteRoutine(routineId: string): boolean {
	if (routineId === DEFAULT_INBOX_TICKET_ROUTINE_ID) return false;
	const r = getDb().query<unknown, [string]>("DELETE FROM routines WHERE id = ?").run(routineId);
	return Number(r.changes ?? 0) > 0;
}

export function setRoutineSchedule(routineId: string, patch: { lastRunAt?: string; nextRunAt?: string | null }): void {
	const sets: string[] = [];
	const args: Array<string | null> = [];
	if (patch.lastRunAt !== undefined) {
		sets.push("last_run_at = ?");
		args.push(patch.lastRunAt);
	}
	if (patch.nextRunAt !== undefined) {
		sets.push("next_run_at = ?");
		args.push(patch.nextRunAt);
	}
	if (sets.length === 0) return;
	args.push(routineId);
	getDb()
		.query<unknown, (string | null)[]>(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`)
		.run(...args);
}

// ─── Runs ──────────────────────────────────────────────────────────────────

/** Record a run's start. The trigger payload is stored through `encodeTriggerPayload`. */
export function startRun(
	routineId: string,
	trigger: RoutineRun["trigger"],
	triggerPayload?: Record<string, unknown> | unknown[],
): RoutineRun {
	const runId = `run_${id().toLowerCase().slice(0, 18)}`;
	const startedAt = nowIso();
	getDb()
		.query<unknown, [string, string, string, string, string | null]>(
			"INSERT INTO routine_runs (id, routine_id, started_at, trigger, trigger_payload) VALUES (?, ?, ?, ?, ?)",
		)
		.run(
			runId,
			routineId,
			startedAt,
			trigger,
			triggerPayload === undefined ? null : encodeTriggerPayload(triggerPayload),
		);
	const out = getRun(runId);
	if (!out) throw new Error("startRun failed");
	return out;
}

/** Persist the tree selected for this run before executing its first agent step. */
export function setRunBackend(
	runId: string,
	backend: { path: string; commit: string | null; version: string | null },
): void {
	getDb()
		.query<unknown, [string, string | null, string | null, string]>(
			"UPDATE routine_runs SET backend_path = ?, backend_commit = ?, backend_version = ? WHERE id = ?",
		)
		.run(backend.path, backend.commit, backend.version, runId);
}

export function finishRun(
	runId: string,
	patch: { exitCode?: number; stdoutExcerpt?: string; stderrExcerpt?: string; error?: string },
): void {
	getDb()
		.query<unknown, [string, number | null, string, string, string | null, string]>(
			`UPDATE routine_runs
			   SET ended_at = ?, exit_code = ?, stdout_excerpt = ?, stderr_excerpt = ?, error = ?
			 WHERE id = ?`,
		)
		.run(
			nowIso(),
			patch.exitCode ?? null,
			patch.stdoutExcerpt ?? "",
			patch.stderrExcerpt ?? "",
			patch.error ?? null,
			runId,
		);
}

export function listRuns(routineId: string, limit = 20): RoutineRun[] {
	const rows = getDb()
		.query<RunRow, [string, number]>(
			`SELECT id, routine_id, started_at, ended_at, exit_code, stdout_excerpt, stderr_excerpt, error, trigger,
			        trigger_payload, total_llm_tokens, total_llm_cost_micros, aborted_at, abort_reason,
			        step_count_total, step_count_failed, backend_path, backend_commit, backend_version
			 FROM routine_runs
			 WHERE routine_id = ?
			 ORDER BY started_at DESC
			 LIMIT ?`,
		)
		.all(routineId, limit) as RunRow[];
	return rows.map(rowToRun);
}

export function getRun(runId: string): RoutineRun | undefined {
	const row = getDb()
		.query<RunRow, [string]>(
			`SELECT id, routine_id, started_at, ended_at, exit_code, stdout_excerpt, stderr_excerpt, error, trigger,
			        trigger_payload, total_llm_tokens, total_llm_cost_micros, aborted_at, abort_reason,
			        step_count_total, step_count_failed, backend_path, backend_commit, backend_version
			 FROM routine_runs WHERE id = ?`,
		)
		.get(runId) as RunRow | null;
	return row ? rowToRun(row) : undefined;
}

const MAX_GRAPH_TRACE_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_TRACE_DEPTH = 256;
const MAX_GRAPH_HISTORY_ERROR_CHARS = 8 * 1024;
class GraphTraceLimitError extends Error {
	constructor(message = `Graph trace exceeds the ${MAX_GRAPH_TRACE_BYTES}-byte serialization budget`) {
		super(message);
	}
}

/** Redact user data during serialization, without copying or changing live envelopes. */
export function encodeGraphTrace(record: GraphRunRecord): string {
	const ancestors: object[] = [];
	const payloadScopes: boolean[] = [];
	let bytes = 0;
	return JSON.stringify(record, function (this: object, key: string, value: unknown) {
		while (ancestors.length && ancestors[ancestors.length - 1] !== this) {
			ancestors.pop();
			payloadScopes.pop();
		}
		if (ancestors.length >= MAX_GRAPH_TRACE_DEPTH)
			throw new GraphTraceLimitError(
				`Graph trace exceeds the ${MAX_GRAPH_TRACE_DEPTH}-level serialization depth budget`,
			);
		const insidePayload = payloadScopes[payloadScopes.length - 1] ?? false;
		if (insidePayload) value = redactGraphActionField(key, value);
		// Charge each occurrence, including shared envelopes, before stringify expands it.
		// One separator per member is conservative for first members and omitted values.
		if (key.length > MAX_GRAPH_TRACE_BYTES || (typeof value === "string" && value.length > MAX_GRAPH_TRACE_BYTES))
			throw new GraphTraceLimitError();
		if (ancestors.length) bytes += Array.isArray(this) ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2;
		if (value !== null && typeof value === "object") bytes += 2;
		else {
			const encoded = JSON.stringify(value);
			if (encoded !== undefined) bytes += Buffer.byteLength(encoded);
		}
		if (bytes > MAX_GRAPH_TRACE_BYTES) throw new GraphTraceLimitError();
		if (value !== null && typeof value === "object") {
			ancestors.push(value);
			payloadScopes.push(
				insidePayload ||
					key === "result" ||
					key === "config" ||
					key === "request" ||
					key === "receipt" ||
					(this === record.activation && key === "event"),
			);
		}
		return value;
	});
}

/** Final trace and existing run aggregates become durable in the same transaction. */
export function finishGraphRun(record: GraphRunRecord, abortReason?: string): void {
	getDb().transaction(() => {
		const run = getRun(record.id);
		if (!run || run.routineId !== record.routineId) throw new Error("graph trace run does not match routine");
		let trace: string | null = null;
		let traceError: string | undefined;
		try {
			trace = encodeGraphTrace(record);
		} catch (failure) {
			traceError =
				failure instanceof GraphTraceLimitError
					? failure.message
					: `Graph trace could not be serialized: ${String(failure).slice(0, MAX_GRAPH_HISTORY_ERROR_CHARS)}`;
		}
		const historyError = traceError
			? `${traceError}\n${record.error?.slice(0, MAX_GRAPH_HISTORY_ERROR_CHARS) ?? ""}`.slice(
					0,
					MAX_GRAPH_HISTORY_ERROR_CHARS,
				)
			: record.error?.slice(0, MAX_GRAPH_HISTORY_ERROR_CHARS);
		getDb().query("UPDATE routine_runs SET graph_run_json = ? WHERE id = ?").run(trace, record.id);
		const mode = record.graph.execution?.mode;
		if (mode === "routine-v0") {
			const receipt = record.nodeRuns.find(node => node.type === "process.v0")?.diagnostics?.v0;
			const result = receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : {};
			finalizeRun(record.id, {
				endedAt: record.endedAt,
				exitCode: traceError ? null : typeof result.exitCode === "number" ? result.exitCode : null,
				stdoutExcerpt: typeof result.stdoutExcerpt === "string" ? result.stdoutExcerpt : "",
				stderrExcerpt: typeof result.stderrExcerpt === "string" ? result.stderrExcerpt : "",
				error: traceError ? historyError : typeof result.error === "string" ? result.error : undefined,
			});
			return;
		}
		if (mode === "routine-v1") {
			const steps = record.nodeRuns.filter(node => node.type.startsWith("step.") && node.diagnostics?.result);
			let stdout = "";
			for (const step of steps) {
				const result = step.diagnostics!.result;
				const more =
					result &&
					typeof result === "object" &&
					!Array.isArray(result) &&
					typeof result.stdoutExcerpt === "string"
						? result.stdoutExcerpt
						: "";
				const room = MAX_GRAPH_HISTORY_ERROR_CHARS - stdout.length;
				if (room > 0) stdout += more.length > room ? more.slice(0, room) + "\n…(truncated)" : more;
			}
			const reason =
				abortReason ??
				record.abortReason ??
				(record.status === "aborted" ? "cancelled" : record.status === "failed" ? "failure" : undefined);
			finalizeRun(record.id, {
				endedAt: record.endedAt,
				exitCode: !traceError && record.status === "success" ? 0 : null,
				stdoutExcerpt: stdout,
				stderrExcerpt: "",
				error: traceError ? historyError : reason ? `aborted: ${reason}` : undefined,
				...(reason ? { abortedAt: record.endedAt, abortReason: reason } : {}),
				totalLlmTokens: (record.usage?.llmTokensIn ?? 0) + (record.usage?.llmTokensOut ?? 0),
				totalLlmCostMicros: record.usage?.llmCostMicros ?? 0,
				stepCountTotal: steps.length,
				stepCountFailed: steps.filter(
					(node, index) =>
						(node.status === "failed" || node.status === "aborted") &&
						!(reason === "budget" && index === steps.length - 1),
				).length,
			});
			return;
		}
		finalizeRun(record.id, {
			endedAt: record.endedAt,
			exitCode: !traceError && record.status === "success" ? 0 : 1,
			error: historyError,
			...(record.status === "aborted"
				? {
						abortedAt: record.endedAt,
						abortReason: abortReason ?? record.abortReason ?? "cancelled",
					}
				: {}),
			totalLlmTokens: (record.usage?.llmTokensIn ?? 0) + (record.usage?.llmTokensOut ?? 0),
			totalLlmCostMicros: record.usage?.llmCostMicros ?? 0,
			stepCountTotal: record.nodeRuns.filter(node => node.status !== "skipped").length,
			stepCountFailed: record.nodeRuns.filter(node => node.status === "failed" || node.status === "aborted").length,
		});
	})();
}

/** Fetch full provenance only on the dedicated trace path, never in run listings. */
export function getGraphRun(runId: string): GraphRunRecord | undefined {
	const row = getDb()
		.query<{ graph_run_json: string | null }, [string]>("SELECT graph_run_json FROM routine_runs WHERE id = ?")
		.get(runId);
	if (!row?.graph_run_json) return undefined;
	const record = JSON.parse(row.graph_run_json) as GraphRunRecord;
	// Late provider confirmations survive cancellation without reactivating the run.
	if (!record.dryRun)
		for (const node of record.nodeRuns) {
			node.effects = node.effects?.map(effect => {
				if (effect.status !== "uncertain") return effect;
				const durable = getGraphEffect(effect.logicalKey);
				return durable ? { ...durable, replayed: effect.replayed } : effect;
			});
		}
	return record;
}

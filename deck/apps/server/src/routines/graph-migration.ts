import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSettingsToml as parse, stringifySettingsToml as stringify } from "@oh-my-pi/pi-utils/settings-toml";
import { importLegacyRoutineYaml } from "./legacy-yaml.ts";
import { isGraphValue, validateRoutineSpec, type GraphNode, type GraphObject, type GraphValue, type RoutineGraph, type RoutineSpec } from "@npi-deck/protocol";
import { getDb } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import type { GraphNodeRegistry } from "./graph-runner.ts";
import { nativeStepTypes } from "./graph-step-nodes.ts";

export interface MigrationField {
	path: string;
	status: "supported" | "preserved-declaration-only" | "explicit-loss" | "blocked";
	mapping: string;
	/** No source values, TOML fragments or credentials enter an ordinary report. */
	original: string;
}
export interface RoutineMigrationReport {
	routineId: string;
	sourceVersion: number;
	status: "ready" | "blocked" | "native" | "migrated";
	sourceDigest: string;
	fields: MigrationField[];
}
type Row = Record<string, string | number | null> & { id: string; spec_version: number; spec_yaml: string | null; spec_toml: string | null; graph_json: string | null };
interface Plan { row: Row; report: RoutineMigrationReport; graph?: RoutineGraph }
interface Conversion { routine_id: string; source_digest: string; original_json: string; converted_graph_json: string; backup_path: string; converted_at: string; restored_at: string | null }
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const encode = (value: unknown) => JSON.stringify(value);
const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

function plan(row: Row, registry: GraphNodeRegistry): Plan {
	const sourceDigest = hash(encode(row));
	const report: RoutineMigrationReport = { routineId: row.id, sourceVersion: row.spec_version, status: row.spec_version === 2 ? "native" : "ready", sourceDigest, fields: [] };
	const field = (key: string, status: MigrationField["status"], mapping: string) => {
		const existing = report.fields.find(item => item.path === key);
		if (existing?.status === "blocked") return;
		const entry = { path: key, status, mapping, original: `original:${row.id}:${sourceDigest}#${key}` };
		if (existing) Object.assign(existing, entry); else report.fields.push(entry);
	};
	const block = (key: string, reason: string) => { field(key, "blocked", reason); report.status = "blocked"; };
	if (row.spec_version === 2) return { row, report };
	// Preserve every raw column, including columns a normalized Routine reader hides.
	for (const key of Object.keys(row)) field(`/row/${pointer(key)}`, "supported", "Unchanged in-place metadata and owner-only database backup");
	if (row.graph_json !== null) block("/row/graph_json", "Legacy row already contains a graph; source identity is ambiguous");
	const registration = getDb().query<{ path: string }, [string]>("SELECT path FROM routine_webhook_secrets WHERE routine_id = ?").get(row.id);
	if (row.spec_version === 0) {
		if (row.action_kind === "prompt") block("/row/action_kind", "V0 prompt starts an agent. Native agent instantiation, backend pinning and usage contracts depend on neopi#11.");
		else if (row.action_kind !== "bash" && row.action_kind !== "script") block("/row/action_kind", "Unknown V0 process kind has no native command contract");
		if (typeof row.action_body !== "string") block("/row/action_body", "V0 process body must be a string");
		if (row.spec_yaml !== null || row.spec_toml !== null) block("/row/spec_toml", "V0 row contains an unexpected pipeline declaration; source identity is ambiguous");
		if (registration) block("/row/webhook_registration", "V0 webhook dispatch historically changes trigger kind to manual; no equivalent native source mapping is selected");
		if (row.budget_json !== null) field("/row/budget_json", "preserved-declaration-only", "V0 never enforced this column. It remains in the row and protected original, not an active native budget.");
		const graph: RoutineGraph = {
			version: 2,
			execution: { mode: "routine-v0" },
			nodes: [
				{ id: "__manual", type: "event.source", config: { eventType: "manual" } },
				...(typeof row.cron === "string" && row.cron ? [{ id: "__cron", type: "event.source", config: { eventType: "cron", cron: row.cron } }] : []),
				{ id: "__process", type: "process.v0", config: { kind: row.action_kind!, body: row.action_body!, ...(typeof row.action_cwd === "string" ? { cwd: row.action_cwd } : {}) } },
			],
			edges: [],
			concurrency: row.concurrency as RoutineGraph["concurrency"],
			...(typeof row.timezone === "string" ? { timezone: row.timezone } : {}),
		};
		for (const source of graph.nodes.slice(0, -1)) graph.edges.push({ id: `${source.id}_process`, from: { nodeId: source.id, port: "event" }, to: { nodeId: "__process", port: "in" } });
		field("/row/action_kind", "supported", "/graph/nodes/__process/config/kind, exact original V0 argv, no interpolation");
		field("/row/action_body", "supported", "/graph/nodes/__process/config/body, original whitespace splitting for script and shell argument for bash");
		field("/row/action_cwd", "supported", "/graph/nodes/__process/config/cwd, runtime process.cwd fallback and original trimming");
		const validation = registry.validate(graph);
		if (!validation.valid) for (const error of validation.errors ?? []) block(`/graph${error.path}`, `Production registry refused V0 mapping (${error.keyword})`);
		return { row, report, ...(report.status === "ready" ? { graph } : {}) };
	}
	if (row.spec_version !== 1) {
		block("/row/spec_version", "Unknown routine source version");
		return { row, report };
	}
	let parsed: unknown;
	try {
		const source = row.spec_toml ?? (row.spec_yaml === null ? undefined : importLegacyRoutineYaml(row.spec_yaml));
		if (source === undefined) throw new Error("Missing source");
		parsed = parse(source);
		if (!isGraphValue(parsed)) throw new Error("Non-JSON TOML value");

	} catch {
		block("/spec_toml", "Malformed TOML or legacy declaration cannot be imported losslessly. Inspect the protected original, not this report.");
		return { row, report };
	}
	const validation = validateRoutineSpec(parsed);
	if (!validation.valid) {
		for (const error of validation.errors ?? []) {
			const extra = typeof error.params.additionalProperty === "string" ? `/${pointer(error.params.additionalProperty)}` : "";
			block(`/spec${error.path === "/" ? "" : error.path}${extra}`, `Invalid legacy declaration (${error.keyword}). Original remains unchanged.`);
		}
		return { row, report };
	}
	const spec = parsed as unknown as RoutineSpec;
	const mirrors: Record<string, unknown> = {
		concurrency: spec.concurrency ?? "skip", timezone: spec.timezone ?? null,
		tags: spec.tags?.join(",") ?? null,
		cron: (spec.trigger.find(trigger => "cron" in trigger) as { cron: string } | undefined)?.cron ?? "",
	};
	for (const [key, expected] of Object.entries(mirrors)) if (row[key] !== expected) block(`/row/${key}`, "Raw mirrored column disagrees with TOML; no precedence is guessed");
	let budget: unknown = null;
	try { budget = row.budget_json === null ? null : JSON.parse(String(row.budget_json)); }
	catch { block("/row/budget_json", "Malformed raw budget JSON, which normalized readers silently hide"); }
	if (encode(budget) !== encode(spec.budget ?? null)) block("/row/budget_json", "Raw budget disagrees with TOML");
	for (const key of Object.keys(spec.budget ?? {})) field(`/spec/budget/${pointer(key)}`, "supported", `/graph/budget/${pointer(key)}, native routine-v1 per-attempt accounting and abort precedence`);
	if (spec.tags?.some(tag => tag.includes(",") || tag.trim() !== tag)) block("/spec/tags", "Legacy comma-split tags disagree with the declared array");
	if (spec.state) field("/spec/state", "preserved-declaration-only", "Informational declared_keys retained in the protected original and semantic export; persisted routine_state remains unchanged");
	if (spec.layout?.edges?.length) field("/spec/layout/edges", "preserved-declaration-only", "Legacy visual edges never drove execution. Kept in original/export only; not activated as native routing.");
	field("/spec_toml/syntax", "explicit-loss", "Semantic export does not reproduce comments, anchors, formatting or key order. Exact raw TOML remains in the durable backup.");
	const graph: RoutineGraph = { version: 2, execution: { mode: "routine-v1" }, nodes: [], edges: [] };
	for (const key of ["concurrency", "timezone", "tags"] as const) if (spec[key] !== undefined) Object.assign(graph, { [key]: spec[key] });
	if (spec.budget) graph.budget = spec.budget;
	if (spec.layout?.nodes) graph.layout = { nodes: spec.layout.nodes };
	const sources: string[] = [];
	let manualSource: GraphNode | undefined;
	let eventSource: GraphNode | undefined;
	let webhookPath: string | undefined;
	for (const [index, trigger] of spec.trigger.entries()) {
		const source = `__trigger_${index}`;
		let node: GraphNode;
		if ("manual" in trigger) {
			if (Object.hasOwn(trigger.manual ?? {}, "params_schema")) field(`/spec/trigger/${index}/manual/params_schema`, "preserved-declaration-only", "Retained in native manualTriggers. The original run API does not validate this schema; conversion does not add a new restriction.");
			if (manualSource) {
				(manualSource.config.manualTriggers as GraphValue[]).push(structuredClone(trigger.manual ?? {}) as GraphValue);
				field(`/spec/trigger/${index}/manual`, "supported", `/graph/nodes/${manualSource.id}/config/manualTriggers, declaration only as in the original manual API`);
				continue;
			}
			node = { id: source, type: "event.source", config: { eventType: "manual", manualTriggers: [structuredClone(trigger.manual ?? {}) as GraphValue] } };
			manualSource = node;
		} else if ("event" in trigger) {
			for (const key of Object.keys(trigger.event)) field(`/spec/trigger/${index}/event/${pointer(key)}`, "preserved-declaration-only", "Retained in native eventTriggers. Existing explicit event admission is preserved; no automatic subscription or filter evaluation is invented.");
			if (eventSource) {
				(eventSource.config.eventTriggers as GraphValue[]).push(structuredClone(trigger.event) as unknown as GraphValue);
				field(`/spec/trigger/${index}/event`, "supported", `/graph/nodes/${eventSource.id}/config/eventTriggers, existing explicit event admission without a new subscription`);
				continue;
			}
			node = { id: source, type: "event.source", config: { eventType: "event", eventTriggers: [structuredClone(trigger.event) as unknown as GraphValue] } };
			eventSource = node;
		} else if ("webhook" in trigger) {
			if (webhookPath !== undefined) {
				block(`/spec/trigger/${index}/webhook`, "Multiple webhook declarations exceed the existing one-registration-per-routine credential contract");
				continue;
			}
			webhookPath = trigger.webhook.path;
			for (const key of Object.keys(trigger.webhook)) field(`/spec/trigger/${index}/webhook/${pointer(key)}`, "supported", `/graph/nodes/${source}/config/webhook/${pointer(key)}, existing signed admission and unchanged stored credential`);
			node = { id: source, type: "event.source", config: { eventType: "webhook", webhook: structuredClone(trigger.webhook) as unknown as GraphObject } };
		} else node = { id: source, type: "event.source", config: { eventType: "cron", cron: trigger.cron } };
		graph.nodes.push(node);
		sources.push(source);
		field(`/spec/trigger/${index}`, "supported", `/graph/nodes/${graph.nodes.length - 1}/config`);
	}
	if (registration && registration.path !== webhookPath) block("/row/webhook_registration", "Existing registration is absent from or disagrees with the declared webhook path; credentials are never moved or rotated by conversion");
	// All legacy routines admit explicit manual/event fire calls, regardless of declarations.
	if (!manualSource) { sources.push("__manual"); graph.nodes.push({ id: "__manual", type: "event.source", config: { eventType: "manual" } }); }
	if (!eventSource) { sources.push("__event"); graph.nodes.push({ id: "__event", type: "event.source", config: { eventType: "event" } }); }
	const ids = new Set<string>();
	for (const [index, step] of spec.steps.entries()) {
		const base = `/spec/steps/${index}`;
		if (ids.has(step.id)) block(`${base}/id`, "Duplicate step id would overwrite legacy context and cannot identify a native node");
		ids.add(step.id);
		if (!nativeStepTypes.includes(step.type)) block(`${base}/type`, "No equivalent production native node. Agent backend pinning, usage and sandbox semantics remain on the original.");
		if (step.type === "write" && typeof row.action_cwd === "string" && row.action_cwd.trim()) block("/row/action_cwd", "Legacy write dispatch uses actionCwd despite its defaultCwd contract. Resolve this ambiguity before conversion.");
		const config = { step: structuredClone(step), ...(typeof row.action_cwd === "string" && row.action_cwd.trim() ? { cwd: row.action_cwd } : {}) };
		const nodeIndex = graph.nodes.length;
		graph.nodes.push({ id: step.id, type: `step.${step.type}`, config: config as unknown as GraphObject });
		const mapFields = (value: unknown, suffix: string) => {
			field(`${base}${suffix}`, "supported", `/graph/nodes/${nodeIndex}/config/step${suffix}`);
			if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) mapFields(child, `${suffix}/${pointer(key)}`);
		};
		mapFields(step, "");
		if (index === 0) for (const source of sources) graph.edges.push({ id: `${source}_${step.id}`, from: { nodeId: source, port: "event" }, to: { nodeId: step.id, port: "in" } });
		else graph.edges.push({ id: `__edge_${index}_completed`, from: { nodeId: spec.steps[index - 1]!.id, port: "completed" }, to: { nodeId: step.id, port: "in" } });
	}
	const native = registry.validate(graph);
	if (!native.valid) for (const error of native.errors ?? []) {
		const extra = error.params.unevaluatedProperty ?? error.params.additionalProperty;
		const suffix = typeof extra === "string" ? `/${pointer(extra)}` : "";
		const edgeMatch = /^\/edges\/(\d+)\/(from|to)\//.exec(error.path);
		const endpoint = edgeMatch ? graph.edges[Number(edgeMatch[1])]?.[edgeMatch[2] as "from" | "to"] : undefined;
		const endpointIndex = endpoint ? spec.steps.findIndex(step => step.id === endpoint.nodeId) : -1;
		if (endpointIndex >= 0 && !nativeStepTypes.includes(spec.steps[endpointIndex]!.type)) {
			block(`/spec/steps/${endpointIndex}/type`, "No equivalent production native node can provide this step's input or completion ports");
			continue;
		}
		const match = /^\/nodes\/(\d+)(\/config\/step(.*)|\/type)$/.exec(error.path);
		const node = match ? graph.nodes[Number(match[1])] : undefined;
		const stepIndex = node ? spec.steps.findIndex(step => step.id === node.id) : -1;
		const sourceSuffix = match?.[2] === "/type" ? "/type" : match?.[3] ?? "";
		block(stepIndex >= 0 ? `/spec/steps/${stepIndex}${sourceSuffix}${suffix}` : `/graph${error.path}${suffix}`, `Production registry refused mapped node/config (${error.keyword}). Unknown fields and unsupported controls are not discarded.`);
	}
	for (const key of ["name", "description", "concurrency", "timezone", "tags", "budget", "layout"] as const) if (Object.hasOwn(spec, key)) field(`/spec/${key}`, "supported", key === "name" || key === "description" ? "Raw row identity remains authoritative; original TOML declaration retained for semantic export" : `/graph/${key}`);
	return { row, report, ...(report.status === "ready" ? { graph } : {}) };
}
function plans(registry: GraphNodeRegistry, routineId?: string): Plan[] {
	const rows = routineId
		? getDb().query<Row, [string]>("SELECT * FROM routines WHERE id = ?").all(routineId)
		: getDb().query<Row, []>("SELECT * FROM routines ORDER BY id").all();
	return rows.map(row => plan(row, registry));
}
export function inspectRoutineMigrations(registry: GraphNodeRegistry, routineId?: string): RoutineMigrationReport[] { return plans(registry, routineId).map(item => item.report); }

/** SQLite serialization includes committed WAL pages, unlike copying the main file. */
function backupDatabase(directory: string): string {
	const bytes = getDb().serialize();
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	const destination = path.join(directory, `before-routine-graphs-${hash(bytes)}.sqlite`);
	if (fs.existsSync(destination)) {
		if (hash(fs.readFileSync(destination)) !== hash(bytes)) throw new Error("Existing migration backup failed integrity check");
	} else {
		const partial = `${destination}.${crypto.randomUUID()}.partial`;
		try {
			const fd = fs.openSync(partial, "wx", 0o600);
			try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			fs.renameSync(partial, destination);
		} finally {
			fs.rmSync(partial, { force: true });
		}
	}
	const dir = fs.openSync(directory, "r");
	try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
	return destination;
}

/** Opt-in and synchronous. No scheduler, executor, transport or webhook registration is called. */
export function migrateRoutines(registry: GraphNodeRegistry, options: { routineId?: string; backupDirectory?: string } = {}): { reports: RoutineMigrationReport[]; backupPath?: string } {
	const items = plans(registry, options.routineId);
	const ready = items.filter(item => item.graph);
	if (!ready.length) return { reports: items.map(item => item.report) };
	const backupPath = backupDatabase(options.backupDirectory ?? path.join(path.dirname(loadConfig().dbPath), "routine-migration-backups"));
	for (const item of ready) {
		getDb().transaction(() => {
			const current = getDb().query<Row, [string]>("SELECT * FROM routines WHERE id = ?").get(item.row.id);
			if (!current || encode(current) !== encode(item.row)) throw new Error(`Routine changed during migration: ${item.row.id}`);
			const validation = registry.validate(item.graph);
			if (!validation.valid) throw new Error(`Graph validation changed during migration: ${item.row.id}`);
			const graphJson = encode(item.graph);
			getDb().query("INSERT INTO routine_graph_conversions (routine_id, source_digest, original_json, converted_graph_json, backup_path, converted_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(routine_id, source_digest) DO UPDATE SET converted_graph_json = excluded.converted_graph_json, backup_path = excluded.backup_path, converted_at = excluded.converted_at, restored_at = NULL").run(item.row.id, item.report.sourceDigest, encode(item.row), graphJson, backupPath, new Date().toISOString());
			getDb().query("UPDATE routines SET spec_version = 2, graph_json = ?, spec_toml = NULL WHERE id = ?").run(graphJson, item.row.id);
		}).immediate();
		item.report.status = "migrated";
	}
	return { reports: items.map(item => item.report), backupPath };
}

/** Restore the exact pre-conversion definition only; never undo later external actions. */
export function restoreRoutineDefinition(routineId: string, sourceDigest: string): void {
	getDb().transaction(() => {
		const conversion = getDb().query<Conversion, [string, string]>("SELECT * FROM routine_graph_conversions WHERE routine_id = ? AND source_digest = ?").get(routineId, sourceDigest);
		if (!conversion) throw new Error("Conversion not found");
		const current = getDb().query<Row, [string]>("SELECT * FROM routines WHERE id = ?").get(routineId);
		if (!current) throw new Error("Routine no longer exists");
		const original = JSON.parse(conversion.original_json) as Row;
		const predatesToml = !Object.hasOwn(original, "spec_toml");
		const specToml = original.spec_toml ?? (
			original.spec_version === 1 && original.spec_yaml !== null
				? importLegacyRoutineYaml(original.spec_yaml) : null
		);
		// Metadata edits must not disappear as a side effect of restoration.
		const expected: Row = conversion.restored_at !== null ? { ...original, spec_toml: specToml } : {
			...original, spec_version: 2, spec_toml: null, graph_json: conversion.converted_graph_json,
			...(predatesToml ? { spec_yaml: null } : {}),
		};
		for (const key of Object.keys(expected)) {
			if (key === "last_run_at" || key === "next_run_at") continue;
			if (current[key] !== expected[key]) throw new Error("Routine metadata changed since conversion");
		}
		if (conversion.restored_at !== null) return;
		// Old graph conversions cleared YAML. Recover their protected original;
		// never replace provenance retained by current conversions.
		if (predatesToml && original.spec_yaml !== null) {
			getDb().query("UPDATE routines SET spec_yaml = ? WHERE id = ? AND spec_yaml IS NULL").run(original.spec_yaml, routineId);
		}
		getDb().query("UPDATE routines SET spec_version = ?, spec_toml = ?, graph_json = ?, cron = ?, action_kind = ?, action_body = ?, action_cwd = ?, concurrency = ?, budget_json = ?, timezone = ?, tags = ? WHERE id = ?").run(original.spec_version, specToml, original.graph_json, original.cron!, original.action_kind!, original.action_body!, original.action_cwd!, original.concurrency!, original.budget_json!, original.timezone!, original.tags!, routineId);
		getDb().query("UPDATE routine_graph_conversions SET restored_at = ? WHERE routine_id = ? AND source_digest = ?").run(new Date().toISOString(), routineId, sourceDigest);
	}).immediate();
}

/** One-shot semantic TOML export, not an authoring or execution source. Refuse edited topology. */
export function exportRoutineMigration(routineId: string, sourceDigest: string): string {
	const conversion = getDb().query<Conversion, [string, string]>("SELECT * FROM routine_graph_conversions WHERE routine_id = ? AND source_digest = ?").get(routineId, sourceDigest);
	if (!conversion) throw new Error("Conversion not found");
	const row = JSON.parse(conversion.original_json) as Row;
	// The immutable converted graph and raw definition prove omitted/false/zero/null distinctions.
	// Exporting later native edits as legacy TOML would invent a reverse mapping; refuse that.
	const current = getDb().query<Row, [string]>("SELECT * FROM routines WHERE id = ?").get(routineId);
	if (!current || (current.spec_version === 2 && current.graph_json !== conversion.converted_graph_json)) throw new Error("Native definition changed; use native graph export");
	if (row.spec_version === 0) return stringify({
		version: 0, name: row.name, description: row.description, cron: row.cron,
		actionKind: row.action_kind, actionBody: row.action_body,
		...(row.action_cwd !== null ? { actionCwd: row.action_cwd } : {}), enabled: row.enabled === 1,
		metadata: { concurrency: row.concurrency, budget_json: row.budget_json, timezone: row.timezone, tags: row.tags },
	});
	return stringify(parse(row.spec_toml ?? importLegacyRoutineYaml(row.spec_yaml!)));
}

import { randomBytes } from "node:crypto";

import { Hono } from "hono";
import { parseSettingsToml as parseToml } from "@oh-my-pi/pi-utils/settings-toml";

import type {
	CreateRoutineRequest,
	GraphActivation,
	GraphRunRecord,
	ListRoutineRunsResponse,
	ListRoutineStepRunsResponse,
	ListRoutinesResponse,
	RoutineSpec,
	RoutineWebhookStatus,
	UpdateRoutineRequest,
} from "@npi-deck/protocol";
import { isGraphValue, validateRoutineSpec } from "@npi-deck/protocol";

import { logger } from "./log.ts";
import {
	createRoutine,
	createV1Routine,
	createGraphRoutine,
	deleteRoutine,
	DEFAULT_INBOX_TICKET_ROUTINE_ID,
	getRoutine,
	getGraphRun,
	getRun,
	encodeGraphTrace,
	listRoutines,
	listRuns,
	updateRoutine,
	updateV1Routine,
	updateGraphRoutine,
} from "./db/routines.ts";
import {
	deleteWebhookSecret,
	ensureWebhookSecret,
	getWebhookSecretByPath,
	getWebhookSecretByRoutine,
	listStepRuns,
	refuseWebhookBareSecret,
	upsertWebhookSecret,
} from "./db/routine-step-runs.ts";
import type { RoutinesRunner } from "./routines-runner.ts";
import { listTemplates, loadTemplate } from "./routines/templates.ts";
import { executeGraph, GraphValidationError } from "./routines/graph-runner.ts";
import {
	exportRoutineMigration,
	inspectRoutineMigrations,
	migrateRoutines,
	restoreRoutineDefinition,
} from "./routines/graph-migration.ts";
import { graphWebhookPath } from "./routines/graph-triggers.ts";

const log = logger("routes:routines");

/** Everything the UI may know about a webhook registration: no secret, no hash. */
function webhookStatus(routineId: string): RoutineWebhookStatus | undefined {
	const row = getWebhookSecretByRoutine(routineId);
	if (!row) return undefined;
	return {
		path: row.path,
		acceptsBareSecret: row.accept_bare_secret === 1,
		signingKeyStored: row.signing_key !== null,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
		lastBareSecretAt: row.last_bare_secret_at,
	};
}

function webhookPathClaimed(hookPath: string | undefined, routineId?: string): boolean {
	const owner = hookPath ? getWebhookSecretByPath(hookPath) : undefined;
	return owner !== undefined && owner.routine_id !== routineId;
}

export function buildRoutinesRouter(runner: RoutinesRunner): Hono {
	const app = new Hono();

	app.get("/routines", c => {
		const body: ListRoutinesResponse = { routines: listRoutines() };
		return c.json(body);
	});

	app.get("/routine-node-types", c => c.json({ nodeTypes: runner.graphRegistry.describe() }));

	app.post("/routine-graphs/validate", async c => {
		try {
			const graph = await c.req.json();
			const result = runner.graphRegistry.validate(graph);
			return c.json(result, result.valid ? 200 : 400);
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
	});
	// Explicit one-shot conversion only. Loading, listing and startup never migrate or run actions.
	app.get("/routine-migrations", c => c.json({ reports: inspectRoutineMigrations(runner.graphRegistry) }));
	app.post("/routine-migrations/:id", c => {
		if (runner.busy) return c.json({ error: "wait for active routines to finish before migrating" }, 409);
		const id = c.req.param("id");
		const report = inspectRoutineMigrations(runner.graphRegistry, id)[0];
		if (!report) return c.json({ error: "not found" }, 404);
		if (report.status === "blocked") return c.json({ reports: [report] }, 409);
		try {
			const result = migrateRoutines(runner.graphRegistry, { routineId: id });
			const routine = getRoutine(id);
			if (routine) runner.schedule(routine);
			return c.json(result);
		} catch {
			return c.json({ error: "conversion failed; inspect the protected backup and retry" }, 500);
		}
	});
	app.get("/routine-migrations/:id/:digest/export", c => {
		try {
			return c.text(exportRoutineMigration(c.req.param("id"), c.req.param("digest")), 200, {
				"Content-Type": "application/toml",
				"Cache-Control": "no-store",
			});
		} catch {
			return c.json({ error: "conversion missing or native definition changed" }, 409);
		}
	});
	app.post("/routine-migrations/:id/:digest/restore", c => {
		if (runner.busy) return c.json({ error: "wait for active routines to finish before restoring" }, 409);
		const id = c.req.param("id");
		try {
			restoreRoutineDefinition(id, c.req.param("digest"));
			const routine = getRoutine(id);
			if (routine) runner.schedule(routine);
			return c.json({ ok: true });
		} catch {
			return c.json(
				{ error: "conversion missing or definition/metadata changed; restore the protected backup offline" },
				409,
			);
		}
	});

	app.post("/routines", async c => {
		let body: CreateRoutineRequest & { specToml?: string };
		try {
			body = (await c.req.json()) as CreateRoutineRequest & { specToml?: string };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid request" }, 400);
		if (body.graph !== undefined) {
			if (!body.name) return c.json({ error: "name required" }, 400);
			if (
				body.specToml !== undefined ||
				body.cron !== undefined ||
				body.actionKind !== undefined ||
				body.actionBody !== undefined ||
				body.actionCwd !== undefined
			) {
				return c.json({ error: "native graph and legacy authoring fields are exclusive" }, 400);
			}
			const validation = runner.graphRegistry.validate(body.graph);
			if (!validation.valid) return c.json({ error: "invalid graph", details: validation.errors }, 400);
			if (webhookPathClaimed(graphWebhookPath(body.graph)))
				return c.json({ error: "webhook path already in use" }, 409);
			try {
				const routine = createGraphRoutine(
					{
						name: body.name,
						description: body.description,
						graph: body.graph,
						enabled: body.enabled,
					},
					runner.graphRegistry,
				);
				registerWebhookPath(graphWebhookPath(routine.graph), routine.id);
				runner.schedule(routine);
				return c.json(routine, 201);
			} catch (err) {
				return c.json({ error: String(err) }, 400);
			}
		}
		// V1 routine: presence of specToml is the discriminator.
		if (body.specToml) {
			try {
				const spec = parseToml(body.specToml) as unknown;
				const result = validateRoutineSpec(spec);
				if (!result.valid) {
					return c.json({ error: "invalid spec", details: result.errors }, 400);
				}
				const typed = spec as RoutineSpec;
				const routine = createV1Routine({
					name: body.name || typed.name,
					description: body.description ?? typed.description ?? "",
					specToml: body.specToml,
					spec: typed,
					enabled: body.enabled !== false,
				});
				registerWebhookTriggers(typed, routine.id);
				runner.schedule(routine);
				return c.json(routine, 201);
			} catch (err) {
				log.error("createV1Routine failed", err);
				return c.json({ error: String(err) }, 400);
			}
		}
		// V0 path (legacy single-action routine).
		if (!body.name || !body.cron || !body.actionKind || body.actionBody === undefined) {
			return c.json({ error: "name, cron, actionKind, actionBody required (or pass specToml for V1)" }, 400);
		}
		try {
			const routine = createRoutine({
				name: body.name,
				description: body.description,
				cron: body.cron,
				actionKind: body.actionKind,
				actionBody: body.actionBody,
				actionCwd: body.actionCwd,
				enabled: body.enabled,
			});
			runner.schedule(routine);
			return c.json(routine, 201);
		} catch (err) {
			log.error("createRoutine failed", err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.get("/routines/:id", c => {
		const r = getRoutine(c.req.param("id"));
		if (!r) return c.json({ error: "not found" }, 404);
		return c.json(r);
	});

	app.patch("/routines/:id", async c => {
		let body: UpdateRoutineRequest & { specToml?: string };
		try {
			body = (await c.req.json()) as UpdateRoutineRequest & { specToml?: string };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid request" }, 400);
		const id = c.req.param("id");
		const existing = getRoutine(id);
		if (!existing) return c.json({ error: "not found" }, 404);
		if (existing.specVersion === 2) {
			if (
				body.specToml !== undefined ||
				body.cron !== undefined ||
				body.actionKind !== undefined ||
				body.actionBody !== undefined ||
				body.actionCwd !== undefined
			) {
				return c.json({ error: "native graphs cannot be edited through legacy authoring fields" }, 400);
			}
			if (body.graph !== undefined) {
				const validation = runner.graphRegistry.validate(body.graph);
				if (!validation.valid) return c.json({ error: "invalid graph", details: validation.errors }, 400);
				if (webhookPathClaimed(graphWebhookPath(body.graph), id))
					return c.json({ error: "webhook path already in use" }, 409);
			}
			try {
				const updated = updateGraphRoutine(
					id,
					{
						name: body.name,
						description: body.description,
						graph: body.graph,
						enabled: body.enabled,
					},
					runner.graphRegistry,
				);
				if (!updated) return c.json({ error: "not found" }, 404);
				if (body.graph !== undefined) registerWebhookPath(graphWebhookPath(updated.graph), updated.id);
				runner.schedule(updated);
				return c.json(updated);
			} catch (err) {
				return c.json({ error: String(err) }, 400);
			}
		}
		if (body.graph !== undefined) return c.json({ error: "graph requires a native V2 routine" }, 400);
		// V1 routine: validate + persist spec_toml; allow enabled-only patches too.
		if (existing.specVersion === 1) {
			if (body.specToml !== undefined) {
				try {
					const spec = parseToml(body.specToml) as unknown;
					const result = validateRoutineSpec(spec);
					if (!result.valid) {
						return c.json({ error: "invalid spec", details: result.errors }, 400);
					}
					const typed = spec as RoutineSpec;
					const updated = updateV1Routine(id, {
						name: body.name,
						description: body.description,
						specToml: body.specToml,
						spec: typed,
						enabled: body.enabled,
					});
					if (!updated) return c.json({ error: "not found" }, 404);
					registerWebhookTriggers(typed, updated.id);
					runner.schedule(updated);
					return c.json(updated);
				} catch (err) {
					log.error("updateV1Routine failed", err);
					return c.json({ error: String(err) }, 400);
				}
			}
			// V1 routine but no spec change — patch name/description/enabled only.
			const updated = updateV1Routine(id, {
				name: body.name,
				description: body.description,
				enabled: body.enabled,
			});
			if (!updated) return c.json({ error: "not found" }, 404);
			runner.schedule(updated);
			return c.json(updated);
		}
		// V0 path.
		const updated = updateRoutine(id, body);
		if (!updated) return c.json({ error: "not found" }, 404);
		runner.schedule(updated);
		return c.json(updated);
	});

	app.delete("/routines/:id", c => {
		const id = c.req.param("id");
		if (id === DEFAULT_INBOX_TICKET_ROUTINE_ID)
			return c.json({ error: "The default inbox flow cannot be deleted. Disable it instead." }, 409);
		runner.unschedule(id);
		const ok = deleteRoutine(id);
		return c.json({ ok });
	});

	/** Simulations return a transient trace without admission, journal or domain writes. */
	app.post("/routines/:id/preview", async c => {
		const routine = getRoutine(c.req.param("id"));
		if (!routine) return c.json({ error: "not found" }, 404);
		if (routine.specVersion !== 2 || !routine.graph)
			return c.json({ error: "native graph required for write-free preview" }, 400);
		const validation = runner.graphRegistry.validate(routine.graph);
		if (!validation.valid) return c.json({ error: "invalid graph", details: validation.errors }, 400);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!isGraphValue(body) || !body || typeof body !== "object" || Array.isArray(body))
			return c.json({ error: "preview activation must be an object" }, 400);
		if (body.operationId !== undefined && (typeof body.operationId !== "string" || !body.operationId.trim()))
			return c.json({ error: "operationId must be a nonempty string" }, 400);
		const id = crypto.randomUUID(),
			startedAt = new Date().toISOString();
		const activation: GraphActivation = Object.keys(body).length
			? {
					...(body as unknown as GraphActivation),
					operationId: (body.operationId as string | undefined) ?? id,
				}
			: { eventType: "manual", event: { id }, operationId: id };
		const graph = structuredClone(routine.graph);
		graph.budget = {
			...graph.budget,
			max_duration_secs: Math.min(graph.budget?.max_duration_secs ?? 120, 120),
			max_steps_executed: Math.min(graph.budget?.max_steps_executed ?? 10_000, 10_000),
		};
		try {
			const result = await executeGraph(graph, activation, runner.graphRegistry, {
				runId: id,
				routineId: routine.id,
				dryRun: true,
				signal: AbortSignal.timeout(120_000),
			});
			const trace: GraphRunRecord = {
				...result,
				id,
				routineId: routine.id,
				startedAt,
				endedAt: new Date().toISOString(),
				graph,
				activation,
				dryRun: true,
			};
			return c.body(encodeGraphTrace(trace), 200, { "content-type": "application/json" });
		} catch (error) {
			return c.json(
				{ error: String(error), ...(error instanceof GraphValidationError ? { details: error.errors } : {}) },
				400,
			);
		}
	});

	app.post("/routines/:id/run", async c => {
		const id = c.req.param("id");
		const r = getRoutine(id);
		if (!r) return c.json({ error: "not found" }, 404);
		if (r.specImportError) return c.json({ error: r.specImportError }, 409);
		if (r.specVersion === 2) {
			const validation = runner.graphRegistry.validate(r.graph);
			if (!validation.valid) return c.json({ error: "invalid graph", details: validation.errors }, 400);
		}
		const dryRun = c.req.query("dryRun");
		const operationId = c.req.query("operationId");
		if (dryRun !== undefined && dryRun !== "true" && dryRun !== "false")
			return c.json({ error: "dryRun must be true or false" }, 400);
		if (operationId !== undefined && !operationId.trim())
			return c.json({ error: "operationId must be nonempty" }, 400);
		if (r.specVersion !== 2 && (dryRun !== undefined || operationId !== undefined))
			return c.json({ error: "graph execution options require a native routine" }, 400);
		let payload: Record<string, unknown> = {};
		try {
			const text = await c.req.text();
			if (text.trim().length > 0) {
				const parsed = JSON.parse(text);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					payload = parsed as Record<string, unknown>;
				}
			}
		} catch {
			// ignore — manual runs may be triggered with empty body
		}
		void runner
			.fire(id, "manual", payload, { dryRun: dryRun === "true", operationId })
			.catch(err => log.warn("manual fire failed", err));
		return c.json({ ok: true, queued: true }, 202);
	});

	app.get("/routines/:id/runs", c => {
		const id = c.req.param("id");
		const limit = Number(c.req.query("limit") ?? "20");
		const body: ListRoutineRunsResponse = { runs: listRuns(id, limit) };
		return c.json(body);
	});

	app.get("/routines/:id/runs/:runId", c => {
		const run = getRun(c.req.param("runId"));
		if (!run || run.routineId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
		return c.json(run);
	});

	app.get("/routines/:id/runs/:runId/steps", c => {
		const runId = c.req.param("runId");
		const body: ListRoutineStepRunsResponse = { steps: listStepRuns(runId) };
		return c.json(body);
	});

	app.get("/routines/:id/runs/:runId/graph", c => {
		const trace = getGraphRun(c.req.param("runId"));
		if (!trace || trace.routineId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
		return c.json(trace);
	});

	/**
	 * Generate (or rotate) the webhook secret for a routine's `webhook`
	 * trigger. Returns the plaintext secret ONCE; the deck keeps it to verify
	 * signatures and never returns it again. A rotated secret accepts only
	 * signed deliveries.
	 */
	app.post("/routines/:id/webhook-secret/rotate", c => {
		const id = c.req.param("id");
		const r = getRoutine(id);
		if (!r || (r.specVersion !== 1 && r.specVersion !== 2)) {
			return c.json({ error: "routine with webhook trigger required" }, 404);
		}
		let hookPath: string | undefined;
		if (r.specVersion === 2) {
			hookPath = graphWebhookPath(r.graph);
		} else {
			let spec: RoutineSpec;
			try {
				spec = parseToml(r.specToml ?? "") as unknown as RoutineSpec;
			} catch {
				return c.json({ error: "spec parse failure" }, 400);
			}
			if (!spec || !Array.isArray(spec.trigger)) return c.json({ error: "spec parse failure" }, 400);
			const declared = spec.trigger.find(trigger => "webhook" in trigger) as
				| { webhook: { path: string } }
				| undefined;
			hookPath = declared?.webhook.path;
		}
		if (!hookPath) return c.json({ error: "routine has no webhook trigger" }, 400);
		const secret = randomBytes(32).toString("base64url");
		const registered = upsertWebhookSecret({ routineId: id, path: hookPath, secret });
		if (!registered) return c.json({ error: "webhook path already in use" }, 409);
		return c.json({ ok: true, secret, path: hookPath });
	});

	app.get("/routines/:id/webhook", c => {
		const status = webhookStatus(c.req.param("id"));
		return status ? c.json(status) : c.json({ error: "routine has no webhook registration" }, 404);
	});

	/**
	 * `{ acceptBareSecret: false }` stops accepting the deprecated bare-secret
	 * signature. One-way: `true` is refused with 409 unless the registration
	 * still accepts it (its untouched pre-upgrade state), where it changes nothing.
	 */
	app.patch("/routines/:id/webhook", async c => {
		const id = c.req.param("id");
		let body: { acceptBareSecret?: unknown };
		try {
			body = (await c.req.json()) as { acceptBareSecret?: unknown };
		} catch {
			return c.json({ error: "invalid JSON" }, 400);
		}
		if (typeof body.acceptBareSecret !== "boolean") {
			return c.json({ error: "acceptBareSecret must be a boolean" }, 400);
		}
		const row = getWebhookSecretByRoutine(id);
		if (!row) return c.json({ error: "routine has no webhook registration" }, 404);
		if (body.acceptBareSecret) {
			if (row.accept_bare_secret !== 1) {
				return c.json({ error: "the bare secret cannot be accepted again; senders must sign deliveries" }, 409);
			}
		} else {
			refuseWebhookBareSecret(id);
		}
		return c.json(webhookStatus(id));
	});

	// ─── Templates ────────────────────────────────────────────────────────

	app.get("/routine-templates", c => {
		return c.json({ templates: listTemplates() });
	});

	app.post("/routine-templates/:slug", c => {
		const slug = c.req.param("slug");
		const loaded = loadTemplate(slug);
		if (!loaded) return c.json({ error: "template not found" }, 404);
		const validation = validateRoutineSpec(loaded.spec);
		if (!validation.valid) {
			return c.json({ error: "template spec is invalid", details: validation.errors }, 500);
		}
		const routine = createV1Routine({
			name: loaded.spec.name,
			description: loaded.spec.description ?? "",
			specToml: loaded.specToml,
			spec: loaded.spec,
			enabled: false,
		});
		registerWebhookTriggers(loaded.spec, routine.id);
		runner.schedule(routine);
		return c.json(routine, 201);
	});

	/**
	 * Metrics aggregation over the routine's run history. Surfaced on the
	 * routine card and the run detail header.
	 */
	app.get("/routines/:id/metrics", c => {
		const id = c.req.param("id");
		const r = getRoutine(id);
		if (!r) return c.json({ error: "not found" }, 404);
		const runs = listRuns(id, 100);
		const last30 = runs.slice(0, 30);
		const successCount = last30.filter(x => x.endedAt && !x.abortReason && x.exitCode === 0).length;
		const durations = last30
			.filter(x => x.startedAt && x.endedAt)
			.map(x => new Date(x.endedAt!).getTime() - new Date(x.startedAt).getTime())
			.sort((a, b) => a - b);
		const pick = (q: number): number | null => {
			if (durations.length === 0) return null;
			const idx = Math.min(durations.length - 1, Math.floor(durations.length * q));
			return durations[idx] ?? null;
		};
		const mtdStart = new Date(new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z").getTime();
		const mtdCostMicros = runs
			.filter(x => new Date(x.startedAt).getTime() >= mtdStart)
			.reduce((acc, x) => acc + (x.totalLlmCostMicros ?? 0), 0);
		const last30Summary = last30.map(x => {
			const status: "success" | "failed" | "aborted" | "running" = !x.endedAt
				? "running"
				: x.abortReason
					? "aborted"
					: x.exitCode === 0
						? "success"
						: "failed";
			return {
				runId: x.id,
				status,
				durationMs:
					x.startedAt && x.endedAt ? new Date(x.endedAt).getTime() - new Date(x.startedAt).getTime() : null,
			};
		});
		return c.json({
			total: runs.length,
			successCount,
			successRate30d: last30.length === 0 ? 0 : successCount / last30.length,
			p50DurationMs: pick(0.5),
			p95DurationMs: pick(0.95),
			mtdCostMicros,
			last30: last30Summary,
		});
	});

	return app;
}

function registerWebhookTriggers(spec: RoutineSpec, routineId: string): void {
	const webhookTrigger = spec.trigger.find(t => "webhook" in t) as { webhook: { path: string } } | undefined;
	registerWebhookPath(webhookTrigger?.webhook.path, routineId);
}

function registerWebhookPath(hookPath: string | undefined, routineId: string): void {
	// Saving a declaration may move a registration, but never replaces its credentials.
	if (!hookPath) {
		deleteWebhookSecret(routineId);
		return;
	}

	const registered = ensureWebhookSecret({
		routineId,
		path: hookPath,
		secret: randomBytes(32).toString("base64url"),
	});
	if (!registered) {
		log.warn(`webhook path ${hookPath} already in use; skipping registration for ${routineId}`);
	}
}

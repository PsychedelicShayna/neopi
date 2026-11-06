/**
 * Top-level routines runner. Dispatches by `routine.specVersion`:
 *   - V0 (specVersion=0): legacy single-action shell-out (bash/script/prompt)
 *   - V1 (specVersion=1): multi-step pipeline via runV1Pipeline()
 *   - V2 (specVersion=2): native typed graph via executeGraph()
 *
 * Also owns the Cron scheduler. For V0 routines, schedule from `routine.cron`.
 * For V1 routines, parse `spec.trigger` and schedule a Cron per cron-trigger
 * entry. Non-cron triggers (webhook, manual, event) sit passive and are
 * invoked from routes-hooks.ts / routes-routines.ts.
 * V2 schedules each generic event.source with an optional config.cron, selecting
 * that source explicitly and preserving its configured event type.
 */

import { Cron } from "croner";
import { parseSettingsToml as parseToml } from "@oh-my-pi/pi-utils/settings-toml";
import * as path from "node:path";

import { INBOX_CARD_ADDED_EVENT, type GraphActivation, type GraphExecutionResult, type GraphObject, type Routine, type RoutineGraph, type RoutineRun, type RoutineSpec, type RoutineTrigger } from "@npi-deck/protocol";

import { logger } from "./log.ts";
import {
	finishRun,
	finishGraphRun,
	getRoutine,
	listRoutines,
	setRoutineSchedule,
	startRun,
} from "./db/routines.ts";
import { ConcurrencyController } from "./routines/concurrency.ts";
import { runV1Pipeline } from "./routines/v1-runner.ts";
import { finalizeRun, insertAbortedRun } from "./db/routine-step-runs.ts";
import { loadConfig } from "./config.ts";
import { routineAgentCommand } from "./routines/agent-command.ts";
import { workRegistry } from "./work-registry.ts";
import { executeGraph, GraphNodeRegistry } from "./routines/graph-runner.ts";
import { admitInboxGraphEvent, discardInboxGraphEvent, inboxGraphEventsFor, pendingInboxGraphEvents, recoverInboxGraphEvents, subscribeInboxGraphEvents } from "./db/inbox-graph-events.ts";
import { registerGraphActions } from "./routines/graph-actions.ts";
import { registerGraphStepNodes } from "./routines/graph-step-nodes.ts";
import { runV0Action } from "./routines/v0-action.ts";
import { installDefaultInboxFlow, registerInboxFlowNodes } from "./inbox-flow.ts";
import { registerGraphV0Node } from "./routines/graph-v0-node.ts";

const log = logger("routines-runner");


interface ScheduledCron {
	cron: Cron;
	routineId: string;
}

/** Earliest upcoming fire across every cron of a routine, as persisted `nextRunAt`. */
function earliestNextRun(entries: readonly ScheduledCron[]): string | null {
	let earliest: Date | null = null;
	for (const { cron } of entries) {
		const next = cron.nextRun();
		if (next && (!earliest || next < earliest)) earliest = next;
	}
	return earliest?.toISOString() ?? null;
}

export class RoutinesRunner {
	private crons = new Map<string, ScheduledCron[]>();
	private disposed = false;
	private closing = false;
	private unsubscribeInbox?: () => void;
	private readonly runs = new Map<string, { abort: AbortController; finished: Promise<void> }>();
	readonly concurrency = new ConcurrencyController();
	readonly graphRegistry = new GraphNodeRegistry();
	constructor(private readonly agentCommand: () => string[] = () => routineAgentCommand([])) {
		registerGraphActions(this.graphRegistry);
		registerGraphStepNodes(this.graphRegistry);
		registerGraphV0Node(this.graphRegistry);
		registerInboxFlowNodes(this.graphRegistry);
	}
	get busy(): boolean { return this.runs.size > 0; }
	get workSnapshot(): Array<{ runId: string; routineId: string }> {
		return [...this.runs.keys()].map((key) => ({ routineId: key.split(":")[0]!, runId: key.split(":")[1]! }));
	}
	closeAdmissions(): void { this.closing = true; }

	start(): void {
		if (this.unsubscribeInbox || this.closing) return;
		installDefaultInboxFlow(this.graphRegistry);
		recoverInboxGraphEvents();
		this.unsubscribeInbox = subscribeInboxGraphEvents(() => this.dispatchInboxEvents());
		const routines = listRoutines();
		for (const r of routines) {
			if (r.enabled) this.schedule(r);
		}
		log.info(`scheduled ${routines.filter((r) => r.enabled).length} routine(s)`);
		this.dispatchInboxEvents();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.closeAdmissions();
		this.disposed = true;
		this.unsubscribeInbox?.();
		this.unsubscribeInbox = undefined;
		for (const entries of this.crons.values()) {
			for (const entry of entries) {
				try { entry.cron.stop(); } catch (err) { log.warn(`stop failed for routine ${entry.routineId}`, err); }
			}
		}
		this.crons.clear();
		for (const run of this.runs.values()) run.abort.abort();
		await Promise.allSettled([...this.runs.values()].map((run) => run.finished));
	}

	schedule(r: Routine): void {
		this.unschedule(r.id);
		const cronExprs = r.enabled ? collectCronExpressions(r) : [];
		if (cronExprs.length === 0) {
			setRoutineSchedule(r.id, { nextRunAt: null });
			return;
		}

		const scheduled: ScheduledCron[] = [];
		for (const { expression: expr, activation } of cronExprs) {
			try {
				const cron = new Cron(
					expr,
					{
						catch: true,
						protect: true,
						...(r.timezone ? { timezone: r.timezone } : {}),
					},
					() => {
						void (activation
							? this.fireGraphActivation(r.id, { ...activation, event: { firedAt: new Date().toISOString() } }, "cron")
							: this.fire(r.id, "cron")).catch((err) => log.warn(`cron fire failed`, err));
					},
				);
				scheduled.push({ cron, routineId: r.id });
			} catch (err) {
				log.warn(`failed to schedule cron '${expr}' for ${r.id}`, err);
			}
		}
		this.crons.set(r.id, scheduled);
		setRoutineSchedule(r.id, { nextRunAt: earliestNextRun(scheduled) });
	}

	unschedule(routineId: string): void {
		const existing = this.crons.get(routineId);
		if (!existing) return;
		for (const entry of existing) {
			try {
				entry.cron.stop();
			} catch (err) {
				log.warn(`stop failed for ${routineId}`, err);
			}
		}
		this.crons.delete(routineId);
	}

	/** Fire a routine. Branches on specVersion. */
	async fire(
		routineId: string,
		trigger: "cron" | "manual" | "webhook" | "event" = "manual",
		payload: Record<string, unknown> = {},
		options: { dryRun?: boolean; operationId?: string; sourceNodeId?: string } = {},
	): Promise<void> {
		if (this.closing) throw new Error("routine admissions closed");
		const routine = getRoutine(routineId);
		if (!routine) {
			log.warn(`fire: routine ${routineId} not found`);
			return;
		}
		if (!routine.enabled && (trigger === "cron" || trigger === "webhook" || trigger === "event")) return;

		if (routine.specVersion === 2) {
			const nativeTrigger = routine.graph?.execution?.mode === "routine-v0" && trigger !== "cron" && trigger !== "manual" ? "manual" : trigger;
			await this.fireGraph(routine, {
				eventType: nativeTrigger, event: payload as GraphObject,
				...(options.operationId ? { operationId: options.operationId } : {}),
				...(options.sourceNodeId ? { sourceNodeId: options.sourceNodeId } : {}),
			}, nativeTrigger, options);
		} else if (routine.specVersion === 1) {
			await this.fireV1(routine, trigger, payload);
		} else {
			await this.fireV0(routine, trigger === "cron" || trigger === "manual" ? trigger : "manual", payload);
		}

		const next = earliestNextRun(this.crons.get(routineId) ?? []);
		const now = new Date().toISOString();
		setRoutineSchedule(routineId, {
			lastRunAt: now,
			nextRunAt: next,
		});
	}

	/** Inbox notifications can replay; only a committed per-source delivery may start. */
	async fireGraphEvent(routineId: string, activation: GraphActivation, options: { dryRun?: boolean } = {}): Promise<void> {
		if (options.dryRun || activation.eventType !== INBOX_CARD_ADDED_EVENT) {
			await this.fireGraphActivation(routineId, activation, "event", options);
			return;
		}
		for (const delivery of inboxGraphEventsFor(routineId, activation)) {
			const routine = getRoutine(routineId);
			const source = routine?.graph?.nodes.find((node) => node.id === delivery.activation.sourceNodeId);
			if (!routine?.enabled || routine.specVersion !== 2 || !source
				|| this.graphRegistry.get(source.type)?.definition.kind !== "event"
				|| source.config.eventType !== INBOX_CARD_ADDED_EVENT) {
				discardInboxGraphEvent(routineId, delivery.activation);
				continue;
			}
			await this.fireGraphActivation(routineId, delivery.activation, "event", options);
		}
	}

	private dispatchInboxEvents(): void {
		if (this.closing) return;
		for (const delivery of pendingInboxGraphEvents()) {
			void this.fireGraphEvent(delivery.routineId, delivery.activation)
				.catch((err) => log.warn("inbox graph intake failed", err));
		}
	}

	private async fireGraphActivation(
		routineId: string,
		activation: GraphActivation,
		trigger: "cron" | "event",
		options: { dryRun?: boolean } = {},
	): Promise<void> {
		if (this.closing) throw new Error("routine admissions closed");
		const routine = getRoutine(routineId);
		if (!routine || routine.specVersion !== 2) throw new Error("native graph routine required");
		if (!routine.enabled) return;
		await this.fireGraph(routine, activation, trigger, options);
		setRoutineSchedule(routineId, {
			lastRunAt: new Date().toISOString(),
			nextRunAt: earliestNextRun(this.crons.get(routineId) ?? []),
		});
	}

	private async fireGraph(
		routine: Routine,
		activation: GraphActivation,
		trigger: "cron" | "manual" | "webhook" | "event",
		options: { dryRun?: boolean } = {},
	): Promise<void> {
		if (!routine.graph) throw new Error(`native routine ${routine.id} has no graph`);
		const graph = routine.graph;
		const validation = this.graphRegistry.validate(graph);
		if (!validation.valid) throw new Error(`invalid graph: ${JSON.stringify(validation.errors)}`);
		const definition = structuredClone(graph);
		// Simulations start their own trace, never a durable event-delivery claim.
		// Keep this return before live inbox admission when integrating #204.
		if (options.dryRun) {
			await this.executeGraphRun(routine, activation, definition, startRun(routine.id, trigger, activation.event), options);
			return;
		}
		const start = () => startRun(routine.id, trigger, activation.event);
		const run = trigger === "event" && activation.eventType === INBOX_CARD_ADDED_EVENT
			? admitInboxGraphEvent(routine.id, activation, definition, start) : start();
		if (!run) return;
		await this.executeGraphRun(routine, activation, definition, run, options);
	}

	private async executeGraphRun(
		routine: Routine,
		activation: GraphActivation,
		definition: RoutineGraph,
		run: RoutineRun,
		options: { dryRun?: boolean },
	): Promise<void> {
		const graph = routine.graph!;
		const activationSnapshot = structuredClone(activation);
		const decision = this.concurrency.decide(routine.id, run.id, graph.concurrency ?? "skip");
		const persist = (result: GraphExecutionResult, abortReason?: string) => finishGraphRun({
			...result, id: run.id, routineId: routine.id, startedAt: run.startedAt,
			endedAt: new Date().toISOString(), graph: definition, activation: activationSnapshot,
			dryRun: options.dryRun === true,
		}, abortReason);
		if (decision.kind === "skip") {
			persist({ status: "aborted", nodeRuns: [], outputs: [], error: "concurrency_skipped" }, "concurrency_skipped");
			return;
		}
		if (decision.kind === "cancel") decision.toCancel.abort();
		const key = `${routine.id}:${run.id}`;
		const releaseWork = workRegistry.admit(decision.kind === "queue" ? "routine-queued" : "routine-run", key);
		const finished = (async () => {
			try {
				if (decision.kind === "queue") await decision.release;
				if (decision.abort.signal.aborted) {
					persist({ status: "aborted", nodeRuns: [], outputs: [], abortReason: "cancelled", error: "cancelled" });
					return;
				}
				if (decision.kind === "queue") workRegistry.transition("routine-queued", "routine-run", key);
				const result = await executeGraph(graph, activation, this.graphRegistry, {
					runId: run.id, signal: decision.abort.signal, routineId: routine.id, dryRun: options.dryRun,
				});
				persist(result);
			} catch (err) {
				persist({
					status: decision.abort.signal.aborted ? "aborted" : "failed",
					nodeRuns: [], outputs: [], error: String(err),
				});
			} finally {
				this.concurrency.finish(routine.id, run.id);
			}
		})();
		this.runs.set(key, { abort: decision.abort, finished });
		try { await finished; } finally { this.runs.delete(key); releaseWork(); }
	}

	private async fireV0(routine: Routine, trigger: "cron" | "manual", payload: Record<string, unknown>): Promise<void> {
		if (!routine.actionKind || routine.actionBody === undefined) {
			log.warn(`V0 routine ${routine.id} missing action_kind/action_body`);
			return;
		}
		const run = startRun(routine.id, trigger, payload);
		const decision = this.concurrency.decide(routine.id, run.id, routine.concurrency);
		if (decision.kind === "skip") {
			finalizeRun(run.id, { endedAt: new Date().toISOString(), abortedAt: new Date().toISOString(), abortReason: "concurrency_skipped" });
			return;
		}
		if (decision.kind === "cancel") decision.toCancel.abort();
		const key = `${routine.id}:${run.id}`;
		const releaseWork = workRegistry.admit(decision.kind === "queue" ? "routine-queued" : "routine-run", key);
		const finished = (async () => {
			if (decision.kind === "queue") await decision.release;
			if (decision.abort.signal.aborted) {
				finalizeRun(run.id, { endedAt: new Date().toISOString(), abortedAt: new Date().toISOString(), abortReason: "cancelled" });
				return;
			}
			if (decision.kind === "queue") workRegistry.transition("routine-queued", "routine-run", key);
			const cwd = routine.actionCwd?.trim() || process.cwd();
			log.info(`firing V0 routine ${routine.name} (${routine.actionKind})`);
			try {
				const result = await runV0Action(routine.actionKind!, routine.actionBody!, cwd, decision.abort.signal);
				finishRun(run.id, result);
			} catch (err) {
				finishRun(run.id, { error: String(err) });
			} finally {
				this.concurrency.finish(routine.id, run.id);
			}
		})();
		this.runs.set(key, { abort: decision.abort, finished });
		try { await finished; } finally { this.runs.delete(key); releaseWork(); }
	}

	private async fireV1(
		routine: Routine,
		trigger: "cron" | "manual" | "webhook" | "event",
		payload: Record<string, unknown>,
	): Promise<void> {
		let spec: RoutineSpec;
		try {
			spec = parseToml(routine.specToml!) as unknown as RoutineSpec;
		} catch (err) {
			log.warn(`V1 routine ${routine.id} has malformed spec_toml`);
			insertAbortedRun({
				routineId: routine.id,
				triggerKind: trigger,
				triggerPayload: payload,
				abortReason: "failure",
				error: "spec_toml parse failure",
			});
			return;
		}

		const run = startRun(routine.id, trigger, payload);
		const decision = this.concurrency.decide(routine.id, run.id, routine.concurrency);
		if (decision.kind === "skip") {
			finalizeRun(run.id, {
				endedAt: new Date().toISOString(),
				abortedAt: new Date().toISOString(),
				abortReason: "concurrency_skipped",
				error: "skipped: another run is in flight",
			});
			return;
		}
		if (decision.kind === "cancel") {
			decision.toCancel.abort();
		}

		const key = `${routine.id}:${run.id}`;
		const releaseWork = workRegistry.admit(decision.kind === "queue" ? "routine-queued" : "routine-run", key);
		const finished = (async () => {
			if (decision.kind === "queue") await decision.release;
			if (decision.abort.signal.aborted) {
				finalizeRun(run.id, { endedAt: new Date().toISOString(), abortedAt: new Date().toISOString(), abortReason: "cancelled" });
				return;
			}
			if (decision.kind === "queue") workRegistry.transition("routine-queued", "routine-run", key);
			log.info(`firing V1 routine ${routine.name} (${spec.steps.length} steps, trigger=${trigger})`);
			const config = loadConfig();
			try {
				await runV1Pipeline({
					routine, spec, runId: run.id, triggerKind: trigger, triggerPayload: payload,
					abortSignal: decision.abort.signal, defaultCwd: config.defaultCwd,
					agentSandboxRoot: path.join(path.dirname(config.dbPath), "routine-runs"),
					agentCommand: this.agentCommand,
				});
			} catch (err) {
				log.error(`V1 pipeline threw for ${routine.id}`, err);
			} finally {
				this.concurrency.finish(routine.id, run.id);
			}
		})();
		this.runs.set(key, { abort: decision.abort, finished });
		try { await finished; } finally { this.runs.delete(key); releaseWork(); }
	}
}

/** V2 schedules native event sources only; legacy cron discovery remains unchanged. */
function collectCronExpressions(routine: Routine): Array<{ expression: string; activation?: GraphActivation }> {
	if (routine.specVersion === 2) {
		return (routine.graph?.nodes ?? [])
			.filter((node) => node.type === "event.source" && typeof node.config.cron === "string")
			.map((node) => ({
				expression: node.config.cron as string,
				activation: { eventType: node.config.eventType as string, sourceNodeId: node.id, event: {} },
			}));
	}
	if (routine.specVersion === 1 && routine.specToml) {
		try {
			const spec = parseToml(routine.specToml) as unknown as RoutineSpec;
			const out: Array<{ expression: string }> = [];
			for (const t of spec.trigger ?? []) {
				if ("cron" in t && typeof (t as { cron?: unknown }).cron === "string") {
					out.push({ expression: (t as RoutineTrigger & { cron: string }).cron });
				}
			}
			return out;
		} catch {
			return [];
		}
	}
	return routine.cron ? [{ expression: routine.cron }] : [];
}


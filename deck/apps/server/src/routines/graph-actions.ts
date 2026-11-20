import { isGraphValue, type GraphEffect, type GraphObject, type GraphValue } from "@npi-deck/protocol";
import { cardExecutionProperties, cardFrontmatter, importLegacyCardBody, withCardProperties } from "../card-properties.ts";
import { getDb } from "../db/index.ts";
import { getGraphEffect, GraphActionConflictError, graphDigest, redactGraphActionField, reserveGraphEffect, storeGraphEffect } from "../db/graph-actions.ts";
import { createTask, getDefaultState, getState, updateTask } from "../db/tasks.ts";
import { notificationService, validateNotificationPayload } from "../notifications/service.ts";
import { githubIssuesAdapter, validateGithubIssueRequest } from "./github-issues.ts";
import { findGraphOutput, readGraphPath, type GraphNodeContext, type GraphNodeRegistry } from "./graph-runner.ts";
import { reserveInboxFiling } from "../db/inbox-routing.ts";
import type { InboxItem } from "@npi-deck/protocol";

const inFlight = new Map<string, Promise<void>>();

function object(value: unknown, name: string): GraphObject {
	if (!isGraphValue(value) || value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
	return value;
}
function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
	return value;
}
function keys(value: GraphObject, supported: string[], name: string): void {
	for (const key of Object.keys(value)) if (!supported.includes(key)) throw new Error(`Unsupported ${name} property: ${key}`);
}
/** Explicit bindings address original envelopes, not string templates or branch booleans. */
export function resolveGraphActionValue(value: GraphValue, context: GraphNodeContext): GraphValue {
	if (Array.isArray(value)) return value.map(item => resolveGraphActionValue(item, context));
	if (value === null || typeof value !== "object") return value;
	if (Object.hasOwn(value, "$from")) {
		keys(value, ["$from"], "binding");
		const binding = object(value.$from, "$from");
		keys(binding, ["nodeId", "port", "inputPort", "path"], "binding");
		if (!Array.isArray(binding.path) || !binding.path.every(key => typeof key === "string" || (typeof key === "number" && Number.isInteger(key) && key >= 0))) throw new Error("Binding path must be an array of string/nonnegative integer keys");
		if (binding.nodeId !== undefined) text(binding.nodeId, "binding.nodeId");
		if (binding.port !== undefined) text(binding.port, "binding.port");
		if (binding.inputPort !== undefined) text(binding.inputPort, "binding.inputPort");
		for (const input of context.inputs) {
			if (binding.inputPort !== undefined && binding.inputPort !== input.port) continue;
			const output = binding.nodeId === undefined ? input.output : findGraphOutput(input.output, binding.nodeId as string, binding.port as string | undefined);
			if (!output || (binding.nodeId === undefined && binding.port !== undefined && binding.port !== output.port)) continue;
			const resolved = readGraphPath(output, binding.path as (string | number)[]);
			if (resolved !== undefined) return resolved;
		}
		throw new Error("Action binding did not resolve an upstream value");
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveGraphActionValue(item, context)]));
}
function identity(context: GraphNodeContext): string {
	const activation = context.rootActivation ?? context.activation;
	const explicit = context.node.config.operationId === undefined ? activation.operationId : resolveGraphActionValue(context.node.config.operationId, context);
	const event = Array.isArray(activation.event) ? undefined : activation.event;
	const card = event?.card;
	const originalId = explicit ?? event?.id ?? (card && typeof card === "object" && !Array.isArray(card) ? card.id : undefined);
	// One captured item owns one logical issue write, across flows, node edits and replay.
	if (context.node.type === "action.file-issue" && ["inbox.card_added", "inbox.file"].includes(activation.eventType)) {
		return graphDigest({ eventType: "inbox.file", operation: text(event?.id, "original inbox id") });
	}
	return graphDigest({ routine: text(context.routineId, "routineId"), node: context.node.id, eventType: activation.eventType, operation: text(originalId, "event.id or operationId"), ...(context.iteration?.length ? { iteration: context.iteration } : {}) });
}
function effectValue(effect: GraphEffect): GraphObject {
	// Downstream bindings see the same privacy-safe receipt before and after replay.
	const receipt = effect.receipt ? JSON.parse(JSON.stringify(effect.receipt, redactGraphActionField)) as GraphObject : undefined;
	return { status: effect.status, logicalKey: effect.logicalKey, replayed: effect.replayed, ...(receipt ? { receipt } : {}), ...(effect.status === "planned" ? { destination: effect.destination, request: effect.request } : {}) };
}
function certainty(error: unknown): GraphEffect["status"] {
	if (error && typeof error === "object") {
		const value = "certainty" in error ? error.certainty : "outcome" in error ? error.outcome : undefined;
		if (value === "rejected" || value === "not-dispatched") return value;
	}
	return "uncertain";
}
function update(context: GraphNodeContext, effect: GraphEffect): void {
	storeGraphEffect(effect);
	context.recordEffect(effect);
}
interface CardRequest { title: string; body: string; stateId: string; cwd?: string | null; properties?: GraphObject; orderInState?: number; archived?: boolean }
function cardRequest(value: GraphObject): CardRequest {
	keys(value, ["title", "body", "stateId", "cwd", "properties", "orderInState", "archived"], "card");
	const title = text(value.title, "title");
	if (value.body !== undefined && typeof value.body !== "string") throw new Error("body must be a string");
	if (value.cwd !== undefined && value.cwd !== null && typeof value.cwd !== "string") throw new Error("cwd must be a string or null");
	if (value.orderInState !== undefined && (typeof value.orderInState !== "number" || !Number.isSafeInteger(value.orderInState))) throw new Error("orderInState must be a safe integer");
	if (value.archived !== undefined && typeof value.archived !== "boolean") throw new Error("archived must be boolean");
	const properties = value.properties === undefined ? undefined : object(value.properties, "properties");
	const body = value.body as string | undefined ?? "";
	cardExecutionProperties(withCardProperties(importLegacyCardBody(body), properties));
	const stateId = value.stateId === undefined ? getDefaultState().id : text(value.stateId, "stateId");
	if (!getState(stateId)) throw new Error("Unknown card stateId");
	return { title, body, stateId, ...(properties !== undefined ? { properties } : {}), ...(value.cwd !== undefined ? { cwd: value.cwd as string | null } : {}), ...(value.orderInState !== undefined ? { orderInState: value.orderInState as number } : {}), ...(value.archived !== undefined ? { archived: value.archived as boolean } : {}) };
}
function persistedCard(request: CardRequest): GraphObject {
	const card = createTask(request);
	const persisted = updateTask(card.id, { ...(request.orderInState !== undefined ? { orderInState: request.orderInState } : {}), ...(request.archived !== undefined ? { archived: request.archived } : {}) })!;
	return object({ ...persisted, properties: cardFrontmatter(persisted.body).properties }, "persisted card");
}

export function registerGraphActions(registry: GraphNodeRegistry): void {
	for (const [type, label] of [["action.create-card", "Create card"], ["action.send-message", "Send message"], ["action.file-issue", "File GitHub issue"]] as const) registry.register({
		definition: {
			type, label, kind: "action", inputs: [{ id: "in", type: "object", multiple: true }], outputs: [{ id: "result", type: "object" }],
			configSchema: { type: "object", required: ["request"], properties: { request: { type: "object" }, operationId: {} }, additionalProperties: false },
		},
		execute: async (context) => {
			context.signal.throwIfAborted();
			const request = object(resolveGraphActionValue(context.node.config.request!, context), "action request");
			const logicalKey = identity(context);
			let destination: GraphObject;
			let normalized: GraphObject;
			let create: (() => GraphObject) | undefined;
			let send: (() => Promise<GraphObject>) | undefined;
			let reconcile: (() => Promise<GraphObject | undefined>) | undefined;
			let preflight: (() => GraphObject | undefined) | undefined;
			if (type === "action.create-card") {
				const card = cardRequest(request);
				normalized = object(card, "card request"); destination = { stateId: card.stateId };
				create = () => persistedCard(card);
			} else if (type === "action.send-message") {
				keys(request, ["destination", "payload"], "message");
				const channel = text(request.destination, "destination");
				const payload = validateNotificationPayload(request.payload);
				preflight = () => {
					const result = notificationService.preflight(channel, payload);
					return result.status === "ready" ? undefined : object(result, "message preflight");
				};
				normalized = request; destination = { channel };
				send = async () => {
					const result = await notificationService.deliver(channel, payload, context.signal);
					if (result.status !== "accepted" && result.status !== "dispatched") throw Object.assign(new Error(`Message was not dispatched: ${result.status}`), { certainty: "not-dispatched" });
					return object(result, "message receipt");
				};
			} else {
				keys(request, ["host", "owner", "repo", "title", "body", "labels", "assignees", "milestone", "attribution"], "issue");
				const issue = validateGithubIssueRequest({ ...request, operationId: logicalKey });
				const original = (context.rootActivation ?? context.activation).event;
				if (!context.dryRun && !Array.isArray(original) && (context.rootActivation ?? context.activation).eventType === "inbox.card_added") {
					if (original.kind !== "ticket") throw new Error("Only original inbox tickets can file automatically.");
					const snapshot = reserveInboxFiling(original as unknown as InboxItem, { kind: "issue", repo: `${issue.host}/${issue.owner}/${issue.repo}` });
					if (snapshot.title !== issue.title || snapshot.body !== issue.body) throw new Error("Inbox filing conflicts with the original reserved title or body.");
				}
				normalized = object(issue, "issue request"); destination = { host: issue.host, owner: issue.owner, repo: issue.repo };
				send = async () => object(await githubIssuesAdapter.create(issue, context.signal), "issue receipt");
				reconcile = async () => {
					const result = await githubIssuesAdapter.reconcile({ host: issue.host, owner: issue.owner, repo: issue.repo, operationId: logicalKey }, context.signal);
					return result.status === "found" ? object(result.receipt, "issue receipt") : undefined;
				};
			}
			const effect: GraphEffect = { logicalKey, status: context.dryRun ? "planned" : "uncertain", destination, request: normalized, replayed: false };
			// Existing reservations are immutable evidence, not new delivery attempts.
			const unavailable = preflight && (context.dryRun || !getGraphEffect(logicalKey)) ? preflight() : undefined;
			if (unavailable) {
				effect.status = "not-dispatched"; effect.receipt = unavailable; context.recordEffect(effect);
				throw new Error(`Message destination unavailable: ${unavailable.status}`);
			}
			if (context.dryRun) { context.recordEffect(effect); return [{ port: "result", value: effectValue(effect) }]; }
			context.signal.throwIfAborted();
			const fingerprint = graphDigest({ type, destination, request: normalized });
			if (create) {
				let result: GraphEffect;
				try {
					result = getDb().transaction(() => {
						const reservation = reserveGraphEffect(effect, fingerprint);
						if (!reservation.owned) return { ...reservation.effect, replayed: true };
						effect.receipt = create!(); effect.status = "confirmed"; storeGraphEffect(effect); return effect;
					}).immediate();
				} catch (error) {
					delete effect.receipt;
					effect.status = error instanceof GraphActionConflictError ? "rejected" : "not-dispatched";
					context.recordEffect(effect);
					throw error;
				}
				context.recordEffect(result);
				if (result.status !== "confirmed") throw new Error(`Prior card action is ${result.status}`);
				return [{ port: "result", value: effectValue(result) }];
			}
			let reservation: { owned: boolean; effect: GraphEffect };
			try { reservation = reserveGraphEffect(effect, fingerprint); }
			catch (error) {
				effect.status = error instanceof GraphActionConflictError ? "rejected" : "not-dispatched";
				context.recordEffect(effect);
				throw error;
			}
			if (!reservation.owned) {
				await inFlight.get(logicalKey);
				const prior = { ...(getGraphEffect(logicalKey) ?? reservation.effect), replayed: true };
				context.recordEffect(prior);
				if (prior.status === "uncertain" && reconcile) {
					const receipt = await reconcile();
					if (receipt) { prior.receipt = receipt; prior.status = "confirmed"; update(context, prior); }
				}
				if (prior.status !== "confirmed") throw new Error(`Prior action is ${prior.status}; not retried because provider acceptance is unresolved`);
				return [{ port: "result", value: effectValue(prior) }];
			}
			context.recordEffect(effect);
			try {
				context.signal.throwIfAborted();
			} catch (error) { effect.status = "not-dispatched"; update(context, effect); throw error; }
			const settlement = (async () => {
				try {
					effect.receipt = await send!(); effect.status = "confirmed";
				} catch (error) {
					effect.status = certainty(error);
					if (error && typeof error === "object" && "receipt" in error && isGraphValue(error.receipt) && error.receipt !== null && typeof error.receipt === "object" && !Array.isArray(error.receipt)) effect.receipt = error.receipt;
				}
				update(context, effect);
			})();
			inFlight.set(logicalKey, settlement);
			try { await settlement; } finally { inFlight.delete(logicalKey); }
			if (effect.status !== "confirmed") throw new Error(`Action ${effect.status}; inspect its durable effect receipt`);
			return [{ port: "result", value: effectValue(effect) }];
		},
	});
}

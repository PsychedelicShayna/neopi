import { compilePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import { type } from "@oh-my-pi/omptype";

import type { SessionEntry } from "../session/session-entries";
import type { ReadonlySessionManager } from "../session/session-manager";
import blockTemplate from "./block.md" with { type: "text" };

export const CONTRACT_ENTRY = "work-contract";
export const contractRequestSchema = type({
	action: "'list' | 'show' | 'set' | 'edit' | 'enable' | 'disable' | 'remove' | 'promote' | 'policy'",
	"id?": "string",
	"text?": "string",
	"scope?": "'user' | 'project'",
	"allowed?": "boolean",
});
export type ContractRequest = typeof contractRequestSchema.infer;

export interface ContractProvenance {
	actor: "user" | "agent";
	at: string;
	turnId: string | null;
	toolCallId?: string;
}
export interface WorkContract {
	id: string;
	text: string;
	active: boolean;
	history: ContractProvenance[];
	promotions: string[];
}
export interface ContractState {
	clauses: Map<string, WorkContract>;
	agentAllowed: boolean;
}
export interface ContractEvent {
	version: 1;
	request: ContractRequest;
	provenance: ContractProvenance;
	promotedPath?: string;
}

export function requireContractId(id: string | undefined): string {
	if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
		throw new Error(
			"Contract id must be 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.",
		);
	}
	return id;
}

export function applyContractEvent(state: ContractState, event: ContractEvent): void {
	const { request, provenance } = event;
	if (request.action === "policy") {
		if (provenance.actor !== "user" || request.allowed === undefined) {
			throw new Error("Only the user may change contract agent policy.");
		}
		state.agentAllowed = request.allowed;
		return;
	}
	if (provenance.actor === "agent" && !state.agentAllowed) throw new Error("Contract agent policy is off.");
	const id = requireContractId(request.id);
	const current = state.clauses.get(id);
	if (request.action === "set" || request.action === "edit") {
		if (request.action === "edit" && !current) throw new Error(`No contract named ${id}.`);
		if (!request.text?.trim()) throw new Error("Contract text must not be empty.");
		state.clauses.set(id, {
			id,
			text: request.text.trim(),
			active: current?.active ?? true,
			history: [...(current?.history ?? []), provenance],
			promotions: [...(current?.promotions ?? [])],
		});
		return;
	}
	if (!current) throw new Error(`No contract named ${id}.`);
	if (request.action === "remove") {
		state.clauses.delete(id);
		return;
	}
	if (request.action === "promote") {
		if (provenance.actor !== "user")
			throw new Error("Rule promotion requires an explicit /contract promote command.");
		if (!event.promotedPath) throw new Error("Missing promoted rule path.");
		current.promotions.push(event.promotedPath);
	} else if (request.action === "enable" || request.action === "disable") {
		current.active = request.action === "enable";
	} else {
		throw new Error(`Cannot persist contract action ${request.action}.`);
	}
	current.history.push(provenance);
}

/** Replay session-wide mutations, independently of compacted messages or tree navigation. */
export function readContracts(manager: Pick<ReadonlySessionManager, "getEntries">): ContractState {
	const state: ContractState = { clauses: new Map(), agentAllowed: false };
	for (const entry of manager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== CONTRACT_ENTRY) continue;
		const event = entry.data as ContractEvent | undefined;
		if (event?.version !== 1 || !event.provenance || !contractRequestSchema.allows(event.request)) {
			throw new Error("Invalid persisted session contract. Refusing to silently omit it.");
		}
		applyContractEvent(state, event);
	}
	return state;
}

export function contractTurnId(entries: readonly SessionEntry[]): string | null {
	return entries.findLast(entry => entry.type === "message" && entry.message.role === "user")?.id ?? null;
}

export function renderContractBlock(state: ContractState): string | undefined {
	const clauses = [...state.clauses.values()]
		.filter(clause => clause.active)
		.sort((a, b) => a.id.localeCompare(b.id, "en"));
	if (clauses.length === 0) return undefined;
	return compilePromptAsset("work-contracts/block.md", blockTemplate)({ clauses });
}

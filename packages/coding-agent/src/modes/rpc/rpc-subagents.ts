import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { type AgentRef, AgentRegistry } from "../../registry/agent-registry";
import { registerPersistedSubagents, sessionFileBelongsToRoot } from "../../registry/persisted-agents";
import { selectSubagentModel } from "../../registry/subagent-controls";
import { getLiveSubagentFacts } from "../../registry/subagent-facts";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionHandle } from "../../session/agent-session-handle";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import { type AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import {
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import type {
	RpcSetSubagentModelResult,
	RpcSubagentHistoryEntry,
	RpcSubagentHistoryResult,
	RpcSubagentEventFrame,
	RpcSubagentFrame,
	RpcSubagentMessagesResult,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

export interface RpcSubagentTranscriptSelector {
	subagentId?: string;
	sessionFile?: string;
	fromByte?: number;
}

type RpcSubagentOutput = (frame: RpcSubagentFrame) => void;

const MAX_RETAINED_TRANSCRIPT_REFERENCES = 256;

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): AgentProgress["status"] {
	return status === "started" ? "running" : status;
}

function isTerminalLifecycleStatus(status: SubagentLifecyclePayload["status"]): boolean {
	return status !== "started";
}

function hasSameOwner(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "parentToolCallId" | "sessionFile">,
	snapshot: RpcSubagentSnapshot,
): boolean {
	if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

export async function readRpcSubagentTranscript(sessionFile: string, fromByte = 0): Promise<RpcSubagentMessagesResult> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	const file = Bun.file(sessionFile);
	let size: number;
	try {
		({ size } = await fs.stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return {
			sessionFile,
			fromByte: startByte,
			nextByte: startByte,
			reset: false,
			entries: [],
			messages: [],
		};
	}
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}

	const text = startByte >= size ? "" : await file.slice(startByte).text();
	const lastNewline = text.lastIndexOf("\n");
	const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
	const entries = completeText.length > 0 ? parseSessionEntries(completeText) : [];
	const nextByte = startByte + Buffer.byteLength(completeText, "utf8");

	return {
		sessionFile,
		fromByte: startByte,
		nextByte,
		reset,
		entries,
		messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
	};
}

export class RpcSubagentRegistry {
	#subagents = new Map<string, RpcSubagentSnapshot>();
	#transcriptSessionFilesBySubagentId = new Map<string, string>();
	#staleSubagentIds = new Set<string>();
	#unsubscribers: Array<() => void> = [];
	#eventUnsubscribe: (() => void) | undefined;
	#observabilityBus: EventBus | undefined;
	#output: RpcSubagentOutput;
	#subscriptionLevel: RpcSubagentSubscriptionLevel = "off";

	constructor(observabilityBus: EventBus, output: RpcSubagentOutput) {
		this.#observabilityBus = observabilityBus;
		this.#output = output;
		this.#unsubscribers.push(
			observabilityBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				this.handleLifecycle(data as SubagentLifecyclePayload);
			}),
			observabilityBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				this.handleProgress(data as SubagentProgressPayload);
			}),
		);
	}

	dispose(): void {
		this.#eventUnsubscribe?.();
		this.#eventUnsubscribe = undefined;
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#observabilityBus = undefined;
		this.#subagents.clear();
		this.#transcriptSessionFilesBySubagentId.clear();
		this.#staleSubagentIds.clear();
	}

	clear(): void {
		for (const subagentId of this.#subagents.keys()) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		for (const subagentId of this.#transcriptSessionFilesBySubagentId.keys()) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		this.#subagents.clear();
		this.#transcriptSessionFilesBySubagentId.clear();
	}

	setSubscriptionLevel(level: RpcSubagentSubscriptionLevel): void {
		const observabilityBus = this.#observabilityBus;
		if (level === "events" && !this.#eventUnsubscribe && observabilityBus) {
			this.#eventUnsubscribe = observabilityBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				this.handleEvent(data as SubagentEventPayload);
			});
		} else if (level !== "events" && this.#eventUnsubscribe) {
			this.#eventUnsubscribe();
			this.#eventUnsubscribe = undefined;
		}
		this.#subscriptionLevel = level;
	}

	getSubscriptionLevel(): RpcSubagentSubscriptionLevel {
		return this.#subscriptionLevel;
	}

	getSubagents(): RpcSubagentSnapshot[] {
		return [...this.#subagents.values()]
			.map(snapshot => {
				const owned = resolveLiveSnapshot(snapshot);
				const retainedFacts = snapshot.progress
					? {
							resolvedModel: snapshot.progress.resolvedModel,
							resolvedModelIdentity: snapshot.progress.resolvedModelIdentity,
							resolvedThinkingLevel: snapshot.progress.resolvedThinkingLevel,
						}
					: undefined;
				const facts = (owned ? getLiveSubagentFacts(owned.session) : undefined) ?? retainedFacts;
				return {
					...snapshot,
					...facts,
					...(owned && snapshot.progress ? { progress: { ...snapshot.progress, ...facts } } : {}),
				};
			})
			.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
	}

	#rememberTranscriptSession(subagentId: string, sessionFile: string | undefined): void {
		if (!sessionFile) return;
		this.#transcriptSessionFilesBySubagentId.delete(subagentId);
		this.#transcriptSessionFilesBySubagentId.set(subagentId, sessionFile);
		while (this.#transcriptSessionFilesBySubagentId.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
			const oldest = this.#transcriptSessionFilesBySubagentId.keys().next();
			if (oldest.done) break;
			this.#transcriptSessionFilesBySubagentId.delete(oldest.value);
		}
	}

	#hasTranscriptSessionFile(sessionFile: string): boolean {
		for (const snapshot of this.#subagents.values()) {
			if (snapshot.sessionFile === sessionFile) return true;
		}
		for (const transcriptSessionFile of this.#transcriptSessionFilesBySubagentId.values()) {
			if (transcriptSessionFile === sessionFile) return true;
		}
		return false;
	}

	handleLifecycle(payload: SubagentLifecyclePayload): void {
		const existing = this.#subagents.get(payload.id);
		if (existing && !hasSameOwner(payload, existing)) return;
		if (!existing && payload.status !== "started") return;
		if (payload.status === "started") {
			this.#staleSubagentIds.delete(payload.id);
		}
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		const snapshot: RpcSubagentSnapshot = {
			id: payload.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: payload.description ?? existing?.description,
			status: statusFromLifecycle(payload.status),
			task: existing?.task,
			assignment: existing?.assignment,
			sessionFile,
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			lastUpdate: Date.now(),
			progress: existing?.progress,
		};
		this.#rememberTranscriptSession(payload.id, sessionFile);
		if (isTerminalLifecycleStatus(payload.status)) {
			this.#subagents.delete(payload.id);
		} else {
			this.#subagents.set(payload.id, snapshot);
		}
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_lifecycle", payload });
		}
	}

	handleProgress(payload: SubagentProgressPayload): void {
		const progress = payload.progress;
		if (this.#staleSubagentIds.has(progress.id)) return;
		const existing = this.#subagents.get(progress.id);
		if (!existing) return;
		if (!hasSameOwner(payload, existing)) return;
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		this.#rememberTranscriptSession(progress.id, sessionFile);
		this.#subagents.set(progress.id, {
			id: progress.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: progress.description ?? existing?.description,
			status: progress.status,
			task: payload.task,
			assignment: payload.assignment,
			sessionFile,
			lastUpdate: Date.now(),
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			progress,
		});
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_progress", payload });
		}
	}

	handleEvent(payload: SubagentEventPayload): void {
		if (this.#staleSubagentIds.has(payload.id)) return;
		if (this.#subscriptionLevel !== "events") return;
		this.#output({ type: "subagent_event", payload } satisfies RpcSubagentEventFrame);
	}

	resolveSessionFile(selector: RpcSubagentTranscriptSelector): string {
		if (selector.subagentId) {
			const snapshot = this.#subagents.get(selector.subagentId);
			const sessionFile = snapshot?.sessionFile ?? this.#transcriptSessionFilesBySubagentId.get(selector.subagentId);
			if (!sessionFile) {
				throw new Error(`Unknown subagent or session file unavailable: ${selector.subagentId}`);
			}
			return sessionFile;
		}

		if (selector.sessionFile) {
			if (this.#hasTranscriptSessionFile(selector.sessionFile)) return selector.sessionFile;
			throw new Error("Unknown subagent session file");
		}

		throw new Error("get_subagent_messages requires subagentId or sessionFile");
	}
}

/**
 * The registry surface an RPC command handler drives. A control host serves each
 * connection a view over one shared registry, with its own subscription level.
 */
export type RpcSubagentBus = Pick<
	RpcSubagentRegistry,
	"clear" | "getSubagents" | "getSubscriptionLevel" | "resolveSessionFile" | "setSubscriptionLevel"
>;

/** A running subagent from this session's roster, bound to its live registry ref. */
export interface RpcOwnedSubagent {
	ref: AgentRef;
	session: AgentSessionHandle;
}

/**
 * Resolve a `get_subagents` id to its running, live registry ref, or
 * `undefined` when the host must not reach it (unknown, finished, accepted,
 * parked, aborted, or another session's agent).
 *
 * Agent ids are unique only within one parent session's artifacts scope, and
 * the process-global registry keeps the latest ref per id, so the ref must
 * carry the transcript file this session's roster recorded
 * (`<artifactsDir>/<id>.jsonl`). The ref must also still be `running`: it goes
 * `idle` once the parent accepts its result, before the terminal lifecycle
 * frame prunes the roster, and a running ref always holds a live session.
 */
export function resolveOwnedLiveSubagent(
	subagentRegistry: Pick<RpcSubagentRegistry, "getSubagents">,
	subagentId: string,
): RpcOwnedSubagent | undefined {
	const snapshot = subagentRegistry.getSubagents().find(candidate => candidate.id === subagentId);
	return snapshot ? resolveLiveSnapshot(snapshot) : undefined;
}

function resolveLiveSnapshot(snapshot: RpcSubagentSnapshot): RpcOwnedSubagent | undefined {
	// Progress may become terminal before the lifecycle frame prunes the roster.
	if ((snapshot.status !== "running" && snapshot.status !== "pending") || !snapshot.sessionFile) return undefined;
	const ref = AgentRegistry.global().get(snapshot.id);
	if (ref?.kind !== "sub" || ref.status !== "running" || !ref.session || ref.sessionFile !== snapshot.sessionFile) {
		return undefined;
	}
	return { ref, session: ref.session };
}

export type RpcSetSubagentModelOutcome = { ok: true; data: RpcSetSubagentModelResult } | { ok: false; message: string };

/**
 * `set_subagent_model`: the focused `/switch` for one owned running subagent. A `selector`
 * (`provider/id`, fuzzy id, `@role`, `:level` suffix) resolves like `/switch <selector>` against the
 * child's own registry and scope; `provider` + `modelId` name one catalog model exactly. The change is
 * session-only and applies from the child's next request; the parent, siblings and settings are untouched.
 */
export async function handleRpcSetSubagentModel(
	subagentRegistry: Pick<RpcSubagentRegistry, "getSubagents">,
	command: { subagentId: string; selector?: string; provider?: string; modelId?: string },
): Promise<RpcSetSubagentModelOutcome> {
	const owned = resolveOwnedLiveSubagent(subagentRegistry, command.subagentId);
	if (!owned) return { ok: false, message: `Subagent not running: ${command.subagentId}` };
	try {
		return await selectSubagentModel(owned.session, command);
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}

/** The session surface the roster needs: its transcript (whose artifacts tree holds its children) and agent id. */
type RpcRosterSession = Pick<AgentSession, "sessionFile" | "getAgentId">;

/**
 * Hydrate the root session's persisted children into the process registry, as the Agent Hub does, so
 * finished, parked and aborted children survive a restart in the roster. Idempotent: already registered
 * transcripts are left alone and unchanged ones are not reread.
 */
async function hydrateRoster(session: RpcRosterSession): Promise<string | undefined> {
	const root = session.sessionFile;
	if (!root?.endsWith(".jsonl")) return undefined;
	await registerPersistedSubagents(AgentRegistry.global(), root, { rootAgentId: session.getAgentId() });
	return root;
}

/** Every child of the root session's tree, live or persisted: the Agent Hub roster over RPC. */
export async function listRpcSubagentHistory(
	session: RpcRosterSession,
	bus: Pick<RpcSubagentRegistry, "getSubagents"> | undefined,
	options: { includeAdvisors?: boolean } = {},
): Promise<RpcSubagentHistoryResult> {
	const root = await hydrateRoster(session);
	if (!root) return { subagents: [] };
	const toolCallIds = new Map<string, string>();
	for (const snapshot of bus?.getSubagents() ?? []) {
		if (snapshot.parentToolCallId && snapshot.sessionFile)
			toolCallIds.set(snapshot.sessionFile, snapshot.parentToolCallId);
	}
	const subagents: RpcSubagentHistoryEntry[] = [];
	for (const ref of AgentRegistry.global().list()) {
		if (ref.kind !== "sub" && !(options.includeAdvisors && ref.kind === "advisor")) continue;
		if (!ref.sessionFile || ref.sessionFile === root || !sessionFileBelongsToRoot(ref.sessionFile, root)) continue;
		if (ref.status === "running" && ref.kind === "sub" && ref.session === null) continue;
		const live = ref.session ? getLiveSubagentFacts(ref.session) : undefined;
		const history = ref.history;
		const metrics = history?.metrics;
		const parentToolCallId = toolCallIds.get(ref.sessionFile);
		subagents.push({
			id: ref.id,
			kind: ref.kind === "advisor" ? "advisor" : "sub",
			...(ref.parentId !== undefined ? { parentId: ref.parentId } : {}),
			displayName: ref.displayName,
			...(history?.agent !== undefined ? { agent: history.agent } : {}),
			...(ref.activity !== undefined ? { description: ref.activity } : {}),
			status: ref.status,
			live: ref.session !== null,
			sessionFile: ref.sessionFile,
			createdAt: ref.createdAt,
			lastActivity: ref.lastActivity,
			...(ref.lifecycle?.responseAt !== undefined ? { responseAt: ref.lifecycle.responseAt } : {}),
			...(ref.lifecycle?.acceptedAt !== undefined ? { acceptedAt: ref.lifecycle.acceptedAt } : {}),
			...(ref.lifecycle?.terminalAt !== undefined ? { terminalAt: ref.lifecycle.terminalAt } : {}),
			...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
			...((live?.resolvedModel ?? history?.resolvedModel)
				? { resolvedModel: live?.resolvedModel ?? history?.resolvedModel }
				: {}),
			...(live?.resolvedModelIdentity !== undefined ? { resolvedModelIdentity: live.resolvedModelIdentity } : {}),
			...(live?.resolvedThinkingLevel !== undefined ? { resolvedThinkingLevel: live.resolvedThinkingLevel } : {}),
			...(live ? { fastModeEnabled: live.fastModeEnabled, fastModeActive: live.fastModeActive } : {}),
			...(history?.modelRole !== undefined ? { modelRole: history.modelRole } : {}),
			...(history?.readOnly !== undefined ? { readOnly: history.readOnly } : {}),
			...(metrics
				? {
						metrics: {
							tokens: metrics.tokens,
							requests: metrics.requests,
							tools: metrics.tools,
							cost: metrics.cost,
							durationMs: metrics.durationMs,
							...(metrics.contextTokens !== undefined ? { contextTokens: metrics.contextTokens } : {}),
							...(metrics.contextWindow !== undefined ? { contextWindow: metrics.contextWindow } : {}),
						},
					}
				: {}),
			...(history?.directCost !== undefined ? { directCost: history.directCost } : {}),
			...(history?.outputPath !== undefined ? { outputPath: history.outputPath } : {}),
			...(history?.patchPath !== undefined ? { patchPath: history.patchPath } : {}),
			...(history?.branchName !== undefined ? { branchName: history.branchName } : {}),
		});
	}
	subagents.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	return { rootSessionFile: root, ...(session.getAgentId() ? { rootAgentId: session.getAgentId() } : {}), subagents };
}

/**
 * The transcript of a persisted child of the root session's tree, by `subagentId` or `sessionFile`, so
 * `get_subagent_messages` reads children the live roster no longer holds. Only files inside the root's
 * artifacts tree resolve; `undefined` otherwise.
 */
export async function resolvePersistedSubagentFile(
	session: RpcRosterSession,
	selector: RpcSubagentTranscriptSelector,
): Promise<string | undefined> {
	const root = await hydrateRoster(session);
	if (!root) return undefined;
	let file: string | undefined;
	if (selector.subagentId) file = AgentRegistry.global().get(selector.subagentId)?.sessionFile ?? undefined;
	else if (selector.sessionFile) file = path.resolve(selector.sessionFile);
	if (!file || !file.endsWith(".jsonl") || file === root || !sessionFileBelongsToRoot(file, root)) return undefined;
	return file;
}

/**
 * Agent monitor service behind the control socket's monitor connections (#345).
 *
 * An attach pane (`npi monitor attach`) renders one agent through the shared
 * Agent Hub transcript viewer. It authenticates with a capability the owner
 * minted for exactly that agent, never with the publication token, so its
 * connection can only: subscribe to the agent's status and live (unpersisted)
 * output, read its persisted transcript in bounded slices, and, for a subagent,
 * send it a message with the Agent Hub's rules. It never sees the primary
 * session, slash commands, kill, revive, or keystroke routes.
 *
 * Every request re-checks the grant against the registry: the exact ref
 * generation it was minted for, its kind, the owning root, and the host's
 * session generation. Chat re-checks again after an asynchronous revival.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { TranscriptLiveState, TranscriptLiveTool } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import type { ToolResultFrame } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRef, AgentRegistryApi, AgentStatus, RegistryEvent } from "../registry/agent-registry";
import { liveAdvisorAgent } from "../registry/live-advisors";
import type { AgentSession } from "../session/agent-session";
import { isAgentViewSession } from "../session/agent-session-handle";
import { readTranscriptSlice, type TranscriptSlice } from "../session/transcript-slice";

type MonitoredKind = "sub" | "advisor";
type LiveAssistant = NonNullable<TranscriptLiveState["assistant"]>;

/** One agent as an attach pane sees it. */
export interface MonitorAgentSnapshot {
	id: string;
	displayName: string;
	kind: MonitoredKind;
	parentId?: string;
	status: AgentStatus;
	/** Whether the owner has a transcript file for this agent yet. */
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
	activity?: string;
	model?: string;
}

/** What a monitor connection may do; minted by the owner for one exact agent ref. */
export interface MonitorGrant {
	readonly agentId: string;
	readonly ref: AgentRef;
	readonly kind: MonitoredKind;
	readonly root: AgentRef;
	/** Host session generation at mint time; a replaced root session invalidates the grant. */
	readonly hostGeneration: number;
	/** Subagents only: advisors are view-only, exactly as in the Agent Hub. */
	readonly canChat: boolean;
	revoked: boolean;
}

/** The capability string handed to a pane, and what it allows. */
export interface MonitorGrantInfo {
	capability: string;
	agentId: string;
	kind: MonitoredKind;
	canChat: boolean;
}

/** Connection surface the service pushes frames through. */
export interface MonitorConnection {
	write(frame: object): void;
	close(reason?: string): void;
	/** Bytes queued on the socket but not yet flushed to the peer. */
	readonly bufferedBytes: number;
}

export class MonitorRequestError extends Error {
	constructor(
		readonly code: "unknown_agent" | "read_only" | "invalid_value" | "monitor_gone",
		message: string,
	) {
		super(message);
		this.name = "MonitorRequestError";
	}
}

/**
 * Per-read transcript cap. Panes re-request from `newSize` until they reach the
 * end, so a normal reply stays small and many panes catching up at once stay
 * well inside the host's spool budget.
 */
export const MONITOR_TRANSCRIPT_READ_CAP = 256 * 1024;
/**
 * Largest single transcript entry a reply carries whole (the collab host's
 * per-reply cap). Monitor connections speak protocol v2, so the reply is
 * chunked; JSON escaping plus base64 chunking stays under the 16 MiB
 * per-connection spool even with a full live frame queued beside it.
 */
export const MONITOR_TRANSCRIPT_ENTRY_CAP = 4 * 1024 * 1024;
/** Live frames coalesce to at most one per interval per connection (latest state wins). */
export const MONITOR_LIVE_INTERVAL_MS = 80;
/** Unflushed socket bytes above which live pushes wait instead of queueing more. */
export const MONITOR_LIVE_BACKPRESSURE_BYTES = 256 * 1024;
/** Serialized live-state ceiling; larger states drop tool progress, then the assistant preview. */
export const MONITOR_LIVE_MAX_CHARS = 2 * 1024 * 1024;
/** Outstanding grants per host; minting prunes invalid ones first. */
const MAX_GRANTS = 256;
const MAX_CHAT_CHARS = 32 * 1024;
/** How often a stream re-checks its grant and live source (revival, advisor rebuild, root switch). */
const STREAM_CHECK_MS = 1_000;

function isMonitored(ref: AgentRef): ref is AgentRef & { kind: MonitoredKind } {
	return ref.kind === "sub" || ref.kind === "advisor";
}

function snapshotOf(ref: AgentRef & { kind: MonitoredKind }): MonitorAgentSnapshot {
	return {
		id: ref.id,
		displayName: ref.displayName,
		kind: ref.kind,
		...(ref.parentId ? { parentId: ref.parentId } : {}),
		status: ref.status,
		hasSessionFile: Boolean(ref.sessionFile),
		createdAt: ref.createdAt,
		lastActivity: ref.lastActivity,
		...(ref.activity ? { activity: ref.activity } : {}),
		...(ref.history?.resolvedModel ? { model: ref.history.resolvedModel } : {}),
	};
}

function capabilityKey(capability: string): string {
	return createHash("sha256").update(capability).digest("hex");
}

function assistantOf(message: unknown): LiveAssistant | undefined {
	return isRecord(message) && message.role === "assistant" ? (message as unknown as LiveAssistant) : undefined;
}

function toolFrameOf(value: unknown): ToolResultFrame | undefined {
	if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
	return {
		content: value.content as ToolResultFrame["content"],
		...(value.details !== undefined ? { details: value.details } : {}),
		...(value.isError === true ? { isError: true } : {}),
	};
}

/** Where an agent's in-flight output comes from: a subagent's session or an advisor's agent. */
interface LiveSource {
	readonly identity: object;
	subscribe(listener: (event: AgentEvent) => void): () => void;
	streamMessage(): LiveAssistant | undefined;
	activeTools(): TranscriptLiveTool[];
	/** Persistence commands also flush a worker's watched view before their reply. */
	settle?(): Promise<void>;
}

function liveSourceFor(registry: AgentRegistryApi, ref: AgentRef): LiveSource | undefined {
	if (ref.kind === "sub") {
		const session = ref.session;
		if (!session || !isAgentViewSession(session)) return undefined;
		return {
			identity: session,
			// Session events are a superset of agent events; the stream reads only the agent ones.
			subscribe: listener => session.subscribe(event => listener(event as AgentEvent)),
			streamMessage: () => assistantOf(session.agent.state.streamMessage),
			settle: () => session.settleInFlightMessagePersistence(),
			activeTools: () =>
				session.activeToolExecutionUpdates().map(update => ({
					toolCallId: update.toolCallId,
					toolName: update.toolName,
					args: update.args,
					partialResult: toolFrameOf(update.partialResult),
				})),
		};
	}
	if (ref.kind === "advisor") {
		const agent = liveAdvisorAgent(registry, ref.id);
		if (!agent) return undefined;
		return {
			identity: agent,
			subscribe: listener => agent.subscribe(listener),
			streamMessage: () => assistantOf(agent.state.streamMessage),
			activeTools: () => [],
		};
	}
	return undefined;
}

export interface MonitorServiceOptions {
	session: AgentSession;
	registry: AgentRegistryApi;
	/** The host's current session generation (bumps on new/switch/branch of the root session). */
	generation: () => number;
	lifecycle?: () => Pick<AgentLifecycleManager, "ensureLive">;
}

export class ControlMonitorService {
	readonly #options: MonitorServiceOptions;
	readonly #grants = new Map<string, MonitorGrant>();
	readonly #streams = new Map<MonitorConnection, MonitorStream>();
	readonly #connections = new Map<MonitorConnection, MonitorGrant>();
	readonly #unsubscribeRegistry: () => void;

	constructor(options: MonitorServiceOptions) {
		this.#options = options;
		this.#unsubscribeRegistry = options.registry.onChange(event => {
			if (event.type === "registered" || event.type === "removed") this.recheck();
		});
	}

	get registry(): AgentRegistryApi {
		return this.#options.registry;
	}

	/** The owning root ref, or undefined while this host's session is not registered. */
	#root(): AgentRef | undefined {
		return this.#options.registry.rootForSession(this.#options.session);
	}

	/** Subagents and advisors of this host's root tree (strict: an unresolvable parent chain is excluded). */
	targets(): Array<AgentRef & { kind: MonitoredKind }> {
		const root = this.#root();
		if (!root) return [];
		const registry = this.#options.registry;
		return registry
			.list()
			.filter(isMonitored)
			.filter(ref => registry.rootOf(ref.id) === root)
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	/** Mint a capability for one agent of this root. Throws when the agent is not monitorable here. */
	grant(agentId: string): MonitorGrantInfo {
		const registry = this.#options.registry;
		const root = this.#root();
		const ref = registry.get(agentId);
		if (!root || !ref || !isMonitored(ref) || registry.rootOf(agentId) !== root) {
			throw new MonitorRequestError("unknown_agent", `unknown agent ${agentId}`);
		}
		this.#pruneGrants();
		// `npi monitor attach --agent` mints a grant per run and nothing revokes it when the pane
		// exits: at the cap, the oldest grant with no open connection makes room.
		if (this.#grants.size >= MAX_GRANTS) this.#evictIdleGrant();
		if (this.#grants.size >= MAX_GRANTS) {
			throw new MonitorRequestError("invalid_value", `too many monitor grants (${MAX_GRANTS})`);
		}
		const capability = randomBytes(32).toString("hex");
		const grant: MonitorGrant = {
			agentId,
			ref,
			kind: ref.kind,
			root,
			hostGeneration: this.#options.generation(),
			canChat: ref.kind === "sub",
			revoked: false,
		};
		this.#grants.set(capabilityKey(capability), grant);
		return { capability, agentId, kind: grant.kind, canChat: grant.canChat };
	}

	/** The grant a presented capability names, if it is still valid. */
	authenticate(capability: string): MonitorGrant | undefined {
		const grant = this.#grants.get(capabilityKey(capability));
		if (!grant) return undefined;
		try {
			this.check(grant);
			return grant;
		} catch {
			return undefined;
		}
	}

	/** Revoke a capability; open connections using it are told why and closed. */
	revoke(capability: string): void {
		const key = capabilityKey(capability);
		const grant = this.#grants.get(key);
		if (!grant) return;
		this.#grants.delete(key);
		this.#invalidate(grant, "monitor access was revoked");
	}

	/**
	 * Re-check a grant against the registry and host. Throws `monitor_gone` once
	 * the grant no longer names the agent generation it was minted for.
	 */
	check(grant: MonitorGrant): AgentRef & { kind: MonitoredKind } {
		const gone = (reason: string): never => {
			grant.revoked = true;
			throw new MonitorRequestError("monitor_gone", reason);
		};
		if (grant.revoked) gone("monitor access was revoked");
		if (this.#options.generation() !== grant.hostGeneration) gone("the owner session was replaced");
		const registry = this.#options.registry;
		const ref = registry.get(grant.agentId);
		if (!ref) return gone(`${grant.agentId} was removed`);
		if (ref !== grant.ref || ref.kind !== grant.kind || !isMonitored(ref))
			return gone(`${grant.agentId} was replaced`);
		const root = this.#root();
		if (!root || root !== grant.root || registry.rootOf(grant.agentId) !== root) {
			return gone(`${grant.agentId} belongs to another session`);
		}
		return ref;
	}

	/** Track authenticated connections even before their first subscription. */
	attach(connection: MonitorConnection, grant: MonitorGrant): void {
		this.check(grant);
		this.#connections.set(connection, grant);
	}

	/** Invalidate grants immediately when their registry tree or host generation changes. */
	recheck(): void {
		for (const grant of this.#grants.values()) {
			try {
				this.check(grant);
			} catch (error) {
				this.#invalidate(grant, error instanceof Error ? error.message : String(error));
			}
		}
	}

	/** Handle one command from a monitor connection; returns the reply payload. */
	async handle(
		connection: MonitorConnection,
		grant: MonitorGrant,
		frame: Record<string, unknown>,
	): Promise<{ success: boolean; data?: unknown; error?: string; code?: string }> {
		const type = String(frame.type ?? "");
		try {
			this.attach(connection, grant);
			switch (type) {
				case "monitor_subscribe": {
					const ref = this.check(grant);
					this.#streams.get(connection)?.stop();
					const stream = new MonitorStream(this, connection, grant);
					this.#streams.set(connection, stream);
					const live = stream.start();
					const session = this.#options.session;
					return {
						success: true,
						data: {
							agent: snapshotOf(ref),
							canChat: grant.canChat,
							owner: { title: session.sessionName ?? null, cwd: session.sessionManager.getCwd() },
							live,
						},
					};
				}
				case "monitor_transcript":
					return { success: true, data: await this.#transcript(grant, Number(frame.fromByte ?? 0)) };
				case "monitor_chat":
					await this.#chat(connection, grant, String(frame.text ?? ""));
					return { success: true, data: { delivered: true } };
				default:
					return {
						success: false,
						error: "monitor connections may only subscribe, read the transcript, and chat",
						code: "monitor_only",
					};
			}
		} catch (error) {
			if (error instanceof MonitorRequestError) {
				if (error.code === "monitor_gone") this.#invalidate(grant, error.message);
				return { success: false, error: error.message, code: error.code };
			}
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Stop a connection's stream (connection closed). */
	detach(connection: MonitorConnection): void {
		this.#connections.delete(connection);
		this.#streams.get(connection)?.stop();
		this.#streams.delete(connection);
	}

	dispose(): void {
		this.#unsubscribeRegistry();
		for (const stream of this.#streams.values()) stream.stop();
		this.#streams.clear();
		for (const grant of this.#grants.values()) grant.revoked = true;
		this.#grants.clear();
		this.#connections.clear();
	}

	/** Tell every stream on `grant` why it ended, then close those connections. */
	#invalidate(grant: MonitorGrant, reason: string): void {
		grant.revoked = true;
		for (const [connection, current] of this.#connections) {
			if (current !== grant) continue;
			this.detach(connection);
			connection.write({ type: "monitor_gone", agentId: grant.agentId, reason });
			connection.close("monitor_gone");
		}
	}

	/** Called by a stream whose periodic check failed. */
	streamGone(grant: MonitorGrant, reason: string): void {
		this.#invalidate(grant, reason);
	}

	#pruneGrants(): void {
		for (const [key, grant] of this.#grants) {
			try {
				this.check(grant);
			} catch {
				this.#grants.delete(key);
			}
		}
	}

	/** Revoke the oldest grant no connection is using (grants keep insertion order). */
	#evictIdleGrant(): void {
		const inUse = new Set(this.#connections.values());
		for (const [key, grant] of this.#grants) {
			if (inUse.has(grant)) continue;
			this.#grants.delete(key);
			grant.revoked = true;
			return;
		}
	}

	async #transcript(grant: MonitorGrant, fromByte: number): Promise<TranscriptSlice> {
		const ref = this.check(grant);
		const start = Number.isSafeInteger(fromByte) && fromByte > 0 ? fromByte : 0;
		// A new agent has no file yet: an empty slice keeps the pane polling instead of
		// reporting the terminal error the viewer would stop on.
		if (!ref.sessionFile) return { text: "", newSize: 0 };
		try {
			const slice = await readTranscriptSlice(
				ref.sessionFile,
				start,
				MONITOR_TRANSCRIPT_READ_CAP,
				MONITOR_TRANSCRIPT_ENTRY_CAP,
			);
			this.check(grant);
			return slice;
		} catch (error) {
			this.check(grant);
			if (isEnoent(error)) return { text: "", newSize: 0 };
			throw error;
		}
	}

	/**
	 * Agent Hub chat rules (`AgentTranscriptViewer` submit, collab host `chat`):
	 * subagents only, never aborted ones; revive a parked agent, steer a busy
	 * one, prompt an idle one. The grant is re-checked after the revival await.
	 */
	async #chat(connection: MonitorConnection, grant: MonitorGrant, text: string): Promise<void> {
		const ref = this.check(grant);
		if (!grant.canChat || ref.kind !== "sub") {
			throw new MonitorRequestError("read_only", `${grant.agentId} is a read-only advisor transcript`);
		}
		if (ref.status === "aborted") throw new MonitorRequestError("read_only", `${grant.agentId} was aborted`);
		const trimmed = text.trim();
		if (!trimmed) throw new MonitorRequestError("invalid_value", "empty message");
		if (trimmed.length > MAX_CHAT_CHARS) {
			throw new MonitorRequestError("invalid_value", `message exceeds ${MAX_CHAT_CHARS} characters`);
		}
		const lifecycle = this.#options.lifecycle ?? (() => AgentLifecycleManager.global());
		const session = await lifecycle().ensureLive(grant.agentId);
		const after = this.check(grant);
		if (after.status === "aborted") throw new MonitorRequestError("read_only", `${grant.agentId} was aborted`);
		if (after.session !== session) {
			throw new MonitorRequestError("monitor_gone", `${grant.agentId} changed while it was being revived`);
		}
		// The reply confirms delivery; the turn itself runs on in the owner.
		session.prompt(trimmed, { streamingBehavior: "steer" }).catch((error: unknown) => {
			logger.warn("monitor: chat prompt failed", { agentId: grant.agentId, error: String(error) });
			connection.write({
				type: "monitor_notice",
				agentId: grant.agentId,
				text: error instanceof Error ? error.message : String(error),
			});
		});
	}
}

/** One connection's subscription: status pushes plus coalesced, bounded live state. */
class MonitorStream {
	readonly grant: MonitorGrant;
	readonly #service: ControlMonitorService;
	readonly #connection: MonitorConnection;
	#source: LiveSource | undefined;
	#unsubscribeSource: (() => void) | undefined;
	#unsubscribeRegistry: (() => void) | undefined;
	#assistant: LiveAssistant | undefined;
	readonly #tools = new Map<string, TranscriptLiveTool>();
	#pushTimer: Timer | undefined;
	#checkTimer: Timer | undefined;
	#seq = 0;
	#lastAgent = "";
	#stopped = false;

	constructor(service: ControlMonitorService, connection: MonitorConnection, grant: MonitorGrant) {
		this.#service = service;
		this.#connection = connection;
		this.grant = grant;
	}

	/** Attach to the live source and return the initial live state. */
	start(): TranscriptLiveState {
		this.#unsubscribeRegistry = this.#service.registry.onChange(event => this.#onRegistry(event));
		this.#checkTimer = setInterval(() => this.#recheck(), STREAM_CHECK_MS);
		this.#checkTimer.unref?.();
		const ref = this.#service.check(this.grant);
		this.#lastAgent = JSON.stringify(snapshotOf(ref));
		this.#attachSource(ref);
		return this.#boundedState().state;
	}

	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#unsubscribeSource?.();
		this.#unsubscribeSource = undefined;
		this.#unsubscribeRegistry?.();
		this.#unsubscribeRegistry = undefined;
		clearTimeout(this.#pushTimer);
		clearInterval(this.#checkTimer);
	}

	#onRegistry(event: RegistryEvent): void {
		if (this.#stopped || event.ref.id !== this.grant.agentId) return;
		this.#recheck();
	}

	/** Validate the grant, push status changes, and follow a revived session or rebuilt advisor. */
	#recheck(): void {
		if (this.#stopped) return;
		let ref: AgentRef & { kind: MonitoredKind };
		try {
			ref = this.#service.check(this.grant);
		} catch (error) {
			this.#service.streamGone(this.grant, error instanceof Error ? error.message : String(error));
			return;
		}
		const agent = JSON.stringify(snapshotOf(ref));
		if (agent !== this.#lastAgent) {
			this.#lastAgent = agent;
			this.#connection.write({ type: "monitor_agent", agent: snapshotOf(ref) });
		}
		const source = liveSourceFor(this.#service.registry, ref);
		if (source?.identity !== this.#source?.identity) {
			this.#attachSource(ref);
			this.#schedule();
		}
	}

	#attachSource(ref: AgentRef): void {
		this.#unsubscribeSource?.();
		this.#unsubscribeSource = undefined;
		this.#tools.clear();
		this.#assistant = undefined;
		const source = liveSourceFor(this.#service.registry, ref);
		this.#source = source;
		if (!source) return;
		let snapshotPending = source.settle !== undefined;
		const changedTools = new Set<string>();
		let toolsReset = false;
		this.#unsubscribeSource = source.subscribe(event => {
			if (snapshotPending) {
				switch (event.type) {
					case "tool_execution_start":
					case "tool_execution_update":
					case "tool_execution_end":
						changedTools.add(event.toolCallId);
						break;
					case "agent_end":
						toolsReset = true;
						break;
				}
			}
			this.#onEvent(event);
		});
		this.#assistant = source.streamMessage();
		for (const tool of source.activeTools()) {
			if (!changedTools.has(tool.toolCallId)) this.#tools.set(tool.toolCallId, tool);
		}
		if (source.settle) {
			// Watch is sent first; the home flushes its initial view before this
			// command replies. No later tool event is needed to recover mid-tool state.
			void source.settle().then(
				() => {
					snapshotPending = false;
					if (this.#stopped || this.#source !== source) return;
					// The snapshot contains updates, not every running tool. Preserve
					// starts/updates/ends already observed while hydration was pending.
					for (const id of this.#tools.keys()) {
						if (!changedTools.has(id)) this.#tools.delete(id);
					}
					if (!toolsReset) {
						for (const tool of source.activeTools()) {
							if (!changedTools.has(tool.toolCallId)) this.#tools.set(tool.toolCallId, tool);
						}
					}
					changedTools.clear();
					this.#schedule();
				},
				error => {
					snapshotPending = false;
					changedTools.clear();
					if (this.#stopped || this.#source !== source) return;
					logger.warn("Monitor live snapshot synchronization failed", { agentId: ref.id, error: String(error) });
				},
			);
		}
	}

	#onEvent(event: AgentEvent): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
			case "message_end": {
				// A finished message stays as the preview until the next one starts: the
				// pane drops it once the persisted entry with the same timestamp lands.
				const assistant = assistantOf(event.message);
				if (!assistant) return;
				this.#assistant = assistant;
				break;
			}
			case "tool_execution_start":
				this.#tools.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				break;
			case "tool_execution_update":
				this.#tools.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					partialResult: toolFrameOf(event.partialResult),
				});
				break;
			case "tool_execution_end":
				this.#tools.delete(event.toolCallId);
				break;
			case "agent_end":
				this.#tools.clear();
				break;
			default:
				return;
		}
		this.#schedule();
	}

	#state(): TranscriptLiveState {
		return { ...(this.#assistant ? { assistant: this.#assistant } : {}), tools: [...this.#tools.values()] };
	}

	#boundedState(): { state: TranscriptLiveState; omitted?: "tool_progress" | "assistant" } {
		let state = this.#state();
		if (JSON.stringify(state).length <= MONITOR_LIVE_MAX_CHARS) return { state };
		state = { ...state, tools: state.tools.map(({ partialResult: _partial, ...tool }) => tool) };
		if (JSON.stringify(state).length <= MONITOR_LIVE_MAX_CHARS) return { state, omitted: "tool_progress" };
		state = { tools: state.tools };
		if (JSON.stringify(state).length > MONITOR_LIVE_MAX_CHARS) state = { tools: [] };
		return { state, omitted: "assistant" };
	}

	#schedule(): void {
		if (this.#stopped || this.#pushTimer) return;
		this.#pushTimer = setTimeout(() => this.#flush(), MONITOR_LIVE_INTERVAL_MS);
		this.#pushTimer.unref?.();
	}

	/** Push the latest state, or wait while the peer has not drained earlier frames. */
	#flush(): void {
		this.#pushTimer = undefined;
		if (this.#stopped) return;
		try {
			this.#service.check(this.grant);
		} catch (error) {
			this.#service.streamGone(this.grant, error instanceof Error ? error.message : String(error));
			return;
		}
		if (this.#connection.bufferedBytes > MONITOR_LIVE_BACKPRESSURE_BYTES) {
			this.#schedule();
			return;
		}
		const { state, omitted } = this.#boundedState();
		this.#connection.write({
			type: "monitor_live",
			agentId: this.grant.agentId,
			seq: ++this.#seq,
			state,
			...(omitted ? { omitted } : {}),
		});
	}
}

/** True for a pushed frame that belongs to the monitor protocol. */
export function isMonitorFrame(frame: unknown): frame is Record<string, unknown> & { type: string } {
	return isRecord(frame) && typeof frame.type === "string" && frame.type.startsWith("monitor_");
}

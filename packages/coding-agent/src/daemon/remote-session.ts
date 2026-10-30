/**
 * RemoteAgentSession: the session surface a renderer needs, served over a
 * daemon-attached rpc-ui connection instead of an in-process AgentSession.
 *
 * This is the path to running InteractiveMode against a hosted session. It
 * covers the members rpc-ui already serves: state, the event stream,
 * prompting/steering/abort, models, thinking, naming, compaction, messages and
 * the tools in flight. InteractiveMode reaches far more of AgentSession than
 * this (178 distinct members, plus sessionManager/settings/modelRegistry/agent);
 * the remainder is listed in the PR and lands as rpc-ui commands, not as a
 * second protocol.
 *
 * Attach cut (exactly once): rpc-ui writes events and responses to one ordered
 * stream, so a `message_end` seen before the `get_messages` response is already
 * in that response and one seen after it is not. Frames that arrive while
 * history loads are held; when it lands, lifecycle frames of messages and
 * tools that completed before the cut are dropped, the in-flight ones are
 * replayed to the first subscriber, and everything after the cut is live.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { InteractiveSessionViewer } from "../modes/interactive-session-viewer";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { buildSessionContext, type SessionContext, type TranscriptSessionContextOptions } from "../session/session-context";
import type { SessionEntry } from "../session/session-entries";
import type { SessionJournalIdentity } from "../session/session-journal-events";

type Frame = Record<string, unknown>;

/** What the session needs from the daemon connection; `SessionDaemonClient` satisfies it. */
export interface RemoteTransport {
	/** `onResponse` must run synchronously at the response, before any later frame reaches `onFrame`. */
	request(frame: Frame, onResponse?: (data: unknown) => void): Promise<unknown>;
	send(frame: Frame): void;
	onFrame(listener: (frame: Frame) => void): () => void;
	detach(): Promise<void>;
}

/** The subset of rpc-ui's `get_state` a renderer reads. */
export interface RemoteSessionState {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	isStreaming: boolean;
	model?: { provider: string; id: string };
	thinkingLevel?: AgentSession["thinkingLevel"];
	[key: string]: unknown;
}

/** A tool call the session has started and not yet finished. */
export interface RemoteToolExecution {
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult?: unknown;
}

/** rpc-ui stamps each message lifecycle frame with the id it minted for that message. */
type Lifecycle = AgentSessionEvent & { messageId?: string };

const MESSAGE_LIFECYCLE = new Set(["message_start", "message_update", "message_end"]);
const TOOL_LIFECYCLE = new Set(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);

export class RemoteAgentSession implements InteractiveSessionViewer {
	readonly #client: RemoteTransport;
	readonly #attachedSessionId: string;
	readonly #listeners = new Set<(event: Lifecycle) => void>();
	readonly sessionManager: InteractiveSessionViewer["sessionManager"];
	#state: RemoteSessionState | undefined;
	#identity: SessionJournalIdentity | undefined;
	#leafId: string | null | undefined;
	#entries: SessionEntry[] = [];
	#entryIndex = new Map<string, SessionEntry>();
	#entriesGeneration = 0;
	#messages: AgentMessage[] = [];
	#streamMessage: AgentMessage | undefined;
	#streamMessageId: string | undefined;
	readonly #toolUpdates = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_update" }>>();
	readonly #tools = new Map<string, RemoteToolExecution>();
	/** Frames seen before history landed (`undefined` once the cut is made). */
	#beforeCut: Frame[] | undefined = [];
	/** Frames nobody has consumed yet; flushed to the first subscriber. */
	#replay: Frame[] = [];
	readonly #unsubscribe: () => void;

	private constructor(client: RemoteTransport, sessionId: string, cwd: string) {
		this.#client = client;
		this.#attachedSessionId = sessionId;
		this.sessionManager = {
			getEntries: () => [...this.#entries],
			getCwd: () => cwd,
			getSessionId: () => this.sessionId,
			getSessionFile: () => this.sessionFile,
		};
		this.#unsubscribe = client.onFrame(frame => this.#onFrame(frame));
	}

	/** Attach `client` to `sessionId` and load state and history after the snapshot cut. */
	static async attach(client: RemoteTransport, sessionId: string, cwd: string): Promise<RemoteAgentSession> {
		const session = new RemoteAgentSession(client, sessionId, cwd);
		try {
			// daemon.attach already requests the native ordered journal snapshot, including live tools.
			await client.request({ type: "daemon.attach", sessionId });
			await Promise.all([session.refreshState(), session.#loadMessages(), session.#loadEntries()]);
			return session;
		} catch (error) {
			session.#unsubscribe();
			throw error;
		}
	}

	get sessionId(): string {
		return this.#identity?.sessionId ?? this.#state?.sessionId ?? this.#attachedSessionId;
	}
	get sessionFile(): string | undefined {
		return this.#identity ? (this.#identity.sessionFile ?? undefined) : this.#state?.sessionFile;
	}
	get sessionName(): string | undefined {
		return this.#state?.sessionName;
	}
	get isStreaming(): boolean {
		return this.#state?.isStreaming ?? false;
	}
	get thinkingLevel(): AgentSession["thinkingLevel"] {
		return this.#state?.thinkingLevel;
	}
	get modelId(): string | undefined {
		const model = this.#state?.model;
		return model ? `${model.provider}/${model.id}` : undefined;
	}
	/** Completed messages: history at the cut plus every `message_end` since. */
	get messages(): readonly AgentMessage[] {
		return this.#messages;
	}
	/** The current unsaved assistant message, including an attach snapshot's partial content. */
	get streamMessage(): AgentMessage | undefined {
		return this.#streamMessage;
	}

	buildTranscriptSessionContext(options?: TranscriptSessionContextOptions): SessionContext {
		return buildSessionContext(this.#entries, this.#leafId, this.#entryIndex, {
			transcript: true,
			collapseCompactedHistory: options?.collapseCompactedHistory,
			inFlightToolCallIds:
				options?.keepInFlightToolCalls === true && this.isStreaming ? new Set(this.#tools.keys()) : undefined,
		});
	}

	activeToolExecutionUpdates(): readonly Extract<AgentSessionEvent, { type: "tool_execution_update" }>[] {
		return [...this.#toolUpdates.values()];
	}
	/** Tool calls started and not yet ended, in start order. */
	get runningTools(): readonly RemoteToolExecution[] {
		return Array.from(this.#tools.values());
	}

	/**
	 * Same contract as AgentSession.subscribe: every session event, in order.
	 * The first subscriber also receives the in-flight frames held since the cut.
	 */
	subscribe(listener: (event: Lifecycle) => void): () => void {
		this.#listeners.add(listener);
		for (const frame of this.#replay.splice(0)) listener(frame as Lifecycle);
		return () => this.#listeners.delete(listener);
	}

	async refreshState(): Promise<RemoteSessionState> {
		await this.#client.request({ type: "get_state", includeDump: false }, data => {
			this.#state = data as RemoteSessionState;
		});
		return this.#state!;
	}

	async prompt(message: string): Promise<void> {
		await this.#client.request({ type: "prompt", message });
	}
	async steer(message: string): Promise<void> {
		await this.#client.request({ type: "steer", message });
	}
	async followUp(message: string): Promise<void> {
		await this.#client.request({ type: "follow_up", message });
	}
	async abort(): Promise<void> {
		await this.#client.request({ type: "abort" });
	}
	async setModel(provider: string, modelId: string): Promise<void> {
		await this.#client.request({ type: "set_model", provider, modelId });
		await this.refreshState();
	}
	async cycleModel(): Promise<void> {
		await this.#client.request({ type: "cycle_model" });
		await this.refreshState();
	}
	async setThinkingLevel(level: string): Promise<void> {
		await this.#client.request({ type: "set_thinking_level", level });
		await this.refreshState();
	}
	async cycleThinkingLevel(): Promise<void> {
		await this.#client.request({ type: "cycle_thinking_level" });
		await this.refreshState();
	}
	async setSessionName(name: string): Promise<void> {
		await this.#client.request({ type: "set_session_name", name });
		await this.refreshState();
	}
	async compact(customInstructions?: string): Promise<unknown> {
		return this.#client.request({ type: "compact", customInstructions });
	}
	async getAvailableModels(): Promise<unknown[]> {
		const data = (await this.#client.request({ type: "get_available_models" })) as { models: unknown[] };
		return data.models;
	}
	async getAvailableCommands(): Promise<unknown[]> {
		const data = (await this.#client.request({ type: "get_available_commands" })) as { commands: unknown[] };
		return data.commands;
	}
	async getSessionStats(): Promise<unknown> {
		return this.#client.request({ type: "get_session_stats" });
	}

	/** Answer an interaction the session asked every viewer; the first answer wins. */
	respond(frame: Frame): void {
		this.#client.send(frame);
	}

	/** Detach from the hosted session; the session keeps running. */
	async dispose(): Promise<void> {
		this.#unsubscribe();
		this.#listeners.clear();
		await this.#client.detach().catch(() => undefined);
	}

	async #loadEntries(): Promise<void> {
		const generation = ++this.#entriesGeneration;
		await this.#client.request({ type: "get_entries" }, data => {
			if (generation !== this.#entriesGeneration) return;
			const journal = data as { entries: SessionEntry[]; leafId: string | null };
			this.#entries = journal.entries;
			this.#entryIndex = new Map(journal.entries.map(entry => [entry.id, entry]));
			// The response is the journal cut: earlier entry/leaf events are already included.
			this.#leafId = journal.leafId;
		});
	}

	async #loadMessages(): Promise<void> {
		// Cut inside the response callback: frames decoded right after the response are dispatched
		// synchronously, before an `await` here would resume, and they belong after the cut.
		await this.#client.request({ type: "get_messages" }, data => {
			this.#messages = (data as { messages?: AgentMessage[] } | undefined)?.messages ?? [];
			this.#cut();
		});
	}

	/** History landed: everything held so far is either inside it or still in flight. */
	#cut(): void {
		const held = this.#beforeCut ?? [];
		this.#beforeCut = undefined;
		const endedMessages = new Set<string>();
		const endedTools = new Set<string>();
		for (const frame of held) {
			if (frame.type === "message_end" && typeof frame.messageId === "string") endedMessages.add(frame.messageId);
			if (frame.type === "tool_execution_end") endedTools.add(String(frame.toolCallId));
		}
		const inFlight = held.filter(frame => {
			const type = String(frame.type);
			if (MESSAGE_LIFECYCLE.has(type)) return !endedMessages.has(String(frame.messageId));
			if (TOOL_LIFECYCLE.has(type)) return !endedTools.has(String(frame.toolCallId));
			return true;
		});
		// Held frames were tracked on arrival; replay must not roll state back to an older snapshot.
		for (const frame of inFlight) this.#deliver(frame, false, false);
	}

	#onFrame(frame: Frame): void {
		if (this.#beforeCut) {
			this.#beforeCut.push(frame);
			this.#track(frame);
			return;
		}
		this.#deliver(frame, true);
	}

	/** Apply a frame to session state (messages after the cut only) and hand it to subscribers. */
	#deliver(frame: Frame, appendMessages: boolean, track = true): void {
		if (track) this.#track(frame);
		if (appendMessages && frame.type === "message_end" && frame.message !== undefined)
			this.#messages.push(frame.message as AgentMessage);
		if (this.#listeners.size === 0) {
			this.#replay.push(frame);
			return;
		}
		for (const listener of this.#listeners) listener(frame as Lifecycle);
	}

	/** Streaming flag and the running-tool set follow the stream, before and after the cut. */
	#track(frame: Frame): void {
		switch (frame.type) {
			case "journal_state":
			case "journal_entry": {
				const identity = frame as unknown as SessionJournalIdentity;
				const changed =
					this.#identity !== undefined &&
					(this.#identity.sessionId !== identity.sessionId || this.#identity.sessionFile !== identity.sessionFile);
				this.#identity = {
					sessionId: identity.sessionId,
					sessionFile: identity.sessionFile,
					leafId: identity.leafId,
				};
				this.#leafId = identity.leafId;
				if (changed) {
					this.#entries = [];
					this.#entryIndex.clear();
					this.#messages = [];
					this.#streamMessage = undefined;
					this.#tools.clear();
					this.#streamMessageId = undefined;
					this.#toolUpdates.clear();
					void this.#loadEntries().catch(() => undefined);
				}
				if (frame.type === "journal_entry") {
					const entry = frame.entry as SessionEntry;
					if (!this.#entryIndex.has(entry.id)) {
						this.#entries.push(entry);
						this.#entryIndex.set(entry.id, entry);
					}
				}
				return;
			}
			case "message_start":
			case "message_update":
				if ((frame.message as AgentMessage | undefined)?.role === "assistant") {
					this.#streamMessage = frame.message as AgentMessage;
					this.#streamMessageId = typeof frame.messageId === "string" ? frame.messageId : undefined;
				}
				return;
			case "message_end":
				if (
					(frame.message as AgentMessage | undefined)?.role === "assistant" &&
					frame.messageId === this.#streamMessageId
				) {
					this.#streamMessage = undefined;
					this.#streamMessageId = undefined;
				}
				return;
			case "agent_start":
				if (this.#state) this.#state = { ...this.#state, isStreaming: true };
				return;
			case "agent_end":
				if (frame.willContinue !== true) {
					if (this.#state) this.#state = { ...this.#state, isStreaming: false };
					this.#streamMessage = undefined;
					this.#streamMessageId = undefined;
				}
				return;
			case "tool_execution_start":
				this.#tools.set(String(frame.toolCallId), {
					toolCallId: String(frame.toolCallId),
					toolName: String(frame.toolName),
					args: frame.args,
				});
				return;
			case "tool_execution_update": {
				const tool = this.#tools.get(String(frame.toolCallId));
				this.#toolUpdates.set(
					String(frame.toolCallId),
					frame as unknown as Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
				);
				if (tool) tool.partialResult = frame.partialResult;
				return;
			}
			case "tool_execution_end":
				this.#tools.delete(String(frame.toolCallId));
				this.#toolUpdates.delete(String(frame.toolCallId));
				return;
			case "config_update":
			case "session_info_changed":
				void this.refreshState().catch(() => undefined);
		}
	}
}

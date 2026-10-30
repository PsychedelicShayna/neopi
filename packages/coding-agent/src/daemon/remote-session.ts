/**
 * RemoteAgentSession: the session surface a renderer needs, served over a
 * daemon-attached rpc-ui connection instead of an in-process AgentSession.
 *
 * This is the start of the path to running InteractiveMode against a hosted
 * session. It covers the members rpc-ui already serves: state, the event
 * stream, prompting/steering/abort, models, thinking, naming, compaction and
 * messages. InteractiveMode reaches far more of AgentSession than this (178
 * distinct members, plus sessionManager/settings/modelRegistry/agent); the
 * remainder is listed in the PR and lands as rpc-ui commands, not as a second
 * protocol.
 */
import type { SessionDaemonClient } from "./client";

type Frame = Record<string, unknown>;

/** The subset of rpc-ui's `get_state` a renderer reads. */
export interface RemoteSessionState {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	isStreaming: boolean;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	[key: string]: unknown;
}

export class RemoteAgentSession {
	readonly #client: SessionDaemonClient;
	readonly #listeners = new Set<(event: Frame) => void>();
	#state: RemoteSessionState | undefined;
	#messages: unknown[] = [];
	readonly #unsubscribe: () => void;

	private constructor(client: SessionDaemonClient) {
		this.#client = client;
		this.#unsubscribe = client.onFrame(frame => this.#onFrame(frame));
	}

	/** Attach `client` to `sessionId` and load state and history after the snapshot cut. */
	static async attach(client: SessionDaemonClient, sessionId: string): Promise<RemoteAgentSession> {
		const session = new RemoteAgentSession(client);
		await client.attach(sessionId);
		await Promise.all([session.refreshState(), session.#loadMessages()]);
		return session;
	}

	get sessionId(): string {
		return this.#state?.sessionId ?? "";
	}
	get sessionFile(): string | undefined {
		return this.#state?.sessionFile;
	}
	get sessionName(): string | undefined {
		return this.#state?.sessionName;
	}
	get isStreaming(): boolean {
		return this.#state?.isStreaming ?? false;
	}
	get thinkingLevel(): string | undefined {
		return this.#state?.thinkingLevel;
	}
	get modelId(): string | undefined {
		const model = this.#state?.model;
		return model ? `${model.provider}/${model.id}` : undefined;
	}
	get messages(): readonly unknown[] {
		return this.#messages;
	}

	/** Same contract as AgentSession.subscribe: every session event, in order. */
	subscribe(listener: (event: Frame) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async refreshState(): Promise<RemoteSessionState> {
		this.#state = (await this.#client.request({ type: "get_state", includeDump: false })) as RemoteSessionState;
		return this.#state;
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

	async #loadMessages(): Promise<void> {
		const data = (await this.#client.request({ type: "get_messages" })) as { messages?: unknown[] };
		this.#messages = data.messages ?? [];
	}

	#onFrame(frame: Frame): void {
		if (frame.type === "message_end" && frame.message !== undefined) this.#messages = [...this.#messages, frame.message];
		if (frame.type === "agent_start" && this.#state) this.#state = { ...this.#state, isStreaming: true };
		if (frame.type === "agent_end" && frame.willContinue !== true && this.#state) this.#state = { ...this.#state, isStreaming: false };
		if (frame.type === "config_update" || frame.type === "session_info_changed") void this.refreshState().catch(() => undefined);
		for (const listener of this.#listeners) listener(frame);
	}
}

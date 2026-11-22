/**
 * Attach pane for one agent (`npi monitor attach`, #345).
 *
 * Connects to the owner's control socket with a per-agent monitor capability
 * (never the publication token), mirrors that one agent's registry record, and
 * mounts the Agent Hub's own `AgentTranscriptViewer` at this terminal's width:
 * persisted entries come from bounded remote transcript reads, in-flight
 * assistant text and tool progress from the owner's pushed live state.
 *
 * The pane is not a session and starts no model. It cannot reach the primary,
 * slash commands, kill, or revive. Esc (with an empty draft) and Ctrl+C exit
 * the pane; there is no primary view to return to. A dropped socket reconnects
 * with backoff while the owner's publication is alive; an owner that exited,
 * or a grant the owner ended, closes the pane after showing why.
 */
import type { TranscriptLiveState } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { type Component, matchesKey, ProcessTerminal, truncateToWidth, TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { AgentHubRemote, AgentHubRemoteTranscript } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { AgentHubRegistry, AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { type AgentTranscriptLiveFeed, AgentTranscriptViewer } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { ControlClient, ControlClientError } from "../control/client";
import type { MonitorAgentSnapshot } from "../control/monitor-service";
import { findControlMetadata, publicationProcessGone, type ControlMetadata } from "../control/registry";
import { agentTranscriptSource } from "../modes/agent-hub-runtime";

export type MonitorAttachState = "connecting" | "live" | "reconnecting" | "ended";

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;
/** How long an ended pane shows its reason before exiting. */
const ENDED_LINGER_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface MonitorAttachOptions {
	/** Owner publication (from the control registry). */
	metadata: ControlMetadata;
	capability: string;
	/** Registry directory override, for owner-liveness checks. */
	registryDir?: string;
}

function recordOf(agent: MonitorAgentSnapshot): AgentRecordLike {
	return {
		id: agent.id,
		displayName: agent.displayName,
		kind: agent.kind,
		...(agent.parentId ? { parentId: agent.parentId } : {}),
		status: agent.status,
		session: null,
		// Remote viewers read through the connection; only presence matters here.
		sessionFile: agent.hasSessionFile ? agent.id : null,
		createdAt: agent.createdAt,
		lastActivity: agent.lastActivity,
		...(agent.activity ? { activity: agent.activity } : {}),
		history: { readOnly: agent.kind === "advisor", ...(agent.model ? { resolvedModel: agent.model } : {}) },
	};
}

function isAgentSnapshot(value: unknown): value is MonitorAgentSnapshot {
	return isRecord(value) && typeof value.id === "string" && (value.kind === "sub" || value.kind === "advisor");
}

/** One agent's monitor connection: snapshot, pushes, reads, chat, and reconnects. */
export class MonitorAttachConnection {
	readonly #options: MonitorAttachOptions;
	#client: ControlClient | undefined;
	#state: MonitorAttachState = "connecting";
	#endReason: string | undefined;
	#notice: string | undefined;
	#record: AgentRecordLike | undefined;
	#owner: { title: string | null; cwd: string } | undefined;
	#canChat = false;
	#live: TranscriptLiveState | undefined;
	readonly #changeListeners = new Set<() => void>();
	readonly #liveListeners = new Set<(state: TranscriptLiveState | undefined) => void>();
	#reconnecting = false;
	#disposed = false;

	constructor(options: MonitorAttachOptions) {
		this.#options = options;
	}

	get state(): MonitorAttachState {
		return this.#state;
	}
	get endReason(): string | undefined {
		return this.#endReason;
	}
	get notice(): string | undefined {
		return this.#notice;
	}
	get record(): AgentRecordLike | undefined {
		return this.#record;
	}
	get owner(): { title: string | null; cwd: string } | undefined {
		return this.#owner;
	}
	get canChat(): boolean {
		return this.#canChat;
	}

	/** The single-record registry the viewer reads. */
	readonly registry: AgentHubRegistry = {
		list: () => (this.#record ? [this.#record] : []),
		get: id => (this.#record?.id === id ? this.#record : undefined),
		onChange: listener => this.onChange(listener),
	};

	readonly liveFeed: AgentTranscriptLiveFeed = {
		subscribe: listener => {
			this.#liveListeners.add(listener);
			if (this.#live) listener(this.#live);
			return () => this.#liveListeners.delete(listener);
		},
	};

	readonly remote: AgentHubRemote = {
		chat: (_id, text) => this.chat(text),
		// The pane has no kill or revive powers; the viewer never calls these.
		kill: () => {},
		revive: () => {},
		readTranscript: (_id, fromByte) => this.readTranscript(fromByte),
	};

	onChange(listener: () => void): () => void {
		this.#changeListeners.add(listener);
		return () => this.#changeListeners.delete(listener);
	}

	/** First connection. Throws when the owner refuses the capability or is unreachable. */
	async start(): Promise<void> {
		await this.#connectOnce();
	}

	async readTranscript(fromByte: number): Promise<AgentHubRemoteTranscript | null> {
		const client = this.#client;
		if (!client || this.#state !== "live") return null;
		try {
			const response = await client.request({ type: "monitor_transcript", fromByte }, REQUEST_TIMEOUT_MS);
			if (!response.success) {
				if (response.code === "monitor_gone") this.#end(response.error ?? "monitor access ended");
				return null;
			}
			const data = response.data as AgentHubRemoteTranscript | undefined;
			return data && typeof data.text === "string" && typeof data.newSize === "number" ? data : null;
		} catch {
			return null;
		}
	}

	async chat(text: string): Promise<void> {
		const client = this.#client;
		if (!client || this.#state !== "live") throw new Error("not connected to the owner session");
		const response = await client.request({ type: "monitor_chat", text }, REQUEST_TIMEOUT_MS);
		if (!response.success) throw new Error(response.error ?? "message was not delivered");
		this.#setNotice(undefined);
	}

	dispose(): void {
		this.#disposed = true;
		this.#client?.close();
		this.#client = undefined;
		this.#changeListeners.clear();
		this.#liveListeners.clear();
	}

	async #connectOnce(): Promise<void> {
		const client = new ControlClient({
			metadata: this.#options.metadata,
			label: "monitor",
			kind: "other",
			monitorCapability: this.#options.capability,
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		client.onEvent(frame => this.#onFrame(client, frame));
		await client.connect();
		if (this.#disposed) {
			client.close();
			return;
		}
		client.onClose(() => this.#onClosed(client));
		const response = await client.request({ type: "monitor_subscribe" }, REQUEST_TIMEOUT_MS);
		if (!response.success) {
			client.close();
			if (response.code === "monitor_gone") {
				this.#end(response.error ?? "monitor access ended");
				return;
			}
			throw new ControlClientError(response.code ?? "error", response.error ?? "monitor subscribe failed");
		}
		const data = response.data as {
			agent?: unknown;
			canChat?: boolean;
			owner?: { title: string | null; cwd: string };
			live?: TranscriptLiveState;
		};
		this.#client = client;
		if (isAgentSnapshot(data.agent)) this.#record = recordOf(data.agent);
		this.#canChat = data.canChat === true;
		this.#owner = data.owner;
		this.#state = "live";
		this.#setLive(data.live);
		this.#emitChange();
	}

	#onFrame(client: ControlClient, frame: Record<string, unknown>): void {
		if (this.#disposed || client !== this.#client) return;
		switch (frame.type) {
			case "monitor_live":
				if (frame.agentId !== this.#record?.id || !isRecord(frame.state)) return;
				this.#setNotice(
					frame.omitted === "assistant"
						? "live preview too large; the message appears once it is saved"
						: frame.omitted === "tool_progress"
							? "tool progress too large to stream; results appear once saved"
							: this.#notice?.startsWith("live preview") || this.#notice?.startsWith("tool progress")
								? undefined
								: this.#notice,
				);
				this.#setLive(frame.state as unknown as TranscriptLiveState);
				return;
			case "monitor_agent":
				if (!isAgentSnapshot(frame.agent) || frame.agent.id !== this.#record?.id) return;
				this.#record = recordOf(frame.agent);
				this.#emitChange();
				return;
			case "monitor_notice":
				this.#setNotice(typeof frame.text === "string" ? frame.text : undefined);
				return;
			case "monitor_gone":
				this.#end(typeof frame.reason === "string" ? frame.reason : "monitor access ended");
				return;
			case "host_shutdown":
				this.#end("the owner session exited");
				return;
		}
	}

	#onClosed(client: ControlClient): void {
		if (this.#disposed || client !== this.#client || this.#state === "ended") return;
		this.#client = undefined;
		this.#state = "reconnecting";
		this.#emitChange();
		void this.#reconnect();
	}

	async #reconnect(): Promise<void> {
		if (this.#reconnecting) return;
		this.#reconnecting = true;
		let delay = RECONNECT_MIN_MS;
		try {
			while (!this.#disposed && this.#state === "reconnecting") {
				if (await this.#ownerGone()) {
					this.#end("the owner session exited");
					return;
				}
				try {
					await this.#connectOnce();
					return;
				} catch (error) {
					if (error instanceof ControlClientError && error.code === "unauthorized") {
						this.#end("monitor access ended");
						return;
					}
					logger.debug("monitor attach: reconnect failed", { error: String(error) });
				}
				await Bun.sleep(delay);
				delay = Math.min(delay * 2, RECONNECT_MAX_MS);
			}
		} finally {
			this.#reconnecting = false;
		}
	}

	async #ownerGone(): Promise<boolean> {
		const metadata = await findControlMetadata(this.#options.metadata.instanceId, { dir: this.#options.registryDir });
		return !metadata || publicationProcessGone(metadata);
	}

	#end(reason: string): void {
		if (this.#state === "ended") return;
		this.#state = "ended";
		this.#endReason = reason;
		this.#client?.close();
		this.#client = undefined;
		this.#setLive(undefined);
		this.#emitChange();
	}

	#setLive(state: TranscriptLiveState | undefined): void {
		this.#live = state;
		for (const listener of this.#liveListeners) listener(state);
	}

	#setNotice(notice: string | undefined): void {
		if (notice === this.#notice) return;
		this.#notice = notice;
		this.#emitChange();
	}

	#emitChange(): void {
		for (const listener of this.#changeListeners) listener();
	}
}

/**
 * Fullscreen pane: the viewer, with its first row replaced by the monitor
 * header (owner, connection state, notices). Ctrl+C exits when there is no draft.
 */
class MonitorPaneComponent implements Component {
	constructor(
		readonly viewer: AgentTranscriptViewer,
		readonly connection: MonitorAttachConnection,
		readonly exit: () => void,
	) {}

	render(width: number): readonly string[] {
		const lines = [...this.viewer.render(width)];
		if (lines.length > 0) lines[0] = truncateToWidth(this.#header(), width);
		return lines;
	}

	#header(): string {
		const connection = this.connection;
		const owner = connection.owner?.title || connection.owner?.cwd || "owner session";
		const head = `${theme.fg("accent", "npi monitor")} ${theme.fg("dim", theme.sep.dot)} ${owner}`;
		const state =
			connection.state === "live"
				? theme.fg("success", "live")
				: connection.state === "ended"
					? theme.fg("error", `ended: ${connection.endReason ?? ""}`)
					: theme.fg("warning", connection.state === "connecting" ? "connecting…" : "reconnecting…");
		const notice = connection.notice
			? ` ${theme.fg("dim", theme.sep.dot)} ${theme.fg("warning", connection.notice)}`
			: "";
		// Advisors never chat; an aborted subagent stops accepting messages, as in the Agent Hub.
		const viewOnly = !connection.canChat || connection.record?.status === "aborted";
		const mode = viewOnly ? ` ${theme.fg("dim", theme.sep.dot)} ${theme.fg("muted", "view only")}` : "";
		return ` ${head} ${theme.fg("dim", theme.sep.dot)} ${state}${mode}${notice}`;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c") && !this.viewer.capturesInput(data)) {
			this.exit();
			return;
		}
		this.viewer.handleInput(data);
	}

	describe(cx: DescribeContext): NativeNode {
		return this.viewer.describe(cx);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.viewer.handleNativeEvent(event);
	}
}

/** How an attach pane ended. `closedByUser` is set for Esc or Ctrl+C, not when the owner ended it. */
export interface MonitorAttachResult {
	exitCode: number;
	closedByUser: boolean;
}

/** Run one attach pane until the user exits or the owner ends it. */
export async function runMonitorAttach(options: MonitorAttachOptions): Promise<MonitorAttachResult> {
	const connection = new MonitorAttachConnection(options);
	try {
		await connection.start();
	} catch (error) {
		process.stderr.write(`npi monitor: ${error instanceof Error ? error.message : String(error)}\n`);
		connection.dispose();
		return { exitCode: 1, closedByUser: false };
	}
	const record = connection.record;
	if (!record) {
		process.stderr.write(`npi monitor: ${connection.endReason ?? "the owner sent no agent"}\n`);
		connection.dispose();
		return { exitCode: 1, closedByUser: false };
	}
	const done = Promise.withResolvers<boolean>();
	const exit = (): void => done.resolve(true);
	const ui = new TUI(new ProcessTerminal());
	const keybindings = KeybindingsManager.create();
	const viewer = new AgentTranscriptViewer({
		agentId: record.id,
		transcript: agentTranscriptSource,
		registry: connection.registry,
		remote: connection.remote,
		live: connection.liveFeed,
		ui,
		cwd: connection.owner?.cwd ?? process.cwd(),
		expandKeys: keybindings.getKeys("app.tools.expand"),
		// No hub to toggle and no primary to return to: closing the viewer exits the pane.
		hubKeys: [],
		requestRender: () => ui.requestRender(),
		onClose: exit,
		onHubClose: exit,
	});
	const pane = new MonitorPaneComponent(viewer, connection, exit);
	let lingerTimer: Timer | undefined;
	const unsubscribe = connection.onChange(() => {
		ui.requestRender();
		if (connection.state === "ended" && !lingerTimer) {
			lingerTimer = setTimeout(() => done.resolve(false), ENDED_LINGER_MS);
		}
	});
	const overlay = ui.showOverlay(pane, { fullscreen: true, width: "100%", margin: 0 });
	ui.setFocus(pane);
	ui.start();
	let closedByUser: boolean;
	try {
		closedByUser = await done.promise;
	} finally {
		clearTimeout(lingerTimer);
		unsubscribe();
		overlay.hide();
		ui.stop();
		viewer.dispose();
		connection.dispose();
	}
	return { exitCode: 0, closedByUser };
}

/**
 * Per-session control host (issue #171).
 *
 * Publishes the socket, authenticates connections, and dispatches every RPC
 * command plus the control-only commands. A TUI presenter is attached once
 * the interactive mode is up; until then screen commands answer `no_tui`.
 */
import { randomBytes } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import { BUILD_INFO } from "../build-info";
import { lookup } from "../config/registry";
import { RpcPromptResults } from "../modes/rpc/rpc-prompt-results";
import { RpcRoles } from "../modes/rpc/rpc-roles";
import { RPC_CAPABILITIES } from "../modes/rpc/rpc-capabilities";
import type { RpcCommand } from "../modes/rpc/rpc-types";
import type { AgentSession } from "../session/agent-session";
import { AgentRegistry } from "../registry/agent-registry";
import { executeSend } from "../irc/messaging";
import { HostBudget, workClass } from "./budget";
import { encodeKeyId } from "./keys";
import type { ControlPresenter } from "./presenter";
import {
	newControlInstanceId,
	publishControlEndpoint,
	type ControlPublication,
} from "./registry";
import { ControlServer, type ControlConnection } from "./server";
import { APPROVAL_GATED_SETTINGS, cfgControlApprovals } from "./settings";
import { executeSessionCommand } from "./session-commands";
import { CtlTool } from "../tools/ctl";
import {
	CONTROL_EXEMPTIONS,
	type ControlResponse,
	type ControlRole,
	type ControlSnapshot,
	type Revisions,
} from "./types";

const RPC_TYPES = new Set<string>([
	"negotiate_protocol", "prompt", "steer", "follow_up", "abort", "abort_and_prompt",
	"new_session", "open_session", "get_state", "set_fast_mode", "set_chat_mode", "set_mode",
	"get_available_commands", "get_entries", "get_tree", "set_todos", "set_host_tools",
	"set_host_uri_schemes", "set_subagent_subscription", "set_event_filter", "set_approval_handler",
	"get_subagents", "get_subagent_messages", "set_model", "cycle_model", "get_available_models",
	"get_roles", "set_role", "set_thinking_level", "cycle_thinking_level", "get_available_thinking_levels",
	"set_steering_mode", "set_follow_up_mode", "set_interrupt_mode", "compact", "set_auto_compaction",
	"set_auto_retry", "abort_retry", "bash", "abort_bash", "get_session_stats", "get_usage",
	"export_html", "switch_session", "branch", "get_branch_messages", "get_last_assistant_text",
	"set_session_name", "handoff", "get_messages", "get_messages_page", "get_login_providers", "login",
]);

export interface ControlHostOptions {
	session: AgentSession;
	role: ControlRole;
	/** Registry directory override (tests). */
	dir?: string;
	tmuxPane?: string | null;
}

const hosts = new WeakMap<AgentSession, ControlHost>();

/** The control host for a session, once published. */
export function controlHostFor(session: AgentSession): ControlHost | undefined {
	return hosts.get(session);
}

export class ControlHost {
	readonly instanceId = newControlInstanceId();
	readonly imageId = randomBytes(8).toString("hex");
	readonly budget = new HostBudget();
	readonly roles: RpcRoles;
	readonly promptResults: RpcPromptResults;
	presenter: ControlPresenter | undefined;
	publication: ControlPublication | undefined;
	readonly #options: ControlHostOptions;
	readonly #connections = new Set<ControlConnection>();
	readonly #subscribed = new Set<ControlConnection>();
	#server: ControlServer | undefined;
	#revisions: Revisions = {
		generation: 1,
		human: 0,
		focus: 0,
		draft: 0,
		dialogs: 0,
		paint: 0,
		model: null,
		role: null,
	};
	#ready = false;
	#requestSeq = 0;
	#closed = false;

	constructor(options: ControlHostOptions) {
		this.#options = options;
		this.roles = new RpcRoles(options.session);
		this.promptResults = new RpcPromptResults(options.session, () => {});
		hosts.set(options.session, this);
	}

	get revisions(): Revisions {
		return { ...this.#revisions };
	}

	bumpHuman(): void {
		this.#revisions.human++;
	}
	bumpFocus(): void {
		this.#revisions.focus++;
	}
	bumpDialogs(): void {
		this.#revisions.dialogs++;
	}
	bumpDraft(): void {
		this.#revisions.draft++;
	}
	bumpGeneration(): void {
		this.#revisions.generation++;
	}

	markReady(): void {
		this.#ready = true;
		this.#refreshIdentity();
	}

	/** Publish the socket. No-op when peer credentials are unavailable. */
	async start(): Promise<void> {
		const session = this.#options.session;
		const connectionHost = {
			instanceId: this.instanceId,
			token: "",
			budget: this.budget,
			registryDir: this.#options.dir,
			snapshot: () => this.snapshot(),
			dispatch: (connection: ControlConnection, command: Record<string, unknown>) => this.#dispatch(connection, command),
			onAuthenticated: (connection: ControlConnection) => {
				this.#connections.add(connection);
				connection.write({
					type: "ready",
					protocolVersion: 1,
					supportedProtocolVersions: [1, 2],
					capabilities: [...RPC_CAPABILITIES, "control_v1"],
				});
			},
			onClosed: (connection: ControlConnection) => {
				this.#connections.delete(connection);
				this.#subscribed.delete(connection);
			},
		};
		const server = new ControlServer({ metadata: { instanceId: this.instanceId }, host: connectionHost });
		if (server.disabled) {
			logger.warn("control: socket disabled (peer credentials unavailable)");
			return;
		}
		this.#server = server;
		this.publication = await publishControlEndpoint({
			dir: this.#options.dir,
			role: this.#options.role,
			instanceId: this.instanceId,
			imageId: this.imageId,
			execPath: process.execPath,
			gitSha: BUILD_INFO.gitSha,
			profile: process.env.OMP_PROFILE ?? null,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile ?? null,
			title: session.sessionName ?? null,
			cwd: session.sessionManager.getCwd(),
			tmuxPane: this.#options.tmuxPane ?? process.env.TMUX_PANE ?? null,
			tmuxSession: null,
			tmuxWindow: null,
			tty: null,
			onConnection: socket => server.accept(socket),
		});
		connectionHost.token = this.publication.token;
		const dispose = session.dispose.bind(session);
		session.dispose = async () => {
			await this.close("owner_closed");
			return dispose();
		};
		this.#mountCtlTool(session);
		session.subscribe(event => {
			this.promptResults.observe(event);
			if (event.type === "model_changed") {
				this.#revisions.model = session.model ? `${session.model.provider}/${session.model.id}` : null;
			}
			for (const connection of this.#subscribed) connection.write(event);
		});
	}

	#mountCtlTool(session: AgentSession): void {
		try {
			const tools = session.agent.state.tools;
			if (tools.some(tool => tool.name === "ctl")) return;
			session.agent.setTools([...tools, new CtlTool()]);
		} catch (error) {
			logger.warn("control: ctl tool was not mounted", { error: String(error) });
		}
	}

	#refreshIdentity(): void {
		const session = this.#options.session;
		this.publication?.update({
			sessionId: session.sessionId,
			sessionFile: session.sessionFile ?? null,
			title: session.sessionName ?? null,
			cwd: session.sessionManager.getCwd(),
		});
	}

	snapshot(): ControlSnapshot {
		const session = this.#options.session;
		const presenter = this.presenter;
		return {
			version: 1,
			instanceId: this.instanceId,
			imageId: this.imageId,
			role: this.#options.role,
			pid: process.pid,
			ready: this.#ready,
			build: { ...BUILD_INFO, execPath: process.execPath },
			tmux: { pane: this.#options.tmuxPane ?? process.env.TMUX_PANE ?? null, session: null, window: null },
			cwd: session.sessionManager.getCwd(),
			title: session.sessionName ?? null,
			session: null,
			busy: {
				streaming: session.isStreaming,
				compacting: session.isCompacting,
				queued: session.queuedMessageCount,
				pendingAsyncWork: session.hasPendingAsyncWork(),
				settled: !session.isStreaming && session.queuedMessageCount === 0,
			},
			revisions: this.revisions,
			view: presenter
				? {
						focus: null,
						overlays: 0,
						focusedAgent: null,
						liveDestination: null,
						replMode: null,
						draftLength: presenter.draft().text.length,
					}
				: null,
			modes: { plan: false, chat: session.chatMode?.mode ?? "off", goal: false, vibe: false, live: false, repl: false },
			dialogs: presenter?.dialogs() ?? [],
			connections: this.#connections.size,
			requests: { open: 0, retained: 0 },
			hosts: [{ kind: this.#options.role, canPresent: presenter !== undefined, canApprove: true }],
			approvals: { controlAllowed: cfgControlApprovals.get(session.settings) === true, pending: 0 },
			exemptions: [...CONTROL_EXEMPTIONS],
		};
	}

	async close(reason = "shutdown"): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const connection of this.#connections) {
			connection.write({ type: "host_shutdown", reason });
			connection.close(reason);
		}
		await this.publication?.close();
		hosts.delete(this.#options.session);
	}

	async #dispatch(connection: ControlConnection, frame: Record<string, unknown>): Promise<void> {
		const type = String(frame.type ?? "");
		if (connection.probe && type !== "get_status" && type !== "state" && type !== "bye") {
			this.#reply(connection, frame, { success: false, error: "probe connections are read-only", code: "probe_only" });
			return;
		}
		if (type === "bye") {
			connection.close("bye");
			return;
		}
		const conflict = this.#precondition(frame);
		if (conflict) {
			this.#reply(connection, frame, conflict);
			return;
		}
		logger.info("control", { connectionId: connection.id, peerPid: connection.peer.pid, type, generation: this.#revisions.generation });
		try {
			if (RPC_TYPES.has(type)) {
				await this.#rpc(connection, frame);
				return;
			}
			await this.#control(connection, frame);
		} catch (error) {
			this.#reply(connection, frame, { success: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			const kind = workClass(type, frame);
			if (kind === "retained") connection.budget.release("retained");
		}
	}

	#precondition(frame: Record<string, unknown>): { success: false; error: string; code: string } | undefined {
		const expected = frame.if;
		if (!expected || typeof expected !== "object") return undefined;
		const rev = this.#revisions;
		const check = expected as Record<string, unknown>;
		for (const field of ["generation", "human", "focus", "draft", "dialogs"] as const) {
			if (typeof check[field] === "number" && check[field] !== rev[field]) {
				return { success: false, error: `⌁ ${"label"} backed off (${field} changed)`, code: "conflict" };
			}
		}
		return undefined;
	}

	async #rpc(connection: ControlConnection, frame: Record<string, unknown>): Promise<void> {
		const command = frame as unknown as RpcCommand;
		const handle = `r-${this.instanceId.slice(0, 8)}-${++this.#requestSeq}`;
		const result = await executeSessionCommand(command, {
			session: this.#options.session,
			roles: this.roles,
			origin: connection.origin,
			runOwner: handle,
			output: frame => connection.write(frame),
		});
		this.#reply(connection, frame, result);
		if (result.agentInvoked) {
			connection.write({ type: "turn_origin", requestHandle: handle, connectionId: connection.id, label: connection.label });
		}
	}

	async #control(connection: ControlConnection, frame: Record<string, unknown>): Promise<void> {
		const type = String(frame.type);
		const presenter = this.presenter;
		const needTui = () => {
			if (presenter) return false;
			this.#reply(connection, frame, { success: false, error: "this session has no TUI", code: "no_tui" });
			return true;
		};
		switch (type) {
			case "get_status":
			case "state":
				this.#reply(connection, frame, { success: true, data: this.snapshot() });
				return;
			case "subscribe":
				this.#subscribed.add(connection);
				this.#reply(connection, frame, { success: true, data: { cursor: 0 } });
				return;
			case "input":
			case "slash": {
				if (needTui()) return;
				const text = String(frame.text ?? "");
				const result = await presenter!.submit(text);
				this.#notify(connection, type === "slash" ? text : "input");
				this.#reply(connection, frame, { success: true, data: result });
				return;
			}
			case "action": {
				if (needTui()) return;
				const actionId = String(frame.actionId ?? "");
				if (actionId === "app.suspend") {
					this.#reply(connection, frame, { success: false, error: "job control is exempt", code: "exempt_job_control" });
					return;
				}
				if (actionId === "app.editor.external") {
					this.#reply(connection, frame, { success: false, error: "external editor is exempt", code: "exempt_external_program" });
					return;
				}
				const result = await presenter!.action(actionId);
				if (result.exempt) {
					this.#reply(connection, frame, { success: false, error: result.exempt, code: result.exempt });
					return;
				}
				this.#reply(connection, frame, {
					success: result.handled,
					data: result,
					error: result.handled ? undefined : `unknown action ${actionId}`,
					code: result.handled ? undefined : "unknown_action",
				});
				return;
			}
			case "keys": {
				if (needTui()) return;
				const tokens = Array.isArray(frame.keys) ? frame.keys : [];
				let injected = 0;
				for (const token of tokens) {
					const record = token as { key?: string; text?: string };
					const bytes = record.text ?? (record.key ? encodeKeyId(record.key) : undefined);
					if (!bytes) {
						this.#reply(connection, frame, { success: false, error: `cannot encode ${record.key}`, code: "key_unencodable" });
						return;
					}
					presenter!.inject(bytes);
					injected++;
				}
				this.#reply(connection, frame, { success: true, data: { injected, revisions: this.revisions } });
				return;
			}
			case "paste":
				if (needTui()) return;
				presenter!.inject(`\x1b[200~${String(frame.text ?? "")}\x1b[201~`);
				this.#reply(connection, frame, { success: true });
				return;
			case "esc":
				if (needTui()) return;
				this.#reply(connection, frame, { success: true, data: await presenter!.esc() });
				return;
			case "screen":
				if (needTui()) return;
				this.#reply(connection, frame, { success: true, data: presenter!.screen(typeof frame.mode === "string" ? frame.mode : undefined) });
				return;
			case "dialogs":
				this.#reply(connection, frame, { success: true, data: { dialogs: presenter?.dialogs() ?? [] } });
				return;
			case "dialog_answer": {
				if (!presenter) {
					this.#reply(connection, frame, { success: false, error: "no dialogs", code: "unknown_dialog" });
					return;
				}
				const settled = await presenter.answerDialog(String(frame.dialogId ?? ""), frame.answer);
				this.#reply(connection, frame, { success: settled.settled, error: settled.error, code: settled.settled ? undefined : "unknown_dialog" });
				return;
			}
			case "draft_get":
				if (needTui()) return;
				this.#reply(connection, frame, { success: true, data: presenter!.draft() });
				return;
			case "draft_set":
			case "draft_clear":
				if (needTui()) return;
				if (!frame.if) {
					this.#reply(connection, frame, { success: false, error: "draft writes require if.draft", code: "precondition_required" });
					return;
				}
				presenter!.setDraft(type === "draft_clear" ? "" : String(frame.text ?? ""));
				this.#reply(connection, frame, { success: true, data: { revisions: this.revisions } });
				return;
			case "settings_get":
			case "settings_set":
			case "settings_unset":
				this.#settings(connection, frame);
				return;
			case "commands":
				this.#reply(connection, frame, {
					success: true,
					data: { commands: await import("../slash-commands/available-commands").then(m => m.buildAvailableSlashCommands(this.#options.session)) },
				});
				return;
			case "agents":
				await this.#agents(connection, frame);
				return;
			case "wait":
				this.#reply(connection, frame, { success: true, data: { waited: frame.for } });
				return;
			default:
				this.#reply(connection, frame, { success: false, error: `Unknown command: ${type}` });
		}
	}

	#settings(connection: ControlConnection, frame: Record<string, unknown>): void {
		const session = this.#options.session;
		const path = typeof frame.path === "string" ? frame.path : "";
		const type = String(frame.type);
		if (type === "settings_get" && !path) {
			this.#reply(connection, frame, { success: true, data: { approvals: cfgControlApprovals.get(session.settings) === true } });
			return;
		}
		const setting = lookup(path);
		if (!setting) {
			this.#reply(connection, frame, { success: false, error: `unknown setting ${path}`, code: "unknown_setting" });
			return;
		}
		if (type === "settings_get") {
			this.#reply(connection, frame, { success: true, data: { path, value: setting.get(session.settings) } });
			return;
		}
		if (APPROVAL_GATED_SETTINGS.some(id => path === id || path.startsWith(`${id}.`)) && !cfgControlApprovals.get(session.settings)) {
			this.#reply(connection, frame, {
				success: false,
				error: "approval settings belong to the pane (control.approvals is off)",
				code: "approval_owner_only",
			});
			return;
		}
		try {
			if (type === "settings_unset") setting.unset(session.settings);
			else if (frame.scope === "runtime") setting.override(session.settings, frame.value as never);
			else setting.set(session.settings, frame.value as never);
			this.#notify(connection, `settings ${path}`);
			this.#reply(connection, frame, { success: true, data: { path, value: setting.get(session.settings) } });
		} catch (error) {
			this.#reply(connection, frame, { success: false, error: error instanceof Error ? error.message : String(error), code: "invalid_value" });
		}
	}

	async #agents(connection: ControlConnection, frame: Record<string, unknown>): Promise<void> {
		const op = String(frame.op ?? "list");
		const registry = AgentRegistry.global();
		if (op === "list") {
			this.#reply(connection, frame, {
				success: true,
				data: { agents: registry.list().map(ref => ({ id: ref.id, status: ref.status, kind: ref.kind })) },
			});
			return;
		}
		if (op === "send") {
			const senderId = this.#options.session.getAgentId() ?? this.instanceId;
			const result = await executeSend(
				{ registry, senderId, sessionFileHint: this.#options.session.sessionFile },
				{ to: String(frame.to ?? ""), message: String(frame.message ?? "") },
			);
			this.#reply(connection, frame, { success: true, data: result.details });
			return;
		}
		this.#reply(connection, frame, { success: false, error: `unsupported agents op ${op}` });
	}

	#notify(connection: ControlConnection, what: string): void {
		const text = `⌁ ${connection.label}#${connection.id}: ${what}`;
		this.presenter?.notify(text);
		this.#options.session.emitNotice("info", text, "control");
	}

	#reply(connection: ControlConnection, frame: Record<string, unknown>, result: { success: boolean; data?: unknown; error?: string; code?: string }): void {
		const response: ControlResponse = {
			type: "response",
			command: String(frame.type ?? ""),
			requestId: typeof frame.requestId === "string" ? frame.requestId : undefined,
			id: typeof frame.id === "string" ? frame.id : undefined,
			success: result.success,
			...(result.data !== undefined ? { data: result.data } : {}),
			...(result.error ? { error: result.error } : {}),
			...(result.code ? { code: result.code } : {}),
		};
		connection.respond(response);
	}
}

/** Start the host unless the flag or setting disables it. */
export async function startControlHost(options: ControlHostOptions & { enabled: boolean }): Promise<ControlHost | undefined> {
	if (!options.enabled || process.platform === "win32") return undefined;
	const host = new ControlHost(options);
	try {
		await host.start();
	} catch (error) {
		logger.warn("control: failed to publish", { error: String(error) });
		return undefined;
	}
	return host;
}

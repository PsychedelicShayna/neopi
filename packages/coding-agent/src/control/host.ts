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
import { readSetting, unsetSetting, writeSetting } from "./settings-adapter";
import { RpcPromptResults } from "../modes/rpc/rpc-prompt-results";
import { RpcRoles } from "../modes/rpc/rpc-roles";
import { RPC_CAPABILITIES } from "../modes/rpc/rpc-capabilities";
import type { RpcCommand } from "../modes/rpc/rpc-types";
import type { AgentSession } from "../session/agent-session";
import { AgentRegistry } from "../registry/agent-registry";
import { executeSend } from "../irc/messaging";
import { IrcBus } from "../irc/bus";
import { currentControlActor, runAsControlActor } from "./actor";
import { HostBudget, workClass } from "./budget";
import { RPC_COMMAND_TYPES } from "./parity";
import { encodeKeyId, encodeSgrMouse } from "./keys";
import type { ControlPresenter } from "./presenter";
import { newControlInstanceId, publishControlEndpoint, type ControlPublication } from "./registry";
import { ControlServer, type ControlConnection } from "./server";
import { APPROVAL_GATED_SETTINGS, cfgControlApprovals, cfgControlSecretInput } from "./settings";
import { RpcPlanModeController } from "../modes/rpc/rpc-plan-mode";
import { RpcSessionSettleWatcher } from "../modes/rpc/rpc-session-settle";
import { RpcSessionEventForwarder } from "../modes/rpc/rpc-session-events";
import { RpcHostToolBridge } from "../modes/rpc/host-tools";
import type { RpcPendingExtensionRequests } from "../modes/rpc/rpc-mode";
import { RpcHostUriBridge } from "../modes/rpc/host-uris";
import { RpcToolApprovalBridge } from "../modes/rpc/rpc-tool-approval";
import { RpcExtensionUserMessageTracker } from "../modes/rpc/rpc-prompt-results";
import type { RpcResponse } from "../modes/rpc/rpc-types";
import {
	CONTROL_EXEMPTIONS,
	type ControlResponse,
	type ControlRole,
	type ControlSnapshot,
	type Revisions,
} from "./types";

const RPC_TYPES = new Set<string>(RPC_COMMAND_TYPES);

export interface ControlHostOptions {
	session: AgentSession;
	role: ControlRole;
	/** Registry directory override (tests). */
	dir?: string;
	tmuxPane?: string | null;
}

/** Field that failed an optimistic revision check, if any. */
export function revisionConflict(
	expected: unknown,
	revisions: Revisions,
): "generation" | "human" | "focus" | "draft" | "dialogs" | undefined {
	if (!expected || typeof expected !== "object") return undefined;
	const check = expected as Record<string, unknown>;
	for (const field of ["generation", "human", "focus", "draft", "dialogs"] as const) {
		if (typeof check[field] === "number" && check[field] !== revisions[field]) return field;
	}
	return undefined;
}

const hosts = new WeakMap<AgentSession, ControlHost>();
const liveHosts = new Set<ControlHost>();

export interface ControlCallerIdentity {
	instanceId: string;
	token: string;
	controlChain: string[];
}

/** Publication of the in-process host, so the ctl tool can bind its caller. */
export function currentControlCaller(): ControlCallerIdentity | null {
	const actor = currentControlActor();
	for (const host of liveHosts) {
		const token = host.publication?.token;
		if (!token) continue;
		if (actor) {
			for (const connection of host.connections()) {
				if (connection.id === actor.connectionId) {
					return { instanceId: host.instanceId, token, controlChain: connection.propagatedChain };
				}
			}
		}
	}
	for (const host of liveHosts) {
		const token = host.publication?.token;
		if (!token) continue;
		return { instanceId: host.instanceId, token, controlChain: [] };
	}
	return null;
}

interface ConnectionBridges {
	forwarder: RpcSessionEventForwarder;
	hostTools: RpcHostToolBridge;
	hostUris: RpcHostUriBridge;
	approvals: RpcToolApprovalBridge;
	pending: RpcPendingExtensionRequests;
}

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
	readonly #handlers = new Map<ControlConnection, (command: RpcCommand) => Promise<RpcResponse>>();
	readonly #forwarders = new Map<ControlConnection, RpcSessionEventForwarder>();
	readonly #bridges = new Map<ControlConnection, ConnectionBridges>();
	readonly #openHandles = new Set<string>();
	readonly #settledHandles = new Set<string>();
	#approvalUiOpen = false;
	#planMode: RpcPlanModeController | undefined;
	#settleWatcher: RpcSessionSettleWatcher | undefined;
	readonly #extensionTracker = new RpcExtensionUserMessageTracker();
	#runOwnerSeq = 0;
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
	#closed = false;
	#seenSessionId: string | undefined;

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
		liveHosts.add(this);
		const session = this.#options.session;
		const connectionHost = {
			instanceId: this.instanceId,
			token: "",
			budget: this.budget,
			registryDir: this.#options.dir,
			snapshot: () => this.snapshot(),
			dispatch: (connection: ControlConnection, command: Record<string, unknown>) =>
				this.#dispatch(connection, command),
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
				this.#handlers.delete(connection);
				this.#forwarders.delete(connection);
				this.#closeBridges(connection);
			},
		};
		const server = new ControlServer({ metadata: { instanceId: this.instanceId }, host: connectionHost });
		if (server.disabled) {
			logger.warn("control: socket disabled (peer credentials unavailable)");
			return;
		}
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
		session.subscribe(event => {
			this.#noteSessionIdentity();
			this.promptResults.observe(event);
			this.#planMode?.observe(event);
			this.#settleWatcher?.observe(event);
			if (event.type === "model_changed") {
				this.#revisions.model = session.model ? `${session.model.provider}/${session.model.id}` : null;
			}
			for (const forwarder of this.#forwarders.values()) forwarder.forward(event);
		});
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
			modes: {
				plan: false,
				chat: session.chatMode?.mode ?? "off",
				goal: false,
				vibe: false,
				live: false,
				repl: false,
			},
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
		liveHosts.delete(this);
		AgentRegistry.global().unregister(this.#mailboxId());
		await this.publication?.close();
		hosts.delete(this.#options.session);
	}

	async #dispatch(connection: ControlConnection, frame: Record<string, unknown>): Promise<void> {
		return runAsControlActor(
			{
				connectionId: connection.id,
				label: connection.label || "ctl",
				humanAtAdmission: this.#revisions.human,
				humanNow: () => this.#revisions.human,
			},
			() => this.#dispatchInner(connection, frame),
		);
	}

	async #dispatchInner(connection: ControlConnection, frame: Record<string, unknown>): Promise<void> {
		const type = String(frame.type ?? "");
		if (connection.probe && type !== "get_status" && type !== "state" && type !== "bye") {
			this.#reply(connection, frame, {
				success: false,
				error: "probe connections are read-only",
				code: "probe_only",
			});
			return;
		}
		if (type === "bye") {
			connection.close("bye");
			return;
		}
		const conflict = this.#precondition(connection, frame);
		if (conflict) {
			this.#reply(connection, frame, conflict);
			return;
		}
		logger.info("control", {
			connectionId: connection.id,
			peerPid: connection.peer.pid,
			type,
			generation: this.#revisions.generation,
		});
		try {
			if (await this.#routeSideChannel(connection, frame)) return;
			if (RPC_TYPES.has(type)) {
				await this.#rpc(connection, frame);
				return;
			}
			await this.#control(connection, frame);
		} catch (error) {
			this.#reply(connection, frame, {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			const kind = workClass(type, frame);
			if (kind === "retained") connection.budget.release("retained");
		}
	}

	#precondition(
		connection: ControlConnection,
		frame: Record<string, unknown>,
	): { success: false; error: string; code: string } | undefined {
		const field = revisionConflict(frame.if, this.#revisions);
		if (!field) return undefined;
		const text = `⌁ ${connection.label}#${connection.id} backed off (${field} changed)`;
		this.presenter?.notify(text);
		this.#options.session.emitNotice("info", text, "control");
		return { success: false, error: text, code: "conflict" };
	}

	async #handlerFor(connection: ControlConnection): Promise<(command: RpcCommand) => Promise<RpcResponse>> {
		const existing = this.#handlers.get(connection);
		if (existing) return existing;
		const session = this.#options.session;
		const output = (frame: object) => {
			this.#notePromptResult(frame);
			connection.write(frame);
		};
		const forwarder = new RpcSessionEventForwarder(output);
		this.#forwarders.set(connection, forwarder);
		const hostTools = new RpcHostToolBridge(output);
		const hostUris = new RpcHostUriBridge(output);
		const approvals = new RpcToolApprovalBridge({
			output,
			runner: session.extensionRunner,
			settings: session.settings,
		});
		const { RpcPendingExtensionRequests } = await import("../modes/rpc/rpc-mode");
		const pending = new RpcPendingExtensionRequests();
		this.#bridges.set(connection, { forwarder, hostTools, hostUris, approvals, pending });
		if (!this.#planMode)
			this.#planMode = new RpcPlanModeController(session, frame => {
				for (const subscriber of this.#subscribed) subscriber.write(frame);
			});
		if (!this.#settleWatcher)
			this.#settleWatcher = new RpcSessionSettleWatcher(session, frame => {
				for (const subscriber of this.#subscribed) subscriber.write(frame);
			});
		const planMode = this.#planMode;
		const settleWatcher = this.#settleWatcher;
		const success = (id: string | undefined, command: string, data?: object | null): RpcResponse =>
			(data === undefined
				? { id, type: "response", command, success: true }
				: { id, type: "response", command, success: true, data }) as RpcResponse;
		const error = (id: string | undefined, command: string, message: string, code?: string): RpcResponse =>
			({
				id,
				type: "response",
				command,
				success: false,
				error: message,
				...(code ? { code } : {}),
			}) as RpcResponse;
		const bridges = this.#bridges.get(connection);
		if (!bridges) throw new Error("control bridges were not installed");
		const { createRpcCommandHandler } = await import("../modes/rpc/rpc-mode");
		const handler = createRpcCommandHandler({
			session,
			output,
			success,
			error,
			promptResults: this.promptResults,
			ownPrompt: ticket => {
				ticket.route = frame => {
					this.#notePromptResult(frame);
					connection.write(frame);
				};
				const owner = ticket.requestHandle ?? `r-${this.instanceId.slice(0, 8)}-${++this.#runOwnerSeq}`;
				ticket.requestHandle = owner;
				this.#openHandles.add(owner);
				this.promptResults.bindOwner(ticket, owner);
				return owner;
			},
			reservePromptEntryId: message =>
				session.isExtensionCommand(message) ? undefined : session.sessionManager.reserveEntryId(),
			executeCustomPromptCommand: async message => {
				if (!message.startsWith("/") || session.isExtensionCommand(message)) return null;
				const space = message.indexOf(" ");
				const name = message.slice(1, space < 0 ? undefined : space);
				if (!session.customCommands.some(loaded => loaded.command.name === name)) return null;
				return session.executeCustomCommand(message);
			},
			emitAvailableCommandsUpdate: async () => {
				const { buildAvailableSlashCommands } = await import("../slash-commands/available-commands");
				output({ type: "available_commands_update", commands: await buildAvailableSlashCommands(session) });
			},
			reloadPluginState: async () => {},
			getAvailableCommands: async () => {
				const { buildAvailableSlashCommands } = await import("../slash-commands/available-commands");
				return buildAvailableSlashCommands(session);
			},
			onPromptError: (id, command) => promptError => output(error(id, command, promptError.message)),
			extensionUserMessageTracker: this.#extensionTracker,
			trackBackground: () => {},
			subagentRegistry: undefined,
			planMode,
			settleWatcher,
			rpcRoles: this.roles,
			sessionEvents: forwarder,
			hostToolBridge: bridges.hostTools,
			hostUriBridge: bridges.hostUris,
			toolApprovalBridge: bridges.approvals,
			pendingExtensionRequests: bridges.pending,
			createUiContext: () => {
				throw new Error("control login uses the pane dialog");
			},
			origin: connection.origin,
		});
		this.#handlers.set(connection, handler);
		return handler;
	}

	async #rpc(connection: ControlConnection, frame: Record<string, unknown>): Promise<void> {
		const command = {
			...frame,
			id:
				typeof frame.id === "string" ? frame.id : typeof frame.requestId === "string" ? frame.requestId : undefined,
		} as RpcCommand;
		const response = await (await this.#handlerFor(connection))(command);
		if (
			response.success &&
			(command.type === "new_session" ||
				command.type === "open_session" ||
				command.type === "switch_session" ||
				command.type === "branch")
		) {
			this.#seenSessionId = this.#options.session.sessionId;
			this.bumpGeneration();
		}
		connection.write({ ...response, requestId: command.id });
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
				await this.#handlerFor(connection);
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
				if (this.blocksInjectedInput()) {
					this.#reply(connection, frame, {
						success: false,
						error: "approvals belong to the pane",
						code: "approval_owner_only",
					});
					return;
				}
				const actionId = String(frame.actionId ?? "");
				if (actionId === "app.suspend") {
					this.#reply(connection, frame, {
						success: false,
						error: "job control is exempt",
						code: "exempt_job_control",
					});
					return;
				}
				if (actionId === "app.editor.external") {
					this.#reply(connection, frame, {
						success: false,
						error: "external editor is exempt",
						code: "exempt_external_program",
					});
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
				if (this.blocksInjectedInput()) {
					this.#reply(connection, frame, {
						success: false,
						error: "approvals belong to the pane",
						code: "approval_owner_only",
					});
					return;
				}
				const tokens = Array.isArray(frame.keys) ? frame.keys : [];
				let injected = 0;
				for (const token of tokens) {
					const record = token as { key?: string; text?: string };
					const bytes = record.text ?? (record.key ? encodeKeyId(record.key) : undefined);
					if (!bytes) {
						this.#reply(connection, frame, {
							success: false,
							error: `cannot encode ${record.key}`,
							code: "key_unencodable",
						});
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
				if (this.blocksInjectedInput()) {
					this.#reply(connection, frame, {
						success: false,
						error: "approvals belong to the pane",
						code: "approval_owner_only",
					});
					return;
				}
				presenter!.inject(`\x1b[200~${String(frame.text ?? "")}\x1b[201~`);
				this.#reply(connection, frame, { success: true });
				return;
			case "mouse": {
				if (needTui()) return;
				if (this.blocksInjectedInput()) {
					this.#reply(connection, frame, {
						success: false,
						error: "approvals belong to the pane",
						code: "approval_owner_only",
					});
					return;
				}
				const action =
					frame.action === "release" ||
					frame.action === "scrollUp" ||
					frame.action === "scrollDown" ||
					frame.action === "move" ||
					frame.action === "press"
						? frame.action
						: "click";
				presenter!.inject(encodeSgrMouse(Number(frame.x ?? 0), Number(frame.y ?? 0), action));
				this.#reply(connection, frame, { success: true, data: { revisions: this.revisions } });
				return;
			}
			case "repl_execute": {
				const language = typeof frame.target === "string" && frame.target ? frame.target : "py";
				const result = await this.#options.session.executeEval(language, String(frame.code ?? ""));
				this.#reply(connection, frame, {
					success: result.exitCode === 0,
					data: { output: result.output, exitCode: result.exitCode, language },
				});
				return;
			}
			case "serve":
				if (Array.isArray(frame.tools))
					await this.#rpc(connection, { ...frame, type: "set_host_tools", tools: frame.tools });
				if (Array.isArray(frame.schemes))
					await this.#rpc(connection, { ...frame, type: "set_host_uri_schemes", schemes: frame.schemes });
				if (!Array.isArray(frame.tools) && !Array.isArray(frame.schemes)) {
					this.#reply(connection, frame, {
						success: false,
						error: "serve requires tools or schemes",
						code: "invalid_value",
					});
				}
				return;
			case "unserve":
				await this.#rpc(connection, { ...frame, type: "set_host_tools", tools: [] });
				return;
			case "esc":
				if (needTui()) return;
				this.#reply(connection, frame, { success: true, data: await presenter!.esc() });
				return;
			case "screen":
				if (needTui()) return;
				this.#reply(connection, frame, {
					success: true,
					data: presenter!.screen(typeof frame.mode === "string" ? frame.mode : undefined),
				});
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
				this.#reply(connection, frame, {
					success: settled.settled,
					error: settled.error,
					code: settled.settled ? undefined : "unknown_dialog",
				});
				return;
			}
			case "draft_get":
				if (needTui()) return;
				this.#reply(connection, frame, { success: true, data: presenter!.draft() });
				return;
			case "draft_set":
			case "draft_clear":
				if (needTui()) return;
				const draftRevision =
					frame.if && typeof frame.if === "object" ? (frame.if as Record<string, unknown>).draft : undefined;
				if (typeof draftRevision !== "number") {
					this.#reply(connection, frame, {
						success: false,
						error: "draft writes require if.draft",
						code: "precondition_required",
					});
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
					data: {
						commands: await import("../slash-commands/available-commands").then(m =>
							m.buildAvailableSlashCommands(this.#options.session),
						),
					},
				});
				return;
			case "agents":
				await this.#agents(connection, frame);
				return;
			case "cycle_role_model": {
				if (needTui()) return;
				const direction = frame.direction === "backward" ? "app.model.cycleBackward" : "app.model.cycleForward";
				const result = await presenter!.action(direction);
				this.#reply(connection, frame, { success: result.handled, data: result });
				return;
			}
			case "rewind":
				if (needTui()) return;
				this.#reply(connection, frame, { success: true, data: await presenter!.action("app.session.tree") });
				return;
			case "todo_set":
				await this.#rpc(connection, { ...frame, type: "set_todos" });
				return;
			case "wait":
				await this.#wait(connection, frame);
				return;
			case "keybindings_get":
			case "keybindings_set":
			case "keybindings_reload":
				this.#keybindings(connection, frame);
				return;
			default:
				this.#reply(connection, frame, { success: false, error: `Unknown command: ${type}` });
		}
	}

	async #wait(connection: ControlConnection, frame: Record<string, unknown>): Promise<void> {
		const timeoutMs = Math.min(Math.max(Number(frame.timeoutMs ?? 30_000) || 30_000, 0), 120_000);
		const want = String(frame.for ?? "settled");
		const started = Date.now();
		const handle = typeof frame.requestHandle === "string" ? frame.requestHandle : "";
		if (want === "request" && !handle) {
			this.#reply(connection, frame, {
				success: false,
				error: "wait for request requires requestHandle",
				code: "invalid_value",
			});
			return;
		}
		const paintBaseline = this.#revisions.paint;
		const ready = (): boolean => {
			const session = this.#options.session;
			if (want === "dialog" || want === "approval") return (this.presenter?.dialogs().length ?? 0) > 0;
			if (want === "paint") return this.#revisions.paint > Number(frame.after ?? paintBaseline);
			if (want === "request") return this.#settledHandles.has(handle);
			return !session.isStreaming && session.queuedMessageCount === 0 && !session.isCompacting;
		};
		while (!ready() && Date.now() - started < timeoutMs) {
			await Bun.sleep(50);
		}
		const settled = ready();
		this.#reply(
			connection,
			frame,
			settled
				? { success: true, data: { waited: want, revisions: this.revisions, snapshot: this.snapshot() } }
				: { success: false, error: `timed out waiting for ${want}`, code: "timeout" },
		);
	}

	#keybindings(connection: ControlConnection, frame: Record<string, unknown>): void {
		const bindings = this.presenter?.keybindings;
		if (!bindings) {
			this.#reply(connection, frame, {
				success: false,
				error: "this session has no keybindings store",
				code: "no_tui",
			});
			return;
		}
		const type = String(frame.type);
		if (type === "keybindings_reload") {
			bindings.reload();
			this.#reply(connection, frame, { success: true });
			return;
		}
		if (type === "keybindings_get") {
			const actionId = typeof frame.actionId === "string" ? frame.actionId : undefined;
			this.#reply(connection, frame, {
				success: true,
				data: actionId ? { actionId, keys: bindings.get(actionId) } : { bindings: bindings.all() },
			});
			return;
		}
		const actionId = String(frame.actionId ?? "");
		const keys = Array.isArray(frame.keys) ? frame.keys.filter((key): key is string => typeof key === "string") : [];
		const saved = bindings.set(actionId, keys);
		this.#reply(
			connection,
			frame,
			saved
				? { success: true, data: { actionId, keys } }
				: { success: false, error: "keybindings file is not writable", code: "invalid_value" },
		);
	}

	connections(): Iterable<ControlConnection> {
		return this.#connections;
	}

	/** True while the pane's approval selector is open and control may not press it. */
	setApprovalUiOpen(open: boolean): void {
		this.#approvalUiOpen = open;
	}

	blocksInjectedInput(): boolean {
		if (cfgControlApprovals.get(this.#options.session.settings) === true) return false;
		if (this.#approvalUiOpen) return true;
		return (this.presenter?.dialogs() ?? []).some(dialog => dialog.family === "approval");
	}

	#notePromptResult(frame: object): void {
		const record = frame as { type?: string; requestHandle?: string };
		if (record.type !== "prompt_result" || typeof record.requestHandle !== "string") return;
		this.#openHandles.delete(record.requestHandle);
		this.#settledHandles.add(record.requestHandle);
	}

	#closeBridges(connection: ControlConnection): void {
		const bridges = this.#bridges.get(connection);
		if (!bridges) return;
		this.#bridges.delete(connection);
		bridges.hostTools.close("control connection closed");
		bridges.hostUris.clear("control connection closed");
		bridges.approvals.close("control connection closed");
		bridges.pending.rejectAll("control connection closed");
	}

	async #routeSideChannel(connection: ControlConnection, frame: Record<string, unknown>): Promise<boolean> {
		const type = String(frame.type ?? "");
		if (
			type !== "host_tool_result" &&
			type !== "host_tool_update" &&
			type !== "host_uri_result" &&
			type !== "tool_approval_response" &&
			type !== "plan_proposal_response" &&
			type !== "extension_ui_response"
		) {
			return false;
		}
		await this.#handlerFor(connection);
		const bridges = this.#bridges.get(connection);
		if (!bridges) return false;
		const { dispatchRpcControlFrame } = await import("../modes/rpc/rpc-mode");
		const handled = dispatchRpcControlFrame(frame, {
			handleCommand: async () => ({ type: "response", command: type, success: false, error: "not a command" }),
			output: outbound => connection.write(outbound),
			errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
			pendingExtensionRequests: bridges.pending,
			onHostToolResult: result => {
				bridges.hostTools.handleResult(result);
			},
			onHostToolUpdate: update => {
				bridges.hostTools.handleUpdate(update);
			},
			onHostUriResult: result => {
				bridges.hostUris.handleResult(result);
			},
			onToolApprovalResponse: response => bridges.approvals.handleResponse(response),
			onPlanProposalResponse: response => this.#planMode?.handleProposalResponse(response),
		});
		if (!handled) return false;
		this.#reply(connection, frame, { success: true });
		return true;
	}

	#noteSessionIdentity(): void {
		const id = this.#options.session.sessionId;
		if (this.#seenSessionId === undefined) {
			this.#seenSessionId = id;
			return;
		}
		if (id !== this.#seenSessionId) {
			this.#seenSessionId = id;
			this.bumpGeneration();
		}
	}

	#settings(connection: ControlConnection, frame: Record<string, unknown>): void {
		const session = this.#options.session;
		const path = typeof frame.path === "string" ? frame.path : "";
		const type = String(frame.type);
		if (type === "settings_get" && !path) {
			this.#reply(connection, frame, {
				success: true,
				data: { approvals: cfgControlApprovals.get(session.settings) === true },
			});
			return;
		}
		const setting = lookup(path);
		if (!setting) {
			this.#reply(connection, frame, { success: false, error: `unknown setting ${path}`, code: "unknown_setting" });
			return;
		}
		if (type === "settings_get") {
			if (setting.isCredential && cfgControlSecretInput.get(session.settings) !== true) {
				this.#reply(connection, frame, {
					success: false,
					error: "credential settings stay in the pane",
					code: "secret_input_disabled",
				});
				return;
			}
			const member = typeof frame.member === "string" ? frame.member : undefined;
			this.#reply(connection, frame, {
				success: true,
				data: { path, member, value: readSetting(session.settings, path, member) },
			});
			return;
		}
		if (
			APPROVAL_GATED_SETTINGS.some(id => path === id || path.startsWith(`${id}.`)) &&
			!cfgControlApprovals.get(session.settings)
		) {
			this.#reply(connection, frame, {
				success: false,
				error: "approval settings belong to the pane (control.approvals is off)",
				code: "approval_owner_only",
			});
			return;
		}
		const member = typeof frame.member === "string" ? frame.member : undefined;
		try {
			if (type === "settings_unset") unsetSetting(session.settings, path, member);
			else writeSetting(session.settings, { path, member, value: frame.value, runtime: frame.scope === "runtime" });
			this.#notify(connection, `settings ${path}`);
			this.#reply(connection, frame, {
				success: true,
				data: { path, member, value: readSetting(session.settings, path, member) },
			});
		} catch (error) {
			this.#reply(connection, frame, {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				code: "invalid_value",
			});
		}
	}

	#mailboxId(): string {
		return `ctl:${this.instanceId.slice(0, 8)}`;
	}

	#ensureMailbox(): string {
		const id = this.#mailboxId();
		const registry = AgentRegistry.global();
		if (!registry.get(id)) {
			const root = this.#options.session.getAgentId();
			registry.register({
				id,
				displayName: "⌁ control",
				kind: "mailbox",
				parentId: root,
				session: null,
				status: "idle",
			});
		}
		return id;
	}

	async #agents(connection: ControlConnection, frame: Record<string, unknown>): Promise<void> {
		const op = String(frame.op ?? "list");
		const registry = AgentRegistry.global();
		const mailboxId = this.#ensureMailbox();
		if (op === "list") {
			this.#reply(connection, frame, {
				success: true,
				data: {
					mailboxId,
					inboxHandle: `${this.instanceId}:${mailboxId}`,
					agents: registry.list().map(ref => ({ id: ref.id, status: ref.status, kind: ref.kind })),
				},
			});
			return;
		}
		if (op === "describe") {
			const ref = registry.get(String(frame.agentId ?? frame.to ?? ""));
			this.#reply(
				connection,
				frame,
				ref
					? {
							success: true,
							data: { id: ref.id, status: ref.status, kind: ref.kind, displayName: ref.displayName },
						}
					: { success: false, error: "unknown agent", code: "unknown_agent" },
			);
			return;
		}
		if (op === "send") {
			const result = await executeSend(
				{ registry, senderId: mailboxId, sessionFileHint: this.#options.session.sessionFile },
				{ to: String(frame.to ?? ""), message: String(frame.message ?? "") },
			);
			this.#reply(connection, frame, {
				success: result.isError !== true,
				data: { ...result.details, inboxHandle: `${this.instanceId}:${mailboxId}`, from: mailboxId },
				error: result.isError
					? result.content.map(part => (part.type === "text" ? part.text : "")).join("")
					: undefined,
			});
			return;
		}
		if (op === "inbox" || op === "wait") {
			const bus = IrcBus.global();
			const from = typeof frame.from === "string" ? frame.from : undefined;
			if (op === "inbox") {
				const messages = frame.peek === true ? bus.peek(mailboxId, from) : [];
				if (frame.peek !== true) {
					const taken = bus.take(mailboxId, from);
					this.#reply(connection, frame, {
						success: true,
						data: { inboxHandle: `${this.instanceId}:${mailboxId}`, messages: taken ? [taken] : [] },
					});
					return;
				}
				this.#reply(connection, frame, {
					success: true,
					data: { inboxHandle: `${this.instanceId}:${mailboxId}`, messages },
				});
				return;
			}
			const timeoutMs = Math.min(Math.max(Number(frame.timeoutMs ?? 1000) || 1000, 0), 120_000);
			const waited = await bus.wait(mailboxId, { from }, timeoutMs);
			this.#reply(
				connection,
				frame,
				waited
					? { success: true, data: { inboxHandle: `${this.instanceId}:${mailboxId}`, message: waited } }
					: { success: false, error: "timed out waiting for mail", code: "timeout" },
			);
			return;
		}
		this.#reply(connection, frame, { success: false, error: `unsupported agents op ${op}` });
	}

	#notify(connection: ControlConnection, what: string): void {
		const text = `⌁ ${connection.label}#${connection.id}: ${what}`;
		this.presenter?.notify(text);
		this.#options.session.emitNotice("info", text, "control");
	}

	#reply(
		connection: ControlConnection,
		frame: Record<string, unknown>,
		result: { success: boolean; data?: unknown; error?: string; code?: string },
	): void {
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
export async function startControlHost(
	options: ControlHostOptions & { enabled: boolean },
): Promise<ControlHost | undefined> {
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

/**
 * The operator — the human at this process's interactive UI — as an IRC
 * participant (issue #31). She has her own id, distinct from `Main` (the model
 * that owns the composer): agents address her directly, and what she sends is
 * `from` her, never forged as `Main`. Delivery to her needs no model turn; the
 * bus shows it on her UI and records it in the operator history.
 */
import * as fs from "node:fs";
import type { IrcLogSource } from "@oh-my-pi/pi-tui/tools/irc";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import type {
	IrcClientAction,
	IrcClientHost,
	IrcClientMember,
	IrcClientRoom,
	IrcClientTarget,
} from "../modes/components/irc-client";
import { AgentRegistry, type AgentRef, type AgentRegistryApi } from "../registry/agent-registry";
import { isCurrentSessionRosterRef } from "../registry/persisted-agents";
import type { AgentSession } from "../session/agent-session";
import { writeFileAtomicallySync } from "../utils/atomic-file";
import { IrcBus } from "./bus";
import {
	ircDmId,
	ircEntryConversationId,
	ircEntryId,
	IrcClientModel,
	IRC_TRAFFIC_ID,
	IRC_NOTIFICATION_LEVELS,
	type IrcClientSnapshot,
	type IrcConversationId,
	type IrcNotificationLevel,
	ircRoomId,
	otherIrcDmPeer,
} from "./client-model";
import type { IrcGroupRequest, IrcRoomSnapshot } from "./groups";
import { ensureIrcOperatorStateDirectory, ircOperatorStatePath } from "./operator-storage";
import { cfgIrcOperatorNotifyDefault } from "./settings";

/**
 * Register `handle` as the operator under `rootId`. Returns the unregister, or
 * undefined when another participant already holds that id or the id is the
 * broadcast address `all` (the operator then stays unaddressable rather than
 * shadowing anyone).
 */
export function registerIrcOperator(
	registry: AgentRegistryApi,
	handle: string,
	rootId: string,
): (() => void) | undefined {
	if (handle === "all" || registry.get(handle)) {
		logger.warn("IRC operator handle is taken; the operator is not addressable", { handle });
		return undefined;
	}
	const ref = registry.register({
		id: handle,
		displayName: handle,
		kind: "operator",
		parentId: rootId,
		session: null,
		status: "idle",
	});
	return () => {
		registry.unregister(handle, ref);
	};
}

/**
 * The operator IRC history of the UI bound to `session()`: its root's
 * conversation. The one read side shared by the IRC viewer and the side
 * panel's IRC view; agents gain nothing from it.
 */
export function operatorIrcLogSource(session: () => AgentSession): IrcLogSource {
	const bus = IrcBus.global();
	if (!(bus instanceof IrcBus)) throw new Error("Operator IRC history is only available on the main thread");
	const registry = AgentRegistry.global();
	return {
		entries: () => {
			const root = registry.rootForSession(session());
			return root ? bus.historyForRoot(root) : [];
		},
		subscribe: listener => bus.onHistory(listener),
	};
}

/** Side-panel targets are real message or IRC peer ids, not row numbers or display names. */
export type IrcClientOpenRequest = "traffic" | { messageId: string } | { dm: string };

function isConversationId(value: unknown): value is IrcConversationId {
	return typeof value === "string" && (value === IRC_TRAFFIC_ID || value.startsWith("room:") || value.startsWith("dm:"));
}

function isNotificationOverride(value: unknown): value is [IrcConversationId, IrcNotificationLevel] {
	return Array.isArray(value) && value.length === 2 &&
		isConversationId(value[0]) && value[0] !== IRC_TRAFFIC_ID &&
		IRC_NOTIFICATION_LEVELS.some(level => level === value[1]);
}

function readSnapshot(file: string | undefined): IrcClientSnapshot | undefined {
	if (!file) return undefined;
	try {
		const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (
			isRecord(data) &&
			isConversationId(data.lastConversation) &&
			Array.isArray(data.pinned) &&
			data.pinned.every(isConversationId) &&
			Array.isArray(data.read) &&
			data.read.every(id => typeof id === "string")
		) {
			return {
				lastConversation: data.lastConversation,
				pinned: data.pinned,
				read: data.read,
				notifications: Array.isArray(data.notifications) ? data.notifications.filter(isNotificationOverride) : undefined,
			};
		}
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Could not restore IRC client state", { error });
	}
	return undefined;
}

interface OperatorIrcClientOptions {
	operatorName: string;
	operatorId?: string;
	requestRender(): void;
	reconcileOverlay(): void;
	agentDir?: string;
}

/** One model and private snapshot per owning root conversation, irrespective of transcript focus. */
export class OperatorIrcClient {
	readonly model: IrcClientModel;
	readonly host: IrcClientHost;
	readonly #bus: IrcBus;
	readonly #registry = AgentRegistry.global();
	readonly #sessionId: string;
	readonly #unsubscribeRegistry: () => void;
	readonly #unsubscribeRooms: () => void;
	readonly #statusEnteredAt = new WeakMap<AgentRef, number>();
	#rooms: readonly IrcRoomSnapshot[] = [];
	#active = false;
	#roomRefreshRunning = false;
	#roomRefreshQueued = false;
	#disposed = false;

	constructor(
		private readonly root: AgentRef,
		private readonly session: AgentSession,
		private readonly options: OperatorIrcClientOptions,
	) {
		const { operatorId, operatorName, requestRender, reconcileOverlay } = options;
		const bus = IrcBus.global();
		if (!(bus instanceof IrcBus)) throw new Error("Operator IRC client is only available on the main thread");
		this.#bus = bus;
		this.#sessionId = session.sessionManager.getSessionId();
		this.model = new IrcClientModel(
			{
				entries: () => this.#entries(),
				subscribe: listener => bus.onHistory(() => {
					reconcileOverlay();
					listener();
				}),
			},
			{
				operatorId,
				snapshot: readSnapshot(this.#snapshotFile()),
				onStateChange: snapshot => this.#save(snapshot),
				roomNotificationDefault: () => session.settings ? cfgIrcOperatorNotifyDefault.get(session.settings) : "mentions",
			},
		);
		this.host = {
			operatorId,
			operatorName,
			canCreate: operatorId !== undefined,
			rooms: () => this.#roomRows(),
			agents: () => this.#registry.list()
				.filter(ref => this.#inRoster(ref) && (ref.kind === "sub" || ref.kind === "main") && ref.status !== "aborted")
				.map(ref => this.#member(ref.id)),
			act: action => this.#act(action),
		};
		this.#unsubscribeRegistry = this.#registry.onChange(({ type, ref }) => {
			if (type === "status_changed") this.#statusEnteredAt.set(ref, ref.lastActivity);
			if (this.#active) requestRender();
		});
		this.#unsubscribeRooms = bus.onRooms(() => {
			if (this.#active) void this.#refreshRooms();
		});
	}

	setActive(active: boolean): void {
		this.#active = active;
		if (active) void this.#refreshRooms();
		else this.#roomRefreshQueued = false;
	}

	/** Live relay presentation, before the bus has appended that delivery to the ledger. */
	relayNotifies(details: unknown): boolean {
		if (!this.#isCurrent() || !isRecord(details)) return false;
		const { from, to, body, group, groupText, broadcast } = details;
		return this.model.notifies({
			message: {
				from: typeof from === "string" ? from : undefined,
				to: typeof to === "string" ? to : undefined,
				body: typeof body === "string" ? body : undefined,
				group: typeof group === "string" ? group : undefined,
				groupText: typeof groupText === "string" ? groupText : undefined,
			},
			broadcast: broadcast === true,
			outcome: "injected",
		});
	}

	resolveTarget(request: Exclude<IrcClientOpenRequest, "traffic">): IrcClientTarget | undefined {
		if ("dm" in request) {
			const operatorId = this.host.operatorId;
			if (!operatorId || operatorId === request.dm) return undefined;
			const peer = this.#registry.get(request.dm);
			const conversationId = ircDmId(operatorId, request.dm);
			return (peer && this.#inRoster(peer)) || this.model.entries(conversationId).length > 0
				? { conversationId }
				: undefined;
		}
		const entry = this.#entries().find(candidate =>
			candidate.message.id === request.messageId || ircEntryId(candidate) === request.messageId,
		);
		return entry && { conversationId: ircEntryConversationId(entry), entryId: ircEntryId(entry) };
	}

	dispose(): void {
		this.#disposed = true;
		this.setActive(false);
		this.#unsubscribeRegistry();
		this.#unsubscribeRooms();
		this.model.dispose();
	}

	#isCurrent(): boolean {
		return !this.#disposed &&
			this.#registry.get(this.root.id) === this.root &&
			this.root.session === this.session &&
			this.session.sessionManager.getSessionId() === this.#sessionId;
	}

	#entries() {
		return this.#isCurrent() ? this.#bus.historyForRoot(this.root) : [];
	}

	#snapshotFile(): string | undefined {
		return this.session.sessionManager.getSessionFile()
			? ircOperatorStatePath(this.#sessionId, "client.json", this.options.agentDir)
			: undefined;
	}

	#save(snapshot: IrcClientSnapshot): void {
		if (!this.#isCurrent()) return;
		const file = this.#snapshotFile();
		if (!file) return;
		try {
			ensureIrcOperatorStateDirectory(file);
			writeFileAtomicallySync(file, JSON.stringify(snapshot));
		} catch (error) {
			logger.warn("Could not save IRC client state", { error });
		}
	}

	#inRoster(ref: AgentRef): boolean {
		return this.#registry.rootOf(ref.id) === this.root &&
			isCurrentSessionRosterRef(ref, this.session.sessionManager.getSessionFile()) &&
			!ref.history?.readOnly;
	}

	#member(id: string): IrcClientMember {
		const ref = this.#registry.get(id);
		const modelSlug = ref?.session?.servingModel?.selector ?? ref?.session?.model?.id ?? ref?.history?.resolvedModel ?? "";
		return {
			id,
			name: id,
			modelSlug,
			status: ref?.status ?? "parked",
			statusEnteredAt: ref && (this.#statusEnteredAt.get(ref) ?? ref.session?.runStartedAt),
			agentType: ref?.history?.agent ?? ref?.kind,
			activity: ref?.activity,
		};
	}

	#roomRows(): IrcClientRoom[] {
		return this.#rooms.map(room => {
			const { name, permissions, mute } = room;
			const joined = this.host.operatorId !== undefined && room.joined;
			const capabilities: NonNullable<IrcClientRoom["capabilities"]>[number][] = [];
			if (this.host.operatorId !== undefined) {
				if (!joined) capabilities.push("join-silent", "join-announce", "join-invisible");
				else {
					capabilities.push("notifications", "leave");
					if (permissions.invite) capabilities.push("invite");
					if (permissions.admin) capabilities.push("mute", "remove", "permissions");
				}
			}
			return {
				name,
				joined,
				canSend: joined && permissions.send && !mute,
				notifications: joined ? this.model.notificationLevel(ircRoomId(name)) : undefined,
				members: room.members.map(member => ({
					...this.#member(member.id),
					muted: member.mute !== undefined,
					permissions: member.permissions,
				})),
				capabilities,
			};
		});
	}

	async #refreshRooms(): Promise<void> {
		if (!this.#active || !this.#isCurrent()) return;
		this.#roomRefreshQueued = true;
		if (this.#roomRefreshRunning) return;
		this.#roomRefreshRunning = true;
		try {
			// Multiple mutations can publish before a single roster read settles.
			while (this.#roomRefreshQueued && this.#active && this.#isCurrent()) {
				this.#roomRefreshQueued = false;
				const actor = this.host.operatorId ?? this.root.id;
				const rooms = await this.#bus.roomsForRoot(this.root, actor);
				if (!this.#active || !this.#isCurrent()) continue;
				this.#rooms = rooms;
				this.options.requestRender();
			}
		} catch (error) {
			logger.warn("Could not refresh the IRC room roster", { error });
		} finally {
			this.#roomRefreshRunning = false;
		}
	}

	async #act(action: IrcClientAction): Promise<string | undefined> {
		if (!this.#isCurrent()) return t("overlays.irc_client.session_changed");
		const actor = this.host.operatorId;
		const operator = actor && this.#registry.get(actor);
		if (!actor || !operator || operator.kind !== "operator" || operator.parentId !== this.root.id) {
			return t("overlays.interactive_mode.irc_not_participant");
		}
		try {
			let request: IrcGroupRequest;
			switch (action.kind) {
				case "send": {
					const { conversationId, text } = action;
					if (conversationId.startsWith("room:")) {
						request = { op: "send", group: conversationId.slice(5), message: text };
						break;
					}
					const peer = otherIrcDmPeer(conversationId, actor);
					if (!peer) return t("overlays.irc_client.read_only");
					const recipient = this.#registry.get(peer);
					if (recipient && !this.#inRoster(recipient)) return t("overlays.irc_client.read_only");
					const receipt = await this.#bus.send({ from: actor, to: peer, body: text, localOnly: true });
					return receipt.outcome === "failed" ? receipt.error ?? t("overlays.irc_client.send_failed") : undefined;
				}
				case "create":
					request = { op: "create", group: action.room, members: [actor], notice: "silent" };
					break;
				case "join":
					request = { op: "join", group: action.room, mode: action.mode };
					break;
				case "leave":
					request = { op: "leave", group: action.room };
					break;
				case "notifications": {
					const { conversationId } = action;
					if (conversationId.startsWith("room:")) {
						const rooms = await this.#bus.roomsForRoot(this.root, actor);
						if (!this.#isCurrent() || this.#registry.get(actor) !== operator) return t("overlays.irc_client.session_changed");
						const room = rooms.find(candidate => candidate.name === conversationId.slice(5));
						if (!room?.joined) return t("overlays.irc_client.read_only");
					} else if (!otherIrcDmPeer(conversationId, actor)) {
						return t("overlays.irc_client.read_only");
					}
					this.model.setNotificationLevel(conversationId, action.level);
					return undefined;
				}
				case "invite": {
					const { roomId, agentIds, noticeMode } = action.confirmation;
					const members = [...new Set(agentIds)];
					if (members.length === 0 || members.some(id => {
						const ref = this.#registry.get(id);
						return !ref || !this.#inRoster(ref) || (ref.kind !== "sub" && ref.kind !== "main") || ref.status === "aborted";
					})) return t("overlays.irc_client.read_only");
					request = { op: "invite", group: roomId, members, notice: noticeMode };
					break;
				}
				case "mute":
					request = { op: action.muted ? "mute" : "unmute", group: action.room, member: action.memberId };
					break;
				case "remove":
					request = { op: "remove", group: action.room, members: [action.memberId] };
					break;
				case "permission":
					request = {
						op: "permit",
						group: action.room,
						members: [action.memberId],
						permissions: { [action.permission]: action.enabled },
					};
					break;
			}
			if (request.op !== "create") {
				const { group } = request;
				const rooms = await this.#bus.roomsForRoot(this.root, actor);
				if (!this.#isCurrent() || this.#registry.get(actor) !== operator) return t("overlays.irc_client.session_changed");
				const room = rooms.find(candidate => candidate.name === group);
				if (!room || (!room.joined && request.op !== "join")) return t("overlays.irc_client.read_only");
			}
			const result = await this.#bus.group(actor, request);
			if (result.isError) return result.text;
			const failures = result.receipts?.filter(receipt => receipt.outcome === "failed");
			if (failures?.length) {
				const recipients = failures.map(({ to, error }) => error ? `${to}: ${error}` : to).join("; ");
				return t("overlays.irc_client.partial_delivery", { recipients, summary: result.text });
			}
			if (request.op === "invite") {
				const added = new Set(result.affected);
				const notified = request.notice !== "silent" ? new Set(result.receipts?.map(receipt => receipt.to)) : undefined;
				if (request.members.some(id => !added.has(id) || (notified && !notified.has(id)))) {
					return t("overlays.irc_client.partial_invite", { summary: result.text });
				}
			}
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}
}

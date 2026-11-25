import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import messageTemplate from "../prompts/system/irc-group-message.md" with { type: "text" };
import reminderTemplate from "../prompts/system/irc-group-reminder.md" with { type: "text" };
import type { AgentRef, AgentRegistryApi } from "../registry/agent-registry";
import { isCurrentSessionRosterRef } from "../registry/persisted-agents";
import type { SessionEntry } from "../session/session-entries";
import type { IrcBusApi } from "./bus";
import {
	activeMute,
	DEFAULT_PERMISSIONS,
	effectivePermissions,
	type IrcInviteNoticeMode,
	type IrcMemberPolicy,
	type IrcRoomJoinMode,
	type IrcRoomMute,
	type IrcRoomPermissions,
	mayLiftMute,
	missingGrant,
	muteDeadline,
	patchPermissions,
	samePermissions,
} from "./room-policy";

export type { IrcInviteNoticeMode, IrcRoomJoinMode, IrcRoomMute, IrcRoomPermissions } from "./room-policy";

export const IRC_EVERYONE = "everyone";
export const IRC_SINGLE_MEMBER_MINUTES = 10;
export const IRC_KEEP_MINUTES = 5;
const MINUTE_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export type IrcGroupRequest =
	| { op: "send"; group: string; message: string }
	| {
			op: "create" | "add" | "invite";
			group: string;
			members: string[];
			permissions?: Partial<IrcRoomPermissions>;
			notice?: IrcInviteNoticeMode;
	  }
	| { op: "join"; group: string; mode: IrcRoomJoinMode }
	| { op: "remove"; group: string; members: string[] }
	| { op: "permit"; group: string; members: string[]; permissions: Partial<IrcRoomPermissions> }
	| { op: "mute"; group: string; member?: string; duration?: string }
	| { op: "unmute"; group: string; member?: string }
	| { op: "leave"; group: string }
	| { op: "members"; group: string }
	| { op: "keep"; group: string; reason: string }
	| { op: "groups" | "my_groups" };

export interface IrcGroupResult {
	text: string;
	isError?: boolean;
	receipts?: IrcDeliveryReceipt[];
	/** Structured values backing the read-only group listing operations. */
	groups?: string[];
	members?: string[];
	rooms?: IrcRoomSnapshot[];
	room?: IrcRoomSnapshot;
	/** Members actually changed; a failed delivery receipt does not undo membership. */
	affected?: string[];
}

export interface IrcRoomMember {
	id: string;
	/** Effective grant (Admin implies the other rights); mute is a separate traffic gate. */
	permissions: IrcRoomPermissions;
	mute?: IrcRoomMute;
}

export interface IrcRoomSnapshot {
	name: string;
	/** Visible roster; an invisible operator is omitted even in her own view. */
	members: IrcRoomMember[];
	joined: boolean;
	joinMode?: IrcRoomJoinMode;
	/** The actor's grant; traffic is also gated by membership and mute policy. */
	permissions: IrcRoomPermissions;
	mute?: IrcRoomMute;
	deadline?: number;
}

interface Group {
	members: Set<string>;
	policies: Map<string, IrcMemberPolicy>;
	creator?: string;
	deadline?: number;
	timer?: NodeJS.Timeout;
}

export const IRC_GROUPS_CUSTOM_TYPE = "irc-groups";

export interface IrcGroupSnapshot {
	groups: { name: string; members: string[]; deadline?: number; creator?: string; policies?: PersistedPolicies }[];
	everyoneOptOuts: string[];
	everyoneAdvisors: string[];
	everyonePolicies?: PersistedPolicies;
}

type PersistedPolicies = [id: string, policy: IrcMemberPolicy][];

export function readIrcGroupSnapshot(branch: readonly SessionEntry[]): IrcGroupSnapshot | undefined {
	for (let i = branch.length - 1; i >= 0; --i) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === IRC_GROUPS_CUSTOM_TYPE) {
			const snapshot = entry.data as IrcGroupSnapshot | undefined;
			if (
				Array.isArray(snapshot?.groups) &&
				Array.isArray(snapshot.everyoneOptOuts) &&
				Array.isArray(snapshot.everyoneAdvisors)
			)
				return snapshot;
		}
	}
	return undefined;
}

interface GroupPersistence {
	isCurrent(): boolean;
	save(snapshot: IrcGroupSnapshot): void;
}

interface GroupOptions {
	includes(ref: AgentRef): boolean;
	deliverInvite(
		from: string,
		to: string,
		group: string,
		mode: IrcInviteNoticeMode,
		fanoutId?: string,
	): Promise<IrcDeliveryReceipt | undefined>;
}

function newGroup(creator?: string): Group {
	return { members: new Set(), policies: new Map(), creator };
}

function refused(text: string): IrcGroupResult {
	return { text, isError: true };
}

function isParticipant(ref: AgentRef | undefined): ref is AgentRef {
	if (!ref || ref.status === "aborted" || ref.kind === "mailbox") return false;
	// Live advisors can speak and belong to named groups, but the bus still
	// refuses incoming messages to their read-only transcripts.
	if (ref.kind === "advisor") return ref.status === "idle" || ref.status === "running";
	return !ref.history?.readOnly;
}

/** Main IRC host's address lists. Messages still live only in each recipient's own session. */
export class IrcGroups {
	readonly #everyone = newGroup();
	readonly #groups = new Map([[IRC_EVERYONE, this.#everyone]]);
	readonly #everyoneOptOuts: Set<string>;
	readonly #everyoneAdvisors: Set<string>;
	readonly #listeners = new Set<() => void>();
	readonly #unsubscribe: () => void;
	#muteTimer?: NodeJS.Timeout;
	#restorePending: boolean;
	#disposed = false;

	constructor(
		private readonly registry: AgentRegistryApi,
		private readonly bus: Pick<IrcBusApi, "send">,
		snapshot: IrcGroupSnapshot | undefined,
		private readonly persistence: GroupPersistence | undefined,
		private readonly options: GroupOptions,
	) {
		this.#restorePending = snapshot !== undefined;
		this.#everyoneOptOuts = new Set(snapshot?.everyoneOptOuts);
		this.#everyoneAdvisors = new Set(snapshot?.everyoneAdvisors);
		this.#everyone.policies = new Map(snapshot?.everyonePolicies);
		for (const ref of registry.list()) {
			if (this.#joinsEveryone(ref)) this.#everyone.members.add(ref.id);
		}
		this.#unsubscribe = registry.onChange(({ type, ref }) => {
			if (!this.#isCurrent() || this.#restorePending) return;
			if (type === "removed" || !this.#includes(ref)) {
				let save = this.#everyoneAdvisors.delete(ref.id);
				let changed = false;
				for (const [name, group] of this.#groups) {
					if (!group.members.delete(ref.id)) continue;
					changed = true;
					this.#resize(name, group);
					if (name !== IRC_EVERYONE) save = true;
				}
				if (save || changed) this.#changed(save);
			} else if (this.#joinsEveryone(ref) && !this.#everyone.members.has(ref.id)) {
				this.#everyone.members.add(ref.id);
				this.#changed(false);
			}
		});
	}

	/** Prune against the registry only after the persisted child roster has been loaded. */
	restore(snapshot: IrcGroupSnapshot, sessionFile: string | undefined): void {
		if (!this.#isCurrent()) return;
		let changed = false;
		for (const id of this.#everyoneAdvisors) {
			if (!this.#isRestorableMember(id, sessionFile)) {
				this.#everyoneAdvisors.delete(id);
				changed = true;
			}
		}
		this.#everyone.members.clear();
		for (const ref of this.registry.list()) {
			if (this.#joinsEveryone(ref)) this.#everyone.members.add(ref.id);
		}
		for (const { name, members, deadline, creator, policies } of snapshot.groups) {
			if (name === IRC_EVERYONE) continue;
			const group: Group = {
				creator,
				members: new Set(members.filter(id => this.#isRestorableMember(id, sessionFile))),
				policies: new Map(policies),
			};
			if (group.members.size !== members.length) changed = true;
			if (!group.members.size || (group.members.size === 1 && deadline !== undefined && deadline <= Date.now())) {
				changed = true;
				continue;
			}
			this.#groups.set(name, group);
			if (group.members.size === 1) {
				if (deadline === undefined) {
					this.#resize(name, group);
					changed = true;
				} else {
					this.#scheduleExpiry(name, group, deadline);
				}
			} else if (deadline !== undefined) {
				changed = true;
			}
		}
		this.#restorePending = false;
		const expired = this.#clearExpiredMutes();
		this.#changed(changed || expired);
	}

	#isCurrent(): boolean {
		return !this.#disposed && (this.persistence?.isCurrent() ?? true);
	}

	#includes(ref: AgentRef | undefined): ref is AgentRef {
		return isParticipant(ref) && this.options.includes(ref);
	}

	#isRestorableMember(id: string, sessionFile: string | undefined): boolean {
		const ref = this.registry.get(id);
		return this.#includes(ref) && isCurrentSessionRosterRef(ref, sessionFile);
	}

	#joinsEveryone(ref: AgentRef): boolean {
		return (
			this.#includes(ref) &&
			!this.#everyoneOptOuts.has(ref.id) &&
			(ref.kind !== "advisor" || this.#everyoneAdvisors.has(ref.id))
		);
	}

	#save(persistence: GroupPersistence): void {
		const groups: IrcGroupSnapshot["groups"] = [];
		for (const [name, { members, creator, deadline, policies }] of this.#groups) {
			if (name !== IRC_EVERYONE) {
				groups.push({ name, members: [...members], deadline, creator, policies: policies.size ? [...policies] : undefined });
			}
		}
		persistence.save({
			groups,
			everyoneOptOuts: [...this.#everyoneOptOuts],
			everyoneAdvisors: [...this.#everyoneAdvisors],
			everyonePolicies: this.#everyone.policies.size ? [...this.#everyone.policies] : undefined,
		});
	}

	#changed(save = true): void {
		if (!this.#isCurrent() || this.#restorePending) return;
		if (save && this.persistence) this.#save(this.persistence);
		this.#scheduleMuteExpiry();
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				logger.debug("IRC room change listener failed", { error: String(error) });
			}
		}
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		this.#listeners.clear();
		clearTimeout(this.#muteTimer);
		for (const group of this.#groups.values()) clearTimeout(group.timer);
	}

	#actor(id: string): AgentRef | undefined {
		if (!this.#isCurrent() || this.#restorePending) return undefined;
		const ref = this.registry.get(id);
		return this.#includes(ref) ? ref : undefined;
	}

	#permissions(ref: AgentRef, group: Group): Readonly<IrcRoomPermissions> {
		return effectivePermissions(group.policies.get(ref.id), group.members.has(ref.id), this.#intrinsicAdmin(ref, group));
	}

	#intrinsicAdmin(ref: AgentRef, group: Group): boolean {
		return ref.kind === "main" || ref.kind === "operator" || ref.id === group.creator;
	}

	#room(actor: AgentRef, name: string, group: Group): IrcRoomSnapshot {
		const now = Date.now();
		const members: IrcRoomMember[] = [];
		for (const id of group.members) {
			const ref = this.registry.get(id);
			const policy = group.policies.get(id);
			if (!this.#includes(ref) || policy?.joinMode === "invisible") continue;
			const mute = activeMute(policy, now);
			members.push({ id, permissions: { ...this.#permissions(ref, group) }, mute: mute && { ...mute } });
		}
		const joined = group.members.has(actor.id);
		const policy = group.policies.get(actor.id);
		const mute = activeMute(policy, now);
		return {
			name,
			members,
			joined,
			joinMode: joined ? policy?.joinMode : undefined,
			permissions: { ...this.#permissions(actor, group) },
			mute: mute && { ...mute },
			deadline: group.deadline,
		};
	}

	snapshot(sender: string): IrcRoomSnapshot[] {
		const actor = this.#actor(sender);
		return actor ? Array.from(this.#groups, ([name, group]) => this.#room(actor, name, group)) : [];
	}

	#mayReceive(group: Group, id: string): boolean {
		if (!group.members.has(id) || activeMute(group.policies.get(id))) return false;
		const ref = this.registry.get(id);
		return this.#includes(ref) && this.#permissions(ref, group).receive;
	}

	#sendError(actor: AgentRef, group: Group, name: string): string | undefined {
		if (activeMute(group.policies.get(actor.id))) return `You are muted in IRC group ${name}. Unmute first.`;
		// The primary and creator can speak without adding themselves. The
		// operator, who can inspect rooms read-only, must explicitly join.
		if (!group.members.has(actor.id) && (actor.kind === "operator" || !this.#intrinsicAdmin(actor, group))) {
			return `Join IRC group ${name} before sending.`;
		}
		if (!this.#permissions(actor, group).send) return `Send permission is required in IRC group ${name}.`;
	}

	filterBroadcastTargets(sender: string, targets: string[]): string[] {
		const actor = this.#actor(sender);
		if (!actor || this.#sendError(actor, this.#everyone, IRC_EVERYONE)) return [];
		return targets.filter(id => this.#mayReceive(this.#everyone, id));
	}

	/** Visible named groups holding both peers; metadata must not reveal invisible membership. */
	shared(a: string, b: string, exclude?: string): string[] {
		if (!this.#actor(a) || !this.#actor(b)) return [];
		const names: string[] = [];
		for (const [name, group] of this.#groups) {
			if (name === IRC_EVERYONE || name === exclude) continue;
			if (!group.members.has(a) || !group.members.has(b)) continue;
			if (group.policies.get(a)?.joinMode === "invisible" || group.policies.get(b)?.joinMode === "invisible") continue;
			names.push(name);
		}
		return names;
	}

	async execute(sender: string, request: IrcGroupRequest): Promise<IrcGroupResult> {
		const actor = this.#actor(sender);
		if (!actor) return refused(`Unknown IRC participant ${sender} in this session.`);
		if (!("group" in request)) {
			const rooms = this.snapshot(sender).filter(room => request.op === "groups" || room.joined);
			const rows = rooms.map(room => `${room.name} (${room.members.length})`);
			return { text: rows.join("\n") || "No IRC groups.", groups: rooms.map(room => room.name), rooms };
		}

		const name = request.group.trim();
		const group = this.#groups.get(name);
		if (request.op === "create") {
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
				return refused(
					"Use an IRC group name made of letters, digits, hyphens, or underscores, starting with a letter or digit.",
				);
			}
			if (group) return refused(`IRC group ${name} already exists.`);
			return this.#add(actor, name, newGroup(sender), request, true);
		}
		if (!group) return refused(`Unknown IRC group ${name}.`);

		switch (request.op) {
			case "send": {
				if (!request.message.trim()) return refused("A non-empty message is required.");
				const denied = this.#sendError(actor, group, name);
				if (denied) return refused(denied);
				const heading = renderPromptAsset("system/irc-group-message.md", messageTemplate, {
					sender: actor.kind === "operator" ? "The operator" : sender,
					group: name,
				}).trimEnd();
				const receipts = await this.#fanout(sender, name, group, `${heading}\n\n${request.message}`, request.message);
				const failed = receipts.filter(receipt => receipt.outcome === "failed");
				const delivered = receipts.length - failed.length;
				return {
					text: [
						`Delivered to ${delivered} of ${receipts.length} member(s) of IRC group ${name}.`,
						...failed.map(receipt => `${receipt.to}: ${receipt.error ?? "delivery failed"}`),
					].join("\n"),
					receipts,
					isError: delivered === 0,
				};
			}
			case "members": {
				const room = this.#room(actor, name, group);
				const members = room.members.map(member => member.id);
				const now = Date.now();
				const rows = room.members.map(({ id, permissions, mute }) => {
					const badges: string[] = [];
					if (mute) {
						const remaining =
							mute.until === undefined ? "until unmuted" : `${Math.ceil((mute.until - now) / MINUTE_MS)}m left`;
						badges.push(`muted by ${mute.by}, ${remaining}`);
					}
					// Intrinsic admin does not represent an explicit member grant.
					if (group.policies.get(id)?.permissions?.admin) badges.push("admin");
					if (!permissions.receive) badges.push("Receive off");
					if (!permissions.send) badges.push("Send off");
					if (!permissions.invite) badges.push("Invite off");
					return badges.length ? `${id} (${badges.join("; ")})` : id;
				});
				return { text: `Members of IRC group ${name}: ${rows.join(", ") || "none"}.`, members, room };
			}
			case "join":
				return this.#join(actor, name, group, request.mode);
			case "add":
			case "invite":
				return this.#add(actor, name, group, request, false);
			case "remove":
				return this.#remove(actor, name, group, request.members);
			case "leave":
				return this.#remove(actor, name, group, [sender]);
			case "permit":
				return this.#permit(actor, name, group, request.members, request.permissions);
			case "mute":
				return this.#mute(actor, name, group, request.member, false, request.duration);
			case "unmute":
				return this.#mute(actor, name, group, request.member, true);
			case "keep": {
				if (!group.members.has(sender) || group.deadline === undefined) {
					return refused("Only the sole member of an expiring group can extend it.");
				}
				const reason = request.reason.trim();
				if (!reason) return refused("A reason is required to keep a group.");
				this.#scheduleExpiry(name, group, group.deadline + IRC_KEEP_MINUTES * MINUTE_MS);
				this.#changed();
				return { text: `Kept IRC group ${name} for ${IRC_KEEP_MINUTES} more minutes: ${reason}` };
			}
		}
		return refused("Unknown IRC group operation.");
	}

	async #fanout(
		from: string,
		name: string,
		group: Group,
		body: string,
		groupText: string,
		noWake?: boolean,
	): Promise<IrcDeliveryReceipt[]> {
		const fanoutId = Snowflake.next();
		const legs: Promise<IrcDeliveryReceipt | undefined>[] = [];
		for (const to of group.members) {
			if (!this.#isCurrent() || !this.#mayReceive(group, to)) continue;
			const hidden = to !== from && group.policies.get(to)?.joinMode === "invisible";
			legs.push(
				this.bus
					.send(
						{ from, to, body, localOnly: true, broadcast: true, group: name, groupText, fanoutId },
						{ suppressRelay: true, broadcast: true, groupDelivery: true, noWake },
					)
					.then(
						receipt => (hidden ? undefined : receipt),
						(error): IrcDeliveryReceipt | undefined =>
							hidden ? undefined : { to, outcome: "failed", error: String(error) },
					),
			);
		}
		return (await Promise.all(legs)).filter(receipt => receipt !== undefined);
	}

	#addMember(name: string, group: Group, ref: AgentRef): void {
		group.members.add(ref.id);
		if (name === IRC_EVERYONE) {
			this.#everyoneOptOuts.delete(ref.id);
			if (ref.kind === "advisor") this.#everyoneAdvisors.add(ref.id);
		}
	}

	async #join(actor: AgentRef, name: string, group: Group, mode: IrcRoomJoinMode): Promise<IrcGroupResult> {
		if (actor.kind !== "operator") return refused("Only the operator can use room entry modes; use add to join yourself.");
		if (mode !== "silent" && mode !== "announce" && mode !== "invisible") return refused("Unknown IRC entry mode.");
		const joined = group.members.has(actor.id);
		const policy = group.policies.get(actor.id);
		if (joined && policy?.joinMode === mode) {
			return { text: `Already in IRC group ${name}.`, affected: [], room: this.#room(actor, name, group) };
		}
		if (mode === "announce" && activeMute(policy)) {
			return refused(`You are muted in IRC group ${name}. Unmute first to announce your entry.`);
		}
		this.#addMember(name, group, actor);
		group.policies.set(actor.id, { ...policy, joinMode: mode });
		if (!joined) this.#resize(name, group, false);
		this.#changed();
		const result = { affected: [actor.id], room: this.#room(actor, name, group) };
		if (mode !== "announce") return { text: `Joined IRC group ${name}.`, ...result };
		const line = `${actor.displayName} joined #${name}.`;
		const receipts = await this.#fanout(actor.id, name, group, line, line, true);
		return { text: line, ...result, receipts };
	}

	async #add(
		actor: AgentRef,
		name: string,
		group: Group,
		request: { members: string[]; permissions?: Partial<IrcRoomPermissions>; notice?: IrcInviteNoticeMode },
		create: boolean,
	): Promise<IrcGroupResult> {
		const ids = new Set(request.members.map(id => id.trim()));
		if (!ids.size) return refused("At least one IRC member is required.");
		const notice = request.notice ?? "next-turn";
		if (notice !== "next-turn" && notice !== "wake-now" && notice !== "verbose" && notice !== "silent") {
			return refused("Unknown IRC invite notice mode.");
		}
		const rights = this.#permissions(actor, group);
		const pending: { ref: AgentRef; permissions: IrcRoomPermissions }[] = [];
		for (const id of ids) {
			const ref = this.registry.get(id);
			if (!this.#includes(ref)) return refused(`Unknown IRC participant ${JSON.stringify(id)} in this session.`);
			const self = id === actor.id;
			if (!self && !rights.invite) return refused(`Invite permission is required in IRC group ${name}.`);
			if (group.members.has(id)) {
				if (request.permissions) {
					const missing = missingGrant(rights, request.permissions);
					if (missing) return refused(`Cannot grant ${missing} permission you do not have in IRC group ${name}.`);
				}
				continue;
			}
			const policy = group.policies.get(id);
			const previous = policy?.permissions ?? DEFAULT_PERMISSIONS;
			const permissions = patchPermissions(previous, request.permissions);
			if (policy?.permissions && !samePermissions(previous, permissions)) {
				return refused(`Cannot change ${id}'s saved permissions by re-adding them. Use permit after they join.`);
			}
			// Open self-join can recover a previous grant or the default grant,
			// but it must never widen that grant. Invitations use the inviter's ceiling.
			const ceiling = self && !rights.admin ? effectivePermissions(policy, true, false) : rights;
			const missing = missingGrant(ceiling, permissions);
			if (missing) return refused(`Cannot grant ${missing} permission you do not have in IRC group ${name}.`);
			pending.push({ ref, permissions });
		}
		if (!pending.length) {
			return { text: `No new members added to IRC group ${name}.`, affected: [], room: this.#room(actor, name, group) };
		}
		for (const { ref, permissions } of pending) {
			this.#addMember(name, group, ref);
			const policy = group.policies.get(ref.id);
			if (!samePermissions(permissions, DEFAULT_PERMISSIONS) || policy?.joinMode) {
				group.policies.set(ref.id, { ...policy, permissions, joinMode: undefined });
			}
		}
		if (create) this.#groups.set(name, group);
		this.#resize(name, group, notice !== "silent");
		this.#changed();
		const affected = pending.map(({ ref }) => ref.id);
		const room = this.#room(actor, name, group);
		const notices: Promise<IrcDeliveryReceipt>[] = [];
		if (notice !== "silent") {
			const fanoutId = affected.length > 1 ? Snowflake.next() : undefined;
			for (const to of affected) {
				if (!this.#isCurrent() || !this.#mayReceive(group, to)) continue;
				notices.push(this.#inviteNotice(actor.id, to, name, notice, fanoutId));
			}
		}
		return {
			text: `${create ? "Created" : "Updated"} IRC group ${name}; added ${affected.join(", ")}.`,
			affected,
			room,
			receipts: await Promise.all(notices),
		};
	}

	async #inviteNotice(
		from: string,
		to: string,
		name: string,
		mode: Exclude<IrcInviteNoticeMode, "silent">,
		fanoutId?: string,
	): Promise<IrcDeliveryReceipt> {
		try {
			const receipt = await this.options.deliverInvite(from, to, name, mode, fanoutId);
			return receipt ?? { to, outcome: "failed", error: "The invite notice was not delivered." };
		} catch (error) {
			return { to, outcome: "failed", error: String(error) };
		}
	}

	#remove(actor: AgentRef, name: string, group: Group, members: string[]): IrcGroupResult {
		const ids = new Set(members.map(id => id.trim()));
		const admin = this.#permissions(actor, group).admin;
		for (const id of ids) {
			if (id !== actor.id && !admin) return refused(`Admin permission is required to remove others from IRC group ${name}.`);
			if (!this.#includes(this.registry.get(id))) return refused(`Unknown IRC participant ${JSON.stringify(id)} in this session.`);
		}
		const affected: string[] = [];
		let visiblyChanged = false;
		for (const id of ids) {
			const policy = group.policies.get(id);
			if (policy?.joinMode === "invisible" && id !== actor.id) continue;
			if (!group.members.delete(id)) continue;
			affected.push(id);
			visiblyChanged ||= policy?.joinMode !== "invisible";
			if (policy?.joinMode) group.policies.set(id, { ...policy, joinMode: undefined });
			if (name === IRC_EVERYONE) {
				this.#everyoneOptOuts.add(id);
				this.#everyoneAdvisors.delete(id);
			}
		}
		if (!affected.length) return refused(`No matching members in IRC group ${name}.`);
		this.#resize(name, group, visiblyChanged);
		this.#changed();
		const remains = this.#groups.has(name);
		return {
			text: `Removed ${affected.join(", ")} from IRC group ${name}.${remains ? "" : " Empty group deleted."}`,
			affected,
			room: remains ? this.#room(actor, name, group) : undefined,
		};
	}

	#permit(
		actor: AgentRef,
		name: string,
		group: Group,
		members: string[],
		patch: Partial<IrcRoomPermissions>,
	): IrcGroupResult {
		const rights = this.#permissions(actor, group);
		if (!rights.admin) return refused(`Admin permission is required to edit permissions in IRC group ${name}.`);
		const ids = new Set(members.map(id => id.trim()));
		if (!ids.size) return refused("At least one IRC member is required.");
		const updates = new Map<string, IrcMemberPolicy>();
		for (const id of ids) {
			const ref = this.registry.get(id);
			const policy = group.policies.get(id);
			if (!this.#includes(ref) || !group.members.has(id) || (policy?.joinMode === "invisible" && id !== actor.id)) {
				return refused(`Unknown member ${JSON.stringify(id)} in IRC group ${name}.`);
			}
			if (this.#intrinsicAdmin(ref, group)) return refused(`${id} is an administrator of IRC group ${name} by role.`);
			const previous = policy?.permissions ?? DEFAULT_PERMISSIONS;
			const permissions = patchPermissions(previous, patch);
			if (!samePermissions(previous, permissions)) updates.set(id, { ...policy, permissions });
		}
		for (const [id, policy] of updates) group.policies.set(id, policy);
		if (updates.size) this.#changed();
		const affected = [...updates.keys()];
		return {
			text: affected.length ? `Updated permissions for ${affected.join(", ")} in IRC group ${name}.` : "No permissions changed.",
			affected,
			room: this.#room(actor, name, group),
		};
	}

	#mute(
		actor: AgentRef,
		name: string,
		group: Group,
		member: string | undefined,
		lift: boolean,
		duration?: string,
	): IrcGroupResult {
		const id = member?.trim() || actor.id;
		const self = id === actor.id;
		const admin = this.#permissions(actor, group).admin;
		if (!self && !admin) {
			return refused(`Admin permission is required to ${lift ? "unmute" : "mute"} others in IRC group ${name}.`);
		}
		const policy = group.policies.get(id);
		if (!this.#includes(this.registry.get(id)) || !group.members.has(id) || (policy?.joinMode === "invisible" && !self)) {
			return refused(`Unknown member ${JSON.stringify(id)} in IRC group ${name}.`);
		}
		const operator = actor.kind === "operator";
		const existing = activeMute(policy);
		if (existing && !mayLiftMute(existing, actor.id, admin, operator)) {
			const hint =
				existing.authority === "operator"
					? " Send the operator a direct message explaining why you want to be unmuted."
					: "";
			return refused(
				`${id} was muted by ${existing.by} in IRC group ${name}; you cannot ${lift ? "lift" : "replace"} that mute.${hint}`,
			);
		}
		if (lift && !existing) {
			return { text: `${id} is not muted in IRC group ${name}.`, affected: [], room: this.#room(actor, name, group) };
		}
		const until = muteDeadline(duration);
		if (Number.isNaN(until)) return refused("Use a positive mute duration in minutes or hours, such as 30m or 2h.");
		const authority = operator ? "operator" : self && existing?.authority !== "admin" ? "self" : "admin";
		group.policies.set(id, { ...policy, mute: lift ? undefined : { by: actor.id, authority, until } });
		this.#changed();
		return {
			text: `${lift ? "Unmuted" : "Muted"} ${id} in IRC group ${name}.`,
			affected: [id],
			room: this.#room(actor, name, group),
		};
	}

	#clearExpiredMutes(): boolean {
		let changed = false;
		const now = Date.now();
		for (const group of this.#groups.values()) {
			for (const [id, policy] of group.policies) {
				if (!policy.mute || activeMute(policy, now)) continue;
				group.policies.set(id, { ...policy, mute: undefined });
				changed = true;
			}
		}
		return changed;
	}

	#scheduleMuteExpiry(): void {
		clearTimeout(this.#muteTimer);
		this.#muteTimer = undefined;
		let deadline = Infinity;
		for (const group of this.#groups.values()) {
			for (const { mute } of group.policies.values()) {
				if (mute?.until !== undefined) deadline = Math.min(mute.until, deadline);
			}
		}
		if (deadline === Infinity) return;
		this.#muteTimer = setTimeout(() => {
			if (!this.#isCurrent()) return;
			if (this.#clearExpiredMutes()) this.#changed();
			else this.#scheduleMuteExpiry();
		}, Math.min(MAX_TIMEOUT_MS, Math.max(0, deadline - Date.now())));
		this.#muteTimer.unref?.();
	}

	#resize(name: string, group: Group, remind = true): void {
		if (name === IRC_EVERYONE) return;
		clearTimeout(group.timer);
		group.timer = undefined;
		group.deadline = undefined;
		if (group.members.size === 0) {
			this.#groups.delete(name);
		} else if (group.members.size === 1) {
			this.#scheduleExpiry(name, group, Date.now() + IRC_SINGLE_MEMBER_MINUTES * MINUTE_MS);
			const [member] = group.members;
			if (remind && member && this.#mayReceive(group, member)) {
				const notice = renderPromptAsset("system/irc-group-reminder.md", reminderTemplate, {
					group: name,
					minutes: IRC_SINGLE_MEMBER_MINUTES,
				}).trimEnd();
				void this.#remind(member, name, notice);
			}
		}
	}

	#scheduleExpiry(name: string, group: Group, deadline: number): void {
		clearTimeout(group.timer);
		group.deadline = deadline;
		group.timer = setTimeout(() => {
			if (!this.#isCurrent() || this.#groups.get(name) !== group) return;
			if (deadline > Date.now()) {
				this.#scheduleExpiry(name, group, deadline);
				return;
			}
			this.#groups.delete(name);
			this.#changed();
		}, Math.min(MAX_TIMEOUT_MS, Math.max(0, deadline - Date.now())));
		group.timer.unref?.();
	}

	async #remind(member: string, name: string, body: string): Promise<void> {
		try {
			const receipt = await this.bus.send(
				{ from: member, to: member, body, localOnly: true, broadcast: true, group: name },
				{ suppressRelay: true, groupDelivery: true, noWake: true },
			);
			if (receipt.outcome === "failed") logger.debug("IRC group reminder not delivered", { member, error: receipt.error });
		} catch (error) {
			logger.debug("IRC group reminder not delivered", { member, error: String(error) });
		}
	}
}

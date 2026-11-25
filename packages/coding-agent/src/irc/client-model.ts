import type { IrcLogEntry, IrcLogSource } from "@oh-my-pi/pi-tui/tools/irc";

export const IRC_TRAFFIC_ID = "traffic";
type IrcRoomId = `room:${string}`;
type IrcDmId = `dm:${string}`;
export type IrcConversationId = typeof IRC_TRAFFIC_ID | IrcRoomId | IrcDmId;

export const IRC_NOTIFICATION_LEVELS = ["all", "mentions", "none"] as const;
export type IrcNotificationLevel = (typeof IRC_NOTIFICATION_LEVELS)[number];

export function ircRoomId(name: string): IrcRoomId {
	return `room:${name}`;
}

/** Participants are real IRC ids, not display names or the direction of a particular send. */
export function ircDmId(a: string, b: string): IrcDmId {
	return `dm:${JSON.stringify(a <= b ? [a, b] : [b, a])}`;
}

function dmPeers(id: IrcConversationId): readonly [string, string] | undefined {
	if (!id.startsWith("dm:")) return undefined;
	try {
		const value: unknown = JSON.parse(id.slice(3));
		if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") {
			return [value[0], value[1]];
		}
	} catch {
		// Ignore stale or malformed persisted DM ids.
	}
	return undefined;
}

/** Undefined for a read-only third-party conversation or a non-DM view. */
export function otherIrcDmPeer(id: IrcConversationId, operatorId?: string): string | undefined {
	const peers = dmPeers(id);
	if (!peers || peers[0] === peers[1]) return undefined;
	if (peers[0] === operatorId) return peers[1];
	if (peers[1] === operatorId) return peers[0];
	return undefined;
}

/** Stable even when a later-settling fan-out leg replaces the projected representative. */
export function ircEntryId({ message }: IrcLogEntry): string {
	return message.fanoutId ?? message.id;
}

export function ircEntryConversationId({ message, broadcast }: IrcLogEntry): IrcConversationId {
	if (message.group !== undefined) return ircRoomId(message.group);
	// A legacy `all` send isn't a DM with any particular recipient.
	if (broadcast || message.broadcast) return IRC_TRAFFIC_ID;
	return ircDmId(message.from, message.to);
}

interface IrcConversationSummary {
	readonly unread: number;
	readonly pinned: boolean;
	readonly lastMessageAt: number | undefined;
}

export type IrcClientConversation = IrcConversationSummary &
	(
		| { readonly kind: "room"; readonly id: IrcRoomId; readonly room: string }
		| { readonly kind: "dm"; readonly id: IrcDmId; readonly peers: readonly [string, string] }
	);

/** Persist with the same session as the ledger; these are view positions, not another log. */
export interface IrcClientSnapshot {
	readonly lastConversation: IrcConversationId;
	readonly pinned: readonly IrcConversationId[];
	readonly read: readonly string[];
	readonly notifications?: readonly (readonly [IrcConversationId, IrcNotificationLevel])[];
}

export interface IrcClientModelOptions {
	operatorId?: string;
	rootId?: string;
	snapshot?: IrcClientSnapshot;
	onStateChange?: (state: IrcClientSnapshot) => void;
	roomNotificationDefault?: () => IrcNotificationLevel;
}

const MENTION_CONTINUATION = /[\p{L}\p{N}_/-]/u;
const MENTION_PREFIX = /[\p{L}\p{N}_@]/u;

function hasMention(text: string, handle: string): boolean {
	const token = `@${handle.toLowerCase()}`;
	let index = text.indexOf(token);
	while (index !== -1) {
		if (!MENTION_PREFIX.test(text[index - 1] ?? "") && !MENTION_CONTINUATION.test(text[index + token.length] ?? "")) {
			return true;
		}
		index = text.indexOf(token, index + token.length);
	}
	return false;
}

type NotificationEntry = Pick<IrcLogEntry, "outcome" | "broadcast"> & {
	message: Partial<Pick<IrcLogEntry["message"], "from" | "to" | "body" | "group" | "groupText" | "broadcast">>;
};

interface ProjectedRow {
	entry: IrcLogEntry;
	notified: boolean;
}

const NO_ENTRIES: readonly IrcLogEntry[] = [];

/** Operator's per-session read/selection state over the existing bus ledger. */
export class IrcClientModel {
	readonly #read: Set<string>;
	readonly #pinned: Set<IrcConversationId>;
	readonly #listeners = new Set<() => void>();
	readonly #pendingNotifications = new Set<string>();
	readonly #unsubscribe: () => void;
	readonly #notificationLevels: Map<IrcConversationId, IrcNotificationLevel>;
	#rows = new Map<string, ProjectedRow>();
	#observedLegs = new Set<string>();
	#traffic: IrcLogEntry[] = [];
	#conversations = new Map<IrcConversationId, IrcLogEntry[]>();
	#lastConversation: IrcConversationId;
	#selected: IrcConversationId;
	#open = false;

	constructor(
		private readonly source: IrcLogSource,
		private readonly options: IrcClientModelOptions = {},
	) {
		const { snapshot, operatorId } = options;
		this.#read = new Set(snapshot?.read);
		this.#pinned = new Set(snapshot?.pinned);
		this.#notificationLevels = new Map(snapshot?.notifications);
		this.#lastConversation = snapshot?.lastConversation ?? IRC_TRAFFIC_ID;
		this.#selected = this.#lastConversation;
		// Hydrated entries are backlog, not fresh notifications.
		this.#refresh("hydrate");
		this.#unsubscribe = source.subscribe(() => {
			this.#refresh(this.#open ? "open" : "closed");
			this.#emit();
		});
	}

	get selected(): IrcConversationId {
		return this.#selected;
	}

	/** Normal Alt+I resumes or follows a notification; Alt+Shift+I explicitly opens Traffic. */
	open(mode: "resume" | "traffic" = "resume", target?: IrcConversationId): IrcConversationId {
		let notified: IrcConversationId | undefined;
		if (!target && mode === "resume" && this.#pendingNotifications.size > 0) {
			for (let i = this.#traffic.length - 1; i >= 0; i--) {
				const entry = this.#traffic[i]!;
				if (!this.#pendingNotifications.has(ircEntryId(entry))) continue;
				notified = ircEntryConversationId(entry);
				break;
			}
		}
		this.#open = true;
		this.#pendingNotifications.clear();
		this.select(target ?? (mode === "traffic" ? IRC_TRAFFIC_ID : (notified ?? this.#lastConversation)));
		return this.#selected;
	}

	close(): void {
		this.#open = false;
	}

	/** Explicit activation. Sidebar previews use entries(id) without changing selection or unread state. */
	select(id: IrcConversationId): void {
		this.#selected = id;
		// Persist explicit activation while the owning session is current; a
		// control-driven transition can unmount the client after the id changes.
		const moved = this.#lastConversation !== id;
		this.#lastConversation = id;
		if (this.#readConversation(id) || moved) this.#save();
		this.#emit();
	}

	/** Call when live arrivals are actually being viewed, not merely when the client is open. */
	markRead(id: IrcConversationId = this.#selected): void {
		if (!this.#readConversation(id)) return;
		this.#save();
		this.#emit();
	}

	/** Chronological logical messages, in the bus's send order (not delivery completion order). */
	entries(id: IrcConversationId = this.#selected): readonly IrcLogEntry[] {
		return id === IRC_TRAFFIC_ID ? this.#traffic : (this.#conversations.get(id) ?? NO_ENTRIES);
	}

	/** The latest live notification, even if its conversation has already been read. */
	latestNotification(): IrcLogEntry | undefined {
		for (let i = this.#traffic.length - 1; i >= 0; i--) {
			const entry = this.#traffic[i]!;
			if (this.#rows.get(ircEntryId(entry))?.notified) return entry;
		}
		return undefined;
	}

	unread(id: IrcConversationId = IRC_TRAFFIC_ID): number {
		let count = 0;
		for (const entry of this.entries(id)) {
			if (this.#isUnread(entry)) count++;
		}
		return count;
	}

	/** Pinned first, then by newest activity; current room names also supply rooms with no messages. */
	conversations(rooms: readonly string[] = []): IrcClientConversation[] {
		// Reverse the ledger projection for recency without sorting by wall clock (which can repeat or regress).
		const ids = new Set<IrcConversationId>();
		for (let i = this.#traffic.length - 1; i >= 0; i--) ids.add(ircEntryConversationId(this.#traffic[i]!));
		for (const room of rooms) ids.add(ircRoomId(room));
		for (const id of this.#pinned) ids.add(id);
		const pinned: IrcClientConversation[] = [];
		const recent: IrcClientConversation[] = [];
		for (const id of ids) {
			if (id === IRC_TRAFFIC_ID) continue;
			const isPinned = this.#pinned.has(id);
			const summary = { pinned: isPinned, unread: this.unread(id), lastMessageAt: this.entries(id).at(-1)?.message.ts };
			const target = isPinned ? pinned : recent;
			if (id.startsWith("room:")) {
				target.push({ ...summary, kind: "room", id: id as IrcRoomId, room: id.slice(5) });
			} else {
				const peers = dmPeers(id);
				if (peers) target.push({ ...summary, kind: "dm", id: id as IrcDmId, peers });
			}
		}
		return pinned.concat(recent);
	}

	setPinned(id: IrcConversationId, pinned: boolean): void {
		if (id === IRC_TRAFFIC_ID || this.#pinned.has(id) === pinned) return;
		if (pinned) this.#pinned.add(id);
		else this.#pinned.delete(id);
		this.#save();
		this.#emit();
	}

	notificationLevel(id: IrcConversationId): IrcNotificationLevel {
		if (id === IRC_TRAFFIC_ID) return "none";
		return this.#notificationLevels.get(id) ??
			(id.startsWith("dm:") ? "all" : (this.options.roomNotificationDefault?.() ?? "mentions"));
	}

	setNotificationLevel(id: IrcConversationId, level: IrcNotificationLevel): void {
		if (id === IRC_TRAFFIC_ID || this.#notificationLevels.get(id) === level) return;
		this.#notificationLevels.set(id, level);
		this.#save();
		this.#emit();
	}

	/** Whether an addressed delivery can move the IRC client or become a quick-reply target. */
	notifies({ message, outcome, broadcast }: NotificationEntry): boolean {
		const operatorId = this.options.operatorId;
		const { from, to, group } = message;
		if (!operatorId || !from || from === operatorId || to !== operatorId || outcome === "failed") return false;
		if (group === undefined && (broadcast || message.broadcast || from === this.options.rootId)) return false;
		const id = group === undefined ? ircDmId(from, operatorId) : ircRoomId(group);
		const level = this.notificationLevel(id);
		if (level !== "mentions") return level === "all";
		const body = (group === undefined ? message.body : message.groupText ?? message.body)?.toLowerCase();
		return body !== undefined && (hasMention(body, operatorId) || hasMention(body, "operator") || hasMention(body, "everyone"));
	}

	snapshot(): IrcClientSnapshot {
		return {
			lastConversation: this.#lastConversation,
			pinned: [...this.#pinned],
			read: [...this.#read],
			notifications: [...this.#notificationLevels],
		};
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	dispose(): void {
		this.#unsubscribe();
		this.#listeners.clear();
	}

	#refresh(mode: "hydrate" | "open" | "closed"): void {
		const rows = new Map<string, ProjectedRow>();
		const observedLegs = new Set<string>();
		for (const entry of this.source.entries()) {
			const key = ircEntryId(entry);
			const before = rows.get(key);
			const leg = entry.message.id;
			// Remember the policy at arrival time; changing it must not promote old chatter.
			const notified =
				before?.notified || this.#rows.get(key)?.notified ||
				(mode !== "hydrate" && !this.#observedLegs.has(leg) && this.notifies(entry));
			observedLegs.add(leg);
			if (!before) rows.set(key, { entry, notified });
			else {
				before.notified = notified;
				// Prefer a successful leg over a failure, and the operator's own
				// successful delivery when available. Map position remains the first send leg's.
				if (
					entry.outcome !== "failed" &&
					(before.entry.outcome === "failed" || entry.message.to === this.options.operatorId)
				) {
					before.entry = entry;
				}
			}
		}
		const traffic: IrcLogEntry[] = [];
		const conversations = new Map<IrcConversationId, IrcLogEntry[]>();
		for (const [key, row] of rows) {
			const { entry } = row;
			traffic.push(entry);
			const id = ircEntryConversationId(entry);
			if (id !== IRC_TRAFFIC_ID) {
				const entries = conversations.get(id);
				if (entries) entries.push(entry);
				else conversations.set(id, [entry]);
			}
			if (mode === "closed" && row.notified && !this.#rows.get(key)?.notified) this.#pendingNotifications.add(key);
		}
		for (const key of this.#pendingNotifications) {
			if (!rows.has(key)) this.#pendingNotifications.delete(key);
		}
		for (const key of this.#read) {
			if (!rows.has(key)) this.#read.delete(key);
		}
		this.#rows = rows;
		this.#observedLegs = observedLegs;
		this.#traffic = traffic;
		this.#conversations = conversations;
	}

	#isUnread(entry: IrcLogEntry): boolean {
		return entry.message.from !== this.options.operatorId && !this.#read.has(ircEntryId(entry));
	}

	#readConversation(id: IrcConversationId): boolean {
		let changed = false;
		for (const entry of this.entries(id)) {
			if (!this.#isUnread(entry)) continue;
			this.#read.add(ircEntryId(entry));
			changed = true;
		}
		return changed;
	}

	#save(): void {
		this.options.onStateChange?.(this.snapshot());
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
}

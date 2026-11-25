/** Peer-message types and roster constants shared by messaging, `wait`, and child prompts. */

/** Maximum live peer rows embedded in child prompts. */
export const DEFAULT_PEER_ROSTER_LIMIT = 32;

/** Serializable peer message retained in coordination result snapshots. */
export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/**
	 * Automated wake-turn relay of a woken subagent's stop output (task executor
	 * `relayWakeTurnOutput`). Relays are answers, never wake sources: the
	 * recipient's own wake-turn relay must skip them or two idle peers
	 * ping-pong forever.
	 */
	wakeRelay?: boolean;
	/**
	 * One leg of an `all` broadcast. Like relays, broadcasts never draw an
	 * automatic wake-turn reply: every woken idle peer would otherwise answer
	 * the broadcaster, mostly to say the message was not for it.
	 */
	broadcast?: boolean;
	/** Passive local delivery: neither interrupt nor start a model turn. */
	noWake?: true;
	/**
	 * Interim acknowledgement or progress on something the recipient asked
	 * (`agent://<id>?progress`): it neither answers that request nor asks one,
	 * so the recipient's `wait` keeps waiting for the actual reply.
	 */
	progress?: boolean;
	/**
	 * Group this message names: where a group send went, or what a group notice is
	 * about. Recorded when sent, so the transcript shows the group as it was.
	 */
	group?: string;
	/** The sender's own text of a group send; `body` opens with the heading its recipients' models read. */
	groupText?: string;
	/** Other named groups sender and recipient shared when it was sent. */
	sharedGroups?: string[];
	/** Shared by every leg of one group send or `all` broadcast, so one UI shows that send once. */
	fanoutId?: string;
	/** Actual recipients on this leg's transcript: this agent and any operator attached to it. */
	deliveredRecipientIds?: string[];
}

/** Delivery outcome for one peer recipient. */
export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "queued" | "failed";
	error?: string;
}

/** Presentation metadata on the settled IRC tool result. Its body is already in the call arguments. */
export interface IrcOutgoingTranscript {
	from: string;
	to: string[];
	group?: string;
	timestamp?: number;
}

/**
 * One delivery attempt in the operator's IRC history: a concrete message (a
 * broadcast contributes one entry per recipient) and how it reached, or failed
 * to reach, that recipient.
 */
export interface IrcLogEntry {
	readonly message: IrcMessage;
	readonly outcome: IrcDeliveryReceipt["outcome"];
	readonly error?: string;
	/** One leg of a `to: "all"` fan-out. */
	readonly broadcast: boolean;
}

/** Read side of the IRC history a viewer renders: a snapshot plus change notifications. */
export interface IrcLogSource {
	/** Entries in send order, oldest first. */
	entries(): readonly IrcLogEntry[];
	/** Calls `listener` after each new entry; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
}

/** Status ordering for peer rosters in child prompts. */
export const LIST_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };

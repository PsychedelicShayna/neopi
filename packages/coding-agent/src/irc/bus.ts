/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked and killed agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage).
 */

import { type IrcDeliveryReceipt, type IrcLogEntry, type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { type AgentLifecycleApi, AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import { isAgentViewSession } from "../session/agent-session-handle";
import type { CustomMessage } from "../session/messages";
import {
	IRC_GROUPS_CUSTOM_TYPE,
	IrcGroups,
	type IrcGroupRequest,
	type IrcGroupResult,
	type IrcGroupSnapshot,
	readIrcGroupSnapshot,
} from "./groups";
import { ircHistoryMaxEntries, ircRelayToMainTranscript } from "./policy";
import { agentMesh } from "./mesh";
import { parsePeerAddress } from "./mesh-protocol";

interface IrcWaiter {
	filter: IrcWaitFilter;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** Which messages a bus {@link IrcBusApi.wait} consumes. */
export interface IrcWaitFilter {
	/** Only messages from this agent. */
	from?: string;
	/**
	 * Skip broadcast legs and progress notes, which ask the waiter nothing: they
	 * reach it through ordinary delivery, a non-interrupting aside when it is busy.
	 */
	directOnly?: boolean;
	/**
	 * With `directOnly`, still take a broadcast from these agents: the waiter
	 * asked them something, so their news interrupts its wait without settling
	 * the outstanding direct question (see {@link IrcBusApi.unansweredSends}).
	 */
	repliesFrom?: readonly string[];
}

/** Whether a bus wait under `filter` consumes `msg`. */
function ircWaitAccepts(filter: IrcWaitFilter, msg: IrcMessage): boolean {
	if (filter.from !== undefined && msg.from !== filter.from) return false;
	if (!filter.directOnly || (!msg.broadcast && !msg.progress)) return true;
	return !msg.progress && (filter.repliesFrom?.includes(msg.from) ?? false);
}

/** When a send went out: wall-clock `ts`, and `seq` to order sends within one millisecond. */
interface SendMark {
	ts: number;
	seq: number;
	/** The message's opening text (see {@link excerptOf}), for notices that quote an ask or a promise. */
	excerpt: string;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;
/** Longest message excerpt the bus keeps per sender → recipient pair. */
const EXCERPT_MAX_CHARS = 280;

/** `body` on one line, cut to {@link EXCERPT_MAX_CHARS}. */
function excerptOf(body: string): string {
	const text = body.replace(/\s+/g, " ").trim();
	return text.length <= EXCERPT_MAX_CHARS ? text : `${text.slice(0, EXCERPT_MAX_CHARS - 1)}…`;
}

/** A direct message still waiting for its answer; see {@link IrcBusApi.unansweredSends}. */
export interface UnansweredSend {
	/** The agent asked. */
	to: string;
	/** When the latest unanswered message to it went out. */
	sentAt: number;
	/** The agent asked sent progress since: it promised a later reply. */
	promised: boolean;
	/** Opening text of that message. */
	ask: string;
	/** Opening text of the agent's latest progress note since, when `promised`. */
	promise?: string;
}

/** A message awaiting delivery; local-only sends never fall through to a peer tunnel. */
export type IrcSend = Omit<IrcMessage, "id" | "ts"> & { localOnly?: boolean };

/** Options of one {@link IrcBus.send} leg. */
export interface IrcSendOptions {
	/** Skip the display-only main-UI relay for this leg. */
	suppressRelay?: boolean;
	/** This leg is one recipient of a `to: "all"` fan-out. */
	broadcast?: boolean;
	/** Show the operator's addressed group leg even when it came from her own root. */
	groupDelivery?: boolean;
}

/** Which root's operator a history entry belongs to; see {@link IrcBus.history}. */
export interface IrcHistoryScope {
	rootId: string;
	/**
	 * The root's session id: one per conversation, so `/new` starts a fresh
	 * history (with or without a session file) and moving a session keeps its own.
	 */
	sessionId: string | undefined;
}

interface IrcHistoryRecord extends IrcLogEntry {
	/** Root whose UI observed the sender when it sent (see {@link ircRelayRoot}); undefined when none resolved. */
	readonly scope: IrcHistoryScope | undefined;
	/** Send-start order: a slow delivery still lands where it was sent, not where it finished. */
	readonly seq: number;
}

interface IrcGroupScope {
	isCurrent(): boolean;
	groups: IrcGroups;
	ready?: Promise<boolean>;
}

/** Public surface of the process-global IRC bus, implemented locally on main and by a proxy in workers. */
export interface IrcBusApi {
	/** Fire-and-forget delivery; the receipt reports how the message reached the recipient. */
	send(msg: IrcSend, opts?: IrcSendOptions): Promise<IrcDeliveryReceipt>;
	/** Execute a namespace operation on the IRC host. */
	group(sender: string, request: IrcGroupRequest): Promise<IrcGroupResult>;
	/** Apply explicit everyone removals to the legacy live-peer broadcast roster. */
	filterBroadcastTargets(sender: string, targets: string[]): string[];
	/** Whether `from` successfully sent `to` anything, progress included, at or after `sinceTs`. */
	sentSince(from: string, to: string, sinceTs: number): boolean;
	/** Agents `from` messaged directly at or after `sinceTs` that have not answered since. */
	unansweredSends(from: string, sinceTs: number): UnansweredSend[];
	/** When `from` last sent `to` a message that ends a wait of `to`'s (not broadcast, not progress); undefined if never. */
	lastMessageAt(from: string, to: string): number | undefined;
	/** Block until a message for `agentId` that `filter` accepts arrives; null on timeout. */
	wait(
		agentId: string,
		filter: IrcWaitFilter,
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null>;
	/** Consume the oldest pending message for `agentId` (optionally from `from`). */
	take(agentId: string, from?: string): IrcMessage | undefined;
	/** Copy pending mail without consuming it. */
	peek(agentId: string, from?: string): IrcMessage[];
	/** Hold a direct message for a spawned agent that has not started yet; its run takes it on start. */
	park(msg: Omit<IrcMessage, "id" | "ts">): IrcMessage;
	/** Unread count for the local Agent Hub overlay. */
	unreadCount(agentId: string): number;
	/** Count a settled job of agent `from` owned by `to` as `from`'s reply to `to`. */
	recordReply(from: string, to: string): void;
}

export class IrcBus implements IrcBusApi {
	static #global: IrcBusApi | undefined;

	/** The installed bus; lazily a local {@link IrcBus} unless a worker installed a proxy. */
	static global(): IrcBusApi {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** The process-global bus if one exists; never creates it (no bus means no message was ever held). */
	static existing(): IrcBusApi | undefined {
		return IrcBus.#global;
	}

	/** Install the process-global bus. Worker bootstrap only. */
	static installGlobal(api: IrcBusApi): void {
		IrcBus.#global = api;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		const bus = IrcBus.#global;
		if (bus instanceof IrcBus) {
			bus.#fallbackGroups?.dispose();
			for (const scope of bus.#groupScopes.values()) scope.groups.dispose();
			bus.#groupScopes.clear();
		}
		IrcBus.#global = undefined;
	}

	/** Start restoring once the host's root (and the operator in interactive mode) is registered. */
	static restoreGroupsForRoot(root: AgentRef): void {
		const existing = IrcBus.#global;
		if (existing instanceof IrcBus) {
			existing.#groupScope(root, true);
		} else if (!existing && root.session && isAgentViewSession(root.session)) {
			const snapshot = readIrcGroupSnapshot(root.session.sessionManager.getBranch());
			if (!snapshot) return;
			const bus = new IrcBus();
			IrcBus.#global = bus;
			bus.#groupScope(root, true, snapshot);
		}
	}

	/** Freeze the journal before host shutdown unregisters peers that can return on resume. */
	static closeGroupsForRoot(root: AgentRef): void {
		const bus = IrcBus.#global;
		if (!(bus instanceof IrcBus)) return;
		bus.#closingGroupRoots.add(root);
		bus.#groupScopes.get(root)?.groups.dispose();
		bus.#groupScopes.delete(root);
	}

	/**
	 * Count a settled job of agent `from` owned by `to` as `from`'s reply to
	 * `to`: the job delivers that agent's outcome, so it answers what `to`
	 * asked it before now (see {@link unansweredSends}). With no bus yet no
	 * message was ever sent, so there is nothing to answer.
	 */
	static recordReply(from: string, to: string): void {
		IrcBus.#global?.recordReply(from, to);
	}

	readonly #registry: AgentRegistryApi;
	readonly #lifecycle: () => AgentLifecycleApi;
	readonly #groupScopes = new Map<AgentRef, IrcGroupScope>();
	readonly #closingGroupRoots = new WeakSet<AgentRef>();
	#fallbackGroups?: IrcGroups;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	/** The latest successful non-progress send per `from` → `to`; see {@link sentSince}. */
	readonly #lastSent = new Map<string, Map<string, SendMark>>();
	/** The latest non-broadcast, non-progress reply per `from` → `to`, including wake relays. */
	readonly #lastReply = new Map<string, Map<string, SendMark>>();
	/** The latest direct (non-broadcast, non-progress, non-relay) send per `from` → `to`; see {@link unansweredSends}. */
	readonly #lastDirect = new Map<string, Map<string, SendMark>>();
	/** The latest progress message per `from` → `to`: a promise that a reply will follow. */
	readonly #lastProgress = new Map<string, Map<string, SendMark>>();
	/** The latest job-carried reply per agent → owner; see {@link IrcBus.recordReply}. */
	readonly #lastJobReply = new Map<string, Map<string, SendMark>>();
	/** Last {@link SendMark.seq} handed out, taken when a send starts. */
	#sendSeq = 0;
	/** Operator-only log of every delivery attempt; agents never read it. */
	readonly #history: IrcHistoryRecord[] = [];
	readonly #historyListeners = new Set<() => void>();
	#nextHistorySeq = 0;

	constructor(registry: AgentRegistryApi = AgentRegistry.global(), lifecycle?: AgentLifecycleApi) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
	}

	async group(sender: string, request: IrcGroupRequest): Promise<IrcGroupResult> {
		const root = ircRelayRoot(this.#registry, sender);
		if (root && this.#closingGroupRoots.has(root)) return { text: "The IRC session is closing.", isError: true };
		const scope = root && this.#groupScope(root);
		if (!scope) return (this.#fallbackGroups ??= new IrcGroups(this.#registry, this)).execute(sender, request);
		if (scope.ready && !(await scope.ready)) {
			return { text: "Could not restore IRC groups for this session.", isError: true };
		}
		if (!scope.isCurrent()) return { text: "The IRC session changed during restore.", isError: true };
		return scope.groups.execute(sender, request);
	}

	filterBroadcastTargets(sender: string, targets: string[]): string[] {
		const root = ircRelayRoot(this.#registry, sender);
		const groups = (root && this.#groupScope(root)?.groups) ?? this.#fallbackGroups;
		return groups?.filterBroadcastTargets(targets) ?? targets;
	}

	/**
	 * Named groups `from` and `to` share right now, besides `exclude`. Reads only a
	 * roster that already exists: stamping a message must not create or restore one.
	 */
	#sharedGroups(from: string, to: string, exclude: string | undefined): string[] {
		const root = ircRelayRoot(this.#registry, from);
		const scope = root && this.#groupScopes.get(root);
		const groups = scope?.isCurrent() ? scope.groups : this.#fallbackGroups;
		return groups?.shared(from, to, exclude) ?? [];
	}

	#groupScope(root: AgentRef, restoreOnly = false, snapshot?: IrcGroupSnapshot): IrcGroupScope | undefined {
		const session = root.session;
		if (root.kind !== "main" || this.#closingGroupRoots.has(root) || !session || !isAgentViewSession(session)) {
			return undefined;
		}
		const manager = session.sessionManager;
		const sessionId = manager.getSessionId();
		const current = this.#groupScopes.get(root);
		if (current?.isCurrent()) return current;
		current?.groups.dispose();

		snapshot ??= readIrcGroupSnapshot(manager.getBranch());
		if (!snapshot && restoreOnly) {
			this.#groupScopes.delete(root);
			return undefined;
		}
		const sessionFile = manager.getSessionFile();
		const isCurrent = (): boolean =>
			this.#groupScopes.get(root) === scope &&
			this.#registry.get(root.id) === root &&
			root.session === session &&
			!this.#closingGroupRoots.has(root) &&
			manager.getSessionId() === sessionId;
		let materialized = snapshot !== undefined;
		const groups = new IrcGroups(this.#registry, this, snapshot, {
			isCurrent,
			save: state => {
				manager.appendCustomEntry(IRC_GROUPS_CUSTOM_TYPE, state);
				if (!materialized) {
					// Operator IRC can change groups before the first assistant turn.
					materialized = true;
					void manager.ensureOnDisk().catch(error => {
						materialized = false;
						logger.warn("Could not materialize IRC group session", { sessionId, error: String(error) });
					});
				}
			},
		});
		const scope: IrcGroupScope = { isCurrent, groups };
		this.#groupScopes.set(root, scope);
		if (snapshot && sessionFile && snapshot.groups.length) {
			// A missing ref is not necessarily gone until the session's revivable
			// child transcripts have been registered. Incomplete scans must not
			// turn a transient I/O failure into a durable membership removal.
			scope.ready = registerPersistedSubagents(this.#registry, sessionFile, {
				hydrateHistory: false,
				rootAgentId: root.id,
				shouldContinue: isCurrent,
			})
				.then(() => {
					if (!isCurrent()) return false;
					groups.restore(snapshot, sessionFile);
					scope.ready = undefined;
					return true;
				})
				.catch(error => {
					logger.warn("Could not restore IRC group roster", { sessionId, error: String(error) });
					if (this.#groupScopes.get(root) === scope) this.#groupScopes.delete(root);
					groups.dispose();
					return false;
				});
		} else if (snapshot) {
			groups.restore(snapshot, sessionFile);
		}
		return scope;
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 *
	 * `opts.suppressRelay` skips the display-only main-UI relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets the main
	 * agent directly: the main agent then already sees the body as its own
	 * incoming card, so relaying the sibling legs would duplicate it.
	 *
	 * Every attempt, failed ones included, is appended to the operator history
	 * ({@link history}); that never changes delivery or unread counts.
	 */
	async send({ localOnly, ...msg }: IrcSend, opts?: IrcSendOptions): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		// Membership as it is now travels with the message: the transcript shows it
		// as sent, whatever the groups look like when the session is next opened.
		const sharedGroups = this.#sharedGroups(message.from, message.to, message.group);
		if (sharedGroups.length > 0) message.sharedGroups = sharedGroups;
		const seq = this.#nextHistorySeq++;
		const scope = this.#historyScope(message.from);
		// Taken before delivery: a reply sent while this message is still being
		// delivered must still order after it.
		const mark: SendMark = { ts: message.ts, seq: ++this.#sendSeq, excerpt: excerptOf(message.body) };
		const receipt = await this.#deliver(message, { ...opts, localOnly });
		this.#recordHistory({
			message,
			outcome: receipt.outcome,
			error: receipt.error,
			broadcast: opts?.broadcast === true,
			scope,
			seq,
		});
		if (receipt.outcome !== "failed") {
			if (message.progress) {
				this.#record(this.#lastProgress, message.from, message.to, mark);
			} else {
				this.#record(this.#lastSent, message.from, message.to, mark);
				if (!message.broadcast) {
					this.#record(this.#lastReply, message.from, message.to, mark);
					if (!message.wakeRelay) this.#record(this.#lastDirect, message.from, message.to, mark);
				}
			}
		}
		return receipt;
	}

	park(msg: Omit<IrcMessage, "id" | "ts">): IrcMessage {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		const mark: SendMark = { ts: message.ts, seq: ++this.#sendSeq, excerpt: excerptOf(message.body) };
		this.#enqueue(message);
		// Counts as sent: a reply wait on the recipient blocks for its answer.
		if (message.progress) {
			this.#record(this.#lastProgress, message.from, message.to, mark);
		} else {
			this.#record(this.#lastSent, message.from, message.to, mark);
			this.#record(this.#lastReply, message.from, message.to, mark);
			this.#record(this.#lastDirect, message.from, message.to, mark);
		}
		return message;
	}

	#record(table: Map<string, Map<string, SendMark>>, from: string, to: string, mark: SendMark): void {
		let sent = table.get(from);
		if (!sent) {
			sent = new Map();
			table.set(from, sent);
		}
		// Deliveries can settle out of order; keep the latest send.
		if ((sent.get(to)?.seq ?? 0) < mark.seq) sent.set(to, mark);
	}

	/** Instance half of {@link IrcBus.recordReply}: records the job-carried reply on this bus. */
	recordReply(from: string, to: string): void {
		this.#record(this.#lastJobReply, from, to, { ts: Date.now(), seq: ++this.#sendSeq, excerpt: "" });
	}

	/**
	 * Whether `from` successfully sent `to` anything, progress included, at or
	 * after `sinceTs`. The wake-turn relay uses it to skip agents that already
	 * answered their waker themselves, or promised it a later answer.
	 */
	sentSince(from: string, to: string, sinceTs: number): boolean {
		return [this.#lastSent, this.#lastProgress].some(table => (table.get(from)?.get(to)?.ts ?? -1) >= sinceTs);
	}

	/**
	 * Agents `from` messaged directly at or after `sinceTs` that have not
	 * answered since, with when the latest of those messages went out: the
	 * replies a `wait` can block for. A non-broadcast message back answers, and
	 * so does a settled job of the agent `from` owns, which delivers its result.
	 * Progress answers nothing; it marks the request `promised`, and from then on only
	 * an explicit message answers it (a job settling the turn that sent the
	 * progress must not). "Since" is by send order, not timestamp, so an answer
	 * to an earlier question never settles a later one sent within the same
	 * millisecond. Each row quotes the asking message and, when promised, the
	 * latest progress note.
	 */
	unansweredSends(from: string, sinceTs: number): UnansweredSend[] {
		const sends = this.#lastDirect.get(from);
		if (!sends) return [];
		const unanswered: UnansweredSend[] = [];
		for (const [to, sent] of sends) {
			if (sent.ts < sinceTs) continue;
			const after = (table: Map<string, Map<string, SendMark>>) => (table.get(to)?.get(from)?.seq ?? 0) > sent.seq;
			const promised = after(this.#lastProgress);
			if (after(this.#lastReply) || (!promised && after(this.#lastJobReply))) continue;
			const row: UnansweredSend = { to, sentAt: sent.ts, promised, ask: sent.excerpt };
			const promise = promised ? this.#lastProgress.get(to)?.get(from)?.excerpt : undefined;
			if (promise !== undefined) row.promise = promise;
			unanswered.push(row);
		}
		return unanswered;
	}

	/**
	 * The operator's IRC history, oldest first: entries observed by `scope`'s
	 * root in that conversation, or every entry when `scope` is undefined.
	 */
	history(scope?: IrcHistoryScope): IrcLogEntry[] {
		const entries = scope
			? this.#history.filter(
					entry =>
						entry.scope === undefined ||
						(entry.scope.rootId === scope.rootId && entry.scope.sessionId === scope.sessionId),
				)
			: this.#history;
		return entries.map(({ scope: _scope, seq: _seq, ...entry }) => entry);
	}

	/** Calls `listener` after each history entry; returns the unsubscribe. */
	onHistory(listener: () => void): () => void {
		this.#historyListeners.add(listener);
		return () => this.#historyListeners.delete(listener);
	}

	#historyScope(senderId: string): IrcHistoryScope | undefined {
		const root = ircRelayRoot(this.#registry, senderId);
		return root ? { rootId: root.id, sessionId: ircHistorySessionId(root) } : undefined;
	}

	#recordHistory(record: IrcHistoryRecord): void {
		// Concurrent sends finish out of order; keep the history in the order they started.
		let index = this.#history.length;
		while (index > 0 && this.#history[index - 1]!.seq > record.seq) index--;
		this.#history.splice(index, 0, record);
		const excess = this.#history.length - ircHistoryMaxEntries();
		if (excess > 0) this.#history.splice(0, excess);
		for (const listener of this.#historyListeners) {
			try {
				listener();
			} catch (error) {
				logger.debug("IrcBus: history listener failed", { error: String(error) });
			}
		}
	}

	/**
	 * When `from` last sent `to` a message that ends a wait of `to`'s: a
	 * non-broadcast message that is not progress (wake relays included). A
	 * block `to` took before then is ending, however long its release takes.
	 */
	lastMessageAt(from: string, to: string): number | undefined {
		return this.#lastReply.get(from)?.get(to)?.ts;
	}

	async #deliver(
		message: IrcMessage,
		opts: IrcSendOptions & { localOnly?: boolean } = {},
	): Promise<IrcDeliveryReceipt> {
		const ref = this.#registry.get(message.to);
		const mesh = ref || opts.localOnly ? undefined : agentMesh();
		const peer = mesh && parsePeerAddress(message.to);
		if (mesh && peer && peer.pid !== process.pid) {
			// Another omp instance in this project: the mesh forwards it, and the
			// recipient's own bus decides how it lands.
			return mesh.send(peer, message.from, message.body, message.progress);
		}
		if (!ref) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check the subagent roster or read history:// for known peers.`,
			};
		}
		if (ref.status === "aborted") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" was hard-aborted and cannot be messaged. Explicitly revive it in the Agent Hub first, or read its transcript at history://${message.to}.`,
			};
		}
		// A control mailbox has no session. Buffer the message for a later wait/inbox.
		if (ref.kind === "mailbox") {
			const waiter = this.#takeMatchingWaiter(message);
			if (waiter) {
				waiter.resolve(message);
				return { to: message.to, outcome: "injected" };
			}
			this.#enqueue(message);
			return { to: message.to, outcome: "queued" };
		}
		// The operator reads IRC on her UI, not in a session: the history entry is
		// the record and a card on her root's transcript the notification, so it
		// arrives without waiting on any model's turn. A message from that root's
		// own model already shows as its hub tool call.
		if (ref.kind === "operator") {
			const root = ircRelayRoot(this.#registry, ref.id);
			if (root && (opts.groupDelivery || message.from !== root.id)) this.#showOnUi(root, message);
			return { to: message.to, outcome: "injected" };
		}
		// Advisor/read-only refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor" || ref.history?.readOnly) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		// A `parked` recipient needs the lifecycle to revive it from its
		// transcript — this is read from *this* bus's registry,
		// so it holds for any registry. The mid-park / adopted checks below query
		// the lifecycle's own state, which only describes the registry it manages:
		// consult them only when the lifecycle owns this bus's registry, otherwise
		// a custom-registry bus (fallen back to the global manager) would gate a
		// live recipient on unrelated global park state. Main/non-adopted live
		// peers skip the gate, and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(message.to) || lifecycle.has(message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await lifecycle.ensureLive(message.to);
				// Revival = we did not keep the same live instance (parked start, or
				// park completed and a fresh session was rebuilt).
				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				// Not revivable / released / revive failed. Do not buffer: a permanent
				// failure must not inflate unread counts or pretend delivery is pending.
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// A pending bus wait from the recipient consumes the message directly
		// and never hits the inbox; the `wait` tool hands it to its own session,
		// which injects it as a user turn.
		const waiter = this.#takeMatchingWaiter(message);
		if (waiter) {
			waiter.resolve(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer
			// the message so a later `wait`/`inbox` from the recipient can still
			// pick it up. The receipt stays "failed" — the recipient has not
			// seen it.
			this.#enqueue(message);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` that `filter` accepts arrives;
	 * consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: IrcWaitFilter,
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, msg => ircWaitAccepts(filter, msg));
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		};

		const waiter: IrcWaiter = {
			filter,
			resolve: msg => settle({ kind: "message", msg }),
			cancel: () => cleanup(),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		return promise;
	}

	/**
	 * Consume the OLDEST pending message for `agentId` (optionally restricted
	 * to `from`), leaving the rest of the mailbox intact. This is the exact
	 * atomic step `wait` performs on entry, exposed for callers that must not
	 * block without draining the entire backlog.
	 */
	take(agentId: string, from?: string): IrcMessage | undefined {
		return this.#takeFromMailbox(agentId, msg => from === undefined || msg.from === from);
	}

	/** Copy pending mail without consuming it. */
	peek(agentId: string, from?: string): IrcMessage[] {
		const mailbox = this.#mailboxes.get(agentId) ?? [];
		return mailbox.filter(message => !from || message.from === from).map(message => ({ ...message }));
	}

	/** Unread count for the local Agent Hub overlay. */
	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	#enqueue(message: IrcMessage): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Resolve the OLDEST waiter for the recipient whose filter accepts `message`. */
	#takeMatchingWaiter(message: IrcMessage): IrcWaiter | undefined {
		const waiters = this.#waiters.get(message.to);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => ircWaitAccepts(waiter.filter, message));
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(message.to);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, accepts: (msg: IrcMessage) => boolean): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = mailbox.findIndex(accepts);
		if (index === -1) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the UI of the
	 * sender's root session (the top-level session whose spawn tree it
	 * belongs to; the default "Main" session when that tree cannot be
	 * resolved). Skipped when that root is either endpoint: as recipient its
	 * own `deliverIrcMessage` (or `wait` tool result) already shows the
	 * message, and as sender the irc send tool call already rendered the
	 * outbound body — relaying it again would duplicate it in the transcript.
	 */
	#relayToMainUi(message: IrcMessage): void {
		if (!ircRelayToMainTranscript()) return;
		const root = ircRelayRoot(this.#registry, message.from);
		if (!root || message.to === root.id || message.from === root.id) return;
		this.#showOnUi(root, message);
	}

	/** Display-only `irc:relay` card for `message` on `root`'s UI; never persisted. */
	#showOnUi(root: AgentRef, message: IrcMessage): void {
		const session = root.session;
		if (!session) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: {
				from: message.from,
				to: message.to,
				body: message.body,
				...(message.broadcast ? { broadcast: true } : {}),
				...(message.group ? { group: message.group } : {}),
				...(message.groupText !== undefined ? { groupText: message.groupText } : {}),
				...(message.sharedGroups ? { sharedGroups: message.sharedGroups } : {}),
				...(message.fanoutId ? { fanoutId: message.fanoutId } : {}),
			},
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			session.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}

/**
 * The root whose UI observes `senderId`'s IRC traffic: the top-level ref of
 * its spawn tree, falling back to the default "Main" root when the parent
 * chain is broken.
 */
export function ircRelayRoot(registry: AgentRegistryApi, senderId: string): AgentRef | undefined {
	return registry.rootOf(senderId) ?? registry.get(MAIN_AGENT_ID);
}

/** The session id `root` currently runs, scoping its IRC history to one conversation. */
export function ircHistorySessionId(root: AgentRef): string | undefined {
	// Roots without a live session (and test doubles) have no conversation to scope by.
	const manager: { getSessionId?(): string } | undefined = root.session?.sessionManager;
	return manager?.getSessionId?.();
}

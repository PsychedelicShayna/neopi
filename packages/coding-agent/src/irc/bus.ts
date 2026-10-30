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
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { CustomMessage } from "../session/messages";
import { ircHistoryMaxEntries, ircRelayToMainTranscript } from "./policy";

interface IrcWaiter {
	from?: string;
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** When a send went out: wall-clock `ts`, and `seq` to order sends within one millisecond. */
interface SendMark {
	ts: number;
	seq: number;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

/** Options of one {@link IrcBus.send} leg. */
export interface IrcSendOptions {
	/** Skip the display-only main-UI relay for this leg. */
	suppressRelay?: boolean;
	/** This leg is one recipient of a `to: "all"` fan-out. */
	broadcast?: boolean;
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

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	/**
	 * Count a settled job of agent `from` owned by `to` as `from`'s reply to
	 * `to`: the job delivers that agent's outcome, so it answers what `to`
	 * asked it before now (see {@link unansweredSends}). With no bus yet no
	 * message was ever sent, so there is nothing to answer.
	 */
	static recordReply(from: string, to: string): void {
		const bus = IrcBus.#global;
		if (bus) bus.#recordReply(from, to);
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();
	/** The latest successful non-progress send per `from` → `to`; see {@link sentSince}. */
	readonly #lastSent = new Map<string, Map<string, SendMark>>();
	/** The latest direct (non-broadcast, non-progress) send per `from` → `to`; see {@link unansweredSends}. */
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

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
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
	async send(msg: Omit<IrcMessage, "id" | "ts">, opts?: IrcSendOptions): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		const seq = this.#nextHistorySeq++;
		const scope = this.#historyScope(message.from);
		// Taken before delivery: a reply sent while this message is still being
		// delivered must still order after it.
		const mark: SendMark = { ts: message.ts, seq: ++this.#sendSeq };
		const receipt = await this.#deliver(message, opts);
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
				if (!message.broadcast && !message.wakeRelay)
					this.#record(this.#lastDirect, message.from, message.to, mark);
			}
		}
		return receipt;
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

	#recordReply(from: string, to: string): void {
		this.#record(this.#lastJobReply, from, to, { ts: Date.now(), seq: ++this.#sendSeq });
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
	 * replies a `wait` can block for. A message back answers, and so does a
	 * settled job of the agent `from` owns, which delivers its result. Progress
	 * answers nothing; it marks the request `promised`, and from then on only
	 * an explicit message answers it (a job settling the turn that sent the
	 * progress must not). "Since" is by send order, not timestamp, so an answer
	 * to an earlier question never settles a later one sent within the same
	 * millisecond.
	 */
	unansweredSends(from: string, sinceTs: number): Array<{ to: string; sentAt: number; promised: boolean }> {
		const sends = this.#lastDirect.get(from);
		if (!sends) return [];
		const unanswered: Array<{ to: string; sentAt: number; promised: boolean }> = [];
		for (const [to, sent] of sends) {
			if (sent.ts < sinceTs) continue;
			const after = (table: Map<string, Map<string, SendMark>>) => (table.get(to)?.get(from)?.seq ?? 0) > sent.seq;
			const promised = after(this.#lastProgress);
			if (after(this.#lastSent) || (!promised && after(this.#lastJobReply))) continue;
			unanswered.push({ to, sentAt: sent.ts, promised });
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

	async #deliver(message: IrcMessage, opts?: IrcSendOptions): Promise<IrcDeliveryReceipt> {
		const ref = this.#registry.get(message.to);
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
			const waiter = this.#takeMatchingWaiter(message.to, message.from);
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
			if (root && message.from !== root.id) this.#showOnUi(root, message);
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

		// A pending `wait` from the recipient consumes the message directly —
		// it is returned from their irc tool call and never hits the inbox or
		// the session injection path.
		const waiter = this.#takeMatchingWaiter(message.to, message.from);
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
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, filter.from);
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
			from: filter.from,
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
		return this.#takeFromMailbox(agentId, from);
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

	/** Resolve the OLDEST waiter for `agentId` whose from-filter accepts `from`. */
	#takeMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(waiter => !waiter.from || waiter.from === from);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => msg.from === from) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
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
			details: { from: message.from, to: message.to, body: message.body },
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
export function ircRelayRoot(registry: AgentRegistry, senderId: string): AgentRef | undefined {
	return registry.rootOf(senderId) ?? registry.get(MAIN_AGENT_ID);
}

/** The session id `root` currently runs, scoping its IRC history to one conversation. */
export function ircHistorySessionId(root: AgentRef): string | undefined {
	// Roots without a live session (and test doubles) have no conversation to scope by.
	const manager: { getSessionId?(): string } | undefined = root.session?.sessionManager;
	return manager?.getSessionId?.();
}

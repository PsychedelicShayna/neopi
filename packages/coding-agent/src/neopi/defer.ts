import { AsyncLocalStorage } from "node:async_hooks";
import { sleepLong } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";

export const DEFER_USAGE = "Usage: /defer <duration> <input> | /defer cancel <id|all>";

const UNITS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
	M: 2_592_000_000,
	Y: 31_536_000_000,
};

const DURATION_AMOUNT = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const DURATION_UNITS = Object.keys(UNITS);
const DEFERRED_INPUT = new RegExp(`^(${DURATION_AMOUNT.source})(${DURATION_UNITS.join("|")})\\s([\\s\\S]+)$`);
const DURATION_PREFIX = new RegExp(`^(${DURATION_AMOUNT.source})([a-zA-Z]*)$`);

/** Complete the units of an amount the operator has already entered. */
export function completeDeferredDuration(prefix: string): string[] {
	const match = DURATION_PREFIX.exec(prefix);
	if (!match) return [];
	const [, amount, unitPrefix] = match;
	const value = Number(amount);
	const matches: string[] = [];
	for (const unit of DURATION_UNITS) {
		if (!unit.startsWith(unitPrefix) || !Number.isFinite(value * UNITS[unit])) continue;
		// Keep an exact `m` ahead of the longer `ms` match.
		if (unit === unitPrefix) matches.unshift(prefix);
		else matches.push(amount + unit);
	}
	return matches;
}

export function parseDeferredInput(args: string): { delayMs: number; input: string } | undefined {
	const match = DEFERRED_INPUT.exec(args);
	if (!match || !match[3].trim()) return undefined;
	const delayMs = Number(match[1]) * UNITS[match[2]];
	if (!Number.isFinite(delayMs)) return undefined;
	return { delayMs: Math.max(0, delayMs), input: match[3] };
}

interface DeferredDelivery {
	session: AgentSession;
	sessionId: string;
	signal: AbortSignal;
}

const deliveryScope = new AsyncLocalStorage<DeferredDelivery>();
const pendingInputs = new WeakMap<object, { delivery: DeferredDelivery; finish: () => void }>();

function isCurrent(delivery: DeferredDelivery): boolean {
	return (
		!delivery.signal.aborted &&
		!delivery.session.isDisposed &&
		delivery.session.sessionManager.getSessionId() === delivery.sessionId
	);
}

/** Commands may delegate while their original scheduling conversation remains active. */
export function isDeferredSubmissionActive(): boolean {
	const delivery = deliveryScope.getStore();
	return !delivery || isCurrent(delivery);
}

/** Preserve ownership across the existing composer→main-loop promise handoff. */
export function waitForDeferredInput(input: object): Promise<void> | undefined {
	const delivery = deliveryScope.getStore();
	if (!delivery) return;
	const done = Promise.withResolvers<void>();
	const finish = () => done.resolve();
	pendingInputs.set(input, { delivery, finish });
	delivery.signal.addEventListener("abort", finish, { once: true });
	if (delivery.signal.aborted) finish();
	return done.promise.finally(() => delivery.signal.removeEventListener("abort", finish));
}

export function consumeDeferredInput(input: object, submit: () => Promise<void>): Promise<void> {
	const pending = pendingInputs.get(input);
	if (!pending) return submit();
	return deliveryScope.run(pending.delivery, async () => {
		try {
			await submit();
		} finally {
			pending.finish();
		}
	});
}

/** Owns cancellable clocks and in-flight delivery, not AgentSession's message queues. */
export class DeferredSubmissions {
	#nextId = 0;
	#timers = new Map<number, AbortController>();

	constructor(readonly session: AgentSession) {
		const unsubscribe = session.registerSessionChangeCallback(() => this.cancel());
		session.addDisposer(() => {
			this.cancel();
			unsubscribe();
		});
	}

	schedule(delayMs: number, submit: () => Promise<void>, onError: (error: unknown) => void): number {
		if (this.session.isDisposed) throw new Error("Cannot defer input after the session has ended");
		const id = ++this.#nextId;
		const controller = new AbortController();
		const sessionId = this.session.sessionManager.getSessionId();
		this.#timers.set(id, controller);
		void sleepLong(delayMs, controller.signal)
			.then(async () => {
				const delivery = { session: this.session, sessionId, signal: controller.signal };
				if (!isCurrent(delivery)) return;
				await deliveryScope.run(delivery, submit);
			})
			.catch(error => {
				if (!controller.signal.aborted) onError(error);
			})
			.finally(() => this.#timers.delete(id));
		return id;
	}

	pendingIds(): number[] {
		return [...this.#timers.keys()];
	}

	cancel(id?: number): number {
		if (id !== undefined) {
			const controller = this.#timers.get(id);
			if (!controller) return 0;
			controller.abort();
			this.#timers.delete(id);
			return 1;
		}
		const count = this.#timers.size;
		for (const controller of this.#timers.values()) controller.abort();
		this.#timers.clear();
		return count;
	}
}

const schedules = new WeakMap<AgentSession, DeferredSubmissions>();

export function deferredSubmissionsFor(session: AgentSession): DeferredSubmissions {
	let schedulesForSession = schedules.get(session);
	if (!schedulesForSession) {
		schedulesForSession = new DeferredSubmissions(session);
		schedules.set(session, schedulesForSession);
	}
	return schedulesForSession;
}

/** Inspect outstanding submissions without creating a schedule or registering lifecycle callbacks. */
export function pendingDeferredSubmissionIds(session: AgentSession): number[] {
	return schedules.get(session)?.pendingIds() ?? [];
}

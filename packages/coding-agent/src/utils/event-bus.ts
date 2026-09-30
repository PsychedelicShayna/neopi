import { logger } from "@oh-my-pi/pi-utils";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";

export const ACTIVE_RUN_LEDGER_MAX = 512;
const activeRuns = new WeakMap<EventBus, Map<string, SubagentLifecyclePayload>>();

/** Snapshot the current starts; callers cannot mutate the producer's ledger. */
export function activeSubagentRuns(bus: EventBus): ReadonlyMap<string, SubagentLifecyclePayload> {
	const runs = activeRuns.get(bus);
	return new Map(runs ? [...runs].map(([token, frame]) => [token, { ...frame }]) : []);
}

function recordSubagentFrame(bus: EventBus, channel: string, payload: unknown): void {
	if (channel !== TASK_SUBAGENT_LIFECYCLE_CHANNEL && channel !== TASK_SUBAGENT_PROGRESS_CHANNEL) return;
	let runs = activeRuns.get(bus);
	if (!runs) {
		runs = new Map();
		activeRuns.set(bus, runs);
	}
	if (channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL) {
		const frame = payload as SubagentLifecyclePayload;
		if (!frame.runToken) return;
		if (frame.status === "started") {
			runs.set(frame.runToken, { ...frame });
			if (runs.size > ACTIVE_RUN_LEDGER_MAX) runs.delete(runs.keys().next().value!);
		} else {
			runs.delete(frame.runToken);
		}
	} else {
		const frame = payload as SubagentProgressPayload;
		const start = runs.get(frame.runToken);
		if (start && frame.owned && frame.runEffectiveModelIdentity && frame.runEffectiveThinkingLevel) {
			runs.set(frame.runToken, {
				...start,
				runEffectiveModelIdentity: frame.runEffectiveModelIdentity,
				runEffectiveThinkingLevel: frame.runEffectiveThinkingLevel,
			});
		}
	}
}

export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const safeHandler = async (data: unknown) => {
			try {
				await handler(data);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		this.#listeners.get(channel)!.add(safeHandler);
		return () => this.#listeners.get(channel)?.delete(safeHandler);
	}

	clear(): void {
		this.#listeners.clear();
	}
}

/**
 * Publishes a subagent frame on the session bus and the observability bus.
 * SDK embedders may pass the same EventBus for both slots; the identity check
 * skips the aliased re-emit so listeners never see duplicate frames.
 */
export function emitSubagentFrame(
	eventBus: EventBus | undefined,
	subagentEventBus: EventBus | undefined,
	channel: string,
	payload: unknown,
): void {
	if (eventBus) {
		recordSubagentFrame(eventBus, channel, payload);
		eventBus.emit(channel, payload);
	}
	if (subagentEventBus && subagentEventBus !== eventBus) {
		recordSubagentFrame(subagentEventBus, channel, payload);
		subagentEventBus.emit(channel, payload);
	}
}

/**
 * Provenance of the control request currently running on this call chain.
 * Keyboard input is never inside the scope, so a mount can tell the two apart.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ControlActor {
	connectionId: string;
	label: string;
	/** `human` revision when the request was admitted. */
	humanAtAdmission: number;
	/** Current human revision. A mount refuses when this moved. */
	humanNow: () => number;
}

const actors = new AsyncLocalStorage<ControlActor>();

export function currentControlActor(): ControlActor | undefined {
	return actors.getStore();
}

export function runAsControlActor<T>(actor: ControlActor, fn: () => T): T {
	return actors.run(actor, fn);
}

/**
 * Provenance of the control request currently running on this call chain.
 * Keyboard input is never inside the scope, so a mount can tell the two apart.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { MessageOrigin } from "@oh-my-pi/pi-ai";

export interface ControlActor {
	connectionId: string;
	label: string;
	origin?: MessageOrigin;
	/** Host and ancestry authenticated at admission, retained with the delivered input. */
	hostInstanceId?: string;
	controlChain?: readonly string[];
	/** `human` revision when the request was admitted. */
	humanAtAdmission: number;
	/** Current human revision. A mount refuses when this moved. */
	humanNow: () => number;
}

const actors = new AsyncLocalStorage<ControlActor>();
const inputActors = new WeakMap<MessageOrigin, ControlActor>();
const commands = new AsyncLocalStorage<{ actor: ControlActor; active: boolean }>();

export function currentControlActor(): ControlActor | undefined {
	return actors.getStore();
}

export function runAsControlActor<T>(actor: ControlActor, fn: () => T): T {
	if (actor.origin) inputActors.set(actor.origin, actor);
	return actors.run(actor, fn);
}

export function controlActorForOrigin(origin: MessageOrigin | undefined): ControlActor | undefined {
	return origin && inputActors.get(origin);
}

/** Author of a delivered batch, or of an explicitly dispatched command outside turn work. */
export function controlOperationActor(input: readonly AgentMessage[] | undefined): ControlActor | undefined {
	if (input === undefined) {
		const command = commands.getStore();
		return command?.active ? command.actor : undefined;
	}
	let author: ControlActor | undefined;
	for (const message of input) {
		if (message.role !== "user" || message.synthetic) continue;
		const actor = controlActorForOrigin(message.origin);
		if (!actor || (author && author.connectionId !== actor.connectionId)) return undefined;
		// A coalesced batch must not ignore an intervening pane edit for any of its inputs.
		if (!author || actor.humanAtAdmission < author.humanAtAdmission) author = actor;
	}
	return author;
}

/** Only the command handler owns this scope; detached children lose it on return. */
export async function runAsControlCommand<T>(actor: ControlActor | undefined, run: () => Promise<T>): Promise<T> {
	if (!actor) return run();
	const command = { actor, active: true };
	try {
		return await commands.run(command, run);
	} finally {
		command.active = false;
	}
}

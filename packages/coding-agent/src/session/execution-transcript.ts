import * as path from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { BashExecutionMessage, EvalExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Destination retained by a user execution across transcript changes. */
export type ExecutionAppendDestination =
	| { kind: "current"; manager: SessionManager }
	| { kind: "detached"; manager: SessionManager }
	| { kind: "branch"; manager: SessionManager; parentId: string | null };

export interface ExecutionSessionTarget {
	sessionId: string;
	refs: number;
	destination?: ExecutionAppendDestination;
	pending?: Promise<ExecutionAppendDestination>;
}

export interface ExecutionSessionTransition {
	oldTarget: ExecutionSessionTarget;
	newTarget: ExecutionSessionTarget;
	oldSessionId: string;
	oldSessionFile: string | undefined;
	oldLeafId: string | null;
	detachedManager: SessionManager | undefined;
	resolveOld: ((destination: ExecutionAppendDestination) => void) | undefined;
	resolveNew: (destination: ExecutionAppendDestination) => void;
}

type ExecutionMessage = BashExecutionMessage | EvalExecutionMessage;

/** Shared bash/eval ownership boundary; only live destinations update the Agent. */
export class ExecutionTranscript {
	#target: ExecutionSessionTarget;

	constructor(readonly host: { agent: Agent; sessionManager: SessionManager }) {
		this.#target = {
			sessionId: host.sessionManager.getSessionId(),
			refs: 0,
			destination: { kind: "current", manager: host.sessionManager },
		};
	}

	capture(): ExecutionSessionTarget {
		this.#target.refs++;
		return this.#target;
	}

	isCurrent(target: ExecutionSessionTarget): boolean {
		return target === this.#target;
	}

	async release(target: ExecutionSessionTarget): Promise<void> {
		if (target.refs <= 0) throw new Error("Execution session target released more than once");
		target.refs--;
		if (target.refs === 0 && target.destination?.kind === "detached") await target.destination.manager.close();
	}

	append(destination: ExecutionAppendDestination, message: ExecutionMessage): void {
		switch (destination.kind) {
			case "current":
				this.host.agent.appendMessage(message);
				destination.manager.appendMessage(message);
				break;
			case "detached":
				destination.manager.appendMessage(message);
				break;
			case "branch":
				destination.parentId = destination.manager.appendMessageToBranch(message, destination.parentId);
				break;
		}
	}

	async appendOwned(target: ExecutionSessionTarget, message: ExecutionMessage): Promise<void> {
		try {
			const destination = target.destination ?? (await target.pending);
			if (!destination) throw new Error("Execution session target has no append destination");
			this.append(destination, message);
		} finally {
			await this.release(target);
		}
	}

	beginSessionTransition(options?: { persistDetached?: boolean }): ExecutionSessionTransition {
		const oldTarget = this.#target;
		let detachedManager: SessionManager | undefined;
		let resolveOld: ((destination: ExecutionAppendDestination) => void) | undefined;
		if (oldTarget.refs > 0) {
			detachedManager = this.host.sessionManager.cloneCurrentSession({ persist: options?.persistDetached });
			const pendingOld = Promise.withResolvers<ExecutionAppendDestination>();
			oldTarget.destination = undefined;
			oldTarget.pending = pendingOld.promise;
			resolveOld = pendingOld.resolve;
		}
		const pendingNew = Promise.withResolvers<ExecutionAppendDestination>();
		return {
			oldTarget,
			newTarget: { sessionId: this.host.sessionManager.getSessionId(), refs: 0, pending: pendingNew.promise },
			oldSessionId: this.host.sessionManager.getSessionId(),
			oldSessionFile: this.host.sessionManager.getSessionFile(),
			oldLeafId: this.host.sessionManager.getLeafId(),
			detachedManager,
			resolveOld,
			resolveNew: pendingNew.resolve,
		};
	}

	markSessionTransition(transition: ExecutionSessionTransition): void {
		transition.newTarget.sessionId = this.host.sessionManager.getSessionId();
		this.#target = transition.newTarget;
	}

	finishSessionTransition(transition: ExecutionSessionTransition, success: boolean): void {
		const manager = this.host.sessionManager;
		const currentDestination: ExecutionAppendDestination = { kind: "current", manager };
		let oldDestination: ExecutionAppendDestination = currentDestination;
		if (success && transition.resolveOld) {
			const currentFile = manager.getSessionFile();
			const sameFile =
				transition.oldSessionFile === currentFile ||
				(transition.oldSessionFile !== undefined &&
					currentFile !== undefined &&
					path.resolve(transition.oldSessionFile) === path.resolve(currentFile));
			const sameSession = transition.oldSessionId === manager.getSessionId() && sameFile;
			if (sameSession) {
				oldDestination =
					transition.oldLeafId === manager.getLeafId()
						? currentDestination
						: { kind: "branch", manager, parentId: transition.oldLeafId };
			} else if (transition.detachedManager) {
				oldDestination = { kind: "detached", manager: transition.detachedManager };
			}
		}
		if (transition.resolveOld) {
			transition.oldTarget.pending = undefined;
			transition.oldTarget.destination = oldDestination;
			transition.resolveOld(oldDestination);
		}
		transition.newTarget.pending = undefined;
		transition.newTarget.destination = currentDestination;
		if (!success) transition.newTarget.sessionId = manager.getSessionId();
		transition.resolveNew(currentDestination);
		if (transition.detachedManager && (oldDestination.kind !== "detached" || transition.oldTarget.refs === 0)) {
			void transition.detachedManager.close().catch(error => {
				logger.warn("Failed to close detached execution session writer", { error: String(error) });
			});
		}
	}
}

import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import {
	type BashPtyOptions,
	type BashResult,
	drainAbortedShells,
	executeBash as executeBashCommand,
	releaseShellSessions,
} from "../exec/bash-executor";
import type { ExtensionRunner } from "../extensibility/extensions";
import { outputMeta } from "../tools/output-meta";
import { clampTimeout } from "../tools/tool-timeouts";
import type { BashExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";
import type { SessionEnvironment } from "./environment";
import {
	ExecutionTranscript,
	type ExecutionSessionTarget,
	type ExecutionSessionTransition,
} from "./execution-transcript";

import { cfgToolsMaxTimeout } from "../tools/settings";

interface PendingBashMessage {
	target: ExecutionSessionTarget;
	message: BashExecutionMessage;
}

export interface BashExecuteOptions {
	excludeFromContext?: boolean;
	useUserShell?: boolean;
	pty?: BashPtyOptions;
	/** Receives the `bashExecution` message the run is recorded as, once it is persisted or queued for a mid-turn flush. */
	onRecorded?: (message: BashExecutionMessage) => void;
}

/** Capabilities the bash runner borrows from its owning session. */
export interface BashRunnerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	environment?: SessionEnvironment;
	extensionRunner(): ExtensionRunner | undefined;
	isStreaming(): boolean;
}

/** Owns bash execution and preserves result ownership across transcript transitions. */
export class BashRunner {
	readonly #host: BashRunnerHost;
	#abortControllers = new Set<AbortController>();
	/** Session ids of cancelled commands; a command keeps the id it started under across transitions. */
	#cancelledSessionIds = new Set<string>();
	#pendingMessages: PendingBashMessage[] = [];
	readonly transcript: ExecutionTranscript;

	constructor(host: BashRunnerHost) {
		this.#host = host;
		this.transcript = new ExecutionTranscript(host);
	}

	/** Executes a bash command while retaining the session and branch that owned its start. */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: BashExecuteOptions,
	): Promise<BashResult> {
		const target = this.transcript.capture();
		let targetTransferred = false;
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		try {
			const extensionRunner = this.#host.extensionRunner();
			if (extensionRunner?.hasHandlers("user_bash")) {
				const hookResult = await extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd,
				});
				if (hookResult?.result) {
					targetTransferred = true;
					await this.#recordResultForTarget(target, command, hookResult.result, options);
					return hookResult.result;
				}
			}

			// The hook's adapter forwards only entries that differ from the baseline
			// it is handed, and the child shell starts from the (cached, filtered)
			// spawn env — NOT from live process.env. Diffing against process.env
			// cancels out any variable an extension both mirrors into process.env
			// and injects via its hook (e.g. the secretsd session token file), so
			// hand the hook the env the child will actually receive. Pass a copy:
			// this.#host.settings.getShellConfig().env is a cached, shared object,
			// and a legacy hook that mutates its context.env in place (a supported
			// pattern) would otherwise poison that cache for every later command.
			const shellEnv =
				options?.useUserShell === true
					? extensionRunner
							?.getRegisteredTool("bash")
							?.definition.shellEnv?.({ command, cwd, env: { ...this.#host.settings.getShellConfig().env } })
					: undefined;

			const abortController = new AbortController();
			this.#abortControllers.add(abortController);
			let result: BashResult;
			try {
				result = await executeBashCommand(command, {
					onChunk,
					signal: abortController.signal,
					sessionKey: target.sessionId,
					// A command still pending when its session was left must not keep a
					// shell under that session after the transition released its shells.
					isSessionCurrent: () => this.#host.sessionManager.getSessionId() === target.sessionId,
					cwd,
					timeout: clampTimeout("bash", undefined, cfgToolsMaxTimeout.get(this.#host.settings)) * 1000,
					onMinimizedSave: originalText => this.#saveOriginalArtifact(target, originalText),
					env: shellEnv,
					environment: this.#host.environment,
					useUserShell: options?.useUserShell,
					pty: options?.pty,
				});
			} finally {
				this.#abortControllers.delete(abortController);
			}
			if (result.cancelled) this.#cancelledSessionIds.add(target.sessionId);
			targetTransferred = true;
			await this.#recordResultForTarget(target, command, result, options);
			return result;
		} finally {
			if (!targetTransferred) await this.transcript.release(target);
		}
	}

	/** Records a bash result supplied outside executeBash in the current ownership scope. */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const target = this.transcript.capture();
		const message = this.#createMessage(command, result, options);
		if (this.#host.isStreaming() && this.transcript.isCurrent(target)) {
			this.#pendingMessages.push({ target, message });
			return;
		}
		if (target.destination) {
			try {
				this.transcript.append(target.destination, message);
			} finally {
				void this.transcript.release(target);
			}
			return;
		}
		void this.transcript.appendOwned(target, message).catch(error => {
			logger.error("Failed to record bash result in its owning session", { error: String(error) });
		});
	}

	/** Cancels every running bash command. */
	abort(): void {
		for (const abortController of this.#abortControllers) abortController.abort();
	}

	/** Waits for every cancelled command's native TERM→KILL cleanup, whichever session it started under. */
	async drainCancelled(): Promise<void> {
		await Promise.all([...this.#cancelledSessionIds].map(drainAbortedShells));
	}

	/** Whether a bash command is currently running. */
	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	/** Whether bash results are waiting for a safe persistence boundary. */
	get hasPendingMessages(): boolean {
		return this.#pendingMessages.length > 0;
	}

	/** Flushes deferred bash results without changing their captured ownership. */
	async flushPending(): Promise<void> {
		if (this.#pendingMessages.length === 0) return;
		const pending = this.#pendingMessages;
		this.#pendingMessages = [];
		for (const { target, message } of pending) await this.transcript.appendOwned(target, message);
	}

	/** Runs a leaf rewrite while retaining in-flight bash on its originating branch. */
	withBranchTransition<T>(mutate: () => T): T {
		const transition = this.beginSessionTransition();
		let transitioned = false;
		try {
			const result = mutate();
			this.markSessionTransition(transition);
			transitioned = true;
			return result;
		} finally {
			this.finishSessionTransition(transition, transitioned);
		}
	}

	/** Snapshots the owner of in-flight user execution before a transcript transition. */
	beginSessionTransition(options?: { persistDetached?: boolean }): ExecutionSessionTransition {
		return this.transcript.beginSessionTransition(options);
	}

	markSessionTransition(transition: ExecutionSessionTransition): void {
		this.transcript.markSessionTransition(transition);
	}

	finishSessionTransition(transition: ExecutionSessionTransition, success: boolean): void {
		this.transcript.finishSessionTransition(transition, success);
		// Shell lifecycle remains bash-owned; transcript ownership is shared with eval.
		if (success && transition.oldSessionId !== this.#host.sessionManager.getSessionId()) {
			releaseShellSessions(transition.oldSessionId);
		}
	}

	async #saveOriginalArtifact(target: ExecutionSessionTarget, originalText: string): Promise<string | undefined> {
		try {
			const destination = target.destination ?? (await target.pending);
			return await destination?.manager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}

	#createMessage(
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean },
	): BashExecutionMessage {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).minimized(result.minimized).get();
		return {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			images: result.images,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
	}

	async #recordResultForTarget(
		target: ExecutionSessionTarget,
		command: string,
		result: BashResult,
		options?: BashExecuteOptions,
	): Promise<void> {
		const message = this.#createMessage(command, result, options);
		if (this.#host.isStreaming() && this.transcript.isCurrent(target)) {
			this.#pendingMessages.push({ target, message });
		} else {
			await this.transcript.appendOwned(target, message);
		}
		try {
			options?.onRecorded?.(message);
		} catch (error) {
			logger.error("bash onRecorded callback failed", { error: String(error) });
		}
	}
}

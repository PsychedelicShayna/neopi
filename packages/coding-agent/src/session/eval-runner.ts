import { logger } from "@oh-my-pi/pi-utils";
import { jsBackend, pythonBackend } from "../eval";
import type { ExecutorBackend, ExecutorBackendResult } from "../eval/backend";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { defaultEvalSessionId } from "../eval/session-id";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { ToolSession } from "../tools";
import { outputMeta } from "../tools/output-meta";
import { evalBackendRegistry, extensionBackendAdapter, invokeEvalCell } from "./eval-service";
import type { ExecutionSessionTarget, ExecutionTranscript } from "./execution-transcript";
import type { EvalExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

export interface EvalRunnerHost {
	sessionManager: SessionManager;
	transcript: ExecutionTranscript;
	extensionRunner(): ExtensionRunner | undefined;
	toolSession(): ToolSession;
	isStreaming(): boolean;
}

export interface UserEvalOptions {
	excludeFromContext?: boolean;
	reset?: boolean;
	/** Prefix alias selected by the user; defaults to the resolved language token. */
	alias?: string;
	/** Receives the `evalExecution` message once persisted or queued for a mid-turn flush. */
	onRecorded?: (message: EvalExecutionMessage) => void;
}

interface PendingEvalMessage {
	target: ExecutionSessionTarget;
	message: EvalExecutionMessage;
}

/** Owns user-initiated generic eval execution and retained backend lifecycle. */
export class EvalRunner {
	readonly #kernelOwnerId: string;
	readonly #parentSessionId: string | undefined;
	readonly #host: EvalRunnerHost;
	#abortControllers = new Map<AbortController, string>();
	#pendingMessages: PendingEvalMessage[] = [];
	#activeExecutions = new Set<Promise<unknown>>();
	#disposing = false;

	constructor(host: EvalRunnerHost, options: { kernelOwnerId: string; parentSessionId?: string }) {
		this.#host = host;
		this.#kernelOwnerId = options.kernelOwnerId;
		this.#parentSessionId = options.parentSessionId;
	}

	async execute(
		language: string,
		code: string,
		onChunk?: (chunk: string) => void,
		options?: UserEvalOptions,
	): Promise<ExecutorBackendResult> {
		this.assertExecutionAllowed();
		const target = this.#host.transcript.capture();
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		const abortController = new AbortController();
		const canonicalLanguage = this.#canonicalLanguage(language);
		const execution = (async () => {
			let targetTransferred = false;
			try {
				const extensionRunner = this.#host.extensionRunner();
				if (extensionRunner?.hasHandlers("user_eval")) {
					const hookResult = await extensionRunner.emitUserEval({
						type: "user_eval",
						language,
						alias: options?.alias ?? language,
						code,
						excludeFromContext,
						cwd,
					});
					this.assertExecutionAllowed();
					if (hookResult?.result) {
						targetTransferred = true;
						await this.#recordResultForTarget(target, language, code, hookResult.result, options);
						return hookResult.result;
					}
				}

				const session = this.#host.toolSession();
				const backend = await this.#resolveBackend(language, session, abortController.signal);
				const sessionId = this.getSessionId();
				const result = await invokeEvalCell(backend, code, {
					cwd,
					sessionId,
					sessionFile: this.#host.sessionManager.getSessionFile() ?? undefined,
					kernelOwnerId: this.#kernelOwnerId,
					signal: abortController.signal,
					session,
					reset: options?.reset === true,
					onChunk: onChunk ?? (() => {}),
				});
				targetTransferred = true;
				await this.#recordResultForTarget(target, backend.id, code, result, options);
				return result;
			} finally {
				if (!targetTransferred) await this.#host.transcript.release(target);
			}
		})();
		return await this.trackExecution(execution, abortController, canonicalLanguage);
	}

	async #resolveBackend(token: string, session: ToolSession, signal: AbortSignal): Promise<ExecutorBackend> {
		const builtin: Record<string, ExecutorBackend> = {
			py: pythonBackend,
			python: pythonBackend,
			js: jsBackend,
			javascript: jsBackend,
		};
		const backend =
			builtin[token] ??
			(() => {
				const registered = evalBackendRegistry(this.#host.sessionManager).resolve(token);
				return registered ? extensionBackendAdapter(registered) : undefined;
			})();
		if (!backend) throw new Error(`Unknown eval backend: ${token}`);
		const availability = await backend.checkAvailability(session, { signal });
		signal.throwIfAborted();
		if (!availability.ok) {
			throw new Error(
				`Eval backend "${token}" is unavailable${availability.reason ? `: ${availability.reason}` : ""}`,
			);
		}
		return backend;
	}

	assertExecutionAllowed(): void {
		if (this.#disposing) throw new Error("Eval execution is unavailable while session disposal is in progress");
	}

	trackExecution<T>(execution: Promise<T>, abortController: AbortController, language?: string): Promise<T> {
		this.#abortControllers.set(abortController, language ?? "unknown");
		this.#activeExecutions.add(execution);
		void execution
			.finally(() => {
				this.#abortControllers.delete(abortController);
				this.#activeExecutions.delete(execution);
			})
			.catch(() => undefined);
		return execution;
	}

	recordResult(language: string, code: string, result: ExecutorBackendResult, options?: UserEvalOptions): void {
		const target = this.#host.transcript.capture();
		void this.#recordResultForTarget(target, language, code, result, options).catch(error => {
			logger.error("Failed to record eval result in its owning session", { error: String(error) });
		});
	}

	async #recordResultForTarget(
		target: ExecutionSessionTarget,
		language: string,
		code: string,
		result: ExecutorBackendResult,
		options?: UserEvalOptions,
	): Promise<void> {
		const message: EvalExecutionMessage = {
			role: "evalExecution",
			language,
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			meta: outputMeta().truncationFromSummary(result, { direction: "tail" }).get(),
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
		if (!this.#disposing && this.#host.isStreaming() && this.#host.transcript.isCurrent(target)) {
			this.#pendingMessages.push({ target, message });
		} else {
			await this.#host.transcript.appendOwned(target, message);
		}
		try {
			options?.onRecorded?.(message);
		} catch (error) {
			logger.error("eval onRecorded callback failed", { error: String(error) });
		}
	}

	abort(): void {
		if (this.#abortControllers.size === 0) return;
		for (const controller of this.#abortControllers.keys()) controller.abort();
		void evalBackendRegistry(this.#host.sessionManager).interrupt();
	}

	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	/** Whether a specific language/backend has an active execution. */
	isLanguageRunning(language: string): boolean {
		const canonical = this.#canonicalLanguage(language);
		for (const lang of this.#abortControllers.values()) {
			if (lang === canonical) return true;
		}
		return false;
	}
	get hasPendingMessages(): boolean {
		return this.#pendingMessages.length > 0;
	}
	getKernelOwnerId(): string {
		return this.#kernelOwnerId;
	}
	getSessionId(): string {
		if (this.#parentSessionId !== undefined) return this.#parentSessionId;
		return defaultEvalSessionId({
			cwd: this.#host.sessionManager.getCwd(),
			getSessionFile: () => this.#host.sessionManager.getSessionFile() ?? null,
		});
	}
	async flushPending(): Promise<void> {
		const pending = this.#pendingMessages;
		this.#pendingMessages = [];
		for (const { target, message } of pending) await this.#host.transcript.appendOwned(target, message);
	}
	beginDispose(): void {
		this.#disposing = true;
	}

	async disposeKernels(): Promise<void> {
		const settled = await this.#prepareExecutionsForDispose();
		await this.flushPending();
		if (!settled) logger.warn("Detaching retained eval-kernel ownership while eval execution is still active");
		const results = await Promise.allSettled([
			disposeKernelSessionsByOwner(this.#kernelOwnerId),
			disposeVmContextsByOwner(this.#kernelOwnerId),
			evalBackendRegistry(this.#host.sessionManager).dispose(),
		]);
		const errors = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length) throw new AggregateError(errors, "Failed to dispose one or more eval kernels");
	}

	async #waitForExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeExecutions.size) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			const settled = await Promise.race([
				Promise.allSettled(this.#activeExecutions).then(() => true),
				Bun.sleep(remaining).then(() => false),
			]);
			if (!settled && this.#activeExecutions.size) return false;
		}
		return true;
	}
	async #prepareExecutionsForDispose(): Promise<boolean> {
		if (await this.#waitForExecutionsToSettle(3_000)) return true;
		logger.warn("Aborting active eval execution during dispose before retained kernel cleanup");
		this.abort();
		return await this.#waitForExecutionsToSettle(1_000);
	}

	/** Normalize language aliases to canonical tokens for per-language tracking. */
	#canonicalLanguage(token: string): string {
		switch (token) {
			case "py":
			case "python":
				return "py";
			case "js":
			case "javascript":
				return "js";
			case "rb":
			case "ruby":
				return "rb";
			case "jl":
			case "julia":
				return "jl";
			default:
				return token;
		}
	}
}

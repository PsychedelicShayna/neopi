/**
 * Serialized session Chronicler runtime.
 *
 * One background owner per host session. A synchronous scheduler freezes a
 * session descriptor and the message-entry snapshot, then appends a request to
 * one serialized async work chain; every attempt closes over that frozen
 * descriptor plus its own store, batch, tools, and Agent, so no completion can
 * resolve a newly selected session's store or artifacts root. A generation
 * token revokes an old attempt — synchronously, including its uncommitted batch
 * — on disable, rebind, model config change, or shutdown deadline.
 *
 * This owns capture only: it never advises the primary, injects recall, or
 * touches the memory backend. It reuses the Agent construction and role/effort
 * helpers established for advisors, but none of their message-count cursor or
 * advice machinery.
 */
import { Agent, type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { estimateTranscriptTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Api, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { acquireFileLock, FileLockContentionError, type FileLockHandle, logger, prompt } from "@oh-my-pi/pi-utils";
import { AdvisorTranscriptRecorder, deriveAdvisorTelemetry } from "../advisor";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveChroniclerRoleSelection } from "../config/model-resolver";
import { cfgModelRoles } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { cfgChroniclerEnabled } from "./settings";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import contextTemplate from "../prompts/chronicler/context.md" with { type: "text" };
import systemTemplate from "../prompts/chronicler/system.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { SessionMessageEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import { sameMessageContent, sessionMessagePersistenceKey } from "../session/turn-persistence";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "@oh-my-pi/pi-tui/thinking";
import { CHRONICLER_TOOL_SCHEMAS, ChronicleTool, FinishChronicleTool, ReadChronicleTool } from "./chronicle-tool";
import type { ChronicleEntry } from "./render";
import { renderChronicleDelta } from "./render";
import { type CaptureBatch, type CaptureSource, ChroniclerStore, isChroniclerCorruption } from "./store";

/**
 * The slice of a session the runtime reads. {@link AgentSession} passes its
 * live SessionManager; the headless backfill passes a read-only view over a
 * stored transcript whose persistence members are no-ops.
 */
export type ChroniclerSessionView = Pick<
	SessionManager,
	"getSessionId" | "getSessionFile" | "getArtifactsDir" | "getEntries" | "ensureOnDisk" | "isSessionOnDisk" | "flush"
>;

/**
 * Host seam the runtime binds against. The two persistence-order callbacks and
 * `isCaptureEligible` are wired by {@link AgentSession}; everything else mirrors
 * the advisor host surface.
 */
export interface SessionChroniclerHost {
	/** Source of telemetry inherited by the capture Agent. */
	agent: Pick<Agent, "telemetry">;
	sessionManager: ChroniclerSessionView;
	settings: Settings;
	modelRegistry: ModelRegistry;
	obfuscator: SecretObfuscator | undefined;
	providerSessionState: Map<string, ProviderSessionState>;
	preferWebsockets: boolean | undefined;
	isDisposed(): boolean;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	cwd(): string;
	/** True only for a capturable top-level session (SDK taskDepth 0, no parentTaskPrefix). */
	isCaptureEligible(): boolean;
}

export type ChroniclerStatus =
	| "off"
	| "no_model"
	| "running"
	| "halted"
	| "retrying"
	| "contended"
	| "suspended"
	| "stopping"
	| "stopped";

export interface ChroniclerHealth {
	readonly status: ChroniclerStatus;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly artifactsDir?: string;
	readonly lastCommittedAt?: string;
	readonly error?: string;
	readonly retryAt?: number;
}

interface RoleSelection {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	modelString: string;
}

/** Session identity frozen at scheduling time; never re-read from the live manager. */
interface SessionDescriptor {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly artifactsDir: string;
	readonly cwd: string;
}

/** One scheduled wake: frozen descriptor plus the entry snapshot taken with it. */
interface ScheduledScan {
	readonly gen: number;
	readonly descriptor: SessionDescriptor;
	readonly entries: readonly ChronicleEntry[];
	readonly entryIds: ReadonlySet<string>;
	forceFlush: boolean;
}

/**
 * A bound writer. The Agent is retained across passes so a successful pass keeps
 * its model context; it is rebuilt only under budget pressure or after a failed
 * attempt. Nothing here is re-derived from the live SessionManager.
 */
interface ChroniclerBinding {
	readonly gen: number;
	readonly descriptor: SessionDescriptor;
	readonly store: ChroniclerStore;
	readonly recorder: AdvisorTranscriptRecorder;
	readonly model: Model<Api>;
	readonly modelString: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly systemText: string;
	readonly agent: Agent;
	readonly agentUnsubscribe: () => void;
	/**
	 * Exclusive OS-backed lease on this session's chronicler store. Two processes
	 * on one session (a resumed window beside the original) would otherwise each
	 * commit batches over the same entries and halt the store.
	 */
	readonly lease: FileLockHandle;
}

interface PendingRendezvous {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly message: AgentMessage;
	readonly gen: number;
	readonly willContinue: boolean | undefined;
}

type PrefixSelection = { kind: "ok"; entries: readonly ChronicleEntry[]; requestText: string } | { kind: "oversized" };

type AttemptOutcome =
	| { kind: "committed" }
	| { kind: "revoked" }
	| { kind: "failed"; error: string }
	| { kind: "corruption"; error: string };

/** Chronicler model transcript, recorded per binding beneath the session dir. */
const RECORDER_FILENAME = "chronicler/__chronicler.jsonl";
/** At most this many unseen entries materialize into one capture pass. */
const MAX_PREFIX_ENTRIES = 60;
/** At most this many committed beats are listed in the framing before trimming. */
const MAX_BEAT_LISTING = 200;
/** willContinue-true wakes defer until this many unseen serialized chars accrue. */
const UNSEEN_FLUSH_CHARS = 80_000;
/** Generic working budget when the model reports no usable context window. */
const GENERIC_BUDGET_TOKENS = 32_000;
/** Fraction of a known positive context window a capture pass may fill. */
const CONTEXT_BUDGET_FRACTION = 0.7;
/** Consecutive failed attempts in one capture burst before reconciliation. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Backoff before each retry of the same unseen prefix. */
const RETRY_BACKOFF_MS = [2_000, 4_000];
/** Autonomous recovery is exponential but never waits more than one minute. */
const MAX_RECOVERY_BACKOFF_MS = 60_000;
const OWNERSHIP_CHECK_MS = 60_000;
/** Abort a model attempt after this long without any streamed assistant event. */
const STREAM_STALL_MS = 60 * 60 * 1_000;
/** Hard per-attempt deadline, slightly beyond the resettable idle watchdog. */
const ATTEMPT_DEADLINE_MS = 65 * 60 * 1_000;

const chroniclerTimerIO = {
	setTimeout: (callback: () => void, delayMs: number): Timer => setTimeout(callback, delayMs),
	clearTimeout: (timer: Timer | undefined): void => clearTimeout(timer),
};

export const __sessionChroniclerInternalsForTesting = { chroniclerTimerIO };
/** Default drain deadline for model work at shutdown. */
const DEFAULT_DRAIN_MS = 20_000;
/** Recent persisted-message identities kept for the turn-end rendezvous. */
const SETTLED_KEY_LIMIT = 32;

export class SessionChronicler {
	readonly #host: SessionChroniclerHost;

	#generation = 0;
	#status: ChroniclerStatus = "off";
	#stopping = false;
	#cleanedUp = false;
	#deadlineExpired = false;
	#deadlineSignal = Promise.withResolvers<void>();
	#scheduledDescriptor: SessionDescriptor | undefined;

	#suspended = false;
	#suspension: Promise<void> | undefined;
	#attemptFence = Promise.withResolvers<void>();
	#retryTimer: Timer | undefined;
	#ownershipTimer: Timer | undefined;
	#retryAt: number | undefined;
	#retryAttempt = 0;
	#reconcile = false;
	#error: string | undefined;
	#failureWarned: string | undefined;
	#lastCommittedAt: string | undefined;
	#lastCommittedDescriptor: SessionDescriptor | undefined;
	#chain: Promise<void> = Promise.resolve();
	#scanQueued = false;
	#pendingScan: ScheduledScan | undefined;

	#binding: ChroniclerBinding | undefined;
	/** The only uncommitted batch that may exist; revoked synchronously on any fence. */
	#activeBatch: CaptureBatch | undefined;

	#settingsUnsub: (() => void) | undefined;

	/** Recent persisted-message identities: cloned assistants break object identity. */
	#settled = new Map<string, AgentMessage[]>();
	#pendingRendezvous: PendingRendezvous | undefined;

	constructor(host: SessionChroniclerHost) {
		this.#host = host;
		// Synchronous (not the microtask-coalesced Setting.listen): a disable must revoke an
		// in-flight publication before the caller's next await.
		this.#settingsUnsub = host.settings.onEffectiveChange([cfgChroniclerEnabled, cfgModelRoles], () =>
			this.#onSettingChange(),
		);
		// An idle resumed on-disk session must catch up its backlog without
		// requiring another user turn, so scan once at construction.
		this.#scheduleWake(true);
	}

	get status(): ChroniclerStatus {
		return this.#status;
	}

	get health(): ChroniclerHealth {
		const manager = this.#host.sessionManager;
		const committed = this.#lastCommittedDescriptor;
		const sameHistory =
			committed &&
			manager.getSessionId() === committed.sessionId &&
			manager.getSessionFile() === committed.sessionFile &&
			manager.getArtifactsDir() === committed.artifactsDir &&
			this.#host.cwd() === committed.cwd;
		return {
			status:
				this.#cleanedUp && !this.#binding
					? "stopped"
					: this.#stopping
						? "stopping"
						: this.#suspended
							? "suspended"
							: this.#status,
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile(),
			artifactsDir: manager.getArtifactsDir() ?? undefined,
			lastCommittedAt: sameHistory ? this.#lastCommittedAt : undefined,
			error: this.#error,
			retryAt: this.#retryAt,
		};
	}

	/** Fence synchronously, then settle filesystem work before the host moves it. */
	async suspendForSessionChange(): Promise<void> {
		if (this.#suspension) return this.#suspension;
		if (this.#cleanedUp) return;
		this.#suspended = true;
		this.#cancelTimers();
		this.#resetRecovery();
		this.#pendingScan = undefined;
		this.#revokeNow("chronicler session transition", true);
		this.#status = "suspended";
		this.#settled.clear();
		const suspension = this.#chain.then(async () => {
			await this.#disableBinding();
			this.#scheduledDescriptor = undefined;
			this.#status = "suspended";
		});
		// The caller must see teardown failure, but it must not poison the owner
		// chain: a rollback/resume still needs to enqueue a real reconciliation scan.
		this.#chain = suspension.catch(error => {
			this.#error = `Session transition suspension failed: ${errorText(error)}`;
			this.#status = "suspended";
			this.#host.emitNotice("warning", `Chronicler ${this.#error}`, "chronicler");
		});
		this.#suspension = suspension;
		await suspension;
	}

	/** Also catch up when a failed transition restored the unchanged identity. */
	resumeAfterSessionChange(): void {
		if (this.#stopping || this.#cleanedUp) return;
		this.#suspension = undefined;
		this.#suspended = false;
		this.#status = "off";
		this.#resetRecovery();
		this.#scheduleWake(true);
	}

	/**
	 * The primary finished a turn. Schedules a capture wake; when `lastMessage`
	 * is supplied the wake parks until that message's persistence settles, so the
	 * frozen snapshot includes it. Model work is never awaited here.
	 */
	onPrimaryTurnEnd(willContinue: boolean | undefined, lastMessage?: AgentMessage): void {
		if (!this.#enabled() || !this.#host.isCaptureEligible()) return;
		if (this.#suspended || this.#stopping || this.#cleanedUp || this.#host.isDisposed()) return;
		this.#fenceSessionChange();
		// A new turn end supersedes any earlier park: a stale generation's
		// persistence may never notify, and a dangling park must not linger.
		this.#pendingRendezvous = undefined;
		if (lastMessage) {
			const key = sessionMessagePersistenceKey(lastMessage);
			if (key && !this.#isSettled(lastMessage)) {
				this.#pendingRendezvous = {
					message: lastMessage,
					gen: this.#generation,
					willContinue,
					sessionId: this.#host.sessionManager.getSessionId(),
					sessionFile: this.#host.sessionManager.getSessionFile(),
				};
				return;
			}
		}
		this.#scheduleWake(willContinue !== true);
	}

	/**
	 * Existing session persistence completed for one message (including entries
	 * intentionally skipped by the primary path). Records the settled identity,
	 * materializes a durable root for a first-turn user intention, and resolves a
	 * parked turn-end wake. Never scans or copies `getEntries()` on its own.
	 */
	onPrimaryMessagePersisted(message: AgentMessage): void {
		if (!this.#enabled() || !this.#host.isCaptureEligible()) return;
		if (this.#suspended || this.#stopping || this.#cleanedUp || this.#host.isDisposed()) return;
		this.#fenceSessionChange();
		this.#recordSettled(message);
		if (message.role === "user") this.#maybeEnsureOnDisk();

		const pending = this.#pendingRendezvous;
		if (
			pending &&
			pending.gen === this.#generation &&
			pending.sessionId === this.#host.sessionManager.getSessionId() &&
			pending.sessionFile === this.#host.sessionManager.getSessionFile() &&
			this.#messagesMatch(pending.message, message)
		) {
			this.#pendingRendezvous = undefined;
			this.#scheduleWake(pending.willContinue !== true);
		}
	}

	/**
	 * Snapshot still-unseen work and schedule a final flush, then reject further
	 * scheduling even though the host is disposed. Idempotent; a disabled runtime
	 * stays off (the enable gate still applies inside the scan).
	 */
	beginStop(): void {
		if (this.#stopping) return;
		const recovering = this.#retryTimer !== undefined;
		this.#cancelTimers();
		this.#pendingRendezvous = undefined;
		if (recovering) this.#pendingScan = undefined;
		else this.#scheduleWake(true, true);
		this.#stopping = true;
	}

	/**
	 * Resolve once the owner chain holds no queued or running work. A headless
	 * host waits on this for the construction-time backlog walk to finish
	 * (covered, halted, unresolved model, or contended lease) before draining.
	 */
	async idle(): Promise<void> {
		let chain: Promise<void>;
		do {
			chain = this.#chain;
			await chain;
		} while (chain !== this.#chain);
	}

	/**
	 * Wait for the owner chain to settle, then release ownership. The deadline
	 * bounds model work: at expiry every attempt is fenced and the model aborted,
	 * and the only remaining wait is an already-started publication, so a provider
	 * that ignores its abort cannot extend shutdown.
	 */
	async drain(timeoutMs: number = DEFAULT_DRAIN_MS): Promise<void> {
		this.beginStop();

		const deadline = Promise.withResolvers<void>();
		const timer = setTimeout(() => deadline.resolve(), Math.max(0, timeoutMs));
		let settledInTime: boolean;
		try {
			settledInTime = await Promise.race([
				this.#chain.then(
					() => true,
					() => true,
				),
				deadline.promise.then(() => false),
			]);
		} finally {
			clearTimeout(timer);
		}

		if (!settledInTime) {
			this.#deadlineExpired = true;
			this.#deadlineSignal.resolve();
			this.#pendingScan = undefined;
			this.#revokeNow("chronicler drain deadline", true);
		}
		// A detached model cannot extend shutdown; publication and recorder writes
		// remain owned until their filesystem work settles.
		await this.#chain;
		await this.#cleanup();
	}

	// ---- scheduling -------------------------------------------------------

	/**
	 * Freeze the session descriptor and message-entry snapshot synchronously, then
	 * queue one serialized scan. Redundant wakes collapse onto the freshest
	 * snapshot; nothing downstream re-reads the live manager for identity.
	 */
	#scheduleWake(forceFlush: boolean, bypassStop = false): void {
		if (this.#suspended || this.#deadlineExpired || this.#cleanedUp || this.#retryTimer !== undefined) return;
		if ((this.#stopping || this.#host.isDisposed()) && !bypassStop) return;
		if (!this.#enabled()) return;
		if (!this.#host.isCaptureEligible()) return;

		const manager = this.#host.sessionManager;
		const sessionFile = manager.getSessionFile();
		const artifactsDir = manager.getArtifactsDir();
		// No allocated file or root means a truly in-memory session: skip until a
		// later wake rather than invent a fake artifacts root.
		if (!sessionFile || !artifactsDir) return;

		const descriptor: SessionDescriptor = Object.freeze({
			sessionId: manager.getSessionId(),
			sessionFile,
			artifactsDir,
			cwd: this.#host.cwd(),
		});

		const previous = this.#scheduledDescriptor;
		if (previous && !this.#sameDescriptor(previous, descriptor)) {
			this.#revokeNow("chronicler session changed");
			this.#status = "off";
			this.#settled.clear();
		}
		this.#scheduledDescriptor = descriptor;

		const entries: ChronicleEntry[] = [];
		const entryIds = new Set<string>();
		for (const entry of manager.getEntries()) {
			if (entry.type !== "message") continue;
			const message = entry as SessionMessageEntry;
			entries.push({
				id: message.id,
				parentId: message.parentId,
				timestamp: message.timestamp,
				message: message.message,
			});
			entryIds.add(message.id);
		}

		this.#pendingScan = {
			gen: this.#generation,
			descriptor,
			entries,
			entryIds,
			forceFlush: forceFlush || (this.#pendingScan?.gen === this.#generation && this.#pendingScan.forceFlush),
		};

		if (this.#scanQueued) return;
		this.#scanQueued = true;
		this.#chain = this.#chain
			.then(() => this.#runScan())
			.catch(error => {
				this.#requestRetry(errorText(error), isChroniclerCorruption(error) ? "halted" : "retrying");
			});
	}

	#onSettingChange(): void {
		if (this.#cleanedUp || this.#deadlineExpired || this.#stopping) return;
		this.#cancelTimers();
		this.#resetRecovery();
		this.#status = this.#suspended ? "suspended" : "off";
		this.#revokeNow("chronicler settings change");
		if (!this.#enabled()) {
			this.#pendingScan = undefined;
			this.#chain = this.#chain
				.then(() => {
					if (!this.#enabled()) return this.#disableBinding();
				})
				.catch(error => {
					logger.warn("Chronicler disable failed", { error: String(error) });
				});
		}
		this.#settled.clear();
		this.#scheduleWake(true);
	}

	/**
	 * Synchronously fence everything in flight: bump the generation, revoke the
	 * single uncommitted batch so a publication cannot slip past its pre-rename
	 * check. Ordinary revocation owns the in-flight completion; transitions,
	 * lost ownership and the terminal deadline detach its fenced Agent.
	 */
	#revokeNow(reason: string, detach = false): void {
		this.#generation++;
		const batch = this.#activeBatch;
		if (batch && !Object.isFrozen(batch)) batch.revoked = true;
		if (detach) {
			this.#binding?.agentUnsubscribe();
			this.#binding?.agent.abort(reason);
			this.#attemptFence.resolve();
			this.#attemptFence = Promise.withResolvers<void>();
		}
		this.#pendingRendezvous = undefined;
	}

	// ---- persistence rendezvous ------------------------------------------

	#fenceSessionChange(): void {
		const previous = this.#scheduledDescriptor;
		const manager = this.#host.sessionManager;
		if (
			previous &&
			(previous.sessionId !== manager.getSessionId() ||
				previous.sessionFile !== manager.getSessionFile() ||
				previous.artifactsDir !== manager.getArtifactsDir() ||
				previous.cwd !== this.#host.cwd())
		) {
			this.#revokeNow("chronicler session changed");
			this.#status = "off";
			this.#scheduledDescriptor = undefined;
			this.#pendingScan = undefined;
			this.#settled.clear();
		}
	}

	#settledKey(message: AgentMessage): string | undefined {
		const key = sessionMessagePersistenceKey(message);
		return key === undefined
			? undefined
			: JSON.stringify([
					this.#generation,
					this.#host.sessionManager.getSessionId(),
					this.#host.sessionManager.getSessionFile(),
					key,
				]);
	}

	#recordSettled(message: AgentMessage): void {
		const key = this.#settledKey(message);
		if (!key) return;
		const existing = this.#settled.get(key);
		if (existing) {
			existing.push(message);
			return;
		}
		this.#settled.set(key, [message]);
		while (this.#settled.size > SETTLED_KEY_LIMIT) {
			const oldest = this.#settled.keys().next().value;
			if (oldest === undefined) break;
			this.#settled.delete(oldest);
		}
	}

	#isSettled(message: AgentMessage): boolean {
		const key = this.#settledKey(message);
		if (!key) return false;
		const seen = this.#settled.get(key);
		return seen?.some(candidate => sameMessageContent(candidate, message)) ?? false;
	}

	#messagesMatch(a: AgentMessage, b: AgentMessage): boolean {
		const key = sessionMessagePersistenceKey(a);
		return key !== undefined && key === sessionMessagePersistenceKey(b) && sameMessageContent(a, b);
	}

	/**
	 * Persistence is lazy, so a first-turn user intention can exist with no file
	 * even though its path is allocated. Materialize it against a frozen
	 * descriptor, rechecked immediately before the call.
	 */
	#maybeEnsureOnDisk(): void {
		if (this.#suspended || this.#stopping || this.#cleanedUp || this.#host.isDisposed()) return;
		if (!this.#host.isCaptureEligible() || !this.#enabled()) return;
		const manager = this.#host.sessionManager;
		const frozenFile = manager.getSessionFile();
		const gen = this.#generation;
		const frozenId = manager.getSessionId();
		// Only a session with an allocated file may be materialized: never invent
		// a fake artifacts root for an in-memory session.
		if (!frozenFile || manager.isSessionOnDisk()) return;
		this.#chain = this.#chain
			.then(async () => {
				if (gen !== this.#generation || this.#suspended || !this.#enabled()) return;
				if (manager.getSessionFile() !== frozenFile || manager.getSessionId() !== frozenId) return;
				if (manager.isSessionOnDisk()) return;
				await manager.ensureOnDisk();
			})
			.catch(error => {
				if (gen === this.#generation) this.#requestRetry(`Transcript materialization failed: ${errorText(error)}`);
			});
	}

	// ---- scan -------------------------------------------------------------

	#enabled(): boolean {
		return cfgChroniclerEnabled.get(this.#host.settings);
	}

	async #runScan(): Promise<void> {
		this.#scanQueued = false;
		const scan = this.#pendingScan;
		this.#pendingScan = undefined;
		if (!scan) return;

		const gen = scan.gen;
		if (this.#suspended || this.#deadlineExpired || this.#cleanedUp || gen !== this.#generation) return;
		// An already queued turn wake must not bypass an autonomous recovery backoff.
		// Its source entries remain in the transcript for the timer's fresh snapshot.
		if (this.#retryTimer !== undefined) return;
		if (!this.#host.isCaptureEligible()) return;

		if (!this.#enabled()) {
			await this.#disableBinding();
			return;
		}

		const selection = this.#resolveSelection();
		if (!selection) {
			this.#requestRetry("No model resolved for the chronicler role", "no_model", false);
			return;
		}

		if (!(await this.#materialize(scan.descriptor, gen))) return;

		let binding: ChroniclerBinding | undefined;
		try {
			binding = await this.#ensureBinding(scan.descriptor, selection);
		} catch (error) {
			if (this.#generation === gen) this.#handleBindingError(error);
			return;
		}
		if (!binding || this.#generation !== binding.gen) return;
		this.#status = "running";

		await this.#drainBacklog(binding, scan);
		if (gen === this.#generation && this.#retryAt === undefined) this.#resetRecovery();
	}

	/**
	 * Force the frozen session onto disk when persistence has not yet fired.
	 * Returns false when the wake was fenced or the host moved off this session
	 * across the await.
	 */
	async #materialize(descriptor: SessionDescriptor, gen: number): Promise<boolean> {
		const manager = this.#host.sessionManager;
		const stillCurrent = () =>
			this.#generation === gen &&
			!this.#deadlineExpired &&
			manager.getSessionFile() === descriptor.sessionFile &&
			manager.getSessionId() === descriptor.sessionId;
		if (!stillCurrent()) return false;
		try {
			await manager.ensureOnDisk();
			if (!stillCurrent()) return false;
			if (!manager.isSessionOnDisk()) {
				this.#requestRetry("Transcript materialization did not produce a durable session");
				return false;
			}
			await manager.flush();
			if (!stillCurrent()) return false;
			if (!manager.isSessionOnDisk()) {
				this.#requestRetry("Transcript flush did not leave a durable session");
				return false;
			}
			return true;
		} catch (error) {
			if (stillCurrent()) this.#requestRetry(`Transcript durability failed: ${errorText(error)}`);
			return false;
		}
	}

	/**
	 * Capture the frozen snapshot's backlog in bounded passes until nothing
	 * remains or the wake defers. Each pass recomputes unseen from the committed
	 * union, so a committed pass strictly shrinks the remaining work.
	 */
	async #drainBacklog(binding: ChroniclerBinding, scan: ScheduledScan): Promise<void> {
		while (this.#generation === binding.gen) {
			const processed = binding.store.processedEntryIds;
			const unseen = scan.entries.filter(entry => !processed.has(entry.id));
			if (unseen.length === 0) return;

			if (!scan.forceFlush && this.#serializedChars(unseen) < UNSEEN_FLUSH_CHARS) return;

			const outcome = await this.#capturePass(binding, unseen, scan.entryIds);
			if (outcome !== "committed") return;
		}
	}

	#serializedChars(entries: readonly ChronicleEntry[]): number {
		let total = 0;
		for (const entry of entries) total += JSON.stringify(entry.message).length;
		return total;
	}

	// ---- one capture pass -------------------------------------------------

	async #capturePass(
		binding: ChroniclerBinding,
		unseen: readonly ChronicleEntry[],
		ownedIds: ReadonlySet<string>,
	): Promise<"committed" | "revoked" | "halted"> {
		const selected = this.#selectPrefix(binding, unseen, ownedIds);
		if (selected.kind === "oversized") {
			this.#requestRetry(
				"One transcript entry exceeds the capture input budget; no entries were skipped.",
				"halted",
			);
			return "halted";
		}

		let attempt = 0;
		while (true) {
			if (this.#generation !== binding.gen || !this.#ownsLease(binding)) return "revoked";

			const outcome = await this.#runAttempt(binding, selected.entries, selected.requestText);
			if (outcome.kind === "committed") return "committed";
			if (outcome.kind === "revoked") return "revoked";
			if (outcome.kind === "corruption") {
				this.#requestRetry(outcome.error, "halted");
				return "halted";
			}

			attempt += 1;
			if (attempt >= MAX_CONSECUTIVE_FAILURES) {
				this.#requestRetry(`Capture failed after ${attempt} attempts: ${outcome.error}`);
				return "halted";
			}
			// A failed attempt is never retained as if committed: rebuild the model
			// conversation from committed framing before retrying the same prefix.
			this.#rebuildConversation(binding);
			const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
			if (!this.#stopping) {
				this.#status = "retrying";
				this.#error = outcome.error;
				this.#retryAt = Date.now() + backoff;
			}
			const retry = await this.#sleep(backoff, binding.gen);
			if (this.#retryTimer === undefined) this.#retryAt = undefined;
			if (!retry) return "revoked";
			this.#status = "running";
		}
	}

	/**
	 * Run a single model pass over a fixed unseen prefix, then commit only when
	 * the pass genuinely succeeded and finalized the still-valid batch.
	 */
	async #runAttempt(
		binding: ChroniclerBinding,
		entries: readonly ChronicleEntry[],
		requestText: string,
	): Promise<AttemptOutcome> {
		const sources: CaptureSource[] = entries.map(entry => ({
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
		}));

		let batch: CaptureBatch;
		try {
			batch = binding.store.beginBatch(sources);
		} catch (error) {
			if (isChroniclerCorruption(error)) return { kind: "corruption", error: errorText(error) };
			return { kind: "failed", error: errorText(error) };
		}
		this.#activeBatch = batch;

		try {
			const knownSources = this.#buildKnownSources(binding, batch);
			binding.agent.setTools([
				new ChronicleTool(binding.store, batch, knownSources),
				new FinishChronicleTool(binding.store, batch, knownSources),
				new ReadChronicleTool(binding.store, batch, this.#host.obfuscator),
			]);

			const request: AgentMessage = {
				role: "user",
				content: [{ type: "text", text: requestText }],
				timestamp: Date.now(),
			};

			let stalled = false;
			let watchdog: Timer | undefined;
			const armWatchdog = () => {
				chroniclerTimerIO.clearTimeout(watchdog);
				watchdog = chroniclerTimerIO.setTimeout(() => {
					stalled = true;
					binding.agent.abort("Chronicler stream stalled");
				}, STREAM_STALL_MS);
			};
			const stopWatching = binding.agent.subscribe(event => {
				if (event.type === "message_update") armWatchdog();
			});
			binding.agent.setDeadline(Date.now() + ATTEMPT_DEADLINE_MS);
			armWatchdog();
			try {
				await Promise.race([
					binding.agent.prompt([request]),
					this.#deadlineSignal.promise,
					this.#attemptFence.promise,
				]);
			} catch (error) {
				if (this.#generation !== binding.gen || batch.revoked || !this.#ownsLease(binding)) {
					return { kind: "revoked" };
				}
				return { kind: "failed", error: stalled ? "model stream stalled" : errorText(error) };
			} finally {
				chroniclerTimerIO.clearTimeout(watchdog);
				stopWatching();
				binding.agent.setDeadline(undefined);
			}

			if (this.#generation !== binding.gen || batch.revoked || !this.#ownsLease(binding)) {
				return { kind: "revoked" };
			}

			const failure = this.#passFailure(binding.agent, batch);
			if (failure) return { kind: "failed", error: failure };

			// Publication starts here. A fence landing before the store's pre-rename
			// check revokes this batch and the rename never happens; a fence landing
			// after it settles in this frozen root and is never turned into a retry.
			const publication = binding.store.commitBatch(batch, () => {
				if (!this.#ownsLease(binding)) throw new Error("Chronicler ownership was taken over");
			});
			try {
				await publication;
			} catch (error) {
				// A rename that landed but whose cache write failed is committed
				// success (the store swallows cache errors). Reaching here means the
				// batch never published, so this is retryable — unless the committed
				// data itself disagrees, which halts.
				if (isChroniclerCorruption(error)) return { kind: "corruption", error: errorText(error) };
				if (this.#generation !== binding.gen || batch.revoked || !this.#ownsLease(binding)) {
					return { kind: "revoked" };
				}
				return { kind: "failed", error: errorText(error) };
			}
			this.#lastCommittedAt = binding.store.lastCommittedAt;
			this.#lastCommittedDescriptor = binding.descriptor;
			if (binding.gen === this.#generation) {
				this.#resetRecovery();
				this.#status = "running";
			}
			return { kind: "committed" };
		} finally {
			// Clear the active reference synchronously at settlement so no later
			// fence can touch a batch the store has frozen.
			if (!Object.isFrozen(batch)) batch.revoked = true;
			if (this.#activeBatch === batch) this.#activeBatch = undefined;
		}
	}

	/** A non-empty string names why the pass is not a committable success. */
	#passFailure(agent: Agent, batch: CaptureBatch): string | null {
		if (agent.state.error) return agent.state.error;
		for (let i = agent.state.messages.length - 1; i >= 0; i--) {
			const message = agent.state.messages[i];
			if (message.role !== "assistant") continue;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return message.errorMessage ?? `model turn ended with stopReason ${message.stopReason}`;
			}
			break;
		}
		if (!batch.finalized) return "capture pass ended without a finish_chronicle marker";
		return null;
	}

	/** Drop the retained model conversation, keeping the static system framing. */
	#rebuildConversation(binding: ChroniclerBinding): void {
		binding.agent.reset();
		binding.agent.replaceMessages([]);
	}

	// ---- budget & framing -------------------------------------------------

	/**
	 * Reduce the beat listing (oldest first) then the unseen prefix until the
	 * exact request that will be sent fits the budget. If retained model context
	 * is what pushes it over, rebuild the conversation once and retry the whole
	 * selection. A single entry still over budget on a fresh context is an
	 * explicit preservation halt, never a silent truncation.
	 */
	#selectPrefix(
		binding: ChroniclerBinding,
		unseen: readonly ChronicleEntry[],
		ownedIds: ReadonlySet<string>,
	): PrefixSelection {
		const tokenizer = binding.agent.tokenizer;
		const systemTokens = tokenizer.countTokens(binding.systemText);
		const toolTokens = estimateToolSchemaTokens(CHRONICLER_TOOL_SCHEMAS, tokenizer);
		const budget = this.#budgetTokens(binding.model);
		const carry = this.#resolvableCarry(binding, ownedIds);
		const beats = binding.store.beats;

		let rebuilt = false;
		while (true) {
			const stored = binding.agent.state.messages;
			const storedLocal = tokenizer.countMessages(stored, { excludeEncryptedReasoning: true });
			const storedProvider = estimateTranscriptTokens(stored, tokenizer, { excludeEncryptedReasoning: true });

			let prefixCount = Math.min(MAX_PREFIX_ENTRIES, unseen.length);
			let listingCount = Math.min(MAX_BEAT_LISTING, beats.length);

			while (true) {
				const entries = unseen.slice(0, prefixCount);
				const listing = beats.slice(beats.length - listingCount);
				const framed = this.#renderFramed(binding, entries, listing, beats.length - listing.length, carry);
				// Count the exact bytes that will be sent: obfuscation happens once,
				// here, and the same text is handed to the model.
				const requestText = this.#host.obfuscator?.obfuscate(framed) ?? framed;
				const incoming = tokenizer.countMessage({
					role: "user",
					content: [{ type: "text", text: requestText }],
					timestamp: Date.now(),
				});
				const localTotal = systemTokens + toolTokens + storedLocal + incoming;
				const providerTotal = storedProvider + incoming;

				if (Math.max(localTotal, providerTotal) <= budget) return { kind: "ok", entries, requestText };
				if (listingCount > 0) {
					listingCount -= 1;
					continue;
				}
				if (!rebuilt && stored.length > 0) break;
				if (prefixCount > 1) {
					prefixCount -= 1;
					continue;
				}
				break;
			}

			if (!rebuilt && binding.agent.state.messages.length > 0) {
				this.#rebuildConversation(binding);
				rebuilt = true;
				continue;
			}
			return { kind: "oversized" };
		}
	}

	#budgetTokens(model: Model<Api>): number {
		const window = model.contextWindow;
		if (typeof window === "number" && Number.isFinite(window) && window > 0) {
			return Math.floor(window * CONTEXT_BUDGET_FRACTION);
		}
		return GENERIC_BUDGET_TOKENS;
	}

	/**
	 * Inherited carry is off-branch history unless this session still holds every
	 * entry it cites; a fork that lost a cited source withholds the carry from
	 * framing while the copied manifest keeps it. Own carry passes trivially.
	 */
	#resolvableCarry(
		binding: ChroniclerBinding,
		ownedIds: ReadonlySet<string>,
	): { sources: string[]; text: string } | null {
		const carry = binding.store.carry;
		if (!carry) return null;
		return carry.sources.every(id => ownedIds.has(id)) ? carry : null;
	}

	#renderFramed(
		binding: ChroniclerBinding,
		entries: readonly ChronicleEntry[],
		listing: readonly { id: string; title: string; kind: string; eventTime: string }[],
		omitted: number,
		carry: { sources: string[]; text: string } | null,
	): string {
		// The delta is rendered without an obfuscator: the whole framed request is
		// obfuscated once by the caller, so a secret spanning fragments is caught.
		const rendered = renderChronicleDelta(entries, { includeThinking: true });
		const message = rendered[0];
		const block = message?.role === "user" && Array.isArray(message.content) ? message.content[0] : undefined;
		const delta = block?.type === "text" ? block.text : "";
		return prompt.render(contextTemplate, {
			sessionId: binding.descriptor.sessionId,
			cwd: binding.descriptor.cwd,
			beatCount: binding.store.beats.length,
			beats: listing.map(beat => ({
				id: beat.id,
				title: beat.title,
				kind: beat.kind,
				eventTime: beat.eventTime,
			})),
			omitted,
			carry,
			delta,
		});
	}

	#buildKnownSources(binding: ChroniclerBinding, batch: CaptureBatch): ReadonlyMap<string, CaptureSource> {
		const known = new Map<string, CaptureSource>(binding.store.sourceEntries);
		for (const entry of batch.entries) known.set(entry.id, entry);
		return known;
	}

	// ---- binding lifecycle ------------------------------------------------

	#sameDescriptor(a: SessionDescriptor, b: SessionDescriptor): boolean {
		return (
			a.sessionId === b.sessionId &&
			a.sessionFile === b.sessionFile &&
			a.artifactsDir === b.artifactsDir &&
			a.cwd === b.cwd
		);
	}

	#resolveSelection(): RoleSelection | undefined {
		const selection = resolveChroniclerRoleSelection(this.#host.settings, this.#host.modelRegistry.getAvailable());
		if (!selection) return undefined;
		const requested = concreteThinkingLevel(selection.thinkingLevel) ?? ThinkingLevel.Medium;
		const resolved = resolveThinkingLevelForModel(selection.model, requested);
		return {
			model: selection.model,
			thinkingLevel: resolved ?? ThinkingLevel.Inherit,
			modelString: formatModelString(selection.model),
		};
	}

	async #ensureBinding(
		descriptor: SessionDescriptor,
		selection: RoleSelection,
	): Promise<ChroniclerBinding | undefined> {
		const gen = this.#generation;
		const current = this.#binding;
		const reconcile = this.#reconcile;
		this.#reconcile = false;
		const rebind =
			!current ||
			reconcile ||
			current.gen !== this.#generation ||
			!this.#sameDescriptor(current.descriptor, descriptor) ||
			current.modelString !== selection.modelString ||
			!this.#ownsLease(current);
		if (!rebind) return current;

		// Serialized on the owner chain, so any previous prompt/publication has
		// already settled before another writer starts.
		if (current) await this.#teardownBinding(current);
		this.#binding = undefined;

		if (gen !== this.#generation || this.#deadlineExpired || !this.#enabled()) return undefined;
		const storeRoot = `${descriptor.artifactsDir}/chronicler`;
		let lease: FileLockHandle;
		try {
			lease = await acquireFileLock(storeRoot, { retries: 1, takeoverStoppedOwner: true });
		} catch (error) {
			if (gen !== this.#generation) return undefined;
			if (!(error instanceof FileLockContentionError)) throw error;
			this.#requestRetry(`Chronicler lease contention: ${error.message}`, "contended");
			return undefined;
		}
		let bound = false;
		try {
			const store = new ChroniclerStore(
				storeRoot,
				{ sessionId: descriptor.sessionId, project: descriptor.cwd, model: selection.modelString },
				{ warn: message => this.#host.emitNotice("warning", message, "chronicler") },
			);
			await store.open();
			if (this.#generation !== gen) return undefined;
			const binding = this.#completeBinding(gen, descriptor, selection, store, lease);
			bound = true;
			return binding;
		} finally {
			if (!bound) lease.release();
		}
	}

	#ownsLease(binding: ChroniclerBinding): boolean {
		let owned: boolean;
		try {
			owned = binding.lease.isOwner?.() ?? true;
		} catch (error) {
			if (binding.gen === this.#generation) {
				this.#revokeNow("chronicler ownership check failed", true);
				this.#requestRetry(`Chronicler ownership check failed: ${errorText(error)}`);
			}
			return false;
		}
		if (!owned && binding.gen === this.#generation) {
			this.#revokeNow("chronicler ownership lost", true);
			this.#requestRetry("Chronicler ownership was taken over");
		}
		return owned;
	}

	#completeBinding(
		gen: number,
		descriptor: SessionDescriptor,
		selection: RoleSelection,
		store: ChroniclerStore,
		lease: FileLockHandle,
	): ChroniclerBinding {
		const recorder = new AdvisorTranscriptRecorder(
			() => descriptor.sessionFile,
			() => descriptor.cwd,
			RECORDER_FILENAME,
		);
		const renderedSystem = prompt.render(systemTemplate, {
			sessionId: descriptor.sessionId,
			cwd: descriptor.cwd,
		});
		const systemText = this.#host.obfuscator?.obfuscate(renderedSystem) ?? renderedSystem;
		const agent = this.#buildAgent(descriptor, selection, systemText);
		// Ordinary revocation still owns the billed completion until this binding
		// settles; only teardown or the terminal deadline closes its diagnostics.
		let recording = true;
		const unsubscribe = agent.subscribe(event => {
			if (recording && !this.#deadlineExpired && !this.#cleanedUp && event.type === "message_end") {
				recorder.record(event.message);
			}
		});
		const agentUnsubscribe = () => {
			recording = false;
			unsubscribe();
		};

		const binding: ChroniclerBinding = {
			gen,
			descriptor,
			store,
			recorder,
			model: selection.model,
			modelString: selection.modelString,
			thinkingLevel: selection.thinkingLevel,
			systemText,
			agent,
			agentUnsubscribe,
			lease,
		};
		agent.addBeforeModelCallHook(() => {
			if (this.#generation !== gen || this.#deadlineExpired || this.#cleanedUp || !this.#ownsLease(binding)) {
				throw new Error("Chronicler binding was revoked");
			}
		});
		this.#binding = binding;
		this.#lastCommittedAt = store.lastCommittedAt;
		this.#lastCommittedDescriptor = descriptor;
		this.#watchOwnership(binding);
		return binding;
	}

	#buildAgent(descriptor: SessionDescriptor, selection: RoleSelection, systemText: string): Agent {
		const providerSessionId = Bun.randomUUIDv7();
		const agent = new Agent({
			initialState: {
				systemPrompt: [systemText],
				model: selection.model,
				thinkingLevel: toReasoningEffort(selection.thinkingLevel),
				tools: [],
			},
			sessionId: providerSessionId,
			promptCacheKey: Bun.randomUUIDv7(),
			providerSessionState: this.#host.providerSessionState,
			cwdResolver: () => descriptor.cwd,
			preferWebsockets: this.#host.preferWebsockets,
			getApiKey: requestModel => this.#host.modelRegistry.resolver(requestModel, providerSessionId),
			streamFn: streamSimple,
			intentTracing: false,
			telemetry: deriveAdvisorTelemetry(this.#host.agent.telemetry, {
				id: `${providerSessionId}-chronicler`,
				name: "Chronicler",
				description: selection.modelString,
			}),
		});
		agent.setDisableReasoning(shouldDisableReasoning(selection.thinkingLevel));
		return agent;
	}

	async #teardownBinding(binding: ChroniclerBinding): Promise<void> {
		binding.agentUnsubscribe();
		binding.agent.abort("chronicler binding released");
		chroniclerTimerIO.clearTimeout(this.#ownershipTimer);
		this.#ownershipTimer = undefined;
		try {
			await binding.recorder.close();
		} catch (error) {
			logger.debug("Chronicler recorder close failed", { error: String(error) });
		}
		binding.lease.release();
	}

	async #disableBinding(): Promise<void> {
		this.#status = "off";
		this.#settled.clear();
		if (this.#binding) {
			await this.#teardownBinding(this.#binding);
			this.#binding = undefined;
		}
	}

	#handleBindingError(error: unknown): void {
		this.#requestRetry(errorText(error), isChroniclerCorruption(error) ? "halted" : "retrying");
	}

	async #cleanup(): Promise<void> {
		if (this.#cleanedUp) return;
		this.#cancelTimers();
		this.#cleanedUp = true;
		this.#settingsUnsub?.();
		this.#settingsUnsub = undefined;
		if (this.#binding) {
			await this.#teardownBinding(this.#binding);
			this.#binding = undefined;
		}
	}

	#cancelTimers(): void {
		chroniclerTimerIO.clearTimeout(this.#retryTimer);
		chroniclerTimerIO.clearTimeout(this.#ownershipTimer);
		this.#retryTimer = undefined;
		this.#ownershipTimer = undefined;
		this.#retryAt = undefined;
	}

	#resetRecovery(): void {
		chroniclerTimerIO.clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
		this.#retryAt = undefined;
		this.#retryAttempt = 0;
		this.#error = undefined;
		this.#failureWarned = undefined;
	}

	#requestRetry(reason: string, status: ChroniclerStatus = "retrying", reconcile = true): void {
		if (
			this.#suspended ||
			this.#stopping ||
			this.#cleanedUp ||
			this.#deadlineExpired ||
			this.#host.isDisposed() ||
			!this.#enabled() ||
			!this.#host.isCaptureEligible()
		)
			return;
		this.#error = reason;
		this.#status = status;
		this.#reconcile ||= reconcile;
		if (this.#failureWarned !== reason) {
			this.#failureWarned = reason;
			this.#host.emitNotice("warning", `Chronicler recovery pending: ${reason}`, "chronicler");
		}
		if (this.#retryTimer !== undefined) return;
		const delay = Math.min(RETRY_BACKOFF_MS[0] * 2 ** Math.min(this.#retryAttempt++, 5), MAX_RECOVERY_BACKOFF_MS);
		this.#retryAt = Date.now() + delay;
		this.#retryTimer = chroniclerTimerIO.setTimeout(() => {
			this.#retryTimer = undefined;
			this.#retryAt = undefined;
			this.#scheduleWake(true);
		}, delay);
		this.#retryTimer.unref?.();
	}

	#watchOwnership(binding: ChroniclerBinding): void {
		if (this.#stopping || this.#suspended || this.#cleanedUp || !this.#enabled()) return;
		this.#ownershipTimer = chroniclerTimerIO.setTimeout(() => {
			this.#ownershipTimer = undefined;
			if (this.#binding !== binding || this.#generation !== binding.gen) return;
			if (this.#ownsLease(binding)) this.#watchOwnership(binding);
		}, OWNERSHIP_CHECK_MS);
		this.#ownershipTimer.unref?.();
	}

	/** Interruptible sleep; resolves false when the generation is revoked. */
	async #sleep(ms: number, gen: number): Promise<boolean> {
		const step = 50;
		let waited = 0;
		while (waited < ms) {
			if (this.#generation !== gen) return false;
			await Bun.sleep(Math.min(step, ms - waited));
			waited += step;
		}
		return this.#generation === gen;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Headless Chronicler backfill for stored sessions (#198).
 *
 * Hosts the ordinary {@link SessionChronicler} against a read-only view of a
 * transcript: no AgentSession, no primary turn, no MCP/extensions/advisors, and
 * no transcript write. The runtime's construction-time backlog walk does the
 * capture; this module waits for it, reports committed coverage, and drains
 * with a caller-chosen budget instead of the interactive shutdown default.
 *
 * Resumability and deduplication come from the store: coverage is the union of
 * committed batches, so a later run starts from whatever the last one published.
 */
import * as path from "node:path";
import type { ProviderSessionState } from "@oh-my-pi/pi-ai";
import { acquireFileLock, logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { SessionHeader } from "../session/session-entries";
import { visitEntriesFromFile } from "../session/session-loader";
import { artifactsDirectoryFor, SessionManager } from "../session/session-manager";
import { type ChroniclerSessionView, SessionChronicler } from "./session-chronicler";
import { cfgChroniclerEnabled } from "./settings";
import { readCommittedChroniclerBatches } from "./store";

/** Committed capture state of one stored session. */
export interface BackfillCoverage {
	/** Message entries in the transcript: the units capture must cover. */
	readonly totalEntries: number;
	/** Message entries cited by a committed batch. */
	readonly coveredEntries: number;
	/** Beats across every committed batch. */
	readonly beats: number;
}

/** Header facts and coverage for one stored session, read without opening a writer. */
export interface StoredSessionCoverage extends BackfillCoverage {
	readonly sessionFile: string;
	readonly sessionId: string;
	readonly cwd: string;
	/** Session start time from the header. */
	readonly createdAt: string;
	/**
	 * A v1 transcript has no persisted entry IDs; a read-only load assigns fresh
	 * ones every time, so committed coverage could never match it again.
	 */
	readonly legacy: boolean;
}

export type BackfillOutcome =
	/** Every message entry is covered by a committed batch. */
	| "complete"
	/** The timeout elapsed first; committed batches remain and a later run resumes. */
	| "incomplete"
	/** Capture stopped on an oversized entry, repeated failures, or corrupt committed data. */
	| "halted"
	/** The `chronicler` role resolved to no available model. */
	| "no_model"
	/** Another live process holds this session's Chronicler lease. */
	| "leased"
	/** `chronicler.enabled` is false in the session's effective settings. */
	| "disabled"
	/** v1 transcript; see {@link StoredSessionCoverage.legacy}. */
	| "legacy";

export interface HeadlessBackfillOptions {
	readonly sessionFile: string;
	/** Effective settings for the session's project; decide enablement and the `chronicler` role. */
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly obfuscator: SecretObfuscator | undefined;
	/** Wall-clock budget for the backlog walk before the final drain begins. */
	readonly timeoutMs: number;
	/** Budget for the final drain; in-flight model work is aborted when it expires. */
	readonly drainMs: number;
	/** Interval between committed-coverage reads while capture runs. */
	readonly pollMs?: number;
	onProgress?(coverage: BackfillCoverage): void;
	onNotice?(level: "info" | "warning" | "error", message: string): void;
}

export interface HeadlessBackfillResult {
	readonly outcome: BackfillOutcome;
	readonly before: StoredSessionCoverage;
	readonly after: BackfillCoverage;
}

const DEFAULT_POLL_MS = 5_000;

function chroniclerRootFor(sessionFile: string): string {
	const artifactsDir = artifactsDirectoryFor(sessionFile);
	if (!artifactsDir) throw new Error(`Not a session transcript: ${sessionFile}`);
	return path.join(artifactsDir, "chronicler");
}

async function committedCoverage(sessionFile: string, messageIds: ReadonlySet<string>): Promise<BackfillCoverage> {
	const batches = await readCommittedChroniclerBatches(chroniclerRootFor(sessionFile));
	let coveredEntries = 0;
	let beats = 0;
	for (const batch of batches) {
		beats += batch.beats.length;
		for (const entry of batch.checkpoint.entries) if (messageIds.has(entry.id)) coveredEntries++;
	}
	return { totalEntries: messageIds.size, coveredEntries, beats };
}

async function readMessageIds(sessionFile: string): Promise<{ header: SessionHeader; ids: Set<string> }> {
	let header: SessionHeader | undefined;
	const ids = new Set<string>();
	await visitEntriesFromFile(sessionFile, entry => {
		if (entry.type === "session") header ??= entry;
		else if (entry.type === "message" && entry.id) ids.add(entry.id);
	});
	if (!header) throw new Error(`Session file has no valid header: ${sessionFile}`);
	return { header, ids };
}

/** Message-entry coverage of a stored session from its transcript and committed batches; reads only. */
export async function readStoredSessionCoverage(sessionFile: string): Promise<StoredSessionCoverage> {
	const resolved = path.resolve(sessionFile);
	const { header, ids } = await readMessageIds(resolved);
	const legacy = (header.version ?? 1) < 2;
	const coverage = legacy
		? { totalEntries: ids.size, coveredEntries: 0, beats: 0 }
		: await committedCoverage(resolved, ids);
	return {
		...coverage,
		sessionFile: resolved,
		sessionId: header.id,
		cwd: header.cwd,
		createdAt: header.timestamp,
		legacy,
	};
}

/** True when another process currently holds the Chronicler lease for this session. */
async function leaseIsHeld(sessionFile: string): Promise<boolean> {
	try {
		const lease = await acquireFileLock(chroniclerRootFor(sessionFile), { retries: 1 });
		lease.release();
		return false;
	} catch {
		return true;
	}
}

/**
 * Capture the uncovered backlog of one stored session without appending to it.
 *
 * Waits for the Chronicler's backlog walk to settle or `timeoutMs` to pass,
 * then drains with `drainMs`. Sessions that are already covered, disabled,
 * leased, or legacy return before any model is resolved.
 */
export async function runHeadlessBackfill(options: HeadlessBackfillOptions): Promise<HeadlessBackfillResult> {
	const before = await readStoredSessionCoverage(options.sessionFile);
	const sessionFile = before.sessionFile;
	const skip = (outcome: BackfillOutcome): HeadlessBackfillResult => ({ outcome, before, after: before });

	if (before.legacy) return skip("legacy");
	if (before.coveredEntries >= before.totalEntries) return skip("complete");
	if (!cfgChroniclerEnabled.get(options.settings)) return skip("disabled");
	if (await leaseIsHeld(sessionFile)) return skip("leased");

	const manager = await SessionManager.openReadOnly(sessionFile);
	const artifactsDir = artifactsDirectoryFor(sessionFile);
	const messageIds = new Set<string>();
	for (const entry of manager.getEntries()) if (entry.type === "message") messageIds.add(entry.id);
	// The read-only manager never persists, so the transcript bytes cannot
	// change; the view reports the real file so the store lands beside it.
	const view: ChroniclerSessionView = {
		getSessionId: () => before.sessionId,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getEntries: () => manager.getEntries(),
		isSessionOnDisk: () => true,
		ensureOnDisk: async () => {},
		flush: async () => {},
	};

	// Provider transports (e.g. Codex websockets) outlive the Agent unless the
	// host closes them, as AgentSession does on dispose.
	const providerSessionState = new Map<string, ProviderSessionState>();
	const chronicler = new SessionChronicler({
		agent: { telemetry: undefined },
		sessionManager: view,
		settings: options.settings,
		modelRegistry: options.modelRegistry,
		obfuscator: options.obfuscator,
		providerSessionState,
		preferWebsockets: undefined,
		isDisposed: () => false,
		isCaptureEligible: () => true,
		emitNotice: (level, message) => options.onNotice?.(level, message),
		cwd: () => before.cwd,
	});

	const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
	const deadline = Date.now() + Math.max(0, options.timeoutMs);
	const settled = chronicler.idle().then(() => true);
	let reported = before.coveredEntries;
	while (true) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const done = await Promise.race([settled, Bun.sleep(Math.min(pollMs, remaining)).then(() => false)]);
		try {
			const now = await committedCoverage(sessionFile, messageIds);
			if (now.coveredEntries !== reported) {
				reported = now.coveredEntries;
				options.onProgress?.(now);
			}
		} catch (error) {
			// A corrupt store halts the runtime itself; the final read reports it.
			logger.debug("Chronicler backfill progress read failed", { error: String(error) });
		}
		if (done) break;
	}
	try {
		await chronicler.drain(options.drainMs);
	} finally {
		for (const state of providerSessionState.values()) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close Chronicler provider session", { error: String(error) });
			}
		}
		providerSessionState.clear();
	}

	const after = await committedCoverage(sessionFile, messageIds);
	if (after.coveredEntries >= after.totalEntries) return { outcome: "complete", before, after };
	switch (chronicler.status) {
		case "halted":
			return { outcome: "halted", before, after };
		case "no_model":
			return { outcome: "no_model", before, after };
		case "off":
			// Enabled and eligible, so the only scan that leaves the runtime off is
			// one that lost the lease to a process that took it after our check.
			return { outcome: "leased", before, after };
		default:
			return { outcome: "incomplete", before, after };
	}
}

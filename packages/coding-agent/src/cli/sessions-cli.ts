// Read-only host session discovery (#355).
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { isRecord } from "@oh-my-pi/pi-utils";
import { getSessionCatalogCacheDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ControlClient } from "../control/client";
import { type ControlMetadata, readControlEntries, type ControlRegistryOptions } from "../control/registry";
import type { ControlSnapshot } from "../control/types";
import { readSessionExit, SESSION_EXIT_CUSTOM_TYPE, type SessionExitData } from "../session/exit-diagnostics";
import { getMessageEntryId } from "../session/message-entry-ids";
import { filterSessionsForPicker, listAllSessions, listSessionsReadOnly } from "../session/session-listing";
import { loadSessionBranchReadOnly } from "../session/session-loader";
import { sessionDirForCwd, worktreeSessionDirs } from "../session/session-paths";
import { loadPinnedSessionIds } from "../session/session-pins";
import { FileSessionStorage } from "../session/session-storage";
import { countSessionCatalogMessages } from "./session-catalog-count";

export interface SessionCatalogOptions {
	cwd?: string;
	sessionDirs?: string[];
	all?: boolean;
	/** Explicit roots keep SDK consumers and tests independent of process globals. */
	sessionsRoot?: string;
	agentDir?: string;
	controlRegistry?: ControlRegistryOptions;
	countCacheDir?: string;
	/** Ask each live control endpoint what its session is doing (`--live`); adds `live` to every row. */
	live?: boolean;
	/** Per-endpoint deadline for `live`; an endpoint that misses it reports `live: null`. */
	liveTimeoutMs?: number;
	/** Fetches an endpoint's snapshot; tests substitute the socket. */
	probeControl?: (metadata: ControlMetadata, timeoutMs: number) => Promise<ControlSnapshot>;
}

/** What a live process is doing, read from its control endpoint (`sessions list --live`). */
export interface SessionCatalogLive {
	/** `waiting`: a pane dialog (ask or approval) is open; `busy`: not settled; otherwise `idle`. */
	state: "busy" | "waiting" | "idle";
	isStreaming: boolean;
	pendingDialogs: number;
	/** VCS branch of the process's working directory; null outside a repository or on a detached head. */
	branch: string | null;
}

const DEFAULT_LIVE_TIMEOUT_MS = 750;

async function probeControlEndpoint(metadata: ControlMetadata, timeoutMs: number): Promise<ControlSnapshot> {
	const client = new ControlClient({ metadata, label: "sessions-list", kind: "cli", probe: true, timeoutMs });
	try {
		return await client.connect();
	} finally {
		client.close();
	}
}

/** The live state of one control endpoint, or null when it does not answer in time. */
async function readLive(
	metadata: ControlMetadata,
	options: Pick<SessionCatalogOptions, "liveTimeoutMs" | "probeControl">,
): Promise<SessionCatalogLive | null> {
	const timeoutMs = options.liveTimeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS;
	let snapshot: ControlSnapshot;
	try {
		// The client's own handshake deadline covers connecting; this one also covers a silent endpoint.
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(() => deadline.reject(new Error("control endpoint timed out")), timeoutMs);
		try {
			snapshot = await Promise.race([
				(options.probeControl ?? probeControlEndpoint)(metadata, timeoutMs),
				deadline.promise,
			]);
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
	let branch: string | null = null;
	try {
		branch = (await vcs.git(snapshot.cwd || metadata.cwd)?.currentBranch()) ?? null;
	} catch {
		// Not a repository, or the helper could not read it: the branch is simply unknown.
	}
	const pendingDialogs = snapshot.dialogs.length;
	return {
		state: pendingDialogs > 0 ? "waiting" : snapshot.busy.settled ? "idle" : "busy",
		isStreaming: snapshot.busy.streaming,
		pendingDialogs,
		branch,
	};
}

export interface SessionCatalogMessage {
	/** Missing only for legacy journals without persisted native IDs. */
	entryId?: string;
	role: "user" | "assistant";
	text: string;
	/** ISO-8601, or null when the persisted message timestamp is missing or invalid. */
	timestamp: string | null;
}

export interface SessionCatalogNativeMessage extends SessionCatalogMessage {
	entryId: string;
}

export interface SessionCatalogExit {
	entryId: string;
	kind: SessionExitData["kind"];
	reason: string;
	pendingToolCallCount: number;
	lastAssistantStopReason: string | null;
}

export interface SessionCatalogReadResult {
	version: 1;
	session: { path: string; id: string; cwd: string; title: string | null };
	messages: SessionCatalogMessage[];
	truncated: boolean;
	/** Identity-dependent fields are absent for legacy journals. */
	branchEntryIds?: string[];
	leafId?: string | null;
	userEntryIds?: string[];
	sessionExits?: SessionCatalogExit[];
	sessionExitEntryIds?: string[];
	branchMessages?: SessionCatalogNativeMessage[];
	branchMessagesTruncated?: boolean;
}

async function canonicalPath(file: string): Promise<string> {
	return fs.realpath(file).catch(() => path.resolve(file));
}

export async function listSessionCatalog(options: SessionCatalogOptions = {}) {
	if (options.all && options.sessionDirs?.length) throw new Error("--all and --session-dir are mutually exclusive");
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const root = options.sessionsRoot ?? getSessionsDir();
	const storage = new FileSessionStorage();
	const pinned = await loadPinnedSessionIds(options.agentDir);
	const countCacheDir = options.countCacheDir ?? getSessionCatalogCacheDir(options.agentDir);
	let sessions;
	if (options.all) {
		sessions = await listAllSessions(storage, root);
	} else {
		const primary = sessionDirForCwd(cwd, root);
		const dirs = options.sessionDirs?.length
			? options.sessionDirs.map(dir => path.resolve(dir))
			: [primary, ...(await worktreeSessionDirs(cwd, primary))];
		sessions = (await Promise.all(dirs.map(dir => listSessionsReadOnly(dir, storage)))).flat();
	}
	const controls = new Map<string, { instanceId: string; role: "tui" | "rpc" | "acp" | "print"; pid: number }>();
	const liveByFile = new Map<string, Promise<SessionCatalogLive | null>>();
	for (const { meta } of await readControlEntries(options.controlRegistry)) {
		if (!meta.sessionFile) continue;
		const file = await canonicalPath(meta.sessionFile);
		controls.set(file, { instanceId: meta.instanceId, role: meta.role, pid: meta.pid });
		// Probes run together, so one slow endpoint costs one deadline, not one per session.
		if (options.live) liveByFile.set(file, readLive(meta, options));
	}
	const seen = new Set<string>();
	const rows = [];
	for (const session of filterSessionsForPicker(sessions, pinned).sort(
		(a, b) => b.modified.getTime() - a.modified.getTime(),
	)) {
		const file = await canonicalPath(session.path);
		if (seen.has(file)) continue;
		seen.add(file);
		const messageCount = await countSessionCatalogMessages(file, countCacheDir);
		const modified = Number.isFinite(session.modified.getTime()) ? session.modified.toISOString() : null;
		const created = Number.isFinite(session.created.getTime()) ? session.created.toISOString() : modified;
		rows.push({
			path: path.resolve(session.path),
			id: session.id,
			cwd: session.cwd,
			title: session.title ?? null,
			parentSessionPath: session.parentSessionPath ?? null,
			created,
			modified,
			messageCount,
			status: session.status ?? null,
			firstMessage: session.firstMessage === "(no messages)" ? "" : session.firstMessage.trim().slice(0, 300),
			inUse: session.inUse ?? null,
			control: controls.get(file) ?? null,
			...(options.live ? { live: (await liveByFile.get(file)) ?? null } : {}),
		});
	}
	return { version: 1 as const, sessions: rows };
}

function messageTimestamp(value: unknown): string | null {
	if (typeof value !== "number" && typeof value !== "string") return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function readSessionCatalog(file: string, maxMessages?: number): Promise<SessionCatalogReadResult> {
	if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages < 0)) {
		throw new Error("--max-messages must be a nonnegative integer");
	}
	const resolved = path.resolve(file);
	const storage = new FileSessionStorage();
	const info = (await listSessionsReadOnly(path.dirname(resolved), storage)).find(
		session => path.resolve(session.path) === resolved,
	);
	if (!info) throw new Error(`Not a readable session file: ${resolved}`);
	const branch = await loadSessionBranchReadOnly(resolved);
	if (branch.entries === null) {
		const messages: SessionCatalogMessage[] = [];
		for (const message of branch.messages) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = textContent(message.content, "\n\n");
			if (!text.trim()) continue;
			messages.push({ role: message.role, text, timestamp: messageTimestamp(message.timestamp) });
		}
		const truncated = maxMessages !== undefined && messages.length > maxMessages;
		return {
			version: 1 as const,
			session: { path: resolved, id: info.id, cwd: info.cwd, title: info.title ?? null },
			messages: truncated ? messages.slice(messages.length - maxMessages!) : messages,
			truncated,
		};
	}
	const branchMessages: SessionCatalogNativeMessage[] = [];
	const userEntryIds: string[] = [];
	const sessionExits: SessionCatalogExit[] = [];
	const sessionExitEntryIds: string[] = [];
	let lastAssistantStopReason: string | null = null;
	for (const entry of branch.entries) {
		if (entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE) {
			sessionExitEntryIds.push(entry.id);
		}
		if (entry.type === "custom" && isRecord(entry.data)) {
			const exit = readSessionExit(entry);
			// Native shutdown omits the pending-call list when it is empty.
			// A present but malformed list cannot certify a clean exit.
			if (exit && (entry.data.pendingToolCalls === undefined || exit.pendingToolCalls !== undefined)) {
				sessionExits.push({
					entryId: entry.id,
					kind: exit.kind,
					reason: exit.reason,
					pendingToolCallCount: exit.pendingToolCalls?.length ?? 0,
					lastAssistantStopReason,
				});
			}
		}
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role === "user") {
			userEntryIds.push(entry.id);
			lastAssistantStopReason = null;
		} else if (message.role === "assistant") {
			lastAssistantStopReason = typeof message.stopReason === "string" ? message.stopReason : null;
		}
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textContent(message.content, "\n\n");
		if (!text.trim()) continue;
		branchMessages.push({
			entryId: entry.id,
			role: message.role,
			text,
			timestamp: messageTimestamp(message.timestamp),
		});
	}
	const messages: SessionCatalogNativeMessage[] = [];
	for (const message of branch.messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textContent(message.content, "\n\n");
		if (!text.trim()) continue;
		const entryId = getMessageEntryId(message);
		if (entryId === undefined) throw new Error("Session transcript message has no native entry identity");
		messages.push({ entryId, role: message.role, text, timestamp: messageTimestamp(message.timestamp) });
	}
	const truncated = maxMessages !== undefined && messages.length > maxMessages;
	const branchMessagesTruncated = maxMessages !== undefined && branchMessages.length > maxMessages;
	return {
		version: 1 as const,
		session: { path: resolved, id: info.id, cwd: info.cwd, title: info.title ?? null },
		branchEntryIds: branch.entries.map(entry => entry.id),
		leafId: branch.leafId,
		userEntryIds,
		sessionExits,
		sessionExitEntryIds,
		messages: truncated ? messages.slice(messages.length - maxMessages!) : messages,
		truncated,
		branchMessages: branchMessagesTruncated
			? branchMessages.slice(branchMessages.length - maxMessages!)
			: branchMessages,
		branchMessagesTruncated,
	};
}

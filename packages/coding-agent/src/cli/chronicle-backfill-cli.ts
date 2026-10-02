/**
 * `npi chronicle backfill` (#198): select stored sessions, report their
 * committed Chronicler coverage, and capture the uncovered backlog headlessly
 * with bounded concurrency. Output is plain lines on stdout; diagnostics and
 * Chronicler notices go to stderr.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getModelDbPath, getProjectDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	type BackfillCoverage,
	type BackfillOutcome,
	type HeadlessBackfillResult,
	readStoredSessionCoverage,
	runHeadlessBackfill,
	type StoredSessionCoverage,
} from "../chronicler/backfill";
import { cfgChroniclerEnabled } from "../chronicler/settings";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { initializeWithSettings } from "../discovery";
import { discoverAuthStorage } from "../sdk";
import { buildSecretObfuscator } from "../secrets";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { cfgSecretsEnabled } from "../secrets/settings";
import { listAllSessions, type SessionInfo, sessionMatchesResumeArg } from "../session/session-listing";
import { FileSessionStorage } from "../session/session-storage";
import { mapWithConcurrencyLimitAllSettled } from "../task/parallel";

export interface ChronicleBackfillFlags {
	/** Session ids (resume-style prefixes) or transcript paths. */
	sessions: string[];
	project?: string;
	since?: string;
	until?: string;
	minSize?: string;
	all: boolean;
	dryRun: boolean;
	concurrency: number;
	drain?: string;
	timeout?: string;
	force: boolean;
}

/** Process-level inputs, injectable so tests run against a temp agent dir and a fake model. */
export interface ChronicleBackfillDeps {
	/** Invocation directory; its effective settings gate the whole run. */
	cwd: string;
	sessionsRoot: string;
	stdout(line: string): void;
	stderr(line: string): void;
	loadSettings(cwd: string, overrides: Readonly<Record<string, unknown>> | undefined): Promise<Settings>;
	/** Called at most once, and never for a dry run. */
	openModelRegistry(settings: Settings): Promise<ModelRegistry>;
	buildObfuscator(cwd: string, settings: Settings): Promise<SecretObfuscator | undefined>;
}

export const DEFAULT_BACKFILL_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;
const DEFAULT_DRAIN_MS = 10 * 60_000;
const SCAN_CONCURRENCY = 8;

const DURATION_UNITS_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
const SIZE_UNITS: Readonly<Record<string, number>> = {
	"": 1,
	b: 1,
	k: 1024,
	kb: 1024,
	kib: 1024,
	m: 1024 ** 2,
	mb: 1024 ** 2,
	mib: 1024 ** 2,
	g: 1024 ** 3,
	gb: 1024 ** 3,
	gib: 1024 ** 3,
};

/** `90`, `30s`, `10m`, `1h30m`, `500ms`; a bare number is seconds. */
export function parseBackfillDuration(text: string, flag: string): number {
	const trimmed = text.trim().toLowerCase();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1_000;
	if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(trimmed)) {
		throw new CliUsageError(`--${flag} expects a duration like 90s, 10m, or 1h30m; got "${text}"`);
	}
	let total = 0;
	for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
		total += Number(amount) * DURATION_UNITS_MS[unit!]!;
	}
	return total;
}

/** `4096`, `64k`, `2MB`, `1GiB` (binary multiples). */
export function parseBackfillSize(text: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text.trim());
	const unit = match ? SIZE_UNITS[match[2]!.toLowerCase()] : undefined;
	if (!match || unit === undefined)
		throw new CliUsageError(`--min-size expects a size like 4096, 64k, or 2MB; got "${text}"`);
	return Number(match[1]) * unit;
}

/**
 * A date-only value is a local calendar day: `--since` starts at its midnight,
 * `--until` includes the whole day. Anything else goes through `Date.parse`.
 */
export function parseBackfillDate(text: string, flag: "since" | "until"): number {
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text.trim());
	const ms = dateOnly ? new Date(`${text.trim()}T00:00:00`).getTime() : Date.parse(text);
	if (Number.isNaN(ms)) throw new CliUsageError(`--${flag} expects a date like 2026-09-01; got "${text}"`);
	return dateOnly && flag === "until" ? ms + 24 * 3_600_000 : ms;
}

interface Candidate extends StoredSessionCoverage {
	readonly size: number;
	readonly modifiedMs: number;
}

interface Selection {
	readonly candidates: Candidate[];
	/** Sessions whose transcript or store could not be read. */
	readonly unreadable: number;
}

async function resolveSessionFiles(flags: ChronicleBackfillFlags, deps: ChronicleBackfillDeps): Promise<string[]> {
	const files = new Set<string>();
	let listing: SessionInfo[] | undefined;
	const listed = async () => {
		listing ??= await listAllSessions(new FileSessionStorage(), deps.sessionsRoot);
		return listing;
	};

	for (const arg of flags.sessions) {
		const asPath = path.resolve(deps.cwd, arg);
		const stat = await fs.stat(asPath).catch(() => undefined);
		if (stat?.isFile()) {
			files.add(asPath);
			continue;
		}
		const matches = (await listed()).filter(session => sessionMatchesResumeArg(session, arg));
		if (matches.length === 0) throw new CliUsageError(`No stored session matches "${arg}"`);
		if (matches.length > 1) {
			throw new CliUsageError(
				`"${arg}" matches ${matches.length} sessions: ${matches.map(session => session.id).join(", ")}`,
			);
		}
		files.add(path.resolve(matches[0]!.path));
	}

	if (flags.all || flags.project) {
		const project = flags.project ? path.resolve(deps.cwd, flags.project) : undefined;
		for (const session of await listed()) {
			if (project && (!session.cwd || path.resolve(session.cwd) !== project)) continue;
			files.add(path.resolve(session.path));
		}
	}
	return [...files];
}

async function selectSessions(flags: ChronicleBackfillFlags, deps: ChronicleBackfillDeps): Promise<Selection> {
	const since = flags.since === undefined ? undefined : parseBackfillDate(flags.since, "since");
	const until = flags.until === undefined ? undefined : parseBackfillDate(flags.until, "until");
	const minSize = flags.minSize === undefined ? undefined : parseBackfillSize(flags.minSize);
	const files = await resolveSessionFiles(flags, deps);

	const scanned = await mapWithConcurrencyLimitAllSettled(files, SCAN_CONCURRENCY, async file => {
		const [coverage, stat] = await Promise.all([readStoredSessionCoverage(file), fs.stat(file)]);
		return { ...coverage, size: stat.size, modifiedMs: stat.mtimeMs } satisfies Candidate;
	});

	const candidates: Candidate[] = [];
	let unreadable = 0;
	scanned.results.forEach((result, index) => {
		if (!result) return;
		if (result.status === "rejected") {
			unreadable++;
			deps.stderr(`${shortenPath(files[index]!)}: cannot read session: ${errorText(result.reason)}`);
			return;
		}
		const candidate = result.value;
		// Date bounds select sessions whose activity overlaps the window.
		if (since !== undefined && candidate.modifiedMs < since) return;
		if (until !== undefined && Date.parse(candidate.createdAt) >= until) return;
		if (minSize !== undefined && candidate.size < minSize) return;
		candidates.push(candidate);
	});
	candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sessionFile.localeCompare(b.sessionFile));
	return { candidates, unreadable };
}

function uncovered(coverage: BackfillCoverage): number {
	return coverage.totalEntries - coverage.coveredEntries;
}

function describeCoverage(coverage: BackfillCoverage): string {
	return `${coverage.coveredEntries}/${coverage.totalEntries} entries`;
}

const OUTCOME_LABEL: Readonly<Record<BackfillOutcome, string>> = {
	complete: "complete",
	incomplete: "incomplete (timeout; rerun to resume)",
	halted: "halted",
	no_model: "halted: no model resolved for the chronicler role",
	leased: "skipped: another process holds this session's Chronicler lease",
	disabled: "skipped: chronicler.enabled is false for this project",
	legacy: "skipped: v1 transcript without persisted entry ids (resume it once to migrate)",
};

/** Run the command; returns the process exit code. */
export async function runChronicleBackfill(
	flags: ChronicleBackfillFlags,
	deps: ChronicleBackfillDeps,
): Promise<number> {
	if (flags.sessions.length === 0 && !flags.project && !flags.all) {
		throw new CliUsageError("Select sessions by id or path, --project <dir>, or --all");
	}
	if (!Number.isSafeInteger(flags.concurrency) || flags.concurrency < 1) {
		throw new CliUsageError("--concurrency must be a positive integer");
	}
	const timeoutMs = flags.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseBackfillDuration(flags.timeout, "timeout");
	const drainMs = flags.drain === undefined ? DEFAULT_DRAIN_MS : parseBackfillDuration(flags.drain, "drain");
	const overrides = flags.force ? { [cfgChroniclerEnabled.id]: true } : undefined;

	const baseSettings = await deps.loadSettings(deps.cwd, overrides);
	if (!flags.dryRun && !cfgChroniclerEnabled.get(baseSettings)) {
		deps.stderr("chronicler.enabled is false in the effective settings; refusing. Pass --force to backfill anyway.");
		return 2;
	}

	const { candidates, unreadable } = await selectSessions(flags, deps);
	const covered = candidates.filter(candidate => !candidate.legacy && uncovered(candidate) === 0);
	const pending = candidates.filter(candidate => candidate.legacy || uncovered(candidate) > 0);

	if (flags.dryRun) {
		let total = 0;
		for (const candidate of pending) {
			total += candidate.legacy ? 0 : uncovered(candidate);
			const state = candidate.legacy
				? "legacy v1 transcript (not backfillable headlessly)"
				: `${uncovered(candidate)} of ${candidate.totalEntries} entries uncovered, ${candidate.beats} beats`;
			deps.stdout(`${candidate.sessionId}  ${state}  ${shortenPath(candidate.cwd)}`);
		}
		deps.stdout(
			`${pending.length} session(s) need backfill (${total} uncovered entries); ${covered.length} already covered${unreadable ? `; ${unreadable} unreadable` : ""}.`,
		);
		return unreadable > 0 ? 1 : 0;
	}

	// Opened once, on the first session that actually reaches capture.
	let registry: Promise<ModelRegistry> | undefined;

	const results = await mapWithConcurrencyLimitAllSettled(pending, flags.concurrency, async candidate => {
		const id = candidate.sessionId;
		if (candidate.legacy) {
			deps.stdout(`${id}  ${OUTCOME_LABEL.legacy}  ${shortenPath(candidate.cwd)}`);
			return { outcome: "legacy", before: candidate, after: candidate } satisfies HeadlessBackfillResult;
		}
		deps.stdout(
			`${id}  start  ${describeCoverage(candidate)}, ${candidate.beats} beats  ${shortenPath(candidate.cwd)}`,
		);
		const settings = await deps.loadSettings(candidate.cwd, overrides);
		registry ??= deps.openModelRegistry(baseSettings);
		const result = await runHeadlessBackfill({
			sessionFile: candidate.sessionFile,
			settings,
			modelRegistry: await registry,
			obfuscator: await deps.buildObfuscator(candidate.cwd, settings),
			timeoutMs,
			drainMs,
			onProgress: coverage =>
				deps.stdout(`${id}  ${describeCoverage(coverage)}, +${coverage.beats - candidate.beats} beats  running`),
			onNotice: (level, message) => deps.stderr(`${id}  ${level}: ${message}`),
		});
		deps.stdout(
			`${id}  ${describeCoverage(result.after)}, +${result.after.beats - candidate.beats} beats  ${OUTCOME_LABEL[result.outcome]}`,
		);
		return result;
	});

	const counts = new Map<BackfillOutcome | "error", number>();
	let beatsAdded = 0;
	results.results.forEach((settled, index) => {
		if (!settled) return;
		if (settled.status === "rejected") {
			counts.set("error", (counts.get("error") ?? 0) + 1);
			deps.stderr(`${pending[index]!.sessionId}  error: ${errorText(settled.reason)}`);
			return;
		}
		const result: HeadlessBackfillResult = settled.value;
		counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
		beatsAdded += result.after.beats - result.before.beats;
	});

	const parts = [`${pending.length} session(s)`, `+${beatsAdded} beats`];
	for (const [outcome, count] of counts) parts.push(`${outcome} ${count}`);
	if (covered.length > 0) parts.push(`already covered ${covered.length}`);
	if (unreadable > 0) parts.push(`unreadable ${unreadable}`);
	deps.stdout(`Backfill: ${parts.join(", ")}`);

	const failed = (counts.get("halted") ?? 0) + (counts.get("no_model") ?? 0) + (counts.get("error") ?? 0);
	return failed > 0 || unreadable > 0 ? 1 : 0;
}

/** Real process dependencies: the configured agent dir, auth vault, and model registry. */
export function createChronicleBackfillDeps(): ChronicleBackfillDeps & { close(): void } {
	const agentDir = getAgentDir();
	let closeAuth: (() => void) | undefined;
	return {
		cwd: getProjectDir(),
		sessionsRoot: getSessionsDir(agentDir),
		stdout: line => process.stdout.write(`${line}\n`),
		stderr: line => process.stderr.write(`${line}\n`),
		loadSettings: (cwd, overrides) => Settings.loadReadOnly({ cwd, agentDir, overrides }),
		async openModelRegistry(settings) {
			initializeWithSettings(settings);
			const authStorage = await discoverAuthStorage(agentDir, { settings, cwd: settings.getCwd() });
			closeAuth = () => authStorage.close();
			const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), {
				settings,
				cacheDbPath: getModelDbPath(agentDir),
			});
			await registry.refreshRuntimeProviders();
			await registry.hydrateCredentialScopedModelCaches();
			return registry;
		},
		buildObfuscator: (cwd, settings) =>
			cfgSecretsEnabled.get(settings) ? buildSecretObfuscator(cwd, agentDir) : Promise.resolve(undefined),
		close: () => closeAuth?.(),
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

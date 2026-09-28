/**
 * `get_usage` RPC command: account-level provider usage reports from the
 * running session's auth storage, in the shape `npi usage --json` prints.
 *
 * The fetch goes through `AgentSession.fetchUsageReports`, so it shares the
 * session's usage cache and in-flight coalescing with the status line and
 * `/usage`. Filtering, `raw` stripping, and `--redact` masking reuse the
 * usage CLI helpers so the two surfaces cannot drift.
 */
import type { AuthStorage, UsageReport } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import {
	collectReportableAccounts,
	filterUsageReports,
	prepareUsageView,
	usageReportsForJson,
} from "../../cli/usage-cli";

/** Machine-readable `code` on a failed `get_usage` response. */
export const RPC_USAGE_UNAVAILABLE_CODE = "usage_unavailable";

/** The session has no initialized auth storage to report usage from. */
export class RpcUsageUnavailableError extends Error {
	readonly code = RPC_USAGE_UNAVAILABLE_CODE;

	constructor() {
		super("Usage reporting is unavailable: auth storage is not initialized for this session");
		this.name = "RpcUsageUnavailableError";
	}
}

/** The slice of the session `get_usage` reads. */
export interface RpcUsageSource {
	/** Auth storage behind the session's model registry. */
	readonly authStorage: AuthStorage | undefined;
	/** Cached, coalesced usage fetch; resolves `null` when usage reporting is not wired. */
	fetchUsageReports(): Promise<UsageReport[] | null>;
}

export interface RpcUsageRequest {
	/** Provider id to report on (case-insensitive); every provider when unset. */
	provider?: string;
	/** Invalidate cached reports for the targeted providers before fetching. */
	refresh?: boolean;
	/** Mask account identifiers exactly as `npi usage --redact` does. */
	redact?: boolean;
}

export interface RpcUsageResult {
	/** Epoch ms when the response was assembled. */
	generatedAt: number;
	/** Reports as `npi usage --json` prints them (`raw` dropped). */
	reports: Array<Omit<UsageReport, "raw">>;
}

/**
 * Resolve one `get_usage` request.
 *
 * @throws {RpcUsageUnavailableError} when the session has no auth storage.
 */
export async function getRpcUsage(source: RpcUsageSource, request: RpcUsageRequest): Promise<RpcUsageResult> {
	const authStorage = source.authStorage;
	if (!authStorage) throw new RpcUsageUnavailableError();
	const provider = request.provider || undefined;
	if (request.refresh) await authStorage.usage.invalidate(provider?.toLowerCase());

	let reports: UsageReport[] | null;
	try {
		reports = await source.fetchUsageReports();
	} catch (error: unknown) {
		// Per-credential failures are absorbed upstream (last-good cache or
		// omission); a rejected fetch fails every provider it would have covered.
		logger.warn("RPC get_usage fetch failed", { provider, error: String(error) });
		return { generatedAt: Date.now(), reports: failedUsageReports(authStorage, provider, error) };
	}
	if (reports === null) throw new RpcUsageUnavailableError();

	if (!request.redact) {
		return { generatedAt: Date.now(), reports: usageReportsForJson(filterUsageReports(reports, provider)) };
	}
	const view = await prepareUsageView(authStorage, reports, { provider, redact: true });
	return { generatedAt: Date.now(), reports: usageReportsForJson(view.reports, view.redaction) };
}

/** One `limits: []` report with a failure note per provider with a stored credential and a usage endpoint. */
function failedUsageReports(authStorage: AuthStorage, provider: string | undefined, error: unknown): UsageReport[] {
	const message = error instanceof Error ? error.message : String(error);
	const providers = new Set<string>();
	for (const account of collectReportableAccounts(authStorage, provider).accounts) {
		if (authStorage.usage.providerFor(account.provider) !== undefined) providers.add(account.provider);
	}
	const fetchedAt = Date.now();
	return Array.from(providers, id => ({
		provider: id,
		fetchedAt,
		limits: [],
		notes: [`Usage fetch failed: ${message}`],
	}));
}

/**
 * Shared helpers for `/usage reset` (TUI selector + ACP) and `omp usage reset`:
 * turn the live per-account reset-credit status into rows, resolve a typed
 * `<provider>/<credential id>` target, and map a redeem outcome code to a
 * human message.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget } from "../../session/auth-storage";
import type { ResetUsageAccount } from "@oh-my-pi/pi-tui/overlays/reset-usage-selector";
import { summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";

const CODEX_PROVIDER_ID = "openai-codex";
const CLAUDE_PROVIDER_ID = "anthropic";

/** Provider name shown beside each exact saved-reset account option. */
export function formatResetProviderName(provider: string): string {
	if (provider === CODEX_PROVIDER_ID) return "Codex";
	if (provider === CLAUDE_PROVIDER_ID) return "Claude";
	return provider;
}

/** Strip control characters and fold line breaks so stored or provider text stays on one line. */
export function oneLine(value: string): string {
	return sanitizeText(value.replace(/[\r\n\t]+/g, " "));
}

/** Provider id a saved-reset target names; `claude` and `codex` are aliases. */
export function normalizeResetProvider(value: string): string | undefined {
	switch (value.trim().toLowerCase()) {
		case "anthropic":
		case "claude":
			return CLAUDE_PROVIDER_ID;
		case "openai-codex":
		case "codex":
			return CODEX_PROVIDER_ID;
		default:
			return undefined;
	}
}

/** A typed `<provider>/<credential id>` or `<provider>/active` saved-reset target. */
export interface ResetUsageTarget {
	provider: string;
	/** Lowercased account part: a credential id, or `active`. */
	account: string;
}

/** Parse a saved-reset target; errors point at `command`, which lists the choices. */
export function parseResetUsageTarget(arg: string, command: string): ResetUsageTarget | { error: string } {
	const text = arg.trim();
	const slash = text.indexOf("/");
	if (slash <= 0) return { error: t("commands.resetUsage.chooseAccount", { command }) };
	const provider = normalizeResetProvider(text.slice(0, slash));
	if (!provider) {
		return { error: t("commands.resetUsage.unknownProvider", { provider: oneLine(text.slice(0, slash)) }) };
	}
	return {
		provider,
		account: text
			.slice(slash + 1)
			.trim()
			.toLowerCase(),
	};
}

/**
 * The listed account a saved-reset target names, when it has a reset to spend
 * now; otherwise the message saying why nothing will be spent.
 */
export function resolveResetUsageTarget(
	accounts: readonly ResetUsageAccount[],
	arg: string,
	command: string,
): { account: ResetUsageAccount } | { error: string } {
	const target = parseResetUsageTarget(arg, command);
	if ("error" in target) return target;
	const credentialId = /^\d+$/.test(target.account) ? Number(target.account) : undefined;
	const account = accounts.find(candidate => {
		if (candidate.provider !== target.provider) return false;
		if (target.account === "active") return candidate.active;
		return credentialId !== undefined && candidate.target.credentialId === credentialId;
	});
	if (!account) {
		return { error: t("commands.resetUsage.noMatchingAccount", { target: oneLine(arg.trim()), command }) };
	}
	if (account.error) {
		return {
			error: t("commands.resetUsage.unavailable", {
				account: oneLine(account.label),
				provider: oneLine(account.providerLabel),
				error: oneLine(account.error),
			}),
		};
	}
	if (account.redeemableCount <= 0) {
		const reason = account.unavailableReason ? ` (${oneLine(account.unavailableReason)})` : "";
		return {
			error: t("commands.resetUsage.noneUsable", {
				account: oneLine(account.label),
				provider: oneLine(account.providerLabel),
				reason,
			}),
		};
	}
	return { account };
}

/** One listing row: identity, provider, the account's `<provider>/<credential id>` target, and its resets. */
export function formatResetUsageAccountLine(account: ResetUsageAccount): string {
	let detail: string;
	if (account.error) {
		detail = t("commands.resetUsage.unavailableDetail", { error: oneLine(account.error) });
	} else {
		detail = t("commands.resetUsage.counts", { saved: account.availableCount, usable: account.redeemableCount });
		if (account.expiresAt) detail += t("commands.resetUsage.expiresSuffix", { date: oneLine(account.expiresAt) });
		if (account.redeemableCount === 0 && account.unavailableReason) {
			detail += ` (${oneLine(account.unavailableReason)})`;
		}
	}
	return `- ${oneLine(account.label)} [${oneLine(account.providerLabel)} · ${account.provider}/${account.target.credentialId}]: ${detail}${account.active ? t("commands.resetUsage.activeSuffix") : ""}`;
}

/** Map one account's live reset status to a selector row. */
export function toResetUsageAccount(status: ResetCreditAccountStatus): ResetUsageAccount {
	const provider = status.provider;
	const providerLabel = formatResetProviderName(provider);
	const credit = status.nextCreditId
		? status.credits.find(candidate => candidate.id === status.nextCreditId)
		: (status.credits.find(candidate => candidate.usable !== false) ?? status.credits[0]);
	const advertisedRedeemable = status.redeemableCount ?? status.availableCount;
	const summary = summarizeUsageResetCredits(status);
	// Claude's listing endpoint chooses the one grant that may be spent.
	// Never degrade a missing pin into "spend whichever grant is current".
	const redeemableCount = provider === CLAUDE_PROVIDER_ID && !status.nextCreditId ? 0 : advertisedRedeemable;
	const identity = status.email ?? status.accountId ?? "account";
	const organization = status.orgName ?? status.orgId;
	const label = organization ? `${identity} · ${organization}` : identity;
	const unavailableReason =
		summary?.unavailableReason ??
		(provider === CLAUDE_PROVIDER_ID && advertisedRedeemable > 0 && !status.nextCreditId
			? t("commands.resetUsage.noSafeGrant")
			: undefined) ??
		(status.availableCount > 0 && redeemableCount === 0 ? t("commands.resetUsage.notUsable") : undefined);
	return {
		label,
		provider,
		providerLabel,
		availableCount: status.availableCount,
		redeemableCount,
		target: {
			credentialId: status.credentialId,
			provider,
			...(status.accountId ? { accountId: status.accountId } : {}),
			...(status.email ? { email: status.email } : {}),
			...(status.orgId ? { orgId: status.orgId } : {}),
			...(status.nextCreditId ? { creditId: status.nextCreditId } : {}),
		} satisfies ResetCreditTarget,
		active: status.active,
		error: status.error,
		unavailableReason,
		expiresAt: summary?.soonestExpiry,
		credit,
	};
}

/**
 * Map live per-account reset status to selector rows. Sorted with the active
 * account first, then most-credits, then label.
 */
export function toResetUsageAccounts(statuses: ResetCreditAccountStatus[]): ResetUsageAccount[] {
	return statuses.map(toResetUsageAccount).sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		if (a.redeemableCount !== b.redeemableCount) return b.redeemableCount - a.redeemableCount;
		if (a.availableCount !== b.availableCount) return b.availableCount - a.availableCount;
		if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
		return a.label.localeCompare(b.label);
	});
}

/** Human-facing summary of a redeem outcome for status lines and ACP output. */
export function describeRedeemOutcome(outcome: ResetCreditRedeemOutcome, label: string): string {
	const provider = outcome.provider ? ` (${formatResetProviderName(outcome.provider)})` : "";
	const reason = outcome.reason ? ` — ${outcome.reason}` : "";
	switch (outcome.code) {
		case "reset": {
			const cleared = outcome.cleared ?? [];
			const scope =
				cleared.length === 1 && cleared[0] === "anthropic:5h"
					? t("commands.resetUsage.claudeRefreshed")
					: cleared.length > 0
						? t("commands.resetUsage.coveredRefreshed", { plural: cleared.length === 1 ? " has" : "s have" })
						: t("commands.resetUsage.windowRefreshed");
			return t("commands.resetUsage.applied", { account: label, provider, scope });
		}
		case "already_redeemed":
			return t("commands.resetUsage.redeemed", { account: label, provider });
		case "no_credit":
			return t("commands.resetUsage.noneAvailable", { account: label, provider, reason });
		case "credit_list_failed":
			return t("commands.resetUsage.loadFailed", { account: label, provider });
		case "nothing_to_reset":
			return t("commands.resetUsage.unconstrained", { account: label, provider });
		case "no_account":
			return t("commands.resetUsage.accountNotFound", { account: label, provider });
		case "account_unavailable":
			return t("commands.resetUsage.authFailed", { account: label, provider });
		case "offer_changed":
			return t("commands.resetUsage.offerChanged", { account: label, provider });
		case "reset_in_progress":
			return t("commands.resetUsage.inProgress", { account: label, provider });
		case "reset_unconfirmed":
		case "network_error":
		case "malformed_response":
			return t("commands.resetUsage.uncertain", { account: label, provider, reason });
		default:
			return t("commands.resetUsage.notConfirmed", { account: label, provider, code: outcome.code, reason });
	}
}

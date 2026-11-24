import { sanitizeText } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import type { SessionContinuation } from "../session/session-listing";
import type { SessionPersistenceNotice } from "../session/session-manager";

/**
 * First-failure notice. The store keeps the unlanded entries in memory and
 * retries the whole transcript on the next write, so this reports a retryable
 * condition and claims nothing about durability — the write may still land.
 * `sanitizeText` leaves tabs and newlines intact, so both are normalized here
 * to keep the result on one line.
 */
export function formatPersistenceFailure(message: string): string {
	const detail = truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
	return t("overlaysModel.persistence.failed", { detail });
}

/**
 * Teardown-time durability claim, emitted only while the store failure is
 * still latched at dispose: the retry never landed, so the transcript is not
 * durable and the in-memory entries are gone with the process.
 */
export function formatPersistenceDurabilityFailure(message: string): string {
	const detail = truncateToWidth(replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.LINE);
	return t("overlaysModel.persistence.shutdownFailure", { detail });
}

/**
 * A {@link SessionPersistenceNotice}: saving continues, so this claims no
 * failure. Not truncated, because the notice names the session files the user
 * may need to find.
 */
export function formatPersistenceNotice(notice: SessionPersistenceNotice): string {
	const from = shortenPath(notice.from);
	const to = shortenPath(notice.to);
	let message: string;
	switch (notice.reason) {
		case "open-elsewhere":
			message = t("overlaysModel.persistence.openElsewhere", { from, to });
			break;
		case "replaced":
			message = t("overlaysModel.persistence.replaced", { from, to });
			break;
		case "contested":
			message = t("overlaysModel.persistence.contested", { from, to });
			break;
	}
	return replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " ");
}

/**
 * Resume of a session file whose conversation went on in another file (see
 * {@link SessionContinuation}). Names both files, so the user sees that the
 * file they asked for was not the one opened.
 */
export function formatSessionContinuationNotice(continuation: SessionContinuation): string {
	const from = shortenPath(continuation.from);
	const to = shortenPath(continuation.session.path);
	// A session moves off its file for every SessionPersistenceNotice reason, not only another process's hold.
	let message: string;
	if (continuation.relation === "earlier") {
		message = t("overlaysModel.persistence.continuationEarlier", { from, to });
	} else if (continuation.relation === "other") {
		message = t("overlaysModel.persistence.continuationOther", { from, to });
	} else if (continuation.copies > 2) {
		message = t("overlaysModel.persistence.continuationSeveral", { from, to, count: continuation.copies - 1 });
	} else {
		message = t("overlaysModel.persistence.continuation", { from, to });
	}
	return replaceTabs(sanitizeText(message)).replace(/[\r\n]+/g, " ");
}

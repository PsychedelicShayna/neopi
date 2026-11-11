import type { ReactNode } from "react";
import type { ConnectionPhase, GuestSnapshot } from "../../lib/client";
import { useTranslation } from "../../lib/i18n";

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	loading: GuestSnapshot["loading"];
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ phase, endedReason, loading, onRejoin, onNewLink }: BannersProps): ReactNode {
	const tr = useTranslation();
	const progress = loading && loading.total > 0 ? ` ${Math.floor((loading.received / loading.total) * 100)}%` : "";
	if (phase === "connecting" || phase === "waiting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{phase === "connecting"
					? tr("connection.connecting_relay", "Connecting to relay…")
					: tr("connection.joining_progress", "Joining session…{progress}").replace("{progress}", progress)}
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{tr("connection.reconnecting_progress", "Reconnecting…{progress}").replace("{progress}", progress)}
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label={tr("connection.session_ended_aria", "session ended")}>
				<div className="sh-ended-card">
					<div className="sh-ended-title">{tr("connection.session_ended", "Session ended")}</div>
					{endedReason && <div className="sh-ended-reason">{endedReason}</div>}
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onRejoin}>
							{tr("connection.rejoin", "Rejoin")}
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							{tr("connection.new_link", "New link")}
						</button>
					</div>
				</div>
			</div>
		);
	}
	return null;
}

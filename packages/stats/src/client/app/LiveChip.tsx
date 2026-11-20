import { RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { formatInteger } from "../data/formatters";
import { useLiveStatus } from "../data/live";
import { useTranslation } from "../i18n";
import { Dot } from "../ui";

/** Topbar ingest status; click to sync now. */
export function LiveChip() {
	const tr = useTranslation();
	const { sync, indexingHours, connected, requestSync } = useLiveStatus();
	const now = useNow(sync.phase === "idle" ? 15_000 : null);

	let body: ReactNode;
	let title: string;
	if (!connected) {
		body = (
			<>
				<Dot tone="warn" />
				<span>{tr("live.reconnecting", "Reconnecting")}</span>
			</>
		);
		title = tr("live.disconnected", "Lost the live connection to the stats server; retrying");
	} else if (sync.phase === "syncing") {
		body = (
			<>
				<RefreshCw size={13} className="spin" />
				<span>{tr("live.syncing", "Syncing")}</span>
				{sync.total > 0 && (
					<span className="live-chip-count">
						{formatInteger(sync.current)}/{formatInteger(sync.total)}
					</span>
				)}
			</>
		);
		title = "Ingesting session files";
	} else if (sync.phase === "error") {
		body = (
			<>
				<Dot tone="bad" />
				<span>{tr("live.sync_failed", "Sync failed")}</span>
			</>
		);
		title = tr("live.retry", "{error} — click to retry").replace(
			"{error}",
			sync.error ?? tr("live.sync_failed", "Sync failed"),
		);
	} else if (indexingHours > INDEXING_VISIBLE_HOURS) {
		body = (
			<>
				<RefreshCw size={13} className="spin" />
				<span>{tr("live.indexing", "Indexing")}</span>
				<span className="live-chip-count">
					{tr("live.hours_left", "{hours}h left").replace("{hours}", formatInteger(indexingHours))}
				</span>
			</>
		);
		title = "Building hourly rollups; older ranges fill in as it goes";
	} else {
		body = (
			<>
				<Dot tone="live" pulse />
				<span>{tr("live.live", "Live")}</span>
				{sync.lastSyncedAt !== null && <span className="live-chip-count">{ago(now - sync.lastSyncedAt, tr)}</span>}
			</>
		);
		title = "Click to sync session files now";
	}

	return (
		<button
			type="button"
			className="live-chip"
			onClick={requestSync}
			disabled={sync.phase === "syncing"}
			title={title}
		>
			{body}
		</button>
	);
}

/** A handful of dirty hours is normal live churn; only a real backlog is worth showing. */
const INDEXING_VISIBLE_HOURS = 24;

function useNow(intervalMs: number | null): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (intervalMs === null) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

function ago(ms: number, tr: (key: string, english: string) => string): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 45) return tr("live.just_now", "just now");
	const m = Math.round(s / 60);
	if (m < 60) return tr("live.minutes_ago", "{count}m ago").replace("{count}", String(m));
	const h = Math.round(m / 60);
	return h < 24
		? tr("live.hours_ago", "{count}h ago").replace("{count}", String(h))
		: tr("live.days_ago", "{count}d ago").replace("{count}", String(Math.round(h / 24)));
}

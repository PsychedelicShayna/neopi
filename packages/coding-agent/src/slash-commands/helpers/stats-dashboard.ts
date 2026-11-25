import * as stats from "@oh-my-pi/omp-stats";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { getLocale } from "@oh-my-pi/pi-utils/i18n";
import { openTernPage } from "../../tools/browser/tern/user-page";
import * as openUtils from "../../utils/open";

export const DEFAULT_STATS_DASHBOARD_PORT = 3847;

interface StatsDashboardServer {
	hostname: string;
	port: number;
	stop: () => void;
}

export interface StatsDashboardArgs {
	port: number;
	host: string;
}

export interface StatsDashboardLaunchResult {
	url: string;
	message: string;
}

let activeStatsServer: StatsDashboardServer | undefined;

function statsUsage() {
	return t("commands.dashboard.usage");
}

function parsePort(value: string | undefined): number | string {
	if (!value) return t("commands.dashboard.missingPort", { usage: statsUsage() });
	if (!/^\d+$/.test(value)) return t("commands.dashboard.invalidPort", { port: value });
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535)
		return t("commands.dashboard.invalidPort", { port: value });
	return port;
}

export function parseStatsDashboardArgs(args: string): StatsDashboardArgs | { error: string } {
	const tokens = args.split(/\s+/).filter(Boolean);
	let port = DEFAULT_STATS_DASHBOARD_PORT;
	let host = "127.0.0.1";

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--port" || token === "-p") {
			const parsed = parsePort(tokens[++i]);
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (token.startsWith("--port=")) {
			const parsed = parsePort(token.slice("--port=".length));
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (token === "--host") {
			const value = tokens[++i];
			if (!value) return { error: t("commands.dashboard.missingHost", { usage: statsUsage() }) };
			host = value;
			continue;
		}
		if (token.startsWith("--host=")) {
			const value = token.slice("--host=".length);
			if (!value) return { error: t("commands.dashboard.missingHost", { usage: statsUsage() }) };
			host = value;
			continue;
		}
		return { error: t("commands.dashboard.unknownOption", { option: token, usage: statsUsage() }) };
	}

	return { port, host };
}

/**
 * Start (or reuse) the dashboard and open it (in a Tern pane, in a browser
 * block beside omp's; elsewhere in the system browser), without waiting for
 * ingest: the server syncs sessions in the background and streams progress to the page.
 * `judge` powers the Frustration page's judge runs; a later launch replaces
 * the registered one, so the dashboard always judges through the most recent
 * session.
 */
export async function launchStatsDashboard(
	args: StatsDashboardArgs,
	judge?: stats.StatsJudgeProvider,
): Promise<StatsDashboardLaunchResult> {
	let requestedAddressIgnored = false;

	if (!activeStatsServer) {
		activeStatsServer = await stats.startServer(args.port, args.host, { judge });
	} else {
		requestedAddressIgnored = args.port !== activeStatsServer.port || args.host !== activeStatsServer.hostname;
		// Resolves to the live in-process server; only re-registers the judge.
		if (judge) await stats.startServer(activeStatsServer.port, activeStatsServer.hostname, { judge });
	}

	const url = stats.formatStatsDashboardUrl(activeStatsServer.hostname, activeStatsServer.port, getLocale());
	const page = await openTernPage(url, "beside");
	if (page) page.disconnect();
	else openUtils.openPath(url);

	const serverLine = requestedAddressIgnored
		? t("commands.dashboard.alreadyRunning", { url, host: args.host, port: args.port })
		: t("commands.dashboard.available", { url });

	return { url, message: t("commands.dashboard.syncing", { status: serverLine }) };
}

export function stopStatsDashboard(): void {
	if (!activeStatsServer) return;
	activeStatsServer.stop();
	activeStatsServer = undefined;
	stats.closeDb();
}

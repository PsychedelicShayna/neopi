/**
 * `npi browser-relay` implementation: serve the local CDP relay and install
 * its Chrome extension. Standalone CLI command — console output here is
 * intentional user-facing output.
 */
import * as path from "node:path";
import { APP_NAME, PRODUCT_NAME, VERSION } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { probeRelayServer } from "../tools/browser/relay/daemon";
import { defaultRelayExtensionDir, writeRelayExtension } from "../tools/browser/relay/extension-files";
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { type RelayServer, startRelayServer } from "../tools/browser/relay/server";

export const BROWSER_RELAY_ACTIONS = ["serve", "install"] as const;
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	port: number;
	token?: string;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Gather tabs the agent actively drives into a 'NeoPi' Chrome tab group (default true). */
	group?: boolean;
	verbose?: boolean;
}

/** Default port of the relay endpoint (kept in sync with DEFAULT_RELAY_URL). */
export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	if (args.action === "install") {
		await runInstall(args.dir);
		return;
	}
	await runServe(args);
}

async function runInstall(dirOverride: string | undefined): Promise<void> {
	const dir = dirOverride ? path.resolve(dirOverride) : defaultRelayExtensionDir();
	await writeRelayExtension(dir, VERSION);
	console.log(t("cli.commands.browser-relay.installed", { product: PRODUCT_NAME, path: dir }));
	console.log("");
	console.log(t("cli.commands.browser-relay.chromeSetup"));
	console.log(t("cli.commands.browser-relay.developerMode"));
	console.log(t("cli.commands.browser-relay.loadUnpacked", { path: dir }));
	console.log(t("cli.commands.browser-relay.enableMode", { app: APP_NAME }));
	console.log("");
	console.log(t("cli.commands.browser-relay.startsAutomatically", { app: APP_NAME }));
	console.log(t("cli.commands.browser-relay.manualStart", { app: APP_NAME }));
	console.log(t("cli.commands.browser-relay.connectionBadge"));
	if (!dirOverride) console.log(t("cli.commands.browser-relay.autoUpdate", { app: APP_NAME }));
	console.log(t("cli.commands.browser-relay.oldErrors"));
}

async function runServe(args: BrowserRelayCommandArgs): Promise<void> {
	const log = args.verbose
		? (message: string, data?: Record<string, unknown>) => {
				console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
			}
		: undefined;
	let relay: RelayServer;
	try {
		relay = startRelayServer({ port: args.port, token: args.token, group: args.group !== false, log });
	} catch (err) {
		// The port is machine-global while relays can be started by any project's
		// broker (or by hand): losing the bind to a live relay is success.
		if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
			if (await probeRelayServer(`http://127.0.0.1:${args.port}`)) {
				console.log(
					t("cli.commands.browser-relay.alreadyRunning", {
						product: PRODUCT_NAME,
						url: `http://127.0.0.1:${args.port}`,
					}),
				);
				return;
			}
			console.error(t("cli.commands.browser-relay.portConflict", { port: args.port, product: PRODUCT_NAME }));
			process.exit(1);
		}
		throw err;
	}

	console.log(`${PRODUCT_NAME} browser relay listening on http://127.0.0.1:${args.port}`);
	console.log(
		t("cli.commands.browser-relay.extensionEndpoint", {
			url: `ws://127.0.0.1:${args.port}/ext${args.token ? "?token=***" : ""}`,
		}),
	);
	const defaultEnable = `${APP_NAME} config set browser.relay true`;
	const enable =
		args.port === DEFAULT_RELAY_PORT
			? defaultEnable
			: `${defaultEnable} && ${APP_NAME} config set browser.relayUrl http://127.0.0.1:${args.port}`;
	console.log(t("cli.commands.browser-relay.enableCommand", { command: enable }));
	console.log(t("cli.commands.browser-relay.waitingExtension", { product: PRODUCT_NAME, app: APP_NAME }));

	let announced = false;
	const readiness = setInterval(() => {
		if (relay.bridge.ready && !announced) {
			announced = true;
			console.log(t("cli.commands.browser-relay.connected", { product: PRODUCT_NAME }));
		} else if (!relay.bridge.ready && announced) {
			announced = false;
			console.log(t("cli.commands.browser-relay.disconnected"));
		}
	}, 500);

	const shutdown = () => {
		clearInterval(readiness);
		relay.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Serve runs until SIGINT/SIGTERM; keep the process alive.
	await new Promise<never>(() => {});
}

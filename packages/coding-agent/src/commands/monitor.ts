/**
 * `npi monitor`: the attach pane the tmux agent monitor runs (#345).
 *
 * `attach <session> --capability-file <path>` is what `/monitor` launches: the
 * file holds a capability the owner minted for one agent; the pane reads and
 * deletes it, so it never appears in an argument list. `attach <session>
 * --agent <id>` lets a same-user shell (which can already reach the owner's
 * control socket) mint that capability itself. `idle <session>` is the
 * placeholder that keeps an empty monitor session open until its owner exits.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { APP_NAME, getProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { monitorHelp as commandHelp } from "../cli/command-help";
import { resolveCtlTarget } from "../cli/ctl-cli";
import { Settings, settings } from "../config/settings";
import { ControlClient } from "../control/client";
import type { MonitorGrantInfo } from "../control/monitor-service";
import { type ControlMetadata, findControlMetadata, publicationProcessGone } from "../control/registry";
import { cfgColorBlindMode, cfgSymbolPreset, cfgThemeDark, cfgThemeLight, cfgTuiVimMode } from "../modes/settings";
import { runMonitorAttach } from "../monitor/attach";
import { paneClosedMarker } from "../monitor/tmux-manager";

const IDLE_POLL_MS = 2_000;

export default class Monitor extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({ description: "attach or idle", required: true, options: ["attach", "idle"] }),
		session: Args.string({
			description: "Owner session: control instance id, prefix, or any ctl selector",
			required: true,
		}),
	};

	static flags = {
		"capability-file": Flags.string({
			description: "File holding the owner-minted monitor capability (deleted on read)",
		}),
		agent: Flags.string({
			description: "Agent id to attach to, minting the capability over the owner's control socket",
		}),
	};

	static examples = [
		`${APP_NAME} monitor attach <instanceId> --agent <agentId>`,
		`${APP_NAME} monitor attach <instanceId> --capability-file <path>`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Monitor);
		const session = args.session;
		if (!session) throw new CliUsageError("monitor needs the owner session (control instance id or selector)");
		if (args.action === "idle") {
			process.exitCode = await runIdle(session);
			return;
		}
		const capabilityFile = flags["capability-file"];
		if ((capabilityFile === undefined) === (flags.agent === undefined)) {
			throw new CliUsageError("monitor attach needs exactly one of --capability-file or --agent");
		}
		if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
			process.stderr.write(`${APP_NAME} monitor attach is interactive and requires a TTY\n`);
			process.exitCode = 1;
			return;
		}
		const metadata = await resolveCtlTarget(session);
		const capability = capabilityFile
			? await readCapabilityFile(capabilityFile)
			: await mintCapability(metadata, flags.agent ?? "");
		await Settings.init({ cwd: getProjectDir() });
		setMenuSearchVimMode(cfgTuiVimMode.get(settings));
		await initTheme(
			false,
			cfgSymbolPreset.get(settings),
			cfgColorBlindMode.get(settings),
			cfgThemeDark.get(settings),
			cfgThemeLight.get(settings),
		);
		// Closing the pane with the keys or through tmux (SIGHUP) marks it closed
		// on purpose. A crash or a failed attach leaves no marker.
		const markClosed = (): void => {
			if (!capabilityFile) return;
			try {
				fsSync.writeFileSync(paneClosedMarker(capabilityFile), "", { mode: 0o600 });
			} catch {
				// The monitor already stopped and removed its directory.
			}
		};
		process.once("SIGHUP", () => {
			markClosed();
			process.exit(129);
		});
		const result = await runMonitorAttach({ metadata, capability });
		if (result.closedByUser) markClosed();
		process.exitCode = result.exitCode;
		process.exit();
	}
}

/** Read the one-shot capability file and delete it. */
async function readCapabilityFile(file: string): Promise<string> {
	let capability: string;
	try {
		capability = (await Bun.file(file).text()).trim();
	} catch (error) {
		if (isEnoent(error)) throw new CliUsageError(`capability file ${file} is gone (already used?)`);
		throw error;
	}
	await fs.rm(file, { force: true });
	if (!/^[0-9a-f]{64}$/.test(capability)) throw new CliUsageError(`capability file ${file} is malformed`);
	return capability;
}

async function mintCapability(metadata: ControlMetadata, agentId: string): Promise<string> {
	const client = new ControlClient({ metadata, label: "monitor-grant", kind: "cli" });
	await client.connect();
	try {
		const response = await client.request({ type: "monitor_grant", agentId });
		if (!response.success) throw new CliUsageError(response.error ?? `cannot monitor ${agentId}`);
		return (response.data as MonitorGrantInfo).capability;
	} finally {
		client.close();
	}
}

/** Placeholder pane: say what this session is, then wait for the owner to exit. */
async function runIdle(selector: string): Promise<number> {
	const metadata = await resolveCtlTarget(selector);
	const title = metadata.title ?? metadata.cwd;
	process.stdout.write(`\n  npi monitor · ${title}\n\n  Subagent and advisor panes open here as they start.\n`);
	for (;;) {
		await Bun.sleep(IDLE_POLL_MS);
		const current = await findControlMetadata(metadata.instanceId);
		if (!current || publicationProcessGone(current)) return 0;
	}
}

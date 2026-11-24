/**
 * CLI handlers for local Collab discovery and explicit link retrieval.
 * Listing returns metadata only; capabilities travel over authenticated IPC
 * only when a caller requests a link.
 */
import { APP_NAME, formatAge } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { t } from "@oh-my-pi/pi-utils/i18n";
import {
	COLLAB_REGISTRY_VERSION,
	type CollabHostSnapshot,
	type CollabListOptions,
	type CollabResolvedLink,
	listCollabHosts,
	resolveCollabHostLink,
} from "../collab/registry";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";

export interface CollabListCommandArgs {
	/** Emit deterministic machine-readable JSON. */
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabListOptions;
}

export interface CollabLinkCommandArgs {
	selector: string;
	/** Request a view-only link instead of control access. */
	view: boolean;
	json: boolean;
	/** Registry overrides (tests). */
	registry?: CollabListOptions;
}

/** Versioned top-level JSON shape for `npi collab list --json`. */
export interface CollabListJsonOutput {
	version: number;
	hosts: CollabHostSnapshot[];
}

/** Versioned capability response for `npi collab link --json`. */
export interface CollabLinkJsonOutput extends CollabResolvedLink {
	version: number;
}

export async function runCollabListCommand(
	args: CollabListCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const hosts = await listCollabHosts(args.registry);
	if (args.json) {
		const output: CollabListJsonOutput = { version: COLLAB_REGISTRY_VERSION, hosts };
		print(JSON.stringify(output, null, 2));
		return;
	}

	if (hosts.length === 0) {
		print(chalk.dim(t("cli.commands.collab.noHosts")));
		return;
	}

	print(
		chalk.green(
			t(hosts.length === 1 ? "cli.commands.collab.hosts.one" : "cli.commands.collab.hosts.many", {
				count: hosts.length,
			}),
		),
	);
	for (const host of hosts) {
		// Session names and POSIX paths come from other processes and may carry
		// tabs, newlines, or escape bytes; keep each on one clean line.
		const name = host.sessionName ? sanitizeDisplayLine(host.sessionName) : "";
		const sessionId = sanitizeDisplayLine(host.sessionId);
		const session = name ? `${name} (${sessionId})` : sessionId;
		const cwd = sanitizeDisplayLine(shortenPath(host.cwd));
		const guests = host.participants - 1;
		const age = formatAge(Math.round((Date.now() - host.startedAt) / 1000));
		const details = [
			`pid ${host.pid}`,
			`gen ${host.generation}`,
			host.model
				? sanitizeDisplayLine(`${host.model.provider}/${host.model.id}`)
				: t("commands.collaboration.noModel"),
			t("cli.commands.collab.started", {
				age: !age || age === t("en", "commands.collaboration.justNow") ? t("commands.collaboration.justNow") : age,
			}),
			t("commands.collaboration.guests", { count: guests, plural: guests === 1 ? "" : "s" }),
			host.access,
			host.relayConnected
				? t("commands.collaboration.relayConnected")
				: t("commands.collaboration.relayReconnecting"),
		];
		if (host.inputRequired) details.push(t("commands.collaboration.inputRequired"));
		if (host.busy !== null)
			details.push(host.busy ? t("cli.commands.collab.working") : t("cli.commands.collab.idle"));
		print("");
		print(`${host.instanceId}  ${session}  ${chalk.dim(cwd)}`);
		print(`  ${chalk.dim(details.join(" · "))}`);
	}
	print(chalk.dim(t("cli.commands.collab.getLink", { app: APP_NAME })));
}

export async function runCollabLinkCommand(
	args: CollabLinkCommandArgs,
	print: (line: string) => void = line => console.log(line),
): Promise<void> {
	const link = await resolveCollabHostLink(args.selector, args.view ? "view" : "control", args.registry);
	if (args.json) {
		const output: CollabLinkJsonOutput = { version: COLLAB_REGISTRY_VERSION, ...link };
		print(JSON.stringify(output, null, 2));
		return;
	}
	print(link.url);
}

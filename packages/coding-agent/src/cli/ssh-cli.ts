/**
 * SSH CLI command handlers.
 *
 * Handles `omp ssh <command>` subcommands for SSH host configuration management.
 */

import { APP_NAME, getSSHConfigPath } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../ssh/config-writer";

// =============================================================================
// Types
// =============================================================================

export type SSHAction = "add" | "remove" | "list";

export interface SSHCommandArgs {
	action: SSHAction;
	args: string[];
	flags: {
		json?: boolean;
		host?: string;
		user?: string;
		port?: string;
		key?: string;
		desc?: string;
		compat?: boolean;
		scope?: "project" | "user";
	};
}

// =============================================================================
// Main dispatcher
// =============================================================================

export async function runSSHCommand(cmd: SSHCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "add":
			await handleAdd(cmd);
			break;
		case "remove":
			await handleRemove(cmd);
			break;
		case "list":
			await handleList(cmd);
			break;
		default:
			process.stdout.write(chalk.red(`${t("cli.commands.session.unknown_action", { action: cmd.action })}\n`));
			process.stdout.write(`${t("cli.commands.ssh.valid_actions", { actions: "add, remove, list" })}\n`);
			process.exitCode = 1;
	}
}

// =============================================================================
// Handlers
// =============================================================================

async function handleAdd(cmd: SSHCommandArgs): Promise<void> {
	const name = cmd.args[0];
	if (!name) {
		process.stdout.write(chalk.red(`${t("cli.commands.ssh.host_name_required")}\n`));
		process.stdout.write(
			chalk.dim(
				`${t("cli.commands.shell.usage")} ${APP_NAME} ssh add <name> --host <address> [--user <user>] [--port <port>] [--key <path>]\n`,
			),
		);
		process.exitCode = 1;
		return;
	}

	const host = cmd.flags.host;
	if (!host) {
		process.stdout.write(chalk.red(`${t("cli.commands.ssh.host_required")}\n`));
		process.stdout.write(chalk.dim(`${t("cli.commands.shell.usage")} ${APP_NAME} ssh add <name> --host <address>\n`));
		process.exitCode = 1;
		return;
	}

	// Validate port if provided
	if (cmd.flags.port !== undefined) {
		const port = Number.parseInt(cmd.flags.port, 10);
		if (Number.isNaN(port) || port < 1 || port > 65535) {
			process.stdout.write(chalk.red(`${t("cli.commands.ssh.invalid_port")}\n`));
			process.exitCode = 1;
			return;
		}
	}

	const hostConfig: SSHHostConfig = { host };
	if (cmd.flags.user) hostConfig.username = cmd.flags.user;
	if (cmd.flags.port) hostConfig.port = Number.parseInt(cmd.flags.port, 10);
	if (cmd.flags.key) hostConfig.keyPath = cmd.flags.key;
	if (cmd.flags.desc) hostConfig.description = cmd.flags.desc;
	if (cmd.flags.compat) hostConfig.compat = true;

	const scope = cmd.flags.scope ?? "project";
	const filePath = getSSHConfigPath(scope);

	try {
		await addSSHHost(filePath, name, hostConfig);
		process.stdout.write(chalk.green(`${t("cli.commands.ssh.added_host", { name, scope })}\n`));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stdout.write(chalk.red(`${t("tools.common.error_detail", { message })}\n`));
		process.exitCode = 1;
	}
}

async function handleRemove(cmd: SSHCommandArgs): Promise<void> {
	const name = cmd.args[0];
	if (!name) {
		process.stdout.write(chalk.red(`${t("cli.commands.ssh.host_name_required")}\n`));
		process.stdout.write(
			chalk.dim(`${t("cli.commands.shell.usage")} ${APP_NAME} ssh remove <name> [--scope project|user]\n`),
		);
		process.exitCode = 1;
		return;
	}

	const scope = cmd.flags.scope ?? "project";
	const filePath = getSSHConfigPath(scope);

	try {
		await removeSSHHost(filePath, name);
		process.stdout.write(chalk.green(`${t("cli.commands.ssh.removed_host", { name, scope })}\n`));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		process.stdout.write(chalk.red(`${t("tools.common.error_detail", { message })}\n`));
		process.exitCode = 1;
	}
}

async function handleList(cmd: SSHCommandArgs): Promise<void> {
	const projectPath = getSSHConfigPath("project");
	const userPath = getSSHConfigPath("user");

	const [projectConfig, userConfig] = await Promise.all([readSSHConfigFile(projectPath), readSSHConfigFile(userPath)]);

	const projectHosts = projectConfig.hosts ?? {};
	const userHosts = userConfig.hosts ?? {};

	if (cmd.flags.json) {
		process.stdout.write(JSON.stringify({ project: projectHosts, user: userHosts }, null, 2));
		process.stdout.write("\n");
		return;
	}

	const hasProject = Object.keys(projectHosts).length > 0;
	const hasUser = Object.keys(userHosts).length > 0;

	if (!hasProject && !hasUser) {
		process.stdout.write(chalk.dim(`${t("cli.commands.ssh.no_hosts")}\n`));
		const command = `${APP_NAME} ssh add <name> --host <address>`;
		process.stdout.write(chalk.dim(`${t("cli.commands.ssh.add_hint", { command })}\n`));
		return;
	}

	if (hasProject) {
		process.stdout.write(chalk.bold(`${t("cli.commands.ssh.project_hosts", { path: projectPath })}\n`));
		printHosts(projectHosts);
	}

	if (hasProject && hasUser) {
		process.stdout.write("\n");
	}

	if (hasUser) {
		process.stdout.write(chalk.bold(`${t("cli.commands.ssh.user_hosts", { path: userPath })}\n`));
		printHosts(userHosts);
	}
}

// =============================================================================
// Helpers
// =============================================================================

function printHosts(hosts: Record<string, SSHHostConfig>): void {
	for (const [name, config] of Object.entries(hosts)) {
		const parts = [chalk.cyan(name), config.host];
		if (config.username) parts.push(chalk.dim(config.username));
		if (config.port && config.port !== 22) parts.push(chalk.dim(t("cli.commands.ssh.port", { port: config.port })));
		if (config.keyPath) parts.push(chalk.dim(config.keyPath));
		if (config.description) parts.push(chalk.dim(`- ${config.description}`));
		process.stdout.write(`  ${parts.join("  ")}\n`);
	}
}

/**
 * SSH Command Controller
 *
 * Handles /ssh subcommands for managing SSH host configurations.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import { getProjectDir, getSSHConfigPath } from "@oh-my-pi/pi-utils";
import { Text } from "@oh-my-pi/pi-tui";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { reset as resetCapabilities } from "../../capability";
import { type SSHHost, sshCapability } from "../../capability/ssh";
import { loadCapability } from "../../discovery";
import { addSSHHost, readSSHConfigFile, removeSSHHost, type SSHHostConfig } from "../../ssh/config-writer";
import { parseCommandArgs } from "../../utils/command-args";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../types";
import {
	groupBySource,
	parseRemoveArgs,
	readScopeFlag,
	type ScopeValue,
	showCommandMessage,
} from "./command-controller-shared";

export class SSHCommandController {
	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Handle /ssh command and route to subcommands
	 */
	async handle(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const subcommand = parts[1]?.toLowerCase();

		if (!subcommand || subcommand === "help") {
			this.#showHelp();
			return;
		}

		switch (subcommand) {
			case "add":
				await this.#handleAdd(text);
				break;
			case "list":
				await this.#handleList();
				break;
			case "remove":
			case "rm":
				await this.#handleRemove(text);
				break;
			default:
				this.ctx.showError(t("overlays.ssh_command_controller.unknown_subcommand", { part1: `${subcommand}` }));
		}
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			t("overlays.ssh_command_controller.help_intro"),
			"",
			theme.fg("accent", t("overlays.ssh_command_controller.commands")),
			"  /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--desc <description>] [--compat] [--scope project|user]",
			t("overlays.ssh_command_controller.help_list"),
			t("overlays.ssh_command_controller.help_remove"),
			t("overlays.ssh_command_controller.help_help"),
			"",
		].join("\n");

		this.#showReport(t("overlays.ssh_command_controller.management"), helpText);
	}

	/**
	 * Handle /ssh add - parse flags and add host to config
	 */
	async #handleAdd(text: string): Promise<void> {
		const prefixMatch = text.match(/^\/ssh\s+add\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		if (!rest) {
			this.ctx.showError(t("overlays.ssh_command_controller.add_usage"));
			return;
		}

		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			this.ctx.showError(t("overlays.ssh_command_controller.add_usage"));
			return;
		}

		let name: string | undefined;
		let scope: ScopeValue = "project";
		let host: string | undefined;
		let username: string | undefined;
		let port: number | undefined;
		let keyPath: string | undefined;
		let description: string | undefined;
		let compat = false;

		let i = 0;
		if (!tokens[0].startsWith("-")) {
			name = tokens[0];
			i = 1;
		}

		while (i < tokens.length) {
			const argToken = tokens[i];
			if (argToken === "--host") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError(t("overlays.ssh_command_controller.missing_host"));
					return;
				}
				host = value;
				i += 2;
				continue;
			}
			if (argToken === "--user") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError(t("overlays.ssh_command_controller.missing_user"));
					return;
				}
				username = value;
				i += 2;
				continue;
			}
			if (argToken === "--port") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError(t("overlays.ssh_command_controller.missing_port"));
					return;
				}
				const parsed = Number.parseInt(value, 10);
				if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
					this.ctx.showError(t("overlays.ssh_command_controller.invalid_port"));
					return;
				}
				port = parsed;
				i += 2;
				continue;
			}
			if (argToken === "--key") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError(t("overlays.ssh_command_controller.missing_key"));
					return;
				}
				keyPath = value;
				i += 2;
				continue;
			}
			if (argToken === "--desc") {
				const value = tokens[i + 1];
				if (!value) {
					this.ctx.showError(t("overlays.ssh_command_controller.missing_desc"));
					return;
				}
				description = value;
				i += 2;
				continue;
			}
			if (argToken === "--compat") {
				compat = true;
				i += 1;
				continue;
			}
			if (argToken === "--scope") {
				const r = readScopeFlag(tokens[i + 1]);
				if (!r.ok) {
					this.ctx.showError(r.error);
					return;
				}
				scope = r.scope;
				i += 2;
				continue;
			}
			this.ctx.showError(t("overlays.ssh_command_controller.unknown_option", { part1: `${argToken}` }));
			return;
		}

		if (!name) {
			this.ctx.showError(t("overlays.ssh_command_controller.name_required"));
			return;
		}

		if (!host) {
			this.ctx.showError(t("overlays.ssh_command_controller.host_required"));
			return;
		}

		try {
			const cwd = getProjectDir();
			const filePath = getSSHConfigPath(scope, cwd);

			const hostConfig: SSHHostConfig = { host };
			if (username) hostConfig.username = username;
			if (port) hostConfig.port = port;
			if (keyPath) hostConfig.keyPath = keyPath;
			if (description) hostConfig.description = description;
			if (compat) hostConfig.compat = true;

			await addSSHHost(filePath, name, hostConfig);
			resetCapabilities();

			const scopeLabel = scope === "user" ? "user" : "project";
			const lines = [
				"",
				theme.fg(
					"success",
					t("overlays.ssh_command_controller.added", { part1: `${name}`, part2: `${scopeLabel}` }),
				),
				"",
				`  Host: ${host}`,
			];
			if (username) lines.push(t("overlays.ssh_command_controller.user", { part1: `${username}` }));
			if (port) lines.push(t("overlays.ssh_command_controller.port", { part1: `${port}` }));
			if (keyPath) lines.push(t("overlays.ssh_command_controller.key", { part1: `${keyPath}` }));
			if (description) lines.push(t("overlays.ssh_command_controller.desc", { part1: `${description}` }));
			if (compat) lines.push(`  Compat: true`);
			lines.push("");
			lines.push(
				theme.fg(
					"muted",
					t("overlays.ssh_command_controller.list_hint", { part1: `${theme.fg("accent", "/ssh list")}` }),
				),
			);
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);

			let helpText = "";
			if (errorMsg.includes("already exists")) {
				helpText = t("overlays.ssh_command_controller.duplicate_hint", {
					part1: `${theme.fg("accent", "/ssh remove")}`,
				});
			}

			this.ctx.showError(
				t("overlays.ssh_command_controller.add_failed", { part1: `${errorMsg}`, part2: `${helpText}` }),
			);
		}
	}

	/**
	 * Handle /ssh list - show all configured SSH hosts
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();

			// Load from both user and project configs
			const userPath = getSSHConfigPath("user", cwd);
			const projectPath = getSSHConfigPath("project", cwd);

			const [userConfig, projectConfig] = await Promise.all([
				readSSHConfigFile(userPath),
				readSSHConfigFile(projectPath),
			]);

			const userHosts = Object.keys(userConfig.hosts ?? {});
			const projectHosts = Object.keys(projectConfig.hosts ?? {});

			// Load discovered hosts via capability system
			const configHostNames = new Set([...userHosts, ...projectHosts]);
			let discoveredHosts: SSHHost[] = [];
			try {
				const result = await loadCapability<SSHHost>(sshCapability.id, { cwd });
				discoveredHosts = result.items.filter(h => !configHostNames.has(h.name));
			} catch {
				// Ignore discovery errors
			}

			if (userHosts.length === 0 && projectHosts.length === 0 && discoveredHosts.length === 0) {
				this.#showReport(
					t("overlays.ssh_command_controller.hosts"),
					[
						theme.fg("muted", t("overlays.ssh_command_controller.none")),
						"",
						t("overlays.ssh_command_controller.add_hint", { part1: `${theme.fg("accent", "/ssh add")}` }),
					].join("\n"),
				);
				return;
			}

			const lines: string[] = [];

			// Show user-level hosts
			if (userHosts.length > 0) {
				lines.push(
					theme.fg("accent", t("overlays.ssh_command_controller.user_level")) +
						theme.fg("muted", ` (${shortenPath(userPath)}):`),
				);
				for (const name of userHosts) {
					const config = userConfig.hosts![name];
					const details = this.#formatHostDetails(config);
					lines.push(`  ${theme.fg("accent", name)} ${details}`);
				}
				lines.push("");
			}

			// Show project-level hosts
			if (projectHosts.length > 0) {
				lines.push(
					theme.fg("accent", t("overlays.ssh_command_controller.project_level")) +
						theme.fg("muted", ` (${shortenPath(projectPath)}):`),
				);
				for (const name of projectHosts) {
					const config = projectConfig.hosts![name];
					const details = this.#formatHostDetails(config);
					lines.push(`  ${theme.fg("accent", name)} ${details}`);
				}
				lines.push("");
			}

			// Show discovered hosts (ssh.json/.ssh.json in project root, ~/.ssh/config aliases, etc.)
			if (discoveredHosts.length > 0) {
				for (const { providerName, shortPath, items: hosts } of groupBySource(discoveredHosts, h => h._source)) {
					lines.push(
						theme.fg("accent", t("overlays.ssh_command_controller.discovered")) +
							theme.fg("muted", ` (${providerName}: ${shortPath}):`) +
							theme.fg("dim", t("overlays.ssh_command_controller.read_only")),
					);
					for (const host of hosts) {
						const details = this.#formatHostDetails({
							host: host.host,
							username: host.username,
							port: host.port,
						});
						lines.push(`  ${theme.fg("accent", host.name)} ${details}`);
					}
					lines.push("");
				}
			}

			this.#showReport(t("overlays.ssh_command_controller.configured"), lines.join("\n"));
		} catch (error) {
			this.ctx.showError(
				t("overlays.ssh_command_controller.list_failed", {
					part1: `${error instanceof Error ? error.message : String(error)}`,
				}),
			);
		}
	}

	/**
	 * Format host details (host, user, port) for display
	 */
	#formatHostDetails(config: { host?: string; username?: string; port?: number }): string {
		const parts: string[] = [];
		if (config.host) parts.push(config.host);
		if (config.username) parts.push(`user=${config.username}`);
		if (config.port && config.port !== 22) parts.push(`port=${config.port}`);
		return theme.fg("dim", parts.length > 0 ? `[${parts.join(", ")}]` : "");
	}

	/**
	 * Handle /ssh remove <name> - remove a host from config
	 */
	async #handleRemove(text: string): Promise<void> {
		const match = text.match(/^\/ssh\s+(?:remove|rm)\b\s*(.*)$/i);
		const rest = match?.[1]?.trim() ?? "";
		const parsed = parseRemoveArgs(rest);
		if (!parsed.ok) {
			this.ctx.showError(parsed.error);
			return;
		}
		const { name, scope } = parsed.value;
		if (!name) {
			this.ctx.showError(t("overlays.ssh_command_controller.remove_usage"));
			return;
		}

		try {
			const cwd = getProjectDir();
			const filePath = getSSHConfigPath(scope, cwd);
			const config = await readSSHConfigFile(filePath);
			if (!config.hosts?.[name]) {
				this.ctx.showError(t("overlays.ssh_command_controller.not_found", { part1: `${name}`, part2: `${scope}` }));
				return;
			}

			await removeSSHHost(filePath, name);
			resetCapabilities();

			this.#showMessage(
				[
					"",
					theme.fg(
						"success",
						t("overlays.ssh_command_controller.removed", { part1: `${name}`, part2: `${scope}` }),
					),
					"",
				].join("\n"),
			);
		} catch (error) {
			this.ctx.showError(
				t("overlays.ssh_command_controller.remove_failed", {
					part1: `${error instanceof Error ? error.message : String(error)}`,
				}),
			);
		}
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}

	/** A read-only listing shown outside the transcript (see `InteractiveModeContext.showCommandReport`). */
	#showReport(title: string, text: string): void {
		this.ctx.showCommandReport({ title, body: new Text(text.trim(), 0, 0) });
	}
}

import { getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { connectToServer, disconnectServer, listPrompts, listResources, listTools } from "../../mcp/client";
import {
	addMCPServer,
	readDisabledServers,
	readMCPConfigFile,
	removeMCPServer,
	setServerDisabled,
	updateMCPServer,
} from "../../mcp/config-writer";
import { compileMCPAllowlist } from "../../mcp/config";
import { cfgMcpEnableProjectConfig } from "../../mcp/settings";
import { MCPManager } from "../../mcp/manager";
import { cfgMcpIncludeServers } from "../../mcp/settings";
import {
	findMcpServerForAuth,
	MCPOAuthCancelledError,
	McpReauthRefusalError,
	reauthorizeMcpServer,
} from "../../mcp/oauth-reauth";
import type { MCPServerConfig, MCPServerConnection } from "../../mcp/types";
import { parseCommandArgs } from "../../utils/command-args";
import { openPath } from "../../utils/open";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseNamedScopeArgs, parseSubcommand, usage } from "./parse";

type AcpMcpScope = "user" | "project";

interface ParsedMcpAddArgs {
	name?: string;
	scope: AcpMcpScope;
	url?: string;
	transport: "http" | "sse";
	authToken?: string;
	commandTokens?: string[];
	error?: string;
}

type McpAddOptionParser = (parsed: ParsedMcpAddArgs, value: string | undefined) => string | undefined;

function mcpAddUsage() {
	return t("commands.mcp.addUsage");
}

const MCP_ADD_OPTION_PARSERS = new Map<string, McpAddOptionParser>([
	[
		"--scope",
		(parsed, value) => {
			if (!value || (value !== "project" && value !== "user")) return t("commands.mcp.invalidScope");
			parsed.scope = value;
			return undefined;
		},
	],
	[
		"--url",
		(parsed, value) => {
			if (!value) return t("commands.mcp.missingUrl");
			parsed.url = value;
			return undefined;
		},
	],
	[
		"--transport",
		(parsed, value) => {
			if (!value || (value !== "http" && value !== "sse")) return t("commands.mcp.invalidTransport");
			parsed.transport = value;
			return undefined;
		},
	],
	[
		"--token",
		(parsed, value) => {
			if (!value) return t("commands.mcp.missingToken");
			parsed.authToken = value;
			return undefined;
		},
	],
]);

async function getMcpConfiguredServers(
	cwd: string,
): Promise<Array<{ name: string; config: MCPServerConfig; scope: AcpMcpScope }>> {
	const userPath = getMCPConfigPath("user", cwd);
	const projectPath = getMCPConfigPath("project", cwd);
	const [userConfig, projectConfig] = await Promise.all([readMCPConfigFile(userPath), readMCPConfigFile(projectPath)]);
	const servers: Array<{ name: string; config: MCPServerConfig; scope: AcpMcpScope }> = [];
	const seen = new Set<string>();
	for (const [name, config] of Object.entries(projectConfig.mcpServers ?? {})) {
		if (config.enabled !== false) {
			servers.push({ name, config, scope: "project" });
			seen.add(name);
		}
	}
	for (const [name, config] of Object.entries(userConfig.mcpServers ?? {})) {
		if (!seen.has(name) && config.enabled !== false) servers.push({ name, config, scope: "user" });
	}
	return servers;
}

function validateParsedMcpAddArgs(parsed: ParsedMcpAddArgs): ParsedMcpAddArgs {
	const hasCommand = (parsed.commandTokens?.length ?? 0) > 0;
	const hasUrl = Boolean(parsed.url);
	if (!hasCommand && !hasUrl) {
		return {
			...parsed,
			error: t("commands.mcp.noninteractiveAdd"),
		};
	}
	if (!parsed.name) return { ...parsed, error: t("commands.mcp.nameRequired") };
	if (hasCommand && hasUrl) return { ...parsed, error: t("commands.mcp.conflictingTransport") };
	if (parsed.authToken && !hasUrl) return { ...parsed, error: t("commands.mcp.tokenNeedsUrl") };
	return parsed;
}

function parseMcpAddArgs(rest: string): ParsedMcpAddArgs {
	const tokens = parseCommandArgs(rest);
	const parsed: ParsedMcpAddArgs = { scope: "project", transport: "http" };
	if (tokens.length === 0) return parsed;

	let index = 0;
	if (!tokens[0]!.startsWith("-")) {
		parsed.name = tokens[0];
		index = 1;
	}

	while (index < tokens.length) {
		const arg = tokens[index]!;
		if (arg === "--") {
			parsed.commandTokens = tokens.slice(index + 1);
			break;
		}
		const parser = MCP_ADD_OPTION_PARSERS.get(arg);
		if (!parser) return { ...parsed, error: t("commands.mcp.unknownOption", { option: arg }) };
		const error = parser(parsed, tokens[index + 1]);
		if (error) return { ...parsed, error };
		index += 2;
	}

	return validateParsedMcpAddArgs(parsed);
}

async function withPreparedMcpConnection<T>(
	runtime: SlashCommandRuntime,
	name: string,
	config: MCPServerConfig,
	fn: (connection: MCPServerConnection) => Promise<T>,
): Promise<T> {
	if (!compileMCPAllowlist(cfgMcpIncludeServers.get(runtime.settings)).admits(name)) {
		throw new Error(t("commands.mcp.serverExcluded", { name }));
	}
	let connection: MCPServerConnection | undefined;
	try {
		const manager = new MCPManager(runtime.cwd);
		// Auth storage must be wired in before prepareConfig so OAuth-backed
		// servers can refresh credentials and inject Authorization headers.
		// Without this, `/mcp test|resources|prompts` silently fails for any
		// server saved by the TUI/reauth path.
		manager.setAuthStorage(runtime.session.modelRegistry.authStorage);
		const resolvedConfig = await manager.prepareConfig(config);
		connection = await connectToServer(name, resolvedConfig);
		return await fn(connection);
	} finally {
		if (connection) {
			// Await cleanup so the stdio subprocess / HTTP DELETE has actually
			// released the resource before this helper returns. Fire-and-forget
			// here races with subsequent connect attempts and turns close
			// failures into unhandled rejections.
			try {
				await disconnectServer(connection);
			} catch (err) {
				logger.warn("MCP disconnect after temporary connection failed", { name, err });
			}
		}
	}
}

async function collectConnectedMcpLines(
	runtime: SlashCommandRuntime,
	collect: (serverName: string, connection: MCPServerConnection) => Promise<string[]>,
): Promise<string[] | undefined> {
	const servers = await getMcpConfiguredServers(runtime.cwd);
	if (servers.length === 0) return undefined;

	const lines: string[] = [];
	for (const { name, config } of servers) {
		try {
			const collected = await withPreparedMcpConnection(runtime, name, config, connection =>
				collect(name, connection),
			);
			lines.push(...collected);
		} catch {
			// unreachable server: skip silently
		}
	}
	return lines;
}

async function handleResourcesCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const lines = await collectConnectedMcpLines(runtime, async (name, connection) => {
		const resources = await listResources(connection);
		return resources.map(resource => `${name}/${resource.uri}`);
	});
	if (!lines) {
		await runtime.output(t("commands.mcp.noServers"));
		return commandConsumed();
	}
	await runtime.output(lines.length > 0 ? lines.join("\n") : t("commands.mcp.noResources"));
	return commandConsumed();
}

async function handlePromptsCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const lines = await collectConnectedMcpLines(runtime, async (name, connection) => {
		const prompts = await listPrompts(connection);
		return prompts.map(prompt => `${name}/${prompt.name}${prompt.description ? ` — ${prompt.description}` : ""}`);
	});
	if (!lines) {
		await runtime.output(t("commands.mcp.noServers"));
		return commandConsumed();
	}
	await runtime.output(lines.length > 0 ? lines.join("\n") : t("commands.mcp.noPrompts"));
	return commandConsumed();
}

async function handleTestCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const name = rest.split(/\s+/)[0]?.trim() ?? "";
	if (!name) return usage(t("commands.mcp.testUsage"), runtime);
	const servers = await getMcpConfiguredServers(runtime.cwd);
	const server = servers.find(item => item.name === name);
	if (!server) return usage(t("commands.mcp.serverNotFound", { name }), runtime);

	try {
		return await withPreparedMcpConnection(runtime, name, server.config, async connection => {
			const tools = await listTools(connection);
			const lines = [t("commands.mcp.connected", { name, count: tools.length })];
			for (const tool of tools) lines.push(`  - ${tool.name}`);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		});
	} catch (err) {
		return usage(t("commands.mcp.connectFailed", { name, error: errorMessage(err) }), runtime);
	}
}

function buildMcpServerConfig(parsed: ParsedMcpAddArgs): MCPServerConfig | undefined {
	if (parsed.commandTokens && parsed.commandTokens.length > 0) {
		const [command, ...args] = parsed.commandTokens;
		return { type: "stdio", command: command!, args: args.length > 0 ? args : undefined } as MCPServerConfig;
	}
	if (!parsed.url) return undefined;
	const normalizedUrl = /^https?:\/\//i.test(parsed.url) ? parsed.url : `https://${parsed.url}`;
	return {
		type: parsed.transport === "sse" ? "sse" : "http",
		url: normalizedUrl,
		headers: parsed.authToken ? { Authorization: `Bearer ${parsed.authToken}` } : undefined,
	} as MCPServerConfig;
}

async function handleAddCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!rest) return usage(mcpAddUsage(), runtime);
	const parsed = parseMcpAddArgs(rest);
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage(mcpAddUsage(), runtime);
	const config = buildMcpServerConfig(parsed);
	if (!config) return usage(mcpAddUsage(), runtime);
	try {
		const filePath = getMCPConfigPath(parsed.scope, runtime.cwd);
		await addMCPServer(filePath, parsed.name, config);
		await runtime.output(t("commands.mcp.added", { name: parsed.name, scope: parsed.scope }));
		return commandConsumed();
	} catch (err) {
		return usage(t("commands.mcp.addFailed", { error: errorMessage(err) }), runtime);
	}
}

async function handleListCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	try {
		const userPath = getMCPConfigPath("user", runtime.cwd);
		const projectPath = getMCPConfigPath("project", runtime.cwd);
		const [userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);
		const disabledSet = new Set(await readDisabledServers(userPath));
		const entries: Array<{ name: string; config: MCPServerConfig; scope: string }> = [];
		for (const [name, config] of Object.entries(userConfig.mcpServers ?? {})) {
			entries.push({ name, config, scope: "user" });
		}
		for (const [name, config] of Object.entries(projectConfig.mcpServers ?? {})) {
			if (!entries.some(entry => entry.name === name)) entries.push({ name, config, scope: "project" });
		}
		if (entries.length === 0) {
			await runtime.output(t("commands.mcp.noServers"));
			return commandConsumed();
		}
		await runtime.output(
			entries
				.map(({ name, config, scope }) => {
					const type = config.type ?? "stdio";
					const enabled =
						config.enabled !== false && !disabledSet.has(name)
							? t("commands.mcp.enabled")
							: t("commands.mcp.disabled");
					let location: string | undefined;
					if (config.type === "http" || config.type === "sse") {
						// Strip query string and userinfo from URLs to avoid leaking
						// API keys carried in the query (e.g. `?apiKey=…`). Skip the
						// redaction entirely for missing/empty URLs so the row falls
						// back to `(unknown)` rather than the misleading `(hidden)`
						// label reserved for unparseable values.
						const raw = (config as { url?: string }).url;
						if (raw) {
							try {
								const parsed = new URL(raw);
								const pathOnly = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
								location = `${parsed.origin}${pathOnly}`;
							} catch {
								location = t("commands.mcp.hidden");
							}
						}
					} else {
						location = (config as { command: string }).command;
					}
					return `${name} | ${type} | ${enabled} | ${location ?? t("commands.mcp.unknown")} [${scope}]`;
				})
				.join("\n"),
		);
		return commandConsumed();
	} catch (err) {
		return usage(t("commands.mcp.listFailed", { error: errorMessage(err) }), runtime);
	}
}

async function handleEnableDisableCommand(
	verb: "enable" | "disable",
	rest: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const name = rest.split(/\s+/)[0] ?? "";
	if (!name) return usage(t("commands.mcp.enableDisableUsage", { subcommand: verb }), runtime);
	const enabled = verb === "enable";
	try {
		const userPath = getMCPConfigPath("user", runtime.cwd);
		const projectPath = getMCPConfigPath("project", runtime.cwd);
		const [userConfig, projectConfig] = await Promise.all([
			readMCPConfigFile(userPath),
			readMCPConfigFile(projectPath),
		]);
		if (projectConfig.mcpServers?.[name] !== undefined) {
			await updateMCPServer(projectPath, name, { ...projectConfig.mcpServers[name], enabled } as MCPServerConfig);
			await runtime.output(
				t("commands.mcp.projectEnabled", {
					name,
					state: enabled ? t("commands.mcp.enabled") : t("commands.mcp.disabled"),
				}),
			);
			return commandConsumed();
		}
		if (userConfig.mcpServers?.[name] !== undefined) {
			await updateMCPServer(userPath, name, { ...userConfig.mcpServers[name], enabled } as MCPServerConfig);
			await runtime.output(
				t("commands.mcp.userEnabled", {
					name,
					state: enabled ? t("commands.mcp.enabled") : t("commands.mcp.disabled"),
				}),
			);
			return commandConsumed();
		}
		const disabledList = await readDisabledServers(userPath);
		if (!enabled || disabledList.includes(name)) {
			await setServerDisabled(userPath, name, !enabled);
			await runtime.output(
				t("commands.mcp.serverEnabled", {
					name,
					state: enabled ? t("commands.mcp.enabled") : t("commands.mcp.disabled"),
				}),
			);
			return commandConsumed();
		}
		return usage(t("commands.mcp.noServerInConfig", { name }), runtime);
	} catch (err) {
		return usage(t("commands.mcp.updateFailed", { subcommand: verb, error: errorMessage(err) }), runtime);
	}
}

async function handleRemoveCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseNamedScopeArgs(rest, t("commands.mcp.invalidScope"));
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage(t("commands.mcp.removeUsage"), runtime);
	try {
		const filePath = getMCPConfigPath(parsed.scope, runtime.cwd);
		await removeMCPServer(filePath, parsed.name);
		await runtime.output(t("commands.mcp.removed", { name: parsed.name, scope: parsed.scope }));
		return commandConsumed();
	} catch (err) {
		return usage(t("commands.mcp.removeFailed", { error: errorMessage(err) }), runtime);
	}
}

/**
 * `/mcp reauth <name>` for ACP/text/RPC mode: the shared engine in
 * `mcp/oauth-reauth.ts` (same browser flow, client-credential assembly, and
 * persistence policy as the TUI) presented as plain text.
 *
 * omp usually runs on the user's machine when driven over ACP (emacs via
 * agent-shell, Zed), so opening the browser works like the TUI. No clipboard
 * copy: OSC 52 escape sequences would corrupt the ACP JSON-RPC stream on
 * stdout, so the URL is emitted as text for the client to render. No
 * manual-code input either (ACP has no composer to claim), so the OAuth
 * redirect must reach this machine's local callback server: the printed URL
 * helps when the browser fails to open, not when omp runs on a remote host.
 */
async function handleReauthCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	// `reauth` takes no other flags, so the entire rest is the server name —
	// `validateServerName` permits spaces, and splitting on whitespace (or
	// un-quoting) would truncate "MaaS Slack" to "MaaS".
	const name = rest.trim();
	if (!name) return usage(t("commands.mcp.reauthUsage"), runtime);
	const found = await findMcpServerForAuth(name, runtime.cwd, runtime.mcpManager, {
		preferManager: true,
		// `mcp.enableProjectConfig: false` opts the project out of project-scoped
		// config; the lookup must not resurrect (or write bindings for) an
		// opted-out entry.
		enableProjectConfig: cfgMcpEnableProjectConfig.get(runtime.settings),
	});
	if (!found) return usage(t("commands.mcp.serverNotFound", { name }), runtime);

	const emit = (text: string): void => {
		void Promise.resolve(runtime.output(text)).catch(() => {});
	};
	const run = async (): Promise<SlashCommandResult> => {
		try {
			await reauthorizeMcpServer(name, found, {
				authStorage: runtime.session.modelRegistry.authStorage,
				signal: runtime.signal,
				cwd: runtime.cwd,
				onReauthorizing: () => emit(t("commands.mcp.reauthStarting", { name })),
				onAuth: info => {
					openPath(info.url);
					emit(
						[
							t("commands.mcp.oauthRequired"),
							t("commands.mcp.openBrowser"),
							info.url,
							...(info.instructions ? ["", info.instructions] : []),
						].join("\n"),
					);
				},
				onProgress: message => emit(message),
			});
			// Ask the host to pick the fresh credential up now when it keeps a
			// live manager for this server (the ACP session manager does); RPC
			// and print mode have none, so the guidance says what to do instead.
			const state = await runtime.reconnectMcpServer?.(name, found.config);
			const suffix =
				state === "connected"
					? t("commands.mcp.reconnected")
					: state === "connecting"
						? t("commands.mcp.reconnecting")
						: state === "disconnected"
							? t("commands.mcp.stillDisconnected")
							: t("commands.mcp.credentialsNextConnection");
			emit(t("commands.mcp.reauthorized", { name, scope: found.scope, detail: suffix }));
			return commandConsumed();
		} catch (error) {
			if (error instanceof McpReauthRefusalError) {
				return usage(error.message, runtime);
			}
			if (error instanceof MCPOAuthCancelledError) {
				emit(t("commands.mcp.reauthCancelled", { name }));
				return commandConsumed();
			}
			return usage(t("commands.mcp.reauthFailed", { name, error: errorMessage(error) }), runtime);
		}
	};

	// RPC's prompt API must return immediately and keep its serialized command
	// queue free for `abort`; a browser wait would otherwise park it for up to
	// five minutes (same dispatch as /compact and /handoff use).
	if (runtime.runCommandInBackground) {
		runtime.runCommandInBackground(() =>
			run().then(
				() => undefined,
				() => undefined,
			),
		);
		return commandConsumed();
	}
	return await run();
}

function mcpHelpText() {
	return [
		t("commands.mcp.help"),
		t("commands.mcp.helpList"),
		t("commands.mcp.helpEnable"),
		t("commands.mcp.helpDisable"),
		t("commands.mcp.helpRemove"),
		t("commands.mcp.helpReload"),
		t("commands.mcp.helpResources"),
		t("commands.mcp.helpPrompts"),
		t("commands.mcp.helpTest"),
		t("commands.mcp.helpReauth"),
		t("commands.mcp.helpAddUrl"),
		t("commands.mcp.helpAddStdio"),
		t("commands.mcp.helpHelp"),
	].join("\n");
}

const TUI_ONLY_MCP_VERBS = new Set(["unauth", "reconnect"]);

/** ACP/text-mode `/mcp` handler. Shared by both dispatchers via the spec. */
export async function handleMcpAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "help") {
		await runtime.output(mcpHelpText());
		return commandConsumed();
	}
	if (verb === "notifications") {
		return usage(t("commands.mcp.notificationsTuiOnly"), runtime);
	}
	if (TUI_ONLY_MCP_VERBS.has(verb)) {
		return usage(t("commands.mcp.authTuiOnly", { subcommand: verb }), runtime);
	}
	switch (verb) {
		case "resources":
			return await handleResourcesCommand(runtime);
		case "prompts":
			return await handlePromptsCommand(runtime);
		case "test":
			return await handleTestCommand(rest, runtime);
		case "reauth":
			return await handleReauthCommand(rest, runtime);
		case "add":
			return await handleAddCommand(rest, runtime);
		case "reload":
			await runtime.refreshCommands();
			await runtime.output(t("commands.mcp.reloadRequested"));
			return commandConsumed();
		case "list":
			return await handleListCommand(runtime);
		case "enable":
		case "disable":
			return await handleEnableDisableCommand(verb, rest, runtime);
		case "remove":
		case "rm":
			return await handleRemoveCommand(rest, runtime);
		default:
			return usage(t("commands.mcp.unknownSubcommand", { subcommand: verb }), runtime);
	}
}

import { getSSHConfigPath, sanitizeText } from "@oh-my-pi/pi-utils";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { reset as resetCapabilities } from "../../capability";
import {
	addSSHHost,
	listSSHHosts,
	readSSHConfigFile,
	removeSSHHost,
	type SSHHostConfig,
} from "../../ssh/config-writer";
import { parseCommandArgs } from "../../utils/command-args";
import { argumentValues, buildDirectoryArgumentCompletions, completeCurrentArgument } from "../builtin-completions";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, TuiSlashCommandRuntime } from "../types";
import { type ConfigScope, commandConsumed, errorMessage, parseNamedScopeArgs, parseSubcommand, usage } from "./parse";

interface ParsedSshAddArgs {
	name?: string;
	scope: "user" | "project";
	host?: string;
	username?: string;
	port?: number;
	keyPath?: string;
	error?: string;
}

type SshAddOptionParser = (parsed: ParsedSshAddArgs, value: string | undefined) => string | undefined;

function sshAddUsage() {
	return t("commands.ssh.addUsage");
}

const SSH_ADD_OPTION_PARSERS = new Map<string, SshAddOptionParser>([
	[
		"--host",
		(parsed, value) => {
			if (!value) return t("commands.ssh.missingHost");
			parsed.host = value;
			return undefined;
		},
	],
	[
		"--user",
		(parsed, value) => {
			if (!value) return t("commands.ssh.missingUser");
			parsed.username = value;
			return undefined;
		},
	],
	[
		"--port",
		(parsed, value) => {
			if (!value) return t("commands.ssh.missingPort");
			// Reject any non-integer token. `Number.parseInt` accepts trailing
			// garbage (parseInt("22oops") === 22) which silently coerces typos
			// to valid-looking ports.
			if (!/^\d+$/.test(value)) {
				return t("commands.ssh.invalidPort");
			}
			const port = Number.parseInt(value, 10);
			if (port < 1 || port > 65535) {
				return t("commands.ssh.invalidPort");
			}
			parsed.port = port;
			return undefined;
		},
	],
	[
		"--key",
		(parsed, value) => {
			if (!value) return t("commands.ssh.missingKey");
			parsed.keyPath = value;
			return undefined;
		},
	],
	[
		"--scope",
		(parsed, value) => {
			if (!value || (value !== "project" && value !== "user")) return t("commands.ssh.invalidScope");
			parsed.scope = value;
			return undefined;
		},
	],
]);

const sshScopeValues = argumentValues("project", "user");
// The interactive controller also accepts --desc (one value) and --compat (a toggle).
const sshAddFlags = argumentValues(...SSH_ADD_OPTION_PARSERS.keys(), "--desc", "--compat");
const sshRemoveFlags = argumentValues("--scope");

/** Quote an argument only when necessary for parseCommandArgs to keep it intact. */
function quoteSshArgument(value: string, preferred?: string, closed = true): string | undefined {
	if (!preferred && !/^["']|[ \t]/.test(value)) return value;
	const quote = [preferred, '"', "'"].find(delimiter => delimiter && !value.includes(delimiter));
	return quote ? `${quote}${value}${closed ? quote : ""}` : undefined;
}

export function completeSshAddArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	return completeCurrentArgument(prefix, runtime, async (query, currentRuntime, previous) => {
		if (!previous[0] || previous[0].startsWith("-")) return null; // A new host name is open input.

		let valueFor: string | undefined;
		let hasHost = false;
		for (const flag of previous.slice(1)) {
			if (valueFor) {
				hasHost ||= valueFor === "--host" && flag.length > 0;
				valueFor = undefined;
			} else if (flag !== "--compat") {
				if (flag !== "--desc" && !SSH_ADD_OPTION_PARSERS.has(flag)) return null;
				valueFor = flag;
			}
		}
		if (valueFor === "--scope") return sshScopeValues(query);
		if (valueFor === "--key") {
			const quote = /^["']/.test(query) ? query[0] : undefined;
			let pathPrefix = quote ? query.slice(1) : query;
			if (quote && pathPrefix.endsWith(quote)) pathPrefix = pathPrefix.slice(0, -1);
			const cwd = currentRuntime?.ctx.sessionManager.getCwd();
			const paths = await buildDirectoryArgumentCompletions({ cwd, includeFiles: true })(pathPrefix);
			const matches = paths?.flatMap(item => {
				const isDirectory = item.value.endsWith("/");
				const value = quoteSshArgument(item.value, quote, !isDirectory);
				return value === undefined ? [] : [{ ...item, value: isDirectory ? value : `${value} ` }];
			});
			return matches?.length ? matches : null;
		}
		if (valueFor) return null;
		const flags = sshAddFlags(query);
		return hasHost && !query && flags ? flags.map(item => ({ ...item, preserveInputOnSubmit: true })) : flags;
	});
}

export function completeSshRemoveArguments(prefix: string, runtime?: TuiSlashCommandRuntime) {
	return completeCurrentArgument(prefix, runtime, async (query, currentRuntime, previous) => {
		if (previous.length) {
			if (previous[0]?.startsWith("-")) return null;
			if (previous.length === 1) {
				const flags = sshRemoveFlags(query);
				return !query && flags ? flags.map(item => ({ ...item, preserveInputOnSubmit: true })) : flags;
			}
			if (previous.length === 2 && previous[1] === "--scope") return sshScopeValues(query);
			return null;
		}
		if (!currentRuntime) return null;
		const cwd = currentRuntime.ctx.sessionManager.getCwd();
		const lower = query.replace(/^["']/, "").toLowerCase();
		const scopes: readonly ConfigScope[] = ["project", "user"];
		const scoped = await Promise.all(
			scopes.map(async scope => {
				try {
					return (await listSSHHosts(getSSHConfigPath(scope, cwd)))
						.filter(name => !name.startsWith("-") && !/[\r\n]/.test(name) && name.toLowerCase().startsWith(lower))
						.sort()
						.flatMap(name => {
							const value = quoteSshArgument(name);
							if (value === undefined) return [];
							// Bare names remove from project scope, including names shared by both scopes.
							return [
								{
									value: scope === "project" ? `${value} ` : `${value} --scope user `,
									label: sanitizeText(name),
									description: scope,
								},
							];
						});
				} catch {
					return [];
				}
			}),
		);
		const matches = scoped.flat();
		return matches.length ? matches : null;
	});
}

function parseSshAddArgs(rest: string): ParsedSshAddArgs {
	const tokens = parseCommandArgs(rest);
	const parsed: ParsedSshAddArgs = { scope: "project" };
	let index = 0;
	if (tokens.length > 0 && !tokens[0]!.startsWith("-")) {
		parsed.name = tokens[0];
		index = 1;
	}
	while (index < tokens.length) {
		const arg = tokens[index]!;
		const parser = SSH_ADD_OPTION_PARSERS.get(arg);
		if (!parser) return { ...parsed, error: t("commands.ssh.unknownOption", { option: arg }) };
		const error = parser(parsed, tokens[index + 1]);
		if (error) return { ...parsed, error };
		index += 2;
	}
	return parsed;
}

const SSH_HELP_TEXT = [
	t("commands.ssh.helpHeading"),
	"  /ssh add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>] [--scope project|user]",
	t("commands.ssh.helpList"),
	t("commands.ssh.helpRemove"),
	t("commands.ssh.helpHelp"),
].join("\n");

async function handleListCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	try {
		const userPath = getSSHConfigPath("user", runtime.cwd);
		const projectPath = getSSHConfigPath("project", runtime.cwd);
		const [userConfig, projectConfig] = await Promise.all([
			readSSHConfigFile(userPath),
			readSSHConfigFile(projectPath),
		]);
		const entries: Array<{ name: string; host: string; user?: string; port?: number; scope: string }> = [];
		// Capability loader resolves project before user, so list project hosts
		// first and let the user-scope loop skip duplicates. Otherwise a host
		// shared between scopes shows up under "user" when the project entry
		// is the one actually in effect.
		for (const [name, config] of Object.entries(projectConfig.hosts ?? {})) {
			entries.push({ name, host: config.host, user: config.username, port: config.port, scope: "project" });
		}
		for (const [name, config] of Object.entries(userConfig.hosts ?? {})) {
			if (!entries.some(entry => entry.name === name)) {
				entries.push({ name, host: config.host, user: config.username, port: config.port, scope: "user" });
			}
		}
		if (entries.length === 0) {
			await runtime.output(t("commands.ssh.none"));
			return commandConsumed();
		}
		await runtime.output(
			entries
				.map(entry => `${entry.name} | ${entry.host} | ${entry.user ?? "-"} | ${entry.port ?? 22} [${entry.scope}]`)
				.join("\n"),
		);
		return commandConsumed();
	} catch (err) {
		return usage(t("commands.ssh.listFailed", { error: errorMessage(err) }), runtime);
	}
}

async function handleRemoveCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseNamedScopeArgs(rest, t("commands.ssh.invalidScope"));
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage(t("commands.ssh.removeUsage"), runtime);
	try {
		const filePath = getSSHConfigPath(parsed.scope, runtime.cwd);
		await removeSSHHost(filePath, parsed.name);
		resetCapabilities();
		await runtime.output(t("commands.ssh.removed", { host: parsed.name, scope: parsed.scope }));
		return commandConsumed();
	} catch (err) {
		return usage(t("commands.ssh.removeFailed", { error: errorMessage(err) }), runtime);
	}
}

async function handleAddCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!rest) return usage(sshAddUsage(), runtime);
	const parsed = parseSshAddArgs(rest);
	if (parsed.error) return usage(parsed.error, runtime);
	if (!parsed.name) return usage(t("commands.ssh.nameRequired"), runtime);
	if (!parsed.host) return usage(t("commands.ssh.hostRequired"), runtime);
	const hostConfig: SSHHostConfig = { host: parsed.host };
	if (parsed.username) hostConfig.username = parsed.username;
	if (parsed.port) hostConfig.port = parsed.port;
	if (parsed.keyPath) hostConfig.keyPath = parsed.keyPath;
	try {
		const filePath = getSSHConfigPath(parsed.scope, runtime.cwd);
		await addSSHHost(filePath, parsed.name, hostConfig);
		resetCapabilities();
		await runtime.output(t("commands.ssh.added", { host: parsed.name, scope: parsed.scope }));
		return commandConsumed();
	} catch (err) {
		return usage(t("commands.ssh.addFailed", { error: errorMessage(err) }), runtime);
	}
}

/** ACP/text-mode `/ssh` handler. Shared by both dispatchers via the spec. */
export async function handleSshAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "help") {
		await runtime.output(SSH_HELP_TEXT);
		return commandConsumed();
	}
	switch (verb) {
		case "list":
			return await handleListCommand(runtime);
		case "remove":
		case "rm":
			return await handleRemoveCommand(rest, runtime);
		case "add":
			return await handleAddCommand(rest, runtime);
		default:
			return usage(t("commands.ssh.unknownSubcommand", { subcommand: verb }), runtime);
	}
}

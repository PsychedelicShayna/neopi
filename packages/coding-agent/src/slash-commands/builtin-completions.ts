import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { readMCPConfigFile } from "../mcp/config-writer";
import { collectMcpServerNames } from "../modes/controllers/mcp-command-controller";
import { InternalUrlRouter } from "../internal-urls";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { sessionLocalProtocolOptions } from "../internal-urls/context";
import { encodeLocalPath } from "../modes/local-file-editor";
import { getConfiguredThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";
import { expandTilde } from "../tools/path-utils";
import { parseCommandArgs, splitCommandCompletionArgs } from "../utils/command-args";
import type { ArgumentValueProvider, SubcommandDef, TuiSlashCommandRuntime } from "./types";

/** Options shared by the declarative subcommand completers. */
interface SubcommandCompletionOptions {
	/** Mirrors `BuiltinSlashCommand.subcommandOptional`. */
	optional?: boolean;
	runtime?: TuiSlashCommandRuntime;
}

/** Ghost text completing `prefix` to `sub`: its remaining name characters, then its usage. */
function subcommandRemainderHint(sub: SubcommandDef, prefix: string): string | undefined {
	const hint = sub.name.slice(prefix.length) + (sub.usage ? ` ${sub.usage}` : "");
	return hint || undefined;
}

/** A provider for fixed parser vocabulary. */
export function argumentValues(...values: string[]): (prefix: string) => AutocompleteItem[] | null {
	return prefix => {
		const lower = prefix.toLowerCase();
		const matches = values
			.filter(value => value.toLowerCase().startsWith(lower))
			.map(value => ({ value: `${value} `, label: value }));
		return matches.length > 0 ? matches : null;
	};
}

/** Completes one positional argument while retaining the preceding text verbatim. */
export function completeArguments(
	prefix: string,
	runtime: TuiSlashCommandRuntime | undefined,
	...providers: readonly (ArgumentValueProvider | null)[]
): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null> {
	return completeCurrentArgument(
		prefix,
		runtime,
		(active, context, previous) => providers[previous.length]?.(active, context, previous) ?? null,
		providers.length - 1,
	);
}

/** Complete a raw tail using a provider that chooses from earlier tokens (e.g. flags). */
export function completeCurrentArgument(
	prefix: string,
	runtime: TuiSlashCommandRuntime | undefined,
	provider: ArgumentValueProvider,
	terminalIndex = -1,
): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null> {
	const { previous, start } = splitCommandCompletionArgs(prefix);
	const preceding = prefix.slice(0, start);
	const active = prefix.slice(start);
	const apply = (items: AutocompleteItem[] | null): AutocompleteItem[] | null =>
		items?.length
			? items.map(item => ({
					...item,
					value: preceding + item.value,
					submitsCommand: item.submitsCommand ?? previous.length === terminalIndex,
					// A keypress on an untouched empty slot must not run a guessed target.
					preserveInputOnSubmit: item.preserveInputOnSubmit ?? active.length === 0,
				}))
			: null;
	const items = provider(active, runtime, previous);
	return items instanceof Promise ? items.then(apply) : apply(items);
}

/** Complete a verb (including multiword verbs), then dispatch its active argument slot. */
export function buildArgumentCompletions(
	subcommands: readonly SubcommandDef[],
	options: SubcommandCompletionOptions = {},
): (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null> {
	// Match the longest complete verb before looking at the argument tail.
	// Nested verbs must win over a shorter verb sharing the same first word.
	const byLength = [...subcommands]
		.sort((a, b) => b.name.length - a.name.length)
		.map(sub => ({
			sub,
			verb: new RegExp(`^${sub.name.split(" ").map(RegExp.escape).join("[ \\t]+")}[ \\t]+`, "i"),
		}));
	return argumentPrefix => {
		const trimmed = argumentPrefix.trimStart();
		const leading = argumentPrefix.slice(0, argumentPrefix.length - trimmed.length);
		for (const { sub, verb } of byLength) {
			const match = verb.exec(trimmed);
			if (!match) continue;
			if (!sub.arguments && !sub.getArgumentCompletions) break;
			const tail = trimmed.slice(match[0].length);
			const insertedPrefix = leading + match[0];
			const insert = (items: AutocompleteItem[] | null): AutocompleteItem[] | null =>
				items?.length
					? items.map(item => ({
							...item,
							value: insertedPrefix + item.value,
							preserveInputOnSubmit: item.preserveInputOnSubmit ?? tail.length === 0,
						}))
					: null;
			const items = sub.getArgumentCompletions
				? sub.getArgumentCompletions(tail, options.runtime)
				: completeArguments(tail, options.runtime, ...(sub.arguments ?? []));
			return items instanceof Promise ? items.then(insert) : insert(items);
		}
		const lower = trimmed.toLowerCase().replace(/[ \t]+/g, " ");
		const matches = subcommands
			.filter(sub => sub.name.startsWith(lower))
			.map(sub => ({
				value: `${leading}${sub.name} `,
				label: sub.name,
				description: sub.description,
				hint: subcommandRemainderHint(sub, lower),
				submitsCommand: sub.usage === undefined,
				preserveInputOnSubmit: options.optional === true && lower.length === 0,
			}));
		return matches.length > 0 ? matches : null;
	};
}

/** Ghost text after the cursor: the untyped rest of a completion, then any usage. */
export function ghostHint(rest: string, usage?: string): string | undefined {
	const hint = usage ? `${rest} ${usage}` : rest;
	return hint.length > 0 ? hint : undefined;
}

/**
 * Build getArgumentCompletions for `/effort <level>`. The static `subcommands`
 * list documents the full vocabulary for ACP clients, but the dropdown must
 * offer only what the active model exposes: suggesting a tier the model lacks
 * (e.g. `xhigh` on a model capped at `high`) would make the handler answer the
 * accepted completion with `Unknown thinking level`. Returns null for a model
 * with no reasoning dial — there is nothing to pick. Reads the viewed session,
 * which `/effort` targets from a focused subagent.
 */
export function buildEffortArgumentCompletions(
	runtime: TuiSlashCommandRuntime,
): (argumentPrefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null;
		const lower = argumentPrefix.toLowerCase();
		const session = runtime.ctx.viewSession;
		const current = session.configuredThinkingLevel();
		const matches = session
			.getAvailableEffortSelectors()
			.filter(level => level.startsWith(lower))
			.map(level => {
				const { description } = getConfiguredThinkingLevelMetadata(level);
				return {
					value: `${level} `,
					label: level,
					description: level === current ? `${description} (current)` : description,
				};
			});
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build getInlineHint for `/effort <level>` from the same live list as the
 * dropdown, so the ghost text never completes a tier the active model lacks.
 */
export function buildEffortInlineHint(runtime: TuiSlashCommandRuntime): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const prefix = argumentText.trimStart().toLowerCase();
		if (prefix.length === 0 || prefix.includes(" ")) return null;
		const match = runtime.ctx.viewSession.getAvailableEffortSelectors().find(level => level.startsWith(prefix));
		return match && match !== prefix ? match.slice(prefix.length) : null;
	};
}

/** Subcommands that accept names found only in `userConfig.disabledServers`. */
const MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
};

/**
 * Subcommands that accept configured servers whose `enabled` flag is false.
 * `unauth` can clear persisted credentials without connecting; test,
 * reconnect, and reauth explicitly require an enabled server.
 */
const MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	unauth: true,
};

/** Names eligible for a specific MCP operation, without starting a server. */
export function mcpServerArgumentValues(
	subcommand: "enable" | "disable" | "test" | "remove" | "reconnect" | "reauth" | "unauth",
): ArgumentValueProvider {
	return async (prefix, runtime) => {
		if (!runtime) return null;
		const namePrefix = prefix.toLowerCase();
		if (subcommand === "remove") return await buildMcpRemoveCompletions(namePrefix);

		let serverNames: string[];
		try {
			serverNames = await collectMcpServerNames(
				runtime.ctx,
				undefined,
				MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS[subcommand] === true,
				MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS[subcommand] === true,
			);
		} catch (error) {
			logger.warn("MCP server-name autocomplete failed to read config", { error });
			return null;
		}
		const matches: AutocompleteItem[] = serverNames
			.filter(name => name.toLowerCase().startsWith(namePrefix))
			.map(name => ({ value: `${name} `, label: name, submitsCommand: true }));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build `/mcp remove <name>` completions. Unlike the other server-name
 * subcommands, `#handleRemove` only ever succeeds against a config-file
 * `mcpServers` entry in the target scope (project by default, user with an
 * explicit `--scope user`) — a purely runtime-discovered server has no
 * config entry to remove and always fails with `Server "<name>" not found
 * in <scope> config.`. Completions are therefore restricted to config-file
 * names, and a name that exists only in the user config is completed with
 * `--scope user` appended so the inserted command is directly executable.
 */
async function buildMcpRemoveCompletions(namePrefix: string): Promise<AutocompleteItem[] | null> {
	const cwd = getProjectDir();
	let projectNames: string[];
	let userNames: string[];
	try {
		const [projectConfig, userConfig] = await Promise.all([
			readMCPConfigFile(getMCPConfigPath("project", cwd)),
			readMCPConfigFile(getMCPConfigPath("user", cwd)),
		]);
		projectNames = Object.keys(projectConfig.mcpServers ?? {});
		userNames = Object.keys(userConfig.mcpServers ?? {});
	} catch (error) {
		logger.warn("MCP remove autocomplete failed to read config", { error });
		return null;
	}

	const projectNameSet = new Set(projectNames);
	const allNames = new Set([...projectNames, ...userNames]);
	const matches: AutocompleteItem[] = [...allNames]
		.filter(name => name.toLowerCase().startsWith(namePrefix))
		.map(name =>
			projectNameSet.has(name)
				? { value: `${name} `, label: name, submitsCommand: true }
				: { value: `${name} --scope user `, label: `${name} (user)`, submitsCommand: true },
		)
		.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
	return matches.length > 0 ? matches : null;
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor; an
 * optional subcommand retains an overview of its choices when the list is closed.
 */
export function buildSubcommandInlineHint(
	subcommands: readonly SubcommandDef[],
	options: SubcommandCompletionOptions = {},
): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const prefix = argumentText
			.trimStart()
			.toLowerCase()
			.replace(/[ \t]+/g, " ");
		if (prefix.length === 0) return options.optional ? `[${subcommands.map(sub => sub.name).join("|")}]` : null;
		const partial = subcommands.find(sub => sub.name.startsWith(prefix));
		if (partial) return subcommandRemainderHint(partial, prefix) ?? null;

		let matched: SubcommandDef | undefined;
		for (const sub of subcommands) {
			if ((!matched || sub.name.length > matched.name.length) && prefix.startsWith(`${sub.name} `)) matched = sub;
		}
		if (!matched?.usage) return null;
		const tail = prefix.slice(matched.name.length + 1);
		if (!tail) return matched.usage;
		const consumed = parseCommandArgs(tail).length;
		return matched.usage.split(" ").slice(consumed).join(" ") || null;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 */
export function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/** Trailing path separator: `/` everywhere, `\` too on Windows. */
const TRAILING_SEPARATOR = process.platform === "win32" ? /[\\/]$/ : /\/$/;
/** A path whose last segment is `.` or `..` (or a bare `~`) names a directory without listing it. */
const UNTERMINATED_DIRECTORY = process.platform === "win32" ? /(?:^|[\\/])\.{1,2}$|^~$/ : /(?:^|\/)\.{1,2}$|^~$/;

/**
 * Build getArgumentCompletions that suggests directories relative to the
 * current project directory. Used by /move so users can Tab-complete the
 * destination directory.
 *
 * Tab accepts the highlighted suggestion, so only a prefix that ends in a
 * separator lists the directory's children. A prefix naming a directory
 * without one (`..`, `~`, `foo/.`) completes the separator first; otherwise
 * Tab would jump straight into the first child.
 */
export function buildDirectoryArgumentCompletions(
	options: { cwd?: string; includeFiles?: boolean } = {},
): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trim();
		if (UNTERMINATED_DIRECTORY.test(prefix)) return [{ value: `${prefix}/`, label: `${prefix}/` }];

		const cwd = options.cwd ?? getProjectDir();
		const expandedPrefix = expandTilde(prefix);
		const isAbsolute = path.isAbsolute(expandedPrefix);
		const resolvedPrefix = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);

		let searchDir: string;
		let searchPrefix: string;
		if (prefix === "" || TRAILING_SEPARATOR.test(prefix)) {
			searchDir = resolvedPrefix;
			searchPrefix = "";
		} else {
			searchDir = path.dirname(resolvedPrefix);
			searchPrefix = path.basename(resolvedPrefix);
		}

		try {
			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			const matchPrefix = searchPrefix.toLowerCase();
			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(matchPrefix)) continue;
				if (entry.name === ".git" || /[\r\n]/.test(entry.name)) continue;

				const absoluteValue = path.join(searchDir, entry.name);
				const target = entry.isSymbolicLink() ? await fs.stat(absoluteValue).catch(() => undefined) : entry;
				const isDirectory = target?.isDirectory() ?? false;
				if (!isDirectory && (!options.includeFiles || !target?.isFile())) continue;
				const directoryValue = buildDirectoryCompletionDisplayValue(prefix, isAbsolute, absoluteValue, cwd);
				const value = isDirectory ? directoryValue : directoryValue.slice(0, -1);
				const label = replaceTabs(sanitizeText(entry.name));
				suggestions.push({ value, label: isDirectory ? `${label}/` : label });
			}
			suggestions.sort((a, b) => a.label.localeCompare(b.label));
			return suggestions.length > 0 ? suggestions : null;
		} catch {
			return null;
		}
	};
}

/** `/local` argument: session local:// file names (accepts a `local://` / `local:/` prefix). */
export function buildLocalFileArgumentCompletions(
	runtime: TuiSlashCommandRuntime,
): (argumentPrefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const query = argumentPrefix
			.trim()
			.replace(/^local:\/{0,2}/i, "")
			.toLowerCase();
		try {
			const files = await InternalUrlRouter.instance().complete("local", query, {
				localProtocolOptions: sessionLocalProtocolOptions(runtime.ctx.sessionManager),
			});
			const matches = (files ?? [])
				.filter(file => file.value.toLowerCase().startsWith(query))
				// `value` is the inserted argument: encode it as a `local://` URL so names
				// with whitespace or URL metacharacters survive `parseSlashCommand`
				// trimming unchanged. `label` is display-only; sanitize it so artifact
				// names with ANSI/C0 bytes cannot escape into the completion popup.
				.map(file => ({
					value: `local://${encodeLocalPath(file.value)}`,
					label: replaceTabs(sanitizeText(file.value)),
				}));
			return matches.length > 0 ? matches : null;
		} catch {
			return null;
		}
	};
}

function buildDirectoryCompletionDisplayValue(
	prefix: string,
	isAbsolute: boolean,
	absoluteValue: string,
	cwd: string,
): string {
	// Preserve the user's prefix style where possible, but always return a
	// value that /move can resolve (absolute or relative) without escaping.
	const normalized = path.normalize(absoluteValue);

	if (prefix === "~" || prefix.startsWith("~/")) {
		const homeRelative = path.relative(os.homedir(), normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	// Absolute stays absolute, including Windows drive paths (`C:/…`, `C:\…`).
	if (isAbsolute) {
		return `${normalized.replaceAll("\\", "/")}/`;
	}
	const relative = path.relative(cwd, normalized).replaceAll("\\", "/");
	// The project directory itself: `""` would render as `/`, the filesystem root.
	if (relative === "") return "./";
	return prefix.startsWith("./") ? `./${relative}/` : `${relative}/`;
}

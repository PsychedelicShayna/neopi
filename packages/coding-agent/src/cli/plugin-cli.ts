/**
 * Plugin CLI command handlers.
 *
 * Handles `npi plugin <command>` subcommands for plugin lifecycle management.
 */

import * as path from "node:path";
import { APP_NAME, getPluginsNodeModules, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { resolveOrDefaultProjectRegistryPath } from "../discovery/helpers";
import { PluginManager, parseSettingValue, validateSetting } from "../extensibility/plugins";
import { setInstalledPluginEnabled } from "../extensibility/plugins/toggle";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
	parsePluginId,
} from "../extensibility/plugins/marketplace/index.js";
import type { InstalledPlugin } from "../extensibility/plugins/types";
import { theme } from "@oh-my-pi/pi-tui/theme";

// =============================================================================
// Types
// =============================================================================

export type PluginAction =
	| "install"
	| "uninstall"
	| "list"
	| "link"
	| "doctor"
	| "features"
	| "config"
	| "enable"
	| "disable"
	| "marketplace"
	| "discover"
	| "upgrade";

export interface PluginCommandArgs {
	action: PluginAction;
	args: string[];
	flags: {
		json?: boolean;
		fix?: boolean;
		force?: boolean;
		dryRun?: boolean;
		local?: boolean;
		enable?: string;
		disable?: string;
		set?: string;
		scope?: "user" | "project";
	};
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: PluginAction[] = [
	"install",
	"uninstall",
	"list",
	"link",
	"doctor",
	"features",
	"config",
	"enable",
	"disable",
	"marketplace",
	"discover",
	"upgrade",
];

/**
 * Parse plugin subcommand arguments.
 * Returns undefined if not a plugin command.
 */
export function parsePluginArgs(args: string[]): PluginCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "plugin") {
		return undefined;
	}

	if (args.length < 2) {
		return { action: "list", args: [], flags: {} };
	}

	const action = args[1];
	if (!VALID_ACTIONS.includes(action as PluginAction)) {
		console.error(chalk.red(t("cli.commands.plugin.unknownCommand", { command: action })));
		console.error(t("cli.commands.config.validCommands", { commands: VALID_ACTIONS.join(", ") }));
		process.exit(1);
	}

	const result: PluginCommandArgs = {
		action: action as PluginAction,
		args: [],
		flags: {},
	};

	// Parse remaining arguments
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			result.flags.json = true;
		} else if (arg === "--fix") {
			result.flags.fix = true;
		} else if (arg === "--force") {
			result.flags.force = true;
		} else if (arg === "--dry-run") {
			result.flags.dryRun = true;
		} else if (arg === "-l" || arg === "--local") {
			result.flags.local = true;
		} else if (arg === "--enable" && i + 1 < args.length) {
			result.flags.enable = args[++i];
		} else if (arg === "--disable" && i + 1 < args.length) {
			result.flags.disable = args[++i];
		} else if (arg === "--set" && i + 1 < args.length) {
			result.flags.set = args[++i];
		} else if (arg === "--scope" && i + 1 < args.length && !args[i + 1].startsWith("-")) {
			const s = args[++i];
			if (s === "user" || s === "project") {
				result.flags.scope = s;
			} else {
				console.error(chalk.red(t("cli.commands.plugin.invalidScope", { scope: s })));
				process.exit(1);
			}
		} else if (arg === "--scope") {
			// --scope with no value following
			console.error(chalk.red(t("cli.commands.plugin.missingScope")));
			process.exit(1);
		} else if (!arg.startsWith("-")) {
			result.args.push(arg);
		}
	}

	return result;
}

import { classifyInstallTarget, handleMarketplaceInstall } from "./classify-install-target";

export { classifyInstallTarget } from "./classify-install-target";

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Stop a mutating command that has no preview mode before it applies its change under `--dry-run`.
 */
function refuseDryRun(flags: { dryRun?: boolean }, command: string): void {
	if (!flags.dryRun) return;
	console.error(chalk.red(t("cli.commands.plugin.refuseDryRun", { bin: APP_NAME, command })));
	process.exit(1);
}

/**
 * Run a plugin command.
 */
export async function runPluginCommand(cmd: PluginCommandArgs): Promise<void> {
	const manager = new PluginManager();

	switch (cmd.action) {
		case "install":
			await handleInstall(manager, cmd.args, cmd.flags);
			break;
		case "uninstall":
			await handleUninstall(manager, cmd.args, cmd.flags);
			break;
		case "list":
			await handleList(manager, cmd.flags);
			break;
		case "link":
			await handleLink(manager, cmd.args, cmd.flags);
			break;
		case "doctor":
			await handleDoctor(manager, cmd.flags);
			break;
		case "features":
			await handleFeatures(manager, cmd.args, cmd.flags);
			break;
		case "config":
			await handleConfig(manager, cmd.args, cmd.flags);
			break;
		case "enable":
			await handleEnable(manager, cmd.args, cmd.flags);
			break;
		case "disable":
			await handleDisable(manager, cmd.args, cmd.flags);
			break;
		case "marketplace":
			await handleMarketplace(cmd.args, cmd.flags);
			break;
		case "discover":
			await handleDiscover(cmd.args, cmd.flags);
			break;
		case "upgrade":
			await handleUpgrade(manager, cmd.args, cmd.flags);
			break;
	}
}

// =============================================================================
// Marketplace Handlers
// =============================================================================

async function makeMarketplaceManager(): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(getProjectDir()),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
	});
}

async function handleMarketplace(args: string[], flags: PluginCommandArgs["flags"]): Promise<void> {
	const subcommand = args[0] ?? "list";
	const manager = await makeMarketplaceManager();

	switch (subcommand) {
		case "add": {
			const source = args[1];
			if (!source) {
				console.error(chalk.red(t("cli.commands.plugin.usageMarketplaceAdd", { bin: APP_NAME })));
				process.exit(1);
			}
			refuseDryRun(flags, "marketplace add");
			try {
				await manager.addMarketplace(source);
				console.log(
					chalk.green(`${theme.status.success} ${t("cli.commands.plugin.marketplaceAdded", { source })}`),
				);
			} catch (err) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t("cli.commands.plugin.marketplaceAddFailed", { error: String(err) })}`,
					),
				);
				process.exit(1);
			}
			break;
		}
		case "remove":
		case "rm": {
			const name = args[1];
			if (!name) {
				console.error(chalk.red(t("cli.commands.plugin.usageMarketplaceRemove", { bin: APP_NAME })));
				process.exit(1);
			}
			refuseDryRun(flags, "marketplace remove");
			try {
				await manager.removeMarketplace(name);
				console.log(
					chalk.green(`${theme.status.success} ${t("cli.commands.plugin.marketplaceRemoved", { name })}`),
				);
			} catch (err) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t("cli.commands.plugin.marketplaceRemoveFailed", { error: String(err) })}`,
					),
				);
				process.exit(1);
			}
			break;
		}
		case "update": {
			refuseDryRun(flags, "marketplace update");
			try {
				const name = args[1];
				if (name) {
					await manager.updateMarketplace(name);
					console.log(
						chalk.green(`${theme.status.success} ${t("cli.commands.plugin.marketplaceUpdated", { name })}`),
					);
				} else {
					const results = await manager.updateAllMarketplaces();
					console.log(
						chalk.green(
							`${theme.status.success} ${t("cli.commands.plugin.marketplacesUpdated", { count: results.length })}`,
						),
					);
				}
			} catch (err) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t("cli.commands.plugin.marketplaceUpdateFailed", { error: String(err) })}`,
					),
				);
				process.exit(1);
			}
			break;
		}
		default: {
			if (subcommand !== "list") {
				console.error(chalk.red(t("cli.commands.plugin.unknownMarketplaceSubcommand", { command: subcommand })));
				console.error(chalk.dim(t("cli.commands.plugin.marketplaceSubcommands")));
				process.exit(1);
			}
			try {
				const marketplaces = await manager.listMarketplaces();
				if (marketplaces.length === 0) {
					console.log(chalk.dim(t("cli.commands.plugin.noMarketplaces")));
					console.log(chalk.dim(t("cli.commands.plugin.addMarketplaceHint", { bin: APP_NAME })));
					return;
				}
				console.log(chalk.bold(t("cli.commands.plugin.configuredMarketplaces")));
				for (const mp of marketplaces) {
					console.log(`  ${chalk.cyan(mp.name)}  ${chalk.dim(mp.sourceUri)}`);
				}
			} catch (err) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t("cli.commands.plugin.marketplaceListFailed", { error: String(err) })}`,
					),
				);
				process.exit(1);
			}
			break;
		}
	}
}

async function handleDiscover(args: string[], _flags: PluginCommandArgs["flags"]): Promise<void> {
	const marketplace = args[0];
	const manager = await makeMarketplaceManager();
	try {
		const plugins = await manager.listAvailablePlugins(marketplace);

		if (plugins.length === 0) {
			console.log(
				chalk.dim(
					marketplace
						? t("cli.commands.plugin.noPluginsInMarketplace", { marketplace })
						: t("cli.commands.plugin.noneAvailable"),
				),
			);
			return;
		}

		console.log(
			chalk.bold(
				marketplace
					? t("cli.commands.plugin.availableInMarketplace", { marketplace })
					: t("cli.commands.plugin.availablePlugins"),
			),
		);
		for (const plugin of plugins) {
			console.log(`  ${chalk.cyan(plugin.name)}${plugin.version ? `@${plugin.version}` : ""}`);
			if (plugin.description) {
				console.log(chalk.dim(`    ${plugin.description}`));
			}
		}
	} catch (err) {
		console.error(
			chalk.red(`${theme.status.error} ${t("cli.commands.plugin.discoverFailed", { error: String(err) })}`),
		);
		process.exit(1);
	}
}

async function handleUpgrade(
	pluginManager: PluginManager,
	args: string[],
	flags: PluginCommandArgs["flags"],
): Promise<void> {
	const manager = await makeMarketplaceManager();
	try {
		if (args.length === 0) {
			if (flags.scope) {
				console.error(
					chalk.yellow(t("cli.commands.plugin.ignoreBulkScope", { bin: APP_NAME, scope: flags.scope })),
				);
			}
			if (flags.dryRun) {
				await previewMarketplaceUpgradeAll(manager);
				return;
			}
			const results = await manager.upgradeAllPlugins();
			if (results.length === 0) {
				console.log(t("cli.commands.plugin.upToDate"));
			} else {
				for (const r of results) {
					console.log(chalk.green(`  ${r.pluginId} (${r.scope}): ${r.from} -> ${r.to}`));
				}
			}
			return;
		}

		for (let pluginId of args) {
			// Marketplace IDs are `name@marketplace`; anything else is either a bare
			// marketplace plugin name or an npm/git-installed plugin (e.g. `ida-mcp`
			// from `github:HexRaysSA/ida-mcp#latest`, or a scoped `@scope/pkg`).
			if (!parsePluginId(pluginId)) {
				const bareName = pluginId;
				const candidates = (await manager.listInstalledPlugins())
					.map(p => p.id)
					.filter(id => id.slice(0, id.lastIndexOf("@")) === bareName);
				const uniqueCandidates = [...new Set(candidates)];
				if (uniqueCandidates.length > 1) {
					console.error(
						chalk.red(
							t("cli.commands.plugin.ambiguousMarketplace", {
								name: bareName,
								count: uniqueCandidates.length,
								candidates: uniqueCandidates.join(", "),
							}),
						),
					);
					process.exit(1);
				}
				if (uniqueCandidates.length === 1) {
					pluginId = uniqueCandidates[0];
				} else {
					await upgradePackagePlugin(pluginManager, bareName, flags);
					continue;
				}
			}
			if (flags.dryRun) {
				await previewMarketplaceReinstall(manager, pluginId, flags.scope);
			} else if (flags.scope) {
				const result = await manager.upgradePlugin(pluginId, flags.scope);
				console.log(
					chalk.green(
						t("cli.commands.plugin.upgradedScoped", {
							plugin: pluginId,
							scope: flags.scope,
							version: result.version,
						}),
					),
				);
			} else {
				const entries = await manager.upgradePluginAcrossScopes(pluginId);
				for (const entry of entries) {
					console.log(
						chalk.green(
							t("cli.commands.plugin.upgradedScoped", {
								plugin: pluginId,
								scope: entry.scope,
								version: entry.version,
							}),
						),
					);
				}
			}
		}
	} catch (err) {
		console.error(chalk.red(t("cli.commands.plugin.upgradeFailed", { error: String(err) })));
		process.exit(1);
	}
}

/**
 * `upgrade --dry-run` with no id: the rows `upgradeAllPlugins` would reinstall, which are the
 * outdated rows of `checkForUpdates` without the ones whose install the current state refuses.
 */
async function previewMarketplaceUpgradeAll(manager: MarketplaceManager): Promise<void> {
	const updates = await manager.previewUpgradeAllPlugins();
	if (updates.length === 0) {
		console.log(chalk.dim(t("cli.commands.plugin.dryRunUpToDate")));
		return;
	}
	for (const u of updates) {
		console.log(
			chalk.dim(
				t("cli.commands.plugin.wouldUpgrade", { plugin: u.pluginId, scope: u.scope, from: u.from, to: u.to }),
			),
		);
	}
}

/**
 * `upgrade <id> --dry-run`: one row per scope the real command reinstalls. `upgradePlugin` and
 * `upgradePluginAcrossScopes` force a reinstall of the catalog's current version whatever it is,
 * so a same or older catalog version is reported as a reinstall or downgrade, not skipped.
 */
async function previewMarketplaceReinstall(
	manager: MarketplaceManager,
	pluginId: string,
	scope: "user" | "project" | undefined,
): Promise<void> {
	for (const row of await manager.previewUpgradePlugin(pluginId, scope)) {
		const label = `${pluginId} (${row.scope})`;
		const from = row.from ?? "?";
		let line: string;
		if (!row.to) {
			line = t("cli.commands.plugin.wouldReinstallUnknown", { label, from });
		} else {
			const versions = { label, from, to: row.to };
			switch (row.change) {
				case "upgrade":
					line = t("cli.commands.plugin.previewUpgrade", versions);
					break;
				case "reinstall":
					line = t("cli.commands.plugin.previewReinstall", versions);
					break;
				case "downgrade":
					line = t("cli.commands.plugin.previewDowngrade", versions);
					break;
				default:
					line = t("cli.commands.plugin.previewUnknownChange", { ...versions, change: String(row.change) });
					break;
			}
		}
		console.log(chalk.dim(`[dry-run] ${line}`));
	}
}

/** Upgrade an npm/git-installed plugin in place from its recorded source. */
async function upgradePackagePlugin(
	manager: PluginManager,
	name: string,
	flags: PluginCommandArgs["flags"],
): Promise<void> {
	if (flags.dryRun) {
		try {
			await manager.validateUpgrade(name);
		} catch (err) {
			console.error(
				chalk.red(
					t("cli.commands.plugin.upgradeNamedFailed", {
						name,
						error: err instanceof Error ? err.message : String(err),
					}),
				),
			);
			process.exit(1);
		}
		refuseDryRun(flags, `upgrade ${name}`);
	}
	if (flags.scope === "project") {
		console.error(chalk.yellow(t("cli.commands.plugin.ignoreUpgradeScope", { name })));
	}
	try {
		const { from, plugin, changed } = await manager.upgrade(name);
		if (flags.json) {
			console.log(
				JSON.stringify({ upgraded: plugin.name, from: from ?? null, to: plugin.version, changed }, null, 2),
			);
		} else if (!changed) {
			console.log(
				chalk.green(t("cli.commands.plugin.packageUpToDate", { name: plugin.name, version: plugin.version })),
			);
		} else if (from === plugin.version) {
			console.log(
				chalk.green(t("cli.commands.plugin.upgradedRevision", { name: plugin.name, version: plugin.version })),
			);
		} else {
			console.log(
				chalk.green(
					from
						? t("cli.commands.plugin.upgradedFrom", { name: plugin.name, from, version: plugin.version })
						: t("cli.commands.plugin.upgraded", { name: plugin.name, version: plugin.version }),
				),
			);
		}
	} catch (err) {
		console.error(
			chalk.red(
				t("cli.commands.plugin.upgradeNamedFailed", {
					name,
					error: err instanceof Error ? err.message : String(err),
				}),
			),
		);
		process.exit(1);
	}
}

function printLinkPreview(pluginPath: string, json?: boolean): void {
	if (json) {
		console.log(JSON.stringify({ dryRun: true, action: "link", path: pluginPath }, null, 2));
	} else {
		console.log(chalk.dim(t("cli.commands.plugin.wouldLink", { path: pluginPath })));
	}
}

async function handleInstall(
	manager: PluginManager,
	packages: string[],
	flags: { json?: boolean; force?: boolean; dryRun?: boolean; scope?: "user" | "project" },
): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(t("cli.commands.plugin.usageInstall", { bin: APP_NAME })));
		console.error(chalk.dim(t("cli.commands.plugin.examples")));
		console.error(chalk.dim(`  ${APP_NAME} plugin install @oh-my-pi/exa`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install name@marketplace`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install github:user/repo`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install https://github.com/user/repo#v1.0`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install ./path/to/local/plugin`));
		process.exit(1);
	}

	// Build known marketplace set for classification
	const mktMgr = await makeMarketplaceManager();
	const knownMarketplaces = new Set((await mktMgr.listMarketplaces()).map(m => m.name));

	for (const spec of packages) {
		const target = classifyInstallTarget(spec, knownMarketplaces);

		if (target.type === "marketplace") {
			try {
				const handled = await handleMarketplaceInstall(
					mktMgr,
					target,
					{ dryRun: flags.dryRun ?? false, force: flags.force, scope: flags.scope },
					preview => {
						if (flags.json) {
							console.log(JSON.stringify(preview, null, 2));
						} else {
							console.log(chalk.dim(t("cli.commands.plugin.wouldInstall", { spec })));
						}
					},
				);
				if (handled) continue;
			} catch (err) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t("cli.commands.plugin.installFailed", { spec, error: String(err) })}`,
					),
				);
				process.exit(1);
			}
			try {
				const entry = await mktMgr.installPlugin(target.name, target.marketplace, {
					force: flags.force,
					scope: flags.scope,
				});
				console.log(
					chalk.green(
						`${theme.status.success} ${t("cli.commands.plugin.marketplaceInstalled", { name: target.name, marketplace: target.marketplace, version: entry.version })}`,
					),
				);
			} catch (err) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t("cli.commands.plugin.installFailed", { spec, error: String(err) })}`,
					),
				);
				process.exit(1);
			}
			continue;
		}

		if (target.type === "local") {
			// Local paths route to link(): symlink the directory into the plugins
			// node_modules tree so source edits show up without a reinstall. Matches
			// `npi plugin link <path>` so users can use either verb interchangeably.
			if (flags.scope) {
				console.error(chalk.yellow(t("cli.commands.plugin.ignoreInstallScope", { spec })));
			}
			if (flags.force) {
				console.error(chalk.yellow(t("cli.commands.plugin.ignoreLocalForce", { spec })));
			}
			if (flags.dryRun) {
				printLinkPreview(spec, flags.json);
				continue;
			}
			try {
				const result = await manager.link(target.path);
				if (flags.json) {
					console.log(JSON.stringify(result, null, 2));
				} else {
					console.log(
						chalk.green(
							`${theme.status.success} ${t("cli.commands.plugin.linked", { name: result.name, path: spec })}`,
						),
					);
					if (result.manifest.description) {
						console.log(chalk.dim(`  ${result.manifest.description}`));
					}
				}
			} catch (err) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t("cli.commands.plugin.installFailed", { spec, error: String(err) })}`,
					),
				);
				process.exit(1);
			}
			continue;
		}

		// --scope only applies to marketplace installs; warn when it would be silently no-op'd for npm.
		if (flags.scope) {
			console.error(chalk.yellow(t("cli.commands.plugin.ignoreInstallScope", { spec })));
		}

		// npm path
		try {
			const result = await manager.install(spec, { force: flags.force, dryRun: flags.dryRun });

			if (flags.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				if (flags.dryRun) {
					console.log(chalk.dim(t("cli.commands.plugin.wouldInstall", { spec })));
				} else {
					console.log(
						chalk.green(
							`${theme.status.success} ${t("cli.commands.plugin.installed", { name: result.name, version: result.version })}`,
						),
					);
					if (result.enabledFeatures && result.enabledFeatures.length > 0) {
						console.log(
							chalk.dim(
								t("cli.commands.plugin.enabledFeatures", { features: result.enabledFeatures.join(", ") }),
							),
						);
					}
					if (result.manifest.description) {
						console.log(chalk.dim(`  ${result.manifest.description}`));
					}
				}
			}
		} catch (err) {
			console.error(
				chalk.red(`${theme.status.error} ${t("cli.commands.plugin.installFailed", { spec, error: String(err) })}`),
			);
			process.exit(1);
		}
	}
}

async function handleUninstall(
	manager: PluginManager,
	packages: string[],
	flags: { json?: boolean; dryRun?: boolean; scope?: "user" | "project" },
): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(t("cli.commands.plugin.usageUninstall", { bin: APP_NAME })));
		process.exit(1);
	}

	// For uninstall, check the installed plugins registry directly.
	// This works even if the marketplace entry was later removed from marketplaces.json.
	const mktMgr = await makeMarketplaceManager();
	const installedIds = (await mktMgr.listInstalledPlugins()).map(p => p.id);
	const installedPlugins = new Set(installedIds);

	// Installed marketplace IDs are `name@marketplace`, so a bare name never matches one
	// exactly. Resolve it when exactly one marketplace supplies that name: without this the
	// bare form falls through to the npm path, where `bun uninstall` exits 0 for a package
	// that was never a dependency and the command reports a removal that did not happen.
	const marketplaceIdsFor = (name: string): string[] =>
		installedIds.filter(id => id.slice(0, id.lastIndexOf("@")) === name);

	for (const rawName of packages) {
		let name = rawName;
		if (!installedPlugins.has(name)) {
			const candidates = marketplaceIdsFor(name);
			if (candidates.length === 1) {
				name = candidates[0] as string;
			} else if (candidates.length > 1) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t("cli.commands.plugin.ambiguousMarketplace", { name: rawName, count: candidates.length, candidates: candidates.join(", ") })}`,
					),
				);
				process.exit(1);
			}
		}

		const viaMarketplace = installedPlugins.has(name);

		if (flags.dryRun) {
			if (viaMarketplace) {
				try {
					await mktMgr.uninstallPlugin(name, flags.scope, { dryRun: true });
				} catch (err) {
					console.error(
						chalk.red(
							`${theme.status.error} ${t("cli.commands.plugin.uninstallFailed", { name, error: String(err) })}`,
						),
					);
					process.exit(1);
				}
			}

			// Marketplace dry-runs validate the requested scope before reporting.
			if (flags.json) {
				console.log(
					JSON.stringify({
						dryRun: true,
						action: "uninstall",
						plugin: name,
						source: viaMarketplace ? "marketplace" : "npm",
					}),
				);
			} else {
				console.log(chalk.dim(t("cli.commands.plugin.wouldUninstall", { name })));
			}
			continue;
		}

		if (viaMarketplace) {
			// Exact match against installed marketplace plugin IDs (name@marketplace)
			try {
				await mktMgr.uninstallPlugin(name, flags.scope);
				console.log(chalk.green(`${theme.status.success} ${t("cli.commands.plugin.uninstalled", { name })}`));
			} catch (err) {
				console.error(
					chalk.red(
						`${theme.status.error} ${t("cli.commands.plugin.uninstallFailed", { name, error: String(err) })}`,
					),
				);
				process.exit(1);
			}
			continue;
		}

		// npm path. `bun uninstall` exits 0 for a package that is not a dependency, so an
		// unknown name would otherwise print a success line having removed nothing.
		const npmPlugins = await manager.list();
		if (!npmPlugins.some(p => p.name === name)) {
			console.error(chalk.red(`${theme.status.error} ${t("cli.commands.plugin.notInstalled", { name: rawName })}`));
			process.exit(1);
		}

		try {
			await manager.uninstall(name);
			if (flags.json) {
				console.log(JSON.stringify({ uninstalled: name }));
			} else {
				console.log(chalk.green(`${theme.status.success} ${t("cli.commands.plugin.uninstalled", { name })}`));
			}
		} catch (err) {
			console.error(
				chalk.red(
					`${theme.status.error} ${t("cli.commands.plugin.uninstallFailed", { name, error: String(err) })}`,
				),
			);
			process.exit(1);
		}
	}
}

async function handleList(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const npmPlugins = await manager.list();
	const mktMgr = await makeMarketplaceManager();
	const mktPlugins = await mktMgr.listInstalledPlugins();

	if (flags.json) {
		console.log(JSON.stringify({ npm: npmPlugins, marketplace: mktPlugins }, null, 2));
		return;
	}

	if (npmPlugins.length === 0 && mktPlugins.length === 0) {
		console.log(chalk.dim(t("cli.commands.plugin.noneInstalled")));
		console.log(chalk.dim(t("cli.commands.plugin.installHint", { bin: APP_NAME })));
		return;
	}

	if (npmPlugins.length > 0) {
		console.log(chalk.bold(t("cli.commands.plugin.npmPlugins")));
		for (const plugin of npmPlugins) {
			const status = plugin.enabled ? chalk.green(theme.status.enabled) : chalk.dim(theme.status.disabled);
			const nameVersion = `${plugin.name}@${plugin.version}`;
			console.log(`${status} ${nameVersion}`);
			if (plugin.manifest.description) {
				console.log(chalk.dim(`  ${plugin.manifest.description}`));
			}
			if (plugin.enabledFeatures && plugin.enabledFeatures.length > 0) {
				console.log(
					chalk.dim(t("cli.commands.plugin.enabledFeatures", { features: plugin.enabledFeatures.join(", ") })),
				);
			}
			if (plugin.manifest.features) {
				const availableFeatures = Object.keys(plugin.manifest.features);
				if (availableFeatures.length > 0) {
					const enabledSet = new Set(plugin.enabledFeatures ?? []);
					const featureDisplay = availableFeatures
						.map(f => (enabledSet.has(f) ? chalk.green(f) : chalk.dim(f)))
						.join(", ");
					console.log(chalk.dim(t("cli.commands.plugin.availableFeatures", { features: featureDisplay })));
				}
			}
		}
	}

	if (mktPlugins.length > 0) {
		if (npmPlugins.length > 0) console.log();
		console.log(chalk.bold(t("cli.commands.plugin.marketplacePlugins")));
		for (const plugin of mktPlugins) {
			const entry = plugin.entries[0];
			const version = entry?.version ?? "unknown";
			const shadowLabel = plugin.shadowedBy ? chalk.dim(t("cli.commands.plugin.shadowed")) : "";
			const scopeLabel = chalk.dim(` (${plugin.scope})`);
			console.log(`  ${plugin.id} (${version})${scopeLabel}${shadowLabel}`);
		}
	}
}

async function handleLink(
	manager: PluginManager,
	paths: string[],
	flags: { json?: boolean; dryRun?: boolean },
): Promise<void> {
	if (paths.length === 0) {
		console.error(chalk.red(t("cli.commands.plugin.usageLink", { bin: APP_NAME })));
		process.exit(1);
	}

	if (flags.dryRun) {
		printLinkPreview(paths[0], flags.json);
		return;
	}

	try {
		const result = await manager.link(paths[0]);

		if (flags.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(
				chalk.green(
					`${theme.status.success} ${t("cli.commands.plugin.linked", { name: result.name, path: paths[0] })}`,
				),
			);
		}
	} catch (err) {
		console.error(chalk.red(`${theme.status.error} ${t("cli.commands.plugin.linkFailed", { error: String(err) })}`));
		process.exit(1);
	}
}

async function handleDoctor(
	manager: PluginManager,
	flags: { json?: boolean; fix?: boolean; dryRun?: boolean },
): Promise<void> {
	if (flags.fix) refuseDryRun(flags, "doctor --fix");
	const checks = await manager.doctor({ fix: flags.fix });

	if (flags.json) {
		console.log(JSON.stringify(checks, null, 2));
		return;
	}

	console.log(chalk.bold(t("cli.commands.plugin.healthCheck")));

	for (const check of checks) {
		const icon =
			check.status === "ok"
				? chalk.green(theme.status.success)
				: check.status === "warning"
					? chalk.yellow(theme.status.warning)
					: chalk.red(theme.status.error);
		console.log(`${icon} ${check.name}: ${check.message}`);
		if (check.fixed) {
			console.log(chalk.dim(`  ${theme.nav.cursor} ${t("cli.commands.plugin.fixed")}`));
		}
	}

	const errors = checks.filter(c => c.status === "error" && !c.fixed).length;
	const warnings = checks.filter(c => c.status === "warning" && !c.fixed).length;
	const ok = checks.filter(c => c.status === "ok").length;
	const fixed = checks.filter(c => c.fixed).length;

	console.log("");
	const fixedNote = fixed > 0 ? t("cli.commands.plugin.fixedSummary", { count: fixed }) : "";
	console.log(t("cli.commands.plugin.healthSummary", { ok, warnings, errors, fixedNote }));

	if (errors > 0) {
		if (!flags.fix) {
			console.log(chalk.dim(t("cli.commands.plugin.fixHint")));
		}
		process.exit(1);
	}
}

async function handleFeatures(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; enable?: string; disable?: string; set?: string; dryRun?: boolean },
): Promise<void> {
	if (args.length === 0) {
		console.error(chalk.red(t("cli.commands.plugin.usageFeatures", { bin: APP_NAME })));
		process.exit(1);
	}

	const pluginName = args[0];
	const plugin = await manager.getPlugin(pluginName, { path: path.join(getPluginsNodeModules(), pluginName) });

	if (!plugin) {
		console.error(chalk.red(t("cli.commands.plugin.notFound", { name: pluginName })));
		process.exit(1);
	}

	// Handle modifications
	if (flags.enable || flags.disable || flags.set) {
		let currentFeatures = new Set((await manager.getEnabledFeatures(pluginName)) ?? []);

		if (flags.set) {
			// --set replaces all features
			currentFeatures = new Set(
				flags.set
					.split(",")
					.map(f => f.trim())
					.filter(Boolean),
			);
		} else {
			if (flags.enable) {
				for (const f of flags.enable
					.split(",")
					.map(f => f.trim())
					.filter(Boolean)) {
					currentFeatures.add(f);
				}
			}
			if (flags.disable) {
				for (const f of flags.disable
					.split(",")
					.map(f => f.trim())
					.filter(Boolean)) {
					currentFeatures.delete(f);
				}
			}
		}

		refuseDryRun(flags, "features");
		await manager.setEnabledFeatures(pluginName, [...currentFeatures]);
		console.log(
			chalk.green(`${theme.status.success} ${t("cli.commands.plugin.updatedFeatures", { name: pluginName })}`),
		);
	}

	// Display current state
	const updatedFeatures = await manager.getEnabledFeatures(pluginName);

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					plugin: pluginName,
					enabledFeatures: updatedFeatures,
					availableFeatures: plugin.manifest.features ? Object.keys(plugin.manifest.features) : [],
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(t("cli.commands.plugin.features", { name: pluginName })));

	if (!plugin.manifest.features || Object.keys(plugin.manifest.features).length === 0) {
		console.log(chalk.dim(t("cli.commands.plugin.noFeatures")));
		return;
	}

	const enabledSet = new Set(updatedFeatures ?? []);
	for (const [name, feat] of Object.entries(plugin.manifest.features)) {
		const enabled = enabledSet.has(name);
		const icon = enabled ? chalk.green(theme.status.enabled) : chalk.dim(theme.status.disabled);
		const defaultLabel = feat.default ? chalk.dim(t("cli.commands.plugin.defaultFeature")) : "";
		console.log(`${icon} ${name}${defaultLabel}`);
		if (feat.description) {
			console.log(chalk.dim(`    ${feat.description}`));
		}
	}
}

async function handleConfig(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; local?: boolean; dryRun?: boolean },
): Promise<void> {
	if (args.length === 0) {
		console.error(chalk.red(t("cli.commands.plugin.usageConfig", { bin: APP_NAME })));
		process.exit(1);
	}

	const [subcommand, pluginName, key, ...valueArgs] = args;

	// Special case: validate doesn't need a plugin name
	if (subcommand === "validate") {
		await handleConfigValidate(manager, flags);
		return;
	}

	if (!pluginName) {
		console.error(chalk.red(t("cli.commands.plugin.nameRequired")));
		process.exit(1);
	}

	const plugin = await manager.getPlugin(pluginName);

	if (!plugin) {
		console.error(chalk.red(t("cli.commands.plugin.notFound", { name: pluginName })));
		process.exit(1);
	}

	switch (subcommand) {
		case "list": {
			const settings = await manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings || {};

			if (flags.json) {
				console.log(JSON.stringify({ settings, schema }, null, 2));
				return;
			}

			console.log(chalk.bold(t("cli.commands.plugin.settings", { name: pluginName })));

			if (Object.keys(schema).length === 0) {
				console.log(chalk.dim(t("cli.commands.plugin.noSettings")));
				return;
			}

			for (const [k, s] of Object.entries(schema)) {
				const value = settings[k] ?? s.default;
				const displayValue =
					s.secret && value ? "********" : String(value ?? chalk.dim(t("cli.commands.config.notSet")));
				console.log(`  ${k}: ${displayValue}`);
				if (s.description) {
					console.log(chalk.dim(`    ${s.description}`));
				}
				if (s.env) {
					console.log(chalk.dim(`    env: ${s.env}`));
				}
			}
			break;
		}

		case "get": {
			if (!key) {
				console.error(chalk.red(t("cli.commands.plugin.keyRequired")));
				process.exit(1);
			}

			const settings = await manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings?.[key];
			const value = settings[key] ?? schema?.default;

			if (flags.json) {
				console.log(JSON.stringify({ [key]: value }));
			} else {
				const displayValue = schema?.secret && value ? "********" : String(value ?? "(not set)");
				console.log(displayValue);
			}
			break;
		}

		case "set": {
			if (!key) {
				console.error(chalk.red(t("cli.commands.plugin.keyRequired")));
				process.exit(1);
			}

			const valueStr = valueArgs.join(" ");
			const schema = plugin.manifest.settings?.[key];

			// Parse value according to type
			let value: unknown = valueStr;
			if (schema) {
				value = parseSettingValue(valueStr, schema);

				// Validate
				const validation = validateSetting(value, schema);
				if (!validation.valid) {
					console.error(chalk.red(validation.error!));
					process.exit(1);
				}
			}

			refuseDryRun(flags, "config set");
			await manager.setPluginSetting(pluginName, key, value);
			console.log(chalk.green(`${theme.status.success} ${t("cli.commands.plugin.set", { key })}`));
			break;
		}

		case "delete": {
			if (!key) {
				console.error(chalk.red(t("cli.commands.plugin.keyRequired")));
				process.exit(1);
			}

			refuseDryRun(flags, "config delete");
			await manager.deletePluginSetting(pluginName, key);
			console.log(chalk.green(`${theme.status.success} ${t("cli.commands.plugin.deleted", { key })}`));
			break;
		}

		default:
			console.error(chalk.red(t("cli.commands.plugin.unknownConfigSubcommand", { subcommand })));
			console.error(chalk.dim(t("cli.commands.plugin.configSubcommands")));
			process.exit(1);
	}
}

/**
 * Enumerate every installed plugin to validate — npm/link plugins from
 * {@link PluginManager.list} plus marketplace runtime packages, which `list()`
 * intentionally omits. Marketplace summaries are resolved through their trusted
 * install path; deduped by resolved package name using the same active-scope
 * precedence as runtime loading.
 */
async function collectPluginsForValidation(manager: PluginManager): Promise<InstalledPlugin[]> {
	const byName = new Map<string, InstalledPlugin>();
	for (const plugin of await manager.list()) {
		byName.set(plugin.name, plugin);
	}
	const mktMgr = await makeMarketplaceManager();
	for (const summary of await mktMgr.listInstalledPlugins()) {
		const entry = summary.entries[0];
		if (!entry) continue;
		const fallbackName = parsePluginId(summary.id)?.name ?? summary.id;
		const resolved = await manager.getPlugin(fallbackName, { path: entry.installPath });
		if (!resolved) continue;
		byName.set(resolved.name, (await manager.getPlugin(resolved.name)) ?? resolved);
	}
	return [...byName.values()];
}

async function handleConfigValidate(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const plugins = await collectPluginsForValidation(manager);
	const results: Array<{ plugin: string; key: string; error: string }> = [];

	for (const plugin of plugins) {
		const settings = await manager.getPluginSettings(plugin.name);
		const schema = plugin.manifest.settings || {};

		for (const [key, s] of Object.entries(schema)) {
			const value = settings[key];
			if (value !== undefined) {
				const validation = validateSetting(value, s);
				if (!validation.valid) {
					results.push({ plugin: plugin.name, key, error: validation.error! });
				}
			}
		}
	}

	if (flags.json) {
		console.log(JSON.stringify({ valid: results.length === 0, errors: results }, null, 2));
		return;
	}

	if (results.length === 0) {
		console.log(chalk.green(`${theme.status.success} ${t("cli.commands.plugin.validSettings")}`));
	} else {
		for (const { plugin, key, error } of results) {
			console.log(chalk.red(`${theme.status.error} ${plugin}.${key}: ${error}`));
		}
		process.exit(1);
	}
}

async function handleEnable(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project"; dryRun?: boolean },
): Promise<void> {
	return handleSetEnabled(manager, plugins, flags, true);
}

async function handleDisable(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project"; dryRun?: boolean },
): Promise<void> {
	return handleSetEnabled(manager, plugins, flags, false);
}

async function handleSetEnabled(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project"; dryRun?: boolean },
	enabled: boolean,
): Promise<void> {
	const action = enabled ? "enable" : "disable";
	const jsonKey = enabled ? "enabled" : "disabled";

	if (plugins.length === 0) {
		console.error(chalk.red(t("cli.commands.plugin.usageToggle", { bin: APP_NAME, action })));
		process.exit(1);
	}

	refuseDryRun(flags, action);

	const mktMgr = await makeMarketplaceManager();
	const installedPlugins = new Set((await mktMgr.listInstalledPlugins()).map(p => p.id));

	for (const name of plugins) {
		try {
			await setInstalledPluginEnabled(name, {
				enabled,
				scope: flags.scope,
				marketplaceIds: installedPlugins,
				marketplace: mktMgr,
				npm: manager,
			});
			if (flags.json) {
				console.log(JSON.stringify({ [jsonKey]: name }));
			} else {
				const message = enabled
					? t("cli.commands.plugin.enabled", { name })
					: t("cli.commands.plugin.disabled", { name });
				console.log(chalk.green(`${theme.status.success} ${message}`));
			}
		} catch (err) {
			const message = enabled
				? t("cli.commands.plugin.enableFailed", { name, error: String(err) })
				: t("cli.commands.plugin.disableFailed", { name, error: String(err) });
			console.error(chalk.red(`${theme.status.error} ${message}`));
			process.exit(1);
		}
	}
}

// =============================================================================
// Help
// =============================================================================

export function printPluginHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} plugin`)} - ${t("cli.commands.plugin.help.title")}

${chalk.bold(t("cli.config.help.commands"))}
  install <source>[features]     ${t("cli.commands.plugin.help.install")}
  uninstall <pkg>                ${t("cli.commands.plugin.help.uninstall")}
  list                           ${t("cli.commands.plugin.help.list")}
  link <path>                    ${t("cli.commands.plugin.help.link")}
  doctor                         ${t("cli.commands.plugin.help.doctor")}
  features <pkg>                 ${t("cli.commands.plugin.help.features")}
  config <cmd> <pkg> [key] [val] ${t("cli.commands.plugin.help.config")}
  enable <pkg>                   ${t("cli.commands.plugin.help.enable")}
  disable <pkg>                  ${t("cli.commands.plugin.help.disable")}
  marketplace <cmd>            ${t("cli.commands.plugin.help.marketplace")}
  discover [marketplace]        ${t("cli.commands.plugin.help.discover")}

${chalk.bold(t("cli.commands.plugin.help.featureSyntax"))}
  pkg                ${t("cli.commands.plugin.help.defaultFeatures")}
  pkg[feat1,feat2]   ${t("cli.commands.plugin.help.specificFeatures")}
  pkg[*]             ${t("cli.commands.plugin.help.allFeatures")}
  pkg[]              ${t("cli.commands.plugin.help.noFeatures")}

${chalk.bold(t("cli.commands.plugin.help.sources"))}
  pkg, pkg@1.2.3                  ${t("cli.commands.plugin.help.npmSource")}
  github:user/repo[#ref]          ${t("cli.commands.plugin.help.githubSource")}
  https://github.com/user/repo    ${t("cli.commands.plugin.help.gitUrl")}
  name@marketplace                ${t("cli.commands.plugin.help.marketplaceSource")}
  ./path, ../path, /abs, ~/path   ${t("cli.commands.plugin.help.localSource")}

${chalk.bold(t("cli.commands.plugin.help.configCommands"))}
  config list <pkg>              ${t("cli.commands.plugin.help.configList")}
  config get <pkg> <key>         ${t("cli.commands.plugin.help.configGet")}
  config set <pkg> <key> <val>   ${t("cli.config.help.set")}
  config delete <pkg> <key>      ${t("cli.commands.plugin.help.configDelete")}
  config validate                ${t("cli.commands.plugin.help.configValidate")}

${chalk.bold(t("cli.config.help.options"))}
  --json           ${t("cli.config.help.json")}
  --fix            ${t("cli.commands.plugin.help.fix")}
  --force          ${t("cli.commands.plugin.help.force")}
  --scope <scope>  ${t("cli.commands.plugin.help.scope")}
  --dry-run        ${t("cli.commands.plugin.help.dryRun")}
  -l, --local      ${t("cli.commands.plugin.help.local")}

${chalk.bold(t("cli.commands.plugin.examples"))}
  ${APP_NAME} plugin install @oh-my-pi/exa[search]
  ${APP_NAME} plugin list --json
  ${APP_NAME} plugin features my-plugin --enable search,web
  ${APP_NAME} plugin config set my-plugin apiKey sk-xxx
  ${APP_NAME} plugin doctor --fix
  ${APP_NAME} plugin install --scope project name@marketplace
  ${APP_NAME} plugin install github:user/repo#v1.0
`);
}

import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { reset as resetCapabilities } from "../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers.js";
import { PluginManager } from "../extensibility/plugins";
import { setInstalledPluginEnabled } from "../extensibility/plugins/toggle";
import { MCPCommandController } from "../modes/controllers/mcp-command-controller";
import type { InteractiveModeContext } from "../modes/types";
import { refreshAgentDiscovery } from "../task";
import { argumentValues, completeCurrentArgument } from "./builtin-completions";
import { clearSubmittedText } from "./helpers/draft";
import { createMarketplaceManager } from "./helpers/marketplace-manager";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";
import type { ArgumentValueProvider, SlashCommandSpec, SubcommandDef } from "./types";

/**
 * Reload the interactive session's plugin runtime: invalidate fs/plugin-root
 * caches, rediscover skills, file slash commands, and task agents, reset the
 * capability cache, and reconnect MCP servers (rebinding the session's MCP
 * tools). Shared by `/reload-plugins`'s TUI handler and the `handle`-adapter's
 * `reloadPlugins` hook so both honor the command's documented reload scope.
 */
export async function reloadTuiPluginState(ctx: InteractiveModeContext): Promise<void> {
	const projectPath = await resolveActiveProjectRegistryPath(ctx.sessionManager.getCwd());
	clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
	await refreshAgentDiscovery(ctx.sessionManager.getCwd(), ctx.session.effectiveExtensionRoots);
	await ctx.refreshSkillState();
	await ctx.refreshSlashCommandState();
	resetCapabilities();
	if (ctx.mcpManager) {
		await new MCPCommandController(ctx).reloadServers();
	}
}

const completeMarketplaceName: ArgumentValueProvider = async (prefix, runtime) => {
	if (!runtime) return null;
	const manager = await createMarketplaceManager(runtime.ctx.sessionManager.getCwd()).catch(() => null);
	if (!manager) return null;
	const lower = prefix.toLowerCase();
	return (await manager.listMarketplaces().catch(() => []))
		.filter(marketplace => marketplace.name.toLowerCase().startsWith(lower))
		.map(({ name, sourceUri }) => ({ value: `${name} `, label: name, description: sourceUri }));
};

type PluginCompletionMode = "install" | "uninstall" | "upgrade" | "toggle";
type PluginScope = "user" | "project";
const completePluginScope = argumentValues("user", "project");

function completePluginArguments(mode: PluginCompletionMode): NonNullable<SubcommandDef["getArgumentCompletions"]> {
	return (tail, runtime) =>
		completeCurrentArgument(tail, runtime, async (prefix, context, previous) => {
			let hasPlugin = false;
			let force = false;
			let scope: PluginScope | undefined;
			for (let index = 0; index < previous.length; index++) {
				const token = previous[index];
				if (token === "--scope") {
					if (index === previous.length - 1) return completePluginScope(prefix);
					const value = previous[++index];
					if (value !== "user" && value !== "project") return null;
					scope = value;
				} else if (token === "--force" && mode === "install") {
					force = true;
				} else if (token.startsWith("-") || hasPlugin) {
					return null;
				} else {
					hasPlugin = true;
				}
			}

			const items =
				argumentValues(
					...(scope === undefined ? ["--scope"] : []),
					...(mode === "install" && !force ? ["--force"] : []),
				)(prefix) ?? [];
			if (hasPlugin || prefix.startsWith("-") || !context) return items;

			const cwd = context.ctx.sessionManager.getCwd();
			const manager = await createMarketplaceManager(cwd).catch(() => null);
			if (!manager) return items;
			const lower = prefix.toLowerCase();
			const matches = new Map<string, AutocompleteItem>();
			const add = (id: string, description?: string) => {
				if (!id.toLowerCase().startsWith(lower)) return;
				const existing = matches.get(id);
				if (existing?.description && description) {
					existing.description = `${existing.description}; ${description}`;
				} else if (!existing || description) {
					matches.set(id, { value: `${id} `, label: id, description });
				}
			};
			switch (mode) {
				case "install": {
					// These catalogs are local copies; do not refresh or clone while completing.
					const catalogues = await Promise.all(
						(await manager.listMarketplaces().catch(() => [])).map(async ({ name }) => ({
							name,
							plugins: await manager.listAvailablePlugins(name).catch(() => []),
						})),
					);
					for (const { name, plugins } of catalogues) {
						for (const plugin of plugins) add(`${plugin.name}@${name}`, plugin.description);
					}
					break;
				}
				case "upgrade":
					for (const row of await manager.listCatalogVersions().catch(() => [])) {
						if (scope && scope !== row.scope) continue;
						const versions = row.to && row.to !== row.from ? `${row.from} → ${row.to}` : row.from;
						add(row.pluginId, `${row.scope}: ${versions}`);
					}
					break;
				case "uninstall":
				case "toggle": {
					const installed = await manager.listInstalledPlugins().catch(() => []);
					for (const plugin of installed) {
						if (scope && scope !== plugin.scope) continue;
						add(plugin.id, plugin.scope);
					}
					if (mode === "toggle" && scope !== "project") {
						for (const plugin of await new PluginManager(cwd).list().catch(() => [])) add(plugin.name, "npm");
					}
					break;
				}
			}
			return [...matches.values(), ...items];
		});
}

export const BUILTIN_MARKETPLACE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "marketplace",
		icon: "cart",
		get description() {
			return t("commands.marketplace.description");
		},
		get acpDescription() {
			return t("commands.marketplace.acpDescription");
		},
		acpInputHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				get description() {
					return t("commands.marketplace.addDescription");
				},
				usage: "<source>",
			},
			{
				name: "remove",
				get description() {
					return t("commands.marketplace.removeDescription");
				},
				usage: "<name>",
				arguments: [completeMarketplaceName],
			},
			{
				name: "rm",
				get description() {
					return t("commands.marketplace.removeAliasDescription");
				},
				usage: "<name>",
				arguments: [completeMarketplaceName],
			},
			{
				name: "update",
				get description() {
					return t("commands.marketplace.updateDescription");
				},
				usage: "[name]",
				arguments: [completeMarketplaceName],
			},
			{
				name: "list",
				get description() {
					return t("commands.marketplace.listDescription");
				},
			},
			{
				name: "discover",
				get description() {
					return t("commands.marketplace.discoverDescription");
				},
				usage: "[marketplace]",
				arguments: [completeMarketplaceName],
			},
			{
				name: "install",
				get description() {
					return t("commands.marketplace.installDescription");
				},
				usage: "[--force] [--scope user|project] [name@marketplace]",
				getArgumentCompletions: completePluginArguments("install"),
			},
			{
				name: "uninstall",
				get description() {
					return t("commands.marketplace.uninstallDescription");
				},
				usage: "[--scope user|project] [name@marketplace]",
				getArgumentCompletions: completePluginArguments("uninstall"),
			},
			{
				name: "installed",
				get description() {
					return t("commands.marketplace.installedDescription");
				},
			},
			{
				name: "upgrade",
				get description() {
					return t("commands.marketplace.upgradeDescription");
				},
				usage: "[--scope user|project] [name@marketplace]",
				getArgumentCompletions: completePluginArguments("upgrade"),
			},
			{
				name: "help",
				get description() {
					return t("commands.marketplace.helpDescription");
				},
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) {
				try {
					const manager = await createMarketplaceManager(runtime.cwd);
					const marketplaces = await manager.listMarketplaces();
					if (marketplaces.length === 0) {
						await runtime.output(t("commands.marketplace.noCatalogsGuide"));
					} else {
						const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
						await runtime.output(t("commands.marketplace.catalogsGuide", { catalogs: lines.join("\n") }));
					}
					return commandConsumed();
				} catch (err) {
					return usage(t("commands.marketplace.error", { error: errorMessage(err) }), runtime);
				}
			}
			if (verb === "help") {
				await runtime.output(
					[
						t("commands.marketplace.guide"),
						t("commands.marketplace.guideDefault"),
						t("commands.marketplace.guideAdd"),
						t("commands.marketplace.guideRemove"),
						t("commands.marketplace.guideUpdate"),
						t("commands.marketplace.guideList"),
						t("commands.marketplace.guideDiscover"),
						t("commands.marketplace.guideInstall"),
						t("commands.marketplace.guideUninstall"),
						t("commands.marketplace.guideInstalled"),
						t("commands.marketplace.guideUpgrade"),
						"",
						t("commands.marketplace.quickStart"),
						"  /marketplace add anthropics/claude-plugins-official",
					].join("\n"),
				);
				return commandConsumed();
			}
			if ((verb === "install" || verb === "uninstall") && !rest) {
				return usage(t("commands.marketplace.pickersTuiOnly"), runtime);
			}
			try {
				const manager = await createMarketplaceManager(runtime.cwd);
				switch (verb) {
					case "add": {
						if (!rest) return usage(t("commands.marketplace.addUsage"), runtime);
						const entry = await manager.addMarketplace(rest);
						await runtime.output(t("commands.marketplace.added", { name: entry.name }));
						return commandConsumed();
					}
					case "remove":
					case "rm": {
						if (!rest) return usage(t("commands.marketplace.removeUsage"), runtime);
						await manager.removeMarketplace(rest);
						await runtime.output(t("commands.marketplace.removed", { name: rest }));
						return commandConsumed();
					}
					case "update": {
						if (rest) {
							await manager.updateMarketplace(rest);
							await runtime.output(t("commands.marketplace.updated", { name: rest }));
						} else {
							const results = await manager.updateAllMarketplaces();
							await runtime.output(t("commands.marketplace.updatedCount", { count: results.length }));
						}
						return commandConsumed();
					}
					case "list": {
						const marketplaces = await manager.listMarketplaces();
						if (marketplaces.length === 0) {
							await runtime.output(t("commands.marketplace.noCatalogs"));
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							await runtime.output(t("commands.marketplace.catalogs", { catalogs: lines.join("\n") }));
						}
						return commandConsumed();
					}
					case "discover": {
						const plugins = await manager.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await manager.listMarketplaces();
							await runtime.output(
								marketplaces.length === 0
									? t("commands.marketplace.noCatalogsHint")
									: t("commands.marketplace.noAvailablePlugins"),
							);
							return commandConsumed();
						}
						const lines = [t("commands.marketplace.available")];
						for (const plugin of plugins) {
							lines.push(`  - ${plugin.name}${plugin.version ? `@${plugin.version}` : ""}`);
							if (plugin.description) lines.push(`      ${plugin.description}`);
						}
						await runtime.output(lines.join("\n"));
						return commandConsumed();
					}
					case "install": {
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) return usage(parsed.error, runtime);
						const atIndex = parsed.installSpec.lastIndexOf("@");
						const pluginName = parsed.installSpec.slice(0, atIndex);
						const marketplace = parsed.installSpec.slice(atIndex + 1);
						await manager.installPlugin(pluginName, marketplace, { force: parsed.force, scope: parsed.scope });
						await runtime.reloadPlugins();
						await runtime.output(
							t("commands.marketplace.installed", { plugin: pluginName, catalog: marketplace }),
						);
						return commandConsumed();
					}
					case "uninstall": {
						const parsed = parsePluginScopeArgs(rest, t("commands.marketplace.uninstallUsage"));
						if ("error" in parsed) return usage(parsed.error, runtime);
						await manager.uninstallPlugin(parsed.pluginId, parsed.scope);
						await runtime.reloadPlugins();
						await runtime.output(t("commands.marketplace.uninstalled", { plugin: parsed.pluginId }));
						return commandConsumed();
					}
					case "installed": {
						const installed = await manager.listInstalledPlugins();
						if (installed.length === 0) {
							await runtime.output(t("commands.marketplace.noInstalled"));
						} else {
							const lines = installed.map(p =>
								t("commands.marketplace.installedRow", {
									plugin: p.id,
									scope: p.scope,
									shadowed: p.shadowedBy ? t("commands.marketplace.shadowed") : "",
									count: p.entries.length,
								}),
							);
							await runtime.output(t("commands.marketplace.installedList", { plugins: lines.join("\n") }));
						}
						return commandConsumed();
					}
					case "upgrade": {
						if (rest) {
							const parsed = parsePluginScopeArgs(rest, t("commands.marketplace.upgradeUsage"));
							if ("error" in parsed) return usage(parsed.error, runtime);
							const result = await manager.upgradePlugin(parsed.pluginId, parsed.scope);
							await runtime.reloadPlugins();
							await runtime.output(
								t("commands.marketplace.upgraded", { plugin: parsed.pluginId, version: result.version }),
							);
							return commandConsumed();
						}
						const results = await manager.upgradeAllPlugins();
						if (results.length === 0) {
							await runtime.output(t("commands.marketplace.upToDate"));
						} else {
							await runtime.reloadPlugins();
							const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
							await runtime.output(
								t("commands.marketplace.upgradedList", { count: results.length, plugins: lines.join("\n") }),
							);
						}
						return commandConsumed();
					}
					default:
						return usage(t("commands.marketplace.unknownSubcommand", { subcommand: verb }), runtime);
				}
			} catch (err) {
				return usage(t("commands.marketplace.error", { error: errorMessage(err) }), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const args = command.args.trim().split(/\s+/);
			const sub = args[0] || "install";
			const rest = args.slice(1).join(" ").trim();

			// /marketplace (no args) or /marketplace install (no args) → interactive browser
			if ((sub === "install" && !rest) || (!args[0] && !command.args.trim())) {
				try {
					await runtime.ctx.showPluginSelector("install");
				} catch (err) {
					runtime.ctx.showStatus(t("commands.marketplace.error", { error: errorMessage(err) }));
				}
				return;
			}

			try {
				const mgr = await createMarketplaceManager(runtime.ctx.sessionManager.getCwd());
				switch (sub) {
					case "add": {
						if (!rest) {
							runtime.ctx.showStatus(t("commands.marketplace.addUsage"));
							return;
						}
						const entry = await mgr.addMarketplace(rest);
						runtime.ctx.showStatus(t("commands.marketplace.added", { name: entry.name }));
						break;
					}
					case "remove":
					case "rm": {
						if (!rest) {
							runtime.ctx.showStatus(t("commands.marketplace.removeUsage"));
							return;
						}
						await mgr.removeMarketplace(rest);
						runtime.ctx.showStatus(t("commands.marketplace.removed", { name: rest }));
						break;
					}
					case "update": {
						if (rest) {
							await mgr.updateMarketplace(rest);
							runtime.ctx.showStatus(t("commands.marketplace.updated", { name: rest }));
						} else {
							const results = await mgr.updateAllMarketplaces();
							runtime.ctx.showStatus(t("commands.marketplace.updatedCount", { count: results.length }));
						}
						break;
					}
					case "discover": {
						const plugins = await mgr.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await mgr.listMarketplaces();
							if (marketplaces.length === 0) {
								runtime.ctx.showStatus(t("commands.marketplace.noCatalogsHint"));
							} else {
								runtime.ctx.showStatus(t("commands.marketplace.noAvailablePlugins"));
							}
						} else {
							const lines = plugins.map(
								p =>
									`  ${p.name}${p.version ? `@${p.version}` : ""}${p.description ? ` - ${p.description}` : ""}`,
							);
							runtime.ctx.showStatus(t("commands.marketplace.availableList", { plugins: lines.join("\n") }));
						}
						break;
					}
					case "install": {
						// Parse: /marketplace install [--force] [--scope user|project] name@marketplace
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) {
							runtime.ctx.showStatus(parsed.error);
							return;
						}
						const atIdx = parsed.installSpec.lastIndexOf("@");
						const name = parsed.installSpec.slice(0, atIdx);
						const marketplace = parsed.installSpec.slice(atIdx + 1);
						await mgr.installPlugin(name, marketplace, { force: parsed.force, scope: parsed.scope });
						runtime.ctx.showStatus(t("commands.marketplace.installed", { plugin: name, catalog: marketplace }));
						break;
					}
					case "uninstall": {
						if (!rest) {
							// No args → open interactive uninstall selector
							await runtime.ctx.showPluginSelector("uninstall");
							return;
						}
						const uninstArgs = parsePluginScopeArgs(rest, t("commands.marketplace.uninstallUsage"));
						if ("error" in uninstArgs) {
							runtime.ctx.showStatus(uninstArgs.error);
							return;
						}
						await mgr.uninstallPlugin(uninstArgs.pluginId, uninstArgs.scope);
						runtime.ctx.showStatus(t("commands.marketplace.uninstalled", { plugin: uninstArgs.pluginId }));
						break;
					}
					case "installed": {
						const installed = await mgr.listInstalledPlugins();
						if (installed.length === 0) {
							runtime.ctx.showStatus(t("commands.marketplace.noInstalled"));
						} else {
							const lines = installed.map(p =>
								t("commands.marketplace.installedRow", {
									plugin: p.id,
									scope: p.scope,
									shadowed: p.shadowedBy ? t("commands.marketplace.shadowed") : "",
									count: p.entries.length,
								}),
							);
							runtime.ctx.showStatus(t("commands.marketplace.installedList", { plugins: lines.join("\n") }));
						}
						break;
					}
					case "upgrade": {
						if (rest) {
							const upArgs = parsePluginScopeArgs(rest, t("commands.marketplace.upgradeUsage"));
							if ("error" in upArgs) {
								runtime.ctx.showStatus(upArgs.error);
								return;
							}
							const result = await mgr.upgradePlugin(upArgs.pluginId, upArgs.scope);
							runtime.ctx.showStatus(
								t("commands.marketplace.upgraded", { plugin: upArgs.pluginId, version: result.version }),
							);
						} else {
							const results = await mgr.upgradeAllPlugins();
							if (results.length === 0) {
								runtime.ctx.showStatus(t("commands.marketplace.upToDate"));
							} else {
								const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
								runtime.ctx.showStatus(
									t("commands.marketplace.upgradedList", { count: results.length, plugins: lines.join("\n") }),
								);
							}
						}
						break;
					}
					case "help": {
						runtime.ctx.showStatus(
							[
								t("commands.marketplace.guide"),
								t("commands.marketplace.guideTuiDefault"),
								t("commands.marketplace.guideAdd"),
								t("commands.marketplace.guideRemove"),
								t("commands.marketplace.guideUpdate"),
								t("commands.marketplace.guideList"),
								t("commands.marketplace.guideDiscover"),
								t("commands.marketplace.guideInstall"),
								t("commands.marketplace.guideUninstall"),
								t("commands.marketplace.guideInstalled"),
								t("commands.marketplace.guideUpgrade"),
								"",
								t("commands.marketplace.quickStart"),
								"  /marketplace add anthropics/claude-plugins-official",
								t("commands.marketplace.quickStartBrowser"),
							].join("\n"),
						);
						break;
					}
					default: {
						const marketplaces = await mgr.listMarketplaces();
						if (marketplaces.length === 0) {
							runtime.ctx.showStatus(t("commands.marketplace.noCatalogsTuiGuide"));
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							runtime.ctx.showStatus(t("commands.marketplace.catalogsGuide", { catalogs: lines.join("\n") }));
						}
						break;
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				runtime.ctx.showStatus(t("commands.marketplace.error", { error: msg }));
			}
		},
	},
	{
		name: "plugins",
		aliases: ["plugin"],
		icon: "package",
		get description() {
			return t("commands.marketplace.pluginsDescription");
		},
		get acpDescription() {
			return t("commands.marketplace.pluginsAcpDescription");
		},
		acpInputHint: "[list|enable|disable]",
		subcommands: [
			{
				name: "list",
				get description() {
					return t("commands.marketplace.pluginsListDescription");
				},
			},
			{
				name: "enable",
				get description() {
					return t("commands.marketplace.pluginsEnableDescription");
				},
				usage: "[--scope user|project] <plugin>",
				getArgumentCompletions: completePluginArguments("toggle"),
			},
			{
				name: "disable",
				get description() {
					return t("commands.marketplace.pluginsDisableDescription");
				},
				usage: "[--scope user|project] <plugin>",
				getArgumentCompletions: completePluginArguments("toggle"),
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			try {
				if (verb === "enable" || verb === "disable") {
					const parsed = parsePluginScopeArgs(rest, t("commands.marketplace.pluginsUsage", { subcommand: verb }));
					if ("error" in parsed) return usage(parsed.error, runtime);
					const marketplace = await createMarketplaceManager(runtime.cwd);
					const marketplaceIds = new Set((await marketplace.listInstalledPlugins()).map(plugin => plugin.id));
					await setInstalledPluginEnabled(parsed.pluginId, {
						enabled: verb === "enable",
						scope: parsed.scope,
						marketplaceIds,
						marketplace,
						npm: new PluginManager(),
					});
					await runtime.reloadPlugins();
					await runtime.output(
						`${verb === "enable" ? t("commands.marketplace.pluginEnabled") : t("commands.marketplace.pluginDisabled")} ${parsed.pluginId}`,
					);
					return commandConsumed();
				}
				// Default: list
				const lines: string[] = [];
				const npmManager = new PluginManager();
				const npmPlugins = await npmManager.list();
				if (npmPlugins.length > 0) {
					lines.push(t("commands.marketplace.npmPlugins"));
					for (const plugin of npmPlugins) {
						const status = plugin.enabled === false ? t("commands.marketplace.disabledSuffix") : "";
						lines.push(`  ${plugin.name}@${plugin.version}${status}`);
					}
				}

				const marketplaceManager = await createMarketplaceManager(runtime.cwd);
				const marketplacePlugins = await marketplaceManager.listInstalledPlugins();
				if (marketplacePlugins.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push(t("commands.marketplace.catalogPlugins"));
					for (const plugin of marketplacePlugins) {
						const entry = plugin.entries[0];
						const status = entry?.enabled === false ? t("commands.marketplace.disabledSuffix") : "";
						const shadowed = plugin.shadowedBy ? t("commands.marketplace.shadowed") : "";
						lines.push(`  ${plugin.id} v${entry?.version ?? "?"}${status} [${plugin.scope}]${shadowed}`);
					}
				}

				await runtime.output(lines.length === 0 ? t("commands.marketplace.noPlugins") : lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(t("commands.marketplace.pluginError", { error: errorMessage(err) }), runtime);
			}
		},
	},
	{
		name: "reload-plugins",
		icon: "restart",
		get description() {
			return t("commands.marketplace.reloadDescription");
		},
		get acpDescription() {
			return t("commands.marketplace.reloadAcpDescription");
		},
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output(t("commands.marketplace.reloaded"));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			await reloadTuiPluginState(runtime.ctx);
			runtime.ctx.showStatus(t("commands.marketplace.reloaded"));
			clearSubmittedText(runtime);
		},
	},
];

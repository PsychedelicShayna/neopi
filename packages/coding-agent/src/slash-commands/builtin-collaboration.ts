import { t } from "@oh-my-pi/pi-utils/i18n";
import { clearSubmittedText } from "./helpers/draft";
import { type AutocompleteItem, Spacer } from "@oh-my-pi/pi-tui";
import { APP_NAME, formatAge, getAgentDir } from "@oh-my-pi/pi-utils";
import { getLocale } from "@oh-my-pi/pi-utils/i18n";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { discoverChains } from "../chains/config";
import { discoverMixtures } from "../moa/config";
import { checkMixture } from "../moa/registration";
import { formatMixtureReset, formatMixtureStatus } from "../moa/status";
import { CollabGuestLink } from "../collab/guest";
import type { CollabHost } from "../collab/host";
import { type CollabHostSnapshot, listCollabHosts } from "../collab/registry";
import { entryProvenance } from "../config/entry-provenance";
import { settings } from "../config/settings";
import { parseExportArgs } from "../export/html/args";
import { shareSession } from "../export/share";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "../modes/types";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { extractLastCodeBlock, extractLastCommand, extractLastLink } from "@oh-my-pi/pi-tui/overlays/copy-targets";
import { applyBrowserModeChange } from "../tools/browser";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { openPath } from "../utils/open";
import { copyToClipboard } from "../utils/clipboard";
import {
	argumentValues,
	buildDirectoryArgumentCompletions,
	completeArguments,
	completeCurrentArgument,
} from "./builtin-completions";
import { refreshStatusLine } from "./builtin-modes";
import { CollabQrCodeComponent, collabBrowserLink } from "@oh-my-pi/pi-tui/chrome/collab-qrcode";
import { launchMixtureWebEditor } from "./helpers/moa-web";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { formatDumpArchiveReport } from "../session/session-dump-format";
import type { SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";
import type { AgentSession } from "../session/agent-session";
import type { LiveAdvisor } from "../session/session-advisors";

import { cfgBrowserEnabled, cfgBrowserHeadless } from "../tools/browser/settings";
import { cfgShareRedactSecrets, cfgShareServerUrl, cfgShareStore } from "../commands/settings";
import { cfgChainingActive, cfgChainingAuto } from "../chains/settings";

function advisorEnabledMessage(session: AgentSession): string {
	const names = session
		.getAdvisorStatusOverview()
		.advisors.filter(advisor => advisor.status === "running")
		.map(advisor => sanitizeDisplayLine(advisor.name));
	return names.length > 0
		? t("commands.collaboration.advisorsEnabled", { names: names.join(", ") })
		: t("commands.collaboration.advisorsNoneRunning");
}

const ADVISOR_ARGS = "[on|off|status|restart [slug|name]|dump [raw]|configure]";
function advisorUsage() {
	return t("commands.collaboration.advisorUsage", { arguments: ADVISOR_ARGS });
}

function resolveAdvisorTarget(advisors: readonly LiveAdvisor[], target: string): LiveAdvisor | "ambiguous" | undefined {
	let match: LiveAdvisor | undefined;
	for (const advisor of advisors) {
		if (advisor.slug.toLowerCase() !== target && advisor.name.toLowerCase() !== target) continue;
		if (match) return "ambiguous";
		match = advisor;
	}
	return match;
}

function restartAdvisor(session: AgentSession, target: string): { message: string; restarted: boolean } {
	const advisors = session.liveAdvisors();
	if (advisors.length === 0) return { message: t("commands.collaboration.noAdvisorsToRestart"), restarted: false };
	if (!target && advisors.length > 1) {
		return { message: t("commands.collaboration.specifyAdvisor"), restarted: false };
	}
	const advisor = target ? resolveAdvisorTarget(advisors, target.toLowerCase()) : advisors[0];
	if (advisor === "ambiguous") {
		return {
			message: t("commands.collaboration.ambiguousAdvisor"),
			restarted: false,
		};
	}
	if (!advisor) return { message: t("commands.collaboration.advisorNotFound"), restarted: false };
	const name = sanitizeDisplayLine(advisor.name);
	return session.restartAdvisor(advisor.slug)
		? { message: t("commands.collaboration.advisorRestarted", { name }), restarted: true }
		: { message: t("commands.collaboration.advisorRestartFailed", { name }), restarted: false };
}

function advisorRestartCompletions(prefix: string, session: AgentSession | undefined): AutocompleteItem[] | null {
	if (!session) return null;
	const advisors = session.liveAdvisors();
	const query = prefix.trimStart().toLowerCase();
	const items: AutocompleteItem[] = [];
	for (const advisor of advisors) {
		const slug = advisor.slug.toLowerCase();
		const name = advisor.name.toLowerCase();
		if (!slug.startsWith(query) && !name.startsWith(query)) continue;
		// Prefer the slug unless it would collide with another advisor's display name.
		const target =
			slug && resolveAdvisorTarget(advisors, slug) === advisor
				? advisor.slug
				: name && resolveAdvisorTarget(advisors, name) === advisor
					? advisor.name
					: undefined;
		if (!target) continue;
		items.push({
			value: `${target} `,
			label: sanitizeDisplayLine(target),
			description: target !== advisor.name ? sanitizeDisplayLine(advisor.name) : undefined,
			submitsCommand: true,
			preserveInputOnSubmit: true,
		});
	}
	return items.length > 0 ? items : null;
}

/** Join hint printed by /collab: compact terminal link + clickable browser deep link. */
function collabLinkHint(host: CollabHost, heading: string, view = false): string {
	const bullet = theme.fg("accent", theme.format.bullet);
	const link = view ? host.viewLink : host.link;
	const webLink = view ? host.webViewLink : host.webLink;
	return [
		// Keep the URL on the first row: under transcript pressure the status
		// block is clipped to rendered[0], which used to drop the join link.
		`${collabBrowserLink(webLink, t("commands.collaboration.joinBrowser"))}  ${theme.fg("success", heading)}`,
		` ${bullet} ${theme.fg("muted", view ? t("commands.collaboration.watchTerminal") : t("commands.collaboration.joinTerminal"))} ${APP_NAME} join "${link}"`,
		` ${bullet} ${theme.fg("muted", t("commands.collaboration.joinAnyBrowser"))} ${collabBrowserLink(webLink)}`,
		theme.fg("dim", view ? t("commands.collaboration.viewAccess") : t("commands.collaboration.controlAccess")),
	].join("\n");
}

/** One-block summary of chaining mode, the active chain, and every discovered chain. */
async function formatChainingStatus(cwd: string): Promise<string> {
	const { chains, warnings } = await discoverChains(cwd, getAgentDir());
	const active = cfgChainingActive.get(settings);
	const lines = [
		t("commands.collaboration.chainingState", {
			state: cfgChainingAuto.get(settings)
				? t("commands.collaboration.chainingEveryPrompt")
				: t("commands.collaboration.chainingSinglePrompt"),
		}),
		t("commands.collaboration.activeChain", { name: active || t("commands.collaboration.noActiveChain") }),
	];
	if (chains.length === 0) {
		lines.push(t("commands.collaboration.noChains"));
	} else {
		lines.push(t("commands.collaboration.chains"));
		for (const chain of chains) {
			const marker = chain.name === active ? "*" : "-";
			const steps = chain.steps.map(step =>
				step.enabled === false ? t("commands.collaboration.chainDisabled", { name: step.name }) : step.name,
			);
			lines.push(`  ${marker} ${chain.name}: ${steps.join(" → ")}`);
		}
	}
	for (const warning of warnings) lines.push(t("commands.collaboration.warning", { warning }));
	return lines.join("\n");
}

/** Apply a /chain verb that does not need the TUI; returns the message, or undefined for an unknown verb. */
async function applyChainingVerb(verb: string, rest: string, cwd: string): Promise<string | undefined> {
	if (verb === "on") {
		const { chains } = await discoverChains(cwd, getAgentDir());
		if (chains.length === 0) return t("commands.collaboration.noChainsSetup");
		cfgChainingAuto.set(settings, true);
		const active = cfgChainingActive.get(settings);
		return chains.some(chain => chain.name === active)
			? t("commands.collaboration.chainingOn", { name: active })
			: t("commands.collaboration.chainingChoose");
	}
	if (verb === "off") {
		cfgChainingAuto.set(settings, false);
		return t("commands.collaboration.chainingOff");
	}
	if (verb === "use") {
		const name = rest.trim();
		if (!name) {
			cfgChainingActive.set(settings, "");
			return t("commands.collaboration.chainCleared");
		}
		const { chains } = await discoverChains(cwd, getAgentDir());
		if (!chains.some(chain => chain.name === name)) {
			return t("commands.collaboration.chainUnknown", {
				name,
				known: chains.map(chain => chain.name).join(", ") || "(none)",
			});
		}
		cfgChainingActive.set(settings, name);
		return t("commands.collaboration.activeChain", { name });
	}
	if (verb === "status") return formatChainingStatus(cwd);
	return undefined;
}

function chainUsage() {
	return t("commands.collaboration.chainUsage");
}

function mixtureUsage() {
	return t("commands.collaboration.moaUsage");
}

async function chainArgumentValues(tail: string, runtime?: TuiSlashCommandRuntime) {
	if (!runtime) return null;
	const { chains } = await discoverChains(runtime.ctx.sessionManager.getCwd(), getAgentDir());
	return (
		argumentValues(...chains.map(chain => chain.name))(tail)?.map(item => ({
			...item,
			preserveInputOnSubmit: !tail,
		})) ?? null
	);
}

async function mixtureArgumentValues(tail: string, runtime: TuiSlashCommandRuntime | undefined, registered: boolean) {
	if (!runtime) return null;
	const { session, sessionManager } = runtime.ctx;
	const { mixtures } = await discoverMixtures(sessionManager.getCwd(), session.getMixtureAgentDir() ?? getAgentDir());
	const values = mixtures
		.map(item => item.definition.name)
		.filter(
			name => !registered || (session.getRegisteredMixture(name) && session.modelRegistry.find("mixture", name)),
		);
	return (
		argumentValues(...values)(tail)?.map(item => ({
			...item,
			preserveInputOnSubmit: !registered && !tail,
		})) ?? null
	);
}

const exportThemeValues = argumentValues("--themes");

function exportArgumentCompletions(prefix: string, runtime?: TuiSlashCommandRuntime) {
	return completeCurrentArgument(prefix, runtime, async (active, _current, previous) => {
		const hasPath = previous.some(value => value !== "--themes");
		const flags = previous.includes("--themes") ? [] : (exportThemeValues(active) ?? []);
		// Export resolves paths against the process cwd and takes only one
		// whitespace-free output path. Suggest directories, not files to overwrite.
		const dirs =
			hasPath || active.startsWith("-") || active.startsWith("~")
				? null
				: await buildDirectoryArgumentCompletions({ cwd: process.cwd() })(active);
		const matches = [
			...flags.map(item => ({ ...item, preserveInputOnSubmit: !active })),
			...(dirs ?? []).filter(item => !/\s/.test(item.value)).map(item => ({ ...item, preserveInputOnSubmit: true })),
		];
		return matches.length ? matches : null;
	});
}

function optionalArgumentCompletions(...values: string[]) {
	const provider = argumentValues(...values);
	return (prefix: string, runtime?: TuiSlashCommandRuntime) =>
		completeArguments(
			prefix,
			runtime,
			active => provider(active)?.map(item => ({ ...item, preserveInputOnSubmit: !active })) ?? null,
		);
}

async function mixtureList(runtime: Pick<SlashCommandRuntime, "session" | "settings" | "cwd">): Promise<string> {
	const agentDir = runtime.session.getMixtureAgentDir() ?? getAgentDir();
	const found = await discoverMixtures(runtime.cwd, agentDir);
	const names = found.mixtures.map(item => item.definition.name);
	const active = runtime.session.model?.api === "mixture" ? runtime.session.model.id : undefined;
	const lines = [t("commands.collaboration.mixtures")];
	for (const item of found.mixtures) {
		const checked = checkMixture(
			item.definition,
			{
				cwd: runtime.cwd,
				agentDir,
				registry: runtime.session.modelRegistry,
				settings: runtime.settings,
			},
			item.preparedPresets,
			names,
		);
		const state = checked.errors[0]?.code ?? "ready";
		lines.push(
			`  ${active === item.definition.name ? "*" : "-"} ${sanitizeDisplayLine(item.definition.name)} (${state})`,
		);
	}
	if (found.mixtures.length === 0) lines.push(t("commands.collaboration.noMixtures"));
	for (const warning of found.warnings)
		lines.push(t("commands.collaboration.warning", { warning: sanitizeDisplayLine(warning) }));
	return lines.join("\n");
}

async function useMixture(runtime: Pick<SlashCommandRuntime, "session">, name: string): Promise<string> {
	if (!name) return mixtureUsage();
	if (!runtime.session.getRegisteredMixture(name))
		return t("commands.collaboration.mixtureNotRegistered", { name: sanitizeDisplayLine(name) });
	const model = runtime.session.modelRegistry.find("mixture", name);
	if (!model) return t("commands.collaboration.mixtureUnavailable", { name: sanitizeDisplayLine(name) });
	await runtime.session.setModel(model);
	return t("commands.collaboration.mixtureSelected", { name: sanitizeDisplayLine(name) });
}
function showCollabQrCode(ctx: InteractiveModeContext, webLink: string): void {
	try {
		ctx.present([new Spacer(1), new CollabQrCodeComponent(webLink)]);
	} catch (err) {
		ctx.showError(t("commands.collaboration.qrFailed", { error: errorMessage(err) }));
	}
}

function showCollabLink(ctx: InteractiveModeContext, host: CollabHost, heading: string, view = false): void {
	ctx.showStatus(collabLinkHint(host, heading, view), { dim: false });
	showCollabQrCode(ctx, view ? host.webViewLink : host.webLink);
}

export const BUILTIN_COLLABORATION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "advisor",
		icon: "advisor",
		get description() {
			return t("commands.collaboration.advisorDescription");
		},
		get acpDescription() {
			return t("commands.collaboration.advisorAcpDescription");
		},
		acpInputHint: ADVISOR_ARGS,
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.collaboration.advisorOnDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.collaboration.advisorOffDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.collaboration.advisorStatusDescription");
				},
			},
			{
				name: "restart",
				get description() {
					return t("commands.collaboration.advisorRestartDescription");
				},
				provenance: entryProvenance("commands", "advisor restart"),
				usage: "[slug|name]",
				getArgumentCompletions: (tail, _runtime, session) => advisorRestartCompletions(tail, session),
			},
			{
				name: "dump",
				get description() {
					return t("commands.collaboration.advisorCopyDescription");
				},
				usage: "[raw]",
				getArgumentCompletions: optionalArgumentCompletions("raw"),
			},
			{
				name: "configure",
				get description() {
					return t("commands.collaboration.advisorConfigureDescription");
				},
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const stats = runtime.ctx.session.getAdvisorStats();
			if (stats.active && stats.advisors.length > 1)
				return t("commands.collaboration.advisorOnCount", { count: stats.advisors.length });
			if (stats.active && stats.model)
				return t("commands.collaboration.advisorOnModel", { provider: stats.model.provider, id: stats.model.id });
			if (stats.configured) return t("commands.collaboration.advisorConfigured");
			return t("commands.collaboration.advisorOff");
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.session.toggleAdvisorEnabled();
				const configured = runtime.session.isAdvisorEnabled();
				if (active) {
					await runtime.output(advisorEnabledMessage(runtime.session));
				} else if (configured) {
					await runtime.output(t("commands.collaboration.advisorNoModel"));
				} else {
					await runtime.output(t("commands.collaboration.advisorDisabled"));
				}
				return commandConsumed();
			}
			if (verb === "on") {
				const active = runtime.session.setAdvisorEnabled(true);
				await runtime.output(
					active ? advisorEnabledMessage(runtime.session) : t("commands.collaboration.advisorNoModel"),
				);
				return commandConsumed();
			}
			if (verb === "off") {
				runtime.session.setAdvisorEnabled(false);
				await runtime.output(t("commands.collaboration.advisorDisabled"));
				return commandConsumed();
			}
			if (verb === "status") {
				await runtime.output(runtime.session.formatAdvisorStatus());
				return commandConsumed();
			}
			if (verb === "restart") {
				const result = restartAdvisor(runtime.session, rest);
				await runtime.output(result.message);
				return commandConsumed({ failed: !result.restarted });
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				const text = runtime.session.formatAdvisorHistoryAsText({ compact: !isRaw });
				await runtime.output(text ?? t("commands.collaboration.advisorInactive"));
				return commandConsumed();
			}
			if (verb === "configure") {
				await runtime.output(t("commands.collaboration.advisorConfigureTui"));
				return commandConsumed();
			}
			return usage(advisorUsage(), runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || verb === "toggle") {
				const active = runtime.ctx.session.toggleAdvisorEnabled();
				const configured = runtime.ctx.session.isAdvisorEnabled();
				if (active) {
					runtime.ctx.showStatus(advisorEnabledMessage(runtime.ctx.session));
				} else if (configured) {
					runtime.ctx.showStatus(t("commands.collaboration.advisorNoModel"));
				} else {
					runtime.ctx.showStatus(t("commands.collaboration.advisorDisabled"));
				}
				refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "on") {
				const active = runtime.ctx.session.setAdvisorEnabled(true);
				runtime.ctx.showStatus(
					active ? advisorEnabledMessage(runtime.ctx.session) : t("commands.collaboration.advisorNoModel"),
				);
				refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "off") {
				runtime.ctx.session.setAdvisorEnabled(false);
				runtime.ctx.showStatus(t("commands.collaboration.advisorDisabled"));
				refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "status") {
				await runtime.ctx.handleAdvisorStatusCommand();
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "restart") {
				const { message, restarted } = restartAdvisor(runtime.ctx.session, rest);
				runtime.ctx.showStatus(message);
				if (restarted) refreshStatusLine(runtime.ctx);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "dump") {
				const isRaw = rest.toLowerCase() === "raw";
				runtime.ctx.handleAdvisorDumpCommand(isRaw);
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "configure") {
				runtime.ctx.showAdvisorConfigure();
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(advisorUsage());
			clearSubmittedText(runtime);
		},
	},
	{
		name: "chain",
		icon: "advisor",
		get description() {
			return t("commands.collaboration.chainDescription");
		},
		get acpDescription() {
			return t("commands.collaboration.chainAcpDescription");
		},
		acpInputHint: "[on|off|status|use [name]|configure]",
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.collaboration.chainOnDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.collaboration.chainOffDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.collaboration.chainStatusDescription");
				},
			},
			{
				name: "use",
				get description() {
					return t("commands.collaboration.chainUseDescription");
				},
				usage: "[name]",
				getArgumentCompletions: chainArgumentValues,
			},
			{
				name: "configure",
				get description() {
					return t("commands.collaboration.chainConfigureDescription");
				},
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: () => {
			const active = cfgChainingActive.get(settings);
			const mode = cfgChainingAuto.get(settings) ? t("commands.modes.stateOn") : t("commands.modes.stateOff");
			return active
				? t("commands.collaboration.chainingActiveState", { state: mode, name: active })
				: t("commands.collaboration.chainingState", { state: mode });
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "configure") {
				await runtime.output(t("commands.collaboration.chainConfigureTui"));
				return commandConsumed();
			}
			const message = await applyChainingVerb(verb || "status", rest, runtime.session.sessionManager.getCwd());
			return message === undefined
				? usage(chainUsage(), runtime)
				: (await runtime.output(message), commandConsumed());
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			runtime.ctx.editor.setText("");
			if (verb === "configure") {
				runtime.ctx.showChainConfigure();
				return;
			}
			const message = await applyChainingVerb(verb || "status", rest, runtime.ctx.sessionManager.getCwd());
			runtime.ctx.showStatus(message ?? chainUsage());
			refreshStatusLine(runtime.ctx);
		},
	},
	{
		name: "moa",
		icon: "advisor",
		get description() {
			return t("commands.collaboration.moaDescription");
		},
		get acpDescription() {
			return t("commands.collaboration.moaAcpDescription");
		},
		acpInputHint: "[list|use <name>|configure [name]|web [project|user]|reset|status]",
		subcommands: [
			{
				name: "configure",
				get description() {
					return t("commands.collaboration.moaConfigureDescription");
				},
				usage: "[name]",
				getArgumentCompletions: (tail, runtime) => mixtureArgumentValues(tail, runtime, false),
			},
			{
				name: "web",
				get description() {
					return t("commands.collaboration.moaWebDescription");
				},
				provenance: entryProvenance("commands", "moa web"),
				usage: "[project|user]",
				arguments: [argumentValues("project", "user")],
			},
			{
				name: "list",
				get description() {
					return t("commands.collaboration.moaListDescription");
				},
			},
			{
				name: "use",
				get description() {
					return t("commands.collaboration.moaUseDescription");
				},
				usage: "<name>",
				getArgumentCompletions: (tail, runtime) => mixtureArgumentValues(tail, runtime, true),
			},
			{
				name: "reset",
				get description() {
					return t("commands.collaboration.moaResetDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.collaboration.moaStatusDescription");
				},
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "reset") {
				await runtime.output(formatMixtureReset(runtime.session.resetMixtureRuns()));
				return commandConsumed();
			}
			if (verb === "status") {
				await runtime.output(formatMixtureStatus(runtime.session.mixtureRuns(), runtime.settings));
				return commandConsumed();
			}
			if (verb === "configure" || verb === "web") {
				await runtime.output(t("commands.collaboration.moaTuiOnly", { subcommand: verb }));
				return commandConsumed();
			}
			const message =
				!verb || verb === "list"
					? await mixtureList(runtime)
					: verb === "use"
						? await useMixture(runtime, rest.trim())
						: undefined;
			return message === undefined
				? usage(mixtureUsage(), runtime)
				: (await runtime.output(message), commandConsumed());
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			runtime.ctx.editor.setText("");
			if (verb === "web") {
				const scope = rest.trim() || "project";
				if (scope !== "project" && scope !== "user") {
					runtime.ctx.showStatus(t("commands.collaboration.moaWebUsage"));
					return;
				}
				try {
					runtime.ctx.showStatus(await launchMixtureWebEditor(runtime.ctx, scope));
				} catch (error) {
					runtime.ctx.showError(t("commands.collaboration.mixtureEditorFailed", { error: errorMessage(error) }));
				}
				return;
			}
			if (verb === "reset") {
				runtime.ctx.showStatus(formatMixtureReset(runtime.ctx.session.resetMixtureRuns()));
				return;
			}
			if (verb === "status") {
				runtime.ctx.showStatus(formatMixtureStatus(runtime.ctx.session.mixtureRuns(), runtime.ctx.settings));
				return;
			}
			if (!verb || verb === "configure") {
				runtime.ctx.showMixtureConfigure(rest.trim() || undefined);
				return;
			}
			const shared = {
				session: runtime.ctx.session,
				settings: runtime.ctx.settings,
				cwd: runtime.ctx.sessionManager.getCwd(),
			};
			const message =
				verb === "list"
					? await mixtureList(shared)
					: verb === "use"
						? await useMixture(shared, rest.trim())
						: mixtureUsage();
			runtime.ctx.showStatus(message);
			refreshStatusLine(runtime.ctx);
		},
	},
	{
		name: "export",
		icon: "export",
		get description() {
			return t("commands.collaboration.exportDescription");
		},
		inlineHint: "[--themes] [path]",
		allowArgs: true,
		getTuiArgumentCompletions: exportArgumentCompletions,
		handle: async (command, runtime) => {
			try {
				const { outputPath, useUserThemes } = parseExportArgs(command.args);
				if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy") {
					return usage(t("commands.collaboration.copyDumpHint"), runtime);
				}
				const filePath = await runtime.session.exportToHtml(outputPath, useUserThemes);
				await runtime.output(t("commands.collaboration.exported", { path: filePath }));
				return commandConsumed();
			} catch (err) {
				return usage(t("commands.collaboration.exportFailed", { error: errorMessage(err) }), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleExportCommand(command.text);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "trace",
		icon: "stats",
		get description() {
			return t("commands.collaboration.traceDescription");
		},
		handle: async (_command, runtime) => {
			const sessionFile = runtime.session.sessionFile;
			if (!sessionFile) {
				await runtime.output(t("commands.collaboration.traceNoFile"));
				return commandConsumed();
			}
			try {
				// Lazy: the stats dashboard (server + sqlite) loads on demand only,
				// matching src/cli/stats-cli.ts, to keep CLI startup fast.
				const { formatStatsDashboardUrl, startServer } = await import("@oh-my-pi/omp-stats");
				const { hostname, port } = await startServer();
				const url = `${formatStatsDashboardUrl(hostname, port, getLocale())}#/traces?s=${encodeURIComponent(sessionFile)}`;
				await runtime.output(url);
				return commandConsumed();
			} catch (err) {
				return usage(t("commands.collaboration.traceFailed", { error: errorMessage(err) }), runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleTraceCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "dump",
		icon: "clipboard",
		get description() {
			return t("commands.collaboration.dumpDescription");
		},
		get acpDescription() {
			return t("commands.collaboration.dumpAcpDescription");
		},
		acpInputHint: "[all|anon]",
		subcommands: [
			{
				name: "all",
				get description() {
					return t("commands.collaboration.dumpAllDescription");
				},
			},
			{
				name: "anon",
				get description() {
					return t("commands.collaboration.dumpAnonDescription");
				},
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "all" || verb === "anon") {
				const archive =
					verb === "all"
						? await runtime.session.dumpSessionArchiveToTmpDir()
						: await runtime.session.dumpAnonymizedArchiveToTmpDir();
				if (!archive) {
					await runtime.output(t("commands.collaboration.noMessagesToDump"));
					return commandConsumed();
				}
				await runtime.output(formatDumpArchiveReport(archive).join("\n"));
				return commandConsumed();
			}
			if (verb) return usage(t("commands.collaboration.dumpUsage"), runtime);
			const text = runtime.session.formatSessionAsText();
			if (!text) {
				await runtime.output(t("commands.collaboration.noMessagesToDump"));
				return commandConsumed();
			}
			let sidecarPath: string | undefined;
			try {
				sidecarPath = await runtime.session.dumpLlmRequestToTmpDir();
			} catch {
				// Sidecar is best-effort; the transcript is still output below.
			}
			const lines = [text];
			if (sidecarPath)
				lines.push(
					"",
					t("commands.collaboration.llmRequestJson", { path: sidecarPath }),
					t("commands.collaboration.dumpSecrets"),
				);
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "all") await runtime.ctx.handleDumpAllCommand();
			else if (verb === "anon") await runtime.ctx.handleDumpAnonCommand();
			else if (verb) runtime.ctx.showStatus(t("commands.collaboration.dumpUsage"));
			else await runtime.ctx.handleDumpCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "share",
		icon: "share",
		get description() {
			return t("commands.collaboration.shareDescription");
		},
		handle: async (_command, runtime) => {
			try {
				const result = await shareSession(runtime.sessionManager, {
					serverUrl: cfgShareServerUrl.get(runtime.settings),
					store: cfgShareStore.get(runtime.settings),
					state: runtime.session.state,
					obfuscator: cfgShareRedactSecrets.get(runtime.settings) ? runtime.session.obfuscator : undefined,
				});
				const lines = [t("commands.collaboration.shareUrl", { url: result.url })];
				if (result.gistUrl) lines.push(t("commands.collaboration.gistUrl", { url: result.gistUrl }));
				if (result.truncated) lines.push(t("commands.collaboration.shareTrimmed"));
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(t("commands.collaboration.shareFailed", { error: errorMessage(err) }), runtime);
			}
		},
		handleTui: async (_command, runtime) => {
			await runtime.ctx.handleShareCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "collab",
		icon: "broadcast",
		get description() {
			return t("commands.collaboration.collabDescription");
		},
		inlineHint: "[start|view|list|stop|status] [relayUrl]",
		subcommands: [
			{
				name: "start",
				get description() {
					return t("commands.collaboration.collabStartDescription");
				},
				usage: "[relayUrl]",
			},
			{
				name: "view",
				get description() {
					return t("commands.collaboration.collabViewDescription");
				},
			},
			{
				name: "list",
				get description() {
					return t("commands.collaboration.collabListDescription", { app: APP_NAME });
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.collaboration.collabStatusDescription");
				},
			},
			{
				name: "stop",
				get description() {
					return t("commands.collaboration.collabStopDescription");
				},
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const host = runtime.ctx.collabController.host;
			if (host) {
				return t("commands.collaboration.collabHosting", { count: Math.max(0, host.participants.length - 1) });
			}
			if (runtime.ctx.collabGuest?.readOnly) return t("commands.collaboration.collabViewGuest");
			if (runtime.ctx.collabGuest) return t("commands.collaboration.collabGuest");
			return t("commands.collaboration.collabOff");
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			clearSubmittedText(runtime);
			const args = command.args.trim();
			const { verb, rest } = parseSubcommand(args);
			if (verb === "stop") {
				await ctx.collabController.stop("host stopped");
				ctx.showStatus(t("commands.collaboration.collabStopped"));
				return;
			}
			if (verb === "status") {
				const host = ctx.collabController.host;
				if (host) {
					const names = host.participants.map(p =>
						p.role === "host"
							? t("commands.collaboration.participantHost", { name: p.name })
							: p.readOnly
								? t("commands.collaboration.participantView", { name: p.name })
								: p.name,
					);
					const link = host.access === "view" ? host.webViewLink : host.webLink;
					ctx.showStatus(
						t("commands.collaboration.collabStatus", {
							participants: names.join(", "),
							url: collabBrowserLink(link),
						}),
					);
				} else if (ctx.collabGuest) {
					ctx.showStatus(
						ctx.collabGuest.readOnly
							? t("commands.collaboration.collabViewing")
							: t("commands.collaboration.collabJoined"),
					);
				} else {
					ctx.showStatus(t("commands.collaboration.noCollab"));
				}
				return;
			}
			if (verb === "list") {
				// Same registry as `npi collab list`: metadata only, never a link. A
				// link is a deliberate per-host act (`npi collab link <id> [--view]`),
				// so a listing can be shown or logged without granting anything.
				if (rest.trim()) {
					ctx.showError(t("commands.collaboration.collabListUsage", { app: APP_NAME }));
					return;
				}
				let hosts: CollabHostSnapshot[];
				try {
					hosts = await listCollabHosts();
				} catch (err) {
					ctx.showError(
						truncateToWidth(
							sanitizeDisplayLine(t("commands.collaboration.collabListFailed", { error: errorMessage(err) })),
							TRUNCATE_LENGTHS.LINE,
						),
					);
					return;
				}
				if (hosts.length === 0) {
					ctx.showStatus(t("commands.collaboration.noCollabHosts"));
					return;
				}
				const bullet = theme.fg("accent", theme.format.bullet);
				const plural = hosts.length === 1 ? "" : "s";
				const lines = [
					theme.fg("success", t("commands.collaboration.collabHosts", { count: hosts.length, plural })),
				];
				for (const host of hosts) {
					// Registry strings come from other processes: strip controls,
					// collapse newlines, and bound the width before they hit the TUI.
					const name = host.sessionName ? sanitizeDisplayLine(host.sessionName) : "";
					const sessionId = sanitizeDisplayLine(host.sessionId);
					const session = truncateToWidth(name ? `${name} (${sessionId})` : sessionId, TRUNCATE_LENGTHS.LONG);
					const guests = host.participants - 1;
					const room = [
						`gen ${host.generation}`,
						host.model
							? sanitizeDisplayLine(`${host.model.provider}/${host.model.id}`)
							: t("commands.collaboration.noModel"),
						`started ${formatAge(Math.round((Date.now() - host.startedAt) / 1000)) || t("commands.collaboration.justNow")}`,
					].join(", ");
					const detail = [
						`pid ${host.pid}`,
						t("commands.collaboration.guests", { count: guests, plural: guests === 1 ? "" : "s" }),
						host.access,
						host.relayConnected
							? t("commands.collaboration.relayConnected")
							: t("commands.collaboration.relayReconnecting"),
						...(host.inputRequired ? [t("commands.collaboration.inputRequired")] : []),
						...(host.busy === null ? [] : [host.busy ? "working" : "idle"]),
						truncateToWidth(sanitizeDisplayLine(shortenPath(host.cwd)), TRUNCATE_LENGTHS.TITLE),
					].join(", ");
					lines.push(
						// Fields are bounded above; each composed row is bounded too so the
						// fixed details can never push it past one transcript line.
						truncateToWidth(` ${bullet} ${session} ${theme.fg("muted", `— ${room}`)}`, TRUNCATE_LENGTHS.LINE),
						truncateToWidth(`   ${theme.fg("muted", detail)}`, TRUNCATE_LENGTHS.LINE),
						`   ${theme.fg("dim", `${APP_NAME} collab link ${host.instanceId}${host.access === "view" ? " --view" : ""}`)}`,
					);
				}
				ctx.showStatus(lines.join("\n"), { dim: false });
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError(t("commands.collaboration.collabAlreadyGuest"));
				return;
			}
			const knownStartVerb = verb === "start" || verb === "view";
			const view = verb === "view";
			const access = view ? "view" : "control";
			const existing = ctx.collabController.host;
			let host: CollabHost;
			try {
				host = await ctx.collabController.start({ access, relay: knownStartVerb ? rest : args });
			} catch (err) {
				ctx.showError(t("commands.collaboration.collabStartFailed", { error: errorMessage(err) }));
				return;
			}
			let heading = existing
				? t("commands.collaboration.collabRestarted")
				: t("commands.collaboration.collabStarted");
			if (host === existing)
				heading = view ? t("commands.collaboration.collabViewActive") : t("commands.collaboration.collabActive");
			showCollabLink(ctx, host, heading, view);
		},
	},
	{
		name: "join",
		icon: "signIn",
		get description() {
			return t("commands.collaboration.joinDescription");
		},
		inlineHint: "<link>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			clearSubmittedText(runtime);
			const link = command.args.trim();
			if (!link) {
				ctx.showError(t("commands.collaboration.joinUsage"));
				return;
			}
			if (ctx.collabGuest) {
				ctx.showError(t("commands.collaboration.alreadyJoined"));
				return;
			}
			try {
				// Stop stale/ending ownership and cancel pending starts, not a live room.
				if (!ctx.collabController.host) await ctx.collabController.stop("joining another session");
				// Recheck after teardown: a concurrent manual start may have won.
				if (ctx.collabController.host) {
					ctx.showError(t("commands.collaboration.stopHosting"));
					return;
				}
				await new CollabGuestLink(ctx).join(link);
			} catch (err) {
				ctx.showError(t("commands.collaboration.joinFailed", { error: errorMessage(err) }));
			}
		},
	},
	{
		name: "leave",
		icon: "signOut",
		get description() {
			return t("commands.collaboration.leaveDescription");
		},
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.collabController.host) return t("commands.collaboration.leaveHosting");
			if (runtime.ctx.collabGuest) return t("commands.collaboration.leaveGuest");
			return t("commands.collaboration.leaveOutside");
		},
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			clearSubmittedText(runtime);
			if (ctx.collabGuest) {
				await ctx.collabGuest.leave("left");
				return;
			}
			const wasHosting = ctx.collabHost !== undefined;
			await ctx.collabController.stop("host stopped");
			if (wasHosting) {
				ctx.showStatus(t("commands.collaboration.collabStopped"));
				return;
			}
			ctx.showStatus(t("commands.collaboration.noCollab"));
		},
	},
	{
		name: "browser",
		icon: "globe",
		get description() {
			return t("commands.collaboration.browserDescription");
		},
		acpInputHint: "[headless|visible]",
		subcommands: [
			{
				name: "headless",
				get description() {
					return t("commands.collaboration.browserHeadlessDescription");
				},
			},
			{
				name: "visible",
				get description() {
					return t("commands.collaboration.browserVisibleDescription");
				},
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgBrowserEnabled.get(runtime.ctx.settings)) return t("commands.collaboration.browserDisabled");
			return cfgBrowserHeadless.get(runtime.ctx.settings)
				? t("commands.collaboration.browserHeadless")
				: t("commands.collaboration.browserVisible");
		},
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const enabled = cfgBrowserEnabled.get(runtime.settings);
			if (!enabled) return usage(t("commands.collaboration.browserDisabledInSettings"), runtime);
			const current = cfgBrowserHeadless.get(runtime.settings);
			let next = current;
			if (!arg) next = !current;
			else if (arg === "headless" || arg === "hidden") next = true;
			else if (arg === "visible" || arg === "show" || arg === "headful") next = false;
			else return usage(t("commands.collaboration.browserUsage"), runtime);
			cfgBrowserHeadless.set(runtime.settings, next);
			try {
				await applyBrowserModeChange(next);
			} catch (err) {
				// Setting was already mutated; surface the failure so the
				// user knows the browser is in an inconsistent state.
				await runtime.output(
					t("commands.collaboration.browserModeApplyFailed", {
						mode: next ? "headless" : "visible",
						error: errorMessage(err),
					}),
				);
				return commandConsumed();
			}
			await runtime.output(t("commands.collaboration.browserMode", { mode: next ? "headless" : "visible" }));
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			const current = cfgBrowserHeadless.get(settings);
			let next = current;
			if (!cfgBrowserEnabled.get(settings)) {
				runtime.ctx.showWarning(t("commands.collaboration.browserDisabledInSettingsShort"));
				clearSubmittedText(runtime);
				return;
			}
			if (!arg) {
				next = !current;
			} else if (arg === "headless" || arg === "hidden") {
				next = true;
			} else if (arg === "visible" || arg === "show" || arg === "headful") {
				next = false;
			} else {
				runtime.ctx.showStatus(t("commands.collaboration.browserUsage"));
				clearSubmittedText(runtime);
				return;
			}
			cfgBrowserHeadless.set(settings, next);
			try {
				await applyBrowserModeChange(next);
			} catch (error) {
				runtime.ctx.showWarning(t("commands.collaboration.browserApplyFailed", { error: errorMessage(error) }));
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(t("commands.collaboration.browserMode", { mode: next ? "headless" : "visible" }));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "copy",
		icon: "copy",
		get description() {
			return t("commands.collaboration.copyDescription");
		},
		allowArgs: true,
		getTuiArgumentCompletions: optionalArgumentCompletions("code", "cmd", "command", "link", "url"),
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg) {
				runtime.ctx.showCopySelector();
				clearSubmittedText(runtime);
				return;
			}
			if (arg === "code") {
				const block = extractLastCodeBlock(runtime.ctx.viewSession.messages);
				if (!block) {
					runtime.ctx.showStatus(t("commands.collaboration.noCodeToCopy"));
					clearSubmittedText(runtime);
					return;
				}
				await copyToClipboard(block.code);
				runtime.ctx.showStatus(t("commands.collaboration.codeCopied"));
				clearSubmittedText(runtime);
				return;
			}
			if (arg === "cmd" || arg === "command") {
				const lastCommand = extractLastCommand(runtime.ctx.viewSession.messages);
				if (!lastCommand) {
					runtime.ctx.showStatus(t("commands.collaboration.noCommandToCopy"));
					clearSubmittedText(runtime);
					return;
				}
				await copyToClipboard(lastCommand.code);
				runtime.ctx.showStatus(
					t("commands.collaboration.commandCopied", {
						command:
							lastCommand.kind === "bash"
								? t("commands.collaboration.bashCommand")
								: t("commands.collaboration.evalCode"),
					}),
				);
				clearSubmittedText(runtime);
				return;
			}
			if (arg === "link" || arg === "url") {
				const link = extractLastLink(runtime.ctx.viewSession.messages);
				if (!link) {
					runtime.ctx.showStatus(t("commands.collaboration.noLinkToCopy"));
					clearSubmittedText(runtime);
					return;
				}
				await copyToClipboard(link.href);
				runtime.ctx.showStatus(t("commands.collaboration.linkCopied"));
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(t("commands.collaboration.copyUsage"));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "open",
		icon: "globe",
		get description() {
			return t("commands.collaboration.openDescription");
		},
		allowArgs: true,
		getTuiArgumentCompletions: optionalArgumentCompletions("link", "url"),
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg && arg !== "link" && arg !== "url") {
				runtime.ctx.showStatus(
					t("commands.collaboration.openUsage", { blocks: formatKeyHint("right"), open: formatKeyHint("o") }),
				);
				clearSubmittedText(runtime);
				return;
			}
			const link = extractLastLink(runtime.ctx.session.messages);
			if (!link) {
				runtime.ctx.showStatus(t("commands.collaboration.noLinkToOpen"));
				clearSubmittedText(runtime);
				return;
			}
			openPath(link.href);
			runtime.ctx.showStatus(t("commands.collaboration.openingLink", { url: link.href }));
			clearSubmittedText(runtime);
		},
	},
];

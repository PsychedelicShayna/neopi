import { t } from "@oh-my-pi/pi-utils/i18n";
import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
/**
 * NeoPi operator commands: `/notice`, `/persona`, `/loadout`, `/repl`, `/kernel`, `/neoproxy`.
 */
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import {
	currentDeferredDraft,
	type DetachedDraft,
	runWithDetachedDraft,
	runWithoutDetachedDraft,
} from "@oh-my-pi/pi-tui/draft-scope";
import { formatVisionMarker } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import type { InteractiveModeContext } from "../modes/types";
import {
	completeDeferredDuration,
	deferredSubmissionsFor,
	DEFER_USAGE,
	isDeferredSubmissionActive,
	parseDeferredInput,
	pendingDeferredSubmissionIds,
} from "../neopi/defer";
import { type LoadoutHost, loadoutFeature } from "../neopi/loadout";
import { BUILTIN_PERSONALITIES, completePersonalityNames, isBuiltinPersonality } from "../neopi/personalities";
import {
	currentPersonalityName,
	listCustomPersonalities,
	listPersonalityNames,
	selectPersonality,
} from "../neopi/personality-settings";
import type { Settings } from "../config/settings";
import {
	describePersonalityCacheImpact,
	formatPersonalityCacheImpact,
	personalityCacheImpact,
} from "../neopi/personality-cache";
import { previewBuiltinPersonality } from "../system-prompt";
import {
	PERSONA_SUBCOMMANDS,
	PERSONA_USAGE,
	type PersonaNameItem,
	personaNameItems,
	parsePersonaCommand,
	runPersonaCommand,
	sessionPersonaHost,
} from "../neopi/persona-config";
import { describeNeoProxy, withNeoProxyLoginUrl } from "../neopi/neoproxy-connect";
import { parseReplTarget, REPL_TARGETS, type ReplTarget, replTargetLabel } from "../neopi/repl";
import noticeTemplate from "../prompts/system/operator-notice.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import {
	argumentValues,
	buildArgumentCompletions,
	buildSubcommandInlineHint,
	completeArguments,
	ghostHint,
} from "./builtin-completions";
import { clearSubmittedText, restoreDetachedDraft } from "./helpers/draft";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec, SubcommandDef, TuiSlashCommandRuntime } from "./types";

const deferCancelValues = argumentValues("cancel");

// Compile the static wrapper without prompt.format(), which would rewrite payload whitespace.

const PERSONA_DEFS: SubcommandDef[] = PERSONA_SUBCOMMANDS.map(item => ({ ...item }));
const LIVE_PERSONA_DEFS = PERSONA_DEFS.filter(item => item.name !== "live");
const LOADOUT_DEFS: SubcommandDef[] = [
	{
		name: "set",
		get description() {
			return t("commands.neopi.loadoutSetDescription");
		},
		usage: "<name>",
	},
	{
		name: "use",
		get description() {
			return t("commands.neopi.loadoutUseDescription");
		},
		usage: "<name>",
	},
	{
		name: "off",
		get description() {
			return t("commands.neopi.loadoutOffDescription");
		},
	},
	{
		name: "list",
		get description() {
			return t("commands.neopi.loadoutListDescription");
		},
	},
	{
		name: "show",
		get description() {
			return t("commands.neopi.loadoutShowDescription");
		},
		usage: "<name>",
	},
	{
		name: "status",
		get description() {
			return t("commands.neopi.loadoutStatusDescription");
		},
	},
];
const KERNEL_DEFS: SubcommandDef[] = [
	{
		name: "status",
		get description() {
			return t("commands.neopi.kernelStatusDescription");
		},
	},
	{
		name: "reset",
		get description() {
			return t("commands.neopi.kernelResetDescription");
		},
		usage: "<py|js>",
	},
	{
		name: "interrupt",
		get description() {
			return t("commands.neopi.kernelInterruptDescription");
		},
	},
];
const NEOPROXY_DEFS: SubcommandDef[] = [
	{
		name: "status",
		get description() {
			return t("commands.neopi.proxyStatusDescription");
		},
	},
	{
		name: "url",
		get description() {
			return t("commands.neopi.proxyUrlDescription");
		},
		usage: "<url>",
	},
];

interface NamedArgument {
	name: string;
	description?: string;
	active?: boolean;
}

/**
 * Completion for `<subcommand> <name>` commands: the declarative subcommand
 * list while the verb is typed, then names for the verbs in `nameVerbs`.
 * A name completes the command unless the verb takes a second argument
 * (`needsMore`), in which case the popup stays for it.
 */
async function subcommandThenNameCompletions(
	prefix: string,
	lead: string,
	defs: SubcommandDef[],
	nameVerbs: ReadonlySet<string>,
	names: () => Promise<NamedArgument[]>,
	needsMore: ReadonlySet<string> = new Set(),
): Promise<AutocompleteItem[] | null> {
	const space = prefix.indexOf(" ");
	if (space === -1) {
		const items = await buildArgumentCompletions(defs)(prefix);
		return items?.map(item => ({ ...item, value: `${lead}${item.value}` })) ?? null;
	}
	const verb = prefix.slice(0, space).toLowerCase();
	const typed = prefix.slice(space + 1);
	if (!nameVerbs.has(verb) || typed.includes(" ")) return null;
	const lower = typed.toLowerCase();
	const more = needsMore.has(verb);
	const matches = (await names())
		.filter(item => item.name.toLowerCase().startsWith(lower))
		.map(item => ({
			value: `${lead}${verb} ${item.name}${more ? " " : ""}`,
			label: `${item.active ? "● " : ""}${item.name}`,
			description: item.description,
			hint: ghostHint(item.name.slice(typed.length), more ? "<new-name>" : undefined),
			submitsCommand: !more,
		}));
	return matches.length > 0 ? matches : null;
}

const PERSONA_NAME_VERBS = new Set(["set", "show", "delete", "clone"]);

function personaArgumentCompletions(
	prefix: string,
	runtime: TuiSlashCommandRuntime | undefined,
): Promise<AutocompleteItem[] | null> {
	const lead = /^live\s+/i.exec(prefix)?.[0] ?? "";
	const scope = lead ? "live" : "persona";
	const names = (): Promise<PersonaNameItem[]> => personaNameItems(scope, runtime?.ctx.sessionManager.getSessionId());
	return subcommandThenNameCompletions(
		prefix.slice(lead.length),
		lead,
		lead ? LIVE_PERSONA_DEFS : PERSONA_DEFS,
		PERSONA_NAME_VERBS,
		names,
		new Set(["clone"]),
	).then(
		items =>
			// Bare `/persona live` opens the live editor, so accepting it runs it.
			items?.map(item => (item.value === "live " ? { ...item, submitsCommand: true } : item)) ?? null,
	);
}

const personaSubcommandHint = buildSubcommandInlineHint(PERSONA_DEFS);
const livePersonaSubcommandHint = buildSubcommandInlineHint(LIVE_PERSONA_DEFS);

function personaInlineHint(argumentText: string): string | null {
	const lead = /^\s*live\s+/i.exec(argumentText)?.[0];
	return lead ? livePersonaSubcommandHint(argumentText.slice(lead.length)) : personaSubcommandHint(argumentText);
}

function loadoutUsage() {
	return t("commands.neopi.loadoutUsage");
}
function replUsage() {
	return t("commands.neopi.replUsage");
}
function kernelUsage() {
	return t("commands.neopi.kernelUsage");
}
function neoProxyUsage() {
	return t("commands.neopi.proxyUsage");
}

function tuiPersonaHost(ctx: InteractiveModeContext) {
	return sessionPersonaHost(ctx.session, {
		setStatus: (key, text) => ctx.setHookStatus(key, text),
		setWidget: (key, lines) => ctx.setHookWidget(key, lines),
	});
}

function loadoutHost(session: AgentSession, ctx?: InteractiveModeContext): LoadoutHost {
	return {
		isIdle: () => !session.isStreaming,
		applyRuntimeModelLoadout: loadout => session.applyRuntimeModelLoadout(loadout),
		setStatus: ctx ? (key, text) => ctx.setHookStatus(key, text) : undefined,
	};
}

async function runLoadoutCommand(args: string, host: LoadoutHost): Promise<string | undefined> {
	const { verb, rest } = parseSubcommand(args);
	const loadouts = loadoutFeature();
	switch (verb) {
		case "set":
		case "use":
			return rest ? loadouts.use(rest, host) : undefined;
		case "off":
			return loadouts.off(host);
		case "list":
			return loadouts.list();
		case "show":
			return rest ? loadouts.show(rest) : undefined;
		case "":
		case "status":
			return loadouts.status();
		default:
			return undefined;
	}
}

/** One-screen loadout switcher: pick a loadout to apply it, or turn the overlay off. */
async function loadoutMenu(ctx: InteractiveModeContext): Promise<void> {
	const ui = ctx.getToolUIContext();
	const loadouts = loadoutFeature();
	const data = await loadouts.data();
	if (!ui || data.items.length === 0) {
		ctx.showStatus(data.items.length === 0 ? t("commands.neopi.noLoadouts") : await loadouts.list());
		return;
	}
	const OFF = t("commands.neopi.loadoutOff");
	const options = data.items.map(item => ({
		label: `${item.active ? "●" : "○"} ${item.name}`,
		description: item.loadout.mainModel,
	}));
	if (data.active)
		options.push({ label: OFF, description: t("commands.neopi.restoreModels", { active: data.active }) });
	const picked = await ui.select(
		data.active ? t("commands.neopi.activeLoadout", { active: data.active }) : t("commands.neopi.loadouts"),
		options,
	);
	if (!picked) return;
	const host = loadoutHost(ctx.session, ctx);
	const name = picked === OFF ? undefined : picked.slice(2);
	try {
		ctx.showStatus(name ? await loadouts.use(name, host) : await loadouts.off(host));
	} catch (error) {
		ctx.showError(errorMessage(error));
	}
}

async function replMenu(ctx: InteractiveModeContext): Promise<void> {
	const ui = ctx.getToolUIContext();
	if (!ui) return;
	const current = ctx.replMode.target;
	const picked = await ui.select(
		t("commands.neopi.replTarget", { target: replTargetLabel(current) }),
		REPL_TARGETS.map(item => ({
			label: `${item.id === current ? "●" : "○"} ${item.label}`,
			description:
				item.id === "agent"
					? t("commands.neopi.composerAgent")
					: t("commands.neopi.composerCode", { language: item.label }),
		})),
	);
	const target = REPL_TARGETS.find(item => picked?.slice(2) === item.label)?.id;
	if (target) setRepl(ctx, target);
}

function setRepl(ctx: InteractiveModeContext, target: ReplTarget): void {
	ctx.setReplTarget(target);
	ctx.showStatus(
		target === "agent"
			? t("commands.neopi.replOff")
			: t("commands.neopi.replKeys", {
					target: replTargetLabel(target),
					keys: ctx.keybindings.getKeys("app.repl.execute").join(" / "),
				}),
	);
}

function kernelStatus(session: AgentSession): string {
	const state = (busy: boolean) => (busy ? t("commands.neopi.kernelRunning") : t("commands.neopi.kernelIdle"));
	return [
		`JavaScript: ${state(session.isEvalLanguageRunning("js"))}`,
		`Python: ${state(session.isEvalLanguageRunning("py"))}`,
		`Bash: ${state(session.isBashRunning)}`,
	].join("\n");
}

/** The personality `requested` names: an exact name, else the one case-insensitive match. */
function resolvePersonalityName(names: readonly string[], requested: string): string | undefined {
	const matching = names.filter(name => name.toLocaleLowerCase() === requested.toLocaleLowerCase());
	return names.includes(requested) ? requested : matching.length === 1 ? matching[0] : undefined;
}

async function personalityPrompt(settings: Settings, name: string, cwd: string): Promise<string | undefined> {
	return isBuiltinPersonality(name)
		? await previewBuiltinPersonality(name, cwd)
		: listCustomPersonalities(settings).find(item => item.name === name)?.prompt;
}

function operatorNotice(text: string): string {
	return prompt.compile(
		resolvePromptAsset("system/operator-notice.md", noticeTemplate, { kind: "notice" }).text.trimEnd(),
	)({ text });
}

function noticeOptions(rawText: string) {
	return {
		synthetic: true,
		userInitiated: true,
		attribution: "user" as const,
		rawText,
		expandPromptTemplates: false,
		streamingBehavior: "steer" as const,
	};
}

function personalityCompletions(names: readonly string[], prefix: string) {
	const matches = completePersonalityNames(names, prefix).map(name => ({
		value: name,
		label: name,
		hint: ghostHint(name.slice(prefix.length)),
		submitsCommand: true,
	}));
	return matches.length ? matches : null;
}

export const BUILTIN_NEOPI_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "personality",
		icon: "personality",
		get description() {
			return t("commands.neopi.personalityDescription");
		},
		allowArgs: true,
		inlineHint: "[name]",
		getTuiArgumentCompletions: (prefix, runtime) =>
			personalityCompletions(
				runtime ? listPersonalityNames(runtime.ctx.settings) : [...BUILTIN_PERSONALITIES],
				prefix,
			),
		getHeadlessCompletions: (prefix, runtime) =>
			personalityCompletions(listPersonalityNames(runtime.settings), prefix),
		// Headless hosts: set by name, or list the names. Choosing is a typed name, so there is no confirmation
		// dialog; the cache impact the terminal asks about is reported after the change instead.
		handle: async (command, runtime) => {
			const requested = command.args.trim();
			const current = currentPersonalityName(runtime.settings);
			if (!requested) {
				const names = listPersonalityNames(runtime.settings);
				await runtime.output(
					[
						t("commands.neopi.personality", { name: current }),
						t("commands.neopi.available"),
						...names.map(name => `  ${name}`),
						t("commands.neopi.personalityUsage"),
					].join("\n"),
				);
				return commandConsumed();
			}
			try {
				const name = resolvePersonalityName(listPersonalityNames(runtime.settings), requested);
				if (!name) return usage(t("commands.neopi.unknownPersonality", { name: requested }), runtime);
				const prompt = await personalityPrompt(runtime.settings, name, runtime.cwd);
				if (prompt === undefined) return usage(t("commands.neopi.personalityNotFound", { name }), runtime);
				const impact = await personalityCacheImpact(runtime.session, prompt);
				selectPersonality(runtime.settings, "session", name);
				await runtime.settings.flush();
				await runtime.output(
					t("commands.neopi.personalitySessionImpact", {
						name,
						impact: impact ? `\n${formatPersonalityCacheImpact(impact)}` : "",
					}),
				);
				return commandConsumed();
			} catch (error) {
				return usage(errorMessage(error), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			clearSubmittedText(runtime);
			const requested = command.args.trim();
			if (!requested) {
				ctx.showPersonalityManager();
				return;
			}
			try {
				const names = listPersonalityNames(ctx.settings);
				const name = resolvePersonalityName(names, requested);
				if (!name) {
					ctx.showError(t("commands.neopi.unknownPersonality", { name: requested }));
					return;
				}
				const prompt = await personalityPrompt(ctx.settings, name, ctx.sessionManager.getCwd());
				if (prompt === undefined) {
					ctx.showError(t("commands.neopi.personalityNotFound", { name }));
					return;
				}
				const impact = await personalityCacheImpact(ctx.session, prompt);
				if (
					impact &&
					!(await ctx.showHookConfirm(
						t("commands.neopi.confirmPersonality"),
						describePersonalityCacheImpact(impact),
					))
				)
					return;
				selectPersonality(ctx.settings, "session", name);
				await ctx.settings.flush();
				ctx.showStatus(t("commands.neopi.personalitySession", { name }));
			} catch (error) {
				ctx.showError(errorMessage(error));
			}
		},
	},
	{
		name: "defer",
		icon: "prompt",
		get description() {
			return t("commands.neopi.deferDescription");
		},
		inlineHint: "<duration> <input> | cancel <id|all>",
		allowArgs: true,
		getTuiArgumentCompletions: (prefix, runtime) =>
			completeArguments(
				prefix,
				runtime,
				value => {
					const durations = completeDeferredDuration(value);
					return durations.length > 0
						? durations.map(duration => ({ value: `${duration} `, label: duration }))
						: deferCancelValues(value);
				},
				(value, current) => {
					if (!/^cancel\s/.test(prefix.trimStart())) return null;
					const ids = current ? pendingDeferredSubmissionIds(current.ctx.session) : [];
					// Completing a prefix must not turn Enter into cancellation of a guessed ID or "all".
					return (
						argumentValues(
							"all",
							...ids.map(String),
						)(value)?.map(item => ({
							...item,
							preserveInputOnSubmit: true,
						})) ?? null
					);
				},
			),
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			clearSubmittedText(runtime);
			const schedules = deferredSubmissionsFor(ctx.session);
			const cancellation = /^cancel\s+(\d+|all)$/.exec(command.args);
			if (cancellation) {
				const count = schedules.cancel(cancellation[1] === "all" ? undefined : Number(cancellation[1]));
				ctx.showStatus(t("commands.neopi.deferCancelled", { count, plural: count === 1 ? "" : "s" }));
				return;
			}
			const parsed = parseDeferredInput(command.text.slice(command.name.length + 2).trimStart());
			if (!parsed) {
				ctx.showError(DEFER_USAGE);
				return;
			}
			const images = runtime.input?.images ? [...runtime.input.images] : [];
			const imageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : images.map(() => undefined);
			const id = schedules.schedule(
				parsed.delayMs,
				() =>
					runWithoutDetachedDraft(async () => {
						let returned: DetachedDraft | undefined;
						try {
							await runWithDetachedDraft(async () => {
								const draft = currentDeferredDraft();
								if (!draft) throw new Error(t("commands.neopi.missingDeferredScope"));
								returned = draft;
								ctx.editor.pendingImages = [...images];
								ctx.editor.pendingImageLinks = [...imageLinks];
								ctx.editor.imageLinks = draft.imageLinks;
								// Enter has already removed the submitted text; only refusal paths put it back.
								try {
									await ctx.editor.onSubmit?.(parsed.input);
								} catch (error) {
									ctx.editor.setText(parsed.input);
									ctx.editor.pendingImages = [...images];
									ctx.editor.pendingImageLinks = [...imageLinks];
									throw error;
								}
							}, "defer");
						} finally {
							if (returned && isDeferredSubmissionActive()) {
								const text =
									returned.text ||
									returned.images.map((_, index) => formatVisionMarker("image", index + 1)).join(" ");
								if (text.trim()) {
									restoreDetachedDraft(ctx.editor, text, returned.images, returned.imageLinks);
									ctx.showWarning(t("commands.neopi.deferUnconsumed"));
									ctx.ui.requestRender();
								}
							}
						}
					}),
				error => ctx.showError(t("commands.neopi.deferFailed", { error: errorMessage(error) })),
			);
			if (images.length && images.every((image, index) => ctx.editor.pendingImages[index] === image)) {
				ctx.editor.pendingImages.splice(0, images.length);
				ctx.editor.pendingImageLinks.splice(0, images.length);
				ctx.editor.imageLinks = ctx.editor.pendingImageLinks.length ? ctx.editor.pendingImageLinks : undefined;
			}
			ctx.showStatus(t("commands.neopi.deferScheduled", { id, target: id }));
		},
	},
	{
		name: "notice",
		icon: "prompt",
		get description() {
			return t("commands.neopi.noticeDescription");
		},
		inlineHint: "<text>",
		allowArgs: true,
		// Headless hosts: the same steering notice, sent through the session.
		handle: async (command, runtime) => {
			const text = command.text.slice(command.name.length + 2);
			if (!text.trim()) return usage(t("commands.neopi.noticeUsage"), runtime);
			try {
				await runtime.session.prompt(operatorNotice(text), noticeOptions(command.text));
			} catch (error) {
				return usage(errorMessage(error), runtime);
			}
			return commandConsumed({ agentInvoked: true });
		},
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			// Discard only the command and its separator; all remaining text is literal.
			const text = command.text.slice(command.name.length + 2);
			clearSubmittedText(runtime);
			if (!text.trim()) {
				ctx.showStatus(t("commands.neopi.noticeUsage"));
				return;
			}
			const notice = operatorNotice(text);
			const options = noticeOptions(command.text);
			ctx.editor.clearSubmittedDraft();
			if (ctx.onInputCallback && !ctx.session.isStreaming) {
				ctx.onInputCallback({ text: notice, ...options, cancelled: false, started: true });
				return;
			}
			try {
				await ctx.session.prompt(notice, options);
			} catch (error) {
				ctx.editor.setCollapsedText(command.text);
				ctx.showError(errorMessage(error));
			}
			ctx.updatePendingMessagesDisplay();
			ctx.ui.requestRender();
		},
	},
	{
		name: "persona",
		icon: "prompt",
		get description() {
			return t("commands.neopi.personaDescription");
		},
		get acpDescription() {
			return t("commands.neopi.personaAcpDescription");
		},
		acpInputHint: "[live] [set <name>|off|list|show <name>|status|clone <source> <name>|delete <name>]",
		subcommands: PERSONA_DEFS,
		getTuiArgumentCompletions: personaArgumentCompletions,
		getTuiInlineHint: personaInlineHint,
		allowArgs: true,
		handle: async (command, runtime) => {
			try {
				const message = await runPersonaCommand(
					parsePersonaCommand(command.args),
					sessionPersonaHost(runtime.session),
				);
				if (message === undefined) return usage(PERSONA_USAGE, runtime);
				await runtime.output(message);
				return commandConsumed();
			} catch (error) {
				return usage(errorMessage(error), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const parsed = parsePersonaCommand(command.args);
			if (!parsed.verb) {
				ctx.showPersonaConfigure(parsed.scope);
				return;
			}
			try {
				const message = await runPersonaCommand(parsed, tuiPersonaHost(ctx));
				if (message === undefined) ctx.showError(PERSONA_USAGE);
				else ctx.showStatus(message);
			} catch (error) {
				ctx.showError(errorMessage(error));
			}
		},
	},
	{
		name: "live-persona",
		icon: "prompt",
		get description() {
			return t("commands.neopi.livePersonaDescription");
		},
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			runtime.ctx.showPersonaConfigure("live");
		},
	},
	{
		name: "loadout",
		icon: "swap",
		get description() {
			return t("commands.neopi.loadoutDescription");
		},
		acpInputHint: "[set <name>|use <name>|off|list|show <name>|status]",
		subcommands: LOADOUT_DEFS,
		getTuiArgumentCompletions: prefix =>
			subcommandThenNameCompletions(prefix, "", LOADOUT_DEFS, new Set(["set", "use", "show"]), async () =>
				(await loadoutFeature().data()).items.map(item => ({
					name: item.name,
					description: item.loadout.mainModel,
					active: item.active,
				})),
			),
		allowArgs: true,
		handle: async (command, runtime) => {
			try {
				const message = await runLoadoutCommand(command.args, loadoutHost(runtime.session));
				if (message === undefined) return usage(loadoutUsage(), runtime);
				await runtime.output(message);
				return commandConsumed();
			} catch (error) {
				return usage(errorMessage(error), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			if (!command.args.trim()) {
				await loadoutMenu(ctx);
				return;
			}
			try {
				const message = await runLoadoutCommand(command.args, loadoutHost(ctx.session, ctx));
				if (message === undefined) ctx.showError(loadoutUsage());
				else ctx.showStatus(message);
			} catch (error) {
				ctx.showError(errorMessage(error));
			}
		},
	},
	{
		name: "repl",
		icon: "computer",
		get description() {
			return t("commands.neopi.replDescription");
		},
		get acpDescription() {
			return t("commands.neopi.replAcpDescription");
		},
		subcommands: REPL_TARGETS.map(item => ({
			name: item.id,
			description:
				item.id === "agent"
					? t("commands.neopi.leaveRepl")
					: t("commands.neopi.runComposer", { language: item.label }),
		})),
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.replMode.active
				? t("commands.neopi.replState", { target: replTargetLabel(runtime.ctx.replMode.target) })
				: undefined,
		handle: async (_command, runtime) => usage(t("commands.neopi.replTuiOnly"), runtime),
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const token = command.args.trim();
			if (!token) {
				await replMenu(ctx);
				return;
			}
			const target = parseReplTarget(token);
			if (!target) {
				ctx.showError(replUsage());
				return;
			}
			setRepl(ctx, target);
		},
	},
	{
		name: "kernel",
		icon: "restart",
		get description() {
			return t("commands.neopi.kernelDescription");
		},
		acpInputHint: "[status|interrupt]",
		subcommands: KERNEL_DEFS,
		getTuiArgumentCompletions: prefix =>
			subcommandThenNameCompletions(prefix, "", KERNEL_DEFS, new Set(["reset"]), async () => [
				{ name: "js", description: t("commands.neopi.javascriptKernel") },
				{ name: "py", description: t("commands.neopi.pythonKernel") },
			]),
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "" || verb === "status") {
				await runtime.output(kernelStatus(runtime.session));
				return commandConsumed();
			}
			if (verb === "interrupt") {
				runtime.session.abortEval();
				runtime.session.abortBash();
				await runtime.output(t("commands.neopi.kernelsInterrupted"));
				return commandConsumed();
			}
			return usage(kernelUsage(), runtime);
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "" || verb === "status") {
				ctx.showStatus(kernelStatus(ctx.session));
				return;
			}
			if (verb === "interrupt") {
				ctx.session.abortEval();
				ctx.session.abortBash();
				ctx.showStatus(t("commands.neopi.kernelsInterrupted"));
				return;
			}
			const kernel = parseReplTarget(rest);
			if (verb === "reset" && (kernel === "py" || kernel === "js")) {
				ctx.replMode.requestReset(kernel);
				ctx.showStatus(t("commands.neopi.nextKernel", { language: replTargetLabel(kernel) }));
				return;
			}
			ctx.showError(kernelUsage());
		},
	},
	{
		name: "neoproxy",
		icon: "signIn",
		get description() {
			return t("commands.neopi.proxyDescription");
		},
		acpInputHint: "[status]",
		subcommands: NEOPROXY_DEFS,
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (verb === "" || verb === "status") {
				await runtime.output(describeNeoProxy(runtime.session.modelRegistry));
				return commandConsumed();
			}
			if (verb === "url") return usage(t("commands.neopi.proxyKeyRequired"), runtime);
			return usage(neoProxyUsage(), runtime);
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "" || verb === "status") {
				ctx.showStatus(describeNeoProxy(ctx.session.modelRegistry));
				return;
			}
			if (verb === "url" && rest.trim()) {
				await withNeoProxyLoginUrl(ctx.session.modelRegistry, rest.trim(), () =>
					ctx.showOAuthSelector("login", "neoproxy"),
				);
				return;
			}
			ctx.showError(neoProxyUsage());
		},
	},
];

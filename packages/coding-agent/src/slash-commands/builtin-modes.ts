import { t } from "@oh-my-pi/pi-utils/i18n";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import { clearSubmittedText, runWithDetachedDraft } from "./helpers/draft";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { isRecord, PRODUCT_NAME } from "@oh-my-pi/pi-utils";
import { formatModelString } from "../config/model-resolver";
import { resolveSessionModelSelector } from "../config/session-model-selector";
import type { Settings } from "../config/settings";
import { cfgModelsDefaultScope } from "../config/model-settings";
import {
	applyModelPreset,
	deleteModelPreset,
	formatModelPresetSwitch,
	getModelPresetNames,
	isCleanModelPresetSwitch,
	isValidModelPresetName,
	modelPresetSavedMessage,
	type ModelPresetSession,
	saveModelPreset,
} from "../config/model-presets";
import { describeLoopCondition } from "../modes/loop-condition";
import {
	describeLoopLimitRuntime,
	LOOP_CONDITION_FLAGS,
	LOOP_DURATION_UNITS,
	parseLoopArgs,
} from "../modes/loop-limit";
import type { InteractiveModeContext } from "../modes/types";
import ratchetKickoffPrompt from "../prompts/ratchet-kickoff.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { FAST_USAGE, formatFastModeStatus, runFastCommand } from "../session/fast-command";
import { describePrewalkCrew, getPrewalkPatterns, resolvePrewalkCrewSelection } from "../session/prewalk-crew";
import { CLI_THINKING_LEVELS, getConfiguredThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";
import { argumentValues, buildArgumentCompletions, completeCurrentArgument } from "./builtin-completions";
import { noThinkingMessage, resolveThinkingArgument } from "./helpers/effort";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSecurityCommand, SECURITY_SUBCOMMANDS } from "./helpers/security";
import { buildModelSelectorCompletions } from "./model-selector-completions";
import type { ArgumentValueProvider, SlashCommandSpec, SubcommandDef, TuiSlashCommandRuntime } from "./types";

import {
	cfgComputerBackgroundFallback,
	cfgComputerDisplay,
	cfgComputerEnabled,
	cfgComputerMaxHeight,
	cfgComputerMaxWidth,
	cfgRatchetEnabled,
} from "../tools/settings";
import { cfgSkillful } from "../session/settings";
import { formatSlowModeResetClock } from "../session/anthropic-slow-mode";
import { cfgExtendedContext } from "../session/context-settings";
import { cfgGoalEnabled } from "../goals/settings";
import { cfgPlanEnabled } from "../plan-mode/settings";
import {
	CHAT_INCLUDES,
	CHAT_MODES,
	type ChatModeChangeRequest,
	type ChatModeConfig,
	parseChatCommandArgs,
} from "../chat/chat-mode";

function formatChatModeStatus(config: ChatModeConfig | undefined): string {
	if (!config) return "off";
	return config.include.length > 0
		? t("commands.modes.chatInclude", { mode: config.mode, paths: config.include.join(", ") })
		: config.mode;
}

const clearArgument = argumentValues("clear");

const loopFlags = argumentValues(...LOOP_CONDITION_FLAGS);
const loopUnits = argumentValues(...LOOP_DURATION_UNITS);

const loopArguments: ArgumentValueProvider = (prefix, _runtime, previous) => {
	if (previous.length === 0) {
		const compact = /^((?:\d+[a-z]+)*\d+)([a-z]*)$/i.exec(prefix);
		if (!compact) return loopFlags(prefix);
		return (
			loopUnits(compact[2]!)?.flatMap(item => {
				const value = compact[1] + item.value;
				return typeof parseLoopArgs(value) === "string"
					? []
					: [{ value, label: value.trimEnd(), preserveInputOnSubmit: /^\d+$/.test(prefix) }];
			}) ?? null
		);
	}
	const parsed = parseLoopArgs(previous.join(" "));
	if (typeof parsed === "string" || !parsed.limit || parsed.prompt || parsed.condition) return null;
	const flags = loopFlags(prefix);
	const units = parsed.limit.kind === "iterations" && !prefix.startsWith("-") ? loopUnits(prefix) : null;
	return flags && units ? [...flags, ...units] : (flags ?? units);
};

const CHAT_INCLUDE_OPTION = "--include";
const CHAT_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "chat",
		get description() {
			return t("commands.modes.chatDescription");
		},
		usage: "[--include <categories>]",
	},
	{
		name: "erp",
		get description() {
			return t("commands.modes.roleplayDescription");
		},
		usage: "[--include <categories>]",
	},
	{
		name: "raw",
		get description() {
			return t("commands.modes.noSystemPrompt");
		},
		usage: "[--include <categories>]",
	},
	{
		name: "off",
		get description() {
			return t("commands.modes.codingMode");
		},
	},
];
const chatModeCompletions = buildArgumentCompletions(CHAT_SUBCOMMANDS, { optional: true });
const chatActiveModes = argumentValues(...CHAT_MODES);

function chatIncludeCompletions(prefix: string, attached: string) {
	const parts = prefix.split(",");
	const query = parts.pop()!.toLowerCase();
	const existing = new Set(parts.map(part => part.toLowerCase()));
	const preceding = parts.length > 0 ? `${parts.join(",")},` : "";
	return CHAT_INCLUDES.filter(name => name.toLowerCase().startsWith(query) && !existing.has(name.toLowerCase())).map(
		name => ({
			label: name,
			value: `${attached}${preceding}${name} `,
		}),
	);
}

const chatArguments: ArgumentValueProvider = async (prefix, _runtime, previous) => {
	const expectingInclude = previous.at(-1) === CHAT_INCLUDE_OPTION;
	const consumed = expectingInclude ? previous.slice(0, -1) : previous;
	let request: ChatModeChangeRequest;
	try {
		request = parseChatCommandArgs(consumed.join(" "));
	} catch {
		return null;
	}
	if (request.mode === "off") return null;
	if (expectingInclude) return request.include === undefined ? chatIncludeCompletions(prefix, "") : null;
	if (request.include !== undefined) {
		return request.mode ? null : chatActiveModes(prefix);
	}
	const attached = `${CHAT_INCLUDE_OPTION}=`;
	if (prefix.startsWith(attached)) return chatIncludeCompletions(prefix.slice(attached.length), attached);
	const flag = CHAT_INCLUDE_OPTION.startsWith(prefix)
		? [{ label: CHAT_INCLUDE_OPTION, value: `${CHAT_INCLUDE_OPTION} ` }]
		: [];
	const modes = request.mode ? null : await chatModeCompletions(prefix);
	return [...(modes ?? []), ...flag];
};

const completeModelArgument: ArgumentValueProvider = (prefix, runtime) => {
	if (!runtime) return null;
	return (
		buildModelSelectorCompletions(runtime)(prefix)?.map(item => ({
			...item,
			submitsCommand: false,
		})) ?? null
	);
};

const PREWALK_SUBCOMMANDS: SubcommandDef[] = [
	{
		name: "restart",
		get description() {
			return t("commands.modes.prewalkRestartDescription");
		},
		usage: "[from] [into]",
		arguments: [completeModelArgument, completeModelArgument],
	},
	{
		name: "off",
		get description() {
			return t("commands.modes.prewalkOffDescription");
		},
	},
];

async function completePrewalkArguments(prefix: string, runtime: TuiSlashCommandRuntime | undefined) {
	const verbs = await buildArgumentCompletions(PREWALK_SUBCOMMANDS, { optional: true, runtime })(prefix);
	const trimmed = prefix.trimStart();
	if (/\s/.test(trimmed) || trimmed.toLowerCase() === "off" || !runtime) return verbs;
	const models = buildModelSelectorCompletions(runtime)(trimmed);
	return [
		...(verbs ?? []),
		...(models?.map(item => ({
			...item,
			value: prefix.slice(0, prefix.length - trimmed.length) + item.value,
			preserveInputOnSubmit: trimmed.length === 0,
		})) ?? []),
	];
}

function modelPresetNames(deletable: boolean): ArgumentValueProvider {
	return (prefix, runtime) => {
		const settings = runtime?.ctx.settings;
		if (!settings) return null;
		const global = settings.getGlobalSettings().modelPresets;
		const names = getModelPresetNames(settings).filter(
			name => !deletable || (isRecord(global) && Object.hasOwn(global, name)),
		);
		return argumentValues(...names)(prefix);
	};
}

export function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

const SLOW_UNSUPPORTED = t("commands.modes.slowUnavailable");

/**
 * `/slow [on|off|status]` for the active model: the `flex` service tier on
 * OpenAI/Google, subscription low priority (`providers.anthropic.slowMode`
 * `auto`/`off`) on Anthropic. Bare invocation toggles. Returns the user-facing
 * reply, or `undefined` for an unknown argument.
 */
function runSlowCommand(arg: string, session: AgentSession): string | undefined {
	if (arg !== "" && arg !== "toggle" && arg !== "on" && arg !== "off" && arg !== "status") return undefined;
	const anthropic = session.model?.provider === "anthropic";
	if (arg === "status") {
		const label = anthropic ? session.getAnthropicSlowModeLabel() : undefined;
		if (!session.isSlowModeEnabled())
			return label ? t("commands.modes.slowOffWithTier", { tier: label }) : t("commands.modes.slowOff");
		if (!anthropic) return t("commands.modes.slowFlex");
		return label ? t("commands.modes.slowOnWithTier", { tier: label }) : t("commands.modes.slowPriority");
	}
	const enabled = arg === "on" || (arg !== "off" && !session.isSlowModeEnabled());
	if (!session.setSlowMode(enabled)) return SLOW_UNSUPPORTED;
	if (!session.isSlowModeEnabled()) {
		return anthropic ? t("commands.modes.slowOffClaude") : t("commands.modes.slowDisabled");
	}
	if (!anthropic) return t("commands.modes.slowEnabledFlex");
	const resetsAtSec = session.getAnthropicSlowModeLane()?.activeResetsAtSec();
	return resetsAtSec !== undefined
		? t("commands.modes.slowUntilReset", { time: formatSlowModeResetClock(resetsAtSec) })
		: t("commands.modes.slowAtLimit");
}

/** `/extended-context status` label for the premium long-context window setting. */
function formatExtendedContextStatus(settings: Settings): string {
	return cfgExtendedContext.get(settings) ? t("commands.modes.stateOn") : t("commands.modes.stateOff");
}

/** Applies an `/extended-context` argument and returns its operator feedback. */
function applyExtendedContextCommand(settings: Settings, args: string): string | undefined {
	const arg = args.trim().toLowerCase();
	const current = cfgExtendedContext.get(settings);
	if (!arg || arg === "toggle") {
		const enabled = !current;
		cfgExtendedContext.set(settings, enabled);
		return t("commands.modes.extendedState", {
			state: enabled ? t("commands.modes.enabled") : t("commands.modes.disabled"),
		});
	}
	if (arg === "on") {
		cfgExtendedContext.set(settings, true);
		return t("commands.modes.extendedEnabled");
	}
	if (arg === "off") {
		cfgExtendedContext.set(settings, false);
		return t("commands.modes.extendedDisabled");
	}
	if (arg === "status") return t("commands.modes.extendedCurrent", { state: formatExtendedContextStatus(settings) });
	return undefined;
}

/** Detailed, session-effective `/computer status` diagnostics. */
function formatComputerUseStatus(session: AgentSession): string {
	const enabled = cfgComputerEnabled.get(session.settings);
	const active = session.getEvalPreludes().some(definition => definition.name === "computer");
	const configured = {
		display: cfgComputerDisplay.get(session.settings),
		maxWidth: cfgComputerMaxWidth.get(session.settings),
		maxHeight: cfgComputerMaxHeight.get(session.settings),
		backgroundFallback: cfgComputerBackgroundFallback.get(session.settings),
	};
	return [
		t("commands.modes.computerState", {
			state: enabled ? t("commands.modes.enabled") : t("commands.modes.disabled"),
		}),
		t("commands.modes.preludeState", { status: active ? t("commands.modes.active") : t("commands.modes.inactive") }),
		t("commands.modes.computerConfig", {
			display: configured.display,
			maxWidth: configured.maxWidth,
			maxHeight: configured.maxHeight,
			backgroundFallback: String(configured.backgroundFallback),
		}),
	].join(" · ");
}

/**
 * Apply a session-scoped computer-use toggle; the session's setting listener
 * reconciles the prompt without a mid-session cache-busting rebuild.
 * The override is never persisted to settings.json.
 */
function applyComputerUseToggle(session: AgentSession, enable: boolean): string {
	const previous = cfgComputerEnabled.get(session.settings);
	cfgComputerEnabled.override(session.settings, enable);
	if (enable && !session.getEvalPreludes().some(definition => definition.name === "computer")) {
		cfgComputerEnabled.override(session.settings, previous);
		return t("commands.modes.computerUnavailable");
	}
	return enable
		? t("commands.modes.computerEnabled", { status: formatComputerUseStatus(session) })
		: t("commands.modes.computerDisabled");
}

/** Tools the ratchet loop needs: the eval kernel hosts `ratchet()`, `task` runs its analyzer. */
const RATCHET_REQUIRED_TOOLS = ["eval", "task"] as const;

/**
 * Arm `/ratchet`: enable the ratchet prelude for this session (override, never persisted) and
 * render the kickoff prompt carrying the user's request as data.
 */
function prepareRatchet(session: AgentSession, request: string): { kickoff: string } | { error: string } {
	const tools = session.getEnabledToolNames();
	const missing = RATCHET_REQUIRED_TOOLS.filter(tool => !tools.includes(tool));
	if (missing.length > 0) return { error: t("commands.modes.ratchetMissingTool", { tools: missing.join(" and ") }) };
	const previous = cfgRatchetEnabled.get(session.settings);
	if (!previous) cfgRatchetEnabled.override(session.settings, true);
	if (!session.getEvalPreludes().some(definition => definition.name === "ratchet")) {
		if (!previous) cfgRatchetEnabled.override(session.settings, previous);
		return { error: t("commands.modes.ratchetUnavailable") };
	}
	const kickoff = renderPromptAsset("ratchet-kickoff.md", ratchetKickoffPrompt, {
		request: request.trim() || undefined,
		tools,
	}).trim();
	return { kickoff };
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		icon: "shield",
		get description() {
			return t("commands.modes.scanDescription", { product: PRODUCT_NAME });
		},
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|cloud|show|import|export|validate|compare|disposition>",
		subcommands: SECURITY_SUBCOMMANDS,
		subcommandOptional: true,
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		icon: "settings",
		get description() {
			return t("commands.modes.settingsDescription");
		},
		allowArgs: true,
		subcommands: [
			{
				name: "session",
				get description() {
					return t("commands.modes.sessionSettingsDescription");
				},
				usage: "[clear]",
				arguments: [clearArgument],
			},
			{
				name: "project",
				get description() {
					return t("commands.modes.projectSettingsDescription");
				},
				usage: "[clear]",
				arguments: [clearArgument],
			},
			{
				name: "global",
				get description() {
					return t("commands.modes.globalSettingsDescription");
				},
			},
		],
		handleTui: async (command, runtime) => {
			const [scope, verb, extra] = command.args.trim().split(/\s+/);
			if (
				(scope && scope !== "session" && scope !== "project" && scope !== "global") ||
				(verb && verb !== "clear") ||
				extra ||
				(verb === "clear" && scope === "global")
			) {
				runtime.ctx.showWarning(t("commands.modes.settingsUsage"));
			} else if (verb === "clear" && (scope === "session" || scope === "project")) {
				await runtime.ctx.settings.clearScope(scope);
				runtime.ctx.showStatus(t("commands.modes.settingsCleared", { scope }));
			} else {
				runtime.ctx.showSettingsSelector(
					scope === "session" || scope === "project" || scope === "global" ? scope : undefined,
				);
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "statusline",
		icon: "settings",
		get description() {
			return t("commands.modes.statusLineDescription");
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showStatusLineConfigure();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		icon: "gear",
		get description() {
			return t("commands.modes.setupDescription");
		},
		allowArgs: true,
		subcommands: [
			{
				name: "providers",
				get description() {
					return t("commands.modes.providersDescription");
				},
			},
		],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(t("commands.modes.setupUsage", { command: command.name }));
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "plan",
		icon: "plan",
		get description() {
			return t("commands.modes.planDescription");
		},
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgPlanEnabled.get(runtime.ctx.settings)) return t("commands.modes.planDisabled");
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return t("commands.modes.planOn", { file: planFile ? ` (${path.basename(planFile)})` : "" });
			}
			if (runtime.ctx.goalModeEnabled) return t("commands.modes.planBlocked");
			return t("commands.modes.planOff");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedDraft(command, runtime, () =>
				runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "plan-review",
		icon: "plan",
		get description() {
			return t("commands.modes.planReviewDescription");
		},
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled
				? t("commands.modes.planReviewAvailable")
				: t("commands.modes.planReviewUnavailable"),
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "vibe",
		icon: "wave",
		get description() {
			return t("commands.modes.vibeDescription");
		},
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return t("commands.modes.vibeOn");
			if (runtime.ctx.planModeEnabled) return t("commands.modes.vibeBlockedPlan");
			if (runtime.ctx.goalModeEnabled) return t("commands.modes.vibeBlockedGoal");
			return t("commands.modes.vibeOff");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedDraft(command, runtime, () =>
				runtime.ctx.handleVibeModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "goal",
		icon: "goal",
		get description() {
			return t("commands.modes.goalDescription");
		},
		subcommands: [
			{
				name: "set",
				get description() {
					return t("commands.modes.goalSetDescription");
				},
				usage: "<objective>",
			},
			{
				name: "show",
				get description() {
					return t("commands.modes.goalStatusDescription");
				},
			},
			{
				name: "pause",
				get description() {
					return t("commands.modes.goalPauseDescription");
				},
			},
			{
				name: "resume",
				get description() {
					return t("commands.modes.goalResumeDescription");
				},
			},
			{
				name: "drop",
				get description() {
					return t("commands.modes.goalClearDescription");
				},
			},
			{
				name: "budget",
				get description() {
					return t("commands.modes.goalBudgetDescription");
				},
				usage: "<N|off>",
				arguments: [argumentValues("off")],
			},
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!cfgGoalEnabled.get(runtime.ctx.settings)) return t("commands.modes.goalDisabled");
			if (runtime.ctx.planModeEnabled) return t("commands.modes.goalBlocked");
			const state = runtime.ctx.session.getGoalModeState();
			return state
				? t("commands.modes.goalStatus", {
						status: state.goal.status,
						objective: shortDetail(state.goal.objective),
					})
				: t("commands.modes.goalOff");
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedDraft(command, runtime, () =>
				runtime.ctx.handleGoalModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "guided-goal",
		icon: "compass",
		get description() {
			return t("commands.modes.goalSetupDescription");
		},
		get inlineHint() {
			return t("commands.modes.goalSetupHint");
		},
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runWithDetachedDraft(command, runtime, () =>
				runtime.ctx.handleGuidedGoalCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "loop",
		icon: "loop",
		get description() {
			return t("commands.modes.loopDescription", { key: formatKeyHint("escape") });
		},
		inlineHint: "[count|duration] [--while|--until '<cmd>'] [prompt]",
		allowArgs: true,
		getTuiArgumentCompletions: (prefix, runtime) => completeCurrentArgument(prefix, runtime, loopArguments),
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return t("commands.modes.loopOff");
			if (runtime.ctx.loopModePaused) return t("commands.modes.loopPaused");
			const bounds = [
				runtime.ctx.loopLimit ? describeLoopLimitRuntime(runtime.ctx.loopLimit) : undefined,
				runtime.ctx.loopCondition ? describeLoopCondition(runtime.ctx.loopCondition) : undefined,
			].filter((part): part is string => part !== undefined);
			if (bounds.length > 0) return t("commands.modes.loopBounds", { bounds: bounds.join(", ") });
			if (runtime.ctx.loopPrompt) return t("commands.modes.loopRepeating");
			return t("commands.modes.loopWaiting");
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			clearSubmittedText(runtime);
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "queue",
		icon: "inbox",
		get description() {
			return t("commands.modes.queueDescription");
		},
		inlineHint: "<message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(
				command.args,
				runtime.draftDetached ? { ...runtime.input, text: command.text } : undefined,
			);
		},
	},
	{
		name: "roles",
		hiddenAliases: ["models"],
		icon: "model",
		get description() {
			return t("commands.modes.rolesDescription");
		},
		allowArgs: true,
		subcommands: [
			{
				name: "session",
				get description() {
					return t("commands.modes.sessionRolesDescription");
				},
			},
			{
				name: "project",
				get description() {
					return t("commands.modes.projectRolesDescription");
				},
			},
			{
				name: "global",
				get description() {
					return t("commands.modes.globalRolesDescription");
				},
			},
		],
		handleTui: (command, runtime) => {
			const args = command.args.trim();
			if (runtime.focusedSession && (!args || args === "session")) {
				runtime.ctx.showModelSelector({ temporaryOnly: true });
				clearSubmittedText(runtime);
				return;
			}
			const scope = args || cfgModelsDefaultScope.get(runtime.ctx.settings);
			if (scope !== "session" && scope !== "project" && scope !== "global") {
				runtime.ctx.showError(t("commands.modes.rolesUsage"));
				return;
			}
			runtime.ctx.showModelSelector({ scope });
			clearSubmittedText(runtime);
		},
	},
	{
		name: "model",
		hiddenAliases: ["switch"],
		icon: "swap",
		get description() {
			return t("commands.modes.modelDescription", { key: formatKeyHint("alt+p") });
		},
		get acpDescription() {
			return t("commands.modes.modelAcpDescription");
		},
		acpInputHint: "[model]",
		inlineHint: "[model]",
		allowArgs: true,
		getTuiArgumentCompletions: (prefix, runtime) =>
			runtime
				? (buildModelSelectorCompletions(runtime)(prefix)?.map(item => ({
						...item,
						preserveInputOnSubmit: prefix.length === 0,
					})) ?? null)
				: null,
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.viewSession.model;
			return model
				? t("commands.modes.model", { provider: model.provider, id: model.id })
				: t("commands.modes.noModel");
		},
		handle: async (command, runtime) => {
			const selector = command.args.trim();
			if (!selector) {
				const model = runtime.session.model;
				await runtime.output(
					model
						? t("commands.modes.currentModel", { provider: model.provider, id: model.id })
						: t("commands.modes.modelNotSelected"),
				);
				return commandConsumed();
			}
			const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
			if (!resolved.model) return usage(t("commands.modes.unknownModel", { selector }), runtime);
			try {
				await runtime.session.setModelTemporary(resolved.model, resolved.thinkingLevel);
				await runtime.output(t("commands.modes.modelSwitched", { model: formatModelString(resolved.model) }));
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(t("commands.modes.modelSwitchFailed", { error: errorMessage(err) }), runtime);
			}
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const selector = command.args.trim();
			if (!selector) {
				runtime.ctx.showModelSelector({ temporaryOnly: true });
				return;
			}
			const { ctx, focusedSession } = runtime;
			if (focusedSession) {
				try {
					const outcome = await focusedSession.selectSubagentModel({ selector });
					if (!outcome.ok) {
						ctx.showError(outcome.message);
						return;
					}
					const { provider, modelId, warning } = outcome.data;
					if (warning) ctx.showStatus(warning);
					refreshStatusLine(ctx);
					ctx.showStatus(t("commands.modes.modelSwitched", { model: `${provider}/${modelId}` }));
				} catch (error) {
					ctx.showError(t("commands.modes.modelSwitchFailed", { error: errorMessage(error) }));
				}
				return;
			}
			const resolved = resolveSessionModelSelector(selector, ctx.session, ctx.settings);
			if (!resolved.model) {
				runtime.ctx.showError(t("commands.modes.unknownModel", { selector }));
				return;
			}
			if (resolved.warning) runtime.ctx.showStatus(resolved.warning);
			await runtime.ctx.switchSessionModel(resolved.model, resolved.thinkingLevel);
		},
	},
	{
		name: "voice",
		get description() {
			return t("commands.modes.localVoiceDescription");
		},
		allowArgs: true,
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.modes.localVoiceOnDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.modes.localVoiceOffDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.modes.localVoiceStatusDescription");
				},
			},
		],
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleLocalVoiceCommand(command.args);
		},
	},
	{
		name: "fast",
		icon: "fast",
		get description() {
			return t("commands.modes.fastDescription");
		},
		get acpDescription() {
			return t("commands.modes.fastToggleDescription");
		},
		acpInputHint: "[on|ultra|off|status|force fast|force ultra]",
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.modes.fastOnDescription");
				},
			},
			{
				name: "ultra",
				get description() {
					return t("commands.modes.fastUltraDescription");
				},
			},
			{
				name: "force",
				get description() {
					return t("commands.modes.fastForceDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.modes.fastOffDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.modes.fastStatusDescription");
				},
			},
			{
				name: "toggle",
				get description() {
					return t("commands.modes.fastToggleDescription");
				},
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			t("commands.modes.fastStatus", {
				status: formatFastModeStatus(runtime.ctx.focusedAgentId ? runtime.ctx.viewSession : runtime.ctx.session),
			}),
		handle: async (command, runtime) => {
			const result = runFastCommand(command.args.trim().toLowerCase(), runtime.session);
			if (result === undefined) return usage(FAST_USAGE, runtime);
			await runtime.output(result.message);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const result = runFastCommand(command.args.trim().toLowerCase(), runtime.ctx.session);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(result?.message ?? FAST_USAGE);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "slow",
		icon: "fast",
		get description() {
			return t("commands.modes.slowDescription");
		},
		get acpDescription() {
			return t("commands.modes.slowToggleDescription");
		},
		acpInputHint: "[on|off|status]",
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.modes.slowOnDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.modes.slowOffDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.modes.slowStatusDescription");
				},
			},
			{
				name: "toggle",
				get description() {
					return t("commands.modes.slowToggleDescription");
				},
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.session.isSlowModeEnabled() ? t("commands.modes.slowOnStatus") : t("commands.modes.slowOffStatus"),
		handle: async (command, runtime) => {
			const message = runSlowCommand(command.args.trim().toLowerCase(), runtime.session);
			if (message === undefined) return usage(t("commands.modes.slowUsage"), runtime);
			await runtime.output(message);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const message = runSlowCommand(command.args.trim().toLowerCase(), runtime.ctx.session);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(message ?? t("commands.modes.slowUsage"));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "skillful",
		icon: "compass",
		get description() {
			return t("commands.modes.skillfulDescription");
		},
		get acpDescription() {
			return t("commands.modes.skillfulAcpDescription");
		},
		acpInputHint: "[on|off|status]",
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.modes.skillfulOnDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.modes.skillfulOffDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.modes.skillfulStatusDescription");
				},
			},
			{
				name: "toggle",
				get description() {
					return t("commands.modes.skillfulToggleDescription");
				},
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			t("commands.modes.skillfulStatus", {
				status: cfgSkillful.get(runtime.ctx.session.settings)
					? t("commands.modes.listOn")
					: t("commands.modes.listOff"),
			}),
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(
					t("commands.modes.skillfulOverride", {
						status: cfgSkillful.get(runtime.session.settings)
							? t("commands.modes.listOn")
							: t("commands.modes.listOff"),
					}),
				);
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.session.setSkillful(true)
						: arg === "off"
							? await runtime.session.setSkillful(false)
							: await runtime.session.toggleSkillful();
				await runtime.output(
					t("commands.modes.skillfulUpdated", {
						status: enabled ? t("commands.modes.listEnabled") : t("commands.modes.listDisabled"),
					}),
				);
				return commandConsumed();
			}
			return usage(t("commands.modes.skillfulUsage"), runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(
					t("commands.modes.skillfulCurrent", {
						status: cfgSkillful.get(runtime.ctx.session.settings)
							? t("commands.modes.listOn")
							: t("commands.modes.listOff"),
					}),
				);
				clearSubmittedText(runtime);
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.ctx.session.setSkillful(true)
						: arg === "off"
							? await runtime.ctx.session.setSkillful(false)
							: await runtime.ctx.session.toggleSkillful();
				runtime.ctx.showStatus(
					t("commands.modes.skillfulUpdated", {
						status: enabled ? t("commands.modes.listEnabled") : t("commands.modes.listDisabled"),
					}),
				);
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(t("commands.modes.skillfulUsage"));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "chat",
		icon: "prompt",
		get description() {
			return t("commands.modes.chatModeDescription");
		},
		get acpDescription() {
			return t("commands.modes.chatModeAcpDescription");
		},
		acpInputHint: "[chat|erp|raw|off] [--include <categories>]",
		subcommands: CHAT_SUBCOMMANDS,
		subcommandOptional: true,
		getTuiArgumentCompletions: (prefix, runtime) => completeCurrentArgument(prefix, runtime, chatArguments),
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			t("commands.modes.chatModeStatus", { mode: formatChatModeStatus(runtime.ctx.session.chatMode) }),
		handle: async (command, runtime) => {
			try {
				const next = await runtime.session.setChatMode(parseChatCommandArgs(command.args));
				await runtime.output(t("commands.modes.chatModeChanged", { mode: formatChatModeStatus(next) }));
			} catch (err) {
				await runtime.output(errorMessage(err));
			}
			return commandConsumed();
		},
	},
	{
		name: "extended-context",
		icon: "expand",
		get description() {
			return t("commands.modes.extendedDescription");
		},
		get acpDescription() {
			return t("commands.modes.extendedToggleDescription");
		},
		acpInputHint: "[on|off|status]",
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.modes.extendedOnDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.modes.extendedOffDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.modes.extendedStatusDescription");
				},
			},
			{
				name: "toggle",
				get description() {
					return t("commands.modes.extendedToggleDescription");
				},
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			t("commands.modes.extendedStatus", { status: formatExtendedContextStatus(runtime.ctx.settings) }),
		handle: async (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.settings, command.args);
			if (!output) return usage(t("commands.modes.extendedUsage"), runtime);
			await runtime.output(output);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.ctx.settings, command.args);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(output ?? t("commands.modes.extendedUsage"));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "computer",
		icon: "computer",
		get description() {
			return t("commands.modes.computerDescription");
		},
		get acpDescription() {
			return t("commands.modes.computerToggleDescription");
		},
		acpInputHint: "[on|off|status]",
		subcommands: [
			{
				name: "on",
				get description() {
					return t("commands.modes.computerOnDescription");
				},
			},
			{
				name: "off",
				get description() {
					return t("commands.modes.computerOffDescription");
				},
			},
			{
				name: "status",
				get description() {
					return t("commands.modes.computerStatusDescription");
				},
			},
			{
				name: "toggle",
				get description() {
					return t("commands.modes.computerToggleDescription");
				},
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			t("commands.modes.computerStatus", {
				status: cfgComputerEnabled.get(runtime.ctx.session.settings)
					? t("commands.modes.stateOn")
					: t("commands.modes.stateOff"),
			}),
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !cfgComputerEnabled.get(runtime.session.settings);
				await runtime.output(applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage(t("commands.modes.computerUsage"), runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(formatComputerUseStatus(runtime.ctx.session));
				clearSubmittedText(runtime);
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable =
					arg === "off" ? false : arg === "on" || !cfgComputerEnabled.get(runtime.ctx.session.settings);
				runtime.ctx.showStatus(applyComputerUseToggle(runtime.ctx.session, enable));
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus(t("commands.modes.computerUsage"));
			clearSubmittedText(runtime);
		},
	},
	{
		name: "ratchet",
		icon: "loop",
		get description() {
			return t("commands.modes.ratchetDescription");
		},
		get inlineHint() {
			return t("commands.modes.ratchetHint");
		},
		allowArgs: true,
		handle: (command, runtime) => {
			const armed = prepareRatchet(runtime.session, command.args);
			if ("error" in armed) return usage(armed.error, runtime);
			return { prompt: armed.kickoff };
		},
		handleTui: async (command, runtime) => {
			const { session } = runtime.ctx;
			const armed = prepareRatchet(session, command.args);
			clearSubmittedText(runtime);
			if ("error" in armed) {
				runtime.ctx.showWarning(armed.error);
				return;
			}
			// Same delivery as /guided-goal: the kickoff is a hidden developer message queued behind
			// any in-flight run; the agent's batched `ask` is the first thing the user sees.
			const images = runtime.input?.images?.length ? runtime.input.images : undefined;
			if (session.isStreaming) {
				await session.followUp(armed.kickoff, images, { synthetic: true });
				return;
			}
			try {
				await session.prompt(armed.kickoff, images ? { synthetic: true, images } : { synthetic: true });
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await session.followUp(armed.kickoff, images, { synthetic: true });
			}
		},
	},
	{
		name: "prewalk",
		icon: "prewalk",
		get description() {
			return t("commands.modes.prewalkDescription");
		},
		allowArgs: true,
		get acpDescription() {
			return t("commands.modes.prewalkAcpDescription");
		},
		acpInputHint: "[into] | restart [from] [into] | off",
		subcommands: PREWALK_SUBCOMMANDS,
		subcommandOptional: true,
		getTuiArgumentCompletions: completePrewalkArguments,
		handle: async (command, runtime) => {
			const [verb, ...rest] = command.args.trim().split(/\s+/).filter(Boolean);
			const keyword = verb?.toLowerCase();
			const restart = keyword === "restart";
			const args = restart || keyword === "off" ? rest : verb ? [verb, ...rest] : [];
			if (args.length > (restart ? 2 : keyword === "off" ? 0 : 1)) {
				return usage(t("commands.modes.prewalkUsage"), runtime);
			}
			if (keyword === "off") {
				const armed = runtime.session.getPrewalkState() !== undefined;
				runtime.session.disarmPrewalk();
				await runtime.output(armed ? t("commands.modes.prewalkCancelled") : t("commands.modes.prewalkAlreadyOff"));
				return commandConsumed();
			}
			const into = restart ? args[1] : args[0];
			const from = restart ? args[0] : undefined;
			const explicitTarget = into ? resolveSessionModelSelector(into, runtime.session, runtime.settings) : undefined;
			if (explicitTarget && (!explicitTarget.model || explicitTarget.error))
				return usage(explicitTarget.error ?? t("commands.modes.prewalkModelNotFound", { model: into }), runtime);
			const availableModels = runtime.session.scopedModels.map(entry => entry.model);
			const execution = explicitTarget?.model
				? { target: explicitTarget.model, thinkingLevel: explicitTarget.thinkingLevel }
				: resolvePrewalkCrewSelection(
						runtime.settings,
						runtime.session.modelRegistry,
						"execution",
						undefined,
						availableModels,
					);
			if (!execution) return usage(t("commands.modes.prewalkNoExecution"), runtime);
			const target = { model: execution.target, thinkingLevel: execution.thinkingLevel };
			if (!runtime.session.modelRegistry.hasConfiguredAuth(target.model))
				return usage(
					t("commands.modes.prewalkNoApiKey", { provider: target.model.provider, id: target.model.id }),
					runtime,
				);
			const configuredPlanner = getPrewalkPatterns(runtime.settings, "planner").length > 0;
			const planner = configuredPlanner
				? resolvePrewalkCrewSelection(
						runtime.settings,
						runtime.session.modelRegistry,
						"planner",
						undefined,
						availableModels,
					)
				: undefined;
			if (!from && configuredPlanner && !planner) return usage(t("commands.modes.prewalkNoPlanning"), runtime);
			if (restart || (planner && !runtime.session.getPrewalkState())) {
				const source = from
					? resolveSessionModelSelector(from, runtime.session, runtime.settings)
					: planner
						? { model: planner.target, thinkingLevel: planner.thinkingLevel, error: undefined }
						: resolveSessionModelSelector("@default", runtime.session, runtime.settings);
				if (source.error || !source.model) {
					return usage(source.error ?? t("commands.modes.prewalkModelNotFound", { model: String(from) }), runtime);
				}
				if (!runtime.session.modelRegistry.hasConfiguredAuth(source.model)) {
					return usage(
						t("commands.modes.prewalkNoApiKey", { provider: source.model.provider, id: source.model.id }),
						runtime,
					);
				}
				const result = await runtime.session.restartPrewalk(
					source.model,
					source.thinkingLevel,
					target.model,
					target.thinkingLevel,
				);
				if (result === "rejected") return commandConsumed();

				await runtime.output(
					result === "armed"
						? t("commands.modes.prewalkRestarted", {
								crew: describePrewalkCrew(
									{ target: source.model, thinkingLevel: source.thinkingLevel },
									execution,
								),
							})
						: t("commands.modes.prewalkReset"),
				);
				return commandConsumed();
			}
			const armed = runtime.session.armPrewalk(target.model, target.thinkingLevel);
			if (armed) {
				await runtime.output(
					t("commands.modes.prewalkArmed", { provider: target.model.provider, id: target.model.id }),
				);
			}
			return commandConsumed();
		},
	},
	{
		name: "modelpreset",
		icon: "model",
		get description() {
			return t("commands.modes.presetDescription");
		},
		get acpDescription() {
			return t("commands.modes.presetAcpDescription");
		},
		acpInputHint: "[list|save|switch|delete] [name]",
		inlineHint: "[save|switch|delete|list] [name]",
		subcommands: [
			{
				name: "list",
				get description() {
					return t("commands.modes.presetListDescription");
				},
			},
			{
				name: "save",
				get description() {
					return t("commands.modes.presetSaveDescription");
				},
				usage: "<name>",
			},
			{
				name: "switch",
				get description() {
					return t("commands.modes.presetApplyDescription");
				},
				usage: "<name>",
				arguments: [modelPresetNames(false)],
			},
			{
				name: "delete",
				get description() {
					return t("commands.modes.presetDeleteDescription");
				},
				usage: "<name>",
				arguments: [modelPresetNames(true)],
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = getModelPresetNames(runtime.ctx.settings).length;
			return count > 0 ? t("commands.modes.presetsSaved", { count }) : t("commands.modes.noPresets");
		},
		handle: async (command, runtime) => {
			const outcome = await runPresetsCommand(command.args, runtime.settings, runtime.session);
			if (outcome.usage) return usage(outcome.message, runtime);
			await runtime.output(outcome.message);
			if (outcome.switched) await runtime.notifyTitleChanged?.();
			if (outcome.changedConfig) await runtime.notifyConfigChanged?.();
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const { ctx } = runtime;
			let args = command.args;
			if (!args.trim()) {
				const names = getModelPresetNames(ctx.settings);
				if (names.length === 0) {
					ctx.showStatus(noPresetsMessage());
					return;
				}
				const picked = await ctx.showHookSelector(t("commands.modes.switchPreset"), names);
				if (picked === undefined) return;
				args = `switch ${picked}`;
			}
			const outcome = await runPresetsCommand(args, ctx.settings, ctx.session);
			if (outcome.switched) {
				ctx.statusLine.invalidate();
				ctx.updateEditorBorderColor();
			}
			if (outcome.failed || outcome.usage) ctx.showWarning(outcome.message);
			else ctx.showStatus(outcome.message);
			ctx.ui.requestRender();
		},
	},
	{
		name: "effort",
		icon: "gauge",
		get description() {
			return t("commands.modes.effortDescription", { key: formatKeyHint("shift+tab") });
		},
		get acpDescription() {
			return t("commands.modes.effortAcpDescription");
		},
		acpInputHint: "[level]",
		inlineHint: "[level]",
		allowArgs: true,
		subcommands: CLI_THINKING_LEVELS.map(level => ({
			name: level,
			description: getConfiguredThinkingLevelMetadata(level).description,
		})),
		getTuiAutocompleteDescription: runtime =>
			t("commands.modes.effortCurrent", {
				level: runtime.ctx.viewSession.configuredThinkingLevel() ?? t("commands.modes.effortDefault"),
			}),
		handle: async (command, runtime) => {
			const session = runtime.session;
			if (!command.args.trim()) {
				await runtime.output(
					session.model?.reasoning
						? t("commands.modes.effortAvailable", {
								level: session.configuredThinkingLevel() ?? t("commands.modes.effortDefault"),
								levels: session.getAvailableEffortSelectors().join(", "),
							})
						: noThinkingMessage(session),
				);
				return commandConsumed();
			}
			const resolved = resolveThinkingArgument(session, command.args);
			if ("error" in resolved) return usage(resolved.error, runtime);
			session.setThinkingLevel(resolved.level);
			await runtime.output(t("commands.modes.effortChanged", { level: resolved.level }));
			// `setThinkingLevel` emits `thinking_level_changed`, which hosts with a
			// session-lifetime subscription (ACP) already turn into a config push.
			await runtime.notifyConfigChanged?.({ handledBySessionEvent: true });
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			clearSubmittedText(runtime);
			const { ctx } = runtime;
			const session = ctx.viewSession;
			if (!command.args.trim()) {
				if (session.model?.reasoning) ctx.showThinkingSelector();
				else ctx.showStatus(noThinkingMessage(session));
				return;
			}
			const resolved = resolveThinkingArgument(session, command.args);
			if ("error" in resolved) {
				ctx.showError(resolved.error);
				return;
			}
			// thinking_level_changed refreshes the status line and editor border.
			session.setThinkingLevel(resolved.level);
			ctx.showStatus(t("commands.modes.effortChanged", { level: resolved.level }));
		},
	},
];

function presetUsage() {
	return t("commands.modes.presetUsage");
}
function noPresetsMessage() {
	return t("commands.modes.presetNoneHint");
}

interface PresetsCommandOutcome {
	message: string;
	usage?: boolean;
	failed?: boolean;
	switched?: boolean;
	changedConfig?: boolean;
}

/** Shared by the ACP and TUI handlers of `/modelpreset`; `args` is everything after the command name. */
async function runPresetsCommand(
	args: string,
	settings: Settings,
	session: ModelPresetSession,
): Promise<PresetsCommandOutcome> {
	const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const name = rest.join(" ");
	switch (sub) {
		case "list": {
			const names = getModelPresetNames(settings);
			return {
				message:
					names.length > 0 ? t("commands.modes.presetList", { names: names.join(", ") }) : noPresetsMessage(),
			};
		}
		case "save": {
			if (!name) return { message: t("commands.modes.presetSaveUsage"), usage: true };
			if (!isValidModelPresetName(name)) {
				return {
					message: t("commands.modes.presetInvalidName", { name }),
					usage: true,
				};
			}
			saveModelPreset(settings, name);
			return { message: modelPresetSavedMessage(settings, name), changedConfig: true };
		}
		case "switch": {
			if (!name) return { message: t("commands.modes.presetSwitchUsage"), usage: true };
			const result = await applyModelPreset(settings, session, name);
			const message = formatModelPresetSwitch(name, result);
			const wroteRoles = result.kind === "switched" || result.kind === "failed";
			return {
				message,
				failed: !isCleanModelPresetSwitch(result),
				switched: result.kind === "switched",
				changedConfig: wroteRoles,
			};
		}
		case "delete": {
			if (!name) return { message: t("commands.modes.presetDeleteUsage"), usage: true };
			const result = deleteModelPreset(settings, name);
			if (result === "deleted") return { message: t("commands.modes.presetDeleted", { name }), changedConfig: true };
			if (result === "project") {
				return {
					message: t("commands.modes.presetFromConfig", { name }),
					failed: true,
				};
			}
			return { message: t("commands.modes.presetNotFound", { name }), failed: true };
		}
		default:
			return { message: presetUsage(), usage: true };
	}
}

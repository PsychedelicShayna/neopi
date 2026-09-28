/**
 * NeoPi operator commands: `/persona`, `/loadout`, `/repl`, `/kernel`.
 */
import type { InteractiveModeContext } from "../modes/types";
import { type LoadoutHost, loadoutFeature } from "../neopi/loadout";
import {
	PERSONA_SUBCOMMANDS,
	PERSONA_USAGE,
	parsePersonaCommand,
	runPersonaCommand,
	sessionPersonaHost,
} from "../neopi/persona-config";
import { parseReplTarget, REPL_TARGETS, type ReplTarget, replTargetLabel } from "../neopi/repl";
import type { AgentSession } from "../session/agent-session";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

const LOADOUT_USAGE = "Usage: /loadout [set <name>|off|list|show <name>|status]";
const REPL_USAGE = "Usage: /repl [agent|js|py|bash]";
const KERNEL_USAGE = "Usage: /kernel [status|reset <py|js>|interrupt]";

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
		ctx.showStatus(data.items.length === 0 ? "No loadouts defined in neopi-loadout.json." : await loadouts.list());
		return;
	}
	const OFF = "Turn loadout off";
	const options = data.items.map(item => ({
		label: `${item.active ? "●" : "○"} ${item.name}`,
		description: item.loadout.mainModel,
	}));
	if (data.active) options.push({ label: OFF, description: `Restore the configured models (now: ${data.active})` });
	const picked = await ui.select(data.active ? `Loadouts · active: ${data.active}` : "Loadouts", options);
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
		`REPL target · now: ${replTargetLabel(current)}`,
		REPL_TARGETS.map(item => ({
			label: `${item.id === current ? "●" : "○"} ${item.label}`,
			description: item.id === "agent" ? "Composer sends prompts to the agent" : `Composer runs ${item.label} code`,
		})),
	);
	const target = REPL_TARGETS.find(item => picked?.slice(2) === item.label)?.id;
	if (target) setRepl(ctx, target);
}

function setRepl(ctx: InteractiveModeContext, target: ReplTarget): void {
	ctx.setReplTarget(target);
	ctx.showStatus(
		target === "agent"
			? "REPL off: the composer talks to the agent."
			: `REPL ${replTargetLabel(target)}: Enter inserts a newline; ${ctx.keybindings.getKeys("app.repl.execute").join(" / ")} runs the buffer.`,
	);
}

function kernelStatus(session: AgentSession): string {
	const state = (busy: boolean) => (busy ? "running" : "idle");
	return [
		`JavaScript: ${state(session.isEvalLanguageRunning("js"))}`,
		`Python: ${state(session.isEvalLanguageRunning("py"))}`,
		`Bash: ${state(session.isBashRunning)}`,
	].join("\n");
}

export const BUILTIN_NEOPI_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "persona",
		icon: "prompt",
		description: "Edit and switch system-prompt personas; `/persona live` does the same for the voice model",
		acpDescription: "Switch or inspect system-prompt and live-voice personas",
		acpInputHint: "[live] [set <name>|off|list|show <name>|status|clone <source> <name>|delete <name>]",
		subcommands: PERSONA_SUBCOMMANDS.map(item => ({ ...item })),
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
		name: "loadout",
		icon: "swap",
		description: "Switch runtime model loadouts (model roles, fallback chains, task-agent models)",
		acpInputHint: "[set <name>|off|list|show <name>|status]",
		subcommands: [
			{ name: "set", description: "Apply a loadout", usage: "<name>" },
			{ name: "off", description: "Restore the configured models" },
			{ name: "list", description: "List loadouts; * marks the active one" },
			{ name: "show", description: "Print a loadout definition", usage: "<name>" },
			{ name: "status", description: "Show the active loadout" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			try {
				const message = await runLoadoutCommand(command.args, loadoutHost(runtime.session));
				if (message === undefined) return usage(LOADOUT_USAGE, runtime);
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
				if (message === undefined) ctx.showError(LOADOUT_USAGE);
				else ctx.showStatus(message);
			} catch (error) {
				ctx.showError(errorMessage(error));
			}
		},
	},
	{
		name: "repl",
		icon: "computer",
		description: "Point the composer at a kernel (JavaScript, Python, Bash) or back at the agent",
		acpDescription: "REPL mode (interactive TUI only)",
		subcommands: REPL_TARGETS.map(item => ({
			name: item.id,
			description: item.id === "agent" ? "Leave REPL mode" : `Run composer text as ${item.label}`,
		})),
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.replMode.active ? `REPL: ${replTargetLabel(runtime.ctx.replMode.target)}` : undefined,
		handle: async (_command, runtime) =>
			usage("/repl switches the interactive composer and is only available in the TUI.", runtime),
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
				ctx.showError(REPL_USAGE);
				return;
			}
			setRepl(ctx, target);
		},
	},
	{
		name: "kernel",
		icon: "restart",
		description: "Show, reset, or interrupt the REPL kernels",
		acpInputHint: "[status|interrupt]",
		subcommands: [
			{ name: "status", description: "Show which kernels are running" },
			{ name: "reset", description: "Start the next cell in a fresh kernel", usage: "<py|js>" },
			{ name: "interrupt", description: "Cancel running eval and bash cells" },
		],
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
				await runtime.output("Interrupted running kernels.");
				return commandConsumed();
			}
			return usage(KERNEL_USAGE, runtime);
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
				ctx.showStatus("Interrupted running kernels.");
				return;
			}
			const kernel = parseReplTarget(rest);
			if (verb === "reset" && (kernel === "py" || kernel === "js")) {
				ctx.replMode.requestReset(kernel);
				ctx.showStatus(`The next ${replTargetLabel(kernel)} cell starts in a fresh kernel.`);
				return;
			}
			ctx.showError(KERNEL_USAGE);
		},
	},
];

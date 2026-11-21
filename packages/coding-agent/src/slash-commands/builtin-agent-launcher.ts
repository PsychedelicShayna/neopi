import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { completeSpawnTypes, createAgentLauncher, parseSpawnArguments } from "../neopi/agent-launcher";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, errorMessage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const SPAWN_COMMAND: SlashCommandSpec = {
	name: "spawn",
	icon: "agents",
	description: "Launch an agent from its definition or edit its launch settings",
	allowArgs: true,
	getTuiInlineHint: prefix => (prefix.trim() ? null : "<type>[spec] [assignment]"),
	inlineHint: "[type[spec] [assignment]]",
	getTuiArgumentCompletions: (prefix, runtime) => (runtime ? completeSpawnTypes(runtime.ctx.session, prefix) : null),
	handle: async (command, runtime) => {
		const input = parseSpawnArguments(command.args);
		if (!input?.assignment.trim()) {
			await runtime.output(
				"Use /spawn <type>[spec] <assignment>. The launcher and assignment editor require the TUI.",
			);
			return commandConsumed({ failed: true });
		}
		try {
			const launcher = await createAgentLauncher(runtime.session);
			const draft = launcher.resolveSpec(input.spec);
			draft.assignment = input.assignment;
			await runtime.output(await launcher.launch(draft, runtime.signal));
		} catch (error) {
			await runtime.output(errorMessage(error));
			return commandConsumed({ failed: true });
		}
	},
	handleTui: async (command, runtime) => {
		clearSubmittedText(runtime);
		try {
			const input = parseSpawnArguments(command.args);
			const launcher = await createAgentLauncher(runtime.ctx.session);
			const draft = input ? launcher.resolveSpec(input.spec) : await runtime.ctx.showSpawn(launcher);
			if (!draft) return;
			if (input) {
				const assignment = input.assignment.trim() ? input.assignment : await runtime.ctx.showSpawnAssignment();
				if (assignment === undefined) return;
				draft.assignment = assignment;
			}
			runtime.ctx.showStatus(sanitizeDisplayLine(await launcher.launch(draft)));
		} catch (error) {
			runtime.ctx.showError(sanitizeDisplayLine(errorMessage(error)));
		}
	},
};

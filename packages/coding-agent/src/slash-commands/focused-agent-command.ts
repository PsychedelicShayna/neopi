import { type ControlActor, runAsControlCommand } from "../control/actor";
import type { AgentSession } from "../session/agent-session";
import { executeAcpBuiltinSlashCommand } from "./builtin-registry";
import type { AcpBuiltinSlashCommandResult } from "./types";

export interface FocusedAgentCommandResult {
	result: AcpBuiltinSlashCommandResult;
	output: string[];
}

/** Run the headless builtin against the actual session on its home thread. */
export async function runFocusedAgentCommand(
	session: AgentSession,
	text: string,
	actor?: ControlActor,
): Promise<FocusedAgentCommandResult> {
	const output: string[] = [];
	const result = await runAsControlCommand(actor, () =>
		executeAcpBuiltinSlashCommand(text, {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			output: text => {
				output.push(text);
			},
			cwd: session.sessionManager.getCwd(),
			reloadPlugins: async () => {
				throw new Error("Reload plugins from the main session.");
			},
			refreshCommands: () => {},
		}),
	);
	return { result, output };
}

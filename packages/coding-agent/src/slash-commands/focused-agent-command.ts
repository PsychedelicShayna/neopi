import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type ControlActor, runAsControlCommand } from "../control/actor";
import type { AgentSession } from "../session/agent-session";
import { type AgentViewSession, isLocalAgentSession } from "../session/agent-session-handle";
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
	images?: ImageContent[],
): Promise<FocusedAgentCommandResult> {
	const output: string[] = [];
	const result = await runAsControlCommand(actor, () =>
		executeAcpBuiltinSlashCommand(text, {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			focusedInput: { images },
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

export function dispatchFocusedAgentCommand(
	target: AgentViewSession,
	text: string,
	actor?: ControlActor,
	images?: ImageContent[],
): Promise<FocusedAgentCommandResult> | undefined {
	return isLocalAgentSession(target)
		? runFocusedAgentCommand(target, text, actor, images)
		: target.runFocusedAgentCommand?.(text, actor, images);
}

/**
 * The 53 RPC commands, executed against the live session (#171).
 *
 * Control connections and stdio share these session methods. The control host
 * supplies output, prompt-result tickets, and an optional presenter so a TUI
 * process renders the same effects a keyboard command would.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { AgentSession } from "../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { calculateTokensPerSecond } from "../utils/token-rate";
import { buildAvailableSlashCommands } from "../slash-commands/available-commands";
import { selectRpcEntries } from "../modes/rpc/rpc-compat";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "../modes/rpc/rpc-messages";
import { applyRpcQueueModeCommand, handleRpcSessionChange, openRpcSession } from "../modes/rpc/rpc-mode";
import { setRpcChatMode } from "../modes/rpc/rpc-chat-mode";
import { isRpcSessionSettled } from "../modes/rpc/rpc-session-settle";
import { sessionLeaseErrorCode } from "../modes/rpc/rpc-session-lease";
import { getRpcUsage, RpcUsageUnavailableError } from "../modes/rpc/rpc-usage";
import { RpcRoles } from "../modes/rpc/rpc-roles";
import type { RpcCommand, RpcSessionState } from "../modes/rpc/rpc-types";
import type { ControlOrigin } from "./types";

export interface SessionCommandContext {
	session: AgentSession;
	roles: RpcRoles;
	origin?: ControlOrigin;
	/** Request handle bound as the run owner of prompt-family work. */
	runOwner?: string;
	output: (frame: object) => void;
	planSetMode?: (mode: string, planFilePath?: string) => Promise<object>;
}

export interface SessionCommandResult {
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
	/** Prompt-family: a receipt will follow. */
	agentInvoked?: boolean;
}

/** Execute one RPC command. Unknown types return success:false. */
export async function executeSessionCommand(
	command: RpcCommand,
	ctx: SessionCommandContext,
): Promise<SessionCommandResult> {
	const session = ctx.session;
	const origin = ctx.origin;
	try {
		switch (command.type) {
			case "negotiate_protocol":
				return command.protocolVersion === 2
					? { success: true, data: { protocolVersion: 2 } }
					: { success: false, error: `Unsupported RPC protocol version: ${command.protocolVersion}` };
			case "prompt": {
				const invoked = await session.prompt(command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					origin,
					runOwner: ctx.runOwner,
				});
				return { success: true, data: { agentInvoked: invoked, delivery: invoked ? "started" : "local" }, agentInvoked: invoked };
			}
			case "steer": {
				const userEntryId = session.sessionManager.reserveEntryId();
				await session.steer(command.message, command.images, { entryId: userEntryId, origin });
				return { success: true, data: { userEntryId, delivery: "steered" } };
			}
			case "follow_up": {
				const userEntryId = session.sessionManager.reserveEntryId();
				await session.followUp(command.message, command.images, { entryId: userEntryId, origin });
				return { success: true, data: { userEntryId, delivery: "followUp" } };
			}
			case "abort":
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return { success: true };
			case "abort_and_prompt": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				const invoked = await session.prompt(command.message, {
					images: command.images,
					origin,
					runOwner: ctx.runOwner,
				});
				return { success: true, data: { agentInvoked: invoked }, agentInvoked: invoked };
			}
			case "new_session":
			case "switch_session":
			case "branch": {
				try {
					const result = await handleRpcSessionChange(session, command);
					return { success: true, data: result.data };
				} catch (error) {
					const code = sessionLeaseErrorCode(error);
					if (code) return { success: false, error: error instanceof Error ? error.message : String(error), code };
					throw error;
				}
			}
			case "open_session": {
				try {
					return { success: true, data: await openRpcSession(session, command.sessionDir) };
				} catch (error) {
					const code = sessionLeaseErrorCode(error);
					if (code) return { success: false, error: error instanceof Error ? error.message : String(error), code };
					throw error;
				}
			}
			case "get_state":
				return { success: true, data: sessionState(session, ctx) };
			case "set_fast_mode": {
				const supported = session.setFastMode(command.enabled);
				if (command.enabled && !supported)
					return { success: false, error: "Fast mode is unavailable for the current model." };
				return { success: true, data: { enabled: session.isFastModeEnabled(), active: session.isFastModeActive() } };
			}
			case "set_chat_mode": {
				const outcome = await setRpcChatMode(session, command);
				if (!outcome.ok) return { success: false, error: outcome.message, code: outcome.code };
				return { success: true, data: outcome.state };
			}
			case "set_mode": {
				if (!ctx.planSetMode) return { success: false, error: "plan mode is not available on this host", code: "plan_disabled" };
				return { success: true, data: await ctx.planSetMode(command.mode, command.planFilePath) };
			}
			case "get_available_commands":
				return { success: true, data: { commands: await buildAvailableSlashCommands(session) } };
			case "get_entries":
				try {
					return {
						success: true,
						data: selectRpcEntries(session.sessionManager.getEntries(), session.sessionManager.getLeafId(), command.since),
					};
				} catch (error) {
					return { success: false, error: error instanceof Error ? error.message : String(error), code: "unknown_since" };
				}
			case "get_tree":
				return { success: true, data: { tree: session.sessionManager.getTree(), leafId: session.sessionManager.getLeafId() } };
			case "set_todos":
				session.setTodoPhases(command.phases);
				return { success: true, data: { todoPhases: session.getTodoPhases() } };
			case "set_model": {
				let models = session.getAvailableModels();
				let model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					await session.modelRegistry.awaitBackgroundRefresh();
					models = session.getAvailableModels();
					model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				}
				if (!model) return { success: false, error: `Model not found: ${command.provider}/${command.modelId}` };
				await session.setModel(model);
				return { success: true, data: model };
			}
			case "cycle_model":
				return { success: true, data: (await session.cycleModel()) ?? null };
			case "get_available_models":
				await session.modelRegistry.awaitBackgroundRefresh();
				return { success: true, data: { models: session.getAvailableModels() } };
			case "get_roles":
				await session.modelRegistry.awaitBackgroundRefresh();
				return { success: true, data: ctx.roles.list() };
			case "set_role": {
				const result = await ctx.roles.setRole(command.role);
				if (!result.ok) return { success: false, error: result.message, code: result.code };
				ctx.output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
				return { success: true, data: result.data };
			}
			case "set_thinking_level":
				session.setThinkingLevel(command.level);
				return { success: true };
			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				return { success: true, data: level ? { level } : null };
			}
			case "get_available_thinking_levels":
				return { success: true, data: { levels: [ThinkingLevel.Off, ...session.getAvailableThinkingLevels()] } };
			case "set_steering_mode":
			case "set_follow_up_mode":
			case "set_interrupt_mode":
				applyRpcQueueModeCommand(session, command);
				return { success: true };
			case "compact":
				return { success: true, data: await session.compact(command.customInstructions) };
			case "set_auto_compaction":
				session.setAutoCompactionEnabled(command.enabled);
				return { success: true };
			case "set_auto_retry":
				session.setAutoRetryEnabled(command.enabled);
				return { success: true };
			case "abort_retry":
				session.abortRetry();
				return { success: true };
			case "bash":
				return { success: true, data: await session.executeBash(command.command) };
			case "abort_bash":
				session.abortBash();
				return { success: true };
			case "get_session_stats":
				return { success: true, data: session.getSessionStats() };
			case "get_usage":
				try {
					return {
						success: true,
						data: await getRpcUsage(
							{ authStorage: session.modelRegistry.authStorage, fetchUsageReports: () => session.fetchUsageReports() },
							command,
						),
					};
				} catch (error) {
					if (error instanceof RpcUsageUnavailableError) return { success: false, error: error.message, code: error.code };
					throw error;
				}
			case "export_html":
				return { success: true, data: { path: await session.exportToHtml(command.outputPath) } };
			case "get_branch_messages":
				return { success: true, data: { messages: session.getUserMessagesForBranching() } };
			case "get_last_assistant_text":
				return { success: true, data: { text: session.getLastAssistantText() } };
			case "set_session_name": {
				const name = command.name.trim();
				if (!name || !(await session.setSessionName(name, "user")))
					return { success: false, error: "Session name cannot be empty" };
				return { success: true };
			}
			case "handoff":
				if (session.isStreaming) return { success: false, error: "Cannot hand off while a response is in progress" };
				return { success: true, data: await session.handoff(command.customInstructions) };
			case "get_messages":
				return { success: true, data: { messages: session.messages } };
			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return { success: false, error: RPC_MESSAGES_PAGE_BUSY_ERROR, code: "session_busy" };
				try {
					return {
						success: true,
						data: pageRpcMessages(
							session.messages,
							{ sessionId: session.sessionId, leafId: session.sessionManager.getLeafId(), messageCount: session.messages.length },
							{ cursor: command.cursor, limit: command.limit },
						),
					};
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
						code: error instanceof RpcMessagesPageError ? error.code : undefined,
					};
				}
			}
			case "get_login_providers":
				return {
					success: true,
					data: {
						providers: getOAuthProviders().map(provider => ({
							id: provider.id,
							name: provider.name,
							available: provider.available,
							authenticated: session.modelRegistry.authStorage.keys.source(provider.id) !== undefined,
						})),
					},
				};
			case "login":
				return { success: false, error: "login over control uses the pane dialog; use the login control command", code: "no_tui" };
			default:
				return { success: false, error: `Unknown command: ${(command as { type: string }).type}` };
		}
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function sessionState(session: AgentSession, ctx: SessionCommandContext): RpcSessionState {
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		queuedMessageCount: session.queuedMessageCount,
		hasPendingAsyncWork: session.hasPendingAsyncWork(),
		isSettled: isRpcSessionSettled(session),
		todoPhases: session.getTodoPhases(),
		fastModeEnabled: session.isFastModeEnabled(),
		tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
		fastModeActive: session.isFastModeActive(),
		messageCount: session.messages.length,
		systemPrompt: session.systemPrompt,
		dumpTools: session.agent.state.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: toolWireSchema(tool),
			examples: tool.examples,
		})),
		contextUsage: session.getContextUsage(),
		activeRole: ctx.roles.activeRole(),
		chatMode: session.chatMode?.mode ?? "off",
		mode: "default",
	};
}

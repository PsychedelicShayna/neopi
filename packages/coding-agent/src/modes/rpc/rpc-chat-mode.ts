/**
 * RPC `set_chat_mode`: switch chat mode on the live session. The session
 * rebuilds its system prompt, journals the change, and emits
 * `chat_mode_changed`; this module only validates the wire frame.
 */
import { type ChatModeState, chatModeState, parseChatModeSetting, splitChatIncludes } from "../../chat/chat-mode";
import type { AgentSession } from "../../session/agent-session";

export type RpcSetChatModeOutcome =
	| { ok: true; state: ChatModeState }
	| { ok: false; message: string; code?: "session_busy" };

/** Apply a `set_chat_mode` frame. `include` accepts a comma-separated string or a string array. */
export async function setRpcChatMode(
	session: Pick<AgentSession, "isStreaming" | "setChatMode">,
	frame: { mode?: unknown; include?: unknown },
): Promise<RpcSetChatModeOutcome> {
	if (session.isStreaming) {
		return { ok: false, message: "Change chat mode after the current turn finishes.", code: "session_busy" };
	}
	if (typeof frame.mode !== "string") {
		return { ok: false, message: "set_chat_mode requires mode: off, chat, erp, or raw." };
	}
	let include: string[] | undefined;
	if (typeof frame.include === "string") {
		include = splitChatIncludes([frame.include]);
	} else if (Array.isArray(frame.include) && frame.include.every(item => typeof item === "string")) {
		include = splitChatIncludes(frame.include);
	} else if (frame.include !== undefined) {
		return { ok: false, message: "set_chat_mode include must be a comma-separated string or a string array." };
	}
	try {
		const next = await session.setChatMode({ mode: parseChatModeSetting(frame.mode), include });
		return { ok: true, state: chatModeState(next) };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}

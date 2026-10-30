import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../session/agent-session";
import type { SessionContext, TranscriptSessionContextOptions } from "../session/session-context";

/** Transcript capabilities shared by an in-process session and a daemon viewer. */
export interface InteractiveSessionViewer {
	readonly sessionManager: Pick<
		AgentSession["sessionManager"],
		"getEntries" | "getCwd" | "getSessionId" | "getSessionFile"
	> & Partial<Pick<AgentSession["sessionManager"], "putBlobSync">>;
	buildTranscriptSessionContext(options?: TranscriptSessionContextOptions): SessionContext;
	readonly messages: readonly AgentMessage[];
	readonly isStreaming: boolean;
	readonly model?: AgentSession["model"];
	readonly thinkingLevel?: AgentSession["thinkingLevel"];
	readonly extensionRunner?: AgentSession["extensionRunner"];
	readonly retryAttempt?: AgentSession["retryAttempt"];
	readonly isRetrying?: AgentSession["isRetrying"];
	readonly isAborting?: AgentSession["isAborting"];
	readonly isTtsrAbortPending?: AgentSession["isTtsrAbortPending"];
	readonly getToolByName?: AgentSession["getToolByName"];
	readonly hasBuiltInTool?: AgentSession["hasBuiltInTool"];
	readonly activeToolExecutionUpdates?: AgentSession["activeToolExecutionUpdates"];
	readonly getAsyncJobSnapshot?: AgentSession["getAsyncJobSnapshot"];
	readonly getQueuedMessages?: AgentSession["getQueuedMessages"];
}

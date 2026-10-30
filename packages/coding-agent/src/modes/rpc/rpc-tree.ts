import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type } from "@oh-my-pi/omptype";
import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";
import type { AgentSession } from "../../session/agent-session";
import type { BranchSummaryEntry } from "../../session/session-entries";
import { TreeNavigationError, type TreeNavigationExpected } from "../../session/tree-navigation";
import type { RpcAskDialogQuestion } from "./rpc-types";

/** Fields consumed by the native ask re-answer operation. */
export type RpcTreeAskReanswer = Pick<AgentToolResult<AskToolDetails>, "content" | "details" | "isError">;

export interface RpcNavigateTreeOptions extends TreeNavigationExpected {
	targetId: string;
	summarize?: boolean;
	customInstructions?: string;
	allowAskReopen?: boolean;
	reanswerAskResult?: RpcTreeAskReanswer;
}

export interface RpcResumeTreeOptions extends TreeNavigationExpected {
	resumeToken: string;
}

export interface RpcNavigateTreeResult {
	sessionId: string;
	sessionFile?: string;
	leafId: string | null;
	outcome: "navigated" | "unchanged" | "cancelled" | "ask_reopen";
	cancelled: boolean;
	aborted?: boolean;
	editorText?: string;
	editorImages?: ImageContent[];
	summaryEntry?: BranchSummaryEntry;
	reopenAsk?: { toolCallId: string; questions: RpcAskDialogQuestion[] };
	askReanswerCommitted?: boolean;
	resumeToken?: string;
}

export interface RpcResumeTreeResult {
	resumed: true;
}

const optionNote = { option: "string", note: "string" } as const;
const answerMetadata = {
	"customInput?": "string",
	"note?": "string",
	"optionNotes?": [optionNote, "[]"],
	"noteOption?": "string",
	"timedOut?": "boolean",
} as const;
const reanswerSchema = type({
	content: [
		[
			{ type: "'text'", text: "string", "textSignature?": "string" },
			"|",
			{
				type: "'image'",
				data: "string",
				mimeType: "string",
			},
		],
		"[]",
	],
	"details?": {
		...answerMetadata,
		"question?": "string",
		"options?": "string[]",
		"multi?": "boolean",
		"selectedOptions?": "string[]",
		"results?": [
			{
				...answerMetadata,
				id: "string",
				question: "string",
				options: "string[]",
				multi: "boolean",
				selectedOptions: "string[]",
			},
			"[]",
		],
		"chatRedirect?": "boolean",
		"questions?": "string[]",
	},
	"isError?": "boolean",
});

function validateExpected(options: TreeNavigationExpected): void {
	if (
		typeof options.expectedSessionId !== "string" ||
		!options.expectedSessionId ||
		!(
			options.expectedSessionFile === null ||
			(typeof options.expectedSessionFile === "string" && options.expectedSessionFile.length > 0)
		) ||
		!(
			options.expectedLeafId === null ||
			(typeof options.expectedLeafId === "string" && options.expectedLeafId.length > 0)
		)
	) {
		throw new TreeNavigationError(
			"invalid_request",
			"Expected native session ID, session file and leaf are required",
		);
	}
}

/** Same owner and same native navigation operation for headless and terminal control clients. */
export async function navigateRpcTree(
	session: AgentSession,
	options: RpcNavigateTreeOptions,
	onRemoteAdmitted?: () => Promise<void>,
): Promise<RpcNavigateTreeResult> {
	validateExpected(options);
	if (
		typeof options.targetId !== "string" ||
		!options.targetId ||
		(options.summarize !== undefined && typeof options.summarize !== "boolean") ||
		(options.customInstructions !== undefined && typeof options.customInstructions !== "string") ||
		(options.allowAskReopen !== undefined && typeof options.allowAskReopen !== "boolean") ||
		(options.reanswerAskResult !== undefined &&
			(!options.allowAskReopen || !reanswerSchema.allows(options.reanswerAskResult)))
	) {
		throw new TreeNavigationError("invalid_request", "Invalid native tree navigation options");
	}
	const result = await session.navigateTree(options.targetId, {
		expected: options,
		onRemoteAdmitted,
		summarize: options.summarize,
		customInstructions: options.customInstructions,
		allowAskReopen: options.allowAskReopen,
		reanswerAskResult: options.reanswerAskResult,
	});
	const state = result.navigationState;
	if (!state) throw new Error("Native tree navigation did not return its admitted identity");
	const { leafId } = state;
	return {
		...state,
		outcome: result.cancelled
			? "cancelled"
			: result.reopenAsk
				? "ask_reopen"
				: leafId === options.expectedLeafId
					? "unchanged"
					: "navigated",
		cancelled: result.cancelled,
		aborted: result.aborted,
		editorText: result.editorText,
		editorImages: result.editorImages,
		summaryEntry: result.summaryEntry,
		reopenAsk: result.reopenAsk,
		askReanswerCommitted: result.askReanswerCommitted,
		resumeToken: result.resumeToken,
	};
}

/** Explicit client acknowledgement after it has consumed navigation and rebuilt its transcript. */
export function resumeRpcTree(session: AgentSession, options: RpcResumeTreeOptions): RpcResumeTreeResult {
	validateExpected(options);
	if (typeof options.resumeToken !== "string" || !options.resumeToken) {
		throw new TreeNavigationError("invalid_request", "A committed tree re-answer resume token is required");
	}
	session.resumeAfterAskReanswer({ expected: options, resumeToken: options.resumeToken });
	return { resumed: true };
}

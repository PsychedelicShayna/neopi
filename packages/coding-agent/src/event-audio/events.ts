import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { isSilentAbort, isUserInterruptAbort } from "../session/messages";

/** Authoritative IDs accepted by the player. No ID selects a sound by itself. */
export const EVENT_AUDIO_IDS = new Set([
	"agent.start",
	"agent.complete",
	"agent.pause",
	"turn.start",
	"turn.end",
	"message.start",
	"message.end",
	"stream.start",
	"stream.done",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"text.start",
	"text.delta",
	"text.end",
	"image.end",
	"toolcall.start",
	"toolcall.delta",
	"toolcall.end",
	"tool.start",
	"tool.progress",
	"tool.preview",
	"tool.success",
	"edit.start",
	"edit.complete",
	"todo.changed",
	"todo.reminder",
	"todo.auto_clear",
	"reminder.rule",
	"bash.start",
	"bash.progress",
	"bash.end",
	"eval.start",
	"eval.progress",
	"eval.end",
	"eval.phase",
	"eval.log",
	"eval.python.start",
	"eval.python.progress",
	"eval.python.end",
	"eval.python.error",
	"eval.js.start",
	"eval.js.progress",
	"eval.js.end",
	"eval.js.error",
	"async.result",
	"async.register",
	"async.background",
	"async.progress",
	"async.complete",
	"async.failed",
	"async.cancelled",
	"subagent.start",
	"subagent.wake",
	"subagent.follow_up",
	"subagent.progress",
	"subagent.event",
	"subagent.complete",
	"subagent.failed",
	"subagent.aborted",
	"irc.incoming",
	"irc.relay",
	"error.provider",
	"error.tool",
	"error.harness",
	"error.interrupt",
	"error.silent_abort",
	"retry.start",
	"retry.success",
	"retry.exhausted",
	"fallback.applied",
	"fallback.succeeded",
	"notice.info",
	"notice.warning",
	"config.warnings",
	"compaction.start",
	"compaction.end",
	"cache.start",
	"cache.end",
	"model.changed",
	"thinking_level.changed",
	"goal.updated",
	"chat_mode.changed",
	"queue.updated",
	"owners.joined",
	"owners.skipped",
	"advisor.cost",
	"advisor.yield",
	"advisor.message",
	"mixture.hop_end",
	"mixture.decision",
	"mixture.limit",
	"mixture.checkpoint",
	"mixture.run_end",
]);

const SESSION_IDS: Readonly<Record<string, string>> = {
	agent_start: "agent.start",
	turn_start: "turn.start",
	turn_end: "turn.end",
	auto_compaction_start: "compaction.start",
	auto_compaction_end: "compaction.end",
	cache_warming_start: "cache.start",
	cache_warming_end: "cache.end",
	auto_retry_start: "retry.start",
	retry_fallback_applied: "fallback.applied",
	retry_fallback_succeeded: "fallback.succeeded",
	model_changed: "model.changed",
	config_warnings_changed: "config.warnings",
	thinking_level_changed: "thinking_level.changed",
	goal_updated: "goal.updated",
	chat_mode_changed: "chat_mode.changed",
	queue_update: "queue.updated",
	run_owners_joined: "owners.joined",
	run_owners_skipped: "owners.skipped",
	advisor_cost_changed: "advisor.cost",
	advisor_yielded: "advisor.yield",
	advisor_message: "advisor.message",
	todo_reminder: "todo.reminder",
	todo_auto_clear: "todo.auto_clear",
	ttsr_triggered: "reminder.rule",
	mixture_hop_end: "mixture.hop_end",
	mixture_decision: "mixture.decision",
	mixture_limit: "mixture.limit",
	mixture_checkpoint: "mixture.checkpoint",
	mixture_run_end: "mixture.run_end",
};

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function assistantFailure(message: AssistantMessage): string | undefined {
	if (message.stopReason === "aborted") {
		if (isSilentAbort(message)) return "error.silent_abort";
		if (isUserInterruptAbort(message)) return "error.interrupt";
		return undefined; // An unclassified abort is not evidence of a provider or user error.
	}
	return message.stopReason === "error" ? "error.provider" : undefined;
}

/** Specific candidates precede generic fallbacks; at most one mapped cue plays per source frame. */
export function sessionAudioEvents(event: AgentSessionEvent, toolArgs?: unknown): string[] {
	const direct = SESSION_IDS[event.type];
	if (direct) return [direct];
	switch (event.type) {
		case "agent_pause":
			return ["agent.pause"];
		case "agent_end": {
			const message = event.messages.findLast(candidate => candidate.role === "assistant");
			if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
				const failure = assistantFailure(message);
				return failure ? [failure] : [];
			}
			return ["agent.complete"];
		}
		case "auto_retry_end":
			return [event.success ? "retry.success" : "retry.exhausted"];
		case "notice":
			return [event.level === "error" ? "error.harness" : `notice.${event.level}`];
		case "irc_message":
			return event.message.customType === "irc:relay" ? ["irc.relay"] : ["irc.incoming"];
		case "message_start":
		case "message_end": {
			const ids: string[] = [];
			if (event.type === "message_end" && event.message.role === "assistant") {
				const failure = assistantFailure(event.message);
				if (failure) ids.push(failure);
			}
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "async-result"
			)
				ids.push("async.result");
			ids.push(event.type === "message_start" ? "message.start" : "message.end");
			return ids;
		}
		case "message_update": {
			const part = event.assistantMessageEvent;
			if (part.type === "error") {
				const failure = assistantFailure(part.error);
				return failure ? [failure] : [];
			}
			return [
				part.type === "start" ? "stream.start" : part.type === "done" ? "stream.done" : part.type.replace("_", "."),
			];
		}
		case "tool_stream_update":
			return ["tool.preview"];
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end": {
			const start = event.type === "tool_execution_start";
			const end = event.type === "tool_execution_end";
			const result = record(
				end ? event.result : event.type === "tool_execution_update" ? event.partialResult : undefined,
			);
			const details = record(result?.details);
			const files = Array.isArray(details?.perFileResults) ? details.perFileResults : [];
			const cells = Array.isArray(details?.cells) ? details.cells : [];
			const failed =
				end &&
				(event.isError ||
					result?.isError === true ||
					details?.isError === true ||
					files.some(file => record(file)?.isError === true) ||
					cells.some(cell => record(cell)?.status === "error"));
			const ids: string[] = failed ? ["error.tool"] : [];
			const phase = start ? "start" : end ? "end" : "progress";
			if (event.toolName === "eval") {
				const args = record(start ? event.args : toolArgs);
				const languages = new Set<string>();
				const addLanguage = (language: string): void => {
					languages.add(language === "py" ? "python" : language === "javascript" ? "js" : language);
				};
				if (typeof args?.language === "string") addLanguage(args.language);
				if (Array.isArray(args?.cells))
					for (const cell of args.cells) {
						const language = record(cell)?.language;
						if (typeof language === "string") addLanguage(language);
					}
				if (typeof details?.language === "string") addLanguage(details.language);
				for (const cell of cells) {
					const row = record(cell);
					if (row?.language === "python" || row?.language === "js") {
						languages.add(row.language);
						if (row.status === "error") ids.unshift(`eval.${row.language}.error`);
					}
				}
				for (const language of languages)
					if (language === "python" || language === "js") ids.push(`eval.${language}.${phase}`);
				ids.push(`eval.${phase}`);
			}
			if (event.toolName === "bash") ids.push(`bash.${phase}`);
			if (event.toolName === "edit" && (start || end)) ids.push(start ? "edit.start" : "edit.complete");
			if (end && !failed && event.toolName === "todo" && Array.isArray(details?.phases)) ids.push("todo.changed");
			ids.push(start ? "tool.start" : end ? (failed ? "error.tool" : "tool.success") : "tool.progress");
			return ids;
		}
		default:
			return [];
	}
}

export function isStreamingCue(id: string): boolean {
	return (
		id.endsWith(".delta") ||
		id.endsWith(".progress") ||
		id === "tool.preview" ||
		id === "subagent.event" ||
		id === "eval.log"
	);
}

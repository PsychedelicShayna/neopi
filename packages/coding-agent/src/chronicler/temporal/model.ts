/**
 * One-shot text completions for temporal summaries and recall ranking,
 * resolved through the `chronicler-summary` role (which falls back to the
 * `chronicler` capture role, then the `slow` chain).
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Api, type ApiKey, completeSimple, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "../../config/model-registry";
import { formatModelString, resolveChronicleSummaryRoleSelection } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";

export interface ChronicleModelClient {
	/** `provider/model:thinking` — part of every generated node's identity. */
	readonly identity: string;
	complete(system: string, input: string, maxTokens: number, signal?: AbortSignal): Promise<string>;
}

export function createModelClient(
	model: Model<Api>,
	thinkingLevel: ThinkingLevel,
	apiKey: ApiKey,
	sessionId: string,
): ChronicleModelClient {
	return {
		identity: `${formatModelString(model)}:${thinkingLevel}`,
		async complete(system, input, maxTokens, signal) {
			const response = await retryTransientCompletion(
				() =>
					completeSimple(
						model,
						{
							systemPrompt: [system],
							messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
						},
						{
							apiKey,
							sessionId,
							maxTokens,
							signal,
							reasoning: shouldDisableReasoning(thinkingLevel) ? undefined : toReasoningEffort(thinkingLevel),
						},
					),
				{ provider: model.provider },
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				throw new Error(response.errorMessage || `chronicle model ${response.stopReason}`);
			}
			return response.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("");
		},
	};
}

/** Resolve the summary role to a client, or undefined when no model is available. */
export function resolveChronicleModelClient(
	settings: Settings,
	modelRegistry: ModelRegistry,
	sessionId: string = Bun.randomUUIDv7(),
): ChronicleModelClient | undefined {
	const selection = resolveChronicleSummaryRoleSelection(settings, modelRegistry.getAvailable());
	if (!selection) return undefined;
	const requested = concreteThinkingLevel(selection.thinkingLevel) ?? ThinkingLevel.Medium;
	const thinking = resolveThinkingLevelForModel(selection.model, requested) ?? ThinkingLevel.Inherit;
	return createModelClient(selection.model, thinking, modelRegistry.resolver(selection.model, sessionId), sessionId);
}

/** Parse the first JSON object in a model reply, tolerating a code fence or stray prose. */
export function parseJsonObject(text: string): Record<string, unknown> {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("model reply contains no JSON object");
	const parsed: unknown = JSON.parse(text.slice(start, end + 1));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("model reply is not a JSON object");
	}
	return parsed as Record<string, unknown>;
}

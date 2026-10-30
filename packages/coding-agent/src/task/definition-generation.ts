import { completeSimple, type Message } from "@oh-my-pi/pi-ai";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { AUTO_THINKING, shouldDisableReasoning, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveConfiguredModelPatterns, resolveModelOverride, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { cfgDefinitionGenerationConversationTtlMs } from "./settings";

export interface DefinitionGenerationRequest<T extends object> {
	definition: Partial<T>;
	target: Extract<keyof T, string> | "all";
	comment?: string;
	baseDefinitions?: readonly T[];
	conversationId?: string;
	signal?: AbortSignal;
}

export interface DefinitionGenerationResult<T extends object> {
	/** A patch containing only the requested editable fields. */
	fields: Partial<T>;
	/** Absent when conversation retention is disabled. */
	conversationId?: string;
}

export interface DefinitionGeneratorOptions<T extends object> {
	settings: Settings;
	modelRegistry: Pick<ModelRegistry, "refresh" | "getAvailable" | "resolver">;
	cwd: string;
	activeModelPattern?: string;
	defaultModelPattern?: string;
	schema: () => Record<string, unknown>;
	systemPrompt: () => string | Promise<string>;
	requestPrompt: (request: DefinitionGenerationRequest<T>) => string | Promise<string>;
	validateFields?: (fields: Partial<T>) => void;
}

export interface DefinitionGenerator<T extends object> {
	generate(request: DefinitionGenerationRequest<T>): Promise<DefinitionGenerationResult<T>>;
	dispose(): void;
}

interface Conversation {
	messages: Message[];
	updatedAt: number;
	timer: NodeJS.Timeout;
}

/** Tool-free authoring: the only model tool submits data to the calling editor. */
export function createDefinitionGenerator<T extends object>(options: DefinitionGeneratorOptions<T>): DefinitionGenerator<T> {
	const conversations = new Map<string, Conversation>();
	let disposed = false;
	const forget = (id: string): void => {
		const conversation = conversations.get(id);
		if (conversation) clearTimeout(conversation.timer);
		conversations.delete(id);
	};
	const scheduleExpiry = (id: string, delay: number): NodeJS.Timeout => {
		const timer = setTimeout(() => forget(id), delay);
		timer.unref();
		return timer;
	};
	const stopListening = cfgDefinitionGenerationConversationTtlMs.listen(options.settings, ttl => {
		for (const [id, conversation] of conversations) {
			const remaining = ttl - (Date.now() - conversation.updatedAt);
			if (ttl === 0 || remaining <= 0) forget(id);
			else {
				clearTimeout(conversation.timer);
				conversation.timer = scheduleExpiry(id, remaining);
			}
		}
	});
	return {
		async generate(request) {
			if (disposed) throw new Error("Definition generator has been disposed.");
			request.signal?.throwIfAborted();
			const ttl = cfgDefinitionGenerationConversationTtlMs.get(options.settings);
			for (const [id, conversation] of conversations) {
				if (ttl === 0 || Date.now() - conversation.updatedAt >= ttl) forget(id);
			}
			const previous = request.conversationId ? conversations.get(request.conversationId) : undefined;
			const schema = options.schema();
			if (!isRecord(schema.properties)) throw new Error("Definition schema must declare editable properties.");
			const properties = schema.properties;
			const keys = request.target === "all" ? Object.keys(properties) : [request.target];
			if (keys.some(key => !Object.hasOwn(properties, key))) throw new Error(`Unknown definition field: ${request.target}`);
			// Starting from references fills gaps instead of overwriting the operator's choices.
			const preservePreset = request.target === "all" && (request.baseDefinitions?.length ?? 0) > 0;
			const preset = Object.fromEntries(
				Object.entries(request.definition).filter(([key, value]) =>
					Object.hasOwn(properties, key) && value !== undefined && value !== null && value !== "",
				),
			);
			const generatedKeys = preservePreset ? keys.filter(key => !Object.hasOwn(preset, key)) : keys;
			const required = request.target === "all"
				? Array.isArray(schema.required) ? schema.required.filter(key => generatedKeys.includes(key)) : []
				: generatedKeys;
			const responseSchema = {
				...schema,
				properties: Object.fromEntries(generatedKeys.map(key => [key, properties[key]])),
				required,
				additionalProperties: false,
			};
			const prompt = await options.requestPrompt(request);
			const systemPrompt = await options.systemPrompt();
			await options.modelRegistry.refresh();
			const available = options.modelRegistry.getAvailable();
			const patterns = resolveConfiguredModelPatterns(
				options.activeModelPattern ?? options.defaultModelPattern ?? options.settings.getModelRole("default"),
				options.settings,
			);
			const author = options.settings.getModelRole("agent-author")
				? resolveModelRoleValue("@agent-author", available, { settings: options.settings })
				: undefined;
			const fallback = resolveModelOverride(patterns, options.modelRegistry, options.settings);
			const model = author ? author.model : (fallback.model ?? available[0]);
			if (!model) throw new Error("No available model to generate a definition.");
			const selectedThinking = author?.model ? author.thinkingLevel : fallback.thinkingLevel;
			const thinking = selectedThinking === AUTO_THINKING ? undefined : selectedThinking;
			const conversationId = previous ? request.conversationId! : crypto.randomUUID();
			const messages: Message[] = [
				...(previous?.messages ?? []),
				{ role: "user", content: prompt, timestamp: Date.now() },
			];
			request.signal?.throwIfAborted();
			const response = await completeSimple(model, {
				systemPrompt: [systemPrompt],
				messages,
				tools: [{
					name: "submit_definition",
					description: "Return the requested definition fields to the editor.",
					parameters: responseSchema,
					strict: false,
				}],
			}, {
				apiKey: options.modelRegistry.resolver(model, conversationId),
				sessionId: conversationId,
				signal: request.signal,
				reasoning: toReasoningEffort(thinking),
				disableReasoning: shouldDisableReasoning(thinking),
				toolChoice: { type: "tool", name: "submit_definition" },
				maxTokens: Math.min(16_384, model.maxTokens),
				cacheRetention: "long",
			});
			request.signal?.throwIfAborted();
			if (disposed) throw new Error("Definition generator has been disposed.");
			if (response.stopReason === "error" || response.stopReason === "aborted")
				throw new Error(response.errorMessage ?? "Definition generation failed.");
			if (response.stopReason === "length") throw new Error("Definition generation exceeded the output limit.");
			const calls = response.content.filter(block => block.type === "toolCall");
			if (calls.length !== 1 || calls[0].name !== "submit_definition")
				throw new Error("Generator did not return structured definition fields.");
			const call = calls[0];
			// Never apply incidental fields returned by a model outside the requested target.
			const fields = Object.fromEntries(
				generatedKeys.filter(key => Object.hasOwn(call.arguments, key)).map(key => [key, call.arguments[key]]),
			);
			const validation = validateJsonSchemaValue(responseSchema, fields);
			if (!validation.success)
				throw new Error(`Invalid generated definition: ${validation.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
			const result = (preservePreset ? { ...fields, ...preset } : fields) as Partial<T>;
			options.validateFields?.(result);
			const currentTtl = cfgDefinitionGenerationConversationTtlMs.get(options.settings);
			if (currentTtl > 0) {
				forget(conversationId);
				const timer = scheduleExpiry(conversationId, currentTtl);
				conversations.set(conversationId, {
					messages: [...messages, structuredClone(response), {
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: "text", text: JSON.stringify(result) }],
						isError: false,
						timestamp: Date.now(),
					}],
					updatedAt: Date.now(),
					timer,
				});
				return { fields: result, conversationId };
			}
			for (const id of conversations.keys()) forget(id);
			return { fields: result };
		},
		dispose() {
			disposed = true;
			stopListening();
			for (const id of conversations.keys()) forget(id);
		},
	};
}

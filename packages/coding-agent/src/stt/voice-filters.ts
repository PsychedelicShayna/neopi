/**
 * Voice filters: post-processing passes for the Ctrl+Space whole-recording
 * xAI transcript. Each filter is a markdown file with YAML frontmatter; the
 * body is the system prompt and the raw transcript is the user message. The
 * model's final text replaces the transcript before it reaches the composer.
 *
 * Discovery: `<agent dir>/voice-filters/*.md` (user; `~/.omp/agent` by default,
 * following the active profile like prompt templates) and the nearest
 * `.omp/voice-filters/*.md` (project); a project filter shadows a user filter
 * with the same name.
 *
 * Frontmatter:
 *   name:        display name (default: file name without `.md`)
 *   description: one-line summary shown in the picker
 *   model:       model selector or `@role` (default: `@voice`)
 *   tools:       session tool names the filter may call (default: none)
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { getAgentDir, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import {
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "@oh-my-pi/pi-tui/thinking";
import { findAllNearestProjectConfigDirs } from "../config";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelRoleAlias } from "../config/model-roles";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";

const VOICE_FILTER_DIR = "voice-filters";
const VOICE_FILTER_CONFIG_SOURCE = ".omp";
/** Model role every filter falls back to when its frontmatter names no model. */
export const VOICE_FILTER_ROLE = "voice";
/** How long the untouched Ctrl+Space filter picker waits before closing on "None". */
export const VOICE_FILTER_PICKER_TIMEOUT_MS = 5_000;

export interface VoiceFilter {
	name: string;
	description: string | undefined;
	/** Model selector or `@role`; undefined means the `@voice` role. */
	model: string | undefined;
	/** Session tool names the filter may call. Empty means a tool-free pass. */
	tools: string[];
	systemPrompt: string;
	source: "project" | "user";
	path: string;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toolsField(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(Boolean);
}

/** Parse one filter file; returns undefined for an empty prompt body. */
export function parseVoiceFilter(
	filePath: string,
	content: string,
	source: VoiceFilter["source"],
): VoiceFilter | undefined {
	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
	const systemPrompt = body.trim();
	if (!systemPrompt) {
		logger.warn("Voice filter has an empty prompt body", { path: filePath });
		return undefined;
	}
	return {
		name: stringField(frontmatter.name) ?? path.basename(filePath, ".md"),
		description: stringField(frontmatter.description),
		model: stringField(frontmatter.model),
		tools: toolsField(frontmatter.tools),
		systemPrompt,
		source,
		path: filePath,
	};
}

async function loadFiltersFromDir(dir: string, source: VoiceFilter["source"]): Promise<VoiceFilter[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.map(entry => path.join(dir, entry.name));
	const loaded = await Promise.all(
		files.map(async filePath => {
			try {
				return parseVoiceFilter(filePath, await Bun.file(filePath).text(), source);
			} catch (error) {
				logger.warn("Failed to read voice filter", { path: filePath, error: String(error) });
				return undefined;
			}
		}),
	);
	return loaded.filter((filter): filter is VoiceFilter => filter !== undefined);
}

/** Discover project and user filters, project first on name collisions, sorted by name. */
export async function discoverVoiceFilters(cwd: string): Promise<VoiceFilter[]> {
	const userDir = path.join(getAgentDir(), VOICE_FILTER_DIR);
	const projectDir = findAllNearestProjectConfigDirs(VOICE_FILTER_DIR, path.resolve(cwd)).find(
		entry => entry.source === VOICE_FILTER_CONFIG_SOURCE,
	);
	const [project, user] = await Promise.all([
		projectDir ? loadFiltersFromDir(projectDir.path, "project") : [],
		loadFiltersFromDir(userDir, "user"),
	]);
	const byName = new Map<string, VoiceFilter>();
	for (const filter of [...project, ...user]) {
		if (!byName.has(filter.name)) byName.set(filter.name, filter);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface RunVoiceFilterOptions {
	settings: Settings;
	modelRegistry: Pick<ModelRegistry, "getAvailable" | "resolver">;
	/** The session's tool instances; the filter receives only those it names. */
	tools: readonly AgentTool[];
	cwd: string;
	signal?: AbortSignal;
}

/** Run `filter` over `transcript` and return the model's final text. */
export async function runVoiceFilter(
	filter: VoiceFilter,
	transcript: string,
	options: RunVoiceFilterOptions,
): Promise<string> {
	const selector = filter.model ?? formatModelRoleAlias(VOICE_FILTER_ROLE);
	const resolved = resolveModelRoleValue(selector, options.modelRegistry.getAvailable(), {
		settings: options.settings,
		matchPreferences: getModelMatchPreferences(options.settings),
	});
	if (!resolved.model) throw new Error(`Voice filter "${filter.name}": no model available for ${selector}`);
	// Without an explicit level the model's own default applies; speed matters for dictation.
	const requested = concreteThinkingLevel(resolved.thinkingLevel);
	const thinkingLevel =
		(requested && resolveThinkingLevelForModel(resolved.model, requested)) ?? ThinkingLevel.Inherit;

	const granted = new Set(filter.tools);
	const tools = options.tools.filter(tool => granted.has(tool.name));
	const providerSessionId = Bun.randomUUIDv7();
	const agent = new Agent({
		initialState: {
			systemPrompt: [filter.systemPrompt],
			model: resolved.model,
			thinkingLevel: toReasoningEffort(thinkingLevel),
			tools,
		},
		sessionId: providerSessionId,
		cwdResolver: () => options.cwd,
		getApiKey: requestModel => options.modelRegistry.resolver(requestModel, providerSessionId),
		streamFn: streamSimple,
		intentTracing: false,
	});
	agent.setDisableReasoning(shouldDisableReasoning(thinkingLevel));

	const onAbort = () => agent.abort("voice filter cancelled");
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await agent.prompt(transcript);
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}

	const last = agent.state.messages.findLast(message => message.role === "assistant");
	if (!last || last.role !== "assistant") throw new Error(`Voice filter "${filter.name}" produced no response`);
	if (last.stopReason === "error" || last.stopReason === "aborted") {
		throw new Error(`Voice filter "${filter.name}" failed: ${last.errorMessage ?? last.stopReason}`);
	}
	const text = last.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("")
		.trim();
	if (!text) throw new Error(`Voice filter "${filter.name}" returned empty text`);
	return text;
}

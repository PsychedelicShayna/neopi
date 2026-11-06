import { importLegacyMarkdown, parseNativeMarkdown, renderNativeMarkdown } from "../utils/native-frontmatter";
import { AGENT_DEFINITION_FIELDS, type AgentDefinitionDraft } from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";
import { parseAgent } from "./agents";

/** Preserve unrecognized metadata from raw edits; rich edits only replace their own fields. */
export function parseAgentDefinitionDocument(raw: string): AgentDefinitionDraft {
	const document = parseNativeMarkdown(raw);
	const { frontmatter } = document;
	const parsed = parseAgent("draft.md", document, "project");
	const draft: Record<string, unknown> = {
		...frontmatter,
		name: parsed.name,
		description: parsed.description,
		systemPrompt: parsed.systemPrompt,
		documentSource: raw,
	};
	for (const field of AGENT_DEFINITION_FIELDS) {
		if (field.key === "systemPrompt" || !Object.hasOwn(frontmatter, field.key)) continue;
		draft[field.key] = parsed[field.key];
	}
	for (const [alias, key] of [
		["thinking-level", "thinkingLevel"],
		["read-summarize", "readSummarize"],
		["autoload-skills", "autoloadSkills"],
	] as const) {
		if (!Object.hasOwn(frontmatter, alias)) continue;
		draft[key] = parsed[key];
		delete draft[alias];
	}
	if (Object.hasOwn(frontmatter, "thinking")) {
		draft.thinkingLevel = parsed.thinkingLevel;
		delete draft.thinking;
	}
	return draft as unknown as AgentDefinitionDraft;
}

/** Foreign plugin YAML is read-only input; editing always produces a native owned override. */
export function importExternalAgentDefinitionDocument(raw: string): AgentDefinitionDraft {
	return parseAgentDefinitionDocument(importLegacyMarkdown(raw));
}

export function serializeAgentDefinitionDocument(definition: AgentDefinitionDraft): string {
	const { systemPrompt, documentSource, ...values } = definition;
	const metadata = Object.fromEntries(
		Object.entries(values).filter(
			([key, value]) =>
				value !== undefined &&
				!["source", "filePath", "disabled", "overrideModel", "prewalkOverride", "advisorOverride"].includes(key),
		),
	);
	// The editor's transport field must not consume an identically named user metadata key.
	if (documentSource) {
		const original = parseNativeMarkdown(documentSource).frontmatter;
		if (Object.hasOwn(original, "documentSource")) metadata.documentSource = original.documentSource;
	}
	return renderNativeMarkdown(metadata, `\n${systemPrompt.trim()}\n`, documentSource);
}

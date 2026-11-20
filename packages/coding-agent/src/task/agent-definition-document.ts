import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { AGENT_DEFINITION_FIELDS, type AgentDefinitionDraft } from "@oh-my-pi/pi-tui/overlays/agent-definition-editor";
import { parseAgent } from "./agents";

/** Preserve unrecognized metadata from raw edits; rich edits only replace their own fields. */
export function parseAgentDefinitionDocument(raw: string): AgentDefinitionDraft {
	const { frontmatter } = parseFrontmatter(raw);
	const parsed = parseAgent("draft.md", raw, "project");
	const draft: Record<string, unknown> = {
		...frontmatter,
		name: parsed.name,
		description: parsed.description,
		systemPrompt: parsed.systemPrompt,
	};
	for (const field of AGENT_DEFINITION_FIELDS) {
		if (field.key === "systemPrompt" || !Object.hasOwn(frontmatter, field.key)) continue;
		draft[field.key] = parsed[field.key];
	}
	if (Object.hasOwn(frontmatter, "thinking")) {
		draft.thinkingLevel = parsed.thinkingLevel;
		delete draft.thinking;
	}
	return draft as unknown as AgentDefinitionDraft;
}

export function serializeAgentDefinitionDocument(definition: AgentDefinitionDraft): string {
	const { systemPrompt, ...values } = definition;
	const metadata = Object.fromEntries(
		Object.entries(values).filter(
			([key, value]) =>
				value !== undefined &&
				!["source", "filePath", "disabled", "overrideModel", "prewalkOverride", "advisorOverride"].includes(key),
		),
	);
	// Block style keeps saved definitions readable and diffable; Bun pads keys that open a block with a space.
	const frontMatter = YAML.stringify(metadata, null, 2).replace(/ +$/gm, "").trimEnd();
	return `---\n${frontMatter}\n---\n\n${systemPrompt.trim()}\n`;
}

import { normalizeTools } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Tool, ToolSession } from "./index";
import { cfgToolsIntentTracing } from "./settings";
import { toolSummary } from "./xdev";

export type ToolCatalogSession = Pick<
	ToolSession,
	"toolRegistry" | "xdev" | "getEnabledToolNames" | "isToolActive" | "settings"
>;

/** Shared catalog for URL and command consumers. Never instantiates or executes tools. */
export function listEnabledTools(session: ToolCatalogSession): Tool[] {
	const registry = session.toolRegistry ?? session.xdev?.tools;
	if (!registry) return [];
	const enabledNames = session.getEnabledToolNames?.();
	const enabled = enabledNames === undefined ? undefined : new Set(enabledNames);
	return [...registry.values()].filter(tool =>
		enabled
			? enabled.has(tool.name)
			: session.isToolActive?.(tool.name) === true || session.xdev?.mountedNames.has(tool.name) === true,
	);
}

export function toolCatalogListing(session: ToolCatalogSession): string {
	const tools = listEnabledTools(session);
	return [
		`# Enabled tools (${tools.length})`,
		"",
		...tools.map(
			tool =>
				`- tool://${encodeURIComponent(tool.name)} [${tool.loadMode ?? "essential"}]: ${toolSummary(tool).replace(/\s+/g, " ").trim()}`,
		),
		"",
		"Read tool://<name> for docs, JSON schema, examples, and restrictions. This catalog is read-only; use existing tool invocation paths to execute.",
	].join("\n");
}

/** Resolve metadata from the same enabled instances used by ordinary dispatch. */
export function toolCatalogDocs(session: ToolCatalogSession, name: string): string {
	const tool = listEnabledTools(session).find(tool => tool.name === name);
	if (!tool) throw new ToolError(`Tool '${name}' is not enabled in this session. Read tool:// for available tools.`);
	// Only top-level tools get harness intent injection. Mounted/Code Mode tools
	// retain their own schema, exactly as their existing dispatch paths expect.
	const wireTool = session.isToolActive?.(name)
		? (normalizeTools([tool], { injectIntent: cfgToolsIntentTracing.get(session.settings) })?.[0] ?? tool)
		: tool;
	const approval = tool.approval;
	const approvalDescription =
		typeof approval === "function"
			? "Argument-dependent"
			: typeof approval === "object"
				? JSON.stringify(approval)
				: (approval ?? "exec");
	return [
		`# ${tool.name}`,
		"",
		toolSummary(tool),
		"",
		tool.description,
		"",
		"## Schema",
		"```json",
		JSON.stringify(toolWireSchema(wireTool), null, 2),
		"```",
		...(tool.customFormat
			? [
					"",
					"## Custom format",
					"```json",
					JSON.stringify({ name: tool.customWireName ?? tool.name, ...tool.customFormat }, null, 2),
					"```",
				]
			: []),
		"",
		"## Examples",
		...(tool.examples?.length
			? ["```json", JSON.stringify(tool.examples, null, 2), "```"]
			: ["No examples declared."]),
		"",
		"## Restrictions",
		`Load mode: ${tool.loadMode ?? "essential"}.`,
		`Approval: ${approvalDescription}. Existing session permission and approval policies still apply.`,
		...(tool.lenientArgValidation ? ["This tool handles schema mismatches itself."] : []),
		"Reading tool:// never invokes a tool. This namespace does not accept writes.",
	].join("\n");
}

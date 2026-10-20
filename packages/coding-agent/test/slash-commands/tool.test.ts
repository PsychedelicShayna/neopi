import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { createXdevState, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0)) await dispose();
});

function harness() {
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }] }));
	const makeTool = (name: string): Tool => ({
		name,
		label: name,
		description: `Docs for ${name}`,
		summary: `Summary for ${name}`,
		parameters: { type: "object", properties: { path: { type: "string" } } },
		examples: [{ call: { path: "notes.txt" } }],
		execute,
	});
	const read = makeTool("read");
	const device = { ...makeTool("mcp:Server/Query"), loadMode: "discoverable" as const };
	const inactive = makeTool("inactive");
	const registry = new Map([read, device, inactive].map(tool => [tool.name, tool]));
	const settings = Settings.isolated();
	const source: ToolSession = {
		cwd: os.tmpdir(), hasUI: false, settings,
		getSessionFile: () => null, getSessionSpawns: () => "*",
		toolRegistry: registry,
	};
	const xdev = createXdevState(source, registry, new Set(registry.keys()), new Set([device.name]));
	const auth = createInMemoryAuthStorage();
	const session = new AgentSession({
		agent: new Agent({ initialState: { tools: [read], systemPrompt: ["Test"], messages: [] } }),
		sessionManager: SessionManager.inMemory(os.tmpdir()),
		settings,
		modelRegistry: new ModelRegistry(auth, path.join(os.tmpdir(), "tool-slash-models.yml")),
		toolRegistry: registry,
		xdev,
	});
	disposals.push(async () => { await session.dispose(); auth.close(); });
	source.getEnabledToolNames = () => session.getEnabledToolNames();
	source.isToolActive = name => session.getActiveToolNames().includes(name);
	const reports: string[] = [];
	const setText = vi.fn();
	const showError = vi.fn();
	const ctx = {
		session,
		editor: { setText },
		showError,
		handleToolCatalogCommand: (name?: string) => reports.push(session.getToolCatalogDocs(name)),
	} as unknown as InteractiveModeContext;
	return { session, source, registry, device, execute, reports, setText, showError, runtime: { ctx } };
}

describe("/tool: catalog", () => {
	it("lists the enabled registry and shares docs with tool:// without invocation", async () => {
		const h = harness();
		expect(await executeBuiltinSlashCommand("/tool:", h.runtime)).toBe(true);
		expect(h.reports[0]).toContain("tool://read");
		expect(h.reports[0]).toContain("tool://mcp%3AServer%2FQuery");
		expect(h.reports[0]).not.toContain("inactive");
		expect(h.session.getToolCatalogEntries().map(tool => tool.name)).toEqual(["read", h.device.name]);
		expect(await executeBuiltinSlashCommand(`/tool:${h.device.name}`, h.runtime)).toBe(true);
		const resource = await new InternalUrlRouter().resolve(`tool://${encodeURIComponent(h.device.name)}`, { session: h.source });
		expect(h.reports[1]).toBe(resource.content);
		expect(h.reports[1]).toContain("## Schema");
		expect(h.reports[1]).toContain("## Examples");
		expect(h.reports[1]).toContain("## Restrictions");
		expect(h.execute).not.toHaveBeenCalled();
		expect(h.setText).toHaveBeenCalledWith("");
	});

	it("reads registry replacements instead of caching a second schema catalog", async () => {
		const h = harness();
		h.registry.set(h.device.name, { ...h.device, description: "Replacement docs" });
		await executeBuiltinSlashCommand(`/tool:${h.device.name}`, h.runtime);
		expect(h.reports[0]).toContain("Replacement docs");
		expect(h.session.getToolCatalogDocs("inactive")).toContain('No enabled tool named "inactive"');
	});

	it("consumes extra arguments without treating them as execution or prose", async () => {
		const h = harness();
		expect(await executeBuiltinSlashCommand('/tool:read {"path":"notes.txt"}', h.runtime)).toBe(true);
		expect(h.showError).toHaveBeenCalled();
		expect(h.reports).toEqual([]);
		expect(h.execute).not.toHaveBeenCalled();
	});

	it("preserves a newer detached draft", async () => {
		const h = harness();
		await executeBuiltinSlashCommand("/tool:read", { ...h.runtime, draftDetached: true });
		expect(h.setText).not.toHaveBeenCalled();
	});
});

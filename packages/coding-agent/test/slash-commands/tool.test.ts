import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
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
	const execute = vi.fn(async (_id: string, _args: unknown, _signal?: AbortSignal) => ({
		content: [{ type: "text" as const, text: "executed" }],
	}));
	const stream = vi.fn(() => {
		throw new Error("Human tool invocation must not call a model");
	});
	const makeTool = (name: string): Tool => ({
		name,
		label: name,
		description: `Docs for ${name}`,
		summary: `Summary for ${name}`,
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		examples: [{ call: { path: "notes.txt" } }],
		execute,
	});
	const read = makeTool("read");
	const device = { ...makeTool("mcp:Server/Query"), loadMode: "discoverable" as const };
	const inactive = makeTool("inactive");
	const registry = new Map([read, device, inactive].map(tool => [tool.name, tool]));
	const settings = Settings.isolated();
	const source: ToolSession = {
		cwd: os.tmpdir(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		toolRegistry: registry,
	};
	const xdev = createXdevState(source, registry, new Set(registry.keys()), new Set([device.name]));
	const auth = createInMemoryAuthStorage();
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5"),
				tools: [read],
				systemPrompt: ["Test"],
				messages: [],
			},
			streamFn: stream,
		}),
		sessionManager: SessionManager.inMemory(os.tmpdir()),
		settings,
		modelRegistry: new ModelRegistry(auth, path.join(os.tmpdir(), "tool-slash-models.yml")),
		toolRegistry: registry,
		xdev,
	});
	disposals.push(async () => {
		await session.dispose();
		auth.close();
	});
	source.getEnabledToolNames = () => session.getEnabledToolNames();
	source.isToolActive = name => session.getActiveToolNames().includes(name);
	const reports: string[] = [];
	const setText = vi.fn();
	const showError = vi.fn();
	const ctx = {
		session,
		editor: { setText },
		showError,
		showStatus: vi.fn(),
		handleToolCatalogCommand: (name?: string) => reports.push(session.getToolCatalogDocs(name)),
	} as unknown as InteractiveModeContext;
	return { session, source, registry, device, execute, stream, reports, setText, showError, runtime: { ctx } };
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
		const resource = await new InternalUrlRouter().resolve(`tool://${encodeURIComponent(h.device.name)}`, {
			session: h.source,
		});
		expect(h.reports[1]).toBe(String(resource.content));
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

	it("executes JSON and key=value calls through the journal without a model turn", async () => {
		const h = harness();
		expect(await executeBuiltinSlashCommand('/tool:read {"path":"notes.txt"}', h.runtime)).toBe(true);
		expect(await executeBuiltinSlashCommand('/tool:read path="other notes.txt"', h.runtime)).toBe(true);
		expect(h.showError).not.toHaveBeenCalled();
		expect(h.execute).toHaveBeenCalledTimes(2);
		expect(h.execute.mock.calls.map(call => call[1])).toEqual([{ path: "notes.txt" }, { path: "other notes.txt" }]);
		expect(h.session.messages.filter(message => message.role === "toolResult")).toHaveLength(2);
		expect(h.session.sessionManager.getBranch().filter(entry => entry.type === "message")).toHaveLength(6);
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("validates before execution and records the ordinary error result", async () => {
		const h = harness();
		await executeBuiltinSlashCommand("/tool:read {}", h.runtime);
		expect(h.execute).not.toHaveBeenCalled();
		expect(h.session.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "read", isError: true });
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("keeps disabled tools uncallable and malformed arguments out of the transcript", async () => {
		const h = harness();
		await executeBuiltinSlashCommand("/tool:inactive path=notes.txt", h.runtime);
		await executeBuiltinSlashCommand('/tool:read {"path":', h.runtime);
		expect(h.showError).toHaveBeenCalledTimes(2);
		expect(h.execute).not.toHaveBeenCalled();
		expect(h.session.messages).toEqual([]);
	});

	it("invokes mounted tools by their exact case-sensitive canonical names", async () => {
		const h = harness();
		await executeBuiltinSlashCommand(`/tool:${h.device.name} path=notes.txt`, h.runtime);
		expect(h.showError).not.toHaveBeenCalled();
		expect(h.execute).toHaveBeenCalledTimes(1);
		expect(h.session.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: h.device.name });
	});

	it.each(["allow_once", "reject_once"] as const)("honors ACP approval %s", async decision => {
		const h = harness();
		h.registry.set("bash", {
			...h.registry.get("read")!,
			name: "bash",
			approval: { tier: "exec", policy: "prompt" },
		});
		await h.session.setActiveToolsByName(["bash"]);
		const requestPermission = vi.fn(async () => ({
			outcome: "selected" as const,
			optionId: decision,
			kind: decision,
		}));
		h.session.setClientBridge({ capabilities: { requestPermission: true }, requestPermission });
		await executeBuiltinSlashCommand("/tool:bash path=notes.txt", h.runtime);
		expect(requestPermission).toHaveBeenCalledTimes(1);
		expect(h.execute).toHaveBeenCalledTimes(decision === "allow_once" ? 1 : 0);
		expect(h.session.messages.at(-1)).toMatchObject({ role: "toolResult", isError: decision === "reject_once" });
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("cancels through session abort and preserves a newer detached composer draft", async () => {
		const h = harness();
		const started = Promise.withResolvers<void>();
		h.execute.mockImplementation(async (_id, _args, signal) => {
			const stopped = Promise.withResolvers<void>();
			signal!.addEventListener("abort", () => stopped.resolve(), { once: true });
			started.resolve();
			await stopped.promise;
			signal!.throwIfAborted();
			return { content: [{ type: "text", text: "unreachable" }] };
		});
		const invocation = executeBuiltinSlashCommand("/tool:read path=notes.txt", { ...h.runtime, draftDetached: true });
		await started.promise;
		await expect(h.session.invokeTool("read", { path: "second.txt" })).rejects.toThrow("current operation");
		await h.session.abort();
		await invocation;
		expect(h.session.isStreaming).toBe(false);
		expect(h.session.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
		expect(h.setText).not.toHaveBeenCalled();
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("leaves /force as a next-model-turn hint", async () => {
		const h = harness();
		const force = vi.spyOn(h.session, "setForcedToolChoice");
		await executeBuiltinSlashCommand("/force:read", h.runtime);
		expect(force).toHaveBeenCalled();
		expect(h.execute).not.toHaveBeenCalled();
		expect(h.session.messages).toEqual([]);
	});

	it("preserves a newer detached draft", async () => {
		const h = harness();
		await executeBuiltinSlashCommand("/tool:read", { ...h.runtime, draftDetached: true });
		expect(h.setText).not.toHaveBeenCalled();
	});
});

import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { normalizeTools } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createXdevState, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { cfgToolsIntentTracing } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { listEnabledTools, toolCatalogDocs } from "@oh-my-pi/pi-coding-agent/tools/tool-catalog";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

function fixture() {
	let executed = 0;
	let approvals = 0;
	const makeTool = (name: string, loadMode: "essential" | "discoverable" = "essential"): Tool => ({
		name,
		label: name,
		description: `Documentation for ${name}. Only inspect project files.`,
		summary: `Summary for ${name}`,
		loadMode,
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		examples: [{ call: { path: "notes.txt" } }],
		approval: () => {
			approvals++;
			return "read";
		},
		execute: async () => {
			executed++;
			return { content: [{ type: "text", text: "invoked" }] };
		},
	});
	const read = makeTool("read");
	const device = makeTool("checkpoint", "discoverable");
	const pinned = makeTool("grep", "discoverable");
	const inactive = makeTool("inactive");
	const bridged = makeTool("bridge_only");
	const tools = new Map([read, device, pinned, inactive, bridged].map(tool => [tool.name, tool]));
	const active = new Set(["read", "grep"]);
	const enabled = new Set(["read", "grep", "checkpoint", "bridge_only"]);
	const session: ToolSession = {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "tools.intentTracing": true }),
		toolRegistry: tools,
		isToolActive: name => active.has(name),
		getEnabledToolNames: () => [...enabled],
	};
	session.xdev = createXdevState(session, tools, new Set(tools.keys()), new Set([device.name]));
	return { session, tools, active, enabled, device, counts: () => ({ executed, approvals }) };
}

function schemaFromDocs(content: string): unknown {
	const schema = content.match(/## Schema\n```json\n([\s\S]*?)\n```/);
	if (!schema) throw new Error("Missing schema in catalog docs");
	return JSON.parse(schema[1]);
}

describe("tool:// enabled catalog", () => {
	it("lists top-level, pinned, mounted and Code Mode tools from the same instances", async () => {
		const { session, device, counts } = fixture();
		const resource = await new InternalUrlRouter().resolve("tool://", { session });
		expect(resource.content).toContain("Enabled tools (4)");
		for (const name of ["read", "grep", "checkpoint", "bridge_only"]) {
			expect(resource.content).toContain(`tool://${name}`);
		}
		expect(resource.content).toContain("[discoverable]: Summary for checkpoint");
		expect(resource.content).not.toContain("inactive");
		expect(listEnabledTools(session).find(tool => tool.name === "checkpoint")).toBe(device);
		expect(counts()).toEqual({ executed: 0, approvals: 0 });
	});

	it("exposes wire schemas, examples and restrictions without invoking the tool or policy", async () => {
		const { session, device, counts } = fixture();
		const resource = await new InternalUrlRouter().resolve("tool://checkpoint", { session });
		expect(schemaFromDocs(String(resource.content))).toEqual(toolWireSchema(device));
		expect(resource.content).toContain(JSON.stringify(device.examples, null, 2));
		expect(resource.content).toContain("Only inspect project files.");
		expect(resource.content).toContain("Load mode: discoverable");
		expect(resource.content).toContain("Approval: Argument-dependent");
		expect(counts()).toEqual({ executed: 0, approvals: 0 });
	});

	it("matches top-level intent injection and honors live intent settings", () => {
		const { session, tools } = fixture();
		const tool = tools.get("read")!;
		const [normalized] = normalizeTools([tool], { injectIntent: true })!;
		expect(schemaFromDocs(toolCatalogDocs(session, "read"))).toEqual(toolWireSchema(normalized));
		cfgToolsIntentTracing.override(session.settings, false);
		expect(schemaFromDocs(toolCatalogDocs(session, "read"))).toEqual(toolWireSchema(tool));
	});

	it("reflects disabling and same-name registry replacements on the next read", async () => {
		const { session, tools, enabled, device } = fixture();
		const router = new InternalUrlRouter();
		enabled.delete("checkpoint");
		await expect(router.resolve("tool://checkpoint", { session })).rejects.toThrow("not enabled");
		expect((await router.resolve("tool://", { session })).content).not.toContain("tool://checkpoint");
		enabled.add("checkpoint");
		const replacement = {
			...device,
			description: "Replacement docs",
			parameters: { type: "object", properties: { revision: { type: "integer" } } },
		};
		tools.set("checkpoint", replacement);
		const resource = await router.resolve("tool://checkpoint", { session });
		expect(resource.content).toContain("Replacement docs");
		expect(schemaFromDocs(String(resource.content))).toEqual(toolWireSchema(replacement));
	});

	it("works without XD enabled and falls back to active plus mounted names for factory consumers", async () => {
		const { session } = fixture();
		session.getEnabledToolNames = undefined;
		expect(listEnabledTools(session).map(tool => tool.name)).toEqual(["read", "checkpoint", "grep"]);
		session.xdev = undefined;
		expect(listEnabledTools(session).map(tool => tool.name)).toEqual(["read", "grep"]);
		expect((await new InternalUrlRouter().resolve("tool://grep", { session })).content).toContain("Summary for grep");
	});

	it("preserves case-sensitive and encoded tool names", async () => {
		const { session, tools, enabled, device } = fixture();
		const name = "mcp:Server/Query";
		tools.set(name, { ...device, name });
		enabled.add(name);
		const resource = await new InternalUrlRouter().resolve(`tool://${encodeURIComponent(name)}`, { session });
		expect(resource.content).toContain(`# ${name}`);
	});

	it("routes through read and denies catalog writes at the ordinary approval gate", async () => {
		const { session, counts } = fixture();
		const result = await new ReadTool(session).execute("catalog-read", { path: "tool://checkpoint" });
		expect(result.content.some(block => block.type === "text" && block.text.includes("Summary for checkpoint"))).toBe(
			true,
		);
		expect(
			resolveApproval(new WriteTool(session), { path: "tool://checkpoint", content: "{}" }, "always-ask"),
		).toMatchObject({ policy: "deny", source: "tool" });
		expect(counts()).toEqual({ executed: 0, approvals: 0 });
	});

	it("keeps XD mounted-only listing and existing invocation behavior", async () => {
		const { session, counts } = fixture();
		const router = new InternalUrlRouter();
		const listing = await router.resolve("xd://", { session });
		expect(listing.content).toContain("1 mounted tool devices");
		expect(listing.content).toContain("xd://checkpoint");
		expect(listing.content).not.toContain("xd://grep");
		await router.write("xd://checkpoint", '{"path":"notes.txt"}', { session, toolCall: { id: "device-call" } });
		expect(counts().executed).toBe(1);
	});

	it("rejects missing sessions and unsupported subpaths instead of invoking", async () => {
		const router = new InternalUrlRouter();
		await expect(router.resolve("tool://")).rejects.toThrow("requires a session");
		await expect(router.resolve("tool://read/execute", { session: fixture().session })).rejects.toThrow(
			"Use tool://",
		);
	});
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, type Context } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger, stringifySettingsToml } from "@oh-my-pi/pi-utils";
import type {
	ExtensionAPI,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "../src/extensibility/extensions";
import { SessionManager } from "../src/session/session-manager";
import { createWorkContractsExtension } from "../src/work-contracts";
import { injectWorkContracts } from "../src/work-contracts/context";
import { CONTRACT_ENTRY, contractRequestSchema, readContracts } from "../src/work-contracts/store";
import { AgentStorage } from "../src/session/agent-storage";
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "work-contracts-"));
	roots.push(root);
	return root;
}
const model = buildModel({
	id: "gpt-4.1",
	name: "test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 1024,
});

async function harness(manager: SessionManager, root: string) {
	let command: RegisteredCommand["handler"] | undefined;
	let tool: ToolDefinition<typeof contractRequestSchema> | undefined;
	let active = ["read"];
	const notifications: string[] = [];
	const api = {
		registerCommand(_name: string, options: { handler: RegisteredCommand["handler"] }) {
			command = options.handler;
		},
		registerTool(definition: ToolDefinition<typeof contractRequestSchema>) {
			tool = definition;
		},
		on() {},
		appendEntry(customType: string, data: unknown) {
			manager.appendCustomEntry(customType, data);
		},
		getActiveTools: () => active,
		async setActiveTools(names: string[]) {
			active = names;
		},
	} as unknown as ExtensionAPI;
	await createWorkContractsExtension(path.join(root, "agent"))(api);
	const ctx = {
		cwd: root,
		sessionManager: manager,
		hasUI: true,
		ui: { notify: (text: string) => notifications.push(text), editor: async () => "Edited in editor" },
	} as unknown as ExtensionContext;
	return {
		command: async (args: string) => {
			if (!command) throw new Error("missing command");
			await command(args, ctx as Parameters<RegisteredCommand["handler"]>[1]);
		},
		tool: async (params: typeof contractRequestSchema.infer) => {
			if (!tool) throw new Error("missing tool");
			return await tool.execute("call-1", params, undefined, undefined, ctx);
		},
		active: () => active,
		notifications,
	};
}

describe("session work contracts", () => {
	test("SDK request preparation budgets wire tool definitions, not runtime session state", async () => {
		const root = await temp();
		const manager = SessionManager.inMemory(root);
		const h = await harness(manager, root);
		expect(readContracts(manager).clauses.size).toBe(0);
		const auth = await AuthStorage.create(path.join(root, "auth.db"));
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			sessionManager: manager,
			modelRegistry: new ModelRegistry(auth, path.join(root, "models.toml")),
			settings: Settings.isolated({}),
			model: { ...model, contextWindow: 200_000 },
			disableExtensionDiscovery: true,
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "bash", "edit"],
			restrictToolNames: true,
			skipPythonPreflight: true,
		});
		try {
			const unchangedRequest = await session.agent.buildSideRequestContext([]);
			expect(unchangedRequest.systemPrompt).toEqual(session.systemPrompt);
			expect(unchangedRequest.messages).toEqual([]);
			expect(unchangedRequest.tools?.map(tool => tool.name)).toEqual(["read", "bash", "edit"]);
			expect(readContracts(manager).agentAllowed).toBe(false);
			await h.command('set lane "The funnel publishes; the lane stays free."');
			const request = await session.agent.buildSideRequestContext([]);
			expect(request.systemPrompt?.at(-1)).toContain("The funnel publishes; the lane stays free.");
			expect(session.systemPrompt.join("\n")).not.toContain("The funnel publishes; the lane stays free.");
			await h.command("disable lane");
			expect((await session.agent.buildSideRequestContext([])).systemPrompt?.join("\n")).not.toContain(
				"The funnel publishes; the lane stays free.",
			);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	test.each([
		["empty", {}],
		[
			"existing nested",
			{
				task: { maxConcurrency: 4 },
				compaction: { enabled: true, thresholdPercent: 85 },
				live: { holdMode: false },
			},
		],
	] as const)(
		"production Settings.init accepts %s configuration without contract keys",
		async (_name, configuration) => {
			const state = beginSettingsTest();
			const root = await temp();
			try {
				const agentDir = path.join(root, "agent");
				await Bun.write(path.join(agentDir, "config.toml"), stringifySettingsToml(configuration));
				const settings = await Settings.init({ agentDir, cwd: root });
				await settings.reloadFromDisk();
				const manager = SessionManager.inMemory(root);
				const context = { systemPrompt: ["Existing policy"], messages: [] };
				expect(injectWorkContracts(context, model, manager, new Tokenizer(model))).toBe(context);
				expect(readContracts(manager).agentAllowed).toBe(false);
			} finally {
				AgentStorage.close();
				restoreSettingsTestState(state);
			}
		},
	);

	test("command and policy-gated tool share clauses, editor, and provenance", async () => {
		const root = await temp();
		const manager = SessionManager.inMemory(root);
		const turnId = manager.appendMessage({ role: "user", content: "Keep the lane free", timestamp: 1 });
		const h = await harness(manager, root);
		await expect(h.tool({ action: "set", id: "lane", text: "unauthorized" })).rejects.toThrow("disabled");
		expect(h.active()).not.toContain("contract");
		await h.command("set lane The lane stays free.");
		await h.command("policy on");
		expect(h.active()).toContain("contract");
		await h.tool({ action: "edit", id: "lane", text: "The funnel publishes; the lane stays free." });
		const clause = readContracts(manager).clauses.get("lane");
		expect(clause?.history.map(item => item.actor)).toEqual(["user", "agent"]);
		expect(clause?.history[0].turnId).toBe(turnId);
		expect(clause?.history[1].toolCallId).toBe("call-1");
		expect(Date.parse(clause!.history[0].at)).toBeGreaterThan(0);
		await h.command("edit lane");
		expect(readContracts(manager).clauses.get("lane")?.text).toBe("Edited in editor");
		await h.command("policy off");
		expect(h.active()).toEqual(["read"]);
		await expect(h.tool({ action: "remove", id: "lane" })).rejects.toThrow("disabled");
	});

	test("clauses survive compaction and disk resume, but not a new session", async () => {
		const root = await temp();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const h = await harness(manager, root);
		const turnId = manager.appendMessage({ role: "user", content: "Original turn", timestamp: 1 });
		await h.command("set lane Keep the lane free.");
		manager.appendCompaction("Summary without contract prose", undefined, turnId, 2000);
		await manager.ensureOnDisk();
		await manager.flush();
		const resumed = await SessionManager.open(manager.getSessionFile()!, path.join(root, "sessions"));
		const context = injectWorkContracts({ messages: [] }, model, resumed, new Tokenizer(model));
		expect(context.systemPrompt?.join("\n")).toContain("Keep the lane free.");
		expect(readContracts(resumed).clauses.get("lane")?.history[0].turnId).toBe(turnId);
		expect(readContracts(SessionManager.inMemory(root)).clauses.size).toBe(0);
	});

	test("promotion is explicit, scoped, audited, and never overwrites a rule", async () => {
		const root = await temp();
		const manager = SessionManager.inMemory(root);
		const h = await harness(manager, root);
		await h.command("set lane Keep the lane free.");
		await h.command("policy on");
		await expect(h.tool({ action: "promote", id: "lane", scope: "project" })).rejects.toThrow("explicit");
		await h.command("promote lane project");
		const target = path.join(root, ".omp", "rules", "contract-lane.md");
		expect(await Bun.file(target).text()).toBe("---\nalwaysApply: true\n---\n\nKeep the lane free.\n");
		expect(readContracts(manager).clauses.get("lane")?.promotions).toEqual([target]);
		await expect(h.command("promote lane project")).rejects.toThrow();
		await expect(h.command("set ../escape nope")).rejects.toThrow("Contract id");
		await expect(h.tool({ action: "policy", allowed: false })).rejects.toThrow("Only the user");
	});

	test("request-local injection reflects activation and removal without retaining stale copies", async () => {
		const root = await temp();
		const manager = SessionManager.inMemory(root);
		const h = await harness(manager, root);
		const base = { systemPrompt: ["Base policy"], messages: [] };
		expect(injectWorkContracts(base, model, manager, new Tokenizer(model))).toBe(base);
		await h.command("set zeta Z clause");
		await h.command("set alpha A clause");
		const injected = injectWorkContracts(base, model, manager, new Tokenizer(model));
		expect(injected.systemPrompt?.[1].indexOf("alpha")).toBeLessThan(injected.systemPrompt![1].indexOf("zeta"));
		expect(base.systemPrompt).toEqual(["Base policy"]);
		await h.command("disable alpha");
		expect(injectWorkContracts(base, model, manager, new Tokenizer(model)).systemPrompt?.join("\n")).not.toContain(
			"A clause",
		);
		await h.command("enable alpha");
		await h.command("remove zeta");
		expect(injectWorkContracts(base, model, manager, new Tokenizer(model)).systemPrompt?.join("\n")).toContain(
			"A clause",
		);
	});

	test("reserved rendering preserves clause markup and whitespace verbatim", async () => {
		const root = await temp();
		const manager = SessionManager.inMemory(root);
		const h = await harness(manager, root);
		const text = "Keep **MUST NOT** literal.\n\n<!-- operational comment -->\n\tIndented <data> & raw.";
		await h.command(JSON.stringify({ action: "set", id: "literal", text }));
		const context = injectWorkContracts({ messages: [] }, model, manager, new Tokenizer(model));
		expect(context.systemPrompt?.at(-1)).toContain(text);
	});

	test("an empty contract journal never injects or checks a context budget", () => {
		const manager = SessionManager.inMemory();
		const tokenizer = new Tokenizer(model);
		const countTokens = spyOn(tokenizer, "countTokens");
		const countMessages = spyOn(tokenizer, "countMessages");
		try {
			const context = { systemPrompt: ["Existing policy".repeat(100)], messages: [] };
			expect(injectWorkContracts(context, { ...model, contextWindow: 1 }, manager, tokenizer)).toBe(context);
			expect(countTokens).not.toHaveBeenCalled();
			expect(countMessages).not.toHaveBeenCalled();
		} finally {
			countTokens.mockRestore();
			countMessages.mockRestore();
		}
	});

	test("unknown context windows keep contracts intact without reserving an invented budget", async () => {
		const root = await temp();
		const manager = SessionManager.inMemory(root);
		const h = await harness(manager, root);
		const text = "Keep the lane free. ".repeat(100).trim();
		await h.command(`set lane ${text}`);
		const unknownWindowModel = { ...model, contextWindow: null };
		const tokenizer = new Tokenizer(unknownWindowModel);
		const countTokens = spyOn(tokenizer, "countTokens");
		const countMessages = spyOn(tokenizer, "countMessages");
		const debug = spyOn(logger, "debug").mockImplementation(() => {});
		try {
			const base = { systemPrompt: ["Base policy"], messages: [] };
			const injected = injectWorkContracts(base, unknownWindowModel, manager, tokenizer);
			expect(injected.systemPrompt?.[0]).toBe("Base policy");
			expect(injected.systemPrompt?.at(-1)).toContain(text);
			expect(base.systemPrompt).toEqual(["Base policy"]);
			expect(countTokens).not.toHaveBeenCalled();
			expect(countMessages).not.toHaveBeenCalled();
			expect(debug).toHaveBeenCalledWith(
				"Skipping work contract budget sizing because the model context window is unknown",
				{ provider: model.provider, model: model.id },
			);
		} finally {
			countTokens.mockRestore();
			countMessages.mockRestore();
			debug.mockRestore();
		}
	});

	test.each(["system", "messages", "tools", "inactiveTools"] as const)(
		"short clauses still fail visibly when existing %s fill the context",
		async part => {
			const root = await temp();
			const manager = SessionManager.inMemory(root);
			const h = await harness(manager, root);
			await h.command("set lane The funnel publishes; the lane stays free.");
			const text = "Existing context fills the window. ".repeat(50_000);
			const context: Context = { messages: [] };
			if (part === "system") context.systemPrompt = [text];
			else if (part === "messages") context.messages = [{ role: "user", content: text, timestamp: 1 }];
			else context[part] = [{ name: "existing", description: text, parameters: { type: "object" } }];
			expect(() =>
				injectWorkContracts(context, { ...model, contextWindow: 200_000 }, manager, new Tokenizer(model)),
			).toThrow("No contract text was truncated");
			expect(context.systemPrompt).toEqual(part === "system" ? [text] : undefined);
		},
	);

	test("budget overflow surfaces instead of dropping or trimming contract text", async () => {
		const root = await temp();
		const manager = SessionManager.inMemory(root);
		const h = await harness(manager, root);
		const text = "Keep the lane free. ".repeat(50_000).trim();
		await h.command(`set lane ${text}`);
		expect(() =>
			injectWorkContracts({ messages: [] }, { ...model, contextWindow: 200_000 }, manager, new Tokenizer(model)),
		).toThrow("No contract text was truncated");
		expect(readContracts(manager).clauses.get("lane")?.text).toBe(text);
	});

	test("invalid persisted contracts fail visibly rather than silently disappear", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(CONTRACT_ENTRY, { version: 999 });
		expect(() => readContracts(manager)).toThrow("Invalid persisted session contract");
	});
});

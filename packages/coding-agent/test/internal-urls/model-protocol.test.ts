import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import * as modelInfo from "../../src/config/model-info";
import type { ModelInfoLookup } from "../../src/config/model-info";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AgentStorage } from "../../src/session/agent-storage";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { resolveApproval } from "../../src/tools/approval";
import { ReadTool } from "../../src/tools/read";
import { WriteTool } from "../../src/tools/write";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const fixtureResult: ModelInfoLookup = {
	selector: "current",
	kind: "current",
	selected: "lookup-provider/lookup-model",
	matchCount: 0,
	truncated: false,
	limit: 25,
	models: [],
};

describe("model:// session lookup", () => {
	let dir: string;
	let auth: AuthStorage;
	let state: SettingsTestState | undefined;
	let sdkSession: AgentSession | undefined;
	beforeEach(async () => {
		state = beginSettingsTest();
		const scratch = path.join(os.homedir(), ".cache/npi-canary");
		await fs.mkdir(scratch, { recursive: true });
		dir = await fs.mkdtemp(path.join(scratch, "model-info-"));
		auth = await AuthStorage.create(":memory:");
	});
	afterEach(async () => {
		await sdkSession?.dispose();
		sdkSession = undefined;
		vi.restoreAllMocks();
		auth.close();
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		InternalUrlRouter.resetForTests();
		await fs.rm(dir, { recursive: true, force: true });
	});

	function fixture(settings = Settings.isolated()) {
		const registry = new ModelRegistry(auth, path.join(dir, "models.yml"), {
			settings,
			fetch: async () => {
				throw new Error("unexpected network");
			},
		});
		registry.registerProvider("lookup-provider", {
			api: "openai-completions",
			baseUrl: "https://lookup.invalid/v1",
			auth: "none",
			models: [
				{
					id: "lookup-model",
					name: "Lookup model",
					reasoning: true,
					input: ["text"],
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
				},
			],
		});
		const model = registry.find("lookup-provider", "lookup-model");
		if (!model) throw new Error("fixture model missing");
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
			modelRegistry: registry,
			getActiveModel: () => model,
			getActiveModelString: () => "lookup-provider/lookup-model",
			getActiveEffort: () => ({
				level: Effort.High,
				origin: "caller",
				selection: { mode: "fixed", level: Effort.High },
			}),
			getActualThinkingLevel: () => Effort.High,
		};
		return { session, registry, model };
	}

	it("preserves exact selectors, role syntax, effort suffixes and encoded patterns", async () => {
		const { session } = fixture();
		const lookup = vi.spyOn(modelInfo, "lookupModelInfo").mockResolvedValue(fixtureResult);
		const router = new InternalUrlRouter();
		const cases = [
			["model://", ""],
			["model://Provider/Model:high", "Provider/Model:high"],
			["model://@task", "@task"],
			["model://Provider/Model%3F", "Provider/Model?"],
			[`model://?selector=${encodeURIComponent("re:provider/(mini|nano):high")}`, "re:provider/(mini|nano):high"],
		] as const;
		for (const [url, selector] of cases) {
			const result = await router.resolve(url, { session, settings: Settings.isolated() });
			expect(lookup).toHaveBeenLastCalledWith(selector, session);
			expect(JSON.parse(result.content)).toEqual(fixtureResult);
			expect(result.shape).toBe("value");
		}
	});

	it("rejects ambiguous or malformed URL input before looking up a model", async () => {
		const { session } = fixture();
		const lookup = vi.spyOn(modelInfo, "lookupModelInfo").mockResolvedValue(fixtureResult);
		const router = new InternalUrlRouter();
		for (const url of [
			"model://@task?selector=other",
			"model://?selector=a&selector=b",
			"model://?unknown=a",
			"model://@task#part",
			"model://provider/%ZZ",
		]) {
			await expect(router.resolve(url, { session })).rejects.toThrow("model://");
		}
		expect(lookup).not.toHaveBeenCalled();
		await expect(router.resolve("model://")).rejects.toThrow("calling session");
	});

	it("routes the real lookup through read without exposing transport or allowing writes", async () => {
		const { session } = fixture();
		const result = await new ReadTool(session).execute("model-info-read", { path: "model://" });
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		const payload = JSON.parse(text) as ModelInfoLookup;
		expect(payload.selected).toBe("lookup-provider/lookup-model");
		expect(payload.models[0]?.reasoning).toEqual({ status: "observed", level: Effort.High });
		expect(text).not.toContain("https://lookup.invalid");
		expect(resolveApproval(new WriteTool(session), { path: "model://", content: "{}" }, "always-ask")).toMatchObject({
			policy: "deny",
			source: "tool",
		});
	});

	it("advertises a bounded lookup rather than injecting a model table", () => {
		const router = new InternalUrlRouter();
		expect(router.spec("model")?.selectors).toBe("none");
		const docs = router
			.describe({
				skillUriAccess: false,
				ruleCount: 0,
				securityEnabled: false,
				settingsApproval: false,
				outReplies: false,
			})
			.join("\n");
		expect(docs).toContain("model://");
		expect(docs).not.toContain("lookup-provider/lookup-model");
	});

	it("keeps startup Auto pending and reads the real SDK concrete resolution when it exists", async () => {
		const settings = await Settings.init({ cwd: dir, agentDir: path.join(dir, "agent") });
		const { registry, model } = fixture(settings);
		const result = await createAgentSession({
			cwd: dir,
			agentDir: path.join(dir, "agent"),
			settings,
			modelRegistry: registry,
			authStorage: auth,
			model,
			thinkingLevel: AUTO_THINKING,
			sessionManager: SessionManager.inMemory(),
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sdkSession = result.session;
		const read = sdkSession.getToolByName("read");
		if (!read) throw new Error("SDK read tool missing");
		const inspect = async (): Promise<ModelInfoLookup> => {
			const response = await read.execute("sdk-model-info", { path: "model://", i: "Inspecting active reasoning" });
			return JSON.parse(
				response.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n"),
			) as ModelInfoLookup;
		};
		expect(sdkSession.thinkingLevel).toBeDefined();
		expect((await inspect()).models[0]?.reasoning).toEqual({ status: "pending-auto" });
		const classified = vi.spyOn(sdkSession, "autoResolvedThinkingLevel").mockReturnValue(Effort.High);
		expect((await inspect()).models[0]?.reasoning).toEqual({ status: "observed", level: Effort.High });
		sdkSession.setThinkingLevel(Effort.Low);
		expect((await inspect()).models[0]?.reasoning).toEqual({ status: "observed", level: Effort.Low });
		classified.mockRestore();
		sdkSession.setThinkingLevel(AUTO_THINKING);
		expect((await inspect()).models[0]?.reasoning).toEqual({ status: "pending-auto" });
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { registerMixtureApi } from "@oh-my-pi/pi-coding-agent/moa/provider";
import { MIXTURE_RUN_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/moa/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import {
	getProjectAgentDir,
	getProjectDir,
	setProjectDir,
	removeSyncWithRetries,
	Snowflake,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createMoaFixture, createMoaSession, DRAFT_THEN_EDIT_TOML, FakeMembers } from "./helpers/moa-setup";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it.each(["disabled", "empty", "failed"] as const)(
		"drops source Hindsight context after cwd rebind when destination recall is %s",
		async destinationRecall => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-memory-prompt-move-"));
			tempDirs.push(tempDir);
			const cwdA = path.join(tempDir, "cwd-a");
			const cwdB = path.join(tempDir, "cwd-b");
			const agentDir = path.join(tempDir, "agent");
			let moved = false;
			const recalledBanks: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const pathname = new URL(request.url).pathname;
					if (request.method === "PUT") return Response.json({});
					if (pathname.endsWith("/mental-models")) {
						return Response.json({
							items: [{ id: "source-model", name: "Source model", content: "SOURCE-MODEL-CANARY" }],
						});
					}
					if (pathname.endsWith("/memories/recall")) {
						recalledBanks.push(pathname.split("/")[4]!);
						if (moved && destinationRecall === "failed") return new Response("unavailable", { status: 503 });
						return Response.json({ results: moved ? [] : [{ id: "source-fact", text: "SOURCE-RECALL-CANARY" }] });
					}
					return new Response("Unexpected request", { status: 404 });
				},
			});
			const authStorage = createInMemoryAuthStorage();
			let session: AgentSession | undefined;
			try {
				// The failed-recall case keeps the bank but changes configuration.
				const destinationBank = destinationRecall === "failed" ? "source" : "destination";
				await Promise.all(
					[cwdA, cwdB].map(cwd =>
						Bun.write(
							path.join(getProjectAgentDir(cwd), "config.yml"),
							Bun.YAML.stringify({
								memory: { backend: "hindsight" },
								hindsight: {
									apiUrl: server.url.href,
									bankId: cwd === cwdA ? "source" : destinationBank,
									autoRecall: cwd === cwdA || destinationRecall !== "disabled",
									autoRetain: false,
									mentalModelsEnabled: cwd === cwdA,
									mentalModelAutoSeed: false,
								},
							}),
						),
					),
				);
				const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
				const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
				authStorage.keys.setRuntime("openai", "test-key");
				({ session } = await createAgentSession({
					cwd: cwdA,
					agentDir,
					sessionManager,
					authStorage,
					modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
					settings,
					model: getBundledModel("openai", "gpt-4o-mini"),
					toolNames: ["read"],
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					rules: [],
					preloadedCustomToolPaths: [],
				}));
				const model = createMockModel({ handler: { content: ["ok"] } });
				session.agent.streamFn = model.stream;
				await session.getHindsightSessionState()?.mentalModelsLoadPromise;
				await session.prompt("Summarize this project.");
				const sourcePrompt = model.calls[0]!.context.systemPrompt!.join("\n");
				expect(sourcePrompt).toContain("SOURCE-RECALL-CANARY");
				expect(sourcePrompt).toContain("SOURCE-MODEL-CANARY");

				moved = true;
				await sessionManager.moveTo(cwdB);
				await settings.reloadForCwd(cwdB);
				// Rebinding must clear memory without depending on a later skill/tool refresh.
				await rebindMemoryBackendForCwd(session);
				expect(session.getHindsightSessionState()?.bankId).toBe(destinationBank);
				const movedPrompt = session.agent.state.systemPrompt.join("\n");
				await session.prompt("Summarize the destination project.");
				expect(model.calls).toHaveLength(2);
				const destinationPrompt = model.calls[1]!.context.systemPrompt!.join("\n");
				expect(recalledBanks).toEqual(destinationRecall === "disabled" ? ["source"] : ["source", destinationBank]);
				for (const prompt of [movedPrompt, destinationPrompt]) {
					expect(prompt).not.toContain("SOURCE-RECALL-CANARY");
					expect(prompt).not.toContain("SOURCE-MODEL-CANARY");
					expect(prompt).toContain("# Memory");
				}
			} finally {
				await session?.dispose();
				authStorage.close();
				await server.stop(true);
			}
		},
	);

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["bash"],
		});

		try {
			await sessionManager.moveTo(cwdB);

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const result = await bashTool.execute("pwd-after-move", { command: "pwd" });

			expect(textContent(result)).toContain(cwdB);
		} finally {
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
	it.each(["hindsight", "mnemopi"] as const)("keeps %s disabled in restricted sessions after /move", async backend => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-restricted-memory-move-"));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		const agentDir = path.join(tempDir, "agent");
		await Promise.all(
			[cwdA, cwdB].map(cwd =>
				Bun.write(
					path.join(getProjectAgentDir(cwd), "config.yml"),
					Bun.YAML.stringify({
						memory: { backend },
						hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
						mnemopi: { noEmbeddings: true, llmMode: "none" },
					}),
				),
			),
		);
		const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const authStorage = createInMemoryAuthStorage();
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir,
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			restrictToolNames: true,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
		});
		const originalProjectDir = getProjectDir();
		try {
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			const output: string[] = [];
			await executeAcpBuiltinSlashCommand("/move " + cwdB, {
				session,
				sessionManager,
				settings,
				cwd: cwdA,
				output: text => {
					output.push(text);
				},
				refreshCommands: () => { },
				reloadPlugins: async () => { },
			});
			expect(output.join("\n")).toContain("Moved to ");
			expect(sessionManager.getCwd()).toBe(cwdB);
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			// Explicit backend reapplication must preserve the same startup policy.
			await session.applyMemoryBackend();
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			setProjectDir(originalProjectDir);
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
});

describe("headless /move mixture run continuity", () => {
	it("rebinds same-name mixture metadata on move and restores it after a failed move", async () => {
		const root = TempDir.createSync("@moa-move-");
		const originalProjectDir = getProjectDir();
		const members = new FakeMembers();
		registerMixtureApi();
		const fixture = await createMoaFixture(root);
		const destination = root.join("destination");
		fs.mkdirSync(destination);
		await Bun.write(
			path.join(getProjectAgentDir(fixture.cwd), "MIXTURES.toml"),
			DRAFT_THEN_EDIT_TOML.replace("tools = false", "tools = false\nmax_tokens = 8000"),
		);
		await Bun.write(
			path.join(getProjectAgentDir(destination), "MIXTURES.toml"),
			`[[mixtures]]
name = "draft-then-edit"
entry = "editor"

[[mixtures.members]]
id = "editor"
model = "fake/editor"
system_prompt = "Return the final answer."
tools = false
max_tokens = 2000
`,
		);
		const manager = SessionManager.create(fixture.cwd, root.join("sessions"));
		const settings = Settings.isolated({ "compaction.enabled": false });
		const session = await createMoaSession(fixture, { sessionManager: manager, settings });
		const checkpointIds = () =>
			manager
				.getBranch()
				.flatMap(entry =>
					entry.type === "custom" &&
						entry.customType === MIXTURE_RUN_ENTRY_TYPE &&
						"reason" in (entry.data as object)
						? [(entry.data as { run: { id: string } }).run.id]
						: [],
				);
		const output: string[] = [];
		const runtime = {
			session,
			sessionManager: manager,
			settings,
			cwd: fixture.cwd,
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => { },
			reloadPlugins: async () => { },
		};
		const notices: string[] = [];
		const modelChanges: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "mixture") notices.push(event.message);
			if (event.type === "model_changed") {
				const model = session.agent.state.model;
				modelChanges.push(`${model?.input.join(",")}/${model?.maxTokens}`);
			}
		});
		try {
			await session.setModel(fixture.registry.find("mixture", "draft-then-edit")!);
			expect(session.agent.state.model?.input).toEqual(["text", "image"]);
			expect(session.agent.state.model?.maxTokens).toBe(8000);
			expect(session.agent.state.model?.contextWindow).toBe(64_000);
			expect(modelChanges.at(-1)).toBe("text,image/8000");
			await session.sendUserMessage("first");
			const sourceRun = checkpointIds().at(-1);
			expect(sourceRun).toBeDefined();

			let failRefresh = true;
			runtime.reloadPlugins = async () => {
				if (failRefresh) {
					failRefresh = false;
					throw new Error("destination plugin refresh failed");
				}
			};
			await executeAcpBuiltinSlashCommand(`/move ${destination}`, runtime);
			expect(manager.getCwd()).toBe(fixture.cwd);
			expect(output.join("\n")).toContain("Move failed: destination plugin refresh failed");
			expect(session.agent.state.model?.provider).toBe("mixture");
			expect(session.agent.state.model?.id).toBe("draft-then-edit");
			expect(session.agent.state.model?.input).toEqual(["text", "image"]);
			expect(session.agent.state.model?.maxTokens).toBe(8000);
			expect(session.agent.state.model?.contextWindow).toBe(64_000);
			expect(modelChanges).toContain("text/2000");
			expect(modelChanges.at(-1)).toBe("text,image/8000");

			expect(notices).toEqual([]);

			runtime.reloadPlugins = async () => { };
			await executeAcpBuiltinSlashCommand(`/move ${destination}`, runtime);
			expect(manager.getCwd()).toBe(destination);
			expect(session.agent.state.model?.provider).toBe("mixture");
			expect(session.agent.state.model?.id).toBe("draft-then-edit");
			expect(session.agent.state.model?.input).toEqual(["text"]);
			expect(session.agent.state.model?.maxTokens).toBe(2000);
			expect(session.agent.state.model?.contextWindow).toBe(64_000);
			expect(modelChanges.at(-1)).toBe("text/2000");
			expect(notices).toEqual([
				"1 mixture run from the previous workspace was reset; the next message starts a new run",
			]);
			await session.sendUserMessage("second");
			expect(checkpointIds().at(-1)).not.toBe(sourceRun);
			expect(members.callsTo("writer")).toHaveLength(1);
			expect(members.callsTo("editor")).toHaveLength(2);
		} finally {
			await session.dispose();
			fixture.authStorage.close();
			clearCustomApis();
			setProjectDir(originalProjectDir);
			root.removeSync();
		}
	});
});

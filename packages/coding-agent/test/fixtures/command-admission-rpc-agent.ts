import { spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ControlHost } from "../../src/control/host";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode";
import { saveCustomPersonality } from "../../src/neopi/personality-settings";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";

spyOn(globalThis, "fetch").mockRejectedValue(new Error("Command admission fixture refuses network access"));
const output = (frame: object): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};
const root = process.env.PI_CODING_AGENT_DIR!;
const authStorage = await AuthStorage.create(":memory:");
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
const sessionManager = SessionManager.inMemory(root);
const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
saveCustomPersonality(settings, "global", "Warm", "A warm fixture voice.");
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.on("input", async (event, ctx) => {
			if (event.text === "to-settings") return { text: "/settings" };
			if (event.text === "consume") return { handled: true };
			if (event.text === "wait-for-ui") {
				await ctx.ui.confirm("Release stale input?", "Command setup is pending");
				return { text: "/personality Warm" };
			}
			return undefined;
		});
		if (process.env.RPC_ADMISSION_OVERRIDES === "1") {
			pi.registerCommand("settings", {
				description: "Fixture extension override",
				handler: async () => {
					output({ type: "fixture_override", name: "settings" });
				},
			});
		}
	},
	root,
	new EventBus(),
	runtime,
	"command-admission",
);
const extensionRunner = new ExtensionRunner([extension], runtime, root, sessionManager, modelRegistry);
const mock = createMockModel({
	handler: context => {
		const last = context.messages.at(-1);
		const held = last?.role === "user" && JSON.stringify(last.content).includes("hold-model");
		output({ type: "fixture_model", held });
		return { content: ["ok"], ...(held ? { delayMs: 300_000 } : {}) };
	},
});
const session = new AgentSession({
	agent: new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	}),
	sessionManager,
	settings,
	modelRegistry,
	extensionRunner,
});
const prompt = session.prompt.bind(session);
session.prompt = async (text, options) => {
	output({ type: "fixture_prompt", text, options });
	return prompt(text, options);
};
if (process.env.RPC_ADMISSION_OVERRIDES === "1") {
	session.setMCPPromptCommands([
		{
			path: import.meta.path,
			resolvedPath: import.meta.path,
			source: "user",
			command: {
				name: "hotkeys",
				description: "Fixture custom override",
				execute: () => {
					output({ type: "fixture_override", name: "hotkeys" });
					return undefined;
				},
			},
		},
	]);
}
const host = new ControlHost({ session, role: "rpc", dir: path.join(root, "control"), tmuxPane: null });
await host.start();
output({ type: "fixture_control", metadata: host.publication!.metadata() });
await runRpcMode(session);

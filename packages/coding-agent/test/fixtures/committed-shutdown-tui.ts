import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem } from "@oh-my-pi/pi-utils";

const cwd = process.cwd();
initTheme();
await Settings.init({ inMemory: true, cwd });
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
const modelRegistry = new ModelRegistry(authStorage);
const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled model");
const session = new AgentSession({
	agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
	sessionManager: SessionManager.create(cwd, cwd),
	settings: Settings.isolated(),
	modelRegistry,
});
const mode = new InteractiveMode(session, "test");
await mode.init({ suppressWelcomeIntro: true });
postmortem.register("committed-shutdown-test", async () => {
	process.stdout.write("committed-shutdown: cleanup started\n");
	await Promise.withResolvers<void>().promise;
});
process.stdout.write("committed-shutdown: ready\n");

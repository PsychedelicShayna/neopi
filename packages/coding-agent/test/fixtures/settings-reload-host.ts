import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ControlHost } from "../../src/control/host";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const settings = await Settings.loadIsolated({ agentDir: process.env.PI_CODING_AGENT_DIR, cwd: process.cwd() });
const auth = createInMemoryAuthStorage();
const model = createMockModel({ provider: "anthropic", responses: [] });
const session = new AgentSession({
	agent: new Agent({
		getApiKey: () => "test",
		initialState: { model, systemPrompt: [], tools: [] },
		streamFn: model.stream,
	}),
	sessionManager: SessionManager.inMemory(process.cwd()),
	settings,
	modelRegistry: new ModelRegistry(auth, `${process.env.PI_CODING_AGENT_DIR}/models.yml`),
});
const host = new ControlHost({ session, role: "rpc" });
await host.start();
host.markReady();
// No file watcher: every refresh in this fixture must come from the control RPC.
await Bun.stdin.text();
await host.close();
await session.dispose();
settings.cancelPendingSaves();
auth.close();

/**
 * Issue #668: stdio RPC advertises `dictation`, and `get_state` reports whether speech-to-text is enabled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RPC_CAPABILITIES, stdioCapabilities } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-capabilities";
import { buildRpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("dictation discovery", () => {
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
	});

	function stateWith(settings: Settings) {
		authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		session = new AgentSession({
			agent: new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		return buildRpcSessionState(session, { includeDump: false });
	}

	test("the stdio ready frame advertises dictation; the shared capability list, which the control socket reuses, does not", () => {
		expect(stdioCapabilities()).toContain("dictation");
		expect(RPC_CAPABILITIES).not.toContain("dictation");
		for (const capability of RPC_CAPABILITIES) expect(stdioCapabilities()).toContain(capability);
	});

	test("get_state reports speech-to-text off by default", () => {
		expect(stateWith(Settings.isolated({})).dictationEnabled).toBe(false);
	});

	test("get_state reports speech-to-text on when stt.enabled is set", () => {
		expect(stateWith(Settings.isolated({ "stt.enabled": true })).dictationEnabled).toBe(true);
	});
});

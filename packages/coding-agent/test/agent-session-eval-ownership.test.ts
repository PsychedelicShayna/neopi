import { expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { ModelRegistry } from "../src/config/model-registry";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

it("fallback eval sessions share the parent kernel and dispose it after the last owner leaves", async () => {
	using temp = TempDir.createSync("@omomp-eval-ownership-");
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth);
	const sessions: AgentSession[] = [];
	const parentEvalSessionId = `parent:${Bun.randomUUIDv7()}`;
	const create = () => {
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(temp.path()),
			settings: Settings.isolated({ "chronicler.enabled": false, "advisor.enabled": false }),
			modelRegistry: registry,
			parentEvalSessionId,
			evalKernelOwnerId: `owner:${Bun.randomUUIDv7()}`,
		});
		sessions.push(session);
		return session;
	};
	try {
		const first = create();
		const second = create();
		expect((await first.executeEval("js", "var shared = 41; return shared;")).output.trim()).toBe("41");
		expect((await second.executeEval("js", "return shared + 1;")).output.trim()).toBe("42");
		await first.dispose();
		expect((await second.executeEval("js", "return shared;")).output.trim()).toBe("41");
		await second.dispose();
		expect((await create().executeEval("js", "return typeof shared;")).output.trim()).toBe("undefined");
	} finally {
		for (const session of sessions) await session.dispose();
		auth.close();
	}
});

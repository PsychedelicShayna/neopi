import { expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { SessionManager } from "../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

test("two live advisors granted irc without write join and speak in a council as distinct peers", async () => {
	await using directory = await TempDir.create("@pi-irc-advisors-");
	const cwd = directory.path();
	const registry = AgentRegistry.global();
	const ownerId = "IrcCouncilOwner";
	const recipient = "IrcCouncilScout";
	const firstId = `${ownerId}/advisor:architect`;
	const secondId = `${ownerId}/advisor:auditor`;
	const received: IrcMessage[] = [];
	const receiver = registry.register({
		id: recipient,
		kind: "sub",
		displayName: recipient,
		parentId: ownerId,
		session: {
			deliverIrcMessage: async (message: IrcMessage) => {
				received.push(message);
				return "injected";
			},
		} as unknown as AgentSessionHandle,
	});
	const settings = Settings.isolated({ "advisor.enabled": true });
	settings.setModelRole("advisor", "openai/gpt-4o-mini");
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected bundled advisor model");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("openai", "test-key");
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		agentId: ownerId,
		model,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, directory.join("models.yml")),
		settings,
		sessionManager: SessionManager.inMemory(cwd),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		contextFiles: [],
		rules: [],
		toolNames: ["read"],
		advisorConfigs: [
			{ name: "Architect", tools: ["irc"] },
			{ name: "Auditor", tools: ["irc"] },
		],
	});
	try {
		const [first, second] = session.liveAdvisors();
		expect([first?.slug, second?.slug]).toEqual(["architect", "auditor"]);
		const firstTools = first!.agent.state.tools;
		const secondTools = second!.agent.state.tools;
		expect(firstTools.map(tool => tool.name)).not.toContain("write");
		expect(secondTools.map(tool => tool.name)).not.toContain("write");
		const architect = firstTools.find(tool => tool.name === "irc");
		const auditor = secondTools.find(tool => tool.name === "irc");
		if (!architect || !auditor) throw new Error("Expected both advisor IRC grants");
		const firstMessageCount = first!.agent.state.messages.length;
		const secondMessageCount = second!.agent.state.messages.length;
		const group = "advisor-council";
		expect((await architect.execute("create", { op: "create", group, members: [firstId, recipient] })).isError).toBe(
			false,
		);
		expect((await auditor.execute("join", { op: "add", group, members: [secondId] })).isError).toBe(false);
		expect((await auditor.execute("mine", { op: "my_groups" })).content).toEqual([
			{ type: "text", text: "advisor-council (3)" },
		]);
		received.length = 0;
		expect((await architect.execute("first", { op: "send", group, message: "Design finding" })).isError).toBe(false);
		expect((await auditor.execute("second", { op: "send", group, message: "Audit finding" })).isError).toBe(false);
		expect(received.map(message => ({ from: message.from, body: message.body }))).toEqual([
			{ from: firstId, body: `${firstId} sent this to group ${group}, which you are part of.\n\nDesign finding` },
			{ from: secondId, body: `${secondId} sent this to group ${group}, which you are part of.\n\nAudit finding` },
		]);
		expect(first!.agent.state.messages).toHaveLength(firstMessageCount);
		expect(second!.agent.state.messages).toHaveLength(secondMessageCount);
	} finally {
		IrcBus.resetGlobalForTests();
		registry.unregister(recipient, receiver);
		await session.dispose();
		authStorage.close();
	}
});

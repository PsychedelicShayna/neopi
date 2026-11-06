import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { buildJobResult, snapshotJobs } from "../src/async/job-control";
import { AsyncJobManager } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ProcProtocolHandler } from "../src/internal-urls/proc-protocol";
import { HistoryProtocolHandler } from "../src/internal-urls/history-protocol";
import type { InternalUrl } from "../src/internal-urls/types";
import { RpcSubagentRegistry } from "../src/modes/rpc/rpc-subagents";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import type { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { collectIrcPeerRoster } from "../src/task/executor";
import type { SubagentLifecyclePayload } from "../src/task/types";
import type { ToolSession } from "../src/tools";
import { EventBus } from "../src/utils/event-bus";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const id = "ListingWorker";
const identity = "anthropic/claude-sonnet-4-5";

describe("live subagent listing facts", () => {
	let root: string;
	let auth: AuthStorage;
	let child: AgentSession;
	let rpc: RpcSubagentRegistry;
	let tools: ToolSession;
	let parentFile: string;
	let childFile: string;
	const jobs = [
		{
			id,
			type: "task" as const,
			status: "running",
			label: id,
			startTime: 0,
			latestDetails: {
				progress: [
					{
						id,
						resolvedModel: `${identity}:low`,
						resolvedModelIdentity: identity,
						resolvedThinkingLevel: ThinkingLevel.Low,
					},
				],
			},
		},
	];

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		const scratch = path.join(os.homedir(), ".cache", "npi-canary");
		await fs.mkdir(scratch, { recursive: true });
		root = await fs.mkdtemp(path.join(scratch, "live-listings-"));
		parentFile = path.join(root, "parent.jsonl");
		childFile = path.join(root, "parent", `${id}.jsonl`);
		auth = createInMemoryAuthStorage();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing bundled test model");
		child = new AgentSession({
			agent: new Agent({ initialState: { model, thinkingLevel: ThinkingLevel.Low }, convertToLlm }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(auth, path.join(root, "models.toml")),
			thinkingLevel: ThinkingLevel.Low,
		});
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "Main",
			session: child,
			sessionFile: childFile,
		});
		rpc = new RpcSubagentRegistry(new EventBus(), () => {});
		rpc.handleLifecycle({
			id,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			runToken: "run",
			status: "started",
			sessionFile: childFile,
		} satisfies SubagentLifecyclePayload);
		tools = {
			agentRegistry: AgentRegistry.global(),
			getAgentId: () => "Main",
			getSessionFile: () => parentFile,
			settings: Settings.isolated({ "launch.enabled": false }),
		} as unknown as ToolSession;
	});

	afterEach(async () => {
		rpc.dispose();
		await child.dispose();
		auth.close();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	function edit(): void {
		child.setThinkingLevel(ThinkingLevel.High, false);
		child.setFastMode(true);
	}

	test("RPC snapshots reread current effort and distinguish enabled fast from active fast", () => {
		expect(rpc.getSubagents()[0]).toMatchObject({
			resolvedModelIdentity: identity,
			resolvedThinkingLevel: ThinkingLevel.Low,
		});
		vi.spyOn(child, "isFastModeActive").mockReturnValue(false);
		edit();
		expect(child.isFastModeEnabled()).toBe(true);
		expect(child.isFastModeActive()).toBe(false);
		expect(rpc.getSubagents()[0]).toMatchObject({
			resolvedModel: `${identity}:high`,
			resolvedModelIdentity: identity,
			resolvedThinkingLevel: ThinkingLevel.High,
			fastModeEnabled: child.isFastModeEnabled(),
			fastModeActive: child.isFastModeActive(),
		});
	});

	test("RPC snapshots do not hydrate an identically named child from another session", () => {
		AgentRegistry.global().get(id)!.sessionFile = path.join(root, "other", `${id}.jsonl`);
		edit();
		expect(rpc.getSubagents()[0]).not.toHaveProperty("fastModeEnabled");
		expect(rpc.getSubagents()[0]).not.toHaveProperty("resolvedThinkingLevel");
	});

	test("task snapshots override stale progress with the owned live session", () => {
		edit();
		expect(snapshotJobs(tools, jobs)[0]).toMatchObject({
			resolvedModel: `${identity}:high`,
			resolvedModelIdentity: identity,
			resolvedThinkingLevel: ThinkingLevel.High,
			fastModeEnabled: child.isFastModeEnabled(),
			fastModeActive: child.isFastModeActive(),
		});
		AgentRegistry.global().get(id)!.sessionFile = path.join(root, "other", `${id}.jsonl`);
		expect(snapshotJobs(tools, jobs)[0]).toMatchObject({ resolvedThinkingLevel: ThinkingLevel.Low });
		expect(snapshotJobs(tools, jobs)[0]).not.toHaveProperty("fastModeEnabled");
	});

	test("model-facing job and proc listings include current model and effort", async () => {
		edit();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const result = buildJobResult(tools, manager, "jobs", jobs, []);
		const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(text).toContain(identity);
		expect(text).toContain("effort=high");
		const url = {
			href: "proc://",
			rawHref: "proc://",
			rawHost: "",
			pathname: "",
			search: "",
			hash: "",
		} as InternalUrl;
		const listing = await new ProcProtocolHandler().resolve(url, { session: tools });
		expect(listing.content).toContain(identity);
		expect(listing.content).toContain("effort=high");
	});

	test("peer roster rereads current effort and fast state", () => {
		edit();
		expect(collectIrcPeerRoster(AgentRegistry.global(), "Main", parentFile).peers[0]).toMatchObject({
			resolvedModelIdentity: identity,
			resolvedThinkingLevel: ThinkingLevel.High,
			fastModeEnabled: child.isFastModeEnabled(),
			fastModeActive: child.isFastModeActive(),
		});
	});

	test("history agent index includes the live model, effort, and fast state", async () => {
		edit();
		const url = { href: "history://", rawHost: "", hostname: "", pathname: "", search: "", hash: "" } as InternalUrl;
		const listing = await new HistoryProtocolHandler().resolve(url);
		expect(listing.content).toContain(identity);
		expect(listing.content).toContain("effort=high");
		expect(listing.content).toContain("fast=on");
	});
});

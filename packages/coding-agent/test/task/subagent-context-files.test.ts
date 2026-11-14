import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { loadProjectContextFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { localSession } from "../helpers/local-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MODEL = getBundledModel("openai", "gpt-5.4");
const MODEL_SELECTOR = `${MODEL.provider}/${MODEL.id}`;
const WORKER: AgentDefinition = {
	name: "task",
	description: "Read the assigned policy context",
	systemPrompt: "Inspect the supplied context and report completion.",
	source: "bundled",
	tools: ["read", "task"],
	spawns: ["task"],
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
		resetCapabilities();
		resetRegisteredArtifactDirsForTests();
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	}
});

/** Real discovery, SDK sessions, task dispatch and park/revive; only model responses are scripted. */
async function fixture() {
	const directory = TempDir.createSync("@omp-child-context-");
	const previousAgentDir = getAgentDir();
	const home = directory.join("home");
	const agentDir = path.join(home, ".omp", "agent");
	const workspace = path.join(home, "ws");
	const repo = path.join(workspace, "repo");
	const copy = path.join(home, ".omp", "wt", "isolated", "m");
	const userFile = path.join(home, ".agents", "AGENTS.md");
	const workspaceFile = path.join(workspace, "CLAUDE.md");
	const sourceFile = path.join(repo, "CLAUDE.md");
	const copyFile = path.join(copy, "CLAUDE.md");
	const markers = {
		user: "User policy: CHILD_CONTEXT_USER_RULE.",
		workspace: "Workspace policy: CHILD_CONTEXT_WORKSPACE_RULE.",
		source: "Source checkout policy: CHILD_CONTEXT_SOURCE_RULE.",
		copy: "Isolation copy policy: CHILD_CONTEXT_COPY_RULE.",
	};
	const sessions: AgentSession[] = [];
	const jobs: AsyncJobManager[] = [];
	const authStorage = createInMemoryAuthStorage();
	cleanups.push(async () => {
		try {
			for (const manager of jobs) await manager.dispose({ timeoutMs: 100 });
			await AgentLifecycleManager.global().dispose();
			for (const session of sessions.toReversed()) await session.dispose();
		} finally {
			authStorage.close();
			AgentStorage.close();
			closeModelCache();
			setAgentDir(previousAgentDir);
			await directory.remove();
		}
	});
	await Promise.all([
		fs.mkdir(path.dirname(userFile), { recursive: true }),
		fs.mkdir(path.join(repo, ".git"), { recursive: true }),
		fs.mkdir(path.join(copy, ".git"), { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
	]);
	await Promise.all([
		Bun.write(userFile, markers.user),
		Bun.write(workspaceFile, markers.workspace),
		Bun.write(sourceFile, markers.source),
		Bun.write(copyFile, markers.copy),
	]);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	AgentStorage.close();
	setAgentDir(agentDir);
	resetCapabilities();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	VibeSessionRegistry.resetGlobalForTests();
	authStorage.keys.setRuntime(MODEL.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, directory.join("models.yml"));
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([MODEL]);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in policy-context tests"));
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [WORKER], projectAgentsDir: null });
	const mock = createMockModel({
		handler: { content: [{ type: "toolCall", name: "yield", arguments: { data: { complete: true } } }] },
	});
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation(() => mock.stream);
	const realCreate = sdk.createAgentSession;
	vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
		const created = await realCreate({
			...options,
			agentDir,
			disableExtensionDiscovery: true,
			skills: options?.skills ?? [],
			promptTemplates: options?.promptTemplates ?? [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(created.session);
		return created;
	});
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.structured": true,
		"task.batch": false,
		"task.maxRecursionDepth": 3,
		"task.agentIdleTtlMs": 0,
		"task.isolation.enabled": false,
		"task.enableLsp": false,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"advisor.enabled": false,
		"memory.backend": "off",
		includeWorkspaceTree: true,
		modelRoles: { default: MODEL_SELECTOR, task: MODEL_SELECTOR, smol: MODEL_SELECTOR, advisor: MODEL_SELECTOR },
	});

	async function create(options: sdk.CreateAgentSessionOptions = {}): Promise<AgentSession> {
		const { session } = await sdk.createAgentSession({
			cwd: repo,
			agentId: `PolicyParent${sessions.length}`,
			sessionManager: SessionManager.create(repo, directory.join(`parent-${sessions.length}`)),
			authStorage,
			modelRegistry,
			model: MODEL,
			settings,
			toolNames: ["task"],
			spawns: "*",
			...options,
		});
		return session;
	}

	function liveChild(id: string): AgentSession {
		const child = AgentRegistry.global().get(id)?.session;
		if (!child) throw new Error(`Expected live child ${id}`);
		return localSession(child);
	}

	async function spawn(parent: AgentSession, id: string): Promise<AgentSession> {
		const tool = parent.getToolByName("task") as TaskTool | undefined;
		if (!tool) throw new Error("Expected the parent's task tool");
		const result = await tool.execute(id, {
			name: id,
			agent: "task",
			task: "Read the policy context.",
			solutionSpace: "Check only the supplied policy context.",
		});
		expect(result.isError, JSON.stringify(result)).not.toBe(true);
		expect(result.details?.results[0]?.exitCode, JSON.stringify(result)).toBe(0);
		const childId = result.details?.results[0]?.id;
		if (!childId) throw new Error("Expected the task result to identify its child");
		return liveChild(childId);
	}

	async function isolated(id: string, overrides: Partial<ExecutorOptions> = {}): Promise<AgentSession> {
		const result = await runSubprocess({
			cwd: repo,
			worktree: copy,
			worktreeRepoRoot: repo,
			agent: WORKER,
			task: "Read the isolation copy's policy context.",
			index: 0,
			id,
			description: "Policy context test",
			artifactsDir: directory.join(`artifacts-${id}`),
			persistArtifacts: true,
			authStorage,
			modelRegistry,
			modelOverride: MODEL_SELECTOR,
			settings,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			...overrides,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		return liveChild(id);
	}

	return {
		directory,
		repo,
		copy,
		userFile,
		workspaceFile,
		sourceFile,
		copyFile,
		markers,
		authStorage,
		modelRegistry,
		settings,
		jobs,
		create,
		spawn,
		isolated,
		liveChild,
	};
}

function systemPrompt(session: AgentSession): string {
	return session.agent.state.systemPrompt.join("\n");
}

describe("subagent policy context", () => {
	it("loads source workspace ancestors beside the isolation copy's own policy, not the source repo policy", async () => {
		const h = await fixture();
		const own = await loadProjectContextFiles({ cwd: h.copy });
		expect(own.map(file => file.content)).toEqual(expect.arrayContaining([h.markers.user, h.markers.copy]));
		expect(own.map(file => file.content)).not.toContain(h.markers.workspace);
		const loaded = await loadProjectContextFiles({ cwd: h.copy, ancestorRoot: h.repo });
		expect(loaded.map(file => file.path)).toEqual(expect.arrayContaining([h.userFile, h.workspaceFile, h.copyFile]));
		expect(loaded.map(file => file.path)).not.toContain(h.sourceFile);
		expect(loaded.findIndex(file => file.path === h.workspaceFile)).toBeLessThan(
			loaded.findIndex(file => file.path === h.copyFile),
		);
	});

	it("discovers workspace and repository policy for a task child without inheriting user AGENTS.md", async () => {
		const h = await fixture();
		const parent = await h.create();
		const child = await h.spawn(parent, "OrdinaryPolicyChild");
		const rendered = systemPrompt(child);
		for (const marker of [h.markers.workspace, h.markers.source]) expect(rendered).toContain(marker);
		expect(rendered).not.toContain(h.markers.user);
		expect(rendered.indexOf(h.markers.workspace)).toBeLessThan(rendered.indexOf(h.markers.source));
	});

	it("keeps isolated descendants and their advisors on the copy's policy and drops the parent's workspace tree", async () => {
		const h = await fixture();
		const parentOnlyFile = path.join(h.repo, "source-only", "AGENTS.md");
		const child = await h.isolated("IsolatedPolicyChild", {
			workspaceTree: {
				rootPath: h.repo,
				rendered: "SOURCE_CHECKOUT_ONLY_TREE",
				truncated: false,
				totalLines: 1,
				agentsMdFiles: [parentOnlyFile],
			},
		});
		const rendered = systemPrompt(child);
		for (const marker of [h.markers.workspace, h.markers.copy]) expect(rendered).toContain(marker);
		expect(rendered).not.toContain(h.markers.user);
		expect(rendered).not.toContain(h.markers.source);
		expect(rendered).not.toContain(h.sourceFile);
		expect(rendered).not.toContain("SOURCE_CHECKOUT_ONLY_TREE");
		expect(rendered).not.toContain(parentOnlyFile);

		const grandchild = await h.spawn(child, "NestedPolicyChild");
		const nested = systemPrompt(grandchild);
		for (const marker of [h.markers.workspace, h.markers.copy]) expect(nested).toContain(marker);
		expect(nested).not.toContain(h.markers.user);
		expect(nested).not.toContain(h.markers.source);

		child.setAdvisorEnabled(true);
		const advisor = child.getAdvisorAgent();
		if (!advisor) throw new Error("Expected the child's read-only advisor");
		const advisorPrompt = advisor.state.systemPrompt.join("\n");
		for (const marker of [h.markers.workspace, h.markers.copy]) expect(advisorPrompt).toContain(marker);
		expect(advisorPrompt).not.toContain(h.markers.user);
		expect(advisorPrompt).not.toContain(h.markers.source);
	});

	it.each([false, true])(
		"filters explicit AGENTS.md while preserving other SDK context verbatim (empty=%s)",
		async empty => {
			const h = await fixture();
			const explicit = empty
				? []
				: [
						{ path: h.directory.join("notes.txt"), content: "EXPLICIT_NON_POLICY_CONTEXT" },
						{ path: h.directory.join("someone", "AGENTS.md"), content: "EXPLICIT_AGENT_POLICY_CONTEXT" },
					];
			const parent = await h.create({ contextFiles: explicit });
			const child = await h.spawn(parent, empty ? "EmptyPolicyChild" : "ExplicitPolicyChild");
			const rendered = systemPrompt(child);
			if (!empty) {
				expect(rendered).toContain("EXPLICIT_NON_POLICY_CONTEXT");
				expect(rendered.split("EXPLICIT_NON_POLICY_CONTEXT")).toHaveLength(2);
				expect(rendered).not.toContain("EXPLICIT_AGENT_POLICY_CONTEXT");
			}
			for (const marker of Object.values(h.markers)) expect(rendered).not.toContain(marker);
			if (empty) expect(rendered).not.toContain("<repo-rules>");
		},
	);

	it("rediscovers policy on warm revival after the normal capability-cache boundary", async () => {
		const h = await fixture();
		const parent = await h.create();
		const child = await h.spawn(parent, "RevivablePolicyChild");
		const childId = child.getAgentId();
		if (!childId) throw new Error("Expected the spawned child to carry its registry id");
		const lifecycle = AgentLifecycleManager.global();
		await lifecycle.park(childId);
		expect(AgentRegistry.global().get(childId)?.session).toBeNull();
		const updated = "Updated repository policy: CHILD_CONTEXT_REVISED_RULE.";
		await Bun.write(h.sourceFile, updated);
		// /clear and /new use this public cache boundary; revival must not freeze the parent's old array.
		resetCapabilities();
		const revived = await lifecycle.ensureLive(childId);
		const rendered = systemPrompt(localSession(revived));
		expect(rendered).toContain(updated);
		expect(rendered).not.toContain(h.markers.source);
		expect(rendered).toContain(h.markers.workspace);
		expect(rendered).not.toContain(h.markers.user);
	});

	it("uses the same discovered policies for Vibe's public spawn path", async () => {
		const h = await fixture();
		const parentSession = await h.create();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		h.jobs.push(manager);
		const parent = {
			cwd: h.repo,
			settings: h.settings,
			authStorage: h.authStorage,
			modelRegistry: h.modelRegistry,
			asyncJobManager: manager,
			sessionManager: parentSession.sessionManager,
			getAgentId: () => parentSession.getAgentId(),
			getSessionId: () => parentSession.sessionId,
			getSessionFile: () => parentSession.sessionManager.getSessionFile() ?? null,
			getActiveModelString: () => MODEL_SELECTOR,
			getArtifactsDir: () => null,
			taskDepth: 0,
			enableLsp: false,
			// This models an SDK-discovered parent, not an explicit contextFiles override.
			contextFiles: await loadProjectContextFiles({ cwd: h.repo }),
			childContextFiles: undefined,
			skills: [],
			promptTemplates: [],
			rules: [],
			extensionPaths: [],
			customToolPaths: [],
		} as unknown as ToolSession;
		const spawned = await VibeSessionRegistry.global().spawn(parent, {
			name: "VibePolicyChild",
			cli: "good",
			prompt: "Read the policy context.",
		});
		const job = manager.getJob(spawned.jobId);
		if (!job) throw new Error("Expected Vibe's spawn job");
		await job.promise;
		expect(job.status, job.errorText ?? job.resultText).toBe("completed");
		const rendered = systemPrompt(h.liveChild(spawned.id));
		for (const marker of [h.markers.workspace, h.markers.source]) expect(rendered).toContain(marker);
		expect(rendered).not.toContain(h.markers.user);
	});
});

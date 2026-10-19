import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import {
	cfgRoutingPolicies,
	fillRoutingPolicy,
	parseRoutingPolicySelector,
	validateRoutingPolicies,
} from "@oh-my-pi/pi-coding-agent/config/routing-policies";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { resolveEffectiveSubagentPolicy, runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { StructuredSubagentRequest } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";

const policies = {
	funnel: { slots: {
		scout: { model: "@smol:medium", boundary: "Investigate only; never publish.", agent: "scout" },
		authority: { model: "example/authority", effort: "high" as const, boundary: "Publish issues only." },
	} },
};
function settings(): Settings {
	return Settings.isolated({ routingPolicies: policies, modelRoles: { smol: "example/investigator" } });
}
function request(config = settings(), agent = "policy:funnel/scout"): StructuredSubagentRequest {
	return {
		session: {
			cwd: "/tmp", settings: config, getSessionSpawns: () => "*", getSessionFile: () => null,
		} as unknown as ToolSession,
		invocationKind: "task", assignment: "Find the evidence.", agent,
	};
}
function mockAgents(): void {
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [
		{ name: "task", description: "Worker", systemPrompt: "Implement work.", source: "bundled" },
		{ name: "scout", description: "Scout", systemPrompt: "Investigate.", tools: ["read"], source: "bundled" },
	], projectAgentsDir: null });
}
afterEach(() => vi.restoreAllMocks());

describe("named routing policies", () => {
	it("loads declared user and project policies across fresh settings instances", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "npi-routing-"));
		try {
			const agentDir = path.join(dir, "agent");
			const cwd = path.join(dir, "project");
			await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ routingPolicies: policies }));
			await Bun.write(path.join(cwd, ".omp", "config.yml"), YAML.stringify({
				routingPolicies: { local: { slots: { implementer: {
					model: "example/implementer", effort: "low", boundary: "Implement only in src/.",
				} } } },
			}));
			for (let n = 0; n < 2; n++) {
				const loaded = await Settings.loadReadOnly({ agentDir, cwd });
				expect(fillRoutingPolicy(loaded, { policy: "funnel", slot: "scout" }).effort).toBe("medium");
				expect(fillRoutingPolicy(loaded, { policy: "local" }).slot).toBe("implementer");
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("does not invent a policy in empty settings", () => {
		const empty = Settings.isolated({});
		expect(cfgRoutingPolicies.get(empty)).toEqual({});
		expect(() => fillRoutingPolicy(empty, { policy: "funnel" })).toThrow('Unknown routing policy "funnel"');
	});
	it("fills missing fields and normalizes suffix effort separately", () => {
		expect(fillRoutingPolicy(settings(), { policy: "funnel", slot: "scout" })).toEqual({
			policy: "funnel", slot: "scout", model: "@smol", effort: "medium",
			boundary: "Investigate only; never publish.", agent: "scout",
		});
	});
	it("preserves every explicit assignment field", () => {
		const fields = { policy: "funnel", slot: "scout", model: ["custom/model"], effort: "low", boundary: "Inspect one path.", agent: "reviewer" };
		const resolved = fillRoutingPolicy(settings(), fields);
		expect(resolved).toEqual(fields);
		expect(resolved.model).not.toBe(fields.model);
	});
	it("keeps delivered snapshots unchanged when the policy is edited", () => {
		const config = settings();
		const delivered = fillRoutingPolicy(config, { policy: "funnel", slot: "authority" });
		cfgRoutingPolicies.override(config, { funnel: { slots: { authority: { model: "example/authority", effort: "low", boundary: "Publish issues only." } } } });
		expect(delivered.effort).toBe("high");
		expect(fillRoutingPolicy(config, { policy: "funnel", slot: "authority" }).effort).toBe("low");
	});
	it("requires a slot when multiple slots are declared and rejects missing slots", () => {
		expect(() => fillRoutingPolicy(settings(), { policy: "funnel" })).toThrow("requires a slot");
		expect(() => fillRoutingPolicy(settings(), { policy: "funnel", slot: "missing" })).toThrow('Unknown slot "missing"');
	});
	it("rejects missing model, effort, boundary, and conflicting effort declarations", () => {
		for (const slot of [
			{ effort: "medium", boundary: "Investigate." },
			{ model: "@smol", boundary: "Investigate." },
			{ model: "@smol", effort: "medium" },
			{ model: "@smol:high", effort: "medium", boundary: "Investigate." },
		]) expect(() => validateRoutingPolicies({ funnel: { slots: { scout: slot } } })).toThrow();
	});
	it("only parses explicit namespaced references", () => {
		expect(parseRoutingPolicySelector("@smol")).toBeUndefined();
		expect(parseRoutingPolicySelector("policy:funnel/scout")).toEqual({ policy: "funnel", slot: "scout" });
		expect(() => parseRoutingPolicySelector("policy:funnel/scout/extra")).toThrow("Invalid routing selector");
	});
	it("resolves the specialist, role alias and exact effort through task and eval preflight", async () => {
		mockAgents();
		for (const invocationKind of ["task", "eval"] as const) {
			const resolved = await resolveEffectiveSubagentPolicy({ ...request(), invocationKind });
			expect(resolved.agentName).toBe("scout");
			expect(resolved.effectiveAgent.tools).toEqual(["read"]);
			expect(resolved.modelOverride).toEqual(["example/investigator"]);
			expect(resolved.modelRole).toBe("smol");
			expect(resolved.callerThinkingLevel).toBe(ThinkingLevel.Medium);
		}
	});
	it("keeps explicit model and effort ahead of policy defaults", async () => {
		mockAgents();
		const resolved = await resolveEffectiveSubagentPolicy({ ...request(), model: "custom/model", effort: Effort.Low });
		expect(resolved.modelOverride).toEqual(["custom/model"]);
		expect(resolved.callerThinkingLevel).toBeUndefined();
	});
	it("does not bypass specialist spawn restrictions", async () => {
		mockAgents();
		const input = request();
		input.session.getSessionSpawns = () => "task";
		await expect(resolveEffectiveSubagentPolicy(input)).rejects.toThrow("Cannot spawn 'scout'");
	});
	it("surfaces undeclared policy errors before discovery or dispatch", async () => {
		const spy = vi.spyOn(discovery, "discoverAgents");
		await expect(resolveEffectiveSubagentPolicy(request(Settings.isolated({})))).rejects.toThrow("Unknown routing policy");
		expect(spy).not.toHaveBeenCalled();
	});
	it("copies the boundary into the actual child assignment", async () => {
		mockAgents();
		const calls: executor.ExecutorOptions[] = [];
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			calls.push(options);
			return { index: 0, id: "Scout", agent: "scout", agentSource: "bundled", task: options.task, exitCode: 0, output: "Evidence", stderr: "", truncated: false, durationMs: 1, tokens: 0, requests: 1 };
		});
		await runStructuredSubagent(request());
		expect(calls[0]?.task).toContain("Investigate only; never publish.");
		expect(calls[0]?.task).toContain("Effort: medium");
		expect(calls[0]?.callerThinkingLevel).toBe(ThinkingLevel.Medium);
	});
	it("shows the expanded model and effort before dispatch without changing role settings", async () => {
		mockAgents();
		const input = request();
		const originalRoles = input.session.settings.getModelRoles();
		const tool = await TaskTool.create(input.session);
		const originalFallbacks = cfgRetryFallbackChains.get(input.session.settings);
		const theme = (await getThemeByName("dark"))!;
		const preview = Bun.stripANSI(tool.renderCall({ agent: "policy:funnel/scout", task: "Investigate." }, {}, theme).render(160).join("\n"));
		expect(preview).toContain("example/investigator");
		expect(preview).toContain("effort: medium");
		expect(tool.description).toContain("policy:funnel/scout");
		expect(input.session.settings.getModelRoles()).toEqual(originalRoles);
		expect(cfgRetryFallbackChains.get(input.session.settings)).toEqual(originalFallbacks);
	});
});

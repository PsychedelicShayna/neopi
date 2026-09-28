import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseMixturesDoc } from "@oh-my-pi/pi-coding-agent/moa/config";
import { MIXTURE_API, MIXTURE_PROVIDER } from "@oh-my-pi/pi-coding-agent/moa/provider";
import { resolveMixture } from "@oh-my-pi/pi-coding-agent/moa/resolve";
import type { MixtureIssue } from "@oh-my-pi/pi-coding-agent/moa/types";
import {
	hasCycle,
	MAX_EDGE_TARGETS,
	MAX_EDGES,
	MAX_MEMBERS,
	MAX_TEXT_CHARS,
	validateMixture,
} from "@oh-my-pi/pi-coding-agent/moa/validate";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { MixtureDefinition, MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { TempDir } from "@oh-my-pi/pi-utils";

const ENV_KEYS = ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"];
const savedEnv = new Map<string, string | undefined>();
let tempDir: TempDir;
let authStorage: AuthStorage;
let registry: ModelRegistry;

function fakeModel(id: string, extra: Partial<{ reasoning: boolean; supportsTools: boolean }> = {}) {
	return {
		id,
		name: id,
		reasoning: extra.reasoning ?? true,
		supportsTools: extra.supportsTools,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_000,
	};
}

beforeEach(async () => {
	for (const key of ENV_KEYS) {
		savedEnv.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
	tempDir = TempDir.createSync("@moa-validate-");
	authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	registry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	registry.registerProvider("fake", {
		baseUrl: "http://127.0.0.1:1/v1",
		apiKey: "test-key",
		api: "fake-api",
		models: [
			fakeModel("writer"),
			fakeModel("editor"),
			fakeModel("plain", { reasoning: false, supportsTools: false }),
		],
	});
});

afterEach(() => {
	authStorage.close();
	tempDir.removeSync();
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

/** Registers `mixture/loop` so selectors can land on a mixture model. */
function registerMixtureModel(): void {
	registry.registerProvider(MIXTURE_PROVIDER, {
		baseUrl: "mixture://catalog/test",
		api: MIXTURE_API,
		auth: "none",
		models: [{ ...fakeModel("loop"), api: MIXTURE_API }],
	});
}

function parseDoc(text: string): MixturesConfigDoc {
	const doc = parseMixturesDoc(Bun.TOML.parse(text), "MIXTURES.toml");
	expect(doc.warnings).toBeUndefined();
	return doc;
}

function check(
	definition: MixtureDefinition,
	settings = Settings.isolated(),
	doc: MixturesConfigDoc = { mixtures: [] },
) {
	const resolved = resolveMixture(definition, {
		registry,
		settings,
		documentEnvelopes: doc.envelopes,
		documentRoles: doc.roles,
	});
	return { resolved, ...validateMixture(resolved, { settings, names: doc.mixtures.map(mixture => mixture.name) }) };
}

function codes(issues: MixtureIssue[]): string[] {
	return issues.map(issue => issue.code);
}

const LINEAR = `
[[mixtures]]
name = "draft-then-edit"
entry = "writer"

[[mixtures.members]]
id = "writer"
model = "fake/writer:medium"
system_prompt = "Draft a complete answer."
tools = false

[[mixtures.members]]
id = "editor"
model = "fake/editor:low"
system_prompt = "Tighten the draft. Return only the final text."
tools = false

[[mixtures.edges]]
from = "writer"
to = "editor"
x = { output = true }
`;

function linear(): MixtureDefinition {
	return parseDoc(LINEAR).mixtures[0]!;
}

/** The linear fixture with a route on the writer: a routed graph, gated at M1 but resolved with a judge plan. */
function routed(): MixtureDefinition {
	const definition = linear();
	const writer = definition.members[0]!;
	if (writer.kind !== "verdict") writer.route = { instructions: "Is the draft ready?" };
	return definition;
}

describe("validateMixture on the M1 fixture", () => {
	it("accepts draft-then-edit with no errors or warnings and resolves no helpers", () => {
		const result = check(linear());
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.resolved.uses).toEqual({ judge: false, summary: false, slicer: false });
		expect(result.resolved.judgePlan).toBeUndefined();
		const writer = result.resolved.members.writer;
		expect(writer?.kind === "model" && `${writer.model.provider}/${writer.model.id}:${writer.effort}`).toBe(
			"fake/writer:medium",
		);
	});

	it("gives a changed preset or member model a new revision", () => {
		const base = check(linear()).resolved.revision;
		const edited = linear();
		edited.members[1] = { ...edited.members[1]!, model: "fake/writer" } as MixtureDefinition["members"][number];
		expect(check(edited).resolved.revision).not.toBe(base);
		expect(check(linear()).resolved.revision).toBe(base);
	});
});

describe("validateMixture error codes", () => {
	const cases: [string, string, string, (definition: MixtureDefinition) => void][] = [
		["name.invalid", "name", "E1", definition => (definition.name = "Bad Name")],
		["members.empty", "members", "E3", definition => ((definition.members = []), (definition.edges = []))],
		["member.id", "members[1].id", "E3", definition => (definition.members[1]!.id = "writer")],
		[
			"member.model.unresolved",
			"members[0].model",
			"E2",
			definition => Object.assign(definition.members[0]!, { model: "nowhere/nothing" }),
		],
		[
			"member.prompt.missing",
			"members[0]",
			"E4",
			definition => Object.assign(definition.members[0]!, { systemPrompt: undefined }),
		],
		[
			"member.role.unresolved",
			"members[0].role",
			"E4",
			definition => Object.assign(definition.members[0]!, { systemPrompt: undefined, role: "ghost" }),
		],
		["entry.unresolved", "entry", "E5", definition => (definition.entry = "ghost")],
		[
			"entry.verdict",
			"entry",
			"E5",
			definition =>
				(definition.members[0] = {
					kind: "verdict",
					id: "writer",
					question: { type: "noul", instructions: "Done?" },
				}),
		],
		["edge.endpoint", "edges[0]", "E6", definition => (definition.edges[0]!.to = "ghost")],
		[
			"edge.from_verdict",
			"edges[0].from",
			"E6",
			definition =>
				(definition.members[0] = {
					kind: "verdict",
					id: "writer",
					question: { type: "noul", instructions: "Done?" },
				}),
		],
		["edge.x.empty", "edges[0].x", "E7", definition => (definition.edges[0]!.x = {})],
		[
			"edge.x.unknown_part",
			"edges[0].x.vibes",
			"E7",
			definition => Object.assign(definition.edges[0]!.x, { vibes: true }),
		],
		["edge.envelope.unresolved", "edges[0].envelope", "E8", definition => (definition.edges[0]!.envelope = "ghost")],
		[
			"edge.envelope.compile",
			"edges[0].envelope",
			"E8",
			definition => (definition.edges[0]!.envelope = "Broken {{#if x.output}} never closed"),
		],
		[
			"edge.envelope.undeclared_part",
			"edges[0].envelope",
			"E8",
			definition => (definition.edges[0]!.envelope = "Think about {{x.reasoning}}\n"),
		],
		[
			"edge.id.duplicate",
			"edges[1].id",
			"E9",
			definition => definition.edges.push({ ...definition.edges[0]!, x: { output: true } }),
		],
	];

	it.each(cases)("reports %s at %s (%s)", (code, path, _rule, mutate) => {
		const definition = linear();
		mutate(definition);
		const result = check(definition);
		expect(result.errors.find(issue => issue.code === code)?.path).toBe(path);
	});

	it("reports a duplicate name in the roster", () => {
		const doc = parseDoc(`${LINEAR}\n${LINEAR}`);
		expect(check(doc.mixtures[0]!, Settings.isolated(), doc).errors.map(issue => [issue.code, issue.path])).toEqual([
			["name.duplicate", "name"],
		]);
	});

	it("refuses x = {} with edge.x.empty and nothing else", () => {
		const definition = linear();
		definition.edges[0]!.x = {};
		expect(codes(check(definition).errors)).toEqual(["edge.x.empty"]);
	});

	it("refuses limits.max_hops above moa.hard_max_hops with limits.exceeds, and accepts it at the cap", () => {
		const definition = linear();
		const settings = Settings.isolated({ "moa.hard_max_hops": 10 });
		definition.limits = { maxHops: 11 };
		expect(check(definition, settings).errors.map(issue => [issue.code, issue.path])).toEqual([
			["limits.exceeds", "limits.max_hops"],
		]);
		definition.limits = { maxHops: 10 };
		expect(check(definition, settings).errors).toEqual([]);
	});
});

describe("validateMixture warnings", () => {
	it("warns on show = never for the terminal member", () => {
		const definition = linear();
		definition.members[1]!.show = "never";
		expect(check(definition).warnings.map(issue => [issue.code, issue.path])).toEqual([
			["member.show.final", "members[1].show"],
		]);
	});

	it("warns on a member with no path from the entry", () => {
		const definition = linear();
		definition.members.push({ id: "orphan", model: "fake/writer", systemPrompt: "x", tools: false });
		expect(check(definition).warnings.map(issue => [issue.code, issue.path])).toEqual([
			["unreachable", "members[2]"],
		]);
	});

	it("warns on reasoning handed on from a model that exposes none", () => {
		const definition = linear();
		Object.assign(definition.members[0]!, { model: "fake/plain" });
		definition.edges[0]!.x = { output: true, reasoning: true };
		expect(check(definition).warnings.map(issue => issue.code)).toEqual(["edge.x.reasoning.empty"]);
	});

	it("warns on tools for a model without tool support and on terminate at a terminal member", () => {
		const definition = linear();
		Object.assign(definition.members[1]!, {
			model: "fake/plain",
			tools: ["read"],
			terminate: { instructions: "Done?" },
		});
		expect(codes(check(definition).warnings).sort()).toEqual(["member.tools.unsupported", "terminate.terminal"]);
	});

	it("warns on controls of a fan-out branch", () => {
		const definition = linear();
		definition.members.push({ id: "judge", model: "fake/editor", systemPrompt: "j", tools: false });
		definition.edges = [{ from: "writer", to: ["editor", "judge"], join: "writer", x: { output: true } }];
		definition.edges.push({ from: "editor", to: "judge", x: { output: true } });
		expect(codes(check(definition).warnings)).toContain("fanout.branch.controls");
	});
});

describe("capability gate", () => {
	it("refuses route with unsupported.feature naming M2", () => {
		const result = check(routed());
		const gated = result.errors.filter(issue => issue.code === "unsupported.feature");
		expect(gated.map(issue => issue.path)).toEqual(["members[0].route"]);
		expect(gated[0]!.message).toContain("M2");
	});

	it.each([
		[
			"tools on the terminal member",
			(definition: MixtureDefinition) => Object.assign(definition.members[1]!, { tools: undefined }),
		],
		[
			"a back-edge",
			(definition: MixtureDefinition) =>
				definition.edges.push({ from: "editor", to: "writer", x: { output: true } }),
		],
		["x.transcript", (definition: MixtureDefinition) => (definition.edges[0]!.x = { transcript: true })],
		["serve", (definition: MixtureDefinition) => (definition.serve = true)],
		["a budget limit", (definition: MixtureDefinition) => (definition.limits = { budgetUsd: 1 })],
		["steering", (definition: MixtureDefinition) => (definition.steering = { target: "entry" })],
	])("refuses %s", (_label, mutate) => {
		const definition = linear();
		mutate(definition);
		expect(codes(check(definition).errors)).toContain("unsupported.feature");
	});

	it("keeps limits.max_hops runnable", () => {
		const definition = linear();
		definition.limits = { maxHops: 5 };
		expect(check(definition).errors).toEqual([]);
	});

	it("marks the M2 courtroom fixture unsupported", () => {
		const doc = parseDoc(`
[[mixtures]]
name = "courtroom"
entry = "prosecution"
[[mixtures.members]]
id = "prosecution"
model = "fake/writer"
system_prompt = "prosecute"
tools = false
[[mixtures.members]]
id = "defense"
model = "fake/editor"
system_prompt = "defend"
tools = false
[mixtures.members.terminate]
instructions = "Conceded?"
[[mixtures.edges]]
id = "open"
from = "prosecution"
to = "defense"
x = { output = true }
[[mixtures.edges]]
id = "rebut"
from = "defense"
to = "prosecution"
x = { output = true }
max_traversals = 3
`);
		expect(codes(check(doc.mixtures[0]!).errors)).toContain("unsupported.feature");
	});
});

describe("recursion", () => {
	it("rejects a member whose selector resolves to a mixture through @default", () => {
		registerMixtureModel();
		const definition = linear();
		Object.assign(definition.members[0]!, { model: "@default" });
		const result = check(definition, Settings.isolated({ modelRoles: { default: "mixture/loop" } }));
		expect(result.errors.map(issue => [issue.code, issue.path])).toEqual([
			["member.model.recursive", "members[0].model"],
		]);
	});

	it("rejects an explicitly configured judge role bound to a mixture on a routed graph", () => {
		registerMixtureModel();
		const result = check(routed(), Settings.isolated({ modelRoles: { judge: "mixture/loop" } }));
		expect(result.errors.find(issue => issue.code === "helper.unresolved")?.path).toBe("judge");
		expect(result.resolved.judgePlan).toBeUndefined();
	});

	it("resolves a linear graph with a mixture @default and no native judge, without a judge plan", () => {
		registerMixtureModel();
		const result = check(linear(), Settings.isolated({ modelRoles: { default: "mixture/loop" } }));
		expect(result.errors).toEqual([]);
		expect(result.resolved.judgePlan).toBeUndefined();
	});

	it("filters the mixture out of a routed graph's implicit judge fallback", () => {
		registerMixtureModel();
		const result = check(
			routed(),
			Settings.isolated({ modelRoles: { default: "mixture/loop", smol: "fake/editor" } }),
		);
		expect(codes(result.errors)).toEqual(["unsupported.feature"]);
		const plan = result.resolved.judgePlan?.map(candidate => `${candidate.model.provider}/${candidate.model.id}`);
		expect(plan).toContain("fake/editor");
		expect(plan).not.toContain("mixture/loop");
	});
});

describe("model allow-list", () => {
	const ALLOWED = ["fake/writer", "fake/editor"];

	it("filters a model enabledModels excludes out of a routed graph's implicit judge fallback", () => {
		const result = check(
			routed(),
			Settings.isolated({ enabledModels: ALLOWED, modelRoles: { default: "fake/plain", smol: "fake/editor" } }),
		);
		expect(codes(result.errors)).toEqual(["unsupported.feature"]);
		const plan = result.resolved.judgePlan?.map(candidate => `${candidate.model.provider}/${candidate.model.id}`);
		expect(plan).toContain("fake/editor");
		expect(plan).not.toContain("fake/plain");
	});

	it("rejects an explicitly configured judge role that enabledModels excludes", () => {
		const result = check(
			routed(),
			Settings.isolated({ enabledModels: ALLOWED, modelRoles: { judge: "fake/plain" } }),
		);
		const issue = result.errors.find(candidate => candidate.code === "helper.unresolved");
		expect([issue?.path, issue?.message]).toEqual(["judge", expect.stringContaining("excluded by enabledModels")]);
		expect(result.resolved.judgePlan).toBeUndefined();
	});
});

describe("definition size bounds", () => {
	/** A linear chain m0 -> m1 -> … of `count` members. */
	function chain(count: number): MixtureDefinition {
		const definition = linear();
		definition.members = Array.from({ length: count }, (_, index) => ({
			id: `m${index}`,
			model: "fake/writer",
			systemPrompt: "Answer.",
			tools: false,
		}));
		definition.entry = "m0";
		definition.edges = Array.from({ length: count - 1 }, (_, index) => ({
			from: `m${index}`,
			to: `m${index + 1}`,
			x: { output: true },
		}));
		return definition;
	}

	function sizeCodes(issues: MixtureIssue[]): string[] {
		return codes(issues).filter(code => code.startsWith("limits.") && code.endsWith("_size"));
	}

	it("refuses a chain one member over the cap with exactly one limits.graph_size error", () => {
		const result = check(chain(MAX_MEMBERS + 1));
		expect(result.errors.map(issue => [issue.code, issue.path])).toEqual([["limits.graph_size", "members"]]);
		expect(result.warnings).toEqual([]);
		expect(result.resolved.members).toEqual({});
	});

	it("validates a definition exactly at the member and edge caps with no size error", () => {
		const definition = chain(MAX_MEMBERS);
		for (let index = definition.edges.length; index < MAX_EDGES; index++) {
			definition.edges.push({ id: `extra-${index}`, from: "m0", to: "m1", x: { output: true } });
		}
		expect(definition.edges).toHaveLength(MAX_EDGES);
		expect(sizeCodes(check(definition).errors)).toEqual([]);
	});

	it("refuses a fan-out edge whose targets push the sum over the cap, at that edge", () => {
		const definition = linear();
		const to = Array.from({ length: MAX_EDGE_TARGETS }, (_, index) => `b${index}`);
		definition.edges.push({ from: "writer", to, join: "editor", x: { output: true } });
		expect(check(definition).errors.map(issue => [issue.code, issue.path])).toEqual([
			["limits.graph_size", "edges[1]"],
		]);
	});

	it("refuses a system prompt over the text cap at that member", () => {
		const definition = linear();
		Object.assign(definition.members[0]!, { systemPrompt: "x".repeat(MAX_TEXT_CHARS + 1) });
		expect(check(definition).errors.map(issue => [issue.code, issue.path])).toEqual([
			["limits.text_size", "members[0].system_prompt"],
		]);
	});

	const LONG = "x".repeat(MAX_TEXT_CHARS + 1);

	it.each<[string, string, (definition: MixtureDefinition) => void]>([
		["a model selector", "members[0].model", definition => Object.assign(definition.members[0]!, { model: LONG })],
		[
			"a role selector",
			"members[0].role",
			definition => Object.assign(definition.members[0]!, { systemPrompt: undefined, role: LONG }),
		],
		["a tool name", "members[0].tools[0]", definition => Object.assign(definition.members[0]!, { tools: [LONG] })],
		[
			"a choice-criteria label",
			"members[2].question.criteria (key)",
			definition =>
				definition.members.push({
					kind: "verdict",
					id: "judge",
					question: { type: "choice", instructions: "Which?", criteria: { [LONG]: "the long one" } },
				}),
		],
		["an edge endpoint", "edges[0].to", definition => Object.assign(definition.edges[0]!, { to: LONG })],
	])("refuses %s over the text cap at %s, before anything resolves it", (_label, path, mutate) => {
		const definition = linear();
		mutate(definition);
		const result = check(definition);
		expect(result.errors.map(issue => [issue.code, issue.path])).toEqual([["limits.text_size", path]]);
		expect(result.resolved.members).toEqual({});
	});

	it("walks a 100 000-node chain for cycles without recursion, and still finds a back-edge", () => {
		const successors = new Map<string, string[]>();
		const count = 100_000;
		for (let index = 0; index < count; index++) {
			successors.set(`n${index}`, index + 1 < count ? [`n${index + 1}`] : []);
		}
		expect(hasCycle(successors)).toBe(false);
		successors.set(`n${count - 1}`, ["n0"]);
		expect(hasCycle(successors)).toBe(true);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MixtureCatalog, registerMixtureApi } from "@oh-my-pi/pi-coding-agent/moa/provider";
import { discoverRegistrableMixtures } from "@oh-my-pi/pi-coding-agent/moa/registration";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import {
	createMoaFixture,
	createMoaSession,
	DRAFT_THEN_EDIT_TOML,
	FakeMembers,
	type MoaFixture,
} from "./helpers/moa-setup";

let tempDir: TempDir;
let fixture: MoaFixture;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	tempDir = TempDir.createSync("@moa-provider-");
	new FakeMembers();
	registerMixtureApi();
	fixture = await createMoaFixture(tempDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	fixture.authStorage.close();
	clearCustomApis();
	tempDir.removeSync();
});

async function session(): Promise<AgentSession> {
	const created = await createMoaSession(fixture);
	sessions.push(created);
	return created;
}

function mixtureModel() {
	return fixture.registry.find("mixture", "draft-then-edit");
}

async function resolvedRoster() {
	return discoverRegistrableMixtures({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		registry: fixture.registry,
		settings: Settings.isolated(),
	});
}

describe("keyless mixture registration", () => {
	it("is available and selectable immediately after setRoster, with no mixture credential and no refresh", async () => {
		const catalog = MixtureCatalog.for(fixture.registry);
		catalog.retain("test");
		catalog.setRoster(await resolvedRoster());

		expect(fixture.authStorage.keys.source("mixture")).toBeUndefined();
		const available = fixture.registry.getAvailable().map(model => `${model.provider}/${model.id}`);
		expect(available).toContain("mixture/draft-then-edit");
		const model = mixtureModel()!;
		expect(fixture.registry.hasConfiguredAuth(model)).toBe(true);

		const live = await session();
		await live.setModel(model);
		expect(live.model?.id).toBe("draft-then-edit");
		expect(live.model?.api).toBe("mixture");
		catalog.release("test");
	});

	it("survives extension source sync and a forced refresh", async () => {
		const live = await session();
		fixture.registry.syncExtensionSources([]);
		await fixture.registry.refresh("offline");
		const model = mixtureModel();
		expect(model).toBeDefined();
		expect(fixture.registry.getAvailable().some(candidate => candidate.provider === "mixture")).toBe(true);
		await live.setModel(model!);
	});

	it("describes the mixture model from its members", async () => {
		await session();
		const model = mixtureModel()!;
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(64_000);
		expect(model.supportsTools).toBe(false);
		expect(model.reasoning).toBe(true);
	});

	it("never registers a definition with errors, and logs why", async () => {
		const warn = vi.spyOn(logger, "warn");
		await Bun.write(
			`${fixture.agentDir}/MIXTURES.toml`,
			`${DRAFT_THEN_EDIT_TOML}
[[mixtures]]
name = "broken"
entry = "a"
[[mixtures.members]]
id = "a"
model = "fake/writer"
system_prompt = "a"
tools = false
[[mixtures.members]]
id = "b"
model = "fake/editor"
system_prompt = "b"
tools = false
[[mixtures.edges]]
from = "a"
to = "b"
x = {}

[[mixtures]]
name = "routed"
entry = "a"
[[mixtures.members]]
id = "a"
model = "fake/writer"
system_prompt = "a"
tools = false
[mixtures.members.route]
instructions = "which?"
`,
		);
		await session();
		expect(mixtureModel()).toBeDefined();
		expect(fixture.registry.find("mixture", "broken")).toBeUndefined();
		expect(fixture.registry.find("mixture", "routed")).toBeUndefined();
		const refusals = warn.mock.calls.flatMap(([message, context]) =>
			message === "Mixture refused at registration" ? [`${context?.mixture}:${context?.code}`] : [],
		);
		expect(refusals).toContain("broken:edge.x.empty");
		expect(refusals).toContain("routed:unsupported.feature");
	});

	it("removes and restores the model across a one → zero → one roster", async () => {
		const catalog = MixtureCatalog.for(fixture.registry);
		catalog.retain("test");
		const roster = await resolvedRoster();
		catalog.setRoster(roster);
		expect(mixtureModel()).toBeDefined();
		catalog.setRoster([]);
		expect(mixtureModel()).toBeUndefined();
		expect(fixture.registry.getAvailable().some(model => model.provider === "mixture")).toBe(false);
		catalog.setRoster(roster);
		expect(mixtureModel()).toBeDefined();
		catalog.release("test");
	});

	it("keeps the mixture for a session sharing the registry after another releases, until the last release", async () => {
		const parent = await session();
		const child = await createMoaSession(fixture);
		await child.setModel(mixtureModel()!);
		await child.dispose();
		const model = mixtureModel();
		expect(model).toBeDefined();
		await parent.setModel(model!);
		expect(parent.model?.id).toBe("draft-then-edit");

		sessions.splice(0);
		await parent.dispose();
		expect(mixtureModel()).toBeUndefined();
	});

	it("fails a provider-level stream loudly: only a session or a gateway can run a mixture", async () => {
		await session();
		const result = await streamSimple(mixtureModel()!, { messages: [] }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("mixture/draft-then-edit can only run inside a session or a gateway");
	});
});

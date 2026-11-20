import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getProjectAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ModelRegistry } from "../../src/config/model-registry";
import { cfgAuthBrokerToken, cfgModelRoles } from "../../src/config/model-settings";
import { Settings } from "../../src/config/settings";
import { ControlClient } from "../../src/control/client";
import { ControlHost } from "../../src/control/host";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { cfgProvidersMaxInFlightRequests } from "../../src/session/settings";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

let root: string;
const disposers: (() => Promise<void>)[] = [];
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ctl-settings-"));
});
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
	await fs.rm(root, { recursive: true, force: true });
});

async function start(name: string, persisted = true) {
	const agentDir = path.join(root, name, "profile");
	const cwd = path.join(root, name, "cwd");
	const globalFile = path.join(agentDir, "config.yml");
	const projectFile = path.join(getProjectAgentDir(cwd), "config.yml");
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(
		globalFile,
		YAML.stringify({
			theme: { dark: "dark" },
			providers: { maxInFlightRequests: { a: 2 } },
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			auth: { broker: { token: "fixture-inherited" } },
		}),
	);
	const settings = await Settings.loadIsolated({ cwd, agentDir });
	const auth = createInMemoryAuthStorage();
	const model = createMockModel({ provider: "anthropic", responses: [] });
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: [], tools: [] }, streamFn: model.stream }),
		sessionManager: persisted
			? SessionManager.create(cwd, path.join(agentDir, "sessions"))
			: SessionManager.inMemory(cwd),
		settings,
		modelRegistry: new ModelRegistry(auth, path.join(agentDir, "models.yml")),
	});
	await settings.attachSessionFile(session.sessionFile);
	const sessionFile = session.sessionFile ? path.join(session.sessionFile.slice(0, -6), "settings.yml") : undefined;
	const host = new ControlHost({ session, role: "rpc", dir: path.join(root, "ctl") });
	disposers.push(async () => {
		await host.close();
		await session.dispose();
		settings.cancelPendingSaves();
		auth.close();
	});
	await host.start();
	const publication = host.publication;
	if (!publication) throw new Error("control host did not publish");
	const client = new ControlClient({ metadata: publication.metadata(), label: "test" });
	disposers.push(async () => client.close());
	await client.connect();
	return { client, globalFile, projectFile, sessionFile, settings };
}

test("socket writes persist to the addressed scope and leave a peer's files and settings alone", async () => {
	const { client, settings, globalFile, projectFile, sessionFile } = await start("target");
	const peer = await start("peer");
	if (!sessionFile || !peer.sessionFile) throw new Error("expected persisted test sessions");
	const globalBefore = await Bun.file(globalFile).text();
	const peerGlobalBefore = await Bun.file(peer.globalFile).text();
	const roles = { path: "modelRoles", member: "default" };
	const sessionRole = "openai/gpt-5.2";
	expect(await client.request({ type: "settings_set", scope: "session", ...roles, value: sessionRole })).toMatchObject(
		{
			success: true,
			data: { ...roles, value: sessionRole },
		},
	);
	expect(YAML.parse(await Bun.file(sessionFile).text())).toEqual({ modelRoles: { default: sessionRole } });
	expect(await Bun.file(globalFile).text()).toBe(globalBefore);
	expect(await Bun.file(projectFile).exists()).toBe(false);

	const limits = { path: "providers.maxInFlightRequests", scope: "project" };
	expect(await client.request({ type: "settings_set", ...limits, member: "b", value: 3 })).toMatchObject({
		success: true,
	});
	expect(YAML.parse(await Bun.file(projectFile).text())).toEqual({ providers: { maxInFlightRequests: { b: 3 } } });
	expect(settings.resolveFileScopeValue(cfgProvidersMaxInFlightRequests, "project")).toEqual({
		value: { a: 2, b: 3 },
		source: "project",
	});
	expect(await client.request({ type: "settings_set", ...limits, member: "c", value: 4 })).toMatchObject({
		success: true,
	});
	expect(await client.request({ type: "settings_unset", ...limits, member: "b" })).toMatchObject({ success: true });
	expect(YAML.parse(await Bun.file(projectFile).text())).toEqual({ providers: { maxInFlightRequests: { c: 4 } } });
	expect(await client.request({ type: "settings_unset", ...limits, member: "c" })).toMatchObject({ success: true });
	expect(settings.readScopeValue(cfgProvidersMaxInFlightRequests, "project")).toBeUndefined();
	expect(YAML.parse(await Bun.file(projectFile).text())).not.toHaveProperty("providers.maxInFlightRequests");
	expect(await Bun.file(globalFile).text()).toBe(globalBefore);
	expect(YAML.parse(await Bun.file(sessionFile).text())).toEqual({ modelRoles: { default: sessionRole } });

	const projectBefore = await Bun.file(projectFile).text();
	const sessionBefore = await Bun.file(sessionFile).text();
	const theme = { path: "theme.dark" };
	for (const [scope, value] of [
		["global", "titanium"],
		["persist", "anthracite"],
		[undefined, "dark"],
	] as const) {
		expect(await client.request({ type: "settings_set", scope, ...theme, value })).toMatchObject({
			success: true,
			data: { ...theme, value },
		});
		expect(YAML.parse(await Bun.file(globalFile).text())).toMatchObject({ theme: { dark: value } });
		expect(await Bun.file(projectFile).text()).toBe(projectBefore);
		expect(await Bun.file(sessionFile).text()).toBe(sessionBefore);
		expect(await peer.client.request({ type: "settings_get", ...theme })).toMatchObject({
			data: { ...theme, value: "dark" },
		});
	}
	expect(await peer.client.request({ type: "settings_get", ...roles })).toMatchObject({
		data: { ...roles, value: "anthropic/claude-sonnet-4-5" },
	});
	expect(await Bun.file(peer.globalFile).text()).toBe(peerGlobalBefore);
	expect(await Bun.file(peer.projectFile).exists()).toBe(false);
	expect(await Bun.file(peer.sessionFile).exists()).toBe(false);
});

test("runtime writes and unsets, including model role members, never change the global file", async () => {
	const { client, globalFile, settings } = await start("target");
	const globalBefore = await Bun.file(globalFile).text();
	const theme = { path: "theme.dark", scope: "runtime" };
	expect(await client.request({ type: "settings_set", ...theme, value: "titanium" })).toMatchObject({
		success: true,
		data: { value: "titanium" },
	});
	expect(await client.request({ type: "settings_unset", ...theme })).toMatchObject({
		success: true,
		data: { value: "dark" },
	});
	const role = { path: "modelRoles", scope: "runtime", member: "default" };
	const otherRole = { ...role, member: "smol" };
	expect(await client.request({ type: "settings_set", ...otherRole, value: "openai/gpt-5.2" })).toMatchObject({
		success: true,
	});
	expect(await client.request({ type: "settings_set", ...role, value: "openai/gpt-5.2" })).toMatchObject({
		success: true,
		data: { value: "openai/gpt-5.2" },
	});
	expect(await client.request({ type: "settings_unset", ...role })).toMatchObject({
		success: true,
		data: { value: "anthropic/claude-sonnet-4-5" },
	});
	expect(settings.readRuntimeOverrideValue(cfgModelRoles)).toEqual({ smol: "openai/gpt-5.2" });
	await settings.flush();
	expect(await Bun.file(globalFile).text()).toBe(globalBefore);
});

test("a default-scope model role write keeps an outside sibling edit and moves a runtime override", async () => {
	const { client, globalFile, settings } = await start("roles-global");
	const role = { path: "modelRoles", member: "default" };
	expect(
		await client.request({ type: "settings_set", ...role, scope: "runtime", value: "openai/gpt-5.1" }),
	).toMatchObject({ success: true });
	await Bun.write(
		globalFile,
		YAML.stringify({ modelRoles: { default: "anthropic/claude-sonnet-4-5", smol: "openai/gpt-5-mini" } }),
	);
	expect(await client.request({ type: "settings_set", ...role, value: "openai/gpt-5.2" })).toMatchObject({
		success: true,
		data: { ...role, value: "openai/gpt-5.2" },
	});
	await settings.flush();
	expect(YAML.parse(await Bun.file(globalFile).text())).toMatchObject({
		modelRoles: { default: "openai/gpt-5.2", smol: "openai/gpt-5-mini" },
	});
	expect(await client.request({ type: "settings_get", ...role })).toMatchObject({
		data: { ...role, value: "openai/gpt-5.2" },
	});
});

test("a refused global model role write leaves the file and the runtime override as they were", async () => {
	const { client, globalFile } = await start("roles-conflict");
	const role = { path: "modelRoles", member: "default" };
	expect(
		await client.request({ type: "settings_set", ...role, scope: "runtime", value: "openai/gpt-5.1" }),
	).toMatchObject({ success: true });
	await Bun.write(globalFile, YAML.stringify({ modelRoles: { default: "openai/gpt-5-mini" } }));
	const bytes = await Bun.file(globalFile).text();
	expect(await client.request({ type: "settings_set", ...role, value: "openai/gpt-5.2" })).toMatchObject({
		success: false,
		code: "conflict",
	});
	expect(await Bun.file(globalFile).text()).toBe(bytes);
	expect(await client.request({ type: "settings_get", ...role })).toMatchObject({
		data: { ...role, value: "openai/gpt-5.1" },
	});
});

test("after a refused project write the session holds the outside value, not the refused one", async () => {
	const { client, projectFile } = await start("project-conflict-live");
	await Bun.write(projectFile, YAML.stringify({ theme: { dark: "outside" } }));
	await client.request({ type: "settings_set", path: "theme.dark", scope: "project", value: "inside" });
	expect(await client.request({ type: "settings_get", path: "theme.dark" })).toMatchObject({
		data: { path: "theme.dark", value: "outside" },
	});
});

test("a project write refused because the file changed outside replies conflict and leaves the file alone", async () => {
	const { client, projectFile } = await start("project-conflict");
	await Bun.write(projectFile, YAML.stringify({ theme: { dark: "outside" } }));
	const bytes = await Bun.file(projectFile).text();
	expect(
		await client.request({ type: "settings_set", path: "theme.dark", scope: "project", value: "inside" }),
	).toMatchObject({ success: false, code: "conflict" });
	expect(await Bun.file(projectFile).text()).toBe(bytes);
});

test("credential writes acknowledge without echoing own, inherited, or shadowing values", async () => {
	const { client, settings } = await start("target");
	const credential = { path: "auth.broker.token" };
	const acknowledge = { success: true, data: credential };
	for (const scope of ["project", "runtime", "persist", "global", "session"] as const) {
		if (scope === "runtime") {
			// Subsequent writes to lower layers are shadowed by the session credential.
			const shadow = await client.request({
				type: "settings_set",
				scope: "session",
				...credential,
				value: "fixture-shadow",
			});
			expect({ success: shadow.success, data: shadow.data }).toEqual(acknowledge);
		}
		const value = `fixture-${scope}`;
		const set = await client.request({ type: "settings_set", scope, ...credential, value });
		expect({ success: set.success, data: set.data }).toEqual(acknowledge);
		const fileScope = scope === "persist" ? "global" : scope;
		expect(
			fileScope === "runtime"
				? settings.readRuntimeOverrideValue(cfgAuthBrokerToken)
				: settings.readScopeValue(cfgAuthBrokerToken, fileScope),
		).toBe(value);
		const unset = await client.request({ type: "settings_unset", scope, ...credential });
		expect({ success: unset.success, data: unset.data }).toEqual(acknowledge);
	}
});

test("a host without a session file refuses session writes", async () => {
	const { client } = await start("ephemeral", false);
	const request = { path: "colorBlindMode", scope: "session" };
	const failure = { success: false, code: "invalid_value", error: "This host has no session file" };
	expect(await client.request({ type: "settings_set", ...request, value: true })).toMatchObject(failure);
	expect(await client.request({ type: "settings_unset", ...request })).toMatchObject(failure);
});

test("malformed member or missing value is refused without touching the file", async () => {
	const { client, settings, globalFile } = await start("malformed");
	expect(
		await client.request({ type: "settings_set", path: "autoResume", value: true, scope: "global" }),
	).toMatchObject({
		success: true,
	});
	await settings.flush();
	const bytes = await Bun.file(globalFile).text();
	const refused = { success: false, code: "invalid_value" };
	for (const frame of [
		{ type: "settings_unset", path: "providers.maxInFlightRequests", member: 7, scope: "global" },
		{ type: "settings_unset", path: "providers.maxInFlightRequests", member: "", scope: "global" },
		{ type: "settings_unset", path: "autoResume", member: "foo", scope: "global" },
		{ type: "settings_set", path: "providers.maxInFlightRequests", scope: "global" },
	]) {
		expect(await client.request(frame)).toMatchObject(refused);
	}
	await settings.flush();
	expect(await Bun.file(globalFile).text()).toBe(bytes);
});

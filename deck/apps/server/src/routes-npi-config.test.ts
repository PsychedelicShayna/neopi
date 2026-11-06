import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { parseSettingsToml as parse } from "@oh-my-pi/pi-utils/settings-toml";
import type { NpiConfigPatchResponse, NpiConfigResponse, NpiModelRolesResponse } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { buildNpiConfigRouter } from "./routes-npi-config.ts";
import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";

import { privateBackendTest } from "./backend/private-test.ts";

if (privateBackendTest(import.meta.path)) {
	const root = await mkdtemp(path.join(tmpdir(), "deck-npi-config-test-"));
	const project = path.join(root, "project");
	await mkdir(project);
	const backend = resolveBackendSelection();
	if (!backend) throw new Error("NeoPi config tests require a configured NeoPi backend");
	await loadBackend(backend);
	// Retain the actual SDK-path refusal before rewriting config.toml.
	const agentDir = sdk().getAgentDir();
	if (!agentDir.startsWith(tmpdir())) throw new Error(`refusing to edit a non-temporary agent dir: ${agentDir}`);
	await mkdir(agentDir, { recursive: true });
	const configFile = path.join(agentDir, "config.toml");
	const priorConfig = (await Bun.file(configFile).exists()) ? await readFile(configFile, "utf8") : null;
	const config: Config = {
		defaultCwd: project,
		extraWorkspaces: [],
		host: "127.0.0.1",
		port: 0,
		devMode: true,
		idleTimeoutMs: 0,
		dbPath: path.join(root, "db"),
		uploadsRoot: path.join(root, "uploads"),
	};

	// A live chat's settings: an isolated persisted instance, reloaded like the bridge reloads a session's.
	let live = await sdk().Settings.loadIsolated({ cwd: project, agentDir });
	const bridge = {
		reloadLiveSettings: async () => {
			await live.reloadFromDisk();
			return [{ sessionId: "live", cwd: project, settings: live }];
		},
	} as unknown as AgentBridge;
	const app = buildNpiConfigRouter(bridge, config);
	const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
	const patch = (body: unknown) =>
		request("/npi-config", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const list = async () => (await (await request("/npi-config")).json()) as NpiConfigResponse;

	const roles = async () => {
		const response = await request("/npi-config/model-roles");
		expect(response.status).toBe(200);
		return (await response.json()) as NpiModelRolesResponse;
	};
	const BUILTIN_ROLES = [
		"default",
		"smol",
		"slow",
		"vision",
		"plan",
		"commit",
		"tiny",
		"memory",
		"task",
		"advisor",
		"chronicler",
		"prose",
		"image",
		"web",
		"speech",
		"dictation",
		"judge",
	];

	beforeEach(async () => {
		await writeFile(configFile, '[theme]\ndark = "titanium"\n');
		live = await sdk().Settings.loadIsolated({ cwd: project, agentDir });
	});
	afterEach(() => {
		delete process.env.PI_EDIT_FUZZY_THRESHOLD;
	});
	afterAll(async () => {
		if (priorConfig === null) await rm(configFile, { force: true });
		else await writeFile(configFile, priorConfig);
		await rm(root, { recursive: true, force: true });
	});

	test("every registered setting is listed once; settings without panel metadata land in Other", async () => {
		const body = await list();
		const ids = body.settings.map(s => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("statusLine.leftSegments");
		expect(body.settings.find(s => s.id === "modelRoles")?.tab).toBe("other");
		expect(body.tabs.at(-1)?.id).toBe("other");
		for (const setting of body.settings) {
			const tab = body.tabs.find(t => t.id === setting.tab);
			expect(tab?.groups).toContain(setting.group);
		}
	});

	test("a saved record reaches config.toml and the live session; reset removes the key", async () => {
		const chains = { "anthropic/claude-opus-5-5": ["openai-codex/gpt-6-sol:medium"] };
		const saved = await patch({ id: "retry.fallbackChains", value: chains });
		expect(saved.status).toBe(200);
		const result = (await saved.json()) as NpiConfigPatchResponse;
		const text = await readFile(configFile, "utf8");
		expect(parse(text)).toHaveProperty("theme.dark", "titanium");
		expect(text).toContain("openai-codex/gpt-6-sol:medium");
		expect(result.setting).toMatchObject({ provenance: "global", inGlobalConfig: true, value: chains });
		expect(result.live).toEqual([{ sessionId: "live", cwd: project, provenance: "global", effectiveValue: chains }]);
		expect((await list()).settings.find(s => s.id === "retry.fallbackChains")).toMatchObject({
			provenance: "global",
			effectiveValue: chains,
		});

		const reset = (await (await patch({ id: "retry.fallbackChains", unset: true })).json()) as NpiConfigPatchResponse;
		expect(await readFile(configFile, "utf8")).not.toContain("fallbackChains");
		expect(reset.setting).toMatchObject({ provenance: "default", inGlobalConfig: false });
		expect(reset.live[0]).toMatchObject({ provenance: "default", effectiveValue: {} });
	});

	test("stale expected values reject role edits without replacing a newer assignment", async () => {
		const before = await roles();
		const first = await patch({
			id: "modelRoles",
			entries: { review: "openai/gpt-4o" },
			expectedValue: before.setting.value,
		});
		expect(first.status).toBe(200);
		const persisted = await readFile(configFile, "utf8");
		const stale = await patch({
			id: "modelRoles",
			entries: { review: "anthropic/claude-sonnet" },
			expectedValue: before.setting.value,
		});
		expect(stale.status).toBe(409);
		expect(await stale.text()).toContain("changed since this page loaded");
		expect(await readFile(configFile, "utf8")).toBe(persisted);
		const fresh = await roles();
		expect(
			(
				await patch({
					id: "modelRoles",
					entries: { review: "anthropic/claude-sonnet" },
					expectedValue: fresh.setting.value,
				})
			).status,
		).toBe(200);
	});

	test("expected-value checks cannot be used to compare secret configuration", async () => {
		const before = await readFile(configFile, "utf8");
		const response = await patch({ id: "searxng.token", value: "new-secret", expectedValue: null });
		expect(response.status).toBe(400);
		expect(await readFile(configFile, "utf8")).toBe(before);
	});

	test.skipIf(!("setActiveRole" in live))(
		"live settings report role provenance without replacing the saved global value",
		async () => {
			const configured = await patch({
				id: "roleSettings",
				value: { review: { "compaction.thresholdTokens": 64000 } },
			});
			expect(configured.status).toBe(200);
			if (!("setActiveRole" in live) || typeof live.setActiveRole !== "function")
				throw new Error("backend lacks active role settings");
			live.setActiveRole("review");
			const response = await patch({ id: "compaction.thresholdTokens", value: 32000 });
			expect(response.status).toBe(200);
			const body = (await response.json()) as NpiConfigPatchResponse;
			expect(body.setting).toMatchObject({ provenance: "global", value: 32000, effectiveValue: 32000 });
			expect(body.live).toEqual([{ sessionId: "live", cwd: project, provenance: "role", effectiveValue: 64000 }]);
			expect((await list()).settings.find(setting => setting.id === "compaction.thresholdTokens")).toMatchObject({
				provenance: "global",
				effectiveValue: 32000,
			});
		},
	);

	test("invalid values fail with the setting's own message and leave config.toml untouched", async () => {
		const before = await readFile(configFile, "utf8");
		const cases: Array<[string, unknown, string]> = [
			["edit.fuzzyThreshold", "abc", "Invalid number: abc"],
			["edit.mode", "bogus", "Valid values:"],
			["providers.maxInFlightRequests", { openai: -1 }, "Provider request limits must be positive numbers: openai"],
			["retry.fallbackChains", ["not", "a", "record"], "expected a record"],
			["statusLine.leftSegments", ["no-such-segment"], "Unknown status line segment"],
		];
		for (const [id, value, message] of cases) {
			const response = await patch({ id, value });
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: string }).error).toContain(message);
		}
		expect((await patch({ id: "no.such.setting", value: 1 })).status).toBe(404);
		expect(await readFile(configFile, "utf8")).toBe(before);
	});

	test("credentials are write-only: configured and saved secrets never appear in responses", async () => {
		await writeFile(configFile, '[searxng]\ntoken = "s3cret-configured"\n');
		const response = await request("/npi-config");
		expect(await response.clone().text()).not.toContain("s3cret-configured");
		const token = ((await response.json()) as NpiConfigResponse).settings.find(s => s.id === "searxng.token");
		expect(token).toMatchObject({
			secret: true,
			configured: true,
			provenance: "global",
			value: null,
			effectiveValue: null,
		});

		const saved = await patch({ id: "searxng.token", value: "s3cret-saved" });
		expect(saved.status).toBe(200);
		expect(await saved.text()).not.toContain("s3cret-saved");
		expect(await readFile(configFile, "utf8")).toContain("s3cret-saved");
	});

	test("a malformed config.toml fails without quoting the file and stays in place", async () => {
		// Parser detail must not escape even when its offending line contains a secret.
		const broken = '[searxng]\ntoken = "s3cret-in-broken-line\n';
		await writeFile(configFile, broken);
		for (const response of [await request("/npi-config"), await patch({ id: "edit.mode", value: "replace" })]) {
			expect(response.status).toBe(500);
			const text = await response.text();
			expect(text).not.toContain("s3cret");
			expect(JSON.parse(text).error).toContain("could not load or save");
		}
		expect(await readFile(configFile, "utf8")).toBe(broken);
	});

	test("rejected credential values are not echoed back", async () => {
		for (const [id, value] of [
			["images.urls.credentials", "s3cret-not-json"],
			["searxng.token", { token: "s3cret-wrong-type" }],
		] as const) {
			const response = await patch({ id, value });
			expect(response.status).toBe(400);
			const text = await response.text();
			expect(text).not.toContain("s3cret");
			expect(JSON.parse(text).error).toContain(id);
		}
	});

	test("credential record entries merge field-wise and keep the hidden others", async () => {
		await writeFile(
			configFile,
			[
				"[images.urls.credentials.alpha]",
				'clientId = "s3cret-alpha-id"',
				'accessToken = "s3cret-alpha-old"',
				'refreshToken = "s3cret-alpha-refresh"',
				"[images.urls.credentials.beta]",
				'token = "s3cret-beta"',
				"",
			].join("\n"),
		);
		const listed = (await list()).settings.find(s => s.id === "images.urls.credentials");
		expect(listed).toMatchObject({
			secret: true,
			value: null,
			secretEntries: [
				{ key: "alpha", fields: ["clientId", "accessToken", "refreshToken"] },
				{ key: "beta", fields: ["token"] },
			],
		});
		const response = await patch({
			id: "images.urls.credentials",
			entries: {
				alpha: { accessToken: "s3cret-alpha-new", refreshToken: null },
				beta: null,
				gamma: { token: "s3cret-gamma" },
			},
		});
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("s3cret");
		expect((JSON.parse(text) as NpiConfigPatchResponse).setting.secretEntries).toEqual([
			{ key: "alpha", fields: ["clientId", "accessToken"] },
			{ key: "gamma", fields: ["token"] },
		]);
		const saved = parse(await readFile(configFile, "utf8")) as { images: { urls: { credentials: unknown } } };
		expect(saved.images.urls.credentials).toEqual({
			alpha: { clientId: "s3cret-alpha-id", accessToken: "s3cret-alpha-new" },
			gamma: { token: "s3cret-gamma" },
		});
	});

	test("legacy config.yaml imports once and future saves write only config.toml", async () => {
		const yamlFile = path.join(agentDir, "config.yaml");
		const original = "theme:\n  dark: titanium\nedit:\n  mode: patch\n";
		await rm(configFile);
		await writeFile(yamlFile, original);
		try {
			const body = await list();
			expect(body.configPath).toBe(configFile);
			expect(body.settings.find(s => s.id === "edit.mode")).toMatchObject({ provenance: "global", value: "patch" });
			const response = await patch({ id: "edit.mode", value: "replace" });
			expect(response.status).toBe(200);
			expect(((await response.json()) as NpiConfigPatchResponse).setting).toMatchObject({
				provenance: "global",
				value: "replace",
			});
			expect(parse(await readFile(configFile, "utf8"))).toMatchObject({
				edit: { mode: "replace" },
				theme: { dark: "titanium" },
			});
			expect(await readFile(yamlFile, "utf8")).toBe(original);
		} finally {
			await rm(yamlFile, { force: true });
		}
	});

	test("an environment override locks its key with the reason and refuses writes", async () => {
		process.env.PI_EDIT_FUZZY_THRESHOLD = "0.7";
		const setting = (await list()).settings.find(s => s.id === "edit.fuzzyThreshold");
		expect(setting).toMatchObject({
			provenance: "env",
			effectiveValue: 0.7,
			env: { name: "PI_EDIT_FUZZY_THRESHOLD", fallback: false, active: true },
		});
		expect(setting?.lockedReason).toContain("$PI_EDIT_FUZZY_THRESHOLD");
		const before = await readFile(configFile, "utf8");
		const response = await patch({ id: "edit.fuzzyThreshold", value: 0.9 });
		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: string }).error).toContain("$PI_EDIT_FUZZY_THRESHOLD");
		expect(await readFile(configFile, "utf8")).toBe(before);
	});

	test("model roles: every built-in role in NeoPi's order, then custom roles, each with its own layer and model filter", async () => {
		// Newer SDKs add built-in roles. Keep the shared core's order fixed while
		// requiring configured roles to follow the backend's entire built-in list.
		const builtins = (await roles()).roles;
		expect(builtins.every(role => role.builtin)).toBe(true);
		expect(builtins.map(role => role.id).filter(id => BUILTIN_ROLES.includes(id))).toEqual(BUILTIN_ROLES);
		await writeFile(
			configFile,
			'[modelRoles]\nsmol = "openrouter/openai/gpt-4o-mini"\nreview = "anthropic/claude-opus-5-5:high"\nsweep = ["openai/gpt-5", "@smol"]\n',
		);
		const projectDir = path.join(project, ".omp");
		await mkdir(projectDir, { recursive: true });
		await writeFile(path.join(projectDir, "config.toml"), '[modelRoles]\nplan = "openai/gpt-5:high"\n');
		try {
			const body = await roles();
			expect(body.roles.map(r => r.id)).toEqual([...builtins.map(role => role.id), "review", "sweep"]);
			const role = (id: string) => body.roles.find(r => r.id === id)!;
			expect(role("smol")).toMatchObject({
				name: "Fast",
				tag: "SMOL",
				section: "chat",
				builtin: true,
				value: "openrouter/openai/gpt-4o-mini",
				effectiveValue: "openrouter/openai/gpt-4o-mini",
				provenance: "global",
			});
			// Unset: no layer assigns it, so NeoPi's built-in chain is what applies.
			expect(role("slow")).toMatchObject({ value: null, effectiveValue: null, provenance: "default" });
			expect(role("slow").patterns.length).toBeGreaterThan(0);
			// A project layer shadows the global file for this workspace.
			expect(role("plan")).toMatchObject({
				value: null,
				effectiveValue: "openai/gpt-5:high",
				provenance: "project",
			});
			expect(role("review")).toMatchObject({
				builtin: false,
				section: "chat",
				value: "anthropic/claude-opus-5-5:high",
				provenance: "global",
			});
			expect(role("sweep")).toMatchObject({ value: "openai/gpt-5,@smol" });
			// Chat roles share one filter, which admits mixtures; model-kind roles each have their own.
			expect(role("review").pool).toBe(role("default").pool);
			expect(body.pools[role("default").pool]!.mixtures).toBe(true);
			expect(new Set(["default", "image", "web", "speech", "dictation"].map(id => role(id).pool)).size).toBe(5);
			expect(body.pools[role("image").pool]!.mixtures).toBe(false);
			expect(body.setting).toMatchObject({ id: "modelRoles", type: "record" });
			expect(body.thinkingLevels).toEqual(expect.arrayContaining(["low", "medium", "high"]));
		} finally {
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("model roles: assigning or unsetting one role keeps every other role, including unknown ones", async () => {
		await writeFile(
			configFile,
			'[modelRoles]\nsmol = "openrouter/openai/gpt-4o-mini"\nreview = "anthropic/claude-opus-5-5:high"\n',
		);
		const saved = await patch({ id: "modelRoles", entries: { slow: "anthropic/claude-opus-5-5:high" } });
		expect(saved.status).toBe(200);
		expect(((await saved.json()) as NpiConfigPatchResponse).live[0]?.effectiveValue).toMatchObject({
			slow: "anthropic/claude-opus-5-5:high",
			review: "anthropic/claude-opus-5-5:high",
		});
		expect((await patch({ id: "modelRoles", entries: { smol: null } })).status).toBe(200);
		const body = await roles();
		const role = (id: string) => body.roles.find(r => r.id === id);
		expect(role("slow")).toMatchObject({ value: "anthropic/claude-opus-5-5:high", provenance: "global" });
		expect(role("smol")).toMatchObject({ value: null, provenance: "default" });
		expect(role("review")).toMatchObject({ builtin: false, value: "anthropic/claude-opus-5-5:high" });
		const saved2 = parse(await readFile(configFile, "utf8")) as { modelRoles: Record<string, string> };
		expect(saved2.modelRoles).toEqual({
			review: "anthropic/claude-opus-5-5:high",
			slow: "anthropic/claude-opus-5-5:high",
		});
	});

	test("GUI saves preserve top-level and nested TOML comments", async () => {
		await writeFile(
			configFile,
			'# operator heading\n[theme] # theme section\ndark = "titanium" # theme note\n\n[edit]\n# edit policy\nmode = "patch" # mode note\n',
		);
		const response = await patch({ id: "edit.mode", value: "replace" });
		expect(response.status).toBe(200);
		const saved = await readFile(configFile, "utf8");
		for (const comment of ["# operator heading", "# theme section", "# theme note", "# edit policy", "# mode note"])
			expect(saved).toContain(comment);
		expect(parse(saved)).toMatchObject({ theme: { dark: "titanium" }, edit: { mode: "replace" } });
	});
}

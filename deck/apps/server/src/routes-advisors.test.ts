import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { parseSettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { feature, loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { buildAdvisorsRouter } from "./routes-advisors.ts";
import type { AgentBridge } from "./bridge/types.ts";
import type { Config } from "./config.ts";

import { privateBackendTest } from "./backend/private-test.ts";

if (privateBackendTest(import.meta.path)) {
	const root = await mkdtemp(path.join(tmpdir(), "deck-advisor-test-"));
	const project = path.join(root, "project");
	await mkdir(project);
	const backend = resolveBackendSelection();
	if (!backend) throw new Error("advisor tests require a configured NeoPi backend");
	await loadBackend(backend);
	const agentDir = sdk().getAgentDir();
	if (!agentDir.startsWith(tmpdir())) throw new Error(`refusing to edit a non-temporary agent dir: ${agentDir}`);
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
	let roster: Array<{ name: string; enabled?: boolean }> = [];
	let model = "";
	const fake = {
		cwd: project,
		applyAdvisorConfigs: (discovered: { advisors: typeof roster }) => {
			roster = discovered.advisors;
		},
	};
	const bridge = {
		listSessions: async () => [],
		advisorSession: (id: string) => (id === "live" ? fake : undefined),
		liveAdvisorSessions: () => [fake],
		reloadLiveSettings: async () => {
			model =
				(
					parseSettingsToml(await readFile(path.join(agentDir, "config.toml"), "utf8")).modelRoles as Record<
						string,
						string
					>
				)?.advisor ?? "";
			return [];
		},
	} as unknown as AgentBridge;
	const app = buildAdvisorsRouter(bridge, config);
	const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
	const json = (method: string, body: unknown): RequestInit => ({
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	type AdvisorSnapshot = {
		user: { hash: string };
		project: { hash: string; file: string };
	};
	type SavedAdvisors = {
		saved: { file: string };
		merged: { advisors: Array<{ name: string; source: string | null; instructions?: string }> };
	};
	type ToggledAdvisors = {
		file: string;
		merged: { advisors: Array<{ name: string; enabled?: boolean; source: string | null }> };
	};
	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("project save hot-applies; user overrides survive", async () => {
		await writeFile(
			path.join(agentDir, "WATCHDOG.toml"),
			'[[advisors]]\nname = "Shared"\ninstructions = "User version"\n',
		);
		const initial = (await (await request(`/advisors?cwd=${encodeURIComponent(project)}`)).json()) as AdvisorSnapshot;
		const userHash = initial.user.hash;
		const projectHash = initial.project.hash;
		const response = await request(
			"/advisors/watchdog",
			json("PUT", {
				cwd: project,
				scope: "project",
				hash: projectHash,
				doc: {
					advisors: [
						{ name: "Shared", instructions: "Project version" },
						{ name: "Other", enabled: false },
					],
				},
			}),
		);
		expect(response.status).toBe(200);
		const saved = (await response.json()) as SavedAdvisors;
		expect(saved.merged.advisors.find(a => a.name === "Shared")?.source).toBe(saved.saved.file);
		expect(saved.merged.advisors.find(a => a.name === "Shared")?.instructions).toBe("Project version");
		expect(await readFile(path.join(agentDir, "WATCHDOG.toml"), "utf8")).toContain("User version");
		const userEdit = await request(
			"/advisors/watchdog",
			json("PUT", {
				cwd: project,
				scope: "user",
				hash: userHash,
				doc: { advisors: [{ name: "Shared", instructions: "User updated" }] },
			}),
		);
		expect(userEdit.status).toBe(200);
		expect(((await userEdit.json()) as SavedAdvisors).merged.advisors[0]?.instructions).toBe("Project version");
		expect(roster.find(a => a.name === "Shared")).toMatchObject({ instructions: "Project version" });
	});

	test("two stale editors and an external edit cannot overwrite a WATCHDOG file", async () => {
		const initial = (await (await request(`/advisors?cwd=${encodeURIComponent(project)}`)).json()) as AdvisorSnapshot;
		const file = initial.project.file;
		await writeFile(file, '# external editor\n[[advisors]]\nname = "TUI"\n');
		const stale = await request(
			"/advisors/watchdog",
			json("PUT", {
				cwd: project,
				scope: "project",
				hash: initial.project.hash,
				doc: { advisors: [{ name: "Lost" }] },
			}),
		);
		expect(stale.status).toBe(409);
		expect(await readFile(file, "utf8")).toContain("TUI");
		const fresh = (await (await request(`/advisors?cwd=${encodeURIComponent(project)}`)).json()) as AdvisorSnapshot;
		const [winner, loser] = await Promise.all([
			request(
				"/advisors/watchdog",
				json("PUT", {
					cwd: project,
					scope: "project",
					hash: fresh.project.hash,
					doc: { advisors: [{ name: "First" }] },
				}),
			),
			request(
				"/advisors/watchdog",
				json("PUT", {
					cwd: project,
					scope: "project",
					hash: fresh.project.hash,
					doc: { advisors: [{ name: "Second" }] },
				}),
			),
		]);
		expect([winner.status, loser.status].sort()).toEqual([200, 409]);
	});

	test("enabled toggle writes the advisor's winning WATCHDOG scope only", async () => {
		const userFile = path.join(agentDir, "WATCHDOG.toml");
		const projectFile = path.join(project, "WATCHDOG.toml");
		await writeFile(
			userFile,
			'# user roster\n[[advisors]]\nname = "Velvet"\ninstructions = "Keep it tidy"\n[[advisors]]\nname = "Rook"\nenabled = false\n',
		);
		await writeFile(
			projectFile,
			'# project roster\n[[advisors]]\nname = "Rook"\nmodel = "openrouter/openai/gpt-4o-mini"\n',
		);
		const toggle = (name: string, enabled: boolean) =>
			request("/advisors/watchdog/enabled", json("PATCH", { cwd: project, name, enabled }));

		const velvet = await toggle("Velvet", false);
		expect(velvet.status).toBe(200);
		const velvetBody = (await velvet.json()) as ToggledAdvisors;
		expect(velvetBody.file).toBe(userFile);
		expect(velvetBody.merged.advisors.find(a => a.name === "Velvet")?.enabled).toBe(false);
		expect(parseSettingsToml(await readFile(userFile, "utf8"))).toMatchObject({
			advisors: [
				{ name: "Velvet", instructions: "Keep it tidy", enabled: false },
				{ name: "Rook", enabled: false },
			],
		});
		expect(await readFile(projectFile, "utf8")).toBe(
			'# project roster\n[[advisors]]\nname = "Rook"\nmodel = "openrouter/openai/gpt-4o-mini"\n',
		);

		// Rook's effective entry is the project one; the user file's copy is shadowed.
		const rook = await toggle("Rook", true);
		expect(rook.status).toBe(200);
		expect(((await rook.json()) as ToggledAdvisors).file).toBe(projectFile);
		expect(parseSettingsToml(await readFile(projectFile, "utf8"))).toMatchObject({
			advisors: [{ name: "Rook", model: "openrouter/openai/gpt-4o-mini", enabled: true }],
		});
		expect(parseSettingsToml(await readFile(userFile, "utf8"))).toMatchObject({
			advisors: [
				{ name: "Velvet", enabled: false },
				{ name: "Rook", enabled: false },
			],
		});
		expect(roster.map(a => [a.name, a.enabled])).toEqual([
			["Velvet", false],
			["Rook", true],
		]);

		expect((await toggle("Nobody", true)).status).toBe(404);
	});

	test("enabled toggle never reports success the roster does not show", async () => {
		const userFile = path.join(agentDir, "WATCHDOG.toml");
		await rm(path.join(project, "WATCHDOG.toml"), { force: true });
		await writeFile(userFile, '[[advisors]]\nname = "Velvet"\ninstructions = "Keep it tidy"\n');
		// Another editor sets Velvet's key between the route's load and its save;
		// NeoPi's save keeps a field changed on disk since the load.
		const api = feature("advisors");
		const save = api.saveWatchdogConfigFile;
		api.saveWatchdogConfigFile = async (file, doc) => {
			await writeFile(userFile, '[[advisors]]\nname = "Velvet"\ninstructions = "Keep it tidy"\nenabled = true\n');
			return save(file, doc);
		};
		try {
			const response = await request(
				"/advisors/watchdog/enabled",
				json("PATCH", { cwd: project, name: "Velvet", enabled: false }),
			);
			const onDisk =
				(parseSettingsToml(await readFile(userFile, "utf8")).advisors as Array<{ enabled?: boolean }>)[0]
					?.enabled !== false;
			// Baseline-aware NeoPi (the pinned tree) keeps the external value; older trees overwrite it.
			expect(response.status).toBe(onDisk === false ? 200 : 409);
			expect(
				((await response.json()) as ToggledAdvisors).merged.advisors.find(a => a.name === "Velvet")?.enabled,
			).toBe(onDisk);
			expect(roster.find(a => a.name === "Velvet")?.enabled).toBe(onDisk);
		} finally {
			api.saveWatchdogConfigFile = save;
		}
	});

	test("model role saves via locked settings without dropping unrelated keys", async () => {
		await writeFile(
			path.join(agentDir, "config.toml"),
			'# Captain comment\n[theme]\ndark = "titanium"\n[modelRoles]\nsmol = "openrouter/openai/gpt-4o-mini"\n',
		);
		const response = await request(
			"/advisors/settings",
			json("PATCH", { cwd: project, model: "openrouter/openai/gpt-4o-mini" }),
		);
		expect(response.status).toBe(200);
		const text = await readFile(path.join(agentDir, "config.toml"), "utf8");
		expect(parseSettingsToml(text)).toMatchObject({
			modelRoles: { smol: "openrouter/openai/gpt-4o-mini", advisor: "openrouter/openai/gpt-4o-mini" },
			theme: { dark: "titanium" },
		});
		expect(text).toContain("# Captain comment");
		expect(model).toBe("openrouter/openai/gpt-4o-mini");
	});

	test("legacy roster import returns a fresh canonical hash and saves never modify YAML", async () => {
		const legacy = path.join(agentDir, "WATCHDOG.yaml");
		const canonical = path.join(agentDir, "WATCHDOG.toml");
		const original = "advisors:\n  - name: Imported\n    enabled: false\n";
		await rm(canonical, { force: true });
		await rm(path.join(project, "WATCHDOG.toml"), { force: true });
		await writeFile(legacy, original);
		try {
			const initial = (await (await request("/advisors")).json()) as AdvisorSnapshot & { user: { file: string } };
			expect(initial.user.file).toBe(canonical);
			const response = await request(
				"/advisors/watchdog",
				json("PUT", {
					scope: "user",
					hash: initial.user.hash,
					doc: { advisors: [{ name: "Imported", enabled: true }] },
				}),
			);
			expect(response.status).toBe(200);
			expect(parseSettingsToml(await readFile(canonical, "utf8"))).toMatchObject({
				advisors: [{ name: "Imported", enabled: true }],
			});
			expect(await readFile(legacy, "utf8")).toBe(original);
		} finally {
			await rm(legacy, { force: true });
		}
	});
}

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hashPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import { buildSpec } from "../src/cli/completion-gen";
import {
	PROMPT_ACTIONS,
	type PromptsCommandOptions,
	type PromptsFlags,
	runPromptsCommand,
} from "../src/cli/prompts-cli";
import { commands } from "../src/cli-commands";
import Prompts from "../src/commands/prompts";
import type { PromptAsset, PromptDiagnostic } from "../src/prompts/types";

const assets: readonly PromptAsset[] = [
	{
		id: "system/system-prompt.md",
		relPath: "system/system-prompt.md",
		group: "core",
		scope: "system",
		bundled: 'Working in {{cwd}}.\n{{#if tools}}{{join tools ", "}}{{/if}}\n',
		keys: [
			{ path: "cwd", type: "string", required: true, resolution: "static-fixture" },
			{ path: "tools", type: "string[]", resolution: "static-fixture" },
			{ path: "workspaceTree", type: "string", resolution: "session-dependent" },
		],
		fixture: { cwd: "/fixture", tools: ["bash", "read"] },
		consumerHints: ["buildSystemPrompt"],
	},
	{
		id: "live/live-instructions.md",
		relPath: "live/live-instructions.md",
		group: "feature",
		scope: "live",
		bundled: "You are speaking to {{firstName}} ({{username}}).\n",
		keys: [
			{ path: "username", type: "string", required: true },
			{ path: "firstName", type: "string", required: true },
		],
		fixture: { username: "fixture-user", firstName: "Fixture" },
		consumerHints: ["currentUser"],
	},
	{
		id: "tools/bash.md",
		relPath: "tools/bash.md",
		group: "core",
		scope: "tool:bash",
		bundled: "Run commands.{{#if asyncEnabled}} Background is enabled.{{/if}}\n",
		keys: [{ path: "asyncEnabled", type: "boolean", resolution: "static-fixture" }],
		fixture: { asyncEnabled: true },
		consumerHints: ["BashTool.description"],
	},
];

interface ListedAsset {
	id: string;
	source: string;
	path?: string;
	hash: string;
	bundledHash: string;
	drift: string;
	hint?: string;
}
interface CheckResult {
	checked: string[];
	diagnostics: PromptDiagnostic[];
}

let scratch: string;
let cwd: string;
let agentDir: string;
beforeEach(async () => {
	const cache = path.join(os.homedir(), ".cache", "npi-canary");
	await fs.mkdir(cache, { recursive: true });
	scratch = await fs.mkdtemp(path.join(cache, "prompts-cli-"));
	cwd = path.join(scratch, "project");
	agentDir = path.join(scratch, "profile", "agent");
	await fs.mkdir(cwd, { recursive: true });
});
afterEach(async () => {
	await fs.rm(scratch, { recursive: true, force: true });
});

async function run(
	action: string,
	flags: PromptsFlags = {},
	targets: string[] = [],
	extra: PromptsCommandOptions = {},
) {
	let stdout = "";
	let stderr = "";
	const code = await runPromptsCommand(
		{ action, flags: { json: true, ...flags }, targets },
		{
			cwd,
			agentDir,
			assets,
			stdout: text => {
				stdout += text;
			},
			stderr: text => {
				stderr += text;
			},
			...extra,
		},
	);
	return { code, stdout, stderr, json: () => JSON.parse(stdout) as unknown };
}
const userRoot = () => path.join(agentDir, "builtin-prompts");
const projectRoot = () => path.join(cwd, ".omp", "builtin-prompts");

describe("prompts unpack and reset", () => {
	it("unpacks raw core templates, records source contracts and leaves live values dynamic", async () => {
		const result = await run("unpack");
		expect(result.code).toBe(0);
		const manifest = (await Bun.file(path.join(userRoot(), "OMP_PROMPT_MANIFEST.json")).json()) as {
			ompVersion: string;
			unpackedAt: string;
			assets: Record<string, unknown>[];
		};
		expect(manifest.ompVersion).toBeString();
		expect(Number.isFinite(Date.parse(manifest.unpackedAt))).toBe(true);
		expect(manifest.assets).toHaveLength(2);
		expect(manifest.assets[0]).toMatchObject({
			id: assets[0].id,
			bundledHash: hashPromptAsset(assets[0].bundled),
			scope: "system",
			hasHandlebars: true,
			expectedKeys: ["cwd", "tools", "workspaceTree"],
			keyTypes: { cwd: "string", tools: "string[]", workspaceTree: "string" },
			runtimeOnly: [],
			localHelpers: [],
			consumerHints: ["buildSystemPrompt"],
		});
		expect(await Bun.file(path.join(userRoot(), assets[0].relPath)).text()).toBe(assets[0].bundled);
		expect(await Bun.file(path.join(userRoot(), assets[1].relPath)).exists()).toBe(false);
		expect((await run("unpack", { include: "all", only: "live/*" })).code).toBe(0);
		expect(await Bun.file(path.join(userRoot(), assets[1].relPath)).text()).toBe(assets[1].bundled);
	});

	it("qualifies nested array and object keys in manifest contracts", async () => {
		const nested: PromptAsset = {
			...assets[0],
			keys: [
				{
					path: "items",
					type: "object[]",
					children: [
						{ path: "label", type: "string", resolution: "runtime-only" },
						{ path: "metadata", type: "object", children: [{ path: "enabled", type: "boolean" }] },
					],
				},
			],
		};
		const result = await run("unpack", {}, [], { assets: [nested] });
		expect(result.code).toBe(0);
		expect(result.json()).toMatchObject({
			manifest: {
				assets: [
					expect.objectContaining({
						expectedKeys: ["items", "items[].label", "items[].metadata", "items[].metadata.enabled"],
						keyTypes: {
							items: "object[]",
							"items[].label": "string",
							"items[].metadata": "object",
							"items[].metadata.enabled": "boolean",
						},
						runtimeOnly: ["items[].label"],
					}),
				],
			},
		});
	});

	it("skips user edits by default and force restores template source", async () => {
		await run("unpack");
		const file = path.join(userRoot(), assets[0].relPath);
		await Bun.write(file, "my template {{cwd}}");
		const skipped = await run("unpack");
		expect(skipped.json()).toMatchObject({ written: [], skipped: [assets[0].relPath, assets[2].relPath] });
		expect(await Bun.file(file).text()).toBe("my template {{cwd}}");
		expect((await run("unpack", { force: true })).code).toBe(0);
		expect(await Bun.file(file).text()).toBe(assets[0].bundled);
	});

	it("supports exact project and custom roots without writing to the user profile", async () => {
		expect((await run("unpack", { project: true, only: "tools/*" })).code).toBe(0);
		expect(await Bun.file(path.join(projectRoot(), assets[2].relPath)).text()).toBe(assets[2].bundled);
		expect(await Bun.file(path.join(userRoot(), assets[2].relPath)).exists()).toBe(false);
		expect((await run("unpack", { dir: "exports", only: "tools/*" })).code).toBe(0);
		expect(await Bun.file(path.join(cwd, "exports", assets[2].relPath)).text()).toBe(assets[2].bundled);
	});

	it("rejects conflicting destinations, unsupported flags and invalid include values", async () => {
		for (const flags of [
			{ user: true, project: true },
			{ user: true, dir: "out" },
			{ project: true, dir: "out" },
			{ dir: "" },
			{ include: "invalid" },
			{ unused: true },
		])
			expect((await run("unpack", flags)).code).toBe(2);
		expect((await run("unknown")).code).toBe(2);
		expect((await run("reset")).code).toBe(2);
		expect((await run("reset", { all: true }, [assets[0].id])).code).toBe(2);
	});

	it("refuses traversal and symlink escapes even with force", async () => {
		const outside = path.join(scratch, "outside");
		await fs.mkdir(outside);
		await fs.mkdir(userRoot(), { recursive: true });
		await fs.symlink(outside, path.join(userRoot(), "tools"));
		expect((await run("unpack", { force: true, only: "tools/*" })).code).toBe(2);
		expect(await Bun.file(path.join(outside, "bash.md")).exists()).toBe(false);
		const malicious = { ...assets[0], relPath: "../../escape.md" };
		expect((await run("unpack", {}, [], { assets: [malicious] })).code).toBe(2);
		expect(await Bun.file(path.join(agentDir, "escape.md")).exists()).toBe(false);
	});

	it("resets only catalogued override files and preserves content slots and discovered agents", async () => {
		await run("unpack");
		const keep = [
			path.join(agentDir, "SYSTEM.md"),
			path.join(agentDir, "APPEND_SYSTEM.md"),
			path.join(agentDir, "PERSONALITY.md"),
			path.join(agentDir, "agents", "scout.md"),
			path.join(cwd, ".omp", "SYSTEM.md"),
			path.join(userRoot(), "unrelated.md"),
		];
		for (const file of keep) await Bun.write(file, "literal {{notATemplate}}");
		expect((await run("reset", { user: true, all: true })).code).toBe(0);
		for (const file of keep) expect(await Bun.file(file).text()).toBe("literal {{notATemplate}}");
		expect(await Bun.file(path.join(userRoot(), assets[0].relPath)).exists()).toBe(false);
		const result = await run("show", {}, [assets[0].id]);
		expect(result.json()).toMatchObject({ source: "bundled", text: assets[0].bundled });
	});
});

describe("prompts inspection", () => {
	it("lists project > user > bundled provenance, exact selected roots and content hashes", async () => {
		await run("unpack", { only: "tools/*" });
		await Bun.write(path.join(projectRoot(), assets[0].relPath), "project {{cwd}}");
		const result = await run("list");
		const listed = result.json() as ListedAsset[];
		expect(listed.map(asset => asset.source)).toEqual(["project", "bundled", "user"]);
		expect(listed[0]).toMatchObject({
			hash: hashPromptAsset("project {{cwd}}"),
			bundledHash: hashPromptAsset(assets[0].bundled),
			path: path.join(projectRoot(), assets[0].relPath),
		});
		expect((await run("show", { user: true }, [assets[0].id])).json()).toMatchObject({ source: "bundled" });
		expect((await run("show", {}, [path.join(projectRoot(), assets[0].relPath)])).json()).toMatchObject({
			source: "project",
			text: "project {{cwd}}",
		});
	});

	it("marks old unchanged bundles for refresh and warns on diverged overrides", async () => {
		await run("unpack");
		const changed = assets.map(asset => ({ ...asset, bundled: `${asset.bundled}New bundle\n` }));
		expect((await run("list", {}, [], { assets: changed })).json()).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: assets[0].id, drift: "refresh-available" })]),
		);
		await Bun.write(path.join(userRoot(), assets[0].relPath), "my changes {{cwd}}");
		const listing = (await run("list", {}, [], { assets: changed })).json() as ListedAsset[];
		expect(listing[0]).toMatchObject({ drift: "diverged", hint: expect.stringContaining("Keep your changes") });
		expect((await run("check", { "strict-warnings": true }, [], { assets: changed })).code).toBe(1);
	});

	it("shows context contracts and a unified diff without rendering source", async () => {
		await Bun.write(path.join(userRoot(), assets[2].relPath), "Override {{asyncEnabled}}\n");
		const shown = await run("show", { vars: true }, [assets[2].id]);
		expect(shown.json()).toMatchObject({ text: "Override {{asyncEnabled}}\n", contract: expect.any(Object) });
		const diff = await run("diff", {}, ["tools/*"]);
		expect(diff.json()).toEqual([
			expect.objectContaining({ id: assets[2].id, diff: expect.stringContaining("+Override {{asyncEnabled}}") }),
		]);
		expect((await run("keys", {}, [assets[2].id])).code).toBe(0);
		expect((await run("keys", {}, ["**/*.md"])).code).toBe(2);
	});

	it("filters lexicon helpers, scopes and used/unused variables", async () => {
		const unused = (await run("lexicon", { vars: true, scope: "system", unused: true })).json() as {
			helpers: unknown[];
			scopes: { name: string; keys: { path: string; usage: string }[] }[];
		};
		expect(unused.helpers).toEqual([]);
		expect(unused.scopes.map(scope => scope.name)).toEqual(["system"]);
		expect(unused.scopes[0].keys).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "workspaceTree", usage: "unused" })]),
		);
		const used = (await run("lexicon", { helpers: true, used: true })).json() as {
			helpers: { name: string; usage: string }[];
			scopes: unknown[];
		};
		expect(used.scopes).toEqual([]);
		expect(used.helpers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "join", usage: "used" })]));
		expect(used.helpers.every(helper => helper.usage === "used")).toBe(true);
		expect((await run("lexicon", { used: true, unused: true })).code).toBe(2);
		expect((await run("lexicon", { scope: "not-a-scope" })).code).toBe(2);
	});
});

describe("prompts check", () => {
	it("checks bundled ids and dry-renders against supplied JSON fixtures", async () => {
		expect((await run("check", {}, [assets[2].id])).code).toBe(0);
		let observed: unknown;
		const result = await run(
			"check",
			{ fixture: '{"asyncEnabled":false}', strict: true, runtime: true },
			[assets[2].id],
			{
				validate: (asset, text, options) => {
					observed = { asset: asset.id, text, ...options };
					return [];
				},
			},
		);
		expect(result.code).toBe(0);
		expect(observed).toMatchObject({
			asset: assets[2].id,
			text: assets[2].bundled,
			fixture: { asyncEnabled: false },
			strict: true,
			runtime: true,
		});
	});

	it("loads fixture JSON files relative to the command cwd and reports bad files as usage errors", async () => {
		await Bun.write(path.join(cwd, "fixtures", "bash.json"), '{"asyncEnabled":false}');
		let observed: unknown;
		const result = await run("check", { fixture: "fixtures/bash.json" }, [assets[2].id], {
			validate: (_asset, _text, options) => {
				observed = options?.fixture;
				return [];
			},
		});
		expect(result.code).toBe(0);
		expect(observed).toEqual({ asyncEnabled: false });
		expect((await run("check", { fixture: "fixtures/missing.json" }, [assets[2].id])).code).toBe(2);
		await Bun.write(path.join(cwd, "fixtures", "bad.json"), "{broken json");
		expect((await run("check", { fixture: "fixtures/bad.json" }, [assets[2].id])).code).toBe(2);
		await Bun.write(path.join(cwd, "fixtures", "array.json"), "[]");
		expect((await run("check", { fixture: "fixtures/array.json" }, [assets[2].id])).code).toBe(2);
	});

	it("returns validation errors with precise locations, candidates and plain output", async () => {
		const file = path.join(userRoot(), assets[0].relPath);
		await Bun.write(file, "First line.\n{{cwdd}}\n");
		const result = await run("check");
		expect(result.code).toBe(1);
		const diagnostics = (result.json() as CheckResult).diagnostics;
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "unknown-variable",
					file,
					line: 2,
					column: 3,
					scope: "system",
					candidates: expect.arrayContaining([expect.stringContaining("cwd")]),
				}),
			]),
		);
		const plain = await run("check", { json: false });
		expect(plain.stdout).toContain(`${file}:2:3: error[unknown-variable]`);
		expect(plain.stdout).toContain("nearest candidates:");
	});

	it("rejects unknown helpers and accepts exposed but unused variables", async () => {
		const file = path.join(userRoot(), assets[0].relPath);
		await Bun.write(file, "{{madeUp cwd}}");
		expect((await run("check")).code).toBe(1);
		await Bun.write(file, "{{workspaceTree}}");
		expect((await run("check")).code).toBe(0);
	});

	it("validates agent bodies without treating frontmatter as template syntax", async () => {
		const file = path.join(agentDir, "agents", "scout.md");
		await Bun.write(file, '---\nname: "{{unknown helper}}"\n---\nRead files carefully.\n');
		expect((await run("check", { agents: true })).code).toBe(0);
		await Bun.write(file, '---\nname: scout\n---\n{{madeUp "argument"}}\n');
		const result = await run("check", {}, [file]);
		expect(result.code).toBe(1);
		expect((result.json() as CheckResult).diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "unknown-helper", line: 4, scope: "agent-body" })]),
		);
	});

	it("accepts explicit files, globs, scope override and installed together", async () => {
		const file = path.join(cwd, "draft.md");
		await Bun.write(file, "Hello {{firstName}}.");
		const result = await run("check", { installed: true, scope: "live" }, ["*.md"]);
		expect(result.code).toBe(0);
		expect((result.json() as CheckResult).checked).toContain(file);
	});

	it("reports usage errors for missing files, bad scopes, fixtures and plain content slots", async () => {
		for (const [flags, targets] of [
			[{}, ["missing.md"]],
			[{ scope: "no-scope" }, []],
			[{ fixture: "not json" }, []],
			[{ fixture: "[]" }, []],
		] as [PromptsFlags, string[]][])
			expect((await run("check", flags, targets)).code).toBe(2);
		const file = path.join(cwd, "SYSTEM.md");
		await Bun.write(file, "{{plain slot}}");
		expect((await run("check", { scope: "system" }, [file])).code).toBe(2);
		expect(await Bun.file(file).text()).toBe("{{plain slot}}");
	});

	it("maps warnings and internal validator failures to distinct exit codes", async () => {
		const warning: PromptDiagnostic = {
			code: "fixture-warning",
			severity: "warning",
			file: assets[2].id,
			line: 1,
			column: 1,
			endLine: 1,
			endColumn: 2,
			expression: "",
			scope: "tool:bash",
			message: "Warning",
			candidates: [],
		};
		expect((await run("check", {}, [assets[2].id], { validate: () => [warning] })).code).toBe(0);
		expect(
			(await run("check", { "strict-warnings": true }, [assets[2].id], { validate: () => [warning] })).code,
		).toBe(1);
		const internal = await run("check", {}, [assets[2].id], {
			validate: () => {
				throw new Error("validator failure");
			},
		});
		expect(internal.code).toBe(3);
		expect(internal.json()).toMatchObject({ error: "internal-validator-error", file: assets[2].id });
	});

	it("reports wrong scopes and syntax failures through structured CLI diagnostics", async () => {
		const file = path.join(userRoot(), assets[0].relPath);
		await Bun.write(file, "{{username}}");
		const wrongScope = await run("check");
		expect(wrongScope.code).toBe(1);
		expect((wrongScope.json() as CheckResult).diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "wrong-scope", hint: expect.stringContaining("live") }),
			]),
		);
		await Bun.write(file, "First line.\n{{#if tools}}");
		const syntax = await run("check");
		expect(syntax.code).toBe(1);
		expect((syntax.json() as CheckResult).diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "compile-error", line: 2 })]),
		);
	});

	it("makes missing required runtime values errors only with --runtime", async () => {
		const runtimeAsset: PromptAsset = {
			...assets[0],
			bundled: "{{sessionSecret}}",
			keys: [{ path: "sessionSecret", type: "string", required: true, resolution: "runtime-only" }],
			fixture: {},
		};
		const relaxed = await run("check", {}, [runtimeAsset.id], { assets: [runtimeAsset] });
		expect(relaxed.code).toBe(0);
		expect((relaxed.json() as CheckResult).diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "missing-required-runtime", severity: "note" })]),
		);
		expect((await run("check", { runtime: true }, [runtimeAsset.id], { assets: [runtimeAsset] })).code).toBe(1);
		expect(
			(
				await run("check", { runtime: true, fixture: '{"sessionSecret":"fixture"}' }, [runtimeAsset.id], {
					assets: [runtimeAsset],
				})
			).code,
		).toBe(0);
	});
});

it("registers prompts and exposes actions and all flags to shell completion", async () => {
	expect(commands.find(command => command.name === "prompts")).toBeDefined();
	const spec = await buildSpec(
		{ bin: "omp", version: "test", commands: new Map([["prompts", Prompts]]) },
		"launch",
		new Map(),
	);
	expect(spec.commands[0].args[0].value).toMatchObject({ values: [...PROMPT_ACTIONS] });
	expect(spec.commands[0].flags.map(flag => flag.name)).toEqual(
		expect.arrayContaining([
			"force",
			"only",
			"include",
			"helpers",
			"vars",
			"scope",
			"used",
			"unused",
			"all",
			"strict",
			"strict-warnings",
			"runtime",
			"fixture",
			"installed",
			"agents",
			"user",
			"project",
			"dir",
			"json",
		]),
	);
});

it("parses unpack aliases and repeated check targets through command metadata", async () => {
	const config = { bin: "omp", version: "test", commands: new Map([["prompts", Prompts]]) };
	const unpack = await new Prompts(["unpack", "-f", "--dir", "exports", "--only", "tools/*"], config).parse(Prompts);
	expect(unpack).toMatchObject({
		args: { action: "unpack" },
		flags: { force: true, dir: "exports", only: "tools/*" },
	});
	const check = await new Prompts(["check", "tools/bash.md", "live/live-instructions.md", "--runtime"], config).parse(
		Prompts,
	);
	expect(check.args.targets).toEqual(["tools/bash.md", "live/live-instructions.md"]);
	expect(check.flags.runtime).toBe(true);
	await expect(new Prompts(["unpack", "--not-a-flag"], config).parse(Prompts)).rejects.toThrow();
});

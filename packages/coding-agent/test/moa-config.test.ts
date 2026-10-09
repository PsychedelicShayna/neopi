import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	discoverMixtures,
	loadMixturesConfigFile,
	parseMixturesDoc,
	saveMixturesConfigFile,
} from "@oh-my-pi/pi-coding-agent/moa/config";
import {
	discoverRegistrableMixtures,
	MixtureWorkspace,
	readMixtureDefinitionFile,
	saveMixtureDefinition,
} from "@oh-my-pi/pi-coding-agent/moa/registration";
import { serializeMixturesConfig } from "@oh-my-pi/pi-coding-agent/moa/toml";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createMoaFixture, DRAFT_THEN_EDIT_TOML } from "./helpers/moa-setup";

const DRAFT_THEN_EDIT = `
[[mixtures]]
name = "draft-then-edit"
entry = "writer"

[[mixtures.members]]
id = "writer"
model = "openai-codex/gpt-6-astra:medium"
system_prompt = "Draft a complete answer."
tools = false

[[mixtures.members]]
id = "editor"
model = "xai/grok-4.7:low"
system_prompt = "Tighten the draft. Return only the final text."
tools = false

[[mixtures.edges]]
from = "writer"
to = "editor"
x = { output = true }
`;

const COURTROOM = `
[envelopes]
disagree = """
The topic is: {{topic}}
There are {{mixture.member_count}} participants. The previous turn was {{from.id}}.
{{> moa-parts}}
"""

[roles]
prosecution = "You argue the strongest case that the proposal is wrong. Be concrete."
"odd name" = 'a "quoted" \\ role'

[[mixtures]]
name = "courtroom"
description = "Adversarial review with a judge"
entry = "prosecution"
serve = false

[mixtures.limits]
max_hops = 12
budget_usd = 4.5
wall_clock_minutes = 60
on_limit = "judge"
limit_target = "judge"

[mixtures.steering]
target = "auto"

[mixtures.envelopes]
local = "Local {{x.output}}"

[[mixtures.members]]
id = "prosecution"
description = "opens the case"
model = "xai/grok-4.7:high"
role = "prosecution"
tools = ["read", "grep"]
show = "always"
inherit = true
max_tokens = 4000

[[mixtures.members]]
id = "defense"
model = "openai-codex/gpt-6-astra:xhigh"
role = "defense"
tools = false
[mixtures.members.route]
instructions = "Has the argument been exhausted?"
state = ["output", "tool_trace"]
min_confidence = 0.6
fallback = "verdict"
[mixtures.members.terminate]
instructions = "Has the defense conceded?"
criteria = { true = "conceded", false = "still arguing" }
threshold = 0.8

[[mixtures.members]]
id = "judge"
kind = "verdict"
state = ["output", "transcript"]
render = "verdict"
[mixtures.members.question]
type = "choice"
instructions = "Who won?"
criteria = { prosecution = "made the stronger case", defense = "" }

[[mixtures.members]]
id = "scorer"
kind = "verdict"
[mixtures.members.question]
type = "score"
instructions = "How strong?"
criteria = ["weak", "strong"]

[[mixtures.members]]
id = "gate"
kind = "verdict"
[mixtures.members.question]
type = "noul"
instructions = "Settled?"

[[mixtures.edges]]
id = "open"
from = "prosecution"
to = "defense"
x = { output = true }
envelope = "disagree"

[[mixtures.edges]]
id = "rebut"
from = "defense"
to = "prosecution"
x = { output = true, transcript = { optimize = "compact", budget_tokens = 9000 } }
envelope = "defend"
when = "there is a live point"
max_traversals = 3
show = "never"

[[mixtures.edges]]
id = "review"
from = "prosecution"
to = ["defense", "judge"]
x = { output = true, input = true, reasoning = true, tool_trace = true, transcript = true }
slices = ["first", "second"]
join = "gate"
join_x = { output = true }
join_envelope = "aggregate"
quorum = 1
grace_ms = 15000
anonymize = true

[[mixtures.edges]]
from = "defense"
to = ["judge", "scorer"]
x = { output = true }
slices = "auto"
join = "gate"
`;

function parse(text: string) {
	return parseMixturesDoc(Bun.TOML.parse(text), "MIXTURES.toml");
}

describe("MIXTURES.toml parsing", () => {
	it("turns a malformed member into a warning and keeps the valid mixtures", () => {
		const doc = parse(`
[[mixtures]]
name = "broken-member"
entry = "a"
[[mixtures.members]]
id = "a"
model = "x/y"
[[mixtures.members]]
id = "b"
[[mixtures.edges]]
from = "a"
to = "b"
x = { output = true }

[[mixtures]]
entry = "nameless"

${DRAFT_THEN_EDIT}
`);
		expect(doc.mixtures.map(mixture => mixture.name)).toEqual(["broken-member", "draft-then-edit"]);
		expect(doc.mixtures[0]!.members.map(member => member.id)).toEqual(["a"]);
		expect(doc.warnings?.some(warning => warning.includes("members[1]") && warning.includes("needs a model"))).toBe(
			true,
		);
		expect(doc.warnings?.some(warning => warning.includes("mixtures[1]") && warning.includes("needs a name"))).toBe(
			true,
		);
		expect(doc.mixtures[1]!.members[0]).toEqual({
			id: "writer",
			model: "openai-codex/gpt-6-astra:medium",
			systemPrompt: "Draft a complete answer.",
			tools: false,
		});
	});

	it("keeps an empty and an unknown transit part for validation to report", () => {
		const doc = parse(`
[[mixtures]]
name = "m"
entry = "a"
[[mixtures.members]]
id = "a"
model = "x/y"
[[mixtures.edges]]
from = "a"
to = "a"
x = {}
[[mixtures.edges]]
from = "a"
to = "a"
x = { vibes = true }
`);
		expect(doc.mixtures[0]!.edges[0]!.x).toEqual({});
		expect(Object.keys(doc.mixtures[0]!.edges[1]!.x)).toEqual(["vibes"]);
	});

	it("reports an unparseable file as a warning instead of throwing", () => {
		expect(() => Bun.TOML.parse("[[mixtures]\nname =")).toThrow();
		const doc = parseMixturesDoc("not a table", "MIXTURES.toml");
		expect(doc.mixtures).toEqual([]);
		expect(doc.warnings).toHaveLength(1);
	});
});

describe("MIXTURES.toml serialization", () => {
	it.each([
		["the M1 linear fixture", DRAFT_THEN_EDIT],
		["presets, limits, steering, conditions, verdicts, and fan-out", COURTROOM],
	])("round-trips %s through Bun.TOML.parse", (_label, text) => {
		const first = parse(text);
		expect(first.warnings).toBeUndefined();
		const emitted = serializeMixturesConfig(first);
		const second = parse(emitted);
		expect(second.warnings).toBeUndefined();
		expect(second).toEqual(first);
	});

	it("round-trips strings that need escaping or cannot be multi-line literals", () => {
		const awkward = [
			"line one\nline two\n",
			"ends with a quote'\nsecond line",
			"has ''' inside\nand more",
			'quotes " and \\ backslashes',
			"windows\r\nnewline",
			"tab\tseparated\nsecond line",
		];
		const doc = {
			mixtures: [
				{
					name: "strings",
					entry: "a",
					members: awkward.map((systemPrompt, index) => ({
						id: `m${index}`,
						model: "x/y",
						systemPrompt,
						tools: false,
					})),
					edges: [],
				},
			],
		};
		const second = parse(serializeMixturesConfig(doc));
		expect(second).toEqual(doc);
	});

	it("saves to disk and removes the file for an empty doc", async () => {
		using dir = TempDir.createSync("@moa-config-save-");
		const file = dir.join("MIXTURES.toml");
		const doc = parse(DRAFT_THEN_EDIT);
		await saveMixturesConfigFile(file, doc);
		expect(await loadMixturesConfigFile(file)).toEqual(doc);
		await saveMixturesConfigFile(file, { mixtures: [] });
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await loadMixturesConfigFile(file)).toEqual({ mixtures: [] });
	});

	it("rejects oversized UTF-8 output without replacing the saved configuration", async () => {
		using dir = TempDir.createSync("@moa-config-save-bound-");
		const file = dir.join("MIXTURES.toml");
		const original = parse(DRAFT_THEN_EDIT);
		await saveMixturesConfigFile(file, original);
		const saved = await Bun.file(file).text();
		const oversized = {
			...original,
			roles: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`role${index}`, "é".repeat(22_000)])),
		};

		await expect(saveMixturesConfigFile(file, oversized)).rejects.toThrow("file.too_large");
		expect(await Bun.file(file).text()).toBe(saved);
		expect(await loadMixturesConfigFile(file)).toEqual(original);
	});

	it("rejects invalid drafts without replacing the file and registers valid edits only on apply", async () => {
		using dir = TempDir.createSync("@moa-config-edit-");
		const fixture = await createMoaFixture(dir);
		const file = path.join(fixture.agentDir, "MIXTURES.toml");
		const ctx = {
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			registry: fixture.registry,
			settings: Settings.isolated(),
		};
		const workspace = await MixtureWorkspace.retain("editor", ctx);
		try {
			const original = await Bun.file(file).text();
			const { doc, hash: baseHash } = await readMixtureDefinitionFile(file);
			const first = doc.mixtures[0]!;
			await expect(
				saveMixtureDefinition({
					...ctx,
					sourcePath: file,
					doc: { ...doc, mixtures: [{ ...first, entry: "missing" }] },
					baseHash,
				}),
			).rejects.toThrow("entry");
			expect(await Bun.file(file).text()).toBe(original);
			expect(fixture.registry.find("mixture", "draft-then-edit")).toBeDefined();

			await saveMixtureDefinition({
				...ctx,
				sourcePath: file,
				doc: { ...doc, mixtures: [{ ...first, name: "new-mixture" }] },
				baseHash,
			});
			expect(fixture.registry.find("mixture", "new-mixture")).toBeUndefined();
			workspace.scope.setRoster(await discoverRegistrableMixtures(ctx));
			expect(fixture.registry.getAvailable().map(model => `${model.provider}/${model.id}`)).toContain(
				"mixture/new-mixture",
			);
			expect(fixture.registry.find("mixture", "draft-then-edit")).toBeUndefined();
		} finally {
			workspace.release();
			fixture.authStorage.close();
		}
	});
	it("rejects stale or symlinked sources without altering the external file", async () => {
		using dir = TempDir.createSync("@moa-config-cas-");
		const fixture = await createMoaFixture(dir);
		const file = path.join(fixture.agentDir, "MIXTURES.toml");
		const ctx = {
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			registry: fixture.registry,
			settings: Settings.isolated(),
		};
		try {
			const { doc, hash: baseHash } = await readMixtureDefinitionFile(file);
			const externalEdit = `${await Bun.file(file).text()}\n# external edit\n`;
			await Bun.write(file, externalEdit);
			await expect(saveMixtureDefinition({ ...ctx, sourcePath: file, doc, baseHash })).rejects.toThrow(
				"changed since it was loaded",
			);
			expect(await Bun.file(file).text()).toBe(externalEdit);

			const target = dir.join("outside.toml");
			await fs.rename(file, target);
			await fs.symlink(target, file);
			await expect(saveMixtureDefinition({ ...ctx, sourcePath: file, doc, baseHash })).rejects.toThrow();
			expect(await Bun.file(target).text()).toBe(externalEdit);
		} finally {
			fixture.authStorage.close();
		}
	});
});

describe("discoverMixtures", () => {
	it("lets project files shadow user files by name, leaf over ancestor .omp", async () => {
		using dir = TempDir.createSync("@moa-config-discover-");
		const agentDir = dir.join("agent");
		const project = dir.join("project");
		const cwd = path.join(project, "pkg");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(path.join(project, ".omp"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		const mixture = (name: string, description: string) => `
[[mixtures]]
name = "${name}"
description = "${description}"
entry = "a"
[[mixtures.members]]
id = "a"
model = "x/y"
`;
		await Bun.write(
			path.join(agentDir, "MIXTURES.toml"),
			`[roles]\nshared = "user role"\n${mixture("shared", "user")}${mixture("user-only", "user")}`,
		);
		await Bun.write(
			path.join(project, ".omp", "MIXTURES.toml"),
			`${mixture("shared", "ancestor")}${mixture("ancestor-only", "ancestor")}`,
		);
		await Bun.write(path.join(cwd, "MIXTURES.toml"), mixture("shared", "leaf"));

		const discovered = await discoverMixtures(cwd, agentDir);
		const byName = new Map(discovered.mixtures.map(entry => [entry.definition.name, entry]));
		expect(byName.get("shared")?.definition.description).toBe("leaf");
		expect(byName.get("shared")?.path).toBe(path.join(cwd, "MIXTURES.toml"));
		expect(byName.get("ancestor-only")?.definition.description).toBe("ancestor");
		expect(byName.get("user-only")?.roles).toEqual({ shared: "user role" });
		expect(discovered.warnings).toEqual([]);
	});

	/** The mixtures registration accepts, and the codes it refused them with. */
	async function register(dir: TempDir, userToml: string, projectToml?: string, settings = Settings.isolated()) {
		const fixture = await createMoaFixture(dir, userToml);
		try {
			if (projectToml !== undefined) await Bun.write(path.join(fixture.cwd, "MIXTURES.toml"), projectToml);
			const warn = vi.spyOn(logger, "warn");
			const registrable = await discoverRegistrableMixtures({
				cwd: fixture.cwd,
				agentDir: fixture.agentDir,
				registry: fixture.registry,
				settings,
			});
			const refused = warn.mock.calls.flatMap(([message, context]) =>
				message === "Mixture refused at registration" ? [[context?.mixture, context?.code]] : [],
			);
			warn.mockRestore();
			return { registered: registrable.map(mixture => mixture.definition), refused };
		} finally {
			fixture.authStorage.close();
		}
	}

	it("refuses every mixture in a document with an unused oversized preset, not a sibling document", async () => {
		using dir = TempDir.createSync("@moa-config-preset-bound-");
		const bad = `[roles]\nunused = "${"x".repeat(65_537)}"\n${
			DRAFT_THEN_EDIT_TOML
		}${DRAFT_THEN_EDIT_TOML.replace('name = "draft-then-edit"', 'name = "second"')}`;
		const good = DRAFT_THEN_EDIT_TOML.replace('name = "draft-then-edit"', 'name = "independent"');
		const { registered, refused } = await register(dir, bad, good);
		expect(registered.map(definition => definition.name)).toEqual(["independent"]);
		expect(refused).toEqual([
			["draft-then-edit", "limits.text_size"],
			["second", "limits.text_size"],
		]);
	});

	it("refuses a name declared twice in one file, logging name.duplicate for each declaration", async () => {
		using dir = TempDir.createSync("@moa-config-duplicate-");
		const solo = DRAFT_THEN_EDIT_TOML.replace('name = "draft-then-edit"', 'name = "solo"');
		const { registered, refused } = await register(dir, `${DRAFT_THEN_EDIT_TOML}${DRAFT_THEN_EDIT_TOML}${solo}`);
		expect(registered.map(definition => definition.name)).toEqual(["solo"]);
		expect(refused).toEqual([
			["draft-then-edit", "name.duplicate"],
			["draft-then-edit", "name.duplicate"],
		]);
	});

	it("lets a project file shadow a user file's single declaration with no error", async () => {
		using dir = TempDir.createSync("@moa-config-shadow-");
		const project = DRAFT_THEN_EDIT_TOML.replace('entry = "writer"', 'description = "project"\nentry = "writer"');
		const { registered, refused } = await register(dir, DRAFT_THEN_EDIT_TOML, project);
		expect(registered.map(definition => [definition.name, definition.description])).toEqual([
			["draft-then-edit", "project"],
		]);
		expect(refused).toEqual([]);
	});

	it("refuses a mixture whose member the session's enabledModels excludes, and keeps an allowed sibling", async () => {
		using dir = TempDir.createSync("@moa-config-allowlist-");
		const writerOnly = `
[[mixtures]]
name = "writer-only"
entry = "writer"
[[mixtures.members]]
id = "writer"
model = "fake/writer"
system_prompt = "Answer."
tools = false
`;
		const settings = Settings.isolated({ enabledModels: ["fake/writer", "fake/other"] });
		const { registered, refused } = await register(dir, `${DRAFT_THEN_EDIT_TOML}${writerOnly}`, undefined, settings);
		expect(registered.map(definition => definition.name)).toEqual(["writer-only"]);
		expect(refused).toEqual([["draft-then-edit", "member.model.excluded"]]);
	});

	/**
	 * Discovery and the configurator's loader on a workspace whose user MIXTURES.toml is
	 * prepared by `setup`, beside a readable project file that must still load.
	 */
	async function withUserFile(prefix: string, setup: (userFile: string) => Promise<void>) {
		using dir = TempDir.createSync(prefix);
		const agentDir = dir.join("agent");
		const cwd = dir.join("project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		const userFile = path.join(agentDir, "MIXTURES.toml");
		await setup(userFile);
		const project = DRAFT_THEN_EDIT_TOML.replace('name = "draft-then-edit"', 'name = "project-only"');
		await Bun.write(path.join(cwd, "MIXTURES.toml"), project);
		const discovered = await discoverMixtures(cwd, agentDir);
		const edited = await loadMixturesConfigFile(userFile);
		return { userFile, discovered, edited };
	}

	it("skips a MIXTURES.toml over the file cap by its size, without reading it, and still loads a sibling file", async () => {
		// A sparse 8 GiB file: reading it whole would take seconds and gigabytes.
		const { userFile, discovered, edited } = await withUserFile("@moa-config-too-large-", async userFile => {
			await Bun.write(userFile, DRAFT_THEN_EDIT_TOML);
			await fs.truncate(userFile, 8 * 1024 ** 3);
		});
		expect(discovered.mixtures.map(entry => entry.definition.name)).toEqual(["project-only"]);
		expect(discovered.warnings).toEqual([expect.stringContaining(`${userFile}: file.too_large`)]);
		expect(edited).toEqual({ mixtures: [], warnings: [expect.stringContaining("file.too_large")] });
	});

	it.each<[string, (userFile: string) => Promise<void>]>([
		["a symlink to /dev/zero", userFile => fs.symlink("/dev/zero", userFile)],
		[
			"a FIFO no one writes to",
			async userFile => {
				expect(Bun.spawnSync(["mkfifo", userFile]).exitCode).toBe(0);
			},
		],
	])(
		"refuses %s as file.not_regular without reading it, and still loads a sibling file",
		async (_label, setup) => {
			const { userFile, discovered, edited } = await withUserFile("@moa-config-not-regular-", setup);
			expect(discovered.mixtures.map(entry => entry.definition.name)).toEqual(["project-only"]);
			expect(discovered.warnings).toEqual([expect.stringContaining(`${userFile}: file.not_regular`)]);
			expect(edited).toEqual({ mixtures: [], warnings: [expect.stringContaining("file.not_regular")] });
		},
		5_000,
	);
});

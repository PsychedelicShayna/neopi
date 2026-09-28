import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import {
	advisorConfigFilePath,
	discoverAdvisorConfigs,
	getOrCreateAdvisorProviderSessionId,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
	serializeWatchdogConfig,
	slugifyAdvisorName,
} from "../../src/advisor/config";
import type { WatchdogConfigDoc } from "@oh-my-pi/pi-tui/overlays/advisor-config";

describe("discoverAdvisorConfigs", () => {
	let tmp: string;
	let agentDir: string;

	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-config-"));
		await fsp.mkdir(path.join(tmp, ".git"));
		// Empty agent dir so the user-level search path can't pick up a real ~/.omp/WATCHDOG.yml.
		agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-agentdir-"));
	});

	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
		await fsp.rm(agentDir, { recursive: true, force: true });
	});

	it("parses advisors, the model thinking suffix, tool filtering, and shared instructions", async () => {
		const yaml = [
			"instructions: Shared baseline for all advisors.",
			"advisors:",
			"  - name: Architecture",
			"    model: x-ai/grok-code-fast:high",
			"    instructions: Watch module boundaries.",
			"  - name: Security Reviewer",
			"    tools: [read, definitely-not-a-tool]",
		].join("\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

		const { advisors, sharedInstructions } = await discoverAdvisorConfigs(tmp, agentDir);
		expect(advisors).toHaveLength(2);
		const [arch, sec] = advisors;
		expect(arch.name).toBe("Architecture");
		// The model selector (incl. the `:high` thinking suffix) is stored verbatim;
		// resolution happens later in the session, not here.
		expect(arch.model).toBe("x-ai/grok-code-fast:high");
		expect(arch.instructions).toBe("Watch module boundaries.");
		expect(sec.name).toBe("Security Reviewer");
		expect(sec.model).toBeUndefined();
		// The unknown/non-read-only tool is dropped; only `read` survives.
		expect(sec.tools).toEqual(["read"]);
		expect(sharedInstructions).toBe("Shared baseline for all advisors.");
	});

	it("distinguishes omitted tools, explicit no-tools, and invalid-only lists", async () => {
		const yaml = [
			"advisors:",
			"  - name: No Tools",
			"    tools: []",
			"  - name: Default Tools",
			"  - name: Invalid Only",
			"    tools: [reed]",
		].join("\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

		const { advisors } = await discoverAdvisorConfigs(tmp, agentDir);
		const noTools = advisors.find(a => a.name === "No Tools");
		const defaultTools = advisors.find(a => a.name === "Default Tools");
		const invalidOnly = advisors.find(a => a.name === "Invalid Only");

		expect(noTools?.tools).toEqual([]);
		expect(defaultTools?.tools).toBeUndefined();
		expect(invalidOnly?.tools).toBeUndefined();
	});

	it("ignores a malformed YAML file without throwing", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: [unclosed bracket");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.sharedInstructions).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("failed to parse YAML");
		// Editor reports the same problem class instead of blanking silently.
		const doc = await loadWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"));
		expect(doc.advisors).toEqual([]);
		expect(doc.warnings).toHaveLength(1);
		expect(doc.warnings?.[0]).toContain("failed to parse YAML");
		doc.advisors.push({ name: "Repaired", enabled: false });
		await saveWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"), doc);
		expect(await loadWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"))).toEqual({
			advisors: [{ name: "Repaired", enabled: false }],
		});
	});

	it("skips a file whose shape fails the schema (advisors must be a list)", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: not-an-array");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("advisors must be a list");
		const doc = await loadWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"));
		expect(doc.advisors).toEqual([]);
		expect(doc.warnings).toHaveLength(1);
		expect(doc.warnings?.[0]).toContain("advisors must be a list");
	});

	it("reports a non-mapping document in the editor just like discovery does", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "- just\n- a\n- list\n");

		const discovered = await discoverAdvisorConfigs(tmp, tmp);
		expect(discovered.advisors).toEqual([]);
		expect(discovered.warnings).toHaveLength(1);
		expect(discovered.warnings[0]).toContain("expected a YAML mapping");

		const doc = await loadWatchdogConfigFile(file);
		expect(doc.advisors).toEqual([]);
		expect(doc.warnings).toHaveLength(1);
		expect(doc.warnings?.[0]).toContain("expected a YAML mapping");
	});

	it("drops only the malformed entry and reports one warning per problem", async () => {
		await Bun.write(
			path.join(tmp, "WATCHDOG.yml"),
			[
				"advisors:",
				"  - name: Good",
				"  - name: Bad",
				"    enabled: not-a-boolean",
				"  - name: Also Bad",
				"    maxNotesPerUpdate: not-a-number",
			].join("\n"),
		);
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors.map(a => a.name)).toEqual(["Good"]);
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings[0]).toContain('"Bad"');
		expect(result.warnings[1]).toContain('"Also Bad"');
	});

	it("editor load drops only the malformed entry, like discovery", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Good\n  - name: Bad\n    enabled: bogus\n");
		const doc = await loadWatchdogConfigFile(file);
		expect(doc.advisors.map(a => a.name)).toEqual(["Good"]);
		expect(doc.warnings).toHaveLength(1);
		expect(doc.warnings?.[0]).toContain('"Bad"');
	});

	it("returns an empty roster when no config file exists", async () => {
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.sharedInstructions).toBeUndefined();
	});
});

describe("slugifyAdvisorName", () => {
	it("lowercases and collapses non-alphanumeric runs to single hyphens", () => {
		expect(slugifyAdvisorName("Security Reviewer")).toBe("security-reviewer");
		expect(slugifyAdvisorName("  Arch/Boundaries!  ")).toBe("arch-boundaries");
	});

	it("falls back to 'advisor' when nothing alphanumeric survives", () => {
		expect(slugifyAdvisorName("!!!")).toBe("advisor");
	});
});

describe("getOrCreateAdvisorProviderSessionId", () => {
	const primarySessionA = "018f8f5d-75b0-7cc6-8a6f-2f1c0b8e4c9d";
	const primarySessionB = "018f8f5d-75b1-7cc6-8a6f-2f1c0b8e4c9d";

	it("returns the generated UUIDv7 instead of a local advisor label", () => {
		const generated = "0193c8f2-7b1a-7c4d-9e2f-123456789abc";

		const providerSessionId = getOrCreateAdvisorProviderSessionId(
			new Map<string, string>(),
			primarySessionA,
			"security-advisor",
			() => generated,
		);

		expect(providerSessionId).toBe(generated);
		expect(providerSessionId).not.toContain("-advisor");
	});

	it("reuses the same generated UUIDv7 for repeated calls with the same primary session and slug", () => {
		const generatedIds = ["0193c8f2-7b1a-7c4d-9e2f-123456789abc", "0193c8f2-7b1b-7c4d-9e2f-123456789abc"];
		let nextGeneratedIdIndex = 0;
		const ids = new Map<string, string>();

		const first = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "architecture", () => {
			const generated = generatedIds[nextGeneratedIdIndex];
			if (!generated) throw new Error("unexpected generator call");
			nextGeneratedIdIndex += 1;
			return generated;
		});
		const second = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "architecture", () => {
			const generated = generatedIds[nextGeneratedIdIndex];
			if (!generated) throw new Error("unexpected generator call");
			nextGeneratedIdIndex += 1;
			return generated;
		});

		expect(first).toBe(generatedIds[0]);
		expect(second).toBe(generatedIds[0]);
		expect(nextGeneratedIdIndex).toBe(1);
	});

	it("creates distinct UUIDv7 values for different advisor slugs or primary sessions", () => {
		const generatedIds = [
			"0193c8f2-7b1a-7c4d-9e2f-123456789abc",
			"0193c8f2-7b1b-7c4d-9e2f-123456789abc",
			"0193c8f2-7b1c-7c4d-9e2f-123456789abc",
		];
		let nextGeneratedIdIndex = 0;
		const ids = new Map<string, string>();
		const nextGeneratedId = () => {
			const generated = generatedIds[nextGeneratedIdIndex];
			if (!generated) throw new Error("unexpected generator call");
			nextGeneratedIdIndex += 1;
			return generated;
		};

		const architecture = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "architecture", nextGeneratedId);
		const security = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "security", nextGeneratedId);
		const architectureForOtherSession = getOrCreateAdvisorProviderSessionId(
			ids,
			primarySessionB,
			"architecture",
			nextGeneratedId,
		);

		expect(architecture).toBe(generatedIds[0]);
		expect(security).toBe(generatedIds[1]);
		expect(architectureForOtherSession).toBe(generatedIds[2]);
		expect(new Set([architecture, security, architectureForOtherSession]).size).toBe(3);
	});

	it("rejects generated values that are not UUIDv7", () => {
		expect(() =>
			getOrCreateAdvisorProviderSessionId(
				new Map<string, string>(),
				primarySessionA,
				"architecture",
				() => "550e8400-e29b-41d4-a716-446655440000",
			),
		).toThrow("non-UUIDv7");
	});
});

describe("WATCHDOG.yml file round-trip", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-file-"));
		await fsp.mkdir(path.join(tmp, ".git"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	const doc: WatchdogConfigDoc = {
		instructions: 'Shared baseline.\n\nSecond line with: a colon and "quotes".',
		advisors: [
			{
				name: "Architecture",
				model: "x-ai/grok-code-fast:high",
				instructions: "Watch module boundaries.\nReport coupling.",
			},
			{ name: "Security", tools: ["read", "grep"] },
		],
	};

	it("saves and reloads a doc byte-equivalently (incl. multiline and special chars)", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const loaded = await loadWatchdogConfigFile(file);
		expect(loaded).toEqual(doc);
	});

	it("serializes block-style YAML that the discovery path also parses", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const text = await Bun.file(file).text();
		// Block style (not the flow `{...}` form), so it stays hand-editable.
		expect(text).toContain("advisors:");
		expect(text).not.toMatch(/^\{/);
		expect(text).toContain('instructions: |2-\n  Shared baseline.\n  \n  Second line with: a colon and "quotes".');
		expect(text).toContain("    instructions: |2-\n      Watch module boundaries.\n      Report coupling.");
		expect(text).not.toContain("\\n");
		const { advisors, sharedInstructions } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors.map(a => a.name)).toEqual(["Architecture", "Security"]);
		expect(sharedInstructions).toContain("Shared baseline.");
	});

	it("preserves significant leading whitespace and trailing newlines in block scalars", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		const whitespaceDoc: WatchdogConfigDoc = {
			instructions: "  indented first line\nplain second line\n\n",
			advisors: [{ name: "Whitespace", instructions: "\n  indented after blank\nplain" }],
		};

		await saveWatchdogConfigFile(file, whitespaceDoc);
		expect(await loadWatchdogConfigFile(file)).toEqual(whitespaceDoc);
	});

	it("round-trips an explicit empty tools list without collapsing it into the default", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		const explicitNoToolsDoc: WatchdogConfigDoc = {
			advisors: [{ name: "No Tools", tools: [] }, { name: "Default Tools" }],
		};

		await saveWatchdogConfigFile(file, explicitNoToolsDoc);
		const serializedDoc = await loadWatchdogConfigFile(file);
		expect(serializedDoc).toEqual(explicitNoToolsDoc);

		const { advisors } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors.find(a => a.name === "No Tools")?.tools).toEqual([]);
		expect(advisors.find(a => a.name === "Default Tools")?.tools).toBeUndefined();
	});

	it("preserves custom and empty base prompts through save, discovery, and reset", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		const custom = '  Literal base: "quoted"\n\nDo not expand @missing.md\n\n';
		const promptDoc: WatchdogConfigDoc = {
			advisors: [
				{ name: "Custom", systemPrompt: custom, instructions: "Append specialization" },
				{ name: "Empty", systemPrompt: "" },
				{ name: "Default" },
			],
		};
		await saveWatchdogConfigFile(file, promptDoc);
		const loaded = await loadWatchdogConfigFile(file);
		expect(loaded).toEqual(promptDoc);
		expect((await discoverAdvisorConfigs(tmp, tmp)).advisors.map(advisor => advisor.systemPrompt)).toEqual([
			custom,
			"",
			undefined,
		]);

		delete loaded.advisors[0].systemPrompt;
		delete loaded.advisors[1].systemPrompt;
		await saveWatchdogConfigFile(file, loaded);
		expect(await Bun.file(file).text()).not.toContain("systemPrompt:");
		expect((await loadWatchdogConfigFile(file)).advisors).toEqual([
			{ name: "Custom", instructions: "Append specialization" },
			{ name: "Empty" },
			{ name: "Default" },
		]);
		expect((await discoverAdvisorConfigs(tmp, tmp)).advisors.map(advisor => advisor.systemPrompt)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
	});

	it("preserves comments and unknown fields when saving an edited document", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(
			file,
			[
				"# roster owner: Captain",
				"instructions: Keep the baseline. # shared note",
				"futureTopLevel:",
				"  policy: strict # future note",
				"advisors:",
				"  - name: Architecture # advisor identity",
				"    model: x-ai/grok-code-fast:high",
				"    futureAdvisorField: retain-me # advisor future note",
				"",
			].join("\n"),
		);
		const loaded = await loadWatchdogConfigFile(file);
		await Bun.write(file, `${await Bun.file(file).text()}externalAfterLoad: survive # external edit\n`);
		loaded.advisors[0].enabled = false;
		await saveWatchdogConfigFile(file, loaded);

		const saved = await Bun.file(file).text();
		expect(saved).toContain("# roster owner: Captain");
		expect(saved).toContain("# shared note");
		expect(saved).toContain("# future note");
		expect(saved).toContain("# advisor identity");
		expect(saved).toContain("# advisor future note");
		expect(saved).toContain("futureTopLevel:");
		expect(saved).toContain("futureAdvisorField: retain-me");
		expect(saved).toContain("instructions: Keep the baseline. # shared note");
		expect(saved).toContain("futureTopLevel:\n  policy: strict # future note");
		expect(saved).toContain("externalAfterLoad: survive # external edit");
		expect(YAML.parse(saved)).toMatchObject({
			futureTopLevel: { policy: "strict" },
			externalAfterLoad: "survive",
			advisors: [{ name: "Architecture", enabled: false, futureAdvisorField: "retain-me" }],
		});
	});

	it("keeps the surviving duplicate advisor node when deleting the first duplicate", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(
			file,
			[
				"advisors:",
				"  - name: Reviewer",
				"    futureId: first # first duplicate",
				"  - name: Reviewer",
				"    futureId: second # second duplicate",
				"",
			].join("\n"),
		);
		const loaded = await loadWatchdogConfigFile(file);
		loaded.advisors.splice(0, 1);
		loaded.advisors[0].enabled = false;
		await saveWatchdogConfigFile(file, loaded);

		const saved = await Bun.file(file).text();
		expect(YAML.parse(saved)).toEqual({
			advisors: [{ name: "Reviewer", futureId: "second", enabled: false }],
		});
		expect(saved).toContain("# second duplicate");
		expect(saved).not.toContain("# first duplicate");
	});

	it("matches cloned loaded advisors back to their existing YAML nodes", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Reviewer\n    model: test/old\n    futureId: keep # cloned\n");
		const loaded = await loadWatchdogConfigFile(file);
		loaded.advisors = loaded.advisors.map(advisor => structuredClone(advisor));
		loaded.advisors[0].model = "test/new";
		await saveWatchdogConfigFile(file, loaded);

		const saved = await Bun.file(file).text();
		expect(YAML.parse(saved)).toEqual({
			advisors: [{ name: "Reviewer", model: "test/new", futureId: "keep" }],
		});
		expect(saved).toContain("# cloned");
	});

	it("materializes an aliased advisor row before applying edits", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(
			file,
			[
				"template: &reviewer",
				"  name: Reviewer",
				"  model: test/old",
				"  futureId: keep # anchored template",
				"advisors:",
				"  - *reviewer # aliased row",
				"",
			].join("\n"),
		);
		const loaded = await loadWatchdogConfigFile(file);
		loaded.advisors[0].model = "test/new";
		await saveWatchdogConfigFile(file, loaded);

		const saved = await Bun.file(file).text();
		expect(saved).toContain("# anchored template");
		expect(saved).toContain("# aliased row");
		expect(YAML.parse(saved)).toEqual({
			template: { name: "Reviewer", model: "test/old", futureId: "keep" },
			advisors: [{ name: "Reviewer", model: "test/new", futureId: "keep" }],
		});
	});

	it("materializes an aliased advisor sequence before applying edits", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(
			file,
			[
				"sharedRoster: &sharedRoster",
				"  - name: Reviewer",
				"    model: test/old",
				"    futureId: keep # shared roster",
				"advisors: *sharedRoster # roster alias",
				"",
			].join("\n"),
		);
		const loaded = await loadWatchdogConfigFile(file);
		loaded.advisors[0].model = "test/new";
		await saveWatchdogConfigFile(file, loaded);

		const saved = await Bun.file(file).text();
		expect(saved).toContain("# shared roster");
		expect(saved).toContain("# roster alias");
		expect(YAML.parse(saved)).toEqual({
			sharedRoster: [{ name: "Reviewer", model: "test/old", futureId: "keep" }],
			advisors: [{ name: "Reviewer", model: "test/new", futureId: "keep" }],
		});
	});

	it("removes malformed advisor rows while preserving valid row comments and unknown fields", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(
			file,
			[
				"advisors:",
				"  - name: Valid",
				"    futureId: keep # valid future field",
				"  - name: Broken",
				'    enabled: "sometimes" # malformed row',
				"",
			].join("\n"),
		);
		const loaded = await loadWatchdogConfigFile(file);
		expect(loaded.advisors).toEqual([{ name: "Valid" }]);
		expect(loaded.warnings).toHaveLength(1);
		loaded.advisors[0].enabled = false;
		await saveWatchdogConfigFile(file, loaded);

		const normalized = await Bun.file(file).text();
		expect(normalized).toContain("# valid future field");
		expect(normalized).not.toContain("Broken");
		expect(YAML.parse(normalized)).toEqual({
			advisors: [{ name: "Valid", futureId: "keep", enabled: false }],
		});
		expect((await loadWatchdogConfigFile(file)).warnings).toBeUndefined();

		loaded.advisors.splice(0);
		await saveWatchdogConfigFile(file, loaded);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("merges later saves after repairing a malformed document", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "advisors: [broken");
		const repaired = await loadWatchdogConfigFile(file);
		repaired.advisors.push({ name: "Repaired" });
		await saveWatchdogConfigFile(file, repaired);

		const concurrent = await loadWatchdogConfigFile(file);
		concurrent.advisors.push({ name: "Concurrent", model: "test/external" });
		await saveWatchdogConfigFile(file, concurrent);
		repaired.advisors[0].enabled = false;
		await saveWatchdogConfigFile(file, repaired);

		expect(YAML.parse(await Bun.file(file).text())).toEqual({
			advisors: [
				{ name: "Repaired", enabled: false },
				{ name: "Concurrent", model: "test/external" },
			],
		});
	});

	it("matches a stale edit to the original row after a duplicate is inserted ahead of it", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Reviewer\n    futureId: original # original row\n");
		const stale = await loadWatchdogConfigFile(file);
		await Bun.write(
			file,
			[
				"advisors:",
				"  - name: Reviewer",
				"    futureId: inserted # inserted row",
				"  - name: Reviewer",
				"    futureId: original # original row",
				"",
			].join("\n"),
		);
		stale.advisors[0].enabled = false;
		await saveWatchdogConfigFile(file, stale);

		const saved = await Bun.file(file).text();
		expect(YAML.parse(saved)).toEqual({
			advisors: [
				{ name: "Reviewer", futureId: "inserted" },
				{ name: "Reviewer", futureId: "original", enabled: false },
			],
		});
		expect(saved).toContain("# inserted row");
		expect(saved).toContain("# original row");
	});

	it("keeps the newer value when two editors change the same advisor field", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Reviewer\n    model: test/original # model owner\n");
		const stale = await loadWatchdogConfigFile(file);
		const winner = await loadWatchdogConfigFile(file);
		winner.advisors[0].model = "test/winner";
		await saveWatchdogConfigFile(file, winner);
		stale.advisors[0].model = "test/stale";
		stale.advisors[0].enabled = false;
		await saveWatchdogConfigFile(file, stale);

		const saved = await Bun.file(file).text();
		expect(YAML.parse(saved)).toEqual({
			advisors: [{ name: "Reviewer", model: "test/winner", enabled: false }],
		});
		expect(saved).toContain("# model owner");
	});

	it("keeps newer shared fields when a stale editor changes the same fields", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(
			file,
			"instructions: original # shared owner\nmaxNotesPerUpdate: 3\nadvisors:\n  - name: Reviewer\n",
		);
		const stale = await loadWatchdogConfigFile(file);
		const winner = await loadWatchdogConfigFile(file);
		winner.instructions = "winner";
		winner.maxNotesPerUpdate = 7;
		await saveWatchdogConfigFile(file, winner);
		stale.instructions = "stale";
		stale.maxNotesPerUpdate = 9;
		await saveWatchdogConfigFile(file, stale);

		const saved = await Bun.file(file).text();
		expect(YAML.parse(saved)).toEqual({
			instructions: "winner",
			maxNotesPerUpdate: 7,
			advisors: [{ name: "Reviewer" }],
		});
		expect(saved).toContain("# shared owner");
	});

	it("preserves a concurrently changed advisor when a stale editor removes it", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Reviewer\n    model: test/original # row owner\n");
		const stale = await loadWatchdogConfigFile(file);
		const winner = await loadWatchdogConfigFile(file);
		winner.advisors[0].model = "test/winner";
		await saveWatchdogConfigFile(file, winner);
		stale.advisors.splice(0, 1);
		await saveWatchdogConfigFile(file, stale);

		const saved = await Bun.file(file).text();
		expect(YAML.parse(saved)).toEqual({
			advisors: [{ name: "Reviewer", model: "test/winner" }],
		});
		expect(saved).toContain("# row owner");
	});

	it("does not resurrect an advisor renamed or deleted by a newer editor", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Original\n    futureId: keep\n");
		const renameWinner = await loadWatchdogConfigFile(file);
		const staleAfterRename = await loadWatchdogConfigFile(file);
		renameWinner.advisors[0].name = "Renamed";
		await saveWatchdogConfigFile(file, renameWinner);
		staleAfterRename.advisors[0].enabled = false;
		await saveWatchdogConfigFile(file, staleAfterRename);
		expect(YAML.parse(await Bun.file(file).text())).toEqual({
			advisors: [{ name: "Renamed", futureId: "keep" }],
		});

		const deleteWinner = await loadWatchdogConfigFile(file);
		const staleAfterDelete = await loadWatchdogConfigFile(file);
		deleteWinner.advisors.splice(0, 1);
		await saveWatchdogConfigFile(file, deleteWinner);
		staleAfterDelete.advisors[0].enabled = false;
		await saveWatchdogConfigFile(file, staleAfterDelete);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("removes the file when the doc is empty so legacy discovery resumes", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		await saveWatchdogConfigFile(file, { advisors: [] });
		expect(await Bun.file(file).exists()).toBe(false);
		// Loading a missing file yields an empty doc, never throws.
		expect(await loadWatchdogConfigFile(file)).toEqual({ advisors: [] });
	});

	it("returns an empty serialization for an empty doc", () => {
		expect(serializeWatchdogConfig({ advisors: [] })).toBe("");
	});

	it("resolves project and user scope paths", () => {
		expect(advisorConfigFilePath("project", { projectDir: "/repo", agentDir: "/home/.omp" })).toBe(
			path.join("/repo", "WATCHDOG.yml"),
		);
		expect(advisorConfigFilePath("user", { projectDir: "/repo", agentDir: "/home/.omp" })).toBe(
			path.join("/home/.omp", "WATCHDOG.yml"),
		);
	});
});

describe("resolveAdvisorConfigEditPath", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-resolve-"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	const dirs = (d: string) => ({ projectDir: d, agentDir: d });

	it("defaults to .yml when neither file exists", async () => {
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yml"));
	});

	it("edits an existing .yaml in place when only it exists", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yaml"), "advisors: []\n");
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yaml"));
	});

	it("prefers the canonical .yml when both exist", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: []\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yaml"), "advisors: []\n");
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yml"));
	});
});

describe("per-advisor enabled field", () => {
	it("preserves explicit true, explicit false, and absence through save and discovery", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-enabled-"));
		await fsp.mkdir(path.join(tmp, ".git"));
		try {
			const doc: WatchdogConfigDoc = {
				advisors: [
					{ name: "Explicit On", model: "test/model-a", enabled: true },
					{ name: "Explicit Off", model: "test/model-b", enabled: false },
					{ name: "Default", model: "test/model-c" },
				],
			};
			const file = path.join(tmp, "WATCHDOG.yml");
			await saveWatchdogConfigFile(file, doc);

			const loaded = await loadWatchdogConfigFile(file);
			expect(loaded.advisors.map(advisor => advisor.enabled)).toEqual([true, false, undefined]);

			const { advisors } = await discoverAdvisorConfigs(tmp, tmp);
			expect(advisors.map(advisor => advisor.enabled)).toEqual([true, false, undefined]);
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});

	it("emits explicit boolean values but omits an absent enabled field", () => {
		const text = serializeWatchdogConfig({
			advisors: [
				{ name: "Explicit On", enabled: true },
				{ name: "Explicit Off", enabled: false },
				{ name: "Default" },
			],
		});
		expect(text).toContain("enabled: true");
		expect(text).toContain("enabled: false");
		expect(text.match(/enabled:/g)).toHaveLength(2);
	});
});

describe("maxNotesPerUpdate configuration", () => {
	it("discovers shared and per-advisor maxNotesPerUpdate from WATCHDOG.yml", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-max-notes-"));
		await fsp.mkdir(path.join(tmp, ".git"));
		try {
			const yaml = [
				"maxNotesPerUpdate: 4",
				"advisors:",
				"  - name: High Throughput",
				"    maxNotesPerUpdate: 5",
				"  - name: Default Budget",
			].join("\n");
			await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

			const { advisors, sharedMaxNotesPerUpdate } = await discoverAdvisorConfigs(tmp, tmp);
			expect(sharedMaxNotesPerUpdate).toBe(4);
			expect(advisors).toHaveLength(2);
			expect(advisors.find(a => a.name === "High Throughput")?.maxNotesPerUpdate).toBe(5);
			expect(advisors.find(a => a.name === "Default Budget")?.maxNotesPerUpdate).toBeUndefined();
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});

	it("round-trips maxNotesPerUpdate through save and load", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-max-notes-roundtrip-"));
		try {
			const doc: WatchdogConfigDoc = {
				maxNotesPerUpdate: 3,
				advisors: [{ name: "High", maxNotesPerUpdate: 5 }, { name: "Default" }],
			};
			const file = path.join(tmp, "WATCHDOG.yml");
			await saveWatchdogConfigFile(file, doc);

			const loaded = await loadWatchdogConfigFile(file);
			expect(loaded.maxNotesPerUpdate).toBe(3);
			expect(loaded.advisors[0]?.maxNotesPerUpdate).toBe(5);
			expect(loaded.advisors[1]?.maxNotesPerUpdate).toBeUndefined();
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});
});

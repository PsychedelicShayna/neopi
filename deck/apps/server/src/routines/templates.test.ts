/**
 * Smoke tests for routine templates. Every `.toml` file under
 * `apps/server/src/templates/` is parsed + validated against the V1 routine
 * spec schema. Adding a new template here is the cheap way to catch typos
 * (unknown step type, missing required field, regex-failing id) before they
 * 500 the install endpoint at runtime.
 *
 * The test is dynamic: it iterates whatever templates are present on disk
 * rather than hardcoding a slug list. That way local-only templates (e.g.
 * user-specific paper-trading sleeves gitignored away from the public repo)
 * still get validated in dev, but CI doesn't fail when they're absent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSettingsToml, stringifySettingsToml } from "@oh-my-pi/pi-utils/settings-toml";

import { validateRoutineSpec, type RoutineSpec } from "@npi-deck/protocol";

import { listTemplates, loadTemplate } from "./templates.ts";

/** Templates that MUST ship in the public repo. Anything else is best-effort. */
const REQUIRED_SHIPPED = ["daily-briefing", "kb-orphan-census"] as const;

describe("routine templates", () => {
	test("every required shipped template is in the listing", () => {
		const slugs = new Set(listTemplates().map(t => t.slug));
		for (const required of REQUIRED_SHIPPED) {
			expect(slugs.has(required)).toBe(true);
		}
	});

	const templates = listTemplates();
	for (const summary of templates) {
		test(`${summary.slug}: loads + passes schema validation`, () => {
			const loaded = loadTemplate(summary.slug);
			expect(loaded).not.toBeNull();
			if (!loaded) return;
			const result = validateRoutineSpec(loaded.spec);
			if (!result.valid) {
				const reasons = (result.errors ?? []).map(e => `  ${e.path}: ${e.message}`).join("\n");
				throw new Error(`${summary.slug} failed validation:\n${reasons}`);
			}
		});
	}
});

const temporaryDirectories: string[] = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function templateDirectory(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deck-template-toml-"));
	temporaryDirectories.push(directory);
	return directory;
}

const legacyTemplate =
	"# original user source\nname: user-template # user slug comment\ntrigger:\n  - manual: {}\nsteps:\n  - id: state\n    type: set_state\n    state: {cleared: null, nested: [null, false, 0, '']} # nested payload comment\n";

test("YAML-only user templates import once atomically with original permissions and provenance", async () => {
	const directory = templateDirectory();
	const legacyPath = path.join(directory, "user-template.yaml");
	const target = path.join(directory, "user-template.toml");
	await Bun.write(legacyPath, legacyTemplate);
	fs.chmodSync(legacyPath, 0o640);
	const loaded = loadTemplate("user-template", directory)!;
	expect(loaded).not.toBeNull();
	expect(loaded.spec.steps[0]).toMatchObject({ state: { cleared: null, nested: [null, false, 0, ""] } });
	for (const comment of ["# original user source", "# user slug comment", "# nested payload comment"])
		expect(loaded.specToml).toContain(comment);
	expect(await Bun.file(legacyPath).text()).toBe(legacyTemplate);
	expect(await Bun.file(target).text()).toBe(loaded.specToml);
	if (process.platform !== "win32")
		expect(fs.statSync(target).mode & 0o777).toBe(fs.statSync(legacyPath).mode & 0o777);
	expect(fs.readdirSync(directory).sort()).toEqual(["user-template.toml", "user-template.yaml"]);
	const edited = `${loaded.specToml}\n# native edit wins forever\n`;
	await Bun.write(target, edited);
	await Bun.write(legacyPath, "invalid: [");
	expect(loadTemplate("user-template", directory)?.specToml).toBe(edited);
	expect(listTemplates(directory).map(template => template.slug)).toEqual(["user-template"]);
	expect(await Bun.file(legacyPath).text()).toBe("invalid: [");
});

test("existing TOML wins over both legacy suffixes without parsing or replacing them", async () => {
	const directory = templateDirectory();
	const spec: RoutineSpec = {
		name: "native",
		trigger: [{ manual: {} }],
		steps: [{ id: "wait", type: "wait", duration_secs: 1 }],
	};
	const toml = stringifySettingsToml(spec as unknown as Record<string, unknown>);
	await Bun.write(path.join(directory, "user-template.toml"), toml);
	await Bun.write(path.join(directory, "user-template.yaml"), "invalid: [");
	await Bun.write(path.join(directory, "user-template.yml"), legacyTemplate);
	expect(listTemplates(directory)).toMatchObject([{ slug: "user-template", name: "native" }]);
	expect(loadTemplate("user-template", directory)?.specToml).toBe(toml);
	expect(await Bun.file(path.join(directory, "user-template.yaml")).text()).toBe("invalid: [");
	expect(await Bun.file(path.join(directory, "user-template.yml")).text()).toBe(legacyTemplate);
});

test("YML-only templates are imported while unsupported YAML never creates a target", async () => {
	const directory = templateDirectory();
	await Bun.write(path.join(directory, "user-template.yml"), legacyTemplate);
	expect(loadTemplate("user-template", directory)?.spec.name).toBe("user-template");
	expect(parseSettingsToml(await Bun.file(path.join(directory, "user-template.toml")).text()).name).toBe(
		"user-template",
	);
	const invalid = `${legacyTemplate}\nunknown: do-not-drop\n`;
	await Bun.write(path.join(directory, "invalid.yaml"), invalid);
	expect(loadTemplate("invalid", directory)).toBeNull();
	expect(await Bun.file(path.join(directory, "invalid.toml")).exists()).toBe(false);
	expect(await Bun.file(path.join(directory, "invalid.yaml")).text()).toBe(invalid);
});

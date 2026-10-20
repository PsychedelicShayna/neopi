import { describe, expect, it } from "bun:test";
import { listPromptHelpers } from "@oh-my-pi/pi-utils/prompt";
import { analyzePromptReferences } from "../src/prompts/analysis";
import { promptAssets } from "../src/prompts/catalog";
import { getPromptAssetKeys, getPromptLexicon } from "../src/prompts/lexicon";
import type { PromptAsset } from "../src/prompts/types";
import { validatePrompt } from "../src/prompts/validation";

function asset(overrides: Partial<PromptAsset> = {}): PromptAsset {
	return {
		id: "test/sample.md",
		relPath: "test/sample.md",
		bundled: "Hello {{name}}",
		scope: "test",
		group: "core",
		keys: [
			{ path: "name", type: "string" },
			{ path: "unused", type: "string" },
		],
		fixture: { name: "Shayna", unused: "still exposed" },
		consumerHints: ["test"],
		...overrides,
	};
}

describe("built-in prompt validation", () => {
	it("accepts exposed unused keys and helpers instead of restricting overrides to shipped usage", () => {
		expect(validatePrompt(asset(), '{{default unused "fallback"}}')).toEqual([]);
	});

	it("reports an unknown variable at its original source line and suggests declared keys", () => {
		const diagnostics = validatePrompt(asset(), "Header\n  {{#if name}}\nHello {{nmae}}\n  {{/if}}\n", {
			file: "override.md",
		});
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			code: "unknown-variable",
			file: "override.md",
			line: 3,
			column: 9,
			scope: "test",
		});
		expect(diagnostics[0].candidates).toContain("name");
		expect(diagnostics[0].endColumn).toBeGreaterThan(diagnostics[0].column);
	});

	it("finds unknown nested helpers in subexpressions", () => {
		const diagnostics = validatePrompt(asset(), '{{#if (defualt name "x")}}yes{{/if}}');
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].code).toBe("unknown-helper");
		expect(diagnostics[0].candidates).toContain("default");
	});

	it("distinguishes another scope's identity value from an unknown root", () => {
		const target = promptAssets.find(candidate => candidate.scope === "system");
		expect(target).toBeDefined();
		const diagnostics = validatePrompt(target!, "{{username}}");
		expect(diagnostics.find(item => item.code === "wrong-scope")?.hint).toContain("live");
	});

	it("validates nested typed fields through each, with, parent and root paths", () => {
		const target = asset({
			keys: [
				{ path: "name", type: "string" },
				{ path: "items", type: "object[]", children: [{ path: "label", type: "string" }] },
				{ path: "owner", type: "object", children: [{ path: "name", type: "string" }] },
			],
			fixture: { name: "root", items: [{ label: "one" }], owner: { name: "captain" } },
		});
		expect(
			validatePrompt(
				target,
				"{{#each items}}{{label}} {{../name}} {{@root.name}}{{/each}}{{#with owner}}{{name}}{{/with}}",
			),
		).toEqual([]);
		const diagnostics = validatePrompt(target, "{{#each items}}{{missing}}{{/each}}");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].code).toBe("bad-type-path");
	});

	it("rejects a field on a scalar without attempting to render it", () => {
		expect(validatePrompt(asset(), "{{name.address}}")[0]).toMatchObject({
			code: "bad-type-path",
			expectedType: "string",
		});
	});

	it("reports malformed templates as structured diagnostics", () => {
		const diagnostics = validatePrompt(asset(), "intro\n{{#if name}}missing close", { file: "broken.md" });
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ code: "compile-error", file: "broken.md", line: 2, scope: "test" });
	});

	it("notes missing required runtime data and requires it with --runtime", () => {
		const target = asset({
			keys: [{ path: "roster", type: "string", required: true, resolution: "runtime-only" }],
			fixture: { roster: "fixture" },
		});
		expect(validatePrompt(target, "{{roster}}")[0]).toMatchObject({
			code: "missing-required-runtime",
			severity: "note",
		});
		expect(validatePrompt(target, "{{roster}}", { runtime: true })[0].severity).toBe("error");
		expect(validatePrompt(target, "{{roster}}", { runtime: true, fixture: { roster: "live" } })).toEqual([]);
	});

	it("dry-renders a real tool fixture", () => {
		const bash = promptAssets.find(candidate => candidate.id === "tools/bash.md");
		expect(bash).toBeDefined();
		expect(validatePrompt(bash!, bash!.bundled).filter(item => item.severity === "error")).toEqual([]);
	});

	it("surfaces dry-render exceptions as diagnostics instead of throwing a helper error", () => {
		const target = asset({ keys: [{ path: "items", type: "string[]" }], fixture: { items: ["one"] } });
		const diagnostics = validatePrompt(target, "{{#list items join=1}}{{this}}{{/list}}");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ code: "render-error", severity: "error", scope: "test" });
	});

	it("accepts declared string and array length paths", () => {
		const target = asset({
			keys: [
				{ path: "name", type: "string" },
				{ path: "items", type: "string[]" },
			],
			fixture: { name: "Shayna", items: ["one"] },
		});
		expect(validatePrompt(target, "{{name.length}} {{items.length}} {{items.0}}")).toEqual([]);
	});

	it("limits local helpers to their declared scope", () => {
		expect(validatePrompt(asset(), "{{jtdToTypeScript schema}}").some(item => item.code === "unknown-helper")).toBe(
			true,
		);
		const scoped = asset({
			localHelpers: ["jtdToTypeScript"],
			keys: [{ path: "schema", type: "object" }],
			fixture: { schema: { type: "string" } },
		});
		expect(validatePrompt(scoped, "{{jtdToTypeScript schema}}")).toEqual([]);
	});
});

describe("generated prompt lexicon", () => {
	it("derives registered helper inventory and keeps local helper availability scoped", () => {
		const lexicon = getPromptLexicon();
		expect(lexicon.helpers.map(helper => helper.name).sort()).toEqual(listPromptHelpers().sort());
	});

	it("computes used and unused from bundled ASTs, not from a manually curated split", () => {
		const target = asset();
		const keys = getPromptAssetKeys(target);
		expect(keys.keys.find(key => key.path === "name")).toMatchObject({ usage: "used", usedBy: [target.id] });
		expect(keys.keys.find(key => key.path === "unused")).toMatchObject({ usage: "unused", usedBy: [] });
		expect(
			getPromptAssetKeys({ ...target, bundled: "{{unused}}" }).keys.find(key => key.path === "unused")?.usage,
		).toBe("used");
	});

	it("exposes only live OS identity fields", () => {
		const live = getPromptLexicon().scopes.find(scope => scope.name === "live");
		expect(live?.keys.map(key => key.path).sort()).toEqual(["firstName", "username"]);
	});

	it("every shipped reference belongs to its exposed scope contract", () => {
		const invalid = promptAssets.flatMap(target =>
			validatePrompt(target, target.bundled)
				.filter(item =>
					[
						"unknown-variable",
						"unknown-helper",
						"wrong-scope",
						"bad-type-path",
						"compile-error",
						"render-error",
					].includes(item.code),
				)
				.map(item => ({ asset: target.id, code: item.code, expression: item.expression, message: item.message })),
		);
		expect(invalid).toEqual([]);
	});

	it("resolves block lexical references for inspection", () => {
		const refs = analyzePromptReferences("{{#each items}}{{label}} {{../name}}{{else}}{{name}}{{/each}}");
		expect(refs.filter(ref => ref.kind === "variable").map(ref => ref.path)).toEqual([
			"items",
			"items[].label",
			"name",
			"name",
		]);
	});
});

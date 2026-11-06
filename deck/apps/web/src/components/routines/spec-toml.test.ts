/** Native TOML builder source round-trips and layout metadata stability. */

import { describe, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";

import type { RoutineSpec } from "@npi-deck/protocol";

import { emptyV1Spec, parseSpec, replaceStep, stringifySpec } from "./spec-toml";

const baseSpec: RoutineSpec = {
	name: "layout-roundtrip",
	trigger: [{ manual: {} }],
	steps: [
		{ id: "step_a", type: "wait", duration_secs: 1 },
		{ id: "step_b", type: "wait", duration_secs: 1 },
	],
};

describe("stringifySpec / parseSpec — layout round-trip", () => {
	test("spec without layout serializes without a layout table", () => {
		const toml = stringifySpec(baseSpec);
		expect(toml).not.toContain("[layout");
	});

	test("spec with layout serializes the block at the tail in stable order", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				// Insertion order is intentionally NOT alphabetical to verify sort.
				nodes: {
					step_b: { x: 280, y: 220 },
					step_a: { x: 280, y: 0 },
				},
				edges: [{ from: "step_a", to: "step_b", kind: "success" }],
			},
		};
		const toml = stringifySpec(spec);
		// Steps precede the optional layout tables.
		expect(toml.indexOf("[[steps]]")).toBeLessThan(toml.indexOf("[layout]"));
		// Node table keys appear alphabetically.
		expect(toml.indexOf("[layout.nodes.step_a]")).toBeLessThan(toml.indexOf("[layout.nodes.step_b]"));
		expect(toml).toContain("version = 1");
		expect(toml).toContain("[layout.nodes.step_a]");
		expect(toml).toContain("[[layout.edges]]");
	});

	test("round-trip is lossless for a fully-populated layout", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: {
					step_a: { x: 280, y: 0 },
					step_b: { x: 280, y: 220, collapsed: true },
				},
				edges: [
					{ from: "step_a", to: "step_b", kind: "success" },
					{ from: "step_a", to: "step_b", kind: "manual", label: "fallback" },
				],
			},
		};
		const toml = stringifySpec(spec);
		const result = parseSpec(toml);
		expect(result.ok).toBe(true);
		expect(result.spec?.layout?.version).toBe(1);
		expect(result.spec?.layout?.nodes?.step_a).toEqual({ x: 280, y: 0 });
		expect(result.spec?.layout?.nodes?.step_b).toEqual({
			x: 280,
			y: 220,
			collapsed: true,
		});
		expect(result.spec?.layout?.edges).toEqual([
			{ from: "step_a", to: "step_b", kind: "success" },
			{ from: "step_a", to: "step_b", kind: "manual", label: "fallback" },
		]);
	});

	test("empty nodes / edges drop out of the emitted TOML", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: { version: 1, nodes: {}, edges: [] },
		};
		const toml = stringifySpec(spec);
		expect(toml).toContain("version = 1");
		expect(toml).not.toContain("[layout.nodes");
		expect(toml).not.toContain("[[layout.edges]]");
	});
});

describe("native TOML builder source", () => {
	test("an empty builder draft preserves its shape while failing step validation", () => {
		const spec = emptyV1Spec();
		const toml = stringifySpec(spec);
		expect(parseToml(toml)).toEqual(spec);
		const result = parseSpec(toml);
		expect(result.ok).toBe(false);
		expect(result.tomlError).toBeUndefined();
		expect(result.schemaErrors?.some(error => error.path === "/steps")).toBe(true);
	});

	test("direct specs preserve nested actions, expressions and layout", () => {
		const cardBody =
			"+++\n# Keep card metadata\nread-only = true\ncustom = {values = [1, 'two']}\n+++\n{{ steps.prepare.stdout }}\n";
		const spec: RoutineSpec = {
			name: "nested-actions",
			description: 'Unicode 🐇 and "quoted" source',
			trigger: [
				{ manual: { params_schema: { type: "object", properties: { title: { type: "string" } } } } },
				{ webhook: { path: "/hooks/local-test", secret_env: "TEST_SECRET" } },
			],
			concurrency: "queue",
			budget: { max_duration_secs: 30, max_llm_cost_usd: 0.5 },
			state: { declared_keys: ["last_run"] },
			tags: ["builder", "toml"],
			steps: [
				{
					id: "prepare",
					type: "agent",
					prompt: "Return JSON.\nPreserve {{ params.title }}.",
					structured_output: {
						schema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } } },
						strict: true,
					},
					on_failure: "retry",
					retry: { times: 2, backoff: "exponential", max_delay_secs: 4 },
				},
				{
					id: "task",
					type: "deck",
					action: "create_task",
					title: "{{ params.title }}",
					body: cardBody,
					properties: { "read-only": true, custom: { priorities: [1, 2], nested: { enabled: false } } },
				},
				{
					id: "lookup",
					type: "mcp",
					server: "local-fixture",
					tool: "lookup",
					args: { nested: { filters: [{ key: "title", value: "{{ params.title }}" }] } },
				},
			],
			layout: {
				version: 1,
				nodes: { prepare: { x: -40, y: 0 }, task: { x: 280, y: 120, collapsed: true } },
				edges: [{ from: "prepare", to: "task", kind: "manual", label: "Create task" }],
			},
		};
		const toml = stringifySpec(spec);
		expect(toml).toContain('name = "nested-actions"');
		expect(toml).not.toContain("[spec]");
		const parsed = parseSpec(toml);
		expect(parsed).toEqual({ ok: true, spec });
		expect(parsed.spec?.steps[1]).toEqual(spec.steps[1]);
	});

	test("syntax failures and schema failures remain separate", () => {
		const syntax = parseSpec("name = [");
		expect(syntax.ok).toBe(false);
		expect(syntax.tomlError?.message).toBeTruthy();
		expect(syntax.tomlError?.line).toBe(1);
		expect(syntax.schemaErrors).toBeUndefined();
		const schema = parseSpec('name = "missing-required-fields"');
		expect(schema.ok).toBe(false);
		expect(schema.tomlError).toBeUndefined();
		expect(schema.schemaErrors?.length).toBeGreaterThan(0);
	});

	test("the native source editor does not accept legacy YAML", () => {
		expect(parseSpec("name: legacy\ntrigger:\n  - manual: {}\nsteps: []\n").ok).toBe(false);
	});
});

describe("replaceStep — id rename cascade", () => {
	test("no rename: returns spec untouched aside from steps array", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: { step_a: { x: 100, y: 0 }, step_b: { x: 100, y: 220 } },
			},
		};
		const next = replaceStep(spec, 0, { id: "step_a", type: "wait", duration_secs: 5 });
		// layout block carried through verbatim.
		expect(next.layout).toEqual(spec.layout);
		// only the patched step changed.
		expect((next.steps[0] as { duration_secs: number }).duration_secs).toBe(5);
	});

	test("rename: migrates the layout.nodes key, preserving collapsed flag", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: {
					step_a: { x: 100, y: 0, collapsed: true },
					step_b: { x: 100, y: 220 },
				},
			},
		};
		const next = replaceStep(spec, 0, {
			id: "renamed_a",
			type: "wait",
			duration_secs: 1,
		});
		expect(next.layout?.nodes?.renamed_a).toEqual({ x: 100, y: 0, collapsed: true });
		expect(next.layout?.nodes?.step_a).toBeUndefined();
		// Unrelated node untouched.
		expect(next.layout?.nodes?.step_b).toEqual({ x: 100, y: 220 });
	});

	test("rename: rewrites layout.edges endpoints (from + to)", () => {
		const spec: RoutineSpec = {
			...baseSpec,
			layout: {
				version: 1,
				nodes: { step_a: { x: 0, y: 0 }, step_b: { x: 0, y: 220 } },
				edges: [
					{ from: "step_a", to: "step_b", kind: "success" },
					{ from: "step_b", to: "step_a", kind: "manual" },
				],
			},
		};
		const next = replaceStep(spec, 0, {
			id: "renamed_a",
			type: "wait",
			duration_secs: 1,
		});
		expect(next.layout?.edges).toEqual([
			{ from: "renamed_a", to: "step_b", kind: "success" },
			{ from: "step_b", to: "renamed_a", kind: "manual" },
		]);
	});

	test("rename on a spec with NO layout returns spec without inventing one", () => {
		const next = replaceStep(baseSpec, 0, {
			id: "renamed_a",
			type: "wait",
			duration_secs: 1,
		});
		expect(next.layout).toBeUndefined();
		expect(next.steps[0]?.id).toBe("renamed_a");
	});
});

describe("shared native source semantics", () => {
	test("literal nulls remain distinct from empty strings and absent fields", () => {
		const spec: RoutineSpec = {
			name: "null-state",
			trigger: [{ manual: {} }],
			steps: [
				{ id: "state", type: "set_state", state: { cleared: null, nested: [null, "", false, 0], "a/b~c": null } },
			],
		};
		const source = stringifySpec(spec);
		expect(source).toContain("__npi");
		expect(parseSpec(source)).toEqual({ ok: true, spec });
	});

	test("form edits and source re-saves retain unrelated comments and authored text", () => {
		const source =
			"# top-level note\nname = 'comments'\n# trigger note\n[[trigger]]\nmanual = {}\n\n[[steps]]\n# step note\nid = 'wait'\ntype = 'wait'\nduration_secs = 1 # timing\n";
		const parsed = parseSpec(source);
		expect(parsed.ok).toBe(true);
		expect(stringifySpec(parsed.spec!, source)).toBe(source);
		const edited: RoutineSpec = { ...parsed.spec!, steps: [{ id: "wait", type: "wait", duration_secs: 2 }] };
		const saved = stringifySpec(edited, source);
		for (const comment of ["# top-level note", "# trigger note", "# step note", "# timing"])
			expect(saved).toContain(comment);
		expect(saved).toContain("name = 'comments'");
		expect(parseSpec(saved)).toEqual({ ok: true, spec: edited });
	});

	test("cleared optional form fields are omitted without erasing explicit payload nulls", () => {
		const source = stringifySpec({
			name: "optional",
			description: undefined,
			trigger: [{ manual: {} }],
			steps: [
				{
					id: "request",
					type: "http",
					method: "POST",
					url: "http://127.0.0.1/unused",
					headers: undefined,
					body: { cleared: null },
				},
			],
		});
		const parsed = parseSpec(source);
		expect(parsed.ok).toBe(true);
		expect(parsed.spec).not.toHaveProperty("description");
		expect(parsed.spec?.steps[0]).toMatchObject({ body: { cleared: null } });
		expect(parsed.spec?.steps[0]).not.toHaveProperty("headers");
	});

	test("invalid reserved null metadata is rejected before schema validation", () => {
		const result = parseSpec(`${stringifySpec(baseSpec)}\n[__npi]\nversion = 1\nnull_paths = ['/steps/99/body']\n`);
		expect(result.ok).toBe(false);
		expect(result.tomlError?.message).toBeTruthy();
	});
});

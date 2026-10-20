import { describe, expect, it } from "bun:test";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { create, parseTemplate, TemplateSyntaxError } from "@oh-my-pi/pi-utils/template";

function position(source: string, offset: number) {
	const prefix = source.slice(0, offset).split("\n");
	return { line: prefix.length, column: prefix[prefix.length - 1].length + 1, offset };
}

describe("original template source spans", () => {
	it("retains standalone rendering and original locations after multiline comments", () => {
		const source =
			"Header\r\n  {{!-- comment\r\n    more --}}\r\n  {{#if enabled}}  \r\n    {{name}}\r\n  {{/if}}\r\nTail";
		const nodes = parseTemplate(source);
		const block = nodes.find(node => node.kind === "block");
		expect(block?.loc).toEqual({
			start: position(source, source.indexOf("{{#if")),
			end: position(source, source.indexOf("{{/if}}") + "{{/if}}".length),
		});
		if (!block || block.kind !== "block") throw new Error("Expected if block");
		const output = block.body.find(node => node.kind === "output");
		expect(output?.loc).toEqual({
			start: position(source, source.indexOf("{{name}}")),
			end: position(source, source.indexOf("{{name}}") + "{{name}}".length),
		});
		expect(create().compile(source)({ enabled: true, name: "Ada" })).toBe("Header\r\n    Ada\r\nTail");
	});

	it("locates nested subexpressions and hash values independently", () => {
		const source = 'Before\n{{#if (not (includes tools "bash")) includeZero=true}}{{name}}{{/if}}';
		const block = parseTemplate(source).find(node => node.kind === "block");
		if (!block || block.kind !== "block") throw new Error("Expected if block");
		const not = block.expression.args[0];
		if (not.kind !== "call") throw new Error("Expected not call");
		const includes = not.args[0];
		if (includes.kind !== "call") throw new Error("Expected includes call");
		expect(source.slice(includes.loc.start.offset, includes.loc.end.offset)).toBe('(includes tools "bash")');
		expect(includes.args[0].loc.start).toEqual(position(source, source.indexOf("tools")));
		expect(source.slice(includes.args[1].loc.start.offset, includes.args[1].loc.end.offset)).toBe('"bash"');
		const hash = block.expression.hash.includeZero;
		expect(source.slice(hash.loc.start.offset, hash.loc.end.offset)).toBe("true");
	});

	it("keeps inline comments invisible without moving following text", () => {
		const source = "one {{! hidden }} two\n{{!-- hidden --}}{{value}}";
		const output = parseTemplate(source).find(node => node.kind === "output");
		expect(output?.loc.start).toEqual(position(source, source.indexOf("{{value}}")));
		expect(create().compile(source)({ value: "three" })).toBe("one  two\nthree");
	});

	it("points mismatched closing blocks at the original standalone line", () => {
		const source = "{{! removed }}\n  {{#if value}}\nbody\n  {{/each}}\n";
		try {
			create().compile(source);
			throw new Error("Expected syntax failure");
		} catch (error) {
			expect(error).toBeInstanceOf(TemplateSyntaxError);
			if (!(error instanceof TemplateSyntaxError)) throw error;
			expect(error).toMatchObject({ line: 4, column: 3, endLine: 4, endColumn: 12, expression: "{{/each}}" });
		}
	});

	it.each([
		["before\n{{#if value}}", "{{#if value}}"],
		["before\n{{else}}", "{{else}}"],
		["before\n{{!-- open", "{{!-- open"],
		['before\n{{join values "open}}', '{{join values "open}}'],
		["before\n{{not (includes tools}}", "{{not (includes tools}}"],
		["before\n{{# }}", ""],
	])("reports structured syntax errors for %s", (source, expression) => {
		try {
			parseTemplate(source);
			throw new Error("Expected syntax failure");
		} catch (error) {
			expect(error).toBeInstanceOf(TemplateSyntaxError);
			if (!(error instanceof TemplateSyntaxError)) throw error;
			expect(error.line).toBe(2);
			expect(error.endLine).toBe(2);
			expect(error.expression).toBe(expression);
			expect(error.loc.start.offset).toBeGreaterThanOrEqual(7);
		}
	});
});

describe("prompt helper inventory", () => {
	it("derives isolated engine inventory from helper registration", () => {
		const engine = create();
		const before = engine.listHelpers();
		engine.registerHelper("testInventoryHelper", () => "registered");
		expect(engine.listHelpers()).toEqual([...before, "testInventoryHelper"].sort());
		expect(engine.compile("{{testInventoryHelper}}")()).toBe("registered");
		expect(create().listHelpers()).toEqual(before);
	});

	it("lists implemented syntax and custom helpers without duplicates", () => {
		const names = prompt.listPromptHelpers();
		expect(names).toEqual([...new Set(names)].sort());
		expect(names).toEqual(
			expect.arrayContaining([
				...create().listHelpers(),
				"arg",
				"list",
				"join",
				"default",
				"pluralize",
				"when",
				"ifAny",
				"ifAll",
				"table",
				"codeblock",
				"xml",
				"escapeXml",
				"len",
				"add",
				"sub",
				"has",
				"includes",
				"not",
				"jsonStringify",
			]),
		);
		expect(names).toEqual(expect.arrayContaining(["if", "unless", "each", "with", "else", "lookup"]));
		expect(
			prompt.render('{{#if (includes values "a")}}{{lookup data "name"}}{{else}}missing{{/if}}', {
				values: ["a"],
				data: { name: "Ada" },
			}),
		).toBe("Ada");
	});
});

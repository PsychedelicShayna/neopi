import { describe, expect, it } from "bun:test";
import type { NativeChild, NativeNode } from "../src/native/node";
import { askToolRenderer } from "../src/tools/ask";
import { describeDefaultToolExecution } from "../src/tools/default-renderer";
import { describeMCPCall, describeMCPResult } from "../src/tools/mcp";
import type { RenderResultOptions } from "../src/tools/renderer";
import { webSearchToolRenderer } from "../src/tools/web-search";

const opts = { expanded: false, isPartial: false } as RenderResultOptions;

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	return (children ?? []).filter((c): c is NativeNode => typeof c === "object" && c !== null && "k" in c);
}

describe("web_search native view", () => {
	it("heads with the query and lists sources as linked rows with a domain mark", () => {
		const view = webSearchToolRenderer.describeResult(
			{
				content: [],
				details: {
					response: {
						provider: "parallel",
						answer: "The answer",
						sources: [{ url: "https://www.example.com/a", title: "Example", ageSeconds: 3 * 86400 }],
						model: "m1",
						usage: { inputTokens: 5 },
					},
				} as never,
			},
			opts,
			{ query: "what is x" },
		);
		expect(view?.tool?.target).toBe("what is x");
		expect(view?.tool?.targetKind).toBe("query");
		expect(view?.tool?.meta?.[0]).toMatch(/1 source$/);
		expect(view?.tool?.badges?.[0]?.title).toContain("in 5");
		const [answer, sources] = nodes(view?.body);
		expect(answer?.k).toBe("md");
		const rowNode = nodes(sources?.c)[0]!;
		expect(rowNode.p).toMatchObject({ role: "omp.tool.source", href: "https://www.example.com/a" });
		const [mark, title, meta] = nodes(rowNode.c);
		expect(mark?.p).toMatchObject({ text: "E" });
		expect(title?.p).toMatchObject({ spans: [{ href: "https://www.example.com/a" }] });
		expect(meta?.p).toMatchObject({ spans: [{ t: "example.com · 3d" }] });
	});
});

describe("ask native view", () => {
	it("pending call is an inline head naming the first retained question", () => {
		const view = askToolRenderer.describeCall({
			questions: [
				{ id: "pick", question: "Pick one?", options: [{ label: "A" }] },
				{ id: "why", question: "Why?", options: [] },
			],
		});
		expect(view?.inline).toBe(true);
		expect(view?.tool?.target).toBe("Pick one?");
		expect(view?.tool?.meta).toEqual(["2 questions"]);
	});

	it("pairs retained questions with their answers and distinguishes a timed-out single answer", () => {
		const view = askToolRenderer.describeResult(
			{
				content: [],
				details: {
					results: [
						{
							id: "db",
							question: "Database?",
							options: ["Postgres"],
							multi: false,
							selectedOptions: ["Postgres"],
						},
						{ id: "notes", question: "Notes", options: [], multi: false, selectedOptions: [] },
					],
				},
			},
			opts,
		);
		const sections = nodes(view?.body).filter(n => n.k === "section");
		const answers = sections.map(section => nodes(section.c).at(-1)!);
		expect(answers[0]?.p?.role).toBe("omp.tool.answer");
		expect(answers[1]?.p?.tone).toBe("warning");
		expect(JSON.stringify(answers[0])).toContain("Postgres");
		const timedOut = askToolRenderer.describeResult(
			{
				content: [],
				details: { question: "Database?", options: ["Postgres"], selectedOptions: ["Postgres"], timedOut: true },
			},
			opts,
		);
		expect(nodes(timedOut?.body).at(-1)?.p).toMatchObject({ role: "omp.tool.notice" });
	});

	it("keeps persisted option notes scoped to their retained question", () => {
		const view = askToolRenderer.describeResult(
			{
				content: [],
				details: {
					results: [
						{
							id: "unrelated",
							question: "Unrelated?",
							options: ["First", "Second"],
							multi: false,
							selectedOptions: ["First"],
						},
						{
							id: "db",
							question: "Database?",
							options: ["First", "Second"],
							multi: false,
							selectedOptions: ["First"],
							optionNotes: [{ option: "Second", note: "Team standard" }],
						},
					],
				},
			},
			opts,
		);
		const sections = nodes(view?.body).filter(node => node.k === "section");
		expect(nodes(sections[0]!.c).some(node => node.p?.role === "omp.tool.context")).toBe(false);
		const note = nodes(sections[1]!.c).at(-1)!;
		expect(note.p?.role).toBe("omp.tool.context");
		expect(JSON.stringify(note)).toContain("Second: ");
		expect(JSON.stringify(note)).toContain("Team standard");
	});

	it("falls back to the result text when details are unavailable", () => {
		const view = askToolRenderer.describeResult({ content: [{ type: "text", text: "Question unavailable" }] }, opts);
		expect(view?.tone).toBe("warning");
		expect(JSON.stringify(view?.body)).toContain("Question unavailable");
	});
});

describe("generic / MCP native views", () => {
	it("default renderer summarizes args in the head and renders JSON output as a tree", () => {
		const view = describeDefaultToolExecution({
			label: "custom",
			args: { a: 1 },
			result: { output: '{"x":1}', isError: false },
			options: opts,
		});
		expect(view.tool).toMatchObject({ title: "custom", targetKind: "text" });
		expect(view.tool?.target).toContain("a");
		expect(nodes(view.body)[0]?.k).toBe("tree");
	});

	it("MCP call and result keep the full args in a folded Args section after the output", () => {
		const query = `find ${"long ".repeat(40)}terms`;
		const args = { query, i: "intent" };
		const call = describeMCPCall(args, "srv/tool");
		const res = describeMCPResult({ content: [{ type: "text", text: "[1,2]" }] }, opts, args);
		for (const view of [call, res]) {
			// The head summary clips the value; the folded section carries all of it.
			expect(view?.tool?.target).not.toContain(query);
			const section = nodes(view?.body).at(-1)!;
			expect(section).toMatchObject({ k: "section", key: "args", p: { collapsible: true, collapsed: true } });
			expect(JSON.stringify(section)).toContain(query);
			expect(JSON.stringify(section)).not.toContain("intent");
		}
		expect(nodes(res?.body).map(n => n.k)).toEqual(["tree", "section"]);
		expect(describeMCPCall({}, "srv/tool").body).toBeUndefined();
	});

	it("MCP sends JSON output and args to a host that draws json as values, less the hidden root keys", () => {
		const json = { ...opts, json: true };
		const args = { query: "tokyo", limit: 2, i: "intent" };
		const text = JSON.stringify({ hits: [{ id: 1 }], __partialJson: "{" });
		const res = describeMCPResult({ content: [{ type: "text", text }] }, json, args);
		const [output, section] = nodes(res?.body);
		expect(output?.k).toBe("json");
		expect(output?.p).toEqual({ value: { hits: [{ id: 1 }] } });
		const argsNode = nodes(section?.c)[0];
		expect(argsNode?.k).toBe("json");
		expect(argsNode?.p).toEqual({ value: { query: "tokyo", limit: 2 } });
		const call = describeMCPCall(args, "srv/tool", json);
		expect(nodes(nodes(call.body)[0]?.c)[0]?.k).toBe("json");
	});
});

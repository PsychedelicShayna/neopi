import { listPromptHelpers } from "@oh-my-pi/pi-utils/prompt";
import {
	type CallExpression,
	type Expression,
	type Node,
	parseTemplate,
	type SourceLocation,
} from "@oh-my-pi/pi-utils/template";

export interface PromptReference {
	kind: "helper" | "variable" | "partial";
	name: string;
	path: string;
	loc: SourceLocation;
	expression: string;
}

const LOCAL_HELPERS = new Set(["jtdToTypeScript", "renderYieldSchema"]);

export function globalPromptHelpers(): string[] {
	return listPromptHelpers().filter(name => !LOCAL_HELPERS.has(name));
}

/** Resolve references in lexical context, including each/with and parent paths. */
export function analyzePromptReferences(text: string, localHelpers: readonly string[] = []): PromptReference[] {
	const helpers = new Set([...globalPromptHelpers(), ...localHelpers]);
	const references: PromptReference[] = [];
	function pathInContext(raw: string, contexts: string[]): string {
		if (raw.startsWith("@root.")) return raw.slice(6);
		if (raw === "@root") return "";
		if (raw.startsWith("@")) return raw;
		let path = raw;
		let level = contexts.length - 1;
		while (path.startsWith("../")) {
			level = Math.max(0, level - 1);
			path = path.slice(3);
		}
		path = path.replace(/^this(?:\.|\/|$)/, "").replace(/^\.\//, "");
		if (path === ".") path = "";
		path = path.replace(/\[([^\]]+)\]/g, "$1").replaceAll("/", ".");
		return [contexts[level], path].filter(Boolean).join(".");
	}
	function add(kind: PromptReference["kind"], name: string, contexts: string[], loc: SourceLocation): void {
		references.push({
			kind,
			name,
			path: kind === "variable" ? pathInContext(name, contexts) : name,
			loc,
			expression: text.slice(loc.start.offset, loc.end.offset),
		});
	}
	function argument(expression: Expression, contexts: string[], fallback: SourceLocation): void {
		if (expression.kind === "path") add("variable", expression.value, contexts, expression.loc ?? fallback);
		else if (expression.kind === "call") call(expression, contexts, expression.loc ?? fallback, true);
	}
	function call(expression: CallExpression, contexts: string[], loc: SourceLocation, forceHelper = false): void {
		const helper =
			helpers.has(expression.name) ||
			forceHelper ||
			expression.args.length > 0 ||
			Object.keys(expression.hash).length > 0;
		add(helper ? "helper" : "variable", expression.name, contexts, expression.loc ?? loc);
		for (const value of expression.args) argument(value, contexts, loc);
		for (const value of Object.values(expression.hash)) argument(value, contexts, loc);
	}
	function walk(nodes: Node[], contexts: string[]): void {
		for (const node of nodes) {
			if (node.kind === "text") continue;
			if (node.kind === "partial") {
				add("partial", node.expression.name, contexts, node.loc);
				for (const value of node.expression.args) argument(value, contexts, node.loc);
				continue;
			}
			call(node.expression, contexts, node.loc);
			if (node.kind !== "block") continue;
			if (node.inverse.length) add("helper", "else", contexts, node.loc);
			const { name, args } = node.expression;
			let childContexts = contexts;
			if (["each", "with", "list", "table"].includes(name) && args[0]?.kind === "path") {
				const child = pathInContext(args[0].value, contexts) + (name === "with" ? "" : "[]");
				childContexts = [...contexts, child];
			} else if (!helpers.has(name) && args.length === 0) {
				childContexts = [...contexts, pathInContext(name, contexts)];
			}
			walk(node.body, childContexts);
			walk(node.inverse, contexts);
		}
	}
	walk(parseTemplate(text), [""]);
	return references;
}

#!/usr/bin/env bun
/** Reject direct process creation outside the owned-process boundary. */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { ts } from "ts-morph";

const root = path.resolve(import.meta.dir, "../apps/server/src");

export function scanSource(file: string, text: string): string[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.expression.getText(source) === "Bun" &&
			(node.expression.name.text === "spawn" || node.expression.name.text === "spawnSync")
		) {
			const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
			violations.push(
				`${path.relative(root, file)}:${line}: direct ${node.expression.name.text} outside owned-process`,
			);
		}
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteralLike(node.moduleSpecifier) &&
			/^(node:)?child_process$/.test(node.moduleSpecifier.text)
		) {
			violations.push(`${path.relative(root, file)}: child_process import`);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return violations;
}

function scan(dir: string, violations: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) scan(file, violations);
		else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
			if (entry.name === "owned-process.ts") continue;
			violations.push(...scanSource(file, readFileSync(file, "utf8")));
		}
	}
}
if (import.meta.main) {
	const violations: string[] = [];
	scan(root, violations);
	if (violations.length) {
		console.error(violations.join("\n"));
		process.exit(1);
	}
	console.log("server process creation uses owned-process wrappers");
}

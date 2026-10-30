import * as path from "node:path";
import { ts } from "ts-morph";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

export interface RegistryInventory {
	settings: string[];
	commands: string[];
}
export interface ProvenanceData {
	upstream: string;
	previousUpstream: string;
	forkRevision: string;
	fork: RegistryInventory;
	newUpstream: RegistryInventory;
}
export type ReadRegistrySource = (file: string) => Promise<string>;
const ROOT = "packages/coding-agent/src/";

function literalProperty(object: ts.ObjectLiteralExpression, key: string): string | undefined {
	for (const property of object.properties) {
		if (!ts.isPropertyAssignment(property) || property.name.getText() !== key) continue;
		if (!ts.isStringLiteralLike(property.initializer)) throw new Error(`Nonliteral registry ${key}`);
		return property.initializer.text;
	}
	return undefined;
}

/** Parse declarations, not descriptions or nested subcommand names; never execute historical code. */
export async function readRegistryInventory(read: ReadRegistrySource): Promise<RegistryInventory> {
	const cache = new Map<string, ts.SourceFile>();
	const source = async (file: string): Promise<ts.SourceFile> => {
		let parsed = cache.get(file);
		if (!parsed) {
			parsed = ts.createSourceFile(file, await read(file), ts.ScriptTarget.Latest, true);
			cache.set(file, parsed);
		}
		return parsed;
	};
	const relative = (file: string, specifier: string): string =>
		path.posix.normalize(path.posix.join(path.posix.dirname(file), `${specifier}.ts`));
	const settings = new Set<string>();
	const visitedSettings = new Set<string>();
	const collectSettings = async (file: ts.SourceFile): Promise<void> => {
		if (visitedSettings.has(file.fileName)) return;
		visitedSettings.add(file.fileName);
		const declarations = new Map<string, ts.Expression>();
		const functions = new Map<string, ts.FunctionDeclaration>();
		for (const statement of file.statements) {
			if (ts.isVariableStatement(statement))
				for (const variable of statement.declarationList.declarations) {
					if (variable.initializer) declarations.set(variable.name.getText(), variable.initializer);
				}
			if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
			if (
				ts.isExportDeclaration(statement) &&
				statement.moduleSpecifier &&
				ts.isStringLiteral(statement.moduleSpecifier)
			) {
				await collectSettings(await source(relative(file.fileName, statement.moduleSpecifier.text)));
			}
		}
		const resolveString = (node: ts.Expression, scope: Map<string, ts.Expression>): string => {
			if (ts.isStringLiteralLike(node)) return node.text;
			if (ts.isIdentifier(node)) {
				const value = scope.get(node.text);
				if (value) return resolveString(value, scope);
			}
			if (ts.isTemplateExpression(node))
				return (
					node.head.text +
					node.templateSpans.map(span => resolveString(span.expression, scope) + span.literal.text).join("")
				);
			throw new Error(`Unsupported setting id in ${file.fileName}: ${node.getText()}`);
		};
		const walk = (node: ts.Node, scope: Map<string, ts.Expression>): void => {
			if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node)) return;
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
				if (node.expression.text === "register") {
					const object = node.arguments[0];
					if (!object || !ts.isObjectLiteralExpression(object))
						throw new Error(`Unsupported setting in ${file.fileName}`);
					const property = object.properties.find(item => item.name?.getText() === "id");
					if (!property || (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)))
						throw new Error(`Missing setting id in ${file.fileName}`);
					settings.add(
						resolveString(ts.isPropertyAssignment(property) ? property.initializer : property.name, scope),
					);
					return;
				}
				const helper = functions.get(node.expression.text);
				if (helper?.body) {
					const nested = new Map(scope);
					helper.parameters.forEach((parameter, index) => {
						const argument = node.arguments[index] ?? parameter.initializer;
						if (argument) nested.set(parameter.name.getText(), argument);
					});
					for (const statement of helper.body.statements)
						if (ts.isVariableStatement(statement)) {
							for (const variable of statement.declarationList.declarations)
								if (variable.initializer) nested.set(variable.name.getText(), variable.initializer);
						}
					ts.forEachChild(helper.body, child => walk(child, nested));
					return;
				}
			}
			ts.forEachChild(node, child => walk(child, scope));
		};
		for (const initializer of declarations.values()) walk(initializer, declarations);
		// Array-driven registry factories (for example one switch per magic keyword).
		for (const initializer of declarations.values()) {
			const maps: ts.CallExpression[] = [];
			const findMaps = (node: ts.Node): void => {
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					node.expression.name.text === "map" &&
					node.arguments.some(ts.isArrowFunction)
				)
					maps.push(node);
				ts.forEachChild(node, findMaps);
			};
			findMaps(initializer);
			for (const map of maps) {
				const callback = map.arguments.find(ts.isArrowFunction)!;
				let containsRegister = false;
				const check = (node: ts.Node): void => {
					if (ts.isCallExpression(node) && node.expression.getText() === "register") containsRegister = true;
					ts.forEachChild(node, check);
				};
				check(callback.body);
				if (!containsRegister) continue;
				const receiver = (map.expression as ts.PropertyAccessExpression).expression.getText();
				let values = declarations.get(receiver);
				if (!values)
					for (const statement of file.statements) {
						if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
						const bindings = statement.importClause?.namedBindings;
						if (
							!bindings ||
							!ts.isNamedImports(bindings) ||
							!bindings.elements.some(item => item.name.text === receiver)
						)
							continue;
						const imported = await source(relative(file.fileName, statement.moduleSpecifier.text));
						for (const statement of imported.statements)
							if (ts.isVariableStatement(statement)) {
								for (const variable of statement.declarationList.declarations)
									if (variable.name.getText() === receiver) values = variable.initializer;
							}
					}
				while (values && (ts.isAsExpression(values) || ts.isSatisfiesExpression(values)))
					values = values.expression;
				if (!values || !ts.isArrayLiteralExpression(values))
					throw new Error(`Unsupported registry factory ${receiver}`);
				for (const value of values.elements) {
					if (!ts.isObjectLiteralExpression(value))
						throw new Error(`Unsupported registry factory value ${receiver}`);
					const nested = new Map(declarations);
					for (const property of value.properties)
						if (ts.isPropertyAssignment(property)) {
							nested.set(
								`${callback.parameters[0]!.name.getText()}.${property.name.getText()}`,
								property.initializer,
							);
						}
					const substitute = (node: ts.Node): void => {
						if (ts.isCallExpression(node) && node.expression.getText() === "register") {
							const object = node.arguments[0] as ts.ObjectLiteralExpression;
							const id = object.properties.find(item => item.name?.getText() === "id") as ts.PropertyAssignment;
							const template = id.initializer as ts.TemplateExpression;
							const text =
								template.head.text +
								template.templateSpans
									.map(span => {
										const value = nested.get(span.expression.getText());
										if (!value) throw new Error(`Unresolved registry template ${span.expression.getText()}`);
										return resolveString(value, nested) + span.literal.text;
									})
									.join("");
							settings.add(text);
						}
						ts.forEachChild(node, substitute);
					};
					substitute(callback.body);
				}
			}
		}
	};
	const allSettings = await source(`${ROOT}config/all-settings.ts`);
	for (const statement of allSettings.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (!statement.importClause?.namedBindings || !ts.isNamespaceImport(statement.importClause.namedBindings))
			continue;
		await collectSettings(await source(relative(allSettings.fileName, statement.moduleSpecifier.text)));
	}
	const commands = new Set<string>();
	const visit = async (file: string, name: string): Promise<void> => {
		const parsed = await source(file);
		for (const statement of parsed.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const variable of statement.declarationList.declarations) {
				if (variable.name.getText() !== name || !variable.initializer) continue;
				await expression(file, variable.initializer);
				return;
			}
		}
		for (const statement of parsed.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const bindings = statement.importClause?.namedBindings;
			if (!bindings || !ts.isNamedImports(bindings)) continue;
			const binding = bindings.elements.find(item => item.name.text === name);
			if (binding) return visit(relative(file, statement.moduleSpecifier.text), binding.propertyName?.text ?? name);
		}
		throw new Error(`Cannot resolve registry ${file}:${name}`);
	};
	const expression = async (file: string, node: ts.Expression): Promise<void> => {
		if (ts.isArrayLiteralExpression(node)) {
			for (const item of node.elements) await expression(file, ts.isSpreadElement(item) ? item.expression : item);
		} else if (ts.isIdentifier(node)) await visit(file, node.text);
		else if (ts.isObjectLiteralExpression(node)) {
			const name = literalProperty(node, "name");
			if (!name) throw new Error(`Missing command name in ${file}`);
			commands.add(name);
		} else throw new Error(`Unsupported command registry expression in ${file}: ${node.kind}`);
	};
	await visit(`${ROOT}slash-commands/builtin-registry.ts`, "BUILTIN_SLASH_COMMAND_REGISTRY");
	return { settings: [...settings].sort(), commands: [...commands].sort() };
}

export function classifyInventories(
	previous: RegistryInventory,
	upstream: RegistryInventory,
	fork: RegistryInventory,
): Pick<ProvenanceData, "fork" | "newUpstream"> {
	const difference = (left: RegistryInventory, right: RegistryInventory): RegistryInventory => ({
		settings: left.settings.filter(id => !right.settings.includes(id)).sort(),
		commands: left.commands.filter(id => !right.commands.includes(id)).sort(),
	});
	return { fork: difference(fork, upstream), newUpstream: difference(upstream, previous) };
}

export async function generateProvenance(
	options: { previousUpstream: string; upstream: string; forkRevision: string },
	cwd = path.resolve(import.meta.dir, ".."),
): Promise<ProvenanceData> {
	const repo = vcs.requireGit(cwd);
	const readRevision =
		(revision: string): ReadRegistrySource =>
		async file => {
			if (revision === "WORKTREE") return Bun.file(path.join(cwd, file)).text();
			const blob = await repo.showBlob(`${revision}:${file}`);
			if (blob.truncated) throw new Error(`Truncated registry ${revision}:${file}`);
			return blob.data.toString();
		};
	const [previous, upstream, fork] = await Promise.all([
		readRegistryInventory(readRevision(options.previousUpstream)),
		readRegistryInventory(readRevision(options.upstream)),
		readRegistryInventory(readRevision(options.forkRevision)),
	]);
	return { ...options, ...classifyInventories(previous, upstream, fork) };
}

if (import.meta.main) {
	const [previousUpstream, upstream, forkRevision = "WORKTREE"] = process.argv.slice(2);
	if (!previousUpstream || !upstream)
		throw new Error(
			"Usage: bun scripts/generate-entry-provenance.ts <previous-upstream> <new-upstream> [fork-revision|WORKTREE]",
		);
	const data = await generateProvenance({ previousUpstream, upstream, forkRevision });
	await Bun.write(
		path.resolve(import.meta.dir, "../packages/coding-agent/src/config/entry-provenance.json"),
		`${JSON.stringify(data, null, 2)}\n`,
	);
	console.log(
		`Fork: ${data.fork.settings.length} settings, ${data.fork.commands.length} commands; upstream: ${data.newUpstream.settings.length} settings, ${data.newUpstream.commands.length} commands`,
	);
}

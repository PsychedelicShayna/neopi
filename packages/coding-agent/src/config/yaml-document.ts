import { Document, isAlias, isMap, isNode, isScalar, parseDocument, type ParsedNode, type YAMLMap } from "yaml";

/** One path-level change to apply without rebuilding the surrounding YAML document. */
export type YamlPathMutation =
	| { path: readonly (string | number)[]; operation: "set"; value: unknown }
	| { path: readonly (string | number)[]; operation: "delete" };

function appendComment(node: unknown, comments: readonly string[]): void {
	if (!isNode(node) || comments.length === 0) return;
	node.commentBefore = [node.commentBefore, ...comments].filter(Boolean).join("\n");
}

function preserveDeletedComments(document: Document.Parsed<ParsedNode>, path: readonly (string | number)[]): void {
	const parentPath = path.slice(0, -1);
	const parent = parentPath.length === 0 ? document.contents : document.getIn(parentPath, true);
	if (!isMap(parent)) return;
	const key = path[path.length - 1];
	const index = parent.items.findIndex(pair => (isScalar(pair.key) ? pair.key.value === key : pair.key === key));
	if (index < 0) return;
	const pair = parent.items[index];
	const comments: string[] = [];
	for (const node of [pair.key, pair.value]) {
		if (!isNode(node)) continue;
		if (node.commentBefore) comments.push(node.commentBefore);
		if (node.comment) comments.push(node.comment);
	}
	const next = parent.items[index + 1];
	if (next) appendComment(next.key, comments);
	else appendComment(parent, comments);
}

function materializeAliasParents(document: Document.Parsed<ParsedNode>, path: readonly (string | number)[]): void {
	for (let length = 1; length < path.length; length++) {
		const parentPath = path.slice(0, length);
		const parent = document.getIn(parentPath, true);
		if (!isAlias(parent)) continue;
		const resolved = parent.resolve(document);
		if (!resolved) throw new Error(`YAML alias at ${parentPath.join(".")} does not resolve`);
		document.setIn(parentPath, document.createNode(resolved.toJS(document)));
	}
}

function deleteYamlPath(document: Document.Parsed<ParsedNode>, path: readonly (string | number)[]): void {
	materializeAliasParents(document, path);
	preserveDeletedComments(document, path);
	document.deleteIn(path);
	for (let length = path.length - 1; length > 0; length--) {
		const parentPath = path.slice(0, length);
		const parent = document.getIn(parentPath, true);
		if (!isMap(parent) || parent.items.length > 0) break;
		preserveDeletedComments(document, parentPath);
		document.deleteIn(parentPath);
	}
}

/**
 * Parse an existing YAML mapping and mutate only the requested paths. The yaml
 * Document keeps comments and node styles attached to every untouched value.
 */
export function patchYamlDocument(source: string, mutations: readonly YamlPathMutation[]): string {
	const document = parseYamlMappingDocument(source);
	for (const mutation of mutations) {
		if (mutation.operation === "delete") {
			deleteYamlPath(document, mutation.path);
		} else {
			materializeAliasParents(document, mutation.path);
			document.setIn(mutation.path, mutation.value);
		}
	}
	return document.toString({ lineWidth: 0 });
}

/** Parse a YAML mapping for an in-place editor, accepting an empty document as an empty mapping. */
export function parseYamlMappingDocument(source: string): Document.Parsed<ParsedNode> {
	const document = parseDocument(source);
	if (document.errors.length > 0) throw document.errors[0];
	if (document.contents === null) document.contents = document.createNode({}) as ParsedNode;
	if (!isMap(document.contents)) throw new Error("YAML document must contain a mapping at the document root");
	return document;
}

/** Narrow a parsed document's root after {@link parseYamlMappingDocument}. */
export function yamlDocumentRoot(document: Document.Parsed<ParsedNode>): YAMLMap<unknown, unknown> {
	if (!isMap(document.contents)) throw new Error("YAML document must contain a mapping at the document root");
	return document.contents as YAMLMap<unknown, unknown>;
}

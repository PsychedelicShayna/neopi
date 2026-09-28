import { Document, isMap, parseDocument, type ParsedNode, type YAMLMap } from "yaml";

/** One path-level change to apply without rebuilding the surrounding YAML document. */
export type YamlPathMutation =
	| { path: readonly (string | number)[]; operation: "set"; value: unknown }
	| { path: readonly (string | number)[]; operation: "delete" };

/**
 * Parse an existing YAML mapping and mutate only the requested paths. The yaml
 * Document keeps comments and node styles attached to every untouched value.
 */
export function patchYamlDocument(source: string, mutations: readonly YamlPathMutation[]): string {
	const document = parseYamlMappingDocument(source);
	for (const mutation of mutations) {
		if (mutation.operation === "delete") document.deleteIn(mutation.path);
		else document.setIn(mutation.path, mutation.value);
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

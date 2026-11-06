import { isMap, isNode, isSeq, parseAllDocuments } from "yaml";

/**
 * Retain YAML comment text without confusing quoted/block scalar # characters
 * with comments. Associations cannot survive the format change, so retained
 * comments form an explicitly labelled TOML preamble. The legacy source stays
 * untouched; neither its values nor parser diagnostics are copied into logs.
 */
export function preserveLegacyYamlComments(source: string, toml: string): string {
	const documents = (() => {
		try {
			return parseAllDocuments(source, { uniqueKeys: false });
		} catch {
			throw new Error("Unable to retain legacy YAML comments");
		}
	})();
	if (documents.some(document => document.errors.length)) {
		throw new Error("Unable to retain legacy YAML comments");
	}
	const comments: string[] = [];
	const append = (comment: string | null | undefined): void => {
		if (comment !== null && comment !== undefined) comments.push(...comment.split("\n").map(line => `#${line}`));
	};
	const inspect = (node: unknown): void => {
		if (!isNode(node)) return;
		append(node.commentBefore);
		if (isMap(node)) {
			for (const pair of node.items) {
				inspect(pair.key);
				inspect(pair.value);
			}
		} else if (isSeq(node)) {
			for (const item of node.items) inspect(item);
		}
		append(node.comment);
	};
	for (const document of documents) {
		append(document.commentBefore);
		inspect(document.contents);
		append(document.comment);
	}
	if (!comments.length) return toml;
	return `# Imported YAML comments; original field associations are not retained.\n${comments.join("\n")}\n\n${toml}`;
}

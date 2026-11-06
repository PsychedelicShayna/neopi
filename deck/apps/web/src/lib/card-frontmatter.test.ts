import { describe, expect, test } from "bun:test";

import { cardBodyParts, cardPropertyDocument, setCardBodyContent, setCardBodyProperty } from "./card-frontmatter";

describe("native card body properties", () => {
	const body = '+++\n# Keep this comment\ncustom = {values = [1, "two"]}\nworktree = "/old"\nread-only = true\n+++\n\nKeep {{ steps.prepare.stdout }}\n';

	test("changing one property preserves unrelated header bytes and expression content", () => {
		const changed = setCardBodyProperty(body, "worktree", "/new");
		expect(changed).toBe(body.replace('worktree = "/old"', 'worktree = "/new"'));
		expect(setCardBodyProperty(changed, "worktree", "/new")).toBe(changed);
	});

	test("editing basic body text preserves the entire leading property block", () => {
		const changed = setCardBodyContent(body, "Edited text\n");
		expect(changed).toBe(body.slice(0, body.indexOf("\n\nKeep") + 1) + "Edited text\n");
	});

	test("removing a property preserves unknown properties and body content", () => {
		expect(setCardBodyProperty(body, "worktree", undefined)).toBe(body.replace('worktree = "/old"\n', ""));
	});

	test("inline table metadata remains valid and nested properties are preserved", () => {
		const changed = setCardBodyProperty('+++\ncustom = {values = [1, "two"]}\nread-only = false\n+++\nText', "read-only", true);
		expect(cardPropertyDocument(changed).properties).toEqual({ custom: { values: [1, "two"] }, "read-only": true });
		expect(cardBodyParts(changed).content).toBe("Text");
	});

	test("nested null metadata survives unrelated edits", () => {
		const source = '+++\nread-only = false\n[custom]\nvalues = ["", "kept"]\n[__npi]\nversion = 1\nnull_paths = ["/custom/values/0", "/custom/empty"]\n+++\nTask';
		const changed = setCardBodyProperty(source, "read-only", true);
		expect(cardPropertyDocument(changed).properties).toEqual({ "read-only": true, custom: { values: [null, "kept"], empty: null } });
	});

	test("legacy YAML and malformed native delimiters fail closed in the browser", () => {
		expect(() => cardPropertyDocument("---\nread-only: true\n---\nTask")).toThrow("imported by the server");
		expect(() => cardBodyParts("+++\nread-only = true\nTask")).toThrow("closing +++");
	});
});

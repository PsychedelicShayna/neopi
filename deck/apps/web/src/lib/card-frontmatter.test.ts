import { describe, expect, test } from "bun:test";
import { cardBodyParts, cardPropertyDocument, setCardBodyContent, setCardBodyProperty } from "./card-frontmatter";

const body =
	"+++\n# retained root\nread-only = false\nmodel = 'provider/model'\n[custom]\n# retained nested\nscore = 0.25\ntags = ['one', 'two']\n+++\nResearch\n";

describe("native browser card metadata", () => {
	test("parses native tables and leaves the Markdown body separate", () => {
		expect(cardPropertyDocument(body).properties).toEqual({
			"read-only": false,
			model: "provider/model",
			custom: { score: 0.25, tags: ["one", "two"] },
		});
		expect(cardBodyParts(body).content).toBe("Research\n");
		expect(cardBodyParts("+++\n+++\nBody")).toEqual({ header: "", content: "Body" });
		expect(cardBodyParts("Plain Markdown")).toEqual({ header: "", content: "Plain Markdown" });
	});

	test("property patches preserve nested comments, unrelated spelling and native types", () => {
		const patched = setCardBodyProperty(body, "read-only", true);
		expect(cardPropertyDocument(patched).properties["read-only"]).toBe(true);
		expect(patched).toContain("model = 'provider/model'");
		expect(patched).toContain("[custom]\n# retained nested\nscore = 0.25\ntags = ['one', 'two']");
		expect(setCardBodyProperty(body, "read-only", false)).toBe(body);
		const removed = setCardBodyProperty(patched, "model", undefined);
		expect(Object.hasOwn(cardPropertyDocument(removed).properties, "model")).toBe(false);
		expect(cardPropertyDocument(removed).properties.custom).toEqual({ score: 0.25, tags: ["one", "two"] });
	});

	test("body edits keep raw metadata byte-for-byte and null metadata uses the shared decoder", () => {
		const next = setCardBodyContent(body, "Edited\n");
		expect(cardBodyParts(next).header).toBe(cardBodyParts(body).header);
		expect(cardBodyParts(next).content).toBe("Edited\n");
		const nulls =
			"+++\nitems = ['', 'text']\n[custom]\n[__npi]\nversion = 1\nnull_paths = ['/items/0', '/custom/empty']\n+++\nBody";
		expect(cardPropertyDocument(nulls).properties).toEqual({ items: [null, "text"], custom: { empty: null } });
		expect(cardPropertyDocument(setCardBodyProperty(nulls, "read-only", true)).properties).toEqual({
			items: [null, "text"],
			custom: { empty: null },
			"read-only": true,
		});
	});

	test("refuses YAML, duplicate keys and unclosed native metadata rather than reinterpreting it", () => {
		expect(() => cardPropertyDocument("---\nread-only: true\n---\nBody")).toThrow("imported");
		expect(() => cardPropertyDocument("+++\nrole = 'a'\nrole = 'b'\n+++\nBody")).toThrow();
		expect(() => cardPropertyDocument("+++\nrole = 'a'\nBody")).toThrow("closing");
	});
});

test("raw multiline values containing +++ survive native body editing and property patching", () => {
	const raw =
		"+++\n# retained comment  \nnotes = \"\"\"before\n+++\nafter\"\"\"\nliteral = '''first\n+++\nlast'''\n+++\nBody\n+++\nProse\n";
	const parsed = cardPropertyDocument(raw);
	expect(parsed.properties).toEqual({ notes: "before\n+++\nafter", literal: "first\n+++\nlast" });
	expect(parsed.content).toBe("Body\n+++\nProse\n");
	const edited = setCardBodyContent(raw, "Edited\n");
	expect(cardPropertyDocument(edited).header).toBe(parsed.header);
	const patched = setCardBodyProperty(raw, "read-only", true);
	expect(patched).toContain("# retained comment  \n");
	expect(cardPropertyDocument(patched).properties).toEqual({ ...parsed.properties, "read-only": true });
	expect(cardPropertyDocument(patched).content).toBe(parsed.content);
	const rich = setCardBodyProperty("Body", "notes", "before\n+++\nafter");
	expect(cardPropertyDocument(rich).properties.notes).toBe("before\n+++\nafter");
	expect(cardPropertyDocument(rich).content).toBe("Body");
});

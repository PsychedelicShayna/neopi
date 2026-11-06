import { describe, expect, test } from "bun:test";
import { cardBodyParts, cardPropertyDocument, setCardBodyContent, setCardBodyProperty } from "./card-frontmatter";

const body = "+++\n# retained root\nread-only = false\nmodel = 'provider/model'\n[custom]\n# retained nested\nscore = 0.25\ntags = ['one', 'two']\n+++\nResearch\n";

describe("native browser card metadata", () => {
	test("parses native tables and leaves the Markdown body separate", () => {
		expect(cardPropertyDocument(body).properties).toEqual({ "read-only": false, model: "provider/model", custom: { score: 0.25, tags: ["one", "two"] } });
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
		const nulls = "+++\nitems = ['', 'text']\n[custom]\n[__npi]\nversion = 1\nnull_paths = ['/items/0', '/custom/empty']\n+++\nBody";
		expect(cardPropertyDocument(nulls).properties).toEqual({ items: [null, "text"], custom: { empty: null } });
		expect(cardPropertyDocument(setCardBodyProperty(nulls, "read-only", true)).properties).toEqual({ items: [null, "text"], custom: { empty: null }, "read-only": true });
	});

	test("refuses YAML, duplicate keys and unclosed native metadata rather than reinterpreting it", () => {
		expect(() => cardPropertyDocument("---\nread-only: true\n---\nBody")).toThrow("imported");
		expect(() => cardPropertyDocument("+++\nrole = 'a'\nrole = 'b'\n+++\nBody")).toThrow();
		expect(() => cardPropertyDocument("+++\nrole = 'a'\nBody")).toThrow("closing");
	});
});

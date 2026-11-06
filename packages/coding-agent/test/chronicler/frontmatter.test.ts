import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { parseNativeMarkdown, readNativeMarkdown, renderNativeMarkdown } from "../../src/utils/native-frontmatter";

let temp: TempDir;
beforeEach(async () => {
	temp = TempDir.createSync("chronicler-toml-");
});
afterEach(async () => {
	await temp.remove();
});

const legacy =
	"---\nschema: 1\ntitle: Legacy record\noptional: null\nitems: [null, value]\n---\n\n# Legacy record\n\nBody stays byte-identical.\r\n";

describe("owned Chronicler TOML frontmatter", () => {
	it("preserves nested metadata, nulls, punctuation, and the exact body", () => {
		const metadata = {
			title: 'A +++ boundary, : colon, and "quotes"',
			optional: null,
			items: [null, { nested: null, text: "first\n+++\nlast" }],
		};
		const body = "\n# Heading\r\n\nBody with --- and +++.\n";
		const rendered = renderNativeMarkdown(metadata, body);
		expect(rendered).toStartWith("+++\n");
		expect(parseNativeMarkdown(rendered)).toEqual({ frontmatter: metadata, body });
	});

	it("does not accept YAML through the canonical parser or repair broken TOML", () => {
		expect(() => parseNativeMarkdown(legacy)).toThrow();
		expect(() => parseNativeMarkdown('+++\ntitle = "unterminated\n+++\nBody')).toThrow();
		expect(() => parseNativeMarkdown("+++\ntitle = 1\nBody")).toThrow();
	});

	it("imports a legacy record into an atomic same-mode sibling without changing the source", async () => {
		const file = path.join(temp.path(), "beat.md");
		const sibling = path.join(temp.path(), "beat.toml.md");
		await Bun.write(file, legacy);
		await fs.chmod(file, 0o640);
		const imported = await readNativeMarkdown(file);
		expect(imported.filePath).toBe(sibling);
		expect(imported.frontmatter).toEqual({
			schema: 1,
			title: "Legacy record",
			optional: null,
			items: [null, "value"],
		});
		expect(imported.body).toBe("\n# Legacy record\n\nBody stays byte-identical.\r\n");
		expect(await Bun.file(file).text()).toBe(legacy);
		expect((await fs.stat(sibling)).mode & 0o777).toBe(0o640);
		expect((await fs.readdir(temp.path())).sort()).toEqual(["beat.md", "beat.toml.md"]);
	});

	it("selects an existing TOML sibling, warns with paths only, and never rewrites either file", async () => {
		const file = path.join(temp.path(), "beat.md");
		const sibling = path.join(temp.path(), "beat.toml.md");
		const canonical = renderNativeMarkdown({ title: "Canonical" }, "\nCanonical body.\n");
		await Bun.write(file, legacy);
		await Bun.write(sibling, canonical);
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const loaded = await readNativeMarkdown(file);
			expect(loaded.frontmatter.title).toBe("Canonical");
			expect(warning).toHaveBeenCalledWith("Native TOML document takes precedence over legacy document", {
				filePath: sibling,
				legacyPath: file,
			});
		} finally {
			warning.mockRestore();
		}
		expect(await Bun.file(file).text()).toBe(legacy);
		expect(await Bun.file(sibling).text()).toBe(canonical);
	});

	it("keeps snapshot readers and dry runs read-only when a legacy record has not been imported", async () => {
		const file = path.join(temp.path(), "beat.md");
		await Bun.write(file, legacy);
		const loaded = await readNativeMarkdown(file, { readOnly: true });
		expect(loaded.frontmatter.optional).toBeNull();
		expect(loaded.filePath).toBe(file);
		expect(await fs.readdir(temp.path())).toEqual(["beat.md"]);
		expect(await Bun.file(file).text()).toBe(legacy);
	});

	it("fails closed on a corrupt canonical sibling rather than falling back to YAML", async () => {
		const file = path.join(temp.path(), "beat.md");
		await Bun.write(file, legacy);
		await Bun.write(path.join(temp.path(), "beat.toml.md"), "+++\ninvalid =\n+++\n");
		await expect(readNativeMarkdown(file)).rejects.toThrow();
		expect(await Bun.file(file).text()).toBe(legacy);
	});

	it("carries legacy comment text into native metadata without confusing literal hashes for comments", async () => {
		const file = path.join(temp.path(), "commented.md");
		const original =
			'---\n# record heading\ntitle: "literal # value" # title annotation\nnested:\n  # nested annotation\n  clear: null\n---\n\nExact body.\r\n';
		await Bun.write(file, original);
		const imported = await readNativeMarkdown(file);
		const raw = await Bun.file(imported.filePath).text();
		expect(raw).toContain("# record heading");
		expect(raw).toContain("# title annotation");
		expect(raw).toContain("# nested annotation");
		expect(raw).not.toContain("# literal # value");
		expect(imported.frontmatter).toEqual({ title: "literal # value", nested: { clear: null } });
		expect(imported.body).toBe("\nExact body.\r\n");
		expect(await Bun.file(file).text()).toBe(original);
	});
});

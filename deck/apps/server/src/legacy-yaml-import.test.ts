import { expect, test } from "bun:test";
import { preserveLegacyYamlComments } from "./legacy-yaml-import.ts";

test("comment import retains AST comments but never treats quoted/block hashes as comments", () => {
	const source = '# root\nname: "value # not a comment" # inline\nnested:\n  # nested\n  text: |\n    # block content, not a comment\n';
	const output = preserveLegacyYamlComments(source, 'name = "native"\n');
	expect(output).toContain("# root");
	expect(output).toContain("# inline");
	expect(output).toContain("# nested");
	expect(output).not.toContain("value # not a comment");
	expect(output).not.toContain("# block content, not a comment");
	expect(output).toContain("original field associations are not retained");
	expect(output.endsWith('name = "native"\n')).toBe(true);
});

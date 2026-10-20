import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { promptAssets, promptAssetExclusions } from "../src/prompts/catalog";
import { buildLivePromptContext, describePromptContext, systemPromptContextFixture } from "../src/prompts/contexts";

const root = path.resolve(import.meta.dir, "../../..");

describe("built-in prompt inventory", () => {
	it("catalogues every statically imported runtime markdown asset", async () => {
		const imported = new Set<string>();
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		for (const packageName of ["coding-agent", "agent", "snapcompact"]) {
			const sourceDir = path.join(root, "packages", packageName, "src");
			for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceDir, absolute: true })) {
				const text = await Bun.file(file).text();
				const source = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
				for (const item of transpiler.scanImports(source)) {
					if (item.path.endsWith(".md")) imported.add(path.resolve(path.dirname(file), item.path));
				}
			}
		}
		const excluded = new Set(
			promptAssetExclusions.filter(entry => !entry.path.includes("*")).map(entry => path.join(root, entry.path)),
		);
		const catalogued = new Set(
			promptAssets.map(asset =>
				path.join(
					root,
					asset.consumerHints.find(hint => hint.endsWith(".md"))!,
				),
			),
		);
		expect([...imported].filter(file => !catalogued.has(file) && !excluded.has(file))).toEqual([]);
		expect(new Set(promptAssets.map(asset => asset.id)).size).toBe(promptAssets.length);
	});

	it("keeps system contract keys tied to its context fixture and live identity limited to account names", () => {
		const system = promptAssets.find(asset => asset.id === "system/system-prompt.md")!;
		expect(system.keys).toEqual(describePromptContext(systemPromptContextFixture));
		const live = promptAssets.find(asset => asset.scope === "live")!;
		expect(live.keys.map(key => key.path).sort()).toEqual(
			Object.keys(buildLivePromptContext("alexandra", "Alexandra")).sort(),
		);
		expect(live.keys.map(key => key.path).sort()).toEqual(["firstName", "username"]);
	});

	it("leaves bundled agent definitions inspection-only without disabling runtime agent wrappers", () => {
		for (const name of ["frontmatter", "reviewer", "scout", "security-reviewer", "task"]) {
			expect(promptAssets.find(asset => asset.id === `agents/${name}.md`)?.inspectionOnly).toBe(true);
		}
		expect(promptAssets.find(asset => asset.id === "agents/init.md")?.inspectionOnly).not.toBe(true);
		expect(promptAssets.find(asset => asset.id === "agents/claude-parent-context.md")?.inspectionOnly).not.toBe(true);
	});
});

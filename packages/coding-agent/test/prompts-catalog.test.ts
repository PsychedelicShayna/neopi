import { describe, expect, it } from "bun:test";
import { promptAssets } from "../src/prompts/catalog";
import { buildLivePromptContext } from "../src/prompts/contexts";

describe("built-in prompt inventory", () => {
	it("limits live identity to account-name fields in both context and catalog", () => {
		const allowedIdentityKeys = ["firstName", "username"];
		expect(Object.keys(buildLivePromptContext("alexandra", "Alexandra")).sort()).toEqual(allowedIdentityKeys);
		const live = promptAssets.find(asset => asset.scope === "live")!;
		expect(live.keys.map(key => key.path).sort()).toEqual(allowedIdentityKeys);
	});

	it("leaves bundled agent definitions inspection-only without disabling runtime agent wrappers", () => {
		for (const name of ["frontmatter", "reviewer", "scout", "security-reviewer", "task"]) {
			expect(promptAssets.find(asset => asset.id === `agents/${name}.md`)?.inspectionOnly).toBe(true);
		}
		expect(promptAssets.find(asset => asset.id === "agents/init.md")?.inspectionOnly).not.toBe(true);
		expect(promptAssets.find(asset => asset.id === "agents/claude-parent-context.md")?.inspectionOnly).not.toBe(true);
	});
});

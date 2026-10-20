import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, prompt, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { buildSystemPrompt, type BuildSystemPromptOptions } from "../src/system-prompt";
import { buildLivePromptContext } from "../src/prompts/contexts";
import { resolveLiveInstructions } from "../src/live/personas";
import { Settings, resetSettingsForTest } from "../src/config/settings";
import bundledSystem from "../src/prompts/system/system-prompt.md" with { type: "text" };

async function withPromptHome(fn: (cwd: string, agentDir: string) => Promise<void>): Promise<void> {
	using temp = TempDir.createSync("@prompts-runtime-");
	const cwd = temp.join("project");
	const agentDir = temp.join("home", CONFIG_DIR_NAME, "agent");
	await fs.mkdir(cwd, { recursive: true });
	const previous = getAgentDir();
	const home = spyOn(os, "homedir").mockReturnValue(temp.join("home"));
	setAgentDir(agentDir);
	try {
		await fn(cwd, agentDir);
	} finally {
		setAgentDir(previous);
		home.mockRestore();
	}
}

function options(cwd: string): BuildSystemPromptOptions {
	return {
		cwd,
		contextFiles: [],
		skills: [],
		rules: [],
		alwaysApplyRules: [],
		toolNames: [],
		personality: "none",
		taskMaxConcurrency: 8,
		activeRepoContext: null,
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	};
}

function override(cwd: string, id: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "builtin-prompts", id);
}

describe("built-in prompt runtime boundaries", () => {
	it("starts real settings and builds the system prompt without an override directory", async () => {
		await withPromptHome(async (cwd, agentDir) => {
			resetSettingsForTest();
			try {
				const settings = await Settings.init({ cwd, agentDir });
				await settings.flush();
				expect((await buildSystemPrompt(options(cwd))).systemPrompt[0].length).toBeGreaterThan(0);
				expect(await Bun.file(path.join(agentDir, "builtin-prompts", "OMP_PROMPT_MANIFEST.json")).exists()).toBe(
					false,
				);
			} finally {
				resetSettingsForTest();
			}
		});
	});

	it("keeps bundled provider bytes when no override is installed", async () => {
		await withPromptHome(async cwd => {
			const original = prompt.render.bind(prompt);
			let context: Record<string, unknown> | undefined;
			const render = spyOn(prompt, "render").mockImplementation((template, data) => {
				if (data && typeof data === "object" && "MAX_CONCURRENCY" in data)
					context ??= data as Record<string, unknown>;
				return original(template, data);
			});
			try {
				const result = await buildSystemPrompt(options(cwd));
				expect(context).toBeDefined();
				expect(result.systemPrompt[0]).toBe(original(bundledSystem, context));
			} finally {
				render.mockRestore();
			}
		});
	});

	it("reloads project overrides on rebuild and falls back to the user asset", async () => {
		await withPromptHome(async (cwd, agentDir) => {
			const id = "system/system-prompt.md";
			await Bun.write(path.join(agentDir, "builtin-prompts", id), "user {{MAX_CONCURRENCY}}");
			await Bun.write(override(cwd, id), "project {{MAX_CONCURRENCY}}");
			expect((await buildSystemPrompt(options(cwd))).systemPrompt[0]).toBe("project 8");
			await Bun.write(override(cwd, id), "changed {{MAX_CONCURRENCY}}!");
			expect((await buildSystemPrompt(options(cwd))).systemPrompt[0]).toBe("changed 8!");
			await fs.unlink(override(cwd, id));
			expect((await buildSystemPrompt(options(cwd))).systemPrompt[0]).toBe("user 8");
		});
	});

	it("keeps SYSTEM.md literal and orthogonal to the default template override", async () => {
		await withPromptHome(async cwd => {
			await Bun.write(override(cwd, "system/system-prompt.md"), "DEFAULT TEMPLATE SHOULD NOT WIN");
			await Bun.write(override(cwd, "system/custom-system-prompt.md"), "custom slot: {{customPrompt}}");
			await Bun.write(path.join(cwd, CONFIG_DIR_NAME, "SYSTEM.md"), "literal {{username}} {{#if broken}}");
			const result = await buildSystemPrompt(options(cwd));
			expect(result.systemPrompt[0]).toBe("custom slot: literal {{username}} {{#if broken}}");
		});
	});

	it("prefers PERSONALITY.md even when the preset override cannot compile", async () => {
		await withPromptHome(async (cwd, agentDir) => {
			await Bun.write(path.join(agentDir, "PERSONALITY.md"), "file personality {{literal}}");
			await Bun.write(override(cwd, "system/personalities/friendly.md"), "{{#if broken}}");
			await Bun.write(override(cwd, "system/system-prompt.md"), "{{personality}}");
			const result = await buildSystemPrompt({ ...options(cwd), personality: "friendly" });
			expect(result.systemPrompt[0]).toBe("file personality {{literal}}");
		});
	});

	it("fails closed on a broken preset override rather than treating it as a preparation failure", async () => {
		await withPromptHome(async cwd => {
			const file = override(cwd, "system/personalities/friendly.md");
			await Bun.write(file, "{{#if broken}}");
			await expect(buildSystemPrompt({ ...options(cwd), personality: "friendly" })).rejects.toThrow(file);
		});
	});

	it("keeps live identity dynamic in the raw selected template", async () => {
		await withPromptHome(async (cwd, agentDir) => {
			await Bun.write(override(cwd, "live/live-instructions.md"), "Hello {{firstName}} / {{username}}");
			const raw = await resolveLiveInstructions(path.join(agentDir, "live-personas.json"), cwd);
			expect(raw).toBe("Hello {{firstName}} / {{username}}");
			expect(prompt.render(raw, buildLivePromptContext("alexandra", "Alexandra"))).toBe(
				"Hello Alexandra / alexandra",
			);
			expect(prompt.render(raw, buildLivePromptContext("shayna", "Shayna"))).toBe("Hello Shayna / shayna");
		});
	});
});

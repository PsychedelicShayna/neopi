import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prompt, TempDir } from "@oh-my-pi/pi-utils";
import { buildChatSystemPrompt } from "../src/chat/chat-system-prompt";
import chatModePrompt from "../src/prompts/chat/chat.md" with { type: "text" };
import chatSystemPrompt from "../src/prompts/chat/system.md" with { type: "text" };
import { renderDateCwdReminder } from "../src/session/date-cwd-reminder";

async function projectFixture(): Promise<TempDir> {
	const root = path.join(os.homedir(), ".cache", "npi-canary");
	await fs.mkdir(root, { recursive: true });
	return TempDir.create(path.join(root, "prompt-features-"));
}

function chatInput(cwd: string) {
	return {
		config: { mode: "chat" as const, include: [] },
		cwd,
		contextFiles: [],
		toolNames: [],
		skills: [],
		rules: [],
	};
}

describe("feature prompt asset consumers", () => {
	it("keeps stock chat output unchanged when no override exists", async () => {
		await using project = await projectFixture();
		const expected = prompt
			.render(chatSystemPrompt, {
				modePrompt: chatModePrompt.trim(),
				contextFiles: [],
				cwd: "",
				skills: [],
				rules: [],
				appendPrompt: "",
			})
			.trim();
		expect(buildChatSystemPrompt(chatInput(project.path()))).toEqual([expected]);
	});

	it("reloads both literal mode text and the wrapper without reinterpreting plain custom text", async () => {
		await using project = await projectFixture();
		const modePath = project.join(".omp", "builtin-prompts", "chat", "chat.md");
		const wrapperPath = project.join(".omp", "builtin-prompts", "chat", "system.md");
		await Bun.write(modePath, "first mode");
		await Bun.write(wrapperPath, "First wrapper: {{modePrompt}}");
		expect(buildChatSystemPrompt(chatInput(project.path()))).toEqual(["First wrapper: first mode"]);

		await Bun.write(modePath, "replacement mode text");
		await Bun.write(wrapperPath, "Second wrapper: {{modePrompt}} / {{appendPrompt}}");
		expect(buildChatSystemPrompt(chatInput(project.path()))).toEqual(["Second wrapper: replacement mode text /"]);
		expect(
			buildChatSystemPrompt({
				...chatInput(project.path()),
				customPrompt: "literal {{firstName}}",
				appendPrompt: "literal {{username}}",
			}),
		).toEqual(["Second wrapper: literal {{firstName}} / literal {{username}}"]);
	});

	it("fails closed for an invalid chat wrapper but falls back for a malformed reminder", async () => {
		await using project = await projectFixture();
		const cwd = project.path();
		const stockReminder = renderDateCwdReminder("2026-10-20", cwd);
		await Bun.write(project.join(".omp", "builtin-prompts", "chat", "system.md"), "{{#if modePrompt}}");
		expect(() => buildChatSystemPrompt(chatInput(cwd))).toThrow();
		await Bun.write(project.join(".omp", "builtin-prompts", "system", "date-cwd-reminder.md"), "{{#if date}}");
		expect(renderDateCwdReminder("2026-10-20", cwd)).toBe(stockReminder);
	});

	it("renders reminder overrides with the current date and explicit project directory", async () => {
		await using project = await projectFixture();
		const cwd = project.path();
		await Bun.write(project.join(".omp", "builtin-prompts", "system", "date-cwd-reminder.md"), "{{date}} @ {{cwd}}");
		expect(renderDateCwdReminder("2026-10-20", cwd)).toBe(`2026-10-20 @ ${cwd}`);
		expect(renderDateCwdReminder("2026-10-21", cwd)).toBe(`2026-10-21 @ ${cwd}`);
	});
});

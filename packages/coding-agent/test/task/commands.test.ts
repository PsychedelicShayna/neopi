import { describe, expect, it } from "bun:test";
import {
	expandCommand,
	getEmbeddedCommandTemplates,
	loadBundledCommands,
	type WorkflowCommand,
} from "@oh-my-pi/pi-coding-agent/task/commands";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeCommand(instructions: string): WorkflowCommand {
	return { name: "test", description: "test", instructions, source: "project", filePath: "test.md" };
}

describe("expandCommand", () => {
	it("substitutes $@ with the input", () => {
		expect(expandCommand(makeCommand("Do: $@ and again $@"), "fix the bug")).toBe(
			"Do: fix the bug and again fix the bug",
		);
	});

	it("keeps $-patterns in user input literal", () => {
		expect(expandCommand(makeCommand("Run $@"), "echo $$ $& $' $` $@")).toBe("Run echo $$ $& $' $` $@");
	});
});

describe("bundled command prompt overrides", () => {
	it("reads and renders the current project template each time commands are loaded", async () => {
		const scratch = path.join(os.homedir(), ".cache", "npi-canary");
		await fs.mkdir(scratch, { recursive: true });
		await using project = await TempDir.create(path.join(scratch, "task-command-prompts-"));
		const override = project.join(".omp", "builtin-prompts", "agents", "init.md");
		await Bun.write(override, "---\ndescription: Project init\n---\nRevision {{add 2 3}}");

		expect(loadBundledCommands(project.path()).find(command => command.name === "init")).toMatchObject({
			description: "Project init",
			instructions: "Revision 5",
		});
		expect(getEmbeddedCommandTemplates(project.path())[0]?.content).toContain("Revision 5");

		await Bun.write(override, "---\ndescription: Updated init\n---\nCurrent {{add 10 7}}");
		expect(loadBundledCommands(project.path()).find(command => command.name === "init")).toMatchObject({
			description: "Updated init",
			instructions: "Current 17",
		});

		await Bun.write(override, "{{#if true}}unclosed");
		expect(() => loadBundledCommands(project.path())).toThrow();
	});
});

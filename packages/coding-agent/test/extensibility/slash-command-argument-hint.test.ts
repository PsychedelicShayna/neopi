import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildFileSlashArgumentCompletions } from "@oh-my-pi/pi-coding-agent/extensibility/file-command-completions";
import { loadSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";

describe("loadSlashCommands argument-hint", () => {
	test("parses argument-hint frontmatter into FileSlashCommand.argumentHint", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-arg-hint-"));
		try {
			const commandsDir = path.join(cwd, ".agent", "commands");
			await fs.mkdir(commandsDir, { recursive: true });
			await Bun.write(
				path.join(commandsDir, "git-sync-branch.md"),
				[
					"---",
					"description: Rebase current branch",
					'argument-hint: "[base-branch]"',
					"---",
					"Rebase onto $ARGUMENTS",
					"",
				].join("\n"),
			);
			await Bun.write(
				path.join(commandsDir, "plain.md"),
				["---", "description: No hint here", "---", "Body", ""].join("\n"),
			);

			const commands = await loadSlashCommands({ cwd });
			const withHint = commands.find(command => command.name === "git-sync-branch");
			const withoutHint = commands.find(command => command.name === "plain");

			expect(withHint?.argumentHint).toBe("[base-branch]");
			expect(withoutHint?.argumentHint).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	test("parses side: true frontmatter, leaving other commands as main-session prompts", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-side-cmd-"));
		try {
			const commandsDir = path.join(cwd, ".agent", "commands");
			await fs.mkdir(commandsDir, { recursive: true });
			await Bun.write(
				path.join(commandsDir, "sitrep.md"),
				["---", "description: Situation report", "side: true", "---", "Report status", ""].join("\n"),
			);
			await Bun.write(
				path.join(commandsDir, "quoted.md"),
				["---", "description: Quoted flag", 'side: "true"', "---", "Body", ""].join("\n"),
			);

			const commands = await loadSlashCommands({ cwd });

			expect(commands.find(command => command.name === "sitrep")?.side).toBe(true);
			expect(commands.find(command => command.name === "quoted")?.side).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	test("only explicitly opted-in commands complete live Deck task IDs", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deck-arguments-"));
		const previousBase = process.env.NPI_DECK_API_BASE;
		const requests: string[] = [];
		let available = true;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push(`${request.method} ${new URL(request.url).pathname}`);
				if (!available) return new Response(null, { status: 503 });
				return Response.json({
					states: [
						{ id: "s_active", name: "Active" },
						{ id: "s_backlog", name: "Backlog" },
					],
					tasks: [
						{ id: "t_ui", title: "Update the UI", stateId: "s_active", orderInState: 2 },
						{ id: "t_api", title: "Update the API", stateId: "s_active", orderInState: 1 },
						{ id: "t_backlog", title: "Update docs", stateId: "s_backlog", orderInState: 0 },
						{ id: "t_archived", title: "Update tests", stateId: "s_active", archivedAt: "now", orderInState: 0 },
					],
				});
			},
		});
		try {
			process.env.NPI_DECK_API_BASE = server.url.origin;
			const commandsDir = path.join(cwd, ".agent", "commands");
			const hint = 'argument-hint: "[top|t_<id>|<title-fragment>]"';
			await Bun.write(path.join(commandsDir, "plain.md"), `---\n${hint}\n---\nBody`);
			await Bun.write(
				path.join(commandsDir, "pick-task.md"),
				`---\n${hint}\nargument-completions: deck-active-tasks\n---\nBody`,
			);
			const commands = await loadSlashCommands({ cwd });
			const plain = commands.find(command => command.name === "plain");
			const pickTask = commands.find(command => command.name === "pick-task");
			if (!plain || !pickTask) throw new Error("missing file command fixture");
			expect(buildFileSlashArgumentCompletions(plain)).toBeUndefined();
			expect(requests).toHaveLength(0);

			const complete = buildFileSlashArgumentCompletions(pickTask);
			expect((await complete?.(""))?.map(item => [item.value, item.preserveInputOnSubmit])).toEqual([
				["top", true],
				["t_api", true],
				["t_ui", true],
			]);
			expect((await complete?.("the UI"))?.map(item => item.value)).toEqual(["t_ui"]);
			expect(await complete?.("Update docs")).toBeNull();
			available = false;
			expect((await complete?.("to"))?.map(item => item.value)).toEqual(["top"]);
			expect(requests).toEqual(Array.from({ length: 4 }, () => "GET /api/tasks"));
		} finally {
			if (previousBase === undefined) delete process.env.NPI_DECK_API_BASE;
			else process.env.NPI_DECK_API_BASE = previousBase;
			await server.stop(true);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

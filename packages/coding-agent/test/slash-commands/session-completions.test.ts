import { describe, expect, it, spyOn } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	buildTuiBuiltinSlashCommands,
	BUILTIN_SLASH_COMMANDS,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

function complete(name: string, prefix: string, commands = BUILTIN_SLASH_COMMANDS) {
	return commands.find(command => command.name === name)?.getArgumentCompletions?.(prefix);
}

const liveCommands = buildTuiBuiltinSlashCommands({
	ctx: {
		todoPhases: [{ name: "Release notes", tasks: [{ content: "Write release announcement", status: "pending" }] }],
		session: {
			getAsyncJobSnapshot: () => ({ running: [{ id: "Report2" }], recent: [{ id: "Report1" }] }),
			getToolCatalogEntries: () => [{ name: "mounted_example", description: "An enabled mounted tool" }],
		},
	} as unknown as InteractiveModeContext,
});

describe("session slash command argument completion", () => {
	it("completes live todo targets across spaces without replacing bare all", async () => {
		const targets = await complete("todo", "done write release ", liveCommands);
		expect(targets?.map(item => item.value)).toEqual(["done Write release announcement "]);

		const empty = await complete("todo", "done ", liveCommands);
		expect(empty?.every(item => item.preserveInputOnSubmit)).toBe(true);
		expect(empty?.find(item => item.label === "all (no target)")?.value).toBe("done ");

		expect((await complete("todo", "append rel", liveCommands))?.map(item => item.value)).toEqual([
			'append "Release notes" ',
		]);
		expect(await complete("todo", 'append "Release notes" free text', liveCommands)).toBeNull();
	});

	it("offers running job IDs only, and completes enabled mounted tools", async () => {
		expect((await complete("jobs", "kill ", liveCommands))?.map(item => item.value)).toEqual([
			"kill all ",
			"kill Report2 ",
		]);
		expect((await complete("tool", "mounted", liveCommands))?.map(item => item.value)).toEqual(["mounted_example "]);
	});

	it("completes branches, tags at HEAD and recent commit IDs", async () => {
		const repo = spyOn(vcs, "requireGit").mockReturnValue({
			listBranches: async () => ["release", "origin/release"],
			tagsAt: async (ref: string) => (ref === "HEAD" ? ["rel-v2"] : []),
			logOnelines: async () => ["cafe001 Fix the issue"],
		} as unknown as VcsGitRepo);
		try {
			expect((await complete("git", "rel", liveCommands))?.map(item => item.value)).toEqual(["release ", "rel-v2 "]);
			expect((await complete("git", "cafe", liveCommands))?.map(item => item.value)).toEqual(["cafe001 "]);
		} finally {
			repo.mockRestore();
		}
	});

	it("offers stats flags but does not try to fill in a port or hostname", async () => {
		expect((await complete("stats", "--"))?.map(item => item.label)).toEqual(["--port", "--host"]);
		expect(await complete("stats", "--port ")).toBeNull();
		expect((await complete("stats", "-p 3847 "))?.map(item => item.value)).toEqual(["-p 3847 --host "]);
		expect(await complete("stats", "--host ex")).toBeNull();
	});

	it("completes MCP flags after a new name but leaves open inputs open", async () => {
		expect((await complete("mcp", 'add "new server" --scope u'))?.map(item => item.value)).toEqual([
			'add "new server" --scope user ',
		]);
		expect((await complete("mcp", "add new --transport s"))?.map(item => item.value)).toEqual([
			"add new --transport sse ",
		]);
		expect(await complete("mcp", "add new --url ex")).toBeNull();
		expect(await complete("mcp", "add new -- node ")).toBeNull();
		expect((await complete("mcp", "remove new --scope u"))?.map(item => item.value)).toEqual([
			"remove new --scope user ",
		]);
	});
});

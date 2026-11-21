import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { setSessionPinned } from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { buildTuiBuiltinSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { getSSHConfigPath, refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";

function makeCompleter(context: object) {
	const commands = buildTuiBuiltinSlashCommands({ ctx: context as InteractiveModeContext });
	return (name: string, prefix: string) =>
		commands.find(command => command.name === name)?.getArgumentCompletions?.(prefix);
}

describe("lifecycle argument completion", () => {
	it("matches session filenames and IDs across buckets and filters unpin against the live pin set", async () => {
		using temp = TempDir.createSync("@npi-lifecycle-sessions-");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = temp.join("agent");
		refreshDirsFromEnv();
		try {
			const cwd = temp.join("project");
			const localDir = temp.join("custom-sessions");
			const globalCwd = temp.join("another-project");
			const globalDir = computeDefaultSessionDir(globalCwd, new FileSessionStorage());
			const timestamp = "2026-01-01T00:00:00.000Z";
			const filename = "2026-01-01T00-00-00-000Z";
			await Bun.write(
				`${localDir}/${filename}_local-session.jsonl`,
				`${JSON.stringify({ type: "session", id: "local-session", timestamp, cwd })}\n`,
			);
			await Bun.write(
				`${globalDir}/${filename}_global-session.jsonl`,
				`${JSON.stringify({ type: "session", id: "global-session", timestamp, cwd: globalCwd })}\n`,
			);
			const complete = makeCompleter({ sessionManager: { getSessionDir: () => localDir } });
			expect((await complete("resume", "@cl"))?.map(item => item.value)).toEqual(["@claude "]);
			expect((await complete("resume", "2026-01-01T00"))?.map(item => item.value)).toEqual([
				"local-session ",
				"global-session ",
			]);
			expect((await complete("pin", "glob"))?.map(item => item.value)).toEqual(["global-session "]);
			expect(await complete("unpin", "")).toBeNull();
			await setSessionPinned("global-session", true);
			expect(await complete("unpin", "")).toEqual([
				expect.objectContaining({ value: "global-session ", preserveInputOnSubmit: true }),
			]);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			refreshDirsFromEnv();
		}
	});

	it("completes SSH flags, quoted key paths, and configured names in their owning scope", async () => {
		using temp = TempDir.createSync("@npi-lifecycle-ssh-");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = temp.join("agent");
		refreshDirsFromEnv();
		try {
			const cwd = temp.join("project");
			await Bun.write(
				getSSHConfigPath("project", cwd),
				JSON.stringify({ hosts: { office: { host: "office.test" } } }),
			);
			await Bun.write(getSSHConfigPath("user", cwd), JSON.stringify({ hosts: { home: { host: "home.test" } } }));
			await Bun.write(temp.join("project", "key file"), "");
			const complete = makeCompleter({ sessionManager: { getCwd: () => cwd } });
			expect((await complete("ssh", "add node --sc"))?.map(item => item.value)).toEqual(["add node --scope "]);
			expect((await complete("ssh", 'add node --key "key f'))?.map(item => item.value)).toEqual([
				'add node --key "key file" ',
			]);
			expect(await complete("ssh", "add node --port ")).toBeNull();
			expect((await complete("ssh", "remove "))?.map(item => item.value)).toEqual([
				"remove office ",
				"remove home --scope user ",
			]);
			expect((await complete("ssh", "rm office --scope u"))?.map(item => item.value)).toEqual([
				"rm office --scope user ",
			]);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			refreshDirsFromEnv();
		}
	});

	it("completes nested memory verbs and reads IDs from the active bank", async () => {
		const listMentalModels = vi.fn(async () => ({ items: [{ id: "project-state", name: "Project state" }] }));
		const state = { bankId: "current-bank", config: { mentalModelsEnabled: true }, client: { listMentalModels } };
		const complete = makeCompleter({ session: { getHindsightSessionState: () => state } });
		expect((await complete("memory", "mm sh"))?.map(item => item.value)).toEqual(["mm show "]);
		expect((await complete("memory", "mm show proj"))?.map(item => item.value)).toEqual(["mm show project-state "]);
		expect(listMentalModels).toHaveBeenCalledWith("current-bank", { detail: "metadata" });
		expect(await complete("memory", "mm refresh ")).toEqual([
			expect.objectContaining({ value: "mm refresh project-state ", preserveInputOnSubmit: true }),
		]);
	});

	it("keeps cleanse prose and counts open and uses different live sources for add-dir and remove-dir", async () => {
		using temp = TempDir.createSync("@npi-lifecycle-dirs-");
		const root = temp.join("workspace extra");
		await fs.mkdir(root);
		const settings = Settings.isolated();
		settings.setRoleModelAndEffort("smol", "openai/small", undefined, "session");
		const complete = makeCompleter({
			sessionManager: { getCwd: () => temp.path(), getAdditionalDirectories: () => [root] },
			session: {},
			settings,
		});
		expect(await complete("cleanse", "fix the di")).toBeNull();
		expect(await complete("cleanse", "fix this -n ")).toBeNull();
		expect((await complete("cleanse", "fix this -n 2 --te"))?.map(item => item.value)).toEqual([
			"fix this -n 2 --tests ",
		]);
		expect(await complete("cleanse", "fix this --model @smo")).toEqual([
			expect.objectContaining({ value: "fix this --model @smol ", submitsCommand: false }),
		]);
		await fs.mkdir(temp.join("workspace other"));
		expect((await complete("add-dir", "workspace "))?.map(item => item.value)).toEqual([
			"workspace extra/",
			"workspace other/",
		]);
		expect((await complete("remove-dir", "./workspace "))?.map(item => item.value)).toEqual([root]);
		expect(await complete("remove-dir", "workspace other")).toBeNull();
	});
});

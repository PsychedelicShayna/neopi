import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAgentsCommand } from "@oh-my-pi/pi-coding-agent/cli/agents-cli";
import { loadBundledAgents, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("agents unpack", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "npi-agents-unpack-"));
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(directory);
	});

	it("writes all bundled definitions as canonical native TOML documents", async () => {
		await runAgentsCommand({ action: "unpack", flags: { dir: directory, json: true } });
		const agents = loadBundledAgents();
		expect((await fs.readdir(directory)).sort()).toEqual(agents.map(agent => `${agent.name}.toml.md`).sort());
		for (const agent of agents) {
			const filePath = path.join(directory, `${agent.name}.toml.md`);
			const document = await Bun.file(filePath).text();
			expect(document.startsWith("+++\n")).toBe(true);
			const parsed = parseAgent(filePath, document, "user");
			expect(parsed.systemPrompt.trim()).toBe(agent.systemPrompt.trim());
			expect(parsed).toEqual({ ...agent, systemPrompt: parsed.systemPrompt, source: "user", filePath });
		}
	});

	it("does not shadow a customized legacy definition unless overwrite is forced", async () => {
		const legacyPath = path.join(directory, "scout.md");
		const nativePath = path.join(directory, "scout.toml.md");
		const legacy = "---\nname: scout\ndescription: Customized scout.\n---\nKeep my scout instructions.\n";
		await Bun.write(legacyPath, legacy);

		await runAgentsCommand({ action: "unpack", flags: { dir: directory, json: true } });
		expect(await Bun.file(legacyPath).text()).toBe(legacy);
		expect(await Bun.file(nativePath).exists()).toBe(false);
		expect(process.stdout.write).toHaveBeenLastCalledWith(
			expect.stringContaining(
				JSON.stringify({ skipped: [legacyPath] }, null, 2)
					.slice(1, -1)
					.trim(),
			),
		);

		await runAgentsCommand({ action: "unpack", flags: { dir: directory, json: true, force: true } });
		expect(await Bun.file(legacyPath).text()).toBe(legacy);
		const document = await Bun.file(nativePath).text();
		expect(document.startsWith("+++\n")).toBe(true);
		expect(parseAgent(nativePath, document, "user").description).toBe(
			loadBundledAgents().find(agent => agent.name === "scout")?.description,
		);
	});

	it("preserves existing native edits and legacy YAML unless native overwrite is forced", async () => {
		const nativePath = path.join(directory, "task.toml.md");
		const legacyPath = path.join(directory, "task.md");
		const native = '+++\nname = "task"\ndescription = "User edit."\n+++\nUser prompt.\n';
		const legacy = "---\nname: task\ndescription: Legacy edit.\n---\nLegacy prompt.\n";
		await Bun.write(nativePath, native);
		await Bun.write(legacyPath, legacy);

		await runAgentsCommand({ action: "unpack", flags: { dir: directory, json: true } });
		expect(await Bun.file(nativePath).text()).toBe(native);
		expect(await Bun.file(legacyPath).text()).toBe(legacy);

		await runAgentsCommand({ action: "unpack", flags: { dir: directory, json: true, force: true } });
		const document = await Bun.file(nativePath).text();
		expect(parseAgent(nativePath, document, "user").description).toBe(
			loadBundledAgents().find(agent => agent.name === "task")?.description,
		);
		expect(await Bun.file(legacyPath).text()).toBe(legacy);
	});
});

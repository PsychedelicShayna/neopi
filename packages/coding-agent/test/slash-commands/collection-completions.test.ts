import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeMarketplacesRegistry } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SkillshareClient } from "@oh-my-pi/pi-coding-agent/skillshare/client";
import { getSkillsInstallPaths, writeSkillsManifest } from "@oh-my-pi/pi-coding-agent/skillshare/manifest";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as piUtils from "@oh-my-pi/pi-utils";

function runtimeFor(cwd: string) {
	return {
		ctx: {
			sessionManager: { getCwd: () => cwd },
			editor: { setText: () => {} },
			showStatus: () => {},
			showError: (message: string) => {
				throw new Error(message);
			},
		} as unknown as InteractiveModeContext,
	};
}

describe("collection argument completion", () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collection-slash-"));
		spyOn(piUtils, "getAgentDir").mockReturnValue(path.join(root, "agent"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await piUtils.removeWithRetries(root);
	});

	test("marketplace names and cached plugin IDs complete with flags in either position", async () => {
		const registry = path.join(root, "marketplaces.json");
		spyOn(piUtils, "getMarketplacesRegistryPath").mockReturnValue(registry);
		const catalogPath = path.resolve(
			import.meta.dir,
			"../marketplace/fixtures/valid-marketplace/.claude-plugin/marketplace.json",
		);
		await writeMarketplacesRegistry(registry, {
			version: 1,
			marketplaces: [
				{
					name: "test-marketplace",
					sourceType: "local",
					sourceUri: path.dirname(path.dirname(catalogPath)),
					catalogPath,
					addedAt: "2026-01-01",
					updatedAt: "2026-01-01",
				},
			],
		});
		const complete = buildTuiBuiltinSlashCommands(runtimeFor(root)).find(
			command => command.name === "marketplace",
		)!.getArgumentCompletions!;
		expect((await complete("rm test"))?.map(item => item.value)).toEqual(["rm test-marketplace "]);
		expect((await complete("install --force --scope project hello"))?.map(item => item.value)).toEqual([
			"install --force --scope project hello-plugin@test-marketplace ",
		]);
		expect((await complete("install hello-plugin@test-marketplace --scope p"))?.map(item => item.value)).toEqual([
			"install hello-plugin@test-marketplace --scope project ",
		]);
	});

	test("skills update uses the selected manifest and offers remaining targets, not duplicates", async () => {
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd);
		const project = await getSkillsInstallPaths({ cwd, global: false });
		const user = await getSkillsInstallPaths({ cwd, global: true });
		await writeSkillsManifest(project.manifest, { skills: { "@demo/alpha": "^1.0.0", "@demo/beta": "^1.0.0" } });
		await writeSkillsManifest(user.manifest, { skills: { "@demo/global": "^2.0.0" } });
		const complete = buildTuiBuiltinSlashCommands(runtimeFor(cwd)).find(
			command => command.name === "skills",
		)!.getArgumentCompletions!;
		expect((await complete("update @demo/alpha @demo/"))?.map(item => item.value)).toEqual([
			"update @demo/alpha @demo/beta ",
		]);
		expect((await complete("update -g @demo/"))?.map(item => item.value)).toEqual(["update -g @demo/global "]);
	});

	test("skills install reuses packages and versions from explicit search without looking up drafts", async () => {
		const client = await SkillshareClient.create({ registryUrl: "https://example.invalid" });
		const create = spyOn(SkillshareClient, "create").mockResolvedValue(client);
		const search = spyOn(client, "search").mockResolvedValue({
			total: 1,
			page: 1,
			perPage: 10,
			hits: [
				{
					scope: "demo",
					name: "remote-skill",
					description: "A test skill",
					keywords: [],
					version: "2.1.0",
					publisher: { username: "demo", avatar: "" },
					updatedAt: Date.UTC(2026, 0, 1),
					weeklyDownloads: 0,
				},
			],
		});
		const runtime = runtimeFor(root);
		await executeBuiltinSlashCommand("/skills search remote", runtime);
		const complete = buildTuiBuiltinSlashCommands(runtime).find(
			command => command.name === "skills",
		)!.getArgumentCompletions!;
		expect((await complete("install @demo/re"))?.map(item => item.value)).toEqual(["install @demo/remote-skill "]);
		expect((await complete("install @demo/remote-skill@2."))?.map(item => item.value)).toEqual([
			"install @demo/remote-skill@2.1.0 ",
		]);
		expect(create).toHaveBeenCalledTimes(1);
		expect(search).toHaveBeenCalledTimes(1);
	});
});

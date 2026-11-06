import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import {
	importExternalAgentDefinitionDocument,
	parseAgentDefinitionDocument,
} from "@oh-my-pi/pi-coding-agent/task/agent-definition-document";
import { readNativeMarkdown } from "@oh-my-pi/pi-coding-agent/utils/native-frontmatter";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

let temp: TempDir;
beforeEach(async () => {
	temp = TempDir.createSync("native-agent-save-");
	await fs.mkdir(path.join(temp.path(), ".git"));
});
afterEach(async () => {
	await temp.remove();
});

function setup() {
	const auth = createInMemoryAuthStorage();
	const deps = createAgentsHubDeps(temp.path(), Settings.isolated(), new ModelRegistry(auth), () => ({
		explicit: [],
		configured: [],
		configuredLevel: "user",
		mode: "explicit-only",
	}));
	return {
		deps,
		close() {
			deps.dispose?.();
			auth.close();
		},
	};
}

const legacy =
	"---\n# external metadata\nname: foreign\ndescription: External definition\ntools: []\ncustom:\n  retained: null\n---\nExternal instructions\n";

describe("native agent definition persistence", () => {
	test("editing an external YAML definition writes an owned native override without touching its source", async () => {
		const external = path.join(temp.path(), ".claude", "agents", "foreign.md");
		await Bun.write(external, legacy);
		await fs.chmod(external, 0o640);
		const { deps, close } = setup();
		try {
			const definition = importExternalAgentDefinitionDocument(legacy);
			const saved = await deps.saveDefinition(
				"project",
				{ ...definition, description: "Owned override" },
				{ ...definition, source: "project", filePath: external, disabled: false },
			);
			expect(saved).toBe(path.join(temp.path(), ".omp", "agents", "foreign.toml.md"));
			const raw = await Bun.file(saved).text();
			expect(raw).toStartWith("+++\n");
			expect(raw).toContain("# external metadata");
			expect(parseAgentDefinitionDocument(raw)).toMatchObject({
				name: "foreign",
				description: "Owned override",
				tools: [],
				custom: { retained: null },
			});
			expect(await Bun.file(external).text()).toBe(legacy);
			expect((await fs.stat(external)).mode & 0o777).toBe(0o640);
		} finally {
			close();
		}
	});

	test("editing a migrated owned definition keeps source bytes, native comments and inherited permissions", async () => {
		const original = path.join(temp.path(), ".omp", "agents", "foreign.md");
		await Bun.write(original, legacy);
		await fs.chmod(original, 0o640);
		const imported = await readNativeMarkdown(original);
		const definition = parseAgentDefinitionDocument(await Bun.file(imported.filePath).text());
		const { deps, close } = setup();
		try {
			const saved = await deps.saveDefinition(
				"project",
				{ ...definition, description: "Edited native" },
				{ ...definition, source: "project", filePath: imported.filePath, disabled: false },
			);
			expect(saved).toBe(imported.filePath);
			expect((await fs.stat(saved)).mode & 0o777).toBe(0o640);
			expect(await Bun.file(saved).text()).toContain("# external metadata");
			expect(parseAgentDefinitionDocument(await Bun.file(saved).text()).description).toBe("Edited native");
			expect(await Bun.file(original).text()).toBe(legacy);
		} finally {
			close();
		}
	});
});

import { expect, test } from "bun:test";
import type { ModelFolderRules } from "@oh-my-pi/pi-tui/overlays/model-folder-rules";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { cfgModelFolders } from "../../src/config/model-settings";
import { Settings } from "../../src/config/settings";
import { AuthStorage } from "../../src/session/auth-storage";

const MODELS_YML = `providers:
  folder-fixture:
    baseUrl: http://folder-fixture.test/v1
    api: openai-completions
    auth: none
    discovery:
      type: openai-models-list
`;

const rules: ModelFolderRules = {
	ingest: true,
	clauses: [[{ attribute: "slug", operator: "*=", value: "folder-fixture/eligible-*" }]],
};

test("the background provider refresh adds matching models only to enabled folder filters", async () => {
	const temp = TempDir.createSync("@folder-ingest-");
	const auth = await AuthStorage.create(temp.join("auth.db"));
	try {
		const modelsPath = temp.join("models.yml");
		await Bun.write(modelsPath, MODELS_YML);
		const settings = await Settings.loadIsolated({ cwd: temp.path(), agentDir: temp.join("agent") });
		settings.writeScopeValue(cfgModelFolders, [{ name: "Smart", models: ["manual/entry"], rules }], "global");
		settings.writeScopeValue(cfgModelFolders, [{ name: "Project smart", models: [], rules }], "project");
		let roster = ["eligible-first", "ignored"];
		const registry = new ModelRegistry(auth, modelsPath, {
			settings,
			fetch: async input => {
				const url = input instanceof Request ? input.url : String(input);
				if (url !== "http://folder-fixture.test/v1/models") throw new Error(`Unexpected request: ${url}`);
				return Response.json({ data: roster.map(id => ({ id })) });
			},
		});
		const refresh = () => registry.refreshCatalogProvider("folder-fixture");
		const globalFolders = () => settings.getGlobalSettings().modelFolders;
		await refresh();
		expect(globalFolders()).toEqual([
			{ name: "Smart", models: ["manual/entry", "folder-fixture/eligible-first"], rules },
		]);
		expect(settings.getProjectSettings().modelFolders).toEqual([
			{ name: "Project smart", models: ["folder-fixture/eligible-first"], rules },
		]);

		roster = ["eligible-second"];
		await refresh();
		const retained = ["manual/entry", "folder-fixture/eligible-first", "folder-fixture/eligible-second"];
		expect(globalFolders()).toEqual([{ name: "Smart", models: retained, rules }]);

		const off = { ...rules, ingest: false };
		settings.writeScopeValue(cfgModelFolders, [{ name: "Smart", models: retained, rules: off }], "global");
		roster = ["eligible-third"];
		await refresh();
		expect(registry.find("folder-fixture", "eligible-third")).toBeDefined();
		expect(globalFolders()).toEqual([{ name: "Smart", models: retained, rules: off }]);
		await settings.flush();
		const reloaded = await Settings.loadReadOnly({ cwd: temp.path(), agentDir: temp.join("agent") });
		expect(reloaded.getGlobalSettings().modelFolders).toEqual([{ name: "Smart", models: retained, rules: off }]);
	} finally {
		auth.close();
		await temp.remove();
	}
});

import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelSightings, recordModelSightings, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AuthStorage } from "../../src/session/auth-storage";

const DAY_MS = 86_400_000;
const MODEL_CONFIG = `providers:
  discovery-test:
    baseUrl: http://discovery.test/v1
    api: openai-completions
    auth: none
    discovery:
      type: openai-models-list
  other-provider:
    baseUrl: http://other.test/v1
    api: openai-completions
    auth: none
    discovery:
      type: openai-models-list
`;

test("baseline identities have unknown age; rediscovery does not overwrite history or share it across providers", async () => {
	const dir = TempDir.createSync("@model-first-seen-");
	const modelsPath = dir.join("models.yml");
	const dbPath = dir.join("models.db");
	const auth = await AuthStorage.create(dir.join("auth.db"));
	const start = Date.UTC(2026, 10, 22, 12);
	let now = start;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	try {
		await Bun.write(modelsPath, MODEL_CONFIG);
		const cached = buildModel({
			provider: "discovery-test",
			id: "cached",
			name: "Cached",
			api: "openai-completions",
			baseUrl: "http://discovery.test/v1",
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 65_536,
			maxTokens: 8_192,
		});
		writeModelCache("unrelated-cache-scope", start - 90 * DAY_MS, [cached], true, "test", dbPath);
		{
			using db = new Database(dbPath);
			db.run("UPDATE model_cache SET materialization_policy = 'prior-policy'");
		}

		let ids = ["cached", "new/main"];
		const createRegistry = () =>
			new ModelRegistry(auth, modelsPath, {
				settings: Settings.isolated({}),
				fetch: async () => Response.json({ data: ids.map(id => ({ id })) }),
			});
		const registry = createRegistry();
		expect(registry.getModelSightings(0).size).toBe(0);
		await registry.refreshDiscoverableProviders(["discovery-test"], "online");
		expect(registry.getModelSightings(0)).toEqual(new Map([["discovery-test/new/main", start]]));

		now += 43 * DAY_MS;
		// Replace the cache's payload and reopen the registry before the model returns.
		ids = ["cached"];
		await registry.refreshDiscoverableProviders(["discovery-test"], "online");
		const reopened = createRegistry();
		ids = ["cached", "new/main"];
		await reopened.refreshDiscoverableProviders(["discovery-test", "other-provider"], "online");
		expect(reopened.getModelSightings(now - 42 * DAY_MS)).toEqual(
			new Map([
				["other-provider/cached", now],
				["other-provider/new/main", now],
			]),
		);
		expect(reopened.getModelSightings(0).get("discovery-test/new/main")).toBe(start);
	} finally {
		clock.mockRestore();
		auth.close();
		await dir.remove();
	}
});

test("an unchanged bundle skips enumeration; a new bundle files only identities not seen before", async () => {
	const dir = TempDir.createSync("@model-bundle-history-");
	const dbPath = dir.join("models.db");
	const old = { provider: "example", id: "old" };
	const next = { provider: "example", id: "next" };
	try {
		expect(recordModelSightings([], dbPath, { fingerprint: "first", models: [old] })).toBe(true);
		const enumerate = spyOn([old], Symbol.iterator);
		const bundle = { fingerprint: "first", models: { [Symbol.iterator]: enumerate } };
		expect(recordModelSightings([], dbPath, bundle)).toBe(true);
		expect(enumerate).not.toHaveBeenCalled();
		expect(readModelSightings(0, dbPath).size).toBe(0);

		expect(recordModelSightings([], dbPath, { fingerprint: "second", models: [old, next] })).toBe(true);
		expect([...readModelSightings(0, dbPath).keys()]).toEqual(["example/next"]);
	} finally {
		await dir.remove();
	}
});

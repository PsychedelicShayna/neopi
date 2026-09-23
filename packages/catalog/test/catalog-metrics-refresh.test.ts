import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function xaiSpec(
	id: string,
	overrides: Partial<ModelSpec<"openai-responses">>,
): ModelSpec<"openai-responses"> {
	return {
		id,
		name: id,
		provider: "xai",
		api: "openai-responses",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 500000,
		maxTokens: 8192,
		...overrides,
	};
}

test("an additive stencil row replaces int and tps and leaves the rest of the bundled row", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-metrics-refresh-"));
	const cacheDbPath = path.join(tempDir, "models.db");
	try {
		const staticGrok = xaiSpec("grok-4.6", {
			name: "bundled",
			contextWindow: 500000,
			int: 60.9,
			tps: 61.3,
		});
		const online = await resolveProviderModels(
			{
				providerId: "xai",
				cacheDbPath,
				staticModels: [staticGrok],
				modelsDev: {
					additiveOnly: true,
					fetch: async () => ({ ok: true }),
					map: () => [
						xaiSpec("grok-4.6", { name: "stencil", contextWindow: 1, int: 44.3, tps: 60.4 }),
						xaiSpec("grok-4.7", { int: 46.4, tps: 39.5 }),
					],
				},
			},
			"online",
		);
		const refreshed = online.models.find(model => model.id === "grok-4.6");
		expect(refreshed?.name).toBe("bundled");
		expect(refreshed?.contextWindow).toBe(500000);
		expect(refreshed?.int).toBe(44.3);
		expect(refreshed?.tps).toBe(60.4);
		expect(online.models.find(model => model.id === "grok-4.7")?.int).toBe(46.4);

		const offline = await resolveProviderModels(
			{
				providerId: "xai",
				cacheDbPath,
				staticModels: [staticGrok],
				modelsDev: {
					additiveOnly: true,
					fetch: async () => {
						throw new Error("offline");
					},
					map: () => [],
				},
			},
			"offline",
		);
		expect(offline.models.find(model => model.id === "grok-4.6")?.int).toBe(44.3);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("a discovery row that copies the bundled score does not keep it", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-metrics-refresh-dynamic-"));
	const cacheDbPath = path.join(tempDir, "models.db");
	try {
		const staticGrok = xaiSpec("grok-4.6", { name: "bundled", int: 60.9, tps: 61.3 });
		const online = await resolveProviderModels(
			{
				providerId: "xai",
				cacheDbPath,
				staticModels: [staticGrok],
				modelsDev: {
					additiveOnly: true,
					fetch: async () => ({ ok: true }),
					map: () => [xaiSpec("grok-4.6", { name: "stencil", int: 44.3, tps: 60.4 })],
				},
				fetchDynamicModels: async () => [xaiSpec("grok-4.6", { name: "discovered", int: 60.9, tps: 61.3 })],
			},
			"online",
		);
		const refreshed = online.models.find(model => model.id === "grok-4.6");
		expect(refreshed?.int).toBe(44.3);
		expect(refreshed?.tps).toBe(60.4);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

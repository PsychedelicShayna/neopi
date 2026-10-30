import { orderedSettings } from "../packages/coding-agent/src/config/all-settings";
import { expect, test } from "bun:test";
import * as path from "node:path";
import data from "../packages/coding-agent/src/config/entry-provenance.json" with { type: "json" };
import { generateProvenance, readRegistryInventory } from "./generate-entry-provenance";

// The committed output is a generated artifact, not an assertion on implementation source text.
test("committed provenance is reproducible from all three pinned registries", async () => {
	expect(await generateProvenance(data)).toEqual(data);
});

test("current registry entries retain the generated provenance classification", async () => {
	const current = await generateProvenance({ ...data, forkRevision: "WORKTREE" });
	expect(current.fork).toEqual(data.fork);
	expect(current.newUpstream).toEqual(data.newUpstream);
});

test("registry extraction matches the runtime registered setting inventory", async () => {
	const root = path.resolve(import.meta.dir, "..");
	const inventory = await readRegistryInventory(file => Bun.file(path.join(root, file)).text());
	expect(inventory.settings.length).toBeGreaterThan(100);
	expect(inventory.commands).toContain("persona");
	expect(inventory.commands).not.toContain("show");
	expect(inventory.settings).toEqual(
		orderedSettings()
			.map(setting => setting.id)
			.sort(),
	);
});

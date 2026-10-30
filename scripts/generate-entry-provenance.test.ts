import { orderedSettings } from "../packages/coding-agent/src/config/all-settings";
import { expect, test } from "bun:test";
import * as path from "node:path";
import data from "../packages/coding-agent/src/config/entry-provenance.json" with { type: "json" };
import uiData from "../packages/tui/src/theme/ui-entry-provenance.json" with { type: "json" };
import { KEYBINDINGS } from "../packages/tui/src/app-keybindings";
import { STATUS_LINE_SEGMENT_IDS } from "../packages/tui/src/status-line/schema";
import { BUILTIN_COMPOSER_SHAPES } from "../packages/tui/src/overlays/composer-shape-registry";
import { MODEL_ROLES } from "../packages/coding-agent/src/config/model-roles";
import {
	generateProvenance,
	generateUiProvenance,
	readRegistryInventory,
	readUiRegistryInventory,
} from "./generate-entry-provenance";

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

test("additional UI provenance matches pinned and current registries", async () => {
	expect(await generateUiProvenance(data)).toEqual(uiData);
	expect(await generateUiProvenance({ ...data, forkRevision: "WORKTREE" })).toEqual(uiData);
	const root = path.resolve(import.meta.dir, "..");
	const inventory = await readUiRegistryInventory(file => Bun.file(path.join(root, file)).text());
	expect(inventory.keybindings).toEqual(Object.keys(KEYBINDINGS).sort());
	expect(inventory.statusSegments).toEqual([...STATUS_LINE_SEGMENT_IDS].sort());
	expect(inventory.roles).toEqual(Object.keys(MODEL_ROLES).sort());
	expect(inventory.composerShapes).toEqual(BUILTIN_COMPOSER_SHAPES.map(shape => shape.value).sort());
});

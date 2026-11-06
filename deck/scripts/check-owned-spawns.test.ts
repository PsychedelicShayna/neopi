import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { scanSource } from "./check-owned-spawns.ts";

const file = path.resolve(import.meta.dir, "../apps/server/src/example.ts");

describe("owned process guard parser", () => {
	test("rejects direct Bun process creation with source locations", () => {
		expect(
			scanSource(
				file,
				`function run() {
  Bun.spawn(["example"]);
  return Bun.spawnSync(["example"]);
}`,
			),
		).toEqual([
			"example.ts:2: direct spawn outside owned-process",
			"example.ts:3: direct spawnSync outside owned-process",
		]);
	});

	for (const specifier of ["child_process", "node:child_process"]) {
		test(`rejects ${specifier} imports`, () => {
			expect(scanSource(file, `import { spawn } from "${specifier}";`)).toEqual([
				"example.ts: child_process import",
			]);
		});
	}

	test("allows owned wrappers and unrelated APIs without matching comments or strings", () => {
		expect(
			scanSource(
				file,
				`
import { spawnOwned, spawnOwnedSync } from "./owned-process.ts";
import { parse } from "node:path";
// Bun.spawn(["example"]);
const example = 'Bun.spawnSync(["example"])';
spawnOwned(["example"]);
spawnOwnedSync(["example"]);
other.spawn();
Bun.sleep(1);
`,
			),
		).toEqual([]);
	});

	test("parses TSX and visits nested spawn calls", () => {
		const tsxFile = path.resolve(import.meta.dir, "../apps/server/src/example.tsx");
		expect(
			scanSource(
				tsxFile,
				`const view = <div>{() => {
  return Bun.spawn(["example"]);
}}</div>;`,
			),
		).toEqual(["example.tsx:2: direct spawn outside owned-process"]);
	});
});

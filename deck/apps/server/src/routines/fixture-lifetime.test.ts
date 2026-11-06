import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runIsolatedCase } from "../test-isolation.ts";

const moduleUrl = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
const agentSource =
	'const message = {role:"assistant", timestamp:1, model:"test", content:[{type:"text",text:"answer"}], usage:{input:10, output:5, cacheRead:0, cacheWrite:0, cost:{total:0.001}}}; process.stdout.write(JSON.stringify({type:"message_end",message}) + "\\n" + JSON.stringify({type:"agent_end",messages:[message]}) + "\\n");';

test("an expired routine teardown is joined before its private worker releases a successor", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-fixture-lifetime-"));
	const alias = path.join(root, "alias");
	const file = path.join(alias, "lifetime.test.ts");
	try {
		fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
		fs.writeFileSync(
			file,
			`
import { afterAll, afterEach, expect } from "bun:test";
import { stringifySettingsToml as stringifyToml } from ${moduleUrl("../../../../../packages/utils/src/settings-toml.ts")};
import * as fs from "node:fs";
import * as path from "node:path";
import { createIsolatedTest } from ${moduleUrl("../test-isolation.ts")};
import { openDb, closeDb, getDb } from ${moduleUrl("../db/index.ts")};
import { createV1Routine, getRoutine, listRuns } from ${moduleUrl("../db/routines.ts")};
import { listStepRuns } from ${moduleUrl("../db/routine-step-runs.ts")};
import { RoutinesRunner } from ${moduleUrl("../routines-runner.ts")};
import { initializeOwnedGeneration, stopOwnedProcesses } from ${moduleUrl("../owned-process.ts")};
const test = createIsolatedTest(import.meta.path);
const receipt = name => path.join(process.env.FIXTURE_RECEIPTS, name);
const home = process.env.NPI_DECK_HOME;
const dbPath = process.env.NPI_DECK_DB_PATH;
let cleanup;
let runner;
let cleanupFinished = false;
afterEach(() => {
  cleanup = (async () => {
    if (process.env.FIXTURE_EXPIRE === "yes") await Bun.sleep(100);
    await runner?.dispose();
    await stopOwnedProcesses();
    closeDb();
    cleanupFinished = true;
    fs.writeFileSync(receipt(process.env.FIXTURE_EXPIRE === "yes" ? "old-cleaned" : "successor-cleaned"), JSON.stringify({home, dbPath, pid: process.pid}));
  })();
  return cleanup;
}, process.env.FIXTURE_EXPIRE === "yes" ? 25 : 5000);
afterAll(async () => {
  if (process.env.FIXTURE_EXPIRE === "yes") {
    expect(cleanupFinished).toBe(false);
    fs.writeFileSync(receipt("hook-expired"), "expired");
  }
  await cleanup;
  expect(cleanupFinished).toBe(true);
});
test("old fixture expires its cleanup", () => {
  openDb({path: dbPath});
  initializeOwnedGeneration();
});
test("successor persists a real routine after old teardown", async () => {
  const old = JSON.parse(fs.readFileSync(receipt("old-cleaned"), "utf8"));
  expect(home).not.toBe(old.home);
  expect(dbPath).not.toBe(old.dbPath);
  expect(process.pid).not.toBe(old.pid);
  const db = openDb({path: dbPath});
  initializeOwnedGeneration();
  const cli = path.join(home, "backend/packages/coding-agent/src/cli.ts");
  fs.mkdirSync(path.dirname(cli), {recursive: true});
  // Synthetic agent CLI fixture: the production runner and native SQLite remain real.
  fs.writeFileSync(cli, ${JSON.stringify(agentSource)});
  runner = new RoutinesRunner(() => [process.execPath, cli]);
  const spec = {name:"lifetime", trigger:[{manual:{}}], concurrency:"skip", steps:[{id:"agent", type:"agent", prompt:"fixture answer"}]};
  const routine = createV1Routine({name:"lifetime", spec, specToml:stringifyToml(spec), enabled:true});
  await runner.fire(routine.id);
  expect(getDb()).toBe(db);
  const runs = listRuns(routine.id);
  expect(runs).toHaveLength(1);
  expect(runs[0].exitCode).toBe(0);
  expect(runs[0].endedAt).toBeDefined();
  expect(runs[0].error).toBeUndefined();
  expect(runs[0].totalLlmTokens).toBe(15);
  expect(runs[0].totalLlmCostMicros).toBe(1000);
  const steps = listStepRuns(runs[0].id);
  expect(steps).toHaveLength(1);
  expect(steps[0].status).toBe("success");
  closeDb();
  openDb({path:dbPath});
  expect(getRoutine(routine.id)?.id).toBe(routine.id);
  expect(listRuns(routine.id)).toEqual(runs);
  expect(listStepRuns(runs[0].id)).toEqual(steps);
  fs.writeFileSync(receipt("persisted"), "persisted");
});
`,
		);
		const old = runIsolatedCase(file, "old fixture expires its cleanup", {
			FIXTURE_RECEIPTS: root,
			FIXTURE_EXPIRE: "yes",
		});
		expect(old.exitCode).not.toBe(0);
		expect(old.output).toContain("a beforeEach/afterEach hook timed out");
		expect(fs.readFileSync(path.join(root, "hook-expired"), "utf8")).toBe("expired");
		expect(fs.existsSync(path.join(root, "old-cleaned"))).toBe(true);
		expect(fs.existsSync(old.root)).toBe(false);
		const successor = runIsolatedCase(file, "successor persists a real routine after old teardown", {
			FIXTURE_RECEIPTS: root,
		});
		if (successor.exitCode !== 0) throw new Error(successor.output);
		expect(successor.output).toMatch(/^\s*1 pass\s*$/m);
		expect(successor.output).toMatch(/^\s*0 fail\s*$/m);
		expect(fs.readFileSync(path.join(root, "persisted"), "utf8")).toBe("persisted");
		expect(fs.existsSync(path.join(root, "successor-cleaned"))).toBe(true);
		expect(fs.existsSync(successor.root)).toBe(false);
		for (const marker of ["old-cleaned", "successor-cleaned"]) {
			const receipt = JSON.parse(fs.readFileSync(path.join(root, marker), "utf8")) as { pid: number; home: string };
			expect(fs.existsSync(receipt.home)).toBe(false);
			expect(() => process.kill(receipt.pid, 0)).toThrow();
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}, 20_000);

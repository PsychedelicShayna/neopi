import { stringifySettingsToml as stringifyToml } from "@oh-my-pi/pi-utils/settings-toml";
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { activeBackend, nativeProcessClass, resolveBackendSelection } from "./backend/runtime.ts";
import { completeOwned, spawnOwned, stopOwnedProcesses, terminateOwned } from "./owned-process.ts";
import { createIsolatedTest } from "./test-isolation.ts";
import { workRegistry } from "./work-registry.ts";
import { RoutineTestFixtures } from "./routines/test-fixture.ts";
import { createShellFixture } from "./routines/shell-fixture.ts";
import { observeProcessTree, unrelatedProcess } from "../test-fixtures/process-fixture.ts";
import { createV1Routine, listRuns } from "./db/routines.ts";
import { listStepRuns } from "./db/routine-step-runs.ts";

const backend = resolveBackendSelection();
const test = createIsolatedTest(import.meta.path, backend ? { NPI_DECK_BACKEND: backend.path } : {});

for (const leaderExits of [false, true]) {
	test(leaderExits ? "owned tree survives leader exit until descendant pipes drain" : "repeated owned cancellation joins one tree teardown and drains both pipes", async () => {
		const fixtures = new RoutineTestFixtures();
		try {
			await fixtures.run(async ({ home }) => {
				const marker = path.join(home, "tree.json");
				const release = path.join(home, "leader-exit");
				const shell = createShellFixture(home);
				const command = shell.command("tree", { marker, release, leaderExits });
				const proc = spawnOwned(process.platform === "win32" ? ["cmd", "/c", command] : ["bash", "-lc", command],
					{ cwd: shell.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" }, { retainUntilDrained: true });
				const stdout = new Response(proc.stdout).text();
				const stderr = new Response(proc.stderr).text();
				const control = unrelatedProcess();
				let tree: Awaited<ReturnType<typeof observeProcessTree>> | undefined;
				let observation: ReturnType<typeof setTimeout> | undefined;
				try {
					tree = await observeProcessTree(marker);
					if (leaderExits) {
						fs.writeFileSync(release, "exit");
						observation = setTimeout(() => console.log(JSON.stringify({
							event: "leader-release-pending", states: tree!.states(),
						})), 250);
						await proc.exited;
						clearTimeout(observation);
						if (process.platform === "win32") expect(workRegistry.snapshot().some(item => item.kind === "process")).toBe(true);
					}
					const start = Date.now();
					await Promise.all([terminateOwned(proc), terminateOwned(proc), stopOwnedProcesses(), stopOwnedProcesses()]);
					if (process.platform === "win32") expect(workRegistry.snapshot().some(item => item.kind === "process")).toBe(true);
					const output = await Promise.all([stdout, stderr, proc.exited]);
					await completeOwned(proc);
					console.log(JSON.stringify({ event: "owned-tree-released", leaderExits, elapsed: Date.now() - start,
						states: tree.states(), work: workRegistry.snapshot(), control: control.status() }));
					expect(Date.now() - start).toBeLessThan(4000);
					expect(tree.states().every(process => process.status === "exited")).toBe(true);
					expect(output[0]).toContain("tree stdout ready");
					expect(output[1]).toContain("tree stderr ready");
					expect(workRegistry.snapshot()).toEqual([]);
					expect(control.status() === "running").toBe(true);
				} finally {
					clearTimeout(observation);
					tree?.kill();
					await control.close();
					await completeOwned(proc);
				}
			});
		} finally { await fixtures.join(); }
	});
}

test("native process support leaves the agent SDK backend inactive", () => {
	expect(activeBackend()).toBeUndefined();
	expect(typeof nativeProcessClass().fromPid).toBe("function");
	expect(activeBackend()).toBeUndefined();
});

if (process.platform === "win32") test("Windows local runs refuse to spawn without native ownership", async () => {
	const fixtures = new RoutineTestFixtures();
	const saved = process.env.NPI_DECK_BACKEND;
	try {
		await fixtures.run(async ({ home, runner }) => {
			delete process.env.NPI_DECK_BACKEND;
			const marker = path.join(home, "must-not-start");
			const shell = createShellFixture(home);
			const spec = { name: "no native ownership", trigger: [{ manual: {} }], concurrency: "skip" as const,
				steps: [{ id: "local", type: "run" as const, cwd: shell.cwd, command: shell.command("write", { marker }) }] };
			const routine = createV1Routine({ name: spec.name, spec, specToml: stringifyToml(spec), enabled: true });
			await runner.fire(routine.id);
			const run = listRuns(routine.id)[0]!;
			expect(listStepRuns(run.id)[0]?.error).toContain("owned Windows processes require a configured NeoPi native backend");
			expect(fs.existsSync(marker)).toBe(false);
			expect(run.backend).toBeUndefined();
		});
	} finally {
		if (saved === undefined) delete process.env.NPI_DECK_BACKEND;
		else process.env.NPI_DECK_BACKEND = saved;
		await fixtures.join();
	}
});
